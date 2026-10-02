// Keyed once-only warnings for the silent-failure class: an invariant that,
// when false, disables a feature without breaking anything. Such a warning
// must fire once per distinct (invariant, agent) — a process-global boolean
// hides the second affected agent. Key convention: `<invariant>:<agentId>`.
// Doctor (step 3) reads the fired set so every warning is also a finding.
export const firedWarnings = new Map(); // key → { msg, at }

export function warnOnce(key, msg, { warn = console.warn } = {}) {
  if (firedWarnings.has(key)) return false;
  firedWarnings.set(key, { msg, at: new Date().toISOString() });
  warn(msg);
  return true;
}

export function resetWarnOnce() { firedWarnings.clear(); }

// ── .hadron/server.log ──
// systemd/launchd keep the console, a hand-started server loses it; either way
// nobody could read "Found 1 orphaned tmux session" after the fact from the
// workspace (prod 2026-10-01). Mirror every console line into the workspace,
// stamped, size-capped (one rotation to server.log.1), created 0600. Console
// output already carries agent ids only — never tokens or session ids — so the
// file holds nothing the journal does not. Best-effort: a failing write never
// breaks the server, and a line is still printed to the console.
import { appendFileSync, renameSync, statSync, openSync, closeSync, chmodSync } from "fs";
const SERVER_LOG_MAX = 2 * 1024 * 1024;
// The state `hadron doctor` reports: {path, ok, error} — a dead log is the
// silent-failure case (the file exists for post-hoc forensics), so a failed
// open or the first failed write also warns once on the console.
let serverLog = { path: null, ok: false, error: "not initialised" };
export function serverLogStatus() { return { ...serverLog }; }
export function initServerLog(path) {
  if (serverLog.path) return serverLog.ok; // never wrap console twice
  try { closeSync(openSync(path, "a", 0o600)); chmodSync(path, 0o600); } // chmod: a pre-existing 0644 file stays private too
  catch (e) { serverLog = { path, ok: false, error: e.code || e.message }; warnOnce("server-log", `[log] ${path} is not writable (${serverLog.error}) — the console is not mirrored; \`hadron doctor\` says so`); return false; }
  serverLog = { path, ok: true, error: null };
  let size = 0;
  try { size = statSync(path).size; } catch {}
  const write = (level, args) => {
    if (!serverLog.ok) return;
    try {
      const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
      const entry = `${new Date().toISOString()} ${level} ${line}\n`;
      // A failed rotation (read-only dir, a .1 owned by someone else) is not
      // retried per line: the counter resets so the next attempt is 2 MiB away.
      if (size > SERVER_LOG_MAX) { try { renameSync(path, `${path}.1`); } catch {} size = 0; }
      appendFileSync(path, entry, { mode: 0o600 });
      size += Buffer.byteLength(entry);
    } catch (e) {
      serverLog = { path, ok: false, error: e.code || e.message };
      warnOnce("server-log", `[log] writing ${path} failed (${serverLog.error}) — the console is no longer mirrored; \`hadron doctor\` says so`);
    }
  };
  for (const [level, fn] of [["info", "log"], ["warn", "warn"], ["error", "error"]]) {
    const orig = console[fn].bind(console);
    console[fn] = (...args) => { orig(...args); write(level, args); };
  }
  return true;
}
