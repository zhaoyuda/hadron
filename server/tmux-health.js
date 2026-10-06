// tmux server health, from what the server already does.
//
// Prod 2026-10-05: the tmux server had grown to 5.6 GB RSS + 1.2 GB swap (76
// panes, 171k lines of history) and was paging; every tmux call took seconds,
// two timed out in a row and the server crashed (fixed in tmux.js/index.js).
// Nobody saw it coming because nothing watched tmux itself. This module does,
// without a single extra tmux spawn: the state detector already runs one
// `list-panes -a` per second for ALL agents — its wall time IS the latency
// probe (noteProbe). Memory is read from /proc/<pid>/status (VmRSS, VmSwap)
// every PROC_INTERVAL_MS, a file read, no process. macOS has no /proc (decided
// once at boot, not per read — 2026-10-06: every read there threw ENOENT, which
// was taken for "pid gone", so the pid was re-asked of tmux every 5 s forever
// and memory never read): RSS comes from one `ps -o rss=,comm= -p <pid>` per
// sample instead, comm doubling as the pid-reuse check; swap stays null there
// (not a per-process figure on macOS) so only RSS is judged.
//
// It never kills, restarts or resizes anything: the verdict goes to
// /api/health.tmux, a topbar pill, a `hadron doctor` row and — opt-in, default
// off — one ntfy push per state change (rate-limited). The operator decides.
import { readFileSync, existsSync } from "fs";
import { execFile } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { tmuxSafeAsync, TMUX_SLOW_MS, TMUX_HISTORY_LINES } from "./tmux.js";

export const PROC_INTERVAL_MS = 30_000;
export const PID_RETRY_MS = 5_000;        // how often an unknown tmux pid is asked for again
export const WINDOW = 60;                 // probes judged (≈ 60 s at one per second)
export const SLOW_PROBES_WARN = 3;        // this many slow probes in the window → warn
export const FAIL_PROBES_DOWN = 3;        // this many failed/timed-out probes IN A ROW → down
export const RECENT_MS = 60_000;          // "recent" failures count only this far back
export const NTFY_MIN_INTERVAL_MS = 30 * 60_000; // at most one push per level change per half hour
// An unset or malformed override keeps the default; 0 switches that half off.
const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? d : Number(v));
export const WARN_RSS_MB = num(process.env.HADRON_TMUX_WARN_RSS_MB, 2048);
// Swap is judged by GROWTH, not by the figure: pages tmux pushed out during
// an old peak stay out (prod 2026-10-06: 3.9 GB swapped, 387 MB RSS, nothing
// paging, 16 GB free) and only cost something if they are ever touched again.
// Swap that is RISING is tmux being pushed out right now — that is the alarm.
export const WARN_SWAP_MB = num(process.env.HADRON_TMUX_WARN_SWAP_MB, 512);
// …and a high absolute ceiling beside it: a tmux that pages out slowly
// (+100 MB/h for days) never trips the growth rule, and swapped-out pages
// are not RSS, so without this it would read ok forever.
export const SWAP_CEILING_MB = num(process.env.HADRON_TMUX_SWAP_CEILING_MB, 4096);
export const SWAP_WINDOW_MS = 60 * 60_000;  // growth is measured against the lowest sample this far back
export const MEM_SAMPLES = Math.ceil(SWAP_WINDOW_MS / PROC_INTERVAL_MS) + 1;

