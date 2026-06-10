/**
 * Module M6 — Content extraction (Copy / Download / context menu).
 *
 * Feature 1: Copy + Download buttons on text-based artifact views.
 *   - Open a .md artifact → Copy button visible; click it → clipboard equals
 *     the file content; button shows "Copied ✓" feedback.
 *   - Click Download → download event fires with the correct suggested filename.
 *
 * Feature 2: Right-click context menu on artifact tabs.
 *   - Right-click the artifact tab → menu appears with Copy contents / Copy path
 *     / Download items.
 *   - Click "Copy path" → clipboard equals the artifact's path.
 *
 * Run: node test/e2e/m6-copy.js
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const r = reporter("M6 Content extraction");
const env = await bootWorkspace({ name: "m6" });
let browser;

const MD_CONTENT = `# Hello Hadron\n\nThis is a test artifact for copy/download.\n\n- item one\n- item two\n`;
const MD_FILENAME = "readme.md";

try {
  // ── script: write fixture, create agent via HTTP API ──
  const mdPath = join(env.ws, MD_FILENAME);
  writeFileSync(mdPath, MD_CONTENT);

  const resp = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "copy demo",
      group: "Demo",
      launchCommand: "shell",
      artifacts: [
        { type: "file", value: MD_FILENAME },
      ],
    }),
  });
  r.ok(resp.status === 201, "agent created with md artifact");

  // ── browser: open the agent, click the artifact ──
  browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 850 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  // Select the agent
  await page.locator('.dk[data-sid="copy-demo"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('.dk[data-sid="copy-demo"]').click();

  // Click the artifact in the right panel to open its tab
  await page.locator('.af[data-art-idx]', { hasText: MD_FILENAME }).waitFor({ state: "visible", timeout: 5000 });
  await page.locator('.af[data-art-idx]', { hasText: MD_FILENAME }).click();

  // Wait for the markdown preview to render
  await page.locator('.md-preview').waitFor({ state: "visible", timeout: 10000 });

  // ── Check 1: Copy button is visible ──
  const copyBtn = page.locator('.artifact-action-btn', { hasText: "Copy" });
  await copyBtn.waitFor({ state: "visible", timeout: 5000 });
  r.ok(await copyBtn.isVisible(), "Copy button visible on md artifact view");

  // ── Check 2: Download button is visible ──
  const dlBtn = page.locator('.artifact-action-btn', { hasText: "Download" });
  r.ok(await dlBtn.isVisible(), "Download button visible on md artifact view");

  // ── Check 3: Click Copy → clipboard gets the file content ──
  await copyBtn.click();
  // Wait for feedback
  await page.locator('.artifact-action-btn.copied').waitFor({ state: "visible", timeout: 3000 });
  r.ok(true, "Copy button shows 'Copied ✓' feedback");

  const clipped = await page.evaluate(() => navigator.clipboard.readText());
  r.ok(clipped === MD_CONTENT, `clipboard contains file content (got ${clipped.length} chars, expected ${MD_CONTENT.length})`);

  // ── Check 4: Download fires with correct filename ──
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dlBtn.click(),
  ]);
  r.ok(download.suggestedFilename() === MD_FILENAME, `download suggests correct filename: ${download.suggestedFilename()}`);

  // ── Check 5: Right-click artifact tab → context menu appears ──
  const artTab = page.locator('.wh-tab-art', { hasText: MD_FILENAME });
  await artTab.waitFor({ state: "visible", timeout: 5000 });
  await artTab.click({ button: "right" });

  const ctxMenu = page.locator('#artifact-tab-ctx-menu');
  await ctxMenu.waitFor({ state: "visible", timeout: 3000 });
  r.ok(await ctxMenu.isVisible(), "artifact tab context menu appears on right-click");

  // Check menu items
  const items = await ctxMenu.locator('.art-ctx-item').allInnerTexts();
  r.ok(items.some((t) => t.includes("Copy contents")), `context menu has 'Copy contents' (got: ${items.join(", ")})`);
  r.ok(items.some((t) => t.includes("Copy path")), `context menu has 'Copy path'`);
  r.ok(items.some((t) => t.includes("Download")), `context menu has 'Download'`);

  // Screenshot of the open context menu
  const dir = screenshotDir();
  await page.screenshot({ path: join(dir, "m6-ctx-menu.png") });
  console.log(`  📸 ${join(dir, "m6-ctx-menu.png")}`);

  // ── Check 6: Click "Copy path" → clipboard equals the resolved artifact path ──
  // The server resolves relative paths to absolute (resolveFilePath), so the
  // stored value (and what gets copied) is the full absolute path.
  const expectedPath = join(env.ws, MD_FILENAME);

  await ctxMenu.locator('.art-ctx-item', { hasText: "Copy path" }).click();
  // Give async fetch/clipboard write a moment
  await page.waitForTimeout(300);
  const pathClipped = await page.evaluate(() => navigator.clipboard.readText());
  r.ok(pathClipped === expectedPath, `Copy path writes artifact path to clipboard (got: "${pathClipped}", expected: "${expectedPath}")`);

} catch (e) {
  r.fail(`unexpected error: ${e.message}\n${e.stack}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
