/**
 * Perf log (server/perf-log.js) + `hadron perf`.
 *
 * Prod 2026-10-05: tmux had been crawling for hours before the crash and
 * nobody could say since when. The server now appends one JSON line per
 * sample to <ws>/.hadron/logs/perf.jsonl — every /api request (route template,
 * status, ms), tmux calls over 500 ms, terminal connect → first byte — rotates
 * it by local day and keeps 7 files; `hadron perf [--since 1h]` reads p50/p95.
 *
 *   - pure: createPerfLog buffers + flushes, rotates perf.jsonl → perf-<day>.jsonl
 *     on a day change (clock injected), prunes beyond keepDays, holds lines
 *     (bounded) while the dir is unwritable and warns once; summarizePerf
 *     groups by route/cmd with p50/p95/max/5xx/timeouts; parseSince grammar
 *   - live: a throwaway server → perf.jsonl has http lines with the route
 *     TEMPLATE for /api/sessions/:id (no query string, no token), an
 *     "(unmatched)" line for a 404 path, a ws line for a terminal connect with
 *     a non-negative ms, a tmux line when a call is forced slow; `hadron perf`
 *     prints the tables, --json carries the numbers, --since rejects garbage;
 *     doctor's perfLog status is ok; SIGTERM flushes the buffer
 *   - browser samples (client/perf.js → POST /api/perf/client, kind "ui"):
 *     validateClientPerf allowlists ev/view/agent/marks/scripts/items, drops an
 *     event without a valid ev/ms, clamps nothing silently (out of range → dropped),
 *     dates by `ago`; summarizePerf.ui = freeze stats + total, causes by mark
 *     ("(nothing marked)" for the rest), worst 5, switch per view, chat load;
 *     live: 401 without token, 400 on shape, lines land, `hadron perf` prints
 *     the freeze section
 *
 * Run: node test/unit/test-perf-log.js
 */
import "./hadron-home.js";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { createPerfLog, summarizePerf, parseSince, localDay, MAX_QUEUE, validateClientPerf, UI_MAX_EVENTS } from "../../server/perf-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const CLI = join(REPO, "bin", "hadron.js");
const PORT = 7700 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── pure ──────────────────────────────────────────────────────────────────
console.log("[parseSince]");
ok(parseSince(undefined) === 3600_000 && parseSince("") === 3600_000, "default 1h");
ok(parseSince("30m") === 1800_000 && parseSince("2d") === 172_800_000 && parseSince("90s") === 90_000 && parseSince("1.5h") === 5400_000, "s/m/h/d units");
ok(parseSince("all") === Infinity, "all → Infinity");
ok(parseSince("yesterday") === null && parseSince("5") === null && parseSince("-1h") === null, "garbage → null");

