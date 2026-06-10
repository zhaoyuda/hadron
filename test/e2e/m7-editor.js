/**
 * Module M7 — Editor setting (built-in textarea vs vim).
 *
 * Edit mode on an artifact is now routed by the "hadron-editor" localStorage
 * pref (View ▸ Editor): default "text" opens a plain textarea with a Save
 * button (POST /api/file) — no tmux session at all; opt-in "vim" keeps the
 * original terminal-vim-in-throwaway-tmux behavior. This module drives the
 * golden path like a user:
 *   - default (no localStorage): toggle Edit on an md artifact → textarea
 *     appears with the exact file content, and NO vim tmux session exists
 *   - type a change + Ctrl+S → file content on disk updates; Save button
 *     shows "Saved ✓"; the mtime poller (3s) does not clobber the editor
 *   - toggle back to Preview → rendered markdown includes the new text
 *   - View menu → Editor → "Vim (terminal)" (real clicks) → toggle Edit
 *     again → a vim tmux session IS created
 *
 * Run: node test/e2e/m7-editor.js
 */
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const r = reporter("M7 Editor setting (textarea / vim)");
const env = await bootWorkspace({ name: "m7" });
const prefix = `hadron-${env.wsName}`;
let browser;

function tmuxSessions() {
  try {
    const out = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n");
  } catch { return []; }
}
const vimSessionExists = () => tmuxSessions().some((n) => n.startsWith(prefix) && n.includes("-vim-"));
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (fn()) return true; await wait(150); }
  return fn();
}

const mdPath = join(env.ws, "notes.md");
const original = "# Field Notes\n\nfirst draft\n";

try {
  // ── script: fixture on disk + agent created over the HTTP API ──
  writeFileSync(mdPath, original);
  const resp = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "editor demo", group: "Demo", launchCommand: "shell",
      artifacts: [{ type: "file", value: "notes.md" }],
    }),
  });
  r.ok(resp.status === 201, "agent created via HTTP API with an md artifact");

  // ── browser: default setting (no localStorage) → built-in textarea ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  await page.locator('.dk[data-sid="editor-demo"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('.dk[data-sid="editor-demo"]').click();
  await page.locator('.af[data-art-idx]', { hasText: "notes.md" }).click();
  await page.locator(".md-toggle").waitFor({ state: "visible", timeout: 10000 });

  // 1. Toggle Edit → textarea with the exact file content, no vim tmux session.
  await page.locator(".md-toggle").click();
  const ta = page.locator(".text-edit-area");
  await ta.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForFunction(() => {
    const el = document.querySelector(".text-edit-area");
    return el && !el.disabled && el.value.length > 0;
  }, null, { timeout: 5000 });
  r.ok((await ta.inputValue()) === original, "Edit (default) opens a textarea with the exact file content");
  await wait(700); // would-be vim WS/tmux spin-up window
  r.ok(!vimSessionExists(), "no vim tmux session is created in text mode");

  const dir = screenshotDir();
  await page.locator("#artifact-container").screenshot({ path: join(dir, "m7-text-editor.png") });
  console.log(`  📸 ${join(dir, "m7-text-editor.png")}`);

  // 2. Type a change, Ctrl+S → disk updated, button shows saved feedback.
  const edited = original + "\nsecond draft via textarea\n";
  await ta.fill(edited);
  await ta.press("Control+s");
  await page.waitForFunction(() => {
    const btn = document.querySelector(".text-editor-save");
    return btn && btn.textContent.includes("Saved ✓");
  }, null, { timeout: 4000 });
  r.ok(true, 'Save button shows "Saved ✓" feedback');
  r.ok(readFileSync(mdPath, "utf-8") === edited, "Ctrl+S writes the edited content to disk");

  // Ride out a full mtime-poll cycle (3s): our own save must not trigger a
  // reload that rebuilds the pane out from under the editor.
  await wait(3800);
  r.ok((await page.locator(".text-edit-area").count()) === 1 && (await ta.inputValue()) === edited,
    "mtime poller does not clobber the open editor after a save");

  // 3. Toggle back to Preview → rendered output includes the new text.
  await page.locator(".md-toggle").click();
  await page.locator(".md-preview").waitFor({ state: "visible", timeout: 5000 });
  const preview = await page.locator(".md-preview").innerText();
  r.ok(preview.includes("second draft via textarea"), "Preview after save renders the new text");
  r.ok(preview.includes("Field Notes"), "Preview keeps the original content too");

  // 4. View ▸ Editor ▸ "Vim (terminal)" via real clicks → Edit opens vim tmux.
  await page.locator("#menu-view").click();
  const editorItem = page.locator(".menu-dropdown-item.has-submenu", { hasText: "Editor" });
  await editorItem.waitFor({ state: "visible", timeout: 5000 });
  await editorItem.hover();
  await page.locator('.menu-submenu .menu-dropdown-item[data-editor="vim"]').click();
  const pref = await page.evaluate(() => localStorage.getItem("hadron-editor"));
  r.ok(pref === "vim", `menu click persists the setting (localStorage hadron-editor=${pref})`);

  await page.locator(".md-toggle").click();
  r.ok(await until(() => vimSessionExists()), "Edit with vim setting creates a vim tmux session");
  r.ok((await page.locator(".text-edit-area").count()) === 0, "no textarea in vim mode");
  r.ok((await page.locator(".vim-editor-container").count()) === 1, "vim terminal container is rendered");

  // Close the editor (back to preview) → vim tmux session is reaped.
  await page.locator(".md-toggle").click();
  r.ok(await until(() => !vimSessionExists()), "toggling back to Preview reaps the vim tmux session");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
