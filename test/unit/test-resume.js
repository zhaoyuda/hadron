/**
 * Unit tests for the resume decision layer (server/resume.js).
 *
 * decideResume() is the safety gate for v0.9 auto-resume: it must refuse to
 * resurrect a session unless the checkpoint proves the agent was in claude,
 * didn't exit deliberately, is fresh, and the session id is trustworthy.
 * scrapeSessionId()/validateSessionFile() are the "correlated" evidence path —
 * a filename picked by mtime counts only if the transcript's own head confirms
 * the sessionId and cwd. RuntimeTracker transitions are driven synthetically.
 *
 * Run: node test/unit/test-resume.js
 */
import { decideResume, scrapeSessionId, validateSessionFile, claudeProjectDir, RuntimeTracker, performResume, isClaudeCmd, verifyAdoption } from "../../server/resume.js";
import { warnOnce, firedWarnings, resetWarnOnce } from "../../server/log.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = Date.parse("2026-07-11T12:00:00Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const SID = "aaffcbf2-7e28-43ef-8588-478c82d2bad2";
const base = { desiredRuntime: "claude", cleanExitAt: null, sessionId: SID, confidence: "correlated", lastObservedAt: FRESH };
const D = (rt, opts = {}) => decideResume(rt, { now: NOW, generation: "boot-test", ...opts });

console.log("\n[decideResume — the gate]");
ok(D(base).resume === true, "fresh correlated checkpoint → resume");
ok(D({ ...base, confidence: "authoritative" }).resume === true, "authoritative → resume");
ok(D(null).resume === false, "no checkpoint → skip");
ok(D({ ...base, desiredRuntime: "shell" }).resume === false, "agent was at a shell → skip");
ok(D({ ...base, cleanExitAt: FRESH }).resume === false, "clean-exit tombstone → skip (deliberate exit is never healed)");
ok(D({ ...base, sessionId: null }).resume === false, "no session id → skip (never falls back to --continue)");
ok(D({ ...base, sessionId: "$(rm -rf /)" }).resume === false, "malformed session id → skip (shell-inert gate)");
ok(D({ ...base, confidence: "ambiguous" }).resume === false, "ambiguous confidence → skip");
ok(D({ ...base, confidence: "manual" }).resume === true, "manual (hadron adopt) → resume");
ok(D({ ...base, confidence: "manual" }, { policy: "authoritative" }).resume === true, "manual resumes under the authoritative-only policy too");
ok(D({ ...base, confidence: "manual" }, { policy: "off" }).resume === false, "manual still respects policy off");
ok(D({ ...base }, { policy: "authoritative" }).resume === false, "correlated under authoritative-only policy → skip");
ok(D({ ...base }, { policy: "off" }).resume === false, "policy off → skip");
ok(D({ ...base, lastObservedAt: new Date(NOW - 8 * 24 * 3600e3).toISOString() }).resume === false, "checkpoint older than TTL → skip");
ok(D({ ...base, restoreAttempt: { generation: "boot-test", state: "started", attempts: 1 } }).resume === false, "already attempted this boot → skip (idempotent)");
ok(D({ ...base, restoreAttempt: { generation: "boot-old", state: "failed", attempts: 3 } }).resume === false, "3 failed attempts → skip (bounded retries)");
ok(D({ ...base, restoreAttempt: { generation: "boot-old", state: "failed", attempts: 1 } }).resume === true, "prior-boot failed attempt (<3) → retry allowed");

console.log("\n[claudeProjectDir — cwd munging]");
ok(claudeProjectDir("/home/ubuntu/work") === "-home-ubuntu-work", "plain path");
ok(claudeProjectDir("/home/ubuntu/work/frostpunk1") === "-home-ubuntu-work-frostpunk1", "digits survive");
ok(claudeProjectDir("/a/b.c_d") === "-a-b-c-d", "dots and underscores mangle to dashes");