console.log("[createPerfLog: buffer, flush, rotate, prune]");
{
  const dir = mkdtempSync(join(tmpdir(), "hadron-perf-"));
  let clock = Date.parse("2026-10-05T10:00:00Z");
  const warnings = [];
  const log = createPerfLog({ dir: join(dir, "logs"), keepDays: 3, now: () => clock, flushMs: 10, log: { warn: (m) => warnings.push(m), log: (m) => warnings.push(m) } });
  log.record("http", { method: "GET", route: "/api/sessions", status: 200, ms: 12.3 });
  ok(!existsSync(join(dir, "logs", "perf.jsonl")), "nothing on disk before the flush");
  log.flush();
  const lines = readFileSync(join(dir, "logs", "perf.jsonl"), "utf-8").trim().split("\n");
  ok(lines.length === 1 && JSON.parse(lines[0]).t === "2026-10-05T10:00:00.000Z" && JSON.parse(lines[0]).kind === "http" && JSON.parse(lines[0]).ms === 12.3, `one JSON line with t/kind/fields (${lines[0]})`);
  ok(log.status().ok && log.status().lines === 1, "status ok, 1 line");
  // day change → rotate
  const day1 = localDay(clock);
  clock += 86_400_000;
  log.record("tmux", { cmd: "list-panes", ms: 900, timedOut: false });
  log.flush();
  const files = () => readdirSync(join(dir, "logs")).sort();
  ok(files().includes(`perf-${day1}.jsonl`) && files().includes("perf.jsonl"), `rotated to perf-${day1}.jsonl, new perf.jsonl (${files()})`);
  ok(readFileSync(join(dir, "logs", "perf.jsonl"), "utf-8").includes('"kind":"tmux"') && readFileSync(join(dir, "logs", `perf-${day1}.jsonl`), "utf-8").includes('"kind":"http"'), "the old day's lines are in the rotated file, the new day's in the live one");
  // two more days → the oldest rotated file is pruned (keepDays 3 = live + 2 rotated)
  for (let i = 0; i < 2; i++) { clock += 86_400_000; log.record("ws", { agent: "a", shell: null, ms: 5 }); log.flush(); }
  const rotated = files().filter((f) => f.startsWith("perf-"));
  ok(rotated.length === 2 && !rotated.includes(`perf-${day1}.jsonl`), `keepDays 3 → 2 rotated files, the oldest gone (${rotated})`);
  // timer-driven flush
  log.record("ws", { agent: "a", shell: "sh1", ms: 7 });
  await sleep(60);
  ok(readFileSync(join(dir, "logs", "perf.jsonl"), "utf-8").includes('"shell":"sh1"'), "the timer flushes without an explicit call");
  // summarize across live + rotated with --since
  let sum = summarizePerf({ dir: join(dir, "logs"), sinceMs: Infinity, now: clock });
  // day1's http line left with its pruned file; day2's tmux line and the three ws lines remain
  ok(sum.samples === 4 && sum.http.length === 0 && sum.tmux.length === 1 && sum.ws.n === 3, `summarize(all) sees every kept file (${sum.samples} samples: http ${sum.http.length}, tmux ${sum.tmux.length}, ws ${sum.ws.n})`);
  sum = summarizePerf({ dir: join(dir, "logs"), sinceMs: 3600_000, now: clock });
  ok(sum.samples === 2 && sum.ws.n === 2 && sum.http.length === 0, `summarize(1h) keeps only the last hour (${sum.samples})`);
  // unwritable dir: lines held, one warning, recovers
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(join(dir, "logs", "perf.jsonl"), 0o400);
    log.record("ws", { agent: "a", shell: null, ms: 1 }); log.flush();
    log.record("ws", { agent: "a", shell: null, ms: 2 }); log.flush();
    const st = log.status();
    ok(!st.ok && st.error === "EACCES" && st.queued === 2, `unwritable dir → status {ok:false, error:EACCES}, lines held (${JSON.stringify(st)})`);
    ok(warnings.filter((w) => /\[perf\] writing .* failed \(EACCES\)/.test(w)).length === 1, "warned once");
    chmodSync(join(dir, "logs", "perf.jsonl"), 0o600);
    log.flush();
    ok(log.status().ok && log.status().queued === 0 && readFileSync(join(dir, "logs", "perf.jsonl"), "utf-8").includes('"ms":2'), "writable again → the held lines land, status ok");
    ok(warnings.some((w) => /writable again/.test(w)), "says so");
  }
  // bounded queue
  const log2 = createPerfLog({ dir: join(dir, "nope", "x"), now: () => clock, flushMs: 100000, log: { warn() {}, log() {} } });
  chmodSync(dir, 0o500);
  for (let i = 0; i < MAX_QUEUE + 10; i++) log2.record("ws", { agent: "a", shell: null, ms: i });
  ok(log2.status().queued === MAX_QUEUE && log2.status().dropped > 0, `queue capped at ${MAX_QUEUE}, drops counted (${log2.status().dropped})`);
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
}
console.log("[summarizePerf: percentiles + grouping]");
{
  const dir = mkdtempSync(join(tmpdir(), "hadron-perf-"));
  mkdirSync(join(dir, "logs"));
  const now = Date.parse("2026-10-05T12:00:00Z");
  const L = [];
  for (let i = 1; i <= 100; i++) L.push({ t: new Date(now - i * 1000).toISOString(), kind: "http", method: "GET", route: "/api/sessions", status: i === 7 ? 500 : 200, ms: i });
  L.push({ t: new Date(now - 5000).toISOString(), kind: "http", method: "POST", route: "/api/sessions/:id/message", status: 409, ms: 3 });
  L.push({ t: new Date(now - 5000).toISOString(), kind: "tmux", cmd: "list-panes", ms: 2005, timedOut: true });
  L.push({ t: new Date(now - 4000).toISOString(), kind: "tmux", cmd: "list-panes", ms: 700, timedOut: false });
  L.push({ t: new Date(now - 4000).toISOString(), kind: "tmux", cmd: "has-session", ms: 5005, timedOut: true });
  L.push({ t: "not a date", kind: "http", method: "GET", route: "/x", status: 200, ms: 1 });
  writeFileSync(join(dir, "logs", "perf.jsonl"), L.map((o) => JSON.stringify(o)).join("\n") + "\n{garbage\n");
  const sum = summarizePerf({ dir: join(dir, "logs"), sinceMs: 3600_000, now });
  const get = sum.http.find((r) => r.route === "/api/sessions");
  ok(get && get.n === 100 && get.p50 === 51 && get.p95 === 96 && get.max === 100 && get.errors === 1, `GET /api/sessions n=100 p50=51 p95=96 max=100 5xx=1 (${JSON.stringify(get)})`);
  ok(sum.http[0].route === "/api/sessions" && sum.http[1].route === "/api/sessions/:id/message" && sum.http[1].n === 1, "routes sorted by count");
  const lp = sum.tmux.find((r) => r.cmd === "list-panes");
  ok(lp && lp.n === 2 && lp.timeouts === 1 && lp.max === 2005 && sum.tmux.length === 2, `tmux grouped by command with timeouts (${JSON.stringify(lp)})`);
  ok(sum.malformed === 1 && sum.samples === 104, `one malformed line skipped, an undated line ignored (${sum.malformed}, ${sum.samples})`);
  ok(sum.ws.n === 0 && sum.ws.p50 === null, "no ws samples → n 0, nulls");
  rmSync(dir, { recursive: true, force: true });
}

