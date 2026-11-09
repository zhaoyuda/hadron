/**
 * Conversation model over claude's own transcript jsonl — the chat view's
 * source of truth (design-notes/chat-view-design.md, block G1).
 *
 * Unlike transcript.js (a bounded tail reader for the card's "last reply"),
 * this rebuilds the WHOLE conversation incrementally: a per-agent cache holds
 * an ordered list of items, a byte cursor into the file, and the maps that
 * glue records together. Each poll reads only what claude appended since.
 *
 * Items (one per conversation event, in file order; `ord` is the position,
 * `rev` the change counter — a tool result landing on an earlier assistant
 * message bumps that item's rev, so a client that remembers the highest rev it
 * saw gets every item that changed since, not only the new ones):
 *   user       a prompt the person typed (or `hadron message` delivered)
 *   command    a slash-command envelope (<command-name>…), `name`/`args`
 *   output     <local-command-stdout> — what a local command printed
 *   meta       isMeta records (hooks, injected context) — hidden by default
 *   assistant  one API message: blocks [thinking | text | tool_use(+result)]
 *              grouped by message.id across records; stopReason/model/usage
 *   summary    the compaction summary claude writes as a user record
 *   compact    system/compact_boundary (trigger, preTokens)
 *   turn       system/turn_duration (durationMs) — "Working · Ns" ends here
 *   system     other system records (away_summary, informational): text, level
 *   queue      queue-operation records (claude's own queue: op + text)
 *   notice     a <task-notification> claude fed itself (a background command or
 *              agent finished / stopped): status, summary, durationMs, toolUses,
 *              text = the whole envelope. Comes from the user record claude
 *              writes for it, or from the queue-operation that enqueued it (a
 *              notice removed from the queue mid-turn never gets a user record).
 *              Once its user record lands, the queue line is `dup` (the record is shown).
 * Sidechain (subagent) records are ignored throughout. Records are deduped by
 * uuid. Nothing in an item is a session id; the conversation's identity on the
 * wire is a hash of it (conversationId), so /clear or a resume reads as a new
 * conversation without the id itself leaving the server.
 *
 * Text is clipped per block (TEXT_MAX), tool inputs per string field
 * (INPUT_TEXT_MAX), tool results (RESULT_TEXT_MAX) — `truncated` on the piece.
 * The item list is capped at MAX_ITEMS (oldest evicted, `truncated` on the
 * conversation). A record longer than MAX_LINE is skipped and counted.
 */
import { openSync, readSync, closeSync, statSync } from "fs";
import { createHash } from "crypto";

export const CHUNK_BYTES = 4 * 1024 * 1024;   // bytes ingested per read call
export const MAX_LINE = 32 * 1024 * 1024;     // a record longer than this is skipped
export const MAX_ITEMS = 4000;
export const TEXT_MAX = 100_000;
export const BLOCKS_MAX = 500; // blocks one assistant message may hold (a count cap: items are bounded, blocks were not)              // chars per text/thinking block
export const INPUT_TEXT_MAX = 20_000;         // chars per string in a tool input
export const RESULT_TEXT_MAX = 20_000;        // chars per tool result
export const SEEN_MAX = 5000;                 // record uuids remembered for dedupe
export const PAGE_DEFAULT = 200, PAGE_MAX = 1000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const safeAt = (t) => (typeof t === "string" && ISO_RE.test(t) ? t : null);
const str = (v) => (typeof v === "string" ? v : "");

function clipText(s, max) {
  if (s.length <= max) return { text: s };
  return { text: s.slice(0, max), truncated: true };
}

// Deep copy of a tool input with every long string clipped; `truncated` set on
// the returned wrapper when anything was.
export function clipInput(input, max = INPUT_TEXT_MAX) {
  let truncated = false;
  const walk = (v, depth) => {
    if (typeof v === "string") { if (v.length > max) { truncated = true; return v.slice(0, max); } return v; }
    if (Array.isArray(v)) return depth > 8 ? [] : v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      if (depth > 8) return {};
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, depth + 1);
      return o;
    }
    return v === undefined ? null : v;
  };
  const out = walk(input && typeof input === "object" ? input : {}, 0);
  return truncated ? { input: out, truncated: true } : { input: out };
}

