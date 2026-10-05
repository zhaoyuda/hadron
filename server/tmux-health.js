// tmux server health, from what the server already does.
//
// Prod 2026-10-05: the tmux server had grown to 5.6 GB RSS + 1.2 GB swap (76
// panes, 171k lines of history) and was paging; every tmux call took seconds,
// two timed out in a row and the server crashed (fixed in tmux.js/index.js).
// Nobody saw it coming because nothing watched tmux itself. This module does,
// without a single extra tmux spawn: the state detector already runs one
// `list-panes -a` per second for ALL agents — its wall time IS the latency
// probe (noteProbe). Memory is read from /proc/<pid>/status (VmRSS, VmSwap)
// every PROC_INTERVAL_MS, a file read, no process. macOS has no /proc: memory
// is null there and only latency is judged.
//
// It never kills, restarts or resizes anything: the verdict goes to
// /api/health.tmux, a topbar pill, a `hadron doctor` row and — opt-in, default
// off — one ntfy push per state change (rate-limited). The operator decides.
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmuxSafeAsync, TMUX_SLOW_MS } from "./tmux.js";

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
export const WARN_SWAP_MB = num(process.env.HADRON_TMUX_WARN_SWAP_MB, 512);

// Pure: the verdict from the samples. Exported for the unit test.
export function judge({ probes, rssMb, swapMb, now = Date.now(), slowMs = TMUX_SLOW_MS, warnRssMb = WARN_RSS_MB, warnSwapMb = WARN_SWAP_MB }) {
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
  if (warnSwapMb > 0 && typeof swapMb === "number" && swapMb >= warnSwapMb) { if (level === "ok") level = "warn"; reasons.push(`${swapMb} MB swapped out (warn from ${warnSwapMb} MB)`); }
  return { level, reasons, slowProbes: slow, failedProbes: failed, probesJudged: recent.length };
}

// Pure: /proc/<pid>/status text → { rssMb, swapMb } (null fields when absent).
export function parseProcStatus(text) {
  const kb = (key) => { const m = String(text || "").match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m")); return m ? Number(m[1]) : null; };
  const rss = kb("VmRSS"), swap = kb("VmSwap");
  return { rssMb: rss === null ? null : Math.round(rss / 1024), swapMb: swap === null ? null : Math.round(swap / 1024) };
}

function p95(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

export function createTmuxHealth({
  readStatus = (pid) => readFileSync(`/proc/${pid}/status`, "utf-8"),
  resolvePid = async () => { const out = await tmuxSafeAsync(["display-message", "-p", "#{pid}"]); const n = Number(out); return Number.isInteger(n) && n > 0 ? n : null; },
  now = Date.now,
  notify = null,              // (event: {level, previous, reasons, summary}) => void — the ntfy sender
  isNotifyEnabled = () => false,
  log = console,
} = {}) {
  const probes = [];          // { at, ms, failed, timedOut }
  let pid = null;
  let mem = { rssMb: null, swapMb: null, sampledAt: null, error: null };
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

  let sampling = false, lastResolveAt = 0;
  async function sampleMemory() {
    if (sampling) return;
    sampling = true;
    try {
      if (pid === null) { lastResolveAt = now(); pid = await resolvePid(); }
      if (pid === null) { mem = { ...mem, error: "tmux pid unknown" }; return; }
      const text = readStatus(pid);
      // A pid the kernel reused after a hand restart of tmux reads fine and is
      // somebody else's memory: /proc's Name says whose it is.
      if (!/^Name:\s+tmux/m.test(text)) { pid = null; mem = { ...mem, error: "tmux pid reused by another process, re-resolving" }; return; }
      mem = { ...parseProcStatus(text), sampledAt: new Date(now()).toISOString(), error: null };
    } catch (e) {
      // ENOENT = the pid is gone (tmux restarted) → resolve again next time;
      // no /proc at all (macOS) → memory stays unknown, latency still judged.
      if (e && e.code === "ENOENT") pid = null;
      mem = { ...mem, error: e && e.code === "ENOENT" ? "tmux pid gone, re-resolving" : "memory unreadable on this platform" };
    } finally { sampling = false; evaluate(); }
  }

  function evaluate() {
    const v = judge({ probes, rssMb: mem.rssMb, swapMb: mem.swapMb, now: now() });
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
      rssMb: mem.rssMb, swapMb: mem.swapMb, memSampledAt: mem.sampledAt, memError: mem.error,
      warnRssMb: WARN_RSS_MB, warnSwapMb: WARN_SWAP_MB,
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
