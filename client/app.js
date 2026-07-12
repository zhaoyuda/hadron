// ═══ AUTH ═══
// The server injects window.HADRON_TOKEN into index.html. Attach it to every
// same-origin /api/ request and WebSocket so the browser can talk to the guarded API
// without the user pasting a token.
const HADRON_TOKEN = window.HADRON_TOKEN || "";
(function patchFetch() {
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    try {
      const url = typeof input === "string" ? input : input.url;
      const isApi = url && (url.startsWith("/api/") || url.startsWith(`${location.origin}/api/`));
      if (isApi && HADRON_TOKEN) {
        const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined) || {});
        headers.set("x-hadron-token", HADRON_TOKEN);
        init = { ...init, headers };
      }
    } catch {}
    return origFetch(input, init);
  };
})();
function wsTokenParam() {
  return HADRON_TOKEN ? `&token=${encodeURIComponent(HADRON_TOKEN)}` : "";
}

// ═══ STATE ═══
let sessions = [];
let activeSessionId = null;
let notesSaveTimer = null;
let prevSessionStates = {};
let activeTab = "terminal"; // "terminal", "notes", or "artifact:<index>"
let openTabsPerSession = {}; // { sessionId: Set of tab ids }
let layoutMode = "tabs"; // "tabs", "vsplit", "hsplit"
let perSessionTab = {}; // { sessionId: activeTab }
let perSessionLayout = {}; // { sessionId: layoutMode }
let collapsedArtFolders = {}; // { sessionId: Set of collapsed artifact-folder dirs } — survives the 3s re-render
let workspaceGroups = null; // persisted group order from config, or null if not loaded
let groupConfig = {}; // per-group attributes like { expandable: false }
let deckSortMode = "state"; // "state", "manual", "name"
let deckGroupBy = "group"; // "group" (semantic groups) or "status" (bucket by agent state)
let currentTheme = "default"; // "default", "exploration"
let notifyLevel = "all"; // "all" (sound+banner+flash), "banner" (banner+flash), "off"
let titleFlashInterval = null;
let pendingAlerts = new Set();
let wsName = "Hadron";

// ═══ UI STATE PERSISTENCE ═══ — extracted to ui-sync.js (loaded before this file).
// broadcastUIState/saveUIState/restoreUIState + the BroadcastChannel live there;
// they read the globals declared above at call time.

// ═══ THEME SYSTEM ═══ — extracted to theme.js (loaded before this file).
// CLASSIC_CREW/PNG_SPRITES sprite data + renderThemeAvatar/applyTheme/animateSprites
// live there; they read currentTheme / saveUIState / render from this file at call time.

// ═══ INIT ═══
async function init() {
  initTerminal();
  await fetchWorkspace();
  await fetchSessions();
  restoreUIState();
  applyTheme(currentTheme);
  if (!sessions.find((s) => s.id === activeSessionId) && sessions.length > 0) activeSessionId = sessions[0].id;
  restoreShellTabs();
  syncGroupList();
  prevSessionStates = snapshotSessionStates();
  initMenuBar();
  render();
  connectWs(activeSessionId);
  initResize();
  initKeyboard();
  renderShortcutBar();
}

async function fetchWorkspace() {
  try {
    const res = await fetch("/api/workspace");
    const config = await res.json();
    const el = document.querySelector(".proj-name");
    const displayName = config.cwd ? config.cwd.replace(/^\/home\/[^/]+/, "~") : (config.name || "workspace");
    if (el) el.textContent = displayName;
    wsName = config.name || "Hadron";
    document.title = `${wsName} — Hadron`;
    if (config.groups) workspaceGroups = config.groups;
    if (config.groupConfig) groupConfig = config.groupConfig;
  } catch {}
}

async function saveWorkspaceGroups(groups) {
  workspaceGroups = groups;
  try {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups, groupConfig }),
    });
  } catch (e) {
    console.error("Failed to save workspace groups:", e);
  }
}

// ═══ WEBSOCKET + TERMINAL ═══ — extracted to terminal.js (loaded before this file).
// Terminal/WS state (ws/term/fitAddon/reconnectTimer/shellInstances) + the lifecycle fns
// (initTerminal/safeFit/deferredFit/sendResize/connectWs/scheduleReconnect) and shell tabs
// (createShellTab/closeShellTab/restoreShellTabs) live there; they read activeSessionId,
// openTabsPerSession, wsTokenParam and the render/switch helpers from this file at call time.

// ═══ SESSIONS API ═══
async function fetchSessions() {
  try {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
  } catch (e) {
    console.error("Failed to fetch sessions:", e);
  }
}

// ═══ DISPLAY ORDER ═══
function getSessionGroups() {
  // Group case-insensitively: "Workers" and "workers" are the same group
  // (they'd otherwise render identically once CSS uppercases the label).
  // Keyed by lowercase; the display label is the persisted casing when the
  // group exists in workspaceGroups, else the first casing we encounter.
  const labelFor = (raw) => {
    if (workspaceGroups) {
      const hit = workspaceGroups.find((g) => g.toLowerCase() === raw.toLowerCase());
      if (hit) return hit;
    }
    return raw;
  };
  const groupMap = {}; // lcKey -> { label, items }
  sessions.forEach((s) => {
    const raw = s.group || "Workers";
    const key = raw.toLowerCase();
    if (!groupMap[key]) groupMap[key] = { label: labelFor(raw), items: [] };
    groupMap[key].items.push(s);
  });

  const STATE_PRIORITY = { blocked: 0, done: 1, working: 2, idle: 3 };
  for (const key of Object.keys(groupMap)) {
    groupMap[key].items.sort((a, b) => {
      if (deckSortMode === "state") {
        const ap = STATE_PRIORITY[a.state || "idle"] ?? 3;
        const bp = STATE_PRIORITY[b.state || "idle"] ?? 3;
        if (ap !== bp) return ap - bp;
      }
      if (deckSortMode === "name") {
        return (a.name || a.id).localeCompare(b.name || b.id);
      }
      // manual or tiebreak: use sortOrder
      const aSort = a.sortOrder ?? Infinity;
      const bSort = b.sortOrder ?? Infinity;
      if (aSort !== bSort) return aSort - bSort;
      return a.id.localeCompare(b.id);
    });
  }

  // Use persisted group order if available
  if (workspaceGroups) {
    const result = [];
    const seen = new Set();
    for (const gName of workspaceGroups) {
      const key = gName.toLowerCase();
      if (seen.has(key)) continue; // dedupe persisted entries differing only by case
      seen.add(key);
      result.push({ label: gName, items: (groupMap[key] && groupMap[key].items) || [] });
    }
    // Append any groups not in the persisted list (shouldn't happen normally)
    for (const key of Object.keys(groupMap)) {
      if (!seen.has(key)) result.push({ label: groupMap[key].label, items: groupMap[key].items });
    }
    return result;
  }

  // Fallback: alphabetical
  const result = [];
  Object.keys(groupMap)
    .sort()
    .forEach((key) => {
      result.push({ label: groupMap[key].label, items: groupMap[key].items });
    });
  return result;
}

// Bucket every agent by its state, ignoring semantic groups. Order surfaces the
// agents that need a human first: blocked → needs-review (done) → working → idle.
function getStatusBuckets() {
  const BUCKETS = [
    { key: "blocked", label: "Blocked" },
    { key: "done", label: "Needs Review" },
    { key: "working", label: "Working" },
    { key: "idle", label: "Idle" },
  ];
  const map = { blocked: [], done: [], working: [], idle: [] };
  sessions.forEach((s) => {
    const st = s.state || "idle";
    (map[st] || map.idle).push(s);
  });
  for (const k of Object.keys(map)) {
    map[k].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }
  return BUCKETS.filter((b) => map[b.key].length > 0)
    .map((b) => ({ label: b.label, items: map[b.key], status: b.key }));
}

// Rendering/nav layer: either semantic groups or status buckets. Persistence and
// group-list bookkeeping keep using getSessionGroups() (always the group axis).
function getDeckSections() {
  return deckGroupBy === "status" ? getStatusBuckets() : getSessionGroups();
}

function getDisplayOrder() {
  return getDeckSections().flatMap((g) => g.items);
}

function syncGroupList() {
  const groups = getSessionGroups();
  const list = groups.map((g) => g.label);
  if (!workspaceGroups || JSON.stringify(workspaceGroups) !== JSON.stringify(list)) {
    saveWorkspaceGroups(list);
  }
}

// ═══ RENDER ═══
function render() {
  renderDeck();
  renderWorkHeader();
  renderWorkContent();
  renderRightPanel();
  renderShortcutBar();
  deferredFit();
}

