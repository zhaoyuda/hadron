#!/usr/bin/env node
/**
 * Setup a Hadron workspace directory.
 *
 * Usage:
 *   node scripts/setup-workspace.js ~/work
 *   node scripts/setup-workspace.js ~/work/demo --name demo --groups "Research,Workers"
 *
 * Creates .hadron/config.json and .hadron/agents/ if they don't exist.
 * Safe to re-run — won't overwrite existing config.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, basename, join, dirname } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: node scripts/setup-workspace.js <workspace-path> [--name <name>] [--groups <g1,g2,...>]");
  console.log("");
  console.log("Examples:");
  console.log("  node scripts/setup-workspace.js ~/work");
  console.log("  node scripts/setup-workspace.js ~/work/demo --name demo --groups Research,Workers");
  process.exit(1);
}

const wsPath = resolve(args[0].replace(/^~/, process.env.HOME));
let name = null;
let groups = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--name" && args[i + 1]) { name = args[++i]; }
  else if (args[i] === "--groups" && args[i + 1]) { groups = args[++i].split(",").map(g => g.trim()); }
}

name = name || basename(wsPath);
groups = groups || ["Workers"];

const hadronDir = resolve(wsPath, ".hadron");
const agentsDir = resolve(hadronDir, "agents");
const configPath = resolve(hadronDir, "config.json");

mkdirSync(agentsDir, { recursive: true });

if (existsSync(configPath)) {
  console.log(`Config already exists: ${configPath}`);
  console.log("Skipping — delete it first if you want to regenerate.");
} else {
  const config = { name, groups, groupConfig: {} };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Created: ${configPath}`);
  console.log(`  name: ${name}`);
  console.log(`  groups: ${groups.join(", ")}`);
}

// Install a sample agent so the first dashboard screen isn't empty. Rewrites the
// template's artifact paths to absolute paths under the repo's examples/ dir, so it
// works regardless of where the workspace lives relative to the repo.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const samplesDir = join(repoRoot, "examples");
const sampleSrc = join(samplesDir, "sample-agent.json");
const sampleDest = join(agentsDir, "hadron.json");

if (existsSync(sampleDest)) {
  console.log(`\nSample agent already present: ${sampleDest}`);
} else if (existsSync(sampleSrc)) {
  try {
    const agent = JSON.parse(readFileSync(sampleSrc, "utf-8"));
    if (Array.isArray(agent.artifacts)) {
      agent.artifacts = agent.artifacts.map((a) => {
        if (a.type !== "file") return a;
        const base = basename(a.value);
        return { ...a, value: join(samplesDir, base) };
      });
    }
    writeFileSync(sampleDest, JSON.stringify(agent, null, 2) + "\n");
    console.log(`\nInstalled sample agent: ${sampleDest}`);
  } catch (e) {
    console.log(`\nCould not install sample agent: ${e.message}`);
  }
}

console.log(`\nWorkspace ready. Start Hadron with:`);
console.log(`  node server/index.js ${wsPath}`);
