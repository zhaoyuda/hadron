// Claude Code's own process registry: ~/.claude/sessions/<pid>.json, one file
// per live interactive claude, rewritten on /clear and --resume, removed on
// exit (verified on 2.1.261–2.1.283, Linux, 2026-09-28). Each record carries
// the process (pid, procStart, pidDomain), the conversation (sessionId, cwd)
// and the exact tmux pane it runs in (`session:@window.%pane`).
//
// That makes pane → session id DETERMINISTIC: no transcript scraping by cwd
// (refused in shared cwds, and a shell-tab claude in the same cwd would win
// by mtime), no hook to install. This module is a version-tested adapter,
// never automatically authoritative: a record counts only when its pid is
// alive, IS a claude process, and started when the record says it did (pid
// reuse), and it names the monitored pane exactly (a `-sh1` shell-tab claude
// lives in another tmux session; a user-split pane in the agent's window is
// not the agent's pane). Anything less falls back to scraping, and `hadron
// doctor` says which.
//
// Leak rule: nothing here logs a session id; callers get it in a return value.
import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

// Claude's config dir: CLAUDE_CONFIG_DIR relocates settings, the session
// registry AND the transcripts together — every path Hadron derives from it
// must come from here, or the registry finds records whose transcripts we
// then look for in the wrong tree.
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CLAUDE_PROJECTS_ROOT = join(CLAUDE_CONFIG_DIR, "projects");
export const REGISTRY_ROOT = join(CLAUDE_CONFIG_DIR, "sessions");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANE_TARGET_RE = /^@\d+\.%\d+$/;
export const REGISTRY_STATUSES = new Set(["matched", "unverified", "none", "stale", "ambiguous", "unavailable"]);

// Field types as claude actually writes them (2.1.28x): pid number,
// procStart a STRING of clock ticks, updatedAt/startedAt epoch-ms NUMBERS,
// kind "interactive". Both accepted forms are normalised here so a drift in
// either direction cannot silently null a field.
const toIso = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && v && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

// The claude version verified to write the `tmux` field (2.1.284 on the Mac
// fleet, 2026-09-29; 2.1.212 wrote records WITHOUT it — every one was rejected
// and shared-cwd agents went red with a guessed "claude too old?").
export const REGISTRY_TMUX_SINCE = "2.1.284";

// One registry record, shape-checked. { rec } for a complete INTERACTIVE
// record of a version we understand (extra fields are fine); otherwise
// { reject, version, pid, procStart } naming WHY, so doctor can count rejects
// by reason instead of calling them all "unreadable". A `claude -p` child that
// ever writes a record is not the pane's conversation and must never match.
function parseRecord(text, file) {
  let d;
  try { d = JSON.parse(text); } catch { return { reject: "not-json" }; }
  if (!d || typeof d !== "object") return { reject: "not-json" };
  const version = typeof d.version === "string" ? d.version : null;
  const pid = Number(d.pid);
  const procStart = d.procStart == null || d.procStart === "" ? null : Number(d.procStart);
  const base = { version, pid: Number.isInteger(pid) && pid > 0 ? pid : null, procStart: Number.isFinite(procStart) ? procStart : null };
  if (base.pid === null || basename(file) !== `${pid}.json`) return { reject: "bad-pid", ...base };
  if (typeof d.sessionId !== "string" || !UUID_RE.test(d.sessionId)) return { reject: "bad-session-id", ...base };
  // ORDER IS LOAD-BEARING: not-interactive is checked before no-tmux so a
  // `claude -p` child never lands in `tmuxless` (an old claude that omits
  // `kind` altogether would slip through — unverified for 2.1.212).
  if (d.kind != null && d.kind !== "interactive") return { reject: "not-interactive", ...base };
  if (typeof d.tmux !== "string" || !d.tmux) return { reject: "no-tmux", ...base };
  if (typeof d.cwd !== "string" || !d.cwd) return { reject: "no-cwd", ...base };
  if (procStart !== null && !Number.isFinite(procStart)) return { reject: "bad-procstart", ...base };
  return { rec: {
    pid, procStart, pidDomain: typeof d.pidDomain === "string" ? d.pidDomain : null,
    sessionId: d.sessionId, cwd: d.cwd, tmux: d.tmux,
    status: typeof d.status === "string" ? d.status : null,
    updatedAt: toIso(d.updatedAt),
    version,
  } };
}