// Text of a user/tool_result content (string or block list); images counted.
function contentText(c) {
  if (typeof c === "string") return { text: c, images: 0 };
  if (!Array.isArray(c)) return { text: "", images: 0 };
  let images = 0;
  const parts = [];
  for (const b of c) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") images++;
  }
  return { text: parts.join("\n"), images };
}

const ENVELOPE_RE = /^<command-name>([\s\S]*?)<\/command-name>/;
const ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const NOTICE_SEEN_MAX = 200;
const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tag = (text, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text); return m ? m[1].trim() : null; };
const num = (v) => (v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null);
// One notice item from a <task-notification> envelope. Only `text` carries the
// whole envelope; the rest are what the one-line card shows.
function noticeItem(id, at, text, via) {
  const head = text.slice(0, 64 * 1024);
  const summary = tag(head, "summary");
  return {
    id, kind: "notice", at, via,
    status: (tag(head, "status") || "").slice(0, 40) || null,
    summary: summary === null ? null : unxml(summary).slice(0, 300),
    durationMs: num(tag(head, "duration_ms")), toolUses: num(tag(head, "tool_uses")),
    ...clipText(text, TEXT_MAX),
  };
}
// The shape claude writes (tag, task-id first, closing tag). The queue record
// carries no origin, so a person's queued prompt that merely starts with the
// tag must not pass for one.
const NOTICE_SHAPE_RE = /^\s*<task-notification>\s*<task-id>[\s\S]*<\/task-notification>\s*$/;
// The envelope a notice record carries, past any banner claude put in front of it.
const noticeKey = (text) => { const i = text.indexOf("<task-notification>"); return i < 0 ? null : text.slice(i).trim(); };
// Queue lines waiting for their record, oldest first, at most NOTICE_SEEN_MAX
// entries: the oldest goes first (a list, so the order is by entry, not by text).
// An entry outlives its line's eviction from the picture (item → null, id kept):
// the record still names the line in `hides` for a client that holds it.
// An entry shifted out by the cap is forgotten: its record names nothing, and a
// client still holding that line shows both (past 200 waiting lines; accepted).
function waitAdd(list, key, item) {
  list.push({ key, id: item.id, item });
  if (list.length > NOTICE_SEEN_MAX) list.shift();
}
function waitTake(list, key) {
  if (key == null) return null;
  const i = list.findIndex((e) => e.key === key);
  return i < 0 ? null : list.splice(i, 1)[0];
}
const STDOUT_RE = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

