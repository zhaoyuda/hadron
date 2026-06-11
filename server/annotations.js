/**
 * Annotation store — the server side of the v0.8 review loop.
 *
 * Layout: `.hadron/annotations/<agentId>/manifest.json` (batch state) plus one
 * sidecar per annotated file, named `<sha1(normalizedPath)>.json`. Files inside
 * the workspace are stored AND hashed by their workspace-relative path (scope
 * "workspace"); paths outside it stay absolute (scope "external"), so a moved
 * workspace keeps its annotations.
 *
 * Concurrency model: every mutation is fully synchronous (no awaits), so Node's
 * single thread IS the critical section — double-click Send / two tabs can't
 * interleave. All writes go temp+rename so a crash never leaves a torn file.
 *
 * Lifecycle is one-way (draft → sent → resolved) and only the dedicated
 * functions advance it. anchorStatus is recomputed on every read against the
 * file's current content — never persisted.
 */
import {
  readFileSync, writeFileSync, renameSync, unlinkSync,
  mkdirSync, readdirSync,
} from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { getWorkspaceDir } from "./agent-store.js";

// ── paths + atomic IO ──

function annotationsDir(agentId) {
  return join(getWorkspaceDir(), ".hadron", "annotations", agentId);
}
function sha1(s) {
  return createHash("sha1").update(s).digest("hex");
}
function sidecarFsPath(agentId, fileKey) {
  return join(annotationsDir(agentId), `${sha1(fileKey)}.json`);
}
function writeJsonAtomic(fsPath, data) {
  const tmp = `${fsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, fsPath);
}
function now() {
  return Math.floor(Date.now() / 1000);
}

// ── ids ──
// Random suffix makes ids unique within an agent even for same-second creates;
// createAnnotation still double-checks against existing ids to make it certain.

function randSuffix() {
  let s = "";
  while (s.length < 4) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}
function newCommentId() { return `c_${now()}_${randSuffix()}`; }
function newBatchId() { return `b_${now()}_${randSuffix()}`; }

// ── manifest ──

function manifestPath(agentId) {
  return join(annotationsDir(agentId), "manifest.json");
}
function loadManifest(agentId) {
  try {
    const m = JSON.parse(readFileSync(manifestPath(agentId), "utf-8"));
    if (m && typeof m === "object") return m;
  } catch {}
  return { schemaVersion: 1, lastBatchId: null, currentBatchId: null, dispatchedAt: null, dispatchError: null, updatedAt: 0 };
}
function saveManifest(agentId, manifest) {
  mkdirSync(annotationsDir(agentId), { recursive: true });
  manifest.updatedAt = now();
  writeJsonAtomic(manifestPath(agentId), manifest);
}

// ── sidecars ──
// A single corrupted sidecar must never take the API down: it's skipped and
// reported in the `errors` array of list responses instead.

function loadSidecars(agentId) {
  const dir = annotationsDir(agentId);
  const sidecars = [];
  const errors = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  } catch {}
  for (const f of files) {
    const fsPath = join(dir, f);
    try {
      const data = JSON.parse(readFileSync(fsPath, "utf-8"));
      if (!data || typeof data.file !== "string" || !Array.isArray(data.comments)) throw new Error("malformed sidecar");
      sidecars.push({ fsPath, data });
    } catch (e) {
      errors.push({ sidecar: f, error: e.message });
    }
  }
  return { sidecars, errors };
}

// Write back a sidecar; an emptied one is removed rather than left as litter.
function persistSidecar(sc) {
  if (sc.data.comments.length === 0) {
    try { unlinkSync(sc.fsPath); } catch {}
  } else {
    writeJsonAtomic(sc.fsPath, sc.data);
  }
}

function findComment(agentId, cid) {
  const { sidecars } = loadSidecars(agentId);
  for (const sc of sidecars) {
    const comment = sc.data.comments.find((c) => c.id === cid);
    if (comment) return { sc, comment };
  }
  return null;
}

// ── path canonicalization ──
// URLs can't be annotated; everything else resolves against the workspace root.
// Inside the workspace → relative path (the stable hash key); outside → absolute.

export function canonicalizePath(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "path (string) required" };
  let p = raw.trim();
  if (/^https?:\/\//i.test(p)) return { error: "URLs cannot be annotated" };
  if (p.startsWith("~")) p = p.replace(/^~/, process.env.HOME || "~");
  const root = resolve(getWorkspaceDir());
  const abs = resolve(root, p);
  if (abs === root) return { error: "path resolves to the workspace root, not a file" };
  if (abs.startsWith(root + "/")) return { file: abs.slice(root.length + 1), scope: "workspace" };
  return { file: abs, scope: "external" };
}

function absFilePath(sidecarData) {
  return sidecarData.scope === "external" ? sidecarData.file : resolve(getWorkspaceDir(), sidecarData.file);
}

// ── anchors ──
// Open union: "doc" (whole document) and "text" (exact + optional prefix/suffix)
// today; future types relocate as matched until they grow their own logic.

function normalizeAnchor(anchor) {
  if (anchor === undefined || anchor === null) return { anchor: { type: "doc" } };
  if (typeof anchor !== "object" || Array.isArray(anchor)) return { error: "anchor must be an object" };
  if (anchor.type === "doc") return { anchor: { type: "doc" } };
  if (anchor.type === "text") {
    if (typeof anchor.exact !== "string" || !anchor.exact) return { error: "text anchor requires exact (non-empty string)" };
    const a = { type: "text", exact: anchor.exact };
    if (typeof anchor.prefix === "string" && anchor.prefix) a.prefix = anchor.prefix;
    if (typeof anchor.suffix === "string" && anchor.suffix) a.suffix = anchor.suffix;
    return { anchor: a };
  }
  return { error: 'anchor.type must be "doc" or "text"' };
}

function findOccurrences(content, exact) {
  const idxs = [];
  let i = content.indexOf(exact);
  while (i !== -1) {
    idxs.push(i);
    i = content.indexOf(exact, i + 1);
  }
  return idxs;
}

// Relocate against current content: unique exact → matched; multiple → narrow by
// prefix/suffix context, still multiple → ambiguous; zero → orphaned.
export function relocateAnchor(anchor, content) {
  if (!anchor || anchor.type !== "text") return { status: "matched", index: null };
  if (typeof content !== "string") return { status: "orphaned", index: null };
  const matches = findOccurrences(content, anchor.exact);
  if (matches.length === 0) return { status: "orphaned", index: null };
  if (matches.length === 1) return { status: "matched", index: matches[0] };
  const narrowed = matches.filter((i) => {
    const prefixOk = !anchor.prefix || content.slice(Math.max(0, i - anchor.prefix.length), i) === anchor.prefix;
    const suffixOk = !anchor.suffix || content.startsWith(anchor.suffix, i + anchor.exact.length);
    return prefixOk && suffixOk;
  });
  if (narrowed.length === 1) return { status: "matched", index: narrowed[0] };
  return { status: "ambiguous", index: null };
}

// Human-readable location — the consumer-side anchor contract: the CLI/agent only
// ever sees this text, so new anchor types don't ripple past this function.
export function describeAnchor(comment, content) {
  const anchor = comment.anchor;
  if (!anchor || anchor.type !== "text") return "(whole document)";
  const { status, index } = relocateAnchor(anchor, content);
  if (status === "orphaned") return "(original text no longer found)";
  const oneLine = anchor.exact.replace(/\s+/g, " ").trim();
  const excerpt = oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
  if (status === "matched") {
    const line = content.slice(0, index).split("\n").length;
    return `"${excerpt}" (line ${line})`;
  }
  return `"${excerpt}" (multiple matches)`;
}

// ── summary ──
// Drives the UI floating bar entirely: it never re-derives batch state itself.

function computeSummary(manifest, sidecars) {
  let draft = 0, sent = 0, resolvedInCurrentBatch = 0, total = 0;
  for (const sc of sidecars) {
    for (const c of sc.data.comments) {
      total++;
      if (c.state === "draft") draft++;
      else if (c.state === "sent") sent++;
      else if (c.state === "resolved" && manifest.currentBatchId && c.batchId === manifest.currentBatchId) resolvedInCurrentBatch++;
    }
  }
  return {
    draft, sent, resolvedInCurrentBatch, total,
    currentBatchId: manifest.currentBatchId,
    lastBatchId: manifest.lastBatchId,
    dispatchError: manifest.dispatchError,
  };
}

function freshSummary(agentId) {
  return computeSummary(loadManifest(agentId), loadSidecars(agentId).sidecars);
}

// ── public API ──
// Every function returns either a payload or { error, status } for the route to map.

const STATE_FILTERS = { sent: ["sent"], active: ["draft", "sent"], all: null };

export function listAnnotations(agentId, { path, state = "active" } = {}) {
  const filter = STATE_FILTERS[state];
  if (filter === undefined) return { error: 'state must be "sent", "active" or "all"', status: 400 };
  let fileKey = null;
  if (path) {
    const c = canonicalizePath(path);
    if (c.error) return { error: c.error, status: 400 };
    fileKey = c.file;
  }
  const manifest = loadManifest(agentId);
  const { sidecars, errors } = loadSidecars(agentId);
  const comments = [];
  for (const sc of sidecars) {
    if (fileKey !== null && sc.data.file !== fileKey) continue;
    const visible = sc.data.comments.filter((c) => !filter || filter.includes(c.state));
    if (!visible.length) continue;
    // Content read once per file, only when something is visible — relocation
    // and locationText both come from this same snapshot.
    let content = null;
    try { content = readFileSync(absFilePath(sc.data), "utf-8"); } catch {}
    for (const c of visible) {
      comments.push({
        ...c,
        file: sc.data.file,
        scope: sc.data.scope,
        anchorStatus: relocateAnchor(c.anchor, content).status,
        locationText: describeAnchor(c, content),
      });
    }
  }
  return { comments, summary: computeSummary(manifest, sidecars), errors };
}

export function createAnnotation(agentId, { path, anchor, body }) {
  const c = canonicalizePath(path);
  if (c.error) return { error: c.error, status: 400 };
  if (typeof body !== "string" || !body.trim()) return { error: "body (non-empty string) required", status: 400 };
  const a = normalizeAnchor(anchor);
  if (a.error) return { error: a.error, status: 400 };

  const fsPath = sidecarFsPath(agentId, c.file);
  let data = { schemaVersion: 1, file: c.file, scope: c.scope, comments: [] };
  try {
    const existing = JSON.parse(readFileSync(fsPath, "utf-8"));
    if (!existing || !Array.isArray(existing.comments)) throw new Error("malformed");
    data = existing;
  } catch (e) {
    // ENOENT → fresh sidecar; anything else means the file exists but is
    // corrupted — refuse to overwrite it (it may hold recoverable comments).
    if (e.code !== "ENOENT") return { error: "sidecar for this file is corrupted; cannot add", status: 409 };
  }

  const existingIds = new Set();
  for (const sc of loadSidecars(agentId).sidecars) for (const cm of sc.data.comments) existingIds.add(cm.id);
  let id = newCommentId();
  while (existingIds.has(id)) id = newCommentId();

  const comment = {
    id, anchor: a.anchor, body,
    state: "draft", batchId: null,
    createdAt: now(), sentAt: null, resolvedAt: null,
  };
  data.comments.push(comment);
  mkdirSync(annotationsDir(agentId), { recursive: true });
  writeJsonAtomic(fsPath, data);
  // Response carries the same read-time fields a list would (anchorStatus is
  // computed, never persisted) so the UI can paint the new comment directly.
  let content = null;
  try { content = readFileSync(absFilePath(data), "utf-8"); } catch {}
  return {
    comment: {
      ...comment, file: data.file, scope: data.scope,
      anchorStatus: relocateAnchor(comment.anchor, content).status,
      locationText: describeAnchor(comment, content),
    },
    summary: freshSummary(agentId),
  };
}

export function updateAnnotation(agentId, cid, { body }) {
  if (typeof body !== "string" || !body.trim()) return { error: "body (non-empty string) required", status: 400 };
  const found = findComment(agentId, cid);
  if (!found) return { error: "comment not found", status: 404 };
  if (found.comment.state !== "draft") return { error: "only draft comments can be edited", status: 409 };
  found.comment.body = body;
  persistSidecar(found.sc);
  return { comment: { ...found.comment, file: found.sc.data.file, scope: found.sc.data.scope }, summary: freshSummary(agentId) };
}

export function deleteAnnotation(agentId, cid) {
  const found = findComment(agentId, cid);
  if (!found) return { error: "comment not found", status: 404 };
  if (found.comment.state !== "draft") return { error: "only draft comments can be deleted", status: 409 };
  found.sc.data.comments = found.sc.data.comments.filter((c) => c.id !== cid);
  persistSidecar(found.sc);
  return { ok: true, summary: freshSummary(agentId) };
}

/**
 * Atomic Send. One synchronous pass: collect drafts → purge the previous fully-
 * resolved batch → stamp drafts with a fresh batchId → commit manifest — and only
 * THEN dispatch the trigger. Dispatch failure does not un-send the batch: it's
 * recorded as manifest.dispatchError and retried via retryDispatch.
 */
export function sendAnnotations(agentId, dispatch) {
  const manifest = loadManifest(agentId);
  const { sidecars } = loadSidecars(agentId);
  const drafts = [];
  for (const sc of sidecars) for (const c of sc.data.comments) if (c.state === "draft") drafts.push(c);
  if (!drafts.length) return { ok: true, sent: 0, summary: computeSummary(manifest, sidecars) };

  const batchId = newBatchId();
  const ts = now();
  for (const sc of sidecars) {
    let touched = false;
    if (manifest.lastBatchId) {
      const before = sc.data.comments.length;
      sc.data.comments = sc.data.comments.filter((c) => !(c.state === "resolved" && c.batchId === manifest.lastBatchId));
      if (sc.data.comments.length !== before) touched = true;
    }
    for (const c of sc.data.comments) {
      if (c.state === "draft") {
        c.state = "sent";
        c.batchId = batchId;
        c.sentAt = ts;
        touched = true;
      }
    }
    if (touched) persistSidecar(sc);
  }
  manifest.currentBatchId = batchId;
  manifest.dispatchError = null;
  saveManifest(agentId, manifest);

  // Batch is committed on disk — dispatch is best-effort and retryable.
  let dispatchError = null;
  try {
    dispatch();
    manifest.dispatchedAt = ts;
  } catch (e) {
    dispatchError = e.message || String(e);
    manifest.dispatchError = dispatchError;
  }
  saveManifest(agentId, manifest);

  const out = { ok: true, sent: drafts.length, batchId, summary: computeSummary(manifest, sidecars) };
  if (dispatchError) out.dispatchError = dispatchError;
  return out;
}

// Idempotent: resolving an already-resolved comment is an OK no-op (the agent may
// retry after a flaky CLI call). When the current batch has no sent comment left,
// it becomes the re-openable "last batch".
export function resolveAnnotation(agentId, cid) {
  const found = findComment(agentId, cid);
  if (!found) return { error: "comment not found", status: 404 };
  if (found.comment.state === "draft") return { error: "comment has not been sent", status: 409 };
  if (found.comment.state !== "resolved") {
    found.comment.state = "resolved";
    found.comment.resolvedAt = now();
    persistSidecar(found.sc);
    const manifest = loadManifest(agentId);
    if (manifest.currentBatchId) {
      const { sidecars } = loadSidecars(agentId);
      const stillOpen = sidecars.some((sc) =>
        sc.data.comments.some((c) => c.batchId === manifest.currentBatchId && c.state === "sent"));
      if (!stillOpen) {
        manifest.lastBatchId = manifest.currentBatchId;
        manifest.currentBatchId = null;
        saveManifest(agentId, manifest);
      }
    }
  }
  return { ok: true, summary: freshSummary(agentId) };
}

// Recall the last fully-resolved batch: every comment in it goes back to a clean
// draft (no batch/sent/resolved traces), and the batch id is retired for good —
// the next Send always mints a fresh one.
export function reopenAnnotations(agentId) {
  const manifest = loadManifest(agentId);
  if (!manifest.lastBatchId) return { error: "no batch to reopen", status: 409 };
  const { sidecars } = loadSidecars(agentId);
  let reopened = 0;
  for (const sc of sidecars) {
    let touched = false;
    for (const c of sc.data.comments) {
      if (c.batchId === manifest.lastBatchId) {
        c.state = "draft";
        c.batchId = null;
        c.sentAt = null;
        c.resolvedAt = null;
        touched = true;
        reopened++;
      }
    }
    if (touched) persistSidecar(sc);
  }
  manifest.lastBatchId = null;
  saveManifest(agentId, manifest);
  return { ok: true, reopened, summary: computeSummary(manifest, sidecars) };
}

// Re-fire the trigger line only; batch data is untouched either way.
export function retryDispatch(agentId, dispatch) {
  const manifest = loadManifest(agentId);
  if (!manifest.currentBatchId) return { error: "no batch in flight", status: 409 };
  try {
    dispatch();
    manifest.dispatchError = null;
    manifest.dispatchedAt = now();
    saveManifest(agentId, manifest);
    return { ok: true, summary: freshSummary(agentId) };
  } catch (e) {
    manifest.dispatchError = e.message || String(e);
    saveManifest(agentId, manifest);
    return { ok: false, dispatchError: manifest.dispatchError, summary: freshSummary(agentId) };
  }
}
