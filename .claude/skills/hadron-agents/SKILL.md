---
name: hadron-agents
description: Manage sibling Hadron agents from inside your own session — list, message, pin, close/archive, restore — via the `hadron` CLI. Use when the user asks you to coordinate with, hand off to, or clean up other agents.
---

# Manage Sibling Agents

You are one of several agents on a Hadron dashboard. The `hadron` CLI lets you operate on your siblings — always through it, never raw curl or tmux.

Every command that takes a target accepts an agent **id or its exact name** (case-insensitive). An ambiguous or unknown name exits with a candidate list — nothing is guessed, nothing is delivered.

## See who's around

```bash
hadron ls              # live agents: name, id, group, state
hadron ls --archived   # archived agents (id, name, group, archivedAt)
```

## Message another agent

```bash
hadron message "Auth Refactor" "The token schema moved to server/auth.js — rebase before you continue."
cat brief.md | hadron message worker-2 -    # multiline brief from a file
```

- **Only message siblings when the user asked for coordination.** Never set up automatic agent-to-agent chatter, relays, or reply loops — messaging is explicit and one-shot.
- Your message is delivered with an attribution prefix (`[hadron message from <name> (<id>)]`) so the receiver knows who sent it. `--raw` drops the prefix.
- It's fine to message a **working** agent — Claude Code queues composer input; don't wait for it to go idle.

## Pin / unpin

Pinned agents surface in a "📌 Pinned" section at the front of the deck — use it to keep a long-running session visible for the user.

```bash
hadron pin "Data Pipeline"   # no arg = pin yourself
hadron unpin data-pipeline
```

## Close (archive) and restore

```bash
hadron close "Old Worker"          # kills its tmux session; agent JSON is kept as archived
hadron close worker-1 worker-2     # bulk cleanup — all names resolved before anything is touched
hadron close                       # archive YOURSELF — your terminal dies immediately
hadron restore "Old Worker"        # bring it back (searches the archive by name/id; also takes several)
```

- Close is a **soft archive** — nothing is lost; `hadron ls --archived` shows what's recoverable.
- **Permanent deletion is not a CLI verb** by design: agents must not be able to unlink agent records. The user does that from the dashboard (Agents → Delete Agent).
- Some agents are protected (`deletable: false`); closing them fails with a clear error — leave them alone.

## When to use this

- The user says "tell agent X ...", "hand this off", "pass this to the reviewer" → `hadron message`.
- The user says "we're done with X", "clean up the old agents" → `hadron close`, and mention it's restorable.
- The user wants an agent kept in view → `hadron pin`.
