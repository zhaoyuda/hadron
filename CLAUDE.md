# Hadron — Project Instructions

## What is this

Hadron is a web-based workspace for managing multiple AI coding agents in parallel. Each agent gets its own tmux terminal, file artifacts, notes, and automatic state detection. See `README.md` for full feature list and configuration reference.

## First-time setup (onboarding)

If the user just cloned this repo or pulled it onto a new machine, **invoke the `/hadron-setup` skill** — it's the orchestrator for onboarding and walks through prerequisites, install, workspace scaffold, server start, and verification. The steps below are the contract that skill follows (and a manual fallback if the skill isn't available):

1. **Preflight**: Run `npm run setup:check` — deterministic verification of `node` (>=18), `tmux` (>=3.0), Claude Code on PATH, free port, and `.hadron/` config. It installs nothing; fix whatever it flags.
2. **Install dependencies**: Run `npm install` if `node_modules/` doesn't exist. Install `node`/`tmux` via the OS package manager only after confirming with the user.
3. **Ask for workspace root**: Ask the user which directory they want as their workspace root. This is where `.hadron/` config will live and where agents work. Examples: `~/work` (all projects), `~/work/demo` (single project). The user can run multiple Hadron instances for different workspaces on different ports.
4. **Create workspace config**: Run `node scripts/setup-workspace.js <path>` with the user's answers (it also installs a sample agent). Ask them:
   - Workspace name (defaults to directory basename)
   - Group names (defaults to "Workers" — suggest they think about how they want to organize agents)
5. **Start the server**: `node server/index.js <workspace-path>`. Binds `127.0.0.1` by default; a token is auto-generated at `.hadron/token`. For a second workspace, use `PORT=3001 node server/index.js <other-path>`.
6. **Verify**: Open `http://localhost:3000` in a browser. The user should see the Hadron dashboard with the sample agent. They can create agents from the Agents menu or `hadron spawn`.

## Agent awareness (when running inside Hadron)

If this Claude Code session is itself a Hadron-managed agent (running inside a `hadron-*` tmux session), run `/hadron-whoami` on session start to load your identity, task, artifacts, and related agents. Use the `hadron` CLI (`bin/hadron.js`) — not raw curl — for agent operations: `hadron whoami`, `hadron spawn`, `hadron artifacts add`, `hadron notes`.

### Multi-workspace setup

If the user needs multiple workspaces (e.g., one per project):

```bash
# Each workspace gets its own port and .hadron/ config
node server/index.js ~/work/demo &           # port 3000
PORT=3001 node server/index.js ~/work &     # port 3001
```

Tmux sessions are namespaced by the workspace *directory basename* (e.g., `~/work/demo` → `hadron-demo-agent1`, `~/work` → `hadron-work-agent1`), so there are no conflicts.

## Project structure

```
server/
  index.js            # Express + WebSocket server, tmux management, file API
  state-detector.js   # Polls tmux panes to detect agent state (idle/working/blocked/done)
  agent-store.js      # Agent persistence — reads/writes JSON files in <workspace>/.hadron/agents/
client/
  index.html          # Single page app shell
  app.js              # All frontend logic (vanilla JS, no framework)
  style.css           # Dark theme styles
examples/             # Demo artifact files (md, py, csv, sql, ipynb) + sample-agent.json
scripts/
  setup-workspace.js  # Interactive workspace initializer
test/
  unit/               # detectState/nextState fixtures + security HTTP suite (npm test)
  e2e/                # Playwright browser modules M1-M18 (npm run test:e2e)
```

## Conventions

- Use `python3`, never `python`; `python3 -m pip`, never bare `pip`
- Node.js: ES modules (`"type": "module"` in package.json)
- Keep dependencies minimal — vanilla JS on frontend, no React/Vue
- Dark theme: GitHub-dark palette (`#0d1117` background)

## Key concepts

- **Workspace**: A directory (e.g., `~/work`) containing `.hadron/` config. All agent file paths can be relative to this root.
- **Agent**: A named unit of work with its own tmux session, artifacts, notes, and state. Persisted as `.hadron/agents/<id>.json`.
- **State detection**: The server polls each agent's tmux pane every 2s, pattern-matching Claude Code output to determine state (idle/working/blocked/done). See `server/state-detector.js`.
- **Artifacts**: Files attached to an agent, rendered in the right panel. Paths can be absolute, `~/`-relative, or workspace-relative.
- **Tmux namespacing**: Sessions are named `hadron-<workspace-basename>-<agent-id>` (the workspace *directory basename*, not the configurable display name) to prevent collisions between multiple Hadron instances.

## Running Hadron

```bash
# Install dependencies
npm install

# Start with a workspace root
node server/index.js ~/work

# Or use environment variable
HADRON_WORKSPACE=~/work npm start

# Multiple instances on different ports
node server/index.js ~/work/demo &          # port 3000 (default)
PORT=3001 node server/index.js ~/work &    # port 3001
```

## Testing

```bash
# Full suite (no external services; spins up a throwaway server + tmux internally)
npm test
#   = test-state-eval.js   (detectState snapshot fixtures)
#   + test-state-machine.js (nextState reducer — temporal transitions)
#   + test-security.js      (auth, cwd policy, injection, concurrency over HTTP)
#   + test-annotations.js / test-message.js / test-upload.js (v0.8 surfaces)
#   + test-resume.js        (v0.9 auto-resume gate: checkpoint, tombstone, scrape validation)
#   + test-file-revision.js (conditional /api/file writes: revision, 409 conflict, atomicity)
```

Individual suites can be run directly, e.g. `node test/unit/test-state-eval.js`.
`test/unit/test-state-detector.js` is a separate live integration harness that
expects an already-running server on localhost:3000.

