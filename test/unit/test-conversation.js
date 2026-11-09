/**
 * Conversation model + draft API (server/conversation.js, the chat view's
 * source of truth — block G1 of design-notes/chat-view-design.md).
 *
 *   - ingestRecord (pure): an assistant message's records (thinking / text /
 *     tool_use, one record each, same message.id) become ONE item with blocks
 *     in order; a tool_result user record lands on its tool_use block (rev
 *     bumped, ord unchanged); user prompts, slash-command envelopes,
 *     local-command output, meta, compaction summary + boundary, turn
 *     duration, queue operations, api errors; sidechain records ignored;
 *     duplicate uuids ignored; title/mode/permissionMode carried; text clipped
 *     with `truncated`, tool inputs clipped per string, results clipped
 *   - task notifications: one `notice` item (status / summary / duration / tools
 *     parsed), the user record of an enqueued one is `dup`, a person's prompt
 *     that starts with the tag stays a prompt
 *   - readConversation: incremental cursor — a second read ingests only the
 *     appended records; a torn tail waits; `after=` returns changed items
 *     (an old assistant item whose tool result just landed included); a
 *     replaced file (inode) and a shrunken file restart from zero; a record
 *     longer than a chunk is read whole; eviction past maxItems flags truncated
 *   - conversationWire paging: tail / before / after + more
 *   - HTTP: GET /conversation 401 without the token, 404 unknown/archived,
 *     {conversationId:null} for a shell agent, items for a seeded transcript
 *     (CLAUDE_CONFIG_DIR relocated), the session id in NO response body;
 *     draft GET/PATCH with revision + 409 on conflict, empty clears, persisted
 *     on the record and short form on the token-bearing list only
 *
 * Run: node test/unit/test-conversation.js
 */
import "./hadron-home.js";
import { spawn } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { claudeProjectDir } from "../../server/resume.js";
import { BLOCKS_MAX, createConversation, ingestRecord, readConversation, conversationWire, conversationIdFor, clipInput, validateDraftPatch, safeDraft, TEXT_MAX, INPUT_TEXT_MAX, RESULT_TEXT_MAX, PAGE_DEFAULT } from "../../server/conversation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const PORT = 6500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SID = randomUUID();
const T = (i) => new Date(Date.UTC(2026, 9, 11, 10, 0, i)).toISOString();
let n = 0;
const uid = () => `u-${++n}`;
const user = (text, i, extra = {}) => ({ type: "user", uuid: uid(), sessionId: SID, timestamp: T(i), message: { role: "user", content: text }, ...extra });
const result = (toolUseId, content, i, extra = {}) => ({ type: "user", uuid: uid(), sessionId: SID, timestamp: T(i), toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...extra }] } });
const asst = (blocks, i, id, extra = {}) => ({ type: "assistant", uuid: uid(), sessionId: SID, timestamp: T(i), message: { id, role: "assistant", model: "claude-x", content: blocks, stop_reason: extra.stop ?? "tool_use", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } }, ...extra });
const line = (r) => JSON.stringify(r) + "\n";

