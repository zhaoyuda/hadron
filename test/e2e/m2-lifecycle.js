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
  const wsUrls = [];   // every /ws the page opens — the size fix lives in the URL
  page.on("websocket", (w) => wsUrls.push(w.url()));
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

  // The pty is spawned at the size the client asks for (?cols=&rows=), so an
  // agent switch is one attach at the window's real size instead of 80x24 + a
  // resize (two full re-renders of a long Claude session). The server side is
  // unit-tested; this proves the client puts its fitted size on the wire.
  const primaryUrl = wsUrls.find((u) => u.includes("session=term-probe") && !u.includes("shell="));
  const fitted = await page.evaluate(() => ({ cols: term.cols, rows: term.rows }));
  const sz = primaryUrl && primaryUrl.match(/[?&]cols=(\d+)&rows=(\d+)/);
  r.ok(!!sz, `primary terminal WS URL carries cols/rows (${primaryUrl ? primaryUrl.replace(/token=[^&]*/, "token=…") : "no /ws opened"})`);
  r.ok(sz && Number(sz[1]) === fitted.cols && Number(sz[2]) === fitted.rows && fitted.cols > 80,
    `…equal to the fitted xterm size ${fitted.cols}x${fitted.rows}, not the 80x24 default`);

  // ── shell tab: its WS reconnects after a drop (server restart, network blip) ──
  // Before, a closed shell WS was left dead: stale screen, keystrokes swallowed
  // until a full reload (only the primary terminal had reconnect logic).
  await page.evaluate(() => createShellTab());
  const shellKey = await page.waitForFunction(() => {
    const k = [...shellInstances.keys()].find((k) => k.startsWith("term-probe:shell:"));
    const i = k && shellInstances.get(k);
    return i && i.ws && i.ws.readyState === WebSocket.OPEN ? k : null;
  }, { timeout: 10000 }).then((h) => h.jsonValue());
  await page.waitForFunction((k) => shellInstances.get(k).term.buffer.active.getLine(0)?.translateToString().trim().length > 0, shellKey, { timeout: 10000 });
  {
    const shellUrl = wsUrls.find((u) => u.includes("session=term-probe") && u.includes("shell=sh"));
    const f = await page.evaluate((k) => ({ cols: shellInstances.get(k).term.cols, rows: shellInstances.get(k).term.rows }), shellKey);
    const m = shellUrl && shellUrl.match(/[?&]cols=(\d+)&rows=(\d+)/);
    r.ok(m && Number(m[1]) === f.cols && Number(m[2]) === f.rows && f.cols > 80,
      `new shell tab's WS URL carries its fitted size ${f.cols}x${f.rows} (tab shown before connecting)`);
  }
  const firstWs = await page.evaluateHandle((k) => shellInstances.get(k).ws, shellKey);
  await page.evaluate((k) => shellInstances.get(k).ws.close(), shellKey);   // simulate the drop
  const reconnected = await page.waitForFunction((k) => {
    const i = shellInstances.get(k);
    return i && i.ws && i.ws.readyState === WebSocket.OPEN;
  }, shellKey, { timeout: 10000 }).then(() => true).catch(() => false);
  r.ok(reconnected, "shell tab WS reconnects within seconds of being closed");
  r.ok(await page.evaluate(([k, w]) => shellInstances.get(k).ws !== w, [shellKey, firstWs]), "…on a new WebSocket object");
  await page.evaluate((k) => shellInstances.get(k).term.focus(), shellKey);
  await page.keyboard.type("echo SHELL_RECONNECT_OK");
  await page.keyboard.press("Enter");
  const shellRoundTrip = await page.waitForFunction((k) => {
    const b = shellInstances.get(k).term.buffer.active;
    for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString().includes("SHELL_RECONNECT_OK")) return true;
    return false;
  }, shellKey, { timeout: 10000 }).then(() => true).catch(() => false);
  r.ok(shellRoundTrip, "keystrokes reach the shell pane again after the reconnect");
  // closing the tab must not resurrect the WS
  await page.evaluate((k) => closeShellTab(k.split(":").slice(1).join(":")), shellKey);
  await page.waitForTimeout(1500);
  r.ok(await page.evaluate((k) => !shellInstances.has(k), shellKey), "closed shell tab stays closed (no reconnect after closeShellTab)");

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
