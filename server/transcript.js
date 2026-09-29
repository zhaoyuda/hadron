// Last-reply / last-prompt / activity summary of a claude session, read from
// the transcript claude itself writes (~/.claude/projects/<cwd-dir>/<sid>.jsonl).
//
// Zero-install "tier 0" of the structured-signal plan (ROADMAP: structured
// state detection): the transcript is claude's own record, so the text shown
// on a card is what the agent actually said — not a guess scraped from the
// pane. It is read only for an agent whose session id the resume machinery has
// correlated or that the operator adopted (server/resume.js) — a transcript is
// never attributed to an agent by cwd alone.
//
// Only the tail of the file is read (TAIL_BYTES), re-read only when size/mtime
// change. The summary carries no session id and nothing is persisted.
import { openSync, readSync, closeSync, statSync } from "fs";
import { CLAUDE_PROJECTS_ROOT } from "./session-registry.js";
import { join } from "path";
import { claudeProjectDir } from "./resume.js";

export const TAIL_BYTES = 256 * 1024;
export const MAX_TEXT = 4000; // chars kept per prompt/reply (the card shows the first line)
// A busy turn can put megabytes of tool traffic between two text replies (26 of
// 29 real transcripts >300 KB had a gap >256 KB). When the tail has no reply the
// window doubles backwards up to this bound; past it the previous reply is kept.
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;
export const WIRE_TEXT = 300; // chars of prompt/reply on the session list (full text via /transcript)

export function transcriptPath(cwd, sessionId, { projectsRoot = CLAUDE_PROJECTS_ROOT } = {}) {
  return join(projectsRoot, claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

// Parse the jsonl records in `text`. When `partialHead` is true the first line
// may be a fragment (we started reading mid-file) and is dropped.
export function parseRecords(text, { partialHead = false } = {}) {
  const lines = text.split("\n");
  if (partialHead) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn last line while claude is writing */ }
  }
  return out;
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

// A real user prompt: typed by the person (or delivered by `hadron message`),
// not a tool_result carrier, not a meta record, not a slash-command envelope.
function userPromptText(rec) {
  if (rec.isMeta || rec.isCompactSummary) return null; // compaction summary is not a prompt
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return null;
  const t = blockText(c).trim();
  if (!t || t.startsWith("<")) return null; // <command-name>/<local-command-stdout> envelopes
  return t;
}

function clip(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s;
}

// Pure: records → summary. Sidechain (subagent) records are ignored throughout.
//   title          claude's own ai-title for the session (last one wins)
//   lastPrompt     { text, at } — the last real user prompt
//   lastReply      { text, at } — every text block of the last assistant
//                  message (grouped by message id; a turn's final message is
//                  usually one block, a mid-turn narration is what's current)
//   lastActivityAt timestamp of the last user/assistant record (tool traffic
//                  counts: an agent mid-task is active even without prose)
//   context        { tokens, window, at } — the prompt size of the last API
//                  call claude made (usage of the last assistant record:
//                  input + cache-creation + cache-read tokens), against the
//                  window claude itself assumes for that model. This is what
//                  claude's own footer/statusline computes "% context used"
//                  from; the pane only prints that line near the limit, so
//                  the transcript is the badge's source the rest of the time.
export function summarizeRecords(records) {
  let title = null;
  let lastPrompt = null;
  let lastActivityAt = null;
  let context = null;
  let replyId = null, replyParts = [], replyAt = null;
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") { title = rec.aiTitle; continue; }
    if (rec.isSidechain) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
    if (at) lastActivityAt = at;
    if (rec.type === "user") {
      const t = userPromptText(rec);
      if (t) lastPrompt = { text: clip(t), at };
      continue;
    }
    const usage = usageTokens(rec.message?.usage);
    if (usage !== null) context = { tokens: usage, window: contextWindowFor(rec.message?.model), at };
    const t = blockText(rec.message?.content);
    if (!t.trim()) continue; // thinking / tool_use-only records
    const mid = rec.message?.id || rec.uuid || null;
    if (mid !== replyId) { replyId = mid; replyParts = []; }
    replyParts.push(t.trim());
    replyAt = at;
  }
  const lastReply = replyParts.length ? { text: clip(replyParts.join("\n\n")), at: replyAt } : null;
  return { title, lastPrompt, lastReply, lastActivityAt, context };
}

