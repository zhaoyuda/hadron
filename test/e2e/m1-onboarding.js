/**
 * Module M1 — Onboarding.
 *
 * Proves a freshly scaffolded workspace boots into a usable dashboard:
 *   - script: server answers, the sample agent is installed and listed
 *   - browser: the dashboard actually paints the sample agent card (screenshot)
 *
 * Run: node test/e2e/m1-onboarding.js   (chromium via Playwright must be installed)
 */
import { chromium } from "playwright";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir } from "./harness.js";

const r = reporter("M1 Onboarding");
const env = await bootWorkspace({ name: "m1" });
let browser;
try {
  // ── script: onboarding produced a live, populated workspace ──
  const list = await (await fetch(`${env.baseUrl}/api/sessions`)).json();
  r.ok(Array.isArray(list), "GET /api/sessions returns an array");
  r.ok(list.some((s) => s.id === "hadron"), "sample agent installed by setup-workspace");

  // ── browser: the dashboard paints and the sample card is visible ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  const card = page.locator('.dk[data-sid="hadron"]');
  await card.waitFor({ state: "visible", timeout: 10000 });
  r.ok(await card.isVisible(), "sample agent card renders in the deck");
  const shot = join(screenshotDir(), "m1-dashboard.png");
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`  📸 ${shot}`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
