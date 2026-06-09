# Configuration Reference

Full configuration reference for Hadron. For setup, see the [README](../README.md).

## Workspace Config (`<workspace>/.hadron/config.json`)

This file controls the workspace name, group ordering, group-level attributes, and kernel config.

```json
{
  "name": "work",
  "groups": ["DevOps", "Workers", "Backup"],
  "groupConfig": {
    "DevOps": { "expandable": false }
  },
  "kernels": {
    "marimo": "/home/user/work/.venv"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name shown in the top bar |
| `groups` | string[] | Ordered list of group names. Controls left-to-right display order in the deck. |
| `groupConfig` | object | Per-group attribute overrides (see below) |
| `kernels` | object | Python environment paths for notebook runtimes (see [Kernel Config](#kernel-config)) |

**Group attributes** (set inside `groupConfig.<GroupName>`):

| Attribute | Default | Description |
|---|---|---|
| `expandable` | `true` | When `false`, the "+" button is hidden and no new agents can be added to this group via the UI. |

## Agent Config (`<workspace>/.hadron/agents/<id>.json`)

Each agent is a JSON file. Agents are created from the UI (Agents > New Agent, or the "+" button in a group), but you can also create them manually:

```json
{
  "id": "homelab",
  "name": "homelab",
  "group": "DevOps",
  "state": "idle",
  "artifacts": [
    { "label": "README", "type": "file", "value": "homelab/README.md" }
  ],
  "notes": "",
  "deletable": false
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier. Also used as the tmux session name (`hadron-<id>`). |
| `name` | string | Display name (shown in deck and work header). |
| `group` | string | Which group this agent belongs to. Must match a name in `config.json`'s `groups` array. |
| `state` | string | Current state: `idle`, `working`, `blocked`, or `done`. Automatically detected. |
| `artifacts` | array | List of files shown in the context panel. Each has `label`, `type` (`file`), and `value` (file path). |
| `notes` | string | Free-text notes for this agent. |
| `deletable` | boolean | Default `true`. Set to `false` to prevent archiving/deletion. |
| `cwd` | string | Working directory for this agent's terminal. Defaults to workspace root. |
| `archived` | boolean | When `true`, agent is hidden from the deck. Restorable from Agents > Restore Agent. |

## Artifact Paths

Artifact paths can be **absolute** (`/home/user/work/file.md`), home-relative (`~/work/file.md`), or **relative to the workspace root** (`project/file.md`). Relative paths are recommended for portability.

See the [README](../README.md#supported-artifacts) for the extension-to-renderer table.

## Kernel Config

Hadron uses a per-workspace Python environment for launching marimo and Jupyter. Configuration lives in `.hadron/config.json`:

```json
{
  "kernels": {
    "marimo": "/home/user/work/.venv",
    "jupyter": "/home/user/work/.venv"
  }
}
```

Use the `/hadron-notebook-kernel` Claude Code skill to detect available environments, create new ones (via `uv` or `python3 -m venv`), and update the config. The **Kernel** menu in the menubar shows the current environment at a glance.

## Sample Agent with All Artifact Types

The repo includes sample files in `examples/` demonstrating supported artifact types:

- `examples/demo.md` — Markdown with headers, code blocks, lists
- `examples/demo.py` — Python script with syntax highlighting
- `examples/demo.csv` — CSV table rendered as a grid
- `examples/demo.sql` — SQL query with syntax highlighting
- `examples/demo.ipynb` — Jupyter notebook with cells and outputs
- `examples/demo_notebook.py` — Marimo reactive notebook with charts

## Multiple Projects

Run separate Hadron instances on different ports:

```bash
node server/index.js ~/work/demo &                # port 3000
PORT=3001 node server/index.js ~/work &           # port 3001
```

Each instance shows its workspace name in the browser tab title. Tmux sessions are namespaced per workspace, so they don't collide.
