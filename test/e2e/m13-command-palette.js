/**
 * Module M13 — Command palette (⌘K / Ctrl+K).
 *
 * Fuzzy switch across agents + the current agent's artifacts + workspace files
 * (via /api/files/suggest). Opened by Cmd/Ctrl+K (preventDefault'd so it beats
 * the browser's own) or the topbar trigger; arrow keys navigate, Enter acts,
 * Esc closes. Roadmap "Next up" #2.
 *
 * Technique: browser (Playwright) — overlay rendering, real key handling, and
 * the switch/open/add side effects are only observable in a live page.
 *
 * Run: node test/e2e/m13-command-palette.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M13 Command palette");
const env = await bootWorkspace({ name: "m13" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function mkAgent(name, artifacts = []) {
  await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name, launchCommand: "shell", artifacts }),
  });
}

try {
  // A workspace file the palette can surface via /api/files/suggest.
  mkdirSync(join(env.ws, "out"), { recursive: true });
  writeFileSync(join(env.ws, "out", "report.md"), "# report");
  // Two agents (switch target) + one with an artifact (open target).
  await mkAgent("alpha", [{ type: "file", value: "out/report.md" }]);
  await mkAgent("bravo");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="alpha"]').click();
  await page.locator("#terminal-container.active .xterm").waitFor({ state: "visible", timeout: 10000 });

  const overlay = page.locator("#palette-overlay.active");

  // ── (1) Cmd/Ctrl+K opens it, even with the terminal focused ──
  await page.locator("#terminal-container .xterm").click();
  await page.keyboard.press("Control+k");
  await overlay.waitFor({ state: "visible", timeout: 3000 });
  r.ok(await overlay.isVisible(), "Ctrl+K opens the palette over a focused terminal");

  // ── (2) Esc closes ──
  await page.keyboard.press("Escape");
  await wait(150);
  r.ok(!(await page.locator("#palette-overlay").evaluate((el) => el.classList.contains("active"))),
    "Esc closes the palette");

  // ── (3) Topbar trigger opens it too ──
  await page.locator("#palette-trigger").click();
  await overlay.waitFor({ state: "visible", timeout: 3000 });
  r.ok(await overlay.isVisible(), "topbar trigger opens the palette");

  // ── (4) Fuzzy-switch agents: type "brv", Enter → active agent is bravo ──
  await page.locator("#palette-input").fill("brv");
  await wait(150);
  const agentRow = page.locator(".palette-row", { hasText: "bravo" });
  r.ok(await agentRow.count() > 0, "fuzzy query 'brv' surfaces the bravo agent");
  await page.keyboard.press("Enter");
  await wait(400);
  const active = await page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return s && s.name;
  });
  r.ok(active === "bravo", `Enter switches to the matched agent (now ${active})`);

  // ── (5) File search → add as artifact (on the now-active bravo) ──
  await page.locator("#palette-trigger").click();
  await overlay.waitFor({ state: "visible", timeout: 3000 });
  const before = await page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return (s.artifacts || []).length;
  });
  await page.locator("#palette-input").fill("report");
  await wait(500); // debounced /api/files/suggest
  const fileRow = page.locator(".palette-cat", { hasText: "Files" });
  r.ok(await fileRow.count() > 0, "typing a filename surfaces a Files section from /api/files/suggest");
  // screenshot the populated palette before we act on it
  const shotPath = join(screenshotDir(), "m13-palette.png");
  await page.screenshot({ path: shotPath });
  console.log(`  📸 ${shotPath}`);
  await page.locator(".palette-row", { hasText: "report.md" }).first().click();
  await wait(400);
  const after = await page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return (s.artifacts || []).length;
  });
  r.ok(after === before + 1, `selecting a file adds it as an artifact (was ${before}, now ${after})`);

  // ── (6) Empty query shows agents + artifacts, no file noise ──
  await page.locator("#palette-trigger").click();
  await overlay.waitFor({ state: "visible", timeout: 3000 });
  await page.locator("#palette-input").fill("");
  await wait(150);
  const cats = (await page.locator(".palette-cat").allInnerTexts()).map((c) => c.toLowerCase());
  r.ok(cats.includes("agents") && !cats.includes("files"),
    `empty query lists Agents (and no Files): ${JSON.stringify(cats)}`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
