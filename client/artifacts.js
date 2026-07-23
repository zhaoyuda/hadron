// ═══ ARTIFACT PANE ═══ — extracted from app.js (classic <script>, loaded before app.js).
// Owns the artifact-pane subsystem: the persistent artifact cache + offscreen pool,
// renderArtifactView and its renderers (CSV table, code/SQL syntax views, marimo and
// jupyter notebooks), split-pane artifact panes (renderPaneContent), mtime auto-reload
// polling, copy/download action buttons, the artifact tab context menu, the
// add-artifact popover, and artifact add/remove against the sessions API.
// Seam — reads app.js globals (sessions, activeSessionId, activeTab, openTabsPerSession)
// and helpers (esc, render, renderWorkHeader, switchTab, closeTab, saveSplitNotes,
// hideAddPopover, armPopoverDismiss, clampPopover) at call time only — no load-order TDZ.
// Seam — app.js calls in: stashArtifacts/showArtifactInContainer/renderPaneContent/
// startArtifactMtimePolling (renderWorkContent), stopArtifactServer (closeTab),
// stopAllArtifactServers (closeSession), reloadCurrentArtifact (Ctrl+Shift+R),
// showArtifactTabContextMenu (tab right-click), removeArtifact/showArtifactPopover/
// addArtifact (right panel). markdown.js reads/writes artifactCache (typeof-guarded);
// markdown.js/data-preview.js/file-icons.js helpers (isHTMLFile,
// renderHTMLArtifact, openVimEditor, csvStatsHTML, nbErrorBannerHTML, fileExtIcon,
// folderIcon, noteMarimoNotebook, ...) are called at runtime — those files load first.


// ═══ ARTIFACT CACHE + PANES ═══
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

// Tab id → artifact descriptor. `artifact:N` indexes the session's artifacts array;
// `file:<abs path>` is an ephemeral viewer tab (dir-artifact children) — same
// rendering pipeline, no artifacts-array entry.
function artFromTabId(session, tabId) {
  if (typeof tabId !== "string") return null;
  if (tabId.startsWith("artifact:")) {
    const idx = parseInt(tabId.split(":")[1]);
    return session?.artifacts?.[idx] || null;
  }
  if (tabId.startsWith("file:")) return { type: "file", value: tabId.slice(5) };
  return null;
}

function isViewerTab(tabId) {
  return typeof tabId === "string" && (tabId.startsWith("artifact:") || tabId.startsWith("file:"));
}

