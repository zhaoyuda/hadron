/**
 * Unit tests for the pure state-transition reducer nextState().
 *
 * detectState() reports a single snapshot; nextState() is the temporal layer
 * (hysteresis / debounce) that turns a stream of snapshots into stable states.
 * It mutates only the passed-in machine `m`, so we can drive it deterministically
 * here with no tmux. These cover the bugs fixed in v0.6: vim/TUI handling,
 * transient working→done flips, blocked latching, and sluggish idle→working.
 *
 * Run: node test/unit/test-state-machine.js
 */
import { nextState } from "../../server/state-detector.js";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function machine(current = "idle", extra = {}) {
  return { current, blockReason: undefined, notWorking: 0, inconclusive: 0, blockedHits: 0, shellHits: 0, ...extra };
}
// snaps
const sToolStrong = { state: "working", stale: false, promptVisible: true, substatus: { type: "tool", tool: "Bash" } };
const sThinkStale = { state: "working", stale: true, promptVisible: true, substatus: { type: "thinking" } };
const sBlockedInput = { state: "blocked", blockReason: "Needs input" };
const sBlockedApi = { state: "blocked", blockReason: "API error" };
const sInconclusive = { state: "inconclusive" };
const sPrompt = { state: null };
const sEditorAlt = { state: "working", stale: false, altScreen: true, substatus: { type: "editor" } };
// Claude's integrated editor opens vim *inside the agent's own pty*, so tmux still
// reports the agent process (node) as pane_current_command while the pane is in the
// alternate screen. detectState then returns working (generic buffer) or blocked
// (claude-prompt-*.md). These are the snaps the agent-pane-in-vim bug feeds in.
const sPromptEditorAlt = { state: "blocked", blockReason: "Needs input", altScreen: true, substatus: null };

const T = (m, input) => nextState(m, { contentChanged: false, canTransition: true, ...input });

console.log("\n[transient done guard — shell must persist 2 reads]");
{
  const m = machine("working");
  ok(T(m, { cmd: "bash", snap: sPrompt }) === null && m.shellHits === 1, "first shell read does not flip to done");
  const d = T(m, { cmd: "bash", snap: sPrompt });
  ok(d && d.state === "done", "second consecutive shell read → done");
}
{
  // a single shell read sandwiched between agent reads should not stick
  const m = machine("working");
  T(m, { cmd: "bash", snap: sPrompt });
  ok(m.shellHits === 1, "shellHits incremented on transient shell");
  T(m, { cmd: "node", snap: sToolStrong });
  ok(m.shellHits === 0, "agent read resets shell streak (no spurious done)");
}

console.log("\n[shell in alt-screen is a user TUI, not exit]");
{
  const m = machine("working");
  ok(T(m, { cmd: "bash", snap: sEditorAlt }) === null, "shell+altScreen keeps state (no done)");
}

console.log("\n[blocked hysteresis — needs 2 consecutive blocked snaps]");
{
  const m = machine("idle");
  ok(T(m, { cmd: "node", snap: sBlockedInput }) === null && m.blockedHits === 1, "first blocked snap does not latch");
  const d = T(m, { cmd: "node", snap: sBlockedInput });
  ok(d && d.state === "blocked" && d.blockReason === "Needs input", "second blocked snap → blocked");
}
{
  // a lone blocked frame followed by a working frame must not latch blocked
  const m = machine("idle");
  T(m, { cmd: "node", snap: sBlockedInput });
  const d = T(m, { cmd: "node", snap: sToolStrong });
  ok(m.blockedHits === 0 && d && d.state === "working", "blocked streak cleared by a working frame");
}

console.log("\n[stale thinking vs strong indicator at idle]");
{
  const m = machine("idle");
  ok(T(m, { cmd: "node", snap: sThinkStale, contentChanged: false }) === null, "stale thinking + stable content → stays idle");
}
{
  const m = machine("idle");
  const d = T(m, { cmd: "node", snap: sThinkStale, contentChanged: true });
  ok(d && d.state === "working", "stale thinking + changing content → working");
}
{
  const m = machine("idle");
  const d = T(m, { cmd: "node", snap: sToolStrong, contentChanged: false });
  ok(d && d.state === "working", "strong tool indicator → working immediately (no content-change needed)");
}

console.log("\n[idle → working via inconclusive debounce]");
{
  const m = machine("idle");
  ok(T(m, { cmd: "node", snap: sInconclusive }) === null && m.inconclusive === 1, "first inconclusive does not flip");
  const d = T(m, { cmd: "node", snap: sInconclusive });
  ok(d && d.state === "working", "second inconclusive → working");
}

console.log("\n[working → done settle]");
{
  const m = machine("working", { settleThreshold: 3 });
  ok(T(m, { cmd: "node", snap: sPrompt }) === null, "stable prompt poll 1: no done");
  ok(T(m, { cmd: "node", snap: sPrompt }) === null, "stable prompt poll 2: no done");
  const d = T(m, { cmd: "node", snap: sPrompt });
  ok(d && d.state === "done", "stable prompt poll 3 (>=settleThreshold) → done");
}
{
  const m = machine("working", { settleThreshold: 3 });
  T(m, { cmd: "node", snap: sPrompt, contentChanged: true });
  ok(m.notWorking === 0, "content still changing resets the settle counter (stays working)");
}

console.log("\n[non-agent foreground clears stale blocked]");
{
  const m = machine("blocked", { blockReason: "Needs input" });
  const d = T(m, { cmd: "vim", snap: sPrompt });
  ok(d && d.state === "idle", "blocked(Needs input) + user opens editor → idle (resolved)");
}
{
  const m = machine("blocked", { blockReason: "API error" });
  const d = T(m, { cmd: "vim", snap: sPrompt });
  ok(d && d.state === "done", "blocked(API error) + non-agent fg → done (needs review)");
}
{
  const m = machine("working");
  ok(T(m, { cmd: "vim", snap: sPrompt }) === null, "non-agent fg while working keeps state");
}

// REGRESSION GUARD for the recurring "primary terminal in vim shows working/blocked"
// bug. When the AGENT process itself drops into a full-screen editor (Claude's
// integrated prompt editor / an Edit-spawned vim), pane_current_command is still
// "node" and the pane is in alt-screen. The agent isn't producing output and isn't
// awaiting a Claude-level decision — the human is just editing — so the deck must
// NOT read "working" or "blocked". It should stay idle. These currently FAIL: the
// reducer's agent branch blindly applies the alt-screen snap. Fix belongs here in
// nextState (it has the cmd + altScreen context detectState lacks).
console.log("\n[agent pane in editor alt-screen must not read working/blocked]");
{
  const m = machine("idle");
  const d = T(m, { cmd: "node", snap: sEditorAlt });
  ok(!(d && d.state === "working"), "agent in editor alt-screen does not flip idle→working");
}
{
  const m = machine("idle");
  T(m, { cmd: "node", snap: sPromptEditorAlt });
  const d = T(m, { cmd: "node", snap: sPromptEditorAlt });
  ok(!(d && d.state === "blocked"), "agent in vim prompt-editor does not latch blocked");
}

console.log("\n[canTransition gating]");
{
  const m = machine("idle");
  ok(T(m, { cmd: "node", snap: sToolStrong, canTransition: false }) === null, "no transition before min-duration elapses");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
