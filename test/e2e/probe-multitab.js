/**
 * Probe the multi-tab decouple (not part of npm test). Two same-origin pages
 * share one BroadcastChannel. Verifies:
 *   1. No forced follow — each tab keeps its own active agent.
 *   2. Per-agent view sync — when two tabs show the SAME agent, a layout change
 *      in one mirrors to the other (keeps the shared tmux pane one size).
 *
 * Run: node test/e2e/probe-multitab.js
 */
import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { bootWorkspace, reporter } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = await bootWorkspace({ name: "multitab" });
const port = env.baseUrl.split(":").pop();
const r = reporter("multi-tab decouple");

function hadron(args) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token },
  });
}

const active = (page) => page.evaluate(() => activeSessionId);
const layout = (page) => page.evaluate(() => layoutMode);

let browser;
try {
  hadron(["spawn", "alpha", "--group", "Workers", "--launch", "shell"]);
  hadron(["spawn", "bravo", "--group", "Workers", "--launch", "shell"]);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p1 = await ctx.newPage();
  const p2 = await ctx.newPage();
  await p1.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p2.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p1.locator('.dk[data-sid="alpha"]').waitFor({ state: "visible", timeout: 10000 });
  await p2.locator('.dk[data-sid="alpha"]').waitFor({ state: "visible", timeout: 10000 });

  // 1. Decouple: p1 → alpha, p2 → bravo, and they must NOT follow each other.
  await p1.locator('.dk[data-sid="alpha"]').click();
  await p2.locator('.dk[data-sid="bravo"]').click();
  await p1.waitForTimeout(400);
  await p2.waitForTimeout(400);
  r.ok((await active(p1)) === "alpha", `p1 stays on alpha (got ${await active(p1)})`);
  r.ok((await active(p2)) === "bravo", `p2 stays on bravo (got ${await active(p2)})`);

  // 2. Per-agent sync: point both tabs at alpha, change layout in p1, expect p2 to mirror.
  await p2.locator('.dk[data-sid="alpha"]').click();
  await p2.waitForTimeout(300);
  r.ok((await active(p2)) === "alpha", "p2 now on alpha");
  const before = await layout(p2);
  await p1.evaluate(() => cycleLayout());
  await p2.waitForTimeout(400);
  const p1Layout = await layout(p1);
  const p2Layout = await layout(p2);
  r.ok(p1Layout !== "tabs", `p1 layout changed (got ${p1Layout})`);
  r.ok(p2Layout === p1Layout, `p2 mirrors p1 layout (${p2Layout} === ${p1Layout}, was ${before})`);

  // 3. Cross-agent isolation: p2 → bravo, change layout there, p1 (on alpha) unaffected.
  await p2.locator('.dk[data-sid="bravo"]').click();
  await p2.waitForTimeout(300);
  const p1AlphaLayout = await layout(p1);
  await p2.evaluate(() => cycleLayout());
  await p1.waitForTimeout(400);
  r.ok((await active(p1)) === "alpha", "p1 still on alpha after p2 edits bravo");
  r.ok((await layout(p1)) === p1AlphaLayout, "p1 alpha layout untouched by bravo change");
} catch (e) {
  console.error("error:", e.message);
  r.fail("threw: " + e.message);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
