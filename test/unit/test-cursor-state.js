/**
 * Cursor backend (cursor-agent) — the screen reader, process identity, the
 * paste guard and the reducer's handling of a cursor snap.
 *
 * Fixtures in fixtures/cursor/ are real `tmux capture-pane -p` captures of
 * cursor-agent 2026.11.x (OCI, 2026-11-15 and 2026-11-23): trust box, fresh and
 * follow-up composers, a typed draft, a turn running, the approval box (with a
 * right-aligned hint under it), a mid-turn follow-up, the prompt put back after
 * Ctrl+C, and a bad --model (cursor-agent printed its model list and exited:
 * nothing it would draw as its own screen → "unknown").
 *
 * Run: node test/unit/test-cursor-state.js
 */
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "fs";
import { join, dirname, relative } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { detectCursorState, cursorUnderPid, cursorPasteHold, resolveCursorAgent, cursorCmdCandidate, CURSOR_CMD_RE } from "../../server/cursor-state.js";
import { nextState, StateDetector, CURSOR_UNKNOWN_POLLS } from "../../server/state-detector.js";
import { firedWarnings, resetWarnOnce } from "../../server/log.js";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, "fixtures", "cursor", `${name}.txt`), "utf8").split("\n");
const read = (name) => detectCursorState(fx(name));

console.log("\n── screens ──");
{
  const s = read("01-trust");
  ok(s.state === "blocked" && s.cursorDialog?.kind === "trust" && s.blockReason === "Needs input", "trust box → blocked (trust)");
}
{
  const s = read("02-idle");
  ok(s.state === null && s.promptVisible, "fresh composer → at the prompt");
  ok(s.composer?.empty === true && s.composer.text === "Plan, search, build anything", "fresh placeholder reads as an empty box");
}
{
  const s = read("04-typed");
  ok(s.state === null && s.composer?.empty === false && /^Fix the bug in calc\.py/.test(s.composer.text), "typed draft → at the prompt, box NOT empty, text read");
}
{
  const s = read("05-run-1");
  ok(s.state === "working" && !s.stale, "\"ctrl+c to stop\" on the composer row → working (strong)");
  ok(s.composer?.empty === true, "the box under a running turn is empty (follow-up placeholder)");
}
{
  const s = read("05-run-2");
  ok(s.state === "working" && s.footer?.model === "Auto" && s.footer.contextPct === 5, "working with the footer → model Auto, context 5%");
}
{
  const s = read("05-run-10");
  ok(s.state === null && s.composer?.empty && s.footer?.contextPct === 5, "turn over → at the prompt, empty box, footer read");
}
{
  const s = read("07-perm-1");
  ok(s.state === "working" && s.stale === true, "a spinner above the composer without the stop hint → working, stale (content decides)");
}
{
  const s = read("10-pasted");
  ok(s.state === null && s.composer?.empty === false && /pong/.test(s.composer.text), "pasted, not yet sent → box holds text");
}
{
  const s = read("12-perm-1");
  ok(s.state === "blocked" && s.cursorDialog?.kind === "approval", "approval box with a right-aligned hint under it → blocked (approval)");
  const opts = s.cursorDialog?.options || [];
  ok(opts.length >= 2 && opts.filter((o) => o.selected).length === 1, "approval options read, exactly one selected");
  ok(opts.some((o) => o.key === "y") && opts.some((o) => /esc/.test(o.key)), "option keys read (y … esc or n)");
}
{
  const s = read("v0-04-working");
  ok(s.state === "blocked" && s.cursorDialog?.kind === "approval" && /\?$/.test(s.cursorDialog.question || ""), "v0 approval → blocked with its question");
}
{
  const s = read("v0-05-midturn-enter");
  ok(s.state === "working" && s.composer?.empty === true, "mid-turn follow-up queued → still working, box empty");
}
{
  const s = read("v0-17-ctrlc-working");
  ok(s.state === null && s.composer?.empty === false, "Ctrl+C put the prompt back in the box → at the prompt with text (not empty)");
}
{
  const s = read("v0-20-badmodel");
  ok(s.state === "unknown", "bad --model (model list printed) → unknown");
}
ok(detectCursorState([]).state === "unknown" && detectCursorState(["", "  "]).state === "unknown", "blank pane → unknown");
ok(detectCursorState(fx("05-run-1"), { altScreen: true }).altScreen === true, "alt screen → editor (working), never read as a composer");
{
  // A ghost: an old composer row with the stop hint far above, a shell prompt at the bottom.
  const lines = [...fx("05-run-1"), ...Array(20).fill("some output line"), "$ "];
  ok(detectCursorState(lines).state === "unknown", "a composer row above the bottom window is a ghost → unknown");
}

