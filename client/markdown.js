// ═══ MARKDOWN / HTML RENDERING + IN-PLACE EDITOR ═══ — extracted from app.js (classic <script>, before app.js).
// Holds markdown/HTML artifact preview + the Edit-mode editors: built-in textarea (default,
// openTextEditor) and opt-in vim (openVimEditor/closeVimEditor/activeEditors), routed by the
// "hadron-editor" localStorage pref (editorPref). Reads app.js helpers (esc, getLanguageFromPath,
// activeSessionId, wsTokenParam) and CDN globals (marked, hljs, Terminal, FitAddon) at call time.
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

// ── Editor preference (View ▸ Editor) ──
// "text" (default): built-in plain textarea. "vim": terminal vim in a throwaway tmux session.
function editorPref() {
  try { return localStorage.getItem("hadron-editor") === "vim" ? "vim" : "text"; }
  catch { return "text"; }
}
function setEditorPref(mode) {
  try { localStorage.setItem("hadron-editor", mode); } catch {}
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
    if (editorPref() === "vim") openVimEditor(container, filePath);
    else openTextEditor(container, filePath);
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

// ── Built-in plain-textarea editor ── (default Edit mode; vim is opt-in via View ▸ Editor).
// Fetches the file fresh at open time, saves via POST /api/file (auth header added by the
// app.js fetch patch), and syncs the artifact mtime bookkeeping after a save so the
// auto-reload poller doesn't treat our own write as an external change and clobber the pane.
function openTextEditor(container, filePath, showToggle = true) {
  const macKey = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';

  if (showToggle) {
    container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Editing <span class="md-toggle-key">${macKey}+Shift+V</span></div>`;
  } else {
    container.innerHTML = "";
  }

  const bar = document.createElement("div");
  bar.className = "text-editor-bar" + (showToggle ? "" : " no-toggle");
  bar.innerHTML = `<span class="text-editor-status"></span><div class="text-editor-save" title="Save file">Save <span class="md-toggle-key">${macKey}+S</span></div>`;
  container.appendChild(bar);

  const wrap = document.createElement("div");
  wrap.className = "text-editor-wrap";
  const ta = document.createElement("textarea");
  ta.className = "text-edit-area";
  ta.spellcheck = false;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocapitalize", "off");
  ta.disabled = true;
  wrap.appendChild(ta);
  container.appendChild(wrap);

  const status = bar.querySelector(".text-editor-status");
  const saveBtn = bar.querySelector(".text-editor-save");
  const saveBtnHtml = saveBtn.innerHTML;

  // Always fetch fresh content at open time — the preview text may be stale.
  fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
    .then((r) => r.ok ? r.text() : Promise.reject(new Error("could not load file")))
    .then((text) => {
      ta.value = text;
      ta.disabled = false;
      ta.dataset.dirty = "0";
      ta.focus();
    })
    .catch(() => { status.textContent = "Could not load file"; });

  ta.addEventListener("input", () => { ta.dataset.dirty = "1"; });

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      // Tab inserts two spaces instead of moving focus
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      ta.dataset.dirty = "1";
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveTextEditor();
    }
  });

  let savedTimer = null;
  function saveTextEditor() {
    if (ta.disabled) return;
    const content = ta.value;
    status.textContent = "";
    fetch(`/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content }),
    })
      .then((r) => r.ok ? r : r.json().catch(() => ({})).then((j) => Promise.reject(new Error(j.error || `save failed (${r.status})`))))
      .then((r) => {
        ta.dataset.dirty = "0";
        if (container.dataset.mdRaw !== undefined) container.dataset.mdRaw = content;
        // Sync mtime bookkeeping: pre-set the poller baseline + cache entry to our
        // own write's mtime so neither treats it as an external change (same trick
        // as the CSV editor's save).
        const newMtime = r.headers.get("X-File-Mtime");
        if (newMtime) {
          try {
            if (typeof artifactLastMtime !== "undefined") artifactLastMtime = newMtime;
            const key = container.dataset.cacheKey;
            const entry = key && typeof artifactCache !== "undefined" ? artifactCache.get(key) : null;
            if (entry) entry.mtime = newMtime;
          } catch {}
        }
        saveBtn.innerHTML = "Saved ✓";
        saveBtn.classList.add("saved");
        if (savedTimer) clearTimeout(savedTimer);
        savedTimer = setTimeout(() => {
          saveBtn.innerHTML = saveBtnHtml;
          saveBtn.classList.remove("saved");
        }, 1500);
      })
      .catch((e) => {
        // Keep the textarea content — the user's edits are not lost.
        status.textContent = e && e.message ? e.message : "Save failed";
      });
  }

  saveBtn.addEventListener("click", saveTextEditor);
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