export function conversationIdFor(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  return "c-" + createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export function createConversation({ maxItems = MAX_ITEMS } = {}) {
  return {
    items: [], ord: 0, rev: 0, maxItems,
    byMsgId: new Map(), toolUse: new Map(), seen: new Map(), noticeSeen: [], queuedPrompt: [],
    title: null, mode: null, permissionMode: null, lastAt: null,
    evicted: 0, skipped: 0, orphanResults: 0, truncated: false,
    offset: 0, ino: undefined, wideAt: undefined, complete: false,
    generation: 0,
  };
}

function push(conv, item) {
  item.ord = ++conv.ord;
  item.rev = ++conv.rev;
  conv.items.push(item);
  while (conv.items.length > conv.maxItems) {
    const gone = conv.items.shift();
    conv.evicted++;
    conv.truncated = true;
    // A waiting line evicted from the picture: drop the reference, keep the id.
    for (const l of [conv.noticeSeen, conv.queuedPrompt]) for (const e of l) if (e.item === gone) e.item = null;
    if (gone.kind === "assistant") {
      conv.byMsgId.delete(gone.msgId);
      for (const b of gone.blocks) if (b.type === "tool_use") conv.toolUse.delete(b.id);
    }
  }
  return item;
}
function touch(conv, item) { item.rev = ++conv.rev; }

function seenBefore(conv, uuid) {
  if (typeof uuid !== "string" || !uuid) return false;
  if (conv.seen.has(uuid)) return true;
  conv.seen.set(uuid, true);
  if (conv.seen.size > SEEN_MAX) conv.seen.delete(conv.seen.keys().next().value);
  return false;
}

function ingestUser(conv, rec) {
  if (seenBefore(conv, rec.uuid)) return;
  const at = safeAt(rec.timestamp);
  const c = rec.message?.content;
  if (at) conv.lastAt = at;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) {
    for (const b of c) {
      if (!b || b.type !== "tool_result") continue;
      const owner = conv.toolUse.get(b.tool_use_id);
      if (!owner) { conv.orphanResults++; continue; }
      const block = owner.blocks.find((x) => x.type === "tool_use" && x.id === b.tool_use_id);
      if (!block) { conv.orphanResults++; continue; }
      const { text, images } = contentText(b.content);
      const clipped = clipText(text, RESULT_TEXT_MAX);
      block.result = { text: clipped.text, isError: b.is_error === true, at, ...(images ? { images } : {}), ...(clipped.truncated ? { truncated: true } : {}) };
      touch(conv, owner);
    }
    const rest = c.filter((b) => b && b.type !== "tool_result");
    if (!rest.length) return;
    const { text: t2, images: i2 } = contentText(rest);
    if (!t2.trim() && !i2) return;
    push(conv, { id: str(rec.uuid) || `u${conv.ord + 1}`, kind: "user", at, ...clipText(t2, TEXT_MAX), ...(i2 ? { images: i2 } : {}) });
    return;
  }
  const { text, images } = contentText(c);
  const id = str(rec.uuid) || `u${conv.ord + 1}`;
  if (rec.isCompactSummary) { push(conv, { id, kind: "summary", at, ...clipText(text, TEXT_MAX) }); return; }
  if (rec.isMeta) { push(conv, { id, kind: "meta", at, ...clipText(text, TEXT_MAX) }); return; }
  const env = ENVELOPE_RE.exec(text);
  if (env) {
    const args = ARGS_RE.exec(text);
    push(conv, { id, kind: "command", at, name: env[1].trim().slice(0, 200), args: args ? args[1].trim().slice(0, 2000) : "" });
    return;
  }
  // A notice is claude's own, and claude marks every one by its origin. A person's
  // prompt that looks like one (origin absent / human) stays a prompt.
  const origin = rec.origin?.kind;
  const key = noticeKey(text);
  if (origin === "task-notification" && key !== null) {
    // Like a typed prompt: the queue line drawn mid-turn was the placeholder, the
    // record (where claude took it in) is the copy shown.
    const q = waitTake(conv.noticeSeen, key);
    if (q?.item) { q.item.dup = true; touch(conv, q.item); }
    // `hides` names the queue line this record replaces, so a client still holding
    // a line the server has since evicted (no dup update will come) can hide it.
    push(conv, { ...noticeItem(id, at, key, "record"), ...(q ? { hides: [q.id] } : {}) });
    return;
  }
  // The queue line drawn as a notice was this person's prompt: the bubble is the copy shown.
  const misread = waitTake(conv.noticeSeen, text.trim());
  if (misread?.item) { misread.item.dup = true; touch(conv, misread.item); }
  const out = STDOUT_RE.exec(text);
  if (out) { push(conv, { id, kind: "output", at, ...clipText(out[1], TEXT_MAX) }); return; }
  if (!text.trim() && !images) return;
  // A prompt typed mid-turn was drawn as claude's queue line first; once it is a
  // bubble, the queue line is its second copy.
  // The same text queued twice pairs in order: the oldest line goes first.
  const q = waitTake(conv.queuedPrompt, text);
  if (q?.item) { q.item.dup = true; touch(conv, q.item); }
  const hides = [misread, q].filter(Boolean).map((h) => h.id);
  push(conv, { id, kind: "user", at, ...clipText(text, TEXT_MAX), ...(images ? { images } : {}), ...(hides.length ? { hides } : {}) });
}

