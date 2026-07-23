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

  // ── Idle (prompt visible, NO working indicators in above window) ──
  "idle-at-prompt":                        { state: null },
  "idle-prompt-with-user-text":            { state: null },
  "idle-survey-above-prompt":              { state: null },
  "idle-recap-above-prompt":               { state: null },
  "idle-cooked-summary":                   { state: null },
  "idle-100pct-context":                   { state: null },

  // ── Blocked: needs input ──
  "blocked-needs-input":               { state: "blocked", blockReason: "Needs input" },
  "blocked-plan-approval":             { state: "blocked", blockReason: "Needs input" },
  "blocked-permission-allow-deny":     { state: "blocked", blockReason: "Needs input" },
  "blocked-selection-4options":        { state: "blocked", blockReason: "Needs input" },
  "blocked-do-you-want-to-proceed":    { state: "blocked", blockReason: "Needs input" },
  "blocked-prompt-editor":             { state: "blocked", blockReason: "Needs input" },

  // ── Blocked: API error ──
  "blocked-rate-limit":                { state: "blocked", blockReason: "API error" },
  "blocked-overloaded":                { state: "blocked", blockReason: "API error" },
  "blocked-api-500":                   { state: "blocked", blockReason: "API error" },
  "blocked-no-healthy-deployments":    { state: "blocked", blockReason: "API error" },
  "blocked-model-issue":               { state: "blocked", blockReason: "API error" },

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
