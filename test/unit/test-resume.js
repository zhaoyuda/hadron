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
import { decideResume, scrapeSessionId, validateSessionFile, claudeProjectDir, RuntimeTracker, performResume, isClaudeCmd, verifyAdoption, PINNED_CONFIDENCE, REGISTRY_POLL_MS, REGISTRY_POLL_NO_ID_MS } from "../../server/resume.js";
import { findRegistrySession, readRegistry, processIdentity } from "../../server/session-registry.js";
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

console.log("\n[RuntimeTracker — a correlated id whose transcript is gone is dropped (prod 2026-09-28: two green agents that could not resume)]");
{
  const oldId = "11111111-2222-4333-8444-555555555555";
  const newId = "33333333-4444-4555-8666-777777777777";
  let scrapes = 0;
  const scrape = () => { scrapes++; return { sessionId: newId, confidence: "correlated" }; };
  const settle = (tr) => { tr.observe("claude"); tr.observe("claude"); tr.observe("claude"); };
  // Exclusive cwd, file gone: drop, then the scrape refills with the current session.
  const corr = { id: "c1", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "correlated" } };
  settle(new RuntimeTracker(corr, { save: () => {}, cwdShared: () => false, scrape, fileExists: () => false }));
  ok(corr.runtime.sessionId === newId && corr.runtime.confidence === "correlated" && scrapes === 1, "exclusive cwd: stale correlated id dropped and re-scraped in the same poll");
  // Urgency: the settle poll is urgent on its own, so prove the flag on a LATER
  // poll — the file vanishes after settle, the 5-min clock is forced due, and
  // that one save must be urgent (a bare heartbeat rides the 30 s trailing write;
  // a crash in that window would reboot on the checkpoint just proven a lie).
  {
    let exists = true;
    const saves = [];
    const late = { id: "c1b", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "correlated" } };
    const tr = new RuntimeTracker(late, { save: (s, u) => saves.push(!!u), cwdShared: () => true, scrape, fileExists: () => exists });
    settle(tr);
    saves.length = 0;
    tr.observe("claude");
    ok(saves.length === 1 && saves[0] === false && late.runtime.sessionId === oldId, "control: a later poll with the file present is a plain heartbeat (not urgent)");
    exists = false;
    tr.observe("claude");
    ok(late.runtime.sessionId === oldId, "…and the check runs on its own 5-min clock, not every poll");
    tr.lastCheckAt = 0;
    saves.length = 0;
    tr.observe("claude");
    ok(late.runtime.sessionId === null && saves.length === 1 && saves[0] === true, "drop on a later poll is persisted urgently");
  }
  // Shared cwd, file gone: drop and stay empty — never a sibling's session.
  scrapes = 0;
  const shared = { id: "c2", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "correlated" } };
  settle(new RuntimeTracker(shared, { save: () => {}, cwdShared: () => true, scrape, fileExists: () => false }));
  ok(shared.runtime.sessionId === null && !("confidence" in shared.runtime) && scrapes === 0, "shared cwd: stale id dropped, no scrape, no id (doctor goes red 'no session id')");
  // File present: untouched (control).
  const fine = { id: "c3", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "correlated" } };
  settle(new RuntimeTracker(fine, { save: () => {}, cwdShared: () => true, scrape, fileExists: () => true }));
  ok(fine.runtime.sessionId === oldId, "control: a correlated id whose file exists is kept");
  // Pinned ids are never re-validated: Hadron chose them; the file appears on the first turn.
  for (const conf of ["authoritative", "manual"]) {
    const pinned = { id: `p-${conf}`, cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: conf } };
    settle(new RuntimeTracker(pinned, { save: () => {}, cwdShared: () => false, scrape, fileExists: () => false }));
    ok(pinned.runtime.sessionId === oldId && pinned.runtime.confidence === conf, `${conf} id survives a missing file`);
  }
  // A malformed id is not this check's business (decideResume reports it).
  const bad = { id: "c4", cwd: "/some/cwd", runtime: { sessionId: "not-a-uuid", confidence: "correlated" } };
  settle(new RuntimeTracker(bad, { save: () => {}, cwdShared: () => true, scrape, fileExists: () => false }));
  ok(bad.runtime.sessionId === "not-a-uuid", "malformed id left for decideResume to report, not silently dropped");
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
  // Doctor and the decider agree: an id with no transcript under the agent's
  // cwd is refused before anything is typed into the pane — at EVERY
  // confidence. A pinned identity is still not resumable without its file.
  for (const conf of ["correlated", "authoritative", "manual", "registry"]) {
    const sess = { id: "y", cwd: "/some/cwd", runtime: { ...base, confidence: conf, lastObservedAt: new Date(Date.now() - 60_000).toISOString() } };
    const calls = [];
    const logs = [];
    const r = await performResume(sess, "tmux-y", {
      deliver: (t, text) => { calls.push(text); throw new Error("abort-after-deliver"); },
      save: () => {}, generation: "boot-pr-test", log: (m) => logs.push(m), fileExists: () => false,
    }).catch(() => null);
    ok(calls.length === 0 && r?.reason === "transcript missing" && !sess.runtime.restoreAttempt && sess.runtime.sessionId === SID,
      `${conf} id, transcript missing → refused, no attempt burned, id kept`);
    ok(!logs.some((m) => m.includes(SID)), `${conf} refusal log carries no session id`);
  }
  // The "resuming" log line names the agent and confidence, never the session id.
  {
    const sess = { id: "z", cwd: "/some/cwd", runtime: { ...base, lastObservedAt: new Date(Date.now() - 60_000).toISOString() } };
    const logs = [];
    await performResume(sess, "tmux-z", {
      deliver: () => { throw new Error("abort-after-deliver"); },
      save: () => {}, generation: "boot-pr-test", log: (m) => logs.push(m), fileExists: () => true,
    }).catch(() => {});
    ok(logs.some((m) => /\[resume\] z: resuming the checkpointed session \(confidence correlated, attempt 1\)/.test(m)) && !logs.some((m) => m.includes(SID)),
      "resume log line names agent + confidence + attempt, not the session id");
  }
  ok((await run(null))[0] === `claude --resume ${SID}`, "default launchArgv stays bare claude");
  ok((await run(["cc-kimi", "--profile", "two words"]))[0] === `cc-kimi --profile 'two words' --resume ${SID}`,
    "argv boundaries survive resume (spaced element single-quoted)");
}

