/**
 * Unit tests for server/transcript.js — the tier-0 "last reply" reader.
 *
 * The card preview / last-reply strip must show what claude actually said:
 * sidechain (subagent) records, tool_result carriers, meta records and
 * slash-command envelopes are not prompts or replies; a reply is every text
 * block of the last assistant message; a torn last line (claude mid-write)
 * and a partial first line (tail read) are dropped, never a crash; nothing
 * in the summary is a session id. `context` is the last assistant usage
 * (input + cache-creation + cache-read) against claude's window for the
 * model (1M for "[1m]" models, 200k otherwise) — the card badge's fallback
 * when the pane does not print its own meter.
 *
 * Run: node test/unit/test-transcript.js
 */
import { parseRecords, summarizeRecords, readTranscriptSummary, transcriptPath, transcriptWire, contextWindowFor, MAX_TEXT, TAIL_BYTES, WIRE_TEXT, CONTEXT_WINDOW, CONTEXT_WINDOW_1M } from "../../server/transcript.js";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const SID = "aaffcbf2-7e28-43ef-8588-478c82d2bad2";
const T = (i) => new Date(Date.UTC(2026, 8, 28, 10, 0, i)).toISOString();
const user = (text, i, extra = {}) => ({ type: "user", sessionId: SID, timestamp: T(i), message: { role: "user", content: text }, ...extra });
const userBlocks = (blocks, i, extra = {}) => ({ type: "user", sessionId: SID, timestamp: T(i), message: { role: "user", content: blocks }, ...extra });
const asst = (blocks, i, id, extra = {}) => ({ type: "assistant", sessionId: SID, timestamp: T(i), message: { id, role: "assistant", content: blocks }, ...extra });

console.log("\n[summarizeRecords — pure]");
{
  const recs = [
    { type: "ai-title", aiTitle: "first-title", sessionId: SID },
    user("do the thing", 1),
    asst([{ type: "thinking", thinking: "hmm" }], 2, "m1"),
    asst([{ type: "text", text: "Let me look." }], 3, "m1"),
    asst([{ type: "tool_use", id: "t1", name: "Read", input: {} }], 4, "m1"),
    userBlocks([{ type: "tool_result", tool_use_id: "t1", content: "file body" }], 5),
    { type: "ai-title", aiTitle: "second-title", sessionId: SID },
    asst([{ type: "text", text: "Done: it works." }], 6, "m2"),
    asst([{ type: "text", text: "Next step is yours." }], 7, "m2"),
    { type: "user", isSidechain: true, sessionId: SID, timestamp: T(8), message: { role: "user", content: "subagent prompt" } },
    { type: "assistant", isSidechain: true, sessionId: SID, timestamp: T(9), message: { id: "s1", role: "assistant", content: [{ type: "text", text: "subagent reply" }] } },
  ];
  const s = summarizeRecords(recs);
  ok(s.title === "second-title", "title: last ai-title wins");
  ok(s.lastPrompt && s.lastPrompt.text === "do the thing" && s.lastPrompt.at === T(1), "lastPrompt is the typed prompt, not the tool_result carrier");
  ok(s.lastReply && s.lastReply.text === "Done: it works.\n\nNext step is yours.", "lastReply joins every text block of the last assistant message (by message id)");
  ok(s.lastReply.at === T(7), "lastReply.at is the last block's timestamp");
  ok(s.lastActivityAt === T(7), "sidechain records never count as activity or reply");
  ok(!JSON.stringify(s).includes(SID), "summary carries no session id");
}
{
  const s = summarizeRecords([
    user("real prompt", 1),
    asst([{ type: "text", text: "answer" }], 2, "m1"),
    user("<command-name>/clear</command-name>", 3),
    user("<local-command-stdout>x</local-command-stdout>", 4),
    user("meta injected", 5, { isMeta: true }),
    userBlocks([{ type: "text", text: "  block prompt  " }], 6),
    user("This session is being continued from a previous conversation…", 7, { isCompactSummary: true }),
  ]);
  ok(s.lastPrompt.text === "block prompt" && s.lastPrompt.at === T(6), "text-block prompts count (trimmed); envelopes, isMeta and a later compaction summary do not");
  ok(s.lastActivityAt === T(7), "activity still advances on a meta/envelope/compaction record");
}
{
  const s = summarizeRecords([
    user("p", 1),
    asst([{ type: "text", text: "narration" }], 2, "m1"),
    asst([{ type: "tool_use", id: "t", name: "Bash", input: {} }], 3, "m1"),
    userBlocks([{ type: "tool_result", tool_use_id: "t", content: "out" }], 4),
  ]);
  ok(s.lastReply.text === "narration" && s.lastActivityAt === T(4), "mid-turn: reply is the latest narration, activity is the tool traffic");
}
{
  const long = "x".repeat(MAX_TEXT + 500);
  const s = summarizeRecords([user(long, 1), asst([{ type: "text", text: long }], 2, "m1")]);
  ok(s.lastPrompt.text.length === MAX_TEXT + 1 && s.lastReply.text.length === MAX_TEXT + 1, `prompt and reply are clipped to MAX_TEXT (${MAX_TEXT}) + ellipsis`);
}
{
  const s = summarizeRecords([null, 42, { type: "assistant" }, { type: "user", message: {} }, { type: "assistant", message: { content: 42 } }, { type: "ai-title", aiTitle: 7 }]);
  ok(s.lastReply === null && s.lastPrompt === null && s.title === null, "malformed records are ignored, not thrown");
  const s2 = summarizeRecords([{ type: "assistant", timestamp: T(1), message: { id: "m", content: [{ type: "text", text: "no uuid ok" }] } }]);
  ok(s2.lastReply.text === "no uuid ok", "an assistant record without uuid still groups by message id");
}