console.log("\n── paste guard ──");
ok(cursorPasteHold(read("02-idle")) === null, "empty composer at the prompt → paste");
ok(cursorPasteHold(read("05-run-1")) === null, "working with an empty box → paste (cursor-agent queues it as a follow-up)");
ok(/approval/.test(cursorPasteHold(read("12-perm-1")) || ""), "approval box → hold (Enter would answer it)");
ok(/trust/.test(cursorPasteHold(read("01-trust")) || ""), "trust box → hold");
ok(/holds text/.test(cursorPasteHold(read("04-typed")) || ""), "draft in the box → hold (the paste would join it)");
ok(/cannot read/.test(cursorPasteHold(read("v0-20-badmodel")) || ""), "unknown screen → hold");
ok(cursorPasteHold(null) !== null, "no snap → hold");
ok(cursorPasteHold(detectCursorState(fx("02-idle"), { altScreen: true })) !== null, "alt screen → hold");

console.log("\n── process identity ──");
ok(CURSOR_CMD_RE.test("cursor-agent") && CURSOR_CMD_RE.test("agent") && !CURSOR_CMD_RE.test("node"), "Linux pane command cursor-agent / agent is the process");
ok(cursorCmdCandidate("node") && cursorCmdCandidate("cursor-agent") && !cursorCmdCandidate("zsh") && !cursorCmdCandidate("claude"), "node is a candidate (macOS), shells and claude are not");
const MAC_ARGS = "/Users/x/.local/bin/cursor-agent --use-system-ca /Users/x/.local/share/cursor-agent/versions/2026.11.22-e9042b2/index.js";
{
  const ps = ` 100     1 -zsh\n 101   100 ${MAC_ARGS}\n 102   101 /bin/zsh -c ls\n`;
  ok(cursorUnderPid(ps, 100), "macOS: cursor-agent's index.js one level under the pane's shell → found");
  ok(cursorUnderPid(` 100     1 ${MAC_ARGS}\n`, 100), "macOS: the pane pid itself is cursor-agent (exec'd) → found");
  ok(!cursorUnderPid(` 100     1 -zsh\n 101   100 node /usr/lib/node_modules/npm/bin/npm-cli.js run dev\n`, 100), "an unrelated node under the pane → not cursor-agent");
  ok(!cursorUnderPid(` 100     1 -zsh\n 101   100 ${MAC_ARGS}\n`, 999), "another pane's cursor-agent → not this pane's");
  const deep = ` 100 1 a\n 101 100 b\n 102 101 c\n 103 102 d\n 104 103 ${MAC_ARGS}\n`;
  ok(!cursorUnderPid(deep, 100) && cursorUnderPid(deep, 100, 4), "deeper than 3 levels → not found (bounded walk)");
  ok(cursorUnderPid(` 100 1 -bash\n 101 100 /home/u/.local/bin/cursor-agent --trust\n`, 100), "Linux launcher path by name → found");
  ok(!cursorUnderPid("", 100) && !cursorUnderPid(null, 100), "no ps table → not found");
  ok(!cursorUnderPid(` 100 1 -zsh\n 101 100 tail -f /tmp/cursor-agent\n`, 100), "a file named cursor-agent in another program's args → not found");
  ok(!cursorUnderPid(` 100 1 -zsh\n 101 100 grep -r x /h/.local/share/cursor-agent/versions/2026.11.22-e9042b2/index.js\n`, 100), "a tool reading cursor's index.js → not found");
  ok(cursorUnderPid(` 100 1 -zsh\n 101 100 /h/.local/share/cursor-agent/versions/2026.11.22-e9042b2/node --use-system-ca /h/.local/share/cursor-agent/versions/2026.11.22-e9042b2/index.js\n`, 100), "node (with flags) running the versioned index.js → found");
}

