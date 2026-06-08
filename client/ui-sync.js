// ═══ UI STATE PERSISTENCE ═══
// Cross-tab model: each browser tab picks its OWN active agent (dual-monitor:
// a different agent per screen — no forced follow). We still sync *per-agent*
// view state (tab + layout) keyed by session id, so the same agent looks
// identical wherever it's shown — which also keeps its one shared tmux pane from
// being rendered at two different sizes. Tabs showing different agents are
// independent (separate tmux sessions, no interference).
//
// This is a classic <script> loaded BEFORE app.js; top-level globals it reads
// (activeSessionId, activeTab, layoutMode, perSessionTab, perSessionLayout,
// deckSortMode, deckGroupBy, currentTheme, notifyLevel, openTabsPerSession) and
// render fns (renderWorkHeader/renderWorkContent/deferredFit) are declared in
// app.js but only dereferenced at call time, so there's no load-order TDZ.
const uiSync = (() => {
  try { return new BroadcastChannel("hadron-ui-sync"); } catch { return null; }
})();
let suppressBroadcast = false;

function broadcastUIState() {
  if (!uiSync || suppressBroadcast) return;
  try {
    // Describe the active agent's view (not a "switch to me" command).
    uiSync.postMessage({
      sessionId: activeSessionId,
      activeTab,
      layoutMode,
    });
  } catch {}
}

function saveUIState() {
  const openTabs = {};
  for (const [k, v] of Object.entries(openTabsPerSession)) {
    openTabs[k] = [...(v instanceof Set ? v : [])];
  }
  // Save current session's state before persisting
  perSessionTab[activeSessionId] = activeTab;
  perSessionLayout[activeSessionId] = layoutMode;
  const state = {
    activeSessionId,
    perSessionTab,
    perSessionLayout,
    openTabs,
    deckSortMode,
    deckGroupBy,
    currentTheme,
    notifyLevel,
  };
  localStorage.setItem("hadron-ui-state", JSON.stringify(state));
  // Per-tab: each browser tab restores the agent IT was showing after a reload,
  // rather than snapping to whichever tab wrote localStorage last.
  try { if (activeSessionId) sessionStorage.setItem("hadron-active-session", activeSessionId); } catch {}
  broadcastUIState();
}

if (uiSync) {
  uiSync.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;
    suppressBroadcast = true;
    try {
      const sid = msg.sessionId;
      if (!sid) return;
      // Update the shared per-agent view model regardless of what this tab shows.
      if (msg.activeTab) perSessionTab[sid] = msg.activeTab;
      if (msg.layoutMode) perSessionLayout[sid] = msg.layoutMode;
      // Re-render only if this tab is currently viewing that same agent — no
      // forced session switch (the whole point of the decouple).
      if (sid === activeSessionId) {
        let changed = false;
        if (msg.activeTab && msg.activeTab !== activeTab) { activeTab = msg.activeTab; changed = true; }
        if (msg.layoutMode && msg.layoutMode !== layoutMode) { layoutMode = msg.layoutMode; changed = true; }
        if (changed) {
          renderWorkHeader();
          renderWorkContent();
          deferredFit();
        }
      }
    } catch {}
    suppressBroadcast = false;
  };
}

function restoreUIState() {
  try {
    const raw = localStorage.getItem("hadron-ui-state");
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state.activeSessionId) activeSessionId = state.activeSessionId;
    // A per-tab override wins if this tab had previously chosen an agent.
    try {
      const perTab = sessionStorage.getItem("hadron-active-session");
      if (perTab) activeSessionId = perTab;
    } catch {}
    if (state.perSessionTab) perSessionTab = state.perSessionTab;
    if (state.perSessionLayout) perSessionLayout = state.perSessionLayout;
    if (state.openTabs) {
      for (const [k, v] of Object.entries(state.openTabs)) {
        openTabsPerSession[k] = new Set(v);
      }
    }
    if (state.deckSortMode) deckSortMode = state.deckSortMode;
    if (state.deckGroupBy) deckGroupBy = state.deckGroupBy;
    if (state.currentTheme) currentTheme = state.currentTheme;
    if (state.notifyLevel) notifyLevel = state.notifyLevel;
    activeTab = perSessionTab[activeSessionId] || "terminal";
    layoutMode = perSessionLayout[activeSessionId] || "tabs";
  } catch {}
}