console.log("\n[context — last assistant usage against the model's window]");
{
  const usage = (i, c, r, extra = {}) => ({ input_tokens: i, cache_creation_input_tokens: c, cache_read_input_tokens: r, output_tokens: 99, ...extra });
  const s = summarizeRecords([
    user("go", 1),
    asst([{ type: "thinking", thinking: "…" }], 2, "m1", { message: { id: "m1", role: "assistant", model: "claude-fable-5-1", usage: usage(10, 20, 30), content: [{ type: "thinking", thinking: "…" }] } }),
    asst([{ type: "text", text: "on it" }], 3, "m1", { message: { id: "m1", role: "assistant", model: "claude-fable-5-1", usage: usage(32, 9981, 83050), content: [{ type: "text", text: "on it" }] } }),
    { type: "assistant", isSidechain: true, sessionId: SID, timestamp: T(4), message: { id: "s1", role: "assistant", model: "claude-haiku-4-5-20251001", usage: usage(1, 1, 199000), content: [{ type: "text", text: "sub" }] } },
    userBlocks([{ type: "tool_result", tool_use_id: "t1", content: "x" }], 5),
  ]);
  ok(s.context && s.context.tokens === 32 + 9981 + 83050, `context.tokens sums input + cache_creation + cache_read of the LAST assistant usage (${s.context?.tokens})`);
  ok(s.context.window === CONTEXT_WINDOW && s.context.at === T(3), "window is 200k for a plain model; at = that record's timestamp");
  ok(s.lastActivityAt === T(5) && s.context.at === T(3), "a sidechain's huge usage and later tool traffic do not move the meter");
  const oneM = summarizeRecords([asst([{ type: "text", text: "hi" }], 1, "m", { message: { id: "m", role: "assistant", model: "claude-opus-5[1m]", usage: usage(300000, 0, 0), content: [{ type: "text", text: "hi" }] } })]);
  ok(oneM.context.window === CONTEXT_WINDOW_1M && oneM.context.tokens === 300000, "a \"[1m]\" model runs on the 1M window");
  ok(contextWindowFor("claude-sonnet-5[1M]") === CONTEXT_WINDOW_1M && contextWindowFor("claude-sonnet-5") === CONTEXT_WINDOW && contextWindowFor(undefined) === CONTEXT_WINDOW, "contextWindowFor: [1m] case-insensitive, default 200k, null-safe");
  const none = summarizeRecords([user("q", 1), asst([{ type: "text", text: "a" }], 2, "m1"), asst([{ type: "text", text: "b" }], 3, "m2", { message: { id: "m2", role: "assistant", usage: { output_tokens: 5 }, content: [{ type: "text", text: "b" }] } })]);
  ok(none.context === null, "no usage / no input counters → context null (never 0)");
  const partial = summarizeRecords([asst([{ type: "text", text: "a" }], 1, "m1", { message: { id: "m1", role: "assistant", usage: { input_tokens: 7, cache_read_input_tokens: "lots" }, content: [{ type: "text", text: "a" }] } })]);
  ok(partial.context.tokens === 7, "a non-numeric counter is skipped, the numeric ones still count");
  ok(!JSON.stringify(s).includes(SID) && !("model" in s.context), "context carries numbers only — no session id, no model string");
}

console.log("\n[parseRecords]");
{
  const lines = [JSON.stringify(user("a", 1)), JSON.stringify(user("b", 2)), '{"type":"user","torn'];
  ok(parseRecords(lines.join("\n")).length === 2, "torn last line dropped");
  ok(parseRecords(lines.join("\n"), { partialHead: true }).length === 1, "partialHead drops the first (fragment) line");
  ok(parseRecords("").length === 0 && parseRecords("\n\n").length === 0, "empty input → no records");
}

