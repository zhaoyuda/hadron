/**
 * Cursor backend identity + auto-resume reads — server/cursor-resume.js, and
 * decideResume's runtimeName. Pure (temp HOME, injected clock); the live path
 * (launch --resume <uuid>, doctor green, reboot relaunch, clean exit) is in
 * test-handoff.js.
 *
 * Run: node test/unit/test-cursor-resume.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cursorChatsDir, cursorChatMeta, cursorChatExists, newestCursorChat, cursorTranscriptFor, cursorIsUp, CursorRuntimeTracker, CHAT_POLL_MS, CHAT_POLL_NO_ID_MS } from "../../server/cursor-resume.js";
import { decideResume } from "../../server/resume.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.log(`  ✗ ${msg}`); } }

const HOME = mkdtempSync(join(tmpdir(), "cursor-resume-"));
const CWD = "/work/proj";
const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const C = "99999999-8888-4777-8666-555555555555";
function chat(id, { hasConversation = true, updatedAtMs = 0, cwd = CWD, raw } = {}) {
  const d = join(cursorChatsDir(CWD, HOME), id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "meta.json"), raw ?? JSON.stringify({ schemaVersion: 1, createdAtMs: 1, hasConversation, updatedAtMs, cwd }));
}
const rmChat = (id) => rmSync(join(cursorChatsDir(CWD, HOME), id), { recursive: true, force: true });

console.log("1. the chat store");
ok(cursorChatsDir("/home/ubuntu/staging-ws/cursor-smoke", "/h") === "/h/.cursor/chats/47eb27df8beb5c8f10ddde50134aedd7", "chats dir = md5 of the absolute cwd (value probed on cursor-agent 2026.11.22)");
chat(A, { hasConversation: false, updatedAtMs: 1000 });
ok(JSON.stringify(cursorChatMeta(CWD, A, HOME)) === JSON.stringify({ hasConversation: false, updatedAtMs: 1000 }), "meta.json → {hasConversation, updatedAtMs}");
ok(cursorChatMeta(CWD, B, HOME) === null && !cursorChatExists(CWD, B, HOME), "a chat that is not there → null");
chat(B, { cwd: "/elsewhere" });
ok(cursorChatMeta(CWD, B, HOME) === null, "a meta.json naming another cwd → null");
chat(B, { raw: "{torn" });
ok(cursorChatMeta(CWD, B, HOME) === null, "unreadable meta.json → null");
ok(cursorChatMeta(CWD, "../../etc", HOME) === null && cursorChatMeta(null, A, HOME) === null, "a path-shaped id or no cwd → null");
rmChat(B);
chat(B, { updatedAtMs: 5000 });
chat(C, { updatedAtMs: 9000, hasConversation: false });
ok(newestCursorChat(CWD, 0, HOME)?.chatId === B, "newest chat with a turn (a newer chat without one does not count)");
ok(newestCursorChat(CWD, 6000, HOME) === null, "…none at or after sinceMs → null");
ok(newestCursorChat("/nope", 0, HOME) === null, "no folder → null");
const tdir = join(HOME, ".cursor", "projects", "work-proj", "agent-transcripts", A);
mkdirSync(tdir, { recursive: true });
writeFileSync(join(tdir, `${A}.jsonl`), "{}\n");
ok(cursorTranscriptFor(CWD, A, "work-proj", HOME) === join(tdir, `${A}.jsonl`) && cursorTranscriptFor(CWD, B, "work-proj", HOME) === null, "transcript by chat id, null when absent");

console.log("\n2. is cursor-agent up");
ok(cursorIsUp("cursor-agent", {}) && cursorIsUp("agent", {}), "pane command cursor-agent / agent");
ok(cursorIsUp("node", { cursorProc: true }) && !cursorIsUp("node", { cursorProc: false }), "node: the detector's process-tree answer decides");
ok(!cursorIsUp("bash", {}) && !cursorIsUp("", { cursorProc: true }), "a shell, or no command, is down");

console.log("\n3. the tracker");
function mk(session, { shared = false } = {}) {
  let t = 1_000_000;
  const saves = [];
  const tr = new CursorRuntimeTracker(session, {
    save: (s, urgent) => saves.push(!!urgent), cwdShared: () => shared,
    chatMeta: (cwd, id) => cursorChatMeta(cwd, id, HOME), newestChat: (cwd, since) => newestCursorChat(cwd, since, HOME),
    now: () => t,
  });
  return { tr, saves, tick: (cmd, ms = 1000) => { t += ms; tr.observe(cmd); }, at: () => t, set: (v) => { t = v; } };
}
for (const id of [A, B, C]) rmChat(id);
{
  const s = { id: "cur", cwd: CWD };
  const { tr, saves, tick, at } = mk(s);
  tick("cursor-agent"); tick("cursor-agent");
  ok(!s.runtime.desiredRuntime && saves.length === 0, "two polls up: nothing recorded yet (settling)");
  tick("cursor-agent");
  ok(s.runtime.desiredRuntime === "cursor" && s.runtime.observedRuntime === "cursor" && s.runtime.cleanExitAt === null && saves.at(-1) === true, "third poll: desiredRuntime cursor, urgent save");
  tr.recordSpawnedSession(A);
  ok(s.runtime.sessionId === A && s.runtime.confidence === "authoritative" && saves.at(-1) === true, "the launch's --resume id is recorded authoritative");
  chat(A, { hasConversation: false, updatedAtMs: at() });
  tick("cursor-agent", CHAT_POLL_NO_ID_MS + 1);
  ok(!s.runtime.transcriptSeen, "a chat with no turn yet: transcriptSeen unset");
  chat(A, { updatedAtMs: at() });
  tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(s.runtime.transcriptSeen === true && s.runtime.sessionId === A, "first turn → transcriptSeen");
  // A chat with a turn written in the folder while this agent sat idle (a
  // cursor-agent run by hand in a terminal) is never taken.
  chat(B, { updatedAtMs: at() + 10 });
  tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(s.runtime.sessionId === A, "idle agent: a newer chat in the folder is not taken");
  // /clear + a turn: the pane works, the new chat gets a turn after the known one's last.
  s.state = "working";
  tick("cursor-agent", 1000);
  chat(B, { updatedAtMs: at() + 10 });
  s.state = "idle";
  tick("cursor-agent", 1000);
  ok(s.runtime.sessionId === A, "inside the poll interval nothing is re-read");
  tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(s.runtime.sessionId === B && s.runtime.confidence === "correlated" && saves.at(-1) === true, "exclusive cwd: the newer chat with a turn is taken, correlated");
  // An OLDER chat being touched less recently never pulls it back.
  chat(A, { updatedAtMs: at() - 100000 });
  s.state = "working"; tick("cursor-agent", 1000); s.state = "idle";
  tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(s.runtime.sessionId === B, "an older chat does not take it back");
  // Correlated chat deleted → dropped.
  rmChat(B);
  tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(!s.runtime.sessionId && !s.runtime.confidence, "a correlated chat that is gone is dropped");
  // One poll with a shell in front (a tool cursor-agent runs) is no exit.
  tick("bash"); tick("cursor-agent");
  ok(!s.runtime.cleanExitAt && s.runtime.desiredRuntime === "cursor", "one down poll between up polls: no tombstone");
  // Down for 3 polls after settle → clean exit.
  tick("bash"); tick("bash");
  ok(!s.runtime.cleanExitAt, "…two in a row: not yet");
  tick("bash");
  ok(s.runtime.cleanExitAt && s.runtime.desiredRuntime === "shell" && s.runtime.observedRuntime === "shell" && saves.at(-1) === true, "cursor-agent → shell: clean-exit tombstone, urgent");
  tick("cursor-agent"); tick("cursor-agent"); tick("cursor-agent");
  ok(s.runtime.desiredRuntime === "cursor" && s.runtime.cleanExitAt === null, "back up: tombstone cleared");
}
for (const id of [A, B, C]) rmChat(id);
{
  const s = { id: "cur2", cwd: CWD, runtime: { sessionId: A, confidence: "authoritative", transcriptSeen: true, restoreAttempt: { generation: "g", attempts: 1, state: "ready" } } };
  const { tick } = mk(s);
  tick("bash"); tick("bash"); tick("bash"); tick("bash");
  ok(!s.runtime.cleanExitAt, "down before ever settling up: no tombstone (a fresh pane's shell)");
  tick("cursor-agent"); tick("cursor-agent"); tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(s.runtime.sessionId === A && s.runtime.confidence === "authoritative", "a pinned chat that is gone is kept (doctor says so)");
}
{
  chat(A, { updatedAtMs: 1_000_000 });
  const s = { id: "cur3", cwd: CWD, runtime: { sessionId: A, confidence: "authoritative" } };
  const { tick, at } = mk(s, { shared: true });
  s.state = "working";
  tick("cursor-agent"); tick("cursor-agent");
  chat(B, { updatedAtMs: at() + 5000 });
  tick("cursor-agent", CHAT_POLL_MS + 1);
  ok(s.runtime.sessionId === A && s.runtime.transcriptSeen === true, "shared cwd: a newer chat is never taken; the known one is still read");
}
{
  const s = { id: "cur4", cwd: CWD };
  const { tick } = mk(s);
  tick("node"); tick("node"); tick("node");
  ok(s.runtime.desiredRuntime !== "cursor", "node without the process-tree answer is not cursor-agent");
  s.cursorProc = true; s.state = "working";
  tick("node"); tick("node"); tick("node", CHAT_POLL_NO_ID_MS + 1);
  ok(s.runtime.desiredRuntime === "cursor", "node with cursorProc true is (macOS)");
  ok(s.runtime.sessionId === B && s.runtime.confidence === "correlated", "no id + exclusive cwd: cursor-agent started by hand adopts the chat with a turn since it came up");
}

console.log("\n4. decideResume per runtime");
const rt = { desiredRuntime: "cursor", sessionId: A, confidence: "authoritative", lastObservedAt: new Date().toISOString() };
ok(decideResume(rt, { runtimeName: "cursor", generation: "x" }).resume === true, "a cursor checkpoint resumes under runtimeName cursor");
const asClaude = decideResume(rt, { generation: "x" });
ok(asClaude.resume === false && asClaude.reason === "was not in claude", "…and never as claude");
ok(decideResume({ ...rt, desiredRuntime: "claude" }, { runtimeName: "cursor", generation: "x" }).reason === "was not in cursor", "a claude checkpoint is not a cursor one");
ok(decideResume({ ...rt, cleanExitAt: new Date().toISOString() }, { runtimeName: "cursor", generation: "x" }).reason === "clean exit tombstone", "clean exit → no resume");

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
