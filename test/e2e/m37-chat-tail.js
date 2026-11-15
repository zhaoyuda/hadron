/**
 * Module M37 — a long transcript opens from its tail; "Load earlier" reads back.
 *
 * A cold conversation cache used to read the whole transcript forward before
 * the chat could draw anything (a 244 MB transcript: 2.3 s, every switch after
 * the cache aged out). A transcript larger than the tail window is now read
 * from its last TAIL_BYTES; the head is read backwards, a chunk at a time, only
 * when "Load earlier" asks (server/conversation.js backfillConversation). The
 * window is shrunk for the test with HADRON_CONVERSATION_TAIL_BYTES. Proves:
 *   - the chat opens on the tail with a "Load earlier" button (no count: the
 *     server does not know how many items the unread head holds)
 *   - clicking it until it goes away shows every exchange exactly once, in
 *     order — messages split over a chunk boundary (text record + tool_use
 *     record) included, each tool result on its card
 *   - an exchange appended between the clicks lands at the bottom, once,
 *     and is never placed above the loaded window
 *   - a transcript whose last record alone exceeds the window (the tail read
 *     holds no item, so the client has no "before" cursor) answers its first
 *     page with the records before it
 *
 * Run: node test/e2e/m37-chat-tail.js
 */
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M37 chat tail-first");
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m37-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.HADRON_CONVERSATION_TAIL_BYTES = "24000";
const SID = randomUUID(), SID2 = randomUUID();
const N = 150;
const now = () => new Date().toISOString();
const rec = (o) => JSON.stringify({ uuid: randomUUID(), timestamp: now(), ...o }) + "\n";
const exchange = (i) =>
  rec({ type: "user", message: { role: "user", content: `prompt ${i} ` + "p".repeat(120) } }) +
  rec({ type: "assistant", message: { id: `m${i}`, role: "assistant", model: "claude-x", content: [{ type: "text", text: `answer ${i} ` + "a".repeat(200) }] } }) +
  rec({ type: "assistant", message: { id: `m${i}`, role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }] } }) +
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `out ${i}` }] } });
let transcript;
const env = await bootWorkspace({
  name: "m37",
  landing: "chat",
  seed(ws) {
    const dir = join(CONFIG, "projects", claudeProjectDir(ws));
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(ws, ".hadron", "agents"), { recursive: true });
    writeFileSync(join(ws, ".hadron", "agents", "alpha.json"), JSON.stringify({
      id: "alpha", name: "Alpha", group: "Workers", cwd: ws,
      runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: SID, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() },
    }, null, 2));
    transcript = join(dir, `${SID}.jsonl`);
    let body = "";
    for (let i = 0; i < N; i++) body += exchange(i);
    writeFileSync(transcript, body);
    // Beta: its last record alone is larger than the tail window.
    writeFileSync(join(ws, ".hadron", "agents", "beta.json"), JSON.stringify({
      id: "beta", name: "Beta", group: "Workers", cwd: ws,
      runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: SID2, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() },
    }, null, 2));
    writeFileSync(join(dir, `${SID2}.jsonl`), exchange(0) + exchange(1) + rec({ type: "user", message: { role: "user", content: "big " + "b".repeat(40000) } }));
  },
});
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) { const s = Date.now(); while (Date.now() - s < timeout) { if (await fn()) return true; await wait(200); } return fn(); }
let browser;

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  const chat = page.locator("#chat-container");
  const ids = () => chat.locator('.ci[data-id^="a:m"]').evaluateAll((els) => els.map((e) => Number(e.dataset.id.slice(3))));
  r.ok(await until(async () => (await ids()).includes(N - 1)), "the chat opens with the last exchange");
  const first = await ids();
  r.ok(first.length > 0 && first.length < N / 2, `…holding only the tail (${first.length} of ${N} replies)`);
  const btn = chat.locator(".chat-earlier");
  r.ok(await until(async () => (await btn.isVisible()) && (await btn.textContent()) === "Load earlier"), `"Load earlier" offered, no count (${await btn.textContent()})`);

  let clicks = 0, appended = false;
  while ((await btn.isVisible()) && clicks < 40) {
    const before = (await ids()).length;
    await btn.click();
    clicks++;
    await until(async () => (await ids()).length > before || !(await btn.isVisible()), 8000);
    if (clicks === 1 && !appended) { appendFileSync(transcript, exchange(N)); appended = true; await until(async () => (await ids()).includes(N), 8000); }
  }
  const all = await ids();
  r.ok(!(await btn.isVisible()) && clicks > 1, `"Load earlier" goes away once the start is read (${clicks} clicks)`);
  r.ok(all.length === N + 1 && all.every((v, i) => v === i), `every reply once, in order, the appended one last (${all.length}; first break at ${all.findIndex((v, i) => v !== i)})`);
  const prompts = await chat.locator(".ci-user").evaluateAll((els) => els.map((e) => (e.textContent.match(/prompt (\d+)/) || [])[1]).filter(Boolean).map(Number));
  r.ok(prompts.length === N + 1 && prompts.every((v, i) => v === i), `every prompt once, in order (${prompts.length})`);
  const split = await chat.evaluate((root) => [...root.querySelectorAll('.ci[data-id^="a:m"]')].filter((e) => /answer \d+/.test(e.textContent) && e.querySelector(".ci-tool")).length);
  r.ok(split === N + 1, `each split message carries both its text and its tool card (${split})`);
  r.ok(!(await chat.locator(".chat-note").textContent()).includes("not held"), "no 'earlier history not held' note");
  const bw = await (await fetch(`${env.baseUrl}/api/sessions/beta/conversation`, { headers: authHeaders(env.token) })).json();
  r.ok(bw.items?.length === 5 && bw.items[4].text.startsWith("big ") && bw.firstOrd !== null, `a tail that holds no item (one record over the window): the first page reads back itself (${bw.items?.length} items)`);
  // A backfill can re-pair a queue line: the record that hid it drops it from
  // `hides` (and the line's own dup goes false on the server). Whichever update
  // arrives first, the line shows again once nothing names it.
  const hid = await page.evaluate(() => {
    const m = { items: new Map(), hidden: new Map() };
    const store = (list) => { for (const it of list) m.items.set(it.id, it); };
    const line = { id: "q1", kind: "queue", ord: 1, rev: 1, dup: false };
    const taker = { id: "u1", kind: "user", ord: 2, rev: 2, hides: ["q1"] };
    store([line, taker]); store(chatHiddenCopies(m, [taker]));
    const hiddenThen = m.items.get("q1").dup === true;
    const t2 = { ...taker, rev: 3, hides: undefined };
    const back = chatHiddenCopies(m, [t2]);
    store([t2]); store(back);
    // the other order: the line's own dup:false arrives before the taker drops it
    const m2 = { items: new Map(), hidden: new Map() };
    const s2 = (list) => { for (const it of list) m2.items.set(it.id, it); };
    s2([line, taker]); s2(chatHiddenCopies(m2, [taker]));
    // an older copy of the record (a page that crossed a poll) arrives after the newer one
    const stale = chatHiddenCopies(m, [taker]);
    return { hiddenThen, shown: m.items.get("q1").dup === false, still: m2.hidden.has("q1"), staleIgnored: !m.hidden.has("q1") && stale.length === 0 };
  });
  r.ok(hid.hiddenThen && hid.shown && hid.still && hid.staleIgnored, `a queue line hidden by a record shows again once that record stops naming it (${JSON.stringify(hid)})`);

  // ▷ Run: claude records `!cmd` as bash input → a command item named "!"; the
  // outbox row matches it (else it would read "not in the conversation yet").
  const bang = await page.evaluate(() => {
    const at = new Date().toISOString();
    const m = { items: new Map([["b1", { id: "b1", kind: "command", name: "!", args: "echo hi", at }]]) };
    const other = { items: new Map([["b2", { id: "b2", kind: "command", name: "!", args: "echo bye", at }]]) };
    return { seen: chatObserved(m, { text: "!echo hi", at }) && chatObserved(m, { text: "! echo hi ", at }), notOther: !chatObserved(other, { text: "!echo hi", at }), text: chatCommandText(m.items.get("b1")) };
  });
  r.ok(bang.seen && bang.notOther && bang.text === "!echo hi", `a handed "!cmd" row is seen once claude records the bash input (${JSON.stringify(bang)})`);
  await page.screenshot({ path: join(screenshotDir(), "m37-chat-tail.png") });
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
