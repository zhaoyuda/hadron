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
let ws = null;
let reconnectTimer = null;
let term = null;
let fitAddon = null;
let notesSaveTimer = null;
let prevSessionStates = {};
let activeTab = "terminal"; // "terminal", "notes", or "artifact:<index>"
let openTabsPerSession = {}; // { sessionId: Set of tab ids }
let layoutMode = "tabs"; // "tabs", "vsplit", "hsplit"
let perSessionTab = {}; // { sessionId: activeTab }
let perSessionLayout = {}; // { sessionId: layoutMode }
// Map of "<sessionId>:<shellId>" -> { term, fitAddon, ws, container, resizeObserver }
let shellInstances = new Map();
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

// ═══ TERMINAL ═══
function initTerminal() {
  term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      selectionBackground: "#264f78",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    allowProposedApi: true,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  const container = document.getElementById("terminal-container");
  term.open(container);

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  window.addEventListener("resize", () => safeFit());

  new ResizeObserver(() => safeFit()).observe(container);
}

function safeFit() {
  const container = document.getElementById("terminal-container");
  if (!container || !container.classList.contains("active")) return;
  if (container.offsetWidth < 50 || container.offsetHeight < 50) return;
  fitAddon.fit();
  sendResize();
}

function deferredFit() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      safeFit();
    });
  });
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN && term) {
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
}

// ═══ WEBSOCKET ═══
function connectWs(sessionId) {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  term.reset();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(sessionId)}${wsTokenParam()}`);

  const statusEl = document.getElementById("status");

  ws.onopen = () => {
    if (statusEl) statusEl.textContent = "";
    deferredFit();
    setTimeout(() => safeFit(), 500);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        term.write(msg.data);
      }
    } catch {
      term.write(event.data);
    }
  };

  ws.onclose = () => {
    if (statusEl) statusEl.textContent = "disconnected - reconnecting...";
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => { ws.close(); };
}

function scheduleReconnect(sessionId) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs(sessionId);
  }, 1000);
}

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
  const groupMap = {};
  sessions.forEach((s) => {
    const g = s.group || "Workers";
    if (!groupMap[g]) groupMap[g] = [];
    groupMap[g].push(s);
  });

  const STATE_PRIORITY = { blocked: 0, done: 1, working: 2, idle: 3 };
  for (const g of Object.keys(groupMap)) {
    groupMap[g].sort((a, b) => {
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
      result.push({ label: gName, items: groupMap[gName] || [] });
      seen.add(gName);
    }
    // Append any groups not in the persisted list (shouldn't happen normally)
    for (const g of Object.keys(groupMap)) {
      if (!seen.has(g)) result.push({ label: g, items: groupMap[g] });
    }
    return result;
  }

  // Fallback: alphabetical
  const result = [];
  Object.keys(groupMap)
    .sort()
    .forEach((g) => {
      result.push({ label: g, items: groupMap[g] });
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
      tabsHtml += `<div class="wh-tab wh-tab-art${isActive}" data-tab="${tab.id}" title="${esc(tab.label)}">${iconHtml}<span class="wh-tab-label">${esc(tab.label)}</span><span class="wh-tab-x" data-close-tab="${tab.id}">×</span></div>`;
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
  wsContent.querySelectorAll(".split-pane, .split-handle").forEach((el) => el.remove());
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
        const pane = document.createElement("div");
        pane.className = "split-pane";
        pane.style.flex = "1";
        renderPaneContent(pane, tab.id, s);
        wsContent.appendChild(pane);
        initSplitResize(handle, layoutMode);
      }
    });
  }

  // Start/stop mtime polling for file-based artifacts
  startArtifactMtimePolling();
}

// Persistent artifact cache: "sessionId:tabId" -> { el, mtime, hasIframe }
// These elements live hidden in #artifact-pool and get moved into view when needed
const artifactCache = new Map();
const ARTIFACT_CACHE_MAX = 10;

function getArtifactPool() {
  let pool = document.getElementById("artifact-pool");
  if (!pool) {
    pool = document.createElement("div");
    pool.id = "artifact-pool";
    pool.style.position = "absolute";
    pool.style.left = "-9999px";
    pool.style.width = "1px";
    pool.style.height = "1px";
    pool.style.overflow = "hidden";
    document.body.appendChild(pool);
  }
  return pool;
}

async function showArtifactInContainer(container, session, tabId) {
  const idx = parseInt(tabId.split(":")[1]);
  const art = session?.artifacts?.[idx];
  if (!art) return;

  const key = `${session.id}:${tabId}`;
  container.style.display = "block";
  container.classList.add("active");

  // Hide all children first, then show the right one
  for (const child of container.children) {
    child.style.display = "none";
  }

  const cached = artifactCache.get(key);
  if (cached) {
    if (cached.hasIframe) {
      // Iframe is already a child of container — just show it (no DOM move = no reload)
      if (cached.el.parentNode === container) {
        cached.el.style.display = "block";
        return;
      }
      // Fell out of container (e.g. session switch) — re-append from pool
      container.appendChild(cached.el);
      cached.el.style.display = "block";
      return;
    }
    // File-based artifact: check if file changed
    if (art.type === "file" && cached.mtime) {
      try {
        const resp = await fetch(`/api/file?path=${encodeURIComponent(art.value)}`, { method: "HEAD" });
        const mtime = resp.headers.get("X-File-Mtime");
        if (mtime === cached.mtime) {
          if (cached.el.parentNode !== container) container.appendChild(cached.el);
          cached.el.style.display = "block";
          return;
        }
      } catch {}
    }
    // Stale — evict and re-render
    if (cached.el.parentNode) cached.el.parentNode.removeChild(cached.el);
    artifactCache.delete(key);
  }

  const artEl = document.createElement("div");
  artEl.className = "artifact-persistent";
  artEl.dataset.cacheKey = key;
  artEl.style.width = "100%";
  artEl.style.height = "100%";
  artEl.style.overflow = "auto";
  container.appendChild(artEl);

  // Evict oldest if over limit
  if (artifactCache.size >= ARTIFACT_CACHE_MAX) {
    const oldest = artifactCache.keys().next().value;
    const oldEntry = artifactCache.get(oldest);
    if (oldEntry?.el?.parentNode) oldEntry.el.parentNode.removeChild(oldEntry.el);
    artifactCache.delete(oldest);
  }
  artifactCache.set(key, { el: artEl, mtime: null, hasIframe: false, htmlFile: false });

  renderArtifactView(artEl, art, (mtime, hasIframe, htmlFile = false) => {
    const entry = artifactCache.get(key);
    if (entry) { entry.mtime = mtime; entry.hasIframe = hasIframe; entry.htmlFile = htmlFile; }
  });
}

function stopArtifactServer(session, tabId) {
  const idx = parseInt(tabId.split(":")[1]);
  const art = session?.artifacts?.[idx];
  if (!art || art.type !== "file") return;
  const path = art.value;
  if (path.endsWith(".py")) {
    fetch("/api/marimo/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath: path }) });
  } else if (path.endsWith(".ipynb")) {
    fetch("/api/jupyter/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath: path }) });
  }
  const key = `${session.id}:${tabId}`;
  const cached = artifactCache.get(key);
  if (cached?.el?._mtimePoller) clearInterval(cached.el._mtimePoller);
  if (cached?.el?.parentNode) cached.el.parentNode.removeChild(cached.el);
  artifactCache.delete(key);
}

function stopAllArtifactServers(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session?.artifacts) return;
  for (let i = 0; i < session.artifacts.length; i++) {
    stopArtifactServer(session, `artifact:${i}`);
  }
}

function stashArtifacts() {
  const pool = getArtifactPool();
  for (const [, entry] of artifactCache) {
    const el = entry.el;
    if (entry.hasIframe) {
      // Never move iframes between DOM parents — just hide in place
      el.style.display = "none";
    } else if (el.parentNode && el.parentNode.id !== "artifact-pool") {
      pool.appendChild(el);
    }
  }
}

function reloadCurrentArtifact() {
  if (!activeTab?.startsWith("artifact:")) return;
  // Don't yank the rug out from under someone mid-edit in the CSV textarea.
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains("csv-edit-area")) return;
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return;
  const key = `${session.id}:${activeTab}`;
  const cached = artifactCache.get(key);
  if (cached?.hasIframe) return;
  // Static HTML file: reload the iframe in-place with a fresh cache-buster
  // (keep the cache entry; just refetch the new mtime and re-point src).
  if (cached?.htmlFile) {
    const idx = parseInt(activeTab.split(":")[1]);
    const art = session.artifacts?.[idx];
    if (art && cached.el) {
      fetch(`/api/file?path=${encodeURIComponent(art.value)}`, { method: "HEAD" })
        .then((r) => r.ok ? r.headers.get("X-File-Mtime") : null)
        .catch(() => null)
        .then((mtime) => {
          if (reloadHTMLIframe(cached.el, art.value, mtime)) {
            cached.mtime = mtime;
          }
        });
      return;
    }
  }
  // Close vim if open on the cached element
  if (cached?.el) closeVimEditor(cached.el);
  if (cached?.el?.parentNode) cached.el.parentNode.removeChild(cached.el);
  artifactCache.delete(key);
  const container = document.getElementById("artifact-container");
  if (!container) return;
  showArtifactInContainer(container, session, activeTab);
}

// Auto-reload: poll mtime for the active vim-based artifact
let artifactMtimePoller = null;
let artifactLastMtime = null;

function startArtifactMtimePolling() {
  stopArtifactMtimePolling();
  if (!activeTab?.startsWith("artifact:")) return;
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return;
  const idx = parseInt(activeTab.split(":")[1]);
  const art = session.artifacts?.[idx];
  if (!art || art.type !== "file") return;
  const key = `${session.id}:${activeTab}`;
  const cached = artifactCache.get(key);
  if (cached?.hasIframe) return;

  artifactLastMtime = cached?.mtime || null;
  artifactMtimePoller = setInterval(async () => {
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(art.value)}`, { method: "HEAD" });
      const mtime = r.headers.get("X-File-Mtime");
      if (artifactLastMtime === null) { artifactLastMtime = mtime; return; }
      if (mtime !== artifactLastMtime) {
        artifactLastMtime = mtime;
        reloadCurrentArtifact();
      }
    } catch {}
  }, 3000);
}

