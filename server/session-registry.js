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
// procStart a STRING — clock ticks on Linux ("12345"), a `ps lstart` date on
// macOS ("Tue Sep 29 03:50:58 2026", Mac fleet 2026-09-29: every record on
// the machine was rejected as bad-procstart until this was known) —
// updatedAt/startedAt epoch-ms NUMBERS, kind "interactive". Both accepted
// forms are normalised here so a drift in either direction cannot silently
// null a field. procStart keeps its platform's shape (number | string) and
// is compared against processIdentity's `start` of the same shape.
const toIso = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && v && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

// The claude version verified to write the `tmux` field (2.1.284 on the Mac
// fleet, 2026-09-29; 2.1.212 wrote records WITHOUT it — every one was rejected
// and shared-cwd agents went red with a guessed "claude too old?").
export const REGISTRY_TMUX_SINCE = "2.1.284";

// procStart as written (number, numeric string, or a `ps lstart` date string)
// → a comparable value: clock ticks as a number, a date as a
// whitespace-collapsed string (macOS `ps` pads a single-digit day with two
// spaces; the record may not), anything else null (= "unknown", never a
// reason to reject the record — an unverifiable start time makes the match
// `unverified`, which is the honest grade, not a lost pane).
export function normalizeProcStart(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return s.length <= 64 ? s : null;
}

// The record's start vs. the live process's start, both run through the same
// normaliser so the source of either side (record file, /proc, ps, a test
// fixture) cannot make "Tue Sep  9" and "Tue Sep 9" look like a reused pid.
// Returns true / false / null: null = not comparable (either side unknown, or
// the two are of different kinds — ticks vs a date, which happens when the
// record and the live lookup disagree on format, not when a pid was reused).
// Callers grade null as `unverified`, never as stale: a format drift must
// cost verification, not the agent's id.
export function sameStart(a, b) {
  const x = normalizeProcStart(a), y = normalizeProcStart(b);
  if (x === null || y === null || typeof x !== typeof y) return null;
  return x === y;
}

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
  // claude's own reader is `procStartFt ?? procStart` (2.1.284 bundle: a
  // feature gate moves the value to procStartFt); accept both names.
  const procStart = normalizeProcStart(d.procStart ?? d.procStartFt);
  const base = { version, pid: Number.isInteger(pid) && pid > 0 ? pid : null, procStart };
  if (base.pid === null || basename(file) !== `${pid}.json`) return { reject: "bad-pid", ...base };
  if (typeof d.sessionId !== "string" || !UUID_RE.test(d.sessionId)) return { reject: "bad-session-id", ...base };
  // ORDER IS LOAD-BEARING: not-interactive is checked before no-tmux so a
  // `claude -p` child never lands in `tmuxless` (an old claude that omits
  // `kind` altogether would slip through — unverified for 2.1.212).
  if (d.kind != null && d.kind !== "interactive") return { reject: "not-interactive", ...base };
  if (typeof d.tmux !== "string" || !d.tmux) return { reject: "no-tmux", ...base };
  if (typeof d.cwd !== "string" || !d.cwd) return { reject: "no-cwd", ...base };
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
    if (sameStart(r.procStart, p.start) === false) continue;
    if (underPane(r.pid)) return { pid: r.pid, version: r.version };
  }
  return null;
}

