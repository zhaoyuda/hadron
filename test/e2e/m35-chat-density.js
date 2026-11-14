/**
 * Module M35 — chat collapse rules + the density switch (client/chat.js CHAT_RULES).
 *
 * One seeded conversation, read at the three densities:
 *   - Standard (the default): a run of tool calls with nothing said between them
 *     (Bash → Read → Edit, across three assistant messages) is ONE summary row
 *     "Ran a command, read a file, edited a file · +1 −1 · 1 failed" with its
 *     cards hidden; a click shows each card and the open run stays open when the
 *     run grows (a tool call appended to the transcript); Thinking is one
 *     collapsed line; a short message from another agent is drawn whole as
 *     "✉ from Beta", a long one is one line "✉ from Gamma · first line · N lines"
 *     (the agent id in the CLI's attribution line is never drawn) that opens on a
 *     click; a long prompt is clamped to 12 lines with "Show all · N lines" /
 *     "Show less"; short command output is one inline line, long output a
 *     collapsed line
 *     a run whose last call finished before an earlier one is still pending;
 *     a lone call opened by hand that becomes a run keeps the run open
 *   - Compact: Thinking is gone, the run row stays
 *   - Verbose: every card, Thinking, the agent message, the prompt and the long
 *     output open, no run row, a following reader still on the tail; a card shut by hand stays shut through the next
 *     poll
 *   - the density persists across a reload (ui state), and a ui state written
 *     before the levels (chatExpandAll: true) reads as Verbose
 *
 * Run: node test/e2e/m35-chat-density.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, mkdtempSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { bootWorkspace, reporter, screenshotDir } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M35 chat density");
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m35-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const SID = randomUUID();
const now = () => new Date().toISOString();
const rec = (o) => JSON.stringify({ uuid: randomUUID(), timestamp: now(), ...o }) + "\n";
const user = (text) => rec({ type: "user", message: { role: "user", content: text } });
const asst = (id, block, extra = {}) => rec({ type: "assistant", message: { id, role: "assistant", content: [block], model: "claude-x", usage: { input_tokens: 10, output_tokens: 5 }, ...extra } });
const result = (toolId, text, isError = false) => rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: text, is_error: isError }] } });
const LONG_PROMPT = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行需求`).join("\n");
const LONG_OUT = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n");
let transcript, ws;
const env = await bootWorkspace({
  name: "m35",
  landing: "chat",
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
      user("[hadron message from Beta (beta-7)]\nbuild green") +
      user("[hadron message from Gamma (gamma-2)]\nReview done.\nP2: rename foo\nP3: add a test\nShip it.") +
      user(LONG_PROMPT) +
      asst("m1", { type: "thinking", thinking: "Run the tests first." }) +
      asst("m1", { type: "text", text: "先跑测试。" }) +
      asst("m1", { type: "tool_use", id: "t-bash", name: "Bash", input: { command: "npm test" } }) +
      result("t-bash", "ok") +
      asst("m2", { type: "tool_use", id: "t-read", name: "Read", input: { file_path: join(ws, "src", "app.js") } }) +
      result("t-read", "console.log('app')\n") +
      asst("m3", { type: "tool_use", id: "t-edit", name: "Edit", input: { file_path: join(ws, "src", "app.js"), old_string: "console.log('app')", new_string: "console.info('app')" } }) +
      result("t-edit", "String to replace not found in file.", true) +
      user("<local-command-stdout>done</local-command-stdout>") +
      user(`<local-command-stdout>${LONG_OUT}</local-command-stdout>`));
  },
});
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const chat = page.locator("#chat-container");
  const open = async () => {
    await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(`.dk[data-sid="alpha"]`).first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`.dk[data-sid="alpha"]`).first().click();
    await chat.locator(".ci-assistant").first().waitFor({ state: "visible", timeout: 10000 });
  };
  const density = async () => chat.locator(".chat-dens.on").getAttribute("data-d");
  await open();

  // ── Standard ──
  r.ok((await density()) === "standard", "Standard is the default density");
  const grp = chat.locator(".ci-group");
  r.ok(await until(async () => (await grp.count()) === 1), "the Bash → Read → Edit run is one summary row");
  const gtxt = (await grp.textContent()).trim();
  r.ok(/Ran a command, read a file, edited a file/.test(gtxt) && /\+1 −1/.test(gtxt) && /1 failed/.test(gtxt), `…"Ran a command, read a file, edited a file · +1 −1 · 1 failed" (${gtxt})`);
  r.ok((await grp.locator(".ci-tool-st").textContent()) === "✗" && (await grp.evaluate((el) => el.classList.contains("err"))), "…marked ✗ — one call failed");
  r.ok((await chat.locator(".ci-tool:visible").count()) === 0, "…its three cards are hidden");
  r.ok((await chat.locator(".ci-think").count()) === 1 && !(await chat.locator(".ci-think").evaluate((d) => d.open)), "Thinking is one collapsed line");
  r.ok((await chat.locator(".ci-md", { hasText: "先跑测试" }).isVisible()), "the reply text before the run is drawn as usual");

  const short = chat.locator(".ci-agentmsg").nth(0), long = chat.locator(".ci-agentmsg").nth(1);
  r.ok((await short.locator(".ci-amsg-from").textContent()) === "✉ from Beta" && (await short.locator(".ci-amsg-body").textContent()) === "build green" && !(await short.locator("details").count()), "a short message from another agent is drawn whole as \"✉ from Beta\"");
  const lsum = long.locator("summary");
  r.ok(/✉ from Gamma · Review done\. · 4 lines/.test(await lsum.textContent()) && !(await long.locator("details").evaluate((d) => d.open)), `a long one is one line "✉ from Gamma · first line · N lines" (${(await lsum.textContent()).trim()})`);
  r.ok(!/beta-7|gamma-2|hadron message from/.test(await chat.locator(".chat-list").textContent()), "…the attribution line and the agent ids are never drawn");
  await lsum.click();
  r.ok(await until(async () => (await long.locator(".ci-amsg-body").isVisible()) && /Ship it\./.test(await long.locator(".ci-amsg-body").textContent())), "…a click opens the whole message");

  const prompt = chat.locator(".ci-user:not(.ci-agentmsg)").first();
  r.ok((await prompt.locator(".ci-clamped").count()) === 1 && !/第 30 行/.test(await prompt.textContent()) && /第 12 行/.test(await prompt.textContent()), "a 30-line prompt is clamped to its first 12 lines");
  const showAll = prompt.locator(".ci-clamp-btn");
  r.ok(/Show all · 30 lines/.test(await showAll.textContent()), `…with "Show all · 30 lines, …" (${await showAll.textContent()})`);
  await showAll.click();
  const prompt2 = chat.locator(".ci-user:not(.ci-agentmsg)").first();
  r.ok(await until(async () => /第 30 行/.test(await prompt2.textContent()) && (await prompt2.locator(".ci-clamp-btn").textContent()) === "Show less"), "…a click shows all of it, with \"Show less\"");
  await prompt2.locator(".ci-clamp-btn").click();
  r.ok(await until(async () => (await chat.locator(".ci-user:not(.ci-agentmsg)").first().locator(".ci-clamped").count()) === 1), "…and Show less clamps it again");

  r.ok((await chat.locator(".ci-out-inline", { hasText: "done" }).count()) === 1, "short command output is one inline line");
  const lout = chat.locator("details.ci-out");
  r.ok((await lout.count()) === 1 && !(await lout.evaluate((d) => d.open)), "long command output is one collapsed line");

  // a hand-opened run stays open as it grows
  await grp.click();
  r.ok(await until(async () => (await chat.locator(".ci-tool:visible").count()) === 3 && (await grp.evaluate((el) => el.classList.contains("open")))), "a click on the run row shows its three cards");
  appendFileSync(transcript, asst("m4", { type: "tool_use", id: "t-grep", name: "Grep", input: { pattern: "console" } }) + result("t-grep", "src/app.js"));
  // the two outputs between the Edit and the Grep break the run: the Grep stands alone
  r.ok(await until(async () => (await chat.locator('[data-tool="t-grep"]').count()) === 1), "an appended tool call lands");
  appendFileSync(transcript, asst("m5", { type: "tool_use", id: "t-ls", name: "Bash", input: { command: "ls" } }) + result("t-ls", "src"));
  r.ok(await until(async () => (await chat.locator(".ci-group").count()) === 2 && /Ran a command, searched once/.test(await chat.locator(".ci-group").nth(1).textContent())), `…Grep + Bash after the outputs make a second run "Ran a command, searched once" (${await chat.locator(".ci-group").nth(1).textContent().catch(() => "")})`);
  r.ok(await chat.locator(".ci-group").nth(0).evaluate((el) => el.classList.contains("open")) && (await chat.locator('[data-tool="t-edit"]').isVisible()), "…the first run, opened by hand, is still open");
  await chat.locator(".ci-group").nth(1).click();
  r.ok(await until(async () => await chat.locator('[data-tool="t-grep"]').isVisible()), "the second run opens on a click");
  appendFileSync(transcript, asst("m5", { type: "tool_use", id: "t-pwd", name: "Bash", input: { command: "pwd" } }) + result("t-pwd", "/x"));
  r.ok(await until(async () => /Ran 2 commands, searched once/.test(await chat.locator(".ci-group").nth(1).textContent())), "…grows to \"Ran 2 commands, searched once\"");
  r.ok(await chat.locator(".ci-group").nth(1).evaluate((el) => el.classList.contains("open")) && await chat.locator('[data-tool="t-pwd"]').isVisible(), "…and stays open, the new card shown");
  appendFileSync(transcript, asst("m6", { type: "text", text: "完成。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await chat.locator(".ci-md", { hasText: "完成" }).count()) === 1), "the closing reply lands after the runs");
  // parallel calls finishing out of order: pending while ANY call has no result
  appendFileSync(transcript, asst("m8", { type: "tool_use", id: "t-a", name: "Bash", input: { command: "sleep 5" } }) + asst("m8", { type: "tool_use", id: "t-b", name: "Read", input: { file_path: join(ws, "src", "app.js") } }) + result("t-b", "x"));
  const g3 = chat.locator('.ci-group[data-ids="t-a t-b"]');
  r.ok(await until(async () => (await g3.count()) === 1 && (await g3.locator(".ci-tool-st-pending").count()) === 1 && /Bash sleep 5/.test(await g3.locator(".ci-group-now").textContent())), "the last call done, an earlier one not: the run is still pending, \"now\" names the earlier call");
  appendFileSync(transcript, result("t-a", "") + asst("m9", { type: "text", text: "下一步。" }));
  r.ok(await until(async () => (await g3.locator(".ci-tool-st").textContent()) === "✓"), "…✓ once every call has its result");
  // a lone call opened by hand, then the next call makes it a run: it stays in view
  appendFileSync(transcript, asst("m10", { type: "tool_use", id: "t-c", name: "Bash", input: { command: "make" } }));
  const cardC = chat.locator('[data-tool="t-c"]');
  r.ok(await until(async () => await cardC.isVisible()), "a lone call is its own card");
  await cardC.locator(".ci-tool-hd").click();
  r.ok(await until(async () => cardC.evaluate((el) => el.classList.contains("open"))), "…opened by hand");
  appendFileSync(transcript, result("t-c", "built") + asst("m10", { type: "tool_use", id: "t-d", name: "Bash", input: { command: "make test" } }) + result("t-d", "ok"));
  const g4 = chat.locator('.ci-group[data-grp="t-c"]');
  r.ok(await until(async () => (await g4.count()) === 1 && (await g4.evaluate((el) => el.classList.contains("open"))) && (await cardC.isVisible()) && (await cardC.evaluate((el) => el.classList.contains("open")))), "…the next call makes a run that starts open, the opened card still on screen");
  await cardC.locator(".ci-tool-hd").click();
  appendFileSync(transcript, asst("m10", { type: "tool_use", id: "t-c2", name: "Bash", input: { command: "make check" } }));
  r.ok(await until(async () => /Ran 3 commands/.test(await g4.textContent())), "…closing the card that opened it, then a call arriving:");
  r.ok((await g4.evaluate((el) => el.classList.contains("open"))) && (await chat.locator('[data-tool="t-c2"]').isVisible()), "…the run it opened stays open");
  await cardC.locator(".ci-tool-hd").click();
  r.ok(await until(async () => cardC.evaluate((el) => el.classList.contains("open"))), "…the card opened again");
  const cardC2 = chat.locator('[data-tool="t-c2"]');
  await cardC2.locator(".ci-tool-hd").click();
  r.ok(await until(async () => cardC2.evaluate((el) => el.classList.contains("open"))), "…a running call's card opened by hand");
  await g4.click();
  r.ok(await until(async () => !(await cardC.isVisible())), "…a click closes the run, the card behind it");
  appendFileSync(transcript, asst("m10", { type: "tool_use", id: "t-e", name: "Bash", input: { command: "make lint" } }) + result("t-e", "ok"));
  r.ok(await until(async () => /Ran 4 commands/.test(await g4.textContent()) && (await g4.getAttribute("title")).startsWith("4 tool calls")), "…the closed run grows to 4 calls (tooltip too) and stays closed");
  r.ok(!(await g4.evaluate((el) => el.classList.contains("open"))) && !(await cardC.isVisible()), "…the hand-opened card does not reopen it");
  await g4.click();
  r.ok(await until(async () => (await cardC.isVisible()) && (await cardC.evaluate((el) => el.classList.contains("open")))), "…opened again, the card opened before is still open");
  appendFileSync(transcript, result("t-c2", "checked"));
  r.ok(await until(async () => /checked/.test(await cardC2.textContent())), "…the running call's result lands");
  r.ok(await cardC2.evaluate((el) => el.classList.contains("open")), "…its card stays open (closing the run kept the card's own state)");
  await cardC.locator(".ci-tool-hd").click();
  appendFileSync(transcript, asst("m10", { type: "tool_use", id: "t-f", name: "Bash", input: { command: "make doc" } }) + result("t-f", "ok"));
  r.ok(await until(async () => /Ran 5 commands/.test(await g4.textContent())), "…closing that card, then a call arriving:");
  r.ok((await g4.evaluate((el) => el.classList.contains("open"))) && (await chat.locator('[data-tool="t-f"]').isVisible()), "…the run stays open (its own state, not the card's)");
  appendFileSync(transcript, asst("m11", { type: "text", text: "全部完成。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await chat.locator(".ci-md", { hasText: "全部完成" }).count()) === 1), "the last reply lands");
  await page.screenshot({ path: join(screenshotDir(), "m35-standard.png") });

  // ── Compact ──
  await chat.locator('.chat-dens[data-d="compact"]').click();
  r.ok(await until(async () => (await chat.locator(".ci-think").count()) === 0), "Compact: Thinking is gone");
  r.ok((await chat.locator(".ci-group").count()) === 4 && (await chat.locator(".ci-group.open").count()) === 0 && (await chat.locator(".ci-tool:visible").count()) === 0, "…the runs are summary rows again, the hand-opened ones closed (a density is a fresh start)");
  r.ok((await chat.locator(".ci-md", { hasText: "先跑测试" }).isVisible()), "…replies stay");

  // ── Verbose ──
  const sc = chat.locator(".chat-scroll");
  // The card clicks above scrolled the reader up (paused): back to the tail, following.
  await sc.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
  await until(async () => chat.locator(".chat-jump").isHidden());
  await chat.locator('.chat-dens[data-d="verbose"]').click();
  const tail0 = await sc.evaluate((el) => [el.scrollHeight - el.scrollTop - el.clientHeight, el.scrollHeight - el.clientHeight]);
  const nCards = await chat.locator(".ci-tool").count();
  r.ok(await until(async () => (await chat.locator(".ci-group").count()) === 0 && (await chat.locator(".ci-tool.open").count()) === nCards), `Verbose: no run rows, all ${nCards} cards open (${await chat.locator(".ci-tool.open").count()})`);
  // Measured right after the click, not polled: a later layout scroll may also find the tail, the switch itself must.
  r.ok(tail0[1] > 200 && tail0[0] < 48 && (await chat.locator(".chat-jump").isHidden()), `…a following reader is on the tail right after everything grew (${tail0[0]}px from the bottom)`);
  r.ok(await chat.locator(".ci-think").evaluate((d) => d.open), "…Thinking open");
  r.ok(await chat.locator(".ci-agentmsg").nth(1).locator("details").evaluate((d) => d.open), "…the long agent message open");
  r.ok((await chat.locator(".ci-clamped").count()) === 0 && /第 30 行/.test(await chat.locator(".ci-user:not(.ci-agentmsg)").first().textContent()), "…the long prompt whole");
  r.ok(await chat.locator("details.ci-out").evaluate((d) => d.open), "…the long output open");
  await chat.locator('[data-tool="t-read"] .ci-tool-hd').click();
  r.ok(await until(async () => !(await chat.locator('[data-tool="t-read"]').evaluate((el) => el.classList.contains("open")))), "a card shut by hand in Verbose closes");
  appendFileSync(transcript, user("再来") + asst("m7", { type: "text", text: "好的。" }, { stop_reason: "end_turn" }));
  r.ok(await until(async () => (await chat.locator(".ci-md", { hasText: "好的" }).count()) === 1), "…a new exchange lands");
  r.ok(!(await chat.locator('[data-tool="t-read"]').evaluate((el) => el.classList.contains("open"))), "…and the shut card stays shut");
  await page.screenshot({ path: join(screenshotDir(), "m35-verbose.png") });

  // ── persistence + migration ──
  await open();
  r.ok((await density()) === "verbose" && (await chat.locator(".ci-tool.open").count()) >= 5, "the density survives a reload");
  await chat.locator('.chat-dens[data-d="standard"]').click();
  await until(async () => (await density()) === "standard");
  await page.evaluate(() => { const st = JSON.parse(localStorage.getItem("hadron-ui-state") || "{}"); delete st.chatDensity; st.chatExpandAll = true; localStorage.setItem("hadron-ui-state", JSON.stringify(st)); });
  await open();
  r.ok((await density()) === "verbose", "a ui state from before the levels (chatExpandAll: true) reads as Verbose");
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);
} catch (e) {
  r.fail(`threw: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
  rmSync(CONFIG, { recursive: true, force: true });
}
process.exit(r.finish() ? 0 : 1);
