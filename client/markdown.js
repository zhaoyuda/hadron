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

// Relative <img src> in a markdown file (md syntax or inline HTML) means
// "relative to the .md file's directory", but in the preview it would resolve
// against the dashboard origin. Rewrite those srcs to go through /api/file,
// which serves images with their real mime. Absolute filesystem paths (what
// paste-to-upload inserts) get the same treatment — an origin-relative URL was
// never meaningful in this app, so "/..." that isn't /api/ or protocol-relative
// is a filesystem path.
function rewriteRelativeImages(previewEl, filePath) {
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  previewEl.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!src || /^(https?:|data:)/.test(src) || src.startsWith("/api/") || src.startsWith("//")) return;
    if (src.startsWith("/")) {
      img.src = `/api/file?path=${encodeURIComponent(src)}`;
      return;
    }
    const rel = src.replace(/^\.\//, "");
    img.src = `/api/file?path=${encodeURIComponent(dir ? `${dir}/${rel}` : rel)}`;
  });
}

function renderMarkdownArtifact(container, text, filePath) {
  container.style.position = "relative";
  container.dataset.mdRaw = text;
  container.dataset.mdMode = "preview";
  container.dataset.mdPath = filePath;
  container.dataset.editablePath = filePath;

  const html = typeof marked !== 'undefined' ? marked.parse(text) : esc(text);
  container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Preview <span class="md-toggle-key">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+E</span></div><div class="md-preview">${html}</div>`;
  rewriteRelativeImages(container.querySelector(".md-preview"), filePath);
  if (typeof annotationsOnPreviewRendered === "function") annotationsOnPreviewRendered(container, filePath);
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

// ── Editor draft store ──
// The textarea's content is a DRAFT — user data, distinct from the file on
// disk. Three states drive every behavior (design-notes/editor-ux-design.md):
//   baseline = disk content + revision the draft started from
//   draft    = current textarea content
//   dirty    = draft !== baseline
// Drafts live in a path-keyed Map (never tied to DOM lifecycle) and are
// debounce-persisted to localStorage so tab switches, page reloads and browser
// crashes all recover them (VS Code Hot Exit / github.dev model). beforeunload
// is only a last-resort flush, not the protection mechanism.
const editorDrafts = new Map(); // path -> {content, baseline, baselineRev}
const DRAFT_LS_PREFIX = "hadron-draft:";
const DRAFT_MAX_BYTES = 400000; // localStorage budget; bigger drafts stay memory-only
const draftPersistTimers = new Map();

function draftLsKey(path) { return DRAFT_LS_PREFIX + path; }

function getDraft(path) {
  if (editorDrafts.has(path)) return editorDrafts.get(path);
  try {
    const raw = localStorage.getItem(draftLsKey(path));
    if (!raw) return null;
    const d = JSON.parse(raw);
    editorDrafts.set(path, d);
    return d;
  } catch { return null; }
}

function isDraftDirty(path) {
  const d = getDraft(path);
  return !!(d && d.content !== d.baseline);
}

function persistDraftNow(path) {
  const d = editorDrafts.get(path);
  try {
    if (!d || d.content === d.baseline) { localStorage.removeItem(draftLsKey(path)); return true; }
    const raw = JSON.stringify(d);
    if (raw.length > DRAFT_MAX_BYTES) return false; // too big — memory-only
    localStorage.setItem(draftLsKey(path), raw);
    return true;
  } catch { return false; }
}

function scheduleDraftPersist(path) {
  clearTimeout(draftPersistTimers.get(path));
  draftPersistTimers.set(path, setTimeout(() => persistDraftNow(path), 500));
}

function clearDraft(path) {
  editorDrafts.delete(path);
  clearTimeout(draftPersistTimers.get(path));
  try { localStorage.removeItem(draftLsKey(path)); } catch {}
  updateTabDirtyDots(path);
}

// Instant dirty dot on the artifact tab(s) showing this file — no re-render.
function updateTabDirtyDots(path) {
  const dirty = isDraftDirty(path);
  document.querySelectorAll(".wh-tab-art").forEach((tab) => {
    if (tab.dataset.artValue === path) tab.classList.toggle("wh-tab-hasdraft", dirty);
  });
}

// Exposed for app.js's tab renderer (markdown.js loads first).
function hasDirtyDraft(path) { return isDraftDirty(path); }

// Last-resort flush: persist every in-memory draft synchronously. Only warn
// the user when a dirty draft could NOT be persisted (too big / quota).
window.addEventListener("beforeunload", (e) => {
  let unsaved = false;
  for (const [path, d] of editorDrafts) {
    if (d.content !== d.baseline && !persistDraftNow(path)) unsaved = true;
  }
  if (unsaved) { e.preventDefault(); e.returnValue = ""; }
});

// ── Per-file caret/scroll memory (UI state, session-scoped — NOT user data) ──
function saveEditPos(path, ta) {
  try {
    sessionStorage.setItem(`hadron-editpos:${path}`,
      JSON.stringify({ s: ta.selectionStart, e: ta.selectionEnd, top: ta.scrollTop }));
  } catch {}
}
function restoreEditPos(path, ta) {
  let pos = null;
  try { pos = JSON.parse(sessionStorage.getItem(`hadron-editpos:${path}`) || "null"); } catch {}
  const len = ta.value.length;
  // Default = document start (never the old cursor-at-end behavior); clamp a
  // remembered position to the current content length.
  const s = Math.min(pos ? pos.s : 0, len), e = Math.min(pos ? pos.e : 0, len);
  try { ta.setSelectionRange(s, e); } catch {}
  ta.scrollTop = pos ? pos.top : 0;
}

// Transient toast inside the editor (keybinding hints, restored-draft notice).
function editorHint(container, text, ms = 2600) {
  let el = container.querySelector(".editor-hint-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "editor-hint-toast";
    container.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
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
    // Preview is a VIEW of the draft, not a reload: with unsaved edits, render
    // the draft (toggling never discards work). Clean → fetch fresh from disk.
    const draft = getDraft(filePath);
    const renderPreview = (text, draftNote) => {
      container.dataset.mdRaw = text;
      const key = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
      const note = draftNote ? `<span class="md-toggle-draftnote">unsaved changes</span>` : "";
      const html = typeof marked !== 'undefined' ? marked.parse(text) : esc(text);
      container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Preview ${note}<span class="md-toggle-key">${key}+Shift+E</span></div><div class="md-preview">${html}</div>`;
      rewriteRelativeImages(container.querySelector(".md-preview"), filePath);
    };
    if (draft && draft.content !== draft.baseline) {
      renderPreview(draft.content, true);
    } else {
      fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
        .then((r) => r.ok ? r.text() : Promise.reject())
        .then((text) => renderPreview(text, false))
        .catch(() => {});
    }
  }
}

