# Hadron Demo abc

A web-based AI agent workspace for managing **multiple Claude Code agents**.

## Features

- Agent deck with drag-and-drop reordering
- Multi-terminal shell tabs (`Alt+T`)
- State detection: `working`, `blocked`, `done`, `idle`
- Related agents with expandable artifacts

## Architecture

```
client/          Frontend (vanilla JS)
  app.js         Main application logic
  style.css      Dark theme styles
server/          Node.js backend
  index.js       Express + WebSocket server
  state-detector State polling via tmux
```

## Quick Start

```bash
npm start -- /path/to/workspace
```

| Component | Tech |
|-----------|------|
| Terminal | xterm.js + tmux |
| Backend | Express + ws |
| State | tmux pane polling |

> **Note**: All agents run in persistent tmux sessions that survive page refreshes.

---

### TODO

- [x] Drag and drop reorder
- [x] Shell tabs
- [ ] Markdown preview
- [ ] Python syntax highlighting
- [ ] Marimo notebook support
