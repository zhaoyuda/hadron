/**
 * State Detector — polls tmux pane to detect agent state.
 *
 * Simple approach: grab the last few non-chrome lines from the pane
 * and pattern-match to determine what the agent is doing right now.
 *
 * States: idle, working, done, blocked
 */

import { tmuxAsync } from "./tmux.js";
import { warnOnce } from "./log.js";

// Processes that indicate an agent (Claude) is running
const AGENT_PROCESS_RE = /^(claude[-_]?code|claude|node|npx|bun|deno|\d+\.\d+\.\d+)(\.exe)?$/i;

// Shell processes that indicate claude has exited
// Broad on purpose: the message guard fails closed on any of these.
const SHELL_RE = /^(zsh|bash|sh|dash|ash|ksh|mksh|csh|tcsh|fish|nu|xonsh|elvish|pwsh|powershell)(\.exe)?$/i;
export const isShellCmd = (cmd) => SHELL_RE.test(String(cmd || "").trim());

// ── Pane probe parsing (pure; unit-tested without tmux) ──────────────────────
// display-message prints one line ending in "\n". Strip ONLY that newline —
// never .trim(): a trailing space in a command name or path is data, not noise.
export const stripLine = (out) => String(out ?? "").replace(/\r?\n$/, "");

// Format for the atomic state-driving read. The separator MUST be printable
// ASCII: tmux >= 3.5 rewrites every control character in display-message
// output to "_" (TAB, LF, US, SOH all become "_"), so a "\t"-packed format
// collapses into one garbage field on tmux 3.6a (macOS/Homebrew) — cmd never
// matches an agent, every state freezes and no resume checkpoint is written.
// tmux 3.4 (Ubuntu) preserves TAB, which is why this only surfaced on macOS.
//
// alternate_on goes FIRST because it is exactly one char ("0"/"1") and can
// never contain the separator, so everything after the first "|" is the
// command — intact even if the process name itself contains "|". Two unbounded
// fields can never share one delimited string unambiguously, which is why the
// path is read separately (see _poll).
export const CMD_PROBE_FORMAT = "#{alternate_on}|#{pane_current_command}";
export function parseCmdProbe(out) {
  const line = stripLine(out);
  const i = line.indexOf("|");
  if (i < 0) return { altScreen: false, cmd: line };   // no separator: whole line is the cmd
  return { altScreen: line.slice(0, i) === "1", cmd: line.slice(i + 1) };
}

// ── Batched pane probe (ONE tmux spawn for every agent per tick) ─────────────
// Per-pane display-message costs a process per agent per field per second; on
// macOS each spawn is also an endpoint-security policy evaluation (2026-09-23
// field report: 57 agents → ~185 tmux spawns/s → 1.45 cores of Cyberhaven).
// `list-panes -a` lists EVERY pane on the tmux server in one process; each
// line starts with the session name, and detectors look their own name up.
// The two flag chars ("<window_active><pane_active>") select the session's
// active pane — the same pane a `-t <session>` target resolves to — so a
// user-split agent window still reads the pane the agent runs in. No %N pane
// id is read or reused (see paneTarget in the constructor).
//
// Same rules as the single-pane probe: printable separators only (tmux >= 3.5
// rewrites control characters), and never two unbounded fields in one line —
// the command line ends in the cmd probe (alternate_on first, then the whole
// remainder is the command), the path line ends in the path. Hadron's own
// session names can't contain "|" (workspace basename is sanitised, ids are
// slugs), but a FOREIGN session on the same tmux server can be named
// `hadron-ws-x|11` and its line would then parse as a second active pane of
// agent x. One session has exactly one active pane, so a name that shows up
// twice is dropped as ambiguous (and warned about, below) rather than letting
// either line win.
export const BATCH_CMD_FORMAT = "#{session_name}|#{window_active}#{pane_active}|" + CMD_PROBE_FORMAT;
export const BATCH_PATH_FORMAT = "#{session_name}|#{window_active}#{pane_active}|#{pane_current_path}";
const ACTIVE_FLAGS = "11|";

function eachActivePane(out, fn) {
  for (const line of String(out ?? "").split("\n")) {
    const i = line.indexOf("|");
    if (i < 0) continue;
    const rest = line.slice(i + 1);
    if (!rest.startsWith(ACTIVE_FLAGS)) continue;   // not the session's active pane
    fn(line.slice(0, i), rest.slice(ACTIVE_FLAGS.length));
  }
}

// Pure: `list-panes` output (cmd lines, path lines) → Map session name →
// { altScreen, cmd, path }. A session with a cmd line but no path line gets
// path null (the path read is non-fatal, as it always was); a path line for a
// session without a cmd line is ignored.
export function parsePaneList(cmdOut, pathOut) {
  const panes = new Map();
  const seen = new Set();
  eachActivePane(cmdOut, (name, rest) => {
    if (seen.has(name)) { panes.set(name, { ambiguous: true }); return; }
    seen.add(name);
    panes.set(name, { ...parseCmdProbe(rest), path: null });
  });
  eachActivePane(pathOut, (name, rest) => {
    const p = panes.get(name);
    if (p && !p.ambiguous) p.path = rest || null;
  });
  return panes;
}

// One in-flight batch is shared by every detector that asks while it is
// running: the shared ticker calls every detector's _poll() in one synchronous
// loop, so a tick costs exactly two tmux spawns (cmd list + path list) for ALL
// agents instead of two per agent. A cmd-list failure rejects (every caller
// returns without a state update, like a failed display-message did); a
// path-list failure yields null paths (non-fatal, feeds only session.cwd).
// The two reads run one after the other, not in parallel: a wedged tmux then
// holds ONE batch client (and no capture-pane ever starts behind it), so a
// stuck server costs one process, not one per read or per agent
// (test-terminal-ws pins that peak).
let probeInflight = null;
let lastBatchSize = 0;     // active panes seen by the previous successful batch
let emptyStreak = 0;
export function probePanes() {
  if (probeInflight) return probeInflight;
  probeInflight = (async () => {
    try {
      const cmdOut = await tmuxAsync(["list-panes", "-a", "-F", BATCH_CMD_FORMAT], { timeout: 2000 });
      const pathOut = await tmuxAsync(["list-panes", "-a", "-F", BATCH_PATH_FORMAT], { timeout: 2000 }).catch(() => "");
      const panes = parsePaneList(cmdOut, pathOut);
      // Seen once on prod (2026-09-25 12:23:59): a batch with no active pane at
      // all while every session was alive — the next tick was normal. One such
      // read is a glitch, not "all agents gone": treat it like a failed probe
      // (tick skipped, no warnings) unless it repeats. A dead tmux server errors
      // out above instead, and a genuinely empty server reads empty twice.
      if (panes.size === 0 && lastBatchSize > 0 && emptyStreak++ === 0) {
        console.warn(`[state] batch probe returned no active pane (${String(cmdOut).length} bytes, ${String(cmdOut).split("\n").length} lines) right after seeing ${lastBatchSize} — skipping this tick`);
        throw new Error("empty batch");
      }
      emptyStreak = 0;
      lastBatchSize = panes.size;
      return panes;
    } finally {
      probeInflight = null;
    }
  })();
  return probeInflight;
}

