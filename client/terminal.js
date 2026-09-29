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

// OSC 52 clipboard write — a program in the pane (e.g. Claude Code's `/copy`,
// vim's "+y) emits `ESC ] 52 ; <sel> ; <base64> BEL`; tmux forwards it out (it
// thinks the terminal supports clipboard — see the terminal-features knob set
// server-side). xterm.js has no built-in OSC 52 handler, so without this the
// sequence reaches the browser and is silently dropped — `/copy` "did nothing".
// Reuses copyTextToClipboard (artifacts.js) so plain-http Tailscale gets the
// execCommand fallback. Read requests (`?`) are ignored — never hand the page's
// clipboard back to a remote pane.
function registerClipboardOsc(t) {
  t.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(";");
    const payload = sep === -1 ? data : data.slice(sep + 1);
    if (!payload || payload === "?") return true;
    let text;
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    } catch { return true; }
    if (typeof copyTextToClipboard === "function") copyTextToClipboard(text).catch(() => {});
    return true; // handled — swallow the sequence so it never prints
  });
}

// ═══ CLICKABLE FILE PATHS ═══
// When an agent prints a file path, let the user click it to open the file as an
// artifact tab ON THE CURRENT AGENT (no session/agent switch) — closing the
// "agent produced X → inspect X now" loop. We register an xterm link provider
// (separate from the URL web-links addon, which still owns http(s) links) that
// matches path-ish tokens per line, then asks the server whether each token
// resolves to a real file *relative to the pane's cwd* before lighting it up —
// so we never underline a token that wouldn't open. Resolution is cached per
// (session, raw token) to avoid hammering /api/resolve-path on every re-render.
//
// Matcher is deliberately conservative: a token must look like a path (contain a
// "/" or start with ./ ~/ , and have a file-ish final segment with an extension)
// to even be a candidate; the server resolve is the real gate. This keeps prose,
// flags, and URLs from turning into false-positive links.
const PATH_TOKEN_RE = /(?:~\/|\.\/|\.\.\/|\/)?(?:[\w.\-@+]+\/)*[\w.\-@+]+\.[A-Za-z0-9]{1,8}/g;
const _pathResolveCache = new Map(); // "sessionId\u0000rawToken" -> Promise<string|null>