// { available, reason, entries, malformed, rejected, tmuxless } —
// available=false when the dir is missing/unreadable (claude too old, or a
// relocated CLAUDE_CONFIG_DIR). `malformed` is the total reject count;
// `rejected` counts them by reason; `tmuxless` lists the interactive records
// that only lack the tmux field (pid, procStart, version — never the session
// id), so a pane's claude can be matched to one by process instead.
export function readRegistry({ root = REGISTRY_ROOT } = {}) {
  let names;
  try { names = readdirSync(root); } catch (e) {
    return { available: false, reason: e && e.code === "ENOENT" ? "missing" : "unreadable", entries: [], malformed: 0, rejected: {}, tmuxless: [] };
  }
  const entries = [];
  const rejected = {};
  const tmuxless = [];
  let malformed = 0;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = join(root, name);
    let text;
    try { text = readFileSync(file, "utf-8"); } catch { continue; } // removed between readdir and read (claude exited)
    const r = parseRecord(text, file);
    if (r.rec) { entries.push(r.rec); continue; }
    malformed++;
    rejected[r.reject] = (rejected[r.reject] || 0) + 1;
    if (r.reject === "no-tmux") tmuxless.push({ pid: r.pid, procStart: r.procStart, version: r.version });
  }
  return { available: true, reason: null, entries, malformed, rejected, tmuxless };
}