console.log("\n── resolveCursorAgent ──");
{
  const d = mkdtempSync(join(tmpdir(), "hadron-cursor-"));
  try {
    const bin = join(d, "bin"), home = join(d, "home"), local = join(home, ".local", "bin");
    mkdirSync(bin); mkdirSync(local, { recursive: true });
    ok(resolveCursorAgent({ PATH: bin, HOME: home }) === null, "nowhere → null");
    writeFileSync(join(local, "cursor-agent"), "#!/bin/sh\n"); chmodSync(join(local, "cursor-agent"), 0o755);
    ok(resolveCursorAgent({ PATH: bin, HOME: home }) === join(local, "cursor-agent"), "not on PATH (launchd) → ~/.local/bin/cursor-agent");
    writeFileSync(join(bin, "cursor-agent"), "#!/bin/sh\n"); chmodSync(join(bin, "cursor-agent"), 0o644);
    ok(resolveCursorAgent({ PATH: bin, HOME: home }) === join(local, "cursor-agent"), "a non-executable file on PATH is skipped");
    chmodSync(join(bin, "cursor-agent"), 0o755);
    ok(resolveCursorAgent({ PATH: bin, HOME: home }) === join(bin, "cursor-agent"), "on PATH → that one first");
    ok(resolveCursorAgent({ PATH: relative(process.cwd(), bin), HOME: join(d, "nohome") }) === null, "a relative PATH entry is never used");
    ok(resolveCursorAgent({ PATH: bin, HOME: home, HADRON_CURSOR_AGENT: join(d, "nope") }) === null, "an override that does not exist → null (never falls back)");
    ok(resolveCursorAgent({ PATH: "", HOME: home, HADRON_CURSOR_AGENT: join(bin, "cursor-agent") }) === join(bin, "cursor-agent"), "the override wins");
    ok(resolveCursorAgent({ PATH: "", HOME: home, HADRON_CURSOR_AGENT: relative(process.cwd(), join(bin, "cursor-agent")) }) === null, "a relative override → null");
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log("\n── reducer with a cursor snap ──");
function machine(current = "idle", extra = {}) {
  return { current, blockReason: undefined, notWorking: 0, inconclusive: 0, blockedHits: 0, shellHits: 0, ...extra };
}
{
  const m = machine("idle");
  const d = nextState(m, { cmd: "node", snap: read("05-run-1"), contentChanged: true, canTransition: true, agent: true });
  ok(d && d.state === "working", "idle + cursor working (agent: true) → working");
}
{
  // On Linux the pane command is cursor-agent, which AGENT_PROCESS_RE does not
  // know: without `agent` the reducer would not take the snap as the agent's.
  const m1 = machine("idle"), m2 = machine("idle");
  const withAgent = nextState(m1, { cmd: "cursor-agent", snap: read("05-run-1"), contentChanged: true, canTransition: true, agent: true });
  const without = nextState(m2, { cmd: "cursor-agent", snap: read("05-run-1"), contentChanged: true, canTransition: true });
  ok(withAgent?.state === "working" && without?.state !== "working", "`agent` decides, not the pane command");
}
{
  const m = machine("working");
  let d = null;
  for (let i = 0; i < 4 && !(d && d.state); i++) d = nextState(m, { cmd: "cursor-agent", snap: read("12-perm-1"), contentChanged: false, canTransition: true, agent: true });
  ok(d && d.state === "blocked" && d.blockReason === "Needs input", "working + approval box → blocked (Needs input)");
}
{
  const m = machine("working", { notWorking: 5, inconclusive: 1, blockedHits: 1 });
  let d;
  for (let i = 0; i < 30; i++) d = nextState(m, { cmd: "cursor-agent", snap: { state: "unknown" }, contentChanged: false, canTransition: true, agent: true });
  ok(d === null && m.notWorking === 0 && m.inconclusive === 0 && m.blockedHits === 0, "unknown screen → the state is held (no decision, counters reset), however long");
}
{
  const m = machine("working");
  let d = null;
  for (let i = 0; i < 12 && !(d && d.state); i++) d = nextState(m, { cmd: "cursor-agent", snap: read("05-run-10"), contentChanged: false, canTransition: true, agent: true });
  ok(d && (d.state === "done" || d.state === "idle"), "working + idle composer, settled → done/idle");
}

console.log("\n── detector: unknown screen is said once ──");
{
  resetWarnOnce();
  const session = { id: "cur1", backend: "cursor", state: "idle" };
  const det = new StateDetector("cur1", session, { poll: false });
  const unknown = { state: "unknown" };
  for (let i = 0; i < CURSOR_UNKNOWN_POLLS - 1; i++) det._cursorScreen(true, unknown);
  ok(typeof session.cursorUnknownSince === "string" && !firedWarnings.has("cursor-screen:cur1"), "unknown < threshold → since stamped, no warning yet");
  det._cursorScreen(true, unknown);
  ok(firedWarnings.has("cursor-screen:cur1"), `unknown for ${CURSOR_UNKNOWN_POLLS} polls → warnOnce cursor-screen:<id>`);
  det._cursorScreen(true, read("02-idle"));
  ok(session.cursorUnknownSince === null, "a known screen clears it");
  det._cursorScreen(false, unknown);
  ok(session.cursorUnknownSince === null, "cursor-agent not running → no unknown-screen claim");
  det.dispose?.();
}
{
  const session = { id: "cur2", backend: "cursor", state: "idle" };
  const det = new StateDetector("cur2", session, { poll: false });
  ok(await det._cursorProcess("cursor-agent") === true && session.cursorProc === true, "pane command cursor-agent → process up");
  ok(await det._cursorProcess("zsh") === false && session.cursorProc === null, "back at the shell → not running (null: nothing to complain about)");
  det._cursorProc = { cmd: "node", up: true };
  await det._cursorProcess("bash");
  ok(det._cursorProc === null, "a shell in between forgets the cached node answer");
  det.dispose?.();
}
{
  // The process-tree path, lookup injected: true / false / null (could not ask).
  const session = { id: "cur3", backend: "cursor", state: "blocked" };
  const det = new StateDetector("cur3", session, { poll: false });
  let answer = true, asked = 0;
  det.cursorLookup = async () => { asked++; if (answer instanceof Error) throw answer; return answer; };
  ok(await det._cursorProcess("node") === true && session.cursorProc === true, "macOS: pane command node with cursor-agent under it → up");
  ok(await det._cursorProcess("node") === true && asked === 1, "…cached until the pane command moves (asked once)");
  answer = null;
  ok(await det._cursorProcess("git") === true && session.cursorProc === true, "a lookup that could not ask (null) keeps the last answer — a slow ps never resolves a block");
  answer = new Error("ps timed out");
  ok(await det._cursorProcess("git") === true, "…a lookup that throws keeps it too");
  answer = false;
  ok(await det._cursorProcess("vim") === false && session.cursorProc === null, "an unrelated program with no cursor-agent under it → not up, no doctor complaint (null)");
  ok(!firedWarnings.has("cursor-proc:cur3"), "…and no warning");
  await det._cursorProcess("zsh");
  ok(await det._cursorProcess("node") === false && session.cursorProc === false, "node with NO cursor-agent under it → false (the doctor's yellow row)");
  ok(firedWarnings.has("cursor-proc:cur3"), "…warnOnce cursor-proc:<id>");
  answer = true;
  await det._cursorProcess("zsh");
  ok(await det._cursorProcess("tsx") === true && session.cursorProc === true, "any non-shell foreground with cursor-agent under it (a renamed process, a tool it runs) → up");
  det.dispose?.();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
