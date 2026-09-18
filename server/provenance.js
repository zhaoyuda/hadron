// What is actually running — so a stale service can be told apart from the
// working tree the user just pulled. Computed once at boot (git calls are
// bounded by a timeout and never throw): `commit`/`dirty` describe the tree
// the process was started from, not the tree as it is now.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

export function gitInfo(root, { timeoutMs = 5000 } = {}) {
  const runRaw = (args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"],
  });
  const run = (args) => runRaw(args).trim();
  let commit = null;
  try { commit = run(["rev-parse", "HEAD"]) || null; } catch { return { commit: null, dirty: null }; }
  let dirty = null, dirtyOther = null;
  try {
    // -z: NUL-separated, unquoted, REPO-ROOT-relative paths; a rename/copy
    // entry is followed by the source path as its own field. When Hadron is a
    // subdirectory of a larger repo (vendored / monorepo) the runtime paths
    // sit under that prefix — strip it, or every edit looks like "other".
    const prefix = run(["rev-parse", "--show-prefix"]);
    const fields = runRaw(["status", "--porcelain", "-z"]).split("\0");
    dirty = false; dirtyOther = false;
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i];
      if (!entry) continue;
      const xy = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename/copy lists the source next; a runtime file renamed AWAY is
      // as much "not any commit" as one edited in place, so judge both ends.
      const paths = [path];
      if (xy[0] === "R" || xy[0] === "C") paths.push(fields[++i] || "");
      const hit = paths.some((p) => p.startsWith(prefix) && affectsRuntime(p.slice(prefix.length)));
      if (xy !== "??" && hit) dirty = true; else dirtyOther = true;
    }
  } catch { dirty = null; dirtyOther = null; }
  return { commit, dirty, dirtyOther };
}

// `dirty` means "what runs is not any commit": a tracked file under the paths
// the server actually executes/serves is modified. Docs, tests, design notes
// and untracked files are reported separately (`dirtyOther`) as a note — a
// README edit must not fail `hadron version` or turn `hadron doctor` yellow.
export const RUNTIME_PATHS = ["server/", "bin/", "client/", "package.json", "package-lock.json"];
export function affectsRuntime(path) {
  return RUNTIME_PATHS.some((r) => (r.endsWith("/") ? path.startsWith(r) : path === r));
}

export function packageVersion(root) {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version || null; } catch { return null; }
}

// systemd sets INVOCATION_ID for every unit it starts; launchd sets
// XPC_SERVICE_NAME for jobs it manages (interactive shells see "0").
export function managedBy(env = process.env) {
  if (env.INVOCATION_ID) return "systemd";
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0") return "launchd";
  return null;
}

export function collectProvenance(root, env = process.env) {
  const git = gitInfo(root);
  return {
    version: packageVersion(root),
    commit: env.HADRON_TEST_COMMIT || git.commit, // test hook: fake a stale server
    dirty: git.dirty,
    dirtyOther: git.dirtyOther,
    repoRoot: root,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    managedBy: managedBy(env),
  };
}

export const short = (c) => (c ? String(c).slice(0, 7) : "unknown");
