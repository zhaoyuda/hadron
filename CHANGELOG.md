# Hadron Changelog — past roadmaps

Completed roadmap versions, moved here from [ROADMAP.md](./ROADMAP.md) to keep it
focused on current + future work. Newest first.

## v0.5 — Connectors & Execution (dissolved)

Grouped before the supervision-cockpit thesis was sharpened. Items redistributed — URL artifact → v0.7, CSV/dataframe → data-aware preview in v0.8 — or dropped: SQL execute & git-status (off-thesis), `/onboarding` (redundant with `/hadron-setup`), xlsx (backlog). See Deprioritized / Anti-roadmap in ROADMAP.md.

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

## v0.3 — Theme System (大航海時代 / Age of Exploration) (done)
- [x] View > Theme menu with theme picker
- [x] Pixel art avatars for agents (CSS box-shadow sprites, state-based)
- [x] 12 unique crew characters (captain, navigator, merchant, etc.) with per-type palettes
- [x] RPG-style blocked agent substatus
- [x] Theme-aware color palette (nautical dark tones)
- [x] CSS sprite animations (idle bob, working pulse, blocked sway, done sparkle)
- [x] Chinese theme name in menu (大航海時代)

(PNG/AI-generated sprite upgrade lives on in the ROADMAP.md backlog.)

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
