---
name: hadron-notebook-kernel
description: Configure which Python environment (venv) Hadron uses to launch marimo and Jupyter notebooks in this workspace. Detects existing venvs, optionally creates one, and saves the choice.
---

# Notebook Kernel

Hadron launches marimo and Jupyter using a venv recorded in `.hadron/config.json` under `kernels`:

```json
{ "kernels": { "marimo": "/abs/path/.venv", "jupyter": "/abs/path/.venv" } }
```

If unset, it falls back to the workspace's `.venv/`. marimo and Jupyter can share one env or use different ones.

## 1. Find the workspace + current config

```bash
WORKSPACE=$(find ~ -maxdepth 3 -name ".hadron" -type d 2>/dev/null | head -1 | xargs dirname)
echo "Workspace: $WORKSPACE"
curl -s http://localhost:${HADRON_PORT:-3000}/api/kernels
```

## 2. Scan for usable venvs

```bash
for d in .venv venv env; do
  p="$WORKSPACE/$d"
  [ -x "$p/bin/python3" ] && { echo "FOUND: $p"; "$p/bin/python3" -m pip list 2>/dev/null | grep -iE "marimo|jupyter"; }
done
command -v uv >/dev/null && echo "uv available"
```

## 3. Create one if needed

Prefer `uv`; fall back to stdlib. Always `python3`, never `python`:

```bash
cd "$WORKSPACE"
uv venv .venv && uv pip install marimo jupyter altair pandas   # preferred
# or:
python3 -m venv .venv && .venv/bin/python3 -m pip install marimo jupyter altair pandas
```

## 4. Save the choice

The kernels route is a mutating endpoint, so it needs the workspace token (read from `.hadron/token`). No Origin header is sent by curl, so the token alone authorizes it:

```bash
TOKEN=$(cat "$WORKSPACE/.hadron/token")
curl -s -X PUT http://localhost:${HADRON_PORT:-3000}/api/kernels \
  -H "Content-Type: application/json" \
  -H "x-hadron-token: $TOKEN" \
  -d "{\"marimo\": \"$WORKSPACE/.venv\", \"jupyter\": \"$WORKSPACE/.venv\"}"
```

## 5. Confirm

Tell the user the kernel is set and that **already-open** marimo/Jupyter tabs must be closed and reopened to pick up the new env. They can verify in the dashboard's **Kernel** menu.

## Notes

- Paths must be absolute or `~/`-prefixed.
- The chosen venv must actually have the package installed (`marimo` for marimo, `jupyter` for Jupyter).