// Claude Code's own arithmetic (2.1.284): total input of a call is the three
// input counters summed; a model whose name carries "[1m]" runs on the 1M
// window, everything else on 200k. A record with no usage (or a usage with
// no numeric counter) contributes nothing.
export const CONTEXT_WINDOW = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;
export function contextWindowFor(model) {
  return /\[1m\]/i.test(String(model || "")) ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW;
}
function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  let total = 0, seen = false;
  for (const k of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const v = usage[k];
    if (Number.isFinite(v) && v >= 0) { total += v; seen = true; }
  }
  return seen ? total : null;
}

function readTail(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return { text: buf.toString("utf-8", 0, off), partialHead: start > 0 };
  } finally { closeSync(fd); }
}

// Stat-gated reader. `cache` is a per-agent object the caller owns:
//   { size, mtimeMs, summary } — returns cache.summary (null when the file is
// unreadable, e.g. the transcript was deleted). Returns quickly (one stat)
// when nothing changed.
//
// A window that holds no text reply (the agent is mid-task, grepping a tree)
// widens backwards up to MAX_SCAN_BYTES; if a reply is already known from an
// earlier read it is carried forward instead — it is still the last thing the
// agent said, and the strip must not blink out for the length of a turn.
// title / lastPrompt / context carry the same way. lastActivityAt is always fresh.
export function readTranscriptSummary(file, cache) {
  let st;
  try { st = statSync(file); } catch { cache.summary = null; cache.size = -1; return null; }
  if (cache.size === st.size && cache.mtimeMs === st.mtimeMs && cache.summary !== undefined) return cache.summary;
  cache.size = st.size;
  cache.mtimeMs = st.mtimeMs;
  const prev = cache.summary || null;
  let summary;
  try {
    for (let bytes = TAIL_BYTES; ; bytes *= 2) {
      const { text, partialHead } = readTail(file, st.size, bytes);
      summary = summarizeRecords(parseRecords(text, { partialHead }));
      if (summary.lastReply || !partialHead || (prev && prev.lastReply) || bytes >= MAX_SCAN_BYTES) break;
    }
  } catch {
    cache.summary = null;
    return null;
  }
  if (prev) for (const k of ["title", "lastPrompt", "lastReply", "lastActivityAt", "context"]) if (!summary[k] && prev[k]) summary[k] = prev[k];
  cache.summary = summary;
  return summary;
}

// ── Files the agent touched (tool_use blocks over the whole transcript) ──────
// The file panel's "Changed" section: every Edit/Write/MultiEdit/NotebookEdit
// call in the transcript (sidechain included — a subagent's edit is the
// agent's edit) is a write to that path, every Read a read. Attribution is per
// session, so agents sharing a cwd are told apart — git status in the cwd
// cannot do that. Only tool calls with a `file_path`/`notebook_path` count;
// Bash is lossy and ignored.
//
// Unlike the summary, this reads the WHOLE file, once, then only what claude
// appended: `cache.filesOffset` is the byte cursor, a shrunken file (claude
// rewrote it after /compact? never observed, but cheap to honour) restarts
// from zero. At most FILES_CHUNK_BYTES per call so a 100 MB transcript at
// boot costs a few polls, not one long stall — `complete` says whether the
// cursor has reached the end. Lines without a tool_use are skipped before
// JSON.parse (the bulk of a transcript). Entries are capped at FILES_MAX:
// past it the read-only entry with the oldest activity goes first.
export const FILES_CHUNK_BYTES = 8 * 1024 * 1024;
// A single record longer than the chunk is read whole up to this (a tool_use
// is model output, so a few hundred KB at most; the multi-MB lines are
// tool_result carriers, which count for nothing here). Past it the line is
// skipped and the result says so (`skipped`) — never silently.
export const FILES_MAX_LINE = 32 * 1024 * 1024;
export const FILES_MAX = 500;
export const FILES_WIRE = 50; // changed files on the session list; the rest via /files
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read"]);