console.log("[ingestRecord — pure]");
{
  const conv = createConversation();
  const recs = [
    { type: "ai-title", aiTitle: "the title", sessionId: SID },
    { type: "mode", mode: "normal", sessionId: SID },
    { type: "permission-mode", permissionMode: "auto", sessionId: SID },
    user("<command-name>/hadron-whoami</command-name>\n<command-message>x</command-message>\n<command-args>foo bar</command-args>", 0),
    user("<local-command-stdout>agent: a1</local-command-stdout>", 1),
    user("把这个做了", 2),
    user("hook context", 3, { isMeta: true }),
    asst([{ type: "thinking", thinking: "hmm", signature: "sig" }], 4, "m1"),
    asst([{ type: "text", text: "看一下。" }], 5, "m1"),
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "List" } }], 6, "m1"),
    { type: "queue-operation", operation: "enqueue", timestamp: T(7), sessionId: SID, content: "后面再做这个" },
    result("t1", "a.txt\nb.txt", 8),
    { type: "user", uuid: "side-1", isSidechain: true, timestamp: T(9), message: { role: "user", content: "subagent prompt" } },
    { type: "assistant", uuid: "side-2", isSidechain: true, timestamp: T(9), message: { id: "m-side", role: "assistant", content: [{ type: "text", text: "subagent reply" }] } },
    asst([{ type: "text", text: "完成了。" }], 10, "m2", { stop: "end_turn" }),
    { type: "system", subtype: "turn_duration", uuid: uid(), timestamp: T(11), durationMs: 6000, sessionId: SID },
    { type: "system", subtype: "compact_boundary", uuid: uid(), timestamp: T(12), content: "Conversation compacted", level: "info", compactMetadata: { trigger: "auto", preTokens: 160000 }, sessionId: SID },
    user("This session is being continued…", 13, { isCompactSummary: true }),
    { type: "system", subtype: "informational", uuid: uid(), timestamp: T(14), content: "note", level: "warning", isMeta: true, sessionId: SID },
    { type: "assistant", uuid: uid(), timestamp: T(15), isApiErrorMessage: true, message: { id: "m3", role: "assistant", content: [{ type: "text", text: "API Error: 529" }] } },
    { type: "last-prompt", lastPrompt: "x", leafUuid: "y", sessionId: SID },
    { type: "attachment", uuid: uid(), attachment: {}, sessionId: SID },
  ];
  for (const r of recs) ingestRecord(conv, r);
  const kinds = conv.items.map((i) => i.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["command", "output", "user", "meta", "assistant", "queue", "assistant", "turn", "compact", "summary", "system", "assistant"]), `item kinds in file order: ${kinds.join(",")}`);
  ok(conv.title === "the title" && conv.mode === "normal" && conv.permissionMode === "auto", "title / mode / permissionMode carried on the conversation");
  const cmd = conv.items[0];
  ok(cmd.name === "/hadron-whoami" && cmd.args === "foo bar", `command envelope → name + args (${cmd.name} ${cmd.args})`);
  ok(conv.items[1].text === "agent: a1", "local-command-stdout → output text");
  ok(conv.items[2].text === "把这个做了" && conv.items[2].at === T(2), "user prompt with its time");
  ok(conv.items[3].kind === "meta" && conv.items[3].text === "hook context", "isMeta record is a meta item (kept, hidden by the client)");
  const a1 = conv.items[4];
  ok(a1.id === "a:m1" && a1.blocks.map((b) => b.type).join(",") === "thinking,text,tool_use", "three records, one message.id → one item with blocks thinking,text,tool_use");
  ok(a1.blocks[0].text === "hmm" && a1.blocks[1].text === "看一下。" && a1.blocks[2].name === "Bash" && a1.blocks[2].input.command === "ls", "block contents");
  ok(a1.blocks[2].result && a1.blocks[2].result.text === "a.txt\nb.txt" && a1.blocks[2].result.isError === false && a1.blocks[2].result.at === T(8), "tool_result paired onto its tool_use block");
  ok(a1.at === T(6) && a1.stopReason === "tool_use" && a1.model === "claude-x" && a1.usage.cacheRead === 30, "assistant item carries the last record's time, stop_reason, model, usage");
  ok(a1.ord === 5 && conv.items[5].ord === 6 && a1.rev > conv.items[5].rev, "the tool result bumped the assistant item's rev past the queue item that followed it, ord unchanged");
  ok(conv.items[5].op === "enqueue" && conv.items[5].text === "后面再做这个", "queue-operation → queue item");
  ok(!conv.items.some((i) => (i.text || "").includes("subagent")) && !conv.byMsgId.has("m-side"), "sidechain records ignored");
  ok(conv.items[7].durationMs === 6000, "turn_duration → turn item");
  ok(conv.items[8].trigger === "auto" && conv.items[8].preTokens === 160000, "compact_boundary → compact item with trigger + preTokens");
  ok(conv.items[9].kind === "summary" && conv.items[9].text.startsWith("This session"), "compaction summary is a summary item, not a user prompt");
  ok(conv.items[10].level === "warning" && conv.items[10].subtype === "informational", "other system records keep subtype + level");
  ok(conv.items[11].error === true && conv.items[11].blocks[0].text === "API Error: 529", "api error message flagged");
  ok(conv.lastAt === T(15), "lastAt = last user/assistant time");
  const before = conv.rev;
  ingestRecord(conv, recs[5]); ingestRecord(conv, recs[9]); ingestRecord(conv, recs[11]);
  ok(conv.items.length === 12 && conv.rev === before && a1.blocks.length === 3, "duplicate uuids (user, assistant block, tool result) are ignored");
  ok(!JSON.stringify(conversationWire(conv)).includes(SID), "no session id anywhere on the wire");
}

