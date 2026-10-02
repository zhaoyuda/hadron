import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, renameSync, statSync } from "fs";
import { join } from "path";
import { warnOnce } from "./log.js";
import { isValidId } from "./tmux.js";

let AGENTS_DIR = null;
let WORKSPACE_DIR = null;

export function initWorkspace(workspaceDir) {
  WORKSPACE_DIR = workspaceDir;
  const hadronDir = join(workspaceDir, ".hadron");
  AGENTS_DIR = join(hadronDir, "agents");
  if (!existsSync(hadronDir)) mkdirSync(hadronDir, { recursive: true });
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });

  const configPath = join(hadronDir, "config.json");
  if (!existsSync(configPath)) {
    const name = workspaceDir.split("/").pop() || "workspace";
    writeFileSync(configPath, JSON.stringify({ name }, null, 2));
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

export function getWorkspaceDir() { return WORKSPACE_DIR; }

// Everything the loader sees on disk is restored, or loudly replaced — never
// skipped. A record that does not parse (prod 2026-10-01: a 0-byte
// t289-sol.json after a non-atomic write was interrupted) used to be dropped
// here with an empty catch, so the agent vanished from the dashboard and the
// CLI while its tmux session — claude, 129k context, a permission prompt —
// kept running unseen for 15 hours. Now the bad file is kept aside as
// <id>.json.corrupt-<stamp> (forensics), a placeholder record with the id as
// its name is written in its place so the next boot still has it, and the
// placeholder carries `recoveredFrom` so the card, `hadron ls` and `hadron
// doctor` all say that name/task/artifacts were lost.
// `recover` is for the boot call only: at runtime (GET /api/sessions/archived)
// a record may be mid-write by the agent that owns it (agents edit their own
// files, not atomically), and quarantining a torn read would destroy a good
// record. At boot nothing else is writing.
export function loadAgents({ recover = false } = {}) {
  const agents = new Map();
  let files;
  try { files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".json")); } catch { return agents; }

  for (const file of files) {
    const path = join(AGENTS_DIR, file);
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf-8"));
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.id !== "string") throw new Error("not an agent record");
    } catch (e) {
      // Only bytes that were READ and are not a record get quarantined. A read
      // error (EMFILE on an fd-exhausted box, EACCES after a chown, EIO) has a
      // .code and says nothing about the bytes — moving such a file aside
      // would de-persist a good record, for every record at once.
      if (e && e.code) { warnOnce(`agent-read:${file}`, `[agents] ${file} could not be read (${e.code}) — left in place, not loaded this boot`); continue; }
      const id = file.slice(0, -".json".length);
      if (!recover) { warnOnce(`corrupt-record:${file}`, `[agents] ${file} is not a parseable agent record — skipped (recovery runs at boot only)`); continue; }
      if (!isValidId(id)) { warnOnce(`corrupt-record:${file}`, `[agents] ${file} is not a parseable agent record and its name is not an agent id — left in place, ignored`); continue; }
      data = recoverCorruptRecord(id, path, e);
      if (!data) continue;
    }
    // Backward compat: map legacy role to group
    if (!data.group && data.role) {
      if (data.role === "planner") data.group = "Command";
      else if (data.role === "reviewer") data.group = "Reviewers";
      else data.group = "Workers";
    }
    agents.set(data.id, {
      ...data,
      state: "idle",
      blockReason: undefined,
    });
  }
  return agents;
}

// Move the unreadable file aside (never overwrite an earlier quarantine) and
// write a minimal valid record in its place. Returns the placeholder, or null
// if the file could not be moved (then nothing is written over it: a later
// boot sees the same corrupt file and warns again).
function recoverCorruptRecord(id, path, err) {
  let bytes = null;
  try { bytes = statSync(path).size; } catch {}
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let aside = `${path}.corrupt-${stamp}`;
  for (let n = 1; existsSync(aside); n++) aside = `${path}.corrupt-${stamp}-${n}`;
  try { renameSync(path, aside); } catch (e2) {
    warnOnce(`corrupt-record:${id}`, `[agents] ${id}.json is unreadable (${bytes === null ? "?" : bytes} bytes: ${err.message}) and could not be moved aside (${e2.message}) — agent ${id} is NOT loaded`);
    return null;
  }
  const asideName = aside.slice(aside.lastIndexOf("/") + 1);
  const placeholder = {
    id, name: id, group: "Workers", task: null, artifacts: [], relatedAgents: [], notes: "",
    recoveredFrom: { file: asideName, bytes, at: new Date().toISOString() },
  };
  try { writeAgentFile(id, placeholder); } catch (e3) {
    // Put the bytes back under their own name so the next boot retries (and
    // warns again) instead of finding a directory with no <id>.json at all.
    let restored = false;
    try { renameSync(aside, path); restored = true; } catch {}
    warnOnce(`corrupt-record:${id}`, `[agents] ${id}.json was unreadable and a placeholder could not be written (${e3.message}) — ${restored ? "original left in place, recovery retried next boot" : `original kept as ${asideName}`}; agent ${id} is loaded for this boot only`);
    placeholder.recoveredFrom.file = restored ? `${id}.json` : asideName;
    return placeholder;
  }
  warnOnce(`corrupt-record:${id}`, `[agents] ${id}.json was unreadable (${bytes === null ? "?" : bytes} bytes: ${err.message}) — moved to ${asideName}, placeholder written; name/task/artifacts/notes are lost, the tmux session (if any) is kept`);
  return placeholder;
}