// ── Shared ticker ────────────────────────────────────────────────────────────
// One interval for all detectors (rather than one per detector at a random
// phase) is what makes the batch above coalesce: every _poll() of a tick runs
// in the same synchronous loop and joins the same probePanes() promise.
export const POLL_INTERVAL_MS = 1000;
const liveDetectors = new Set();
let tickTimer = null;
function registerDetector(d) {
  liveDetectors.add(d);
  if (!tickTimer) tickTimer = setInterval(() => { for (const det of liveDetectors) det._poll(); }, POLL_INTERVAL_MS);
}
function unregisterDetector(d) {
  liveDetectors.delete(d);
  if (liveDetectors.size === 0 && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
export const livePollerCount = () => liveDetectors.size;

// ── capture-pane backoff for quiet panes ─────────────────────────────────────
// capture-pane is the one per-agent spawn left. A pane whose content has not
// changed for QUIET_AFTER_POLLS consecutive captures (an idle prompt, a done
// agent, a bare shell, a blocked dialog waiting on the user) is captured only
// every CAPTURE_BACKOFF_POLLS ticks; the cmd/altScreen probe still runs every
// tick (free, it's in the batch) and any of these wakes the pane back to full
// rate at once: the foreground command changed, content changed on a backoff
// capture, input was delivered (hadron message, terminal keystrokes) or the
// state was set by hand (wake()). A "working" pane never backs off — its
// quiet stretch IS the settle window the reducer counts down (working → idle
// needs settleThreshold consecutive quiet polls), and a working agent redraws
// its spinner every second anyway, so there is nothing to save there.
export const QUIET_AFTER_POLLS = 3;
export const CAPTURE_BACKOFF_POLLS = 5;

// Chrome / status bar lines to strip before analysis
const CHROME_RE = /ctx \[|⏵⏵|Remote Control|Auto-update|^[─━]+$/i;

// Lines that are chrome ONLY when they don't appear inside a selection prompt (❯ N.)
const CHROME_SOFT_RE = /bypass permissions|shift\+tab/i;

// Slash command autocomplete suggestions (e.g. "/clear   Start a new session...")
const AUTOCOMPLETE_RE = /^\s*\/\w+\s{2,}\S/;

// ── Working indicators ──

// Thinking/streaming indicator — spinner animates through ✢✽✶·+※ etc.
// Match: <any-char> <description>… (<duration> · <tokens> tokens [· extra info])
// Description can be multi-word (e.g. "Landing ds 2026-05-26 scoring…")
const THINKING_RE = /^.\s+\S.*…\s*\((\d+[smh][\dsmh ]*)\s*(?:·\s*[↓↑]?\s*([\d.]+k?)\s*tokens?)?[^)]*\)/;

// Same spinner but without duration yet (just started): <any-char> <description>…
const THINKING_BARE_RE = /^.\s+\S.*…\s*$/;

// ⎿  Waiting… = tool currently executing
const TOOL_WAITING_RE = /⎿\s+Waiting…/;

// ⎿  Running… (42s · timeout 2m) = long-running tool (Bash) still executing
const TOOL_RUNNING_RE = /⎿\s+Running…\s*\(/;

// Tool call header: ● Tool( or indented known-tool-name(
const TOOL_CALL_RE = /^●\s+(\w+)\(/;
const TOOL_CALL_INDENT_RE = /^\s+(Read|Edit|Write|Bash|Agent|Skill|NotebookEdit|WebFetch|WebSearch|Update|LSP)\s*\(/;

// Waiting for background agents or dynamic workflows
const BACKGROUND_AGENTS_RE = /Waiting for \d+ (?:background agents?|dynamic workflows?) to finish/;

// Background shell(s) still running
const SHELL_RUNNING_RE = /(\d+) shells? still running/;

// Chrome status bar: "· 2 shells" (persistent indicator after message scrolls away)
const SHELL_CHROME_RE = /·\s*(\d+)\s+shells?\b/;

// Local agent(s) still running
const LOCAL_AGENT_RE = /(\d+) local agents? still running/;

// Chrome status bar: "· 1 local agent"
const LOCAL_AGENT_CHROME_RE = /·\s*(\d+)\s+local agents?\b/;

// Task progress line: ◯ task-name ... N/M agents done · time · ↓ tokens
const TASK_PROGRESS_RE = /◯\s+\S+.*\d+\/\d+\s+agents?\s+done\b/;

// Propagating… (streaming response to screen)
const PROPAGATING_RE = /Propagating…\s*\(([^)]+)\)/;

// Compacting conversation… (with or without duration — /compact shows progress bar, no parens)
const COMPACTING_RE = /Compacting\s+\w+…/;

// API retry in progress: "Retrying in 3s · attempt 2/10" — a transient API
// failure the agent is auto-recovering from. Real-time work, and crucially the
// "thinking" timer above it often freezes while the call is blocked, so without
// this an actively-retrying agent reads as idle.
// API retry banner. v2.1.269 renders it as a fixed "✻" (error colour) at column 0
// followed by "<head> · Retrying in 3s · attempt 2/10" — the delay comes from the
// duration formatter: "8s" under a minute, "1m 30s" under five, then the most
// significant unit only ("5m", "1h", "1d" — long Retry-After delays are allowed with the
// retry watchdog) — or "No response from the API after 30s · retrying, waiting up to 1m ·
// attempt 2/10" (final attempt: "· retrying once, waiting up to 1m", no attempt count).
// The same renderer draws the stalled-connection form "Waiting for API response · will
// retry in 1m · check your network" and the lower-priority wait "Working at lower
// priority · waiting for capacity · next try in 5m · attempt 2 · esc to interrupt".
// Older builds put it under the message as "⎿  Retrying in 0s · attempt 1/10" with
// nothing in between. All forms are line-anchored on their exact layout, so the banner
// quoted in the agent's prose or echoed in tool output ("  ⎿  529 … · Retrying in 3s")
// does not count. Known tradeoff: a tool that prints exactly "Retrying in 3s · attempt
// 3/10" as its first output line is indistinguishable from the legacy banner (→ retrying).
const RETRY_DELAY = "(?:\\d+d|\\d+h|\\d+m(?: \\d+s)?|\\d+(?:\\.\\d)?s)";
const RETRYING_RE = new RegExp(
  "^(?:✻\\s+(?:.*?·\\s*)?(?:(?:Retrying in|will retry in|next try in) " + RETRY_DELAY + "\\b" +
  "|retrying(?: once)?, waiting up to)" +
  "| {0,2}⎿\\s+Retrying in " + RETRY_DELAY + "\\b)",
);

// ── Blocked indicators ──

// Claude Code renders an API failure as an assistant message whose text STARTS
// with "API Error" (its own isApiErrorMessage test is `text.startsWith("API Error")`,
// plus a few fixed client-composed messages). On screen that is a line beginning
// with the message bullet — "●" (Linux/Windows) or "⏺" (macOS, v2.1.269:
// `M()==="macos"?"\u23FA":"\u25CF"`) — or "⚠", a /goal notice's spinner frame
// (∴ ∷ ∵ — "∷ Goal paused · the request was rate limited · …"), or the 2-space indent.
// Anchoring to the line start (and matching case-sensitively, as the client
// composes these strings) is what stops most of the false positives that pinned
// finished agents to blocked: "DVMM-429" in a catalogue id, "API Error: 429"
// quoted mid-sentence in an answer, "overloaded" in a credit-card summary (prod,
// 2026-09-12: 26 API-error flips in 14 days, none real). The residual risk is a
// continuation line of the agent's own prose that itself begins with one of these
// exact strings at the 2-space indent; accepted. Each head therefore includes its
// delimiter ("API Error: ", "Not logged in(?: ·|$)") so "● API Error handling is done" in a
// summary does not count. The renderer wraps long messages at spaces (text width is
// columns − 10), so where the delimiter follows a space, end-of-line stands in for it:
// "● There's an issue with the selected model" / "  (claude-…). It may not exist…" on
// a 50-column pane is still the error. Matched per line (or per re-joined message
// block, see findApiError), never on the whole tail joined into one string.
const API_ERROR_LINE_RE = new RegExp(
  "^(?:[●⏺⚠∴∷∵]\uFE0F? ?| {0,2})(?:" +
  [
    // "API Error: 429 {…}" — the renderer rewrites even a bare "API Error" message to
    // "API Error: Please wait a moment and try again.", so the colon is always there
    "API Error: ",
    "Please run /login(?: ·|$)",
    "Not logged in(?: ·|$)",
    "OAuth token revoked(?: ·|$)",
    "Login expired(?: ·|$)",
    "Credit balance too low(?: ·|$)",
    "Invalid API key(?: ·|$)",
    "Authentication error(?: ·|$)",
    // SDK timeout: the message text is exactly "Request timed out", drawn verbatim
    // (plus " (API_TIMEOUT_MS=…ms, try increasing it)" when that env var is set)
    "Request timed out(?: \\(API_TIMEOUT_MS=|$)",
    "We are experiencing high demand(?: for |$)",
    "The model is currently overloaded\\.",
    "There's an issue with the selected model(?: \\(|\\.|$)",
    "The model \\S+ is not available on your \\S+ deployment(?:\\.|$)",   // "… your bedrock deployment. Try /model …"
    "(?:Error: )?no healthy deployments\\b",
    "You've hit your (?:channel's )?(?:fast|monthly spend) limit(?: ·|\\.|$)",
    "You've hit your team's shared budget(?: ·|\\.|$)",
    "You're out of usage credits(?: ·|\\.|$)",
    "Your organization is out of usage credits(?: ·|\\.|$)",
    "Your organization's usage credit cap is reached(?: for |$)",
    // /goal notice (prefixed by a goal-spinner frame ∴ ∷ ∵): only the API-caused pauses
    "Goal paused ·(?: (?:usage limit reached|the request was rate limited|the API rejected the last request)|\\s*$)",
    "Goal paused after \\d+ automatic retries ·",
    "AWS (?:credentials expired or invalid|authentication failed)(?: ·|\\.|$)",
    "Google Cloud (?:credentials expired or invalid|authentication failed)(?: ·|\\.|$)",
    // Same family (2.1.284 bundle, the "auth from the environment" messages, each
    // rendered as the head then " · credentials are managed by this environment —
    // retry, or contact your administrator"). "OAuth authentication failed" in the
    // same bundle is an MCP server's OAuth callback error — a tool result, never a
    // block — so it is deliberately NOT here.
    "Microsoft Foundry authentication failed(?: ·|\\.|$)",
    "Gateway refused the request(?: ·|$)",   // no `\.`: this one is ordinary English — a reply ending "Gateway refused the request." must not match
  ].join("|") + ")",
);
// The retry banner's head carries the error. v2.1.269 picks it in exactly three ways:
// rate-limit metadata → "<Type> limit reached" (session/weekly/Opus/Sonnet/Fable/usage
// credit/usage, truncated to ≥10 chars with "…" on narrow panes); otherwise the first
// two attempts → the generic "API error"; from attempt 3 (or network-down / SSL) → the
// formatted error, which is "<status> <message>" when the HTTP status is known ("529
// Overloaded", "429 …rate_limit_error…" — the message may itself contain "·") but just
// the message for a mid-stream (SSE) failure that has no status ("Overloaded"). So the
// rule is by exclusion: a ✻ retry banner whose head is anything other than the generic
// "API error" is the block step 5d should own; "API error · Retrying …", the
// "No response from the API … retrying" form and the legacy "⎿  Retrying in 0s ·
// attempt 1/10" stay working.
const RETRY_ERROR_LINE_RE = new RegExp(
  "^✻\\s+(?!API error\\s*·)(?!No response from the API\\b)\\S.*?·\\s*Retrying in " + RETRY_DELAY,
);
const isApiErrorLine = (l) => API_ERROR_LINE_RE.test(l) || RETRY_ERROR_LINE_RE.test(l);
// A message wraps at spaces on narrow panes (text width is columns − 10), so on a
// 45-column pane the head itself splits: "● There's an issue with the selected" /
// "  model (claude-…)". Re-join each bullet line with its 2-space continuation lines
// (up to a blank line, a tool-result "⎿" or the next bullet) and test the head against
// the joined block — the anchor stays the bullet, so prose is no more exposed than a
// single line is.
//
// findApiError returns the LATEST API-error line (or re-joined wrapped message block) in `lines`,
// or null. Scanned from the bottom, line and block interleaved by position: the
// tail can still hold an earlier "API Error: 500" above a later "Login expired",
// and the reason shown must be the current one (Opus review of the split).
function findApiError(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isApiErrorLine(lines[i])) return lines[i];
    if (!/^[●⏺⚠∴∷∵]/.test(lines[i])) continue;
    let block = lines[i];
    for (let j = i + 1; j < lines.length && /^ {2}[^\s⎿]/.test(lines[j]); j++) block += " " + lines[j].slice(2);
    if (block !== lines[i] && API_ERROR_LINE_RE.test(block)) return block;
  }
  return null;
}
const hasApiError = (lines) => findApiError(lines) !== null;

// What the operator has to DO about the error decides the reason shown on the
// card (Mac fleet suggestion, 2026-09-29: a bare "API error" made a login
// prompt, a spent budget and a 529 look alike in triage):
//   "Login needed"      — credentials: /login, expired or revoked token, bad
//                         API key, gateway/cloud auth, HTTP 401/403
//   "Usage limit"       — money or quota: credits, spend caps, shared budget,
//                         rate limit (429, "<Type> limit reached" retry heads,
//                         /goal paused for a limit)
//   "Model unavailable" — the configured model: issue with the selected
//                         model, not on this deployment, no healthy deployments
//   "API error"         — transient: overloaded, high demand, 5xx, timeouts,
//                         and anything not recognised above (claude retries)
// Classification runs only on a line detection already accepted, so these
// patterns need no anchors of their own — they never decide `blocked`. Order:
// auth, model, then quota — the quota bucket's last alternative spans the
// whole message ("rate limit" anywhere before a "·"), so it goes last.
const API_HEAD = "^(?:[●⏺⚠∴∷∵]\uFE0F? ?| {0,2}|✻\\s+)(?:Error: )?";
const API_ERROR_KIND_RES = [
  ["Login needed", new RegExp(API_HEAD + "(?:Please run /login|Not logged in|OAuth token revoked|Login expired|Invalid API key|Authentication error|AWS (?:credentials|authentication)|Google Cloud (?:credentials|authentication)|Microsoft Foundry authentication|Gateway refused the request|API Error: 40[13]\\b|40[13]\\b)")],
  ["Model unavailable", new RegExp(API_HEAD + "(?:There's an issue with the selected model|The model \\S+ is not available|no healthy deployments)")],
  ["Usage limit", new RegExp(API_HEAD + "(?:Credit balance too low|You've hit your|You're out of usage credits|Your organization(?:'s usage credit cap| is out of usage credits)|Goal paused · (?:usage limit reached|the request was rate limited)|API Error: 429\\b|429\\b|[^·]*\\b(?:limit reached|rate.?limit))")],
];
// The retry banner's rate-limit head is "<Type> reached" for the types claude
// 2.1.284 maps (bundle: session/weekly/Opus/Sonnet/Fable/usage credit/usage
// limit), TRUNCATED to the pane's width (≥10 chars) with a trailing "…" — at 50
// columns "Session limit reached" is "Session li…", so the head is matched as a
// PREFIX of a known type string, not by a literal (the regex floor of 4 chars sits
// below claude's, so no width is missed; the 4-8-char prefixes of these heads are
// stems claude cannot emit at that width).
// An unmapped type renders the raw header value + " reached" as the banner head
// (only there — "<word> reached" elsewhere in a message is not a quota signal).
const RAW_LIMIT_HEAD_RE = /^✻\s+[^·]{1,40} reached\s*·\s*Retrying in /;
const LIMIT_HEADS = ["session limit reached", "weekly limit reached", "opus limit reached", "sonnet limit reached", "fable limit reached", "usage credit limit reached", "usage limit reached"];
function truncatedLimitHead(line) {
  const m = /^✻\s+(.{4,}?)…\s*·\s*Retrying in /.exec(line);
  if (!m) return false;
  const head = m[1].toLowerCase();
  return LIMIT_HEADS.some((h) => h.startsWith(head));
}
export function apiErrorReason(line) {
  if (typeof line !== "string") return "API error";
  for (const [reason, re] of API_ERROR_KIND_RES) if (re.test(line)) return reason;
  return RAW_LIMIT_HEAD_RE.test(line) || truncatedLimitHead(line) ? "Usage limit" : "API error";
}

const WAITING_INPUT_RE = /Allow once|Allow always|Allow\s+Deny|Do you want to proceed|manually approve this|❯ Enter to select|Esc to cancel|Would you like to proceed\?|written up a plan|Yes, and bypass permissions|Yes, manually approve edits/;

// Claude Code numbered selection prompt: ❯ 1. Option text
const SELECTION_PROMPT_RE = /^❯\s+\d+\.\s/;

// Claude Code opens vim/vi to edit a temp file for user prompt input
const PROMPT_EDITOR_RE = /claude-prompt-[a-f0-9-]+\.md/;

/**
 * Scan the last few lines of pane content and return what the agent is doing.
 *
 * Claude Code layout (bottom to top):
 *   [status bar / chrome]
 *   ────────── separator
 *   ❯ prompt
 *   ────────── separator
 *   · Thinking… (5s)     ← working indicator
 *   [content output]
 *
 * So we need: the prompt line + a few lines ABOVE it.
 */
// Claude's own context meter, when the pane shows it. The footer prints one of
// "N% context used" / "N% until auto-compact" / "Context low (N% remaining)"
// only once the level is past "ok" (2.1.284) — so a match is authoritative and
// no match means nothing (the transcript's usage is the badge's fallback, see
// server/transcript.js). The footer is the last thing on screen and sits BELOW
// the input box, so only the bottom CONTEXT_TAIL_LINES rows are read and only
// those under the last `❯` prompt line among them: a reply that quotes the
// phrase (a cat of this file, "you are at 72% context used") sits above the
// box and is never the meter. No prompt line in the tail (a permission dialog,
// a scrolled pane) → null, and the transcript's number stands. Pure; returns
// { pct } (0–100, used) or null.
const CONTEXT_USED_RE = /(\d{1,3})% context used\b/;
const CONTEXT_LEFT_RE = /(\d{1,3})% until auto-compact\b|Context low \((\d{1,3})% remaining\)/;
const CONTEXT_TAIL_LINES = 16;   // chrome under the box (statusline, hints) — the prompt-line rule keeps replies out
export function contextFromPane(rawLines) {
  let end = rawLines.length;
  while (end > 0 && !(rawLines[end - 1] || "").trim()) end--;   // trailing blank rows
  const start = Math.max(0, end - CONTEXT_TAIL_LINES);
  let prompt = -1;
  for (let i = end - 1; i >= start; i--) {
    const t = (rawLines[i] || "").trim();
    if (/^❯/.test(t) && !/^❯\s+\d+\./.test(t)) { prompt = i; break; }
  }
  if (prompt < 0) return null;
  for (let i = end - 1; i > prompt; i--) {
    const line = rawLines[i] || "";
    let m = line.match(CONTEXT_USED_RE);
    if (m) return { pct: clampPct(Number(m[1])) };
    m = line.match(CONTEXT_LEFT_RE);
    if (m) return { pct: clampPct(100 - Number(m[1] ?? m[2])) };
  }
  return null;
}
const clampPct = (n) => Math.max(0, Math.min(100, n));

export function detectState(rawLines, opts = {}) {
  // ── Step 0: Alt-screen (full-screen TUI) short-circuit ──
  // When the pane is in the alternate screen buffer, it's a full-screen TUI
  // (vim, less, htop) — the captured content is a file/buffer, NOT Claude's
  // prompt+indicator layout. Running the normal scan here causes false
  // "blocked"/"done" hits when the buffer happens to contain matching text.
  // The one TUI we DO care about is Claude's own prompt editor (vi on a
  // claude-prompt-*.md temp file), which means it's waiting for the user.
  if (opts.altScreen) {
    if (PROMPT_EDITOR_RE.test(rawLines.join("\n"))) {
      return { state: "blocked", blockReason: "Needs input", substatus: null, altScreen: true };
    }
    // Some other editor/pager is open (e.g. Claude's Edit spawned vim). Treat as
    // busy rather than guessing — never blocked/done from arbitrary buffer text.
    return { state: "working", substatus: { type: "editor" }, stale: false, altScreen: true };
  }

  // ── Step 1: Find prompt position ──
  // Scan bottom-up for the `❯` prompt line (not a selection prompt like `❯ 1.`)
  let promptIdx = -1;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const trimmed = rawLines[i].trim();
    if (/^❯/.test(trimmed) && !/^❯\s+\d+\./.test(trimmed)) {
      promptIdx = i;
      break;
    }
  }
  const hasPrompt = promptIdx >= 0;

  // ── Step 2: Build scan window ──
  // "above": content lines above the prompt (or bottom of pane if no prompt).
  // These are the lines where active working indicators would appear.
  // "tail": last 15 raw lines, used for background/blocked checks.
  const tail = rawLines.slice(Math.max(0, rawLines.length - 15));

  // Collect non-chrome content lines above the prompt (up to 20 lines).
  // If no prompt, collect from the bottom of the pane.
  // 20, not 8: newer Claude Code inserts content between the live spinner and
  // the composer — session survey, queued-message notices, todo-HUD lines — and
  // at 8 those pushed the spinner out of the window entirely, so a hard-working
  // agent read as at-prompt → done → idle (Yuda's OPTIMIZER screenshot,
  // 2026-07-23; fixture working-thinking-pushed-out). Stale-spinner false
  // positives stay guarded by the snap.stale + content-change gate in nextState.
  const above = [];
  const scanStart = hasPrompt ? promptIdx - 1 : rawLines.length - 1;
  for (let i = scanStart; i >= 0 && above.length < 20; i--) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (CHROME_RE.test(line) || /^[─━]+$/.test(trimmed)) continue;
    if (AUTOCOMPLETE_RE.test(line)) continue;
    const isSelLine = /^❯\s+\d+\./.test(trimmed) || /^\d+\.\s/.test(trimmed);
    if (!isSelLine && CHROME_SOFT_RE.test(line)) continue;
    above.unshift(line);
  }

  // ── Step 3: Working indicators in "above" window ──
  // Always check — the ❯ prompt is visible in Claude Code even during active thinking.
  // When prompt IS visible, flag `promptVisible` so the caller (StateDetector) can
  // use content-change detection to distinguish stale indicators from active work.

  // 3a. Propagating… / Compacting…
  for (const line of above) {
    const pm = line.match(PROPAGATING_RE);
    if (pm) {
      const info = pm[1];
      const durMatch = info.match(/^([\d]+[smh][\d\s·smh]*?)(?:\s*·|$)/);
      const tokMatch = info.match(/↓?\s*([\d.]+k?)\s*tokens?/);
      return {
        state: "working", promptVisible: hasPrompt, stale: true,
        substatus: { type: "streaming", duration: durMatch?.[1]?.trim() || null, tokens: tokMatch?.[1] || null },
      };
    }
    if (COMPACTING_RE.test(line)) {
      const durM = line.match(/\(([^)]+)\)/);
      return {
        state: "working", promptVisible: hasPrompt, stale: true,
        substatus: { type: "compacting", duration: durM?.[1]?.trim() || null },
      };
    }
  }

  // 3b. Tool executing: ⎿  Waiting… or ⎿  Running… (most specific — check before thinking)
  // Strong (not stale): an executing tool is a real-time signal, never a leftover.
  for (let i = above.length - 1; i >= 0; i--) {
    if (TOOL_WAITING_RE.test(above[i]) || TOOL_RUNNING_RE.test(above[i])) {
      return { state: "working", promptVisible: hasPrompt, stale: false, substatus: { type: "tool", tool: _findToolName(above, i) } };
    }
  }

  // 3b'. API retry in progress ("Retrying in 3s · attempt 2/10"). Strong, not
  // stale: an active retry is real-time work, and the thinking timer above it
  // frequently freezes while the failing call blocks — so check it before the
  // (stale) thinking indicators, which would otherwise need a content change
  // that never comes and leave a retrying agent stuck on idle. Scan the tail
  // (the "⎿ Retrying…" line sits below the spinner, not in the `above` window).
  // Exception: a retry that accompanies a hard API error code (429/5xx/auth) is
  // a real block the user should see — let step 5d claim it instead.
  if (tail.some((l) => RETRYING_RE.test(l)) && !hasApiError(tail)) {
    return { state: "working", promptVisible: hasPrompt, stale: false, substatus: { type: "retrying" } };
  }

  // 3c. Thinking with duration: <spinner> <description>… (duration · tokens)
  for (const line of above) {
    const m = line.match(THINKING_RE);
    if (m) {
      return {
        state: "working", promptVisible: hasPrompt, stale: true,
        substatus: { type: "thinking", duration: m[1].trim(), tokens: m[2] || null },
      };
    }
  }

  // 3d. Bare thinking: <spinner> <description>… (no duration yet)
  for (const line of above) {
    if (THINKING_BARE_RE.test(line.trim())) {
      return { state: "working", promptVisible: hasPrompt, stale: true, substatus: { type: "thinking" } };
    }
  }

  // 3e. Broad fallback: any "<spinner> <description>… (...)" pattern
  for (const line of above) {
    if (/^.\s+\S.*…\s*\(/.test(line)) {
      return { state: "working", promptVisible: hasPrompt, stale: true, substatus: { type: "thinking" } };
    }
  }

  // ── Step 4: Background/concurrent work (always checked in tail) ──

  // 4a. Background agents
  const tailText = tail.join("\n");
  if (BACKGROUND_AGENTS_RE.test(tailText)) {
    return { state: "working", substatus: { type: "agents" } };
  }

  // 4b. Background shells or local agents (check content + chrome status bar).
  // A background shell is NOT by itself "working": Claude Code shows the
  // "· N shells" chrome for as long as the shell lives, and a dev server left
  // in one keeps it there for days (a Mac agent read "working · 1 shell" at an
  // empty prompt for ten days, and blocked every "no agent working" check).
  // The count is remembered and decided in step 6: prompt visible and nothing
  // else going on → idle, with the count as substatus so the deck still shows
  // "· 1 shell"; no prompt → working; a blocked dialog (step 5) wins over both.
  let shellSub = null;
  for (const line of tail) {
    const sm = line.match(SHELL_RUNNING_RE) || line.match(SHELL_CHROME_RE);
    if (sm) {
      shellSub = { type: "shell", count: parseInt(sm[1]) };
      // no `continue`: the chrome puts "· 1 shell  · 3 local agents" on ONE
      // line, and running local agents must still read as working below.
    }
    const am = line.match(LOCAL_AGENT_RE) || line.match(LOCAL_AGENT_CHROME_RE);
    if (am) {
      return { state: "working", substatus: { type: "agents", count: parseInt(am[1]) } };
    }
    if (TASK_PROGRESS_RE.test(line)) {
      return { state: "working", substatus: { type: "agents" } };
    }
  }

  // ── Step 5: Blocked checks ──

  // 5a. Selection prompt (❯ 1. Option text) — check bottom of pane
  const bottom5 = rawLines.slice(Math.max(0, rawLines.length - 5));
  for (const line of bottom5) {
    if (SELECTION_PROMPT_RE.test(line.trim())) {
      return { state: "blocked", blockReason: "Needs input", substatus: null };
    }
  }

  // 5b. Permission / input dialogs
  if (WAITING_INPUT_RE.test(tailText)) {
    return { state: "blocked", blockReason: "Needs input", substatus: null };
  }

  // 5c. Prompt editor (vi editing /tmp/claude-prompt-*.md)
  const allText = rawLines.join("\n");
  if (PROMPT_EDITOR_RE.test(allText)) {
    return { state: "blocked", blockReason: "Needs input", substatus: null };
  }

  // 5d. API error — a line that BEGINS with one of Claude Code's error messages,
  // or a retry banner whose head is a real error rather than the generic "API error"
  const apiErr = findApiError(tail);
  if (apiErr !== null) {
    return { state: "blocked", blockReason: apiErrorReason(apiErr), substatus: null };
  }

  // ── Step 6: Final state ──
  if (hasPrompt) {
    // Idle; a lingering background shell rides along as substatus (see 4b).
    return { state: null, promptVisible: true, substatus: shellSub };
  }
  if (shellSub) {
    return { state: "working", substatus: shellSub };
  }
  return { state: "inconclusive", substatus: null };
}

