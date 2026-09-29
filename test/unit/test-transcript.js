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
import { parseRecords, summarizeRecords, readTranscriptSummary, transcriptPath, transcriptWire, contextWindowFor, collectFileOps, readTranscriptFiles, filesWire, coreScore, MAX_TEXT, TAIL_BYTES, WIRE_TEXT, CONTEXT_WINDOW, CONTEXT_WINDOW_1M, FILES_MAX, FILES_WIRE, FILES_CORE_WIRE, FILES_CHUNK_BYTES, FILES_MAX_LINE } from "../../server/transcript.js";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, openSync, writeSync, closeSync, statSync } from "fs";
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

console.log("\n[collectFileOps — files the session touched]");
{
  const tool = (name, input, i, extra = {}) => ({ type: "assistant", sessionId: SID, timestamp: T(i), message: { id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name, input }] }, ...extra });
  const m = collectFileOps([
    tool("Read", { file_path: "/w/a.js" }, 1),
    tool("Edit", { file_path: "/w/a.js", old_string: "x", new_string: "y" }, 2),
    tool("Write", { file_path: "/w/b.md", content: "hi" }, 3),
    tool("MultiEdit", { file_path: "/w/a.js", edits: [] }, 4, { isSidechain: true }),
    tool("NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "" }, 5),
    tool("Bash", { command: "git checkout -- /w/c.js && touch /w/d" }, 6),
    tool("Glob", { pattern: "**/*.js" }, 7),
    tool("Edit", { file_path: "" }, 8),
    tool("Edit", {}, 9),
    { type: "user", timestamp: T(10), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
    tool("Read", { file_path: "/w/a.js" }, 11),
  ], new Map());
  const a = m.get("/w/a.js");
  ok(a && a.writes === 2 && a.reads === 2 && a.lastWriteAt === T(4) && a.lastAt === T(11) && a.lastTool === "Read", `Read/Edit/MultiEdit on one path fold into writes 2, reads 2, lastWriteAt of the MultiEdit, lastAt of the last Read (${JSON.stringify(a)})`);
  ok(m.get("/w/b.md")?.writes === 1 && m.get("/w/b.md").reads === 0, "Write counts as a write");
  ok(m.get("/w/n.ipynb")?.writes === 1, "NotebookEdit's notebook_path counts as a write");
  ok(m.size === 3, `Bash, Glob, an empty or missing file_path and tool_result carriers add nothing (${[...m.keys()].join(", ")})`);
  ok(!JSON.stringify([...m.values()]).includes(SID), "no session id in the entries");
  // Cap: past FILES_MAX the read-only entry with the oldest activity goes first.
  const big = new Map();
  for (let i = 0; i < FILES_MAX; i++) collectFileOps([tool(i % 2 ? "Edit" : "Read", { file_path: `/f/${i}` }, i)], big);
  collectFileOps([tool("Write", { file_path: "/f/new" }, FILES_MAX + 1)], big);
  ok(big.size === FILES_MAX && big.has("/f/new") && !big.has("/f/0") && big.has("/f/1"), `FILES_MAX cap evicts the oldest read-only entry (/f/0), keeps the written one beside it (${big.size})`);
  ok(big.evicted === true && m.evicted === undefined, "…and the map is flagged evicted (the count is a floor from then on); an uncapped map is not");
  const bad = collectFileOps([tool("Edit", { file_path: "/w/x" }, 1, { timestamp: "not a date" })], new Map());
  ok(bad.get("/w/x").lastAt === null && bad.get("/w/x").lastWriteAt === null && bad.get("/w/x").writes === 1, "a malformed timestamp is dropped (null), the write still counts");
}

console.log("\n[readTranscriptFiles — incremental whole-file cursor]");
{
  const { mkdirSync } = await import("fs");
  const dir = mkdtempSync(join(tmpdir(), "hadron-transcript-files-"));
  const file = join(dir, `${SID}.jsonl`);
  const tool = (name, path, i) => JSON.stringify({ type: "assistant", sessionId: SID, timestamp: T(i), message: { id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name, input: { file_path: path } }] } });
  const cache = {};
  ok(readTranscriptFiles(file, cache) === null, "missing file → null (no throw)");
  writeFileSync(file, [JSON.stringify(user("go", 0)), tool("Edit", "/w/a.js", 1), tool("Read", "/w/b.js", 2)].join("\n") + "\n");
  let f = readTranscriptFiles(file, cache);
  ok(f && f.complete && f.files.length === 2 && f.files.find((e) => e.path === "/w/a.js").writes === 1, "fresh file read whole: complete, two files");
  const same = readTranscriptFiles(file, cache);
  ok(same === f, "unchanged file → the cached result object (one stat, no read)");
  // A torn last line (claude mid-write): not consumed, not complete, then whole once finished.
  appendFileSync(file, tool("Write", "/w/c.md", 3).slice(0, 40));
  f = readTranscriptFiles(file, cache);
  ok(f && !f.complete && f.files.length === 2, "torn tail is left for next time: not complete, nothing counted");
  appendFileSync(file, tool("Write", "/w/c.md", 3).slice(40) + "\n");
  f = readTranscriptFiles(file, cache);
  ok(f && f.complete && f.files.find((e) => e.path === "/w/c.md")?.writes === 1, "…and counted once the newline lands, from the cursor only");
  // Chunking: a small chunk takes several calls and lands on line boundaries.
  const many = []; for (let i = 10; i < 60; i++) many.push(tool("Edit", `/w/${i}.js`, i));
  appendFileSync(file, many.join("\n") + "\n");
  const fresh = {};
  let calls = 0, r;
  do { r = readTranscriptFiles(file, fresh, { chunkBytes: 1500 }); calls++; } while (r && !r.complete && calls < 200);
  ok(r && r.complete && calls > 3 && r.files.length === 53 && r.files.every((e) => e.writes + e.reads > 0), `1.5 KB chunks: complete after ${calls} calls, every line counted exactly once (${r.files.length} files)`);
  ok(r.files.find((e) => e.path === "/w/a.js").writes === 1, "…no double counting across chunk boundaries");
  // Truncation (file rewritten shorter) restarts from zero.
  writeFileSync(file, tool("Edit", "/w/only.js", 1) + "\n");
  f = readTranscriptFiles(file, cache);
  ok(f && f.complete && f.files.length === 1 && f.files[0].path === "/w/only.js", "a shrunken file restarts the scan from zero");
  // A budget-sized slice (below FILES_CHUNK_BYTES) that cannot end on a
  // newline waits — it never skips a record that a full chunk would read.
  writeFileSync(file, tool("Write", "/w/big.txt".padEnd(1500, "x"), 1) + "\n" + tool("Edit", "/w/after.js", 2) + "\n");
  const slice = {};
  r = readTranscriptFiles(file, slice, { chunkBytes: 1000 });
  ok(r && !r.complete && r.files.length === 0 && slice.filesOffset === 0, "a 1 KB slice on a 1.5 KB record: nothing consumed, not complete");
  r = readTranscriptFiles(file, slice);
  ok(r && r.complete && r.files.length === 2 && r.skipped === false, "…a full chunk later reads both records");
  // A record longer than a full chunk is read whole (up to FILES_MAX_LINE)…
  const long = JSON.stringify({ type: "assistant", timestamp: T(3), message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/w/huge.bin", content: "y".repeat(FILES_CHUNK_BYTES + 100) } }] } });
  writeFileSync(file, long + "\n" + tool("Edit", "/w/after.js", 4) + "\n");
  const huge = {}; calls = 0;
  do { r = readTranscriptFiles(file, huge); calls++; } while (r && !r.complete && calls < 10);
  ok(r && r.complete && r.files.map((e) => e.path).sort().join() === "/w/after.js,/w/huge.bin" && r.skipped === false, `a Write longer than FILES_CHUNK_BYTES is read whole and counted (${calls} calls, ${r?.files.length} files)`);
  // …and past FILES_MAX_LINE it is skipped, with `skipped` saying so.
  const fd = openSync(file, "w");
  writeSync(fd, '{"type":"user","message":{"content":"');
  const filler = Buffer.alloc(1 << 20, 0x7a);
  for (let i = 0; i < (FILES_MAX_LINE >> 20) + 1; i++) writeSync(fd, filler);
  writeSync(fd, '"}\n' + tool("Edit", "/w/after.js", 5) + "\n");
  closeSync(fd);
  const skip = {}; calls = 0;
  do { r = readTranscriptFiles(file, skip); calls++; } while (r && !r.complete && calls < 20);
  ok(r && r.complete && r.skipped === true && r.files.length === 1 && r.files[0].path === "/w/after.js", `a line past FILES_MAX_LINE is skipped, reported (skipped=${r?.skipped}), and the next line still counts (${calls} calls)`);
  {
    const w = filesWire(r), clean = filesWire({ files: [], complete: true, skipped: false, evicted: false });
    ok(w.partial === true && w.truncated === undefined && clean.partial === undefined && clean.truncated === undefined, "…the wire form says partial (not truncated — nothing was capped); a clean read says neither");
    ok(filesWire({ files: [], complete: true, skipped: false, evicted: true }).truncated === true && filesWire({ files: [], complete: true, skipped: false, evicted: true }).partial === undefined, "eviction is truncated, not partial");
  }
  // A torn over-long tail (a full chunk with no newline, EOF within
  // FILES_MAX_LINE, no newline there either — a SIGKILLed claude) is re-read
  // only when the file grows, never on every poll.
  {
    const fd2 = openSync(file, "w");
    for (let i = 0; i < (FILES_CHUNK_BYTES >> 20) + 2; i++) writeSync(fd2, filler);
    closeSync(fd2);
    const torn = {};
    r = readTranscriptFiles(file, torn);
    ok(r && !r.complete && torn.filesOffset === 0 && torn.filesWideAt === statSync(file).size, "a torn over-long tail waits and remembers the size it was seen at");
    const seenAt = torn.filesWideAt;
    r = readTranscriptFiles(file, torn);
    ok(r && !r.complete && torn.filesOffset === 0 && torn.filesWideAt === seenAt, "…an unchanged file is not re-read wide again (gate holds at the same size)");
    appendFileSync(file, "\n" + tool("Edit", "/w/after.js", 6) + "\n");
    calls = 0;
    do { r = readTranscriptFiles(file, torn); calls++; } while (r && !r.complete && calls < 20);
    ok(r && r.complete && r.files.length === 1 && r.files[0].path === "/w/after.js" && torn.filesWideAt === undefined, `…and the record that completed the tail is consumed (${calls} calls, skipped=${r?.skipped})`);
  }
  // A file replaced under the same path (new inode, not smaller) restarts.
  writeFileSync(file, tool("Edit", "/w/one.js", 1) + "\n" + tool("Edit", "/w/two.js", 2) + "\n");
  const repl = {};
  r = readTranscriptFiles(file, repl);
  ok(r && r.files.length === 2, "baseline: two files");
  const tmp = file + ".new";
  writeFileSync(tmp, tool("Edit", "/w/three.js", 3) + "\n" + tool("Edit", "/w/four.js", 4) + "\n" + tool("Read", "/w/five.js", 5) + "\n");
  (await import("fs")).renameSync(tmp, file);
  r = readTranscriptFiles(file, repl);
  ok(r && r.complete && r.files.map((e) => e.path).sort().join() === "/w/five.js,/w/four.js,/w/three.js", `a rename over the path (larger file, new inode) restarts the scan — no stale entries (${r?.files.map((e) => e.path).join()})`);
  rmSync(dir, { recursive: true, force: true });
  ok(readTranscriptFiles(file, cache) === null && cache.filesOffset === 0, "deleted file → null, cursor reset");
}

console.log("\n[filesWire — session-list form]");
{
  const e = (path, writes, reads, i) => ({ path, writes, reads, lastAt: T(i), lastWriteAt: writes ? T(i) : null, lastTool: writes ? "Edit" : "Read" });
  const files = [e("/r", 0, 3, 9), e("/old", 1, 0, 1), e("/new", 2, 1, 5)];
  const w = filesWire({ files, complete: false });
  ok(w.changed.map((x) => x.path).join() === "/new,/old" && w.total === 2 && w.complete === false, `written files only, newest write first, total counts them (${JSON.stringify(w)})`);
  ok(!("lastTool" in w.changed[0]) && w.changed[0].writes === 2 && w.changed[0].reads === 1, "entry carries path/writes/reads/lastWriteAt/lastAt");
  const lots = []; for (let i = 0; i < FILES_WIRE + 20; i++) lots.push(e(`/f${i}`, 1, 0, i % 60));
  const w2 = filesWire({ files: lots, complete: true });
  ok(w2.changed.length === FILES_WIRE && w2.total === FILES_WIRE + 20, `capped at FILES_WIRE on the wire, total says how many (${w2.total})`);
  ok(filesWire(null) === null, "null-safe");
  // Core: every touched file by heat (a write = three reads), ties by recency.
  const core = filesWire({ files: [e("/read-only", 0, 3, 9), e("/one-write-old", 1, 0, 1), e("/one-write-new", 1, 0, 5), e("/hot", 2, 4, 2)], complete: true }).core;
  ok(coreScore({ writes: 2, reads: 4 }) === 10 && coreScore({ writes: 0, reads: 3 }) === 3 && coreScore({}) === 0, "coreScore = 3·writes + reads");
  ok(core.map((x) => x.path).join() === "/hot,/read-only,/one-write-new,/one-write-old", `core: heat first (3 reads = 1 write), ties by lastAt, a read-only file included (${core.map((x) => x.path).join()})`);
  ok(core[0].reads === 4 && core[0].writes === 2 && typeof core[0].lastAt === "string" && !("lastTool" in core[0]), "core entry carries path/writes/reads/lastWriteAt/lastAt");
  {
    // Hidden files are dropped before the wire cap: hiding the top 40 of 45 leaves 5, not 0.
    const many = Array.from({ length: 45 }, (_, i) => e(`/f${i}`, 45 - i, 0, 1));
    const skip = new Set(many.slice(0, 40).map((x) => x.path));
    const c = filesWire({ files: many, complete: true }, { coreSkip: (p) => skip.has(p) }).core;
    ok(c.length === 5 && c[0].path === "/f40" && c.every((x) => !skip.has(x.path)), "coreSkip filters before the wire slice");
  }
  const w3 = filesWire({ files: lots, complete: true });
  ok(w3.core.length === FILES_CORE_WIRE, `core capped at FILES_CORE_WIRE on the wire (${w3.core.length})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
