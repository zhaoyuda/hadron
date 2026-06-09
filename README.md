<p align="center">
  <img src="assets/logo.svg" width="88" height="88" alt="Hadron logo" />
</p>
<h1 align="center">Hadron</h1>
<p align="center"><em>Parallel Claude Code agents, one dashboard.</em></p>

<p align="center">
  <img src="assets/screenshot.png" width="820" alt="Hadron dashboard" />
</p>

A web-based workspace for managing multiple AI coding agents in parallel. If you run several Claude Code (or similar) agents at once, Hadron gives you a single dashboard to see what they're all doing — each with its own terminal, file artifacts, notes, and automatic state tracking.

## Why Hadron?

Running multiple AI agents across different projects gets chaotic fast. You end up with a dozen terminal tabs, no idea which agent is thinking vs. blocked vs. done, and no way to see their output files side by side.

Hadron solves this by giving each agent a card on a shared deck. At a glance you can see: who's working, who's stuck waiting for input, who just finished, and what files they've produced. Click any card to jump into its full terminal — it's a real tmux session, not a sandbox.

## Key Features

- **Multi-agent dashboard** — See all agents at a glance, organized into groups. Automatic state detection shows who's working, idle, blocked, or done.
- **Real terminals** — Each agent runs in its own tmux session, rendered via xterm.js. Full terminal emulation, not a log viewer.
- **Artifact panel** — Attach files to any agent: Markdown (rendered), Python (syntax-highlighted, editable via vim), CSV (table view), SQL, Jupyter notebooks, and Marimo notebooks.
- **Live artifacts** — File artifacts auto-reload when changed on disk. Marimo notebooks support `--watch`, and notebook state survives agent switches.
- **Kernel config** — Configure which Python environment runs marimo/Jupyter per workspace, via the `/hadron-notebook-kernel` skill.
- **Notifications** — Sound + banner alerts when agents change state. Configurable: sound+banner, banner only, or off (View > Notifications).
- **Agent lifecycle** — Create, archive, restore, and permanently delete agents from the menu. Agents persist as JSON files — no database needed.
- **Groups & organization** — Organize agents into named groups (e.g., "DevOps", "Workers"). Drag to reorder. Lock groups to prevent ad-hoc additions.
- **Shell tabs** — Each agent can have multiple shell tabs (Alt+T) for parallel terminal work within one agent.
- **Keyboard-driven** — Switch agents (Alt+1-9), navigate (Alt+H/L), manage tabs (Alt+J/K), reload artifacts (Ctrl+Shift+R).
- **Remote-friendly** — Works great over SSH tunnels. Run on a cloud server, tunnel port 3000, use from anywhere.
- **Theme system** — Default dark theme + Age of Exploration (大航海時代) theme with pixel art crew sprites and RPG-style status dialogs.

## Quick Start

