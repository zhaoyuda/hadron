/**
 * Module M2 — Agent lifecycle.
 *
 *   - script: create / list / delete an agent over the API
 *   - browser: select a shell agent and prove its TERMINAL actually connects —
 *     the WS round-trips a typed command back to the screen (screenshot)
 *
 * The browser check is the regression guard for the v0.6 "blank terminal" bug:
 * the HTTP API was fine, but the browser→WS→tmux→xterm path was broken and no
 * non-browser test could see it.
 *
 * Run: node test/e2e/m2-lifecycle.js
 */
import { chromium } from "playwright";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M2 Agent lifecycle");
const env = await bootWorkspace({ name: "m2" });
let browser;
try {
  const mk = (body) => fetch(`${env.baseUrl}/api/sessions`, { method: "POST", headers: authHeaders(env.token), body: JSON.stringify(body) });

  // ── script: create / list / delete ──
  const created = await mk({ name: "E2E Shell", group: "Workers", launchCommand: "shell" });
  r.ok(created.status === 201, "POST create shell agent → 201");
  const list = await (await fetch(`${env.baseUrl}/api/sessions`)).json();
  r.ok(list.some((s) => s.id === "e2e-shell"), "created agent appears in session list");
  const del = await fetch(`${env.baseUrl}/api/sessions/e2e-shell?force=true`, { method: "DELETE", headers: authHeaders(env.token) });
  r.ok(del.status === 200, "DELETE agent → 200");

  // ── browser: terminal of a shell agent actually connects + round-trips ──
  await mk({ name: "Term Probe", group: "Workers", launchCommand: "shell" });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  await page.locator('.dk[data-sid="term-probe"]').click();

  // Terminal renders into #terminal-container as .xterm-rows. Wait for the shell
  // prompt to appear — empty rows here would be the blank-terminal regression.
  const rows = page.locator("#terminal-container .xterm-rows");
  await rows.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#terminal-container .xterm-rows");
    return el && el.innerText.trim().length > 0;
  }, { timeout: 10000 });
  r.ok(true, "terminal renders a shell prompt (WS connected)");

  // Prove the full round-trip: typed keystrokes reach the pty and echo back.
  await page.locator("#terminal-container").click();
  await page.keyboard.type("echo HADRON_E2E_OK");
  await page.keyboard.press("Enter");
  const roundTrip = await page.waitForFunction(() => {
    const el = document.querySelector("#terminal-container .xterm-rows");
    return el && el.innerText.includes("HADRON_E2E_OK");
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  r.ok(roundTrip, "typed command round-trips browser→WS→tmux→xterm");

  const shot = join(screenshotDir(), "m2-terminal.png");
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`  📸 ${shot}`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