### End-to-end module tests (browser)

```bash
npm run test:e2e   # requires: npx playwright install chromium (one-time)
#   = test/e2e/m1-onboarding.js  (fresh workspace boots → dashboard paints)
#   + test/e2e/m2-lifecycle.js   (create agent → terminal connects + round-trips)
#   + test/e2e/m3-agent-mgmt.js  (CLI spawn → group + artifacts + mutual related link)
#   + test/e2e/m4-artifacts.js   (editor WS close → vim tmux reaped; shells preserved)
#   + test/e2e/m5-data-preview.js (CSV stats strip + notebook error/changed cells)
#   + test/e2e/m6-copy.js        (Copy/Download buttons + tab context menu)
#   + test/e2e/m7-editor.js      (text/vim editor toggle, save, paste-image flow)
#   + test/e2e/m8-annotations.js (review loop: comment → send → resolve → reopen)
#   + test/e2e/m9-artifact-reload.js (mtime poller baseline + HTML update pill, tab & split)
#   + test/e2e/m10-clipboard.js  (OSC 52 from pane → browser clipboard; read-request ignored)
#   + test/e2e/m11-terminal-paths.js (clickable terminal path → resolve vs pane cwd → open as current agent's artifact)
#   + test/e2e/m12-artifact-folders.js (artifact folder collapse persists across the 3s deck refresh)
#   + test/e2e/m13-command-palette.js (⌘K palette: fuzzy switch agents / open artifacts / add files via suggest)
#   + test/e2e/m14-group-case.js (agent groups are case-insensitive: "Workers"/"workers" merge into one deck group; rename re-tags every casing)
#   + test/e2e/m15-md-links.js (clicking a link in a rendered .md preview opens the target as an artifact tab; external → new tab; missing → flash)
#   + test/e2e/m16-editor-drafts.js (editor draft model: preview renders draft, reload restores it, agent-write → Save 409s with Compare/Overwrite/Cancel, Discard confirms)
#   + test/e2e/m17-annotation-ux.js (annotation UX: FAB follows the selection; cross-block/formatted/duplicate/overlapping selections anchor + paint honestly; hover card edit, sent read-only; CLI excerpt for formatted anchors; marks survive auto-reload — runs at a <560px preview so the P0 surfaces stay authoritative)
#   + test/e2e/m18-comment-rail.js (comment rail: cards permanently visible at ≥560px previews (width-adaptive 190-260px — split panes qualify), aligned with highlights; rail composer + in-rail edit/delete; mark↔card two-way linking; orphan + doc sections; annRailBusy edit guard; split-layout context derivation; <560px falls back to the P0 hover card)
```

`npm run test:e2e` runs `test/e2e/run-all.js`, which executes every `m*.js`
module regardless of individual failures and exits non-zero only on an
*unexpected* failure. M10 (OSC-52 clipboard) is a documented `XFAIL` in that
runner — it fails identically on main (headless-chromium can't complete the
`navigator.clipboard.writeText` bridge) so it prints but doesn't gate the suite.
This replaced the old `m1 && m2 && …` chain, where M10's failure aborted before
M11–M18 ran (a real regression could hide behind it). Remove M10 from `XFAIL`
the moment the clipboard bridge is fixed — a stale xfail hides regressions too.

Kept out of `npm test` so the core suite stays fast and dependency-free
(Playwright pulls a ~300MB browser). Screenshots land in `test/e2e/screenshots/`
(gitignored). Each `test/e2e/m*.js` is a plain node script using `test/e2e/harness.js`
(`bootWorkspace()` → throwaway workspace + server on a free port).

**Testing convention — two axes:**
- **Modules** (a user-journey slice, one file each): M1 onboarding, M2 agent
  lifecycle, M3 agent management (CLI/skill mechanics), M4 artifacts (editor
  tmux lifecycle). Add modules as files; don't build a framework around them.
- **Technique** (chosen per check, cheapest that proves the truth): *script*
  (curl/CLI/API/state) for anything checkable without rendering; *browser*
  (Playwright + screenshot) for UI-only truths — terminal actually renders,
  menus open, artifacts paint.

Start each module light (golden path) and **grow coverage when a real bug
exposes a gap** — e.g. M2's terminal round-trip exists because a host-allowlist
bug shipped past every non-browser test. **Always run all modules** (they're
fast); the split is for authoring + locating failures, not selective runs.

**Before a major version release**, review which modules need new coverage for
what changed, and run `npm test` + `npm run test:e2e`.

## Development workflow

1. Read `ROADMAP.md` for the current roadmap
2. Implement and test (run the server, open in browser)
3. Update `ROADMAP.md` if completing roadmap items

## Deploying to prod (standard flow)

Risky changes (server-side, state detection, editor/save paths) go through
staging first:

1. Branch in the staging worktree (`/home/ubuntu/hadron-staging`, own systemd
   unit `hadron-staging` on :3001, workspace `/home/ubuntu/staging-ws` with
   canary agents) — `sudo systemctl restart hadron-staging` to pick up server
   changes.
2. `npm test` + `npm run test:e2e` in the worktree. The runner reports M10 as
   `XFAIL` (known headless-chromium clipboard issue, fails identically on main)
   and exits 0 when it's the only failure — so a green run means M1–M9, M11–M18
   all passed. Any `FAIL` (non-xfail) gates the branch.
3. `scripts/predeploy-check.sh` — live-fire proof on staging that a service
   restart does NOT interrupt running agents (claude PIDs survive, a
   mid-response canary keeps working, no auto-resume fires), plus prod-unit
   config sanity (KillMode=process, boot-enabled). Do not restart prod if it
   fails.
4. Check no prod agent is `working`, then: merge → main, `git push`,
   `sudo systemctl restart hadron`.
