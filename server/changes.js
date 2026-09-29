// The per-agent "Changes" view: what git sees in the agent's cwd right now —
// working-tree status with +/- line counts, and a unified diff per file.
// Read-only enrichment of the transcript's own "Changed" list: git is the
// ground truth for what differs from HEAD, the transcript for who did it
// (`touched` marks paths this session's tool calls wrote). No branch
// management, no staging, no commit — the terminal is for that.
import { execFile } from "child_process";
import { readFileSync, statSync } from "fs";
import { resolve, relative, isAbsolute, sep } from "path";

export const CHANGES_MAX_FILES = 500;      // status rows on the wire (git status of a huge tree is the agent's problem, not the panel's)
export const DIFF_MAX_BYTES = 512 * 1024;  // one file's unified diff, clipped with `truncated`
const GIT_TIMEOUT_MS = 5000;
const DIFF_BUFFER = 64 * 1024 * 1024; // above DIFF_MAX_BYTES: the clip is the only size limit a diff hits
const UNTRACKED_COUNT_MAX = 4 * 1024 * 1024; // count lines of an untracked file up to this size

function git(cwd, args, { maxBuffer = 8 * 1024 * 1024, okCodes = [0] } = {}) {
  return new Promise((res, rej) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: GIT_TIMEOUT_MS, maxBuffer, killSignal: "SIGKILL", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }, (err, stdout) => {
      if (err && !(okCodes.includes(err.code) && typeof stdout === "string")) return rej(err);
      res(stdout);
    });
  });
}

// Parse `git status --porcelain -z` (NUL-separated, repo-root-relative; a
// rename/copy entry is followed by its source path as its own field).
export function parseStatusZ(out) {
  const fields = out.split("\0");
  const rows = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2), path = entry.slice(3);
    let from = null;
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") { from = fields[i + 1] || null; i++; }
    rows.push({ path, xy, from });
  }
  return rows;
}
// Parse `git diff --numstat -z`: "add\tdel\tpath\0" (binary: "-\t-\tpath");
// a rename is "add\tdel\t\0src\0dst\0".
export function parseNumstatZ(out) {
  const m = new Map();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const parts = f.split("\t");
    if (parts.length < 3) continue;
    const [a, d, p] = parts;
    let path = p;
    if (path === "") { i += 2; path = fields[i]; }  // rename: src, dst follow
    if (!path) continue;
    m.set(path, { add: a === "-" ? null : Number(a), del: d === "-" ? null : Number(d) });
  }
  return m;
}

// One word per porcelain XY code (index + work tree folded: the panel says
// what happened to the file, the terminal says how it is staged).
export function statusOf(xy) {
  if (xy === "??") return "untracked";
  if (xy === "UU" || xy === "AA" || xy === "DD" || xy.includes("U")) return "conflict";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  if (xy.includes("R") || xy.includes("C")) return "renamed";
  return "modified";
}
// Counting reads files synchronously inside the request: one budget for the
// whole pass (an unignored node_modules must not stall every terminal WS and
// state poll), past it a row reads null like a binary.
const COUNT_BUDGET_BYTES = 8 * 1024 * 1024;
function countLines(file, budget) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > UNTRACKED_COUNT_MAX) return null;
    if (budget.left < st.size) return null;
    budget.left -= st.size;
    const buf = readFileSync(file);
    if (buf.includes(0)) return null; // binary
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return n;
  } catch { return null; }
}

// { root, branch, files: [{ path (repo-relative), abs, status, add, del, from }], total, truncated }
// or { root: null } when cwd is not inside a git work tree (or git is missing).
export async function gitChanges(cwd) {
  let root, branch;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (!root) return { root: null };
  } catch { return { root: null }; }
  try { branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch { branch = null; }
  if (branch === "HEAD") { try { branch = `detached ${(await git(cwd, ["rev-parse", "--short", "HEAD"])).trim()}`; } catch {} }
  let rows;
  try { rows = parseStatusZ(await git(root, ["status", "--porcelain", "-z", "--untracked-files=all"])); } catch { return { root, branch, files: [], total: 0, truncated: false, error: "git status failed" }; }
  // Line counts against HEAD (staged + unstaged in one number — what the
  // agent changed, not how it staged it). A repo with no commit yet has no
  // HEAD: every tracked file is then "added" and counted like untracked.
  let numstat = new Map();
  try { numstat = parseNumstatZ(await git(root, ["diff", "--numstat", "-z", "HEAD", "--"])); } catch {}
  const total = rows.length;
  const budget = { left: COUNT_BUDGET_BYTES };
  const files = rows.slice(0, CHANGES_MAX_FILES).map((r) => {
    const status = statusOf(r.xy);
    const n = numstat.get(r.path);
    const abs = resolve(root, r.path);
    let add = n ? n.add : null, del = n ? n.del : null;
    if (!n && (status === "untracked" || status === "added")) { add = countLines(abs, budget); del = add === null ? null : 0; }
    return { path: r.path, abs, status, add, del, ...(r.from ? { from: r.from } : {}) };
  });
  return { root, branch, files, total, truncated: total > files.length };
}

// The unified diff of ONE changed file. `relPath` must be one of the current
// change set (the caller re-lists — a diff of an arbitrary path is refused:
// the endpoint is not a file reader) and must stay inside the work tree.
async function hasHead(root) {
  try { await git(root, ["rev-parse", "--verify", "-q", "HEAD"]); return true; } catch { return false; }
}
export async function gitDiffFile(root, relPath, status, from) {
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0")) return { error: "bad path" };
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return { error: "path escapes the repository" };
  let out;
  try {
    if (status === "untracked") {
      // --no-index exits 1 when the files differ (always, against /dev/null).
      out = await git(root, ["diff", "--no-index", "--", "/dev/null", abs], { okCodes: [0, 1], maxBuffer: DIFF_BUFFER });
      // git prints the absolute path in the header, its leading slash folded
      // into the prefix ("a/tmp/x/new.txt"); make it read like the others.
      out = out.split("\n").map((line, i) => {
        if (i > 4 && !/^(diff --git|--- |\+\+\+ )/.test(line)) return line; // header lines only, never content
        for (const side of ["a", "b"]) line = line.split(`${side}${abs}`).join(`${side}/${rel}`).split(`${side}/${abs}`).join(`${side}/${rel}`);
        return line;
      }).join("\n");
    } else if (status === "added" && !(await hasHead(root))) {
      // A repo with no commit yet has no HEAD: what is staged IS the change.
      out = await git(root, ["diff", "--cached", "--", relPath], { maxBuffer: DIFF_BUFFER });
    } else if (status === "renamed" && typeof from === "string" && from && !from.includes("\0") && !relative(root, resolve(root, from)).startsWith("..")) {
      out = await git(root, ["diff", "-M", "HEAD", "--", relPath, from], { maxBuffer: DIFF_BUFFER });
    } else {
      out = await git(root, ["diff", "HEAD", "--", relPath], { maxBuffer: DIFF_BUFFER });
    }
  } catch (e) {
    return { error: `git diff failed${e && e.killed ? " (timeout)" : ""}` };
  }
  let truncated = false;
  if (Buffer.byteLength(out) > DIFF_MAX_BYTES) {
    const buf = Buffer.from(out);
    let end = DIFF_MAX_BYTES;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // never cut a multibyte sequence
    out = buf.subarray(0, end).toString("utf-8"); truncated = true;
  }
  return { diff: out, truncated };
}