function _findToolName(lines, fromIdx) {
  for (let j = fromIdx - 1; j >= 0; j--) {
    const m = lines[j].match(TOOL_CALL_RE) || lines[j].match(TOOL_CALL_INDENT_RE);
    if (m) return m[1];
  }
  return null;
}


/**
 * Pure transition reducer. Given the current machine state + counters (`m`) and
 * one poll's inputs, mutate the counters and return a decision:
 *   - { state, blockReason?, substatus? } → change to `state`
 *   - { substatus }                       → keep state, refresh substatus only
 *   - null                                → no change
 *
 * Kept side-effect-free (only mutates the passed-in `m`) so it can be unit-tested
 * without tmux. The class wrapper applies decisions via _setState.
 *
 * `m` fields: current, blockReason, substatus, notWorking, inconclusive, blockedHits,
 *             shellHits, settleThreshold (default 8), inconclusiveThreshold (2).
 * inputs: cmd, snap (from detectState), contentChanged, canTransition.
 */
export function nextState(m, { cmd, snap, contentChanged, canTransition }) {
  const settleThreshold = m.settleThreshold ?? 8;
  const inconclusiveThreshold = m.inconclusiveThreshold ?? 2;
  const isAgent = AGENT_PROCESS_RE.test(cmd);
  const isShell = SHELL_RE.test(cmd);
  const current = m.current;

  // ── Shell foreground ──
  if (isShell) {
    // A shell in the alternate screen means the user opened a TUI (less, vim,
    // htop) from the shell — that's not "Claude exited", so don't mark done.
    if (snap.altScreen) { m.shellHits = 0; return null; }
    // Claude exited back to the shell. Require TWO consecutive shell reads before
    // declaring done: mid-run, a tool spawn can momentarily surface a shell as
    // pane_current_command, which previously caused a transient working→done→idle
    // flip before the agent bounced back to working.
    if (current === "working" || current === "blocked") {
      m.shellHits++;
      if (m.shellHits >= 2 && canTransition) { m.shellHits = 0; return { state: "done" }; }
      return null;
    }
    m.shellHits = 0;
    return null;
  }
  m.shellHits = 0;

  // ── Non-agent foreground (vim/python/less as a tool, or user-opened) ──
  if (!isAgent) {
    // If we were blocked, the block is stale now that a different process holds
    // the pane (user acted) — resolve it instead of freezing in "blocked".
    if (current === "blocked" && canTransition) {
      m.blockedHits = 0;
      return { state: m.blockReason === "Needs input" ? "idle" : "done" };
    }
    return null;
  }

  // ── Agent foreground ──
  // Agent pane in a full-screen editor (Claude's integrated prompt editor, or an
  // Edit-spawned vim): pane_current_command is still the agent but the pane is in
  // the alternate screen. detectState can only return working/blocked from the
  // buffer here, but the agent isn't producing output and isn't awaiting a
  // Claude-level decision — the human is editing. Settle to idle rather than
  // showing a misleading working/blocked. (Guarded by test-state-machine's
  // "agent pane in editor alt-screen" cases.)
  if (snap.altScreen) {
    m.notWorking = 0; m.inconclusive = 0; m.blockedHits = 0;
    if (current !== "idle" && canTransition) return { state: "idle" };
    return null;
  }
  if (snap.state === "working") {
    // Stale-indicator guard: a thinking/streaming/compacting spinner can linger
    // above the prompt after a turn ends. Only those (snap.stale) need content-
    // change confirmation before idle→working. Strong indicators (executing tool,
    // background agents/shells) are real-time — trust them immediately, which also
    // fixes the sluggish idle→working detection for tool/streaming work.
    if (snap.stale && snap.promptVisible && !contentChanged && current !== "working") {
      return null;
    }
    m.notWorking = 0; m.inconclusive = 0; m.blockedHits = 0;
    if (current !== "working") {
      return canTransition ? { state: "working", substatus: snap.substatus } : null;
    }
    return { substatus: snap.substatus };
  }

  if (snap.state === "blocked") {
    m.notWorking = 0; m.inconclusive = 0;
    // Hysteresis: require 2 consecutive blocked snaps before latching, so a single
    // transient frame (e.g. a momentarily selection-looking line) can't flip us.
    m.blockedHits++;
    if (current !== "blocked" && m.blockedHits >= 2 && canTransition) {
      return { state: "blocked", blockReason: snap.blockReason };
    }
    return null;
  }
  m.blockedHits = 0;

  if (snap.state === "inconclusive") {
    m.notWorking = 0;
    m.inconclusive++;
    if (current === "idle" && m.inconclusive >= inconclusiveThreshold && canTransition) {
      return { state: "working" };
    }
    return null;
  }

  // At prompt (snap.state === null)
  m.inconclusive = 0;
  if (current === "working") {
    if (contentChanged) { m.notWorking = 0; return null; }
    m.notWorking++;
    if (m.notWorking >= settleThreshold && canTransition) { return { state: "done", substatus: snap.substatus }; }
    return null;
  }
  if (current === "blocked" && canTransition) {
    return { state: m.blockReason === "Needs input" ? "idle" : "done", substatus: snap.substatus };
  }
  // Idle/done at the prompt: an at-prompt snap can still carry a background
  // substatus (a shell left running — detectState step 4b/6). Keep the state
  // and refresh only the substatus, and only when it actually changed, so a
  // quiet pane produces no decision at all.
  if (current === "idle" || current === "done") {
    const want = snap.substatus || null;
    const have = m.substatus || null;
    if ((want?.type ?? null) !== (have?.type ?? null) || (want?.count ?? null) !== (have?.count ?? null)) {
      return { substatus: want };
    }
  }
  return null;
}

