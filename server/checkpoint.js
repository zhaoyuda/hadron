// server/checkpoint.js — two things an agent's own process tells Hadron about
// itself, both pure (injectable, no I/O of their own):
//
// 1. The HANDOFF checkpoint: what an agent writes at a task boundary through
//    `hadron checkpoint --goal … --next … [--blocked …] [--output p …]` so the
//    card, `hadron whoami` and a post-reboot resume all start from the agent's
//    own words instead of a transcript scrape. Free text is bounded and
//    control-character-free; outputs are workspace-relative or absolute paths
//    checked exactly like coreDismissed (strings, no NUL/newline). Stored as
//    `session.checkpoint = { goal, next, blocked, outputs, at }` — absent when
//    empty; the resume checkpoint lives in `session.runtime` and is untouched.
//
// 2. The SessionStart HOOK claim: claude's own SessionStart hook runs
//    `hadron checkpoint --hook`, which posts claude's session_id together with
//    the pane it ran in and its own pid. verifyHookClaim proves the claim is
//    about THIS agent's pane — the pane is the agent's conversation pane (the
//    main tmux session's active pane, the same one the registry match uses)
//    AND the hook process descends from that pane's process through exactly
//    one live claude — so a claude in a shell tab, a nested claude (launched
//    by the conversation's own Bash tool), a split, or a forged POST cannot
//    rename the agent's conversation. The route also binds the id to the
//    transcript path claude itself reported (…/<project of the agent's cwd>/
//    <sessionId>.jsonl), so a token holder under the pane cannot pin an
//    arbitrary UUID. The freshness rule (a late SessionStart after /clear must
//    not overwrite a newer id) is enforced by the route: the claim's `at` must
//    not precede the last accepted claim's (and may not be in the future — a
//    far-future value would refuse every later claim), and claude's session
//    registry — the same pid's own record — wins when it names a different id.
//    rt.hookAt is persisted only with an accepted change, so the watermark
//    starts over after a server restart (harmless: the registry guard covers
//    the same race).

export const CHECKPOINT_TEXT_MAX = 500;
export const CHECKPOINT_OUTPUTS_MAX = 20;
export const CHECKPOINT_FIELDS = ["goal", "next", "blocked"];
export const HOOK_ANCESTRY_DEPTH = 8; // hook → sh → claude → (wrapper) → pane shell; generous, bounded

const CONTROL_RE = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function cleanText(v, field) {
  if (v === undefined || v === null) return { value: null };
  if (typeof v !== "string") return { error: `${field} must be a string` };
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (t.length > CHECKPOINT_TEXT_MAX) return { error: `${field} must be at most ${CHECKPOINT_TEXT_MAX} characters` };
  if (CONTROL_RE.test(t)) return { error: `${field} must not contain control characters` };
  return { value: t || null };
}

// body → { checkpoint } (null when every field is empty = clear) or { error }.
// `at` is the server's clock (a client cannot backdate a handoff).
export function validateCheckpoint(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be an object" };
  const out = {};
  for (const f of CHECKPOINT_FIELDS) {
    const r = cleanText(body[f], f);
    if (r.error) return r;
    if (r.value) out[f] = r.value;
  }
  const outputs = body.outputs;
  if (outputs !== undefined && outputs !== null) {
    if (!Array.isArray(outputs) || outputs.length > CHECKPOINT_OUTPUTS_MAX) return { error: `outputs must be an array of at most ${CHECKPOINT_OUTPUTS_MAX} paths` };
    const list = [];
    for (const p of outputs) {
      if (typeof p !== "string" || !p.trim() || p.length > 4096 || /[\0\n\r]/.test(p)) return { error: "outputs entries must be non-empty path strings" };
      const t = p.trim();
      if (!list.includes(t)) list.push(t);
    }
    if (list.length) out.outputs = list;
  }
  if (!Object.keys(out).length) return { checkpoint: null };
  out.at = new Date(now).toISOString();
  return { checkpoint: out };
}

