/**
 * Module M23 — the context-usage badge on agent cards.
 *
 * A card carries "N%" next to the name: how full the agent's context window
 * is. Two honest sources, both claude's own numbers: the footer line claude
 * prints near the limit ("N% context used" / "N% until auto-compact") while
 * the pane shows it, else the last assistant usage in the transcript against
 * the window claude assumes for the model (1M for "[1m]" models, 200k
 * otherwise). The colour is the server's `level`, by tokens of headroom
 * before auto-compact (window − 20k): amber within 40k, red within 10k —
 * 70% / 85% on 200k, 94% / 97% on 1M. What this proves in a real browser:
 *   - seeded transcripts → 64% (plain), 85% (red), 30% on a [1m] model
 *     (300k tokens, not clamped to 100); 950k on 1M is 95% and only amber
 *   - a shell agent with no session has no badge; the badge rides an open
 *     GET too (pct + colour, not conversation) — tokens/window and the
 *     transcript text need the token
 *   - appending usage to the transcript moves the badge within the poll +
 *     deck refresh; the tooltip spells out tokens / window / source
 *   - a pane whose foreground command is an agent process and shows claude's
 *     footer ("72% context used" under the ❯ line) reports source "pane" —
 *     for an agent WITH a transcript too, where it wins over the transcript's
 *     number and hands back to it when that process exits
 *   - nothing about the meter reaches disk (state is runtime-only)
 *
 * Run: node test/e2e/m23-context-badge.js
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M23 Context badge");
// Relocate claude's config dir for the server under test (the harness spreads
// process.env): transcripts are seeded there, nothing touches ~/.claude.
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m23-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const SIDS = { half: randomUUID(), full: randomUUID(), big: randomUUID() };
const now = () => new Date().toISOString();
const rec = (model, input, cacheCreate, cacheRead, text = "ok") => JSON.stringify({
  type: "assistant", timestamp: now(),
  message: { id: `m-${Math.random().toString(36).slice(2)}`, role: "assistant", model, usage: { input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, output_tokens: 3 }, content: [{ type: "text", text }] },
}) + "\n";
let transcriptDir;
const env = await bootWorkspace({
  name: "m23",
  seed(ws) {
    transcriptDir = join(CONFIG, "projects", claudeProjectDir(ws));
    mkdirSync(transcriptDir, { recursive: true });
    const dir = join(ws, ".hadron", "agents");
    mkdirSync(dir, { recursive: true });
    for (const [id, sid] of Object.entries(SIDS)) {
      // A manual (operator-adopted) id with a clean-exit tombstone: pinned, so
      // the tracker never re-scrapes it, and never auto-resumed at boot.
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({
        id, name: id[0].toUpperCase() + id.slice(1), group: "Workers", cwd: ws,
        runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: sid, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() },
      }, null, 2));
      writeFileSync(join(transcriptDir, `${sid}.jsonl`), JSON.stringify({ type: "user", timestamp: now(), message: { role: "user", content: "hi" } }) + "\n");
    }
    appendFileSync(join(transcriptDir, `${SIDS.half}.jsonl`), rec("claude-fable-5-1", 63, 10000, 118000));      // 128 063 / 200k → 64%
    appendFileSync(join(transcriptDir, `${SIDS.full}.jsonl`), rec("claude-fable-5-1", 0, 20000, 150000));       // 170 000 / 200k → 85% (red)
    appendFileSync(join(transcriptDir, `${SIDS.big}.jsonl`), rec("claude-opus-5[1m]", 300000, 0, 0));           // 300 000 / 1M → 30%
  },
});
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, {
  method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}),
});
const listed = async (auth = true) => (await (auth ? api("GET", "/api/sessions") : fetch(`${env.baseUrl}/api/sessions`))).json();
const ctxOf = async (id, auth = true) => (await listed(auth)).find((s) => s.id === id)?.context ?? null;
const tmuxName = (id) => `hadron-${env.wsName}-${id}`;
const sendKeys = (id, ...keys) => execFileSync("tmux", ["send-keys", "-t", tmuxName(id), ...keys], { stdio: "ignore" });

try {
  // ── wire form ──────────────────────────────────────────────────────────
  const shell = await api("POST", "/api/sessions", { name: "Meter", launchCommand: "shell" });
  r.ok(shell.status === 201, "shell agent created");
  const meter = (await shell.json()).id;
  r.ok(await until(async () => (await ctxOf("half"))?.pct === 64), "half: context.pct 64 from the transcript's usage (128 063 of 200k)");
  const half = await ctxOf("half");
  r.ok(half.source === "transcript" && half.tokens === 128063 && half.window === 200000 && half.level === "ok", `…with tokens/window/source/level (${JSON.stringify(half)})`);
  const full = await ctxOf("full");
  r.ok(full?.pct === 85 && full.level === "hot", `full: 85% is "hot" on 200k — 10k before auto-compact (${JSON.stringify(full)})`);
  const big = await ctxOf("big");
  r.ok(big?.pct === 30 && big.window === 1000000 && big.level === "ok", `big: a "[1m]" model runs on the 1M window → 30% (${JSON.stringify(big)})`);
  const anon = await listed(false);
  r.ok(anon.find((s) => s.id === "half")?.context?.pct === 64 && !("transcript" in anon.find((s) => s.id === "half")), "open GET: the number rides, the transcript text does not");
  r.ok(!("context" in anon.find((s) => s.id === meter)), "shell agent (no session) has no context field");
  r.ok(anon.every((s) => !s.context || (Object.keys(s.context).sort().join() === "level,pct,source" && !JSON.stringify(s.context).includes(s.runtime?.sessionId))), "open GET context carries pct/source/level only — no tokens, no model string, no session id");

  // ── cards ──────────────────────────────────────────────────────────────
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="half"]`).waitFor({ state: "visible", timeout: 10000 });
  const badge = (id) => page.locator(`.dk[data-sid="${id}"] .dk-ctx`).first();
  const badgeText = async (id) => (await page.locator(`.dk[data-sid="${id}"] .dk-ctx`).count()) ? (await badge(id).textContent()).trim() : null;
  const badgeClass = async (id) => (await badge(id).getAttribute("class")) || "";
  r.ok(await until(async () => (await badgeText("half")) === "64%"), `half card shows "64%" (${await badgeText("half")})`);
  r.ok(!/dk-ctx-(warn|hot)/.test(await badgeClass("half")), "…plain below 70%");
  r.ok((await badgeText("full")) === "85%" && /dk-ctx-hot/.test(await badgeClass("full")), `full card "85%" is red (${await badgeClass("full")})`);
  r.ok((await badgeText("big")) === "30%", `big card "30%" — 300k tokens on a 1M window, not clamped (${await badgeText("big")})`);
  r.ok((await badgeText(meter)) === null, "shell agent card has no badge");
  const tip = (await page.locator(`.dk[data-sid="half"]`).first().getAttribute("title")) || "";
  r.ok(tip.includes("context 64% used (128k of 200k, from the transcript)"), `tooltip spells out tokens, window and source (${JSON.stringify(tip.split("\n").pop())})`);
  await page.screenshot({ path: join(screenshotDir(), "m23-badges.png") });

  // ── live update ────────────────────────────────────────────────────────
  appendFileSync(join(transcriptDir, `${SIDS.half}.jsonl`), rec("claude-fable-5-1", 0, 2000, 148000, "more"));   // 150 000 → 75%
  r.ok(await until(async () => (await badgeText("half")) === "75%"), `appended usage moves the badge to 75% within the poll + refresh (${await badgeText("half")})`);
  r.ok(/dk-ctx-warn/.test(await badgeClass("half")) && !/dk-ctx-hot/.test(await badgeClass("half")), "…amber at 75%");
  appendFileSync(join(transcriptDir, `${SIDS.big}.jsonl`), rec("claude-opus-5[1m]", 0, 50000, 900000, "more"));   // 950 000 / 1M → 95%, 30k before compaction
  r.ok(await until(async () => (await badgeText("big")) === "95%"), `big: 950k of 1M → 95% (${await badgeText("big")})`);
  r.ok(/dk-ctx-warn/.test(await badgeClass("big")) && !/dk-ctx-hot/.test(await badgeClass("big")), "…only amber: 30k of headroom before auto-compact at 980k, the same distance 75% is on 200k");

  // ── pane source ────────────────────────────────────────────────────────
  // The shell agent's pane runs a `node` process (an agent-process name to the
  // detector) that prints claude's footer as claude lays it out — the ❯ prompt
  // line, then the meter under it: the meter is read off the pane. (The phrase
  // above the prompt line is a quote, not a meter — test-state-eval.)
  const footer = (pct) => `node -e "console.log('❯ \\n  ${pct}% context used'); setInterval(() => {}, 1e6)"`;
  await page.locator(`.dk[data-sid="${meter}"]`).first().click();
  sendKeys(meter, footer(72), "Enter");
  r.ok(await until(async () => (await ctxOf(meter))?.source === "pane" && (await ctxOf(meter))?.pct === 72), `pane shows "72% context used" under an agent process → context {pct 72, source pane} (${JSON.stringify(await ctxOf(meter))})`);
  r.ok(await until(async () => (await badgeText(meter)) === "72%"), `…and the card shows 72% (${await badgeText(meter)})`);
  r.ok(!("context" in JSON.parse(readFileSync(join(env.ws, ".hadron", "agents", `${meter}.json`), "utf-8"))) && !readFileSync(join(env.ws, ".hadron", "agents", `${meter}.json`), "utf-8").includes("contextPct"), "nothing about the meter is persisted");
  sendKeys(meter, "C-c");
  r.ok(await until(async () => (await ctxOf(meter)) === null, 15000), "process exits → the pane text still says 72% but the foreground is a shell: no meter");
  r.ok(await until(async () => (await badgeText(meter)) === null), "…and the badge is gone from the card");

  // ── precedence: pane over transcript ───────────────────────────────────
  // `big` has a transcript (95%); its pane now shows claude's footer at 40%.
  sendKeys("big", footer(40), "Enter");
  r.ok(await until(async () => (await ctxOf("big"))?.source === "pane" && (await ctxOf("big"))?.pct === 40), `an agent with a transcript: the pane's footer wins → {pct 40, source pane} (${JSON.stringify(await ctxOf("big"))})`);
  r.ok(await until(async () => (await badgeText("big")) === "40%"), `…card shows 40% (${await badgeText("big")})`);
  const bigPane = await ctxOf("big");
  r.ok(bigPane.level === "ok" && !("tokens" in bigPane), `…pane form carries no tokens/window; 40% of the transcript's 1M window is "ok" (${JSON.stringify(bigPane)})`);
  sendKeys("big", "C-c");
  r.ok(await until(async () => (await ctxOf("big"))?.source === "transcript" && (await ctxOf("big"))?.pct === 95, 15000), `process exits → back to the transcript's 95% (${JSON.stringify(await ctxOf("big"))})`);

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
  rmSync(CONFIG, { recursive: true, force: true });
}
process.exit(r.finish() ? 0 : 1);
