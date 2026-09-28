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
import { join } from "path";
import { homedir } from "os";
import { claudeProjectDir } from "./resume.js";

export const TAIL_BYTES = 256 * 1024;
export const MAX_TEXT = 4000; // chars kept per prompt/reply (the card shows the first line)
// A busy turn can put megabytes of tool traffic between two text replies (26 of
// 29 real transcripts >300 KB had a gap >256 KB). When the tail has no reply the
// window doubles backwards up to this bound; past it the previous reply is kept.
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;
export const WIRE_TEXT = 300; // chars of prompt/reply on the session list (full text via /transcript)

export function transcriptPath(cwd, sessionId, { projectsRoot = join(homedir(), ".claude", "projects") } = {}) {
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
export function summarizeRecords(records) {
  let title = null;
  let lastPrompt = null;
  let lastActivityAt = null;
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
    const t = blockText(rec.message?.content);
    if (!t.trim()) continue; // thinking / tool_use-only records
    const mid = rec.message?.id || rec.uuid || null;
    if (mid !== replyId) { replyId = mid; replyParts = []; }
    replyParts.push(t.trim());
    replyAt = at;
  }
  const lastReply = replyParts.length ? { text: clip(replyParts.join("\n\n")), at: replyAt } : null;
  return { title, lastPrompt, lastReply, lastActivityAt };
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
// title / lastPrompt carry the same way. lastActivityAt is always fresh.
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
  if (prev) for (const k of ["title", "lastPrompt", "lastReply", "lastActivityAt"]) if (!summary[k] && prev[k]) summary[k] = prev[k];
  cache.summary = summary;
  return summary;
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
  return { title: t.title, lastPrompt: short(t.lastPrompt), lastReply: short(t.lastReply), lastActivityAt: t.lastActivityAt };
}