// Parent pid of <pid>, or null (dead, or no cheap source). Linux reads
// /proc/<pid>/stat field 4; elsewhere `ps -o ppid=`.
export function parentPid(pid, platform = process.platform) {
  if (platform === "linux") {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf-8"); } catch { return null; }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  }
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch { return null; }
}

// An old claude (< REGISTRY_TMUX_SINCE) writes records without `tmux`, so the
// pane cannot be matched by target — but the record's pid IS the claude
// process, and it runs in the pane: it is the pane process itself, or a
// descendant when launched from the pane's shell. This finds the tmux-less
// record whose live claude pid sits under panePid (at most `depth` levels,
// procStart-verified where the record carries one), so doctor can say "your
// claude <version> lacks the tmux field — upgrade" instead of guessing.
// Returns { pid, version } or null. Never the session id — the record has
// one, but a process-tree match is not the pane-target proof the tracker
// requires, so this is a DIAGNOSIS, not an identity source.
// depth 2 covers the real topology (pane shell → claude, or → wrapper →
// claude) and keeps the per-record spawn count small on macOS, where every
// step is a `ps`. Callers scanning many agents pass memoised identity/parent.
export function findTmuxlessRecordFor({ panePid, registry, identity = processIdentity, parent = parentPid, depth = 2 }) {
  if (!Number.isInteger(panePid) || panePid <= 0 || !registry || !registry.tmuxless || !registry.tmuxless.length) return null;
  const underPane = (pid) => {
    let p = pid;
    for (let i = 0; i <= depth && p; i++) {
      if (p === panePid) return true;
      p = parent(p);
    }
    return false;
  };
  for (const r of registry.tmuxless) {
    if (!r.pid) continue;
    const p = identity(r.pid);
    if (!p.alive || !p.claude) continue;
    if (r.procStart !== null && p.start !== null && r.procStart !== p.start) continue;
    if (underPane(r.pid)) return { pid: r.pid, version: r.version };
  }
  return null;
}

// What is process <pid>, right now? { alive, claude, start } — `claude` is true
// when the executable name or argv[0] is claude (argv[0] is what tmux reports
// as pane_current_command on Linux, so a fixture that `exec -a claude`s counts
// the same way the state detector counts it); `start` is the kernel start
// time in clock ticks (the value claude stores as procStart), null where the
// platform has no cheap source (macOS: liveness + name only).
export function processIdentity(pid, platform = process.platform) {
  if (platform === "linux") {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf-8"); } catch { return { alive: false, claude: false, start: null }; }
    // "pid (comm) state ppid ..." — comm may contain spaces/parens; split after the last ")".
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const rest = stat.slice(close + 2).split(" ");
    const start = Number(rest[19]); // field 22 overall (starttime)
    let argv0 = "";
    try { argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0")[0] || ""; } catch {}
    const isClaude = (n) => /^claude(\.exe)?$/i.test(basename(String(n || "")));
    return { alive: true, claude: isClaude(comm) || isClaude(argv0), start: Number.isFinite(start) ? start : null };
  }
  try { process.kill(pid, 0); } catch (e) { if (e && e.code !== "EPERM") return { alive: false, claude: false, start: null }; }
  let comm = "";
  try { comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  return { alive: true, claude: /^claude(\.exe)?$/i.test(basename(comm)), start: null };
}

// Resolve the agent's pane for tmuxSession. Returns "@w.%p" or null. Injected
// by the server (private socket, exact-target rewrite live in tmux.js).
//
// findRegistrySession({ tmuxSession, paneTarget, ... }) →
//   { status: "matched", sessionId, cwd, pid, registryStatus, updatedAt, version, entries }
//   { status: "unverified", sessionId, ... }  (same shape; see below)
//   { status: "none" | "stale" | "ambiguous" | "unavailable", reason?, entries }
// none        — no record names this tmux session (old claude, or not claude)
// stale       — records name the pane but none belongs to a live claude with
//               that start time (claude exited without cleanup, pid reused)
// unverified  — one live claude by pid+name, but the start time could not be
//               checked (macOS gives none; an older record carries none): pid
//               reuse after a crash cannot be excluded, so callers may fill an
//               EMPTY id from it but never replace a known one
// ambiguous   — two live claudes claim the same pane (never seen; refuse)
// unavailable — the registry dir is unreadable, or the pane can't be resolved
// paneTarget is consulted only when a record names the session at all, so an
// idle fleet of old-claude agents costs a readdir, not a tmux spawn each.
// pidDomain (`linux:<machine-id>:pid:[<pid namespace>]` — the MACHINE id, not
// the boot id, verified 2.1.280 on 2026-09-28) is kept in the record but not
// checked: it is constant across boots, so procStart is the pid-reuse guard.
// The pane key is the `%pane` id (unique for the life of a tmux server); the
// `@window` part is not compared, so break-pane / move-pane cannot turn a
// match into a permanent "none". `registry` takes a readRegistry() result
// already in hand (doctor reads once per request, not once per agent).
const paneIdOf = (target) => { const m = /%\d+$/.exec(String(target || "")); return m ? m[0] : null; };
export function findRegistrySession({ tmuxSession, paneTarget, root = REGISTRY_ROOT, identity = processIdentity, registry = null }) {
  const reg = registry || readRegistry({ root });
  const base = { entries: reg.entries.length, tmuxless: (reg.tmuxless || []).length };
  if (!reg.available) return { status: "unavailable", reason: `registry ${reg.reason}`, ...base };
  const prefix = `${tmuxSession}:`;
  const named = reg.entries.filter((e) => e.tmux.startsWith(prefix));
  if (!named.length) return { status: "none", ...base };
  const pane = typeof paneTarget === "function" ? paneTarget() : paneTarget;
  if (typeof pane !== "string" || !PANE_TARGET_RE.test(pane)) return { status: "unavailable", reason: "pane target unresolved", ...base };
  const paneId = paneIdOf(pane);
  const exact = named.filter((e) => paneIdOf(e.tmux.slice(prefix.length)) === paneId);
  if (!exact.length) return { status: "none", reason: "records name other panes of this session", ...base };
  let unverified = 0;
  const live = exact.filter((e) => {
    const p = identity(e.pid);
    if (!p.alive || !p.claude) return false;
    if (e.procStart === null || p.start === null) unverified++;
    else if (e.procStart !== p.start) return false;
    return true;
  });
  if (!live.length) return { status: "stale", ...base };
  if (live.length > 1) return { status: "ambiguous", ...base };
  const e = live[0];
  return { status: unverified ? "unverified" : "matched", sessionId: e.sessionId, cwd: e.cwd, pid: e.pid, registryStatus: e.status, updatedAt: e.updatedAt, version: e.version, ...base };
}
