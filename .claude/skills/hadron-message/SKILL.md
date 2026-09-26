---
name: hadron-message
description: Send a message, prompt, follow-up, question, or handoff to another Hadron agent that is already running — and actually submit it. Use whenever you need to talk to, wake, unblock, redirect, or ask something of another agent (e.g. "tell the reviewer to start", "ask the worker for its status", "hand this off to the planner").
---

# Message a Running Hadron Agent

Talking to another agent is **one command**:

```bash
hadron message <agent-id> "Your prompt here."
```

That delivers the text into the target's input box *and presses Enter*, so the agent
actually starts working. Find the id with `hadron ls`.

## Do not hand-roll tmux

`tmux send-keys` looks like it would work and is the single most common way this goes
wrong: the text lands in the target's prompt box but is **never submitted**, so the
agent sits there with a full prompt typed and does nothing. From the dashboard it looks
delivered. It isn't.

`hadron message` exists precisely to avoid that. It pastes via a tmux buffer (bracketed
paste, so multiline text can't self-submit line-by-line) and then sends Enter as a
separate keystroke after a short delay, once the TUI has absorbed the paste.

So:

- ✅ `hadron message reviewer-t113 "Start the review; the spike is at spikes/model/…"`
- ❌ `tmux send-keys -t hadron-reviewer-t113 "Start the review"` — types, never submits
- ❌ `hadron notes set --agent reviewer-t113 "…"` — notes are **passive context**, not a
  message. Nobody reads them until that agent's next turn. They never wake anyone.

## Long or multiline briefs

Don't cram a brief into an argument. Write it to a file and pipe it:

```bash
cat brief.md | hadron message reviewer-t113 -
```

Any length, any special characters — the text reaches tmux through a temp file, never
through argv or a shell.

## Options

| Flag | Effect |
|---|---|
| *(default)* | Deliver **and submit**. This is what you want. |
| `--no-enter` | Deliver without submitting — leaves the text sitting in the input box. Only for staging something a human will review and send. |

## Failure modes

- **`agent tmux session … is not running` (409)** — the agent exists but isn't started.
  Start it from the dashboard, or spawn with `--start` (see the **hadron-spawn** skill).
- **`session not found` (404)** — wrong id. Run `hadron ls`; ids are slugified names.
- **`Cannot reach Hadron`** — the server isn't up on this port. It's read from the nearest
  `.hadron/runtime.json`; override with `HADRON_PORT`.

## When to use notes instead

Notes and messages solve different problems — use both, for different things:

- **`hadron message`** — you want the other agent to *do something now*.
- **`hadron notes set/append`** — durable context that should survive on the record and be
  visible on the dashboard. Not a delivery mechanism.

A handoff usually wants both: message the agent, and record the handoff in notes.

## Related

- **hadron-spawn** — create a *new* agent and brief it (`--start` types the task for you).
- **hadron-whoami** — find out which agent you are.
- `hadron send <id> "keys"` — low-level raw keystrokes into a pane. Almost never what you
  want; use it only for control keys (e.g. Escape), not for prompts.
