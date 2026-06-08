---
name: hadron-whoami
description: Detect if this Claude Code session is a Hadron-managed agent and load its context (group, task, artifacts, related agents, notes). Run on session start or whenever unsure about this agent's role.
---

# Hadron Agent Identity

Hadron runs several Claude Code sessions in parallel, each in its own tmux pane, and shows them on one dashboard. This skill tells you which agent *you* are and loads the context the user set for you.

## Detect + load

The `hadron` CLI resolves your identity by asking the server to map your tmux session — you never parse the session name yourself.

```bash
hadron whoami
```

- **`Not inside a tmux pane`** → this session is standalone, not a Hadron agent. Nothing more to do.
- **`Cannot reach Hadron`** → the server isn't running on this port (default 3000; set `HADRON_PORT` to change). You may still be an agent — mention it to the user.
- **Otherwise** it prints your name, id, group, state, task, cwd, artifacts, related agents, and the first line of your notes.

For the full record (all fields, multi-line notes):

```bash
hadron whoami --json
```

## What the fields mean

| Field | Meaning |
|---|---|
| `id` / `name` | Your identifier and display name in the deck |
| `group` | Your column (e.g. DevOps, Workers) — hints at your purpose |
| `task` | What the user assigned you (may be empty) |
| `artifacts` | Files the user linked for you — **your key working files. Read them early.** |
| `relatedAgents` | Other live agents you should coordinate with / avoid conflicting with |
| `notes` | Free-text context from the user |
| `cwd` | Your working directory if different from the workspace root |

## What to do with it

1. Read your artifacts before starting — they're your brief.
2. Be aware of related agents; don't edit the same files blindly.
3. Keep responses focused — the user is watching multiple agents at once.
4. When you produce a key output file, attach it so the user sees it: run the **hadron-artifacts** skill, or `hadron artifacts add <path>`.
5. Record durable context for yourself with `hadron notes set "…"` / `hadron notes append "…"`.