function stopArtifactMtimePolling() {
  if (artifactMtimePoller) { clearInterval(artifactMtimePoller); artifactMtimePoller = null; }
  artifactLastMtime = null;
}

function renderPaneContent(pane, tabId, session) {
  if (tabId === "notes") {
    const noteVal = session?.notes || "";
    pane.innerHTML = `<textarea class="split-pane-notes" placeholder="Write notes here..." oninput="saveSplitNotes()">${esc(noteVal)}</textarea>`;
  } else if (tabId.startsWith("artifact:")) {
    // Try cache first for split pane artifacts too (only iframe-based)
    const key = `${session.id}:${tabId}`;
    const cached = artifactCache.get(key);
    if (cached?.hasIframe) {
      pane.appendChild(cached.el);
      cached.el.style.display = "block";
      return;
    }
    const idx = parseInt(tabId.split(":")[1]);
    const art = session?.artifacts?.[idx];
    if (!art) return;
    if (art.type === "url") {
      pane.innerHTML = `<iframe class="artifact-iframe" src="${esc(art.value)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
    } else {
      if (isHTMLFile(art.value)) {
        renderHTMLArtifact(pane, art.value);
      } else {
        pane.innerHTML = `<div class="artifact-file-loading">Loading...</div>`;
        fetch(`/api/file?path=${encodeURIComponent(art.value)}`)
          .then((r) => r.ok ? r.text() : Promise.reject("not found"))
          .then((text) => {
            if (isMarimoNotebook(text, art.label || art.value)) {
              if (noteMarimoNotebook(art.value)) renderWorkHeader();
              renderMarimoNotebook(pane, text, art.value);
            } else if (isCSVFile(art.value)) {
              renderCSVTable(pane, text, art.value);
            } else if (isJupyterNotebook(art.value)) {
              renderJupyterNotebook(pane, text, art.value);
            } else if (isMarkdownFile(art.value)) {
              renderMarkdownArtifact(pane, text, art.value);
            } else {
              pane.style.position = "relative";
              openVimEditor(pane, art.value, false);
            }
          })
          .catch(() => { pane.innerHTML = `<div class="artifact-file-error">Could not load file</div>`; });
      }
    }
  }
}

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

// ═══ MARKDOWN RENDERING ═══
// Configure marked with highlight.js integration
if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function(code, lang) {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return code;
    },
  });
}

function isMarkdownFile(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function isHTMLFile(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function isEditableFile(filePath) {
  if (!filePath) return false;
  if (isMarkdownFile(filePath)) return true;
  return getLanguageFromPath(filePath) !== null;
}

function renderMarkdownArtifact(container, text, filePath) {
  container.style.position = "relative";
  container.dataset.mdRaw = text;
  container.dataset.mdMode = "preview";
  container.dataset.mdPath = filePath;
  container.dataset.editablePath = filePath;

  const html = typeof marked !== 'undefined' ? marked.parse(text) : esc(text);
  container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Preview <span class="md-toggle-key">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+V</span></div><div class="md-preview">${html}</div>`;
}

function renderHTMLArtifact(container, filePath, mtime) {
  container.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;";
  container.dataset.htmlPath = filePath;
  const iframe = document.createElement("iframe");
  const bust = mtime ? `&_=${encodeURIComponent(mtime)}` : "";
  iframe.src = `/api/file?path=${encodeURIComponent(filePath)}${bust}`;
  iframe.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:#fff;border-radius:4px;";
  iframe.sandbox = "allow-scripts allow-same-origin";
  iframe.dataset.htmlIframe = "1";
  container.appendChild(iframe);
}

// Re-set the HTML artifact iframe src with a fresh cache-buster (in-place
// reload — no DOM teardown, no flash of the cache entry being evicted).
function reloadHTMLIframe(el, filePath, mtime) {
  if (!el) return false;
  const iframe = el.querySelector('iframe[data-html-iframe="1"]');
  if (!iframe) return false;
  const bust = mtime ? `&_=${encodeURIComponent(mtime)}` : "";
  iframe.src = `/api/file?path=${encodeURIComponent(filePath)}${bust}`;
  return true;
}

// Track active vim editor instances: container -> { term, fitAddon, ws, shellName, resizeObserver }
let activeEditors = new Map();

function toggleEditMode(container) {
  if (!container) return;
  const filePath = container.dataset.editablePath;
  if (!filePath) return;

  const mode = container.dataset.mdMode || "preview";
  if (mode === "preview") {
    container.dataset.mdMode = "edit";
    openVimEditor(container, filePath);
  } else {
    container.dataset.mdMode = "preview";
    closeVimEditor(container);
    fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.ok ? r.text() : Promise.reject())
      .then((text) => {
        container.dataset.mdRaw = text;
        const html = typeof marked !== 'undefined' ? marked.parse(text) : esc(text);
        container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Preview <span class="md-toggle-key">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+V</span></div><div class="md-preview">${html}</div>`;
      });
  }
}

function openVimEditor(container, filePath, showToggle = true) {
  const shellName = `vim-${Date.now()}`;

  if (showToggle) {
    container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Editing <span class="md-toggle-key">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+V</span></div>`;
  } else {
    container.innerHTML = "";
  }
  const termDiv = document.createElement("div");
  termDiv.className = showToggle ? "vim-editor-container" : "vim-editor-container no-toggle";
  container.appendChild(termDiv);

  const editorTerm = new Terminal({
    cursorBlink: true,
    scrollback: 1000,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      selectionBackground: "#264f78",
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
    allowProposedApi: true,
  });

  const editorFit = new FitAddon.FitAddon();
  editorTerm.loadAddon(editorFit);
  editorTerm.open(termDiv);

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const editorWs = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(activeSessionId)}&shell=${encodeURIComponent(shellName)}${wsTokenParam()}`);

  editorTerm.onData((data) => {
    if (editorWs.readyState === WebSocket.OPEN) {
      editorWs.send(JSON.stringify({ type: "input", data }));
    }
  });

  editorWs.onopen = () => {
    requestAnimationFrame(() => {
      editorFit.fit();
      if (editorWs.readyState === WebSocket.OPEN) {
        editorWs.send(JSON.stringify({ type: "resize", cols: editorTerm.cols, rows: editorTerm.rows }));
        // Send vim command after a short delay for shell to be ready
        setTimeout(() => {
          editorWs.send(JSON.stringify({ type: "input", data: `while true; do vim -n "${filePath}"; done\r` }));
        }, 300);
      }
    });
  };

  editorWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") editorTerm.write(msg.data);
    } catch {
      editorTerm.write(event.data);
    }
  };

  editorWs.onclose = () => {};
  editorWs.onerror = () => { editorWs.close(); };

  const ro = new ResizeObserver(() => {
    if (termDiv.offsetWidth < 50 || termDiv.offsetHeight < 50) return;
    editorFit.fit();
    if (editorWs.readyState === WebSocket.OPEN) {
      editorWs.send(JSON.stringify({ type: "resize", cols: editorTerm.cols, rows: editorTerm.rows }));
    }
  });
  ro.observe(termDiv);

  activeEditors.set(container, { term: editorTerm, fitAddon: editorFit, ws: editorWs, shellName, resizeObserver: ro });
}

function closeVimEditor(container) {
  const editor = activeEditors.get(container);
  if (!editor) return;
  if (editor.ws) { editor.ws.onclose = null; editor.ws.close(); }
  editor.term.dispose();
  if (editor.resizeObserver) editor.resizeObserver.disconnect();
  // Kill tmux session
  fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/shells/${encodeURIComponent(editor.shellName)}`, { method: "DELETE" }).catch(() => {});
  activeEditors.delete(container);
}

function addEditToggle(container, filePath) {
  container.style.position = "relative";
  container.dataset.editablePath = filePath;
  container.dataset.mdMode = "view";
  const toggle = document.createElement("div");
  toggle.className = "md-toggle";
  toggle.innerHTML = `View <span class="md-toggle-key">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+V</span>`;
  toggle.onclick = () => toggleEditMode(container);
  container.appendChild(toggle);
}

// ═══ CSV TABLE VIEWER ═══

function isCSVFile(filePath) {
  if (!filePath) return false;
  return filePath.toLowerCase().endsWith('.csv');
}

function parseCSV(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
        current.push(field);
        field = '';
        if (current.length > 1 || current[0] !== '') rows.push(current);
        current = [];
      } else {
        field += ch;
      }
    }
  }
  // Last field/row
  current.push(field);
  if (current.length > 1 || current[0] !== '') rows.push(current);

  if (rows.length === 0) return { headers: [], rows: [] };
  return { headers: rows[0], rows: rows.slice(1) };
}

