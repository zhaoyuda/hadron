/**
 * Module M25 — Agent-switch latency.
 *
 * Regression guard for "switching to a long-lived agent takes ~5 s before
 * anything paints" (prod, 2026-09-29, the homelab agent with a 35k-line
 * history). Two invariants, measured in a real browser:
 *
 *   1. Click a card → the pane's content is on screen within SWITCH_BUDGET_MS,
 *      even when the target pane carries a large CJK scrollback (tmux has to
 *      reflow it on attach; it must stay cheap).
 *   2. A same-layout switch does not resize the tmux window. The WS URL carries
 *      the fitted size so the pty is spawned at it — a resize on a long Claude
 *      session makes claude re-render for seconds, which is exactly the lag.
 *
 * The budget is generous (a loaded CI box is not a laptop); the point is to
 * catch a switch that goes from hundreds of milliseconds to seconds.
 *
 * Run: node test/e2e/m25-switch-latency.js
 */
import { chromium } from "playwright";
import { execFileSync } from "child_process";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const SWITCH_BUDGET_MS = 3000;   // per switch, click → content painted
const HISTORY_LINES = 35000;     // prod homelab pane: 34 948 lines of scrollback
const ROUNDS = 3;                // back-and-forth switches timed

const r = reporter("M25 Agent-switch latency");
const env = await bootWorkspace({ name: "m25" });
const tmuxName = (id) => `hadron-${env.wsName}-${id}`;
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const sendKeys = (id, ...keys) => execFileSync("tmux", ["send-keys", "-t", tmuxName(id), ...keys], { stdio: "ignore" });
const paneSize = (id) => tmux("display-message", "-p", "-t", tmuxName(id), "#{window_width}x#{window_height}");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, ms = 30000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return fn();
}
let browser;
try {
  const mk = (body) => fetch(`${env.baseUrl}/api/sessions`, { method: "POST", headers: authHeaders(env.token), body: JSON.stringify(body) });
  r.ok((await mk({ name: "Big", group: "Workers", launchCommand: "shell" })).status === 201, "shell agent 'big' created");
  r.ok((await mk({ name: "Small", group: "Workers", launchCommand: "shell" })).status === 201, "shell agent 'small' created");

  // ── seed: a 35k-line CJK scrollback in 'big', a one-liner in 'small' ──
  // Written by the shell in the pane itself (no browser attached yet), so the
  // history lives in tmux's scrollback exactly like a long claude session's.
  // tmux's default history-limit is 2000 rows and Hadron does not raise it, so
  // the seeded pane would be trimmed to nothing on a clean box. history-limit
  // is read when a pane is CREATED, so raise it on the session and re-create
  // its (only) window — the agent is still unattached, nothing observes the
  // pane id yet. The ≥ 20000 assertion below proves the limit took.
  const prompted = (id) => until(() => tmux("capture-pane", "-p", "-t", tmuxName(id)).trim().length > 0, 20000, 200);
  r.ok(await prompted("big") && await prompted("small"), "both shells reached a prompt before seeding");
  tmux("set-option", "-t", tmuxName("big"), "history-limit", "100000");
  const oldWin = tmux("display-message", "-p", "-t", tmuxName("big"), "#{window_id}");
  tmux("new-window", "-t", tmuxName("big"));
  tmux("kill-window", "-t", oldWin);
  r.ok(await prompted("big"), "big's re-created window reached a prompt");
  sendKeys("big", `for i in $(seq 1 ${HISTORY_LINES}); do printf '第%d行 长历史记录 中文内容用于回流测试 ─ 这是一条很长的记录 ─ 表格 │ 代码 │ 注释\\n' $i; done; echo BIG_HISTORY_RE''ADY`, "Enter");   // split so the echoed command line is not the sentinel
  sendKeys("small", "clear; echo SMALL_PANE_RE''ADY", "Enter");
  r.ok(await until(() => tmux("capture-pane", "-p", "-t", tmuxName("big")).includes("BIG_HISTORY_READY"), 120000, 500), "big pane printed its 35k lines");
  r.ok(await until(() => tmux("capture-pane", "-p", "-t", tmuxName("small")).includes("SMALL_PANE_READY"), 20000, 200), "small pane printed its sentinel");
  // history_size counts WRAPPED rows at the pane's current width (80 before any
  // client attaches) — so it is only asserted to be a large scrollback, not
  // the exact line count.
  const histSize = () => Number(tmux("display-message", "-p", "-t", tmuxName("big"), "#{history_size}"));
  const hist0 = histSize();
  r.ok(hist0 >= 20000, `big pane scrollback holds ${hist0} rows (≥ 20000 — the raised history-limit took)`);

  // ── browser ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const wsUrls = [];   // every /ws the page opens — the no-resize invariant lives in the URL
  page.on("websocket", (w) => wsUrls.push(w.url()));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  const painted = (needle) => page.waitForFunction((n) => {
    const el = document.querySelector("#terminal-container .xterm-rows");
    return !!el && el.innerText.includes(n);
  }, needle, { timeout: 20000 });
  async function timedSwitch(id, needle) {
    const t0 = Date.now();
    await page.locator(`.dk[data-sid="${id}"]`).click();
    await painted(needle);
    return Date.now() - t0;
  }

  // First attach of each: the pty is spawned at the fitted size, which sizes
  // the tmux window. Not timed — it includes the initial fit + first connect.
  await timedSwitch("small", "SMALL_PANE_READY");
  const firstBig = await timedSwitch("big", "BIG_HISTORY_READY");
  r.ok(firstBig <= 15000, `first attach to big painted in ${firstBig} ms (not timed against the budget: includes the initial fit; ceiling 15 s)`);
  const sizeBig0 = paneSize("big"), sizeSmall0 = paneSize("small");
  const fitted = await page.evaluate(() => ({ cols: (window.term ?? term).cols, rows: (window.term ?? term).rows }));
  // tmux's status line takes rows off the client: `status off` → 0, on → 1, `status N` → N.
  const statusOpt = tmux("show-option", "-v", "-t", tmuxName("big"), "status");
  const statusRows = Number(statusOpt) || (statusOpt === "off" ? 0 : 1);
  r.ok(sizeBig0 === `${fitted.cols}x${fitted.rows - statusRows}`, `big window sized to the browser's fitted terminal (tmux ${sizeBig0}, xterm ${fitted.cols}x${fitted.rows}, status line ${statusRows})`);

  // ── timed rounds: small → big → small … ──
  const wsBefore = wsUrls.length;   // the very first connect predates the first fit (page load) — not a switch
  const times = [];
  const sizesBig = [], sizesSmall = [];
  for (let i = 0; i < ROUNDS; i++) {
    times.push({ to: "small", ms: await timedSwitch("small", "SMALL_PANE_READY") });
    sizesSmall.push(paneSize("small"));
    times.push({ to: "big", ms: await timedSwitch("big", "BIG_HISTORY_READY") });
    sizesBig.push(paneSize("big"));
    await sleep(700);   // let the post-connect safeFit() (500 ms) run before the next switch
  }
  const toBig = times.filter((t) => t.to === "big").map((t) => t.ms);
  const toSmall = times.filter((t) => t.to === "small").map((t) => t.ms);
  const max = Math.max(...times.map((t) => t.ms));
  const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  r.ok(max <= SWITCH_BUDGET_MS, `every switch painted within ${SWITCH_BUDGET_MS} ms — to big: ${toBig.join("/")} ms, to small: ${toSmall.join("/")} ms (p50 ${p50}, max ${max})`);
  r.ok(sizesBig.every((s) => s === sizeBig0) && sizesSmall.every((s) => s === sizeSmall0),
    `same-layout switches never resized the tmux windows (big ${sizeBig0}: ${sizesBig.join(",")}; small ${sizeSmall0}: ${sizesSmall.join(",")})`);
  // The deterministic half of the no-resize invariant: every attach asked for
  // the fitted size up front (client/terminal.js wsSizeParam), so the pty was
  // never spawned at 80x24 and corrected afterwards. The tmux sample above is
  // the server-side half (an attach that resizes the window would show there).
  const primary = wsUrls.slice(wsBefore).filter((u) => /[?&]session=(big|small)(&|$)/.test(u) && !u.includes("shell="));
  const sized = primary.map((u) => u.match(/[?&]cols=(\d+)&rows=(\d+)/)).map((m) => m && `${m[1]}x${m[2]}`);
  r.ok(primary.length === 2 * ROUNDS && sized.every((z) => z === `${fitted.cols}x${fitted.rows}`),
    `all ${primary.length} switch WS connects carried the fitted size ${fitted.cols}x${fitted.rows} on the URL (${[...new Set(sized)].join(",")}) — one connect per switch, no reconnect loop`);
  const hist1 = histSize();
  r.ok(hist1 >= 20000, `big pane's scrollback survived the switches — ${hist1} rows after reflow to ${sizeBig0} (the timing above covered the full history)`);

  await page.screenshot({ path: join(screenshotDir(), "m25-switch-big.png") });
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
