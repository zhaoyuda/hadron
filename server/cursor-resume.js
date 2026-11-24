// Cursor backend — conversation identity and the checkpoint auto-resume reads.
//
// cursor-agent keeps every chat under ~/.cursor/chats/<md5(absolute cwd)>/<chatId>/
// (meta.json {createdAtMs, updatedAtMs, hasConversation, cwd, title?}, store.db).
// `cursor-agent --resume <uuid>` opens that chat, and for a uuid it has never
// seen it creates the chat under that id (2026.11.22, probed) — so Hadron picks
// the id at launch, exactly like claude's --session-id: identity "authoritative".
//
// Inside the app /clear, /fork and /resume move to another chat; nothing names
// the pane's current chat (no pid registry, store.db is not held open). In a
// cwd no other agent works in, a chat in that folder that got a turn after
// this agent's cursor-agent came up and after the known chat's last turn — and
// while this agent's pane was working — is this agent's: taken at "correlated".
// An idle agent never moves (a cursor-agent run by hand in a plain terminal
// writes chats there too). In a shared cwd the known id stands.
import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { UUID_RE, PINNED_CONFIDENCE } from "./resume.js";
import { CURSOR_CMD_RE } from "./cursor-state.js";
import { warnOnce } from "./log.js";

const SETTLE_POLLS = 3;
export const CHAT_POLL_MS = 30 * 1000;
export const CHAT_POLL_NO_ID_MS = 5 * 1000;
const CHAT_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export const cursorChatsDir = (cwd, home = homedir()) => join(home, ".cursor", "chats", createHash("md5").update(String(cwd)).digest("hex"));

// One chat's meta.json → {hasConversation, updatedAtMs} | null (missing / unreadable / not this cwd).
export function cursorChatMeta(cwd, chatId, home = homedir()) {
  if (!cwd || !CHAT_ID_RE.test(String(chatId))) return null;
  try {
    const m = JSON.parse(readFileSync(join(cursorChatsDir(cwd, home), chatId, "meta.json"), "utf-8"));
    if (!m || typeof m !== "object" || (m.cwd != null && m.cwd !== cwd)) return null;
    return { hasConversation: m.hasConversation === true, updatedAtMs: Number.isFinite(m.updatedAtMs) ? m.updatedAtMs : 0 };
  } catch { return null; }
}
export const cursorChatExists = (cwd, chatId, home = homedir()) => cursorChatMeta(cwd, chatId, home) !== null;

// The chat in this cwd with the latest turn at or after sinceMs (hasConversation only).
export function newestCursorChat(cwd, sinceMs = 0, home = homedir()) {
  if (!cwd) return null;
  let names;
  try { names = readdirSync(cursorChatsDir(cwd, home)); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!CHAT_ID_RE.test(name)) continue;
    const m = cursorChatMeta(cwd, name, home);
    if (!m || !m.hasConversation || m.updatedAtMs < sinceMs) continue;
    if (!best || m.updatedAtMs > best.updatedAtMs) best = { chatId: name, updatedAtMs: m.updatedAtMs };
  }
  return best;
}

// The transcript cursor-agent writes for a chat (handoff.js reads it).
export const cursorTranscriptFor = (cwd, chatId, slug, home = homedir()) => {
  if (!CHAT_ID_RE.test(String(chatId))) return null;
  const f = join(home, ".cursor", "projects", slug, "agent-transcripts", chatId, `${chatId}.jsonl`);
  try { return statSync(f).isFile() ? f : null; } catch { return null; }
};

// Is cursor-agent the pane's process? The pane command on Linux; elsewhere the
// detector's process-tree answer from the previous tick (session.cursorProc).
export function cursorIsUp(cmd, session) {
  const c = String(cmd || "").trim();
  if (CURSOR_CMD_RE.test(c)) return true;
  return !!c && session.cursorProc === true;
}

export class CursorRuntimeTracker {
  // save(session, urgent); cwdShared(): another cursor agent works in this cwd;
  // chatMeta / newestChat injectable for tests; now() for the clock.
  constructor(session, { save, cwdShared, chatMeta = cursorChatMeta, newestChat = newestCursorChat, now = Date.now }) {
    this.session = session;
    this.save = save;
    this.cwdShared = cwdShared || (() => false);
    this.chatMeta = chatMeta;
    this.newestChat = newestChat;
    this.now = now;
    this.polls = 0;
    this.upSince = 0;
    this.lastChatAt = 0;
    this.downPolls = 0;
    this.worked = false;   // the pane read "working" since the last chat check
  }