// Remember preview-vs-edit preference per file extension (e.g. CSV defaults to
// the table, but if a user flips to edit we restore that next time).
function artifactModePref(ext, fallback) {
  try { return localStorage.getItem(`hadron-artmode-${ext}`) || fallback; }
  catch { return fallback; }
}
function setArtifactModePref(ext, mode) {
  try { localStorage.setItem(`hadron-artmode-${ext}`, mode); } catch {}
}

function renderCSVTable(container, text, filePath) {
  container.style.position = "relative";
  let raw = text;
  let mode = artifactModePref("csv", "preview");
  const macKey = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';

  function toggleBar(active) {
    const previewSel = active === "preview" ? " active" : "";
    const editSel = active === "edit" ? " active" : "";
    return `<div class="csv-toggle">`
      + `<button class="csv-toggle-btn${previewSel}" data-mode="preview">Preview</button>`
      + `<button class="csv-toggle-btn${editSel}" data-mode="edit">Edit</button>`
      + `</div>`;
  }

  function wireToggle() {
    container.querySelectorAll('.csv-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.mode;
        if (next === mode) return;
        mode = next;
        setArtifactModePref("csv", mode);
        render();
      });
    });
  }

  function renderEdit() {
    container.innerHTML = toggleBar("edit")
      + `<div class="csv-edit-wrap">`
      + `<textarea class="csv-edit-area" spellcheck="false">${esc(raw)}</textarea>`
      + `<div class="csv-edit-bar">`
      + `<span class="csv-edit-status"></span>`
      + `<button class="csv-edit-save">Save <span class="md-toggle-key">${macKey}+S</span></button>`
      + `</div></div>`;
    wireToggle();
    const ta = container.querySelector('.csv-edit-area');
    const status = container.querySelector('.csv-edit-status');
    const saveBtn = container.querySelector('.csv-edit-save');

    function save() {
      const content = ta.value;
      status.textContent = "Saving…";
      saveBtn.disabled = true;
      fetch(`/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content }),
      })
        .then((r) => r.ok ? r : Promise.reject())
        .then((r) => {
          raw = content;
          status.textContent = "Saved";
          // Pre-set the poller's baseline to our own mtime so it doesn't fire a
          // reload that would rebuild the textarea out from under the user.
          const newMtime = r.headers.get("X-File-Mtime");
          if (newMtime) artifactLastMtime = newMtime;
          setTimeout(() => { status.textContent = ""; }, 1500);
        })
        .catch(() => { status.textContent = "Save failed"; })
        .finally(() => { saveBtn.disabled = false; });
    }

    saveBtn.addEventListener('click', save);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    });
  }

  function renderPreview() {
    const { headers, rows } = parseCSV(raw);
    if (headers.length === 0) {
      container.innerHTML = toggleBar("preview") + `<pre class="artifact-code">${esc(raw)}</pre>`;
      wireToggle();
      return;
    }

    let sortCol = -1;
    let sortAsc = true;
    let sortedRows = rows.slice();

    function renderTable() {
      let thead = '<tr>';
      for (let i = 0; i < headers.length; i++) {
        let arrow = '';
        if (sortCol === i) arrow = sortAsc ? ' ▲' : ' ▼';
        thead += `<th data-col="${i}">${esc(headers[i])}${arrow}</th>`;
      }
      thead += '</tr>';

      let tbody = '';
      for (const row of sortedRows) {
        tbody += '<tr>';
        for (let i = 0; i < headers.length; i++) {
          tbody += `<td>${esc(row[i] || '')}</td>`;
        }
        tbody += '</tr>';
      }

      container.innerHTML = toggleBar("preview")
        + `<div class="csv-table-wrapper">`
        + `<table class="csv-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`
        + `</div>`
        + `<div class="csv-footer">${sortedRows.length} row${sortedRows.length !== 1 ? 's' : ''}</div>`;
      wireToggle();

      container.querySelectorAll('.csv-table th').forEach(th => {
        th.addEventListener('click', () => {
          const col = parseInt(th.dataset.col);
          if (sortCol === col) {
            sortAsc = !sortAsc;
          } else {
            sortCol = col;
            sortAsc = true;
          }
          sortedRows.sort((a, b) => {
            const va = a[col] || '';
            const vb = b[col] || '';
            const na = Number(va), nb = Number(vb);
            if (!isNaN(na) && !isNaN(nb) && va !== '' && vb !== '') {
              return sortAsc ? na - nb : nb - na;
            }
            return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
          });
          renderTable();
        });
      });
    }

    renderTable();
  }

  function render() {
    if (mode === "edit") renderEdit();
    else renderPreview();
  }

  render();
}

// ═══ CODE SYNTAX HIGHLIGHTING ═══
const CODE_EXTENSIONS = {
  '.py': 'python', '.js': 'javascript', '.ts': 'typescript', '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'bash', '.bash': 'bash',
  '.css': 'css', '.html': 'xml', '.htm': 'xml', '.go': 'go', '.rs': 'rust',
  '.sql': 'sql', '.toml': 'ini', '.rb': 'ruby', '.java': 'java',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.xml': 'xml',
  '.dockerfile': 'dockerfile', '.tf': 'hcl', '.lua': 'lua',
};

function getLanguageFromPath(filePath) {
  if (!filePath) return null;
  const name = filePath.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const ext = name.slice(dotIdx);
  return CODE_EXTENSIONS[ext] || null;
}

function isSQLFile(filePath) {
  return /\.sql$/i.test(filePath || "");
}

function renderSQLArtifact(container, text, filePath) {
  container.style.position = "relative";
  const lines = text.split('\n');
  let gutterHtml = '';
  for (let i = 1; i <= lines.length; i++) gutterHtml += i + '\n';
  container.innerHTML = `<div class="code-viewer"><pre class="code-gutter">${gutterHtml}</pre><pre class="code-block"><code class="language-sql">${esc(text)}</code></pre></div><div class="sql-hint">Ctrl+Enter to execute (no connector configured)</div>`;
  const codeEl = container.querySelector('code');
  if (codeEl && typeof hljs !== 'undefined') hljs.highlightElement(codeEl);
}

function renderCodeArtifact(container, text, filePath) {
  container.style.position = "relative";
  const lang = getLanguageFromPath(filePath);
  if (!lang || typeof hljs === 'undefined') {
    container.innerHTML = `<pre class="artifact-code">${esc(text)}</pre>`;
  } else {
    const lines = text.split('\n');
    let gutterHtml = '';
    for (let i = 1; i <= lines.length; i++) {
      gutterHtml += i + '\n';
    }
    container.innerHTML = `<div class="code-viewer"><pre class="code-gutter">${gutterHtml}</pre><pre class="code-block"><code class="language-${lang}">${esc(text)}</code></pre></div>`;
    const codeEl = container.querySelector('code');
    if (codeEl) hljs.highlightElement(codeEl);
  }
}

