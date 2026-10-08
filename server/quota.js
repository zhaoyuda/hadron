/**
 * Quota — how much of the Claude and Codex subscription windows is used.
 *
 * Neither vendor exposes this over an API Hadron may call, and claude keeps no
 * record of it on disk. Two honest, read-only sources:
 *
 *   claude — the JSON claude pipes into its statusLine command on every turn
 *            carries `rate_limits.five_hour / seven_day` (subscribers only).
 *            `hadron quota-sink` sits in front of the user's statusline (an
 *            explicit `hadron quota --install`, idempotent, reversible) and
 *            writes an allowlisted receipt to <CLAUDE_CONFIG_DIR>/hadron-quota.json.
 *            Nothing else from that JSON (session id, cwd, model) is kept.
 *   codex  — every codex rollout (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl)
 *            logs `token_count` events with a `rate_limits` block. The newest
 *            rollout's last such line is the current picture.
 *
 * A window whose `resets_at` has passed is dropped (its usage is 0 now, whatever
 * the last receipt said); nothing else expires — a percentage does not decay
 * inside its window, however old the receipt. `at` says how old it is.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { CLAUDE_CONFIG_DIR } from "./session-registry.js";

export const RECEIPT_NAME = "hadron-quota.json";
export const receiptPath = (configDir = CLAUDE_CONFIG_DIR) => join(configDir, RECEIPT_NAME);
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
// A receipt is rewritten when the numbers change, or when the last one is
// older than this (so `at` keeps saying "fresh" while claude keeps running).
export const RECEIPT_REFRESH_MS = 5 * 60 * 1000;
export const CODEX_TAIL_BYTES = 256 * 1024;
export const STDIN_MAX_BYTES = 4 * 1024 * 1024; // one cap: what the sink keeps AND what it parses

const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
// resets_at is epoch seconds for both vendors; tolerate ms and ISO strings.
export function epochSeconds(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? Math.round(v / 1000) : Math.round(v);
  if (typeof v === "string") { const t = Date.parse(v); if (Number.isFinite(t)) return Math.round(t / 1000); const n = Number(v); if (Number.isFinite(n)) return epochSeconds(n); }
  return null;
}

// Allowlisted picture of claude's statusline `rate_limits` — the only part of
// that stdin JSON that ever reaches disk. Null when the payload has no usable window.
export function pickClaudeRateLimits(payload) {
  const rl = payload && typeof payload === "object" ? payload.rate_limits : null;
  if (!rl || typeof rl !== "object") return null;
  const out = {};
  for (const key of ["five_hour", "seven_day"]) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const used = pct(w.used_percentage);
    if (used === null) continue;
    out[key] = { used_percentage: used, resets_at: epochSeconds(w.resets_at) };
  }
  return Object.keys(out).length ? out : null;
}

// Write the receipt atomically; returns true when a write happened.
export function writeReceipt(rateLimits, { configDir = CLAUDE_CONFIG_DIR, now = Date.now() } = {}) {
  if (!rateLimits) return false;
  const path = receiptPath(configDir);
  let prev = null;
  try { prev = JSON.parse(readFileSync(path, "utf-8")); } catch {}
  if (prev && JSON.stringify(prev.rate_limits) === JSON.stringify(rateLimits)) {
    const age = now - (Date.parse(prev.at) || 0);
    if (age >= 0 && age < RECEIPT_REFRESH_MS) return false;
  }
  mkdirSync(configDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: new Date(now).toISOString(), rate_limits: rateLimits }) + "\n");
  renameSync(tmp, path);
  return true;
}

const labelFor = (minutes) => (minutes % 1440 === 0 && minutes >= 1440 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`);
function liveWindows(list, nowS) {
  return list.filter((w) => w.usedPct !== null && (w.resetsAt === null || w.resetsAt > nowS));
}

// { at, windows: [{ key, label, usedPct, resetsAt }], source } or null.
export function readClaudeQuota({ configDir = CLAUDE_CONFIG_DIR, now = Date.now() } = {}) {
  let rec;
  try { rec = JSON.parse(readFileSync(receiptPath(configDir), "utf-8")); } catch { return null; }
  const rl = rec && rec.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const windows = liveWindows([
    { key: "five_hour", label: "5h", usedPct: pct(rl.five_hour?.used_percentage), resetsAt: epochSeconds(rl.five_hour?.resets_at) },
    { key: "seven_day", label: "7d", usedPct: pct(rl.seven_day?.used_percentage), resetsAt: epochSeconds(rl.seven_day?.resets_at) },
  ], Math.floor(now / 1000));
  if (!windows.length) return null;
  return { at: typeof rec.at === "string" && Number.isFinite(Date.parse(rec.at)) ? rec.at : null, windows, source: "statusline" };
}

// Rollouts newest-first by mtime across the last few day directories (a session
// that started yesterday keeps appending to yesterday's file). Capped: a codex
// that has just launched owns the newest file with no rate_limits line yet, so
// the reader falls through to the previous one instead of blanking the widget.
export function recentRollouts(codexHome = CODEX_HOME, { dayDirs = 3, limit = 3 } = {}) {
  const root = join(codexHome, "sessions");
  const days = [];
  try {
    for (const y of readdirSync(root).filter((n) => /^\d{4}$/.test(n)).sort().reverse()) {
      for (const m of readdirSync(join(root, y)).filter((n) => /^\d{2}$/.test(n)).sort().reverse()) {
        for (const d of readdirSync(join(root, y, m)).filter((n) => /^\d{2}$/.test(n)).sort().reverse()) {
          days.push(join(root, y, m, d));
          if (days.length >= dayDirs) break;
        }
        if (days.length >= dayDirs) break;
      }
      if (days.length >= dayDirs) break;
    }
  } catch { return []; }
  const files = [];
  for (const dir of days) {
    let names;
    try { names = readdirSync(dir).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl")); } catch { continue; }
    for (const n of names) {
      try { const st = statSync(join(dir, n)); files.push({ path: join(dir, n), mtimeMs: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  // Same mtime (coarse filesystem clocks) → the later-named file: rollout names carry the start time.
  return files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0)).slice(0, limit);
}

function readTail(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf-8");
  } finally { closeSync(fd); }
}

// Last `rate_limits` block in a rollout tail → normalised, or null.
export function parseCodexRateLimits(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; } // torn first line of the tail
    const rl = rec?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const w = (k) => {
      const x = rl[k];
      if (!x || typeof x !== "object") return null;
      const minutes = typeof x.window_minutes === "number" ? x.window_minutes : null;
      return { key: k, label: minutes ? labelFor(minutes) : k, usedPct: pct(x.used_percent), resetsAt: epochSeconds(x.resets_at) };
    };
    return { windows: [w("primary"), w("secondary")].filter(Boolean), plan: typeof rl.plan_type === "string" ? rl.plan_type.slice(0, 32) : null, timestamp: typeof rec.timestamp === "string" && Number.isFinite(Date.parse(rec.timestamp)) ? rec.timestamp : null };
  }
  return null;
}

export function readCodexQuota({ codexHome = CODEX_HOME, now = Date.now() } = {}) {
  for (const file of recentRollouts(codexHome)) {
    let parsed = null;
    try { parsed = parseCodexRateLimits(readTail(file.path, CODEX_TAIL_BYTES)); } catch {}
    if (!parsed) continue; // no rate_limits yet (just launched) → the previous rollout
    const windows = liveWindows(parsed.windows, Math.floor(now / 1000));
    if (!windows.length) return null; // the newest picture IS "all windows reset" — do not fall back to an older one
    return { at: parsed.timestamp || new Date(file.mtimeMs).toISOString(), windows, source: "rollout", plan: parsed.plan };
  }
  return null;
}

// ── generic sources: <CLAUDE_CONFIG_DIR>/hadron-quota.d/<name>.json ──
// For whatever else meters you (an API-key proxy, LiteLLM, a team budget): any
// script writes a small receipt and the widget shows it beside Claude and Codex
// with a neutral mark and the receipt's own label. Contract (README "Quota
// sources"): { "at": ISO-8601, "label": "LiteLLM", "windows": [{ "label": "1mo",
// "usedPct": 9, "resetsAt": epochSeconds | null }] }. Strict: a file that
// fails any check is skipped WHOLE (one bad window never shows a half picture)
// and `hadron doctor` names it; a receipt older than SOURCE_STALE_MS is skipped
// as stale — the writer stopped, the number is not current.
export const SOURCES_DIR = "hadron-quota.d";
export const sourcesDir = (configDir = CLAUDE_CONFIG_DIR) => join(configDir, SOURCES_DIR);
export const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;
export const SOURCE_MAX_FILES = 16;
export const SOURCE_MAX_BYTES = 64 * 1024;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CLEAN = /^[^\x00-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+$/; // one line, no C0/C1 control characters, no Unicode line separators / zero-widths / bidi overrides — it goes on a <span>, a tooltip and a terminal line
// A file name is attacker-shaped text that reaches `hadron doctor` stdout: no control characters, 80 chars.
const safeFile = (f) => String(f).replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, 80);
const text = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max && CLEAN.test(v) && v.trim() === v;

// Pure. Returns { label, at, windows: [{ key, label, usedPct, resetsAt, detail,
// level }], notes } or throws with the reason (what doctor prints). Expired
// windows are dropped AFTER validation: a file with a bad window is bad even if
// that window is over. Two OPTIONAL per-window fields ride along: `detail`
// (1-80 printable characters, tooltip + `hadron quota` text — what the number
// means, e.g. "$12.40 of $50") and `level` ("ok" | "warn" | "bad" — the writer
// knows its own thresholds; it replaces the widget's 50/80 colours and warn/bad
// draw the number under the Show Quota threshold). An out-of-contract value of
// EITHER is ignored for that field only (null, the window and the file stay) and
// named in `notes` — doctor's green row and a warnOnce carry it, so a typo is
// never silent and never costs the gauge. Unknown fields anywhere are ignored
// without a note: a writer may keep its own keys (a top-level budget block) in
// the same file.
export const SOURCE_LEVELS = ["ok", "warn", "bad"];
export function parseQuotaSource(rec, { now = Date.now() } = {}) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("not a JSON object");
  if (!text(rec.label, 32)) throw new Error("label must be a string of 1-32 printable characters");
  const atMs = typeof rec.at === "string" ? Date.parse(rec.at) : NaN;
  if (!Number.isFinite(atMs)) throw new Error("at must be an ISO-8601 timestamp");
  if (atMs - now > 5 * 60 * 1000) throw new Error("at is in the future");
  if (!Array.isArray(rec.windows) || rec.windows.length < 1 || rec.windows.length > 8) throw new Error("windows must be an array of 1-8 entries");
  const nowS = Math.floor(now / 1000);
  const notes = [];
  const windows = rec.windows.map((w, i) => {
    if (!w || typeof w !== "object" || Array.isArray(w)) throw new Error(`windows[${i}] is not an object`);
    if (!text(w.label, 16)) throw new Error(`windows[${i}].label must be a string of 1-16 printable characters`);
    if (typeof w.usedPct !== "number" || !Number.isFinite(w.usedPct) || w.usedPct < 0 || w.usedPct > 100) throw new Error(`windows[${i}].usedPct must be a number from 0 to 100`);
    let resetsAt = null;
    if (w.resetsAt !== undefined && w.resetsAt !== null) {
      resetsAt = typeof w.resetsAt === "number" ? epochSeconds(w.resetsAt) : null;
      if (resetsAt === null) throw new Error(`windows[${i}].resetsAt must be epoch seconds or null`);
    }
    let detail = null, level = null;
    // A note names the window by index AND label: the index is the file's, and an expired window is dropped from what the row shows.
    if (w.detail !== undefined && w.detail !== null && w.detail !== "") { // "" is a template with nothing to say — absent, not a typo
      if (text(w.detail, 80)) detail = w.detail;
      else notes.push(`windows[${i}] ("${w.label}").detail ignored: must be a string of 1-80 printable characters`); // never the value: attacker-shaped text
    }
    if (w.level !== undefined && w.level !== null) {
      if (SOURCE_LEVELS.includes(w.level)) level = w.level;
      else notes.push(`windows[${i}] ("${w.label}").level ignored: must be "ok", "warn" or "bad" (lower-case)`);
    }
    return { key: `w${i}`, label: w.label, usedPct: Math.round(w.usedPct), resetsAt, detail, level };
  });
  const labels = new Set(windows.map((w) => w.label));
  if (labels.size !== windows.length) throw new Error("window labels must be distinct");
  return { label: rec.label, at: new Date(atMs).toISOString(), windows: liveWindows(windows, nowS), notes };
}

// { sources: [{ name, label, at, windows, notes, source: "file" }], problems: [{ name, file, error }] }
// — sources is what the widget shows (files with no live window are left out,
// not a problem), problems is what doctor shows: `file` is the display path
// ("hadron-quota.d/<file>", control characters stripped), `name` the stem. A
// file whose name is not a stem (spaces, dots first, too long) is a problem
// too; a symlink to something that is not a file is a problem with one word.
export function readQuotaSources({ configDir = CLAUDE_CONFIG_DIR, now = Date.now() } = {}) {
  const dir = sourcesDir(configDir);
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return { sources: [], problems: [] }; }
  const sources = [], problems = [];
  for (const file of names.slice(0, SOURCE_MAX_FILES)) {
    const name = file.slice(0, -5);
    const shown = `${SOURCES_DIR}/${safeFile(file)}`;
    if (!SOURCE_NAME.test(name)) { problems.push({ name: safeFile(name), file: shown, error: "file name must be <name>.json with letters, digits, _ . - only (64 max)" }); continue; }
    try {
      let st;
      try { st = statSync(join(dir, file)); } catch (e) { throw new Error(`unreadable (${(e && e.code) || "stat failed"})`); } // never the path: fs messages carry it
      if (!st.isFile()) throw new Error("not a regular file");
      if (st.size > SOURCE_MAX_BYTES) throw new Error(`file is ${st.size} bytes (max ${SOURCE_MAX_BYTES})`);
      let raw;
      try { raw = readFileSync(join(dir, file), "utf-8"); } catch (e) { throw new Error(`unreadable (${(e && e.code) || "read failed"})`); }
      if (raw.length > SOURCE_MAX_BYTES) throw new Error(`file is over ${SOURCE_MAX_BYTES} bytes`); // grew between stat and read
      let rec;
      try { rec = JSON.parse(raw); } catch { throw new Error("not valid JSON"); }
      const parsed = parseQuotaSource(rec, { now });
      if (now - Date.parse(parsed.at) > SOURCE_STALE_MS) throw new Error(`stale: written ${Math.floor((now - Date.parse(parsed.at)) / 3600000)} h ago (the writer stopped?)`);
      if (!parsed.windows.length && !parsed.notes.length) continue; // every window reset: nothing current to show, nothing wrong (with a note the source stays, so the typo is named before the window comes back)
      sources.push({ name, ...parsed, source: "file" });
    } catch (e) { problems.push({ name, file: shown, error: e.message }); }
  }
  if (names.length > SOURCE_MAX_FILES) problems.push({ name: SOURCES_DIR, file: SOURCES_DIR, error: `${names.length} files, only the first ${SOURCE_MAX_FILES} by name are read — ${names.length - SOURCE_MAX_FILES} skipped, the first of them ${safeFile(names[SOURCE_MAX_FILES])}` });
  return { sources, problems };
}

export function readQuota(opts = {}) {
  const extra = readQuotaSources(opts);
  return { claude: readClaudeQuota(opts), codex: readCodexQuota(opts), sources: extra.sources, sourceProblems: extra.problems, at: new Date(opts.now || Date.now()).toISOString() };
}

// ── statusLine install (explicit, idempotent, reversible) ──
// settings.statusLine.command becomes `<node> <hadron.js> quota-sink --tee | <previous command>`
// (or the bare sink, which prints a compact "5h 28% · 7d 4%" line, when there was
// no statusline). Uninstall strips exactly that prefix / removes exactly that
// bare entry. Other settings keys are never touched; a backup is written first.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function sinkCommand(nodePath, hadronBin) { return `${q(nodePath)} ${q(hadronBin)} quota-sink`; }
// "Ours" is the sink's SHAPE — a quoted path ending in hadron.js, then the
// subcommand — never the bare word: a user's own statusline that merely mentions
// quota-sink is wrapped like any other command, never repointed or removed.
export const SINK_MARK = /(^|\s)'(?:[^']|'\\'')*hadron\.js'\s+quota-sink(\s|$)/; // '…'\''…' is a quote inside q()

export function readSettings(configDir = CLAUDE_CONFIG_DIR) {
  const path = join(configDir, "settings.json");
  let text = null;
  try { text = readFileSync(path, "utf-8"); } catch { return { path, settings: {}, existed: false }; }
  let settings;
  try { settings = JSON.parse(text); } catch (e) { throw new Error(`${path} is not valid JSON (${e.message}) — fix it by hand, nothing was changed`); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${path} is not a JSON object — nothing was changed`);
  return { path, settings, existed: true };
}

export function writeSettings(path, settings, prevText) {
  if (prevText !== null) writeFileSync(`${path}.hadron-bak`, prevText);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, path);
}

// `current` says whether the installed sink points at THIS checkout's hadron.js;
// a sink left behind by a removed worktree runs nothing and writes no receipt.
export function quotaInstallStatus({ configDir = CLAUDE_CONFIG_DIR, hadronBin = null } = {}) {
  const { settings } = readSettings(configDir);
  const sl = settings.statusLine;
  const command = sl && typeof sl === "object" && typeof sl.command === "string" ? sl.command : null;
  const installed = !!command && SINK_MARK.test(command);
  return { installed, command, current: installed && (hadronBin ? command.includes(q(hadronBin)) : null) };
}
// The previous statusline behind an installed sink (null for a bare install).
const unwrap = (command) => command.match(/^.*?quota-sink --tee \| ([\s\S]+)$/)?.[1] ?? null;

export function installQuotaSink({ configDir = CLAUDE_CONFIG_DIR, nodePath = process.execPath, hadronBin } = {}) {
  const { path, settings, existed } = readSettings(configDir);
  const prevText = existed ? readFileSync(path, "utf-8") : null;
  if ("statusLine" in settings && (!settings.statusLine || typeof settings.statusLine !== "object" || Array.isArray(settings.statusLine))) throw new Error("statusLine is not an object — not touching it");
  const sl = settings.statusLine || null;
  let prevCommand = sl && typeof sl.command === "string" ? sl.command : null;
  const sink = sinkCommand(nodePath, hadronBin);
  let repaired = null;
  if (prevCommand && SINK_MARK.test(prevCommand)) {
    if (prevCommand.includes(q(hadronBin))) return { changed: false, command: prevCommand, path };
    repaired = prevCommand; // a sink from another checkout: repoint it, keep what it wrapped
    prevCommand = unwrap(prevCommand);
  }
  if (sl && sl.type && sl.type !== "command") throw new Error(`statusLine.type is "${sl.type}", not "command" — not touching it`);
  const command = prevCommand ? `${sink} --tee | ${prevCommand}` : sink;
  settings.statusLine = { ...(sl || {}), type: "command", command };
  mkdirSync(configDir, { recursive: true });
  writeSettings(path, settings, prevText);
  return { changed: true, command, path, wrapped: !!prevCommand, repaired };
}

export function uninstallQuotaSink({ configDir = CLAUDE_CONFIG_DIR } = {}) {
  const { path, settings, existed } = readSettings(configDir);
  if (!existed) return { changed: false, path };
  const sl = settings.statusLine && typeof settings.statusLine === "object" ? settings.statusLine : null;
  const command = sl && typeof sl.command === "string" ? sl.command : null;
  if (!command || !SINK_MARK.test(command)) return { changed: false, path };
  const prevText = readFileSync(path, "utf-8");
  const restored = unwrap(command);
  if (restored) settings.statusLine = { ...sl, command: restored };
  else {
    // Bare install: drop only what install added; a sibling key (padding) stays.
    const { type, command: _c, ...rest } = sl;
    if (Object.keys(rest).length) settings.statusLine = rest;
    else delete settings.statusLine;
  }
  writeSettings(path, settings, prevText);
  return { changed: true, path, restored };
}