function openVimEditor(container, filePath, showToggle = true) {
  const shellName = `vim-${Date.now()}`;

  if (showToggle) {
    container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Editing <span class="md-toggle-key">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+E</span></div>`;
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
// The textarea holds a DRAFT (see draft store above). Open restores any stored
// draft over the fresh disk read; save is a CONDITIONAL write (baseRevision) —
// a 409 means someone (usually an agent) wrote the file since the baseline and
// opens the conflict dialog instead of silently overwriting them.
function openTextEditor(container, filePath, showToggle = true) {
  const macKey = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  const isMac = navigator.platform.includes('Mac');

  if (showToggle) {
    container.innerHTML = `<div class="md-toggle" onclick="toggleEditMode(this.parentElement)">Editing <span class="md-toggle-key">${macKey}+Shift+E</span></div>`;
  } else {
    container.innerHTML = "";
  }

  const bar = document.createElement("div");
  bar.className = "text-editor-bar" + (showToggle ? "" : " no-toggle");
  bar.innerHTML =
    `<span class="text-editor-status"></span>` +
    `<div class="text-editor-discard" title="Discard changes and reload from disk">Discard changes…</div>` +
    `<div class="text-editor-save" title="Save file">Save <span class="md-toggle-key">${macKey}+S</span></div>`;
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
  const discardBtn = bar.querySelector(".text-editor-discard");
  const saveBtnHtml = saveBtn.innerHTML;

  // Save-button state machine: Saved / Unsaved / Saving… / Save failed / Conflict.
  let savedTimer = null;
  function setSaveState(state) {
    saveBtn.classList.remove("saved", "unsaved", "conflict");
    if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
    if (state === "saved") {
      saveBtn.innerHTML = "Saved ✓"; saveBtn.classList.add("saved");
      savedTimer = setTimeout(() => { saveBtn.innerHTML = saveBtnHtml; syncDirtyUi(); }, 1500);
    } else if (state === "saving") saveBtn.innerHTML = "Saving…";
    else if (state === "conflict") { saveBtn.innerHTML = "Conflict"; saveBtn.classList.add("conflict"); }
    else { saveBtn.innerHTML = saveBtnHtml; if (state === "unsaved") saveBtn.classList.add("unsaved"); }
  }

  function draft() { return editorDrafts.get(filePath); }

  function syncDirtyUi() {
    const dirty = isDraftDirty(filePath);
    ta.dataset.dirty = dirty ? "1" : "0";
    discardBtn.style.display = dirty ? "" : "none";
    if (!saveBtn.classList.contains("saved") && !saveBtn.classList.contains("conflict")) {
      setSaveState(dirty ? "unsaved" : "idle");
    }
    updateTabDirtyDots(filePath);
  }

  function onEdited() {
    const d = draft();
    if (!d) return;
    d.content = ta.value;
    scheduleDraftPersist(filePath);
    syncDirtyUi();
  }

  // Fresh disk read establishes the baseline; a stored dirty draft (from a tab
  // switch, reload or crash) is then restored ON TOP, never silently replaced.
  fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
    .then((r) => r.ok
      ? r.text().then((text) => ({ text, rev: r.headers.get("X-File-Revision") }))
      : Promise.reject(new Error("could not load file")))
    .then(({ text, rev }) => {
      const stored = getDraft(filePath);
      if (stored && stored.content !== stored.baseline) {
        // Rebase note: if the disk moved while the draft slept, keep the draft
        // (save will 409 and offer Compare) but tell the user.
        editorDrafts.set(filePath, { content: stored.content, baseline: text, baselineRev: rev });
        ta.value = stored.content;
        editorHint(container, stored.baseline === text
          ? "Restored unsaved draft"
          : "Restored unsaved draft — file changed on disk since (Save will offer Compare)", 4000);
      } else {
        editorDrafts.set(filePath, { content: text, baseline: text, baselineRev: rev });
        ta.value = text;
      }
      ta.disabled = false;
      restoreEditPos(filePath, ta);
      ta.focus();
      restoreEditPos(filePath, ta); // focus() can scroll-to-caret; re-apply
      syncDirtyUi();
    })
    .catch(() => { status.textContent = "Could not load file"; });

  ta.addEventListener("input", onEdited);
  const posSave = () => { if (!ta.disabled) saveEditPos(filePath, ta); };
  ta.addEventListener("blur", posSave);
  ta.addEventListener("scroll", posSave, { passive: true });
  ta.addEventListener("keyup", posSave);
  ta.addEventListener("mouseup", posSave);

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      // Tab inserts two spaces instead of moving focus
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      onEdited();
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveTextEditor();
    } else if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "v") {
      // macOS Emacs binding (Ctrl+V = page down) reads as a broken paste to
      // most users — neutralize it and point at ⌘V (VS Code-style habits).
      e.preventDefault();
      editorHint(container, "Paste is ⌘V (Ctrl+V is a macOS page-down key)");
    } else if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "k") {
      // macOS Emacs kill-line silently deletes to end of line — too destructive
      // to leave as a surprise.
      e.preventDefault();
      editorHint(container, "Ctrl+K (macOS delete-to-end-of-line) is disabled here");
    }
  });

  discardBtn.addEventListener("click", () => {
    const fname = filePath.split("/").pop();
    if (!confirm(`Discard changes to ${fname}?\n\nYour unsaved edits will be removed.`)) return;
    clearDraft(filePath);
    openTextEditor(container, filePath, showToggle); // reload fresh from disk
  });

  function applySavedResponse(r, content) {
    if (container.dataset.mdRaw !== undefined) container.dataset.mdRaw = content;
    // Pre-set the cache entry's mtime (the poller's baseline) to our own
    // write's mtime so it isn't treated as an external change.
    const newMtime = r.headers.get("X-File-Mtime");
    if (newMtime) {
      try {
        const key = container.dataset.cacheKey;
        const entry = key && typeof artifactCache !== "undefined" ? artifactCache.get(key) : null;
        if (entry) entry.mtime = newMtime;
      } catch {}
    }
    const newRev = r.headers.get("X-File-Revision");
    editorDrafts.set(filePath, { content, baseline: content, baselineRev: newRev });
    persistDraftNow(filePath); // clean → removes the stored draft
    setSaveState("saved");
    syncDirtyUi();
    setSaveState("saved"); // syncDirtyUi resets idle; keep the ✓ visible
  }

  function doConditionalSave(content, baseRevision) {
    setSaveState("saving");
    status.textContent = "";
    return fetch(`/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content, baseRevision }),
    }).then((r) => {
      if (r.ok) { applySavedResponse(r, content); return; }
      if (r.status === 409) {
        return r.json().then((j) => {
          setSaveState("conflict");
          showSaveConflictDialog({
            filePath, container,
            draftContent: content,
            diskContent: j.currentContent,
            onOverwrite: () => doConditionalSave(content, j.currentRevision),
            onDismiss: () => syncDirtyUi(),
          });
        });
      }
      return r.json().catch(() => ({})).then((j) => Promise.reject(new Error(j.error || `save failed (${r.status})`)));
    }).catch((e) => {
      // Keep the draft — the user's edits are never lost by a failed save.
      setSaveState("idle"); syncDirtyUi();
      status.textContent = e && e.message ? e.message : "Save failed";
    });
  }

  function saveTextEditor() {
    if (ta.disabled) return;
    const d = draft();
    doConditionalSave(ta.value, d ? d.baselineRev : undefined);
  }

  saveBtn.addEventListener("click", saveTextEditor);
  syncDirtyUi();
}

