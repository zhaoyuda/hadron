// Cursor backend (cursor-agent CLI) — screen reading for state detection.
//
// The record's `backend: "cursor"` picks this reader (state-detector.js); the
// pane command never does: on macOS cursor-agent's pane command is `node`,
// which is also a claude name. Everything here is anchored on the BOTTOM of
// the pane — cursor-agent redraws in place and leaves ghosts above (an earlier
// trust box, stale "→" composer rows scrolled up), so only what sits at the
// last drawn rows is the screen now.
//
// Screens (cursor-agent 2026.11.x, fixtures test/unit/fixtures/cursor/):
//   composer   "→ Add a follow-up" / "→ Plan, search, build anything" (or the
//              operator's draft) near the bottom, footer "Auto · 5.1% · …" then
//              "~/cwd · branch"; WORKING when "ctrl+c to stop" sits at the right
//              of the composer row (a spinner line "⠘⠤ Working  53 tokens" above)
//   approval   a ──── rule, "$ cmd in .", "Run this command?", option rows
//              ending in their key "(y)" / "(tab)" / "(esc or n)", one marked "→"
//   trust      a ╭─╮ box "Do you trust the contents of this directory?" with
//              "[a] Trust this workspace" / "[q] Quit"
// Anything else while cursor-agent runs is "unknown": the reducer holds its
// state and the detector says so (warnOnce + `hadron doctor`).
import { execFile } from "child_process";
import { accessSync, statSync, constants as fsc } from "fs";
import { join, delimiter, isAbsolute } from "path";
import { homedir } from "os";

export const CURSOR_PLACEHOLDERS = ["Add a follow-up", "Plan, search, build anything"];
const SPINNER_RE = /^\s*[⠀-⣿]{1,3}\s+[A-Z][a-z]+(?:…|\.\.\.)?\s+[\d.]+k?\s+tokens?\b/;
const STOP_HINT_RE = /\bctrl\+c to stop\s*$/i;
const RULE_RE = /^[─━]{20,}\s*$/;
const KEY_HINT_RE = /\(([a-z+]+(?: or [a-z+]+)?)\)\s*$/i;
const FOOTER_STATS_RE = /^\s{0,3}(\S[^·]{0,60}?)\s+·\s+(\d{1,3}(?:\.\d+)?)%(?:\s+·|\s*$)/;
const TRUST_RE = /Do you trust the contents of this directory\?/;
const BOX_BOTTOM_RE = /^\s*╰─+╯\s*$/;
const COMPOSER_RE = /^\s{0,3}→\s?(.*)$/;
const RIGHT_HINT_RE = /^\s{20,}\S/;
const BOTTOM_WINDOW = 14;   // drawn rows the composer / footer must sit in

function lastDrawn(lines) {
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  return end;
}

// The approval box: the last ──── rule within the bottom window, with option
// rows below it that end in their key hint, one of them marked "→", and the
// last drawn row one of those options (the box is the bottom of the screen).
function readApproval(lines, end) {
  let rule = -1;
  for (let i = end; i >= Math.max(0, end - 30); i--) if (RULE_RE.test(lines[i])) { rule = i; break; }
  if (rule < 0) return null;
  const options = [];
  let question = null;
  for (let i = rule + 1; i <= end; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const key = t.match(KEY_HINT_RE);
    if (key && !t.startsWith("$")) options.push({ label: t.replace(/^→\s*/, ""), key: key[1], selected: /^→\s/.test(t) });
    else if (!options.length && /\?\s*$/.test(t)) question = t;
  }
  if (options.length < 2 || !options.some((o) => o.selected)) return null;
  // The bottom row is an option; a right-aligned hint under the box
  // ("ctrl+r to review changed files") does not count.
  let last = end;
  while (last > rule && (RIGHT_HINT_RE.test(lines[last]) || !lines[last].trim())) last--;
  if (!KEY_HINT_RE.test(lines[last].trim())) return null;
  return { kind: "approval", question, options };
}

function readTrust(lines, end) {
  if (!BOX_BOTTOM_RE.test(lines[end])) return null;
  for (let i = end; i >= Math.max(0, end - 25); i--) {
    if (/^\s*╭─+╮\s*$/.test(lines[i])) return null;   // reached the box top without the question
    if (TRUST_RE.test(lines[i])) return { kind: "trust" };
  }
  return null;
}

/**
 * Cursor's screen → a snap the shared reducer (nextState) understands:
 *   { state: "working", substatus, stale?, promptVisible? }
 *   { state: "blocked", blockReason: "Needs input", cursorDialog }
 *   { state: null, promptVisible: true, substatus: null }     (at the composer)
 *   { state: "unknown" }                                       (nothing recognised)
 * plus `composer` {text, empty} when the composer is the screen, and `footer`
 * {model, contextPct} when the stats row is drawn.
 */
