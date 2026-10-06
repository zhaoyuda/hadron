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

// Was this tmux failure the bounded-call timeout (the client was SIGKILLed
// because the server did not answer), as opposed to tmux answering "no"?
// Callers that would CREATE on a miss (has-session → new-session) must tell
// the two apart: a server that did not answer has-session will not answer
// new-session either, and chaining the two is 10 s of stall for nothing —
// exactly the shape of the 2026-10-05 prod crash (tmux server paging at 5.6 GB
// RSS + 1.2 GB swap, has-session ETIMEDOUT → new-session ETIMEDOUT, uncaught).
export function isTmuxTimeout(err) {
  return !!err && (err.code === "ETIMEDOUT" || err.signal === "SIGKILL" || err.killed === true);
}

// Per-call timing. Every tmux() / tmuxAsync() call is clocked; a call over
// TMUX_SLOW_MS is counted and logged (rate-limited — a paging tmux server is
// slow on EVERY call, one line per SLOW_LOG_EVERY_MS says it without a flood).
// Exposed on /api/health as `tmux` so the health probe and `hadron doctor` can
// say "tmux is slow" from the server's own calls, no extra probing.
export const TMUX_SLOW_MS = 500;

// Scrollback kept per pane in the tmux sessions Hadron creates (agents, shell
// tabs, editor panes). tmux's history is an in-memory grid: every line of
// every pane stays resident in the ONE tmux server process, and on the
// 2026-10-05 incident 171k lines over 76 panes were 5.6 GB RSS + 1.2 GB swap —
// the server paged and every call stalled. The browser side (xterm.js) keeps
// 5000 rows per terminal and nothing more is ever shown, so the pane needs no
// more either; what came before lives in claude's transcript, which Hadron
// reads for the card. A per-session option (never the global one — other
// sessions on the shared server keep their own setting); 0 leaves tmux's
// default/global value alone.
export const TMUX_HISTORY_LINES = (() => {
  const v = process.env.HADRON_TMUX_HISTORY_LINES;
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 5000;
})();
const SLOW_LOG_EVERY_MS = 10000;
const stats = { calls: 0, slowCalls: 0, timeouts: 0, maxMs: 0, lastMs: 0, lastSlowAt: null, lastSlowMs: 0, lastSlowCmd: null, lastTimeoutAt: null, lastTimeoutCmd: null };
let lastSlowLogAt = 0;
// One observer for slow calls (the perf log, server/perf-log.js): gets
// { cmd, ms, timedOut } — the subcommand only, never the argv.
let slowObserver = null;
export function setSlowCallObserver(fn) { slowObserver = typeof fn === "function" ? fn : null; }
function record(args, startedAt, err) {
  const ms = Date.now() - startedAt;
  stats.calls++;
  stats.lastMs = ms;
  if (ms > stats.maxMs) stats.maxMs = ms;
  const cmd = args.find((a) => !a.startsWith("-")) || "?";
  if (isTmuxTimeout(err)) {
    stats.timeouts++;
    stats.lastTimeoutAt = new Date(startedAt + ms).toISOString();
    stats.lastTimeoutCmd = cmd;
  }
  if (ms > TMUX_SLOW_MS) {
    stats.slowCalls++;
    stats.lastSlowAt = new Date(startedAt + ms).toISOString();
    stats.lastSlowMs = ms;
    stats.lastSlowCmd = cmd;
    try { slowObserver?.({ cmd, ms, timedOut: isTmuxTimeout(err) }); } catch {}
    const now = Date.now();
    if (now - lastSlowLogAt >= SLOW_LOG_EVERY_MS) {
      lastSlowLogAt = now;
      console.warn(`[tmux] slow call: ${cmd} took ${ms} ms${isTmuxTimeout(err) ? " (timed out, client killed)" : ""} — ${stats.slowCalls} slow / ${stats.timeouts} timed out of ${stats.calls} calls since boot`);
    }
  }
}
export function tmuxStats() {
  return { ...stats, slowMs: TMUX_SLOW_MS, timeoutMs: TMUX_TIMEOUT_MS };
}

// child_process's error message is "Command failed: tmux <full argv>" — the
// argv of `set-environment … HADRON_TOKEN <token>` included. These messages
// reach server.log, the terminal client (the 4503 refusal line) and doctor
// rows, so every thrown/rejected tmux error is rewritten here to name the
// command, how it ended and the first line of stderr — never the arguments.
function sanitize(err, args) {
  if (!err || typeof err !== "object") return err;
  const cmd = args.find((a) => !a.startsWith("-")) || "?";
  let how;
  if (isTmuxTimeout(err)) how = `timed out after ${TMUX_TIMEOUT_MS} ms`;
  else if (err.signal) how = `killed by ${err.signal}`;
  else if (typeof err.status === "number") how = `exited ${err.status}`;
  else if (err.code) how = `failed (${err.code})`;
  else how = "failed";
  const stderr = typeof err.stderr === "string" ? err.stderr.split("\n").find((l) => l.trim()) : null;
  try { err.message = `tmux ${cmd} ${how}${stderr ? `: ${stderr.trim().slice(0, 120)}` : ""}`; } catch {}
  // execFile also sets err.cmd = the full command line; drop it so the error is
  // safe to log by ANY means (console.error(e), JSON.stringify), not only .message.
  try { delete err.cmd; } catch {}
  return err;
}

export function tmux(args, opts = {}) {
  // Hadron only ever needs targeted kill-session. kill-server would take every
  // agent on the socket with it (and, from inside a pane, the caller's own shell).
  const argv = tmuxArgv(args);
  const t0 = Date.now();
  try {
    const out = execFileSync("tmux", argv, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...opts,
    });
    record(args, t0, null);
    return out;
  } catch (e) {
    record(args, t0, e);
    throw sanitize(e, args);
  }
}

// Async twin for the paths that run on a timer (the state-detector poll): the
// same argv guard, socket, timeout and SIGKILL, but the event loop keeps
// serving while tmux runs. A wedged tmux then costs one agent's poll, not the
// whole server. Rejects exactly where tmux() throws.
export function tmuxAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    // tmuxArgv throws on kill-server; inside the executor that becomes a
    // rejection, so every failure of tmuxAsync is a rejection (never a sync throw).
    const argv = tmuxArgv(args);
    const t0 = Date.now();
    execFile("tmux", argv, {
      encoding: "utf-8",
      timeout: TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...opts,
    }, (err, stdout) => { record(args, t0, err); err ? reject(sanitize(err, args)) : resolve(stdout); });
  });
}

// Async twin of tmuxSafe: null on any failure, trimmed stdout otherwise.
export function tmuxSafeAsync(args, opts = {}) {
  return tmuxAsync(args, opts).then((out) => out.trim(), () => null);
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
