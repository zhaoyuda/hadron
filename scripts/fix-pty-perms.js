#!/usr/bin/env node
/**
 * postinstall: restore the executable bit on node-pty's prebuilt spawn-helper.
 *
 * npm's tarball extraction can drop the +x bit, leaving spawn-helper at 0644.
 * node-pty then throws "posix_spawnp failed" on the first terminal spawn — which,
 * unhandled, crashes the whole server. This makes a fresh clone "just work".
 * Idempotent and best-effort: silent no-op if node-pty or the file is absent.
 */
import { chmodSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const prebuilds = join(repoRoot, "node_modules", "node-pty", "prebuilds");

let fixed = 0;
try {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    try {
      const mode = statSync(helper).mode;
      if (!(mode & 0o111)) {
        chmodSync(helper, 0o755);
        fixed++;
      }
    } catch {} // no spawn-helper for this platform (e.g. win32) — skip
  }
} catch {} // node-pty not installed or no prebuilds — nothing to do

if (fixed > 0) console.log(`fix-pty-perms: restored +x on ${fixed} spawn-helper binar${fixed === 1 ? "y" : "ies"}`);
