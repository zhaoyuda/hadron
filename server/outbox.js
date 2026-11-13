// The composer's outbox (chat view, block G3): what the operator asked Hadron to
// deliver to an agent's pane and how far it got. One list per agent on the
// record (`outbox`, absent when empty), so a phone and a laptop see the same
// picture and a server restart loses nothing.
//
//   { id, text, at, state, deviceId?, handedAt?, error? }
//   state: queued     waiting for the agent's dialog to go away (it was blocked
//                     when the message arrived — a paste then would land in the
//                     permission dialog). A WORKING pane is pasted at once:
//                     claude queues input typed during a turn and reads it with
//                     its next step (prod 2026-11-08: a turn of continuous tool
//                     calls never showed the prompt, two messages waited an hour)
//          sending    the paste is in flight right now
//          handed     pasted + Enter pressed; the conversation will show it as
//                     a user turn once claude records it (the client matches the
//                     text and removes the entry — or the HANDED_TTL prunes it)
//          failed     refused: the pane was a shell, tmux did not answer — the
//                     entry stays with its reason until dismissed
//          uncertain  the server went down while it was `sending`: the paste
//                     may or may not have landed. Never resent on its own.
//
// `id` is the client's request id — a retried POST with the same id is answered
// with the entry it already made, never a second paste.

export const OUTBOX_MAX = 20;
export const OUTBOX_TEXT_MAX = 256 * 1024;
export const HANDED_TTL_MS = Math.max(1000, parseInt(process.env.HADRON_OUTBOX_HANDED_TTL_MS || "", 10) || 15 * 60 * 1000);
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const STATES = new Set(["queued", "sending", "handed", "failed", "uncertain"]);
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const WIRE_TEXT = 500; // the list form clips the text; GET /outbox carries it whole

export function validateEntry({ text, requestId, deviceId, idleOnly = false }) {
  if (typeof text !== "string" || text.length === 0) return { error: "text (non-empty string) required" };
  if (text.length > OUTBOX_TEXT_MAX) return { error: `text over ${OUTBOX_TEXT_MAX} chars` };
  if (CONTROL_RE.test(text)) return { error: "text has control characters" };
  if (typeof requestId !== "string" || !ID_RE.test(requestId)) return { error: "requestId (1-128 chars of letters, digits, . _ : -) required" };
  if (deviceId !== undefined && (typeof deviceId !== "string" || !ID_RE.test(deviceId))) return { error: "deviceId must be 1-128 chars of letters, digits, . _ : -" };
  if (typeof idleOnly !== "boolean") return { error: "idleOnly must be a boolean" };
  return { entry: { id: requestId, text, at: new Date().toISOString(), state: "queued", ...(deviceId ? { deviceId } : {}), ...(idleOnly ? { idleOnly: true } : {}) } };
}

// Dispatch holds a queued entry that was written for another conversation
// (/clear, a resume of another session since): it is served `stale` and the
// composer offers it back instead of pasting it into the new conversation.
export function entryStale(e, currentConversationId) {
  return Boolean(e.conversationId && currentConversationId && e.conversationId !== currentConversationId);
}

// The stored list, re-validated on the way in from disk: a hand-edited record
// never puts garbage on the wire, and a `sending` entry found at boot is the
// restart case — the paste may have landed, so it becomes `uncertain`.
export function safeOutbox(list, { boot = false } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !ID_RE.test(e.id) || typeof e.text !== "string" || !e.text.length || e.text.length > OUTBOX_TEXT_MAX || CONTROL_RE.test(e.text)) continue;
    if (!STATES.has(e.state)) continue;
    if (out.some((x) => x.id === e.id)) continue;
    const clean = { id: e.id, text: e.text, at: safeAt(e.at) || new Date().toISOString(), state: e.state };
    if (typeof e.deviceId === "string" && ID_RE.test(e.deviceId)) clean.deviceId = e.deviceId;
    if (typeof e.conversationId === "string" && /^[a-f0-9]{8,64}$/.test(e.conversationId)) clean.conversationId = e.conversationId;
    if (e.idleOnly === true) clean.idleOnly = true;
    if (e.state === "handed") {
      clean.handedAt = safeAt(e.handedAt) || clean.at; // never a handed entry that cannot age out
      if (e.handedWhile === "working" || e.handedWhile === "prompt") clean.handedWhile = e.handedWhile;
    }
    if ((e.state === "failed" || e.state === "uncertain") && typeof e.error === "string") clean.error = e.error.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
    if (boot && clean.state === "sending") { clean.state = "uncertain"; clean.error = "the server restarted while this was being delivered — it may or may not have reached claude"; }
    out.push(clean);
    if (out.length >= OUTBOX_MAX) break;
  }
  return out;
}