// Pure: fold the tool_use blocks of `records` into `files` (Map path → entry
//   { path, writes, reads, lastAt, lastWriteAt, lastTool }).
export function collectFileOps(records, files) {
  for (const rec of records) {
    if (!rec || rec.type !== "assistant") continue;
    const c = rec.message?.content;
    if (!Array.isArray(c)) continue;
    const at = typeof rec.timestamp === "string" && Number.isFinite(Date.parse(rec.timestamp)) ? rec.timestamp : null;
    for (const b of c) {
      if (!b || b.type !== "tool_use" || typeof b.name !== "string") continue;
      const isWrite = WRITE_TOOLS.has(b.name), isRead = READ_TOOLS.has(b.name);
      if (!isWrite && !isRead) continue;
      const path = b.input && (typeof b.input.file_path === "string" ? b.input.file_path : typeof b.input.notebook_path === "string" ? b.input.notebook_path : null);
      if (!path || !path.trim()) continue;
      let e = files.get(path);
      if (!e) {
        if (files.size >= FILES_MAX) { evictOne(files); files.evicted = true; }
        e = { path, writes: 0, reads: 0, lastAt: null, lastWriteAt: null, lastTool: null };
        files.set(path, e);
      }
      if (isWrite) { e.writes++; e.lastWriteAt = at || e.lastWriteAt; } else e.reads++;
      e.lastAt = at || e.lastAt;
      e.lastTool = b.name;
    }
  }
  return files;
}
function evictOne(files) {
  let victim = null;
  for (const e of files.values()) {
    if (!victim || (e.writes === 0) > (victim.writes === 0) || ((e.writes === 0) === (victim.writes === 0) && String(e.lastAt || "") < String(victim.lastAt || ""))) victim = e;
  }
  if (victim) files.delete(victim.path);
}

