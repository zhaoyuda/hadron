---
name: hadron-notebook-kernel
description: Configure which Python environment (venv) Hadron launches marimo and Jupyter notebooks from, in this workspace. Use when notebooks won't open, open with the wrong interpreter, or a package is missing inside a notebook.
---

# Notebook Kernel

Hadron launches marimo and Jupyter from a venv recorded per workspace. If unset, it falls
back to the workspace's `.venv/` — and if that doesn't exist, notebooks simply don't open.

## 1. See what's configured

```bash
hadron kernels
```

`no kernels configured` + no `.venv/` in the workspace root is the usual cause of "the
notebook tab does nothing."

## 2. Find a venv that has the package

The venv must actually contain the runtime you're pointing it at — `marimo` for marimo,
`jupyter` for Jupyter. Check candidates directly:

```bash
ls /path/to/.venv/bin/marimo /path/to/.venv/bin/jupyter
```

Look at the workspace root first, then any shared venv the project already standardises on
(check the project's CLAUDE.md — many workspaces share one env rather than having a local
`.venv/`). Create one only if nothing suitable exists:

```bash
uv venv /path/to/.venv
uv pip install --python /path/to/.venv/bin/python3 marimo jupyter altair pandas
```

## 3. Set it

```bash
hadron kernels set --marimo /abs/path/.venv --jupyter /abs/path/.venv
```

- They can share one venv or point at different ones.
- Either flag alone is fine — the other entry is preserved (the CLI merges; the underlying
  API replaces wholesale, which is why you should not hand-roll this with curl).
- A path without `bin/python3` is rejected up front. This matters: the *server* silently
  falls back to `.venv/` when a configured path doesn't resolve, so a typo would otherwise
  look like the setting simply didn't take.

## 4. Confirm

Run `hadron kernels` to read it back, then tell the user: **already-open marimo/Jupyter tabs
must be closed and reopened** to pick up the new env. They can verify in the dashboard's
**Kernel** menu.

## Don't hand-roll the workspace lookup

Earlier versions of this skill discovered the workspace with
`find ~ -maxdepth 3 -name .hadron | head -1` and curled `localhost:3000` with a hand-read
token. In any multi-workspace setup that is wrong in three ways at once: `head -1` picks a
fixed directory regardless of where you are, the hardcoded port belongs to a *different*
server, and the token then doesn't match that server, so the write is rejected. It never
worked — both workspaces had an empty `kernels` for two months.

`hadron` resolves the port and token together from the nearest `.hadron/` walking up from
cwd, so they're always a matched pair. Use the CLI.