// Every tmux-less record sorted by what it IS, for the doctor header: claude
// ≥ 2.1.284 writes `tmux` whenever it runs in a pane, so a live claude whose
// record lacks it is an OLD claude only when its process sits under one of this
// tmux server's panes (`panePids`, from one `list-panes -a`); a live claude
// outside every pane (desktop app, plain terminal — the Mac fleet had five of
// six) never writes the field on any version and is not a finding; a record whose
// pid is gone, is no longer claude, or was started at another time is stale
// (claude exited without removing its file, or the pid was reused). Same
// ancestry walk as findTmuxlessRecordFor — so a claude deeper than two levels
// under its pane shell (a wrapper launcher, a nested tmux) is reported as NOT
// under a pane, never as "fine". `panePids === null` means the pane list
// could not be read: nothing can be placed, `panesKnown` is false and every
// live record lands in notUnderPane for the caller to word honestly.
// Counts and versions only — no ids.
export function classifyTmuxless({ registry, panePids, identity = processIdentity, parent = parentPid, depth = 2 }) {
  const out = { oldClaude: [], notUnderPane: 0, stale: 0, panesKnown: panePids !== null && panePids !== undefined };
  if (!registry || !registry.tmuxless) return out;
  const panes = panePids instanceof Set ? panePids : new Set(panePids || []);
  const underAnyPane = (pid) => {
    let p = pid;
    for (let i = 0; i <= depth && p; i++) {
      if (panes.has(p)) return true;
      p = parent(p);
    }
    return false;
  };
  for (const r of registry.tmuxless) {
    const p = r.pid ? identity(r.pid) : { alive: false };
    if (!p.alive || !p.claude || sameStart(r.procStart, p.start) === false) { out.stale++; continue; }
    if (out.panesKnown && underAnyPane(r.pid)) out.oldClaude.push({ pid: r.pid, version: r.version });
    else out.notUnderPane++;
  }
  return out;
}

// What is process <pid>, right now? { alive, claude, start } — `claude` is true
// when the executable name or argv[0] is claude (argv[0] is what tmux reports
// as pane_current_command on Linux, so a fixture that `exec -a claude`s counts
// the same way the state detector counts it); `start` is the kernel start
// time in the shape claude stores as procStart — clock ticks on Linux, the
// `ps lstart` date string on macOS (same `ps` claude reads, so it compares
// equal after whitespace normalisation) — null where it cannot be read.
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
  return { alive: true, ...psIdentity(pid) };
}

// `ps -ww -o lstart=,comm=` for one pid → { claude, start }, run EXACTLY the
// way claude renders the record's procStart on macOS (2.1.284 bundle:
// `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`) — without the env pin a Mac in
// America/Los_Angeles would read "Mon Sep 28 20:50:58" against a record
// saying "Tue Sep 29 03:50:58" and grade every live claude as a reused pid.
// lstart is a fixed 24-column "Tue Sep 29 03:50:58 2026" (day padded), comm
// (the full executable path on macOS — hence -ww, ps truncates to the
// terminal width otherwise) follows; both come from ONE ps so a pid reused
// between two calls cannot mix processes. A line that does not parse keeps
// the old `ps -o comm=` name check and yields start null (→ unverified).
export const PS_ENV = { LC_ALL: "C", TZ: "UTC" };
export const psArgs = (pid) => ["-ww", "-o", "lstart=,comm=", "-p", String(pid)];
const IS_CLAUDE = /^claude(\.exe)?$/i;
const defaultPsExec = (args) => execFileSync("ps", args, { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...PS_ENV } });
export function psIdentity(pid, exec = defaultPsExec) {
  let out = "";
  try { out = exec(psArgs(pid)); } catch { return { claude: false, start: null }; }
  const line = out.split("\n").find((l) => l.trim()) || "";
  const m = /^\s*([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
  if (m) return { claude: IS_CLAUDE.test(basename(m[2].trim())), start: normalizeProcStart(m[1]) };
  let comm = "";
  try { comm = exec(["-o", "comm=", "-p", String(pid)]).trim(); } catch {}
  return { claude: IS_CLAUDE.test(basename(comm)), start: null };
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
//               checked (an older record carries none; `ps lstart` did not
//               parse; record and live start are of different kinds): pid
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
    const same = sameStart(e.procStart, p.start);
    if (same === null) unverified++;
    else if (!same) return false;
    return true;
  });
  if (!live.length) return { status: "stale", ...base };
  if (live.length > 1) return { status: "ambiguous", ...base };
  const e = live[0];
  return { status: unverified ? "unverified" : "matched", sessionId: e.sessionId, cwd: e.cwd, pid: e.pid, registryStatus: e.status, updatedAt: e.updatedAt, version: e.version, ...base };
}
