/**
 * Module M36 — the page measures its own freezes (client/perf.js).
 *
 * "Hadron feels stuck" had no number behind it. The page now runs a 100-ms
 * heartbeat; a gap ≥ 200 ms over it is a freeze (the main thread ran nothing
 * else — no paint, no click). Freezes carry the perfMark() labels set inside
 * their window, agent switches are timed to the next frame, and the batch goes
 * to POST /api/perf/client → kind "ui" lines in .hadron/logs/perf.jsonl, which
 * `hadron perf` summarises. What this proves in a real browser:
 *   - a 700-ms busy loop after perfMark("render") lands as ONE freeze of
 *     ~700 ms carrying that mark, the active view and agent
 *   - a short (50 ms) stall is not reported
 *   - a card click is a "switch" sample with a view
 *   - a hidden page records nothing (background-tab throttling is no freeze)
 *   - without long-animation-frame timing the heartbeat gap is the measure
 *     (an upper bound): a 210-ms block is never missed
 *   - `hadron perf` prints the freeze in its section
 *
 * Run: node test/e2e/m36-freeze-log.js
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { bootWorkspace, reporter, authHeaders, screenshotDir } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "bin", "hadron.js");
const r = reporter("M36 Freeze log");
const env = await bootWorkspace({ name: "m36" });
const PERF = join(env.ws, ".hadron", "logs", "perf.jsonl");
const uiLines = () => (existsSync(PERF) ? readFileSync(PERF, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === "ui") : []);
async function until(fn, ms = 10000, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((res) => setTimeout(res, step)); } return false; }
let browser;

try {
  const mk = (body) => fetch(`${env.baseUrl}/api/sessions`, { method: "POST", headers: authHeaders(env.token), body: JSON.stringify(body) });
  r.ok((await mk({ name: "One", group: "Workers", launchCommand: "shell" })).status === 201, "shell agent 'one' created");
  r.ok((await mk({ name: "Two", group: "Workers", launchCommand: "shell" })).status === 201, "shell agent 'two' created");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="one"]`).click();
  await page.locator(`.dk[data-sid="two"]`).click();
  await page.waitForTimeout(1500);          // let boot-time work settle
  await page.evaluate(() => window.perfFlush(false));
  await until(() => true, 600);
  const before = uiLines().filter((l) => l.ev === "freeze").length;

  // A short stall, then a long one with a mark.
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 50) {} });
  await page.waitForTimeout(400);
  await page.evaluate(() => { perfMark("render"); const t = performance.now(); while (performance.now() - t < 700) {} });
  await page.waitForTimeout(500);           // the attribution is decided one beat later
  await page.evaluate(() => window.perfFlush(false));
  r.ok(await until(() => uiLines().some((l) => l.ev === "freeze" && (l.marks || []).includes("render") && l.ms >= 550)), "the busy loop lands as a freeze line carrying its mark");
  const fz = uiLines().filter((l) => l.ev === "freeze").slice(before);
  const busy = fz.find((l) => (l.marks || []).includes("render") && l.ms >= 550);
  r.ok(busy && busy.ms >= 550 && busy.ms <= 1200, `…of about 700 ms (${busy && busy.ms})`);
  r.ok(busy && busy.agent === "two" && typeof busy.view === "string", `…with the active agent and view (${busy && busy.agent} / ${busy && busy.view})`);
  r.ok(fz.every((l) => l.ms >= 200), `no freeze under 200 ms reported (${fz.map((l) => l.ms).join(",")})`);

  const sw = uiLines().filter((l) => l.ev === "switch");
  r.ok(sw.length >= 2 && sw.every((l) => typeof l.ms === "number" && l.ms >= 0 && l.view), `card clicks are switch samples with a view (${sw.map((l) => `${l.view}:${l.ms}`).join(", ")})`);

  // A hidden page: timers are throttled, nothing is a freeze.
  const n0 = uiLines().length;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const t = performance.now(); while (performance.now() - t < 600) {}
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.perfFlush(false));
  await page.waitForTimeout(1500);
  r.ok(uiLines().length === n0, `a hidden page records nothing (${uiLines().length - n0} new)`);
  await page.evaluate(() => { delete document.hidden; });

  // A browser without long-animation-frame timing (Safari, Firefox): the gap
  // is the measure, an upper bound — a 210-ms block is never missed.
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p2.addInitScript(() => {
    Object.defineProperty(PerformanceObserver, "supportedEntryTypes", { configurable: true, get: () => [] });
    // Run the block right after a heartbeat: the gap is then the block plus
    // a hair — the case "gap − half a beat" missed.
    const si = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      if (ms !== 100 || !String(fn).includes("gap")) return si.call(window, fn, ms, ...rest);
      return si.call(window, function () {
        fn();
        const d = window.__blockAfterBeat;
        if (!d) return;
        window.__blockAfterBeat = 0;
        perfMark("deck render");
        const t = performance.now(); while (performance.now() - t < d) {}
      }, ms, ...rest);
    };
  });
  await p2.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(1500);
  await p2.evaluate(() => window.perfFlush(false));
  await p2.waitForTimeout(600);
  const n1 = uiLines().filter((l) => l.ev === "freeze").length;
  let caught = 0;
  for (let i = 0; i < 3; i++) {
    await p2.evaluate(() => { window.__blockAfterBeat = 210; });
    await p2.waitForTimeout(400);
  }
  await p2.evaluate(() => window.perfFlush(false));
  await until(() => uiLines().filter((l) => l.ev === "freeze").length >= n1 + 3, 5000);
  const nl = uiLines().filter((l) => l.ev === "freeze").slice(n1).filter((l) => (l.marks || []).includes("deck render"));
  caught = nl.length;
  r.ok(caught === 3 && nl.every((l) => l.ms >= 210 && l.ms <= 320), `no frame timing: three 210-ms blocks, three freezes measured by the gap (${nl.map((l) => Math.round(l.ms)).join(",")})`);
  await p2.close();

  const p = spawnSync("node", [CLI, "perf"], { cwd: env.ws, encoding: "utf-8", timeout: 30000 });
  r.ok(p.status === 0 && /page freezes \(main thread blocked ≥ 200 ms\): \d+/.test(p.stdout) && /render/.test(p.stdout), "hadron perf prints the freeze section with the mark");
  r.ok(/agent switch → next frame \(ms\)/.test(p.stdout) && !/agent switch → next frame \(ms\): none/.test(p.stdout), "…and the switch table");
  await page.screenshot({ path: join(screenshotDir(), "m36-freeze-log.png") });
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