function looksLikePath(token) {
  if (!token) return false;
  if (/^https?:\/\//.test(token)) return false; // URLs belong to the web-links addon
  // Must reference a directory traversal or be an explicit root/home/relative path,
  // and end in a file-ish segment (has an extension). Bare "v1.2" or "3.14" won't
  // have a slash and won't pass unless they also carry a dir separator.
  const hasSep = token.includes("/");
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(token);
  if (!hasExt) return false;
  if (!hasSep && !/^(~|\.)/.test(token)) {
    // No separator and not anchored — only allow a plain "name.ext" (cwd-relative file)
    // if it has a sensible-looking extension; the server still gates existence.
    return /^[\w.\-@+]+\.[A-Za-z0-9]{1,8}$/.test(token);
  }
  return true;
}

function resolveTerminalPath(sessionId, raw) {
  const key = `${sessionId}\u0000${raw}`;
  if (_pathResolveCache.has(key)) return _pathResolveCache.get(key);
  const p = fetch(`/api/resolve-path?session=${encodeURIComponent(sessionId || "")}&path=${encodeURIComponent(raw)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.path ? d.path : null))
    .catch(() => null);
  _pathResolveCache.set(key, p);
  return p;
}

// Open a resolved file path as an artifact tab on the current agent. Mirrors the
// existing "open a related agent's artifact here" path (app.js): de-dupe against
// the agent's artifacts by value, switch if already open, else addArtifact (which
// persists + switches). We match that persist-on-open behavior rather than invent
// a parallel transient-tab renderer.
async function openPathAsArtifact(absPath) {
  if (typeof sessions === "undefined" || typeof activeSessionId === "undefined") return;
  const s = sessions.find((x) => x.id === activeSessionId);
  if (!s) return;
  const existingIdx = (s.artifacts || []).findIndex((a) => a.value === absPath);
  if (existingIdx >= 0) {
    switchTab(`artifact:${existingIdx}`);
  } else if (typeof addArtifact === "function") {
    await addArtifact("file", absPath, absPath.split("/").pop());
  }
}

// getSessionId: () => sessionId for THIS terminal instance (main term tracks the
// active agent; shell terminals are bound to the agent they were created under).
function registerPathLinks(t, getSessionId) {
  t.registerLinkProvider({
    provideLinks(lineIndex, cb) {
      const sessionId = getSessionId();
      // Reconstruct the (possibly wrapped) logical line's text for this row.
      const line = t.buffer.active.getLine(lineIndex);
      if (!line) { cb(undefined); return; }
      const text = line.translateToString(true);
      if (!text) { cb(undefined); return; }

      const candidates = [];
      let m;
      PATH_TOKEN_RE.lastIndex = 0;
      while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
        const raw = m[0];
        if (!looksLikePath(raw)) continue;
        candidates.push({ raw, start: m.index, end: m.index + raw.length });
      }
      if (!candidates.length) { cb(undefined); return; }

      // Resolve all candidates server-side; only surface those that exist as files.
      Promise.all(candidates.map((c) => resolveTerminalPath(sessionId, c.raw)))
        .then((resolved) => {
          const links = [];
          for (let i = 0; i < candidates.length; i++) {
            const abs = resolved[i];
            if (!abs) continue;
            const c = candidates[i];
            links.push({
              // xterm ranges are 1-based, end inclusive.
              range: {
                start: { x: c.start + 1, y: lineIndex + 1 },
                end: { x: c.end, y: lineIndex + 1 },
              },
              text: c.raw,
              activate: () => { openPathAsArtifact(abs); },
            });
          }
          cb(links.length ? links : undefined);
        })
        .catch(() => cb(undefined));
    },
  });
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
  registerClipboardOsc(term);
  registerPathLinks(term, () => activeSessionId);

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
// "&cols=N&rows=N" so the pty is spawned at the terminal's current size (a
// never-fitted xterm reports its 80x24 constructor default, which is also the
// server's fallback). This only removes the resize detour when the size is
// right at connect time: same-layout agent switches and reconnects. A switch
// that changes layout (tabs → vsplit) still sends the outgoing layout's size
// and corrects with one resize, as before.
function wsSizeParam(t) {
  if (!t || !(t.cols >= 10) || !(t.rows >= 5)) return "";
  return `&cols=${t.cols}&rows=${t.rows}`;
}

function connectWs(sessionId) {
  if (!sessionId) {
    // Empty workspace: nothing to attach to. (Used to open /ws?session=null,
    // which the server minted as an agent literally named "null".)
    const st = document.getElementById("status");
    if (st) st.textContent = "no agents";
    return;
  }
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
  // The pty is spawned at this size (server clamps it), so tmux attaches at the
  // size the window most likely already has instead of 80x24 → resize: with
  // window-size smallest that detour shrank the window to 80x24 and back, and
  // the program in the pane (Claude Code on a long session: seconds) had to
  // re-render twice before the screen settled after every agent switch.
  ws = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(sessionId)}${wsTokenParam()}${wsSizeParam(term)}`);

  const statusEl = document.getElementById("status");

  let openedAt = 0;
  ws.onopen = () => {
    openedAt = Date.now();
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

  ws.onclose = (ev) => {
    if (ev && ev.code === WS_CLOSE_AGENT_GONE) {
      // The server refused: this agent is archived or gone. Reconnecting would
      // only be refused again (and, before the server refused, minted a blank
      // agent in its place) — leave the terminal showing the server's message.
      if (statusEl) statusEl.textContent = ev.reason === "archived" ? "agent archived" : "agent not found";
      return;
    }
    if (statusEl) statusEl.textContent = "disconnected - reconnecting...";
    scheduleReconnect(sessionId, openedAt);
  };

  ws.onerror = () => { ws.close(); };
}

// 1 s, doubling to 4 s while the server stays down (a restart is ~1 s, so the
// first retry usually lands; a dashboard with many shell tabs retries once per
// tab, so the cap keeps that from becoming a hammer, while staying short enough
// that a tab is back within seconds of the server). The delay resets only after
// a connection stayed open for a while — a socket the server accepts and closes
// at once (agent cwd gone, pty exits) must keep backing off, not spawn a pty per
// second. Returning to the tab / coming back online drops the delay back to 1 s.
const RECONNECT_MIN_MS = 1000, RECONNECT_MAX_MS = 4000, RECONNECT_STABLE_MS = 5000;
const WS_CLOSE_AGENT_GONE = 4404;   // server/index.js: no such live agent (archived or unknown)
let reconnectDelay = RECONNECT_MIN_MS;
const wasStable = (openedAt) => openedAt && Date.now() - openedAt >= RECONNECT_STABLE_MS;
function scheduleReconnect(sessionId, openedAt) {
  if (reconnectTimer) return;
  const delay = wasStable(openedAt) ? RECONNECT_MIN_MS : reconnectDelay;
  reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs(sessionId);
  }, delay);
}
function retryReconnectsNow() {
  reconnectDelay = RECONNECT_MIN_MS;
  for (const inst of shellInstances.values()) inst.reconnectDelay = RECONNECT_MIN_MS;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) retryReconnectsNow(); });
window.addEventListener("online", retryReconnectsNow);

// ═══ SHELL TABS ═══
function createShellTab() {
  if (!activeSessionId) return;
  if (!openTabsPerSession[activeSessionId]) openTabsPerSession[activeSessionId] = new Set();
  const open = openTabsPerSession[activeSessionId];

  // Find next available shell number
  let n = 1;
  while (open.has(`shell:${n}`)) n++;
  const shellId = `shell:${n}`;
  open.add(shellId);

  // Show the tab first so the xterm is fitted before its WS opens — the pty
  // then starts at the real size instead of 80x24 + a resize.
  const inst = makeShellInstance(activeSessionId, shellId, `sh${n}`, { connect: false });
  switchTab(shellId);
  connectShellWs(inst, activeSessionId, shellId);
}