function renderWorkHeader() {
  const el = document.getElementById("work-header");
  const s = sessions.find((s) => s.id === activeSessionId);
  if (!s) { el.innerHTML = ""; return; }

  const state = s.state || "idle";
  const code = getAgentIcon(s);
  const name = (s.name || s.id).toUpperCase();
  const avBg = state === "working" ? "#1a2332" : state === "done" ? "#1a2e1a" : state === "blocked" ? "#2a1318" : "#363c46";

  let stateLabel, stateClass;
  if (state === "done") { stateLabel = "needs review"; stateClass = "wh-state-done"; }
  else if (state === "blocked") { stateLabel = isExplorationTheme() ? rpgBlockedLine(s) : (s.blockReason || "blocked"); stateClass = "wh-state-blocked"; }
  else if (state === "working") { stateLabel = formatWorkingSubstatus(s); stateClass = "wh-state-working"; }
  else { stateLabel = "idle"; stateClass = "wh-state-idle"; }

  const canClose = s.deletable !== false;

  const closeBtn = canClose ? `<div class="wh-close" title="Close agent">×</div>` : "";

  const openTabs = getOpenTabs(s);
  const showTabs = openTabs.length > 0;

  let tabsHtml = "";
  if (showTabs) {
    const noHighlight = layoutMode !== "tabs";
    const termActive = !noHighlight && activeTab === "terminal" ? " active" : "";
    tabsHtml += `<div class="wh-tab${termActive}" data-tab="terminal">Primary</div>`;
    openTabs.forEach((tab) => {
      const isActive = !noHighlight && activeTab === tab.id ? " active" : "";
      let iconHtml = "";
      if (tab.type === "url") {
        iconHtml = `<span class="wh-tab-i">${URL_TAB_ICON}</span>`;
      } else if (tab.value) {
        const fname = tab.value.split("/").pop();
        if (fname) iconHtml = `<span class="wh-tab-i">${fileIcon(fname, 14)}</span>`;
      }
      const hasDraft = tab.type !== "url" && tab.value && typeof hasDirtyDraft === "function" && hasDirtyDraft(tab.value) ? " wh-tab-hasdraft" : "";
      tabsHtml += `<div class="wh-tab wh-tab-art${isActive}${hasDraft}" data-tab="${tab.id}" data-art-type="${esc(tab.type || 'file')}" data-art-value="${esc(tab.value || '')}" title="${esc(tab.label)}">${iconHtml}<span class="wh-tab-label">${esc(tab.label)}</span><span class="wh-tab-x" data-close-tab="${tab.id}">×</span></div>`;
    });
  }

  const layoutIcon = layoutMode === "tabs" ? mkLayoutIcon("tabs") : layoutMode === "vsplit" ? mkLayoutIcon("vsplit") : mkLayoutIcon("hsplit");

  const cwdDisplay = s.cwd ? shortenPath(s.cwd) : "";
  const cwdHtml = cwdDisplay ? `<div class="wh-cwd" title="${esc(s.cwd)}">${esc(cwdDisplay)}</div>` : "";

  el.innerHTML = `
    <div class="wh-left">
      ${closeBtn}
      <div class="wh-av" style="background:${avBg}">${isExplorationTheme() ? renderThemeAvatar(s, "wh") : `<span>${code}</span>`}</div>
      <div class="wh-label"><span class="wh-name">${esc(name)}</span></div>
    </div>
    <div class="wh-mid">${cwdHtml}</div>
    <div class="wh-right">
      ${tabsHtml}
      <div class="wh-tab-add" title="New shell (Alt+T)">❯</div>
      <div class="wh-layout-btn" title="Toggle layout: tabs / vertical / horizontal">${layoutIcon}</div>
    </div>
  `;

  el.querySelectorAll(".wh-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("wh-tab-x")) return;
      switchTab(tab.dataset.tab);
    });
  });

  el.querySelectorAll(".wh-tab-x").forEach((x) => {
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(x.dataset.closeTab);
    });
  });

  // Artifact tab right-click context menu
  el.querySelectorAll(".wh-tab-art").forEach((tab) => {
    tab.addEventListener("contextmenu", (e) => {
      showArtifactTabContextMenu(e, {
        type: tab.dataset.artType || "file",
        value: tab.dataset.artValue || "",
        label: tab.title || "",
      });
    });
  });

  const closeEl = el.querySelector(".wh-close");
  if (closeEl) {
    closeEl.addEventListener("click", () => closeSession(activeSessionId));
  }

  const addShellBtn = el.querySelector(".wh-tab-add");
  if (addShellBtn) {
    addShellBtn.addEventListener("click", () => createShellTab());
  }

  const layoutBtn = el.querySelector(".wh-layout-btn");
  if (layoutBtn) {
    layoutBtn.addEventListener("click", () => cycleLayout());
  }

  const nameEl = el.querySelector(".wh-name");
  if (nameEl) {
    nameEl.style.cursor = "pointer";
    nameEl.title = "Click to rename";
    nameEl.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "wh-name-edit";
      input.value = s.name;
      input.spellcheck = false;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        const val = input.value.trim();
        if (val && val !== s.name) {
          s.name = val;
          await fetch(`/api/sessions/${s.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: val }),
          });
          await fetchSessions();
        }
        render();
      };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { render(); }
      });
    });
  }

  const avEl = el.querySelector(".wh-av");
  if (avEl) {
    avEl.style.cursor = "pointer";
    avEl.title = "Click to change icon";
    avEl.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "wh-icon-edit";
      input.value = s.icon || "";
      input.placeholder = getAgentIcon(s);
      input.maxLength = 3;
      input.spellcheck = false;
      avEl.innerHTML = "";
      avEl.appendChild(input);
      input.focus();
      input.select();
      const save = async () => {
        const val = input.value.trim();
        s.icon = val || null;
        await fetch(`/api/sessions/${s.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ icon: val || null }),
        });
        await fetchSessions();
        render();
      };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { render(); }
      });
    });
  }

}