// Pure: the verdict from the samples. Exported for the unit test.
export function judge({ probes, rssMb, swapGrowthMb, swapMb, now = Date.now(), slowMs = TMUX_SLOW_MS, warnRssMb = WARN_RSS_MB, warnSwapMb = WARN_SWAP_MB, swapCeilingMb = SWAP_CEILING_MB }) {
  const recent = probes.filter((p) => now - p.at <= RECENT_MS);
  // "down" is the TRAILING run of failures: the first probe that answers
  // again ends it at once (recovery must not wait for the window to drain);
  // "warn" counts slow probes over the whole window — hysteresis is wanted there.
  let failed = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i].failed; i--) failed++;
  const slow = recent.filter((p) => !p.failed && p.ms > slowMs).length;
  const reasons = [];
  let level = "ok";
  if (failed >= FAIL_PROBES_DOWN) {
    // Killed at the timeout = tmux is not answering (paging, wedged); refused
    // at once = there is no tmux server to answer (killed by hand, crashed).
    const tail = recent.slice(-failed);
    const timedOut = tail.filter((p) => p.timedOut).length;
    const kind = timedOut === failed ? "timed out" : timedOut === 0 ? "were refused at once (no tmux server?)" : "failed or timed out";
    level = "down"; reasons.push(`the last ${failed} pane probes ${kind}`);
  }
  else if (slow >= SLOW_PROBES_WARN) { level = "warn"; reasons.push(`${slow} of the last ${recent.length} pane probes took over ${slowMs} ms`); }
  if (warnRssMb > 0 && typeof rssMb === "number" && rssMb >= warnRssMb) { if (level === "ok") level = "warn"; reasons.push(`RSS ${rssMb} MB (warn from ${warnRssMb} MB)`); }
  if (warnSwapMb > 0 && typeof swapGrowthMb === "number" && swapGrowthMb >= warnSwapMb) { if (level === "ok") level = "warn"; reasons.push(`swap grew ${swapGrowthMb} MB in the last hour, ${swapMb} MB out now (warn from ${warnSwapMb} MB of growth)`); }
  else if (swapCeilingMb > 0 && typeof swapMb === "number" && swapMb >= swapCeilingMb) { if (level === "ok") level = "warn"; reasons.push(`${swapMb} MB swapped out (ceiling ${swapCeilingMb} MB)`); }
  return { level, reasons, slowProbes: slow, failedProbes: failed, probesJudged: recent.length };
}

// Pure: /proc/<pid>/status text → { rssMb, swapMb } (null fields when absent).
// /proc is a Linux thing; decided once, not per read.
export const HAS_PROC = existsSync("/proc/self/status");

// The ps-based reader for a host without /proc: returns the same shape as a
// /proc status text (Name + VmRSS, no VmSwap) so one parser serves both. A pid
// that is gone makes ps exit 1 (a numeric code) with no line → ENOENT, like
// the /proc read; ps itself failing — timed out (killed), not spawnable (a
// string code / syscall) — is NOT "pid gone": that would drop the pid and the
// swap baseline and spend a tmux spawn on a server that is already slow.
export function readStatusViaPs(pid, { exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec("ps", ["-o", "rss=,comm=", "-p", String(pid)], { timeout: 5000 }, (err, stdout) => {
      // trim() BEFORE split: the first line is left-padded for narrow values.
      const line = String(stdout || "").trim().split("\n")[0] || "";
      const m = line.match(/^(\d+)\s+(\S.*)$/);
      if (!m) {
        const psFailed = err && (err.killed || err.syscall || typeof err.code === "string");
        const e = new Error(psFailed ? `ps failed: ${err.signal || err.code}` : `ps -p ${pid}: no such process`);
        e.code = psFailed ? "EPS" : "ENOENT";
        return reject(e);
      }
      const name = m[2].split("/").pop();   // macOS prints the executable path
      resolve(`Name:\t${name}\nVmRSS:\t${Number(m[1])} kB\n`);
    });
  });
}

export function parseProcStatus(text) {
  const kb = (key) => { const m = String(text || "").match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m")); return m ? Number(m[1]) : null; };
  const rss = kb("VmRSS"), swap = kb("VmSwap");
  return { rssMb: rss === null ? null : Math.round(rss / 1024), swapMb: swap === null ? null : Math.round(swap / 1024) };
}

// Pure: `list-panes -a -F '#{session_name}|#{history_size}|#{history_limit}'`
// → what the server's memory is made of. `overCap` counts Hadron's own panes
// whose grid was allocated before the cap existed (their limit is above it):
// the ones `tmux clear-history` would shrink; other sessions on the shared
// server are counted in the totals and left alone.
export function parseHistory(text, cap, prefix = "hadron-") {
  let panes = 0, lines = 0, overCap = 0, overCapLines = 0, largest = null;
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^(.*)\|(\d+)\|(\d+)$/);
    if (!m) continue;
    const name = m[1], size = Number(m[2]), limit = Number(m[3]);
    panes++; lines += size;
    const ours = name.startsWith(prefix);
    if (cap > 0 && ours && limit > cap) { overCap++; overCapLines += size; }
    // The name goes on the OPEN /api/health: only Hadron's own (agent ids are
    // public there already) — the operator's other sessions stay nameless.
    if (!largest || size > largest.lines) largest = { session: ours ? name : null, lines: size, limit };
  }
  return { panes, lines, overCap, overCapLines, largest, cap, at: null };
}

