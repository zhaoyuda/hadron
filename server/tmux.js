import { execFileSync } from "child_process";

// The ONLY way to call tmux. Array args, no shell — eliminates command injection
// regardless of whether a value was (mis)classified as "safe". stderr is suppressed
// so callers can treat a non-zero exit as a thrown error and catch it.
export function tmux(args, opts = {}) {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  });
}

// Convenience: run tmux, swallow errors, return trimmed stdout or null.
export function tmuxSafe(args, opts = {}) {
  try {
    return tmux(args, opts).trim();
  } catch {
    return null;
  }
}

// Agent ids become part of tmux session names and are echoed into many code paths.
// Constrain them to a slug alphabet at every boundary (orphan-adopt and WS paths
// derive ids from tmux names, so we cannot assume the POST slugifier already ran).
const ID_RE = /^[a-z0-9-]+$/;
export function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 100 && ID_RE.test(id);
}

// argv → a shell-safe command line. Launcher argv is TYPED into a pane (the
// shell re-parses it), so a bare join(" ") would dissolve argument boundaries —
// each element that isn't plainly safe is single-quoted with '\'' escaping.
export function shellQuoteArgv(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_.,:/@%^+=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
