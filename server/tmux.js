import { execFileSync } from "child_process";

// The ONLY way to call tmux. Array args, no shell — eliminates command injection
// regardless of whether a value was (mis)classified as "safe". stderr is suppressed
// so callers can treat a non-zero exit as a thrown error and catch it.
// HADRON_TMUX_SOCKET: an explicit socket path (`tmux -S`) for every call. Test
// servers use it to get a private tmux server. `-S` beats an inherited $TMUX;
// TMUX_TMPDIR does NOT (tmux resolves the socket from $TMUX first) — a server
// started from inside a pane with only TMUX_TMPDIR set talks to the pane's server.
const SOCKET = process.env.HADRON_TMUX_SOCKET || null;
export const tmuxSocket = SOCKET;

// Prepend the socket flag so a spawn OUTSIDE this module (the WS terminal's
// node-pty `tmux attach-session`) lands on the same server every tmux() call
// uses. Without it, a test server with HADRON_TMUX_SOCKET creates the agent
// session on the private socket but the pty attaches on the DEFAULT one —
// attaching to a stranger (or the developer's real tmux) instead.
export function tmuxArgv(args) {
  if (args.includes("kill-server")) throw new Error("tmux kill-server is never issued by Hadron");
  return SOCKET ? ["-S", SOCKET, ...args] : args;
}

export function tmux(args, opts = {}) {
  // Hadron only ever needs targeted kill-session. kill-server would take every
  // agent on the socket with it (and, from inside a pane, the caller's own shell).
  return execFileSync("tmux", tmuxArgv(args), {
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