console.log("\n[scrapeSessionId — content-validated, mtime-ordered]");
{
  const root = mkdtempSync(join(tmpdir(), "resume-test-"));
  const cwd = "/fake/agent/cwd";
  const dir = join(root, claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const good = "11111111-2222-4333-8444-555555555555";
  const wrongCwd = "99999999-2222-4333-8444-555555555555";
  writeFileSync(join(dir, `${good}.jsonl`), JSON.stringify({ sessionId: good, cwd }) + "\n");
  writeFileSync(join(dir, `${wrongCwd}.jsonl`), JSON.stringify({ sessionId: wrongCwd, cwd: "/somewhere/else" }) + "\n");
  // wrongCwd is NEWEST — a naive mtime pick would return it
  utimesSync(join(dir, `${good}.jsonl`), new Date(NOW - 10_000), new Date(NOW - 10_000));
  utimesSync(join(dir, `${wrongCwd}.jsonl`), new Date(NOW), new Date(NOW));

  const hit = scrapeSessionId(cwd, { projectsRoot: root });
  ok(hit?.sessionId === good, "newest-but-wrong-cwd transcript is rejected; validated one wins");
  ok(hit?.confidence === "correlated", "scraped id carries correlated confidence, never authoritative");
  ok(validateSessionFile(join(dir, `${good}.jsonl`), good, cwd) === true, "validateSessionFile accepts matching head");
  ok(validateSessionFile(join(dir, `${good}.jsonl`), wrongCwd, cwd) === false, "validateSessionFile rejects id mismatch");
  ok(scrapeSessionId("/never/seen", { projectsRoot: root }) === null, "unknown cwd → null (no guessing)");
  rmSync(root, { recursive: true, force: true });
}

console.log("\n[RuntimeTracker — transitions and tombstone]");
{
  const saves = [];
  const session = { id: "t", cwd: "/nonexistent/cwd" };
  const tr = new RuntimeTracker(session, { save: (s, urgent) => saves.push({ urgent: !!urgent }) });
  tr.observe("claude"); tr.observe("claude");
  ok(!session.runtime?.desiredRuntime, "two claude polls: below settle threshold, nothing recorded");
  tr.observe("claude");
  ok(session.runtime.desiredRuntime === "claude" && session.runtime.observedRuntime === "claude", "third poll settles → desired/observed = claude");
  ok(saves.some((s) => s.urgent), "the shell→claude transition persisted urgently");
  tr.observe("bash");
  ok(session.runtime.cleanExitAt !== null && session.runtime.desiredRuntime === "shell", "claude→shell writes the clean-exit tombstone");
  ok(D({ ...session.runtime, sessionId: SID, confidence: "correlated", lastObservedAt: FRESH }).resume === false, "tracker's tombstoned checkpoint is refused by decideResume");
  tr.observe("claude"); tr.observe("claude"); tr.observe("claude");
  ok(session.runtime.cleanExitAt === null && session.runtime.desiredRuntime === "claude", "re-entering claude clears the tombstone");
}

console.log("\n[RuntimeTracker — macOS reports claude.exe (2026-09 field report: resume 100% dead)]");
{
  // The native binary on macOS shows up in pane_current_command as "claude.exe";
  // before normalization every checkpoint was rejected as "checkpoint stale".
  ok(isClaudeCmd("claude") && isClaudeCmd("claude.exe") && isClaudeCmd("CLAUDE.EXE") && isClaudeCmd(" claude.exe\n"), "isClaudeCmd: claude / claude.exe (any case, trimmed)");
  ok(!isClaudeCmd("node") && !isClaudeCmd("claude-code") && !isClaudeCmd("claude.exe.sh") && !isClaudeCmd("") && !isClaudeCmd(undefined), "isClaudeCmd: node / other claude-ish names / empty are NOT claude");
  const session = { id: "mac", cwd: "/nonexistent/cwd" };
  const tr = new RuntimeTracker(session, { save: () => {} });
  tr.observe("claude.exe"); tr.observe("claude.exe"); tr.observe("claude.exe");
  ok(session.runtime.observedRuntime === "claude" && session.runtime.lastObservedAt, "three claude.exe polls settle → lastObservedAt written");
  ok(D({ ...session.runtime, sessionId: SID, confidence: "authoritative" }).resume === true, "…and decideResume accepts that checkpoint");
  tr.observe("zsh");
  ok(session.runtime.cleanExitAt !== null, "claude.exe → shell tombstones (the path that had never executed on macOS)");
}

console.log("\n[RuntimeTracker — shared-cwd scrape guard]");
{
  // Two agents in one cwd: transcripts validate identically for both sharers,
  // so the tracker must refuse to scrape rather than adopt a sibling's session.
  const root = mkdtempSync(join(tmpdir(), "resume-shared-"));
  const cwd = "/shared/cwd";
  const dir = join(root, claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const sib = "22222222-3333-4444-8555-666666666666";
  writeFileSync(join(dir, `${sib}.jsonl`), JSON.stringify({ sessionId: sib, cwd }) + "\n");
  const session = { id: "a", cwd };
  const tr = new RuntimeTracker(session, { save: () => {}, cwdShared: () => true });
  tr.observe("claude"); tr.observe("claude"); tr.observe("claude");
  ok(!session.runtime.sessionId, "shared cwd → no session id is ever scraped (sibling transcript ignored)");
  const trX = new RuntimeTracker({ id: "b", cwd }, { save: () => {} });
  ok(typeof trX.cwdShared === "function" && trX.cwdShared() === false, "cwdShared defaults to exclusive when not provided");
  rmSync(root, { recursive: true, force: true });
}

console.log("\n[verifyAdoption — hadron adopt never verifies against a fallback cwd]");
{
  const root = mkdtempSync(join(tmpdir(), "resume-adopt-"));
  const cwd = "/agents/own/cwd";
  const sid = "44444444-5555-4666-8777-888888888888";
  const dir = join(root, claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ sessionId: sid, cwd }) + "\n");
  const o = { projectsRoot: root };
  ok(verifyAdoption({ cwd }, sid, o).ok === true, "transcript-backed id for the agent's own cwd → ok");
  ok(verifyAdoption({ cwd }, "$(rm -rf /)", o).status === 400, "malformed id → 400 (shell-inert gate, before any fs access)");
  ok(verifyAdoption({ cwd }, "99999999-5555-4666-8777-888888888888", o).status === 404, "uuid without a transcript for this cwd → 404");
  ok(verifyAdoption({ cwd: "/other/cwd" }, sid, o).status === 404, "transcript exists but for a different cwd → 404 (cwd mismatch)");
  // The sol finding: an agent whose cwd is not yet observed must NOT be verified
  // against the workspace/server cwd — that root transcript is not its own.
  const unset = verifyAdoption({}, sid, o);
  ok(unset.ok === false && unset.status === 400 && /cwd is not known/.test(unset.error), `unset cwd → 400, no fallback dir is consulted (${unset.error})`);
  ok(verifyAdoption({}, sid, { ...o, force: true }).ok === true, "force skips verification (operator's explicit call)");
  ok(verifyAdoption({}, "$(rm -rf /)", { ...o, force: true }).status === 400, "force never bypasses the id format gate");
  rmSync(root, { recursive: true, force: true });
}