function renderArtifactView(container, artifact, onMeta) {
  if (artifact.type === "url") {
    if (container.dataset.artValue !== artifact.value) {
      container.innerHTML = `<iframe class="artifact-iframe" src="${esc(artifact.value)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
      container.dataset.artValue = artifact.value;
    }
    if (onMeta) onMeta(null, true);
  } else if (isHTMLFile(artifact.value)) {
    container.dataset.artValue = "";
    // Static HTML file: render as iframe but fetch mtime so the poller can
    // cache-bust-reload it on disk change (live marimo/jupyter iframes are
    // proxy URLs and handle their own refresh — not this path).
    fetch(`/api/file?path=${encodeURIComponent(artifact.value)}`, { method: "HEAD" })
      .then((r) => r.ok ? r.headers.get("X-File-Mtime") : null)
      .catch(() => null)
      .then((mtime) => {
        renderHTMLArtifact(container, artifact.value, mtime);
        // hasIframe=false so the poller tracks it; htmlFile=true so reload
        // re-sets the iframe src instead of destroying the cache entry.
        if (onMeta) onMeta(mtime, false, true);
      });
  } else {
    container.dataset.artValue = "";
    container.innerHTML = `<div class="artifact-file-loading">Loading...</div>`;
    fetch(`/api/file?path=${encodeURIComponent(artifact.value)}`)
      .then((r) => {
        if (!r.ok) return Promise.reject("not found");
        const mtime = r.headers.get("X-File-Mtime");
        return r.text().then(text => ({ text, mtime }));
      })
      .then(({ text, mtime }) => {
        const isIframe = isMarimoNotebook(text, artifact.label || artifact.value) || isJupyterNotebook(artifact.value);
        if (isMarimoNotebook(text, artifact.label || artifact.value)) {
          if (noteMarimoNotebook(artifact.value)) renderWorkHeader();
          renderMarimoNotebook(container, text, artifact.value);
        } else if (isCSVFile(artifact.value)) {
          renderCSVTable(container, text, artifact.value);
        } else if (isJupyterNotebook(artifact.value)) {
          renderJupyterNotebook(container, text, artifact.value);
        } else if (isMarkdownFile(artifact.value)) {
          renderMarkdownArtifact(container, text, artifact.value);
        } else {
          container.style.position = "relative";
          openVimEditor(container, artifact.value, false);
        }
        if (onMeta) onMeta(mtime, isIframe);
      })
      .catch(() => {
        container.innerHTML = `<div class="artifact-file-error">Could not load file: ${esc(artifact.value)}</div>`;
      });
  }
}

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

async function removeArtifact(idx) {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (!s || !s.artifacts) return;
  const tabId = `artifact:${idx}`;
  closeTab(tabId);
  // Re-index open tabs after removal
  const open = openTabsPerSession[activeSessionId];
  if (open) {
    const newOpen = new Set();
    open.forEach((t) => {
      if (t.startsWith("artifact:")) {
        const ti = parseInt(t.split(":")[1]);
        if (ti < idx) newOpen.add(t);
        else if (ti > idx) newOpen.add(`artifact:${ti - 1}`);
      } else { newOpen.add(t); }
    });
    openTabsPerSession[activeSessionId] = newOpen;
  }
  s.artifacts.splice(idx, 1);
  await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifacts: s.artifacts }),
  });
  render();
}

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
          const toUpdate = sessions.filter((s) => s.group === oldName);
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
            const list = workspaceGroups.map((g) => g === oldName ? newName : g);
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
      const groupItems = sessions.filter((s) => s.group === groupName);
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
      group.classList.toggle("open");
      const dirIcon = hdr.querySelector(".af-dir-icon");
      if (dirIcon) dirIcon.innerHTML = folderIcon(group.classList.contains("open"), 15);
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
    html += `<div class="af-group open" data-af-dir="${esc(dir)}">`;
    html += `<div class="af-group-hdr"><span class="af-arrow">&#9654;</span><span class="af-dir-icon">${folderIcon(true, 15)}</span> ${esc(dirName)}</div>`;
    html += `<div class="af-group-body">`;
    items.forEach(({ art, idx, filename }) => {
      const icon = fileIcon(filename, 15);
      html += `<div class="af" data-art-idx="${idx}"><span class="af-i">${icon}</span><span class="af-label">${esc(filename)}</span><span class="af-rm" data-art-rm="${idx}" title="Remove">×</span></div>`;
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
  return "working...";
}

// ═══ MARIMO NOTEBOOK ═══

function isMarimoNotebook(text, label) {
  if (!text) return false;
  if (label && (/marimo/i.test(label) || /\.marimo\.py$/i.test(label))) return true;
  const head = text.slice(0, 500);
  if (/^import\s+marimo/m.test(head)) return true;
  if (/marimo\.App\s*\(/.test(head) && /@app\.cell/.test(text)) return true;
  return false;
}

function parseMarimoNotebook(text) {
  const cells = [];
  const parts = text.split(/(?=@app\.cell)/);
  for (const part of parts) {
    const m = part.match(/@app\.cell[^\n]*\ndef\s+(\w+)\s*\([^)]*\)\s*(?:->.*?)?:\n([\s\S]*)/);
    if (!m) continue;
    const name = m[1];
    let body = m[2];
    const lines = body.split('\n');
    // Trim trailing empty lines
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    // Dedent: find minimum indentation of non-empty lines
    let minIndent = Infinity;
    for (const line of lines) {
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent < minIndent) minIndent = indent;
    }
    if (minIndent === Infinity) minIndent = 0;
    const dedented = lines.map(l => l.slice(minIndent)).join('\n').trimEnd();
    cells.push({ name, code: dedented });
  }
  return cells;
}

function renderMarimoNotebook(container, text, filePath) {
  const cells = parseMarimoNotebook(text);

  const widthMatch = text.match(/marimo\.App\(\s*width\s*=\s*"([^"]+)"/);
  const width = widthMatch ? widthMatch[1] : 'medium';
  const genMatch = text.match(/__generated_with\s*=\s*"([^"]+)"/);
  const genVersion = genMatch ? genMatch[1] : null;

  // Build static cell preview as fallback / loading state
  let cellsHtml = '';
  for (const cell of cells) {
    cellsHtml += `<div class="marimo-cell">`;
    cellsHtml += `<div class="marimo-cell-header"><span class="marimo-cell-icon">&#9654;</span><span class="marimo-cell-name">${esc(cell.name)}</span></div>`;
    cellsHtml += `<pre class="marimo-cell-code"><code>${esc(cell.code)}</code></pre>`;
    cellsHtml += `</div>`;
  }

  let headerHtml = `<div class="marimo-header">`;
  headerHtml += `<span class="marimo-logo">marimo</span>`;
  if (genVersion) headerHtml += `<span class="marimo-version">v${esc(genVersion)}</span>`;
  headerHtml += `<span class="marimo-cell-count">${cells.length} cell${cells.length !== 1 ? 's' : ''}</span>`;
  if (filePath) headerHtml += `<button class="marimo-launch-btn" id="marimo-launch-btn">Launch editor</button>`;
  headerHtml += `</div>`;

  // Auto-launch marimo editor if filePath available
  if (filePath) {
    container.innerHTML = `<div class="marimo-notebook" data-width="${esc(width)}">${headerHtml.replace('Launch editor', 'Starting...')}${cellsHtml}</div>`;
    startMarimoServer(container, filePath);
  } else {
    container.innerHTML = `<div class="marimo-notebook" data-width="${esc(width)}">${headerHtml}${cellsHtml}</div>`;
  }

  // Highlight cells if hljs available (shown briefly while marimo starts)
  container.querySelectorAll('.marimo-cell-code code').forEach((el) => {
    if (typeof hljs !== 'undefined') {
      el.classList.add('language-python');
      hljs.highlightElement(el);
    }
  });
}

async function startMarimoServer(container, filePath) {
  const btn = container.querySelector('#marimo-launch-btn');
  if (btn) { btn.textContent = 'Starting...'; btn.disabled = true; }

  try {
    const resp = await fetch('/api/marimo/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    const iframeSrc = data.proxyBase || `http://localhost:${data.port}`;
    container.innerHTML = `<div class="marimo-live"><div class="marimo-live-header"><span class="marimo-logo">marimo</span><span class="marimo-live-status">Running on port ${data.port}</span><button class="marimo-stop-btn">Stop</button></div><iframe class="marimo-iframe" src="${esc(iframeSrc)}/"></iframe></div>`;

    const iframe = container.querySelector('.marimo-iframe');
    const stopBtn = container.querySelector('.marimo-stop-btn');

    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        await fetch('/api/marimo/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath }),
        });
        const text = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`).then(r => r.text());
        renderMarimoNotebook(container, text, filePath);
      });
    }
  } catch (e) {
    if (btn) { btn.textContent = `Failed: ${e.message}`; btn.disabled = false; }
  }
}

function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ═══ JUPYTER NOTEBOOK ═══

function isJupyterNotebook(filePath) {
  if (!filePath) return false;
  return filePath.toLowerCase().endsWith('.ipynb');
}

async function startJupyterServer(filePath) {
  const res = await fetch("/api/jupyter/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePath }),
  });
  return await res.json();
}

function renderJupyterNotebook(container, text, filePath) {
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  container.innerHTML = `<div class="jupyter-notebook"><div class="jupyter-header"><span class="jupyter-logo">Jupyter</span><span class="jupyter-kernel">Launching server...</span></div></div>`;

  startJupyterServer(filePath).then(({ proxyBase }) => {
    if (!proxyBase) {
      renderJupyterNotebookStatic(container, text, filePath);
      return;
    }
    const src = `${proxyBase}/notebooks/${encodeURIComponent(fileName)}`;
    container.innerHTML = `<iframe class="jupyter-live" src="${src}" style="width:100%;height:100%;border:none;background:#111" allow="clipboard-read; clipboard-write"></iframe>`;
  }).catch(() => {
    renderJupyterNotebookStatic(container, text, filePath);
  });
}

function renderJupyterNotebookStatic(container, text, filePath) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch (e) {
    container.innerHTML = `<pre class="artifact-code" style="color:var(--red)">Failed to parse notebook JSON: ${esc(e.message)}</pre>`;
    return;
  }

  const cells = nb.cells || [];
  const lang = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.language) || 'python';

  let cellsHtml = '';
  for (const cell of cells) {
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');

    if (cell.cell_type === 'markdown') {
      let mdHtml;
      if (typeof marked !== 'undefined') {
        try { mdHtml = marked.parse(source); } catch { mdHtml = esc(source); }
      } else {
        mdHtml = esc(source);
      }
      cellsHtml += `<div class="jupyter-cell jupyter-cell-md"><div class="md-preview">${mdHtml}</div></div>`;
    } else if (cell.cell_type === 'code') {
      const execCount = cell.execution_count != null ? cell.execution_count : ' ';
      cellsHtml += `<div class="jupyter-cell jupyter-cell-code">`;
      cellsHtml += `<div class="jupyter-input">`;
      cellsHtml += `<span class="jupyter-label jupyter-label-in">In [${esc(String(execCount))}]:</span>`;
      cellsHtml += `<pre class="jupyter-source"><code class="language-${esc(lang)}">${esc(source)}</code></pre>`;
      cellsHtml += `</div>`;

      if (cell.outputs && cell.outputs.length > 0) {
        cellsHtml += `<div class="jupyter-outputs">`;
        for (const out of cell.outputs) {
          cellsHtml += renderJupyterOutput(out, execCount);
        }
        cellsHtml += `</div>`;
      }

      cellsHtml += `</div>`;
    } else if (cell.cell_type === 'raw') {
      cellsHtml += `<div class="jupyter-cell jupyter-cell-raw"><pre class="jupyter-raw-text">${esc(source)}</pre></div>`;
    }
  }

  const kernelName = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.display_name) || '';
  let headerHtml = `<div class="jupyter-header">`;
  headerHtml += `<span class="jupyter-logo">Jupyter</span>`;
  if (kernelName) headerHtml += `<span class="jupyter-kernel">${esc(kernelName)}</span>`;
  headerHtml += `<span class="jupyter-cell-count">${cells.length} cell${cells.length !== 1 ? 's' : ''}</span>`;
  headerHtml += `</div>`;

  container.innerHTML = `<div class="jupyter-notebook">${headerHtml}${cellsHtml}</div>`;

  container.querySelectorAll('.jupyter-source code').forEach((el) => {
    if (typeof hljs !== 'undefined') hljs.highlightElement(el);
  });
}

function renderJupyterOutput(out, execCount) {
  const type = out.output_type;

  if (type === 'stream') {
    const text = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
    return `<pre class="jupyter-output-stream">${esc(text)}</pre>`;
  }

  if (type === 'execute_result' || type === 'display_data') {
    const data = out.data || {};
    let label = '';
    if (type === 'execute_result' && out.execution_count != null) {
      label = `<span class="jupyter-label jupyter-label-out">Out[${esc(String(out.execution_count))}]:</span>`;
    }
    if (data['text/html']) {
      const html = Array.isArray(data['text/html']) ? data['text/html'].join('') : data['text/html'];
      return `<div class="jupyter-output-rich">${label}<div class="jupyter-output-html">${html}</div></div>`;
    }
    if (data['text/plain']) {
      const plain = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain'];
      return `<div class="jupyter-output-rich">${label}<pre class="jupyter-output-text">${esc(plain)}</pre></div>`;
    }
    if (data['image/png']) {
      return `<div class="jupyter-output-rich">${label}<img class="jupyter-output-img" src="data:image/png;base64,${data['image/png']}" /></div>`;
    }
    return '';
  }

  if (type === 'error') {
    const tb = (out.traceback || []).join('\n');
    const clean = tb.replace(/\x1b\[[0-9;]*m/g, '');
    return `<pre class="jupyter-output-error">${esc(clean)}</pre>`;
  }

  return '';
}

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

// ═══ FILE ICONS (VS Code Seti-style) ═══
const FILE_ICON_DEFS = {
  md:       { color: "#519aba", letter: "M" },
  markdown: { color: "#519aba", letter: "M" },
  py:       { color: "#3572A5", letter: "py" },
  marimo:   { color: "#2ecc71", letter: "py" },
  ipynb:    { color: "#e37933", letter: "J" },
  csv:      { color: "#89e051", letter: "," },
  sql:      { color: "#e6c07b", letter: "S" },
  js:       { color: "#cbcb41", letter: "js" },
  ts:       { color: "#3178c6", letter: "ts" },
  jsx:      { color: "#61dafb", letter: "⚛" },
  tsx:      { color: "#3178c6", letter: "⚛" },
  json:     { color: "#cbcb41", letter: "{}" },
  yaml:     { color: "#a074c4", letter: "Y" },
  yml:      { color: "#a074c4", letter: "Y" },
  sh:       { color: "#89e051", letter: "$" },
  bash:     { color: "#89e051", letter: "$" },
  zsh:      { color: "#89e051", letter: "$" },
  go:       { color: "#00ADD8", letter: "Go" },
  rs:       { color: "#dea584", letter: "rs" },
  rb:       { color: "#cc3e44", letter: "rb" },
  html:     { color: "#e44d26", letter: "<>" },
  htm:      { color: "#e44d26", letter: "<>" },
  css:      { color: "#563d7c", letter: "#" },
  scss:     { color: "#c76494", letter: "#" },
  txt:      { color: "#8b949e", letter: "T" },
  toml:     { color: "#9c4221", letter: "T" },
  cfg:      { color: "#8b949e", letter: "⚙" },
  ini:      { color: "#8b949e", letter: "⚙" },
  java:     { color: "#cc3e44", letter: "J" },
  c:        { color: "#519aba", letter: "C" },
  cpp:      { color: "#519aba", letter: "++" },
  h:        { color: "#a074c4", letter: "H" },
  php:      { color: "#a074c4", letter: "P" },
  swift:    { color: "#e37933", letter: "S" },
  kt:       { color: "#a074c4", letter: "K" },
  xml:      { color: "#e37933", letter: "X" },
  svg:      { color: "#e37933", letter: "◇" },
  parquet:  { color: "#4caf50", letter: "⊞" },
  arrow:    { color: "#4caf50", letter: "→" },
  xlsx:     { color: "#207245", letter: "X" },
  xls:      { color: "#207245", letter: "X" },
};

const URL_TAB_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.6 9.4l2.8-2.8M6.9 4.6l.9-.9a2.4 2.4 0 013.4 3.4l-1.1 1.1M9.1 11.4l-.9.9a2.4 2.4 0 01-3.4-3.4l1.1-1.1" stroke="#58a6ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Marimo notebooks are plain `.py` and only detectable by content. Once an
// artifact has been classified at render time (via isMarimoNotebook), we remember
// its basename so the file-type icon upgrades from generic Python to marimo.
const marimoNameCache = new Set();
function noteMarimoNotebook(pathOrName) {
  const base = (pathOrName || "").toLowerCase().split("/").pop();
  if (!base || marimoNameCache.has(base)) return false;
  marimoNameCache.add(base);
  return true;
}

// Hand-drawn distinct glyphs for high-value file types. Each returns the inner
// SVG markup (children of a 16x16 viewBox). The long tail falls back to a
// colored letter-in-document below.
const FILE_ICON_GLYPHS = {
  // Markdown — official Markdown mark (markdown-mark, CC0), scaled from 24→16
  md: (c) => `<g transform="scale(.6667)"><path fill="${c}" d="M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z"/></g>`,
  // SQL — database cylinder (stacked ellipses)
  sql: (c) => `<path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" fill="${c}" opacity="0.15" stroke="${c}" stroke-width="1" stroke-linecap="round"/><ellipse cx="8" cy="4" rx="5" ry="1.9" fill="${c}" opacity="0.2" stroke="${c}" stroke-width="1"/><path d="M3 7.7c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" fill="none" stroke="${c}" stroke-width="1"/>`,
  // Python — two-tone interlocking blocks
  py: () => `<path d="M8 1.5c-2 0-3.4.5-3.4 2.2v1.6h3.6v.5H3.3C1.7 5.8 1.2 7 1.2 8.8s.6 3 2.1 3h1.2V9.9c0-1.5 1.2-2.6 2.6-2.6h3.2c1.3 0 2.3-1 2.3-2.3V3.7C12.6 2.2 11.4 1.5 8 1.5zM6 2.9a.7.7 0 110 1.4.7.7 0 010-1.4z" fill="#3572A5"/><path d="M8 14.5c2 0 3.4-.5 3.4-2.2v-1.6H7.8v-.5h4.9c1.6 0 2.1-1.2 2.1-3s-.6-3-2.1-3h-1.2v1.9c0 1.5-1.2 2.6-2.6 2.6H5.7c-1.3 0-2.3 1-2.3 2.3v1.3c0 1.5 1.2 2.2 4.6 2.2zm2-1.4a.7.7 0 110-1.4.7.7 0 010 1.4z" fill="#FFD43B"/>`,
  // Marimo — reactive cells (green): a node graph of connected cells
  marimo: () => `<rect x="1" y="3" width="14" height="10" rx="2" fill="#1f6f3f" opacity="0.18" stroke="#2ecc71" stroke-width="1"/><circle cx="5" cy="6" r="1.4" fill="#2ecc71"/><circle cx="11" cy="6" r="1.4" fill="#2ecc71"/><circle cx="8" cy="10.5" r="1.4" fill="#2ecc71"/><path d="M5 7.2l2.4 2.5M11 7.2L8.6 9.7M5.4 6h5.2" stroke="#2ecc71" stroke-width="0.9" fill="none" stroke-linecap="round"/>`,
  // Jupyter — official Jupyter logo (Simple Icons, CC0), scaled from 24→16
  ipynb: () => `<g transform="scale(.6667)" fill="#f37726"><path d="M7.157 22.201A1.784 1.799 0 0 1 5.374 24a1.784 1.799 0 0 1-1.784-1.799 1.784 1.799 0 0 1 1.784-1.799 1.784 1.799 0 0 1 1.783 1.799zM20.582 1.427a1.415 1.427 0 0 1-1.415 1.428 1.415 1.427 0 0 1-1.416-1.428A1.415 1.427 0 0 1 19.167 0a1.415 1.427 0 0 1 1.415 1.427zM4.992 3.336A1.047 1.056 0 0 1 3.946 4.39a1.047 1.056 0 0 1-1.047-1.055A1.047 1.056 0 0 1 3.946 2.28a1.047 1.056 0 0 1 1.046 1.056zm7.336 1.517c3.769 0 7.06 1.38 8.768 3.424a9.363 9.363 0 0 0-3.393-4.547 9.238 9.238 0 0 0-5.377-1.728A9.238 9.238 0 0 0 6.95 3.73a9.363 9.363 0 0 0-3.394 4.547c1.713-2.04 5.004-3.424 8.772-3.424zm.001 13.295c-3.768 0-7.06-1.381-8.768-3.425a9.363 9.363 0 0 0 3.394 4.547A9.238 9.238 0 0 0 12.33 21a9.238 9.238 0 0 0 5.377-1.729 9.363 9.363 0 0 0 3.393-4.547c-1.712 2.044-5.003 3.425-8.772 3.425Z"/></g>`,
  // CSV — small table/grid
  csv: (c) => `<rect x="2" y="3" width="12" height="10" rx="1.5" fill="${c}" opacity="0.15" stroke="${c}" stroke-width="1"/><path d="M2 6.3h12M2 9.6h12M6 3v10M10 3v10" stroke="${c}" stroke-width="0.9"/>`,
  // HTML — browser window (reads as "a rendered web page")
  html: (c) => `<rect x="1.5" y="2.5" width="13" height="11" rx="1.6" fill="${c}" opacity="0.12" stroke="${c}" stroke-width="1"/><path d="M1.5 5.6h13" stroke="${c}" stroke-width="1"/><circle cx="3.5" cy="4" r=".55" fill="${c}"/><circle cx="5.3" cy="4" r=".55" fill="${c}"/><circle cx="7.1" cy="4" r=".55" fill="${c}"/><path d="M6.6 10.4L5.2 9l1.4-1.4M9.4 7.6L10.8 9l-1.4 1.4" stroke="${c}" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  // JSON — braces
  json: (c) => `<rect x="2" y="2.5" width="12" height="11" rx="2" fill="${c}" opacity="0.12" stroke="${c}" stroke-width="0.8"/><path d="M6.2 3.5c-1.2 0-1.6.6-1.6 1.6 0 1.4 0 1.5-1 1.9 1 .4 1 .5 1 1.9 0 1 .4 1.6 1.6 1.6" stroke="${c}" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1.5)"/><path d="M9.8 3.5c1.2 0 1.6.6 1.6 1.6 0 1.4 0 1.5 1 1.9-1 .4-1 .5-1 1.9 0 1-.4 1.6-1.6 1.6" stroke="${c}" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1.5)"/>`,
};

function fileIcon(name, size = 16) {
  const lower = (name || "").toLowerCase();
  const base = lower.split("/").pop();
  let ext = base.split(".").pop();
  // marimo notebooks are plain `.py`: use the `.marimo.py` naming convention, or
  // a content classification cached at render time (see marimoNameCache).
  if (lower.endsWith(".marimo.py") || (base.endsWith(".py") && marimoNameCache.has(base))) ext = "marimo";
  const def = FILE_ICON_DEFS[ext] || { color: "#8b949e", letter: "" };
  const glyph = FILE_ICON_GLYPHS[ext];
  if (glyph) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${glyph(def.color)}</svg>`;
  }
  const { color, letter } = def;
  const fontSize = letter.length > 2 ? 5 : letter.length > 1 ? 6 : 7;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h6.5L13 4.5V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" fill="${color}" opacity="0.15" stroke="${color}" stroke-width="1"/><path d="M9.5 1v2.5a1 1 0 001 1H13" stroke="${color}" stroke-width="1"/>${letter ? `<text x="8" y="11.5" text-anchor="middle" fill="${color}" font-family="monospace" font-size="${fontSize}" font-weight="bold">${letter}</text>` : ""}</svg>`;
}

function folderIcon(open, size = 16) {
  const color = "#c09553";
  if (open) return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path d="M1.5 13V4a1 1 0 011-1H6l1.5 1.5H13a1 1 0 011 1V6H5.5L4 8l-1.5 5H2.5a1 1 0 01-1-1z" fill="${color}" opacity="0.15" stroke="${color}"/><path d="M4.5 6H14l-2 7H2.5L4.5 6z" fill="${color}" opacity="0.25" stroke="${color}"/></svg>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path d="M1.5 13V4a1 1 0 011-1H6l1.5 1.5H13a1 1 0 011 1V13a1 1 0 01-1 1H2.5a1 1 0 01-1-1z" fill="${color}" opacity="0.15" stroke="${color}"/></svg>`;
}

function fileExtIcon(name) {
  return fileIcon(name, 15);
}

function showArtifactPopover(e) {
  hideAddPopover();
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.id = "add-popover";
  pop.className = "add-popover add-popover-wide";

  const s = sessions.find(x => x.id === activeSessionId);
  const existingPaths = new Set((s?.artifacts || []).map(a => a.value));

  pop.innerHTML = `
    <div class="add-pop-tabs">
      <span class="add-pop-tab active" data-tab="suggest">Suggested</span>
      <span class="add-pop-tab" data-tab="browse">Browse</span>
      <span class="add-pop-tab" data-tab="url">URL</span>
    </div>
    <div class="add-pop-body" id="art-suggest-body">
      <input class="add-pop-input add-pop-filter" id="art-filter" type="text" placeholder="Filter files..." spellcheck="false" />
      <div class="art-suggest-list" id="art-suggest-list">
        <div class="art-suggest-loading">Scanning...</div>
      </div>
    </div>
    <div class="add-pop-body" id="art-browse-body" style="display:none">
      <div class="art-browse-breadcrumb" id="art-browse-crumb"></div>
      <div class="art-browse-list" id="art-browse-list"></div>
    </div>
    <div class="add-pop-body" id="art-url-body" style="display:none">
      <input class="add-pop-input" id="art-url-input" type="text" placeholder="https://..." spellcheck="false" />
      <input class="add-pop-input" id="art-url-label" type="text" placeholder="Label (optional)" spellcheck="false" />
      <div class="add-pop-hint">Enter to add · Esc to cancel</div>
    </div>
  `;

  document.body.appendChild(pop);
  pop.style.left = Math.max(8, rect.left - 120) + "px";
  pop.style.top = (rect.bottom + 4) + "px";

  const bodyIds = { suggest: "art-suggest-body", browse: "art-browse-body", url: "art-url-body" };
  const focusMap = { suggest: "#art-filter", browse: null, url: "#art-url-input" };

  pop.querySelectorAll(".add-pop-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      pop.querySelectorAll(".add-pop-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      for (const [k, id] of Object.entries(bodyIds)) {
        pop.querySelector(`#${id}`).style.display = k === tab.dataset.tab ? "" : "none";
      }
      const focusSel = focusMap[tab.dataset.tab];
      if (focusSel) pop.querySelector(focusSel)?.focus();
      if (tab.dataset.tab === "browse") loadBrowseDir("");
    });
  });

  // ── Suggested tab ──
  const cwdParam = s?.cwd ? `cwd=${encodeURIComponent(s.cwd)}&` : "";
  const agentParam = s?.id ? `agentId=${encodeURIComponent(s.id)}` : "";
  fetch(`/api/files/suggest?${cwdParam}${agentParam}`)
    .then(r => r.json())
    .then(files => {
      const list = pop.querySelector("#art-suggest-list");
      if (!list) return;
      const filtered = files.filter(f => !existingPaths.has(f.path));
      if (!filtered.length) {
        list.innerHTML = '<div class="art-suggest-empty">No new files found</div>';
        return;
      }
      list.innerHTML = "";
      const allItems = [];
      let addedOtherHeader = false;
      filtered.forEach(f => {
        if (!addedOtherHeader && (f.score || 0) <= 0) {
          addedOtherHeader = true;
          const sep = document.createElement("div");
          sep.className = "art-suggest-sep";
          sep.textContent = "Other files";
          list.appendChild(sep);
        }
        const item = document.createElement("div");
        item.className = "art-suggest-item";
        item.innerHTML = `<span class="art-suggest-icon">${fileExtIcon(f.name)}</span><span class="art-suggest-path">${esc(f.path)}</span>`;
        item.addEventListener("click", async () => {
          hideAddPopover();
          await addArtifact("file", f.path, f.name);
        });
        list.appendChild(item);
        allItems.push({ el: item, path: f.path.toLowerCase() });
      });

      const filterInput = pop.querySelector("#art-filter");
      filterInput.addEventListener("input", () => {
        const q = filterInput.value.toLowerCase();
        allItems.forEach(({ el, path }) => {
          el.style.display = path.includes(q) ? "" : "none";
        });
        list.querySelectorAll(".art-suggest-sep").forEach(sep => sep.style.display = q ? "none" : "");
      });
      filterInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") hideAddPopover();
        if (ev.key === "Enter") {
          const first = list.querySelector(".art-suggest-item:not([style*='display: none'])");
          if (first) first.click();
        }
      });
    })
    .catch(() => {
      const list = pop.querySelector("#art-suggest-list");
      if (list) list.innerHTML = '<div class="art-suggest-empty">Could not scan files</div>';
    });

  // ── Browse tab ──
  let browseCwd = "";
  async function loadBrowseDir(dirPath) {
    browseCwd = dirPath;
    const list = pop.querySelector("#art-browse-list");
    const crumb = pop.querySelector("#art-browse-crumb");
    if (!list || !crumb) return;

    const parts = dirPath ? dirPath.split("/").filter(Boolean) : [];
    let crumbHtml = `<span class="art-browse-crumb-seg" data-path="">./</span>`;
    let acc = "";
    parts.forEach(p => {
      acc += (acc ? "/" : "") + p;
      crumbHtml += `<span class="art-browse-crumb-seg" data-path="${esc(acc)}">${esc(p)}/</span>`;
    });
    crumb.innerHTML = crumbHtml;
    crumb.querySelectorAll(".art-browse-crumb-seg").forEach(seg => {
      seg.addEventListener("click", () => loadBrowseDir(seg.dataset.path));
    });

    list.innerHTML = '<div class="art-suggest-loading">Loading...</div>';
    try {
      const cwdQ = s?.cwd ? `cwd=${encodeURIComponent(s.cwd)}&` : "";
      const entries = await (await fetch(`/api/files/browse?${cwdQ}path=${encodeURIComponent(dirPath)}`)).json();
      list.innerHTML = "";
      if (dirPath) {
        const up = document.createElement("div");
        up.className = "art-browse-item art-browse-dir";
        up.innerHTML = `<span class="art-browse-icon">..</span>`;
        up.addEventListener("click", () => {
          const parent = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : "";
          loadBrowseDir(parent);
        });
        list.appendChild(up);
      }
      entries.forEach(entry => {
        const item = document.createElement("div");
        const entryPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        if (entry.type === "dir") {
          item.className = "art-browse-item art-browse-dir";
          item.innerHTML = `<span class="art-browse-icon">${folderIcon(15)}</span><span class="art-browse-name">${esc(entry.name)}</span>`;
          item.addEventListener("click", () => loadBrowseDir(entryPath));
        } else {
          const already = existingPaths.has(entryPath);
          item.className = `art-browse-item art-browse-file${already ? " art-browse-exists" : ""}`;
          item.innerHTML = `<span class="art-browse-icon">${fileExtIcon(entry.name)}</span><span class="art-browse-name">${esc(entry.name)}</span>${already ? '<span class="art-browse-added">added</span>' : ""}`;
          if (!already) {
            item.addEventListener("click", async () => {
              hideAddPopover();
              await addArtifact("file", entryPath, entry.name);
            });
          }
        }
        list.appendChild(item);
      });
      if (!entries.length) list.innerHTML = '<div class="art-suggest-empty">Empty directory</div>';
    } catch {
      list.innerHTML = '<div class="art-suggest-empty">Could not list directory</div>';
    }
  }

  // ── URL tab ──
  const urlInput = pop.querySelector("#art-url-input");
  const urlLabel = pop.querySelector("#art-url-label");
  const handleUrlKey = async (ev) => {
    if (ev.key === "Escape") { hideAddPopover(); return; }
    if (ev.key === "Enter") {
      const value = urlInput.value.trim();
      if (!value) return;
      hideAddPopover();
      await addArtifact("url", value, urlLabel.value.trim());
    }
  };
  urlInput.addEventListener("keydown", handleUrlKey);
  urlLabel.addEventListener("keydown", handleUrlKey);

  const filterInput = pop.querySelector("#art-filter");
  if (filterInput) filterInput.focus();

  setTimeout(() => {
    document.addEventListener("click", onClickOutsidePopover);
  }, 0);
}

