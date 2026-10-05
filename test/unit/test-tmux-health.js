/**
 * tmux server health probe (server/tmux-health.js) at the REAL boundary.
 *
 * Prod 2026-10-05: the tmux server reached 5.6 GB RSS + 1.2 GB swap and every
 * tmux call crawled; nothing watched tmux itself. The probe piggybacks on the
 * state detector's per-second `list-panes -a` (no extra spawn), reads
 * /proc/<pid>/status every 30 s, and reports — never kills.
 *
 *   - judge / parseProcStatus pure contracts (down = trailing failures in a
 *     row, warn = slow probes over the window or RSS/swap over threshold)
 *   - private tmux server (HADRON_TMUX_SOCKET) → /api/health.tmux has the
 *     server's pid, rssMb/swapMb (Linux), latency, level ok; the ntfy block
 *     says enabled=false (default OFF) + topicReadable, never the topic
 *   - PATCH /api/workspace tmuxAlerts: { ntfy: boolean } only (400 otherwise)
 *   - SIGSTOP the tmux server → level down with a reason; with alerts ON the
 *     local ntfy stub gets ONE POST (Title says not answering, body names
 *     `hadron doctor`); SIGCONT → ok on the next probe + one recovery POST;
 *     with alerts OFF a second outage posts nothing
 *   - HADRON_TMUX_WARN_RSS_MB=1 → warn with an RSS reason, `hadron doctor`
 *     yellow row naming RSS/swap/p95, `--json` carries it
 *   - the topic string is on no payload and in no server log line
 *
 * Run: node test/unit/test-tmux-health.js
 */