// ── Save-conflict dialog ── the file changed on disk after the draft's
// baseline. Cancel (default, safe) / Compare (read-only two-pane) /
// Overwrite… (second confirm, conditional on the revision just seen — if the
// file changes AGAIN mid-dialog the save re-conflicts instead of punching
// through). Every path keeps the draft.
function showSaveConflictDialog({ filePath, container, draftContent, diskContent, onOverwrite, onDismiss }) {
  document.querySelector(".editor-conflict-overlay")?.remove();
  const fname = filePath.split("/").pop();
  const ov = document.createElement("div");
  ov.className = "editor-conflict-overlay";
  ov.innerHTML = `
    <div class="editor-conflict-box">
      <div class="ec-title">Save blocked: <b>${esc(fname)}</b> changed on disk after you started editing.</div>
      <div class="ec-compare" style="display:none">
        <div class="ec-col"><div class="ec-col-hd">Your draft</div><pre></pre></div>
        <div class="ec-col"><div class="ec-col-hd">Current file on disk</div><pre></pre></div>
      </div>
      <div class="ec-actions">
        <button class="ec-btn ec-compare-btn">Compare</button>
        <button class="ec-btn ec-overwrite-btn">Overwrite…</button>
        <button class="ec-btn ec-cancel-btn">Cancel</button>
      </div>
      <div class="ec-note">Cancel keeps your draft untouched. Overwrite replaces the on-disk version.</div>
    </div>`;
  const pres = ov.querySelectorAll(".ec-compare pre");
  pres[0].textContent = draftContent;
  pres[1].textContent = diskContent == null ? "(file is gone)" : diskContent;
  const close = () => { ov.remove(); if (onDismiss) onDismiss(); };
  ov.querySelector(".ec-cancel-btn").addEventListener("click", close);
  ov.querySelector(".ec-compare-btn").addEventListener("click", () => {
    const cmp = ov.querySelector(".ec-compare");
    cmp.style.display = cmp.style.display === "none" ? "" : "none";
  });
  ov.querySelector(".ec-overwrite-btn").addEventListener("click", () => {
    if (!confirm(`Overwrite ${fname} on disk with your draft?\n\nThe other version will be replaced.`)) return;
    ov.remove();
    onOverwrite();
  });
  // Esc closes the DIALOG only (never discards the draft).
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  document.body.appendChild(ov);
  ov.querySelector(".ec-cancel-btn").focus();
}

