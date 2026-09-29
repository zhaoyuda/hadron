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

export function readQuota(opts = {}) {
  return { claude: readClaudeQuota(opts), codex: readCodexQuota(opts), at: new Date(opts.now || Date.now()).toISOString() };
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