import "./hadron-home.js";
import { spawn, spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { judge, parseProcStatus, createTmuxHealth, FAIL_PROBES_DOWN, SLOW_PROBES_WARN, PID_RETRY_MS } from "../../server/tmux-health.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const CLI = join(REPO, "bin", "hadron.js");
const PORT = 7300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOPIC = "hadrontesttopic9f3k";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── pure ──────────────────────────────────────────────────────────────────
console.log("[judge]");
{
  const now = 1_000_000;
  const P = (ms, failed = false, ago = 0, timedOut = failed) => ({ at: now - ago, ms, failed, timedOut });
  let v = judge({ probes: [P(10), P(20), P(30)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "ok" && v.reasons.length === 0, "fast probes + small memory → ok, no reasons");
  v = judge({ probes: [P(10), P(900), P(900), P(900)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "warn" && v.slowProbes === 3 && /3 of the last 4 pane probes took over 500 ms/.test(v.reasons[0]), `${SLOW_PROBES_WARN} slow probes → warn (${v.reasons[0]})`);
  v = judge({ probes: [P(10), P(900), P(900)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "ok", "two slow probes → still ok");
  v = judge({ probes: [P(10), P(2000, true), P(2000, true), P(2000, true)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "down" && v.failedProbes === 3 && /^the last 3 pane probes timed out$/.test(v.reasons[0]), `${FAIL_PROBES_DOWN} timeouts in a row → down, reason says timed out (${v.reasons[0]})`);
  v = judge({ probes: [P(10), P(3, true, 0, false), P(2, true, 0, false), P(3, true, 0, false)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "down" && /refused at once \(no tmux server\?\)/.test(v.reasons[0]), `three instant refusals → down, reason says no tmux server (${v.reasons[0]})`);
  v = judge({ probes: [P(2000, true), P(3, true, 0, false), P(2000, true)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "down" && /failed or timed out/.test(v.reasons[0]), `mixed failures → "failed or timed out" (${v.reasons[0]})`);
  v = judge({ probes: [P(10)], rssMb: 9000, swapMb: 9000, now, warnRssMb: 0, warnSwapMb: 0 });
  ok(v.level === "ok", "a threshold of 0 switches that memory check off (HADRON_TMUX_WARN_*_MB=0)");
  v = judge({ probes: [P(2000, true), P(2000, true), P(2000, true), P(12)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "ok" && v.failedProbes === 0, "one answered probe after three failures → ok at once (trailing run, not window count)");
  v = judge({ probes: [P(2000, true, 70_000), P(2000, true, 65_000), P(2000, true, 61_000)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "ok" && v.probesJudged === 0, "failures older than 60 s are not judged");
  v = judge({ probes: [P(10)], rssMb: 3000, swapMb: 0, now, warnRssMb: 2048 });
  ok(v.level === "warn" && /RSS 3000 MB \(warn from 2048 MB\)/.test(v.reasons[0]), `RSS over threshold → warn (${v.reasons[0]})`);
  v = judge({ probes: [P(10)], rssMb: 100, swapMb: 600, now, warnSwapMb: 512 });
  ok(v.level === "warn" && /600 MB swapped out/.test(v.reasons[0]), `swap over threshold → warn (${v.reasons[0]})`);
  v = judge({ probes: [P(2000, true), P(2000, true), P(2000, true)], rssMb: 3000, swapMb: 600, now });
  ok(v.level === "down" && v.reasons.length === 3, "down + memory reasons: level stays down, every reason listed");
  v = judge({ probes: [P(10)], rssMb: null, swapMb: null, now });
  ok(v.level === "ok", "unknown memory (macOS) judges latency only");
}
console.log("[parseProcStatus]");
{
  const t = "Name:\ttmux: server\nVmPeak:\t 6000000 kB\nVmRSS:\t 5872640 kB\nVmSwap:\t 1228800 kB\n";
  const m = parseProcStatus(t);
  ok(m.rssMb === 5735 && m.swapMb === 1200, `VmRSS/VmSwap kB → MB (${m.rssMb}, ${m.swapMb})`);
  const n = parseProcStatus("Name:\tx\n");
  ok(n.rssMb === null && n.swapMb === null, "missing fields → null");
  const self = parseProcStatus(existsSync("/proc/self/status") ? readFileSync("/proc/self/status", "utf-8") : "");
  if (existsSync("/proc/self/status")) ok(self.rssMb > 0, `this process' own RSS reads as ${self.rssMb} MB`);
}

console.log("[pid reuse]");
{
  // The kernel reused the tmux pid after a hand restart: /proc reads fine but
  // belongs to someone else — the tracker must drop the pid, not judge on it.
  let t = 0;
  const resolved = [];
  const h = createTmuxHealth({
    now: () => t,
    resolvePid: async () => { resolved.push(t); return 4242; },
    readStatus: () => "Name:\tnode\nVmRSS:\t 9000000 kB\nVmSwap:\t 9000000 kB\n",
    log: { log() {}, warn() {} },
  });
  await h.sampleMemory();
  let s = h.snapshot();
  ok(s.pid === null && s.rssMb === null && /reused/.test(s.memError), `a non-tmux Name drops the pid and reads no memory (${s.memError})`);
  ok(s.level === "ok", "no stranger's 8.6 GB RSS on the verdict");
  t = PID_RETRY_MS + 1; h.noteProbe(5, false); await new Promise((r) => setTimeout(r, 0));
  ok(resolved.length === 2, `the pid is asked for again after PID_RETRY_MS (${resolved.length} resolves)`);
}

// ── live ──────────────────────────────────────────────────────────────────
const WS = mkdtempSync(join(tmpdir(), "hadron-th-"));
const SOCK = join(WS, "tmux.sock");
const TOPIC_FILE = join(WS, "ntfy-topic");
writeFileSync(TOPIC_FILE, TOPIC + "\n", { mode: 0o600 });
mkdirSync(join(WS, ".hadron"), { recursive: true });
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({ name: "th", groups: ["Workers"] }));
const tmuxS = (args) => execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", env: { ...process.env, TMUX: "" } }).trim();

// ntfy stub: records every POST
const pushes = [];
const ntfy = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => { pushes.push({ method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(200); res.end("{}"); });
});
await new Promise((r) => ntfy.listen(0, "127.0.0.1", r));
const NTFY_URL = `http://127.0.0.1:${ntfy.address().port}`;

let server = null, serverLog = "";
async function boot(env = {}) {
  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", TMUX: "", HADRON_TMUX_SOCKET: SOCK, HADRON_NTFY_URL: NTFY_URL, HADRON_NTFY_TOPIC_FILE: TOPIC_FILE, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await Promise.race([gone, sleep(4000)]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await gone; }
}
let TOKEN = "";
const H = () => ({ "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: BASE });
// One retry: a keep-alive socket the server closed while its loop was blocked
// (a sync tmux call bounded at 5 s during the outage) resets the next request.
async function health() {
  for (let i = 0; ; i++) {
    try { return await (await fetch(`${BASE}/api/health`)).json(); }
    catch (e) { if (i >= 2) throw e; await sleep(300); }
  }
}
async function waitLevel(level, ms) {
  const t0 = Date.now();
  let h;
  while (Date.now() - t0 < ms) { h = await health(); if (h.tmux.level === level) return h; await sleep(300); }
  return h;
}
const cliEnv = () => ({ ...process.env, HADRON_PORT: String(PORT), HADRON_TOKEN: TOKEN });
const doctor = (...args) => spawnSync("node", [CLI, "doctor", ...args], { cwd: WS, env: cliEnv(), encoding: "utf-8", timeout: 30000 });

let tmuxPid = null;
try {
  console.log("[healthy tmux]");
  await boot();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: H(), body: JSON.stringify({ name: "probe", cwd: WS, launchCommand: "shell", group: "Workers", autostart: false }) });
  ok(r.status === 201, `shell agent created (${r.status}) — the state detector now probes every second`);
  tmuxPid = Number(tmuxS(["display-message", "-p", "#{pid}"]));
  ok(Number.isInteger(tmuxPid) && tmuxPid > 0, `private tmux server pid ${tmuxPid}`);
  await sleep(PID_RETRY_MS + 1500); // the pid is asked for once a session exists, at most every PID_RETRY_MS
  let h = await health();
  const t = h.tmux;
  ok(t.level === "ok" && Array.isArray(t.reasons) && t.reasons.length === 0, `health.tmux.level ok, no reasons (${JSON.stringify(t.reasons)})`);
  ok(t.pid === tmuxPid, `health.tmux.pid is the tmux server's pid (${t.pid})`);
  ok(typeof t.latencyMs === "number" && t.latencyMs >= 0 && t.latencyMs < 2000, `latencyMs from the detector's own batch (${t.latencyMs} ms)`);
  ok(typeof t.latencyP95Ms === "number", `latencyP95Ms present (${t.latencyP95Ms} ms)`);
  if (process.platform === "linux") {
    ok(typeof t.rssMb === "number" && t.rssMb >= 0 && typeof t.swapMb === "number", `rssMb/swapMb read from /proc (${t.rssMb} MB, ${t.swapMb} MB swap)`);
    ok(t.memError === null, `memError null (${t.memError})`);
  } else {
    ok(t.rssMb === null && typeof t.memError === "string", `no /proc on ${process.platform} → rssMb null, memError says so`);
  }
  ok(typeof t.calls === "number" && typeof t.busyRefusals === "number", "the tmux call stats and busyRefusals are still on the same object");
  ok(t.ntfy && t.ntfy.enabled === false && t.ntfy.topicReadable === true, `ntfy: enabled=false by default, topicReadable=true (${JSON.stringify(t.ntfy)})`);
  ok(!JSON.stringify(h).includes(TOPIC), "the topic string is not on /api/health");
  let d = doctor("--json");
  ok(d.status === 0, `hadron doctor exits 0 while tmux is healthy (${d.status})`);
  let dj = null; try { dj = JSON.parse(d.stdout); } catch {}
  const trow = dj && dj.local.find((f) => /^tmux: \d+ calls since boot/.test(f.message));
  ok(trow && trow.level === "green" && /server pid \d+ RSS \d+ MB/.test(trow.message) === (process.platform === "linux"), `doctor green tmux row (${trow && trow.message})`);
  ok(!d.stdout.includes(TOPIC), "the topic string is not in doctor output");

  console.log("[PATCH /api/workspace tmuxAlerts]");
  for (const bad of [{ tmuxAlerts: true }, { tmuxAlerts: { ntfy: "yes" } }, { tmuxAlerts: [] }, { tmuxAlerts: {} }, { tmuxAlerts: null }]) {
    const b = await fetch(`${BASE}/api/workspace`, { method: "PATCH", headers: H(), body: JSON.stringify(bad) });
    ok(b.status === 400, `PATCH ${JSON.stringify(bad)} → 400 (${b.status})`);
  }
  let p = await fetch(`${BASE}/api/workspace`, { method: "PATCH", headers: H(), body: JSON.stringify({ tmuxAlerts: { ntfy: true } }) });
  let pj = await p.json();
  ok(p.status === 200 && pj.tmuxAlerts && pj.tmuxAlerts.ntfy === true, `PATCH { ntfy: true } → 200, echoed (${JSON.stringify(pj.tmuxAlerts)})`);
  const onDisk = JSON.parse(readFileSync(join(WS, ".hadron", "config.json"), "utf-8"));
  ok(onDisk.tmuxAlerts && onDisk.tmuxAlerts.ntfy === true && onDisk.groups[0] === "Workers", "persisted in .hadron/config.json, other keys kept");
  const w = await (await fetch(`${BASE}/api/workspace`)).json();
  ok(w.tmuxAlerts && w.tmuxAlerts.ntfy === true, "GET /api/workspace carries it (the View menu checkbox reads this)");
  h = await health();
  ok(h.tmux.ntfy.enabled === true, "health.tmux.ntfy.enabled follows the config");

  console.log("[tmux stops answering: SIGSTOP, alerts on]");
  // Never signal without a real pid: process.kill(0, …) would SIGSTOP this whole process group.
  const stopTmux = () => { if (!Number.isInteger(tmuxPid) || tmuxPid <= 1) throw new Error("private tmux server pid unknown — refusing to signal"); process.kill(tmuxPid, "SIGSTOP"); };
  stopTmux();
  h = await waitLevel("down", 20000);
  ok(h.tmux.level === "down" && /pane probes timed out/.test(h.tmux.reasons[0]), `level down with a reason (${h.tmux.level}: ${h.tmux.reasons[0]})`);
  ok(h.tmux.failedProbes >= FAIL_PROBES_DOWN && typeof h.tmux.since === "string", `failedProbes ${h.tmux.failedProbes}, since ${h.tmux.since}`);
  ok(server.exitCode === null, "the server is still up (nothing threw out of the probe)");
  await sleep(1500);
  ok(pushes.length === 1, `exactly one ntfy POST so far (${pushes.length})`);
  const push = pushes[0];
  ok(push && push.method === "POST" && push.url === `/${TOPIC}`, `POSTed to <url>/<topic> (${push && push.url})`);
  ok(push && /^Hadron .*: tmux not answering$/.test(push.headers.title || ""), `Title header (${push && push.headers.title})`);
  ok(push && push.headers.priority === "high" && /warning/.test(push.headers.tags || ""), `Priority high, Tags warning (${push && push.headers.priority}, ${push && push.headers.tags})`);
  ok(push && /pane probes timed out/.test(push.body) && /hadron doctor/.test(push.body) && /never|Nothing was killed/.test(push.body), `body carries the reason and says nothing was killed (${push && push.body})`);
  d = doctor("--json");
  dj = null; try { dj = JSON.parse(d.stdout); } catch {}
  const down = dj && dj.local.find((f) => /^tmux is not answering since/.test(f.message));
  ok(down && down.level === "yellow" && /ntfy alerts on/.test(down.message) && /never kills/.test(down.message), `doctor yellow "tmux is not answering" row (${down && down.message})`);

  console.log("[SIGCONT → recovery]");
  process.kill(tmuxPid, "SIGCONT");
  h = await waitLevel("ok", 15000);
  ok(h.tmux.level === "ok" && h.tmux.reasons.length === 0, `level ok again on the next answered probe (${h.tmux.level})`);
  await sleep(1500);
  ok(pushes.length === 2 && /tmux recovered$/.test(pushes[1].headers.title || "") && pushes[1].headers.priority === "low", `one recovery push, priority low (${pushes.length}: ${pushes[1] && pushes[1].headers.title})`);

  console.log("[second outage with alerts OFF]");
  p = await fetch(`${BASE}/api/workspace`, { method: "PATCH", headers: H(), body: JSON.stringify({ tmuxAlerts: { ntfy: false } }) });
  ok(p.status === 200 && (await p.json()).tmuxAlerts.ntfy === false, "PATCH { ntfy: false } → 200");
  stopTmux();
  h = await waitLevel("down", 20000);
  ok(h.tmux.level === "down", "level down again");
  process.kill(tmuxPid, "SIGCONT");
  h = await waitLevel("ok", 15000);
  ok(h.tmux.level === "ok", "and ok again");
  await sleep(1500);
  ok(pushes.length === 2, `no ntfy POST while alerts are off (${pushes.length})`);
  ok(/\[tmux-health\] ok → down/.test(serverLog) && /\[tmux-health\] down → ok/.test(serverLog), "server log records both transitions");
  ok(/\[tmux-health\] ntfy push sent \(down\)/.test(serverLog), "server log records the push without the topic");
  ok(!serverLog.includes(TOPIC) && !serverLog.includes(TOKEN), "neither the topic nor the token is in the server log");
  await stopServer();

  console.log("[memory over threshold: HADRON_TMUX_WARN_RSS_MB=1]");
  if (process.platform === "linux") {
    serverLog = "";
    await boot({ HADRON_TMUX_WARN_RSS_MB: "1" });
    TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
    h = await waitLevel("warn", 10000);
    ok(h.tmux.level === "warn" && h.tmux.reasons.some((r) => /^RSS \d+ MB \(warn from 1 MB\)/.test(r)), `warn with an RSS reason (${JSON.stringify(h.tmux.reasons)})`);
    ok(h.tmux.warnRssMb === 1, "warnRssMb on the payload");
    await sleep(1500); // a probe or two, so p95 is a number
    d = doctor("--json");
    dj = null; try { dj = JSON.parse(d.stdout); } catch {}
    const warn = dj && dj.local.find((f) => /^tmux is degraded since/.test(f.message));
    ok(warn && warn.level === "yellow" && /RSS \d+ MB \+ \d+ MB swap, p95 \d+ ms/.test(warn.message) && /ntfy alerts off \(View/.test(warn.message), `doctor yellow "tmux is degraded" row names RSS/swap/p95 and the alert setting (${warn && warn.message})`);
    ok(d.status === 0, "a yellow tmux row does not fail doctor (exit 0)");
    const dt = doctor();
    ok(/tmux is degraded/.test(dt.stdout) && !dt.stdout.includes(TOPIC), "text doctor shows the row, no topic");
    ok(pushes.length === 2, `no push: alerts are off in this workspace (${pushes.length})`);
    await stopServer();
  } else {
    console.log("  skip (no /proc on this platform)");
  }
} catch (e) {
  failed++;
  console.error(`  ✗ unexpected error: ${e.stack || e}`);
  console.error(`  server exitCode=${server && server.exitCode} log tail:\n${serverLog.slice(-3000)}`);
} finally {
  try { if (tmuxPid) process.kill(tmuxPid, "SIGCONT"); } catch {}
  await stopServer();
  try { execFileSync("tmux", ["-S", SOCK, "kill-server"], { env: { ...process.env, TMUX: "" } }); } catch {}
  ntfy.close();
  rmSync(WS, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
