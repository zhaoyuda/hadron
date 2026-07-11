/**
 * Module M16 — Editor draft model: no silent data loss, no silent overwrite.
 *
 * Release gates from design-notes/editor-ux-design.md (P0):
 *   - dirty draft survives Preview⇄Edit round-trips (preview renders the draft)
 *   - dirty dot on the artifact tab
 *   - draft survives a full page reload (localStorage persistence)
 *   - first open lands at the top, not the old cursor-at-end bottom
 *   - a file changed on disk mid-edit makes Save 409 → conflict dialog;
 *     the other writer's version is never silently overwritten
 *   - Cancel keeps the draft; Compare shows both versions
 *   - Overwrite is conditional on the version just seen — if the file changes
 *     AGAIN mid-dialog, the retry re-conflicts instead of punching through
 *   - Discard changes… (with confirm) reverts to disk and clears the dot
 *
 * Run: node test/e2e/m16-editor-drafts.js
 */
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const r = reporter("M16 Editor drafts & conflicts");
const env = await bootWorkspace({ name: "m16" });
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const mdPath = join(env.ws, "plan.md");
const original = "# Plan\n\n" + Array.from({ length: 80 }, (_, i) => `- step ${i + 1}`).join("\n") + "\n";

const taReady = (page) => page.waitForFunction(() => {
  const el = document.querySelector(".text-edit-area");
  return el && !el.disabled && el.value.length > 0;
}, null, { timeout: 6000 });

