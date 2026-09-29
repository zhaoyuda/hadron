---
name: hadron-artifacts
description: Attach your key output files to this Hadron agent so the user sees them in the dashboard sidebar. Use after producing a report, notebook, or other deliverable, or when the user asks to "show" or "link" files.
---

# Attach Artifacts

Artifacts are files pinned to your agent — the **Pinned** section of Hadron's right panel, under the automatic Changed/Core lists — rendered there (Markdown preview, syntax-highlighted code, CSV tables, notebooks, URLs). Attaching your deliverables is how the user reviews your work without switching to your terminal.

## Auto-discover and bulk-add

The server scores files in your working directory by how likely they are to be a human-readable deliverable (your agent id in the filename, `.md`/`.html`/`.csv`/`.ipynb`, output keywords, `docs/`/`reports/` dirs — source and config files score low). Add everything with a positive score:

```bash
hadron artifacts pin --auto
```

Review the printed list. If it grabbed something you didn't mean to share, that's fine — artifacts are cheap; the user can remove them in the UI.

## Add specific files

```bash
hadron artifacts pin report.md analysis/summary.csv
```

Paths are workspace-relative (or absolute). Duplicates are ignored automatically.

Keep artifact **labels concise** — a few words at most. The file type is already shown by an icon in the tab, and long labels get truncated in the tab bar, so a short, scannable name reads best.

## See what's attached

```bash
hadron artifacts ls
```

## Freshness — what live-updates and what doesn't

The viewer polls each open artifact's mtime every 3s and reacts per type:

- **Markdown / text / CSV / code** re-render silently. Editing the file on disk is enough —
  no reopen needed.
- **HTML and Jupyter tabs** render in an iframe and are NOT silently re-rendered (that would
  wipe scroll/interaction state). Instead a **"File updated ↻ Reload"** pill appears on the
  tab; the user clicks it to see the new render. After regenerating one, tell the user to
  click the pill (or close and reopen the tab) — otherwise they're looking at the old render
  and will think your fix didn't land.
- **marimo** is launched with `--watch` and reloads its own cells; no pill, nothing to do.

## When to use this

- You just produced a report, notebook, chart, or summary → add it so the user sees it.
- The user says "show me X" or "link that file" → add it as an artifact.
- On finishing a task, run `--auto` to surface your outputs in one shot.

Attach to URLs (dashboards, deployed previews) from the dashboard UI, or via `hadron` only for files — URL artifacts are added through the agent's right-panel "+" in the browser.