async function addArtifact(type, value, label) {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (!s) return;
  if (!s.artifacts) s.artifacts = [];
  const artifact = { type, value };
  if (label) artifact.label = label;
  s.artifacts.push(artifact);
  await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifacts: s.artifacts }),
  });
  render();
  switchTab(`artifact:${s.artifacts.length - 1}`);
}

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
    `<kbd>${alt}+1</kbd>–<kbd>${alt}+9</kbd> switch agent`,
    `<kbd>${alt}+H</kbd> / <kbd>${alt}+L</kbd> prev/next agent`,
    `<kbd>${alt}+T</kbd> new shell`,
    `<kbd>${alt}+J</kbd> / <kbd>${alt}+K</kbd> prev/next tab`,
  ];
  const s = sessions.find(x => x.id === activeSessionId);
  const art = s?.artifacts?.[0];
  if (art && isMarkdownFile(art.value)) {
    hints.push(`<kbd>${mod}+Shift+V</kbd> toggle preview`);
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

    // Ctrl+Shift+R: reload current artifact
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyR") {
      e.preventDefault();
      reloadCurrentArtifact();
      return true;
    }

    // Ctrl+Shift+V / Cmd+Shift+V: toggle view/edit mode
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyV") {
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
    if ((digit >= 1 && digit <= 9) || isAltKey(e, "h") || isAltKey(e, "l") || isAltKey(e, "j") || isAltKey(e, "k") || isAltKey(e, "t")) {
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

// ═══ SHELL TABS ═══
function createShellTab() {
  if (!activeSessionId) return;
  if (!openTabsPerSession[activeSessionId]) openTabsPerSession[activeSessionId] = new Set();
  const open = openTabsPerSession[activeSessionId];

  // Find next available shell number
  let n = 1;
  while (open.has(`shell:${n}`)) n++;
  const shellId = `shell:${n}`;
  const shellName = `sh${n}`;
  const key = `${activeSessionId}:${shellId}`;

  open.add(shellId);

  // Create xterm instance
  const shellTerm = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      selectionBackground: "#264f78",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    allowProposedApi: true,
  });

  const shellFitAddon = new FitAddon.FitAddon();
  shellTerm.loadAddon(shellFitAddon);
  shellTerm.loadAddon(new WebLinksAddon.WebLinksAddon());

  // Create container div
  const container = document.createElement("div");
  container.className = "shell-container";
  container.dataset.shellKey = key;
  document.getElementById("ws-content").appendChild(container);

  shellTerm.open(container);

  // Connect WebSocket
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const shellWs = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(activeSessionId)}&shell=${encodeURIComponent(shellName)}${wsTokenParam()}`);

  shellTerm.onData((data) => {
    if (shellWs && shellWs.readyState === WebSocket.OPEN) {
      shellWs.send(JSON.stringify({ type: "input", data }));
    }
  });

  shellWs.onopen = () => {
    requestAnimationFrame(() => {
      shellFitAddon.fit();
      if (shellWs.readyState === WebSocket.OPEN) {
        shellWs.send(JSON.stringify({ type: "resize", cols: shellTerm.cols, rows: shellTerm.rows }));
      }
    });
  };

  shellWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        shellTerm.write(msg.data);
      }
    } catch {
      shellTerm.write(event.data);
    }
  };

  shellWs.onclose = () => {};
  shellWs.onerror = () => { shellWs.close(); };

  // ResizeObserver for fitting
  const ro = new ResizeObserver(() => {
    if (container.offsetWidth < 50 || container.offsetHeight < 50) return;
    if (!container.classList.contains("active")) return;
    shellFitAddon.fit();
    if (shellWs && shellWs.readyState === WebSocket.OPEN) {
      shellWs.send(JSON.stringify({ type: "resize", cols: shellTerm.cols, rows: shellTerm.rows }));
    }
  });
  ro.observe(container);

  // Attach keyboard handler for global shortcuts
  shellTerm.attachCustomKeyEventHandler((e) => {
    function getAltDigit(e) {
      if (!e.altKey) return -1;
      const m = e.code && e.code.match(/^Digit(\d)$/);
      return m ? parseInt(m[1]) : -1;
    }
    function isAltKey(e, letter) {
      if (!e.altKey) return false;
      return e.code === "Key" + letter.toUpperCase();
    }
    const digit = getAltDigit(e);
    if ((digit >= 1 && digit <= 9) || isAltKey(e, "h") || isAltKey(e, "l") || isAltKey(e, "j") || isAltKey(e, "k") || isAltKey(e, "t")) {
      if (e.type === "keydown") {
        if (isAltKey(e, "t")) {
          e.preventDefault();
          createShellTab();
        } else if (isAltKey(e, "h")) { e.preventDefault(); cycleAgent(-1); }
        else if (isAltKey(e, "l")) { e.preventDefault(); cycleAgent(1); }
        else if (isAltKey(e, "j")) { e.preventDefault(); cycleTab(-1); }
        else if (isAltKey(e, "k")) { e.preventDefault(); cycleTab(1); }
        else if (digit >= 1 && digit <= 9) {
          e.preventDefault();
          const ordered = getDisplayOrder();
          const idx = digit - 1;
          if (idx < ordered.length) switchSession(ordered[idx].id);
        }
      }
      return false;
    }
    return true;
  });

  shellInstances.set(key, { term: shellTerm, fitAddon: shellFitAddon, ws: shellWs, container, resizeObserver: ro, shellName });

  // Switch to the new tab
  switchTab(shellId);
}

function closeShellTab(shellId) {
  const key = `${activeSessionId}:${shellId}`;
  const shell = shellInstances.get(key);
  if (shell) {
    // Close WebSocket
    if (shell.ws) {
      shell.ws.onclose = null;
      shell.ws.close();
    }
    // Dispose xterm
    shell.term.dispose();
    // Remove ResizeObserver
    if (shell.resizeObserver) shell.resizeObserver.disconnect();
    // Remove container from DOM
    if (shell.container && shell.container.parentNode) {
      shell.container.remove();
    }
    // Kill tmux session on server
    fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/shells/${encodeURIComponent(shell.shellName)}`, { method: "DELETE" }).catch(() => {});
    shellInstances.delete(key);
  }
  // Remove from open tabs
  const open = openTabsPerSession[activeSessionId];
  if (open) open.delete(shellId);
  if (activeTab === shellId) activeTab = "terminal";
  renderWorkHeader();
  renderWorkContent();
  deferredFit();
  saveUIState();
}