console.log("\n[clipping + odd shapes]");
{
  const conv = createConversation();
  ingestRecord(conv, asst([{ type: "text", text: "x".repeat(TEXT_MAX + 5) }], 1, "big"));
  ok(conv.items[0].blocks[0].text.length === TEXT_MAX && conv.items[0].blocks[0].truncated === true, "a text block over TEXT_MAX is clipped + truncated");
  ingestRecord(conv, asst([{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/a", content: "y".repeat(INPUT_TEXT_MAX + 1), nested: { deep: ["z".repeat(INPUT_TEXT_MAX + 1)] } } }], 2, "w"));
  const tu = conv.items[1].blocks[0];
  ok(tu.input.content.length === INPUT_TEXT_MAX && tu.input.nested.deep[0].length === INPUT_TEXT_MAX && tu.inputTruncated === true && tu.input.file_path === "/a", "tool input strings clipped per field (nested too), inputTruncated");
  ingestRecord(conv, result("w1", [{ type: "text", text: "r".repeat(RESULT_TEXT_MAX + 1) }, { type: "image", source: {} }], 3, { is_error: true }));
  ok(tu.result.text.length === RESULT_TEXT_MAX && tu.result.truncated === true && tu.result.isError === true && tu.result.images === 1, "tool result clipped, is_error, images counted");
  ingestRecord(conv, result("nope", "orphan", 4));
  ok(conv.orphanResults === 1 && conv.items.length === 2, "a result for an unknown tool_use is counted, not an item");
  ingestRecord(conv, user("", 5)); ingestRecord(conv, user("   ", 6));
  ok(conv.items.length === 2, "blank user records make no item");
  ingestRecord(conv, user([{ type: "image", source: {} }, { type: "text", text: "看图" }], 7));
  ok(conv.items[2].kind === "user" && conv.items[2].text === "看图" && conv.items[2].images === 1, "a user record with an image block: text + images count");
  ingestRecord(conv, user("<task-notification>x</task-notification>", 8));
  ok(conv.items[3].kind === "user" && conv.items[3].text.startsWith("<task"), "user text beginning with < is still a user item (only the two envelopes are special)");
  ingestRecord(conv, { type: "assistant", uuid: "s", timestamp: "garbage", message: { role: "assistant", content: "plain string" } });
  ok(conv.items[4].blocks[0].text === "plain string" && conv.items[4].at === null, "string content + malformed timestamp tolerated");
  ingestRecord(conv, null); ingestRecord(conv, 5); ingestRecord(conv, { type: "user" }); ingestRecord(conv, { type: "assistant", message: null });
  ok(conv.items.length === 5, "garbage records are no-ops");
  ok(conversationIdFor(SID).startsWith("c-") && conversationIdFor(SID).length === 18 && conversationIdFor(SID) === conversationIdFor(SID) && conversationIdFor(null) === null, "conversationIdFor: stable short hash, never the id");
  ok(clipInput(undefined).input && typeof clipInput(undefined).input === "object", "clipInput tolerates a missing input");
}

console.log("\n[readConversation — incremental]");
const DIR = mkdtempSync(join(tmpdir(), "hadron-convtest-"));
{
  const file = join(DIR, "t.jsonl");
  writeFileSync(file, line(user("q1", 1)) + line(asst([{ type: "text", text: "a1" }], 2, "m1")) + line(asst([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }], 3, "m1")));
  const conv = createConversation();
  ok(readConversation(file, conv) === true && conv.items.length === 2 && conv.complete === true, "first read: 2 items, complete");
  const rev0 = conv.rev;
  ok(readConversation(file, conv) === true && conv.rev === rev0, "nothing new: no change");
  appendFileSync(file, line(user("q2", 4)));
  appendFileSync(file, JSON.stringify(result("t1", "file body", 5)).slice(0, 40)); // torn tail
  ok(readConversation(file, conv) === true && conv.items.length === 3 && conv.complete === false, "appended record ingested, torn tail waits (complete:false)");
  const w = conversationWire(conv, { after: rev0 });
  ok(w.items.length === 1 && w.items[0].kind === "user" && w.items[0].text === "q2", "after=rev: only the new user item");
  writeFileSync(file, readFileSync(file, "utf-8").slice(0, -40) + line(result("t1", "file body", 5)));
  ok(readConversation(file, conv) === true && conv.complete === true, "the tail completes on the next read");
  const w2 = conversationWire(conv, { after: w.rev });
  ok(w2.items.length === 1 && w2.items[0].id === "a:m1" && w2.items[0].blocks[1].result.text === "file body" && w2.items[0].ord === 2, "after=rev: the OLD assistant item whose tool result landed (ord unchanged)");
  ok(conv.items[0].ord === 1 && conv.items[1].ord === 2 && conv.items[2].ord === 3, "ords are positions");
  // Replaced file (new inode) → restart from zero.
  const other = join(DIR, "t2.jsonl");
  writeFileSync(other, line(user("fresh", 6)));
  renameSync(other, file);
  const revBefore = conv.rev;
  ok(readConversation(file, conv) === true && conv.items.length === 1 && conv.items[0].text === "fresh", "a renamed-over file restarts the conversation");
  ok(conv.generation === 1 && conv.rev > revBefore && conv.items[0].rev > revBefore, `the counters keep counting across the restart (generation 1, rev ${revBefore} → ${conv.rev})`);
  const wr = conversationWire(conv, { after: revBefore });
  ok(wr.items.length === 1 && wr.items[0].text === "fresh" && wr.generation === 1, "a client holding the old rev gets the new item and sees generation 1 (drop the old picture)");
  // Shrunken file → restart.
  writeFileSync(file, line(user("short", 7)).slice(0, 10) + "\n");
  readConversation(file, conv);
  ok(conv.items.length === 0 && conv.offset > 0 && conv.generation === 2, "a shrunken file restarts (a malformed line is skipped), generation 2");
  // Unreadable.
  rmSync(file);
  ok(readConversation(file, conv) === false && conv.complete === false, "a missing file reads false, complete:false");
  // Chunking: a record longer than the chunk is read whole; small chunks over many records never skip.
  const big = join(DIR, "big.jsonl");
  const long = asst([{ type: "text", text: "L".repeat(5000) }], 1, "L");
  writeFileSync(big, line(user("a", 0)) + line(long) + line(user("b", 2)));
  const c2 = createConversation();
  let guard = 0;
  while (!c2.complete && guard++ < 50) readConversation(big, c2, { chunkBytes: 1024 });
  ok(c2.items.length === 3 && c2.items[1].blocks[0].text.length === 5000 && c2.skipped === 0, `1 KB chunks: the 5 KB record is read whole (${guard} reads)`);
  // Past maxLine the record is skipped and counted; what follows is still read.
  const huge = join(DIR, "huge.jsonl");
  writeFileSync(huge, line(user("a", 0)) + line(asst([{ type: "text", text: "H".repeat(8000) }], 1, "H")) + line(user("b", 2)));
  const c3 = createConversation();
  guard = 0;
  while (!c3.complete && guard++ < 50) readConversation(huge, c3, { chunkBytes: 1024, maxLine: 4096 });
  ok(c3.skipped === 1 && c3.complete === true && c3.items.some((i) => i.text === "b") && !c3.byMsgId.has("H"), `a record over maxLine is skipped and counted, the next record read (skipped ${c3.skipped}, items ${c3.items.map((i) => i.kind).join(",")})`);
  const ws = conversationWire(c3);
  ok(ws.skipped === 1 && ws.orphanResults === 0 && ws.evicted === 0 && Number.isInteger(ws.generation), "skipped / orphanResults / evicted / generation are counts on the wire");
  // A torn tail reads true with no progress — the server's budget loop must
  // stop on that (it spun on stat+read for the whole budget before).
  const torn = join(DIR, "torn.jsonl");
  writeFileSync(torn, line(user("a", 0)) + JSON.stringify(user("b", 1)).slice(0, 20));
  const c4 = createConversation();
  readConversation(torn, c4);
  const off = c4.offset;
  ok(readConversation(torn, c4) === true && c4.offset === off && c4.complete === false, "a torn tail: readable, no progress, complete:false — the loop's stop condition");
}

{
  const conv = createConversation();
  ingestRecord(conv, asst([{ type: "tool_use", id: "tx", name: "Bash", input: {} }], 1, "mx"));
  const rec = result("tx", "out", 2);
  rec.message.content.push({ type: "text", text: "顺便说一句" });
  ingestRecord(conv, rec);
  ok(conv.items.length === 2 && conv.items[0].blocks[0].result.text === "out" && conv.items[1].kind === "user" && conv.items[1].text === "顺便说一句", "a user record carrying a tool_result AND text keeps the text as a user item");
  // Blocks per assistant message are capped.
  const many = asst(Array.from({ length: 600 }, (_, i) => ({ type: "text", text: `b${i}` })), 3, "big");
  ingestRecord(conv, many);
  ok(conv.items[2].blocks.length === BLOCKS_MAX && conv.items[2].blocksTruncated === true, `an assistant message holds at most BLOCKS_MAX blocks (${BLOCKS_MAX}), flagged`);
}

console.log("\n[task notifications → notice]");
{
  const conv = createConversation();
  const env = (id, status, summary, extra = "") => `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n<usage><subagent_tokens>900</subagent_tokens><tool_uses>7</tool_uses><duration_ms>125000</duration_ms></usage>${extra}\n</task-notification>`;
  const a = env("bg1", "completed", "Agent &quot;scan&quot; &amp; co finished");
  const b = env("bg2", "failed", "Command failed");
  const c = env("bg3", "killed", "x");
  const recs = [
    { type: "queue-operation", operation: "enqueue", timestamp: T(1), sessionId: SID, content: a },
    { type: "queue-operation", operation: "dequeue", timestamp: T(2), sessionId: SID },
    user(a, 3, { origin: { kind: "task-notification" }, promptSource: "system" }),
    user(b, 4, { origin: { kind: "task-notification" } }),
    { type: "queue-operation", operation: "enqueue", timestamp: T(5), sessionId: SID, content: c },
    { type: "queue-operation", operation: "remove", timestamp: T(6), sessionId: SID, content: c },
    user("<task-notification> 我自己打的", 7),
    user("<task-notification> 我自己打的 (human)", 8, { origin: { kind: "human" }, promptSource: "typed" }),
    { type: "queue-operation", operation: "enqueue", timestamp: T(9), sessionId: SID, content: "普通排队消息" },
  ];
  for (const r of recs) ingestRecord(conv, r);
  const kinds = conv.items.map((i) => i.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["notice", "queue", "notice", "notice", "notice", "user", "user", "queue"]), `kinds: ${kinds.join(",")}`);
  const [q, dq, d, f, k] = conv.items;
  ok(dq.op === "dequeue", "a contentless dequeue stays a queue item (the client draws nothing for it)");
  ok(q.via === "queue" && !q.dup && q.status === "completed" && q.summary === 'Agent "scan" & co finished' && q.durationMs === 125000 && q.toolUses === 7, `the enqueued notice parses status / summary (entities decoded) / duration / tools (${q.summary})`);
  ok(q.text === a && q.at === T(1), "…the raw envelope is its text");
  ok(d.via === "record" && d.dup === true, "the user record of the same notice is the dup (the client hides it)");
  ok(f.via === "record" && !f.dup && f.status === "failed", "a notice with no queue entry is a notice, not a dup");
  ok(k.via === "queue" && k.status === "killed", "a notice removed from the queue mid-turn is drawn once, from its enqueue (dequeue / remove add nothing)");
  ok(conv.items[5].kind === "user" && conv.items[5].text === "<task-notification> 我自己打的" && conv.items[6].kind === "user", "a person's prompt that starts with the tag (no origin / human origin) stays a prompt");
  // A prompt typed mid-turn: the queue line becomes the dup once its bubble lands.
  {
    const qline = conv.items[7], rev0 = qline.rev;
    ok(!qline.dup, "a queued prompt's line is drawn while it waits");
    ingestRecord(conv, user("普通排队消息", 9.5));
    ok(qline.dup === true && qline.rev > rev0, "…its user record marks the queue line dup with a new rev (the client hides it on the next after= page)");
    ingestRecord(conv, user("普通排队消息", 9.6));
    ok(conv.items.filter((i) => i.kind === "user" && i.text === "普通排队消息").length === 2, "…a second identical prompt is still a bubble");
    ingestRecord(conv, { type: "queue-operation", operation: "enqueue", timestamp: T(9.7), sessionId: SID, content: "继续" });
    const cont = conv.items[conv.items.length - 1];
    ingestRecord(conv, { type: "queue-operation", operation: "remove", timestamp: T(9.8), sessionId: SID, content: "继续" });
    ingestRecord(conv, user("继续", 9.9));
    ok(cont.kind === "queue" && !cont.dup, "…a prompt removed from the queue mid-turn is forgotten: a later identical prompt does not hide its line");
  }
  // A second record of an already-paired notice is not a dup again.
  ingestRecord(conv, user(a, 10, { origin: { kind: "task-notification" } }));
  ok(conv.items.at(-1).kind === "notice" && !conv.items.at(-1).dup, "the dup pairing is used once");
  const bad = createConversation();
  ingestRecord(bad, user("<task-notification><usage><duration_ms>12abc</duration_ms></usage>", 1, { origin: { kind: "task-notification" } }));
  ok(bad.items[0].kind === "notice" && bad.items[0].durationMs === null && bad.items[0].summary === null && bad.items[0].status === null, "malformed fields are null, never a NaN or a guess");
}

console.log("\n[eviction + paging]");
{
  const conv = createConversation({ maxItems: 5 });
  for (let i = 1; i <= 8; i++) ingestRecord(conv, i % 2 ? user(`q${i}`, i) : asst([{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }], i, `m${i}`));
  ok(conv.items.length === 5 && conv.truncated === true && conv.evicted === 3 && conv.items[0].ord === 4, `oldest evicted past maxItems (first ord ${conv.items[0].ord}, evicted ${conv.evicted})`);
  ok(!conv.byMsgId.has("m2") && !conv.toolUse.has("t2"), "an evicted assistant item leaves the lookup maps");
  ingestRecord(conv, result("t2", "late", 9));
  ok(conv.orphanResults === 1, "a result for an evicted tool_use is an orphan, not a crash");
  const tail = conversationWire(conv, { limit: 2 });
  ok(tail.items.length === 2 && tail.items[1].ord === 8 && tail.more === true && tail.count === 5 && tail.firstOrd === 4 && tail.truncated === true, "default page = the tail, more:true, count/firstOrd/truncated");
  const prev = conversationWire(conv, { before: tail.items[0].ord, limit: 2 });
  ok(prev.items.map((i) => i.ord).join(",") === "5,6" && prev.more === true, "before=ord pages backwards");
  const prev2 = conversationWire(conv, { before: 5, limit: 2 });
  ok(prev2.items.map((i) => i.ord).join(",") === "4" && prev2.more === false, "the last backwards page says more:false");
  const aft = conversationWire(conv, { after: 0, limit: 2 });
  ok(aft.items.length === 2 && aft.more === true, "after= over the limit says more:true (client asks again)");
  // A truncated after= page is a prefix of the REV order (a result bumps an
  // old item to the highest rev at a low ord), so nextAfter misses nothing.
  ingestRecord(conv, result("t4", "late for ord 4", 10));
  const seen = [], revs = [];
  let cursor = 0, pages = 0;
  for (;;) {
    const pg = conversationWire(conv, { after: cursor, limit: 2 });
    pages++;
    for (const it of pg.items) { seen.push(it.ord); revs.push(it.rev); }
    if (!pg.more) { ok(pg.nextAfter === conv.rev, "the last page's nextAfter is the conversation rev"); break; }
    ok(pg.nextAfter === pg.items[pg.items.length - 1].rev && pg.nextAfter > cursor, "a truncated page's nextAfter is its highest rev");
    cursor = pg.nextAfter;
    if (pages > 10) break;
  }
  ok([...seen].sort((a, b) => a - b).join(",") === "4,5,6,7,8" && seen.length === 5 && seen[seen.length - 1] === 4, `paging with nextAfter reaches every changed item once, the bumped ord 4 last (${seen.join(",")} over ${pages} pages)`);
  ok(revs.every((r, i) => i === 0 || r > revs[i - 1]), "after= pages come in rev order");
  ok(conversationWire(conv, { limit: 99999 }).items.length === 5 && conversationWire(conv, { limit: -1 }).items.length === 5, "limit clamped");
  ok(PAGE_DEFAULT === 200, "default page size");
}

console.log("\n[validateDraftPatch / safeDraft]");
{
  const good = validateDraftPatch({ text: "草稿\n第二行\t", attachments: [{ id: "up-1", pos: 2 }], deviceId: "mac:safari", revision: 0, conversationId: "c-abc" });
  ok(!good.error && good.draft.attachments[0].pos === 2 && good.draft.conversationId === "c-abc", "a well-formed PATCH validates (newline/tab allowed)");
  ok(validateDraftPatch({ text: "x\u0001", deviceId: "d", revision: 0 }).error, "control characters refused");
  ok(validateDraftPatch({ text: "x", deviceId: "bad id", revision: 0 }).error && validateDraftPatch({ text: "x", deviceId: "d", revision: -1 }).error && validateDraftPatch({ text: "x", deviceId: "d", revision: 1.5 }).error, "deviceId shape + revision integer");
  ok(validateDraftPatch({ text: "ab", deviceId: "d", revision: 0, attachments: [{ id: "a", pos: 3 }] }).error && validateDraftPatch({ text: "ab", deviceId: "d", revision: 0, attachments: [{ id: "a/b", pos: 0 }] }).error, "attachment pos inside the text, id shape");
  ok(validateDraftPatch({ text: "x", deviceId: "d", revision: 0, conversationId: 5 }).error && !validateDraftPatch({ text: "x", deviceId: "d", revision: 0, conversationId: null }).error, "conversationId: string id or null");
  ok(validateDraftPatch([]).error && validateDraftPatch(null).error && validateDraftPatch({ deviceId: "d", revision: 0 }).error, "non-object / missing text refused");
  ok(safeDraft({ text: "x", deviceId: "d", revision: 2, attachments: [], updatedAt: "nope" })?.updatedAt === null, "safeDraft: a malformed updatedAt emits null");
  ok(safeDraft({ text: "x", deviceId: "d", revision: 0 }) === null && safeDraft({ text: 5, deviceId: "d", revision: 1 }) === null && safeDraft("x") === null, "safeDraft: revision 0 / garbage → null");
}

// ── HTTP ──
const WS = mkdtempSync(join(tmpdir(), "hadron-convws-"));
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-convcfg-"));
let server, TOKEN;
const H = (auth) => (auth ? { "x-hadron-token": TOKEN, "Origin": BASE, "content-type": "application/json" } : { "content-type": "application/json" });
const get = (p, auth = true) => fetch(`${BASE}${p}`, { headers: H(auth) });
const patch = (p, body, auth = true) => fetch(`${BASE}${p}`, { method: "PATCH", headers: H(auth), body: JSON.stringify(body) });
const record = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));
let TFILE;
function seed() {
  const dir = join(WS, ".hadron", "agents");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "talker.json"), JSON.stringify({
    id: "talker", name: "Talker", group: "Workers", cwd: WS,
    runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now, sessionId: SID, confidence: "manual", lastObservedAt: now, lastPersistedAt: now },
  }));
  writeFileSync(join(dir, "shelly.json"), JSON.stringify({ id: "shelly", name: "Shelly", group: "Workers", cwd: WS }));
  writeFileSync(join(dir, "gone.json"), JSON.stringify({ id: "gone", name: "Gone", group: "Workers", cwd: WS, archived: true, archivedAt: now, draft: { text: "old", deviceId: "d", revision: 3, attachments: [] } }));
  const tdir = join(CONFIG, "projects", claudeProjectDir(WS));
  mkdirSync(tdir, { recursive: true });
  TFILE = join(tdir, `${SID}.jsonl`);
  writeFileSync(TFILE, line(user("你好", 1)) + line(asst([{ type: "thinking", thinking: "…" }], 2, "h1")) + line(asst([{ type: "text", text: "你好！" }], 3, "h1", { stop: "end_turn" })));
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/sessions`)).ok) return; } catch {} await sleep(200); }
  throw new Error("server did not start");
}

async function main() {
  seed();
  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", CLAUDE_CONFIG_DIR: CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  console.log("\n[GET /api/sessions/:id/conversation]");
  ok((await get("/api/sessions/talker/conversation", false)).status === 401, "401 without the token");
  ok((await get("/api/sessions/nope/conversation")).status === 404 && (await get("/api/sessions/gone/conversation")).status === 404, "404 unknown / archived");
  const sh = await (await get("/api/sessions/shelly/conversation")).json();
  ok(sh.conversationId === null && sh.items.length === 0 && sh.reason === "no session", "a shell agent: conversationId null, reason");
  let c = await (await get("/api/sessions/talker/conversation")).json();
  ok(c.conversationId === conversationIdFor(SID) && c.items.length === 2 && c.items[1].blocks.length === 2 && c.items[1].blocks[1].text === "你好！" && c.complete === true, `seeded transcript → 2 items (${c.items.map((i) => i.kind).join(",")})`);
  ok((await get("/api/sessions/talker/conversation?limit=0")).status === 400 && (await get("/api/sessions/talker/conversation?limit=5000")).status === 400, "limit out of range → 400");
  ok((await get("/api/sessions/talker/conversation?limit=abc")).status === 400 && (await get("/api/sessions/talker/conversation?after=x")).status === 400 && (await get("/api/sessions/talker/conversation?before=-1")).status === 400, "garbage limit/after/before → 400, never a silent default");
  ok(c.readable === true && Number.isInteger(c.generation) && c.generation > 1e12 && c.nextAfter === c.rev && c.skipped === 0 && c.orphanResults === 0, "readable:true, generation, nextAfter, counts on the wire");
  // A torn tail (claude mid-write): the request returns at once, not after the read budget.
  appendFileSync(TFILE, JSON.stringify(user("半", 9)).slice(0, 25));
  const t0 = Date.now();
  const ct = await (await get("/api/sessions/talker/conversation")).json();
  const tornMs = Date.now() - t0;
  ok(ct.complete === false && ct.items.length === 2 && tornMs < 150, `a torn tail answers at once with complete:false (${tornMs} ms, budget is 250)`);
  writeFileSync(TFILE, readFileSync(TFILE, "utf-8").slice(0, -25));
  appendFileSync(TFILE, line(user("再来", 4)));
  const c2 = await (await get(`/api/sessions/talker/conversation?after=${c.rev}`)).json();
  ok(c2.items.length === 1 && c2.items[0].text === "再来" && c2.rev > c.rev, "after=rev on the next request: only the appended item (read on demand)");
  const c3 = await (await get(`/api/sessions/talker/conversation?after=${c2.rev}`)).json();
  ok(c3.items.length === 0 && c3.rev === c2.rev, "nothing new → empty page, same rev");
  const page = await (await get("/api/sessions/talker/conversation?limit=1")).json();
  ok(page.items.length === 1 && page.items[0].text === "再来" && page.more === true, "limit=1 → the tail item, more");
  const prev = await (await get(`/api/sessions/talker/conversation?before=${page.items[0].ord}&limit=1`)).json();
  ok(prev.items.length === 1 && prev.items[0].kind === "assistant", "before=ord → the one before");
  // (the /api/sessions list carries `runtime` as before — this block adds
  // nothing there but the short draft form, checked below)
  const bodies = [JSON.stringify(c), JSON.stringify(c2), JSON.stringify(sh), JSON.stringify(page), JSON.stringify(prev)];
  ok(!bodies.some((b) => b.includes(SID)), "the session id is in no conversation body");
  // Transcript vanishes → the cached picture stays, complete:false.
  const keep = readFileSync(TFILE);
  rmSync(TFILE);
  const c4 = await (await get("/api/sessions/talker/conversation")).json();
  ok(c4.items.length === 3 && c4.complete === false && c4.readable === false, "a vanished transcript: the cached picture stays, complete:false, readable:false (stale, not 'ask again')");
  writeFileSync(TFILE, keep);

  console.log("\n[draft API]");
  ok((await get("/api/sessions/talker/draft", false)).status === 401 && (await patch("/api/sessions/talker/draft", {}, false)).status === 401, "401 without the token");
  ok((await get("/api/sessions/gone/draft")).status === 404 && (await patch("/api/sessions/gone/draft", { text: "x", deviceId: "d", revision: 3 })).status === 404, "archived agent: 404 both ways");
  ok((await (await get("/api/sessions/talker/draft")).json()).draft === null, "no draft yet → null");
  ok((await patch("/api/sessions/talker/draft", { text: "x", deviceId: "d" })).status === 400 && (await patch("/api/sessions/talker/draft", { text: "x", deviceId: "d", revision: 0 })).status === 400, "malformed PATCH → 400");
  let r = await patch("/api/sessions/talker/draft", { text: "第一稿", deviceId: "mac", revision: 0, conversationId: c.conversationId, attachments: [{ id: "up-7", pos: 3 }] });
  let d = (await r.json()).draft;
  ok(r.status === 200 && d.revision === 1 && d.text === "第一稿" && d.deviceId === "mac" && d.attachments[0].id === "up-7" && d.conversationId === c.conversationId && d.updatedAt, "first PATCH with revision 0 → revision 1");
  ok(record("talker").draft?.revision === 1 && record("talker").draft.text === "第一稿", "persisted on the record");
  const list = await (await get("/api/sessions")).json();
  const row = list.find((s) => s.id === "talker");
  ok(row.draft && row.draft.revision === 1 && row.draft.deviceId === "mac" && row.draft.chars === 3 && row.draft.attachments === 1 && row.draft.text === undefined, "short form on the token-bearing list (no text)");
  const open = await (await get("/api/sessions", false)).json();
  ok(open.find((s) => s.id === "talker").draft === undefined, "absent on the open list");
  r = await patch("/api/sessions/talker/draft", { text: "手机改的", deviceId: "phone", revision: 0 });
  const conflict = await r.json();
  ok(r.status === 409 && conflict.draft.revision === 1 && conflict.draft.text === "第一稿" && conflict.draft.deviceId === "mac", "a stale revision → 409 with the stored draft");
  ok(record("talker").draft.text === "第一稿", "the conflict changed nothing on disk");
  r = await patch("/api/sessions/talker/draft", { text: "手机改的", deviceId: "phone", revision: 1 });
  d = (await r.json()).draft;
  ok(r.status === 200 && d.revision === 2 && d.deviceId === "phone", "the right revision → revision 2 from the other device");
  r = await patch("/api/sessions/talker/draft", { text: "", deviceId: "phone", revision: 2 });
  ok(r.status === 200 && (await r.json()).draft === null && record("talker").draft === undefined, "an empty PATCH clears the draft (gone from the record)");
  ok((await patch("/api/sessions/talker/draft", { text: "late", deviceId: "mac", revision: 2 })).status === 409, "after a clear the expected revision is 0 again (2 → 409)");
  // A draft for another conversation (after /clear) is served stale, never silently reused.
  r = await patch("/api/sessions/talker/draft", { text: "旧会话的稿", deviceId: "mac", revision: 0, conversationId: "c-0000000000000000" });
  d = (await r.json()).draft;
  ok(r.status === 200 && d.stale === true, "a draft whose conversationId is not the agent's current one comes back stale:true");
  ok((await (await get("/api/sessions/talker/draft")).json()).draft.stale === true && (await (await get("/api/sessions")).json()).find((s) => s.id === "talker").draft.stale === true, "stale on GET and on the list's short form");
  ok(record("talker").draft.stale === undefined, "stale is computed, not stored");
  r = await patch("/api/sessions/talker/draft", { text: "现在的", deviceId: "mac", revision: 1, conversationId: c.conversationId });
  d = (await r.json()).draft;
  ok(r.status === 200 && d.stale === undefined, "the current conversation's draft has no stale flag");
  // A long pasted draft (CJK, ~600 KB of JSON) is accepted — express's body cap fits DRAFT_TEXT_MAX.
  r = await patch("/api/sessions/talker/draft", { text: "长".repeat(200_000), deviceId: "mac", revision: 2, conversationId: c.conversationId });
  ok(r.status === 200 && (await r.json()).draft.text.length === 200_000, `a 200k-char CJK draft is stored (${r.status})`);
  r = await patch("/api/sessions/talker/draft", { text: "", deviceId: "mac", revision: 3 });
  ok(r.status === 200, "cleared again");
  r = await patch("/api/sessions/talker/draft", { text: "late", deviceId: "mac", revision: 0 });
  ok(r.status === 200 && (await r.json()).draft.revision === 1, "…and revision 0 starts over at 1");
}

main().catch((e) => { console.error(e); failed++; }).finally(async () => {
  if (server) { const gone = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await Promise.race([gone, sleep(3000)]); }
  rmSync(WS, { recursive: true, force: true }); rmSync(CONFIG, { recursive: true, force: true }); rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