export function loadAgent(id) {
  try {
    const data = JSON.parse(readFileSync(join(AGENTS_DIR, `${id}.json`), "utf-8"));
    // Backward compat: map legacy role to group
    if (!data.group && data.role) {
      if (data.role === "planner") data.group = "Command";
      else if (data.role === "reviewer") data.group = "Reviewers";
      else data.group = "Workers";
    }
    return { ...data, state: "idle", blockReason: undefined };
  } catch {
    return null;
  }
}

// ── Write coordination ──
// Per-agent in-process lock so concurrent appends (a planner linking several workers
// at once) serialize instead of clobbering via last-write-wins. Also a self-write
// guard so the index.js fsWatch reloader ignores writes WE just made (otherwise the
// watcher races our own mutation and can revert a fresh append).
const writeLocks = new Map();   // id -> Promise chain
const selfWrites = new Map();   // id -> timestamp of our most recent write
const SELF_WRITE_WINDOW_MS = 1500;

function recordSelfWrite(id) {
  selfWrites.set(id, Date.now());
}

export function isSelfWrite(id) {
  const t = selfWrites.get(id);
  return t !== undefined && Date.now() - t < SELF_WRITE_WINDOW_MS;
}

// Exported as a store primitive: index.js routes build on it indirectly (append/
// remove/saveAgentLocked), and the unit suite uses it directly to prove FIFO
// serialization (hold the lock, queue mutations behind it, assert the order).
export function withAgentLock(id, fn) {
  const prev = writeLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(id, next.catch(() => {}));
  return next;
}

