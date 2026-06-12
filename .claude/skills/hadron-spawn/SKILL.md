---
name: hadron-spawn
description: Turn a request like "spin up an agent to do X" into a briefed, auto-started Hadron agent. Use when the user wants to delegate work to a new parallel agent.
---

# Spawn a Hadron Agent

Create a new agent, give it a task, and launch it — all through the `hadron` CLI. The CLI handles auth and talks to the server; you never write tmux or curl directly.

## Gather intent first

Before spawning, settle on:
- **name** — short, human-readable (e.g. "Auth Refactor"). The server slugifies it into an id.
- **task** — the one-line brief the agent boots with.
- **group** — which column (run `hadron ls` to see existing groups; default is `Workers`).
- **launch** — `claude` (default, an AI agent), `codex`, or `shell` (a plain terminal).
- **cwd** — optional subdirectory under the workspace to work in.

## Spawn it

```bash
hadron spawn "Auth Refactor" \
  --group Workers \
  --task "Extract the session-token logic out of middleware into its own module; add tests." \
  --launch claude \
  --start
```

- `--start` auto-launches the agent and types the task as its first message. Omit it to create the agent idle (the user starts it from the dashboard).
- `--cwd subdir` scopes the agent to a directory inside the workspace (must already exist).
- `--related a,b` links sibling agents so they're aware of each other.
- `--artifact path/to/brief.md` attaches a file the new agent should read first.

## After spawning

1. Confirm it appears: `hadron ls`.
2. Tell the user the agent name + id and that it's running.
3. If this agent and the new one should coordinate, the link is mutual context — mention it.
4. To deliver a longer brief or follow-up prompt to an agent that's already running, use `hadron message <id> "..."` (or `cat brief.md | hadron message <id> -`) — it's the reliable way to paste multiline text into a live session.

## Notes

- `--launch` is an enum (`claude|codex|shell`) — you can't pass an arbitrary command. The task is delivered as keystrokes, never glued into a shell string, so any task text is safe.
- Spawning the same name twice is rejected (409) — names are unique among live agents. A previously archived name can be reused; its old flags are cleared on respawn.
