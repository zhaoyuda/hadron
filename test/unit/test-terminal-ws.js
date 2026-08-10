/**
 * Terminal WebSocket pty lifecycle — the macOS ptmx-exhaustion incident class
 * (2026-08-10 report: 478/511 master fds leaked, whole machine unable to open
 * terminals). Guards:
 *   - normal close releases the pty master fd (kill + DESTROY — node-pty's
 *     kill() alone never frees the fd)
 *   - half-open connection (client stops responding) is terminated by the ws
 *     heartbeat and its pty reaped — pre-fix this leaked one pty per reconnect
 *   - /api/health exposes the live pty count
 *
 * fd accounting reads /proc/<serverpid>/fd (Linux-only; skips cleanly elsewhere).
 *
 * Run: node test/unit/test-terminal-ws.js
 * Requires: tmux on PATH.
 */
import { spawn as spawnProc, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "fs";
import { tmpdir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const PORT = 6100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const HEARTBEAT_MS = 500; // shrunk via env so the half-open case resolves in ~1.5s

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-ptytest-"));
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
let server, TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ptmxCount() {
  if (platform() !== "linux") return -1;
  try {
    const dir = `/proc/${server.pid}/fd`;
    return readdirSync(dir).filter((f) => {
      try { return readlinkSync(join(dir, f)) === "/dev/ptmx"; } catch { return false; }
    }).length;
  } catch { return -1; }
}

const health = async () => (await (await fetch(`${BASE}/api/health`)).json());

function connectTerminal(sessionId) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${sessionId}&token=${encodeURIComponent(TOKEN)}`);
    const timer = setTimeout(() => reject(new Error("no terminal output within 10s")), 10_000);
    ws.on("message", () => { clearTimeout(timer); resolveWs(ws); }); // first output = pty is live
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function waitFor(fn, want, ms = 8000) {
  for (let i = 0; i < ms / 200; i++) {
    if ((await fn()) === want) return true;
    await sleep(200);
  }
  return (await fn()) === want;
}

function killTmux() {
  try {
    const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter((n) => n.includes(`hadron-${WS_NAME}`));
    for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
  } catch {}
}

async function main() {
  server = spawnProc("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", HADRON_WS_HEARTBEAT_MS: String(HEARTBEAT_MS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/sessions`)).ok) break; } catch {}
    await sleep(200);
  }
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const baseline = ptmxCount();

  console.log("\n[health endpoint]");
  {
    const h = await health();
    ok(h.ok === true && h.livePtys === 0, `health reports 0 live ptys before any terminal (got ${h.livePtys})`);
  }

  console.log("\n[normal close releases the pty master fd]");
  {
    const ws = await connectTerminal("pty-a");
    ok((await health()).livePtys === 1, "connected terminal → livePtys 1");
    if (baseline >= 0) ok(ptmxCount() === baseline + 1, `one ptmx fd held while connected (${baseline}+1)`);
    ws.close();
    ok(await waitFor(async () => (await health()).livePtys, 0), "close → pty reaped (livePtys back to 0)");
    if (baseline >= 0) ok(await waitFor(() => ptmxCount(), baseline), "master fd released back to baseline");
  }

  console.log("\n[half-open connection: heartbeat terminates, pty reaped]");
  {
    const ws = await connectTerminal("pty-b");
    ok((await health()).livePtys === 1, "second terminal → livePtys 1");
    // Simulate the incident's half-open socket: stop reading, so the client
    // never sees the server's ping and never pongs. Pre-heartbeat the server
    // kept this connection (and its pty) forever while the UI reconnected.
    ws._socket.pause();
    ok(await waitFor(async () => (await health()).livePtys, 0, HEARTBEAT_MS * 10), "heartbeat reaped the half-open connection's pty");
    if (baseline >= 0) ok(await waitFor(() => ptmxCount(), baseline), "its master fd released too");
    try { ws.terminate(); } catch {}
  }

  console.log("\n[repeated connect/close cycles do not accumulate fds]");
  {
    for (let i = 0; i < 5; i++) {
      const ws = await connectTerminal("pty-a");
      ws.close();
      await waitFor(async () => (await health()).livePtys, 0);
    }
    ok((await health()).livePtys === 0, "5 cycles → livePtys 0");
    if (baseline >= 0) ok(ptmxCount() === baseline, `5 cycles → ptmx fds at baseline (${baseline})`);
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    if (server) try { server.kill("SIGKILL"); } catch {}
    killTmux();
    try { rmSync(WS, { recursive: true, force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  });
