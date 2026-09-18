/**
 * Event-loop liveness watchdog (server/heartbeat.js + `hadron watchdog`).
 *
 * Motivated by a Mac incident: an un-timed-out sync tmux spawn wedged the
 * server's event loop permanently. The pid stayed alive and the port stayed
 * bound, so launchd never restarted it and every HTTP probe hung. The server
 * now touches <ws>/.hadron/heartbeat from a timer; `hadron watchdog` reads the
 * mtime out-of-process and, with --restart, SIGKILLs a wedged server so the
 * supervisor relaunches it.
 *
 * Boots a throwaway server and:
 *   - heartbeat file exists, refreshes, and /api/health reports heartbeatAt + lag
 *   - `hadron watchdog` → exit 0 while alive
 *   - SIGSTOP the server (the honest wedge model) → exit 2, pid untouched
 *     without --restart; with --restart the pid is SIGKILLed
 *   - stale runtime.json after a kill → exit 1 (never treats a dead pid as wedged)
 *   - runtime.json naming a foreign live pid → exit 1 (pid reuse guard)
 *   - clean SIGTERM shutdown removes the heartbeat file
 *
 * Run: node test/unit/test-watchdog.js
 */
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const CLI = join(REPO, "bin", "hadron.js");
const PORT = 6900 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-wd-"));
const HB = join(WS, ".hadron", "heartbeat");
const RT = join(WS, ".hadron", "runtime.json");

