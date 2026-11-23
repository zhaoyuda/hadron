// Handoff between backends (C3): "Continue in Cursor" when claude is out of
// budget, "Continue in Claude" on the way back. Everything in the handoff is
// assembled mechanically from what Hadron already holds — the agent's task and
// checkpoint, the last exchanges of its conversation, git's picture of its cwd
// and any messages still queued for it — so a claude at its usage limit spends
// nothing on it. Pure functions here; the route lives in index.js.
import { readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const EXCHANGES = 6;            // last user→assistant exchanges carried over
export const EXCHANGE_TEXT_MAX = 1500; // chars per prompt / reply
export const HANDOFF_TEXT_MAX = 24000; // the whole prompt pasted into the new agent
const CURSOR_TAIL_BYTES = 2 * 1024 * 1024;

const clip = (s, max) => {
  const t = String(s ?? "").replace(/\r/g, "").trim();
  return t.length > max ? `${t.slice(0, max)}\n[… ${t.length - max} more chars]` : t;
};
// The outbox refuses control characters; a transcript may carry any.
export const stripControl = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

// Hadron's conversation model (server/conversation.js items) → the last
// exchanges: a user prompt and the assistant text after it. Tool traffic and
// thinking are left out — the files on disk carry the work itself.
export function exchangesFromItems(items, n = EXCHANGES) {
  const out = [];
  let cur = null;
  for (const it of items || []) {
    if (it.kind === "user" && typeof it.text === "string" && it.text.trim()) {
      cur = { user: it.text, reply: [] };
      out.push(cur);
    } else if (it.kind === "assistant" && cur) {
      for (const b of it.blocks || []) if (b.type === "text" && b.text?.trim()) cur.reply.push(b.text);
    }
  }
  return out.slice(-n).map((x) => ({ user: x.user, reply: x.reply.join("\n\n") }));
}

// cursor-agent's transcripts for a cwd: ~/.cursor/projects/<slug>/agent-transcripts/<chat>/<chat>.jsonl,
// slug = the absolute path with every / . _ turned into - and the leading one dropped.
export const cursorProjectSlug = (cwd) => String(cwd).replace(/[/._]/g, "-").replace(/^-+/, "");

// The newest cursor chat in this cwd written at or after `sinceMs` (the cursor
// agent's own lifetime — an older chat in the same folder is someone else's).
export function newestCursorTranscript(cwd, sinceMs, home = homedir()) {
  const dir = join(home, ".cursor", "projects", cursorProjectSlug(cwd), "agent-transcripts");
  let best = null;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!/^[0-9a-zA-Z-]{1,80}$/.test(name)) continue;
    const file = join(dir, name, `${name}.jsonl`);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < sinceMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
  }
  return best && best.file;
}

// A cursor transcript's tail → exchanges ({role:user|assistant, message.content[text…]}).
// The user text is "<timestamp>…</timestamp>\n<user_query>…</user_query>".
export function exchangesFromCursorTranscript(file, n = EXCHANGES) {
  let text;
  try {
    const fd = openSync(file, "r");
    try {
      const size = statSync(file).size;
      const len = Math.min(size, CURSOR_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf-8");
      if (len < size) text = text.slice(text.indexOf("\n") + 1); // first line is torn
    } finally { closeSync(fd); }
  } catch { return []; }
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const parts = Array.isArray(rec?.message?.content) ? rec.message.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
    if (rec.role === "user" && parts.length) {
      const raw = parts.join("\n");
      const q = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
      cur = { user: q ? q[1] : raw.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/, ""), reply: [] };
      out.push(cur);
    } else if (rec.role === "assistant" && cur && parts.length) cur.reply.push(parts.join("\n"));
  }
  return out.slice(-n).map((x) => ({ user: x.user, reply: x.reply.join("\n\n") }));
}

const BACKEND_NAME = { claude: "Claude Code", cursor: "Cursor (cursor-agent)" };

/**
 * The handoff prompt. `from`/`to` are "claude" | "cursor"; `source` is the
 * agent record handing off; `changes` is gitChanges()'s result (or null);
 * `queued` the texts of messages that were waiting in its outbox.
 */
export function handoffText({ source, from, to, reason, exchanges = [], changes = null, queued = [], file = null, at = new Date().toISOString() }) {
  const L = [];
  L.push(`# Handoff from ${BACKEND_NAME[from] || from} — agent "${source.name}"`);
  L.push("");
  L.push(`You are continuing work another coding agent (${BACKEND_NAME[from] || from}) was doing in this same folder${reason ? ` — it stopped: ${reason}` : ""}. Hadron wrote this handoff mechanically at ${at}; nothing below was summarised by the previous agent.`);
  if (file) L.push(`A copy of this handoff is saved at ${file}.`);
  L.push("");
  L.push(`- Working folder: ${source.cwd || "(workspace root)"}`);
  if (source.task) L.push(`- Task: ${clip(source.task, 2000)}`);
  const cp = source.checkpoint;
  if (cp && (cp.goal || cp.next || cp.blocked || cp.outputs?.length)) {
    L.push("");
    L.push("## Checkpoint (written by the previous agent)");
    if (cp.goal) L.push(`- Goal: ${cp.goal}`);
    if (cp.next) L.push(`- Next: ${cp.next}`);
    if (cp.blocked) L.push(`- Blocked: ${cp.blocked}`);
    if (cp.outputs?.length) L.push(`- Outputs: ${cp.outputs.join(", ")}`);
  }
  if (changes?.root) {
    L.push("");
    L.push(`## Uncommitted changes (git, branch ${changes.branch || "?"})`);
    if (!changes.files?.length) L.push("- none — the working tree is clean");
    for (const f of (changes.files || []).slice(0, 60)) {
      const n = f.add != null ? ` +${f.add} −${f.del ?? 0}` : "";
      L.push(`- ${f.status} ${f.path}${f.from ? ` (from ${f.from})` : ""}${n}`);
    }
    if (changes.total > 60) L.push(`- … and ${changes.total - 60} more (git status shows them all)`);
  }
  if (exchanges.length) {
    L.push("");
    L.push(`## The last ${exchanges.length} exchange${exchanges.length > 1 ? "s" : ""} of the previous conversation`);
    for (const x of exchanges) {
      L.push("");
      L.push("**User:**");
      L.push(clip(x.user, EXCHANGE_TEXT_MAX));
      L.push("");
      L.push(`**${from === "cursor" ? "Cursor" : "Claude"}:**`);
      L.push(x.reply ? clip(x.reply, EXCHANGE_TEXT_MAX) : "(no text reply — it was working with tools)");
    }
  }
  if (queued.length) {
    L.push("");
    L.push("## Messages the user had queued for the previous agent (not yet delivered)");
    for (const q of queued) { L.push(""); L.push(clip(q, EXCHANGE_TEXT_MAX)); }
  }
  L.push("");
  L.push("## What to do");
  L.push(`Look at the files and the changes above to see where the work stands, tell the user in a few lines what you found and what you will do next, then continue${queued.length ? " — starting with the queued messages" : ""}.`);
  let out = stripControl(L.join("\n"));
  if (out.length > HANDOFF_TEXT_MAX) out = `${out.slice(0, HANDOFF_TEXT_MAX)}\n[… handoff clipped${file ? ` — the whole text is in ${file}` : ""}]`;
  return out;
}

// The peer's id: <id>-cursor for a claude agent handing off; the way back
// goes to the agent recorded on the handoff link.
export function peerIdFor(id, to) {
  const base = id.replace(/-cursor$/, "");
  return to === "cursor" ? `${base}-cursor` : base === id ? `${id}-claude` : base;
}