function mkLayoutIcon(mode) {
  if (mode === "tabs") {
    return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
  }
  if (mode === "vsplit") {
    return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="1.2"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

function cycleLayout() {
  if (activeTab === "notes") saveNotes();
  if (layoutMode === "tabs") layoutMode = "vsplit";
  else if (layoutMode === "vsplit") layoutMode = "hsplit";
  else layoutMode = "tabs";

  if (layoutMode !== "tabs") activeTab = "terminal";

  renderWorkHeader();
  renderWorkContent();
  deferredFit();
  saveUIState();
}

function renderWorkContent() {
  const wsContent = document.getElementById("ws-content");
  const termContainer = document.getElementById("terminal-container");
  const notesContainer = document.getElementById("notes-container");

  // Stash cached artifacts to pool before cleaning up
  stashArtifacts();

  // Clean up dynamic split panes
  wsContent.querySelectorAll(".split-pane-wrap, .split-pane, .split-handle").forEach((el) => el.remove());
  let artContainer = document.getElementById("artifact-container");
  if (!artContainer) {
    artContainer = document.createElement("div");
    artContainer.id = "artifact-container";
    wsContent.appendChild(artContainer);
  }

  termContainer.classList.remove("active");
  notesContainer.classList.remove("active");
  artContainer.classList.remove("active");
  artContainer.style.display = "none";
  termContainer.style.width = "";
  termContainer.style.height = "";
  termContainer.style.flex = "";
  wsContent.classList.remove("ws-vsplit", "ws-hsplit");

  // Hide all shell containers
  wsContent.querySelectorAll(".shell-container").forEach((el) => {
    el.classList.remove("active");
    el.style.display = "none";
  });

  const s = sessions.find((s) => s.id === activeSessionId);
  const openTabs = s ? getOpenTabs(s) : [];

  if (layoutMode === "tabs" || openTabs.length === 0) {
    // Tab mode or nothing extra open — single pane
    if (activeTab === "terminal") {
      termContainer.classList.add("active");
    } else if (activeTab === "notes") {
      notesContainer.classList.add("active");
      loadNotes();
    } else if (activeTab.startsWith("artifact:")) {
      showArtifactInContainer(artContainer, s, activeTab);
    } else if (activeTab.startsWith("shell:")) {
      const key = `${activeSessionId}:${activeTab}`;
      const shell = shellInstances.get(key);
      if (shell) {
        shell.container.classList.add("active");
        shell.container.style.display = "block";
        requestAnimationFrame(() => {
          shell.fitAddon.fit();
          if (shell.ws && shell.ws.readyState === WebSocket.OPEN) {
            shell.ws.send(JSON.stringify({ type: "resize", cols: shell.term.cols, rows: shell.term.rows }));
          }
        });
      }
    }
  } else {
    // Split mode — terminal + all open tabs side by side
    wsContent.classList.add(layoutMode === "vsplit" ? "ws-vsplit" : "ws-hsplit");
    termContainer.classList.add("active");
    termContainer.style.flex = "1";

    openTabs.forEach((tab) => {
      const handle = document.createElement("div");
      handle.className = "split-handle " + (layoutMode === "vsplit" ? "split-handle-v" : "split-handle-h");
      wsContent.appendChild(handle);

      if (tab.id.startsWith("shell:")) {
        // Shell tab in split mode — show its container as a pane
        const key = `${activeSessionId}:${tab.id}`;
        const shell = shellInstances.get(key);
        if (shell) {
          shell.container.classList.add("active");
          shell.container.style.display = "block";
          shell.container.style.flex = "1";
          shell.container.style.minWidth = "80px";
          shell.container.style.minHeight = "80px";
          // Move container to correct position in wsContent
          wsContent.appendChild(shell.container);
          requestAnimationFrame(() => {
            shell.fitAddon.fit();
            if (shell.ws && shell.ws.readyState === WebSocket.OPEN) {
              shell.ws.send(JSON.stringify({ type: "resize", cols: shell.term.cols, rows: shell.term.rows }));
            }
          });
        }
        initSplitResize(handle, layoutMode);
      } else {
        // Wrapper carries the flex sizing and hosts the corner close button —
        // the pane's own innerHTML is rebuilt constantly (edit toggles,
        // reloads), so the button must live OUTSIDE it.
        const wrap = document.createElement("div");
        wrap.className = "split-pane-wrap";
        const pane = document.createElement("div");
        pane.className = "split-pane";
        renderPaneContent(pane, tab.id, s);
        wrap.appendChild(pane);
        const x = document.createElement("div");
        x.className = "split-pane-close";
        x.title = "Close pane";
        x.textContent = "×";
        x.addEventListener("click", () => closeTab(tab.id));
        wrap.appendChild(x);
        wsContent.appendChild(wrap);
        initSplitResize(handle, layoutMode);
      }
    });
  }

  // Start/stop mtime polling for file-based artifacts
  startArtifactMtimePolling();
}

// ═══ ARTIFACT PANE ═══ — artifact cache/show/stop/stash/reload, mtime polling and
// split-pane content rendering (renderPaneContent) moved to artifacts.js.

function saveSplitNotes() {
  const textarea = document.querySelector(".split-pane-notes");
  if (!textarea) return;
  const val = textarea.value;
  const s = sessions.find((s) => s.id === activeSessionId);
  if (s) s.notes = val;
  const rp = document.getElementById("rp-notes-textarea");
  if (rp && rp !== document.activeElement) rp.value = val;
  debounceSaveNotes(val);
}

function initSplitResize(handle, mode) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const isV = mode === "vsplit";
    const prev = handle.previousElementSibling;
    const next = handle.nextElementSibling;
    if (!prev || !next) return;

    const startPos = isV ? e.clientX : e.clientY;
    const prevSize = isV ? prev.offsetWidth : prev.offsetHeight;
    const nextSize = isV ? next.offsetWidth : next.offsetHeight;
    const total = prevSize + nextSize;

    document.body.style.cursor = isV ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (e) => {
      const pos = isV ? e.clientX : e.clientY;
      const delta = pos - startPos;
      const newPrev = Math.max(80, Math.min(total - 80, prevSize + delta));
      const newNext = total - newPrev;
      prev.style.flex = `${newPrev} 0 0px`;
      next.style.flex = `${newNext} 0 0px`;
      safeFit();
    };

    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      safeFit();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ═══ MARKDOWN RENDERING ═══ — extracted to markdown.js (loaded before this file).
// markdown/HTML artifact preview + vim editor lifecycle (toggleEditMode/openVimEditor/etc) live there.

// ═══ CSV / CODE / ARTIFACT VIEW ═══ — CSV table, code/SQL renderers, copy/download
// actions, artifact tab context menu and renderArtifactView moved to artifacts.js.

function loadNotes() {
  const textarea = document.getElementById("notes-textarea");
  const s = sessions.find((s) => s.id === activeSessionId);
  textarea.value = s?.notes || "";
  textarea.focus();
}

function saveNotes() {
  const textarea = document.getElementById("notes-textarea");
  const val = textarea.value;
  const s = sessions.find((s) => s.id === activeSessionId);
  if (s) s.notes = val;
  const rp = document.getElementById("rp-notes-textarea");
  if (rp && rp !== document.activeElement) rp.value = val;
  debounceSaveNotes(val);
}

function getOpenTabs(session) {
  const tabs = [];
  const open = openTabsPerSession[session.id] || new Set();
  const artifacts = session.artifacts || [];

  // Shell tabs
  const shellTabs = [];
  for (const tabId of open) {
    if (tabId.startsWith("shell:")) {
      const n = parseInt(tabId.split(":")[1]);
      shellTabs.push({ id: tabId, label: `Shell ${n}`, n });
    }
  }
  // Also include if activeTab is a shell tab not yet in set
  if (activeTab && activeTab.startsWith("shell:") && !open.has(activeTab)) {
    const n = parseInt(activeTab.split(":")[1]);
    shellTabs.push({ id: activeTab, label: `Shell ${n}`, n });
  }
  shellTabs.sort((a, b) => a.n - b.n);
  shellTabs.forEach((t) => tabs.push({ id: t.id, label: t.label }));

  if (open.has("notes") || activeTab === "notes") {
    tabs.push({ id: "notes", label: "Notes" });
  }

  artifacts.forEach((a, i) => {
    const tabId = `artifact:${i}`;
    if (open.has(tabId) || activeTab === tabId) {
      const label = a.label || (a.type === "url" ? new URL(a.value).hostname : a.value.split("/").pop());
      tabs.push({ id: tabId, label, type: a.type, value: a.value });
    }
  });

  return tabs;
}

function openTab(tabId) {
  if (!openTabsPerSession[activeSessionId]) openTabsPerSession[activeSessionId] = new Set();
  openTabsPerSession[activeSessionId].add(tabId);
}

function closeTab(tabId) {
  if (tabId.startsWith("shell:")) {
    closeShellTab(tabId);
    return;
  }
  if (tabId.startsWith("artifact:")) {
    const session = sessions.find(s => s.id === activeSessionId);
    if (session) stopArtifactServer(session, tabId);
  }
  if (activeTab === "notes" || tabId === "notes") saveNotes();
  const open = openTabsPerSession[activeSessionId];
  if (open) open.delete(tabId);
  if (activeTab === tabId) activeTab = "terminal";
  renderWorkHeader();
  renderWorkContent();
  deferredFit();
  saveUIState();
}

function switchTab(tabId) {
  if (activeTab === "notes") saveNotes();
  openTab(tabId);

  if (layoutMode !== "tabs") {
    activeTab = "terminal";
    renderWorkHeader();
    renderWorkContent();
    deferredFit();
    saveUIState();
    return;
  }

  if (tabId === activeTab) return;
  activeTab = tabId;
  renderWorkHeader();
  renderWorkContent();
  if (tabId === "terminal") {
    deferredFit();
    term.focus();
  } else if (tabId.startsWith("shell:")) {
    const key = `${activeSessionId}:${tabId}`;
    const shell = shellInstances.get(key);
    if (shell) {
      requestAnimationFrame(() => {
        shell.fitAddon.fit();
        shell.term.focus();
      });
    }
  }
  saveUIState();
}

// removeArtifact moved to artifacts.js.

// ═══ SVG ICONS ═══
function mkIcon(state, size) {
  const s = size || 14;
  const r = s * 0.38;
  const cx = s / 2;
  if (state === "working") {
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#21262d" stroke-width="1.5"/><path d="M${cx} ${cx - r}a${r} ${r} 0 0 1 ${r} ${r}" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  if (state === "blocked") {
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#f85149" stroke-width="1.5" stroke-dasharray="2.5 2.5"/></svg>`;
  }
  if (state === "done") {
    const cr = r * 0.45;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#3fb950" stroke-width="1.5"/><path d="M${cx - cr} ${cx}l${cr * 0.7} ${cr * 0.7} ${cr * 1.4} -${cr * 1.4}" fill="none" stroke="#3fb950" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#484f58" stroke-width="1.5" stroke-dasharray="2.5 2.5"/></svg>`;
}

// ═══ AGENT DECK (Zone A) ═══
function getAgentIcon(s) {
  if (s.icon) return s.icon;
  const name = s.name || s.id;
  return name.slice(0, 2).toUpperCase();
}

function renderDeck() {
  const el = document.getElementById("deck-groups");
  const statusMode = deckGroupBy === "status";
  const groups = getDeckSections();
  let html = "";
  let idx = 0;

  groups.forEach((g, gi) => {
    if (gi > 0 && html) html += '<div class="deck-sep"></div>';

    const groupKey = g.label.toLowerCase();
    // In status mode the header is a state label (not editable / not a drop target);
    // omit data-group-name so the rename/contextmenu handlers don't bind to it.
    const labelAttrs = statusMode
      ? ` data-status="${esc(g.status)}"`
      : ` data-group-name="${esc(g.label)}"`;
    html += `<div class="deck-group${statusMode ? " deck-group-status" : ""}" data-group="${esc(groupKey)}">`;
    html += `<div class="deck-group-label"${labelAttrs}>${esc(g.label)}</div>`;
    html += `<div class="deck-cards">`;

    g.items.forEach((s) => {
      idx++;
      html += mkDeckCard(s, idx, !statusMode);
    });

    if (!statusMode) {
      const gc = groupConfig[g.label] || {};
      if (gc.expandable !== false) {
        html += `<div class="dk-add dk-add-sm" title="Add agent to ${esc(g.label)}" data-add-group="${esc(g.label)}">+</div>`;
      }
      // Empty, non-protected group → offer a visible delete button (no right-click needed)
      if (g.items.length === 0 && gc.expandable !== false) {
        html += `<div class="dk-del dk-add-sm" title="Delete empty group "${esc(g.label)}"" data-del-group="${esc(g.label)}">×</div>`;
      }
    }
    html += `</div></div>`;
  });

  if (!statusMode) {
    // Global "+" button to create new group
    if (html) html += '<div class="deck-sep"></div>';
    html += `<div class="dk-add dk-add-sm dk-add-global" title="New group">+</div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll(".dk[data-sid]").forEach((card) => {
    card.addEventListener("click", () => switchSession(card.dataset.sid));
  });

  // ── Drag and drop (group axis only; status buckets aren't reorderable) ──
  if (!statusMode) initDeckDragAndDrop(el);

  el.querySelectorAll(".dk-add[data-add-group]").forEach((btn) => {
    btn.addEventListener("click", (e) => showAddPopover(e, btn.dataset.addGroup));
  });

  el.querySelectorAll(".dk-del[data-del-group]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteGroup(btn.dataset.delGroup);
    });
  });

  const globalAdd = el.querySelector(".dk-add-global");
  if (globalAdd) {
    globalAdd.addEventListener("click", (e) => showAddPopover(e, null));
  }

  el.querySelectorAll(".deck-group-label[data-group-name]").forEach((label) => {
    label.addEventListener("dblclick", () => {
      const oldName = label.dataset.groupName;
      const input = document.createElement("input");
      input.className = "deck-group-edit";
      input.value = oldName;
      input.spellcheck = false;
      label.textContent = "";
      label.appendChild(input);
      input.focus();
      input.select();
      const save = async () => {
        const newName = input.value.trim();
        if (newName && newName !== oldName) {
          // Match case-insensitively — the label may merge several casings.
          const toUpdate = sessions.filter((s) => (s.group || "Workers").toLowerCase() === oldName.toLowerCase());
          await Promise.all(toUpdate.map((s) => {
            s.group = newName;
            return fetch(`/api/sessions/${s.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ group: newName }),
            });
          }));
          // Update persisted group list
          if (workspaceGroups) {
            const seen = new Set();
            const list = workspaceGroups
              .map((g) => g.toLowerCase() === oldName.toLowerCase() ? newName : g)
              .filter((g) => { const k = g.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
            await saveWorkspaceGroups(list);
          }
        }
        await fetchSessions();
        render();
      };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { render(); }
      });
    });

    // Right-click to delete empty groups
    label.addEventListener("contextmenu", (e) => {
      const groupName = label.dataset.groupName;
      const groupItems = sessions.filter((s) => (s.group || "Workers").toLowerCase() === groupName.toLowerCase());
      if (groupItems.length > 0) return;
      e.preventDefault();
      const menu = document.getElementById("ctx-menu");
      menu.innerHTML = `<div class="cm-item danger" data-action="delete-group" data-group="${esc(groupName)}">Delete "${esc(groupName)}"</div>`;
      menu.style.display = "block";
      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";
      menu.querySelector(".cm-item").addEventListener("click", () => {
        hideCtxMenu();
        deleteGroup(groupName);
      });
    });
  });
}

