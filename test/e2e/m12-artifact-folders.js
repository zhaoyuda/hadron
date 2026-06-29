/**
 * Module M12 — Artifact folder collapse persists across the deck refresh.
 *
 * Real bug: artifacts sharing a directory render as a collapsible `af-group`,
 * but the group was hardcoded `class="af-group open"` on every render and the
 * collapse was only a live DOM class toggle. The 3s deck refresh
 * (setInterval → renderRightPanel) rebuilt the panel from scratch, so a folder
 * the user collapsed silently re-opened a few seconds later. Fix: remember the
 * collapsed dirs per session (collapsedArtFolders) and honor them on render.
 *
 * Technique: browser (Playwright) — the truth is "still collapsed after the
 * real 3s refresh ran," which only the rendered DOM can show.
 *
 * Run: node test/e2e/m12-artifact-folders.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter } from "./harness.js";

const r = reporter("M12 Artifact folder collapse");
const env = await bootWorkspace({ name: "m12" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  // Two files in the same dir → they group into one collapsible af-group ("out").
  mkdirSync(join(env.ws, "out"), { recursive: true });
  writeFileSync(join(env.ws, "out", "alpha.md"), "# alpha");
  writeFileSync(join(env.ws, "out", "beta.md"), "# beta");
  await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "m12", launchCommand: "shell",
      artifacts: [
        { type: "file", value: "out/alpha.md" },
        { type: "file", value: "out/beta.md" },
      ],
    }),
  });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="m12"]').click();

  const group = page.locator('.af-group');
  await group.waitFor({ state: "visible", timeout: 5000 });
  r.ok(await group.evaluate((el) => el.classList.contains("open")), "folder starts open");

  // Collapse it.
  await page.locator('.af-group .af-group-hdr').click();
  r.ok(!(await group.evaluate((el) => el.classList.contains("open"))), "click collapses the folder");

  // Let the real 3s deck refresh fire (it rebuilds #right from scratch).
  await wait(3600);

  // The folder must NOT have re-opened. (The bug: it silently re-opened here.)
  const stillCollapsed = !(await page.locator('.af-group')
    .evaluate((el) => el.classList.contains("open")));
  r.ok(stillCollapsed, "folder stays collapsed after the 3s deck refresh");

  // And re-expanding still works + sticks across another refresh.
  await page.locator('.af-group .af-group-hdr').click();
  r.ok(await page.locator('.af-group')
    .evaluate((el) => el.classList.contains("open")), "click re-opens the folder");
  await wait(3600);
  r.ok(await page.locator('.af-group')
    .evaluate((el) => el.classList.contains("open")), "folder stays open after another refresh");

  // ── Artifact de-dupe: adding the same value twice must not create a duplicate ──
  const count = () => page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return (s.artifacts || []).length;
  });
  const before = await count();
  await page.evaluate(async () => { await addArtifact("file", "out/gamma.md"); });
  await wait(150);
  r.ok((await count()) === before + 1, "first add of a new file lands");
  await page.evaluate(async () => { await addArtifact("file", "out/gamma.md"); });
  await wait(150);
  r.ok((await count()) === before + 1, "re-adding the same file is a no-op (no duplicate)");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