async function showArtifactInContainer(container, session, tabId) {
  const art = artFromTabId(session, tabId);
  if (!art) return;

  const key = `${session.id}:${tabId}`;
  container.style.display = "block";
  container.classList.add("active");
  ensureArtifactCloseButton(container);

  // Hide all children first, then show the right one (keep the corner close button)
  for (const child of container.children) {
    if (child.id === "artifact-close-btn") continue;
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

// Corner close button — closing the current file from the pane itself is the
// natural gesture while reading/editing (the tab-bar × is far away). One
// persistent element per container; closes the ACTIVE artifact tab.
function ensureArtifactCloseButton(container) {
  let btn = container.querySelector("#artifact-close-btn");
  if (!btn) {
    btn = document.createElement("div");
    btn.id = "artifact-close-btn";
    btn.title = "Close file";
    btn.textContent = "×";
    btn.addEventListener("click", () => {
      if (isViewerTab(activeTab) && typeof closeTab === "function") {
        closeTab(activeTab);
      }
    });
    container.appendChild(btn);
  }
  btn.style.display = "flex";
}

function stopArtifactServer(session, tabId) {
  const art = artFromTabId(session, tabId);
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
  if (!isViewerTab(activeTab)) return;
  // Don't yank the rug out from under someone mid-edit in the CSV textarea.
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains("csv-edit-area")) return;
  // Same for the built-in text editor: focused, or open with unsaved changes.
  if (ae && ae.classList && ae.classList.contains("text-edit-area")) return;
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return;
  const key = `${session.id}:${activeTab}`;
  const cached = artifactCache.get(key);
  if (cached?.el?.querySelector?.('.text-edit-area[data-dirty="1"]')) return;
  if (cached?.hasIframe) return;
  // Static HTML file: reload the iframe in-place with a fresh cache-buster
  // (keep the cache entry; just refetch the new mtime and re-point src).
  if (cached?.htmlFile) {
    const art = artFromTabId(session, activeTab);
    if (art && cached.el) {
      reloadHTMLPaneFromDisk(cached.el, art.value, (m) => { cached.mtime = m; });
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

// Auto-reload: poll mtime for the active artifact tab + any split-pane HTML panes.
// The change baseline is always the mtime of the content ON SCREEN (cache/watch
// entry, set by the render that fetched it) — never the poller's own first HEAD.
// A first-tick baseline arrives up to 3s after render and silently swallows any
// disk write inside that window (the "stale HTML iframe" bug).
let artifactMtimePoller = null;
let htmlPaneWatches = []; // split-mode HTML panes: { el, path, mtime }

function startArtifactMtimePolling() {
  stopArtifactMtimePolling();
  if (typeof annotationsSyncPolling === "function") annotationsSyncPolling(); // annotations.js mirrors this lifecycle
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return;

  // Tab mode: the active file-based artifact (md/csv/notebooks silently
  // auto-reload; HTML gets an update pill — see the tick below).
  let tabTarget = null;
  if (isViewerTab(activeTab)) {
    const art = artFromTabId(session, activeTab);
    const key = `${session.id}:${activeTab}`;
    if (art?.type === "file" && !artifactCache.get(key)?.hasIframe) tabTarget = { art, key };
  }

  // Split mode: HTML panes render outside the artifact cache, so watch them
  // directly. Their iframe was just created from the current file — HEAD now to
  // record what's on screen as the baseline.
  htmlPaneWatches = Array.from(document.querySelectorAll(".split-pane[data-html-path]"))
    .map((el) => ({ el, path: el.dataset.htmlPath, mtime: null }));
  for (const w of htmlPaneWatches) {
    fetch(`/api/file?path=${encodeURIComponent(w.path)}`, { method: "HEAD" })
      .then((r) => { if (r.ok && w.mtime === null) w.mtime = r.headers.get("X-File-Mtime"); })
      .catch(() => {});
  }

  if (!tabTarget && htmlPaneWatches.length === 0) return;

  artifactMtimePoller = setInterval(async () => {
    if (tabTarget) {
      try {
        const r = await fetch(`/api/file?path=${encodeURIComponent(tabTarget.art.value)}`, { method: "HEAD" });
        const mtime = r.headers.get("X-File-Mtime");
        const cached = artifactCache.get(tabTarget.key);
        // cached.mtime null = initial render still in flight (it will paint the
        // latest content anyway — nothing to compare against yet).
        if (cached?.mtime && mtime && mtime !== cached.mtime) {
          if (cached.htmlFile) {
            // Live iframe: a silent reload destroys its state (scroll, form
            // input, JS app state) — offer a reload instead of forcing one.
            showArtifactUpdatePill(cached.el, () =>
              reloadHTMLPaneFromDisk(cached.el, tabTarget.art.value, (m) => { cached.mtime = m; }));
          } else {
            reloadCurrentArtifact();
          }
        }
      } catch {}
    }
    for (const w of htmlPaneWatches) {
      if (!w.el.isConnected || w.mtime === null) continue;
      try {
        const r = await fetch(`/api/file?path=${encodeURIComponent(w.path)}`, { method: "HEAD" });
        const mtime = r.headers.get("X-File-Mtime");
        if (mtime && mtime !== w.mtime) {
          showArtifactUpdatePill(w.el, () =>
            reloadHTMLPaneFromDisk(w.el, w.path, (m) => { w.mtime = m; }));
        }
      } catch {}
    }
  }, 3000);
}

function stopArtifactMtimePolling() {
  if (artifactMtimePoller) { clearInterval(artifactMtimePoller); artifactMtimePoller = null; }
  htmlPaneWatches = [];
}

// "File updated" pill on a live HTML iframe. Idempotent — one pill per pane;
// stays until clicked (the underlying file may keep changing; the click always
// loads whatever is newest).
function showArtifactUpdatePill(container, onReload) {
  if (!container || container.querySelector(".artifact-update-pill")) return;
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "artifact-update-pill";
  pill.innerHTML = `File updated <span class="aup-action">↻ Reload</span>`;
  pill.addEventListener("click", () => { pill.remove(); onReload(); });
  container.appendChild(pill);
}

// HEAD for the current mtime, then re-point the pane's iframe at it.
function reloadHTMLPaneFromDisk(el, filePath, onMtime) {
  fetch(`/api/file?path=${encodeURIComponent(filePath)}`, { method: "HEAD" })
    .then((r) => (r.ok ? r.headers.get("X-File-Mtime") : null))
    .catch(() => null)
    .then((mtime) => {
      if (reloadHTMLIframe(el, filePath, mtime) && onMtime) onMtime(mtime);
    });
}

function renderPaneContent(pane, tabId, session) {
  if (tabId === "notes") {
    const noteVal = session?.notes || "";
    pane.innerHTML = `<textarea class="split-pane-notes" placeholder="Write notes here..." oninput="saveSplitNotes()">${esc(noteVal)}</textarea>`;
  } else if (isViewerTab(tabId)) {
    // Try cache first for split pane artifacts too (only iframe-based)
    const key = `${session.id}:${tabId}`;
    const cached = artifactCache.get(key);
    if (cached?.hasIframe) {
      pane.appendChild(cached.el);
      cached.el.style.display = "block";
      return;
    }
    const art = artFromTabId(session, tabId);
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
              if (editorPref() === "vim") openVimEditor(pane, art.value, false);
              else openTextEditor(pane, art.value, false);
            }
          })
          .catch(() => { pane.innerHTML = `<div class="artifact-file-error">Could not load file</div>`; });
      }
    }
  }
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

