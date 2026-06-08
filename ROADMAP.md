# Hadron Roadmap

## v0.1 — Foundation (done)
- [x] Agent deck with groups, drag-and-drop reorder
- [x] Terminal via tmux + xterm.js
- [x] Shell tabs (Alt+T to create)
- [x] State detection (working/idle/blocked/done)
- [x] Agent persistence (.hadron/agents/*.json)
- [x] Artifact rendering: Markdown, Python, CSV, SQL, Jupyter, Marimo
- [x] Vim editor for text files (Ctrl+Shift+V toggle)
- [x] Related agents section
- [x] Menu bar (View, Agents, Workspace)
- [x] Shortcut hint bar
- [x] Orphan tmux session detection + adopt/kill banner
- [x] Agent archive (soft delete) + restore
- [x] Agent permanent delete
- [x] Chrome-style menus with submenus (View, Agents, Workspace)
- [x] Configurable agent attributes (deletable)
- [x] Configurable group attributes (expandable)

## v0.2 — State Intelligence & Artifact System (done)
- [x] Robust state detection (3-layer: specific regex → broad fallback → process-level)
- [x] Compacting/Propagating detection (distinguished from thinking)
- [x] Claude prompt editor detection (vi editing claude-prompt-*.md → blocked)
- [x] Inconclusive debounce (prevents false working on Ctrl+G / typing)
- [x] Blocked → idle for "needs input" (not done — nothing to review)
- [x] State detection test suite (14 fixtures in test-fixtures/)
- [x] Sound notifications on state change (Web Audio API, distinct tones for blocked/done)
- [x] Browser tab title flashing when backgrounded
- [x] HTML artifact rendering (iframe, sandboxed)
- [x] VS Code-style file type icons (SVG, color-coded by extension)
- [x] Artifact directory grouping (collapsible folders)
- [x] Smart artifact suggestions (scan workspace, filterable list)
- [x] All files default to vim editor (special renderers only for MD/CSV/ipynb/Marimo)
- [x] Multi-workspace support (separate ports, tmux namespacing)
- [x] Workspace name in browser tab title
- [x] AI-guided onboarding via CLAUDE.md
- [x] Jupyter/Marimo server proxy (launch editor, render live notebooks)

## v0.3 — Theme System (大航海時代 / Age of Exploration) (done)
- [x] View > Theme menu with theme picker
- [x] Pixel art avatars for agents (CSS box-shadow sprites, state-based)
- [x] 12 unique crew characters (captain, navigator, merchant, etc.) with per-type palettes
- [x] RPG-style blocked agent substatus
- [x] Theme-aware color palette (nautical dark tones)
- [x] CSS sprite animations (idle bob, working pulse, blocked sway, done sparkle)
- [x] Chinese theme name in menu (大航海時代)
- [ ] Upgrade sprites to PNG/AI-generated (大航海時代4 style)

## v0.4 — Live Artifacts & Kernel Config (done)
- [x] State detection fixes (pane ID targeting, autocomplete filtering, survey false-positive)
- [x] Notification config (View > Notifications: sound+banner / banner only / off)
- [x] Artifact caching with iframe persistence (switch agents without losing notebook state)
- [x] Mtime-based auto-reload for file artifacts (3s polling, detects backend edits)
- [x] Ctrl+Shift+R manual artifact reload hotkey
- [x] Marimo `--watch` for live notebook editing
- [x] Marimo/Jupyter process lifecycle (orphan cleanup on startup, port allocation, SIGINT/SIGTERM handlers)
- [x] Kernel config system (per-workspace Python env for marimo/jupyter)
- [x] Kernel menu in menubar (shows current env, hints `/hadron-notebook-kernel`)
- [x] `/hadron-notebook-kernel` Claude Code skill (detect/create/configure Python envs)

## v0.5 — Connectors & Execution
- [ ] SQL connector config (menu item, connection presets)
- [ ] Ctrl+Enter to execute SQL with configured connector
- [ ] CSV editing support
- [ ] URL artifact type (Google Sheets, Slack links, Notion)
- [ ] Excel (.xlsx) artifact rendering
- [ ] `/onboarding` skill (git clone → claude → /onboarding, zero manual setup)

## v0.6 — Release Readiness (share with 3-5 friends)

Goal: a friend can `git clone` → `claude` → be productive, with no tribal knowledge. From the 2026-06-07 readiness audit (3 subagents).

### P0 — blockers (can't ship without)
- [x] Ship skills inside the repo — redesigned CLI-driven skill set (`hadron-setup`, `hadron-whoami`, `hadron-spawn`, `hadron-artifacts`, `hadron-notebook-kernel`) now in `hadron/.claude/skills/`.
- [x] Delete Claude-Squad legacy tree (commit 2ae1d69).
- [x] Resolve license — MIT (LICENSE.md + README); deleted stale claude-squad CONTRIBUTING/CLA + Go CI workflows.
- [x] Fix vim/TUI state false-positive — `#{alternate_on}` now fetched and threaded into `detectState`; alt-screen short-circuits blocked/done heuristics (except Claude's own prompt editor). `blocked` has ≥2-poll hysteresis; stale `blocked` is cleared when a non-agent process takes the pane. Covered by `altscreen-*` fixtures + `test-state-machine.js`.
- [x] Fix transient `done` false-positive + sluggish working detection — `working → done` now requires ≥2 consecutive shell-foreground reads (rides out tool-spawn blips). Working indicators are split strong (tool/agents/shells → trusted immediately, fixing slow idle→working) vs stale (thinking/streaming/compacting → still gated on content-change). Transition logic extracted into a pure `nextState` reducer with unit tests.
- [x] Preflight checks — `scripts/setup-check.js` + `npm run setup:check` verify node>=18, tmux>=3, deps, free port, Claude Code.
- [x] Install a sample agent on `setup-workspace.js` so first run isn't an empty dashboard (use `examples/sample-agent.json`).

### P1 — strongly recommended
- [x] Make "agent spawns agent + auto-starts task" actually work — autostart sends the launch command then types the task as literal keystrokes (no shell injection).
- [x] `/hadron-setup` skill — clone → claude → /hadron-setup does preflight, workspace setup, sample agent, server start, verify.
- [x] Fix per-agent `cwd` being ignored — pty spawn now uses `resolveAgentCwd(session)`; cwd constrained under workspace root.
- [x] Auto-discover artifacts — `/api/files/suggest?agentId=` scoring + `hadron artifacts add --auto` (one-shot add all `score>0`).
- [x] `/hadron-artifacts` skill — agent attaches its own output files via the CLI.

### P2 — can defer past release
- [ ] Light split of `client/app.js` (3803-line monolith; navigable, not a crisis)
- [ ] Harden remaining fragile state-detector patterns (English-keyword/glyph-dependent regexes, version-fragile spinner detection)
- [x] Scrub personal data from `server/test-fixtures/` (Tailscale IP, `/home/ubuntu/work` paths)
- [x] Review stray root dev files for public repo — removed `preview-theme.html`, `task.md`, `DESIGN.md`; `clean.sh`/`clean_hard.sh` already absent.

## Backlog

### Multi-project support (design notes)

**Current approach (v0.2):** Run separate server instances on different ports. Tmux sessions are namespaced by workspace (`hadron-<workspace>-<agent-id>`) so multiple instances don't collide.

**Long-term vision:** Single server, single port, project switcher in the UI.
- URL-based routing: `localhost:3000/ato`, `localhost:3000/work`
- Left-side project switcher dropdown (where workspace name is now)
- Each project has its own `.hadron/` config, agents, and groups
- Tmux sessions stay alive when switching away — UI just reconnects when you switch back
- Server manages multiple agent sets in memory, keyed by project
- Requires: route layer refactor, per-project state isolation in frontend, multi-config loading in agent-store

**When to build:** After v0.5 core features. The multi-port approach works fine for 2-3 projects.

### Other backlog items
- [x] Workspace root config (~/work as root, not per-project)
- [x] Tmux session namespacing by workspace (prevents multi-instance collisions)
- [ ] Upgrade sprites to PNG/AI-generated (大航海時代4 style)
- [ ] Agent templates (pre-configured agents with artifacts/groups)
- [ ] Search across agent terminals
- [ ] Agent activity timeline / history view
- [ ] Mobile-responsive layout
- [ ] Keyboard-driven agent switching (fuzzy finder)
- [ ] Plugin system for custom artifact renderers
- [ ] Git integration (branch/commit status per agent)
- [ ] Collaborative features (share workspace state)
- [ ] Structured state detection via Claude Code stream-json or Remote Control API (replace regex scraping)
- [ ] `/add-artifacts` AI skill (agent scans context and suggests relevant files)
- [ ] `/onboarding` skill (git clone → claude → /onboarding, zero manual setup)
- [ ] Primitive-surface consolidation (post-v0.6 refactor) — UI already calls the same REST API as the CLI will, so the layering (primitives → CLI → skills) is mostly there. Remaining cleanup: sink client-only orchestration (reorder, terminal split/layout, drag-drop) into composable server primitives; regularize state read path (poll vs WS push); ensure UI/CLI/skills share one documented API surface. Do this when building standup/capture (reviewer reads peer panes) — the missing primitives surface naturally then. NOT a release blocker; don't touch working create/close/state flows before sharing.
