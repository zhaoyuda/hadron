/**
 * Skill linking — shared by the `hadron` CLI and the server's startup self-heal.
 *
 * Claude Code only discovers skills as direct children of ~/.claude/skills/<name>/SKILL.md
 * and only walks up to a repo's git root, so skills living in THIS repo are invisible to
 * agents running in other repos. We symlink each operation skill into the user-global
 * ~/.claude/skills/ (the one place every agent sees regardless of cwd). Symlinks — not
 * copies — so skill *content* edits flow through on `git pull` with no re-install.
 *
 * The skill SET is scanned from the repo (not hardcoded), so a newly-added skill needs
 * zero code changes — it links on the next sync/restart.
 */
import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";

// hadron-setup is the bootstrap orchestrator — run from the repo, never needed user-global.
const EXCLUDE = new Set(["hadron-setup"]);

export function userSkillsDir() {
  return join(homedir(), ".claude", "skills");
}
export function repoSkillsDir(repo) {
  return join(repo, ".claude", "skills");
}

// Operation skills = direct child dirs of .claude/skills/ that have a SKILL.md, minus excludes.
export function scanSkills(repo) {
  const dir = repoSkillsDir(repo);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !EXCLUDE.has(e.name) && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

// Resolve a symlink's target without throwing on a dangling link.
function linkTarget(p) {
  try { return resolve(dirname(p), readlinkSync(p)); } catch { return null; }
}

/**
 * Ensure ~/.claude/skills/<name> points at each scanned repo skill.
 *  - default (additive): create only missing links; never re-point or remove an
 *    existing entry. This is what makes startup self-heal safe with multiple servers
 *    or multiple checkouts — first to create a link wins, others leave it alone.
 *  - prune: also remove DEAD links that point into our own repo skills dir but whose
 *    target is gone (a renamed/removed skill). Never touches the user's own skills or
 *    links pointing elsewhere.
 * onEvent(kind, name, dest, st?) is called for "link" | "skip" | "prune".
 */
export function syncSkills(repo, { prune = false, onEvent } = {}) {
  const destDir = userSkillsDir();
  mkdirSync(destDir, { recursive: true });
  const src = repoSkillsDir(repo);
  const res = { linked: 0, already: 0, skipped: 0, pruned: 0 };
  for (const name of scanSkills(repo)) {
    const target = join(src, name);
    const dest = join(destDir, name);
    let st = null;
    try { st = lstatSync(dest); } catch {}
    if (st) {
      if (st.isSymbolicLink() && linkTarget(dest) === target) res.already++;
      else { res.skipped++; onEvent && onEvent("skip", name, dest, st); }
      continue;
    }
    symlinkSync(target, dest);
    res.linked++;
    onEvent && onEvent("link", name, dest);
  }
  if (prune) {
    let destEntries;
    try { destEntries = readdirSync(destDir); } catch { destEntries = []; }
    for (const name of destEntries) {
      const dest = join(destDir, name);
      let st = null;
      try { st = lstatSync(dest); } catch { continue; }
      if (!st.isSymbolicLink()) continue;
      const tgt = linkTarget(dest);
      if (tgt && tgt.startsWith(src + "/") && !existsSync(tgt)) {
        unlinkSync(dest);
        res.pruned++;
        onEvent && onEvent("prune", name, dest);
      }
    }
  }
  return res;
}

// Remove every link we own (uninstall). Only our links — never foreign entries.
export function removeSkills(repo, { onEvent } = {}) {
  const destDir = userSkillsDir();
  const src = repoSkillsDir(repo);
  let destEntries;
  try { destEntries = readdirSync(destDir); } catch { return { removed: 0 }; }
  let removed = 0;
  for (const name of destEntries) {
    const dest = join(destDir, name);
    let st = null;
    try { st = lstatSync(dest); } catch { continue; }
    if (st.isSymbolicLink()) {
      const tgt = linkTarget(dest);
      if (tgt && tgt.startsWith(src + "/")) { unlinkSync(dest); removed++; onEvent && onEvent("unlink", name); }
    }
  }
  return { removed };
}

// Report each scanned skill's state: "linked" | "not installed" | "conflict".
export function skillsStatus(repo) {
  const destDir = userSkillsDir();
  const src = repoSkillsDir(repo);
  return scanSkills(repo).map((name) => {
    const dest = join(destDir, name);
    let st = null;
    try { st = lstatSync(dest); } catch {}
    if (!st) return { name, state: "not installed" };
    if (st.isSymbolicLink() && linkTarget(dest) === join(src, name)) return { name, state: "linked" };
    return { name, state: "conflict" };
  });
}
