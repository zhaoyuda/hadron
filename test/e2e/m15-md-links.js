/**
 * Module M15 — Clicking a link in a markdown preview opens the target artifact.
 *
 * A relative/absolute link to another local file inside a rendered .md preview
 * (e.g. [report](./report.md)) should open in-place as an artifact tab of the
 * current agent — the same "open as this agent's artifact" model as clicking a
 * terminal path — instead of navigating the dashboard away. External links
 * (http/https/…) open in a new tab; a link whose target is missing flashes
 * rather than adding a broken tab.
 *
 * Technique: browser (Playwright) — link interception, the new artifact tab, the
 * window.open hand-off, and the missing-link flash are all live-DOM truths.
 *
 * Run: node test/e2e/m15-md-links.js
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter } from "./harness.js";

const r = reporter("M15 Markdown links → artifacts");
const env = await bootWorkspace({ name: "m15" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const artCount = (page) => page.evaluate(() => {
  const s = sessions.find((x) => x.id === activeSessionId);
  return (s.artifacts || []).length;
});

try {
  writeFileSync(join(env.ws, "report.md"), "# The Report\n\nquarterly numbers here");
  writeFileSync(join(env.ws, "guide.md"),
    "# Guide\n\n" +
    "- [open the report](./report.md)\n" +
    "- [external site](https://example.com/docs)\n" +
    "- [missing file](./nope.md)\n");
  await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name: "linker", launchCommand: "shell", artifacts: [{ type: "file", value: "guide.md" }] }),
  });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  // Record window.open so we can assert external links hand off to a new tab.
  await page.addInitScript(() => { window.__opened = []; const o = window.open; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  await page.locator('.dk[data-sid="linker"]').click();
  await page.locator('.af[data-art-idx]', { hasText: "guide.md" }).click();
  await page.locator("#artifact-container .md-preview:visible").waitFor({ state: "visible", timeout: 10000 });
  r.ok(await page.locator('.md-preview:visible a', { hasText: "open the report" }).count() > 0,
    "markdown link renders as an anchor in the preview");

  // ── (1) Local link → opens the target as a new artifact tab ──
  const before = await artCount(page);
  await page.locator('.md-preview:visible a', { hasText: "open the report" }).click();
  await wait(500);
  const after = await artCount(page);
  r.ok(after === before + 1, `clicking a local md link adds it as an artifact (was ${before}, now ${after})`);
  const values = await page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return (s.artifacts || []).map((a) => a.value);
  });
  r.ok(values.some((v) => v.endsWith("report.md")), `the linked file is the one added: ${JSON.stringify(values)}`);
  const showsReport = await page.evaluate(() =>
    [...document.querySelectorAll("#artifact-container .md-preview")]
      .some((el) => el.offsetParent !== null && el.innerText.includes("quarterly numbers")));
  r.ok(showsReport, "the linked artifact is opened and rendered in the viewer");

  // ── (2) Re-adding via the same link is a no-op (dedupe), just refocuses ──
  await page.locator('.af[data-art-idx]', { hasText: "guide.md" }).click();
  await page.locator("#artifact-container .md-preview:visible").waitFor({ state: "visible", timeout: 5000 });
  const beforeDup = await artCount(page);
  await page.locator('.md-preview:visible a', { hasText: "open the report" }).click();
  await wait(400);
  r.ok((await artCount(page)) === beforeDup, "re-clicking the same link does not duplicate the artifact");

  // ── (3) External link → new tab (window.open), never an artifact ──
  await page.locator('.af[data-art-idx]', { hasText: "guide.md" }).click();
  await page.locator("#artifact-container .md-preview:visible").waitFor({ state: "visible", timeout: 5000 });
  const beforeExt = await artCount(page);
  await page.locator('.md-preview:visible a', { hasText: "external site" }).click();
  await wait(300);
  const opened = await page.evaluate(() => window.__opened);
  r.ok(opened.some((u) => u.includes("example.com/docs")), `external link opens in a new tab: ${JSON.stringify(opened)}`);
  r.ok((await artCount(page)) === beforeExt, "external link does not add an artifact");

  // ── (4) Missing target → flashes, adds nothing ──
  const beforeMiss = await artCount(page);
  await page.locator('.md-preview:visible a', { hasText: "missing file" }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.md-preview a.md-link-missing')].some((el) => el.offsetParent !== null),
    null, { timeout: 2000 });
  r.ok(true, "a link to a missing file flashes (md-link-missing)");
  r.ok((await artCount(page)) === beforeMiss, "a missing-target link does not add an artifact");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
