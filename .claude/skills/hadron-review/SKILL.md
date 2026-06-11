---
name: hadron-review
description: Process pending review comments the user attached to your artifacts in Hadron — list them with the hadron CLI, make the requested edits, resolve each one.
---

# Process Review Comments

The user reviewed your output files in the Hadron dashboard and left a batch of comments on them. Your job: make every requested change, then mark each comment done. The user is watching the comment count drop in real time — **don't ask for confirmation, just work through all of them.**

## Protocol

1. List the pending comments:

```bash
hadron annotations ls
```

Each comment shows the file it targets, a location hint, and the instruction:

```
[c_1718000000_x7f3] reports/review.md — "the Q3 numbers look inflated" (line 42)
    Cross-check this against the table above and fix the discrepancy.
```

2. For each comment, open the named file and make the edit. The comment **body is the instruction**; the quoted location text tells you where it applies. `(whole document)` means the comment is about the file as a whole.

3. After completing each one, resolve it immediately (not in a batch at the end — the user sees progress per comment):

```bash
hadron annotations resolve <id>
```

4. Repeat until `hadron annotations ls` prints `no pending review comments`.

## Notes

- A location of `(original text no longer found)` or `(multiple matches)` means the file changed since the user selected that text. The comment is still actionable — use the body plus your knowledge of the file to find the right spot, and apply judgment.
- Resolve a comment only after you've actually made the change. If a comment is genuinely impossible (e.g. the file was deleted), say so briefly, then resolve it anyway so the batch can complete.
- `hadron annotations ls --json` gives the raw records if you need anchor details.