console.log("\n[RuntimeTracker — manual (hadron adopt) id is never demoted; unset cwd is never scraped]");
{
  const scraped = "33333333-4444-4555-8666-777777777777";
  let calls = 0;
  const scrape = (cwd) => { calls++; return { sessionId: scraped, confidence: "correlated", cwd }; };
  // Operator-adopted id: a later correlated scrape hit must NOT overwrite it.
  const manual = { id: "m", cwd: "/some/cwd", runtime: { sessionId: "11111111-2222-4333-8444-555555555555", confidence: "manual" } };
  const trM = new RuntimeTracker(manual, { save: () => {}, cwdShared: () => false, scrape });
  trM.observe("claude"); trM.observe("claude"); trM.observe("claude");
  ok(manual.runtime.sessionId === "11111111-2222-4333-8444-555555555555" && manual.runtime.confidence === "manual",
    "manual id survives a correlated scrape hit (never demoted)");
  // Correlated id IS refreshed by a scrape (the existing behaviour, as a control).
  const corr = { id: "c", cwd: "/some/cwd", runtime: { sessionId: "11111111-2222-4333-8444-555555555555", confidence: "correlated" } };
  const trC = new RuntimeTracker(corr, { save: () => {}, cwdShared: () => false, scrape });
  trC.observe("claude"); trC.observe("claude"); trC.observe("claude");
  ok(corr.runtime.sessionId === scraped, "control: a correlated id is still refreshed by a scrape");
  // Unset cwd: no scrape at all, even if cwdShared() says exclusive — the old
  // process.cwd() fallback would have attributed the SERVER's transcripts.
  calls = 0;
  const noCwd = { id: "n" };
  const trN = new RuntimeTracker(noCwd, { save: () => {}, cwdShared: () => false, scrape });
  trN.observe("claude"); trN.observe("claude"); trN.observe("claude");
  ok(calls === 0 && !noCwd.runtime.sessionId, `unset cwd → scrape never called, no id (calls=${calls})`);
}