function renderCSVTable(container, text, filePath, fileRev) {
  let raw = text;
  let baseRev = fileRev; // revision the edit buffer is based on (conditional saves)
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
        // Leaving edit mode: carry the textarea's current text into the working
        // buffer so Preview reflects in-progress edits (Save persists to disk).
        if (mode === "edit") {
          const ta = container.querySelector('.csv-edit-area');
          if (ta) raw = ta.value;
        }
        mode = next;
        setArtifactModePref("csv", mode);
        render();
      });
    });
  }

  function renderEdit() {
    container.innerHTML = `<div class="csv-root">`
      + toggleBar("edit")
      + `<div class="csv-edit-wrap">`
      + `<textarea class="csv-edit-area" spellcheck="false">${esc(raw)}</textarea>`
      + `<div class="csv-edit-bar">`
      + `<span class="csv-edit-status"></span>`
      + `<button class="csv-edit-save">Save <span class="md-toggle-key">${macKey}+S</span></button>`
      + `</div></div></div>`;
    wireToggle();
    const ta = container.querySelector('.csv-edit-area');
    const status = container.querySelector('.csv-edit-status');
    const saveBtn = container.querySelector('.csv-edit-save');

    // Conditional save — same contract as the text editor (codex QA P0-3: the
    // CSV path used to be an unconditional write that silently clobbered
    // agent edits). Draft persistence for CSV is still P1; this closes the
    // silent-overwrite half.
    function save(revOverride) {
      const content = ta.value;
      status.textContent = "Saving…";
      saveBtn.disabled = true;
      fetch(`/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content, ...(revOverride || baseRev ? { baseRevision: revOverride || baseRev } : {}) }),
      })
        .then((r) => {
          if (r.ok) return r;
          if (r.status === 409) {
            return r.json().then((j) => {
              if (j.currentContent === content) return { idempotent: true, rev: j.currentRevision };
              status.textContent = "";
              if (typeof showSaveConflictDialog === "function") {
                showSaveConflictDialog({
                  filePath, container,
                  draftContent: content,
                  diskContent: j.currentContent,
                  onOverwrite: () => save(j.currentRevision),
                  onDismiss: () => { status.textContent = "Conflict — not saved"; },
                });
              } else {
                status.textContent = "File changed on disk — reopen to reload";
              }
              return Promise.reject({ handled: true });
            });
          }
          return Promise.reject();
        })
        .then((r) => {
          raw = content;
          status.textContent = "Saved";
          if (r.idempotent) { baseRev = r.rev; }
          else {
            baseRev = r.headers.get("X-File-Revision") || baseRev;
            // Pre-set the cache entry's mtime (the poller's baseline) to our own
            // write so it doesn't fire a reload that would rebuild the textarea
            // out from under the user.
            const newMtime = r.headers.get("X-File-Mtime");
            const cacheKey = ta.closest("[data-cache-key]")?.dataset.cacheKey;
            const entry = cacheKey ? artifactCache.get(cacheKey) : null;
            if (newMtime && entry) entry.mtime = newMtime;
          }
          setTimeout(() => { if (status.textContent === "Saved") status.textContent = ""; }, 1500);
        })
        .catch((e) => { if (!e || !e.handled) status.textContent = "Save failed"; })
        .finally(() => { saveBtn.disabled = false; });
    }

    saveBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the textarea
    saveBtn.addEventListener('click', () => save());
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
      container.innerHTML = `<div class="csv-root">` + toggleBar("preview") + `<pre class="artifact-code">${esc(raw)}</pre>` + `</div>`;
      wireToggle();
      return;
    }

    let sortCol = -1;
    let sortAsc = true;
    let sortedRows = rows.slice();

    // Data-aware strip (data-preview.js): computed once per parse, not per sort.
    const statsHtml = csvStatsHTML(computeCSVStats(headers, rows));

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

      container.innerHTML = `<div class="csv-root">`
        + toggleBar("preview")
        + statsHtml
        + `<div class="csv-table-wrapper">`
        + `<table class="csv-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`
        + `</div>`
        + `<div class="csv-footer">${sortedRows.length} row${sortedRows.length !== 1 ? 's' : ''}</div>`
        + `</div>`;
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

// ═══ ARTIFACT ACTIONS (Copy / Download) ═══

/**
 * Copy text to clipboard. Uses navigator.clipboard when available (secure
 * contexts: localhost, HTTPS). Falls back to the hidden-textarea +
 * execCommand("copy") trick for plain-http Tailscale access.
 */
function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback: textarea trick
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error("execCommand copy failed"));
    } catch (e) {
      document.body.removeChild(ta);
      reject(e);
    }
  });
}

/**
 * Inject Copy + Download action buttons into an artifact container.
 * textFn: () => string  — returns the text to copy/download (called lazily).
 * filename: string      — suggested download filename.
 * Buttons live top-right, matching the .md-toggle chip style.
 */
function addArtifactActionButtons(container, textFn, filename) {
  // Remove any previously injected buttons
  const old = container.querySelector(".artifact-actions");
  if (old) old.remove();

  const actions = document.createElement("div");
  actions.className = "artifact-actions";

  const copyBtn = document.createElement("div");
  copyBtn.className = "artifact-action-btn";
  copyBtn.textContent = "Copy";
  copyBtn.title = "Copy file contents to clipboard";
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = textFn();
    copyTextToClipboard(text).then(() => {
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("copied");
      }, 1500);
    }).catch(() => {
      copyBtn.textContent = "Failed";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
  });

  const dlBtn = document.createElement("div");
  dlBtn.className = "artifact-action-btn";
  dlBtn.textContent = "Download";
  dlBtn.title = "Download file";
  dlBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = textFn();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  actions.appendChild(copyBtn);
  actions.appendChild(dlBtn);
  container.style.position = "relative";
  container.appendChild(actions);
}

// ═══ ARTIFACT TAB CONTEXT MENU ═══

let _artCtxDismiss = null;

