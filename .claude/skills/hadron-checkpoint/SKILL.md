---
name: hadron-checkpoint
description: Write a handoff checkpoint (goal / next step / blocker / output files) for this Hadron agent at task boundaries so the dashboard card, `hadron whoami`, and a resumed session start from your own words. Use before ending a turn on a milestone, when blocked, and before a long-running command.
---

# Hadron checkpoint — hand off in your own words

Hadron shows every agent as a card. While you are idle or done, the card's
sub-line is your checkpoint's **next** step (or **⚠ blocked**), and a session
that is resumed after a reboot or `/clear` reads the checkpoint first — so the
user (and future you) never has to reconstruct where you were from a transcript.

## Write one

```bash
hadron checkpoint --goal "migrate the notifier to HTTPS" \
                  --next "run scripts/predeploy-check.sh, then ask for the prod restart" \
                  -- README.md client/app.js
```

- `--goal` what the task is (one sentence); `--next` the next concrete action;
  `--blocked "…"` what you are waiting on (shown instead of next); positionals
  after `--` are the output files this work produced (paths as you would give
  the user).
- Each field ≤ 500 characters, plain text. Unmentioned fields keep their
  current value; `--next ""` clears one field; `hadron checkpoint clear`
  clears everything.
- `hadron checkpoint` (or `hadron checkpoint show`, `--json`) prints the current
  one; `hadron whoami` includes it.

## When

- At every task boundary: a milestone reached, a review sent, a commit made.
- When you stop to wait for the user — put the question in `--blocked`.
- Before a long command or a compaction: the checkpoint survives both.

Keep it short and operational: what a colleague needs to continue, not a
summary of the conversation.

## Session identity (optional, operator-installed)

`hadron checkpoint --install-hook` adds `hadron checkpoint --hook` to claude's
`SessionStart` hooks in `~/.claude/settings.json`. Claude then reports its own
session id to Hadron on start, `/clear` and `--resume`; Hadron verifies the
pane and the process before believing it. Agents never need to run this
themselves — it is a one-time, explicit operator step (`--uninstall-hook`
reverts it). The claim must come from the agent's active pane: while the
operator has split the agent's window and left focus in the split, claims are
refused (409) until focus returns — the same rule claude's own session
registry follows. A nested `claude -p` run from the conversation's Bash tool
is refused as well; the outer conversation keeps its id.
