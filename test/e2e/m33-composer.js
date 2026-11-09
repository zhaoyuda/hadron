/**
 * Module M33 — the composer under the chat view (G3: drafts, sending, the outbox).
 *
 * A fixture process NAMED claude runs in the agent's pane (exec'd over the shell
 * after boot): it logs every line typed at it, appends a user record to the
 * seeded transcript for each bracketed paste, and shows a ❯ prompt so the
 * detector reads idle. What reached "claude" is what is in its log.
 *   - the composer is there and focused; typing Chinese is saved locally, then
 *     synced (GET /draft matches, status line says so), a reload restores it
 *     and a second browser sees the same draft (cross-device)
 *   - a draft moved on another device → 409 → "Draft changed on another
 *     device" with both choices; "Use this device" makes the server carry the
 *     text typed here
 *   - Enter while the IME composes does not send; Shift+Enter is a newline;
 *     Enter sends: textarea cleared at once, the row shows under the composer,
 *     the user bubble appears, the row is gone, the entry deleted, the draft
 *     cleared; a multi-line Chinese paste reaches claude line by line;
 *     typing right after Send stays in the composer
 *   - working → pasted at once (claude queues typed input during a turn and
 *     reads it with its next step); blocked → "Send after this turn" (queued
 *     on the record, nothing typed into the dialog), idle again → delivered;
 *     × cancels a queued one, nothing ever typed; switching to another agent
 *     and back keeps the queued row; two queued → "Merge" folds them into one
 *     message; "Send now" forces a queued one out while blocked
 *   - the POST lost on the wire → "Not sure this was sent", never resent on
 *     its own, "Send again" delivers exactly once
 *   - an image pasted into the composer is uploaded and its path inserted
 *
 * Run: node test/e2e/m33-composer.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, chmodSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { bootWorkspace, authHeaders, reporter, screenshotDir, waitPaneProvisioned } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M33 composer");
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m33-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const SID = randomUUID();
const now = () => new Date().toISOString();
const rec = (o) => JSON.stringify({ uuid: randomUUID(), timestamp: now(), ...o }) + "\n";
const user = (text) => rec({ type: "user", message: { role: "user", content: text } });
const asst = (id, text) => rec({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }], model: "claude-x", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" } });
let transcript, ws;
const FIXDIR = mkdtempSync(join(tmpdir(), "hadron-m33-fix-"));
const FIXTURE = join(FIXDIR, "claude"); // the fixture script (test/e2e/fixtures/claude-m33.sh) installed under the name claude
const LOG = join(FIXDIR, "claude-input.log");
// Bracketed paste: tmux's paste-buffer sends ESC[200~ … ESC[201~ with CRs
// between the lines, so a multi-line message arrives as several reads; the
// fixture collects them until the closing marker and records one user turn.
writeFileSync(FIXTURE, readFileSync(new URL("./fixtures/claude-m33.sh", import.meta.url), "utf-8"));
chmodSync(FIXTURE, 0o755);

const env = await bootWorkspace({
  name: "m33",
  seed(w) {
    ws = w;
    const dir = join(CONFIG, "projects", claudeProjectDir(ws));
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(ws, ".hadron", "agents"), { recursive: true });
    for (const [id, name] of [["alpha", "Alpha"], ["beta", "Beta"]]) {
      writeFileSync(join(ws, ".hadron", "agents", `${id}.json`), JSON.stringify({
        id, name, group: "Workers", cwd: ws,
        ...(id === "alpha" ? { runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: SID, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() } } : {}),
      }, null, 2));
    }
    transcript = join(dir, `${SID}.jsonl`);
    writeFileSync(transcript, user("开始吧") + asst("m1", "好的。"));
  },
});
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, { method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}) });
const draft = async () => (await (await api("GET", "/api/sessions/alpha/draft")).json()).draft;
const outbox = async () => (await (await api("GET", "/api/sessions/alpha/outbox")).json()).outbox;
const typed = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8") : "").replace(/\x1b\[20[01]~/g, "").split("\n").filter(Boolean);
const tmuxName = `hadron-${env.wsName}-alpha`;
const tmux = (args) => execFileSync("tmux", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TMUX: undefined } }).trim();

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  // The terminal connect created alpha's tmux session; put a "claude" in it.
  r.ok(await until(() => { try { tmux(["has-session", "-t", tmuxName]); return true; } catch { return false; } }), "alpha's tmux session exists after the switch");
  r.ok(await waitPaneProvisioned(tmuxName), "…and its pane is the provisioned shell (after the server's respawn-pane)");
  tmux(["send-keys", "-t", tmuxName, `exec ${FIXTURE} ${transcript} ${LOG}`, "Enter"]);
  r.ok(await until(() => tmux(["display-message", "-t", tmuxName, "-p", "#{pane_current_command}"]) === "claude"), "…and a process named claude is at its prompt");
  r.ok(await until(async () => (await (await api("GET", "/api/sessions")).json()).find((s) => s.id === "alpha")?.state === "idle"), "the detector reads it idle");

  await page.locator("#af-chat-btn").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#af-chat-btn").click();
  const chat = page.locator("#chat-container");
  const ta = chat.locator(".chat-input");
  await ta.waitFor({ state: "visible", timeout: 5000 });
  r.ok(await until(async () => (await chat.locator(".ci-user").count()) === 1), "the chat paints the seeded prompt");
  r.ok(await ta.evaluate((el) => document.activeElement === el), "the composer is focused on open");

  // ── drafts ──
  await ta.type("你好", { delay: 30 });
  r.ok(await until(async () => (await chat.locator(".chat-draft-st").textContent()) === "Draft synced", 4000), `typing is saved locally, then synced (status "${await chat.locator(".chat-draft-st").textContent()}")`);
  let d = await draft();
  r.ok(d && d.text === "你好" && d.revision >= 1, `GET /draft carries the text + revision ${d?.revision}`);
  const rev1 = d.revision;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  await ta.waitFor({ state: "visible", timeout: 5000 });
  r.ok(await until(async () => (await ta.inputValue()) === "你好"), "a reload restores the draft");
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  await page2.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page2.locator(`.dk[data-sid="alpha"]`).first().click();
  await page2.locator("#af-chat-btn").click();
  const ta2 = page2.locator("#chat-container .chat-input");
  r.ok(await until(async () => (await ta2.inputValue()) === "你好"), "a second browser (another device) sees the same draft");
  await ctx2.close();

  // conflict: another device moves the draft on; this device keeps typing
  const other = await (await api("PATCH", "/api/sessions/alpha/draft", { text: "另一台设备写的", attachments: [], deviceId: "d-other", revision: rev1, conversationId: null })).json();
  r.ok(other.draft && other.draft.revision === rev1 + 1, "another device advances the draft's revision");
  await ta.focus();
  await ta.type("，在吗", { delay: 30 });
  const notice = chat.locator(".chat-notice");
  r.ok(await until(async () => !(await notice.evaluate((el) => el.hidden)) && (await notice.textContent()).includes("Draft changed on another device")), `the 409 becomes a conflict notice: "${(await notice.textContent()).slice(0, 60)}"`);
  r.ok((await notice.locator(".chat-notice-btn").allTextContents()).join("|") === "Use this device|Use other device", "…with both choices, nothing merged");
  r.ok((await ta.inputValue()) === "你好，在吗", "the composer keeps what was typed here");
  await notice.locator(".chat-notice-btn", { hasText: "Use this device" }).click();
  r.ok(await until(async () => (await draft())?.text === "你好，在吗"), "Use this device → the server carries this device's text");
  r.ok(await until(async () => (await chat.locator(".chat-draft-st").textContent()) === "Draft synced"), "…synced again");

  // ── sending ──
  await ta.fill("");
  await ta.type("第一条", { delay: 20 });
  await ta.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await ta.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true })));
  await wait(300);
  r.ok((await ta.inputValue()) === "第一条" && (await chat.locator(".ob-row").count()) === 0, "Enter while the IME composes (isComposing / keyCode 229) sends nothing");
  await ta.press("Shift+Enter");
  await ta.type("第二行", { delay: 20 });
  r.ok((await ta.inputValue()) === "第一条\n第二行", "Shift+Enter is a newline");
  const before = (await chat.locator(".ci-user").count());
  await ta.press("Enter");
  r.ok((await ta.inputValue()) === "", "Enter sends: the composer is cleared at once");
  await ta.type("接着打", { delay: 20 }); // typing right after Send stays in the composer
  r.ok(await until(async () => (await chat.locator(".ci-user").count()) === before + 1), "the user bubble appears");
  const bubble = chat.locator(".ci-user .ci-bubble").last();
  r.ok((await bubble.textContent()).includes("第一条") && (await bubble.textContent()).includes("第二行"), "…with both lines (a multi-line message reaches claude as one paste)");
  r.ok(await until(async () => (await chat.locator(".ob-row").count()) === 0), "the outbox row is gone once claude recorded it");
  r.ok(await until(async () => (await outbox()).length === 0), "…and the entry is deleted from the record");
  r.ok((await ta.inputValue()) === "接着打", "what was typed right after Send is still in the composer");
  r.ok(await until(async () => (await draft())?.text === "接着打"), "…and is the draft now");
  r.ok(typed().join("\n").includes("第一条") && typed().join("\n").includes("第二行"), "claude's log has both lines");

  // ── working: delivered at once (claude queues typed input during a turn) ──
  await ta.fill("");
  await api("PATCH", "/api/sessions/alpha", { state: "working" });
  await ta.type("干活时也发", { delay: 20 });
  await ta.press("Enter");
  const row = chat.locator(".ob-row");
  r.ok(await until(async () => typed().join("\n").includes("干活时也发"), 15000), "while working the message is pasted at once — claude reads it with its next step");
  r.ok(await until(async () => (await row.count()) === 0 && (await chat.locator(".ci-user").count()) === before + 2), "…the bubble appears and the row goes");
  await api("PATCH", "/api/sessions/alpha", { state: "idle" });

  // ── queued while blocked (a dialog is up: a paste would land in it) ──
  await api("PATCH", "/api/sessions/alpha", { state: "blocked" });
  await ta.type("等一下再发", { delay: 20 });
  await ta.press("Enter");
  r.ok(await until(async () => (await row.count()) === 1 && (await row.locator(".ob-st").textContent()) === "Send after this turn"), `while blocked the row says "${await row.locator(".ob-st").textContent().catch(() => "")}"`);
  r.ok((await outbox())[0]?.state === "queued" && !typed().join("\n").includes("等一下再发"), "…queued on the record, nothing typed into the dialog");
  // switching away and back keeps it
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => (await chat.locator(".chat-input").count()) === 1 && (await chat.locator(".ob-row").count()) === 0), "Beta's chat has its own empty composer");
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => (await row.count()) === 1 && (await row.locator(".ob-text").textContent()) === "等一下再发"), "back on Alpha the queued row is still there");
  await api("PATCH", "/api/sessions/alpha", { state: "idle" });
  r.ok(await until(async () => typed().join("\n").includes("等一下再发"), 15000), "idle again → the server delivers it");
  r.ok(await until(async () => (await row.count()) === 0 && (await chat.locator(".ci-user").count()) === before + 3), "…the bubble appears and the row goes");

  // × cancels a queued one
  await api("PATCH", "/api/sessions/alpha", { state: "blocked" });
  await ta.type("这条不要", { delay: 20 });
  await ta.press("Enter");
  r.ok(await until(async () => (await row.count()) === 1 && (await row.locator(".ob-st").textContent()) === "Send after this turn"), "a second queued message");
  await row.locator(".ob-act[data-act=cancel]").click();
  r.ok(await until(async () => (await row.count()) === 0 && (await outbox()).length === 0), "× removes it from the view and the record");
  await api("PATCH", "/api/sessions/alpha", { state: "idle" });
  await wait(2500);
  r.ok(!typed().join("\n").includes("这条不要"), "…and it is never delivered");

  // blocked → queued, Edit takes it back
  await api("PATCH", "/api/sessions/alpha", { state: "blocked" });
  await ta.type("先别回答", { delay: 20 });
  await ta.press("Enter");
  r.ok(await until(async () => (await row.count()) === 1 && (await row.locator(".ob-st").textContent()) === "Send after this turn"), "blocked → queued too");
  await wait(1500);
  r.ok(!typed().join("\n").includes("先别回答"), "…nothing typed into the dialog");
  await row.locator(".ob-act[data-act=edit]").click();
  r.ok(await until(async () => (await row.count()) === 0 && (await ta.inputValue()) === "先别回答"), "Edit takes it back into the composer");
  await ta.fill("");

  // two queued → Merge folds them into one; Send now forces it out while blocked
  await api("PATCH", "/api/sessions/alpha", { state: "blocked" });
  // The first one is longer than the wire clips to (500 chars): after a reload
  // the rows come off the sessions list clipped, and Merge must still send
  // the whole text.
  const long = `第一句${"长".repeat(600)}`;
  await ta.fill(long); await ta.press("Enter");
  await ta.type("第二句", { delay: 20 }); await ta.press("Enter");
  r.ok(await until(async () => (await chat.locator(".ob-row:not(.ob-merge)").count()) === 2 && (await chat.locator(".ob-act[data-act=merge]").count()) === 1), "two messages queued → a Merge button under them");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  await ta.waitFor({ state: "visible", timeout: 5000 });
  r.ok(await until(async () => (await chat.locator(".ob-row:not(.ob-merge)").count()) === 2 && (await chat.locator(".ob-act[data-act=merge]").count()) === 1), "after a reload the rows come off the sessions list (the long one clipped on that wire) with the Merge button");
  await chat.locator(".ob-act[data-act=merge]").click();
  r.ok(await until(async () => (await chat.locator(".ob-row:not(.ob-merge)").count()) === 1 && (await outbox()).length === 1 && (await outbox())[0].state === "queued" && (await outbox())[0].text === `${long}\n\n第二句`), "Merge → one queued message with both whole texts, in order (the record has one entry)");
  r.ok((await chat.locator(".ob-act[data-act=merge]").count()) === 0 && !typed().join("\n").includes("第一句"), "…no Merge button for one row, nothing typed yet");
  await chat.locator(".ob-act[data-act=now]").click();
  r.ok(await until(async () => typed().join("\n").includes(long) && typed().join("\n").includes("第二句"), 15000), "Send now → pasted at once although the pane is blocked, the long text whole");
  r.ok(await until(async () => (await chat.locator(".ob-row").count()) === 0), "…the bubble appears and the row goes");
  await api("PATCH", "/api/sessions/alpha", { state: "idle" });

  // ── the POST lost on the wire ──
  await page.route("**/api/sessions/alpha/message", (rt) => rt.abort());
  await ta.type("网断了", { delay: 20 });
  await ta.press("Enter");
  r.ok(await until(async () => (await row.count()) === 1 && (await row.locator(".ob-st").textContent()).startsWith("Not sure this was sent")), `no answer from the server → "${await row.locator(".ob-st").textContent().catch(() => "")}"`);
  await wait(3000);
  r.ok((await row.count()) === 1 && (await row.locator(".ob-st").textContent()).startsWith("Not sure this was sent") && !typed().join("\n").includes("网断了"), "…and it stays that way: never resent on its own");
  await page.unroute("**/api/sessions/alpha/message");
  await row.locator(".ob-act[data-act=retry]").click();
  r.ok(await until(async () => typed().filter((l) => l.includes("网断了")).length === 1 && (await row.count()) === 0), "Send again delivers it exactly once");

  // ── image paste ──
  await ta.focus();
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([png], "shot.png", { type: "image/png" });
    const dt = new DataTransfer(); dt.items.add(file);
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  r.ok(await until(async () => /\.png/.test(await ta.inputValue()) && !(await ta.inputValue()).includes("uploading")), `an image pasted into the composer is uploaded and its path inserted ("${(await ta.inputValue()).trim()}")`);
  r.ok(!(await ta.inputValue()).includes("!["), "…as a bare path, not a markdown image tag");
  await ta.fill("");
  // A type the server does not take (a Mac clipboard TIFF, a BMP) is re-encoded to PNG first.
  const bmp1x1 = "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAAAAD/AA==";
  await ta.focus();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], "shot.bmp", { type: "image/bmp" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, bmp1x1);
  r.ok(await until(async () => /\.png /.test(await ta.inputValue()) && !(await ta.inputValue()).includes("uploading")), `a BMP pasted is converted and attached as a .png ("${(await ta.inputValue()).trim()}")`);
  await ta.fill("");
  // Two images in one paste → two paths.
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "a.png", { type: "image/png" })); dt.items.add(new File([png], "b.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  r.ok(await until(async () => ((await ta.inputValue()).match(/\.png/g) || []).length === 2 && !(await ta.inputValue()).includes("uploading")), "…two images in one paste attach two paths");
  await ta.fill("");
  // A refused upload is said under the composer, the placeholder goes.
  await page.route("**/api/sessions/alpha/upload", (rt) => rt.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "too big for the test" }) }));
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "a.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const stEl = page.locator("#chat-container .chat-draft-st");
  r.ok(await until(async () => /Image not attached — too big for the test/.test(await stEl.textContent()) && !(await ta.inputValue()).includes("uploading")), `a refused upload says why under the composer ("${await stEl.textContent()}")`);
  await page.unroute("**/api/sessions/alpha/upload");
  await ta.fill("");
  // 📎 picks files; a non-image among them is refused with a word.
  const pngBuf = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  r.ok(await page.locator("#chat-container .chat-attach").isVisible(), "the composer has a 📎 button");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#chat-container .chat-attach").click()]);
  await chooser.setFiles([{ name: "pick.png", mimeType: "image/png", buffer: pngBuf }, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  r.ok(await until(async () => /\.png/.test(await ta.inputValue()) && !(await ta.inputValue()).includes("uploading")), "…a picked image is attached");
  r.ok(/Only images can be attached/.test(await stEl.textContent()), "…the text file is refused with a word");
  await ta.fill("");
  // Out of order: the first upload is held back, the second finishes first, the user removes the
  // first's placeholder and keeps typing — each path lands in its own place, the caret stays put.
  let release; const held = new Promise((res) => { release = res; });
  let nUp = 0;
  await page.route("**/api/sessions/alpha/upload", async (rt) => { nUp++; if ((rt.request().postDataBuffer() || []).length > 100) await held; await rt.continue(); });
  await ta.fill("A ");
  await ta.focus();
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const t = document.querySelector("#chat-container .chat-input");
    t.setSelectionRange(t.value.length, t.value.length);
    for (const name of ["first.png", "second.png"]) {
      // the first carries trailing bytes so the route can hold exactly it back
      const dt = new DataTransfer(); dt.items.add(new File(name === "first.png" ? [png, new Uint8Array(64)] : [png], name, { type: "image/png" }));
      t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  });
  r.ok(await until(async () => /^A \[uploading image [0-9a-z]+…\]\S*\.png $/.test(await ta.inputValue())), `…the second upload finishes first into ITS place ("${await ta.inputValue()}")`);
  await page.evaluate(() => {
    const t = document.querySelector("#chat-container .chat-input");
    t.value = t.value.replace(/\[uploading image [0-9a-z]+…\]/, ""); t.dispatchEvent(new Event("input", { bubbles: true }));
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await ta.pressSequentially("tail");
  release();
  await page.waitForTimeout(800);
  const outOfOrder = await ta.inputValue();
  r.ok((outOfOrder.match(/\.png/g) || []).length === 1 && outOfOrder.endsWith(".png tail"), `…the first, whose placeholder was removed, takes nobody else's place ("${outOfOrder}")`);
  await page.unroute("**/api/sessions/alpha/upload");
  // The caret is kept while an upload lands in front of it.
  let release2; const held2 = new Promise((res) => { release2 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held2; await rt.continue(); });
  await ta.fill("");
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "c.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await ta.pressSequentially(" look at this");
  release2();
  r.ok(await until(async () => /\.png  look at this$/.test(await ta.inputValue())), `…typing after a pending image stays where it was typed ("${await ta.inputValue()}")`);
  const caretAtEnd = await page.evaluate(() => { const t = document.querySelector("#chat-container .chat-input"); return t.selectionStart === t.value.length; });
  r.ok(caretAtEnd, "…and the caret is still at the end");
  await page.unroute("**/api/sessions/alpha/upload");
  await ta.fill("");
  // Switched away and back while an upload is in flight: the composer was re-rendered, the path
  // lands in the live one (where the draft brought the placeholder back) and nothing is left waiting.
  let release3; const held3 = new Promise((res) => { release3 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held3; await rt.continue(); });
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "away.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => /\[uploading image [0-9a-z]+…\]/.test(await ta.inputValue())), `…back on Alpha the placeholder is in the new composer ("${await ta.inputValue()}")`);
  release3();
  r.ok(await until(async () => /\.png $/.test(await ta.inputValue()) && !(await ta.inputValue()).includes("uploading")), `…and the upload finishing lands its path there ("${await ta.inputValue()}")`);
  await page.unroute("**/api/sessions/alpha/upload");
  await ta.fill("");
  // Away and back with an upload running, then the placeholder removed and new text typed in the
  // re-rendered composer: the detached old one must not save its stale text over it.
  let release6; const held6 = new Promise((res) => { release6 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held6; await rt.continue(); });
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "away2.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => /uploading image/.test(await ta.inputValue())), "away and back with an upload running");
  await ta.fill("");
  await ta.pressSequentially("newer text");
  await page.waitForTimeout(400);
  // away again BEFORE it finishes: no composer of Alpha on the page when it does
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  release6();
  await page.waitForTimeout(1200);
  await page.unroute("**/api/sessions/alpha/upload");
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => (await ta.inputValue()) === "newer text"), `…the draft is the new text, not the old composer's ("${await ta.inputValue()}")`);
  // …and an upload that finishes while Alpha is away lands in its saved draft.
  let release7; const held7 = new Promise((res) => { release7 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held7; await rt.continue(); });
  await ta.fill("caption ");
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const t = document.querySelector("#chat-container .chat-input"); t.setSelectionRange(t.value.length, t.value.length);
    const dt = new DataTransfer(); dt.items.add(new File([png], "away3.png", { type: "image/png" }));
    t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  release7();
  await page.waitForTimeout(1200);
  await page.unroute("**/api/sessions/alpha/upload");
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => /^caption \S+\.png $/.test(await ta.inputValue())), `…an upload finishing while Alpha is away lands in its draft ("${await ta.inputValue()}")`);
  await ta.fill("");
  // Send is held while an upload runs, and a placeholder left by a reload (no upload behind it) is named.
  let release4; const held4 = new Promise((res) => { release4 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held4; await rt.continue(); });
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "wait.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await ta.press("End"); await ta.press("Enter");
  r.ok(await until(async () => /Wait for the image to upload/.test(await stEl.textContent())), `Enter while an upload runs waits for it ("${await stEl.textContent()}")`);
  r.ok(/uploading image/.test(await ta.inputValue()), "…nothing was sent");
  // tabs → split while it runs: the path lands in the composer on screen too.
  await page.locator(".wh-layout-btn").click();
  const splitTa = page.locator(".split-pane .chat-input");
  r.ok(await until(async () => (await splitTa.count()) === 1 && /uploading image/.test(await splitTa.inputValue())), "…a split shows the chat with the placeholder in its composer");
  release4();
  r.ok(await until(async () => /\.png $/.test(await splitTa.inputValue()) && !(await splitTa.inputValue()).includes("uploading")), `…the upload finishing lands in the split's composer ("${await splitTa.inputValue()}")`);
  await page.unroute("**/api/sessions/alpha/upload");
  await page.locator(".wh-layout-btn").click(); await page.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await page.locator(".split-pane .chat-input").count()) === 0 && (await ta.count()) === 1), "…back to tabs");
  // In the split, the user removes the placeholder and types on before the upload ends: the hidden
  // tab copy (still holding it) must not save its stale text over theirs.
  let release5; const held5 = new Promise((res) => { release5 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held5; await rt.continue(); });
  await ta.fill("");
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "gone.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await splitTa.count()) === 1 && /uploading image/.test(await splitTa.inputValue())), "split again with an upload running");
  await splitTa.fill("");
  await splitTa.pressSequentially("newer text");
  await page.waitForTimeout(400);
  release5();
  await page.waitForTimeout(1200);
  r.ok((await splitTa.inputValue()) === "newer text", `…the placeholder removed in the split stays removed ("${await splitTa.inputValue()}")`);
  await page.unroute("**/api/sessions/alpha/upload");
  await page.locator(".wh-layout-btn").click(); await page.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await page.locator(".split-pane .chat-input").count()) === 0 && (await ta.count()) === 1), "…back to tabs");
  r.ok(await until(async () => (await ta.inputValue()) === "newer text"), `…the draft is what the user typed, not the hidden copy's stale text ("${await ta.inputValue()}")`);
  // …and the same with a switch to Beta before it finishes: the tab's hidden copy is then the only
  // Alpha composer left on the page, and it still must not save its stale text.
  let release8; const held8 = new Promise((res) => { release8 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held8; await rt.continue(); });
  await ta.fill("");
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "gone2.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await splitTa.count()) === 1 && /uploading image/.test(await splitTa.inputValue())), "split with an upload running, once more");
  await splitTa.fill("");
  await splitTa.pressSequentially("split newer");
  await page.waitForTimeout(400);
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.waitForTimeout(300);
  release8();
  await page.waitForTimeout(1200);
  await page.unroute("**/api/sessions/alpha/upload");
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  const layoutBack = async () => { for (let i = 0; i < 3 && (await page.locator(".split-pane .chat-input").count()) > 0; i++) { await page.locator(".wh-layout-btn").click(); await page.waitForTimeout(300); } };
  await layoutBack();
  if ((await ta.count()) === 0) await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => (await ta.inputValue()) === "split newer"), `…switched to Beta before it finished: the draft is still what the user typed ("${await ta.inputValue()}")`);
  await ta.fill("");
  await ta.fill("before [uploading image zz9q…] after");
  await ta.press("End"); await ta.press("Enter");
  r.ok(await until(async () => /An image upload was interrupted — remove \[uploading image zz9q…\]/.test(await stEl.textContent())), `a placeholder with no upload behind it is named, not waited on ("${await stEl.textContent()}")`);
  await ta.fill("");
  // JPEG re-encoding paints transparency white (black would hide dark text); a PNG under the cap goes as it is.
  const conv = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 2; c.height = 1;
    const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, 1, 1); // pixel 1 black, pixel 2 transparent
    const png = await new Promise((res) => c.toBlob(res, "image/png"));
    const jpg = await reencodeImage(new File([png], "t.png", { type: "image/png" }), "image/jpeg", 0.95);
    const bmp = await createImageBitmap(jpg); const d = document.createElement("canvas"); d.width = 2; d.height = 1;
    const dg = d.getContext("2d"); dg.drawImage(bmp, 0, 0);
    const px = [...dg.getImageData(1, 0, 1, 1).data];
    const big = new File([new Uint8Array(11.5 * 1024 * 1024)], "big.png", { type: "image/png" });
    return { type: jpg.type, px, same: (await uploadableImage(big)) === big };
  });
  r.ok(conv.type === "image/jpeg" && conv.px[0] > 200 && conv.px[1] > 200 && conv.px[2] > 200, `…a transparent pixel re-encoded to JPEG is white (${conv.px.join(",")})`);
  r.ok(conv.same, "…an 11.5 MiB PNG is uploaded unchanged");
  // An upload failing while Alpha is away is said in Alpha's composer on return.
  let release9; const held9 = new Promise((res) => { release9 = res; });
  await page.route("**/api/sessions/alpha/upload", async (rt) => { await held9; await rt.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "refused while away" }) }); });
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "fail.png", { type: "image/png" }));
    document.querySelector("#chat-container .chat-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  release9();
  await page.waitForTimeout(800);
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => /Image not attached — refused while away/.test(await stEl.textContent()) && !(await ta.inputValue()).includes("uploading")), `…an upload that failed while Alpha was away is said on return ("${await stEl.textContent()}" / "${await ta.inputValue()}")`);
  await page.unroute("**/api/sessions/alpha/upload");
  await ta.fill("");
  // A draft save in flight when the user types on and switches away: the old composer's PATCH,
  // answered while Alpha is away, moves the saved draft's revision under the later typing — the
  // return is no "changed on another device" against this device's own text.
  let release10; const held10 = new Promise((res) => { release10 = res; });
  let patches10 = 0;
  await page.route("**/api/sessions/alpha/draft", async (rt) => { if (rt.request().method() === "PATCH" && patches10++ === 0) await held10; await rt.continue(); });
  await ta.fill("saving");
  r.ok(await until(async () => patches10 > 0), "a draft PATCH is in flight (held)");
  await ta.pressSequentially(" and more, typed key by key past twenty", { delay: 5 }); // > 20 input events
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  await page.locator("#af-chat-btn").click();
  release10();
  await page.waitForTimeout(800);
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").click();
  r.ok(await until(async () => ((await draft()) || {}).text === "saving and more, typed key by key past twenty"), `…back on Alpha the later typing is synced (${JSON.stringify(((await draft()) || {}).text)})`);
  const notice10 = page.locator("#chat-container .chat-notice");
  r.ok((await ta.inputValue()) === "saving and more, typed key by key past twenty" && ((await notice10.count()) === 0 || await notice10.evaluate((el) => el.hidden)), "…no conflict notice against this device's own text, the composer keeps it");
  await page.unroute("**/api/sessions/alpha/draft");
  await ta.fill("");
  // A drop with no readable file (Photos.app's file promise) says so.
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add("x", "text/plain");
    const c = document.querySelector("#chat-container .chat-composer");
    Object.defineProperty(dt, "types", { value: ["Files"] });
    c.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  r.ok(await until(async () => /Nothing attached — this drag carries no file/.test(await stEl.textContent())), `…an empty file drop says why ("${await stEl.textContent()}")`);
  // Drag and drop onto the composer.
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], "drop.png", { type: "image/png" }));
    const c = document.querySelector("#chat-container .chat-composer");
    c.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    c.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  r.ok(await until(async () => /\.png/.test(await ta.inputValue()) && !(await ta.inputValue()).includes("uploading")), "an image dropped on the composer is attached");
  await ta.fill("");

  await page.screenshot({ path: join(screenshotDir(), "m33-composer.png") });
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ")})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