function showArtifactTabContextMenu(e, tab) {
  e.preventDefault();
  e.stopPropagation();

  // Close any open context menu
  const menu = document.getElementById("artifact-tab-ctx-menu");
  if (_artCtxDismiss) { _artCtxDismiss(); _artCtxDismiss = null; }

  const isFile = tab.type !== "url";
  const filePath = tab.value;
  const filename = filePath ? filePath.split("/").pop() : "download";

  let items = [];
  if (isFile) {
    items = [
      { label: "Copy contents", action: "copy-contents" },
      { label: "Copy path",     action: "copy-path" },
      { label: "Download",      action: "download" },
    ];
  } else {
    items = [
      { label: "Copy URL", action: "copy-path" },
    ];
  }

  menu.innerHTML = items.map((it) =>
    `<div class="art-ctx-item" data-action="${it.action}">${it.label}</div>`
  ).join("");

  // Position near cursor
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - (items.length * 30 + 16));
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.display = "block";

  menu.querySelectorAll(".art-ctx-item").forEach((item) => {
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const action = item.dataset.action;
      if (action === "copy-path") {
        copyTextToClipboard(filePath).catch(() => {});
      } else if (action === "copy-contents") {
        fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
          .then((r) => r.ok ? r.text() : Promise.reject())
          .then((text) => copyTextToClipboard(text))
          .catch(() => {});
      } else if (action === "download") {
        fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
          .then((r) => r.ok ? r.text() : Promise.reject())
          .then((text) => {
            const blob = new Blob([text], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          })
          .catch(() => {});
      }
      dismiss();
    });
  });

  function dismiss() {
    menu.style.display = "none";
    document.removeEventListener("click", onOutside);
    document.removeEventListener("keydown", onKey);
    _artCtxDismiss = null;
  }

  function onOutside(ev) {
    if (!menu.contains(ev.target)) dismiss();
  }
  function onKey(ev) {
    if (ev.key === "Escape") dismiss();
  }

  _artCtxDismiss = dismiss;
  // Defer so the current click event doesn't immediately close
  setTimeout(() => {
    document.addEventListener("click", onOutside);
    document.addEventListener("keydown", onKey);
  }, 0);
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
        const rev = r.headers.get("X-File-Revision");
        return r.text().then(text => ({ text, mtime, rev }));
      })
      .then(({ text, mtime, rev }) => {
        const isIframe = isMarimoNotebook(text, artifact.label || artifact.value);
        if (isMarimoNotebook(text, artifact.label || artifact.value)) {
          if (noteMarimoNotebook(artifact.value)) renderWorkHeader();
          renderMarimoNotebook(container, text, artifact.value);
        } else if (isCSVFile(artifact.value)) {
          renderCSVTable(container, text, artifact.value, rev);
          // CSV: inject actions; text captured in closure
          const captured = text;
          addArtifactActionButtons(container, () => captured, artifact.value.split("/").pop());
        } else if (isJupyterNotebook(artifact.value)) {
          // Static renders now, so it joins mtime polling immediately (disk
          // writes auto-reload it — that reload surfaces the changed-cell
          // badges); if the live server comes up, the swap re-reports the pane
          // as iframe, and re-running the poller drops it from the watch list.
          renderJupyterNotebook(container, text, artifact.value, () => {
            if (onMeta) onMeta(mtime, false);
            startArtifactMtimePolling();
          }, () => {
            if (onMeta) onMeta(mtime, true);
            startArtifactMtimePolling();
          });
        } else if (isMarkdownFile(artifact.value)) {
          renderMarkdownArtifact(container, text, artifact.value);
          // Markdown: inject actions; text may update on toggle, so re-read from dataset
          addArtifactActionButtons(
            container,
            () => container.dataset.mdRaw !== undefined ? container.dataset.mdRaw : text,
            artifact.value.split("/").pop()
          );
        } else {
          container.style.position = "relative";
          if (editorPref() === "vim") openVimEditor(container, artifact.value, false);
          else openTextEditor(container, artifact.value, false);
        }
        if (onMeta) onMeta(mtime, isIframe);
      })
      .catch(() => {
        container.innerHTML = `<div class="artifact-file-error">Could not load file: ${esc(artifact.value)}</div>`;
      });
  }
}

// ═══ REMOVE ARTIFACT ═══
// Atomic server-side: DELETE { index, value } under the same per-agent lock as
// append. 409 means the array drifted since this render (a concurrent CLI append /
// another tab's remove) — refetch and re-render so the next click operates on fresh
// indexes. Local state updates only from the 2xx response's returned array. No
// confirm dialog: this removes a reference, never the file.
async function removeArtifact(idx) {
  const sessionId = activeSessionId; // capture: completion may race a session switch
  const s = sessions.find((x) => x.id === sessionId);
  if (!s || !s.artifacts || !s.artifacts[idx]) return;
  const removed = s.artifacts[idx];
  const value = removed.value;
  let res;
  try {
    res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: idx, value }),
    });
  } catch { return; }
  if (res.status === 409) {
    await fetchSessions();
    render();
    return;
  }
  if (!res.ok) return;
  const j = await res.json();

  // ── local cleanup: tabs, splits, cache, mtime watches ──
  if (removed.type === "dir") {
    // Forget the group's toggle + listing cache: a future re-add of the same
    // folder must start from the default (collapsed), not the old override.
    collapsedArtFolders[sessionId]?.delete(`dirart:${value}`);
    dirArtCache.delete(`${sessionId}|${value}`);
  }
  const tabId = `artifact:${idx}`;
  // Stop marimo/jupyter for the removed artifact while the OLD array can still
  // resolve its index, then adopt the server's array as authoritative.
  stopArtifactServer(s, tabId);
  s.artifacts = j.artifacts || [];
  const open = openTabsPerSession[sessionId];
  if (open) {
    const newOpen = new Set();
    open.forEach((t) => {
      if (t.startsWith("artifact:")) {
        const ti = parseInt(t.split(":")[1]);
        if (ti < idx) newOpen.add(t);
        else if (ti > idx) newOpen.add(`artifact:${ti - 1}`);
      } else { newOpen.add(t); }
    });
    openTabsPerSession[sessionId] = newOpen;
  }
  // Artifact cache keys embed the index — entries at/after the removed slot would
  // show the wrong artifact after the splice; drop them (they re-render lazily).
  for (const [key, entry] of [...artifactCache]) {
    const m = key.match(/^(.+):artifact:(\d+)$/);
    if (!m || m[1] !== sessionId) continue;
    if (parseInt(m[2]) >= idx) {
      if (entry.el?._mtimePoller) clearInterval(entry.el._mtimePoller);
      if (entry.el?.parentNode) entry.el.parentNode.removeChild(entry.el);
      artifactCache.delete(key);
    }
  }
  if (sessionId === activeSessionId && typeof activeTab === "string" && activeTab.startsWith("artifact:")) {
    const ti = parseInt(activeTab.split(":")[1]);
    if (ti === idx) activeTab = "terminal";
    else if (ti > idx) activeTab = `artifact:${ti - 1}`;
  }
  render(); // rebuilds header/splits and restarts mtime polling for the new layout
  saveUIState();
}