function restoreShellTabs() {
  for (const [sid, tabs] of Object.entries(openTabsPerSession)) {
    if (!(tabs instanceof Set)) continue;
    for (const tabId of tabs) {
      if (!tabId.startsWith("shell:")) continue;
      const n = parseInt(tabId.split(":")[1]);
      if (isNaN(n)) continue;
      const shellName = `sh${n}`;
      const key = `${sid}:${tabId}`;
      if (shellInstances.has(key)) continue;

      // Create xterm instance
      const shellTerm = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          background: "#0d1117",
          foreground: "#c9d1d9",
          cursor: "#58a6ff",
          selectionBackground: "#264f78",
          black: "#484f58",
          red: "#ff7b72",
          green: "#3fb950",
          yellow: "#d29922",
          blue: "#58a6ff",
          magenta: "#bc8cff",
          cyan: "#39c5cf",
          white: "#b1bac4",
          brightBlack: "#6e7681",
          brightRed: "#ffa198",
          brightGreen: "#56d364",
          brightYellow: "#e3b341",
          brightBlue: "#79c0ff",
          brightMagenta: "#d2a8ff",
          brightCyan: "#56d4dd",
          brightWhite: "#f0f6fc",
        },
        allowProposedApi: true,
      });

      const shellFitAddon = new FitAddon.FitAddon();
      shellTerm.loadAddon(shellFitAddon);
      shellTerm.loadAddon(new WebLinksAddon.WebLinksAddon());

      const container = document.createElement("div");
      container.className = "shell-container";
      container.dataset.shellKey = key;
      document.getElementById("ws-content").appendChild(container);

      shellTerm.open(container);

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const shellWs = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(sid)}&shell=${encodeURIComponent(shellName)}${wsTokenParam()}`);

      shellTerm.onData((data) => {
        if (shellWs && shellWs.readyState === WebSocket.OPEN) {
          shellWs.send(JSON.stringify({ type: "input", data }));
        }
      });

      shellWs.onopen = () => {
        requestAnimationFrame(() => {
          shellFitAddon.fit();
          if (shellWs.readyState === WebSocket.OPEN) {
            shellWs.send(JSON.stringify({ type: "resize", cols: shellTerm.cols, rows: shellTerm.rows }));
          }
        });
      };

      shellWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") shellTerm.write(msg.data);
        } catch {
          shellTerm.write(event.data);
        }
      };

      shellWs.onclose = () => {};
      shellWs.onerror = () => { shellWs.close(); };

      const ro = new ResizeObserver(() => {
        if (container.offsetWidth < 50 || container.offsetHeight < 50) return;
        if (!container.classList.contains("active")) return;
        shellFitAddon.fit();
        if (shellWs && shellWs.readyState === WebSocket.OPEN) {
          shellWs.send(JSON.stringify({ type: "resize", cols: shellTerm.cols, rows: shellTerm.rows }));
        }
      });
      ro.observe(container);

      // Attach keyboard handler
      shellTerm.attachCustomKeyEventHandler((e) => {
        function getAltDigit(e) {
          if (!e.altKey) return -1;
          const m = e.code && e.code.match(/^Digit(\d)$/);
          return m ? parseInt(m[1]) : -1;
        }
        function isAltKey(e, letter) {
          if (!e.altKey) return false;
          return e.code === "Key" + letter.toUpperCase();
        }
        const digit = getAltDigit(e);
        if ((digit >= 1 && digit <= 9) || isAltKey(e, "h") || isAltKey(e, "l") || isAltKey(e, "j") || isAltKey(e, "k") || isAltKey(e, "t")) {
          if (e.type === "keydown") {
            if (isAltKey(e, "t")) { e.preventDefault(); createShellTab(); }
            else if (isAltKey(e, "h")) { e.preventDefault(); cycleAgent(-1); }
            else if (isAltKey(e, "l")) { e.preventDefault(); cycleAgent(1); }
            else if (isAltKey(e, "j")) { e.preventDefault(); cycleTab(-1); }
            else if (isAltKey(e, "k")) { e.preventDefault(); cycleTab(1); }
            else if (digit >= 1 && digit <= 9) {
              e.preventDefault();
              const ordered = getDisplayOrder();
              const idx = digit - 1;
              if (idx < ordered.length) switchSession(ordered[idx].id);
            }
          }
          return false;
        }
        return true;
      });

      shellInstances.set(key, { term: shellTerm, fitAddon: shellFitAddon, ws: shellWs, container, resizeObserver: ro, shellName });
    }
  }
}

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
    menu.innerHTML = [
      menuItem("Deck Layout", "", { submenu: groupBySub }),
      menuItem("Agent Sorting", "", { submenu: sortSub }),
      menuItem("Theme", "", { submenu: themeSub }),
      menuItem("Notifications", "", { submenu: notifySub }),
      '<div class="menu-dropdown-sep"></div>',
      menuItem("Toggle Preview", "toggle-preview", { shortcut: `${mod}+Shift+V` }),
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
  } else if (action === "toggle-preview") {
    const mdContainer = document.querySelector("[data-md-raw]");
    if (mdContainer) toggleEditMode(mdContainer);
  } else if (action === "new-agent") {
    const groups = getSessionGroups().filter(g => (groupConfig[g.label] || {}).expandable !== false);
    if (groups.length > 0) showAddPopover({ clientX: 200, clientY: 60, preventDefault() {} }, groups[0].label);
  } else if (action === "new-group") {
    const name = prompt("Group name:");
    if (name && name.trim()) {
      if (!workspaceGroups) workspaceGroups = [];
      workspaceGroups.push(name.trim());
      saveWorkspaceGroups(workspaceGroups);
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
