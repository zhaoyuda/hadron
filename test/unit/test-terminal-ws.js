/**
 * Terminal WebSocket pty lifecycle — the macOS ptmx-exhaustion incident class
 * (2026-08-10 report: 478/511 master fds leaked, whole machine unable to open
 * terminals). Guards:
 *   - normal close releases the pty master fd (kill + DESTROY — node-pty's
 *     kill() alone never frees the fd)
 *   - half-open connection (client stops responding) is terminated by the ws
 *     heartbeat and its pty reaped — pre-fix this leaked one pty per reconnect
 *   - /api/health exposes the live pty count
 *   - the attached tmux client has UTF-8 on even when the server has no locale
 *     and is not inside tmux (macOS/launchd: every non-ASCII cell rendered "_")
 *
 * fd accounting asserts the OS-level truth (Linux: /proc/<pid>/fd; macOS: lsof;
 * skips cleanly elsewhere) — livePtys alone proved blind to the node-pty 1.1.0
 * native leak.
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
import { spawn as ptySpawn } from "node-pty";

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
// Private tmux server: the Hadron under test gets HADRON_TMUX_SOCKET and every
// tmux call this file makes passes the same -S, so neither the operator's default
// server (where prod agents live) nor an inherited $TMUX can be what we inspect.
const SOCK = join(WS, "tmux.sock");
const tmuxQ = (args) => execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL" });
let server, TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ptmxCount(pid) {
  // OS-level truth, not the server's own Set: the second leak (node-pty 1.1.0
  // pty_posix_spawn off-by-one, macOS-only) was invisible to livePtys — the
  // bookkeeping was right while the fds piled up. -1 = unsupported platform.
  if (platform() === "linux") {
    try {
      const dir = `/proc/${pid}/fd`;
      return readdirSync(dir).filter((f) => {
        try { return readlinkSync(join(dir, f)) === "/dev/ptmx"; } catch { return false; }
      }).length;
    } catch { return -1; }
  }
  if (platform() === "darwin") {
    try {
      const out = execFileSync("lsof", ["-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      // Match the NAME column (row-final), not the whole row — a cwd or command
      // containing "ptmx" must not count as a descriptor. Field reports disagree
      // on whether macOS lists a pty master as /dev/ptmx or /dev/ttysNNN; accept
      // both and let validateProbe() decide whether the count is trustworthy.
      return out.split("\n").filter((l) => /\/dev\/(ptmx|ttys\d+)$/.test(l.trimEnd())).length;
    } catch { return -1; }
  }
  return -1;
}

// The probe must prove it can see a pty before any fd assertion trusts it: open
// one pty in THIS process, expect exactly +1, close it, expect the baseline
// back. Anything else → every fd assertion is an honest skip, never `0 === 0`.
async function validateProbe() {
  const before = ptmxCount(process.pid);
  if (before < 0) return { ok: false, why: `unsupported platform ${platform()}` };
  let p;
  try { p = ptySpawn("sleep", ["30"], { name: "xterm", cols: 20, rows: 5, cwd: tmpdir(), env: process.env }); }
  catch (e) { return { ok: false, why: `node-pty spawn failed: ${e.message}` }; }
  const during = ptmxCount(process.pid);
  try { p.kill(); } catch {}
  try { p.destroy?.(); } catch {}
  const back = await waitFor(() => ptmxCount(process.pid), before, 3000);
  if (during !== before + 1) return { ok: false, why: `one pty opened → count went ${before} → ${during}, expected +1` };
  if (!back) return { ok: false, why: `pty closed → count did not return to ${before}` };
  return { ok: true };
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
    const names = tmuxQ(["ls", "-F", "#{session_name}"]).trim().split("\n").filter(Boolean);
    for (const n of names) try { tmuxQ(["kill-session", "-t", n]); } catch {}
  } catch {}
}

async function main() {
  // Run the server the way launchd starts it on macOS — not inside tmux and with
  // no UTF-8 locale (LC_ALL=C beats any LANG a parent might set) — the environment
  // in which the "_" rendering bug was found. Without -u on the attach, tmux has
  // nothing left to take CLIENT_UTF8 from.
  const serverEnv = { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", HADRON_WS_HEARTBEAT_MS: String(HEARTBEAT_MS), HADRON_TMUX_SOCKET: SOCK, LC_ALL: "C" };
  for (const k of ["TMUX", "TMUX_PANE", "LC_CTYPE", "LANG"]) delete serverEnv[k];
  server = spawnProc("node", [join(REPO, "server", "index.js"), WS], {
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/sessions`)).ok) break; } catch {}
    await sleep(200);
  }
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const probe = await validateProbe();
  const fdOk = (cond, msg) => probe.ok ? ok(cond, msg) : console.log(`  - skip (fd probe unavailable on ${platform()}: ${probe.why}): ${msg}`);
  console.log(probe.ok ? "  ✓ fd probe self-validated (+1/-1 for one pty in this process)" : `  - fd probe unavailable on ${platform()}: ${probe.why} — fd assertions will skip`);
  const baseline = probe.ok ? ptmxCount(server.pid) : -1;

  console.log("\n[health endpoint]");
  {
    const h = await health();
    ok(h.ok === true && h.livePtys === 0, `health reports 0 live ptys before any terminal (got ${h.livePtys})`);
  }

  console.log("\n[attached client renders UTF-8 with LC_ALL=C and no $TMUX in the server env]");
  {
    const ws = await connectTerminal("pty-a");
    ok((await health()).livePtys === 1, "connected terminal → livePtys 1");
    const utf8 = await waitFor(() => {
      try { return tmuxQ(["list-clients", "-t", `hadron-${WS_NAME}-pty-a`, "-F", "#{client_utf8}"]).trim(); }
      catch { return ""; }
    }, "1", 4000);
    ok(utf8, "tmux reports client_utf8=1 for the web terminal's client (attach passes -u)");
    ws.close();
    ok(await waitFor(async () => (await health()).livePtys, 0), "close → pty reaped");
  }

  console.log("\n[a wedged tmux server does not stall the event loop]");
  {
    // The agent monitor polls tmux on a timer. Pre-fix those were synchronous
    // spawns on the main thread, so a tmux server that stops answering (here:
    // SIGSTOP on the PRIVATE socket's server — never the developer's) blocked
    // every HTTP request for the length of each poll's timeout, back to back,
    // and a client that never returned wedged the server for good (macOS,
    // 2026-09-17). Now the polls are async and bounded: health must keep
    // answering promptly the whole time, and the in-flight guard must stop
    // spawns from piling up behind the stuck one.
    const ws = await connectTerminal("pty-a");            // keeps a monitor polling
    const tmuxPid = Number(tmuxQ(["display-message", "-p", "#{pid}"]).trim());
    ok(Number.isInteger(tmuxPid) && tmuxPid > 0, `private tmux server pid resolved (${tmuxPid})`);
    const before = await health();
    // If the test is killed mid-window, resume the private server so cleanup
    // (killTmux) doesn't hang against a stopped tmux.
    const resume = () => { try { process.kill(tmuxPid, "SIGCONT"); } catch {} };
    process.once("SIGINT", () => { resume(); process.exit(130); });
    process.once("SIGTERM", () => { resume(); process.exit(143); });
    process.kill(tmuxPid, "SIGSTOP");
    let worst = 0, failures = 0, spawnsPeak = 0;
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 4500) {
        const s0 = Date.now();
        try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) }); }
        catch { failures++; }
        worst = Math.max(worst, Date.now() - s0);
        try {
          // tmux retitles its client process to "tmux: client", so match on the
          // command name, not an exact "tmux"
          const kids = execFileSync("pgrep", ["-P", String(server.pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
          const names = kids.length ? execFileSync("ps", ["-o", "comm=", "-p", kids.join(",")], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }) : "";
          spawnsPeak = Math.max(spawnsPeak, names.split("\n").filter((n) => /(^|\/)tmux/.test(n.trim())).length); // macOS ps prints a path
        } catch {}
        await sleep(250);
      }
    } finally {
      process.kill(tmuxPid, "SIGCONT");
    }
    ok(failures === 0 && worst < 1000, `health kept answering while tmux was stopped for 4.5s (worst ${worst}ms, ${failures} failures)`);
    // one poll in flight per monitor (≤ 1 tmux child per live session) plus the
    // terminal's own attach client — never a growing pile
    // Positive control: the attached terminal client is a guaranteed tmux child,
    // so a peak of 0 means the process probe is blind, not that nothing spawned.
    ok(spawnsPeak >= 1, `process probe sees the attach client (peak ${spawnsPeak}) — not a vacuous count`);
    ok(spawnsPeak <= before.liveSessions + 1, `tmux spawns did not pile up behind the stuck one (peak ${spawnsPeak} children for ${before.liveSessions} sessions + 1 attach)`);
    ok((await health()).ok === true, "server healthy after tmux resumed");
    ws.close();
    ok(await waitFor(async () => (await health()).livePtys, 0), "close → pty reaped");
  }

  console.log("\n[normal close releases the pty master fd]");
  {
    const ws = await connectTerminal("pty-a");
    ok((await health()).livePtys === 1, "connected terminal → livePtys 1");
    fdOk(ptmxCount(server.pid) === baseline + 1, `one ptmx fd held while connected (${baseline}+1)`);
    ws.close();
    ok(await waitFor(async () => (await health()).livePtys, 0), "close → pty reaped (livePtys back to 0)");
    fdOk(await waitFor(() => ptmxCount(server.pid), baseline), "master fd released back to baseline");
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
    fdOk(await waitFor(() => ptmxCount(server.pid), baseline), "its master fd released too");
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
    fdOk(ptmxCount(server.pid) === baseline, `5 cycles → ptmx fds at baseline (${baseline})`);
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