// ═══ DIR ARTIFACTS (live folder groups) ═══
// Children of an EXPANDED dir artifact come from /api/files/browse. The artifacts
// panel already re-renders on the 3s deck cadence; dirArtChildren piggybacks on
// that — each render returns the cache and (at most once per cadence, per dir,
// never with a fetch already in flight) refreshes it, re-rendering the panel only
// when the listing actually changed. Collapsed groups never fetch.
const dirArtCache = new Map(); // "sid|dir" -> { entries, at, inflight, error }
const DIRART_FRESH_MS = 2500; // just under the 3s cadence → one fetch per tick

// Default collapsed unless the artifact carries `open: true`; the user's toggle is
// an override recorded in the existing collapsedArtFolders mechanism (per session).
function dirArtIsOpen(sid, art) {
  const toggled = (collapsedArtFolders[sid] || new Set()).has(`dirart:${art.value}`);
  return (art.open === true) !== toggled;
}

function toggleDirArtifact(sid, dir) {
  const set = (collapsedArtFolders[sid] ||= new Set());
  const key = `dirart:${dir}`;
  if (set.has(key)) set.delete(key); else set.add(key);
  renderRightPanel(); // expanding kicks off the child fetch via dirArtChildren
}

function dirArtChildren(sid, dir) {
  const key = `${sid}|${dir}`;
  let entry = dirArtCache.get(key);
  if (!entry) { entry = { entries: null, at: 0, inflight: false, error: false }; dirArtCache.set(key, entry); }
  if (!entry.inflight && Date.now() - entry.at > DIRART_FRESH_MS) {
    entry.inflight = true;
    fetch(`/api/files/browse?agentId=${encodeURIComponent(sid)}&path=${encodeURIComponent(wsRelativePath(dir))}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => {
        const changed = JSON.stringify(j.entries) !== JSON.stringify(entry.entries);
        entry.entries = j.entries;
        entry.error = false;
        if (changed && sid === activeSessionId) renderRightPanel();
      })
      .catch(() => {
        const hadError = entry.error;
        entry.error = true;
        entry.entries = null;
        if (!hadError && sid === activeSessionId) renderRightPanel();
      })
      .finally(() => { entry.inflight = false; entry.at = Date.now(); });
  }
  return entry;
}

// Client-side identity of paths is the RESOLVED absolute form the server returns;
// the browse API wants them workspace-relative.
function wsRelativePath(p) {
  if (!p || !p.startsWith("/")) return p || "";
  if (typeof wsRoot === "string" && wsRoot) {
    if (p === wsRoot) return "";
    if (p.startsWith(wsRoot + "/")) return p.slice(wsRoot.length + 1);
  }
  return p;
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

// Static-first: the on-disk notebook renders immediately (there's always
// something to read), while the live server launches in the background and
// swaps in when ready. onStatic fires right away so the caller reports the
// pane as non-iframe and starts mtime polling; onLive fires on the swap so it
// can flip the cache entry back to iframe (and drop it from polling).
function renderJupyterNotebook(container, text, filePath, onStatic, onLive) {
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  renderJupyterNotebookStatic(container, text, filePath);
  if (onStatic) onStatic();
  const header = container.querySelector(".jupyter-header");
  let status = null;
  if (header) {
    status = document.createElement("span");
    status.className = "jupyter-launching";
    status.textContent = "launching live server…";
    header.appendChild(status);
  }

  startJupyterServer(filePath).then(({ proxyBase }) => {
    if (!proxyBase) {
      if (status) status.remove();
      return;
    }
    const src = `${proxyBase}/notebooks/${encodeURIComponent(fileName)}`;
    // Even with a live server, surface error outputs from the on-disk notebook
    // above the iframe — catch them without scrolling (data-preview.js).
    let banner = "";
    try { banner = nbErrorBannerHTML(analyzeNotebookCells(JSON.parse(text).cells || [], filePath).errors); } catch {}
    const iframe = `<iframe class="jupyter-live" src="${src}" style="width:100%;${banner ? "flex:1;" : "height:100%;"}border:none;background:#111" allow="clipboard-read; clipboard-write"></iframe>`;
    container.innerHTML = banner ? `<div class="jupyter-live-wrap">${banner}${iframe}</div>` : iframe;
    if (onLive) onLive();
  }).catch(() => {
    if (status) status.remove();
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

  // Errored cells + source diff vs the previous render (data-preview.js).
  const diag = analyzeNotebookCells(cells, filePath);
  const erroredIdx = new Set(diag.errors.map((e) => e.index));

  let cellsHtml = '';
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const errCls = erroredIdx.has(ci) ? ' jupyter-cell-errored' : '';
    const changedBadge = diag.changed.has(ci) ? `<span class="jupyter-cell-badge">changed</span>` : '';
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');

    if (cell.cell_type === 'markdown') {
      let mdHtml;
      if (typeof marked !== 'undefined') {
        try { mdHtml = marked.parse(source); } catch { mdHtml = esc(source); }
      } else {
        mdHtml = esc(source);
      }
      cellsHtml += `<div class="jupyter-cell jupyter-cell-md${errCls}">${changedBadge}<div class="md-preview">${mdHtml}</div></div>`;
    } else if (cell.cell_type === 'code') {
      const execCount = cell.execution_count != null ? cell.execution_count : ' ';
      cellsHtml += `<div class="jupyter-cell jupyter-cell-code${errCls}">${changedBadge}`;
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
      cellsHtml += `<div class="jupyter-cell jupyter-cell-raw${errCls}">${changedBadge}<pre class="jupyter-raw-text">${esc(source)}</pre></div>`;
    }
  }

  const kernelName = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.display_name) || '';
  let headerHtml = `<div class="jupyter-header">`;
  headerHtml += `<span class="jupyter-logo">Jupyter</span>`;
  if (kernelName) headerHtml += `<span class="jupyter-kernel">${esc(kernelName)}</span>`;
  headerHtml += `<span class="jupyter-cell-count">${cells.length} cell${cells.length !== 1 ? 's' : ''}</span>`;
  headerHtml += `</div>`;

  container.innerHTML = `<div class="jupyter-notebook">${headerHtml}${nbErrorBannerHTML(diag.errors)}${cellsHtml}</div>`;

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

// ═══ ADD-ARTIFACT POPOVER ═══
function showArtifactPopover(e) {
  hideAddPopover();
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.id = "add-popover";
  pop.className = "add-popover add-popover-wide";

  const s = sessions.find(x => x.id === activeSessionId);
  // De-dupe against the CANONICAL (resolved) values the server returns — candidates
  // arrive in other forms (workspace-relative from Browse, scan-root-relative from
  // Suggested), so each candidate is canonicalized before the comparison. Suggested
  // paths join against the `base` the server reports (its ACTUAL resolved scan
  // root), never a client guess from session.cwd.
  const existingCanon = () => new Set((s?.artifacts || []).map(a => a.value));
  const canonFromWsRel = (p) => p === "" || p === "." ? wsRoot : (p.startsWith("/") || !wsRoot) ? p : `${wsRoot}/${p}`;

  pop.innerHTML = `
    <div class="add-pop-tabs">
      <span class="add-pop-tab active" data-tab="suggest" role="button" tabindex="0">Suggested</span>
      <span class="add-pop-tab" data-tab="browse" role="button" tabindex="0">Browse</span>
      <span class="add-pop-tab" data-tab="url" role="button" tabindex="0">URL</span>
    </div>
    <div class="add-pop-body" id="art-suggest-body">
      <input class="add-pop-input add-pop-filter" id="art-filter" type="text" placeholder="Filter files..." spellcheck="false" />
      <div class="art-suggest-list" id="art-suggest-list">
        <div class="art-suggest-loading">Scanning...</div>
      </div>
    </div>
    <div class="add-pop-body" id="art-browse-body" style="display:none">
      <div class="art-browse-breadcrumb" id="art-browse-crumb"></div>
      <div class="art-browse-list" id="art-browse-list" tabindex="0"></div>
      <div class="art-browse-bar">
        <label class="art-browse-hidden"><input type="checkbox" id="art-hidden-toggle" /> 显示隐藏文件</label>
        <span class="art-browse-hint" id="art-hidden-hint"></span>
      </div>
      <div class="add-pop-hint">↑↓ move · Enter open/add · Backspace up · Esc close</div>
    </div>
    <div class="add-pop-body" id="art-url-body" style="display:none">
      <input class="add-pop-input" id="art-url-input" type="text" placeholder="https://..." spellcheck="false" />
      <input class="add-pop-input" id="art-url-label" type="text" placeholder="Label (optional)" spellcheck="false" />
      <div class="art-url-error" id="art-url-error"></div>
      <div class="add-pop-hint">Enter to add · Esc to cancel</div>
    </div>
  `;

  document.body.appendChild(pop);
  pop.style.left = Math.max(8, rect.left - 120) + "px";
  pop.style.top = (rect.bottom + 4) + "px";

  const bodyIds = { suggest: "art-suggest-body", browse: "art-browse-body", url: "art-url-body" };
  const focusMap = { suggest: "#art-filter", browse: "#art-browse-list", url: "#art-url-input" };

  const activateTab = (tab) => {
    pop.querySelectorAll(".add-pop-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    for (const [k, id] of Object.entries(bodyIds)) {
      pop.querySelector(`#${id}`).style.display = k === tab.dataset.tab ? "" : "none";
    }
    if (tab.dataset.tab === "browse" && browseRel === null) loadBrowseDir(null);
    const focusSel = focusMap[tab.dataset.tab];
    if (focusSel) pop.querySelector(focusSel)?.focus();
  };
  pop.querySelectorAll(".add-pop-tab").forEach(tab => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activateTab(tab); }
    });
  });

  // ── Suggested tab ──
  // The server derives the scan root from agentId (agent cwd, workspace-jailed) —
  // same ownership model as Browse; no client-supplied cwd.
  const agentParam = s?.id ? `agentId=${encodeURIComponent(s.id)}` : "";
  fetch(`/api/files/suggest?${agentParam}`)
    .then(r => r.json())
    .then(({ base, files }) => {
      const list = pop.querySelector("#art-suggest-list");
      if (!list) return;
      const canonFromSuggest = (p) => (p.startsWith("/") || !base) ? p : `${base}/${p}`;
      const canonSet = existingCanon();
      const filtered = (files || []).filter(f => !canonSet.has(canonFromSuggest(f.path)));
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
          await addArtifact("file", f.path, f.name, canonFromSuggest(f.path));
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
  // The server owns the jail (workspace root) and the start dir (agent cwd): the
  // first call omits `path` and the response's `rel` seeds the breadcrumb. All
  // navigation is by workspace-relative path. Monotonic token: a slow response
  // that arrives after the user navigated again is dropped, not painted.
  let browseRel = null; // workspace-relative path of the listed dir (null = not loaded yet)
  let browseToken = 0;
  let browseRows = [];
  let browseActive = -1;
  const HIDDEN_PREF_KEY = "hadron-browse-hidden";
  let browseHidden = false;
  try { browseHidden = localStorage.getItem(HIDDEN_PREF_KEY) === "1"; } catch {}

  const hiddenToggle = pop.querySelector("#art-hidden-toggle");
  const hiddenHint = pop.querySelector("#art-hidden-hint");
  const syncHiddenHint = () => { hiddenHint.textContent = browseHidden ? "internal dirs (.git/.hadron) excluded" : ""; };
  hiddenToggle.checked = browseHidden;
  syncHiddenHint();
  hiddenToggle.addEventListener("change", () => {
    browseHidden = hiddenToggle.checked;
    try { localStorage.setItem(HIDDEN_PREF_KEY, browseHidden ? "1" : "0"); } catch {}
    syncHiddenHint();
    loadBrowseDir(browseRel);
  });

  const browseUp = () => {
    if (!browseRel) return;
    loadBrowseDir(browseRel.includes("/") ? browseRel.slice(0, browseRel.lastIndexOf("/")) : "");
  };

  async function addDirArtifact(rel) {
    hideAddPopover();
    await addArtifact("dir", rel === "" ? "." : rel, null, canonFromWsRel(rel));
  }

  async function loadBrowseDir(rel) {
    const token = ++browseToken;
    const list = pop.querySelector("#art-browse-list");
    if (!list) return;
    list.innerHTML = '<div class="art-suggest-loading">Loading...</div>';
    const params = new URLSearchParams();
    if (s?.id) params.set("agentId", s.id);
    if (rel !== null && rel !== undefined) params.set("path", rel);
    if (browseHidden) params.set("hidden", "1");
    let payload = null, errMsg = null;
    try {
      const r = await fetch(`/api/files/browse?${params}`);
      if (r.ok) payload = await r.json();
      else {
        try { errMsg = (await r.json()).error || `HTTP ${r.status}`; } catch { errMsg = `HTTP ${r.status}`; }
      }
    } catch { errMsg = "network error"; }
    if (token !== browseToken || !pop.isConnected) return; // stale response — drop
    if (errMsg) {
      list.innerHTML = `<div class="art-suggest-empty">Could not list directory: ${esc(errMsg)}</div>`;
      browseRows = []; browseActive = -1;
      return;
    }
    browseRel = payload.rel || "";
    renderBrowseCrumb();
    renderBrowseList(payload.entries || []);
  }

  function renderBrowseCrumb() {
    const crumb = pop.querySelector("#art-browse-crumb");
    if (!crumb) return;
    const parts = browseRel ? browseRel.split("/").filter(Boolean) : [];
    let html = `<span class="art-browse-crumb-seg" data-path="">./</span>`;
    let acc = "";
    parts.forEach(p => {
      acc += (acc ? "/" : "") + p;
      html += `<span class="art-browse-crumb-seg" data-path="${esc(acc)}">${esc(p)}/</span>`;
    });
    html += `<span class="art-browse-addcur" id="art-browse-addcur" role="button" tabindex="0" title="把当前文件夹添加为 artifact">+ 添加此文件夹</span>`;
    crumb.innerHTML = html;
    crumb.querySelectorAll(".art-browse-crumb-seg").forEach(seg => {
      seg.addEventListener("click", () => loadBrowseDir(seg.dataset.path));
    });
    crumb.querySelector("#art-browse-addcur").addEventListener("click", () => addDirArtifact(browseRel));
  }

  function renderBrowseList(entries) {
    const list = pop.querySelector("#art-browse-list");
    if (!list) return;
    list.innerHTML = "";
    browseRows = [];
    browseActive = -1;
    if (browseRel) {
      const up = document.createElement("div");
      up.className = "art-browse-item art-browse-dir";
      up.innerHTML = `<span class="art-browse-icon">..</span>`;
      up.addEventListener("click", browseUp);
      list.appendChild(up);
      browseRows.push({ el: up, activate: browseUp });
    }
    const canonSet = existingCanon();
    entries.forEach(entry => {
      const item = document.createElement("div");
      const entryRel = browseRel ? `${browseRel}/${entry.name}` : entry.name;
      if (entry.type === "dir") {
        item.className = "art-browse-item art-browse-dir";
        item.innerHTML = `<span class="art-browse-icon">${folderIcon(false, 15)}</span><span class="art-browse-name">${esc(entry.name)}</span><span class="art-browse-adddir" role="button" title="添加文件夹为 artifact">+ 添加文件夹</span>`;
        const descend = () => loadBrowseDir(entryRel);
        item.addEventListener("click", (ev) => {
          if (ev.target.closest(".art-browse-adddir")) return; // the add affordance is separate from descend
          descend();
        });
        item.querySelector(".art-browse-adddir").addEventListener("click", (ev) => {
          ev.stopPropagation();
          addDirArtifact(entryRel);
        });
        browseRows.push({ el: item, activate: descend });
      } else {
        const already = canonSet.has(canonFromWsRel(entryRel));
        item.className = `art-browse-item art-browse-file${already ? " art-browse-exists" : ""}`;
        item.innerHTML = `<span class="art-browse-icon">${fileExtIcon(entry.name)}</span><span class="art-browse-name">${esc(entry.name)}</span>${already ? '<span class="art-browse-added">added</span>' : ""}`;
        if (!already) {
          const addIt = async () => {
            hideAddPopover();
            await addArtifact("file", entryRel, entry.name, canonFromWsRel(entryRel));
          };
          item.addEventListener("click", addIt);
          browseRows.push({ el: item, activate: addIt });
        } else {
          browseRows.push({ el: item, activate: () => {} });
        }
      }
      list.appendChild(item);
    });
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "art-suggest-empty";
      empty.textContent = "Empty directory";
      list.appendChild(empty);
    }
  }

  // Keyboard nav on the (focusable) list — Escape is handled at the popover level.
  const browseListEl = pop.querySelector("#art-browse-list");
  browseListEl.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!browseRows.length) return;
      browseActive = ev.key === "ArrowDown"
        ? Math.min(browseRows.length - 1, browseActive + 1)
        : Math.max(0, browseActive - 1);
      browseRows.forEach((row, i) => row.el.classList.toggle("kb-active", i === browseActive));
      browseRows[browseActive].el.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (browseActive >= 0 && browseRows[browseActive]) browseRows[browseActive].activate();
    } else if (ev.key === "Backspace") {
      ev.preventDefault();
      browseUp();
    }
  });

  // ── URL tab ──
  const urlInput = pop.querySelector("#art-url-input");
  const urlLabel = pop.querySelector("#art-url-label");
  const urlErr = pop.querySelector("#art-url-error");
  const handleUrlKey = async (ev) => {
    if (ev.key !== "Enter") return;
    const value = urlInput.value.trim();
    if (!value) return;
    let u = null;
    try { u = new URL(value); } catch {}
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
      urlErr.textContent = "Enter a valid http(s) URL";
      return;
    }
    urlErr.textContent = "";
    const out = await addArtifact("url", value, urlLabel.value.trim());
    if (!pop.isConnected) return; // popover already dismissed some other way
    if (out && out.ok === false) {
      urlErr.textContent = out.error || "Could not add URL";
      return;
    }
    hideAddPopover();
  };
  urlInput.addEventListener("keydown", handleUrlKey);
  urlLabel.addEventListener("keydown", handleUrlKey);

  const filterInput = pop.querySelector("#art-filter");
  if (filterInput) filterInput.focus();

  clampPopover(pop, rect);
  armPopoverDismiss(btn);
}