// One more "needs me" event for `session`: attentionRev++ (ackRev untouched),
// attentionAt = now. `persist` (optional) is the caller's save hook — the
// detector never touches the store itself. Shared by the detector and the
// manual state PATCH so both paths count the same way.
export function raiseAttention(session, persist, state) {
  session.attentionRev = (Number.isInteger(session.attentionRev) ? session.attentionRev : 0) + 1;
  session.attentionAt = new Date().toISOString();
  if (state) session.attentionState = state; // the state that raised — see _setState's first-verdict rule
  if (typeof persist === "function") persist(session);
}
export const needsAttention = (s) => (s.attentionRev || 0) > (s.ackRev || 0);

export class StateDetector {
  constructor(tmuxSessionName, session, { poll = true } = {}) {
    this.tmuxName = tmuxSessionName;
    this.session = session;
    this.disposed = false;

    this.stateEnteredAt = Date.now();
    this.minStateDuration = 1000;

    // Debounce: require N consecutive polls with prompt visible + no content change to leave "working"
    this.notWorkingCount = 0;
    this.settleThreshold = 8;

    // Debounce: require N consecutive inconclusive polls before idle → working
    this.inconclusiveCount = 0;
    this.inconclusiveThreshold = 2;

    // Hysteresis counters (see nextState): consecutive blocked snaps before
    // latching "blocked", and consecutive shell-foreground reads before "done".
    this.blockedCount = 0;
    this.shellDoneCount = 0;

    // Content change detection: hash of last pane content
    this.lastContentHash = null;

    // Pane target is the stable *session name*. Every per-pane tmux call in
    // _poll targets it directly (and the batched list is keyed by it) and lets
    // tmux resolve the session's current pane itself, inside that one call. We deliberately do NOT cache a %N pane id (nor resolve one
    // and thread it across calls): tmux recycles %N ids after a pane dies, so a
    // stale id can silently start pointing at a *different* agent's pane after a
    // tmux-server restart / session recreation — scrambling state across boxes (a
    // monitor built at boot polling a pane recreated hours later). Never handing a
    // %N id from one tmux invocation to the next is what makes foreign-pane
    // aliasing impossible; a bare `-t <session>` is also base-index-immune (no
    // window.pane numeric index involved). Hadron agent sessions are single-pane,
    // so "the session's active pane" is unambiguously the agent's pane.
    this.paneTarget = this.tmuxName;

    // Polls are async (tmuxAsync) so a slow or wedged tmux never stalls the
    // event loop; at most one poll per detector is in flight — a tick that
    // arrives while the previous poll is still waiting on tmux is skipped, so a
    // stuck pane costs itself, not a growing pile of spawns.
    this.polling = false;

    // capture-pane backoff state (see QUIET_AFTER_POLLS): consecutive captures
    // with unchanged content, ticks since the last capture, last seen command.
    this.quietPolls = 0;
    this.sinceCapture = 0;
    this.lastCmd = undefined;

    // Skip first 3 polls (3s — let Claude start up)
    this.skipCount = 3;

    // Ticks come from the module-wide interval (one for all detectors, so the
    // pane probe is batched). Tests pass { poll: false } and drive _poll().
    this.polls = poll;
    if (poll) registerDetector(this);
  }