// ── live ──────────────────────────────────────────────────────────────────
const WS = mkdtempSync(join(tmpdir(), "hadron-perf-live-"));
mkdirSync(join(WS, ".hadron"), { recursive: true });
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({ name: "perf", groups: ["Workers"] }));
const PERF = join(WS, ".hadron", "logs", "perf.jsonl");
let server = null, serverLog = "";
async function boot(env = {}) {
  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", TMUX: "", HADRON_TMUX_SOCKET: join(WS, "tmux.sock"), ...env },
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
async function stopServer(signal = "SIGTERM") {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((r) => server.once("exit", r));
  server.kill(signal);
  await Promise.race([gone, sleep(5000)]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await gone; }
}
let TOKEN = "";
const H = () => ({ "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: BASE });
const perfLines = () => (existsSync(PERF) ? readFileSync(PERF, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
console.log("[validateClientPerf]");
{
  const now = Date.parse("2026-11-15T12:00:00Z");
  ok(validateClientPerf(null).error && validateClientPerf({ events: "x" }).error, "no events array → error");
  ok(/at most/.test(validateClientPerf({ events: Array(UI_MAX_EVENTS + 1).fill({ ev: "freeze", ms: 1 }) }).error || ""), `more than ${UI_MAX_EVENTS} → error`);
  const v = validateClientPerf({ events: [
    { ev: "freeze", ms: 812.6, ago: 3000, view: "chat", agent: "astra-1", marks: ["chat items", "chat items", "<img onerror=x>", "bad\nline", "arbitrary secret words", "a".repeat(64)], scripts: ["chatApplyItems@chat.js", "https://h/?token=abc", "f@" + "0123456789abcdef".repeat(4) + ".js", "x y@app.js"], items: 3, extra: "dropped" },
    { ev: "nope", ms: 1 }, { ev: "freeze", ms: -1 }, { ev: "freeze", ms: "5" }, { ev: "freeze", ms: 700_000 }, { ev: "switch", ms: NaN },
    { ev: "switch", ms: 40, view: "bogus", agent: "0123456789abcdef".repeat(4), ago: 9e9 },
  ] }, now, (id) => id === "astra-1");
  ok(v.events.length === 2, `invalid ev / ms dropped whole (${v.events.length} kept)`);
  const [f, sw] = v.events;
  ok(f.ms === 813 && f.t === new Date(now - 3000).toISOString() && f.view === "chat" && f.agent === "astra-1" && f.items === 3 && !("extra" in f) && !("ago" in f), `freeze: ms rounded, dated by ago, allowlisted keys only (${JSON.stringify(f)})`);
  ok(JSON.stringify(f.marks) === JSON.stringify(["chat items"]) && JSON.stringify(f.scripts) === JSON.stringify(["chatApplyItems@chat.js"]), `labels de-duplicated, marks outside the app's list and a URL / token-shaped / spaced script dropped (${JSON.stringify([f.marks, f.scripts])})`);
  ok(sw.view === undefined && sw.agent === undefined && sw.t === new Date(now).toISOString(), "bad view / an agent that does not exist (a token-shaped id) dropped per field, out-of-range ago → now");
}
console.log("[summarizePerf: ui]");
{
  const dir = mkdtempSync(join(tmpdir(), "hadron-perf-"));
  const now = Date.parse("2026-11-15T12:00:00Z");
  const t = (s) => new Date(now - s * 1000).toISOString();
  const L = [
    { t: t(50), kind: "ui", ev: "freeze", ms: 300, marks: ["chat items"] },
    { t: t(40), kind: "ui", ev: "freeze", ms: 2500, marks: ["switch", "chat items"], scripts: ["render@app.js"], view: "chat", agent: "a1" },
    { t: t(30), kind: "ui", ev: "freeze", ms: 250 },
    { t: t(20), kind: "ui", ev: "switch", ms: 120, view: "chat" }, { t: t(19), kind: "ui", ev: "switch", ms: 80, view: "chat" }, { t: t(18), kind: "ui", ev: "switch", ms: 30, view: "terminal" },
    { t: t(10), kind: "ui", ev: "chatload", ms: 400, items: 200 },
  ];
  writeFileSync(join(dir, "perf.jsonl"), L.map((o) => JSON.stringify(o)).join("\n") + "\n");
  const ui = summarizePerf({ dir, sinceMs: 3600_000, now }).ui;
  ok(ui.freezes.n === 3 && ui.freezes.totalMs === 3050 && ui.freezes.max === 2500, `freeze stats + total (${JSON.stringify(ui.freezes)})`);
  ok(ui.causes[0].label === "chat items" && ui.causes[0].n === 2 && ui.causes[0].ms === 2800 && ui.causes.some((c) => c.label === "script render@app.js") && ui.causes.some((c) => c.label === "(nothing marked)" && c.n === 1), `causes ranked by frozen ms, scripts prefixed, the unmarked counted (${JSON.stringify(ui.causes)})`);
  ok(ui.worst[0].ms === 2500 && ui.worst[0].agent === "a1" && ui.worst[0].view === "chat" && ui.worst.length === 3, "worst freezes first, with view + agent");
  ok(ui.switches[0].view === "chat" && ui.switches[0].n === 2 && ui.switches[1].view === "terminal", "switch latency per view, by count");
  ok(ui.chatload.n === 1 && ui.chatload.max === 400, "chat load stats");
  rmSync(dir, { recursive: true, force: true });
}

const cli = (...args) => spawnSync("node", [CLI, ...args], { cwd: WS, env: { ...process.env, HADRON_PORT: String(PORT), HADRON_TOKEN: TOKEN }, encoding: "utf-8", timeout: 30000 });

try {
  console.log("[live server]");
  await boot();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: H(), body: JSON.stringify({ name: "perfy", cwd: WS, launchCommand: "shell", group: "Workers", autostart: false }) });
  ok(r.status === 201, `shell agent created (${r.status})`);
  const id = (await r.json()).id;
  await fetch(`${BASE}/api/sessions/${id}/changes?token=${TOKEN}&q=secret-query`, { headers: H() });
  await fetch(`${BASE}/api/no-such-thing`, { headers: H() });
  await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: "{}" }); // 401 — no token
  // terminal connect → first byte
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}&token=${encodeURIComponent(TOKEN)}&cols=80&rows=24`);
  await new Promise((res, rej) => { ws.on("message", () => res()); ws.on("error", rej); setTimeout(() => rej(new Error("no first byte")), 10000); });
  ws.close();
  await sleep(1500); // > FLUSH_MS
  let lines = perfLines();
  const http = lines.filter((l) => l.kind === "http");
  ok(http.some((l) => l.method === "GET" && l.route === "/api/sessions/:id/changes" && l.status === 200 && typeof l.ms === "number"), `http line with the ROUTE TEMPLATE /api/sessions/:id/changes (${JSON.stringify(http.find((l) => /:id/.test(l.route)))})`);
  ok(!JSON.stringify(lines).includes(TOKEN) && !JSON.stringify(lines).includes("secret-query") && !JSON.stringify(http).includes(id), "no token, no query string, no agent id on an http line");
  ok(http.every((l) => /^\/api\/|^\(unmatched\)$/.test(l.route) && !l.route.startsWith("/api/api")), "routes are /api/... exactly once");
  ok(http.some((l) => l.route === "(unmatched)" && l.status === 404), "a 404 path is logged as (unmatched), not echoed");
  ok(http.some((l) => l.route === "(unmatched)" && l.status === 401), "a refused (401) request is (unmatched) too");
  ok(http.some((l) => l.method === "POST" && l.route === "/api/sessions" && l.status === 201), "POST /api/sessions 201 logged");
  const wsl = lines.find((l) => l.kind === "ws");
  ok(wsl && wsl.agent === id && wsl.shell === null && typeof wsl.ms === "number" && wsl.ms >= 0 && wsl.ms < 10000, `ws line: agent + connect→first byte ms (${JSON.stringify(wsl)})`);
  ok(lines.every((l) => typeof l.t === "string" && !Number.isNaN(Date.parse(l.t))), "every line has an ISO t");
  ok(/^\{"t":/.test(readFileSync(PERF, "utf-8")), "lines are compact JSON, t first");
  ok(existsSync(PERF) && readdirSync(join(WS, ".hadron", "logs")).includes("perf.jsonl"), "lives at .hadron/logs/perf.jsonl");

  console.log("[hadron perf]");
  let p = cli("perf");
  ok(p.status === 0 && /^hadron perf — last 1h: \d+ samples/.test(p.stdout), `hadron perf prints the header (${p.stdout.split("\n")[0]})`);
  ok(/API latency \(ms\)\n\s+route\s+n\s+p50\s+p95\s+max\s+5xx\n/.test(p.stdout) && /GET \/api\/sessions\/:id\/changes\s+1\s+\d+\s+\d+\s+\d+\s+0/.test(p.stdout), "API table with the route row");
  ok(/terminal connect → first byte \(ms\)\n[^\n]*\n\s+all terminals\s+1\s+\d+/.test(p.stdout), "terminal table with one connect");
  ok(/tmux calls slower than 500 ms: none/.test(p.stdout), "no slow tmux calls → 'none'");
  p = cli("perf", "--json", "--since", "10m");
  let j = null; try { j = JSON.parse(p.stdout); } catch {}
  ok(p.status === 0 && j && j.sinceMs === 600_000 && j.http.some((r) => r.route === "/api/sessions/:id/changes") && j.ws.n === 1, "--json --since 10m carries the numbers");
  p = cli("perf", "--since", "yesterday");
  ok(p.status === 1 && /--since: use <n>s\|m\|h\|d/.test(p.stderr + p.stdout), "--since garbage → exit 1 with the grammar");
  p = cli("perf", "--since", "1s");
  await sleep(0);
  ok(p.status === 0 && /^hadron perf — last 1s: (\d+ samples|no samples)/.test(p.stdout), `--since 1s runs with the 1s span label (${p.stdout.split("\n")[0]})`);
  p = cli("perf", "--since");
  ok(p.status === 0 && /^hadron perf — last 1h: /.test(p.stdout), `a bare --since means 1h, labelled 1h (${p.stdout.split("\n")[0]})`);
  p = cli("perf", "--help");
  ok(p.status === 0 && /hadron perf \[--since/.test(p.stdout), "--help documents it");
  const d = cli("doctor", "--json");
  let dj = null; try { dj = JSON.parse(d.stdout); } catch {}
  ok(dj && dj.doctor && dj.doctor.perfLog && dj.doctor.perfLog.ok === true && dj.doctor.perfLog.lines > 0, `doctor payload perfLog ok with lines (${JSON.stringify(dj && dj.doctor && dj.doctor.perfLog)})`);
  ok(!dj.local.some((f) => /perf log/.test(f.message)), "no perf-log doctor row while it is written");

  console.log("[browser samples → ui lines]");
  let u = await fetch(`${BASE}/api/perf/client`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ events: [{ ev: "freeze", ms: 900 }] }) });
  ok(u.status === 401, `POST /api/perf/client without the token → 401 (${u.status})`);
  u = await fetch(`${BASE}/api/perf/client`, { method: "POST", headers: H(), body: JSON.stringify({ events: {} }) });
  ok(u.status === 400, `events not an array → 400 (${u.status})`);
  u = await fetch(`${BASE}/api/perf/client`, { method: "POST", headers: H(), body: JSON.stringify({ events: [
    { ev: "freeze", ms: 1234, ago: 2000, view: "chat", agent: id, marks: ["chat items"], scripts: ["chatApplyItems@chat.js"] },
    { ev: "switch", ms: 95, view: "terminal", agent: id }, { ev: "chatload", ms: 310, items: 12 }, { ev: "nope", ms: 1 },
  ] }) });
  ok(u.status === 200 && (await u.json()).recorded === 3, "three valid events recorded, the fourth dropped");
  await sleep(1500);
  const uiLines = perfLines().filter((l) => l.kind === "ui");
  ok(uiLines.length === 3 && uiLines.some((l) => l.ev === "freeze" && l.ms === 1234 && l.agent === id && l.marks[0] === "chat items"), `ui lines in perf.jsonl (${JSON.stringify(uiLines[0])})`);
  p = cli("perf");
  ok(/page freezes \(main thread blocked ≥ 200 ms\): 1, 1\.2 s frozen in all/.test(p.stdout) && /what the page was doing when it froze\n[^\n]*\n\s+chat items\s+1\s+1234/.test(p.stdout), "hadron perf: freeze count, total, causes table");
  ok(/worst freezes\n[^\n]*\n\s+\d{4}-\d\d-\d\d [\d:]+\s+1234\s+chat\s+\S+\s+chat items, chatApplyItems@chat\.js/.test(p.stdout), "worst freezes row with view, agent, marks + scripts");
  ok(/agent switch → next frame \(ms\)\n[^\n]*\n\s+terminal\s+1\s+95/.test(p.stdout) && /chat opened → first items drawn \(ms\)\n[^\n]*\n\s+all chats\s+1\s+310/.test(p.stdout), "switch + chat load tables");

  console.log("[slow tmux call → tmux line]");
  // Freeze the private tmux server: the detector's list-panes (2-s timeout) is
  // the slow call; the server records it as a tmux line with timedOut.
  const tmuxPid = Number(spawnSync("tmux", ["-S", join(WS, "tmux.sock"), "display-message", "-p", "#{pid}"], { encoding: "utf-8", env: { ...process.env, TMUX: "" } }).stdout);
  // Never signal without a real pid: process.kill(0, …) would SIGSTOP this whole process group.
  if (!Number.isInteger(tmuxPid) || tmuxPid <= 1) throw new Error("private tmux server pid unknown — refusing to signal");
  process.kill(tmuxPid, "SIGSTOP");
  await sleep(3500);
  process.kill(tmuxPid, "SIGCONT");
  await sleep(1500);
  lines = perfLines();
  const tl = lines.find((l) => l.kind === "tmux");
  ok(tl && tl.cmd === "list-panes" && tl.ms >= 500 && tl.timedOut === true, `tmux line: cmd + ms + timedOut (${JSON.stringify(tl)})`);
  ok(!JSON.stringify(lines.filter((l) => l.kind === "tmux")).includes("-F"), "the tmux line carries the subcommand, not the argv");
  p = cli("perf");
  ok(/tmux calls slower than 500 ms\n\s+command\s+n\s+p50\s+p95\s+max\s+timed out\n\s+list-panes\s+\d+\s+\d+\s+\d+\s+\d+\s+[1-9]/.test(p.stdout), "hadron perf shows the slow tmux table with the timeout count");

  console.log("[SIGTERM flushes]");
  await fetch(`${BASE}/api/health`);
  const before = perfLines().length;
  await sleep(50);
  await stopServer("SIGTERM");
  const after = perfLines().length;
  ok(after > before, `the buffered samples are on disk after SIGTERM (${before} → ${after})`);
  ok(!serverLog.includes(TOKEN), "no token in the server log");
} catch (e) {
  failed++;
  console.error(`  ✗ unexpected error: ${e.stack || e}\n  server log tail:\n${serverLog.slice(-2000)}`);
} finally {
  await stopServer("SIGKILL");
  try { spawnSync("tmux", ["-S", join(WS, "tmux.sock"), "kill-server"], { env: { ...process.env, TMUX: "" } }); } catch {}
  rmSync(WS, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