function mkDeckCard(s, idx, allowDrag = true) {
  const state = s.state || "idle";
  const isActive = s.id === activeSessionId;
  const name = (s.name || s.id).toUpperCase();
  const code = getAgentIcon(s);
  const stateClass = state !== "idle" ? ` dk-${state}` : "";
  const activeClass = isActive ? " active" : "";

  const avBg = state === "working" ? "#1a2332" : state === "done" ? "#1a2e1a" : state === "blocked" ? "#2a1318" : "#363c46";
  const ring = state === "working" ? `<div class="dk-ring"></div>` : "";
  const needsDot = state === "done" || state === "blocked";
  const dotColor = state === "done" ? "#3fb950" : "#f85149";
  const dot = needsDot ? `<div class="dk-dot" style="background:${dotColor}"></div>` : "";

  let avatarInner;
  if (isExplorationTheme()) {
    avatarInner = renderThemeAvatar(s, "dk");
  } else {
    avatarInner = `${ring}<span class="dk-code">${code}</span>${dot}`;
  }
  const avatar = `<div class="dk-av" style="background:${avBg}">${avatarInner}</div>`;

  let sub, subClass;
  if (state === "done") { sub = "needs review"; subClass = "dk-sub-done"; }
  else if (state === "blocked") {
    sub = isExplorationTheme() ? rpgBlockedLine(s) : esc(s.blockReason || "blocked");
    subClass = "dk-sub-blocked";
  }
  else if (state === "working") { sub = formatWorkingSubstatus(s); subClass = "dk-sub-working"; }
  else { sub = "idle"; subClass = "dk-sub-idle"; }

  const draggable = allowDrag ? ` draggable="true"` : "";
  return `<div class="dk${stateClass}${activeClass}" data-sid="${s.id}"${draggable} oncontextmenu="showCtxMenu(event,'${s.id}')">${avatar}<div class="dk-info"><div class="dk-name">${esc(name)}</div><div class="dk-sub ${subClass}">${sub}</div></div></div>`;
}

// ═══ DRAG AND DROP ═══
let draggedSessionId = null;

function initDeckDragAndDrop(el) {
  el.querySelectorAll(".dk[data-sid][draggable]").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggedSessionId = card.dataset.sid;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.sid);
      requestAnimationFrame(() => card.classList.add("dragging"));
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggedSessionId = null;
      clearAllDragIndicators(el);
    });
  });

  // Dragover and drop on deck cards
  el.querySelectorAll(".dk[data-sid]").forEach((card) => {
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (card.dataset.sid === draggedSessionId) return;
      clearAllDragIndicators(el);
      const rect = card.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        card.classList.add("drag-over-left");
      } else {
        card.classList.add("drag-over-right");
      }
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over-left", "drag-over-right");
    });

    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const sid = e.dataTransfer.getData("text/plain");
      if (!sid || sid === card.dataset.sid) { clearAllDragIndicators(el); return; }
      const rect = card.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const insertBefore = e.clientX < midX;
      const targetGroup = card.closest(".deck-group")?.dataset.group;
      handleDrop(sid, card.dataset.sid, insertBefore, targetGroup);
      clearAllDragIndicators(el);
    });
  });

  // Dragover and drop on deck-cards containers (for dropping at end of group)
  el.querySelectorAll(".deck-cards").forEach((container) => {
    container.addEventListener("dragover", (e) => {
      // Only handle if dragging over the container itself or the add button, not over a card
      if (e.target.closest(".dk[data-sid]")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearAllDragIndicators(el);
      container.classList.add("drag-over");
    });

    container.addEventListener("dragleave", (e) => {
      if (!container.contains(e.relatedTarget)) {
        container.classList.remove("drag-over");
      }
    });

    container.addEventListener("drop", (e) => {
      if (e.target.closest(".dk[data-sid]")) return;
      e.preventDefault();
      const sid = e.dataTransfer.getData("text/plain");
      if (!sid) { clearAllDragIndicators(el); return; }
      const groupEl = container.closest(".deck-group");
      const targetGroup = groupEl?.dataset.group;
      // Drop at end of group
      handleDrop(sid, null, false, targetGroup);
      clearAllDragIndicators(el);
    });
  });
}

function clearAllDragIndicators(el) {
  el.querySelectorAll(".drag-over-left, .drag-over-right").forEach((c) => {
    c.classList.remove("drag-over-left", "drag-over-right");
  });
  el.querySelectorAll(".drag-over").forEach((c) => c.classList.remove("drag-over"));
}

function handleDrop(draggedId, targetId, insertBefore, targetGroupKey) {
  const groups = getSessionGroups();
  // Find the target group by the lowercase key
  let targetGroup = null;
  for (const g of groups) {
    if (g.label.toLowerCase() === targetGroupKey) { targetGroup = g; break; }
  }
  if (!targetGroup) return;

  // Remove dragged session from its current group
  const draggedSession = sessions.find((s) => s.id === draggedId);
  if (!draggedSession) return;

  // Build new items list for target group
  let items = targetGroup.items.filter((s) => s.id !== draggedId);
  // Also remove from source group if different
  const sourceGroup = groups.find((g) => g.items.some((s) => s.id === draggedId));

  if (targetId) {
    const targetIdx = items.findIndex((s) => s.id === targetId);
    if (targetIdx === -1) {
      items.push(draggedSession);
    } else {
      items.splice(insertBefore ? targetIdx : targetIdx + 1, 0, draggedSession);
    }
  } else {
    // Drop at end
    items.push(draggedSession);
  }

  // Build the reorder payload: update sortOrder for all items in target group
  const order = items.map((s, i) => ({
    id: s.id,
    sortOrder: i,
    group: targetGroup.label,
  }));

  // If source group is different, also re-index the source group
  if (sourceGroup && sourceGroup.label !== targetGroup.label) {
    const sourceItems = sourceGroup.items.filter((s) => s.id !== draggedId);
    sourceItems.forEach((s, i) => {
      order.push({ id: s.id, sortOrder: i });
    });
  }

  // Optimistic update: apply locally
  for (const item of order) {
    const s = sessions.find((x) => x.id === item.id);
    if (s) {
      s.sortOrder = item.sortOrder;
      if (item.group !== undefined) s.group = item.group;
    }
  }
  syncGroupList();
  renderDeck();

  // Persist to server
  fetch("/api/sessions/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  }).catch((err) => console.error("Failed to persist reorder:", err));
}

// ═══ CONTEXT PANEL (Zone C) ═══
function renderRightPanel() {
  const el = document.getElementById("right");
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  if (!activeSession) { el.innerHTML = ""; return; }

  const artHtml = buildArtifactsSection(activeSession);
  const noteVal = activeSession.notes || "";
  const notesHtml = `<div class="rp-hdr rp-hdr-notes" title="Double-click to expand">Notes</div><div style="flex:1;display:flex;min-height:80px"><textarea class="rp-notes-area" id="rp-notes-textarea" placeholder="Write notes here..." oninput="saveRpNotes()">${esc(noteVal)}</textarea></div>`;

  el.innerHTML = `
    <div class="rp-section" style="flex:2;min-height:40px"><div class="rp-body">${artHtml}</div></div>
    <div class="rp-section" style="flex:1;min-height:60px;display:flex;flex-direction:column">${notesHtml}</div>
  `;

  el.querySelectorAll(".af[data-art-idx]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("af-rm")) return;
      switchTab(`artifact:${row.dataset.artIdx}`);
    });
  });

  el.querySelectorAll(".af-rm").forEach((x) => {
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeArtifact(parseInt(x.dataset.artRm));
    });
  });

  el.querySelectorAll(".af-group-hdr").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const group = hdr.parentElement;
      const isOpen = group.classList.toggle("open");
      const dirIcon = hdr.querySelector(".af-dir-icon");
      if (dirIcon) dirIcon.innerHTML = folderIcon(isOpen, 15);
      // Remember the collapse so the 3s deck refresh doesn't re-open it.
      const dir = group.dataset.afDir;
      if (dir) {
        const set = (collapsedArtFolders[activeSession.id] ||= new Set());
        if (isOpen) set.delete(dir); else set.add(dir);
      }
    });
  });

  const addBtn = document.getElementById("af-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", (e) => showArtifactPopover(e));
  }

  // Related agent expand/collapse
  el.querySelectorAll(".ra-expandable").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("ra-rm") || e.target.classList.contains("ra-name")) return;
      const rid = row.dataset.raId;
      const artsDiv = el.querySelector(`.ra-arts[data-ra-arts="${rid}"]`);
      if (artsDiv) {
        const isOpen = artsDiv.classList.toggle("open");
        row.querySelector(".ra-arrow").innerHTML = isOpen ? "&#9660;" : "&#9654;";
      }
    });
  });

  // Related agent name click → switch; Shift+click → side-by-side
  el.querySelectorAll(".ra-name[data-ra-switch]").forEach((name) => {
    name.addEventListener("click", (e) => {
      e.stopPropagation();
      const rid = name.dataset.raSwitch;
      if (e.shiftKey) {
        layoutMode = "vsplit";
        perSessionLayout[activeSessionId] = "vsplit";
        const shellId = `ra-${rid}`;
        if (!openTabsPerSession[activeSessionId]) openTabsPerSession[activeSessionId] = new Set();
        openTabsPerSession[activeSessionId].add(`shell:${shellId}`);
        activeTab = "terminal";
        saveUIState();
        render();
      } else {
        switchSession(rid);
      }
    });
    name.title = "Click to switch · Shift+click for side-by-side";
  });

  // Related agent remove
  el.querySelectorAll(".ra-rm[data-ra-rm]").forEach((x) => {
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRelatedAgent(x.dataset.raRm);
    });
  });

  // Related agent artifact click → open in current agent's work area
  el.querySelectorAll(".ra-art-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const agentId = item.dataset.raArtAgent;
      const artIdx = parseInt(item.dataset.raArtIdx);
      const relAgent = sessions.find(s => s.id === agentId);
      if (!relAgent) return;
      const art = (relAgent.artifacts || [])[artIdx];
      if (!art) return;
      const curSession = sessions.find(s => s.id === activeSessionId);
      if (!curSession) return;
      const existingIdx = (curSession.artifacts || []).findIndex(a => a.value === art.value);
      if (existingIdx >= 0) {
        switchTab(`artifact:${existingIdx}`);
      } else {
        await addArtifact(art.type || "file", art.value, art.label || art.value.split("/").pop());
      }
    });
  });

  // Add related agent button
  const raAddBtn = document.getElementById("ra-add-btn");
  if (raAddBtn) {
    raAddBtn.addEventListener("click", (e) => showRelatedAgentPopover(e));
  }

  const notesHdr = el.querySelector(".rp-hdr-notes");
  if (notesHdr) {
    notesHdr.addEventListener("dblclick", () => switchTab("notes"));
    notesHdr.style.cursor = "pointer";
  }
}