function safeAt(v) {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Handed entries older than the TTL are forgotten: the conversation shows the
// turn by then, or claude never recorded it and the operator has long looked.
// Failed/uncertain ones wait for the operator (Retry / Discard) for a day.
export const SETTLED_TTL_MS = 24 * 3600 * 1000;
export function pruneOutbox(list, now = Date.now()) {
  return list.filter((e) => {
    if (e.state === "handed") return !(e.handedAt && now - Date.parse(e.handedAt) > HANDED_TTL_MS);
    if (e.state === "failed" || e.state === "uncertain") return !(e.at && now - Date.parse(e.at) > SETTLED_TTL_MS);
    return true;
  });
}
// Room for one more: when the list is at the cap, the oldest failed/uncertain
// entry gives way (it only waited for a dismissal); nothing live is evicted.
export function makeRoom(list) {
  if (list.length < OUTBOX_MAX) return true;
  const i = list.findIndex((e) => e.state === "failed" || e.state === "uncertain");
  if (i === -1) return false;
  list.splice(i, 1);
  return true;
}

// Per-agent serialisation: every paste into a pane (immediate, queued, legacy
// `hadron message`) runs after the one before it — two deliveries can no longer
// interleave their paste and Enter.
const chains = new Map();
export function withPaneLock(agentId, fn) {
  const prev = chains.get(agentId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(agentId, next);
  next.finally(() => { if (chains.get(agentId) === next) chains.delete(agentId); }).catch(() => {});
  return next;
}

// What goes on the token-bearing sessions list: every entry, text clipped.
export function outboxWire(list) {
  return list.map((e) => ({ ...e, text: e.text.length > WIRE_TEXT ? e.text.slice(0, WIRE_TEXT) : e.text, chars: e.text.length, ...(e.text.length > WIRE_TEXT ? { truncated: true } : {}) }));
}

// Can a paste reach claude's input line? At the prompt it becomes the next
// turn; while working claude queues it for its next step; only a dialog
// (blocked) would swallow it. Unknown/unset states count as the prompt: only a
// pane KNOWN to show a dialog waits.
export const atPrompt = (state) => state !== "blocked";
// …but only once the detector has looked at the pane since boot: `state` is
// not persisted (every agent loads as idle), so for the first seconds after a
// restart "idle" means nothing. A 5-s manual PATCH of the state (the override
// window) is the operator's word over the detector's, deliberately.
export const dispatchable = (s, verdictSeen) => Boolean(verdictSeen) && atPrompt(s.state);

// An `idleOnly` entry (the composer bar's `/model` / `/effort` — when:"idle")
// is a slash command: pasted mid-turn claude would queue it as the next PROMPT
// text, so it waits for the prompt proper — idle or done, never working.
// Ordinary entries keep the mid-turn paste. The head of the list waits with it
// (order is kept: a message typed after a model pick goes after the switch).
export const IDLE_STATES = new Set(["idle", "done"]);
// A block that is claude refusing a turn at its own empty prompt — no dialog,
// nothing retrying — takes a switch too: "Model unavailable" is exactly when
// the operator picks another model, and a different model can be under its
// own usage limit. (The pane is still read under the lock: an empty ❯ box and
// no retry banner, deliverOutboxEntry.)
export const SWITCH_BLOCKS = new Set(["Model unavailable", "Usage limit", "Context full", "Login needed"]);
export const switchable = (s) => IDLE_STATES.has(s.state) || (s.state === "blocked" && SWITCH_BLOCKS.has(s.blockReason) && !s.dialog);
// Order: an entry waits for every queued entry ahead of it — except a switch
// during one of those blocks: the ordinary messages ahead of it are waiting
// on the block itself, which the switch is the way out of (and a message
// typed before the switch is best read by the new model). Switches keep their
// order among themselves.
export const switchBlock = (s) => s.state === "blocked" && switchable(s);
export const heldBehind = (s, entry, earlier, isStale) => earlier.some((o) => o.state === "queued" && !isStale(o) && !(entry?.idleOnly && !o.idleOnly && switchBlock(s)));
export const entryReady = (s, verdictSeen, e) => (e?.idleOnly ? Boolean(verdictSeen) && switchable(s) : dispatchable(s, verdictSeen));
// A paste handed this recently may have started a turn the detector has not
// read yet: an idleOnly entry waits it out.
export const IDLE_SETTLE_MS = 3000;
export const recentlyHanded = (list, now = Date.now()) => (Array.isArray(list) ? list : []).some((e) => e.state === "handed" && e.handedAt && now - Date.parse(e.handedAt) < IDLE_SETTLE_MS);