// Atomic: write a sibling temp file, then rename over the record. A plain
// writeFileSync truncates first, so a process killed (or a disk that fills)
// between truncate and write leaves a 0-byte record — the loader above
// recovers one, but it must not be created in the first place. Same pattern
// as quota.js / annotations.js. The temp name never ends in ".json", so the
// loader's readdir filter and the fsWatch reloader both ignore it.
function writeAgentFile(id, data) {
  recordSelfWrite(id);
  const path = join(AGENTS_DIR, `${id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    recordSelfWrite(id);
  }
}

export function saveAgent(agent) {
  const { id, name, group, task, icon, tmuxSession, artifacts, relatedAgents, notes, sortOrder, archived, archivedAt, deletable, cwd, launchCommand, autostartedAt, pinned, parked } = agent;
  const data = { id, name, group: group || "Workers", task, artifacts: artifacts || [], relatedAgents: relatedAgents || [], notes: notes || "" };
  // Never fabricate a name here: the real one is `hadron-<workspace>-<id>`
  // (server/index.js tmuxSessionName) and only the server knows the prefix.
  if (tmuxSession) data.tmuxSession = tmuxSession;
  if (icon) data.icon = icon;
  if (pinned) data.pinned = true;
  if (parked) data.parked = true; // deck fold only — never implies archived
  // Files hidden from the panel's Core section (paths); absent unless non-empty.
  if (Array.isArray(agent.coreDismissed) && agent.coreDismissed.length) data.coreDismissed = agent.coreDismissed;
  // The agent's own handoff checkpoint (goal/next/blocked/outputs/at) — absent unless set.
  if (agent.checkpoint && typeof agent.checkpoint === "object" && !Array.isArray(agent.checkpoint)) data.checkpoint = agent.checkpoint;
  if (sortOrder !== undefined && sortOrder !== null) data.sortOrder = sortOrder;
  if (archived) data.archived = true;
  if (archived && archivedAt) data.archivedAt = archivedAt;
  if (deletable === false) data.deletable = false;
  if (cwd) data.cwd = cwd;
  if (launchCommand) data.launchCommand = launchCommand;
  if (autostartedAt) data.autostartedAt = autostartedAt;
  // v0.9 resume: the runtime checkpoint and the opt-in post-resume command
  // (both absent unless the resume machinery / the user set them).
  // Triage: attentionRev counts entries into done/blocked, ackRev how far the
  // operator has acknowledged; both survive a restart so an unseen "done" is
  // still lit after a deploy (state itself is not persisted — it is re-detected).
  if (Number.isInteger(agent.attentionRev) && agent.attentionRev > 0) {
    data.attentionRev = agent.attentionRev;
    if (Number.isInteger(agent.ackRev) && agent.ackRev > 0) {
      data.ackRev = Math.min(agent.ackRev, agent.attentionRev);
      if (agent.ackAt) data.ackAt = agent.ackAt; // "you last looked" — one of the card's three timestamps
    }
    if (agent.attentionAt) data.attentionAt = agent.attentionAt;
    if (agent.attentionState === "done" || agent.attentionState === "blocked") data.attentionState = agent.attentionState;
  }
  if (agent.runtime) data.runtime = agent.runtime;
  if (agent.resumeCommand) data.resumeCommand = agent.resumeCommand;
  // Set by the loader when this record replaced an unreadable file; kept so
  // the loss stays visible (card, ls, doctor) until the agent is closed.
  if (agent.recoveredFrom && typeof agent.recoveredFrom === "object") data.recoveredFrom = agent.recoveredFrom;
  data.updatedAt = new Date().toISOString();
  writeAgentFile(id, data);
}

// Persist a full agent snapshot under the same per-agent lock as the field
// mutations (appendAgentField / removeAgentArtifact), so a whole-object save
// (e.g. the artifacts-array PATCH) serializes with their read-modify-write
// cycles instead of racing them.
export function saveAgentLocked(agent) {
  return withAgentLock(agent.id, () => saveAgent(agent));
}

// Atomically append one item to an array field (artifacts | relatedAgents), under the
// per-agent lock: reload from disk → append → dedupe → write. Returns the updated data.
export function appendAgentField(id, field, item) {
  return withAgentLock(id, () => {
    let data;
    try {
      data = JSON.parse(readFileSync(join(AGENTS_DIR, `${id}.json`), "utf-8"));
    } catch {
      return null;
    }
    const arr = Array.isArray(data[field]) ? data[field] : [];
    const keyOf = (x) => (x && typeof x === "object" ? (x.value ?? JSON.stringify(x)) : x);
    const itemKey = keyOf(item);
    if (!arr.some((x) => keyOf(x) === itemKey)) {
      arr.push(item);
    }
    data[field] = arr;
    data.updatedAt = new Date().toISOString();
    writeAgentFile(id, data);
    return data;
  });
}

// Atomically remove one artifact by (index, value), under the same per-agent lock as
// append: reload from disk → verify the pair still matches → splice → write. The
// index+value guard is the transitional substitute for stable artifact ids: if the
// array drifted since the caller rendered (concurrent append/remove), the value at
// that index no longer matches → { conflict: true }, nothing changes, caller 409s.
// `matches(stored, given)` lets the caller compare canonical forms (clients see
// resolved paths while the file stores workspace-relative ones).
export function removeAgentArtifact(id, index, value, matches = (a, b) => a === b) {
  return withAgentLock(id, () => {
    let data;
    try {
      data = JSON.parse(readFileSync(join(AGENTS_DIR, `${id}.json`), "utf-8"));
    } catch {
      return null;
    }
    const arr = Array.isArray(data.artifacts) ? data.artifacts : [];
    const at = arr[index];
    if (!at || !matches(at.value, value)) return { conflict: true };
    arr.splice(index, 1);
    data.artifacts = arr;
    data.updatedAt = new Date().toISOString();
    writeAgentFile(id, data);
    return { data };
  });
}

export function archiveAgent(id) {
  return withAgentLock(id, () => {
    try {
      const data = JSON.parse(readFileSync(join(AGENTS_DIR, `${id}.json`), "utf-8"));
      data.archived = true;
      data.archivedAt = new Date().toISOString();
      writeAgentFile(id, data);
    } catch {}
  });
}

export function deleteAgent(id) {
  try { unlinkSync(join(AGENTS_DIR, `${id}.json`)); } catch {}
}