export function detectCursorState(rawLines, opts = {}) {
  if (opts.altScreen) return { state: "working", substatus: { type: "editor" }, stale: false, altScreen: true };
  const lines = rawLines.map((l) => String(l ?? "").replace(/\s+$/, ""));
  const end = lastDrawn(lines);
  if (end < 0) return { state: "unknown" };

  const trust = readTrust(lines, end);
  if (trust) return { state: "blocked", blockReason: "Needs input", substatus: null, cursorDialog: trust };
  const approval = readApproval(lines, end);
  if (approval) return { state: "blocked", blockReason: "Needs input", substatus: null, cursorDialog: approval };

  // The composer: the bottom-most "→" row inside the bottom window.
  let ci = -1;
  for (let i = end; i >= Math.max(0, end - BOTTOM_WINDOW); i--) if (COMPOSER_RE.test(lines[i])) { ci = i; break; }
  if (ci < 0) return { state: "unknown" };

  let footer = null;
  for (let i = ci + 1; i <= end; i++) {
    const m = lines[i].match(FOOTER_STATS_RE);
    if (m) { footer = { model: m[1].trim(), contextPct: Math.round(Number(m[2])) }; break; }
  }
  // The composer's own text: its row minus the stop hint, plus wrapped rows
  // (indented, before the first blank row).
  let text = lines[ci].match(COMPOSER_RE)[1].replace(/\s{2,}ctrl\+c to stop\s*$/i, "").trim();
  for (let i = ci + 1; i <= end && lines[i].trim() && /^\s{3,}\S/.test(lines[i]) && !FOOTER_STATS_RE.test(lines[i]); i++) text += " " + lines[i].trim();
  const composer = { text, empty: CURSOR_PLACEHOLDERS.includes(text) };
  const base = { composer, footer };

  if (STOP_HINT_RE.test(lines[ci])) return { ...base, state: "working", substatus: null, promptVisible: true };
  // A spinner line right above the composer without the stop hint (a narrow
  // pane can push the hint off the row): working, but only on fresh content —
  // a spinner frozen above an idle composer is a ghost.
  for (let i = ci - 1; i >= Math.max(0, ci - 6); i--) {
    if (SPINNER_RE.test(lines[i])) return { ...base, state: "working", substatus: null, stale: true, promptVisible: true };
    if (lines[i].trim() && !/^[│┌└┐┘─\s]/.test(lines[i])) break;
  }
  return { ...base, state: null, promptVisible: true, substatus: null };
}

// ── Process identity ────────────────────────────────────────────────────────
// Linux shows `cursor-agent` as the pane command; macOS shows `node` (the
// launcher execs bundled node), so there the pane's process tree is asked: a
// process whose args name cursor-agent's versioned index.js under the pane's
// shell (depth ≤ 3) IS cursor-agent.
export const CURSOR_CMD_RE = /^(cursor-agent|agent)$/;
// argv[0] is cursor-agent (by path or name), or an argument is its versioned
// index.js run by node (flags allowed between) — never a tool whose arguments
// merely name cursor-agent or its install dir (grep, cat, ls under the pane).
export const CURSOR_ARGS_RE = /^(?:\S*\/)?node(?:\s+-\S+)*\s+\S*cursor-agent\/versions\/[^/\s]+\/index\.js(?:\s|$)|^(?:\S*\/)?cursor-agent(?:\s|$)/;
const TREE_CMD_RE = /^(node|cursor-agent|agent)$/;

export const cursorCmdCandidate = (cmd) => TREE_CMD_RE.test(String(cmd || "").trim());

// Pure: `ps -A -o pid=,ppid=,args=` output + the pane's pid → true when a
// cursor-agent process lives under it (the pane pid itself included).
export function cursorUnderPid(psOut, panePid, depth = 3) {
  const kids = new Map();
  const args = new Map();
  for (const line of String(psOut || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    args.set(pid, m[3]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let level = [Number(panePid)];
  for (let d = 0; d <= depth && level.length; d++) {
    for (const pid of level) if (CURSOR_ARGS_RE.test(args.get(pid) || "")) return true;
    level = level.flatMap((p) => kids.get(p) || []);
  }
  return false;
}

export function psTable(exec = execFile) {
  return new Promise((resolve) => {
    exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], { timeout: 3000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? null : String(out)));
  });
}

// Where cursor-agent lives, decided once at boot: $HADRON_CURSOR_AGENT (tests),
// then PATH, then ~/.local/bin (its installer's home — a launchd-started server
// on macOS has no ~/.local/bin on PATH). The launcher types this absolute path,
// so the pane's shell PATH never matters. null = not installed (doctor row).
export function resolveCursorAgent(env = process.env) {
  const exe = (p) => { try { if (!statSync(p).isFile()) return false; accessSync(p, fsc.X_OK); return true; } catch { return false; } };
  if (env.HADRON_CURSOR_AGENT) return isAbsolute(env.HADRON_CURSOR_AGENT) && exe(env.HADRON_CURSOR_AGENT) ? env.HADRON_CURSOR_AGENT : null;
  // Absolute PATH entries only: the result is typed into a pane with its own cwd.
  for (const dir of String(env.PATH || "").split(delimiter)) if (isAbsolute(dir) && exe(join(dir, "cursor-agent"))) return join(dir, "cursor-agent");
  const local = join(env.HOME || homedir(), ".local", "bin", "cursor-agent");
  return exe(local) ? local : null;
}

// Why a paste into this cursor screen must wait (null = safe): Enter on the
// approval box ANSWERS it ("Run (once)" — V0, the text is lost), an unknown
// screen is never typed into, and text already in the box would join the
// paste into one message. Mid-turn with an empty box is fine: cursor-agent
// queues it as a follow-up and sends it after the turn.
export function cursorPasteHold(snap) {
  if (!snap || snap.state === "unknown") return "cursor-agent shows a screen Hadron cannot read";
  if (snap.state === "blocked") return snap.cursorDialog?.kind === "trust" ? "cursor-agent is asking whether to trust this folder" : "cursor-agent is waiting for an approval";
  if (snap.altScreen) return "cursor-agent's pane is in a full-screen program";
  if (!snap.composer || !snap.composer.empty) return "cursor-agent's input box holds text — a paste would join it";
  return null;
}
