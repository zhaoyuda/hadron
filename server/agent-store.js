import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

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

export function loadAgents() {
  const agents = new Map();
  let files;
  try { files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".json")); } catch { return agents; }

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(AGENTS_DIR, file), "utf-8"));
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
    } catch {}
  }
  return agents;
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

function withAgentLock(id, fn) {
  const prev = writeLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(id, next.catch(() => {}));
  return next;
}

function writeAgentFile(id, data) {
  recordSelfWrite(id);
  writeFileSync(join(AGENTS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
  recordSelfWrite(id);
}

export function saveAgent(agent) {
  const { id, name, group, task, icon, tmuxSession, artifacts, relatedAgents, notes, sortOrder, archived, archivedAt, deletable, cwd, launchCommand, autostartedAt } = agent;
  const data = { id, name, group: group || "Workers", task, tmuxSession: tmuxSession || `hadron-${id}`, artifacts: artifacts || [], relatedAgents: relatedAgents || [], notes: notes || "" };
  if (icon) data.icon = icon;
  if (sortOrder !== undefined && sortOrder !== null) data.sortOrder = sortOrder;
  if (archived) data.archived = true;
  if (archived && archivedAt) data.archivedAt = archivedAt;
  if (deletable === false) data.deletable = false;
  if (cwd) data.cwd = cwd;
  if (launchCommand) data.launchCommand = launchCommand;
  if (autostartedAt) data.autostartedAt = autostartedAt;
  data.updatedAt = new Date().toISOString();
  writeAgentFile(id, data);
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