  // Back to full-rate capture on the next tick. Called on input to the pane
  // (message delivery, terminal keystrokes) and manual state changes — the
  // moments a quiet pane is most likely to stop being quiet.
  wake() {
    this.quietPolls = 0;
    this.sinceCapture = CAPTURE_BACKOFF_POLLS;
  }

  // Returns a promise (tests drive it directly with `await det._poll()`); the
  // timer ignores the result. Every await is followed by a disposed check so a
  // detector disposed mid-poll never touches its session again.
  async _poll() {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      if (this.session._manualOverrideUntil && Date.now() < this.session._manualOverrideUntil) return;
      await this._pollOnce();
    } catch (e) {
      // Every tmux failure is handled inside _pollOnce; anything reaching here
      // is a programming error that would otherwise silently retire detection
      // for this agent (silent-failure rule: warn once per agent, keep polling).
      warnOnce(`poll-error:${this.session.id}`, `[state] poll failed for agent ${this.session.id}: ${e && e.message}`);
    } finally {
      this.polling = false;
    }
  }

  async _pollOnce() {
    // ONE batched read for every agent (probePanes): tmux resolves each
    // session's active pane inside that one call. No pane id is read back or
    // reused, so nothing can alias a foreign pane (see the paneTarget note in
    // the constructor). altScreen + cmd come from one line, so they always
    // describe the same instant; the path comes from its own line.
    let panes;
    try {
      panes = await probePanes();
    } catch {
      return;
    }
    if (this.disposed) return;
    const pane = panes.get(this.paneTarget);
    if (!pane || pane.ambiguous) {
      this.session.contextPct = null;   // no pane, no meter (the transcript's number stands)
      // No detection and no resume checkpoint for this agent until it comes
      // back: silent-failure rule — say so once per agent. (A session that is
      // simply gone used to be a silently failed display-message.)
      warnOnce(`pane-missing:${this.session.id}`, pane
        ? `[state] agent ${this.session.id}: more than one tmux session parses as ${this.paneTarget} — state detection suspended for it (a foreign session name containing "|"?)`
        : `[state] agent ${this.session.id}: tmux session ${this.paneTarget} is not on the server — state detection and resume tracking are idle until it exists`);
      return;
    }
    const { altScreen, cmd, path: panePath } = pane;

    // Runtime-checkpoint piggyback (resume.js): the tracker just needs the
    // pane's foreground command each poll (every tick, backoff or not). Never
    // let it break detection.
    if (this.onCmd) try { this.onCmd(cmd); } catch {}

    // No await between the disposed check above and this write.
    if (panePath && panePath !== this.session.cwd) {
      this.session.cwd = panePath;
    }

    // A foreground change (claude launched / exited, an editor opened) is the
    // cheapest "something happened" signal there is — it costs nothing extra
    // and ends any backoff at once.
    if (cmd !== this.lastCmd) {
      this.lastCmd = cmd;
      this.wake();
    }
    if (this.skipCount === 0 && this.session.state !== "working" && this.quietPolls >= QUIET_AFTER_POLLS) {
      if (++this.sinceCapture < CAPTURE_BACKOFF_POLLS) return;   // quiet pane: skip this capture
    }
    this.sinceCapture = 0;

    let rawLines;
    try {
      const raw = await tmuxAsync(["capture-pane", "-t", this.paneTarget, "-p"], { timeout: 2000 });
      rawLines = raw.split("\n");
    } catch {
      return;
    }
    if (this.disposed) return;
    // All awaits are behind us: from here to the end of the poll is synchronous,
    // so a detector disposed mid-poll never writes to its session.

    // Context meter (runtime-only, never persisted — saveAgent allowlists what
    // goes to disk): claude's own percentage while the pane shows it, else null
    // and the session list falls back to the transcript's usage. A pane that is
    // not running an agent has no meter, whatever its text says.
    // While a tool child (bash, python3) is the foreground command of a working
    // agent the last reading stands — the meter is still on screen behind it
    // and the badge must not flip between sources every capture.
    if (AGENT_PROCESS_RE.test(cmd)) this.session.contextPct = contextFromPane(rawLines)?.pct ?? null;
    else if (this.session.state !== "working") this.session.contextPct = null;

    if (this.skipCount > 0) {
      this.skipCount--;
      if (this.skipCount === 0) {
        this._applySnap(cmd, detectState(rawLines, { altScreen }), false);
      }
      return;
    }

    // Content change detection: if pane content changed, agent is likely active
    const contentSample = rawLines.slice(-20).join("\n");
    let contentHash = 0;
    for (let i = 0; i < contentSample.length; i++) contentHash = ((contentHash << 5) - contentHash + contentSample.charCodeAt(i)) | 0;
    const contentChanged = this.lastContentHash !== null && this.lastContentHash !== contentHash;
    this.lastContentHash = contentHash;
    this.quietPolls = contentChanged ? 0 : this.quietPolls + 1;

    this._applySnap(cmd, detectState(rawLines, { altScreen }), contentChanged);
  }

  _applySnap(cmd, snap, contentChanged) {
    // Build a machine view over this detector's counters, run the pure reducer,
    // then write counters back and apply the decision through _setState (the
    // single mutation point, which keeps its own min-duration / override guards).
    const m = {
      current: this.session.state || "idle",
      blockReason: this.session.blockReason,
      substatus: this.session.substatus || null,
      notWorking: this.notWorkingCount,
      inconclusive: this.inconclusiveCount,
      blockedHits: this.blockedCount,
      shellHits: this.shellDoneCount,
      settleThreshold: this.settleThreshold,
      inconclusiveThreshold: this.inconclusiveThreshold,
    };
    const decision = nextState(m, { cmd, snap, contentChanged, canTransition: this._canTransition() });

    this.notWorkingCount = m.notWorking;
    this.inconclusiveCount = m.inconclusive;
    this.blockedCount = m.blockedHits;
    this.shellDoneCount = m.shellHits;

    if (!decision) return;
    if (decision.state) {
      this._setState(decision.state, decision.blockReason, decision.substatus);
    } else if (decision.substatus !== undefined) {
      this.session.substatus = decision.substatus;
    }
  }

  _canTransition() {
    return Date.now() - this.stateEnteredAt >= this.minStateDuration;
  }

  _setState(state, blockReason, substatus) {
    if (this.session.state === state) return;

    if (this.session._manualOverrideUntil && Date.now() < this.session._manualOverrideUntil) {
      return;
    }

    this.session.state = state;
    this.stateEnteredAt = Date.now();
    this.session.substatus = substatus || null;
    // Attention is a separate bit from state (mail model: state = what the pane
    // is doing, attention = whether the operator has seen it). Every ENTRY into
    // done/blocked raises it; nothing here ever lowers it — only an ack does
    // (PATCH ackRev, or input typed into the pane), so a card stays lit until
    // the operator has actually looked, and lights again if the agent finishes
    // another round while they are looking (the rev moved on).
    //
    // State is not persisted (the loader resets it to idle), attention is. So
    // the detector's FIRST verdict after a boot is usually a re-recognition of
    // the turn that already raised — re-raising it would re-light a fleet the
    // operator had triaged to zero before a service restart. A first verdict
    // equal to the persisted attentionState is therefore not an entry; any
    // later transition, or a first verdict of a different kind, is.
    const firstVerdict = !this._verdictSeen;
    this._verdictSeen = true;
    if ((state === "done" || state === "blocked") && !(firstVerdict && state === this.session.attentionState)) {
      raiseAttention(this.session, this.onAttention, state);
    }

    if (state === "blocked" && blockReason) {
      this.session.blockReason = blockReason;
    } else if (state !== "blocked") {
      this.session.blockReason = undefined;
    }

    console.log(
      `[state-detector] Session "${this.session.id}" → ${state}${blockReason ? ` (${blockReason})` : ""}${substatus ? ` [${substatus.type}${substatus.tool ? `: ${substatus.tool}` : ""}]` : ""}`
    );
  }

  resetCooldown() {
    // Reset transition timer so next poll can transition immediately — and
    // make sure that next poll actually captures (a manual state change is
    // input to the pane in every sense that matters here).
    this.stateEnteredAt = 0;
    this.wake();
  }

  dispose() {
    this.disposed = true;
    if (this.polls) unregisterDetector(this);
  }
}
