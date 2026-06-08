---
name: hadron-artifacts
description: Attach your key output files to this Hadron agent so the user sees them in the dashboard sidebar. Use after producing a report, notebook, or other deliverable, or when the user asks to "show" or "link" files.
---

# Attach Artifacts

Artifacts are files linked to your agent and rendered in Hadron's right panel (Markdown preview, syntax-highlighted code, CSV tables, notebooks, URLs). Attaching your deliverables is how the user reviews your work without switching to your terminal.

## Auto-discover and bulk-add

The server scores files in your working directory by how likely they are to be a human-readable deliverable (your agent id in the filename, `.md`/`.html`/`.csv`/`.ipynb`, output keywords, `docs/`/`reports/` dirs — source and config files score low). Add everything with a positive score:

```bash
hadron artifacts add --auto
```

Review the printed list. If it grabbed something you didn't mean to share, that's fine — artifacts are cheap; the user can remove them in the UI.

## Add specific files

```bash
hadron artifacts add report.md analysis/summary.csv
```

Paths are workspace-relative (or absolute). Duplicates are ignored automatically.

## See what's attached

```bash
hadron artifacts ls
```

## When to use this

- You just produced a report, notebook, chart, or summary → add it so the user sees it.
- The user says "show me X" or "link that file" → add it as an artifact.
- On finishing a task, run `--auto` to surface your outputs in one shot.

Attach to URLs (dashboards, deployed previews) from the dashboard UI, or via `hadron` only for files — URL artifacts are added through the agent's right-panel "+" in the browser.
