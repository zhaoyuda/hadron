// ═══ WEBSOCKET + TERMINAL LAYER ═══ — extracted from app.js (classic <script>, loaded before app.js).
// Owns the xterm.js lifecycle (primary terminal + per-session shell tabs) and the
// /ws plumbing: connect/teardown, reconnect, resize, input/output message send/receive.
// Reads app.js globals (activeSessionId, activeTab, openTabsPerSession) and helpers
// (wsTokenParam, switchTab, switchSession, cycleAgent, cycleTab, getDisplayOrder,
// renderWorkHeader, renderWorkContent, saveUIState) at call time only — no load-order TDZ.
// CDN globals: Terminal, FitAddon, WebLinksAddon (xterm script tags load first).

// ═══ STATE ═══
let ws = null;
let reconnectTimer = null;
let term = null;
let fitAddon = null;
// Map of "<sessionId>:<shellId>" -> { term, fitAddon, ws, container, resizeObserver }
let shellInstances = new Map();

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