function buildArtifactsSection(activeSession) {
  let html = `<div class="rp-hdr">Artifacts</div>`;
  const artifacts = activeSession.artifacts || [];

  // Group artifacts by directory
  const groups = new Map(); // dir -> [{art, idx}]
  const topLevel = []; // artifacts with no dir or single segment
  artifacts.forEach((a, i) => {
    if (a.type === "url") { topLevel.push({ art: a, idx: i }); return; }
    const parts = (a.value || "").split("/");
    if (parts.length <= 1) { topLevel.push({ art: a, idx: i }); return; }
    const filename = parts.pop();
    const dir = parts.join("/");
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ art: a, idx: i, filename });
  });

  // Render directory groups
  groups.forEach((items, dir) => {
    const dirName = dir.split("/").pop() || dir;
    if (items.length === 1) {
      // Single file in dir — show flat, not grouped
      topLevel.push(items[0]);
      return;
    }
    const collapsed = (collapsedArtFolders[activeSession.id] || new Set()).has(dir);
    html += `<div class="af-group${collapsed ? "" : " open"}" data-af-dir="${esc(dir)}">`;
    html += `<div class="af-group-hdr"><span class="af-arrow">&#9654;</span><span class="af-dir-icon">${folderIcon(!collapsed, 15)}</span> ${esc(dirName)}</div>`;
    html += `<div class="af-group-body">`;
    items.forEach(({ art, idx, filename }) => {
      const icon = fileIcon(filename, 15);
      html += `<div class="af" data-art-idx="${idx}"><span class="af-i">${icon}</span><span class="af-label">${esc(art.label || filename)}</span><span class="af-rm" data-art-rm="${idx}" title="Remove">×</span></div>`;
    });
    html += `</div></div>`;
  });

  // Render top-level artifacts
  topLevel.forEach(({ art, idx, filename: fn }) => {
    const name = fn || (art.value ? art.value.split("/").pop() : "");
    const icon = art.type === "url"
      ? `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#58a6ff" stroke-width="1"/><ellipse cx="8" cy="8" rx="3" ry="6.5" stroke="#58a6ff" stroke-width="0.8"/><line x1="1.5" y1="8" x2="14.5" y2="8" stroke="#58a6ff" stroke-width="0.8"/></svg>`
      : fileIcon(name, 15);
    const label = art.type === "url" ? (art.label || art.value) : esc(art.label || name);
    html += `<div class="af" data-art-idx="${idx}"><span class="af-i">${icon}</span><span class="af-label">${label}</span><span class="af-rm" data-art-rm="${idx}" title="Remove">×</span></div>`;
  });

  html += `<div class="af-add" id="af-add-btn">+ add artifact</div>`;


  // Related agents section
  html += `<div class="rp-hdr rp-hdr-related" style="margin-top:12px">Related</div>`;
  const related = activeSession.relatedAgents || [];
  related.forEach((rid) => {
    const rel = sessions.find((s) => s.id === rid);
    if (!rel) return;
    const relArts = rel.artifacts || [];
    const stateIcon = mkIcon(rel.state, 12);
    const hasArts = relArts.length > 0;
    html += `<div class="ra-agent${hasArts ? " ra-expandable" : ""}" data-ra-id="${esc(rid)}">`;
    html += `<span class="ra-arrow">${hasArts ? "&#9654;" : ""}</span>`;
    html += `<span class="ra-icon">${stateIcon}</span>`;
    html += `<span class="ra-name" data-ra-switch="${esc(rid)}" title="Click to switch">${esc(rel.name.toUpperCase())}</span>`;
    html += `<span class="ra-rm" data-ra-rm="${esc(rid)}" title="Remove">×</span>`;
    html += `</div>`;
    if (hasArts) {
      html += `<div class="ra-arts" data-ra-arts="${esc(rid)}">`;
      relArts.forEach((art, ai) => {
        const artIcon = art.type === "url" ? `<span class="ext-badge" style="background:#58a6ff">URL</span>` : fileExtIcon(art.value);
        const artLabel = art.label || (art.type === "url" ? art.value : art.value.split("/").pop());
        html += `<div class="af ra-art-item" data-ra-art-agent="${esc(rid)}" data-ra-art-idx="${ai}"><span class="af-i">${artIcon}</span><span class="af-label">${esc(artLabel)}</span></div>`;
      });
      html += `</div>`;
    }
  });
  html += `<div class="af-add" id="ra-add-btn">+ add related agent</div>`;

  return html;
}

function buildGroupArtifacts(label, agents) {
  let html = `<div class="af-group" onclick="this.classList.toggle('open')">`;
  html += `<div class="af-group-hdr"><span class="af-arrow">&#9654;</span> ${label}</div>`;
  html += `<div class="af-group-body">`;
  agents.forEach((a) => {
    (a.artifacts || []).forEach((art) => {
      const icon = art.type === "url" ? "\u{1F310}" : "\u{1F4C4}";
      const artLabel = art.label || (art.type === "url" ? art.value : art.value.split("/").pop());
      html += `<div class="af"><span class="af-i">${icon}</span>${a.name.toUpperCase()} / ${esc(artLabel)}</div>`;
    });
  });
  html += `</div></div>`;
  return html;
}

// ═══ NOTES ═══
function saveRpNotes() {
  const textarea = document.getElementById("rp-notes-textarea");
  if (!textarea) return;
  const val = textarea.value;
  const s = sessions.find((s) => s.id === activeSessionId);
  if (s) s.notes = val;
  const main = document.getElementById("notes-textarea");
  if (main && main !== document.activeElement) main.value = val;
  debounceSaveNotes(val);
}

function debounceSaveNotes(val) {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(() => {
    fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: val }),
    });
  }, 500);
}

// ═══ UTILITIES ═══
function shortenPath(p) {
  if (!p) return "";
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? m + "m" : Math.floor(m / 60) + "h" + (m % 60) + "m";
}

function formatWorkingSubstatus(s) {
  const sub = s.substatus;
  if (!sub) return "working...";
  if (sub.type === "thinking") {
    let text = "thinking";
    if (sub.duration) text += ` · ${sub.duration}`;
    if (sub.tokens) text += ` · ${sub.tokens} tok`;
    return text;
  }
  if (sub.type === "tool") {
    return sub.tool ? `running ${sub.tool}` : "running tool...";
  }
  if (sub.type === "streaming") {
    let text = "responding";
    if (sub.duration) text += ` · ${sub.duration}`;
    if (sub.tokens) text += ` · ${sub.tokens} tok`;
    return text;
  }
  if (sub.type === "compacting") {
    let text = "compacting";
    if (sub.duration) text += ` · ${sub.duration}`;
    return text;
  }
  if (sub.type === "agents") {
    return sub.count > 1 ? `${sub.count} agents running` : "agent running";
  }
  if (sub.type === "shell") {
    return sub.count > 1 ? `${sub.count} shells running` : "shell running";
  }
  if (sub.type === "responding") {
    return "responding...";
  }
  if (sub.type === "retrying") {
    return "retrying API...";
  }
  return "working...";
}

// ═══ MARIMO NOTEBOOK ═══ — moved to artifacts.js.

function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ═══ JUPYTER NOTEBOOK ═══ — moved to artifacts.js.

// ═══ ADD AGENT POPOVER ═══
function getNextName(group) {
  if (group === "Command") return "Planner";
  const existing = sessions.filter((s) => s.group === group);
  for (let i = 1; i <= 99; i++) {
    const name = group + "-" + i;
    if (!existing.some((s) => s.name.toUpperCase() === name.toUpperCase())) return name;
  }
  return group + "-99";
}

