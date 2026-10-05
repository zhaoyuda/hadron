// Performance log: <workspace>/.hadron/logs/perf.jsonl — one JSON line per
// sample, so the question "was it slow BEFORE it crashed?" has an answer after
// the fact (prod 2026-10-05: tmux had been crawling for hours; nobody could
// say since when). Three kinds, all cheap to collect:
//   tmux  { cmd, ms, timedOut }          — tmux calls over TMUX_SLOW_MS only
//   http  { method, route, status, ms }  — every /api request (route template,
//                                          never the query string or a token)
//   ws    { agent, shell, ms }           — terminal connect → first pty byte
// Lines are buffered and appended once a second; the file rotates by LOCAL day
// (perf-YYYY-MM-DD.jsonl) and the oldest beyond `keepDays` are deleted.
// `hadron perf [--since 1h]` reads it back (summarizePerf below).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "fs";
import { join } from "path";

export const PERF_FILE = "perf.jsonl";
export const KEEP_DAYS = 7;
export const FLUSH_MS = 1000;
export const MAX_QUEUE = 5000;            // lines held while the disk is unwritable — then the oldest are dropped
export const MAX_FILE_BYTES = 32 * 1024 * 1024; // a live file past this rotates within the day (perf-YYYY-MM-DD-HHMMSS.jsonl)
const ROTATED_RE = /^perf-(\d{4}-\d{2}-\d{2})(?:-\d{6})?\.jsonl$/;

export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// `dir` may be a function (resolved at the first flush — the server knows its
// workspace only after boot).
export function createPerfLog({ dir, keepDays = KEEP_DAYS, now = Date.now, flushMs = FLUSH_MS, log = console } = {}) {
  const dirOf = typeof dir === "function" ? dir : () => dir;
  let path = null;
  let queue = [];
  let timer = null;
  let status = { ok: true, error: null, lines: 0, dropped: 0 };
  let fileDay = null;                     // the local day the open perf.jsonl belongs to
  let modeChecked = false;

  function record(kind, fields) {
    queue.push(JSON.stringify({ t: new Date(now()).toISOString(), kind, ...fields }));
    if (queue.length > MAX_QUEUE) { queue.splice(0, queue.length - MAX_QUEUE); status.dropped++; }
    if (!timer) { timer = setTimeout(flush, flushMs); timer.unref(); }
  }

  // Rotate when the file on disk belongs to an earlier day than `today`, or
  // has outgrown MAX_FILE_BYTES (a reconnect storm must not fill the workspace).
  function rotateIfNeeded(dir, today) {
    let size = 0;
    if (fileDay === null) {
      try { const st = statSync(path); fileDay = localDay(st.mtimeMs); size = st.size; } catch { fileDay = today; }
    } else { try { size = statSync(path).size; } catch {} }
    if (fileDay === today && size < MAX_FILE_BYTES) return;
    let target = join(dir, `perf-${fileDay}.jsonl`);
    if (existsSync(target)) target = join(dir, `perf-${fileDay}-${new Date(now()).toISOString().slice(11, 19).replace(/:/g, "")}.jsonl`);
    try { renameSync(path, target); } catch (e) { if (e.code !== "ENOENT") throw e; }
    fileDay = today;
    prune(dir);
  }
  function prune(dir) {
    let rotated = [];
    try { rotated = readdirSync(dir).filter((f) => ROTATED_RE.test(f)).sort(); } catch { return; }
    // keepDays counts the live file as one day: keep every rotated file of the
    // newest keepDays-1 DAYS (a day may have several files after a size rotation).
    const days = [...new Set(rotated.map((f) => f.match(ROTATED_RE)[1]))].sort();
    const drop = new Set(days.slice(0, Math.max(0, days.length - (keepDays - 1))));
    for (const f of rotated) { if (drop.has(f.match(ROTATED_RE)[1])) { try { unlinkSync(join(dir, f)); } catch {} } }
  }

  function flush() {
    timer = null;
    if (!queue.length) return;
    const lines = queue; queue = [];
    const dir = dirOf();
    path = join(dir, PERF_FILE);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      rotateIfNeeded(dir, localDay(now()));
      appendFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
      if (!modeChecked) { modeChecked = true; try { chmodSync(path, 0o600); } catch {} }   // mode: applies at creation only
      status.lines += lines.length;
      if (!status.ok) { status = { ...status, ok: true, error: null }; log.log(`[perf] ${path} writable again`); }
    } catch (e) {
      // Keep the lines (bounded) and say so once per failure episode; the next
      // flush retries. A perf log that cannot be written must not cost anything else.
      queue = lines.concat(queue);
      if (queue.length > MAX_QUEUE) { status.dropped += queue.length - MAX_QUEUE; queue.splice(0, queue.length - MAX_QUEUE); }
      if (status.ok) log.warn(`[perf] writing ${path} failed (${e.code || e.message}) — samples are held in memory (max ${MAX_QUEUE}) until it works again`);
      status = { ...status, ok: false, error: e.code || e.message };
    }
  }

  function stop() { if (timer) clearTimeout(timer); timer = null; flush(); }
  return { record, flush, stop, status: () => ({ ...status, path, queued: queue.length }) };
}