// One shell tab: xterm + container + its WebSocket. Shared by createShellTab
// (a new tab) and restoreShellTabs (tabs remembered in the UI state on reload) —
// the two used to be copies, and only the primary terminal had reconnect logic.
function makeShellInstance(sid, shellId, shellName, { connect = true } = {}) {
  const key = `${sid}:${shellId}`;

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
  registerClipboardOsc(shellTerm);
  registerPathLinks(shellTerm, () => sid);

  const container = document.createElement("div");
  container.className = "shell-container";
  container.dataset.shellKey = key;
  document.getElementById("ws-content").appendChild(container);

  shellTerm.open(container);

  const inst = { term: shellTerm, fitAddon: shellFitAddon, ws: null, container, resizeObserver: null, shellName, reconnectTimer: null, reconnectDelay: RECONNECT_MIN_MS };
  shellInstances.set(key, inst);

  shellTerm.onData((data) => {
    if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  const ro = new ResizeObserver(() => {
    if (container.offsetWidth < 50 || container.offsetHeight < 50) return;
    if (!container.classList.contains("active")) return;
    shellFitAddon.fit();
    if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: "resize", cols: shellTerm.cols, rows: shellTerm.rows }));
    }
  });
  ro.observe(container);
  inst.resizeObserver = ro;

  // Global shortcuts still work while a shell tab has focus
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
    // Alt+N (next agent that needs me) is only kept away from the shell here;
    // the document-level handler in app.js acts on it (this handler does not
    // mark the event handled, so adding a branch here would fire it twice).
    if ((digit >= 1 && digit <= 9) || isAltKey(e, "h") || isAltKey(e, "l") || isAltKey(e, "j") || isAltKey(e, "k") || isAltKey(e, "t") || isAltKey(e, "n")) {
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

  if (connect) connectShellWs(inst, sid, shellId);
  return inst;
}

// Connect (or reconnect) a shell tab's WebSocket. The tmux session behind a
// shell tab survives a server restart, but the WS does not — and until this
// existed a closed shell WS was simply left dead: the tab kept showing its last
// screen and swallowed every keystroke until a full page reload (the primary
// terminal reconnected all along). Same backoff as scheduleReconnect; stops
// the moment closeShellTab/closeSession removes the instance. Note the server
// recreates a missing shell tmux session on attach, so typing `exit` in a shell
// tab respawns the shell (with a cleared screen) rather than leaving a dead tab;
// close the tab with its ✕.
function connectShellWs(inst, sid, shellId) {
  const key = `${sid}:${shellId}`;
  if (inst.reconnectTimer) { clearTimeout(inst.reconnectTimer); inst.reconnectTimer = null; }
  if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close(); } catch {} inst.ws = null; }

  // A hidden tab has no real size yet; fit first when it is visible so the pty
  // starts at the right size (see connectWs).
  if (inst.container.classList.contains("active") && inst.container.offsetWidth >= 50) {
    try { inst.fitAddon.fit(); } catch {}
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const shellWs = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(sid)}&shell=${encodeURIComponent(inst.shellName)}${wsTokenParam()}${wsSizeParam(inst.term)}`);
  inst.ws = shellWs;

  let openedAt = 0;
  shellWs.onopen = () => {
    openedAt = Date.now();
    requestAnimationFrame(() => {
      if (inst.container.classList.contains("active")) inst.fitAddon.fit();
      if (shellWs.readyState === WebSocket.OPEN) {
        shellWs.send(JSON.stringify({ type: "resize", cols: inst.term.cols, rows: inst.term.rows }));
      }
    });
  };

  shellWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") inst.term.write(msg.data);
    } catch {
      inst.term.write(event.data);
    }
  };

  shellWs.onclose = (ev) => {
    if (inst.ws !== shellWs) return;          // superseded by a newer connection
    if (shellInstances.get(key) !== inst) return;  // tab was closed
    if (ev && ev.code === WS_CLOSE_AGENT_GONE) return;  // agent archived/gone: server said stop (see connectWs)
    if (inst.reconnectTimer) return;
    const delay = wasStable(openedAt) ? RECONNECT_MIN_MS : inst.reconnectDelay;
    inst.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    inst.reconnectTimer = setTimeout(() => {
      inst.reconnectTimer = null;
      if (shellInstances.get(key) !== inst) return;
      inst.term.reset();   // tmux repaints the whole screen on attach
      connectShellWs(inst, sid, shellId);
    }, delay);
  };
  shellWs.onerror = () => { shellWs.close(); };
}

function closeShellTab(shellId) {
  const key = `${activeSessionId}:${shellId}`;
  const shell = shellInstances.get(key);
  if (shell) {
    shellInstances.delete(key);   // first: a close event arriving below must not schedule a reconnect
    if (shell.reconnectTimer) clearTimeout(shell.reconnectTimer);
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
      if (shellInstances.has(`${sid}:${tabId}`)) continue;
      makeShellInstance(sid, tabId, `sh${n}`);
    }
  }
}
