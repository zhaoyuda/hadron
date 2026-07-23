// ═══ COMMAND PALETTE (⌘K / Ctrl+K) ═══
// Fuzzy switch across agents + the current agent's artifacts + workspace files.
// Pure client-side over already-loaded lists (sessions, active artifacts) plus
// the existing /api/files/suggest endpoint for files. Classic-script global
// scope: calls switchSession/switchTab/addArtifact/getDisplayOrder/mkIcon/
// fileIcon at runtime (defined in app.js / artifacts.js / file-icons.js).
//
// Opened from handleGlobalShortcut (app.js) on Cmd/Ctrl+K, or the topbar
// trigger. The server file fetch is debounced; everything else is instant.

let paletteOpen = false;
let paletteSel = 0;        // index into the flat list of selectable rows
let paletteItems = [];     // [{ icon, label, sub, action }]
let paletteFiles = [];     // last /api/files/suggest result (paths relative to its base)
let paletteSuggestBase = ""; // the resolved scan root the server used for paletteFiles
let paletteFileSeq = 0;    // guards against out-of-order fetch responses
let paletteFileTimer = null;

function modKeyLabel() { return navigator.platform.includes("Mac") ? "⌘" : "Ctrl"; }

// Subsequence fuzzy score. Returns -1 for no match; higher = better. Rewards
// contiguous runs and a prefix hit so "rep" ranks report.md over r-e-p-ort.
function fuzzyScore(q, text) {
  if (!q) return 0;
  q = q.toLowerCase(); text = text.toLowerCase();
  let qi = 0, streak = 0, score = 0;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) {
      streak++;
      score += 1 + streak + (ti === 0 ? 3 : 0);
      qi++;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

function ensurePaletteDom() {
  let overlay = document.getElementById("palette-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "palette-overlay";
  overlay.innerHTML = `
    <div id="palette-box" role="dialog" aria-label="Command palette">
      <input id="palette-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Switch agent, open artifact, or find a file…" />
      <div id="palette-results"></div>
      <div id="palette-foot"><kbd>↑↓</kbd> navigate <kbd>↵</kbd> select <kbd>esc</kbd> close</div>
    </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeCommandPalette(); });
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#palette-input");
  input.addEventListener("input", () => {
    scheduleFileFetch(input.value.trim());
    renderPalette(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter") { e.preventDefault(); activateSel(); }
    else if (e.key === "Escape") { e.preventDefault(); closeCommandPalette(); }
  });
  return overlay;
}

function openCommandPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  paletteFiles = [];
  const overlay = ensurePaletteDom();
  overlay.classList.add("active");
  const input = overlay.querySelector("#palette-input");
  input.value = "";
  renderPalette("");
  input.focus();
}

function closeCommandPalette() {
  const overlay = document.getElementById("palette-overlay");
  if (overlay) overlay.classList.remove("active");
  paletteOpen = false;
}

function scheduleFileFetch(query) {
  clearTimeout(paletteFileTimer);
  // Empty query → no file noise; only fetch once the user starts typing.
  if (!query) { paletteFiles = []; return; }
  paletteFileTimer = setTimeout(async () => {
    const seq = ++paletteFileSeq;
    try {
      const r = await fetch(`/api/files/suggest?agentId=${encodeURIComponent(activeSessionId || "")}`);
      if (!r.ok) return;
      const { base, files } = await r.json();
      if (seq !== paletteFileSeq || !paletteOpen) return; // stale / closed
      paletteFiles = files || [];
      paletteSuggestBase = base || "";
      const input = document.getElementById("palette-input");
      renderPalette(input ? input.value.trim() : "");
    } catch {}
  }, 180);
}

// Build the flat selectable list from all three sources, fuzzy-filtered + ranked.
function buildPaletteItems(query) {
  const items = [];

  // ── Agents (global) → switch ──
  const order = (typeof getDisplayOrder === "function") ? getDisplayOrder() : sessions;
  const agentRows = order
    .map((s) => ({ s, score: fuzzyScore(query, s.name) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ s }) => ({
      cat: "Agents",
      icon: mkIcon(s.state, 14),
      label: s.name,
      sub: s.group || "",
      action: () => { closeCommandPalette(); switchSession(s.id); },
    }));

  // ── Current agent's artifacts → open tab ──
  const active = sessions.find((s) => s.id === activeSessionId);
  const arts = (active && active.artifacts) || [];
  const artRows = arts
    .map((a, idx) => {
      const name = a.label || (a.value ? a.value.split("/").pop() : a.value) || "";
      return { a, idx, name, score: fuzzyScore(query, name) };
    })
    .filter((x) => x.a.type !== "dir") // dir artifacts have no tab — they live in the sidebar
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ a, idx, name }) => ({
      cat: "Artifacts",
      icon: a.type === "url" ? urlGlyph() : fileIcon(name, 14),
      label: name,
      sub: a.type === "url" ? a.value : "",
      action: () => { closeCommandPalette(); switchTab(`artifact:${idx}`); },
    }));

  // ── Workspace files (server suggest) → add as artifact (de-dupes) ──
  // Artifact values arrive resolved (canonical); suggest paths are relative to the
  // `base` the server REPORTED with them (its actual resolved scan root — a guess
  // from session.cwd disagrees for symlinked/clamped cwds). Compare resolved forms.
  const existing = new Set(arts.map((a) => a.value));
  const canonOf = (p) => (p.startsWith("/") || !paletteSuggestBase) ? p : `${paletteSuggestBase}/${p}`;
  const fileRows = (query ? paletteFiles : [])
    .filter((f) => !existing.has(f.path) && !existing.has(canonOf(f.path)))
    .map((f) => ({ f, score: fuzzyScore(query, f.path) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || b.f.score - a.f.score)
    .slice(0, 8)
    .map(({ f }) => ({
      cat: "Files",
      icon: fileIcon(f.name, 14),
      label: f.name,
      sub: f.path,
      action: () => { closeCommandPalette(); addArtifact("file", f.path, undefined, canonOf(f.path)); },
    }));

  return items.concat(agentRows, artRows, fileRows);
}

function urlGlyph() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#58a6ff" stroke-width="1"/><ellipse cx="8" cy="8" rx="3" ry="6.5" stroke="#58a6ff" stroke-width="0.8"/><line x1="1.5" y1="8" x2="14.5" y2="8" stroke="#58a6ff" stroke-width="0.8"/></svg>`;
}

function renderPalette(query) {
  paletteItems = buildPaletteItems(query);
  if (paletteSel >= paletteItems.length) paletteSel = Math.max(0, paletteItems.length - 1);
  const box = document.getElementById("palette-results");
  if (!box) return;
  if (!paletteItems.length) {
    box.innerHTML = `<div class="palette-empty">No matches${query ? ` for “${escHtml(query)}”` : ""}</div>`;
    return;
  }
  let html = "";
  let lastCat = null;
  paletteItems.forEach((it, i) => {
    if (it.cat !== lastCat) { html += `<div class="palette-cat">${it.cat}</div>`; lastCat = it.cat; }
    html += `<div class="palette-row${i === paletteSel ? " sel" : ""}" data-i="${i}">`
      + `<span class="palette-ic">${it.icon}</span>`
      + `<span class="palette-label">${escHtml(it.label)}</span>`
      + (it.sub ? `<span class="palette-sub">${escHtml(it.sub)}</span>` : "")
      + `</div>`;
  });
  box.innerHTML = html;
  box.querySelectorAll(".palette-row").forEach((row) => {
    row.addEventListener("mousemove", () => setSel(parseInt(row.dataset.i)));
    row.addEventListener("click", () => { paletteSel = parseInt(row.dataset.i); activateSel(); });
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function setSel(i) {
  if (i === paletteSel) return;
  paletteSel = i;
  highlightSel();
}

function moveSel(delta) {
  if (!paletteItems.length) return;
  paletteSel = (paletteSel + delta + paletteItems.length) % paletteItems.length;
  highlightSel();
}

function highlightSel() {
  const rows = document.querySelectorAll("#palette-results .palette-row");
  rows.forEach((row) => {
    const on = parseInt(row.dataset.i) === paletteSel;
    row.classList.toggle("sel", on);
    if (on) row.scrollIntoView({ block: "nearest" });
  });
}

function activateSel() {
  const it = paletteItems[paletteSel];
  if (it) it.action();
}

// Wire the topbar trigger + key-hint label once the DOM is ready.
function initPaletteTrigger() {
  const trigger = document.getElementById("palette-trigger");
  if (trigger) {
    trigger.querySelector(".pt-key").textContent = `${modKeyLabel()}K`;
    trigger.addEventListener("click", openCommandPalette);
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPaletteTrigger);
} else {
  initPaletteTrigger();
}