Hadron is AI-native: the only thing you install by hand is [Claude Code](https://claude.com/claude-code). It sets up the rest.

```bash
git clone https://github.com/zhaoyuda/hadron.git && cd hadron
claude            # then type:  /hadron-setup
```

The `/hadron-setup` skill checks your prerequisites, installs anything missing for your OS, scaffolds a workspace, starts the server, and opens the dashboard with a sample agent card ready to start.

**Mental model:** one server process watches one *workspace* directory (where `.hadron/` config lives). Each *agent* is a named tmux session with its own terminal, attached files (*artifacts*), and notes. The browser dashboard and the `hadron` CLI both talk to the server's HTTP API — the CLI is just a thin, authenticated client you (or an agent) can script.

**Manual install** (if you'd rather not let the agent run package managers):

```bash
# macOS:        brew install node tmux
# Debian/Ubuntu: sudo apt-get install -y nodejs npm tmux
npm install
npm link                                 # put the `hadron` CLI on PATH
hadron skills sync                       # symlink operation skills into ~/.claude/skills/ so agents in any repo can use them
npm run setup:check                      # verify node>=18, tmux>=3, port free
node scripts/setup-workspace.js ~/work   # scaffold workspace config + sample agent
node server/index.js ~/work              # start server, then open http://localhost:3000
```

## Requirements

- **Node.js** >= 18
- **tmux** >= 3.0
- macOS or Linux (uses `node-pty` for terminal emulation)
- **Claude Code** (recommended for setup and as the AI agent running inside Hadron)

### Optional

- **vim** for text file editing (Ctrl+Shift+V / Cmd+Shift+V)
- **Python 3** + **Jupyter** for live notebook editing
- **Marimo** for reactive notebook rendering
- **uv** for fast Python environment creation (used by `/hadron-notebook-kernel` skill)

## How It Works

### Workspace

The server takes a workspace directory as its argument (defaults to `process.cwd()`). All configuration lives in `<workspace>/.hadron/`:

```
~/work/.hadron/
  config.json       # Workspace name, group order, group attributes, kernel config
  agents/
    agent-name.json  # Per-agent config: group, artifacts, state, notes
```

Each agent gets a tmux session named `hadron-<workspace>-<agent-id>`. Shell tabs are sub-sessions named `hadron-<workspace>-<agent-id>-sh<N>`.

You can also set the workspace via environment variable:

```bash
HADRON_WORKSPACE=~/work node server/index.js
```

Priority: CLI argument > `HADRON_WORKSPACE` > `process.cwd()`

### State Detection

Hadron automatically detects what each agent is doing by polling its tmux pane:

| State | How it's detected |
|---|---|
| **idle** | Shell prompt (`❯`) visible, no activity |
| **working** | Claude process running + thinking/streaming indicators, tool execution, background agents |
| **blocked** | Permission dialog waiting for input, API errors (429, overloaded) |
| **done** | Claude process exited after a working session |

State detection resolves the actual tmux pane ID at startup (handles `base-index=1`), filters autocomplete suggestions, and ignores non-blocking surveys. Process-level signals are used as a fallback when terminal output formats change.

### Live Artifacts

File-based artifacts (`.py`, `.sql`, `.md`, `.csv`, etc.) are monitored for changes via mtime polling. When a file is modified on disk — by another agent, vim, or any editor — the artifact view auto-reloads within 3 seconds.

Marimo notebooks run with `--watch`, so cell edits on disk are picked up by the running marimo server automatically.

Iframe-based artifacts (live marimo/Jupyter) persist their state when you switch between agents — they're moved to an offscreen pool instead of being destroyed.

### Kernel Config

Notebook artifacts (marimo, Jupyter) run against a per-workspace Python environment, configured in `.hadron/config.json`. Use the `/hadron-notebook-kernel` skill to detect, create (via `uv` or `python3 -m venv`), and switch environments — the **Kernel** menu in the menubar shows the current one.

### Supported Artifacts

Artifacts are files linked to an agent, rendered in the right-side panel based on extension:

| Extension | Renderer |
|---|---|
| `.md`, `.markdown` | Markdown preview (toggle raw/preview with Cmd+Shift+V) |
| `.py` | Syntax-highlighted Python; editable via vim |
| `.py` (marimo) | Marimo reactive notebook (live editor with `--watch`) |
| `.csv` | Table view with headers |
| `.sql` | Syntax-highlighted SQL |
| `.ipynb` | Jupyter notebook viewer (cells + outputs, live editor) |
| `.html` | Rendered in sandboxed iframe |
| Other | Vim editor with syntax highlighting |

> Full configuration reference (config.json fields, agent JSON schema, path resolution, multi-project setup) → [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Alt+1-9 (Option+1-9) | Switch to agent by position |
| Alt+H / Alt+L | Previous / next agent |
| Alt+T | New shell tab |
| Alt+J / Alt+K | Previous / next shell tab |
| Cmd+Shift+V | Toggle markdown preview |
| Ctrl+Shift+R | Reload current artifact |

## Claude Code Skills

Hadron includes Claude Code skills that agents can invoke:

| Skill | Description |
|---|---|
| `/hadron-setup` | First-run setup — verify prerequisites, scaffold a workspace, start the server |
| `/hadron-whoami` | Detect agent identity, load config, understand role in the workspace |
| `/hadron-spawn` | Turn intent into a briefed, auto-started agent |
| `/hadron-artifacts` | Attach output files to this agent so they show in the dashboard |
| `/hadron-notebook-kernel` | Configure Python environment for marimo/Jupyter (detect, create, switch envs) |

Skills live in this repo, but Claude Code only discovers skills user-globally or up to the current repo's root — so agents in *other* repos can't see them until they're linked into `~/.claude/skills/`. `hadron skills sync` does that (the server also self-heals on startup, additively linking any missing skills — it never touches your own skills). Links are **symlinks, not copies**, so skill updates flow through automatically on `git pull`. `/hadron-setup` is the exception: it's the bootstrap, run from the repo and never linked. If you have multiple Hadron checkouts, the first one to create a link wins; others leave it alone and `hadron skills status` reports it as a conflict.

```bash
hadron skills install     # symlink operation skills into ~/.claude/skills/ (additive)
hadron skills sync        # like install, but also prune our own dead links
hadron skills status      # show link state per skill (linked / not installed / conflict)
hadron skills uninstall   # remove our links
```

## Deploying Remotely

The server binds `127.0.0.1` by default, so the simplest remote setup is an SSH tunnel — no need to expose the port:

```bash
# On the remote server
cd /path/to/hadron
npm install
node server/index.js ~/work &

# From your local machine — forwards your localhost:3000 to the server's
ssh -L 3000:localhost:3000 user@server
open http://localhost:3000
```

To reach it directly over Tailscale/LAN instead of a tunnel, bind to all interfaces with `HADRON_HOST`:

```bash
HADRON_HOST=0.0.0.0 node server/index.js ~/work &
open http://<tailscale-ip>:3000
```

The auto-generated token (`.hadron/token`) still gates every mutating request, but only expose the port on a trusted network (e.g. Tailscale), never the public internet.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full roadmap. Current version: **v0.7**.

## Architecture

```
server/
  index.js          # Express + WebSocket server, tmux management, marimo/jupyter proxy
  state-detector.js # Automatic agent state detection from tmux pane content
  agent-store.js    # Agent persistence (JSON files)
client/
  index.html        # Single page app shell
  app.js            # All frontend logic (vanilla JS, no framework)
  style.css         # Dark theme styles
scripts/
  setup-workspace.js # Interactive workspace initializer
```

### Design Decisions

- **Vanilla JS** — no React/Vue/build step. Single `app.js` file.
- **tmux backend** — agents run in tmux sessions, terminals rendered via xterm.js over WebSocket.
- **File-based persistence** — agent state is JSON files, no database needed.
- **Dark theme** — GitHub-dark palette (`#0d1117` background).
- **Skills over UI** — complex config (kernels, onboarding) is handled by Claude Code skills, keeping the UI simple.

## License

[MIT](LICENSE) © Yuda Zhao