console.log("\n[readTranscriptSummary — stat-gated tail read]");
{
  const dir = mkdtempSync(join(tmpdir(), "hadron-transcript-"));
  const cwd = "/home/someone/work/proj";
  const file = transcriptPath(cwd, SID, { projectsRoot: dir });
  ok(file === join(dir, "-home-someone-work-proj", `${SID}.jsonl`), "transcriptPath follows claude's project-dir mapping");
  const cache = {};
  ok(readTranscriptSummary(file, cache) === null && cache.size === -1, "missing file → null (no throw)");

  const { mkdirSync } = await import("fs");
  mkdirSync(join(dir, "-home-someone-work-proj"), { recursive: true });
  writeFileSync(file, [JSON.stringify(user("first", 1)), JSON.stringify(asst([{ type: "text", text: "reply one" }], 2, "m1"))].join("\n") + "\n");
  let s = readTranscriptSummary(file, cache);
  ok(s && s.lastReply.text === "reply one", "reads a fresh file");
  const before = cache.summary;
  ok(readTranscriptSummary(file, cache) === before, "unchanged size+mtime → cached object returned (no re-read)");

  // Grow past TAIL_BYTES: the head (with the first prompt) falls out of the
  // window; the tail's first partial line must be dropped, the reply intact.
  const filler = JSON.stringify(userBlocks([{ type: "tool_result", tool_use_id: "t", content: "z".repeat(4000) }], 3));
  const chunks = [];
  while (chunks.join("\n").length < TAIL_BYTES + 20_000) chunks.push(filler);
  appendFileSync(file, chunks.join("\n") + "\n" + JSON.stringify(user("second", 4)) + "\n" + JSON.stringify(asst([{ type: "text", text: "reply two" }], 5, "m2")) + "\n");
  s = readTranscriptSummary(file, cache);
  ok(s && s.lastReply.text === "reply two" && s.lastPrompt.text === "second", "size change → re-read; large file reads only the tail and finds the last turn");
  ok(s.lastActivityAt === T(5), "activity from the tail");

  // A torn write in progress (no trailing newline, half a record) must not
  // regress the summary to null or throw.
  appendFileSync(file, '{"type":"assistant","timestamp":"2026-');
  s = readTranscriptSummary(file, cache);
  ok(s && s.lastReply.text === "reply two", "torn in-progress line: previous turn still reported");

  // Mid-task the tail is all tool traffic: more than TAIL_BYTES of tool_result
  // records after the last text reply. The known reply is carried forward (the
  // strip must not blink out for the length of a turn); activity stays fresh.
  appendFileSync(file, "\n" + chunks.map((c) => c.replace(T(3), T(8))).join("\n") + "\n");
  s = readTranscriptSummary(file, cache);
  ok(s && s.lastReply.text === "reply two" && s.lastPrompt.text === "second", "tail of pure tool traffic: last reply/prompt carried forward from the previous read");
  ok(s.lastActivityAt === T(8), "…while lastActivityAt reflects the new tool traffic");
  ok(s.context === null, "no usage anywhere in this file → context stays null");

  // Usage lives on the assistant record; a later tail of pure tool traffic
  // carries the meter forward like the reply (the badge must not blink out).
  appendFileSync(file, JSON.stringify(asst([{ type: "text", text: "reply three" }], 9, "m3", { message: { id: "m3", role: "assistant", model: "claude-fable-5-1", usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 120000 }, content: [{ type: "text", text: "reply three" }] } })) + "\n");
  s = readTranscriptSummary(file, cache);
  ok(s.context && s.context.tokens === 121005 && s.context.window === CONTEXT_WINDOW, "usage on the new reply → context read");
  appendFileSync(file, chunks.map((c) => c.replace(T(3), T(10))).join("\n") + "\n");
  s = readTranscriptSummary(file, cache);
  ok(s.context && s.context.tokens === 121005 && s.lastReply.text === "reply three", "tail of pure tool traffic: context carried forward with the reply");

  // Same file, fresh cache (server restart): nothing to carry, so the window
  // widens backwards until the reply is in view.
  const fresh = {};
  const s2 = readTranscriptSummary(file, fresh);
  ok(s2 && s2.lastReply.text === "reply three", "fresh read of a tool-heavy tail widens the window backwards to find the last reply");
  ok(s2.context && s2.context.tokens === 121005, "…and the meter comes with it (usage sits on that reply's record)");

  rmSync(dir, { recursive: true, force: true });
  ok(readTranscriptSummary(file, cache) === null, "deleted file → null again");
}

console.log("\n[transcriptWire — session-list form]");
{
  const long = "x".repeat(WIRE_TEXT + 50);
  const w = transcriptWire({ title: "t", lastPrompt: { text: "short", at: T(1) }, lastReply: { text: long, at: T(2) }, lastActivityAt: T(2) });
  ok(w.lastReply.text.length === WIRE_TEXT && w.lastReply.truncated === true && w.lastReply.at === T(2), "reply longer than WIRE_TEXT is clipped and flagged truncated");
  ok(w.lastPrompt.text === "short" && !("truncated" in w.lastPrompt), "short prompt passes through unflagged");
  ok(transcriptWire(null) === null && transcriptWire({ title: null, lastPrompt: null, lastReply: null, lastActivityAt: T(1) }).lastReply === null, "null-safe");
  const ctx = { tokens: 129063, window: CONTEXT_WINDOW, at: T(2) };
  ok(JSON.stringify(transcriptWire({ ...w, context: ctx }).context) === JSON.stringify(ctx), "context rides the wire form unchanged");
  ok(transcriptWire({ title: null, lastPrompt: null, lastReply: null, lastActivityAt: T(1) }).context === null, "…and is null (present) when the summary has none");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