function readRange(file, start, end) {
  const len = end - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

// Incremental reader. `cache` is the same per-agent object the summary reader
// uses (distinct keys): { filesOffset, filesIno, filesMap, filesSkipped,
// filesWideAt, filesResult }. Returns { files: entries (any order), complete,
// skipped (boolean: at least one record was too long to read), evicted } or
// null when the file is unreadable. A torn over-long tail (no newline within
// FILES_MAX_LINE of the cursor, EOF reached) is re-read only once the file
// grows past the size it was seen at (filesWideAt) — a SIGKILLed claude can
// leave one forever, and every poll would otherwise re-read up to 32 MB. One stat when nothing
// changed. A `chunkBytes` below FILES_CHUNK_BYTES (the caller's budget
// residue) never skips a line: a chunk it cannot end on a newline waits for
// a full-size one.
export function readTranscriptFiles(file, cache, { chunkBytes = FILES_CHUNK_BYTES } = {}) {
  let st;
  try { st = statSync(file); } catch { cache.filesOffset = 0; cache.filesMap = undefined; cache.filesResult = null; return null; }
  // Restart from zero on a file that shrank or was replaced (a rename over
  // the path changes the inode; a rewrite in place at ≥ the old size is the
  // one shape this cannot see — claude appends, never rewrites, in practice).
  if (!(cache.filesMap instanceof Map) || st.size < (cache.filesOffset || 0) || (cache.filesIno !== undefined && cache.filesIno !== st.ino)) {
    cache.filesMap = new Map();
    cache.filesOffset = 0;
    cache.filesSkipped = 0;
    cache.filesWideAt = undefined;
    cache.filesResult = undefined;
  }
  cache.filesIno = st.ino;
  if (st.size === cache.filesOffset && cache.filesResult) return cache.filesResult;
  const start = cache.filesOffset;
  let end = Math.min(st.size, start + chunkBytes);
  let buf;
  try { buf = readRange(file, start, end); } catch { cache.filesResult = null; return null; }
  // Stop at the last newline: a torn tail is claude mid-write, read next time.
  let cut = buf.lastIndexOf(10);
  if (cut >= 0) cut += 1;
  else if (end >= st.size || chunkBytes < FILES_CHUNK_BYTES) cut = 0; // torn tail, or a budget-sized slice: wait
  else if (cache.filesWideAt !== undefined && st.size <= cache.filesWideAt) cut = 0; // torn over-long tail already seen at this size: wait for growth
  else {
    // One record longer than a full chunk: read it whole up to FILES_MAX_LINE
    // (its newline is the first one past `end`), else skip it and say so.
    try {
      const wide = readRange(file, start, Math.min(st.size, start + FILES_MAX_LINE));
      const nl = wide.indexOf(10, buf.length);
      if (nl >= 0) { buf = wide; end = start + wide.length; cut = nl + 1; cache.filesWideAt = undefined; }
      else if (start + wide.length >= st.size) { cut = 0; cache.filesWideAt = st.size; } // still no newline before EOF: torn, wait
      else { cut = wide.length; cache.filesSkipped = (cache.filesSkipped || 0) + 1; buf = Buffer.alloc(0); }
    } catch { cache.filesResult = null; return null; }
  }
  if (cut > 0 && buf.length) {
    const text = buf.toString("utf-8", 0, cut);
    const lines = text.split("\n").filter((l) => l.includes('"tool_use"'));
    collectFileOps(parseRecords(lines.join("\n")), cache.filesMap);
  }
  cache.filesOffset = start + cut;
  // A torn last line (no trailing newline yet) leaves the cursor before it:
  // not complete until claude finishes the record.
  const complete = cache.filesOffset >= st.size;
  cache.filesResult = { files: [...cache.filesMap.values()], complete, skipped: cache.filesSkipped > 0, evicted: cache.filesMap.evicted === true };
  return cache.filesResult;
}

// The session-list form: files written, newest write first, FILES_WIRE of
// them; `total` is how many written files the session knows; `complete`
// whether the transcript has been read to its end (a fresh boot on a long
// session catches up over a few polls); `truncated` when entries were evicted
// past FILES_MAX (the list was capped), `partial` when a record was too long
// to read (some writes may be missing) — two different things to tell the
// operator, so two optional bits.
export function filesWire(f) {
  if (!f) return null;
  const changed = f.files.filter((e) => e.writes > 0).sort((a, b) => String(b.lastWriteAt || "").localeCompare(String(a.lastWriteAt || "")));
  return {
    changed: changed.slice(0, FILES_WIRE).map(({ path, writes, reads, lastWriteAt, lastAt }) => ({ path, writes, reads, lastWriteAt, lastAt })),
    total: changed.length,
    complete: f.complete,
    ...(f.evicted ? { truncated: true } : {}),
    ...(f.skipped ? { partial: true } : {}),
  };
}

// The session-list form: first WIRE_TEXT chars of prompt/reply (a card shows
// one line; the full text is one request away for the agent on screen).
export function transcriptWire(t) {
  if (!t) return t;
  const short = (m) => {
    if (!m) return m;
    const truncated = m.text.length > WIRE_TEXT;
    return { text: truncated ? m.text.slice(0, WIRE_TEXT) : m.text, at: m.at, ...(truncated ? { truncated: true } : {}) };
  };
  return { title: t.title, lastPrompt: short(t.lastPrompt), lastReply: short(t.lastReply), lastActivityAt: t.lastActivityAt, context: t.context || null };
}