function ingestAssistant(conv, rec) {
  if (seenBefore(conv, rec.uuid)) return;
  const m = rec.message;
  if (!m || typeof m !== "object") return;
  const at = safeAt(rec.timestamp);
  if (at) conv.lastAt = at;
  const msgId = str(m.id) || str(rec.uuid) || `a${conv.ord + 1}`;
  let item = conv.byMsgId.get(msgId);
  const fresh = !item;
  if (!item) {
    item = { id: `a:${msgId}`, kind: "assistant", at, msgId, blocks: [] };
    if (typeof m.model === "string") item.model = m.model.slice(0, 100);
  }
  const content = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (item.blocks.length >= BLOCKS_MAX) { item.blocksTruncated = true; break; }
    if (b.type === "thinking") item.blocks.push({ type: "thinking", ...clipText(str(b.thinking), TEXT_MAX) });
    else if (b.type === "text") item.blocks.push({ type: "text", ...clipText(str(b.text), TEXT_MAX) });
    else if (b.type === "tool_use" && typeof b.id === "string") {
      const ci = clipInput(b.input);
      const block = { type: "tool_use", id: b.id, name: str(b.name).slice(0, 100), input: ci.input, ...(ci.truncated ? { inputTruncated: true } : {}) };
      item.blocks.push(block);
      conv.toolUse.set(b.id, item);
    }
  }
  if (at) item.at = at; // the latest record's time: the message is still being written
  if (typeof m.stop_reason === "string") item.stopReason = m.stop_reason.slice(0, 40);
  if (rec.isApiErrorMessage === true) item.error = true;
  const u = m.usage;
  if (u && typeof u === "object") {
    const n = (v) => (Number.isFinite(v) ? v : 0);
    item.usage = { input: n(u.input_tokens), cacheCreate: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens), output: n(u.output_tokens) };
  }
  if (fresh) { conv.byMsgId.set(msgId, item); push(conv, item); } else touch(conv, item);
}

// Pure: one parsed record into the conversation.
export function ingestRecord(conv, rec) {
  if (!rec || typeof rec !== "object" || rec.isSidechain) return;
  const at = safeAt(rec.timestamp);
  if (at) conv.lastAt = at;
  switch (rec.type) {
    case "user": return ingestUser(conv, rec);
    case "assistant": return ingestAssistant(conv, rec);
    case "ai-title": if (typeof rec.aiTitle === "string") conv.title = rec.aiTitle.slice(0, 200); return;
    case "mode": if (typeof rec.mode === "string") conv.mode = rec.mode.slice(0, 40); return;
    case "permission-mode": if (typeof rec.permissionMode === "string") conv.permissionMode = rec.permissionMode.slice(0, 40); return;
    case "queue-operation": {
      if (seenBefore(conv, rec.uuid)) return;
      const op = str(rec.operation).slice(0, 40) || "unknown";
      const content = str(rec.content);
      if (NOTICE_SHAPE_RE.test(content)) {
        // Only the enqueue draws the notice; its dequeue adds nothing. A remove
        // took it mid-turn: no record follows, so it waits for nothing.
        if (op === "remove") waitTake(conv.noticeSeen, content.trim());
        if (op !== "enqueue") return;
        const it = noticeItem(str(rec.uuid) || `q${conv.ord + 1}`, at, content, "queue");
        push(conv, it);
        waitAdd(conv.noticeSeen, content.trim(), it);
        return;
      }
      // A prompt taken mid-turn (remove) never becomes a bubble: forget it, so a
      // later identical prompt does not hide this old line.
      if (op === "remove") waitTake(conv.queuedPrompt, content);
      const qi = { id: str(rec.uuid) || `q${conv.ord + 1}`, kind: "queue", at, op, ...clipText(str(rec.content), TEXT_MAX) };
      push(conv, qi);
      if (op === "enqueue" && content.trim()) {
        waitAdd(conv.queuedPrompt, content, qi);
      }
      return;
    }
    case "system": {
      if (seenBefore(conv, rec.uuid)) return;
      const id = str(rec.uuid) || `s${conv.ord + 1}`;
      const sub = str(rec.subtype);
      if (sub === "compact_boundary") {
        const md = rec.compactMetadata && typeof rec.compactMetadata === "object" ? rec.compactMetadata : {};
        push(conv, { id, kind: "compact", at, trigger: str(md.trigger).slice(0, 40) || null, preTokens: Number.isFinite(md.preTokens) ? md.preTokens : null, ...clipText(str(rec.content), TEXT_MAX) });
      } else if (sub === "turn_duration") {
        push(conv, { id, kind: "turn", at, durationMs: Number.isFinite(rec.durationMs) ? rec.durationMs : null });
      } else {
        push(conv, { id, kind: "system", at, subtype: sub.slice(0, 40) || null, level: str(rec.level).slice(0, 20) || null, ...clipText(str(rec.content), TEXT_MAX) });
      }
      return;
    }
    default: return; // last-prompt, attachment, file-history-snapshot, unknown
  }
}

