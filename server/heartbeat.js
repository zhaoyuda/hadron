// Event-loop liveness heartbeat.
//
// A server whose event loop is wedged (a sync spawn that never returns, a
// runaway loop) still holds its port and its pid, so systemd/launchd see a
// healthy service and never restart it — and an HTTP probe from the same
// machine just hangs. This module bumps the mtime of `<ws>/.hadron/heartbeat`
// from a timer on the event loop itself: the file only stays fresh while the
// loop is turning. `hadron watchdog` (bin/hadron.js) reads the mtime from a
// separate process and, with --restart, SIGKILLs a wedged server so the
// supervisor's Restart=always / KeepAlive brings up a fresh one. SIGKILL is
// deliberate: SIGTERM is delivered through the very event loop that is stuck.
//
// The timer is unref'd so it never keeps a shutting-down process alive, and
// every fs call is wrapped — a heartbeat must never be able to crash the server.
import { writeFileSync, utimesSync, unlinkSync } from "fs";

export const HEARTBEAT_INTERVAL_MS = 2000;

export function startHeartbeat(path, { intervalMs } = {}) {
  if (!(intervalMs > 0)) intervalMs = HEARTBEAT_INTERVAL_MS;
  let heartbeatAt = 0;
  let eventLoopLagMs = 0;
  let due = Date.now() + intervalMs;
  let timer = null;

  function touch() {
    const now = Date.now();
    // How late this tick fired vs. when the timer asked for it: a coarse, free
    // event-loop lag gauge (surfaced on /api/health).
    eventLoopLagMs = Math.max(0, now - due);
    due = now + intervalMs;
    heartbeatAt = now;
    try {
      const t = now / 1000;
      utimesSync(path, t, t);
    } catch {
      try { writeFileSync(path, "", { mode: 0o600 }); } catch {}
    }
  }

  touch(); // first beat synchronously so a probe right after boot sees a fresh file
  timer = setInterval(touch, intervalMs);
  timer.unref();

  return {
    // Snapshot for /api/health.
    status() { return { heartbeatAt, eventLoopLagMs, heartbeatIntervalMs: intervalMs }; },
    // Clean shutdown: stop beating and remove the file, so a watchdog run
    // after an orderly exit reports "not running", not "stale".
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      try { unlinkSync(path); } catch {}
    },
  };
}
