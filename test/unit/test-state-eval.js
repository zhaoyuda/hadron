/**
 * Unit tests for detectState() using captured pane fixtures.
 *
 * Each .txt file in test-fixtures/state-detector/ is a captured tmux pane.
 * Expected results are declared here keyed by filename (without .txt).
 *
 * detectState() is a pure snapshot function — it reports what it sees.
 * When a thinking indicator is visible alongside a prompt, it returns
 * state:"working" with promptVisible:true. The temporal staleness logic
 * (content-change detection, debounce) lives in StateDetector._applySnap().
 *
 * Usage: node server/test-state-eval.js
 *
 * To add a new test case:
 *   1. Capture a tmux pane: tmux capture-pane -t <session> -p > server/test-fixtures/state-detector/<name>.txt
 *   2. Add an entry to EXPECTED below with the expected state and optional checks
 */

import { detectState } from "../../server/state-detector.js";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "state-detector");

const EXPECTED = {
  // ── Thinking / streaming (no prompt visible) ──
  "thinking-high-effort":          { state: "working", substatus: { type: "thinking" } },
  "thinking-basic":                { state: "working", substatus: { type: "thinking" } },
  "thinking-with-tokens":          { state: "working", substatus: { type: "thinking", tokens: "1.2k" } },
  "thinking-thought-for":          { state: "working", substatus: { type: "thinking", tokens: "832" } },
  "working-thinking-no-prompt":    { state: "working", substatus: { type: "thinking", tokens: "856" } },
  "working-thinking-bare-no-prompt": { state: "working", substatus: { type: "thinking" } },
  "working-thinking-high-tokens":  { state: "working", substatus: { type: "thinking", tokens: "12.3k" } },
  "working-thinking-multiword-task": { state: "working", substatus: { type: "thinking" } },
  "working-thinking-multiword-bare": { state: "working", substatus: { type: "thinking" } },
  // Spinner separated from the composer by survey/queued/todo-HUD lines (the
  // 8-line window regression — idle-while-Booping, 2026-07-23):
  "working-thinking-pushed-out":   { state: "working", promptVisible: true, substatus: { type: "thinking", tokens: "2.5k" } },

  // ── Thinking with prompt visible (active or stale — _applySnap decides) ──
  "working-thinking-with-survey":            { state: "working", promptVisible: false, substatus: { type: "thinking" } },
  "idle-stale-thinking-above-prompt":        { state: "working", promptVisible: true, substatus: { type: "thinking" } },
  "idle-stale-thinking-with-survey":         { state: "working", promptVisible: true, substatus: { type: "thinking" } },
  "idle-stale-propagating-above-prompt":     { state: "working", promptVisible: true, substatus: { type: "streaming" } },

  // ── Tool execution ──
  "tool-waiting":                  { state: "working", substatus: { type: "tool", tool: "Read" } },
  "tool-bash-waiting":             { state: "working", substatus: { type: "tool", tool: "Bash" } },
  "working-tool-read":             { state: "working", substatus: { type: "tool", tool: "Read" } },
  "working-tool-edit":             { state: "working", substatus: { type: "tool", tool: "Edit" } },
  "working-tool-agent":            { state: "working", substatus: { type: "tool", tool: "Agent" } },

  // ── Propagating / Compacting (no prompt) ──
  "working-propagating":           { state: "working", substatus: { type: "streaming" } },
  "working-propagating-no-prompt": { state: "working", substatus: { type: "streaming" } },
  "working-compacting":            { state: "working", substatus: { type: "compacting" } },
  "working-compacting-no-prompt":  { state: "working", substatus: { type: "compacting" } },
  "working-compacting-progress-bar": { state: "working", substatus: { type: "compacting" } },

  // ── Background agents / shells ──
  "working-background-agents":             { state: "working", substatus: { type: "agents" } },
  "working-background-agents-with-prompt": { state: "working", substatus: { type: "agents" } },
  "working-shells":                        { state: "working", substatus: { type: "shell" } },
  "working-shells-chrome":                 { state: "working", substatus: { type: "shell" } },
  "working-dynamic-workflow":              { state: "working", substatus: { type: "agents" } },
  "working-local-agents":                  { state: "working", substatus: { type: "agents" } },
  "working-task-progress":                 { state: "working", substatus: { type: "agents" } },

  // ── Long-running tool (Running…) ──
  "working-bash-running-with-prompt": { state: "working", promptVisible: true, substatus: { type: "tool", tool: "Bash" } },
  "working-bash-running-no-prompt":  { state: "working", substatus: { type: "tool", tool: "Bash" } },

  // ── Broad fallback ──
  "working-broad-fallback":        { state: "working", substatus: { type: "thinking" } },

  // ── API retry in progress (auth conflict → retry loop; thinking timer frozen) ──
  // Must win over the stale "Wandering…" spinner above the prompt so a retrying
  // agent reads as working, not idle.
  "working-retrying-api":          { state: "working", promptVisible: true, substatus: { type: "retrying" } },
  // the generic head "API error · Retrying in 3s · attempt 1/10" (what the first attempts
  // render unless rate-limit / network-down / SSL metadata is present): no hard status
  // named → still working (retrying), not blocked
  "working-retry-banner-generic":  { state: "working", promptVisible: true, substatus: { type: "retrying" } },
  // final-attempt variant without an attempt count: "· retrying once, waiting up to 1m"
  "working-retry-no-response":     { state: "working", promptVisible: true, substatus: { type: "retrying" } },
  // stalled connection: "Waiting for API response · will retry in 1m · check your network"
  "working-retry-stalled":             { state: "working", promptVisible: true, substatus: { type: "retrying" } },
  // opted-in lower-priority wait: "… · next try in 5m · attempt 2 · esc to interrupt"
  "working-retry-low-priority":        { state: "working", promptVisible: true, substatus: { type: "retrying" } },

  // ── Idle (prompt visible, NO working indicators in above window) ──
  "idle-at-prompt":                        { state: null },
  "idle-prompt-with-user-text":            { state: null },
  "idle-survey-above-prompt":              { state: null },
  "idle-recap-above-prompt":               { state: null },
  "idle-cooked-summary":                   { state: null },
  "idle-100pct-context":                   { state: null },
  // bare "429" in conversation text (PR/issue ids) is not an API error (canary, 2026-09-12)
  "idle-429-in-conversation":              { state: null },
  // the same error strings QUOTED mid-sentence in the agent's answer, or inside a tool's
  // output (⎿ block) are not Claude's own API error — line-anchored rule (2026-09-12)
  "idle-api-error-quoted-in-prose":        { state: null },
  "idle-api-error-in-tool-output":         { state: null },
  // a retry banner QUOTED in prose (no leading ✻/⎿ glyph) is neither retrying nor blocked
  "idle-retry-banner-quoted-in-prose":     { state: null },
  // the same banner text echoed by a tool (⎿ / 5-space continuation) is not the banner
  "idle-retry-banner-in-tool-output":      { state: null },
  // the error heads as ordinary words at line start ("API Error handling is now covered")
  // — every head carries its rendered delimiter ("API Error: ", "Not logged in ·",
  // "high demand for ", "usage limits" ≠ "usage limit ·"), so a summary sentence does not count
  "idle-error-words-in-summary":           { state: null },
  // a /goal pause for a non-API reason (hook ended the turn) is not an API error
  "idle-goal-paused-hook":                 { state: null },

  // ── Blocked: needs input ──
  "blocked-needs-input":               { state: "blocked", blockReason: "Needs input" },
  "blocked-plan-approval":             { state: "blocked", blockReason: "Needs input" },
  "blocked-permission-allow-deny":     { state: "blocked", blockReason: "Needs input" },
  "blocked-selection-4options":        { state: "blocked", blockReason: "Needs input" },
  "blocked-do-you-want-to-proceed":    { state: "blocked", blockReason: "Needs input" },
  "blocked-prompt-editor":             { state: "blocked", blockReason: "Needs input" },

  // ── Blocked: API error ──
  "blocked-rate-limit":                { state: "blocked", blockReason: "API error" },
  // assistant-rendered "● API Error: 429 {…rate_limit_error…}" — how Claude Code actually
  // shows a failed call (its own isApiErrorMessage test is text.startsWith("API Error"))
  "blocked-api-429-message":           { state: "blocked", blockReason: "API error" },
  // macOS renders the message bullet as ⏺ (U+23FA) instead of ● — same anchor
  "blocked-api-error-mac-bullet":      { state: "blocked", blockReason: "API error" },
  // client-composed billing / auth failures (v2.1.269 renders these as the message text)
  "blocked-credit-balance":            { state: "blocked", blockReason: "API error" },
  "blocked-invalid-api-key":           { state: "blocked", blockReason: "API error" },
  "blocked-not-logged-in":             { state: "blocked", blockReason: "API error" },
  "blocked-gateway-auth":              { state: "blocked", blockReason: "API error" },
  "blocked-request-timed-out":         { state: "blocked", blockReason: "API error" },
  // (2026-09-15 review of d88d9f5) forms the client emits that d88d9f5 missed
  "blocked-request-timed-out-env":     { state: "blocked", blockReason: "API error" },
  "blocked-shared-budget":             { state: "blocked", blockReason: "API error" },
  "blocked-out-of-credits":            { state: "blocked", blockReason: "API error" },
  "blocked-org-out-of-credits":        { state: "blocked", blockReason: "API error" },
  "blocked-org-credit-cap":            { state: "blocked", blockReason: "API error" },
  "blocked-model-unavailable-wrapped-50": { state: "blocked", blockReason: "API error" },
  "blocked-goal-paused-wrapped-45":    { state: "blocked", blockReason: "API error" },
  // prose that starts with "API Error" but is not the renderer's "API Error: " form
  "idle-api-error-prose-no-colon":     { state: null },
  "idle-api-error-paren-in-prose":     { state: null },
  "idle-model-unavailable-in-prose":   { state: null },
  "blocked-high-demand":               { state: "blocked", blockReason: "API error" },
  // retry banner whose head names a hard status ("529 Overloaded · Retrying in 8s …"):
  // the user should see the block, not a green "retrying"
  "blocked-retry-banner-529":          { state: "blocked", blockReason: "API error" },
  // longer delays are formatted "1m 30s" / "5m", not seconds
  "blocked-retry-banner-minutes":      { state: "blocked", blockReason: "API error" },
  // the server's message text can itself contain "·"
  "blocked-retry-banner-dot-in-message": { state: "blocked", blockReason: "API error" },
  // narrow pane: the head is truncated to ≥10 chars with "…" before the retry suffix
  "blocked-retry-banner-truncated-head": { state: "blocked", blockReason: "API error" },
  // a mid-stream (SSE) failure has no HTTP status, so the formatted head is the bare
  // message ("Overloaded") — any non-generic head counts, not just "<status> …"
  "blocked-retry-banner-overloaded-stream": { state: "blocked", blockReason: "API error" },
  // delays of five minutes and up show the most significant unit only ("1h", "1d")
  "blocked-retry-banner-hours":        { state: "blocked", blockReason: "API error" },
  "blocked-overloaded":                { state: "blocked", blockReason: "API error" },
  "blocked-api-500":                   { state: "blocked", blockReason: "API error" },
  "blocked-no-healthy-deployments":    { state: "blocked", blockReason: "API error" },
  "blocked-model-issue":               { state: "blocked", blockReason: "API error" },
  // narrow pane (50 cols): the renderer wraps the message at a space, so the head's
  // delimiter " (" lands on the next line — end-of-line stands in for it
  "blocked-model-issue-wrapped":       { state: "blocked", blockReason: "API error" },
  // 45 cols: the head itself wraps ("… the selected" / "  model (…)"); the bullet line is
  // re-joined with its 2-space continuation lines before the head is tested
  "blocked-model-issue-wrapped-45":    { state: "blocked", blockReason: "API error" },
  // /goal notice, prefixed by a goal-spinner frame (∴ ∷ ∵): the API-caused pauses count
  "blocked-goal-paused-rate-limited":  { state: "blocked", blockReason: "API error" },

  // ── Inconclusive (no prompt, no recognized indicators) ──
  "inconclusive-mid-output":           { state: "inconclusive" },
  "inconclusive-empty-pane":           { state: "inconclusive" },

  // ── Alt-screen / full-screen TUI (pass altScreen:true) ──
  // A file buffer whose text would otherwise trip blocked heuristics ("Do you
  // want to proceed", numbered "Allow" options) must NOT be read as blocked.
  "altscreen-vim-edit":     { input: { altScreen: true }, state: "working", substatus: { type: "editor" } },
  // Claude's own prompt editor (vi on claude-prompt-*.md) → waiting for the user.
  "altscreen-prompt-editor": { input: { altScreen: true }, state: "blocked", blockReason: "Needs input" },
};

