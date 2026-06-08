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

## v0.5 — Connectors & Execution (dissolved)

Grouped before the supervision-cockpit thesis (below) was sharpened. Items redistributed — URL artifact → v0.7, CSV/dataframe → data-aware preview in v0.8 — or dropped: SQL execute & git-status (off-thesis), `/onboarding` (redundant with `/hadron-setup`), xlsx (backlog). See Deprioritized / Anti-roadmap.

## v0.6 — Release Readiness (share with 3-5 friends)

Goal: a friend can `git clone` → `claude` → be productive, with no tribal knowledge. From the 2026-06-07 readiness audit (3 subagents).

### P0 — blockers (can't ship without)
- [x] Ship skills inside the repo — redesigned CLI-driven skill set (`hadron-setup`, `hadron-whoami`, `hadron-spawn`, `hadron-artifacts`, `hadron-notebook-kernel`) now in `hadron/.claude/skills/`.
- [x] Resolve license — MIT (LICENSE + README).
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

## Product Thesis

Hadron is a **supervision cockpit for data/ML agent work** — not an orchestrator, not an autopilot. Many concurrent Claude Code agents produce notebooks, dataframes, charts, and analyses, where errors are *silent and compound*; the human stays in the loop to review and steer.

**Yardstick for every feature:** does it help the human *stay and steer / verify live DS work*? If it helps them *delegate and walk away*, that's a competitor's paradigm — skip it.

**Moat to invest in:** live data-aware artifacts + agent-as-context-unit (switch agent ⇒ terminal + artifacts + notes switch together) + web/any-device access + durable tmux sessions.

## v0.7 — Multi-screen & maintainability (released)

Daily-workflow wins; lay groundwork for the moat. Shipped in tag `v0.7`. The two
unchecked items below are intentionally ongoing — the `app.js` split continues
opportunistically, and state-detector hardening stays deferred until scraping
issues accumulate (see `design-notes/state-detection-approaches.md`); neither
gated the release.
- [x] **Multi-tab decouple** — active agent is now per-tab (no forced follow); cross-tab sync is keyed by session id, so per-agent tab/layout still mirrors *only* when two tabs show the same agent (keeps its one shared tmux pane a single size). Per-tab `sessionStorage` so each screen restores its own agent on reload. Enables dual-monitor "a different agent per screen."
- [~] **Incremental `app.js` split** (was a 3803-line monolith → 3552) — 4 cohesive modules extracted as ordered classic `<script>`s sharing global scope (no build step): `ui-sync.js` (cross-tab state sync), `theme.js` (sprite/avatar themes), `file-icons.js` (Seti-style icons), `markdown.js` (md/HTML preview + vim editor). Each green on e2e before the next. Remaining core blocks (render / deck / menus / terminal / websocket) are interdependent — extract opportunistically, not mechanically.
- [x] **URL artifact type** (Sheets / Notion / Slack links) — render/tab/sidebar/add-popover all wired.
- [x] **Status deck layout** — View ▸ Deck Layout ▸ Status re-buckets every agent by state (Blocked → Needs Review → Working → Idle), ignoring semantic groups, so whoever needs a human floats to the top. Supersedes the earlier "group state roll-up" idea (a status view answers "who needs me?" better than a collapsed-group glow).
- [x] **CSV raw-text editing** — Preview⇄Edit toggle (notepad textarea, delete/edit rows, save via `POST /api/file`); per-extension mode memory. (Not originally scoped here; see Deprioritized note.)
- [x] **UI polish** — (a) HTML *file* artifacts join the mtime auto-reload (iframe artifacts are currently excluded; live marimo/jupyter keep their own `--watch`); (b) tab labels truncate (max-width + ellipsis + hover title) and gain a file-type icon; (c) redesign file-type icons — distinct inline-SVG glyphs for md / sql / marimo / jupyter / csv / py / html / json, letter fallback for the long tail; (d) `hadron-artifacts` skill advises short labels.
- [ ] **Harden fragile state-detector regexes** (English-keyword/glyph-dependent, version-fragile spinner). Carried from v0.6 P2.

