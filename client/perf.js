// Freeze log — how long the page stopped responding, and what it was doing.
//
// A heartbeat runs every HEARTBEAT_MS; a gap of FREEZE_MS or more between two
// beats means the main thread was blocked (nothing could paint, no click could
// land). Its length is the browser's long-animation-frame timing where it
// timed one (Chromium 123+), else the gap. Counted only while the page
// is visible: a background tab's timers are throttled to ≥ 1 s by the browser,
// which is not a freeze. Each freeze carries:
//   marks   — perfMark(label) calls made inside its window (app code says
//             "switch", "chat items", "artifact render", … where it starts work)
//   scripts — where the browser exposes long-animation-frame entries
//             (Chromium 123+), the functions that ran longest in that frame
// Agent switch (click → next frame) and chat load (opened → first items drawn)
// are timed too. Samples are batched and POSTed to /api/perf/client every
// FLUSH_MS (and on pagehide); `hadron perf` reads them back.
(function () {
  const HEARTBEAT_MS = 100;
  const FREEZE_MS = 200;      // a stall shorter than this is not reported
  const FLUSH_MS = 10_000;
  const MAX_QUEUE = 100;
  const marks = [];           // { label, at } — the last 64
  const frames = [];          // { start, end, scripts } from long-animation-frame
  let queue = [];
  let last = performance.now();

  function now() { return performance.now(); }
  function view() {
    try {
      if (typeof layoutMode !== "undefined" && layoutMode !== "tabs") return "split";
      const t = typeof activeTab !== "undefined" ? activeTab : null;
      if (t === "terminal" || t === "chat" || t === "notes" || t === "changes") return t;
      return t ? "artifact" : "other";
    } catch { return "other"; }
  }
  function agent() { try { return typeof activeSessionId === "string" ? activeSessionId : undefined; } catch { return undefined; } }
  function label(s) { return String(s).replace(/[^A-Za-z0-9_.$:#@<>/ -]/g, "_").slice(0, 80); }

  function push(ev) {
    queue.push({ ...ev, at: Date.now() });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  }

  window.perfMark = function perfMark(name) {
    marks.push({ label: label(name), at: now() });
    if (marks.length > 64) marks.shift();
  };
  // A timed span that ends at the next frame: what the user waited for before
  // the screen could change (sync work + the frame that paints it).
  window.perfSpan = function perfSpan(ev, extra) {
    const t0 = now();
    const done = () => push({ ev, ms: now() - t0, view: view(), agent: agent(), ...extra });
    if (document.hidden) return;
    requestAnimationFrame(() => setTimeout(done, 0));
  };
  window.perfRecord = function perfRecord(ev, ms, extra) {
    if (!document.hidden) push({ ev, ms, view: view(), agent: agent(), ...extra });
  };

  try {
    if (PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < FREEZE_MS) continue;
          const scripts = (e.scripts || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => {
            const file = String(s.sourceURL || "").split(/[?#]/)[0].split("/").pop() || "page";
            return label(`${s.sourceFunctionName || s.invoker || "anonymous"}@${file}`);
          });
          frames.push({ start: e.startTime, end: e.startTime + e.duration, scripts });
          if (frames.length > 32) frames.shift();
        }
      }).observe({ type: "long-animation-frame", buffered: false });
    }
  } catch {}

  setInterval(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (document.hidden) return;
    // The block began somewhere inside the beat before this gap: it lasted
    // between gap − HEARTBEAT_MS and gap. A gap that could hold a FREEZE_MS
    // block is a candidate; the measured length decides below.
    if (gap < FREEZE_MS) return;
    const start = t - gap;
    const inWindow = marks.filter((m) => m.at >= start - 5 && m.at <= t).map((m) => m.label);
    // A long-animation-frame entry is delivered after the frame; give it until
    // the next beat by deciding attribution one tick later.
    setTimeout(() => {
      // The browser's own frame timing when it timed one (Chromium 123+; a
      // task outside a frame has none). Otherwise the gap itself: the longest
      // the page ran none of its timers, an upper bound at most one beat over
      // the block — a FREEZE_MS block is never missed, a shorter one can be
      // reported at up to FREEZE_MS + a beat.
      const scripts = []; let frameMs = 0;
      for (const f of frames) if (f.end >= start && f.start <= t) { scripts.push(...f.scripts); frameMs = Math.max(frameMs, f.end - f.start); }
      const ms = frameMs || gap;
      if (ms < FREEZE_MS) return;
      push({ ev: "freeze", ms, view: view(), agent: agent(), marks: [...new Set(inWindow)].slice(0, 10), scripts: [...new Set(scripts)].slice(0, 5) });
    }, HEARTBEAT_MS);
  }, HEARTBEAT_MS);
  // Coming back from a hidden tab is a long gap that is not a freeze.
  document.addEventListener("visibilitychange", () => { last = now(); });

  function flush(keepalive) {
    if (!queue.length) return;
    const sent = Date.now();
    const events = queue.splice(0, 50).map(({ at, ...e }) => ({ ...e, ago: sent - at }));
    try {
      fetch("/api/perf/client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }), keepalive: !!keepalive }).catch(() => {});
    } catch {}
  }
  setInterval(() => flush(false), FLUSH_MS);
  window.addEventListener("pagehide", () => flush(true));
  window.perfFlush = flush; // tests
})();
