/**
 * Module M10 — Terminal clipboard (OSC 52) bridge.
 *
 * A program in the pane (Claude Code's `/copy`, vim's "+y, etc.) sets the
 * system clipboard by emitting `ESC ] 52 ; c ; <base64> BEL`. tmux forwards it
 * out to the attached terminal (its default terminal-features include
 * `xterm*:clipboard`), but xterm.js has NO built-in OSC 52 handler — so the
 * sequence reached the browser and was silently dropped: `/copy` under Hadron
 * "did nothing". client/terminal.js now registers a handler that decodes the
 * payload and writes the browser clipboard (via copyTextToClipboard, so
 * plain-http Tailscale gets the execCommand fallback).
 *
 * Technique: browser (Playwright) — drives the FULL real chain (pane process →
 * tmux → pty → WebSocket → xterm.js → navigator.clipboard). The harness binds
 * 127.0.0.1, which Chromium treats as a secure context, so navigator.clipboard
 * works once the context is granted clipboard permission.
 *
 * Run: node test/e2e/m10-clipboard.js
 */
import { chromium } from "playwright";
import { bootWorkspace, authHeaders, reporter } from "./harness.js";

const r = reporter("M10 Terminal clipboard (OSC 52)");
const env = await bootWorkspace({ name: "m10" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}

try {
  const create = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name: "m10", launchCommand: "shell" }),
  });
  const { id } = await create.json();

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="${id}"]`).click();
  // Terminal connects + shell prints its prompt.
  await page.locator("#terminal-container.active .xterm").waitFor({ state: "visible", timeout: 10000 });
  await wait(1200);

  // Drive a real OSC 52 from inside the pane: printf the escape sequence with a
  // known base64 payload, submit it. Goes pane → tmux → pty → ws → xterm.js.
  const PAYLOAD = "hello-hadron-clip";
  const b64 = Buffer.from(PAYLOAD).toString("base64");
  const cmd = `printf '\\033]52;c;${b64}\\007'\r`;
  await page.evaluate((data) => {
    ws.send(JSON.stringify({ type: "input", data }));
  }, cmd);

  const got = await until(async () => {
    const t = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
    return t === PAYLOAD;
  });
  r.ok(got, "OSC 52 from the pane lands in the browser clipboard (xterm.js handler bridges it)");

  // A read request (52;c;?) must NOT leak the clipboard back to the pane.
  await page.evaluate(() => navigator.clipboard.writeText("SECRET-do-not-leak"));
  await page.evaluate(() => ws.send(JSON.stringify({ type: "input", data: "printf '\\033]52;c;?\\007'\r" })));
  await wait(1500);
  const stillSecret = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  r.ok(stillSecret === "SECRET-do-not-leak", "OSC 52 read request is ignored (clipboard not exposed to the pane)");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