// ── Paste-to-upload ── an image on the clipboard (OS screenshot) pasted into the
// built-in editor or a notes textarea uploads to the server (which stores it under
// <workspace>/.hadron/uploads/<agentId>/ and returns the absolute path) and inserts
// a markdown image ref at the cursor. One delegated listener instead of per-textarea
// wiring: the targets are created and destroyed constantly (editor opens, notes tabs
// re-render), a document-level handler survives all of that. Non-image pastes fall
// through untouched. The dispatched "input" event is what keeps the host textarea's
// own contract intact — it fires the editor's dirty-flag listener and the notes
// textareas' inline oninput autosave exactly as typing would.
const IMAGE_PASTE_TARGETS = ".text-edit-area, #notes-textarea, #rp-notes-textarea, .split-pane-notes";

function imagePasteInsert(ta, text, start, end) {
  ta.setRangeText(text, start, end, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function handleImagePaste(e) {
  const ta = e.target;
  if (!ta || !ta.matches || !ta.matches(IMAGE_PASTE_TARGETS)) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let file = null;
  for (const item of items) {
    if (item.kind === "file" && /^image\//.test(item.type)) { file = item.getAsFile(); break; }
  }
  if (!file || !activeSessionId) return; // non-image paste (or no agent) falls through untouched
  e.preventDefault();

  const placeholder = "![uploading…]()";
  imagePasteInsert(ta, placeholder, ta.selectionStart, ta.selectionEnd);

  const swap = (replacement) => {
    const idx = ta.value.indexOf(placeholder);
    if (idx === -1) return; // user removed it — don't fight them
    imagePasteInsert(ta, replacement, idx, idx + placeholder.length);
  };

  fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/upload`, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error(`upload failed (${r.status})`)))
    .then((j) => swap(`![screenshot](${j.path})`))
    .catch(() => swap(""));
}

document.addEventListener("paste", handleImagePaste);

// ── Clicking a link in a markdown preview ──
// A relative/absolute link to another local file (e.g. [design](./notes/plan.md)
// or [report](../out/report.md)) opens in-place as an artifact tab of the current
// agent — the same "open as this agent's artifact" model as clicking a terminal
// path — instead of navigating the whole dashboard away. Links are resolved
// against the .md file's own directory (matching rewriteRelativeImages). External
// links (http(s)/mailto/…) open in a new tab; in-page #anchors are left alone.
function resolveMdLinkPath(mdPath, href) {
  href = href.replace(/[?#].*$/, "");            // drop query / fragment
  try { href = decodeURIComponent(href); } catch {}
  href = href.replace(/^file:\/\//, "");
  if (!href) return null;
  if (href.startsWith("~") || href.startsWith("/")) return href; // ~ / filesystem-absolute
  const dir = mdPath && mdPath.includes("/") ? mdPath.slice(0, mdPath.lastIndexOf("/")) : "";
  const parts = dir ? dir.split("/") : [];
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}

function flashMdLinkMissing(a) {
  a.classList.add("md-link-missing");
  setTimeout(() => a.classList.remove("md-link-missing"), 1200);
}

function handleMdLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || !a.closest(".md-preview")) return; // only links inside a rendered preview
  const href = a.getAttribute("href") || "";
  if (!href || href.startsWith("#")) return;    // in-page anchor → browser default
  // External / non-file scheme → open in a new tab, don't hijack it into an artifact.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
    e.preventDefault();
    window.open(href, "_blank", "noopener");
    return;
  }
  const host = a.closest("[data-md-path]");
  const resolved = resolveMdLinkPath(host && host.dataset.mdPath, href);
  if (!resolved) return;
  e.preventDefault();
  // Confirm it exists before adding a tab, so a broken link doesn't leave junk;
  // otherwise flash the link so the click doesn't feel dead.
  fetch(`/api/file?path=${encodeURIComponent(resolved)}`, { method: "HEAD" })
    .then((r) => {
      if (r.ok && typeof addArtifact === "function") addArtifact("file", resolved);
      else flashMdLinkMissing(a);
    })
    .catch(() => flashMdLinkMissing(a));
}

document.addEventListener("click", handleMdLinkClick);

