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
import { judge, parseProcStatus, parseHistory, readStatusViaPs, HAS_PROC, createTmuxHealth, FAIL_PROBES_DOWN, SLOW_PROBES_WARN, PID_RETRY_MS, SWAP_WINDOW_MS, PROC_INTERVAL_MS } from "../../server/tmux-health.js";
import { TMUX_HISTORY_LINES } from "../../server/tmux.js";

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
  v = judge({ probes: [P(10)], rssMb: 9000, swapMb: 9000, swapGrowthMb: 9000, now, warnRssMb: 0, warnSwapMb: 0, swapCeilingMb: 0 });
  ok(v.level === "ok", "a threshold of 0 switches that memory check off (HADRON_TMUX_WARN_*_MB=0)");
  v = judge({ probes: [P(2000, true), P(2000, true), P(2000, true), P(12)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "ok" && v.failedProbes === 0, "one answered probe after three failures → ok at once (trailing run, not window count)");
  v = judge({ probes: [P(2000, true, 70_000), P(2000, true, 65_000), P(2000, true, 61_000)], rssMb: 100, swapMb: 0, now });
  ok(v.level === "ok" && v.probesJudged === 0, "failures older than 60 s are not judged");
  v = judge({ probes: [P(10)], rssMb: 3000, swapMb: 0, now, warnRssMb: 2048 });
  ok(v.level === "warn" && /RSS 3000 MB \(warn from 2048 MB\)/.test(v.reasons[0]), `RSS over threshold → warn (${v.reasons[0]})`);
  v = judge({ probes: [P(10)], rssMb: 100, swapMb: 4000, swapGrowthMb: 0, now, warnSwapMb: 512 });
  ok(v.level === "ok", "4 GB of swap that is not growing (an old peak's residue) → ok");
  v = judge({ probes: [P(10)], rssMb: 100, swapMb: 900, swapGrowthMb: 600, now, warnSwapMb: 512 });
  ok(v.level === "warn" && /swap grew 600 MB in the last hour, 900 MB out now/.test(v.reasons[0]), `swap growing past the threshold → warn (${v.reasons[0]})`);
  v = judge({ probes: [P(10)], rssMb: 100, swapMb: 900, swapGrowthMb: null, now, warnSwapMb: 512 });
  ok(v.level === "ok", "no growth figure yet (first sample) → not judged");
  v = judge({ probes: [P(2000, true), P(2000, true), P(2000, true)], rssMb: 3000, swapMb: 600, swapGrowthMb: 600, now });
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

console.log("[parseHistory]");
{
  const h = parseHistory("hadron-w-a|40000|50000\nhadron-w-b|120|5000\nhadron-w-c|0|100000\nother|7000|50000\nbad line\n", 5000);
  ok(h.panes === 4 && h.lines === 47120, `panes and total lines over every session (${h.panes}, ${h.lines})`);
  ok(h.overCap === 1 && h.overCapLines === 40000, `overCap counts only hadron-* panes that HOLD more than the cap (${h.overCap}, ${h.overCapLines} lines)`);
  ok(h.uncapped === 2, `uncapped counts hadron-* panes whose limit is above the cap, cleared or not (${h.uncapped}) — a cleared pane is not advice`);
  ok(parseHistory("hadron-w-a|0|100000\n", 5000).overCap === 0, "a pane cleared by the row's own advice drops out of the row (limit unchanged)");
  ok(h.largest && h.largest.session === "hadron-w-a" && h.largest.lines === 40000, "largest pane named");
  ok(parseHistory("hadron-w-a|40000|50000\n", 0).overCap === 0 && parseHistory("hadron-w-a|40000|50000\n", 0).uncapped === 0, "cap 0 (disabled) → nothing is over the cap, nothing uncapped");
  ok(parseHistory("", 5000).panes === 0 && parseHistory(null, 5000).lines === 0, "empty / null → zeros");
}

console.log("[swap growth]");
{
  // Residue stays quiet; the same figure reached by GROWTH inside the window warns.
  let t = 0, swapKb = 2_000_000;
  const h = createTmuxHealth({
    now: () => t,
    resolvePid: async () => 4242,
    readStatus: () => `Name:\ttmux: server\nVmRSS:\t 400000 kB\nVmSwap:\t ${swapKb} kB\n`,
    listHistory: async () => "hadron-w-a|10|5000\n",
    log: { log() {}, warn() {} },
  });
  await h.sampleMemory();
  let s = h.snapshot();
  ok(s.swapMb === 1953 && s.swapGrowthMb === 0 && s.level === "ok", `first sample: 1.9 GB swapped, growth 0, ok (${s.swapMb}, ${s.swapGrowthMb})`);
  ok(s.history && s.history.panes === 1 && s.history.cap === TMUX_HISTORY_LINES, `history inventory on the snapshot (${JSON.stringify(s.history)})`);
  t += PROC_INTERVAL_MS; swapKb += 300 * 1024; await h.sampleMemory();
  s = h.snapshot();
  ok(s.swapGrowthMb === 300 && s.level === "ok", `+300 MB → growth 300, still ok (${s.swapGrowthMb})`);
  t += PROC_INTERVAL_MS; swapKb += 300 * 1024; await h.sampleMemory();
  s = h.snapshot();
  ok(s.swapGrowthMb === 600 && s.level === "warn" && /swap grew 600 MB/.test(s.reasons[0]), `+600 MB within the hour → warn (${s.reasons[0]})`);
  t += SWAP_WINDOW_MS + 1; await h.sampleMemory();
  s = h.snapshot();
  ok(s.swapGrowthMb === 0 && s.level === "ok", `an hour later with no further growth the baseline has moved on → ok (${s.swapGrowthMb})`);
  t += PROC_INTERVAL_MS; swapKb -= 2_000_000; await h.sampleMemory();
  s = h.snapshot();
  ok(s.swapGrowthMb === 0 && s.swapMb < 1000, `a drop (swapoff/swapon, page-ins) is never growth (${s.swapGrowthMb})`);
}

console.log("[swap ceiling]");
{
  const base = { probes: [], rssMb: 300, swapGrowthMb: 0, now: 0 };
  ok(judge({ ...base, swapMb: 4096 }).level === "warn" && /4096 MB swapped out \(ceiling 4096 MB\)/.test(judge({ ...base, swapMb: 4096 }).reasons[0]), "4 GB out with no growth → warn on the ceiling");
  ok(judge({ ...base, swapMb: 4095 }).level === "ok", "just under the ceiling → ok");
  ok(judge({ ...base, swapMb: 9000, swapCeilingMb: 0 }).level === "ok", "ceiling 0 disables it");
  const both = judge({ ...base, swapMb: 9000, swapGrowthMb: 700 });
  ok(both.reasons.length === 1 && /grew/.test(both.reasons[0]), "growth and ceiling at once → one reason, growth");
}

console.log("[restart baseline + inventory gating]");
{
  // A hand restart of tmux: new pid, its swap is its own — the hour of samples
  // from the old server would otherwise read the new figure as growth.
  let t = 0, pid = 100, swapKb = 4_000_000, listed = 0;
  const h = createTmuxHealth({
    now: () => t,
    resolvePid: async () => pid,
    readStatus: (p) => { if (p !== pid) { const e = new Error("gone"); e.code = "ENOENT"; throw e; } return `Name:\ttmux: server\nVmRSS:\t 400000 kB\nVmSwap:\t ${swapKb} kB\n`; },
    listHistory: async () => { listed++; return "hadron-w-a|10|5000\nscratch|20|2000\n"; },
    log: { log() {}, warn() {} },
  });
  await h.sampleMemory();
  let s = h.snapshot();
  ok(s.history.largest.session === null && s.history.lines === 30 && typeof s.history.at === "string", `largest pane outside hadron-* is nameless on the open payload (${JSON.stringify(s.history.largest)})`);
  t += PROC_INTERVAL_MS; swapKb = 100_000; pid = 200; await h.sampleMemory();   // old pid: ENOENT → pid null, ring cleared
  s = h.snapshot();
  ok(s.pid === null, "ENOENT on the old pid drops it");
  t += 6000; await h.sampleMemory();                                              // re-resolve → 200
  t += PROC_INTERVAL_MS; swapKb = 500_000; await h.sampleMemory();               // +390 MB on the NEW server
  s = h.snapshot();
  ok(s.pid === 200 && s.swapGrowthMb === 390 && s.level === "ok", `growth is measured from the new server's first sample only (${s.swapGrowthMb})`);
  const before = listed;
  for (let i = 0; i < 3; i++) h.noteProbe(2500, true, true);
  t += PROC_INTERVAL_MS; await h.sampleMemory();
  ok(h.snapshot().level === "down" && listed === before, "no list-panes spawn while tmux is down");
  for (let i = 0; i < 3; i++) h.noteProbe(5, false, false);
  t += PROC_INTERVAL_MS; await h.sampleMemory();
  ok(h.snapshot().level === "ok" && listed === before + 1, "inventory resumes once tmux answers");
}

console.log("[macOS: memory via ps, no /proc]");
{
  // 2026-10-06 (Mac): /proc missing → every read ENOENT → "pid gone" → pid
  // re-asked of tmux every 5 s forever, memory never read. The ps reader keeps
  // the pid, reads RSS, leaves swap null, and still catches a reused pid.
  const calls = [];
  const psExec = (lines) => (cmd, args, opts, cb) => { calls.push({ cmd, args }); cb(null, lines); };
  let text = await readStatusViaPs(4242, { exec: psExec("  123456 /opt/homebrew/bin/tmux\n") });
  ok(/^Name:\ttmux$/m.test(text) && parseProcStatus(text).rssMb === 121 && parseProcStatus(text).swapMb === null, `macOS ps line → Name tmux (basename of the path), RSS 121 MB, swap null (${JSON.stringify(text)})`);
  ok(calls[0].cmd === "ps" && calls[0].args.join(" ") === "-o rss=,comm= -p 4242", `one ps -o rss=,comm= -p <pid> (${calls[0].args.join(" ")})`);
  text = await readStatusViaPs(1, { exec: psExec("  2048 tmux: server\n") });
  ok(/^Name:\ttmux: server$/m.test(text), "Linux-shaped comm with a space passes through");
  let err = null;
  try { await readStatusViaPs(4242, { exec: psExec("") }); } catch (e) { err = e; }
  ok(err && err.code === "ENOENT", `no line from ps → ENOENT, the tracker's "pid gone" path (${err && err.code})`);
  let t = 0, resolved = 0, rssKb = 100 * 1024;
  const h = createTmuxHealth({
    now: () => t,
    resolvePid: async () => { resolved++; return 4242; },
    readStatus: (pid) => readStatusViaPs(pid, { exec: psExec(`${rssKb} /opt/homebrew/bin/tmux\n`) }),
    listHistory: async () => "hadron-w-a|10|5000\n",
    log: { log() {}, warn() {} },
  });
  for (let i = 0; i < 5; i++) { t += PROC_INTERVAL_MS; await h.sampleMemory(); }
  let s = h.snapshot();
  ok(resolved === 1 && s.pid === 4242, `the pid is resolved once and kept — no 5-s re-resolve loop (${resolved})`);
  ok(s.rssMb === 100 && s.swapMb === null && s.swapGrowthMb === null && s.memError === null && s.level === "ok", `RSS read, swap null, growth null, no error (${JSON.stringify({ rss: s.rssMb, swap: s.swapMb, err: s.memError })})`);
  ok(s.history && s.history.panes === 1, "the scrollback inventory runs there too");
  rssKb = 3000 * 1024; t += PROC_INTERVAL_MS; await h.sampleMemory();
  s = h.snapshot();
  ok(s.level === "warn" && /RSS 3000 MB/.test(s.reasons[0]), `RSS is judged on macOS now (${s.reasons[0]})`);
  const h2 = createTmuxHealth({
    now: () => t, resolvePid: async () => 4242,
    readStatus: (pid) => readStatusViaPs(pid, { exec: psExec("  500 /usr/local/bin/node\n") }),
    log: { log() {}, warn() {} },
  });
  await h2.sampleMemory();
  ok(h2.snapshot().pid === null && /reused/.test(h2.snapshot().memError), "a reused pid (comm is not tmux) is dropped through the same check");
  // ps itself failing is not "pid gone": the pid and the swap baseline stay.
  const failing = (e) => (cmd, args, opts, cb) => cb(e, "");
  for (const [what, e] of [["timeout", Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", code: null })], ["ps missing", Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT", syscall: "spawn ps", path: "ps" })], ["fork failure", Object.assign(new Error("EAGAIN"), { code: "EAGAIN", syscall: "spawn" })]]) {
    err = null;
    try { await readStatusViaPs(4242, { exec: failing(e) }); } catch (x) { err = x; }
    ok(err && err.code === "EPS", `${what} → EPS, not ENOENT (${err && err.code})`);
  }
  err = null;
  try { await readStatusViaPs(4242, { exec: failing(Object.assign(new Error("exit 1"), { code: 1 })) }); } catch (x) { err = x; }
  ok(err && err.code === "ENOENT", "exit 1 with no line (the real 'no such process') → ENOENT");
  let psOk = true;
  const h3 = createTmuxHealth({
    now: () => t, resolvePid: async () => { resolved++; return 4242; },
    readStatus: (pid) => readStatusViaPs(pid, { exec: psOk ? psExec("  100000 /opt/homebrew/bin/tmux\n") : failing(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", code: null })) }),
    log: { log() {}, warn() {} },
  });
  resolved = 0;
  t += PROC_INTERVAL_MS; await h3.sampleMemory();
  psOk = false; t += PROC_INTERVAL_MS; await h3.sampleMemory();
  s = h3.snapshot();
  ok(s.pid === 4242 && resolved === 1 && /memory unreadable this round \(EPS\)/.test(s.memError) && !/killed/.test(s.memError), `one timed-out ps keeps the pid, says so with the code only (${s.memError})`);
  psOk = true; t += PROC_INTERVAL_MS; await h3.sampleMemory();
  s = h3.snapshot();
  ok(s.pid === 4242 && resolved === 1 && s.memError === null && typeof s.rssMb === "number" && s.rssMb > 90, `…and the next sample reads again without re-resolving (RSS ${s.rssMb} MB)`);
    // The real ps on this box, against this very process: the shape holds here too.
  const self = parseProcStatus(await readStatusViaPs(process.pid));
  ok(typeof self.rssMb === "number" && self.rssMb > 10 && self.swapMb === null, `readStatusViaPs(process.pid) on ${process.platform}: RSS ${self.rssMb} MB, swap null`);
  if (HAS_PROC) {
    const viaProc = parseProcStatus(readFileSync(`/proc/${process.pid}/status`, "utf-8"));
    ok(Math.abs(viaProc.rssMb - self.rssMb) <= 4, `…within 4 MB of /proc/self/status read back-to-back (${viaProc.rssMb} vs ${self.rssMb})`);
  }
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
  // Two sessions made by hand before the cap existed (the prod fleet), both at
  // the server's global limit: hadron-old holds more lines than the cap — the
  // one the row must name; hadron-small holds 50 — uncapped, not advice
  // (a Mac fleet with `set -g history-limit 100000` showed 14 such panes yellow).
  tmuxS(["new-session", "-d", "-s", "hadron-old", "-x", "80", "-y", "24"]);
  tmuxS(["new-session", "-d", "-s", "hadron-small", "-x", "80", "-y", "24"]);
  const globalLimit = Number(tmuxS(["show-options", "-g", "-v", "history-limit"]));
  ok(globalLimit > TMUX_HISTORY_LINES + 200, `the private server's global history-limit (${globalLimit}) is above the cap ${TMUX_HISTORY_LINES}`);
  tmuxS(["send-keys", "-t", "=hadron-old:", `for i in $(seq 1 ${TMUX_HISTORY_LINES + 200}); do echo line $i; done`, "Enter"]);
  tmuxS(["send-keys", "-t", "=hadron-small:", "for i in $(seq 1 50); do echo line $i; done", "Enter"]);
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: H(), body: JSON.stringify({ name: "probe", cwd: WS, launchCommand: "shell", group: "Workers", autostart: false }) });
  ok(r.status === 201, `shell agent created (${r.status}) — the state detector now probes every second`);
  console.log("[history cap on Hadron's sessions]");
  const probeName = `hadron-${WS.split("/").pop()}-probe`;
  const panes = tmuxS(["list-panes", "-t", `=${probeName}:`, "-F", "#{window_index}|#{history_limit}|#{pane_current_path}"]).split("\n");
  ok(panes.length === 1 && panes[0].split("|")[1] === String(TMUX_HISTORY_LINES), `the agent's session has one window, history-limit ${TMUX_HISTORY_LINES} (${panes[0]})`);
  ok(panes[0].split("|")[2] === WS, `the window's cwd is the agent's cwd (${panes[0].split("|")[2]})`);
  ok(tmuxS(["list-windows", "-t", `=${probeName}:`]).split("\n").length === 1, "the placeholder window is gone");
  ok(Number(tmuxS(["show-options", "-g", "-v", "history-limit"])) === globalLimit && globalLimit !== TMUX_HISTORY_LINES, `the global history-limit is untouched (${globalLimit})`);
  ok(Number(tmuxS(["display-message", "-p", "-t", "=hadron-old:", "#{history_limit}"])) === globalLimit, "the hand-made session keeps the global limit");
  ok(tmuxS(["show-environment", "-t", `=${probeName}:`, "HADRON_PORT"]) === `HADRON_PORT=${PORT}`, "the agent env still lands in the capped session");
  tmuxPid = Number(tmuxS(["display-message", "-p", "#{pid}"]));
  ok(Number.isInteger(tmuxPid) && tmuxPid > 0, `private tmux server pid ${tmuxPid}`);
  await sleep(PID_RETRY_MS + 1500); // the pid is asked for once a session exists, at most every PID_RETRY_MS
  let h = await health();
  const t = h.tmux;
  ok(t.level === "ok" && Array.isArray(t.reasons) && t.reasons.length === 0, `health.tmux.level ok, no reasons (${JSON.stringify(t.reasons)})`);
  ok(t.pid === tmuxPid, `health.tmux.pid is the tmux server's pid (${t.pid})`);
  ok(typeof t.latencyMs === "number" && t.latencyMs >= 0 && t.latencyMs < 2000, `latencyMs from the detector's own batch (${t.latencyMs} ms)`);
  ok(typeof t.latencyP95Ms === "number", `latencyP95Ms present (${t.latencyP95Ms} ms)`);
  ok(typeof t.rssMb === "number" && t.rssMb >= 0, `rssMb read (${t.rssMb} MB, via ${HAS_PROC ? "/proc" : "ps"})`);
  ok(HAS_PROC ? typeof t.swapMb === "number" : t.swapMb === null, `swapMb ${HAS_PROC ? "from /proc" : "null without /proc"} (${t.swapMb})`);
  ok(t.memError === null, `memError null (${t.memError})`);
  {
    const viaPs = parseProcStatus(await readStatusViaPs(tmuxPid));
    const ref = HAS_PROC ? parseProcStatus(readFileSync(`/proc/${tmuxPid}/status`, "utf-8")).rssMb : t.rssMb;
    ok(/^Name:\ttmux/m.test(await readStatusViaPs(tmuxPid)) && typeof viaPs.rssMb === "number" && Math.abs(viaPs.rssMb - ref) <= 8, `the ps reader names the real tmux server and agrees on its RSS (${viaPs.rssMb} vs ${ref} MB)`);
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
  ok(t.history && t.history.panes >= 3 && t.history.lines > TMUX_HISTORY_LINES && t.history.overCap === 1 && t.history.overCapLines > TMUX_HISTORY_LINES && t.history.uncapped === 2 && t.history.cap === TMUX_HISTORY_LINES && typeof t.swapGrowthMb !== "undefined", `health.tmux.history: the hand-made hadron-* pane is the one over the cap (${JSON.stringify(t.history)})`);
  ok(trow && /scrollback \d+ lines over \d+ panes \(largest hadron-old: \d+\); 2 Hadron panes have a limit above the \d+-line cap \(allocated before the cap; kept until the session is recreated\)/.test(trow.message), `the green row carries the scrollback inventory and the uncapped count (${trow && trow.message.replace(/^.*scrollback/, "scrollback")})`);
  const hrow = dj && dj.local.find((f) => /^tmux scrollback: /.test(f.message));
  ok(hrow && hrow.level === "yellow" && new RegExp(`1 Hadron pane holds more than the ${TMUX_HISTORY_LINES}-line cap \\(\\d+ lines\\)`).test(hrow.message) && /clear-history/.test(hrow.message) && /keeps its old limit/.test(hrow.message) && /hadron close/.test(hrow.message), `doctor yellow scrollback row with clear-history advice and the durable remedy (${hrow && hrow.message})`);
  // The complaint that motivated the size rule, end to end: following the
  // row's own advice makes the row go away while the pane's limit stays.
  tmuxS(["clear-history", "-t", "=hadron-old:"]);
  ok(Number(tmuxS(["display-message", "-p", "-t", "=hadron-old:", "#{history_limit}"])) === globalLimit, "clear-history leaves the pane's limit where it was");
  let afterClear = null, hrow2 = true;
  for (let i = 0; i < 80 && hrow2; i++) {
    await sleep(500);
    afterClear = (await (await fetch(`${BASE}/api/health`)).json()).tmux;
    if (afterClear.history && afterClear.history.at !== t.history.at) {
      let d2 = null; try { d2 = JSON.parse(doctor("--json").stdout); } catch {}
      hrow2 = (d2 && d2.local.find((f) => /^tmux scrollback: \d+ Hadron pane/.test(f.message))) || null;
    }
  }
  ok(afterClear && afterClear.history && afterClear.history.overCap === 0 && afterClear.history.uncapped === 2, `after the clear the pane is no longer over the cap and the uncapped count is unchanged (${JSON.stringify(afterClear && afterClear.history)})`);
  ok(hrow2 === null, "…and the yellow scrollback row is gone — the row can be cleared by its own advice");

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
  { // RSS is read on every platform now (/proc or ps)
    serverLog = "";
    await boot({ HADRON_TMUX_WARN_RSS_MB: "1", HADRON_TMUX_HISTORY_LINES: "0" });
    TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
    const r0 = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: H(), body: JSON.stringify({ name: "uncapped", cwd: WS, launchCommand: "shell", group: "Workers", autostart: false }) });
    const p0 = tmuxS(["list-panes", "-t", `=hadron-${WS.split("/").pop()}-uncapped:`, "-F", "#{history_limit}"]);
    ok(r0.status === 201 && Number(p0) === globalLimit, `HADRON_TMUX_HISTORY_LINES=0 leaves the session at the global limit (${p0})`);
    h = await waitLevel("warn", 10000);
    ok(h.tmux.level === "warn" && h.tmux.reasons.some((r) => /^RSS \d+ MB \(warn from 1 MB\)/.test(r)), `warn with an RSS reason (${JSON.stringify(h.tmux.reasons)})`);
    ok(h.tmux.warnRssMb === 1, "warnRssMb on the payload");
    await sleep(1500); // a probe or two, so p95 is a number
    d = doctor("--json");
    dj = null; try { dj = JSON.parse(d.stdout); } catch {}
    const warn = dj && dj.local.find((f) => /^tmux is degraded since/.test(f.message));
    ok(warn && warn.level === "yellow" && /RSS \d+ MB \+ \d+ MB swap, p95 \d+ ms/.test(warn.message) && /ntfy alerts off \(View/.test(warn.message), `doctor yellow "tmux is degraded" row names RSS/swap/p95 and the alert setting (${warn && warn.message})`);
    ok(warn && /paging: close finished agents/.test(warn.message) && !(dj.local.some((f) => /^tmux scrollback: /.test(f.message))), "with the cap off nothing is 'over the cap': no clear-history hint, no scrollback row");
    ok(d.status === 0, "a yellow tmux row does not fail doctor (exit 0)");
    const dt = doctor();
    ok(/tmux is degraded/.test(dt.stdout) && !dt.stdout.includes(TOPIC), "text doctor shows the row, no topic");
    ok(pushes.length === 2, `no push: alerts are off in this workspace (${pushes.length})`);
    await stopServer();
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