export function ingestText(conv, text) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    ingestRecord(conv, rec);
  }
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

// A replaced or shrunken file starts the picture over, but the counters keep
// counting: a client holding `after=<old rev>` still gets every new item, and
// `generation` on the wire tells it the old items are gone (drop and re-page).
function reset(conv) {
  const fresh = createConversation({ maxItems: conv.maxItems });
  const { rev, ord, generation } = conv;
  for (const k of Object.keys(fresh)) conv[k] = fresh[k];
  conv.rev = rev; conv.ord = ord; conv.generation = generation + 1;
}

// Incremental read: ingest what the file holds past the cursor, up to
// chunkBytes, stopping at the last newline (a torn tail is claude mid-write).
// Returns true when the file could be read (ingested or nothing new), false
// when it is unreadable (conv.complete is false then). A shrunken or
// replaced file (inode) restarts the conversation from zero. A record longer
// than a chunk is read whole up to MAX_LINE, past that skipped and counted.
export function readConversation(file, conv, { chunkBytes = CHUNK_BYTES, maxLine = MAX_LINE } = {}) {
  let st;
  try { st = statSync(file); } catch { conv.complete = false; return false; }
  if (st.size < conv.offset || (conv.ino !== undefined && conv.ino !== st.ino)) reset(conv);
  conv.ino = st.ino;
  if (st.size === conv.offset) { conv.complete = true; return true; }
  const start = conv.offset;
  let end = Math.min(st.size, start + chunkBytes);
  let buf;
  try { buf = readRange(file, start, end); } catch { conv.complete = false; return false; }
  let cut = buf.lastIndexOf(10);
  if (cut >= 0) cut += 1;
  else if (end >= st.size) cut = 0; // torn tail: wait
  else if (conv.wideAt !== undefined && st.size <= conv.wideAt) cut = 0; // torn over-long tail seen at this size: wait for growth
  else {
    try {
      const wide = readRange(file, start, Math.min(st.size, start + maxLine));
      const nl = wide.indexOf(10, buf.length);
      if (nl >= 0) { buf = wide; cut = nl + 1; conv.wideAt = undefined; }
      else if (start + wide.length >= st.size) { cut = 0; conv.wideAt = st.size; }
      else {
        // Over maxLine: skip the WHOLE record — scan on to its newline so the
        // cursor never lands mid-record (the remainder would be dropped as a
        // malformed line and counted a second time).
        let pos = start + wide.length, nl = -1;
        while (nl < 0 && pos < st.size) {
          const part = readRange(file, pos, Math.min(st.size, pos + chunkBytes));
          if (!part.length) break;
          const i = part.indexOf(10);
          if (i >= 0) nl = pos + i; else pos += part.length;
        }
        if (nl < 0) { cut = 0; conv.wideAt = st.size; } // the over-long record is itself torn: wait for growth
        else { cut = nl + 1 - start; conv.skipped++; conv.wideAt = undefined; }
        buf = Buffer.alloc(0);
      }
    } catch { conv.complete = false; return false; }
  }
  if (cut > 0 && buf.length) ingestText(conv, buf.toString("utf-8", 0, cut));
  conv.offset = start + cut;
  conv.complete = conv.offset >= st.size;
  return true;
}