let passed = 0;
let failed = 0;
let skipped = 0;

const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".txt")).sort();

for (const file of files) {
  const name = file.replace(/\.txt$/, "");
  const expected = EXPECTED[name];

  if (!expected) {
    console.log(`  ? SKIP: ${name} (no expected result defined)`);
    skipped++;
    continue;
  }

  const content = readFileSync(join(FIXTURES_DIR, file), "utf-8");
  const lines = content.split("\n");
  const result = detectState(lines, expected.input || {});

  let ok = true;
  const errors = [];

  // Check state
  if (result.state !== expected.state) {
    ok = false;
    errors.push(`state: expected "${expected.state}", got "${result.state}"`);
  }

  // Check promptVisible if specified
  if (expected.promptVisible !== undefined && !!result.promptVisible !== expected.promptVisible) {
    ok = false;
    errors.push(`promptVisible: expected ${expected.promptVisible}, got ${!!result.promptVisible}`);
  }

  // Check blockReason if specified
  if (expected.blockReason && result.blockReason !== expected.blockReason) {
    ok = false;
    errors.push(`blockReason: expected "${expected.blockReason}", got "${result.blockReason}"`);
  }

  // Check substatus fields if specified
  if (expected.substatus) {
    if (!result.substatus) {
      ok = false;
      errors.push(`substatus: expected ${JSON.stringify(expected.substatus)}, got null`);
    } else {
      for (const [key, val] of Object.entries(expected.substatus)) {
        if (result.substatus[key] !== val) {
          ok = false;
          errors.push(`substatus.${key}: expected "${val}", got "${result.substatus[key]}"`);
        }
      }
    }
  }

  if (ok) {
    const pv = result.promptVisible ? " (promptVisible)" : "";
    const detail = result.substatus ? ` [${result.substatus.type}${result.substatus.tool ? `: ${result.substatus.tool}` : ""}]` : "";
    console.log(`  ✓ ${name} → ${result.state || "idle"}${detail}${pv}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${name}`);
    for (const e of errors) console.log(`      ${e}`);
    failed++;
  }
}

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