// ── reader ──────────────────────────────────────────────────────────────────
export function parseSince(s, defaultMs = 3600_000) {
  if (s === undefined || s === true || s === "") return defaultMs;
  if (s === "all") return Infinity;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2]];
}
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null; }
function stats(values) {
  const s = values.filter((v) => typeof v === "number" && v >= 0).sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.length ? s[s.length - 1] : null };
}

// All lines with t >= now - sinceMs across the live file and the rotated ones
// (newest first on disk order does not matter; everything is filtered by t).
export function readPerf({ dir, sinceMs = 3600_000, now = Date.now() }) {
  const cutoff = sinceMs === Infinity ? -Infinity : now - sinceMs;
  let files = [];
  try { files = readdirSync(dir).filter((f) => f === PERF_FILE || ROTATED_RE.test(f)); } catch {}
  const rows = [];
  let malformed = 0, skipped = 0;
  for (const f of files) {
    // A rotated file holds one local day: skip it unread when that day ended
    // before the cutoff (the default --since 1h reads one or two files, not 8).
    const m = f.match(ROTATED_RE);
    if (m && cutoff !== -Infinity) {
      const [y, mo, d] = m[1].split("-").map(Number);
      if (new Date(y, mo - 1, d + 1).getTime() < cutoff) { skipped++; continue; }
    }
    let text = "";
    try { text = readFileSync(join(dir, f), "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { malformed++; continue; }
      const t = Date.parse(o && o.t);
      if (!Number.isFinite(t) || t < cutoff || typeof o.kind !== "string") continue;
      rows.push({ ...o, _t: t });
    }
  }
  rows.sort((a, b) => a._t - b._t);
  return { rows, files: files.length - skipped, malformed };
}

export function summarizePerf({ dir, sinceMs = 3600_000, now = Date.now() }) {
  const { rows, files, malformed } = readPerf({ dir, sinceMs, now });
  const http = new Map(), tmux = new Map();
  const ws = [];
  for (const r of rows) {
    if (r.kind === "http") {
      const key = `${r.method} ${r.route}`;
      const e = http.get(key) || { method: r.method, route: r.route, ms: [], errors: 0 };
      e.ms.push(r.ms); if (r.status >= 500) e.errors++;
      http.set(key, e);
    } else if (r.kind === "tmux") {
      const e = tmux.get(r.cmd) || { cmd: r.cmd, ms: [], timeouts: 0 };
      e.ms.push(r.ms); if (r.timedOut) e.timeouts++;
      tmux.set(r.cmd, e);
    } else if (r.kind === "ws") ws.push(r.ms);
  }
  const httpRows = [...http.values()].map((e) => ({ method: e.method, route: e.route, ...stats(e.ms), errors: e.errors })).sort((a, b) => b.n - a.n);
  const tmuxRows = [...tmux.values()].map((e) => ({ cmd: e.cmd, ...stats(e.ms), timeouts: e.timeouts })).sort((a, b) => b.n - a.n);
  return {
    sinceMs, files, malformed, samples: rows.length,
    from: rows.length ? new Date(rows[0]._t).toISOString() : null,
    to: rows.length ? new Date(rows[rows.length - 1]._t).toISOString() : null,
    http: httpRows, tmux: tmuxRows, ws: stats(ws),
  };
}