// Wire form. Three ways in:
//   (none)        the last `limit` items (the tail of the conversation)
//   before=<ord>  the `limit` items before that position (scrolling up)
//   after=<rev>   every item whose rev is above it, lowest rev first (reconnect /
//                 poll) — `more` when the page could not hold them all, and
//                 `nextAfter` is the cursor for the rest
export function conversationWire(conv, { conversationId = null, after, before, limit } = {}) {
  const n = Math.min(PAGE_MAX, Math.max(1, Number.isInteger(limit) && limit > 0 ? limit : PAGE_DEFAULT));
  let items, more = false;
  const all = conv.items;
  let nextAfter = conv.rev;
  if (Number.isInteger(after)) {
    // Revs are not monotonic in ord (a tool result bumps an old item), so the
    // page is the rev-ORDER prefix: `nextAfter` (the page's highest rev) is a
    // cursor that misses nothing when `more` is set. The client places items
    // by ord.
    items = [];
    for (const it of all) if (it.rev > after) items.push(it);
    items.sort((a, b) => a.rev - b.rev);
    if (items.length > n) { items = items.slice(0, n); more = true; nextAfter = items[items.length - 1].rev; }
  } else if (Number.isInteger(before)) {
    let end = all.length;
    while (end > 0 && all[end - 1].ord >= before) end--;
    items = all.slice(Math.max(0, end - n), end);
    more = end - n > 0;
  } else {
    items = all.slice(Math.max(0, all.length - n));
    more = all.length > n;
  }
  const first = all.length ? all[0].ord : null;
  return {
    conversationId, title: conv.title, mode: conv.mode, permissionMode: conv.permissionMode,
    rev: conv.rev, nextAfter, generation: conv.generation, count: all.length, firstOrd: first, lastAt: conv.lastAt,
    complete: conv.complete, truncated: conv.truncated, evicted: conv.evicted,
    // A floor, not the whole truth, when these are non-zero: records over
    // MAX_LINE were skipped; tool results found no tool_use (evicted, or an
    // oversize record held it) — the client draws the block as "no result".
    skipped: conv.skipped, orphanResults: conv.orphanResults,
    items, more,
  };
}

// ── Drafts ─────────────────────────────────────────────────────────────────
// { conversationId, text, attachments: [{id, pos}], revision, deviceId, updatedAt }
// on the agent record; a PATCH names the revision it saw (0 for none) and is
// refused 409 with the stored draft when the server has moved on — two devices
// never silently overwrite each other (design: keep both, let the person pick).
export const DRAFT_TEXT_MAX = 256 * 1024;
export const DRAFT_ATTACHMENTS_MAX = 20;
const DRAFT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/; // newline, tab, CR allowed

export function validateDraftPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be an object" };
  const { text, attachments = [], deviceId, revision, conversationId = null } = body;
  if (typeof text !== "string") return { error: "text (string) required" };
  if (text.length > DRAFT_TEXT_MAX) return { error: `text over ${DRAFT_TEXT_MAX} chars` };
  if (CONTROL_RE.test(text)) return { error: "text has control characters" };
  if (typeof deviceId !== "string" || !DRAFT_ID_RE.test(deviceId)) return { error: "deviceId (1-128 chars of letters, digits, . _ : -) required" };
  if (!Number.isInteger(revision) || revision < 0) return { error: "revision (non-negative integer) required" };
  if (conversationId !== null && (typeof conversationId !== "string" || !DRAFT_ID_RE.test(conversationId))) return { error: "conversationId must be a string id or null" };
  if (!Array.isArray(attachments) || attachments.length > DRAFT_ATTACHMENTS_MAX) return { error: `attachments must be an array of at most ${DRAFT_ATTACHMENTS_MAX}` };
  const atts = [];
  for (const a of attachments) {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !DRAFT_ID_RE.test(a.id) || !Number.isInteger(a.pos) || a.pos < 0 || a.pos > text.length) return { error: "attachments[]: {id, pos} with pos inside the text" };
    atts.push({ id: a.id, pos: a.pos });
  }
  return { draft: { conversationId, text, attachments: atts, deviceId, revision } };
}

// The stored shape, re-validated on the way out so a hand-edited record never
// puts garbage on the wire. null when absent or unusable.
export function safeDraft(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const v = validateDraftPatch({ text: d.text, attachments: d.attachments, deviceId: d.deviceId, revision: d.revision, conversationId: d.conversationId ?? null });
  if (v.error || v.draft.revision < 1) return null;
  return { ...v.draft, updatedAt: safeAt(d.updatedAt) };
}

export const draftEmpty = (d) => !d.text.length && !d.attachments.length;