function showAddPopover(e, group) {
  hideAddPopover();
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.id = "add-popover";
  pop.className = "add-popover";

  if (group) {
    // In-group "+": only agent name needed
    const defaultName = getNextName(group);
    pop.innerHTML = `
      <div class="add-pop-label">Add to ${esc(group)}</div>
      <input class="add-pop-input" id="add-agent-name" type="text" value="${esc(defaultName)}" spellcheck="false" />
      <div class="add-pop-hint">Enter to create · Esc to cancel</div>
    `;

    document.body.appendChild(pop);
    pop.style.left = (rect.left + rect.width / 2 - 100) + "px";
    pop.style.top = (rect.bottom + 8) + "px";

    const input = pop.querySelector("#add-agent-name");
    input.focus();
    input.select();

    const handleKey = async (ev) => {
      if (ev.key === "Escape") { hideAddPopover(); return; }
      if (ev.key === "Enter") {
        const agentName = input.value.trim();
        if (!agentName) return;
        hideAddPopover();
        await createAgent(agentName, group);
      }
    };
    input.addEventListener("keydown", handleKey);
  } else {
    // Global "+": create empty group only
    pop.innerHTML = `
      <div class="add-pop-label">New group</div>
      <input class="add-pop-input" id="add-group-name" type="text" placeholder="Group name" spellcheck="false" />
      <div class="add-pop-hint">Enter to create · Esc to cancel</div>
    `;

    document.body.appendChild(pop);
    pop.style.left = (rect.left + rect.width / 2 - 100) + "px";
    pop.style.top = (rect.bottom + 8) + "px";

    const input = pop.querySelector("#add-group-name");
    input.focus();

    const handleKey = async (ev) => {
      if (ev.key === "Escape") { hideAddPopover(); return; }
      if (ev.key === "Enter") {
        const groupName = input.value.trim();
        if (!groupName) return;
        hideAddPopover();
        await createEmptyGroup(groupName);
      }
    };
    input.addEventListener("keydown", handleKey);
  }

  setTimeout(() => {
    document.addEventListener("click", onClickOutsidePopover);
  }, 0);
}

async function createEmptyGroup(groupName) {
  const groups = getSessionGroups();
  if (groups.some((g) => g.label === groupName)) return;
  const list = groups.map((g) => g.label);
  list.push(groupName);
  await saveWorkspaceGroups(list);
  render();
}

async function deleteGroup(groupName) {
  const groups = getSessionGroups();
  const g = groups.find((g) => g.label === groupName);
  if (!g || g.items.length > 0) return;
  const list = groups.map((g) => g.label).filter((n) => n !== groupName);
  await saveWorkspaceGroups(list);
  render();
}

function onClickOutsidePopover(e) {
  const pop = document.getElementById("add-popover");
  if (pop && !pop.contains(e.target)) hideAddPopover();
}

function hideAddPopover() {
  const pop = document.getElementById("add-popover");
  if (pop) pop.remove();
  document.removeEventListener("click", onClickOutsidePopover);
}

async function createAgent(name, group) {
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, group }),
    });
    if (!res.ok) {
      const err = await res.json();
      console.error("Failed to create agent:", err.error);
      return;
    }
    const created = await res.json();
    await fetchSessions();
    syncGroupList();
    render();
    switchSession(created.id);
  } catch (e) {
    console.error("Failed to create agent:", e);
  }
}

// ═══ FILE ICONS (VS Code Seti-style) ═══ — extracted to file-icons.js (loaded before this file).
// fileIcon/folderIcon/fileExtIcon + icon data + marimoNameCache/noteMarimoNotebook live there.

// showArtifactPopover/addArtifact moved to artifacts.js.

// ═══ RELATED AGENTS ═══
function showRelatedAgentPopover(e) {
  hideAddPopover();
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.id = "add-popover";
  pop.className = "add-popover";

  const s = sessions.find((s) => s.id === activeSessionId);
  const existing = new Set(s?.relatedAgents || []);
  const candidates = sessions.filter((c) => c.id !== activeSessionId && !existing.has(c.id));

  if (candidates.length === 0) {
    pop.innerHTML = `<div class="add-pop-label">No other agents to add</div>`;
    document.body.appendChild(pop);
    pop.style.left = Math.max(8, rect.left - 80) + "px";
    pop.style.top = (rect.bottom + 4) + "px";
    setTimeout(() => { document.addEventListener("click", onClickOutsidePopover); }, 0);
    return;
  }

  let html = `<div class="add-pop-label">Add related agent</div>`;
  candidates.forEach((c) => {
    const icon = mkIcon(c.state, 12);
    html += `<div class="ra-pick" data-ra-pick="${esc(c.id)}">${icon} <span>${esc(c.name.toUpperCase())}</span></div>`;
  });
  pop.innerHTML = html;

  document.body.appendChild(pop);
  pop.style.left = Math.max(8, rect.left - 80) + "px";
  pop.style.top = (rect.bottom + 4) + "px";

  pop.querySelectorAll(".ra-pick").forEach((item) => {
    item.addEventListener("click", () => {
      hideAddPopover();
      addRelatedAgent(item.dataset.raPick);
    });
  });

  setTimeout(() => { document.addEventListener("click", onClickOutsidePopover); }, 0);
}