console.log("\n[session registry — ~/.claude/sessions/<pid>.json → this pane's session, pid-verified]");
{
  const root = mkdtempSync(join(tmpdir(), "hadron-registry-"));
  // field types as claude writes them: procStart a STRING, timestamps epoch-ms NUMBERS
  const rec = (pid, extra = {}) => ({ pid, procStart: String(1000 + pid), pidDomain: "linux:de318805c2084395abffe0e4aa6cec48:pid:[4026531836]", sessionId: `11111111-2222-4333-8444-${String(pid).padStart(12, "0")}`, cwd: "/some/cwd", tmux: "hadron-ws-a:@1.%7", status: "idle", updatedAt: Date.now(), startedAt: Date.now() - 5000, version: "2.1.283", kind: "interactive", entrypoint: "cli", ...extra });
  const put = (pid, extra) => writeFileSync(join(root, `${pid}.json`), JSON.stringify(rec(pid, extra)));
  const live = new Map(); // pid → identity
  const identity = (pid) => live.get(pid) || { alive: false, claude: false, start: null };
  const find = (o = {}) => findRegistrySession({ tmuxSession: "hadron-ws-a", paneTarget: () => "@1.%7", root, identity, ...o });

  ok(findRegistrySession({ tmuxSession: "x", paneTarget: "@1.%1", root: join(root, "nope"), identity }).status === "unavailable", "missing registry dir → unavailable");
  ok(find().status === "none", "empty registry → none");
  put(41);
  live.set(41, { alive: true, claude: true, start: 1041 });
  const hit = find();
  ok(hit.status === "matched" && hit.sessionId === rec(41).sessionId && hit.registryStatus === "idle" && hit.entries === 1, "live claude pid, exact pane → matched with its session id");
  ok(readRegistry({ root }).entries.length === 1, "readRegistry parses the well-formed record");
  ok(typeof readRegistry({ root }).entries[0].procStart === "number" && /^\d{4}-\d\d-\d\dT/.test(hit.updatedAt), `procStart string → number, updatedAt epoch-ms → ISO (${hit.updatedAt})`);
  ok(findRegistrySession({ tmuxSession: "hadron-ws-a", paneTarget: "@1.%7", root, identity, registry: readRegistry({ root }) }).status === "matched", "a pre-read registry snapshot is used instead of re-reading the dir");
  ok(find({ paneTarget: () => "@3.%7" }).status === "matched", "same %pane in another @window (break-pane / move-pane) still matches — the pane id is the key");
  put(41, { kind: "batch" });
  ok(find().status === "none" && readRegistry({ root }).malformed === 1, "a non-interactive record (claude -p) is never a candidate");
  put(41);
  ok(find({ paneTarget: () => "@1.%8" }).status === "none", "same tmux session, different pane (user split) → none, not matched");
  ok(find({ paneTarget: () => null }).status === "unavailable", "pane target unresolved → unavailable (never a prefix match)");
  ok(find({ tmuxSession: "hadron-ws-a-sh1" }).status === "none", "a shell-tab claude's session name never matches the agent's");
  ok(find({ tmuxSession: "hadron-ws-" }).status === "none", "session match is exact (prefix + ':'), not a substring");
  live.set(41, { alive: true, claude: true, start: 9999 });
  ok(find().status === "stale", "procStart mismatch (pid reused) → stale");
  live.set(41, { alive: true, claude: false, start: 1041 });
  ok(find().status === "stale", "pid alive but not a claude process → stale");
  live.delete(41);
  ok(find().status === "stale", "pid dead → stale (record left behind by a crash)");
  // pidDomain is the MACHINE id (constant across boots; prod 2026-09-28: a
  // boot-id comparison read every live claude as stale) — never a match key.
  live.set(41, { alive: true, claude: true, start: 1041 });
  ok(find({ paneTarget: () => "@1.%7" }).status === "matched" && findRegistrySession({ tmuxSession: "hadron-ws-a", paneTarget: "@1.%7", root, identity }).status === "matched", "pidDomain is not compared (machine id, not boot id)");
  live.set(41, { alive: true, claude: true, start: null });
  const unv = find();
  ok(unv.status === "unverified" && unv.sessionId === rec(41).sessionId, "no start time on this platform (macOS) but the record has procStart → unverified, id offered, never 'matched'");
  put(41, { procStart: null });
  live.set(41, { alive: true, claude: true, start: 1041 });
  ok(find().status === "unverified", "…a record without procStart (older claude) is unverified too — the rule is 'start time verified or not', not 'the record asked'");
  put(41);
  put(42);
  live.set(41, { alive: true, claude: true, start: 1041 });
  live.set(42, { alive: true, claude: true, start: 1042 });
  ok(find().status === "ambiguous", "two live claudes claiming one pane → ambiguous, never a guess");
  rmSync(join(root, "42.json"));
  // malformed / foreign files are skipped, never crash
  writeFileSync(join(root, "43.json"), "{not json");
  writeFileSync(join(root, "44.json"), JSON.stringify({ pid: 45, sessionId: rec(45).sessionId, cwd: "/x", tmux: "hadron-ws-a:@1.%7" })); // pid ≠ filename
  writeFileSync(join(root, "46.json"), JSON.stringify(rec(46, { sessionId: "not-a-uuid" })));
  writeFileSync(join(root, "41.abc.key"), "x");
  const r2 = readRegistry({ root });
  ok(r2.entries.length === 1 && r2.malformed === 3, `malformed records are counted, not parsed (entries=${r2.entries.length}, malformed=${r2.malformed})`);
  ok(find().status === "matched", "…and the good record still matches");
  // the real thing: this very process is alive, and not claude
  const me = processIdentity(process.pid);
  ok(me.alive === true && me.claude === false, `processIdentity(self) → alive, not claude (${JSON.stringify(me)})`);
  const gone = processIdentity(2 ** 22 - 1);
  ok(gone.alive === false && gone.claude === false, `processIdentity on an unused pid → not alive (${JSON.stringify(gone)})`);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n[RuntimeTracker — registry first: replaces any id (pinned included) with claude's own, same id is idempotent, scrape never overrides it]");
{
  const regId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const oldId = "11111111-2222-4333-8444-555555555555";
  const scrapedId = "33333333-4444-4555-8666-777777777777";
  const settle = (tr) => { tr.observe("claude"); tr.observe("claude"); tr.observe("claude"); };
  let result = { status: "matched", sessionId: regId };
  const registry = () => result;
  const scrape = () => ({ sessionId: scrapedId, confidence: "correlated" });
  for (const conf of ["correlated", "authoritative", "manual", "registry"]) {
    const saves = [];
    // desiredRuntime already "claude": the settle poll leaves restoreAttempt alone (only a
    // shell→claude transition clears it), so what survives here is the registry path's doing.
    const s = { id: `r-${conf}`, cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: conf, desiredRuntime: "claude", restoreAttempt: { state: "ready", generation: "g" } } };
    settle(new RuntimeTracker(s, { save: (x, u) => saves.push(!!u), cwdShared: () => true, scrape, registry, fileExists: () => true }));
    ok(s.runtime.sessionId === regId && s.runtime.confidence === "registry" && saves.includes(true),
      `${conf} id replaced by the registry's (a /clear or fresh claude is claude's own report, not a scrape)`);
    ok(s.runtime.restoreAttempt?.state === "ready", "…restoreAttempt untouched (an in-flight performResume still owns it)");
  }
  // same id → provenance kept
  const auth = { id: "r-same", cwd: "/some/cwd", runtime: { sessionId: regId, confidence: "authoritative" } };
  const trS = new RuntimeTracker(auth, { save: () => {}, cwdShared: () => false, scrape, registry, fileExists: () => true });
  settle(trS);
  ok(auth.runtime.sessionId === regId && auth.runtime.confidence === "authoritative", "same id from the registry keeps authoritative provenance (idempotent)");
  // same id, scraped provenance → promoted: claude confirmed the scrape, so the 5-min file check can no longer drop it
  const corr = { id: "r-same-corr", cwd: "/some/cwd", runtime: { sessionId: regId, confidence: "correlated" } };
  const savesC = [];
  settle(new RuntimeTracker(corr, { save: (x, u) => savesC.push(!!u), cwdShared: () => false, scrape, registry, fileExists: () => true }));
  ok(corr.runtime.sessionId === regId && corr.runtime.confidence === "registry" && savesC.includes(true), "same id with correlated provenance is promoted to registry (persisted)");
  // exclusive cwd, no id, registry matched: the scrape runs too but must not override
  const fresh = { id: "r-fresh", cwd: "/some/cwd" };
  settle(new RuntimeTracker(fresh, { save: () => {}, cwdShared: () => false, scrape, registry, fileExists: () => true }));
  ok(fresh.runtime.sessionId === regId && fresh.runtime.confidence === "registry", "registry beats the scrape in an exclusive cwd (registry is pinned)");
  ok(fresh.runtime.transcriptSeen === true, "…and the settle check saw the transcript (transcriptSeen persisted for doctor)");
  // unverified (macOS): fills an empty id as correlated, never replaces a known one
  result = { status: "unverified", sessionId: regId };
  const unvEmpty = { id: "r-unv-empty", cwd: "/some/cwd" };
  settle(new RuntimeTracker(unvEmpty, { save: () => {}, cwdShared: () => true, scrape, registry, fileExists: () => true }));
  ok(unvEmpty.runtime.sessionId === regId && unvEmpty.runtime.confidence === "correlated", "unverified match fills an EMPTY checkpoint at scrape grade (correlated)");
  const unvAuth = { id: "r-unv-auth", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "authoritative", desiredRuntime: "claude" } };
  settle(new RuntimeTracker(unvAuth, { save: () => {}, cwdShared: () => true, scrape, registry, fileExists: () => true }));
  ok(unvAuth.runtime.sessionId === oldId && unvAuth.runtime.confidence === "authoritative", "unverified match never replaces a known id (pid reuse after a crash cannot be excluded)");
  const unvCorr = { id: "r-unv-corr", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "correlated", desiredRuntime: "claude" } };
  settle(new RuntimeTracker(unvCorr, { save: () => {}, cwdShared: () => true, scrape, registry, fileExists: () => true }));
  ok(unvCorr.runtime.sessionId === oldId, "…not even a correlated one");
  // the flap: unverified fill before the first turn is written must NOT be dropped by the missing-file check
  {
    const seen = [];
    const orig = console.log; console.log = (m) => seen.push(String(m));
    const unvNoFile = { id: "r-unv-nofile", cwd: "/some/cwd" };
    const saves = [];
    const trN = new RuntimeTracker(unvNoFile, { save: (x, u) => saves.push(!!u), cwdShared: () => true, scrape, registry, fileExists: () => false });
    settle(trN); trN.observe("claude"); trN.observe("claude");
    console.log = orig;
    ok(unvNoFile.runtime.sessionId === regId && unvNoFile.runtime.transcriptSeen === false && saves.filter(Boolean).length === 1,
      `unverified fill with no transcript yet is kept (transcriptSeen=false), one urgent save, no fill/drop flap (${saves.filter(Boolean).length})`);
    ok(seen.filter((m) => m.includes("r-unv-nofile") && /session registry/.test(m)).length === 1 && !seen.some((m) => m.includes(regId)), "…logged once, no id");
  }
  // a legacy correlated checkpoint (no transcriptSeen flag) with its file gone is still dropped
  {
    const legacy = { id: "r-legacy", cwd: "/some/cwd", runtime: { sessionId: oldId, confidence: "correlated", desiredRuntime: "claude" } };
    settle(new RuntimeTracker(legacy, { save: () => {}, cwdShared: () => true, scrape, registry: () => ({ status: "none" }), fileExists: () => false }));
    ok(legacy.runtime.sessionId === null && legacy.runtime.transcriptSeen === undefined, "legacy correlated id with a missing file is dropped (pre-flag behaviour kept), flag cleared");
  }
  result = { status: "matched", sessionId: regId };
  ok(PINNED_CONFIDENCE.has("registry"), "registry is a pinned confidence");
  // registry id survives a missing transcript (identity kept; doctor/performResume refuse separately)
  const nofile = { id: "r-nofile", cwd: "/some/cwd", runtime: { sessionId: regId, confidence: "registry" } };
  const trN = new RuntimeTracker(nofile, { save: () => {}, cwdShared: () => true, scrape, registry, fileExists: () => false });
  settle(trN); trN.lastCheckAt = 0; trN.observe("claude");
  ok(nofile.runtime.sessionId === regId && nofile.runtime.confidence === "registry", "registry id is never dropped for a missing transcript (first turn not written yet)");
  ok(nofile.runtime.transcriptSeen === undefined, "…and transcriptSeen stays unset (doctor: yellow 'not written yet', not red)");
  // no match → existing behaviour (scrape in exclusive cwd), and status recorded for doctor
  result = { status: "none" };
  resetWarnOnce();
  const seen = [];
  const origWarn = console.warn;
  console.warn = (m) => seen.push(String(m));
  try {
    const fb = { id: "r-fallback", cwd: "/some/cwd" };
    const trF = new RuntimeTracker(fb, { save: () => {}, cwdShared: () => false, scrape, registry, fileExists: () => true });
    settle(trF);
    ok(fb.runtime.sessionId === scrapedId && fb.runtime.confidence === "correlated" && trF.registryStatus === "none", "registry none → scrape fallback, status recorded");
    ok(seen.filter((m) => m.includes("r-fallback") && /session registry/.test(m)).length === 1 && !seen.some((m) => m.includes(scrapedId) || m.includes(regId)), "warned once (silent-failure rule), no session id in the warning");
    // a throwing registry is "unavailable", never a crash of the poll
    const boom = { id: "r-boom", cwd: "/some/cwd" };
    const trB = new RuntimeTracker(boom, { save: () => {}, cwdShared: () => false, scrape, registry: () => { throw new Error("EACCES"); }, fileExists: () => true });
    settle(trB);
    ok(trB.registryStatus === "unavailable" && boom.runtime.sessionId === scrapedId, "registry lookup throwing → unavailable, poll continues");
  } finally { console.warn = origWarn; resetWarnOnce(); }
  // clocks: no id → every REGISTRY_POLL_NO_ID_MS; with id → every REGISTRY_POLL_MS
  {
    let calls = 0;
    result = { status: "none" };
    const c = { id: "r-clock", cwd: "/some/cwd" };
    const tr = new RuntimeTracker(c, { save: () => {}, cwdShared: () => true, scrape, registry: () => { calls++; return result; }, fileExists: () => true });
    settle(tr);
    ok(calls === 1, `settle poll consults the registry once (${calls})`);
    tr.observe("claude");
    ok(calls === 1, "next poll within the no-id interval does not");
    tr.lastRegistryAt = Date.now() - REGISTRY_POLL_NO_ID_MS - 1;
    tr.observe("claude");
    ok(calls === 2, "no id: consulted again after REGISTRY_POLL_NO_ID_MS");
    result = { status: "matched", sessionId: regId };
    tr.lastRegistryAt = 0; tr.observe("claude");
    ok(calls === 3 && c.runtime.sessionId === regId, "matched on a later poll");
    tr.lastRegistryAt = Date.now() - REGISTRY_POLL_NO_ID_MS - 1;
    tr.observe("claude");
    ok(calls === 3, "with an id: the short interval no longer applies");
    tr.lastRegistryAt = Date.now() - REGISTRY_POLL_MS - 1;
    tr.observe("claude");
    ok(calls === 4, "with an id: consulted again after REGISTRY_POLL_MS");
  }
  // no registry wired (unit tests / older server) → nothing changes
  const nr = { id: "r-none", cwd: "/some/cwd" };
  settle(new RuntimeTracker(nr, { save: () => {}, cwdShared: () => false, scrape, fileExists: () => true }));
  ok(nr.runtime.sessionId === scrapedId, "no registry wired → plain scrape behaviour");
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
