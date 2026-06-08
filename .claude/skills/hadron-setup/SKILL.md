---
name: hadron-setup
description: First-run setup for Hadron. Verifies prerequisites (node, tmux, free port), installs what's missing for the current OS, scaffolds a workspace, starts the server, and opens the dashboard. Use right after someone clones the repo.
---

# Hadron Setup

Goal: get a freshly cloned Hadron from zero to a live dashboard with a sample agent card (which the user can start), in a few minutes. You orchestrate; adapt commands to the user's OS. Confirm before installing system packages or starting long-running processes.

## 1. Preflight (deterministic)

Run the bundled check — it installs nothing, just reports pass/fail:

```bash
npm run setup:check
```

It verifies: **node ≥ 18**, **tmux ≥ 3.0**, **Claude Code on PATH**, the chosen port is free, and whether a `.hadron/` config already exists. Fix anything it flags before continuing.

## 2. Install what's missing

Only for items the preflight flagged. Pick the right manager for the OS — **ask the user before running `sudo`**:

```bash
# macOS (Homebrew)
brew install node tmux

# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y nodejs npm tmux
```

Then project deps (always needed on a fresh clone):

```bash
npm install
```

## 3. Scaffold a workspace

Ask the user which directory should be the workspace root (where `.hadron/` config lives and where agents work) and how they want to group agents. Then let the deterministic scaffolder write the config:

```bash
node scripts/setup-workspace.js ~/work --name work --groups "Workers,Research"
```

This also installs a sample agent so the first screen isn't empty. Safe to re-run; it won't overwrite an existing config.

## 4. Start the server

```bash
node server/index.js ~/work
```

Binds `127.0.0.1:3000` by default (set `PORT` for another port; set `HADRON_HOST=0.0.0.0` only to expose on the LAN — it'll warn). A workspace token is generated at `.hadron/token` (gitignored, 0600) and used automatically by the browser and the `hadron` CLI.

For a second workspace on another port:

```bash
PORT=3001 node server/index.js ~/work/other-project
```

## 5. Verify

Open `http://localhost:3000`. The user should see the dashboard with the sample agent. To make it feel live immediately, spawn a demo agent (or run the **hadron-spawn** skill):

```bash
hadron spawn "Hello Hadron" --launch shell --start
```

## 6. Hand off

Tell the user: agents are created from the **Agents** menu (or `hadron spawn`); each agent has its own terminal, artifacts, and notes; inside any agent, `/hadron-whoami` loads that agent's context. Optional: configure a notebook kernel with **hadron-notebook-kernel**.