async function addRelatedAgent(agentId) {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (!s) return;
  if (!s.relatedAgents) s.relatedAgents = [];
  if (s.relatedAgents.includes(agentId)) return;
  // Use the /related endpoint (mutual link) so the other agent shows this one too.
  await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/related`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ related: agentId }),
  });
  await fetchSessions();
  render();
}

async function removeRelatedAgent(agentId) {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (!s || !s.relatedAgents) return;
  s.relatedAgents = s.relatedAgents.filter((id) => id !== agentId);
  const patch = (id, related) => fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relatedAgents: related }),
  });
  await patch(activeSessionId, s.relatedAgents);
  // Symmetric unlink: drop this agent from the other side too.
  const other = sessions.find((x) => x.id === agentId);
  if (other && Array.isArray(other.relatedAgents) && other.relatedAgents.includes(activeSessionId)) {
    other.relatedAgents = other.relatedAgents.filter((id) => id !== activeSessionId);
    await patch(agentId, other.relatedAgents);
  }
  render();
}

// ═══ CONTEXT MENU ═══
function showCtxMenu(e, sessionId) {
  e.preventDefault();
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;

  const canClose = s.deletable !== false;
  const menu = document.getElementById("ctx-menu");
  menu.innerHTML = `
    <div class="cm-item" data-action="focus" data-sid="${sessionId}">Focus ${esc(s.name.toUpperCase())}</div>
    ${canClose ? `<div class="cm-sep"></div><div class="cm-item danger" data-action="close" data-sid="${sessionId}">Close ${esc(s.name.toUpperCase())}</div>` : ""}
  `;
  menu.style.display = "block";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";

  menu.querySelectorAll(".cm-item").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      const sid = item.dataset.sid;
      hideCtxMenu();
      if (action === "focus") switchSession(sid);
      else if (action === "close") closeSession(sid);
    });
  });
}

function hideCtxMenu() {
  document.getElementById("ctx-menu").style.display = "none";
}
document.addEventListener("click", hideCtxMenu);

async function closeSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (s && s.deletable === false) return;
  stopAllArtifactServers(sessionId);
  for (const [key, shell] of shellInstances) {
    if (key.startsWith(sessionId + ":")) {
      if (shell.ws) { shell.ws.onclose = null; shell.ws.close(); }
      shell.term.dispose();
      if (shell.resizeObserver) shell.resizeObserver.disconnect();
      if (shell.container && shell.container.parentNode) shell.container.remove();
      shellInstances.delete(key);
    }
  }
  delete openTabsPerSession[sessionId];
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (activeSessionId === sessionId) {
      const remaining = sessions.filter((x) => x.id !== sessionId);
      switchSession(remaining.length > 0 ? remaining[0].id : null);
    }
    await fetchSessions();
    render();
  } catch (e) {
    console.error("Failed to close session:", e);
  }
}

// ═══ SWITCHING ═══
let doneViewTimer = null;

function switchSession(sessionId) {
  if (sessionId === activeSessionId) return;
  if (activeTab === "notes") saveNotes();

  // Save current session's tab/layout state
  perSessionTab[activeSessionId] = activeTab;
  perSessionLayout[activeSessionId] = layoutMode;

  if (doneViewTimer) { clearTimeout(doneViewTimer); doneViewTimer = null; }

  // Close vim editors from the previous session to avoid orphan tmux sessions
  for (const [container, editor] of activeEditors) {
    closeVimEditor(container);
  }

  activeSessionId = sessionId;

  // Restore target session's tab/layout state
  activeTab = perSessionTab[sessionId] || "terminal";
  layoutMode = perSessionLayout[sessionId] || "tabs";

  connectWs(sessionId);

  const s = sessions.find((x) => x.id === sessionId);
  if (s && s.state === "done") {
    doneViewTimer = setTimeout(() => {
      doneViewTimer = null;
      if (activeSessionId === sessionId && s.state === "done") {
        s.state = "idle";
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "idle" }),
        }).catch(() => {});
        render();
      }
    }, 5000);
  }

  render();
  saveUIState();
}

// ═══ RESIZE HANDLE ═══
function initResize() {
  const handle = document.getElementById("resize-handle");
  const right = document.getElementById("right");
  let resizing = false;
  let startX = 0;
  let startWidth = 0;

  const savedWidth = localStorage.getItem("hadron-right-width");
  if (savedWidth) right.style.width = savedWidth + "px";

  handle.addEventListener("mousedown", (e) => {
    resizing = true;
    startX = e.clientX;
    startWidth = right.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const newWidth = Math.max(200, Math.min(480, startWidth + (startX - e.clientX)));
    right.style.width = newWidth + "px";
    safeFit();
  });

  document.addEventListener("mouseup", () => {
    if (resizing) {
      resizing = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("hadron-right-width", right.offsetWidth);
      safeFit();
    }
  });
}

function renderShortcutBar() {
  const bar = document.getElementById("hints");
  if (!bar) return;
  const mac = navigator.platform.includes("Mac");
  const alt = mac ? "⌥" : "Alt";
  const mod = mac ? "⌘" : "Ctrl";
  const hints = [
    `<kbd>${mod}+K</kbd> command palette`,
    `<kbd>${alt}+1</kbd>–<kbd>${alt}+9</kbd> switch agent`,
    `<kbd>${alt}+H</kbd> / <kbd>${alt}+L</kbd> prev/next agent`,
    `<kbd>${alt}+T</kbd> new shell`,
    `<kbd>${alt}+J</kbd> / <kbd>${alt}+K</kbd> prev/next tab`,
  ];
  const s = sessions.find(x => x.id === activeSessionId);
  const art = s?.artifacts?.[0];
  if (art && isMarkdownFile(art.value)) {
    hints.push(`<kbd>${mod}+Shift+E</kbd> toggle preview`);
  }
  bar.innerHTML = hints.map(h => `<span>${h}</span>`).join("");
}

// ═══ KEYBOARD SHORTCUTS ═══
function initKeyboard() {
  function getAltDigit(e) {
    if (!e.altKey) return -1;
    const m = e.code && e.code.match(/^Digit(\d)$/);
    return m ? parseInt(m[1]) : -1;
  }

  function isAltKey(e, letter) {
    if (!e.altKey) return false;
    return e.code === "Key" + letter.toUpperCase();
  }

  function handleGlobalShortcut(e) {
    const digit = getAltDigit(e);
    if (digit >= 1 && digit <= 9) {
      e.preventDefault();
      const ordered = getDisplayOrder();
      const idx = digit - 1;
      if (idx < ordered.length) switchSession(ordered[idx].id);
      return true;
    }

    if (isAltKey(e, "h")) { e.preventDefault(); cycleAgent(-1); return true; }
    if (isAltKey(e, "l")) { e.preventDefault(); cycleAgent(1); return true; }
    if (isAltKey(e, "j")) { e.preventDefault(); cycleTab(-1); return true; }
    if (isAltKey(e, "k")) { e.preventDefault(); cycleTab(1); return true; }
    if (isAltKey(e, "t")) { e.preventDefault(); createShellTab(); return true; }

    // Cmd/Ctrl+K: command palette (preventDefault to override the browser's own).
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyK") {
      e.preventDefault();
      if (typeof openCommandPalette === "function") openCommandPalette();
      return true;
    }

    // Ctrl+Shift+R: reload current artifact
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyR") {
      e.preventDefault();
      reloadCurrentArtifact();
      return true;
    }

    // Ctrl/Cmd+Shift+E: toggle view/edit mode (VS Code-adjacent). Shift+V kept
    // as a silent legacy alias — but note ⌘⇧V means "paste as plain text" in
    // many apps, which is why E is now the documented binding.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === "KeyE" || e.code === "KeyV")) {
      const editableContainer = document.querySelector('[data-md-raw]');
      if (editableContainer) {
        e.preventDefault();
        toggleEditMode(editableContainer);
        return true;
      }
    }

    return false;
  }

  document.addEventListener("keydown", (e) => {
    if (e._hadronHandled) return;
    handleGlobalShortcut(e);
  });

  term.attachCustomKeyEventHandler((e) => {
    const digit = getAltDigit(e);
    const isPaletteKey = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyK";
    if ((digit >= 1 && digit <= 9) || isAltKey(e, "h") || isAltKey(e, "l") || isAltKey(e, "j") || isAltKey(e, "k") || isAltKey(e, "t") || isPaletteKey) {
      if (e.type === "keydown") {
        e._hadronHandled = true;
        handleGlobalShortcut(e);
      }
      return false;
    }
    return true;
  });
}

function cycleAgent(direction) {
  const ordered = getDisplayOrder();
  const curIdx = ordered.findIndex((s) => s.id === activeSessionId);
  const next = (curIdx + direction + ordered.length) % ordered.length;
  switchSession(ordered[next].id);
}

function cycleTab(direction) {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (!s) return;
  const allTabs = ["terminal", ...getOpenTabs(s).map((t) => t.id)];
  if (allTabs.length <= 1) return;
  const curIdx = allTabs.indexOf(activeTab);
  const next = (curIdx + direction + allTabs.length) % allTabs.length;
  switchTab(allTabs[next]);
}

// ═══ SHELL TABS ═══ — extracted to terminal.js (see WEBSOCKET + TERMINAL note above).

// ═══ CENTER NOTIFICATIONS ═══
function showNotification(session, newState) {
  const container = document.getElementById("notifications");
  const el = document.createElement("div");

  const icon = mkIcon(newState, 28);
  const label = session.name.toUpperCase();
  const stateMsg = newState === "blocked" ? "is blocked" : "is done";
  const reason = newState === "blocked" ? (session.blockReason || "Needs attention") : "Task complete";

  el.className = `center-notif cn-${newState}`;
  el.innerHTML = `<div class="cn-icon">${icon}</div><div class="cn-name">${esc(label)} ${stateMsg}</div><div class="cn-sub">${esc(reason)}</div>`;
  el.dataset.sessionId = session.id;

  el.addEventListener("click", () => { dismissNotification(el); switchSession(session.id); });
  container.appendChild(el);

  requestAnimationFrame(() => { requestAnimationFrame(() => { el.classList.add("active"); }); });

  const timeout = newState === "blocked" ? 6000 : 4000;
  el._dismissTimer = setTimeout(() => dismissNotification(el), timeout);
}

function dismissNotification(el) {
  if (el._dismissed) return;
  el._dismissed = true;
  if (el._dismissTimer) clearTimeout(el._dismissTimer);
  el.classList.remove("active");
  el.classList.add("fade-out");
  setTimeout(() => el.remove(), 400);
}

// ═══ SOUND & TAB ALERTS ═══
function playAlertSound(type) {
  try {
    const ctx = new AudioContext();
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    const o = ctx.createOscillator();
    o.connect(g);
    if (type === "blocked") {
      o.type = "square";
      o.frequency.setValueAtTime(440, ctx.currentTime);
      o.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
      o.frequency.setValueAtTime(260, ctx.currentTime + 0.3);
    } else {
      o.type = "sine";
      o.frequency.setValueAtTime(523, ctx.currentTime);
      o.frequency.setValueAtTime(659, ctx.currentTime + 0.12);
      o.frequency.setValueAtTime(784, ctx.currentTime + 0.24);
    }
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch (_) {}
}

function startTitleFlash(agentName, state) {
  pendingAlerts.add(agentName);
  if (titleFlashInterval) return;
  const baseTitle = document.title;
  let on = true;
  titleFlashInterval = setInterval(() => {
    if (pendingAlerts.size === 0) { clearTitleFlash(baseTitle); return; }
    const names = [...pendingAlerts].join(", ");
    document.title = on ? `⚠ ${names} — Hadron` : baseTitle;
    on = !on;
  }, 1000);
}

function clearTitleFlash(baseTitle) {
  if (titleFlashInterval) { clearInterval(titleFlashInterval); titleFlashInterval = null; }
  pendingAlerts.clear();
  if (baseTitle) document.title = baseTitle;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && titleFlashInterval) {
    clearTitleFlash(`${wsName} — Hadron`);
  }
});

function snapshotSessionStates() {
  const snap = {};
  sessions.forEach((s) => { snap[s.id] = s.state || "idle"; });
  return snap;
}

function detectStateChanges(oldStates, newSessions) {
  newSessions.forEach((s) => {
    const newState = s.state || "idle";
    const oldState = oldStates[s.id];
    if (oldState !== undefined && oldState !== newState) {
      if ((newState === "blocked" || newState === "done") && notifyLevel !== "off") {
        if (s.id !== activeSessionId) showNotification(s, newState);
        if (notifyLevel === "all") playAlertSound(newState);
        if (document.hidden) startTitleFlash(s.name, newState);
      }
    }
  });
}

// ═══ SORT MENU ═══
const SORT_MODES = [
  { id: "state", label: "By status" },
  { id: "manual", label: "Manual" },
  { id: "name", label: "By name" },
];

// ═══ MENU BAR ═══
let activeMenu = null;

function menuItem(label, action, opts = {}) {
  const { shortcut, checked, disabled, submenu } = opts;
  const cls = ["menu-dropdown-item"];
  if (disabled) cls.push("disabled");
  if (submenu) cls.push("has-submenu");
  let inner = "";
  if (checked !== undefined) inner += `<span class="menu-check">${checked ? "✓" : ""}</span>`;
  inner += `<span class="menu-label">${label}</span>`;
  if (shortcut) inner += `<span class="menu-shortcut">${shortcut}</span>`;
  if (submenu) inner += `<span class="menu-arrow">▸</span><div class="menu-submenu">${submenu}</div>`;
  return `<div class="${cls.join(" ")}" data-action="${action || ""}"${opts.data ? ` ${opts.data}` : ""}>${inner}</div>`;
}

function bindMenuClicks(menu) {
  menu.querySelectorAll(".menu-dropdown-item:not(.has-submenu)").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      if (!action || item.classList.contains("disabled")) return;
      hideMenu();
      handleMenuAction(action, item);
    });
  });
  menu.querySelectorAll(".has-submenu .menu-submenu .menu-dropdown-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      if (!action || item.classList.contains("disabled")) return;
      hideMenu();
      handleMenuAction(action, item);
    });
  });
}

async function showMenu(menuId, anchorEl) {
  hideMenu();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.id = "active-menu";
  menu.className = "menu-dropdown";
  menu.style.top = (rect.bottom + 2) + "px";

  const mac = navigator.platform.includes("Mac");
  const mod = mac ? "⌘" : "Ctrl";

  if (menuId === "workspace") {
    menu.style.right = (window.innerWidth - rect.right) + "px";
    menu.innerHTML = [
      menuItem("Switch Project", "", { disabled: true }),
    ].join("");
  } else if (menuId === "view") {
    menu.style.left = rect.left + "px";
    const sortSub = SORT_MODES.map(m =>
      menuItem(m.label, "sort", { checked: m.id === deckSortMode, data: `data-sort="${m.id}"` })
    ).join("");
    const groupBySub = [
      menuItem("Group", "set-groupby", { checked: deckGroupBy === "group", data: 'data-groupby="group"' }),
      menuItem("Status", "set-groupby", { checked: deckGroupBy === "status", data: 'data-groupby="status"' }),
    ].join("");
    const themeSub = [
      menuItem("Default", "set-theme", { checked: currentTheme === "default", data: 'data-theme="default"' }),
      menuItem("大航海時代 Classic", "set-theme", { checked: currentTheme === "exploration", data: 'data-theme="exploration"' }),
      menuItem("大航海時代 v2", "set-theme", { checked: currentTheme === "exploration2", data: 'data-theme="exploration2"' }),
    ].join("");
    const notifySub = [
      menuItem("Sound + Banner", "set-notify", { checked: notifyLevel === "all", data: 'data-level="all"' }),
      menuItem("Banner Only", "set-notify", { checked: notifyLevel === "banner", data: 'data-level="banner"' }),
      menuItem("Off", "set-notify", { checked: notifyLevel === "off", data: 'data-level="off"' }),
    ].join("");
    const editorSub = [
      menuItem("Text (built-in)", "set-editor", { checked: editorPref() === "text", data: 'data-editor="text"' }),
      menuItem("Vim (terminal)", "set-editor", { checked: editorPref() === "vim", data: 'data-editor="vim"' }),
    ].join("");
    menu.innerHTML = [
      menuItem("Deck Layout", "", { submenu: groupBySub }),
      menuItem("Agent Sorting", "", { submenu: sortSub }),
      menuItem("Theme", "", { submenu: themeSub }),
      menuItem("Editor", "", { submenu: editorSub }),
      menuItem("Notifications", "", { submenu: notifySub }),
      '<div class="menu-dropdown-sep"></div>',
      menuItem("Toggle Preview", "toggle-preview", { shortcut: `${mod}+Shift+E` }),
    ].join("");
  } else if (menuId === "kernel") {
    menu.style.left = rect.left + "px";
    let kernels = {};
    try { kernels = await (await fetch("/api/kernels")).json(); } catch {}
    const marimoEnv = kernels.marimo || "(default .venv)";
    const jupyterEnv = kernels.jupyter || "(default .venv)";
    const marimoSub = [
      menuItem(marimoEnv, "", { checked: true, disabled: true }),
    ].join("");
    const jupyterSub = [
      menuItem(jupyterEnv, "", { checked: true, disabled: true }),
    ].join("");
    menu.innerHTML = [
      menuItem("marimo", "", { submenu: marimoSub }),
      menuItem("jupyter", "", { submenu: jupyterSub }),
      '<div class="menu-dropdown-sep"></div>',
      menuItem("Run /change_kernel to configure", "", { disabled: true }),
    ].join("");
  } else if (menuId === "agents") {
    menu.style.left = rect.left + "px";
    const deletable = sessions.filter(s => s.deletable !== false);
    const archiveSub = deletable.length > 0
      ? deletable.map(s => menuItem(s.name || s.id, "archive-agent", { data: `data-id="${s.id}"` })).join("")
      : menuItem("No agents", "", { disabled: true });
    let archived = [];
    try { archived = await (await fetch("/api/sessions/archived")).json(); } catch {}
    const restoreSub = archived.length > 0
      ? archived.map(a => menuItem(a.name || a.id, "restore-agent", { data: `data-id="${a.id}"` })).join("")
      : menuItem("No archived agents", "", { disabled: true });
    const deleteSub = archived.length > 0
      ? archived.map(a => menuItem(a.name || a.id, "delete-agent", { data: `data-id="${a.id}"` })).join("")
      : menuItem("No archived agents", "", { disabled: true });
    menu.innerHTML = [
      menuItem("New Agent", "new-agent"),
      menuItem("New Group", "new-group"),
      '<div class="menu-dropdown-sep"></div>',
      menuItem("Archive Agent", "", { submenu: archiveSub }),
      menuItem("Archive All", "archive-all", { disabled: deletable.length === 0 }),
      '<div class="menu-dropdown-sep"></div>',
      menuItem("Restore Agent", "", { submenu: restoreSub }),
      menuItem("Delete Agent", "", { submenu: deleteSub }),
    ].join("");
  }

  document.body.appendChild(menu);
  activeMenu = menu;
  bindMenuClicks(menu);
  setTimeout(() => document.addEventListener("click", hideMenu), 0);
}

function hideMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  document.removeEventListener("click", hideMenu);
}

async function handleMenuAction(action, item) {
  if (action === "sort") {
    deckSortMode = item.dataset.sort;
    renderDeck();
    saveUIState();
  } else if (action === "set-groupby") {
    deckGroupBy = item.dataset.groupby || "group";
    renderDeck();
    saveUIState();
  } else if (action === "set-theme") {
    applyTheme(item.dataset.theme || "default");
  } else if (action === "set-notify") {
    notifyLevel = item.dataset.level || "all";
    saveUIState();
  } else if (action === "set-editor") {
    setEditorPref(item.dataset.editor === "vim" ? "vim" : "text");
  } else if (action === "toggle-preview") {
    const mdContainer = document.querySelector("[data-md-raw]");
    if (mdContainer) toggleEditMode(mdContainer);
  } else if (action === "new-agent") {
    const groups = getSessionGroups().filter(g => (groupConfig[g.label] || {}).expandable !== false);
    if (groups.length > 0) showAddPopover({ clientX: 200, clientY: 60, preventDefault() {} }, groups[0].label);
  } else if (action === "new-group") {
    const name = prompt("Group name:");
    if (name && name.trim()) {
      const trimmed = name.trim();
      if (!workspaceGroups) workspaceGroups = [];
      // Don't create a case-duplicate of an existing group.
      if (!workspaceGroups.some((g) => g.toLowerCase() === trimmed.toLowerCase())) {
        workspaceGroups.push(trimmed);
        saveWorkspaceGroups(workspaceGroups);
      }
      renderDeck();
    }
  } else if (action === "archive-agent") {
    const id = item.dataset.id;
    if (id) { await closeSession(id); }
  } else if (action === "archive-all") {
    const deletable = sessions.filter(s => s.deletable !== false);
    if (deletable.length === 0) return;
    if (!confirm(`Archive ${deletable.length} agent(s)?`)) return;
    for (const s of deletable) await closeSession(s.id);
  } else if (action === "restore-agent") {
    const id = item.dataset.id;
    if (id) {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
      await fetchSessions();
      render();
    }
  } else if (action === "delete-agent") {
    const id = item.dataset.id;
    const name = item.querySelector(".menu-label")?.textContent || id;
    if (id && confirm(`Permanently delete "${name}"? This cannot be undone.`)) {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/permanent`, { method: "DELETE" });
      await fetchSessions();
      render();
    }
  }
}

