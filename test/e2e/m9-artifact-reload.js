/**
 * Module M9 — Artifact live-reload (mtime poller + HTML update pill).
 *
 * Two real bugs drove this module:
 *  1. Baseline race: the poller used its own first HEAD (3s after render) as the
 *     change baseline, silently swallowing any disk write inside that window —
 *     an HTML tab opened right before an agent rewrote the file stayed stale
 *     forever. The fix keys the baseline to the rendered content's mtime.
 *  2. Split-mode gap: HTML panes rendered outside the artifact cache and the
 *     poller exited when activeTab wasn't an artifact, so vsplit/hsplit HTML
 *     never noticed disk changes at all.
 *
 * Design under test: md/csv keep silent auto-reload (no interaction state to
 * lose); a live HTML iframe instead gets a "File updated ↻ Reload" pill —
 * reloading only on click so scroll/JS/form state isn't yanked away.
 *
 * Technique: browser (Playwright) — the truths are iframe src swaps, pill
 * rendering, and poller timing, none visible to script-level checks.
 *
 * Run: node test/e2e/m9-artifact-reload.js
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M9 Artifact live-reload");
const env = await bootWorkspace({ name: "m9" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
// Poller ticks every 3s; give each expectation three ticks of slack.
async function until(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}

try {
  const htmlPath = join(env.ws, "report.html");
  const mdPath = join(env.ws, "notes.md");
  writeFileSync(htmlPath, "<html><body><h1 id='v'>VERSION-1</h1></body></html>");
  writeFileSync(mdPath, "# md-v1");
  await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "m9", launchCommand: "shell",
      artifacts: [{ type: "file", value: "report.html" }, { type: "file", value: "notes.md" }],
    }),
  });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="m9"]').click();

  // ── HTML tab: change inside the first 3s window → pill, not a silent swap ──
  await page.locator(".af[data-art-idx]", { hasText: "report.html" }).click();
  const iframe = page.locator('#artifact-container iframe[data-html-iframe="1"]');
  const frame = page.frameLocator('#artifact-container iframe[data-html-iframe="1"]');
  await frame.locator("#v").waitFor({ state: "visible", timeout: 10000 });
  const src1 = await iframe.getAttribute("src");

  await wait(1500); // land the write inside the old swallow window
  writeFileSync(htmlPath, "<html><body><h1 id='v'>VERSION-2</h1></body></html>");
  r.ok(await until(() => page.locator("#artifact-container .artifact-update-pill").count()),
    "disk write right after open → update pill appears (baseline race fixed)");
  r.ok((await iframe.getAttribute("src")) === src1 && (await frame.locator("#v").innerText()) === "VERSION-1",
    "iframe NOT silently reloaded — old content stays until the user opts in");

  await page.locator("#artifact-container .artifact-update-pill").click();
  r.ok(await until(async () => (await frame.locator("#v").innerText().catch(() => "")) === "VERSION-2"),
    "clicking the pill reloads the iframe to the new content");
  r.ok((await page.locator("#artifact-container .artifact-update-pill").count()) === 0,
    "pill is gone after reload");

  // ── markdown tab: still silent auto-reload, also immune to the race ──
  await page.locator(".af[data-art-idx]", { hasText: "notes.md" }).click();
  await page.locator("#artifact-container .md-preview", { hasText: "md-v1" }).waitFor({ timeout: 10000 });
  await wait(1500);
  writeFileSync(mdPath, "# md-v2");
  r.ok(await until(async () =>
    (await page.locator("#artifact-container .md-preview").innerText().catch(() => "")).includes("md-v2")),
    "markdown artifact silently auto-reloads on disk change (early write included)");

  // ── split mode: HTML pane is watched too ──
  await page.evaluate(() => cycleLayout()); // tabs → vsplit; both artifacts become panes
  const paneFrame = page.frameLocator('.split-pane[data-html-path] iframe[data-html-iframe="1"]');
  await paneFrame.locator("#v").waitFor({ state: "visible", timeout: 10000 });
  await wait(1500); // let the watch baseline settle
  writeFileSync(htmlPath, "<html><body><h1 id='v'>VERSION-3</h1></body></html>");
  r.ok(await until(() => page.locator(".split-pane .artifact-update-pill").count()),
    "split-mode HTML pane detects the disk change (was: never)");
  await page.screenshot({ path: join(screenshotDir(), "m9-split-update-pill.png") });
  await page.locator(".split-pane .artifact-update-pill").click();
  r.ok(await until(async () => (await paneFrame.locator("#v").innerText().catch(() => "")) === "VERSION-3"),
    "split-pane pill click reloads the pane iframe");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