console.log("\n[performResume — resumes through the agent's launcher argv]");
{
  // deliver mock throws after recording: aborts before the 60s TUI poll loop,
  // which is not under test here.
  const run = async (launchArgv) => {
    const sess = { id: "x", runtime: { ...base, lastObservedAt: new Date(Date.now() - 60_000).toISOString() } };
    const calls = [];
    await performResume(sess, "tmux-x", {
      deliver: (t, text) => { calls.push(text); throw new Error("abort-after-deliver"); },
      save: () => {}, generation: "boot-pr-test", log: () => {},
      ...(launchArgv ? { launchArgv } : {}),
    }).catch(() => {});
    return calls;
  };
  ok((await run(["cc-kimi"]))[0] === `cc-kimi --resume ${SID}`, "claude-kind wrapper argv resumes through the wrapper, not bare claude");
  ok((await run(null))[0] === `claude --resume ${SID}`, "default launchArgv stays bare claude");
  ok((await run(["cc-kimi", "--profile", "two words"]))[0] === `cc-kimi --profile 'two words' --resume ${SID}`,
    "argv boundaries survive resume (spaced element single-quoted)");
}

console.log("\n[silent-failure warnings: once per (invariant, agent), not once per process]");
{
  resetWarnOnce();
  const seen = [];
  const origWarn = console.warn;
  console.warn = (m) => seen.push(String(m));
  try {
    const a = new RuntimeTracker({ id: "agent-a", cwd: "/nonexistent/a" }, { save: () => {} });
    const b = new RuntimeTracker({ id: "agent-b", cwd: "/nonexistent/b" }, { save: () => {} });
    for (let i = 0; i < 5; i++) { a.observe("claude-code"); b.observe("claude-code"); }
    a.observe("node"); b.observe("zsh"); // non-claude-ish names never warn
    ok(seen.filter((m) => m.includes("agent-a")).length === 1, "agent-a warned exactly once across 5 polls");
    ok(seen.filter((m) => m.includes("agent-b")).length === 1, "agent-b warned exactly once too (a global boolean would have hidden it)");
    ok(seen.length === 2 && seen.every((m) => /claude-code/.test(m)), "no warning for node/zsh; message names the untracked command");
    ok(firedWarnings.has("claudeish:agent-a") && firedWarnings.has("claudeish:agent-b"), "fired keys are recorded for doctor to surface");
    ok(warnOnce("claudeish:agent-a", "again") === false && seen.length === 2, "warnOnce returns false and stays quiet on a repeated key");
  } finally { console.warn = origWarn; resetWarnOnce(); }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
