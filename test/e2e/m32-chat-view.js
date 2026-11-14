/**
 * Module M32 — the chat view (tab "chat", client/chat.js over GET /api/sessions/:id/conversation).
 *
 * A claude agent's conversation as claude recorded it, drawn like a chat app in
 * a real browser:
 *   - "💬 Chat" in the file panel opens a Chat tab: the user's prompt as a bubble,
 *     the reply's markdown rendered (heading, list), a code block with a sticky
 *     header naming the language + Copy, a collapsed Thinking line, tool cards
 *     collapsed to one line (name + path relative to the agent's cwd, ✓ / ✗ from
 *     the result) behind a run summary row ("Read a file, edited a file · +1 −1
 *     · 1 failed") until it is opened, the Edit card expanding to a −/+ diff and
 *     its error result; the density switch (Verbose opens every card, Standard
 *     folds them again),
 *     the turn's duration under the reply
 *   - a record appended to the transcript lands within the poll WITHOUT
 *     rebuilding the elements already on screen (a marker set on the old
 *     element survives — a text selection would too), and the view follows
 *     the tail while the reader is at the bottom
 *   - scrolled up: the tail no longer moves the reader; a "↓ N new" pill counts
 *     what arrived, a click jumps to the bottom
 *   - the transcript replaced by a shorter file (generation moved) drops the
 *     picture instead of extending it
 *   - View → Chat View First makes the conversation the landing tab (persisted,
 *     survives a reload); a shell agent's chat says it has no conversation
 *   - hostile HTML quoted in a reply is rendered inert (sanitised markdown);
 *     an open Thinking survives its message's re-render; scrolled up, then
 *     Primary and back → the reader's place is kept with the pill, a new
 *     exchange counts on it, the jump follows again; a multi-screen reply
 *     while following keeps the view at the bottom, no pill; 1200 records
 *     appended at once (more than one tick's pages) all arrive, the view at
 *     the bottom; a server-side cache rebuild while the tab
 *     was away loses nothing (new generation) and keeps a scrolled-up reader's
 *     place, counting what was written meanwhile; an adopted second session
 *     id paints the new conversation
 *   - a message that grows a text block while the reader is scrolled up counts
 *     on the pill, and its Thinking node is kept (block-level patch); blocked
 *     → "Needs input — <reason> · Open Primary" and NO ack from the chat tab
 *     until Primary is opened; working → "last activity Ns ago" + the pending
 *     glyph on a result-less tool card follows the pane's state; done at the
 *     bottom → acked; server unreachable → an offline banner, no live line
 *
 * Run: node test/e2e/m32-chat-view.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, mkdtempSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M32 chat view");
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m32-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.HADRON_CONVERSATION_IDLE_MS = "1500"; // the server drops an unpolled conversation cache after 1.5 s (prod: 10 min)
const SID = randomUUID();
const now = () => new Date().toISOString();
const rec = (o) => JSON.stringify({ uuid: randomUUID(), timestamp: now(), ...o }) + "\n";
const user = (text) => rec({ type: "user", message: { role: "user", content: text } });
const asst = (id, block, extra = {}) => rec({ type: "assistant", message: { id, role: "assistant", content: [block], model: "claude-x", usage: { input_tokens: 10, output_tokens: 5 }, ...extra } });
const result = (toolId, text, isError = false) => rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: text, is_error: isError }] } });
let transcript, ws;
const env = await bootWorkspace({
  name: "m32",
  seed(w) {
    ws = w;
    const dir = join(CONFIG, "projects", claudeProjectDir(ws));
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(ws, ".hadron", "agents"), { recursive: true });
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "app.js"), "console.log('app')\n");
    writeFileSync(join(ws, ".hadron", "agents", "alpha.json"), JSON.stringify({
      id: "alpha", name: "Alpha", group: "Workers", cwd: ws,
      runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: SID, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() },
    }, null, 2));
    transcript = join(dir, `${SID}.jsonl`);
    writeFileSync(transcript,
      user("你好，帮我看看 src/app.js 里的日志调用") +
      asst("m1", { type: "thinking", thinking: "The user wants me to look at app.js first." }) +
      asst("m1", { type: "text", text: "## 看一下文件\n\n先读一下，然后给个例子：\n\n```js\nconsole.log('app');\n```\n\n- 第一点\n- 第二点" }) +
      asst("m1", { type: "tool_use", id: "t-read", name: "Read", input: { file_path: join(ws, "src", "app.js") } }) +
      result("t-read", "console.log('app')\n") +
      asst("m2", { type: "tool_use", id: "t-edit", name: "Edit", input: { file_path: join(ws, "src", "app.js"), old_string: "console.log('app')", new_string: "console.info('app')" } }) +
      result("t-edit", "String to replace not found in file.", true) +
      asst("m3", { type: "text", text: "改好了。" }, { stop_reason: "end_turn" }) +
      rec({ type: "system", subtype: "turn_duration", durationMs: 45200 }));
  },
});
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
// Chat View First is on from its section onwards: Primary is opened from the
// file panel (or its tab, once open) and the chat is its own tab.
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, { method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}) });

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // Chat View First is on from its section onwards: Primary is opened from the
  // file panel (or its tab, once open) and the chat is its own tab.
  const openPrimary = async () => { if (await page.locator("#af-term-btn").count()) await page.locator("#af-term-btn").click(); else await page.locator(".wh-tab", { hasText: "Primary" }).click(); };
  const backToChat = async () => { if (await page.locator("#af-chat-btn").count()) await page.locator("#af-chat-btn").click(); else await page.locator(".wh-tab", { hasText: "Chat" }).click(); };
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  await page.locator("#af-chat-btn").waitFor({ state: "visible", timeout: 5000 });
  await backToChat();
  const chat = page.locator("#chat-container");
  r.ok(await until(async () => (await chat.locator(".ci-user").count()) === 1 && (await chat.locator(".ci-assistant").count()) === 3), `Chat tab paints the conversation: 1 prompt, 3 assistant messages (${await chat.locator(".ci").count()} items)`);
  r.ok(await chat.evaluate((el) => el.classList.contains("active")) && (await page.locator(".wh-tab.active").textContent()).includes("Chat"), "…the Chat tab is active in the work header");
  r.ok((await chat.locator(".ci-user .ci-bubble").textContent()).includes("帮我看看 src/app.js"), "the prompt is a bubble with the Chinese text verbatim");
  const m1 = chat.locator(".ci-assistant").first();
  r.ok((await m1.locator(".ci-md h2").textContent()) === "看一下文件" && (await m1.locator(".ci-md li").count()) === 2, "the reply's markdown is rendered (h2 + list)");
  r.ok((await m1.locator(".ci-code .ci-code-lang").textContent()) === "js" && (await m1.locator(".ci-code .ci-code-copy").textContent()) === "Copy", "the code block has a header naming the language + Copy");
  // Plain http over Tailscale is not a secure context: no navigator.clipboard.
  // Copy must still work (execCommand fallback), never "Copy failed".
  await page.evaluate(() => { window.__cb = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard"); Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined, configurable: true }); });
  await m1.locator(".ci-code .ci-code-copy").click();
  r.ok(await until(async () => (await m1.locator(".ci-code .ci-code-copy").textContent()) === "Copied"), `…Copy works without navigator.clipboard (plain http) — ${await m1.locator(".ci-code .ci-code-copy").textContent()}`);
  await page.evaluate(() => { if (window.__cb) Object.defineProperty(Navigator.prototype, "clipboard", window.__cb); });
  r.ok((await m1.locator(".ci-think").count()) === 1 && !(await m1.locator(".ci-think").evaluate((d) => d.open)), "Thinking is one collapsed line");
  // Read (m1) then Edit (m2) with nothing said between: one tool run, drawn
  // as a summary row until opened (CHAT_RULES.toolRun, Standard density).
  const grp = chat.locator(".ci-group");
  r.ok((await grp.count()) === 1 && /Read a file, edited a file/.test(await grp.textContent()) && /\+1 −1/.test(await grp.textContent()) && /1 failed/.test(await grp.textContent()) && (await grp.locator(".ci-tool-st").textContent()) === "✗", `the Read + Edit run is one summary row with counts, +/− and the failure (${(await grp.textContent()).trim()})`);
  r.ok(!(await m1.locator(".ci-tool").isVisible()) && !(await chat.locator(".ci-assistant").nth(1).locator(".ci-tool").isVisible()), "…its cards are hidden behind it");
  await grp.click();
  r.ok(await until(async () => await m1.locator(".ci-tool").isVisible()), "…a click on the row shows each card");
  const readCard = m1.locator(".ci-tool");
  r.ok((await readCard.locator(".ci-tool-name").textContent()) === "Read" && (await readCard.locator(".ci-tool-sum").textContent()) === "src/app.js" && (await readCard.locator(".ci-tool-st").textContent()) === "✓", `Read card: one line, path relative to the cwd, ✓ from the result (${await readCard.locator(".ci-tool-hd").textContent()})`);
  r.ok(!(await readCard.evaluate((el) => el.classList.contains("open"))) && !(await readCard.locator(".ci-tool-body").isVisible()), "…collapsed");
  const editCard = chat.locator(".ci-assistant").nth(1).locator(".ci-tool");
  r.ok((await editCard.locator(".ci-tool-st").textContent()) === "✗", "Edit card shows ✗ — its result was an error");
  await editCard.locator(".ci-tool-hd").click();
  r.ok(await editCard.locator(".ci-tool-body").isVisible() && (await editCard.locator(".ci-diff .ci-l-del").textContent()).includes("console.log") && (await editCard.locator(".ci-diff .ci-l-add").textContent()).includes("console.info"), "…click expands it to a −/+ diff of old/new");
  r.ok((await editCard.locator(".ci-tool-res.err pre").textContent()).includes("not found"), "…with the error text under it");
  r.ok((await chat.locator(".ci-turn").textContent()).includes("45s"), "the turn's duration (45 s) is drawn under the reply");
  r.ok((await chat.locator(".chat-live").isVisible()) === false, "no live 'Working' line for an idle agent");
  await page.screenshot({ path: join(screenshotDir(), "m32-chat.png") });

  // ── incremental: a new exchange lands without rebuilding what is on screen ──
  await m1.evaluate((el) => { el.dataset.mark = "kept"; });
  const scroll = chat.locator(".chat-scroll");
  await scroll.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = el.scrollHeight; });
  appendFileSync(transcript, user("再加一行") + asst("m4", { type: "text", text: "加好了 — 第二轮。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await chat.locator(".ci-assistant").count()) === 4 && (await chat.locator(".ci-user").count()) === 2), "an appended exchange appears within the poll");
  r.ok((await m1.getAttribute("data-mark")) === "kept", "…the elements of unchanged items were left alone (marker survived)");
  r.ok(await until(async () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48)), "…and the view followed the tail (reader was at the bottom)");

  // ── scrolled up: the tail waits, a pill counts the new items ──
  await scroll.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = 0; });
  await scroll.dispatchEvent("scroll");
  r.ok(await until(async () => (await chat.locator(".chat-jump").isVisible())), "scrolled to the top → the ↓ pill appears");
  appendFileSync(transcript, user("第三轮") + asst("m5", { type: "text", text: "第三轮回复。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await chat.locator(".chat-jump").textContent()) === "↓ 2 new"), `…a new exchange counts on the pill (${await chat.locator(".chat-jump").textContent()})`);
  r.ok((await scroll.evaluate((el) => el.scrollTop)) === 0, "…and the reader was not moved");
  await chat.locator(".chat-jump").click();
  r.ok(await until(async () => (await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48)) && !(await chat.locator(".chat-jump").isVisible())), "…click jumps to the bottom and hides the pill");

  // ── density switch ──
  await chat.locator('.chat-dens[data-d="verbose"]').click();
  r.ok(await until(async () => (await chat.locator(".ci-tool.open").count()) === 2 && (await chat.locator(".ci-group").count()) === 0), "Verbose opens every tool card, no summary row");
  await chat.locator('.chat-dens[data-d="standard"]').click();
  r.ok(await until(async () => (await chat.locator(".ci-tool.open").count()) === 0 && (await chat.locator(".ci-group").count()) === 1 && !(await chat.locator(".ci-group").evaluate((el) => el.classList.contains("open")))), "…Standard closes them all and folds the run again, the hand-opened ones included");

  // ── generation: a shorter file replaces the transcript ──
  writeFileSync(transcript, user("从头来") + asst("m9", { type: "text", text: "新的开始。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await chat.locator(".ci-assistant").count()) === 1 && (await chat.locator(".ci-user .ci-bubble").textContent()).includes("从头来")), "a replaced (shorter) transcript drops the old picture and shows the new one");
  const wire = await (await api("GET", "/api/sessions/alpha/conversation")).json();
  r.ok(wire.generation >= 1 && wire.count === 2, `…the wire's generation moved (${wire.generation}), count ${wire.count}`);

  // ── Chat View First ──
  await page.locator("#menu-view").click();
  await page.locator('.menu-dropdown-item[data-action="toggle-chat-first"]').waitFor({ state: "visible", timeout: 3000 });
  r.ok(!/✓/.test(await page.locator('.menu-dropdown-item[data-action="toggle-chat-first"]').textContent()), "View menu offers Chat View First, unchecked");
  await page.locator('.menu-dropdown-item[data-action="toggle-chat-first"]').click();
  await page.keyboard.press("Escape");
  const shell = await api("POST", "/api/sessions", { name: "Plain", launchCommand: "shell" });
  const plain = (await shell.json()).id;
  await page.locator(`.dk[data-sid="${plain}"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="${plain}"]`).first().click();
  r.ok(await until(async () => (await chat.evaluate((el) => el.classList.contains("active"))) && (await chat.locator(".chat-empty").count()) === 1), "with Chat View First, a new agent opens on its chat; a shell agent's says it has no conversation");
  r.ok((await chat.locator(".chat-empty").textContent()).includes("No conversation yet"), `…(${await chat.locator(".chat-empty").textContent()})`);
  r.ok((await page.locator(".wh-tab", { hasText: "Primary" }).count()) === 0 && (await page.locator("#af-term-btn").count()) === 1 && (await page.locator("#af-chat-btn").count()) === 0, "…the Primary tab is hidden; the file panel offers ⌨ Primary instead of 💬 Chat");
  r.ok((await (await api("GET", "/api/workspace")).json()).landing === "chat", "…the workspace config says landing: chat (every browser, every agent)");
  await page.locator("#af-term-btn").click();
  r.ok(await until(async () => (await page.locator(".wh-tab.active", { hasText: "Primary" }).count()) === 1 && (await page.locator('.wh-tab-x[data-close-tab="terminal"]').count()) === 1), "⌨ Primary opens the terminal as a closable tab");
  await page.locator('.wh-tab-x[data-close-tab="terminal"]').click();
  r.ok(await until(async () => (await page.locator(".wh-tab", { hasText: "Primary" }).count()) === 0 && (await chat.evaluate((el) => el.classList.contains("active")))), "…× on it goes back to the chat, Primary hidden again");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  r.ok(await until(async () => (await page.locator("#chat-container").evaluate((el) => el.classList.contains("active"))) && (await page.locator("#chat-container .ci-assistant").count()) === 1), "after a reload the preference holds and alpha lands on its chat");
  r.ok((await page.locator(".wh-tab", { hasText: "Primary" }).count()) === 0, "…with no Primary tab");
  await page.locator("#menu-view").click();
  await page.locator('.menu-dropdown-item[data-action="toggle-chat-first"]').waitFor({ state: "visible", timeout: 3000 });
  r.ok(/✓/.test(await page.locator('.menu-dropdown-item[data-action="toggle-chat-first"]').textContent()), "…View menu shows it checked");
  await page.keyboard.press("Escape");
  // In a split layout the terminal is one of the panes: Primary is on the bar
  // without its ×, and the chat is an ordinary closable tab there.
  await page.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await page.locator(".wh-tab", { hasText: "Primary" }).count()) === 1 && (await page.locator('.wh-tab-x[data-close-tab="terminal"]').count()) === 0), "vsplit: the Primary tab is on the bar with no ×");
  r.ok((await page.locator(".wh-tab", { hasText: "Chat" }).count()) === 1 && (await page.locator('.wh-tab-x[data-close-tab="chat"]').count()) === 1, "…the Chat tab is there as a closable tab");
  await page.locator('.wh-tab-x[data-close-tab="chat"]').click();
  r.ok(await until(async () => (await page.locator(".wh-tab", { hasText: "Chat" }).count()) === 0), "…and × closes it");
  await page.locator(".wh-layout-btn").click(); await page.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await page.locator(".wh-tab", { hasText: "Chat" }).count()) === 1 && (await page.locator('.wh-tab-x[data-close-tab="chat"]').count()) === 0 && (await page.locator("#chat-container").evaluate((el) => el.classList.contains("active")))), "back to tabs: the tab that was active before the split (Chat, the landing, no ×) is active again");
  await page.locator(".wh-tab", { hasText: "Chat" }).click();
  r.ok(await until(async () => (await page.locator(".wh-tab", { hasText: "Primary" }).count()) === 0 && (await chat.evaluate((el) => el.classList.contains("active")))), "…a click on Chat makes it active and Primary (never opened on purpose) hides again");
  // A browser upgraded from before the workspace landing: its ui state has
  // every agent on "terminal" (the old only landing) — forgotten once, so the
  // new default shows; a choice made after that stands.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addInitScript(() => { if (!localStorage.getItem("hadron-ui-state")) localStorage.setItem("hadron-ui-state", JSON.stringify({ activeSessionId: "alpha", perSessionTab: { alpha: "terminal" }, openTabs: { alpha: ["terminal"] } })); });
  const page2 = await ctx2.newPage();
  await page2.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page2.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page2.locator(`.dk[data-sid="alpha"]`).first().click();
  r.ok(await until(async () => (await page2.locator("#chat-container").evaluate((el) => el.classList.contains("active"))) && (await page2.locator(".wh-tab", { hasText: "Primary" }).count()) === 0), "a pre-landing ui state (every agent on terminal) is migrated: alpha opens on its chat, Primary hidden");
  r.ok(await until(async () => { try { return JSON.parse(await page2.evaluate(() => localStorage.getItem("hadron-ui-state"))).landingMigrated === true; } catch { return false; } }), "…and the state is marked migrated");
  // A split straight from the cold landing (the Chat tab never clicked): the
  // landing is an open tab, so the split shows terminal + chat, not a
  // full-screen terminal with no way back to the conversation.
  await page2.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await page2.locator(".split-pane .chat-scroll").count()) === 1 && (await page2.locator(".wh-tab", { hasText: "Chat" }).count()) === 1 && (await page2.locator(".wh-tab", { hasText: "Primary" }).count()) === 1), "vsplit from the cold landing: the chat is a pane beside the terminal, both on the bar");
  // Leaving the split must not persist the terminal it forced as alpha's tab:
  // a reload lands on the chat again.
  await page2.locator(".wh-layout-btn").click(); await page2.locator(".wh-layout-btn").click();
  await until(async () => JSON.parse(await page2.evaluate(() => localStorage.getItem("hadron-ui-state")) || "{}").perSessionLayout?.alpha === "tabs");
  await page2.reload({ waitUntil: "domcontentloaded" });
  await page2.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok(await until(async () => (await page2.locator("#chat-container").evaluate((el) => el.classList.contains("active")))), "…a visit to a split did not turn alpha terminal-landing: after a reload it opens on its chat");
  await ctx2.close();
  // A fresh browser (no ui state at all, nothing clicked): the landing is
  // opened for the agent actually shown, so its first split keeps the chat.
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page3 = await ctx3.newPage();
  await page3.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  r.ok(await until(async () => (await page3.locator("#chat-container").evaluate((el) => el.classList.contains("active")).catch(() => false))), "a fresh browser lands on the chat of the agent it shows");
  await page3.locator(".wh-layout-btn").click();
  r.ok(await until(async () => (await page3.locator(".split-pane .chat-scroll").count()) === 1 && (await page3.locator(".wh-tab", { hasText: "Chat" }).count()) === 1), "…and its first split, with no card clicked, shows the chat beside the terminal");
  r.ok(!Object.hasOwn(JSON.parse(await page3.evaluate(() => localStorage.getItem("hadron-ui-state")) || "{}").openTabs || {}, "null"), "…no open set is kept for agent null");
  await ctx3.close();

  // ── more than a page: Load earlier prepends with the reader's place kept ──
  let bulk = "";
  for (let i = 0; i < 120; i++) bulk += user(`问题 ${i}`) + asst(`b${i}`, { type: "text", text: `回答 ${i}` }, { stop_reason: "end_turn" });
  appendFileSync(transcript, bulk);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  const chat2 = page.locator("#chat-container");
  r.ok(await until(async () => (await chat2.locator(".ci").count()) === 200), `a long conversation opens on its last page (${await chat2.locator(".ci").count()} items of 242)`);
  r.ok(await until(async () => (await chat2.locator(".chat-earlier").isVisible()) && (await chat2.locator(".chat-earlier").textContent()) === "Load earlier (42 more)"), `…with "Load earlier (42 more)" on top (${await chat2.locator(".chat-earlier").textContent()})`);
  const sc2 = chat2.locator(".chat-scroll");
  await sc2.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = 0; });
  const topText = await chat2.locator(".ci").first().getAttribute("data-id");
  const topY = await chat2.locator(".ci").first().evaluate((el) => el.getBoundingClientRect().top);
  await chat2.locator(".chat-earlier").click();
  r.ok(await until(async () => (await chat2.locator(".ci").count()) === 242 && !(await chat2.locator(".chat-earlier").isVisible())), "…click prepends the rest and the button goes away");
  const y2 = await chat2.locator(`.ci[data-id="${topText}"]`).evaluate((el) => el.getBoundingClientRect().top);
  r.ok(Math.abs(y2 - topY) < 4 && (await chat2.locator(".ci").first().locator(".ci-bubble").textContent()).includes("从头来"), `…the item the reader was looking at stayed put (${Math.round(topY)} → ${Math.round(y2)}), the first prompt is on top`);

  // ── hostile HTML in the reply is rendered inert ──
  appendFileSync(transcript, user("试试") + asst("mx", { type: "text", text: "前文 <img src=x onerror=\"window.__pwned=1\"> <script>window.__pwned=2</script> [点我](javascript:window.__pwned=3) <a href=\"https://example.com\" onclick=\"window.__pwned=4\">ok</a> 后文" }, { stop_reason: "end_turn" }));
  const mx = chat2.locator('.ci-assistant[data-id="a:mx"]');
  r.ok(await until(async () => (await mx.count()) === 1), "a reply quoting hostile HTML lands");
  r.ok((await mx.locator("script, [onerror], [onclick], a[href^='javascript']").count()) === 0 && (await mx.locator("a[href='https://example.com']").count()) === 1 && (await mx.textContent()).includes("后文"), "…script, on* handlers and javascript: links are stripped, the plain link and the text stay");
  r.ok((await page.evaluate(() => window.__pwned)) === undefined, "…nothing ran");

  // ── an open Thinking survives its message's rev moving (a tool result landing) ──
  appendFileSync(transcript, user("想想") + asst("mt", { type: "thinking", thinking: "let me think about this carefully" }) + asst("mt", { type: "text", text: "先看一下。" }));
  const mt = chat2.locator('.ci-assistant[data-id="a:mt"]');
  r.ok(await until(async () => (await mt.locator(".ci-think").count()) === 1), "a reply with Thinking lands");
  await mt.locator(".ci-think summary").click();
  r.ok(await mt.locator(".ci-think").evaluate((d) => d.open), "…opened by hand");
  appendFileSync(transcript, asst("mt", { type: "tool_use", id: "t-x", name: "Bash", input: { command: "ls" } }) + result("t-x", "a\nb"));
  r.ok(await until(async () => (await mt.locator(".ci-tool").count()) === 1 && (await mt.locator(".ci-tool-st").textContent()) === "✓"), "…the tool call + result re-render the message (rev moved)");
  r.ok(await mt.locator(".ci-think").evaluate((d) => d.open), "…and Thinking is still open");

  // ── scrolled up, then away and back: the reader's place is kept ──
  if (await chat2.locator(".chat-jump").isVisible()) await chat2.locator(".chat-jump").click(); // a known start: following, nothing counted
  r.ok(await until(async () => !(await chat2.locator(".chat-jump").isVisible())), "following before the scroll-up (pill hidden)");
  await sc2.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = 900; });
  await sc2.dispatchEvent("scroll");
  r.ok(await until(async () => (await chat2.locator(".chat-jump").isVisible())), "scrolled up → pill");
  const placeId = await sc2.evaluate((el) => { const top = el.getBoundingClientRect().top; return [...el.querySelectorAll(".ci")].find((c) => c.getBoundingClientRect().bottom > top).dataset.id; });
  const placeY = await page.locator(`#chat-container .ci[data-id="${placeId}"]`).evaluate((el) => el.getBoundingClientRect().top);
  await openPrimary();
  await backToChat();
  const sc3 = page.locator("#chat-container .chat-scroll");
  const placeY2 = await until(async () => Math.abs((await page.locator(`#chat-container .ci[data-id="${placeId}"]`).evaluate((el) => el.getBoundingClientRect().top)) - placeY) < 4);
  r.ok(placeY2 && (await page.locator("#chat-container .chat-jump").isVisible()), `Primary and back: the item the reader was on is where it was (${Math.round(placeY)}px), the pill is still there`);
  appendFileSync(transcript, user("回来了") + asst("mb", { type: "text", text: "在底部。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await page.locator("#chat-container .chat-jump").textContent()) === "↓ 2 new"), `…a new exchange counts on the pill (${await page.locator("#chat-container .chat-jump").textContent()})`);
  r.ok(Math.abs((await page.locator(`#chat-container .ci[data-id="${placeId}"]`).evaluate((el) => el.getBoundingClientRect().top)) - placeY) < 4, "…and did not move the reader");
  await page.locator("#chat-container .chat-jump").click();
  r.ok(await until(async () => (await sc3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48)) && !(await page.locator("#chat-container .chat-jump").isVisible()) && (await page.locator('#chat-container .ci-assistant[data-id="a:mb"]').count()) === 1), "…the jump lands at the bottom, pill gone");
  appendFileSync(transcript, user("再来") + asst("mb2", { type: "text", text: "还在底部。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:mb2"]').count()) === 1 && (await sc3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48)) && !(await page.locator("#chat-container .chat-jump").isVisible())), "…and the view follows the next exchange, no phantom pill");

  // ── a multi-screen reply while following keeps the view at the bottom ──
  // (the operator's call over "land at its start", 2026-11-08: new output
  // should scroll into view unless the reader scrolled up on purpose)
  const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：这是一段很长的中文回答，用来把视口撑开，看看视图是不是跟到了底部。`).join("\n\n");
  appendFileSync(transcript, user("写长一点") + asst("ml", { type: "text", text: long }, { stop_reason: "end_turn" }));
  const ml = page.locator('#chat-container .ci-assistant[data-id="a:ml"]');
  r.ok(await until(async () => (await ml.count()) === 1 && (await sc3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48))), "a reply taller than the view arrives → the view follows to its end");
  r.ok((await sc3.evaluate((el) => el.scrollHeight)) > (await sc3.evaluate((el) => el.clientHeight)) * 2 && !(await page.locator("#chat-container .chat-jump").isVisible()), "…the reply is several screens tall and no pill is up (nothing unseen)");

  // ── a message that grows while the reader is away counts, and keeps its nodes ──
  await sc3.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = 0; });
  await sc3.dispatchEvent("scroll");
  r.ok(await until(async () => (await page.locator("#chat-container .chat-jump").isVisible())), "scrolled up again");
  appendFileSync(transcript, user("想一下") + asst("mg", { type: "thinking", thinking: "thinking first, a long answer follows" }));
  r.ok(await until(async () => (await page.locator("#chat-container .chat-jump").textContent()) === "↓ 2 new"), `a prompt + a Thinking-only reply count 2 (${await page.locator("#chat-container .chat-jump").textContent()})`);
  const mg = page.locator('#chat-container .ci-assistant[data-id="a:mg"]');
  await mg.locator(".ci-think").evaluate((el) => { el.dataset.mark = "kept"; });
  appendFileSync(transcript, asst("mg", { type: "text", text: "答案来了。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await mg.locator(".ci-md").count()) === 1 && (await page.locator("#chat-container .chat-jump").textContent()) === "↓ 3 new"), `…the text block landing on the SAME message counts once more (${await page.locator("#chat-container .chat-jump").textContent()})`);
  r.ok((await mg.locator(".ci-think").getAttribute("data-mark")) === "kept", "…and the Thinking node was kept, not rebuilt (a selection in it would survive)");
  // an empty thinking block renders no node; the blocks after it must still be matched by index, not position
  appendFileSync(transcript, asst("me", { type: "thinking", thinking: "" }) + asst("me", { type: "text", text: "第一段。" }));
  const me = page.locator('#chat-container .ci-assistant[data-id="a:me"]');
  r.ok(await until(async () => (await me.locator(".ci-md").count()) === 1), "a reply with an empty Thinking block then text paints the text");
  await me.locator(".ci-md").evaluate((el) => { el.dataset.mark = "kept"; });
  appendFileSync(transcript, asst("me", { type: "text", text: "第二段。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await me.locator(".ci-md").count()) === 2), "…a second text block lands");
  r.ok((await me.locator(".ci-md").first().getAttribute("data-mark")) === "kept", "…and the first text node was kept (empty block before it did not shift the match)");
  r.ok((await me.locator(".ci-md").first().textContent()).includes("第一段") && (await me.locator(".ci-md").nth(1).textContent()).includes("第二段"), "…in order");
  await page.locator("#chat-container .chat-jump").click();
  r.ok(await until(async () => (await sc3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48))), "…jump → bottom");

  // ── honest state: blocked hands over to the terminal and is NOT acked from the chat ──
  const sessOf = async () => (await (await api("GET", "/api/sessions")).json()).find((x) => x.id === "alpha");
  await api("PATCH", "/api/sessions/alpha", { state: "blocked", blockReason: "permission" });
  const live = page.locator("#chat-container .chat-live");
  r.ok(await until(async () => (await live.isVisible()) && /Needs input — permission/.test(await live.textContent()) && (await live.locator(".chat-open-primary").count()) === 1), `blocked → "Needs input — permission · Open Primary" in the chat (${(await live.textContent()).trim()})`);
  await wait(2500);
  let s0 = await sessOf();
  r.ok(s0.attentionRev > (s0.ackRev || 0), `…2.5 s on the chat tab did NOT ack it (attentionRev ${s0.attentionRev}, ackRev ${s0.ackRev}) — the dialog is in the terminal`);
  await live.locator(".chat-open-primary").click();
  r.ok(await until(async () => (await page.locator(".wh-tab.active").textContent()).includes("Primary")), "…Open Primary switches to the terminal tab");
  r.ok(await until(async () => { const x = await sessOf(); return x.ackRev === x.attentionRev; }, 6000), "…where the dwell acks it");
  await backToChat();
  await api("PATCH", "/api/sessions/alpha", { state: "working" });
  appendFileSync(transcript, user("跑一下") + asst("mw", { type: "tool_use", id: "t-w", name: "Bash", input: { command: "ls -la" } }));
  r.ok(await until(async () => (await live.isVisible()) && /Working · last activity \d+s ago · running: Bash ls -la/.test(await live.textContent())), `working → "last activity Ns ago · running: Bash ls -la" (${(await live.textContent()).trim()})`);
  const stW = page.locator('#chat-container .ci-assistant[data-id="a:mw"] .ci-tool-st');
  const glyph = async () => stW.evaluate((el) => getComputedStyle(el, "::before").content);
  r.ok((await glyph()) === '"…"', `…the result-less tool card shows "…" while the pane works (${await glyph()})`);
  appendFileSync(transcript, result("t-w", "total 0"));
  r.ok(await until(async () => /· Bash ✓$/.test((await live.textContent()).trim())), `…the result landing turns the activity into "Bash ✓" (${(await live.textContent()).trim()})`);
  appendFileSync(transcript, asst("mw", { type: "tool_use", id: "t-w2", name: "Bash", input: { command: "pwd" } }));
  const stW2 = page.locator('#chat-container .ci-assistant[data-id="a:mw"] [data-tool="t-w2"] .ci-tool-st');
  r.ok(await until(async () => (await stW2.count()) === 1 && (await stW2.evaluate((el) => getComputedStyle(el, "::before").content)) === '"…"'), "a second call without a result: …");
  const grpW = page.locator('#chat-container .ci-assistant[data-id="a:mw"] .ci-group');
  r.ok(await until(async () => (await grpW.count()) === 1 && /Ran 2 commands/.test(await grpW.textContent()) && (await grpW.locator(".ci-group-now").isVisible()) && /Bash pwd/.test(await grpW.locator(".ci-group-now").textContent()) && (await grpW.locator(".ci-tool-st").evaluate((el) => getComputedStyle(el, "::before").content)) === '"…"'), "…the two calls are one row \"Ran 2 commands\" with \"…\" and \"· Bash pwd\" while the pane works");
  await api("PATCH", "/api/sessions/alpha", { state: "done" });
  r.ok(await until(async () => (await stW2.evaluate((el) => getComputedStyle(el, "::before").content)) === '"–"' && !(await live.isVisible()) && !(await grpW.locator(".ci-group-now").isVisible())), `…done → the glyph is "–" without the message being re-rendered, no live line (${await stW2.evaluate((el) => getComputedStyle(el, "::before").content)})`);
  r.ok(await until(async () => { const x = await sessOf(); return x.ackRev === x.attentionRev && x.attentionRev > s0.attentionRev; }, 6000), "…and done with the latest on screen IS acked from the chat tab");

  // ── offline: a banner, no live claim ──
  await api("PATCH", "/api/sessions/alpha", { state: "working" });
  r.ok(await until(async () => await live.isVisible()), "working again → live line");
  await page.route("**/conversation*", (route) => route.abort());
  const bannerEl = page.locator("#chat-container .chat-banner");
  r.ok(await until(async () => (await bannerEl.isVisible()) && /^Offline/.test(await bannerEl.textContent()) && !(await live.isVisible())), `the server unreachable → an Offline banner and the live line is gone (${await bannerEl.textContent()})`);
  r.ok((await page.locator('#chat-container .ci-assistant[data-id="a:mw"]').count()) === 1, "…the last picture stays");
  await page.unroute("**/conversation*");
  r.ok(await until(async () => !(await bannerEl.isVisible()) && (await live.isVisible())), "…reachable again → banner gone, live line back");
  await api("PATCH", "/api/sessions/alpha", { state: "idle" });

  // ── a catch-up longer than one tick's pages loses nothing ──
  // (the offline spell above outlasted the server's idle cache: the picture
  // was rebuilt as a last page — bring the earlier items back first so the
  // count below is the whole conversation)
  const earlierBtn = page.locator("#chat-container .chat-earlier");
  if (await earlierBtn.isVisible()) { await earlierBtn.click(); await until(async () => !(await earlierBtn.isVisible())); }
  // Following: the prepend above keeps the reader's place, which can leave them
  // paused — jump to the latest so the arrival below meets a following reader.
  const jumpEl = page.locator("#chat-container .chat-jump");
  if (await jumpEl.isVisible()) await jumpEl.click();
  await until(async () => (await sc3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48)) && !(await jumpEl.isVisible()));
  let big = "";
  for (let i = 0; i < 600; i++) big += user(`大 ${i}`) + asst(`g${i}`, { type: "text", text: `回 ${i}` }, { stop_reason: "end_turn" });
  appendFileSync(transcript, big);
  const ci = page.locator("#chat-container .ci");
  let wireN = 0;
  r.ok(await until(async () => { wireN = (await (await api("GET", "/api/sessions/alpha/conversation")).json()).count; return wireN > 1400 && (await ci.count()) === wireN; }, 20000), `1200 records appended at once (more than 5 pages): every item arrives (${await ci.count()} of ${wireN})`);
  // The view follows the tail on every arrival while following (operator's
  // call, 2026-11-08: a reply longer than the screen still lands at its end).
  r.ok(await until(async () => (await sc3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48)) && !(await jumpEl.isVisible())), "…a following reader is taken to the bottom, no pill");

  // ── the server rebuilt its cache while the chat was not polled: nothing is lost ──
  const genBefore = (await (await api("GET", "/api/sessions/alpha/conversation")).json()).generation;
  await openPrimary();
  appendFileSync(transcript, user("离开时") + asst("ma", { type: "text", text: "你不在的时候。" }, { stop_reason: "end_turn" }));
  await wait(4000); // > idle + sweep: the server has dropped alpha's conversation cache
  await backToChat();
  // The rebuilt cache is a new generation: the picture is dropped and the tail
  // re-paged (the earlier pages are a click away again) — never extended past
  // a hole.
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:ma"]').count()) === 1 && (await ci.count()) === 200 && (await page.locator("#chat-container .chat-earlier").textContent()) === `Load earlier (${wireN + 2 - 200} more)`, 15000), `back after the cache was rebuilt: the exchange written meanwhile is there on a fresh last page, the rest offered as "Load earlier" (${await ci.count()} shown, ${await page.locator("#chat-container .chat-earlier").textContent()})`);
  const genAfter = (await (await api("GET", "/api/sessions/alpha/conversation")).json()).generation;
  r.ok(genAfter !== genBefore, `…the wire's generation is a new one (${genBefore} → ${genAfter})`);

  // ── the same, with the reader scrolled up: the place survives the rebuild ──
  const sc4 = page.locator("#chat-container .chat-scroll");
  await sc4.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1500); });
  await sc4.dispatchEvent("scroll");
  r.ok(await until(async () => (await page.locator("#chat-container .chat-jump").isVisible())), "scrolled up in the rebuilt picture → pill");
  const keepId = await sc4.evaluate((el) => { const top = el.getBoundingClientRect().top; return [...el.querySelectorAll(".ci")].find((c) => c.getBoundingClientRect().bottom > top).dataset.id; });
  const keepY = await page.locator(`#chat-container .ci[data-id="${keepId}"]`).evaluate((el) => el.getBoundingClientRect().top);
  await openPrimary();
  appendFileSync(transcript, user("又离开了") + asst("mc", { type: "text", text: "又写了一句。" }, { stop_reason: "end_turn" }));
  await wait(4000);
  await backToChat();
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:mc"]').count()) === 1 && Math.abs((await page.locator(`#chat-container .ci[data-id="${keepId}"]`).evaluate((el) => el.getBoundingClientRect().top)) - keepY) < 4 && (await page.locator("#chat-container .chat-jump").textContent()) === "↓ 2 new", 15000), `back after a rebuild while scrolled up: the item the reader was on is where it was and the exchange written meanwhile is counted (${await page.locator("#chat-container .chat-jump").textContent()})`);
  await page.locator("#chat-container .chat-jump").click();
  r.ok(await until(async () => (await sc4.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48))), "…jump → bottom");

  // ── only the reader pauses the follow (prod 2026-11-09: "↓ 2808 new" climbing
  // for a reader who never left the bottom — layout moved the view, and every
  // scroll event counted as the reader's) ──
  const atEnd = () => sc4.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  const jumpV = () => page.locator("#chat-container .chat-jump").isVisible();
  await page.locator("#chat-container .ci").last().evaluate((el) => { const d = document.createElement("div"); d.className = "m32-late"; d.style.height = "3000px"; el.appendChild(d); });
  r.ok(await until(async () => (await atEnd()) && !(await jumpV())), "content growing under a following reader (late layout) → still at the bottom, no pill");
  await sc4.evaluate((el) => { el.scrollTop = 0; }); // no wheel/touch/key: the browser's doing, not the reader's
  await sc4.dispatchEvent("scroll");
  r.ok(await until(async () => (await atEnd()) && !(await jumpV())), "…a scroll with no reader input behind it (scroll anchoring, a re-shown tab) puts the view back on the tail, no pill");
  appendFileSync(transcript, user("还在底部") + asst("mf", { type: "text", text: "跟着走。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:mf"]').count()) === 1 && (await atEnd()) && !(await jumpV())), "…and the next exchange lands on screen, nothing counted");
  await sc4.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel")); el.scrollTop = 0; });
  await sc4.dispatchEvent("scroll");
  r.ok(await until(async () => await jumpV()), "…a wheel up still pauses it (pill)");
  await page.locator("#chat-container .chat-jump").click();
  r.ok(await until(async () => (await atEnd()) && !(await jumpV())), "…jump → following again");

  // ── quiet chat: background-task notifications are one line, heartbeats fold ──
  const envl = (n, status, summary) => `<task-notification>\n<task-id>bg${n}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n<usage><tool_uses>${n}</tool_uses><duration_ms>${n * 61000}</duration_ms></usage>\n</task-notification>`;
  const autoTurn = (n, status, summary, reply, extra = "") => {
    const t = envl(n, status, summary);
    return rec({ type: "queue-operation", operation: "enqueue", content: t }) + rec({ type: "queue-operation", operation: "dequeue" }) +
      rec({ type: "user", origin: { kind: "task-notification" }, promptSource: "system", message: { role: "user", content: t } }) +
      extra + asst(`q${n}`, { type: "text", text: reply }, { stop_reason: "end_turn" }) + rec({ type: "system", subtype: "turn_duration", durationMs: 4000 });
  };
  appendFileSync(transcript,
    autoTurn(1, "completed", "Agent &quot;scan&quot; is waiting on its own background work", "还在跑。") +
    autoTurn(2, "completed", "Agent &quot;scan&quot; is waiting on its own background work", "还在跑，没有报告。") +
    autoTurn(3, "completed", "Agent &quot;scan&quot; is waiting on its own background work", "还在跑，快了。"));
  const notices = page.locator("#chat-container .ci-nt:visible");
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q3"]').count()) === 1), "three auto turns land");
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q3"]').isVisible()) && (await notices.count()) === 1), `…only the latest is shown (${await notices.count()} notice line(s) visible)`);
  const lastNotice = page.locator("#chat-container .ci-nt:visible").first();
  r.ok((await lastNotice.locator("summary").textContent()).includes('⏳ Agent "scan" is waiting on its own background work') && (await lastNotice.locator("summary").textContent()).includes("3m 3s · 3 tools"), `…the notice is one line: glyph (⏳ waiting), summary (entities decoded), duration + tools (${await lastNotice.locator("summary").textContent()})`);
  r.ok(!(await lastNotice.evaluate((d) => d.open)) && !(await lastNotice.locator("pre").isVisible()), "…collapsed");
  await lastNotice.locator("summary").click();
  r.ok((await lastNotice.locator("pre").textContent()).includes("<task-id>bg3</task-id>"), "…a click shows the raw envelope");
  r.ok((await page.locator("#chat-container .ci-bubble", { hasText: "task-notification" }).count()) === 0 && (await page.locator("#chat-container .ci-queue", { hasText: "task-notification" }).count()) === 0, "no raw <task-notification> bubble or claude-queue line (the second copy is hidden)");
  r.ok(await page.locator('#chat-container .ci-assistant[data-id="a:q3"]').evaluate((el) => el.classList.contains("ci-auto")), "…the quiet auto turn is dimmed");
  const fold = page.locator("#chat-container .chat-fold");
  r.ok((await fold.count()) === 1 && (await fold.textContent()).includes("2 earlier background updates"), `one fold row for the two heartbeats before it (${await fold.count() ? await fold.textContent() : "none"})`);
  r.ok(!(await page.locator('#chat-container .ci-assistant[data-id="a:q1"]').isVisible()), "…the heartbeats are folded");
  r.ok((await page.locator("#chat-container .ci-turn-txt:visible", { hasText: "4s" }).count()) === 0, "a 4 s turn draws no duration line");
  await fold.click();
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q1"]').isVisible()) && (await fold.textContent()).includes("hide 2")), "…a click unfolds them");
  await fold.click();
  r.ok(await until(async () => !(await page.locator('#chat-container .ci-assistant[data-id="a:q1"]').isVisible())), "…and folds them again");
  await page.screenshot({ path: join(screenshotDir(), "m32-quiet.png") });
  appendFileSync(transcript, autoTurn(4, "completed", "Agent &quot;fix&quot; finished", "改好了。", asst("q4t", { type: "tool_use", id: "t-q4", name: "Read", input: { file_path: join(ws, "src", "app.js") } }) + result("t-q4", "x")));
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q4"]').count()) === 1), "an auto turn that called a tool lands");
  r.ok(!(await page.locator('#chat-container .ci-assistant[data-id="a:q4t"]').evaluate((el) => el.classList.contains("ci-auto"))) && (await page.locator('#chat-container .ci-assistant[data-id="a:q3"]').isVisible()), "…is not dimmed, and the quiet run before it keeps its latest turn visible");
  appendFileSync(transcript, user("<task-notification> 这是我自己打的字") + asst("qh", { type: "text", text: "好。" }, { stop_reason: "end_turn" }));
  appendFileSync(transcript, autoTurn(5, "failed", "Background command &quot;build&quot; failed with exit code 1", "构建失败了，等你看。") + autoTurn(6, "completed", "Agent &quot;x&quot; is waiting on its own background work", "还在跑。"));
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q6"]').count()) === 1), "a failed notice and a heartbeat after it land");
  r.ok(await page.locator('#chat-container .ci-assistant[data-id="a:q5"]').isVisible() && !(await page.locator('#chat-container .ci-assistant[data-id="a:q5"]').evaluate((el) => el.classList.contains("ci-auto"))), "…the failure's turn is never dimmed or folded behind the heartbeat");
  r.ok((await page.locator("#chat-container .ci-nt:visible", { hasText: "failed with exit code 1" }).locator(".ci-nt-g").textContent()) === "✗", "…its notice line has ✗");
  r.ok(await until(async () => (await page.locator("#chat-container .ci-bubble", { hasText: "这是我自己打的字" }).count()) === 1), "a person's prompt that merely starts with <task-notification> stays a bubble");
  // The news words are read outside the task's quoted name; an agent's final report is news without a tool call.
  appendFileSync(transcript, autoTurn(7, "completed", "Background command &quot;wait until 120 jobs finished&quot; completed (exit code 0)", "还在跑。") + autoTurn(8, "completed", "Agent &quot;y&quot; completed", "报告到了，结论在上面。"));
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q8"]').count()) === 1), "a task named \"…finished\" and an agent's completion land");
  r.ok(await page.locator('#chat-container .ci-assistant[data-id="a:q7"]').evaluate((el) => el.classList.contains("ci-auto")), "…the task whose NAME says finished is still a quiet heartbeat (dimmed)");
  r.ok(!(await page.locator('#chat-container .ci-assistant[data-id="a:q8"]').evaluate((el) => el.classList.contains("ci-auto"))), "…\"Agent … completed\" is news: not dimmed");
  // An API error after a notice is news; Enter on a fold row opens it in place (the view does not run to the tail).
  const tall = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行。`).join("\n\n");
  appendFileSync(transcript,
    rec({ type: "queue-operation", operation: "enqueue", content: envl(9, "completed", "Monitor event: tick") }) +
    rec({ type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: envl(9, "completed", "Monitor event: tick") } }) +
    rec({ type: "assistant", isApiErrorMessage: true, message: { id: "q9", role: "assistant", content: [{ type: "text", text: "You've hit your session limit" }], model: "<synthetic>", stop_reason: "end_turn" } }) +
    autoTurn(10, "completed", "Monitor event: tick", tall) + autoTurn(11, "completed", "Monitor event: tick", "还在跑。"));
  r.ok(await until(async () => (await page.locator('#chat-container .ci-assistant[data-id="a:q11"]').count()) === 1), "an API error after a notice and two heartbeats land");
  r.ok(await page.locator('#chat-container .ci-assistant[data-id="a:q9"]').isVisible() && !(await page.locator('#chat-container .ci-assistant[data-id="a:q9"]').evaluate((el) => el.classList.contains("ci-auto"))), "…the API error is never dimmed or folded");
  if (await page.locator("#chat-container .chat-jump").isVisible()) await page.locator("#chat-container .chat-jump").click();
  const row10 = page.locator("#chat-container .chat-fold").last();
  r.ok(await until(async () => (await row10.textContent()).includes("1 earlier") && !(await page.locator('#chat-container .ci-assistant[data-id="a:q10"]').isVisible())), "…the first heartbeat after it folds");
  await row10.focus(); await page.waitForTimeout(1100);
  const y0 = await row10.evaluate((el) => el.getBoundingClientRect().top);
  await page.keyboard.press("Enter");
  r.ok(await until(async () => await page.locator('#chat-container .ci-assistant[data-id="a:q10"]').isVisible()), "Enter on the fold row opens it");
  await page.waitForTimeout(400);
  const y1 = await row10.evaluate((el) => el.getBoundingClientRect().top);
  r.ok(Math.abs(y1 - y0) < 4, `…in place: the row did not move (${Math.round(y0)} → ${Math.round(y1)}), the view did not run to the tail`);
  // A click on plain text is not an open: late layout under a following reader still keeps the tail.
  const scr = page.locator("#chat-container .chat-scroll");
  const atTail = () => scr.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  await scr.hover(); await page.mouse.wheel(0, 100000);
  r.ok(await until(atTail), "scrolled down to the tail by wheel");
  await page.waitForTimeout(1100);
  await page.locator('#chat-container .ci-assistant[data-id="a:q11"] .ci-md').first().click();
  await page.locator('#chat-container .ci-assistant[data-id="a:q11"]').evaluate((el) => { el.style.paddingBottom = "900px"; });
  await page.waitForTimeout(300);
  r.ok(await atTail(), "a click on reply text, then the content grows: the following view stays on the tail");
  await page.locator('#chat-container .ci-assistant[data-id="a:q11"]').evaluate((el) => { el.style.paddingBottom = ""; });

  // A queue line the server evicted before its record landed gets no dup update: the record names it (`hides`).
  {
    const res = await page.evaluate(() => {
      const m = { hidden: new Set(), items: new Map([
        ["q1", { id: "q1", kind: "notice", via: "queue", ord: 5, rev: 5, text: "x" }],
        ["q2", { id: "q2", kind: "queue", op: "enqueue", ord: 6, rev: 6, text: "继续" }],
        ["q3", { id: "q3", kind: "queue", op: "enqueue", ord: 50, rev: 50, text: "kept" }],
        ["q4", { id: "q4", kind: "queue", op: "enqueue", ord: 7, rev: 7, text: "继续", dup: true }],
      ]) };
      const page1 = [
        { id: "r1", kind: "notice", via: "record", ord: 60, rev: 60, text: "x", hides: ["q1"] },
        { id: "u1", kind: "user", ord: 61, rev: 61, text: "继续", hides: ["q2"] },
        { id: "u2", kind: "user", ord: 62, rev: 62, text: "kept", hides: ["q3"] },
        { id: "q3", kind: "queue", op: "enqueue", ord: 50, rev: 63, text: "kept", dup: true },
        { id: "u3", kind: "user", ord: 64, rev: 64, text: "继续", hides: ["q4", "gone"] },
        { id: "u4", kind: "user", ord: 65, rev: 65, text: "继续" },
      ];
      return chatHiddenCopies(m, page1).map((x) => `${x.id}:${x.dup}:${x.rev > m.items.get(x.id).rev}`).join(",");
    });
    r.ok(res === "q1:true:true,q2:true:true", `a held queue line named by its record's hides is hidden; one in the page, already hidden or unknown is left alone; text alone hides nothing (${res})`);
  }
  // Either arrival order: a line named by a record that arrives LATER (a slow Load earlier) lands hidden,
  // and a copy older than the one held never replaces it.
  {
    const res = await page.evaluate(() => {
      const m = chatFreshModel("probe"), list = document.createElement("div");
      chatApplyItems(m, list, [{ id: "u9", kind: "user", ord: 20, rev: 20, text: "继续", hides: ["q9"] }]);
      chatApplyItems(m, list, [{ id: "q9", kind: "queue", op: "enqueue", ord: 3, rev: 3, text: "继续" }]);
      const late = m.items.get("q9").dup === true;
      chatApplyItems(m, list, [{ id: "q8", kind: "queue", op: "enqueue", ord: 2, rev: 30, text: "a", dup: true }]);
      chatApplyItems(m, list, [{ id: "q8", kind: "queue", op: "enqueue", ord: 2, rev: 2, text: "a" }]);
      const stale = m.items.get("q8").dup === true && m.items.get("q8").rev === 30;
      return `${late},${stale}`;
    });
    r.ok(res === "true,true", `a queue line arriving after the record that hides it lands hidden; an older copy never replaces a newer one (${res})`);
  }

  // ── a new conversation id (adopt / resume / clear) paints the new conversation ──
  const SID2 = randomUUID();
  writeFileSync(join(CONFIG, "projects", claudeProjectDir(ws), `${SID2}.jsonl`), rec({ type: "user", sessionId: SID2, cwd: ws, message: { role: "user", content: "新会话" } }) + asst("n1", { type: "text", text: "第一句。" }, { stop_reason: "end_turn" }));
  const adopt = await api("POST", "/api/sessions/alpha/adopt", { sessionId: SID2 });
  r.ok(adopt.status === 200, `adopt a second session id (${adopt.status})`);
  r.ok(await until(async () => (await ci.count()) === 2 && (await page.locator("#chat-container .ci-user .ci-bubble").textContent()).includes("新会话")), `…the chat shows the new conversation, not a blank one (${await ci.count()} items)`);

  // ── claude before its first turn: no transcript file yet → an empty state that fills in, never Offline ──
  const SID3 = randomUUID();
  const adopt3 = await api("POST", "/api/sessions/alpha/adopt", { sessionId: SID3, force: true });
  r.ok(adopt3.status === 200, `adopt a session id whose transcript is not written yet (${adopt3.status})`);
  const emptyEl = page.locator("#chat-container .chat-empty");
  r.ok(await until(async () => (await emptyEl.count()) === 1 && (await emptyEl.textContent()).includes("waiting for claude's first turn")), `…the chat says it waits for the first turn (${await emptyEl.count() ? await emptyEl.textContent() : "no empty state"})`);
  await page.waitForTimeout(2500); // a few polls in the empty state
  r.ok(await bannerEl.isHidden(), `…no Offline banner while it waits (${await bannerEl.isHidden() ? "hidden" : await bannerEl.textContent()})`);
  writeFileSync(join(CONFIG, "projects", claudeProjectDir(ws), `${SID3}.jsonl`), rec({ type: "user", sessionId: SID3, cwd: ws, message: { role: "user", content: "第一轮" } }) + asst("f1", { type: "text", text: "开始了。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await ci.count()) === 2 && (await page.locator("#chat-container .ci-user .ci-bubble").textContent()).includes("第一轮")), `…the first turn written → it appears without a reload (${await ci.count()} items)`);
  r.ok(await bannerEl.isHidden() && (await emptyEl.count()) === 0, "…the empty state and banner are gone");
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
  rmSync(CONFIG, { recursive: true, force: true });
}
process.exit(r.finish() ? 0 : 1);