// Wire form: only the known fields, typed — a corrupt on-disk value cannot
// leak an arbitrary shape (or a token) through the open GET.
export function safeCheckpoint(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  for (const f of CHECKPOINT_FIELDS) if (typeof c[f] === "string" && c[f] && c[f].length <= CHECKPOINT_TEXT_MAX && !CONTROL_RE.test(c[f])) out[f] = c[f];
  if (Array.isArray(c.outputs)) {
    const o = c.outputs.filter((p) => typeof p === "string" && p && p.length <= 4096 && !/[\0\n\r]/.test(p)).slice(0, CHECKPOINT_OUTPUTS_MAX);
    if (o.length) out.outputs = o;
  }
  if (typeof c.at === "string" && Number.isFinite(Date.parse(c.at))) out.at = c.at;
  return Object.keys(out).length ? out : null;
}

// Exact pane + process attribution of a SessionStart hook claim.
//   panes:    [{ paneId: "%12", panePid: 4321 }, …] — the agent's MAIN tmux
//             session's panes (never its -shN / -vim sub-sessions)
//   pane:     the claim's TMUX_PANE ("%12")
//   hookPid:  the pid of the `hadron checkpoint --hook` process
//   identity: pid → { alive, claude, start } (session-registry.processIdentity)
//   parent:   pid → ppid | null           (session-registry.parentPid)
// Walks up from hookPid at most `depth` steps: it must reach panePid, and
// exactly ONE live claude may sit on the path (the pane process itself
// counts). Zero means someone ran the CLI by hand under the pane; two or more
// means the hook came from a NESTED claude (`claude -p …` launched by the
// conversation's own Bash tool inherits TMUX_PANE and the hooks) — its
// session id is a throwaway, not this pane's conversation, so it is refused
// rather than resolved to the outermost. Returns
// { ok: true, claudePid, claudeStart } or { ok: false, reason }.
export function verifyHookClaim({ panes, pane, hookPid, identity, parent, depth = HOOK_ANCESTRY_DEPTH }) {
  if (typeof pane !== "string" || !/^%\d+$/.test(pane)) return { ok: false, reason: "pane must be a tmux pane id (%N)" };
  if (!Number.isInteger(hookPid) || hookPid <= 0) return { ok: false, reason: "pid must be a positive integer" };
  const p = (panes || []).find((x) => x.paneId === pane);
  if (!p) return { ok: false, reason: "pane is not a pane of this agent's tmux session" };
  if (!Number.isInteger(p.panePid) || p.panePid <= 0) return { ok: false, reason: "pane process unknown" };
  const claudes = [];
  let cur = hookPid;
  for (let i = 0; i <= depth; i++) {
    if (cur !== hookPid) {
      const id = identity(cur);
      if (id.alive && id.claude) claudes.push({ claudePid: cur, claudeStart: id.start });
    }
    if (cur === p.panePid) {
      if (claudes.length === 0) return { ok: false, reason: "no live claude between the hook and the pane's process" };
      if (claudes.length > 1) return { ok: false, reason: "a nested claude (launched by the conversation itself), not this pane's conversation" };
      return { ok: true, ...claudes[0] };
    }
    const pp = parent(cur);
    if (!pp || pp === cur) break;
    cur = pp;
  }
  return { ok: false, reason: "the hook process does not descend from this agent's pane" };
}

// The route's decision, pure: apply a verified claim to the agent's runtime
// checkpoint. `claim` = { sessionId, at, claudePid }; `registry` = the
// findRegistrySession result for THIS pane (claude's own record for the same
// process) or null. Rules, in order:
//   1. freshness — a claim older than the last accepted one is refused (a
//      SessionStart delivered late, after /clear already reported the newer id)
//   2. the registry wins — when claude's registry names a different id for the
//      pane, that record is the process's current state; the claim is stale
//   3. same id: idempotent; a pinned provenance stands, a scraped one is
//      promoted to `hook` (claude itself confirmed it)
//   4. different id: replaces whatever was there, pinned or not — like the
//      registry, this is claude reporting its own conversation, not a guess.
//      transcriptSeen is reset unless the caller proved the file exists.
// Returns { accepted, changed, reason }. Mutates rt on acceptance only.
export function applyHookClaim(rt, claim, { registry = null, pinned = new Set(["authoritative", "manual", "registry", "hook"]), fileExists = null } = {}) {
  if (Number.isFinite(rt.hookAt) && claim.at < rt.hookAt) return { accepted: false, changed: false, reason: "a newer SessionStart claim was already accepted for this pane" };
  if (registry && registry.status === "matched" && registry.sessionId !== claim.sessionId) return { accepted: false, changed: false, reason: "claude's session registry names a different (newer) session for this pane" };
  rt.hookAt = claim.at;
  rt.hookPid = claim.claudePid;
  if (rt.sessionId === claim.sessionId) {
    if (pinned.has(rt.confidence)) return { accepted: true, changed: false, reason: "same id, provenance kept" };
    rt.confidence = "hook";
    return { accepted: true, changed: true, reason: "same id, promoted to hook" };
  }
  rt.sessionId = claim.sessionId;
  rt.confidence = "hook";
  if (fileExists === true) rt.transcriptSeen = true; else delete rt.transcriptSeen;
  return { accepted: true, changed: true, reason: "session id taken from claude's SessionStart hook" };
}

