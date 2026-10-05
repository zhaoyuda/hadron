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
import "./hadron-home.js"; // private HADRON_HOME before any server spawns
import { spawn as spawnProc, execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "fs";
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
  // HADRON_TEST_THROW_UNCAUGHT: the server throws one uncaught exception and
  // one unhandled rejection shortly after boot — the process guard section
  // below proves it survived both (prod 2026-10-05: one uncaught tmux timeout
  // took the whole server down, twice).
  const serverEnv = { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", HADRON_WS_HEARTBEAT_MS: String(HEARTBEAT_MS), HADRON_TMUX_SOCKET: SOCK, LC_ALL: "C", HADRON_TEST_THROW_UNCAUGHT: "1" };
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
  // A terminal WS no longer mints an agent for an unknown id (that resurrected
  // archived agents) — every id this suite attaches to is created first.
  for (const id of ["pty-a", "pty-b", "pty-sz"]) {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", "x-hadron-token": TOKEN }, body: JSON.stringify({ name: id, launchCommand: "shell" }) });
    if (r.status !== 201) throw new Error(`create ${id} → ${r.status}`);
  }
  const probe = await validateProbe();
  const fdOk = (cond, msg) => probe.ok ? ok(cond, msg) : console.log(`  - skip (fd probe unavailable on ${platform()}: ${probe.why}): ${msg}`);
  console.log(probe.ok ? "  ✓ fd probe self-validated (+1/-1 for one pty in this process)" : `  - fd probe unavailable on ${platform()}: ${probe.why} — fd assertions will skip`);
  const baseline = probe.ok ? ptmxCount(server.pid) : -1;
  // Seeing a pty in THIS process is not proof of seeing one in the SERVER
  // process (a macOS field report: lsof -p <server> listed no pty at all while
  // livePtys was 1, so every fd assertion compared 0 === 0). Validate the
  // measurement where it is taken: the count must rise on the first connect.
  if (probe.ok) {
    const ws = await connectTerminal("pty-a");
    await waitFor(async () => (await health()).livePtys, 1);
    const seen = await waitFor(() => ptmxCount(server.pid), baseline + 1, 3000);
    ws.close();
    await waitFor(async () => (await health()).livePtys, 0);
    await waitFor(() => ptmxCount(server.pid), baseline, 3000);
    if (seen) console.log(`  ✓ fd probe sees the server's pty (${baseline} → ${baseline + 1} on connect)`);
    else {
      probe.ok = false;
      probe.why = `server pid ${server.pid} showed ${ptmxCount(server.pid)} pty fds with a terminal connected (livePtys 1) — the probe is blind to this process`;
      console.log(`  - fd probe unavailable on ${platform()}: ${probe.why} — fd assertions will skip`);
    }
  }

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

  console.log("\n[a tmux that does not answer refuses the terminal with 4503 — the server stays up]");
  {
    // The 2026-10-05 prod crash: a shell tab's connect ran has-session →
    // new-session SYNCHRONOUSLY against a tmux server that was paging (5.6 GB
    // RSS + swap); has-session timed out, new-session timed out, the second
    // throw was uncaught and the server exited — every terminal gone, twice in
    // 18 s. Now the connect is async, a has-session TIMEOUT is never followed by
    // new-session (one timeout, not two), the socket is closed with 4503 "tmux
    // busy" after a visible message, health keeps answering meanwhile, and the
    // same tab attaches as soon as tmux answers again.
    const attach = (q) => new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${q}&token=${encodeURIComponent(TOKEN)}`);
      const out = [];
      const t = setTimeout(() => { try { ws.close(); } catch {} res({ code: "timeout", out }); }, 15000);
      ws.on("message", (m) => out.push(String(m)));
      ws.on("close", (code, reason) => { clearTimeout(t); res({ code, reason: String(reason), out }); });
      ws.on("error", () => {});
    });
    const tmuxPid = Number(tmuxQ(["display-message", "-p", "#{pid}"]).trim());
    const resume = () => { try { process.kill(tmuxPid, "SIGCONT"); } catch {} };
    process.once("SIGINT", () => { resume(); process.exit(130); });
    process.once("SIGTERM", () => { resume(); process.exit(143); });
    const h0 = await health();
    process.kill(tmuxPid, "SIGSTOP");
    let r, rb, created, elapsed = 0, elapsedB = 0, elapsedC = 0, worst = 0, failures = 0, stalledTmux = null, stalledLog = "";
    try {
      const t0 = Date.now();
      const refused = attach("pty-a&shell=sh7").then((x) => { elapsed = Date.now() - t0; return x; });
      // the agent's OWN terminal (not a shell tab) gets the same answer
      const refusedB = attach("pty-b").then((x) => { elapsedB = Date.now() - t0; return x; });
      // and creating an agent while tmux is stalled saves the record and answers,
      // without a monitor and without a tmux session (those come on the first connect)
      const creating = fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", "x-hadron-token": TOKEN }, body: JSON.stringify({ name: "pty-stall", launchCommand: "shell", autostart: true }), signal: AbortSignal.timeout(14000) })
        .then(async (x) => { elapsedC = Date.now() - t0; return { status: x.status, body: await x.json() }; }, (e) => ({ status: "error", body: String(e) }));
      // health must keep answering promptly while the connect waits on tmux
      while ((elapsed === 0 || elapsedB === 0 || elapsedC === 0) && Date.now() - t0 < 12000) {
        const s0 = Date.now();
        try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) }); } catch { failures++; }
        worst = Math.max(worst, Date.now() - s0);
        await sleep(250);
      }
      r = await refused;
      rb = await refusedB;
      created = await creating;
      // observed while tmux is STILL stopped: tmuxQ itself would hang, so ask the
      // socket's session list through a bounded call and read the log instead
      try { execFileSync("tmux", ["-S", SOCK, "has-session", "-t", `=hadron-${WS_NAME}-pty-stall`], { stdio: "ignore", timeout: 1500, killSignal: "SIGKILL" }); stalledTmux = true; } catch (e) { stalledTmux = e.signal === "SIGKILL" || e.code === "ETIMEDOUT" ? null : false; }
      stalledLog = readFileSync(join(WS, ".hadron", "server.log"), "utf-8");
    } finally {
      resume();
    }
    ok(r.code === 4503 && r.reason === "tmux busy", `new shell tab while tmux is stopped → closed with 4503 "tmux busy" (got ${r.code} ${JSON.stringify(r.reason)})`);
    ok(r.out.some((m) => m.includes("tmux is busy")), "…after a visible \"tmux is busy\" line in the terminal");
    ok(elapsed >= 4000 && elapsed < 8500, `…refused after ONE timeout, not has-session + new-session (${elapsed} ms)`);
    ok(rb.code === 4503 && rb.reason === "tmux busy" && elapsedB >= 4000 && elapsedB < 8500, `the agent's own terminal is refused the same way (got ${rb.code} ${JSON.stringify(rb.reason)} after ${elapsedB} ms)`);
    ok(created.status === 201 && created.body && created.body.id === "pty-stall" && elapsedC < 8500, `POST /api/sessions while tmux is stalled → 201 with the record (got ${created.status} after ${elapsedC} ms)`);
    ok(stalledTmux === null && !stalledLog.includes("Monitor started for session: pty-stall") && stalledLog.includes("[monitor] pty-stall: tmux did not answer"),
      "…no monitor for it while tmux is stalled, logged as such (the tmux call itself still hung — proof the server did not wait for tmux)");
    ok(stalledLog.includes("[autostart] pty-stall: skipped"), "…and autostart was skipped with a log line, not launched into nothing");
    ok(failures === 0 && worst < 1000, `health kept answering while the connects waited on tmux (worst ${worst} ms, ${failures} failures)`);
    ok(server.exitCode === null && server.signalCode === null, "server process is still running");
    const h1 = await health();
    ok(h1.ok === true && h1.pid === h0.pid, "same server pid answers after tmux resumed (no restart)");
    ok(h1.tmux && h1.tmux.timeouts >= h0.tmux.timeouts + 3 && h1.tmux.busyRefusals >= h0.tmux.busyRefusals + 2 && typeof h1.tmux.lastTimeoutCmd === "string",
      `health.tmux counts the timeouts and the refusals (timeouts ${h0.tmux.timeouts} → ${h1.tmux && h1.tmux.timeouts}, busyRefusals ${h0.tmux.busyRefusals} → ${h1.tmux && h1.tmux.busyRefusals}, last ${h1.tmux && h1.tmux.lastTimeoutCmd})`);
    ok(h1.tmux.slowCalls >= 1 && h1.tmux.maxMs >= 4000, `…and the slow-call stats saw it (slowCalls ${h1.tmux.slowCalls}, max ${h1.tmux.maxMs} ms)`);
    let shellTmux = false; try { tmuxQ(["has-session", "-t", `=hadron-${WS_NAME}-pty-a-sh7`]); shellTmux = true; } catch {}
    ok(!shellTmux, "…no shell tmux session was created by the refused connect");
    let stallTmux = false; try { tmuxQ(["has-session", "-t", `=hadron-${WS_NAME}-pty-stall`]); stallTmux = true; } catch {}
    ok(!stallTmux && (await (await fetch(`${BASE}/api/sessions`)).json()).some((x) => x.id === "pty-stall"), "the agent created during the stall is listed, with no tmux session yet");
    {
      const w = await connectTerminal("pty-stall");
      ok(await waitFor(async () => (await health()).livePtys, 1), "its first terminal connect after tmux resumed attaches (livePtys 1)");
      stallTmux = false; try { tmuxQ(["has-session", "-t", `=hadron-${WS_NAME}-pty-stall`]); stallTmux = true; } catch {}
      ok(stallTmux && readFileSync(join(WS, ".hadron", "server.log"), "utf-8").includes("Monitor started for session: pty-stall"), "…creating its tmux session and starting its monitor");
      w.close();
      ok(await waitFor(async () => (await health()).livePtys, 0), "close → pty reaped");
      const del = await fetch(`${BASE}/api/sessions/pty-stall`, { method: "DELETE", headers: { "x-hadron-token": TOKEN } });
      ok(del.ok, "pty-stall archived again (cleanup)");
    }
    // tmux answers again → the same tab attaches (this is what the client's backoff retry does)
    const ws = await new Promise((resolveWs, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=pty-a&shell=sh7&token=${encodeURIComponent(TOKEN)}`);
      const timer = setTimeout(() => reject(new Error("no terminal output within 10s after tmux resumed")), 10_000);
      w.on("message", () => { clearTimeout(timer); resolveWs(w); });
      w.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    ok(await waitFor(async () => (await health()).livePtys, 1), "the retried connect attaches once tmux answers (livePtys 1)");
    shellTmux = false; try { tmuxQ(["has-session", "-t", `=hadron-${WS_NAME}-pty-a-sh7`]); shellTmux = true; } catch {}
    ok(shellTmux, "…and the shell tmux session now exists");
    ws.close();
    ok(await waitFor(async () => (await health()).livePtys, 0), "close → pty reaped");
  }

  console.log("\n[process guard: an uncaught error is logged and counted, never fatal]");
  {
    const h = await health();
    ok(h.guard && h.guard.uncaught === 1 && h.guard.unhandledRejections === 1,
      `health.guard counts the test's uncaught exception + unhandled rejection (got ${JSON.stringify(h.guard)})`);
    ok(h.ok === true && server.exitCode === null, "…and the server is still serving");
    ok(!("lastError" in h.guard) && Object.keys(h.guard).sort().join() === "lastAt,uncaught,unhandledRejections", `the open GET carries counts + lastAt only, never the error text (got ${Object.keys(h.guard).join()})`);
    const d = await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json();
    ok(d.guard && d.guard.uncaught === 1 && d.tmux && d.tmux.timeouts >= 1, "doctor payload carries guard + tmux stats");
    ok(typeof d.guard.lastError === "string" && d.guard.lastError.includes("HADRON_TEST_THROW_UNCAUGHT") && d.guard.lastError.length <= 200, "doctor's guard.lastError names the error (clipped) — token-gated");
    let out = "";
    try { out = execFileSync("node", [join(REPO, "bin", "hadron.js"), "doctor"], { encoding: "utf-8", env: { ...process.env, HADRON_PORT: String(PORT), HADRON_TOKEN: TOKEN, TMUX: "" } }); }
    catch (e) { out = String(e.stdout || ""); } // exits 1: hand-started server is a red row
    ok(out.includes("server survived 1 uncaught exception + 1 unhandled rejection"), "`hadron doctor` has a yellow row for the absorbed errors");
    const log = readFileSync(join(WS, ".hadron", "server.log"), "utf-8");
    ok(/tmux: \d+ calls? timed out/.test(out) && out.includes("terminal connect") && out.includes("the row stays until the next restart"), "`hadron doctor` has a yellow row for the tmux timeout + busy refusal (and says the guard row stays until a restart)");
    // tmux error text never carries argv (set-environment … HADRON_TOKEN <token> would reach the log otherwise)
    ok(!log.includes(TOKEN) && !/Command failed: tmux/.test(log), "server.log has no tmux argv and no token in any tmux error");
    ok(log.includes("[guard] uncaught exception (server kept running): Error: HADRON_TEST_THROW_UNCAUGHT") && log.includes("[guard] unhandled rejection (server kept running)"), "server.log has both guard lines with the stack");
    // The slow-call line is rate-limited (one per 10 s): the monitor's own
    // timed-out polls during the stop may own the slot, so assert the line
    // exists for A timed-out call, not for has-session specifically.
    ok(/\[tmux\] slow call: [a-z-]+ took \d+ ms \(timed out, client killed\)/.test(log), "server.log has a slow-call line for a timed-out tmux call");
    ok(log.includes("terminal refused with 4503, client will retry"), "server.log names the refused terminal connect");
  }

  console.log("\n[normal close releases the pty master fd]");
  {
    const ws = await connectTerminal("pty-a");
    ok((await health()).livePtys === 1, "connected terminal → livePtys 1");
    // Poll, don't sample: on macOS `lsof` can lag the spawn by a beat, and a
    // one-shot read here flaked (fail/pass/fail on a stock checkout, node 24,
    // Darwin 25) while every leak-catching assertion below passed every time.
    fdOk(await waitFor(() => ptmxCount(server.pid), baseline + 1, 3000), `one ptmx fd held while connected (${baseline}+1)`);
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

  console.log("\n[pty starts at the size the client asks for]");
  {
    // window-size smallest (fitWindowToClients): the window follows its only
    // client, so the window size right after attach IS the pty's initial size
    // (minus the one status line: rows 41 → window height 40).
    const size = () => { try { return tmuxQ(["display-message", "-p", "-t", `=hadron-${WS_NAME}-pty-sz:`, "#{window_width}x#{window_height}"]).trim(); } catch { return "?"; } };
    const open = (q) => new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=pty-sz${q}&token=${encodeURIComponent(TOKEN)}`);
      const t = setTimeout(() => { try { ws.close(); } catch {} rej(new Error("no output")); }, 10_000);
      ws.on("message", () => { clearTimeout(t); res(ws); }); ws.on("error", rej);
    });
    // A window keeps its size after its client detaches, so consecutive cases
    // must expect different sizes — a fallback case right after another fallback
    // case would pass against the leftover window.
    const cases = [["&cols=123&rows=41", "123x40", "cols=123&rows=41 → window is 123x40 (41 minus status line) with no resize message"],
                   ["&cols=12abc&rows=41", "80x23", "malformed cols → 80x24 pty"],
                   ["&cols=12000&rows=41", "1000x40", "over-range (5-digit) cols → clamped to 1000, not the 80x24 fallback"],
                   ["", "80x23", "no size → 80x24 pty"],
                   ["&cols=100&rows=3", "100x4", "under-range rows → clamped up to 5"]];
    for (const [q, want, msg] of cases) {
      let ws;
      try { ws = await open(q); } catch (e) { ok(false, `${msg} — no output within 10 s`); continue; }
      ok(await waitFor(size, want), `${msg} (got ${size()})`);
      ws.close(); await waitFor(async () => (await health()).livePtys, 0);
    }
  }

  console.log("\n[an unknown or archived id is refused — never minted]");
  {
    // Before: wss "connection" created + saved an agent for ANY session id. A
    // dashboard still open on an agent archived by `hadron close` reconnected
    // after a restart and brought it back with a blanked record.
    const agentFile = (id) => join(WS, ".hadron", "agents", `${id}.json`);
    const live = async () => (await (await fetch(`${BASE}/api/sessions`)).json()).map((s) => s.id);
    const attach = (q) => new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${q}&token=${encodeURIComponent(TOKEN)}`);
      const out = [];
      const t = setTimeout(() => { try { ws.close(); } catch {} res({ code: "timeout", out }); }, 8000);
      ws.on("message", (m) => out.push(String(m)));
      ws.on("close", (code, reason) => { clearTimeout(t); res({ code, reason: String(reason), out }); });
      ws.on("error", () => {});
    });

    const r1 = await attach("never-made");
    ok(r1.code === 4404 && r1.reason === "unknown", `unknown id → closed with 4404 "unknown" (got ${r1.code} ${JSON.stringify(r1.reason)})`);
    ok(r1.out.some((m) => m.includes("not on this server")), "…after a visible message in the terminal");
    ok(!existsSync(agentFile("never-made")), "…and no agent JSON was written for it");
    ok(!(await live()).includes("never-made"), "…and it is not in GET /api/sessions");

    const before = JSON.parse(readFileSync(agentFile("pty-b"), "utf-8"));
    const del = await fetch(`${BASE}/api/sessions/pty-b`, { method: "DELETE", headers: { "x-hadron-token": TOKEN } });
    ok(del.status === 200, "archive pty-b (soft DELETE) → 200");
    const r2 = await attach("pty-b");
    ok(r2.code === 4404 && r2.reason === "archived", `archived id → closed with 4404 "archived" (got ${r2.code} ${JSON.stringify(r2.reason)})`);
    const r3 = await attach("pty-b&shell=sh1");
    ok(r3.code === 4404 && r3.reason === "archived", "…the shell-tab path is refused the same way");
    let shellTmux = false; try { tmuxQ(["has-session", "-t", `=hadron-${WS_NAME}-pty-b-sh1`]); shellTmux = true; } catch {}
    ok(!shellTmux, "…and no shell tmux session was created for the archived agent");
    const after = JSON.parse(readFileSync(agentFile("pty-b"), "utf-8"));
    ok(after.archived === true && after.name === before.name && after.group === before.group,
      `archived record intact after the refused connects (name ${JSON.stringify(after.name)}, archived:${after.archived})`);
    ok(!(await live()).includes("pty-b"), "…archived agent still absent from GET /api/sessions");
    ok(await waitFor(async () => (await health()).livePtys, 0), "…no pty was spawned for any refused connect");

    const rs = await fetch(`${BASE}/api/sessions/pty-b/restore`, { method: "POST", headers: { "x-hadron-token": TOKEN } });
    ok(rs.status === 200, "restore pty-b → 200");
    // A refused connect ALSO emits one message (the yellow line) before 4404,
    // so "got a message" alone would not prove the attach — require a live pty
    // and an open socket.
    const ws = await connectTerminal("pty-b");
    ok(await waitFor(async () => (await health()).livePtys, 1) && ws.readyState === WebSocket.OPEN,
      "…restored agent's terminal attaches again (livePtys 1, socket still open — not a 4404 refusal)");
    ws.close(); await waitFor(async () => (await health()).livePtys, 0);

    // `?shell=` names the tmux sub-session hadron-<ws>-<id>-<shell>; only the
    // client-generated shapes (sh<N>, vim-<ts>) are accepted. Anything else is
    // refused at the upgrade — `?shell=bar` on agent pty-b would otherwise
    // attach to hadron-<ws>-pty-b-bar, the OWN session of an agent named that.
    for (const bad of ["bar", "sh1x", "vim-", "..%2F..", "sh1%2Fx"]) {
      const r = await attach(`pty-b&shell=${bad}`);
      ok(r.code !== 4404 && r.code !== "timeout" && r.out.length === 0 && r.code !== 1000,
        `?shell=${decodeURIComponent(bad)} → upgrade refused (close ${r.code}, no output)`);
    }
    const sessionsNow = tmuxQ(["ls", "-F", "#{session_name}"]).split("\n");
    ok(!sessionsNow.some((n) => n.startsWith(`hadron-${WS_NAME}-pty-b-`)),
      "…and no hadron-<ws>-pty-b-* tmux session was created by the refused names");
    ok((await health()).livePtys === 0, "…and no pty was spawned");
    const good = await connectTerminal("pty-b&shell=sh7");
    ok(await waitFor(async () => (await health()).livePtys, 1) && good.readyState === WebSocket.OPEN,
      "?shell=sh7 (the client's shape) still attaches (livePtys 1)");
    good.close(); await waitFor(async () => (await health()).livePtys, 0);
    tmuxQ(["kill-session", "-t", `=hadron-${WS_NAME}-pty-b-sh7`]);
  }

  console.log("\n[typing into the agent's pane acks its attention; a shell tab does not]");
  {
    const H = { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": BASE };
    const patch = (body) => fetch(`${BASE}/api/sessions/pty-a`, { method: "PATCH", headers: H, body: JSON.stringify(body) });
    const get = async () => (await (await fetch(`${BASE}/api/sessions`)).json()).find((s) => s.id === "pty-a");
    await patch({ state: "done" });
    let s = await get();
    ok(s.attentionRev >= 1 && (s.ackRev || 0) < s.attentionRev, `pty-a needs attention (rev ${s.attentionRev}, ack ${s.ackRev || 0})`);
    let rev = s.attentionRev;
    // A keystroke through a SHELL-TAB socket is the operator working in a side
    // shell, not answering the agent — it must not ack.
    const sh = await connectTerminal("pty-a&shell=sh3");
    sh.send(JSON.stringify({ type: "input", data: "\r" }));
    await sleep(600);
    s = await get();
    ok((s.ackRev || 0) < rev, "input on the shell-tab WS does not ack");
    sh.close(); await waitFor(async () => (await health()).livePtys, 0);
    tmuxQ(["kill-session", "-t", `=hadron-${WS_NAME}-pty-a-sh3`]);
    // Terminal REPLIES ride the same channel (xterm answers tmux's attach-time
    // queries): device attributes, cursor position, focus-in, an OSC reply.
    // None of them is the operator, none may ack.
    const ws = await connectTerminal("pty-a");
    for (const reply of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[24;80R", "\x1b[?24;80R", "\x1b[0n", "\x1b[?2026;2$y", "\x1b[I", "\x1b]11;rgb:0d/11/17\x1b\\"]) {
      ws.send(JSON.stringify({ type: "input", data: reply }));
    }
    await sleep(600);
    s = await get();
    ok((s.ackRev || 0) < rev, "terminal query replies (DA / CPR / DECXCPR / DSR / DECRPM / focus / OSC) on the agent's WS do not ack");
    // Keystrokes that start with ESC are still keystrokes: arrows (CSI and SS3),
    // modified arrows, function keys, bracketed paste, Alt+letter.
    for (const key of ["\x1b[A", "\x1bOA", "\x1b[1;5C", "\x1b[15~", "\x1b[200~x\x1b[201~", "\x1bx"]) {
      ws.send(JSON.stringify({ type: "input", data: key }));
    }
    await sleep(600);
    s = await get();
    ok(s.ackRev === rev, "ESC-prefixed keystrokes (arrows / SS3 / modified / F-keys / paste / Alt+x) do ack");
    // Re-raise (a new round) so the plain keystroke below has something to ack.
    await patch({ state: "blocked" });
    s = await get();
    ok(s.attentionRev === rev + 1 && s.ackRev === rev, `blocked re-raises (rev ${s.attentionRev}, ack ${s.ackRev})`);
    rev = s.attentionRev;
    // A keystroke through the primary socket is an answer → acked, persisted.
    ws.send(JSON.stringify({ type: "input", data: "\r" }));
    ok(await waitFor(async () => (await get()).ackRev, rev), `input on the agent's own WS acks (ackRev ${rev})`);
    ok(await waitFor(() => { try { return JSON.parse(readFileSync(join(WS, ".hadron", "agents", "pty-a.json"), "utf-8")).ackRev; } catch { return undefined; } }, rev),
      "…and the ack is persisted to the agent file");
    s = await get();
    ok(typeof s.ackAt === "string" && Date.now() - Date.parse(s.ackAt) < 10000, "a keystroke ack stamps ackAt too");
    ws.close(); await waitFor(async () => (await health()).livePtys, 0);
    await patch({ state: "idle" });
  }

  console.log("\n[repeated connect/close cycles do not accumulate fds]");
  {
    for (let i = 0; i < 5; i++) {
      const ws = await connectTerminal("pty-a");
      ws.close();
      await waitFor(async () => (await health()).livePtys, 0);
    }
    ok((await health()).livePtys === 0, "5 cycles → livePtys 0");
    fdOk(await waitFor(() => ptmxCount(server.pid), baseline, 3000), `5 cycles → ptmx fds at baseline (${baseline})`);
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