function initMenuBar() {
  document.getElementById("menu-workspace")?.addEventListener("click", function(e) { e.stopPropagation(); showMenu("workspace", this); });
  document.getElementById("menu-view")?.addEventListener("click", function(e) { e.stopPropagation(); showMenu("view", this); });
  document.getElementById("menu-agents")?.addEventListener("click", function(e) { e.stopPropagation(); showMenu("agents", this); });
  document.getElementById("menu-kernel")?.addEventListener("click", function(e) { e.stopPropagation(); showMenu("kernel", this); });
}

// ═══ ORPHAN BANNER ═══
async function checkOrphans() {
  try {
    const res = await fetch("/api/orphans");
    const orphans = await res.json();
    let banner = document.getElementById("orphan-banner");
    if (!orphans.length) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "orphan-banner";
      document.body.prepend(banner);
    }
    const items = orphans.map(o =>
      `<span class="orphan-item">${esc(o.agentId)}${o.hasRunningProcesses ? ' <span class="orphan-running">running</span>' : ""}</span>`
    ).join(" ");
    banner.innerHTML = `<div class="orphan-content"><span class="orphan-icon">?</span> Found ${orphans.length} orphaned tmux session${orphans.length > 1 ? "s" : ""}: ${items}<div class="orphan-actions"><button onclick="orphanAction('adopt-all')">Adopt All</button><button onclick="orphanAction('kill-all')" class="orphan-kill">Kill All</button><button onclick="dismissOrphans()">Dismiss</button></div></div>`;
  } catch {}
}

async function orphanAction(action) {
  await fetch(`/api/orphans/${action}`, { method: "POST" });
  document.getElementById("orphan-banner")?.remove();
  await fetchSessions();
  renderDeck();
}

function dismissOrphans() {
  document.getElementById("orphan-banner")?.remove();
}

// ═══ POLL FOR SESSION UPDATES ═══
setInterval(async () => {
  const oldStates = snapshotSessionStates();
  await fetchSessions();
  detectStateChanges(oldStates, sessions);
  renderDeck();
  renderRightPanel();
}, 3000);

// ═══ BOOT ═══
checkOrphans();
init();
