/**
 * Module M11 — Clickable terminal paths → open as the current agent's artifact.
 *
 * When an agent prints a file path in its pane, the user can click it and the
 * file opens as an artifact tab ON THE CURRENT AGENT (no session/agent switch) —
 * closing the "agent produced X → inspect X now" loop. client/terminal.js
 * registers an xterm link provider that matches path-ish tokens and asks the
 * server (`GET /api/resolve-path?session=&path=`) whether each resolves to a real
 * file *relative to the pane's cwd* before lighting it up; clicking opens it via
 * the existing artifact machinery (de-dupe → switchTab, else addArtifact).
 *
 * Technique: browser (Playwright) — drives the real chain. A known file is
 * written into the agent's cwd, its relative path is printed into the pane (pane
 * → tmux → pty → ws → xterm.js). We then assert: (1) the printed path renders in
 * the buffer, (2) /api/resolve-path resolves the RELATIVE token against the
 * pane's cwd to the canonical absolute file, (3) a non-existent path is NOT lit
 * (404), (4) invoking the click handler opens an artifact tab on the current
 * agent showing the file's contents.
 *
 * Run: node test/e2e/m11-terminal-paths.js
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter } from "./harness.js";

const r = reporter("M11 Clickable terminal paths");
const env = await bootWorkspace({ name: "m11" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}

try {
  // A shell agent whose cwd is the workspace root. Write a known file there so a
  // RELATIVE path printed by the pane has to resolve against the pane cwd.
  const create = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name: "m11", launchCommand: "shell" }),
  });
  const { id } = await create.json();

  const REL = "m11-report.md";
  const ABS = join(env.ws, REL);
  const CONTENT = "# m11 report\n\nclickable-path-marker\n";
  writeFileSync(ABS, CONTENT, "utf-8");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="${id}"]`).click();
  await page.locator("#terminal-container.active .xterm").waitFor({ state: "visible", timeout: 10000 });
  await wait(1200);

  // Print the relative path into the pane (real pane → tmux → pty → ws → xterm.js).
  await page.evaluate((rel) => {
    ws.send(JSON.stringify({ type: "input", data: `printf '%s\\n' '${rel}'\r` }));
  }, REL);

  // (1) The path actually rendered into the terminal buffer.
  const printed = await until(async () =>
    await page.evaluate((rel) => {
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes(rel)) return true;
      }
      return false;
    }, REL)
  );
  r.ok(printed, "printed relative path renders in the terminal buffer");

  // (2) The relative token resolves against the PANE cwd to the canonical file.
  const resolved = await page.evaluate(async (rel) =>
    await resolveTerminalPath(activeSessionId, rel), REL);
  r.ok(resolved === ABS, `relative token resolves against pane cwd → ${ABS} (got ${resolved})`);

  // (3) A path that does not exist is NOT lit up (resolve returns null → no link).
  const bogus = await page.evaluate(async () =>
    await resolveTerminalPath(activeSessionId, "does/not/exist-zzz.md"));
  r.ok(bogus === null, "non-existent path does not resolve (link stays dark)");

  // (3b) looksLikePath gates obvious non-paths so we don't even ask the server.
  const gating = await page.evaluate(() => ({
    plainWord: looksLikePath("hello"),
    version: looksLikePath("v1.2.3"),
    url: looksLikePath("https://example.com/a.md"),
    relFile: looksLikePath("src/app.py"),
    dotSlash: looksLikePath("./notes.md"),
  }));
  r.ok(!gating.plainWord && !gating.url && gating.relFile && gating.dotSlash,
    "matcher gates prose/URLs but accepts dir/relative file paths");

  // (4) Invoke the click handler (what activate() calls) → artifact tab opens on
  // the CURRENT agent, the active session is unchanged, and the file renders.
  const beforeSession = await page.evaluate(() => activeSessionId);
  await page.evaluate(async (abs) => { await openPathAsArtifact(abs); }, ABS);
  await wait(500);

  const afterSession = await page.evaluate(() => activeSessionId);
  r.ok(afterSession === beforeSession && afterSession === id, "no agent switch — opened on the current agent");

  const opened = await until(async () =>
    await page.evaluate((abs) => {
      const s = sessions.find((x) => x.id === activeSessionId);
      return !!(s && (s.artifacts || []).some((a) => a.value === abs));
    }, ABS)
  );
  r.ok(opened, "file is now an artifact tab on the current agent");

  const rendered = await until(async () =>
    await page.evaluate(() => {
      const c = document.getElementById("artifact-container");
      return !!(c && c.textContent && c.textContent.includes("clickable-path-marker"));
    }, 6000)
  );
  r.ok(rendered, "the opened artifact renders the file's contents");

  // De-dupe: opening the same path again must not append a second artifact.
  const countBefore = await page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return (s.artifacts || []).filter((a) => a.value).length;
  });
  await page.evaluate(async (abs) => { await openPathAsArtifact(abs); }, ABS);
  await wait(300);
  const countAfter = await page.evaluate(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    return (s.artifacts || []).filter((a) => a.value).length;
  });
  r.ok(countAfter === countBefore, "re-opening the same path de-dupes (focuses the existing tab)");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
