// What is actually running — so a stale service can be told apart from the
// working tree the user just pulled. Computed once at boot (git calls are
// bounded by a timeout and never throw): `commit`/`dirty` describe the tree
// the process was started from, not the tree as it is now.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

export function gitInfo(root, { timeoutMs = 5000 } = {}) {
  const run = (args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  let commit = null;
  try { commit = run(["rev-parse", "HEAD"]) || null; } catch { return { commit: null, dirty: null }; }
  let dirty = null;
  try { dirty = run(["status", "--porcelain"]).length > 0; } catch { dirty = null; }
  return { commit, dirty };
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
    repoRoot: root,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    managedBy: managedBy(env),
  };
}

export const short = (c) => (c ? String(c).slice(0, 7) : "unknown");
