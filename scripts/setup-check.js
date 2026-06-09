#!/usr/bin/env node
/**
 * Deterministic preflight for Hadron. Verifies prerequisites and reports
 * pass/fail — installs nothing, changes nothing. Both the README manual path
 * and the hadron-setup skill call this so onboarding is reproducible.
 *
 * Usage:
 *   npm run setup:check
 *   node scripts/setup-check.js [workspace-path] [--port 3000]
 *
 * Exit code 0 if all REQUIRED checks pass, 1 otherwise. Optional checks
 * (Claude Code, hadron CLI, skill links, workspace config) only warn.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { createServer } from "net";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
let port = Number(process.env.PORT) || 3000;
let workspace = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
  else if (!args[i].startsWith("--")) workspace = args[i];
}

let failed = 0, warned = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failed++; console.error(`  ✗ ${m}`); };
const warn = (m) => { warned++; console.warn(`  ⚠ ${m}`); };

function cmdVersion(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

function bindFree(p, host) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(p, host);
  });
}

// Test loopback + both wildcard families. A stale server bound to "*:port"
// (IPv6 wildcard) is invisible to a 127.0.0.1-only probe, yet still fights for
// the port — that exact gap let a zombie instance slip past preflight.
async function portFree(p) {
  for (const host of ["127.0.0.1", "0.0.0.0", "::"]) {
    if (!(await bindFree(p, host))) return false;
  }
  return true;
}

async function main() {
  console.log("Hadron preflight\n");

  // node >= 18 (required)
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) pass(`node ${process.versions.node} (>= 18)`);
  else fail(`node ${process.versions.node} is too old — need >= 18`);

  // tmux >= 3.0 (required)
  const tmuxV = cmdVersion("tmux", ["-V"]);
  if (!tmuxV) fail("tmux not found on PATH — install tmux >= 3.0");
  else {
    const m = tmuxV.match(/(\d+)\.(\d+)/);
    const major = m ? Number(m[1]) : 0;
    if (major >= 3) pass(`${tmuxV} (>= 3.0)`);
    else fail(`${tmuxV} is too old — need >= 3.0`);
  }

  // npm dependencies installed (required)
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  if (existsSync(join(repoRoot, "node_modules", "express"))) pass("npm dependencies installed");
  else fail("dependencies missing — run `npm install`");

  // node-pty actually forks (required) — the one native dep that most commonly
  // breaks. A non-executable prebuilt spawn-helper throws "posix_spawnp failed"
  // only at spawn time, so a presence check isn't enough; fork a throwaway pty.
  if (existsSync(join(repoRoot, "node_modules", "node-pty"))) {
    try {
      const { spawn } = await import("node-pty");
      const p = spawn(process.env.SHELL || "/bin/sh", ["-c", "exit 0"], { name: "xterm-256color", cols: 80, rows: 24 });
      p.kill();
      pass("node-pty can fork a pty");
    } catch (e) {
      fail(`node-pty cannot fork (${e.message}) — try \`npm run postinstall\` to restore spawn-helper perms`);
    }
  } else {
    fail("node-pty not installed — run `npm install`");
  }

  // port free (required)
  if (await portFree(port)) pass(`port ${port} is free`);
  else fail(`port ${port} is in use — set PORT to another, or stop the process holding it`);

  // Claude Code on PATH (optional)
  const claudeV = cmdVersion("claude", ["--version"]) || cmdVersion("claude", ["-v"]);
  if (claudeV) pass(`Claude Code present (${claudeV.split("\n")[0]})`);
  else warn("Claude Code not found on PATH — recommended as the agent runtime + for /hadron-setup");

  // hadron CLI on PATH (optional) — no args prints usage and exits 0, so this
  // doubles as an "it actually runs" probe, not just a which(1) lookup.
  if (cmdVersion("hadron", []) !== null) pass("hadron CLI on PATH");
  else warn("hadron CLI not on PATH — run `npm link` so skills and agents in other repos can use it");

  // operation skills linked into ~/.claude/skills (optional) — the server also
  // self-heals these on startup, so missing links are a normal fresh-clone state.
  const { skillsStatus } = await import("../server/skills.js");
  const skills = skillsStatus(repoRoot);
  if (skills.length > 0) {
    const linked = skills.filter((s) => s.state === "linked").length;
    const conflicts = skills.filter((s) => s.state === "conflict").map((s) => s.name);
    if (conflicts.length > 0) warn(`skill name conflict: ${conflicts.join(", ")} — an existing non-Hadron entry in ~/.claude/skills occupies that name`);
    if (linked === skills.length) pass(`operation skills linked into ~/.claude/skills (${linked}/${skills.length})`);
    else if (conflicts.length < skills.length - linked) warn(`${skills.length - linked - conflicts.length} operation skill(s) not linked — run \`hadron skills sync\` (or the server links them on startup)`);
  }

  // workspace config (optional — informational)
  if (workspace) {
    const cfg = join(resolve(workspace.replace(/^~/, process.env.HOME)), ".hadron", "config.json");
    if (existsSync(cfg)) pass(`workspace config present (${cfg})`);
    else warn(`no .hadron config at ${workspace} yet — run scripts/setup-workspace.js`);
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failed, ${warned} warning(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