function p95(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

export function createTmuxHealth({
  readStatus = HAS_PROC ? (pid) => readFileSync(`/proc/${pid}/status`, "utf-8") : readStatusViaPs,
  resolvePid = async () => { const out = await tmuxSafeAsync(["display-message", "-p", "#{pid}"]); const n = Number(out); return Number.isInteger(n) && n > 0 ? n : null; },
  listHistory = () => tmuxSafeAsync(["list-panes", "-a", "-F", "#{session_name}|#{history_size}|#{history_limit}"]),
  historyCap = TMUX_HISTORY_LINES,
  now = Date.now,
  notify = null,              // (event: {level, previous, reasons, summary}) => void — the ntfy sender
  isNotifyEnabled = () => false,
  log = console,
} = {}) {
  const probes = [];          // { at, ms, failed, timedOut }
  let pid = null;
  let mem = { rssMb: null, swapMb: null, sampledAt: null, error: null };
  const memSamples = [];      // { at, swapMb } — the last hour, for the growth figure
  let history = null;         // parseHistory() of the last inventory, null until one succeeded
  let level = "ok";
  let reasons = [];
  let since = null;           // when the current level began
  let lastNotifiedAt = 0, lastNotifiedLevel = null;
  let timer = null;

  function noteProbe(ms, failed = false, timedOut = failed) {
    probes.push({ at: now(), ms, failed: !!failed, timedOut: !!failed && !!timedOut });
    if (probes.length > WINDOW) probes.splice(0, probes.length - WINDOW);
    evaluate();
    // The pid is unknown until tmux has a session (boot before the first agent,
    // or tmux restarted): an answered probe means it can be asked now — at
    // most once per PID_RETRY_MS, never while it is not answering.
    if (pid === null && !failed && !sampling && now() - lastResolveAt >= PID_RETRY_MS) sampleMemory();
  }

  let sampling = false, lastResolveAt = 0, lastPid = null;
  async function sampleMemory() {
    if (sampling) return;
    sampling = true;
    try {
      await readMemory();
      // What the memory is made of: one list-panes per sample (≈ 9 ms for 100
      // panes), after the verdict so a stalled tmux cannot delay it — and not
      // at all while tmux is not answering (one more client queued on a
      // stalled server every 30 s, each a counted timeout) or has no session.
      if (level === "down" || pid === null) return;
      const out = await listHistory();
      if (out !== null) history = { ...parseHistory(out, historyCap), at: new Date(now()).toISOString() };
    } catch {} finally { sampling = false; }
  }
  async function readMemory() {
    try {
      if (pid === null) {
        lastResolveAt = now();
        pid = await resolvePid();
        // A new server's swap is its own: an hour of samples from the old one
        // would read a restarted tmux's first figure as growth.
        if (pid !== null && pid !== lastPid) { memSamples.length = 0; lastPid = pid; }
      }
      if (pid === null) { mem = { ...mem, error: "tmux pid unknown" }; return; }
      const text = await readStatus(pid);
      // A pid the kernel reused after a hand restart of tmux reads fine and is
      // somebody else's memory: /proc's Name says whose it is.
      if (!/^Name:\s+tmux(:|\s|$)/m.test(text)) { pid = null; memSamples.length = 0; mem = { ...mem, error: "tmux pid reused by another process, re-resolving" }; return; }
      mem = { ...parseProcStatus(text), sampledAt: new Date(now()).toISOString(), error: null };
      if (typeof mem.swapMb === "number") {
        memSamples.push({ at: now(), swapMb: mem.swapMb });
        while (memSamples.length && (memSamples.length > MEM_SAMPLES || now() - memSamples[0].at > SWAP_WINDOW_MS)) memSamples.shift();
      }
    } catch (e) {
      // ENOENT = the pid is gone (tmux restarted) → resolve again next time;
      // anything else (/proc unreadable, ps timed out or missing) → the pid is
      // kept, memory unknown this round, latency still judged. The error code
      // alone goes on the open /api/health, never the message.
      if (e && e.code === "ENOENT") { pid = null; memSamples.length = 0; }
      mem = { ...mem, error: e && e.code === "ENOENT" ? "tmux pid gone, re-resolving" : `memory unreadable this round (${(e && e.code) || "error"})` };
    } finally { evaluate(); }
  }

  // Swap growth over the window: now minus the lowest sample (a shrink after a
  // swapoff/swapon or page-ins resets the baseline downwards at once).
  function swapGrowth() {
    if (typeof mem.swapMb !== "number" || !memSamples.length) return null;
    return mem.swapMb - Math.min(...memSamples.map((s) => s.swapMb));
  }

  function evaluate() {
    const v = judge({ probes, rssMb: mem.rssMb, swapMb: mem.swapMb, swapGrowthMb: swapGrowth(), now: now() });
    const prev = level;
    level = v.level; reasons = v.reasons;
    if (prev !== level) {
      since = new Date(now()).toISOString();
      const summary = `tmux ${level === "ok" ? "healthy again" : level === "down" ? "not answering" : "degraded"}${reasons.length ? `: ${reasons.join("; ")}` : ""}`;
      log[level === "ok" ? "log" : "warn"](`[tmux-health] ${prev} → ${level} — ${summary}`);
      maybeNotify(prev, summary);
      // (Alerts switched ON while already warn/down push nothing until the next
      // change: the operator who just flipped the switch is looking at the pill.)
    }
  }

  function maybeNotify(prev, summary) {
    if (!notify || !isNotifyEnabled()) return;
    // One push per level change, never more than one per NTFY_MIN_INTERVAL_MS
    // for the same level (ok ↔ warn flapping at the threshold stays quiet);
    // the recovery push only follows a push that went out.
    if (level === "ok" && lastNotifiedLevel === null) return;
    if (level === lastNotifiedLevel && now() - lastNotifiedAt < NTFY_MIN_INTERVAL_MS) return;
    lastNotifiedAt = now(); lastNotifiedLevel = level === "ok" ? null : level;
    Promise.resolve().then(() => notify({ level, previous: prev, reasons, summary })).catch((e) => log.warn(`[tmux-health] notify failed: ${e.message}`));
  }

  function snapshot() {
    const ok = probes.filter((p) => !p.failed).map((p) => p.ms);
    const last = probes[probes.length - 1];
    return {
      level, reasons, since,
      pid,
      latencyMs: last ? last.ms : null,
      latencyP95Ms: p95(ok),
      slowProbes: probes.filter((p) => !p.failed && p.ms > TMUX_SLOW_MS).length,
      failedProbes: probes.filter((p) => p.failed).length,
      rssMb: mem.rssMb, swapMb: mem.swapMb, swapGrowthMb: swapGrowth(), memSampledAt: mem.sampledAt, memError: mem.error,
      warnRssMb: WARN_RSS_MB, warnSwapMb: WARN_SWAP_MB, swapCeilingMb: SWAP_CEILING_MB,
      history,
    };
  }

  function start() {
    if (timer) return;
    sampleMemory();
    timer = setInterval(sampleMemory, PROC_INTERVAL_MS);
    timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { noteProbe, sampleMemory, snapshot, start, stop };
}

// ── ntfy ────────────────────────────────────────────────────────────────────
// The topic is a secret (anyone who knows it can read the channel): it is read
// from the file at send time and never logged, never put on any payload — the
// health/doctor payloads only say whether the file was readable.
export const NTFY_TOPIC_FILE = process.env.HADRON_NTFY_TOPIC_FILE || join(homedir(), ".ntfy_topic_log");
export const NTFY_URL = (process.env.HADRON_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
export function readNtfyTopic() {
  try { const t = readFileSync(NTFY_TOPIC_FILE, "utf-8").trim(); return /^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : null; } catch { return null; }
}
export async function sendNtfy({ title, body, priority = "default", tags = [] }, { fetchImpl = fetch } = {}) {
  const topic = readNtfyTopic();
  if (!topic) throw new Error("ntfy topic file missing or malformed");
  const r = await fetchImpl(`${NTFY_URL}/${topic}`, {
    method: "POST", body,
    headers: { Title: title, Priority: priority, ...(tags.length ? { Tags: tags.join(",") } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
}