try {
  writeFileSync(mdPath, original);
  await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name: "drafter", launchCommand: "shell", artifacts: [{ type: "file", value: "plan.md" }] }),
  });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="drafter"]').click();
  await page.locator('.af[data-art-idx]', { hasText: "plan.md" }).click();
  await page.locator(".md-toggle").waitFor({ state: "visible", timeout: 10000 });

  // ── 1. first open: viewport at the top, not scrolled to the end ──
  await page.locator(".md-toggle").click();
  await taReady(page);
  const pos = await page.evaluate(() => {
    const el = document.querySelector(".text-edit-area");
    return { top: el.scrollTop, sel: el.selectionStart };
  });
  r.ok(pos.top === 0 && pos.sel === 0, `first Edit opens at the top (scrollTop=${pos.top}, caret=${pos.sel})`);

  // ── 2. dirty draft survives Preview⇄Edit (preview renders the DRAFT) ──
  await page.locator(".text-edit-area").focus();
  await page.evaluate(() => {
    const el = document.querySelector(".text-edit-area");
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type("\nDRAFT-ONLY LINE");
  await page.locator(".md-toggle").click(); // → preview
  await page.locator(".md-preview").waitFor({ state: "visible", timeout: 5000 });
  r.ok((await page.locator(".md-preview").innerText()).includes("DRAFT-ONLY LINE"),
    "Preview renders the unsaved draft, not the disk content");
  r.ok((await page.locator(".md-toggle-draftnote").count()) === 1, 'toggle bar flags "unsaved changes"');
  r.ok(readFileSync(mdPath, "utf-8") === original, "disk content untouched by the toggle");
  await page.locator(".md-toggle").click(); // → edit
  await taReady(page);
  r.ok((await page.locator(".text-edit-area").inputValue()).includes("DRAFT-ONLY LINE"),
    "toggling back to Edit keeps the draft");
  r.ok((await page.locator(".wh-tab-hasdraft").count()) >= 1, "artifact tab shows the dirty draft dot");

  // ── 3. draft survives a full page reload ──
  await wait(700); // ride out the 500ms persist debounce (beforeunload also flushes)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="drafter"]').click();
  await page.locator('.af[data-art-idx]', { hasText: "plan.md" }).click();
  await page.locator(".md-toggle").waitFor({ state: "visible", timeout: 10000 });
  await page.locator(".md-toggle").click();
  await taReady(page);
  r.ok((await page.locator(".text-edit-area").inputValue()).includes("DRAFT-ONLY LINE"),
    "draft restored after a page reload");

  // ── 4. agent writes the file mid-edit → Save must 409, never overwrite ──
  writeFileSync(mdPath, original + "\nTHE AGENTS WORK\n");
  await page.locator(".text-edit-area").press("Control+s");
  await page.locator(".editor-conflict-overlay").waitFor({ state: "visible", timeout: 5000 });
  r.ok(true, "Save against a changed file opens the conflict dialog");
  r.ok(readFileSync(mdPath, "utf-8").includes("THE AGENTS WORK"), "the other writer's version was NOT overwritten");
  r.ok((await page.locator(".text-editor-save").innerText()).includes("Conflict"), "Save button flips to Conflict state");

  const dir = screenshotDir();
  await page.locator(".ec-compare-btn").click();
  const cmpTexts = await page.locator(".ec-compare pre").allInnerTexts();
  r.ok(cmpTexts.length === 2 && cmpTexts[0].includes("DRAFT-ONLY LINE") && cmpTexts[1].includes("THE AGENTS WORK"),
    "Compare shows draft and current disk side by side");
  await page.screenshot({ path: join(dir, "m16-conflict-dialog.png") });
  console.log(`  📸 ${join(dir, "m16-conflict-dialog.png")}`);

  // ── 5. Cancel keeps the draft ──
  await page.locator(".ec-cancel-btn").click();
  r.ok((await page.locator(".editor-conflict-overlay").count()) === 0, "Cancel closes the dialog");
  r.ok((await page.locator(".text-edit-area").inputValue()).includes("DRAFT-ONLY LINE"), "Cancel keeps the draft intact");

  // ── 6. Overwrite is conditional: another change mid-dialog re-conflicts ──
  await page.locator(".text-edit-area").press("Control+s");
  await page.locator(".editor-conflict-overlay").waitFor({ state: "visible", timeout: 5000 });
  writeFileSync(mdPath, original + "\nTHE AGENTS SECOND WRITE\n"); // changes again while dialog is open
  await wait(30); // distinct mtime
  page.once("dialog", (d) => d.accept()); // the Overwrite… second confirm
  await page.locator(".ec-overwrite-btn").click();
  await page.locator(".editor-conflict-overlay").waitFor({ state: "visible", timeout: 5000 });
  r.ok(true, "file changed again during the dialog → Overwrite re-conflicts instead of punching through");
  r.ok(readFileSync(mdPath, "utf-8").includes("THE AGENTS SECOND WRITE"), "the newest disk version survived the stale overwrite");

  // ── 7. clean Overwrite path goes through ──
  page.once("dialog", (d) => d.accept());
  await page.locator(".ec-overwrite-btn").click();
  await page.waitForFunction(() => document.querySelectorAll(".editor-conflict-overlay").length === 0, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const btn = document.querySelector(".text-editor-save");
    return btn && btn.textContent.includes("Saved ✓");
  }, null, { timeout: 5000 });
  r.ok(readFileSync(mdPath, "utf-8").includes("DRAFT-ONLY LINE"), "deliberate Overwrite writes the draft to disk");

  // ── 8. Discard changes… reverts to disk and clears the dot ──
  await page.locator(".text-edit-area").focus();
  await page.evaluate(() => {
    const el = document.querySelector(".text-edit-area");
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type("\nabandon me");
  await page.waitForFunction(() => document.querySelector(".text-editor-discard")?.style.display !== "none", null, { timeout: 4000 });
  page.once("dialog", (d) => d.accept());
  await page.locator(".text-editor-discard").click();
  await taReady(page);
  const afterDiscard = await page.locator(".text-edit-area").inputValue();
  r.ok(!afterDiscard.includes("abandon me"), "Discard removes the unsaved edits");
  r.ok(afterDiscard === readFileSync(mdPath, "utf-8"), "Discard reloads the on-disk content");
  r.ok((await page.locator(".wh-tab-hasdraft").count()) === 0, "dirty dot clears after discard");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