// ── SessionStart hook installation (explicit opt-in only: `hadron checkpoint
// --install-hook`; nothing else ever touches claude's settings.json) ──
// settings.hooks.SessionStart = [ { matcher?, hooks: [ { type:"command", command, timeout } ] } ]
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { readSettings, writeSettings } from "./quota.js";
import { CLAUDE_CONFIG_DIR } from "./session-registry.js";

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function hookCommand(nodePath, hadronBin) { return `${q(nodePath)} ${q(hadronBin)} checkpoint --hook`; }
// Ours is the command's SHAPE: a quoted path ending in hadron.js, then the
// subcommand — a user's own hook that merely mentions "checkpoint --hook" is
// neither repointed nor removed.
export const HOOK_MARK = /(^|\s)'(?:[^']|'\\'')*hadron\.js'\s+checkpoint --hook(\s|$)/;
export const HOOK_TIMEOUT_S = 5;

function hookGroups(settings) {
  const h = settings.hooks;
  if (h === undefined) return [];
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("hooks is not an object — not touching it");
  const g = h.SessionStart;
  if (g === undefined) return [];
  if (!Array.isArray(g)) throw new Error("hooks.SessionStart is not an array — not touching it");
  return g;
}
const ourEntries = (groups) => groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : []).filter((e) => e && typeof e.command === "string" && HOOK_MARK.test(e.command)));

export function hookInstallStatus({ configDir = CLAUDE_CONFIG_DIR, hadronBin = null } = {}) {
  const { settings } = readSettings(configDir);
  const ours = ourEntries(hookGroups(settings));
  const command = ours.length ? ours[0].command : null;
  return { installed: ours.length > 0, command, current: ours.length > 0 && (hadronBin ? command.includes(q(hadronBin)) : null) };
}

export function installSessionHook({ configDir = CLAUDE_CONFIG_DIR, nodePath = process.execPath, hadronBin } = {}) {
  const { path, settings, existed } = readSettings(configDir);
  const prevText = existed ? readFileSync(path, "utf-8") : null;
  const groups = hookGroups(settings);
  const command = hookCommand(nodePath, hadronBin);
  const ours = ourEntries(groups);
  if (ours.length) {
    if (ours.every((e) => e.command === command)) return { changed: false, command, path };
    const repaired = ours[0].command; // another checkout (or node): repoint in place
    for (const e of ours) { e.command = command; e.type = "command"; e.timeout = HOOK_TIMEOUT_S; }
    writeSettings(path, settings, prevText);
    return { changed: true, command, path, repaired };
  }
  groups.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] });
  settings.hooks = { ...(settings.hooks || {}), SessionStart: groups };
  mkdirSync(configDir, { recursive: true });
  writeSettings(path, settings, prevText);
  return { changed: true, command, path };
}

export function uninstallSessionHook({ configDir = CLAUDE_CONFIG_DIR } = {}) {
  const { path, settings, existed } = readSettings(configDir);
  if (!existed) return { changed: false, path };
  const groups = hookGroups(settings);
  if (!ourEntries(groups).length) return { changed: false, path };
  const prevText = readFileSync(path, "utf-8");
  const kept = groups.map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((e) => !(e && typeof e.command === "string" && HOOK_MARK.test(e.command))) } : g))
    .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0 && Object.keys(g).every((k) => k === "hooks" || k === "matcher")));
  if (kept.length) settings.hooks.SessionStart = kept;
  else {
    delete settings.hooks.SessionStart;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  writeSettings(path, settings, prevText);
  return { changed: true, path };
}
