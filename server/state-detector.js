/**
 * State Detector — polls tmux pane to detect agent state.
 *
 * Simple approach: grab the last few non-chrome lines from the pane
 * and pattern-match to determine what the agent is doing right now.
 *
 * States: idle, working, done, blocked
 */

import { tmux } from "./tmux.js";

// Processes that indicate an agent (Claude) is running
const AGENT_PROCESS_RE = /^(claude[-_]?code|claude|node|npx|bun|deno|\d+\.\d+\.\d+)(\.exe)?$/i;

// Shell processes that indicate claude has exited
const SHELL_RE = /^(zsh|bash|sh|fish)$/i;

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
const RETRYING_RE = /Retrying in \d+s\b|·\s*attempt \d+\/\d+/i;

// ── Blocked indicators ──

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /API Error:\s*[45]\d\d/i,
  /BadRequestError/i,
  /no healthy deployments/i,
  /There's an issue with the selected model/i,
  /model.*not exist/i,
  /you may not have access/i,
  /InvalidRequestError/i,
  /AuthenticationError/i,
  /\b(?:40[0-9]|5[0-9]{2})\s+(?:Forbidden|Unauthorized|Not Found|Internal Server Error|Bad Gateway|Service Unavailable)/i,
];

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

  // Collect non-chrome content lines above the prompt (up to 8 lines).
  // If no prompt, collect from the bottom of the pane.
  const above = [];
  const scanStart = hasPrompt ? promptIdx - 1 : rawLines.length - 1;
  for (let i = scanStart; i >= 0 && above.length < 8; i--) {
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
  const retryTail = tail.join("\n");
  if (RETRYING_RE.test(retryTail) && !RATE_LIMIT_PATTERNS.some((p) => p.test(retryTail))) {
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

  // 4b. Background shells or local agents (check content + chrome status bar)
  for (const line of tail) {
    const sm = line.match(SHELL_RUNNING_RE) || line.match(SHELL_CHROME_RE);
    if (sm) {
      return { state: "working", substatus: { type: "shell", count: parseInt(sm[1]) } };
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

  // 5d. API error
  for (const pat of RATE_LIMIT_PATTERNS) {
    if (pat.test(tailText)) {
      return { state: "blocked", blockReason: "API error", substatus: null };
    }
  }

  // ── Step 6: Final state ──
  if (hasPrompt) {
    return { state: null, substatus: null };
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
 * `m` fields: current, blockReason, notWorking, inconclusive, blockedHits,
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
    if (m.notWorking >= settleThreshold && canTransition) { return { state: "done" }; }
    return null;
  }
  if (current === "blocked" && canTransition) {
    return { state: m.blockReason === "Needs input" ? "idle" : "done" };
  }
  return null;
}

export class StateDetector {
  constructor(tmuxSessionName, session) {
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

    // Resolve the first pane ID (immune to base-index settings)
    this.paneTarget = this.tmuxName;
    try {
      const paneId = tmux(["list-panes", "-t", this.tmuxName, "-F", "#{pane_id}"], { timeout: 2000 })
        .trim().split("\n")[0];
      if (paneId) this.paneTarget = paneId;
    } catch {}

    this.pollTimer = setInterval(() => this._poll(), 1000);

    // Skip first 3 polls (3s — let Claude start up)
    this.skipCount = 3;
  }

  _poll() {
    if (this.disposed) return;

    if (this.session._manualOverrideUntil && Date.now() < this.session._manualOverrideUntil) {
      return;
    }

    let cmd, panePath, altScreen = false;
    try {
      const out = tmux(
        ["display-message", "-t", this.paneTarget, "-p", "#{pane_current_command}\t#{pane_current_path}\t#{alternate_on}"],
        { timeout: 2000 }
      ).trim();
      const parts = out.split("\t");
      cmd = parts[0];
      panePath = parts[1] || null;
      altScreen = parts[2] === "1";
    } catch {
      return;
    }

    // Runtime-checkpoint piggyback (resume.js): the tracker just needs the
    // pane's foreground command each poll. Never let it break detection.
    if (this.onCmd) try { this.onCmd(cmd); } catch {}

    if (panePath && panePath !== this.session.cwd) {
      this.session.cwd = panePath;
    }

    let rawLines;
    try {
      const raw = tmux(["capture-pane", "-t", this.paneTarget, "-p"], { timeout: 2000 });
      rawLines = raw.split("\n");
    } catch {
      return;
    }

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

    this._applySnap(cmd, detectState(rawLines, { altScreen }), contentChanged);
  }

  _applySnap(cmd, snap, contentChanged) {
    // Build a machine view over this detector's counters, run the pure reducer,
    // then write counters back and apply the decision through _setState (the
    // single mutation point, which keeps its own min-duration / override guards).
    const m = {
      current: this.session.state || "idle",
      blockReason: this.session.blockReason,
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
    // Reset transition timer so next poll can transition immediately
    this.stateEnteredAt = 0;
  }

  dispose() {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