## v0.8 — The moat: artifact as a review surface

The differentiator. Spec each item when started; gather usage feedback first.
- [ ] **Data-aware preview** — CSV/dataframe: shape, null counts, dtypes, quick stats up top. Notebooks: surface errored/changed cells. Turns "render" into "catch silent errors fast." (Foundation the annotation loop anchors onto.)
- [ ] **Inline review → dispatch → resolve loop** — annotate an artifact (whole-doc or anchored region/cell/element), batch comments, flush them as one structured instruction into the agent's Claude session, mark resolved after it revises. Build the *review loop*, **not** a WYSIWYG editor.

## v0.9 — Durability & reach

- [ ] **Native agent session restore** — after a server restart/crash, resume the actual Claude session (`claude --resume=<id>`), not just the tmux shell. High self-use value for remote OCI long-runs.
- [ ] **Persistence hardening** — clean reconnect/restore so sessions + the artifact panel survive server restart and client detach/reattach.
- [ ] **Mobile read-only triage view** — phone-friendly "which agent needs me." The web architecture makes this nearly free (a mac app can't). Read/triage only, not a mobile IDE.
- [ ] **Notify on state-change (human-facing)** — fire a notification when an agent enters `blocked`/`done`. Human-facing only; NOT agent-self-orchestration via the API.

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

**When to build:** Multi-port works fine for 2-3 projects. Single-server switcher is a later convenience, not a thesis item.

### Other backlog items (pull when justified)
- [ ] **Notebook / data diff** — compare two agents' outputs, or one artifact before/after a rerun (schema drift, distribution shift, changed/errored cells). Strong moat fit but heavy; needs design.
- [ ] **RELATED → handoff view** + one-click "promote artifact to another agent's context." Human is the bus; no auto agent-to-agent. Confirm real planner→worker handoff frequency before building.
- [ ] Search across agent terminals
- [ ] Agent activity timeline / history view
- [ ] Agent templates (pre-configured agents with artifacts/groups)
- [ ] Keyboard-driven agent switching (fuzzy finder)
- [ ] Plugin system for custom artifact renderers
- [ ] `.xlsx` artifact rendering (low priority, not moat)
- [ ] Upgrade sprites to PNG/AI-generated (大航海時代4 style) — cosmetic, low priority
- [ ] Structured state detection via Claude Code stream-json / Remote Control API (replace regex scraping) — strategic but large; revisit when regex-detector pain justifies it
- [ ] Primitive-surface consolidation (post-v0.6 refactor) — sink client-only orchestration (reorder, terminal split/layout, drag-drop) into composable server primitives; regularize the state read path (poll vs WS push); one documented API surface for UI/CLI/skills. Surfaces naturally when building the review→dispatch loop. NOT a blocker; don't touch working create/close/state flows.

## Deprioritized / off-thesis (kept visible so we don't re-add by reflex)
- **SQL connector + Ctrl+Enter execute** — building a SQL IDE / human does the execution; off the "supervise agents" thesis.
- **CSV editing** — *raw-text quick-edit shipped* (Preview⇄Edit toggle: notepad-style textarea, delete/edit rows, save to disk via `POST /api/file`). The heavy spreadsheet-*grid* editor stays off-thesis — superseded by data-aware *preview* (we review, the agent edits).
- **Git integration (branch/commit per agent)** — cmux's code-diff/SWE turf; don't chase.

## Anti-roadmap (do NOT build)
- Multi-CLI (Codex/Gemini/Amp) — stay Claude-Code-native.
- Code diff / PR review / cloud sandboxes / auto-merge / ticket system — delegate-and-review paradigm.
- Full WYSIWYG / visual-manipulation editor — crowded turf, huge effort, makes the human do the work (we want annotate→agent-revises).
- Auto agent-to-agent messaging bus / agent self-orchestration via API — platform's job; removes the human.
- Terminal-native / TUI rewrite — opposite of our artifact-rendering bet.
- Chasing notification-polish parity with cmux — "good enough" is fine.
