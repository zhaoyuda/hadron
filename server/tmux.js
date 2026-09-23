import { execFileSync, execFile } from "child_process";

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
//
// Targets are EXACT. A bare `-t name` is resolved by tmux as exact-then-prefix
// match, so with agents "dummy" and "dummy2", every call aimed at a missing or
// not-yet-created `hadron-ws-dummy` silently lands on `hadron-ws-dummy2`:
// has-session says it exists (so it is never created), the state detector
// reads the other agent's pane, and a message is PASTED INTO THE OTHER AGENT
// (staging, 2026-09-23). tmux's `=` prefix forces an exact match, and the
// trailing `:` says "this is the SESSION part" — for pane-taking commands
// (capture-pane, send-keys, paste-buffer) a bare `=name` is read as a window/
// pane name instead and finds nothing. `=name:` resolves to that session's
// current window/active pane, exactly what a bare `name` resolved to. Hadron
// never relies on prefix or pattern targets, so every bare session-name
// target is rewritten here, in the one place all tmux argv passes through
// (the WS terminal's attach included). Pane ids (%N), session ids ($N),
// window/pane targets (name:0.0) and already-exact targets are left alone —
// so a session name carrying "." or ":" would fall back to prefix matching;
// Hadron never mints one (workspace basename sanitised, ids are slugs).
export function exactTarget(t) {
  return typeof t === "string" && t.length > 0 && !/^[=%$]/.test(t) && !/[:.]/.test(t) ? `=${t}:` : t;
}
export function tmuxArgv(args) {
  if (args.includes("kill-server")) throw new Error("tmux kill-server is never issued by Hadron");
  const out = args.map((a, i) => (i > 0 && args[i - 1] === "-t" ? exactTarget(a) : a));
  return SOCKET ? ["-S", SOCKET, ...out] : out;
}

// Every tmux call is a SYNCHRONOUS spawn on the main thread (monitor polls,
// capture-pane, the HTTP handlers). One that never returns therefore stops the
// whole event loop: the port keeps accepting, nothing is ever served, and a
// supervisor sees a live process (macOS, 2026-09-17: 2d15h in, one tmux client
// parked in kevent forever — launchd never restarted it). Bound every call;
// SIGKILL because a client that ignores SIGTERM would re-hang the same call.
// A timeout throws like any failed tmux call, so tmuxSafe callers see null.
export const TMUX_TIMEOUT_MS = 5000;

export function tmux(args, opts = {}) {
  // Hadron only ever needs targeted kill-session. kill-server would take every
  // agent on the socket with it (and, from inside a pane, the caller's own shell).
  return execFileSync("tmux", tmuxArgv(args), {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
    ...opts,
  });
}

// Async twin for the paths that run on a timer (the state-detector poll): the
// same argv guard, socket, timeout and SIGKILL, but the event loop keeps
// serving while tmux runs. A wedged tmux then costs one agent's poll, not the
// whole server. Rejects exactly where tmux() throws.
export function tmuxAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    // tmuxArgv throws on kill-server; inside the executor that becomes a
    // rejection, so every failure of tmuxAsync is a rejection (never a sync throw).
    execFile("tmux", tmuxArgv(args), {
      encoding: "utf-8",
      timeout: TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...opts,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
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