// Add via the atomic append endpoint (the same one the CLI uses) — never a
// whole-array PATCH that can clobber a concurrent CLI append. The server response
// (the whole session, artifact values resolved) is authoritative for local state.
// The session is captured at gesture time: if the user switched agents before the
// POST landed, that session's data still updates but no tab steals focus.
// `canonValue` is the caller's canonical (resolved) form of `value` when it knows a
// better one than the default guess — used for de-dupe and to find the new tab.
// Returns { ok, error? } so popover callers can surface inline errors.
async function addArtifact(type, value, label, canonValue) {
  const sessionId = activeSessionId;
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return { ok: false, error: "no active session" };
  const canon = canonValue
    || (type !== "url" && value && !value.startsWith("/") && !value.startsWith("~") && wsRoot
      ? `${wsRoot}/${value}` : value);
  // Already an artifact (compare canonical forms): just focus its tab.
  const existing = (s.artifacts || []).findIndex((a) => a.value === value || a.value === canon);
  if (existing !== -1) {
    if (type !== "dir" && sessionId === activeSessionId) switchTab(`artifact:${existing}`);
    return { ok: true };
  }
  let res;
  try {
    // Submit the CANONICAL value, not the display-relative one: a bare relative
    // path is ambiguous server-side when the same filename exists at both the
    // workspace root and the agent cwd (codex round-3) — the client knows the
    // exact base it browsed/suggested from, so it must say so.
    res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, value: canon, ...(label ? { label } : {}) }),
    });
  } catch {
    return { ok: false, error: "network error" };
  }
  if (!res.ok) {
    let msg = `add failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    return { ok: false, error: msg };
  }
  const updated = await res.json();
  s.artifacts = updated.artifacts || [];
  render();
  // Dir artifacts have no tab — the sidebar group is the result.
  if (type !== "dir" && sessionId === activeSessionId) {
    const idx = s.artifacts.findIndex((a) => a.value === canon || a.value === value);
    if (idx !== -1) switchTab(`artifact:${idx}`);
  }
  return { ok: true };
}