// The CLI discovers .hadron/ by walking up from cwd and the port from
// runtime.json — exactly what a timer job on a real machine does. HADRON_PORT
// is scrubbed so the port must come from runtime.json.
const cliEnv = { ...process.env, HADRON_PORT: "", HADRON_TOKEN: "" };
delete cliEnv.HADRON_PORT; delete cliEnv.HADRON_TOKEN;
function watchdog(...args) {
  const env = args[0] && typeof args[0] === "object" ? { ...cliEnv, ...args.shift() } : cliEnv;
  const r = spawnSync("node", [CLI, "watchdog", "--json", ...args], { cwd: WS, env, encoding: "utf-8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

let server = null;
async function boot(env = {}) {
  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", TMUX: "", HADRON_TMUX_SOCKET: join(WS, "tmux.sock"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pid, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}

try {
  console.log("[heartbeat while alive]");
  await boot();
  const pid = server.pid;
  ok(existsSync(HB), "heartbeat file written at boot");
  const h1 = await (await fetch(`${BASE}/api/health`)).json();
  ok(typeof h1.heartbeatAt === "number" && Date.now() - h1.heartbeatAt < 5000, `/api/health.heartbeatAt is recent (${Date.now() - h1.heartbeatAt}ms ago)`);
  ok(typeof h1.eventLoopLagMs === "number" && h1.eventLoopLagMs < 1000, `/api/health.eventLoopLagMs is a small number (${h1.eventLoopLagMs})`);
  const m1 = statSync(HB).mtimeMs;
  await sleep(2600);
  const m2 = statSync(HB).mtimeMs;
  ok(m2 > m1, `heartbeat mtime advances (${Math.round(m2 - m1)}ms)`);
  let w = watchdog();
  ok(w.code === 0 && w.json && w.json.status === "running", `hadron watchdog → exit 0 running (${w.json && w.json.message})`);
  ok(w.json && w.json.pid === pid, "watchdog judged the pid from runtime.json");

  console.log("[wedged server: SIGSTOP]");
  // SIGSTOP freezes the event loop exactly like a blocked sync spawn does: pid
  // alive, port bound, nothing served, heartbeat frozen.
  process.kill(pid, "SIGSTOP");
  await sleep(3500);
  w = watchdog("--stale-after", "3");
  ok(w.code === 2 && w.json && w.json.status === "wedged", `stale heartbeat → exit 2 wedged (${w.json && w.json.message})`);
  ok(alive(pid), "without --restart the pid is left alone");
  ok(w.json && /not restarted/.test(w.json.action), `action says why (${w.json && w.json.action})`);
  w = watchdog("--stale-after", "3", "--restart");
  ok(w.code === 2 && w.json && w.json.action === "killed", `--restart → exit 2, action killed (${w.json && w.json.action})`);
  ok(await waitGone(pid), "wedged server pid is gone after --restart (SIGKILL works on a stopped process)");
  server = null;

  console.log("[after the kill: stale runtime.json]");
  ok(existsSync(RT), "runtime.json survives a SIGKILL (no cleanup ran) — the stale case the watchdog must handle");
  w = watchdog();
  ok(w.code === 1 && w.json && w.json.status === "not-running", `dead pid → exit 1 not-running, never 'wedged' (${w.json && w.json.message})`);

  console.log("[pid reuse guard]");
  const foreign = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    writeFileSync(RT, JSON.stringify({ port: PORT, pid: foreign.pid, startedAt: Date.now() }));
    w = watchdog("--stale-after", "1", "--restart");
    ok(w.code === 1 && w.json && /not a hadron server/.test(w.json.message), `foreign live pid → exit 1, not judged (${w.json && w.json.message})`);
    ok(alive(foreign.pid), "foreign pid was NOT killed even with --restart");
  } finally { foreign.kill("SIGKILL"); }
  rmSync(RT, { force: true }); rmSync(HB, { force: true });
  w = watchdog();
  ok(w.code === 1, "no runtime.json → exit 1");

  console.log("[guards that must refuse to kill]");
  // Beat once at boot, then never again (60s interval): the file goes stale
  // while the server is demonstrably serving — the "heartbeat isn't landing"
  // shape (unwritable .hadron/, fs oddity). Exit 3, and the pid must survive.
  await boot({ HADRON_HEARTBEAT_INTERVAL_MS: "60000" });
  const pid3 = server.pid;
  await sleep(1500);
  w = watchdog("--stale-after", "1", "--restart");
  ok(w.code === 3 && w.json && w.json.status === "unknown" && /answers/.test(w.json.message), `stale beat but /api/health answers → exit 3, refused (${w.json && w.json.message})`);
  let serving = false; try { serving = (await fetch(`${BASE}/api/health`)).ok; } catch {}
  ok(alive(pid3) && serving, "serving server was NOT killed");
  // Wrong HADRON_PORT (stamped into every agent pane; may name another
  // workspace's server): the safety probe must use the pid's own port from
  // runtime.json, so a dead env port cannot turn a serving server into a kill.
  w = watchdog({ HADRON_PORT: String(PORT + 1000) }, "--stale-after", "1", "--restart");
  ok(w.code === 3 && alive(pid3), `HADRON_PORT pointing at a dead port cannot cause a kill (exit ${w.code})`);
  // No heartbeat file + live hadron pid = still booting (the beat starts after
  // the boot-time tmux loop) or an older build: exit 3, never a kill.
  rmSync(HB, { force: true });
  w = watchdog("--stale-after", "1", "--restart");
  ok(w.code === 3 && w.json && w.json.status === "booting", `live hadron pid with no heartbeat → exit 3 booting (${w.json && w.json.message})`);
  ok(alive(pid3), "booting server was NOT killed");
  // Past the boot grace with no beat: an older build that serves HTTP is left
  // alone (exit 3); one that does not answer is wedged in boot → killable.
  writeFileSync(RT, JSON.stringify({ port: PORT, pid: pid3, startedAt: Date.now() - 400_000 }));
  w = watchdog("--stale-after", "1", "--restart");
  ok(w.code === 3 && alive(pid3) && /older build/.test(w.json && w.json.message), `no beat past boot grace but serving → exit 3, not killed (${w.json && w.json.message})`);
  process.kill(pid3, "SIGSTOP");
  w = watchdog("--stale-after", "1", "--restart");
  ok(w.code === 2 && w.json && w.json.action === "killed" && /wedged during boot/.test(w.json.message), `no beat past boot grace and no HTTP → wedged, killed (${w.json && w.json.message})`);
  ok(await waitGone(pid3), "boot-wedged server is gone");
  server = null;
  w = watchdog("--boot-grace", "999999");
  ok(w.code === 1, "and with the server gone the verdict is not-running, not wedged");
  rmSync(RT, { force: true });

  console.log("[clean shutdown]");
  await boot();
  const pid2 = server.pid;
  ok(existsSync(HB), "heartbeat back after a relaunch (the supervisor path)");
  ok(watchdog().code === 0, "watchdog → 0 on the relaunched server");
  server.kill("SIGTERM");
  ok(await waitGone(pid2), "server exits on SIGTERM");
  server = null;
  ok(!existsSync(HB), "clean shutdown removed the heartbeat file");
  ok(!existsSync(RT), "clean shutdown removed runtime.json");
  ok(watchdog().code === 1, "watchdog after a clean stop → exit 1 not-running (not wedged)");
} finally {
  if (server) { try { server.kill("SIGKILL"); } catch {} }
  rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