  observe(cmd) {
    const rt = this.session.runtime || (this.session.runtime = {});
    if (!cursorIsUp(cmd, this.session)) {
      // cursor-agent → shell for SETTLE_POLLS polls in a row while the server is
      // alive = a deliberate exit (one tick of a tool's shell in the foreground is not).
      if (this.polls >= SETTLE_POLLS && ++this.downPolls >= SETTLE_POLLS) {
        rt.observedRuntime = "shell";
        rt.desiredRuntime = "shell";
        rt.cleanExitAt = new Date(this.now()).toISOString();
        this.save(this.session, true);
        this.polls = 0;
      } else if (this.polls < SETTLE_POLLS) this.polls = 0;
      return;
    }
    this.downPolls = 0;
    if (this.session.state === "working") this.worked = true;
    this.polls++;
    if (this.polls === 1) this.upSince = this.now();
    if (this.polls < SETTLE_POLLS) return;
    let urgent = false;
    if (this.polls === SETTLE_POLLS) {
      if (rt.desiredRuntime !== "cursor" || rt.cleanExitAt) {
        rt.desiredRuntime = "cursor";
        rt.cleanExitAt = null;
        delete rt.restoreAttempt;
      }
      urgent = true;
    }
    rt.observedRuntime = "cursor";
    rt.lastObservedAt = new Date(this.now()).toISOString();
    const now = this.now();
    if (now - this.lastChatAt > (rt.sessionId ? CHAT_POLL_MS : CHAT_POLL_NO_ID_MS) && this.session.cwd) {
      this.lastChatAt = now;
      if (this.checkChat(rt)) urgent = true;
    }
    this.save(this.session, urgent);
  }

  // Returns true when the checkpoint changed.
  checkChat(rt) {
    const cwd = this.session.cwd;
    const known = UUID_RE.test(String(rt.sessionId || "")) ? this.chatMeta(cwd, rt.sessionId) : null;
    let changed = false;
    if (known && known.hasConversation && !rt.transcriptSeen) { rt.transcriptSeen = true; changed = true; }
    if (this.cwdShared()) {
      if (!rt.sessionId) warnOnce(`cursor-sharedcwd:${this.session.id}`, `[resume] cursor agent ${this.session.id}: another cursor agent works in ${JSON.stringify(cwd)} — its chat cannot be told apart there; auto-resume is off for it until it is launched by Hadron`);
      return changed;
    }
    // A chat in this folder with a turn after cursor-agent came up and after the
    // known chat's last turn: the operator moved to it (/clear, /resume, /fork),
    // or cursor-agent was launched by hand without an id.
    const worked = this.worked;
    this.worked = false;
    const since = Math.max(this.upSince - 5000, known ? known.updatedAtMs + 1 : 0);
    const hit = worked ? this.newestChat(cwd, since) : null;
    if (hit && hit.chatId !== rt.sessionId && UUID_RE.test(hit.chatId)) {
      rt.sessionId = hit.chatId;
      rt.confidence = "correlated";
      rt.transcriptSeen = true;
      console.log(`[resume] cursor agent ${this.session.id}: now in another chat of its folder (the newest one with a turn) — checkpoint follows it`);
      return true;
    }
    // A chat that had a turn and is gone (deleted) is no checkpoint; a pinned
    // id that never had one is a fresh chat cursor-agent has not written yet.
    if (rt.sessionId && !known && rt.transcriptSeen && !PINNED_CONFIDENCE.has(rt.confidence)) {
      warnOnce(`cursor-stalechat:${this.session.id}`, `[resume] cursor agent ${this.session.id}: its chat is gone from ${cursorChatsDir(cwd)} — checkpoint dropped`);
      rt.sessionId = null;
      delete rt.confidence;
      delete rt.transcriptSeen;
      return true;
    }
    return changed;
  }

  // Hadron launched cursor-agent with --resume <uuid> of its own choosing.
  recordSpawnedSession(chatId) {
    const rt = this.session.runtime || (this.session.runtime = {});
    rt.sessionId = chatId;
    rt.confidence = "authoritative";
    rt.desiredRuntime = "cursor";
    rt.cleanExitAt = null;
    delete rt.transcriptSeen;
    // The launch IS the answer; the next check comes at the short cadence (the
    // chat's first turn — transcriptSeen — lands within seconds of it).
    this.lastChatAt = this.now() - CHAT_POLL_MS + CHAT_POLL_NO_ID_MS;
    this.save(this.session, true);
  }
}
