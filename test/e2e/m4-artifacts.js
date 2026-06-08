/**
 * Module M4 — Artifact editor tmux lifecycle.
 *
 * Opening an artifact in the in-browser vim editor spins up a throwaway tmux
 * session (`<prefix>-<agent>-vim-<ts>`). Closing the editor cleanly kills it,
 * but a browser reload / tab-close / crash drops the WS without the cleanup
 * call. This module proves the server-side guard: a vim-* shell whose WS closes
 * gets its tmux session reaped, while a persistent shell (`shN`) is preserved
 * across a WS drop so it survives a reload.
 *
 * Technique: script-level WS lifecycle — the truth is server behavior on WS
 * close, so we drive the WS directly rather than through a flaky browser reload.
 *
 * Run: node test/e2e/m4-artifacts.js
 */
import { WebSocket } from "ws";
import { execFileSync } from "child_process";
import { bootWorkspace, reporter } from "./harness.js";

const r = reporter("M4 Artifact editor lifecycle");
const env = await bootWorkspace({ name: "m4" });
const prefix = `hadron-${env.wsName}`;

function tmuxHas(name) {
  try {
    const out = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").includes(name);
  } catch { return false; }
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (fn()) return true; await wait(100); }
  return fn();
}

function openShell(shellName) {
  const port = env.baseUrl.split(":").pop();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=hadron&shell=${encodeURIComponent(shellName)}&token=${encodeURIComponent(env.token)}`);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

try {
  // ── vim editor shell: reaped on WS close (the leak guard) ──
  const vimName = `vim-${Date.now()}`;
  const vimSession = `${prefix}-hadron-${vimName}`;
  const vimWs = await openShell(vimName);
  r.ok(await until(() => tmuxHas(vimSession)), "opening an editor creates its vim tmux session");
  await new Promise((res) => { vimWs.on("close", res); vimWs.close(); });
  r.ok(await until(() => !tmuxHas(vimSession)), "closing the editor WS reaps the vim tmux session (no orphan on reload)");

  // ── persistent shell: preserved across a WS drop (don't over-kill) ──
  const shName = "sh9";
  const shSession = `${prefix}-hadron-${shName}`;
  const shWs = await openShell(shName);
  r.ok(await until(() => tmuxHas(shSession)), "opening a persistent shell creates its tmux session");
  await new Promise((res) => { shWs.on("close", res); shWs.close(); });
  await wait(500);
  r.ok(tmuxHas(shSession), "persistent shell tmux session survives a WS drop (reload-safe)");
  try { execFileSync("tmux", ["kill-session", "-t", shSession]); } catch {}
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
