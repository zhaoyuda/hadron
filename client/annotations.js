// ═══ ANNOTATIONS (v0.8 review loop) ═══ — classic <script>, loaded after artifacts.js, before app.js.
// The production side of the inline review loop: selection-gesture comments on markdown
// previews, best-effort <mark> highlights, the bottom-right floating bar (driven purely
// off the server summary), and the comment drawer. The server (server/annotations.js)
// owns all state — this file only paints GET responses and calls the dedicated
// endpoints; it never derives batch state itself.
// Seam — reads app.js globals (esc, activeSessionId, activeTab, sessions) and
// markdown.js helpers (isMarkdownFile) at call time. artifacts.js calls
// annotationsSyncPolling/annotationsStopPolling from its mtime-polling lifecycle;
// markdown.js calls annotationsOnPreviewRendered after each preview render — both
// typeof-guarded over there, so this file is fully optional.

// ── state ──
let annCtx = null;        // { sessionId, path } — the active markdown artifact, or null
let annTimer = null;      // 3s poll interval (mirrors the artifact mtime poller lifecycle)
let annData = null;       // last poll: { summary, current: [comments], others: [comments] }
let annPollSeq = 0;       // stale-response guard across ctx switches
let annSendLocked = false; // Send clicked — stays disabled until the next poll repaints
let annDrawerEl = null;
let annDrawerOpen = false;
let annEditingId = null;  // drawer row currently in inline edit (poll skips the rebuild)
let annFabEl = null;      // floating 💬 Comment button
let annPopEl = null;      // comment composer popover
let annPending = null;    // selection captured at FAB time: { container, path, selected, ordinal }

// ── polling lifecycle ──
// Mirrors startArtifactMtimePolling: called on every renderWorkContent, decides from
// the live globals whether a markdown artifact is the active tab. One interval, no
// leaks across tab/session switches.
function annotationsSyncPolling() {
  let next = null;
  try {
    if (typeof activeTab === "string" && activeTab.startsWith("artifact:") && activeSessionId) {
      const s = sessions.find((x) => x.id === activeSessionId);
      const art = s?.artifacts?.[parseInt(activeTab.split(":")[1])];
      if (art && art.type === "file" && isMarkdownFile(art.value)) next = { sessionId: s.id, path: art.value };
    }
  } catch {}
  if (!next) { annotationsStopPolling(); return; }
  if (annTimer && annCtx && annCtx.sessionId === next.sessionId && annCtx.path === next.path) return;
  annotationsStopPolling();
  annCtx = next;
  annTimer = setInterval(annPoll, 3000);
  annPoll();
}

function annotationsStopPolling() {
  if (annTimer) { clearInterval(annTimer); annTimer = null; }
  annCtx = null;
  annData = null;
  annCloseDrawer();
  annHideFab();
  annClosePopover();
}

// One poll = two reads: the current file's active comments (drawer top section +
// marks) and the agent-wide active set (summary for the bar + "other files" section).
async function annPoll() {
  const ctx = annCtx;
  if (!ctx) return;
  const seq = ++annPollSeq;
  try {
    const base = `/api/sessions/${encodeURIComponent(ctx.sessionId)}/annotations`;
    const [cur, all] = await Promise.all([
      fetch(`${base}?path=${encodeURIComponent(ctx.path)}`).then((r) => r.json()),
      fetch(base).then((r) => r.json()),
    ]);
    if (seq !== annPollSeq || annCtx !== ctx) return; // ctx switched mid-flight
    const curIds = new Set((cur.comments || []).map((c) => c.id));
    annData = {
      summary: all.summary,
      current: cur.comments || [],
      others: (all.comments || []).filter((c) => !curIds.has(c.id)),
    };
    annSendLocked = false;
    annRenderUI();
  } catch {}
}

// markdown.js hook — fires after every renderMarkdownArtifact (initial render AND
// mtime auto-reloads, which rebuild the DOM and destroy our marks/bar).
function annotationsOnPreviewRendered(container, filePath) {
  annEnsureDocBtn(container, filePath);
  if (annCtx && filePath === annCtx.path) annRenderUI();
}

// ── DOM lookup ──
// The preview container can be the cached artifact element or a split pane; ignore
// anything stashed in the offscreen pool or display:none.
function annFindContainer() {
  if (!annCtx) return null;
  for (const el of document.querySelectorAll("[data-md-path]")) {
    if (el.dataset.mdPath !== annCtx.path) continue;
    if (el.closest("#artifact-pool")) continue;
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
    return el;
  }
  return null;
}

function annRenderUI() {
  if (!annCtx) return;
  const container = annFindContainer();
  if (container) {
    annRenderBar(container);
    annApplyMarks(container);
  }
  if (annDrawerOpen) annRenderDrawer();
}

// ── floating bar ──
// State machine driven PURELY off summary (codex #8): draft → Send; batch in flight →
// 等待修改 (x/y); batch done → re-open; dispatch failed → Retry; all zero → hidden.
function annRenderBar(container) {
  const s = annData?.summary;
  const old = container.querySelector(":scope > .ann-bar-wrap");
  const show = s && container.dataset.mdMode === "preview" && (s.draft > 0 || s.currentBatchId || s.lastBatchId);
  if (!show) { if (old) old.remove(); return; }

  let wrap = old;
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "ann-bar-wrap";
    wrap.innerHTML = `<div class="ann-bar"></div>`;
    container.appendChild(wrap);
  }
  const bar = wrap.querySelector(".ann-bar");

  let html = "";
  if (s.dispatchError && s.currentBatchId) {
    html += `<button class="ann-bar-btn ann-retry" title="${esc(s.dispatchError)}">⚠ Retry</button>`;
  } else if (s.currentBatchId) {
    html += `<span class="ann-waiting">等待修改 (${s.resolvedInCurrentBatch}/${s.sent + s.resolvedInCurrentBatch})</span>`;
  }
  if (s.draft > 0) {
    html += `<button class="ann-bar-btn ann-send"${annSendLocked ? " disabled" : ""}>${s.draft} comment${s.draft !== 1 ? "s" : ""} · Send to agent</button>`;
  } else if (!s.currentBatchId && s.lastBatchId) {
    html += `<button class="ann-bar-btn ann-reopen">↻ re-open 上一批</button>`;
  }
  const active = s.draft + s.sent;
  if (active > 0) html += `<span class="ann-badge" title="Show comments">💬 ${active}</span>`;
  bar.innerHTML = html;

  const post = (rest) => fetch(`/api/sessions/${encodeURIComponent(annCtx.sessionId)}/annotations${rest}`, { method: "POST" }).finally(annPoll);
  bar.querySelector(".ann-send")?.addEventListener("click", (e) => {
    if (annSendLocked) return;
    annSendLocked = true;            // re-enabled by the next poll repaint
    e.currentTarget.disabled = true;
    post("/send");
  });
  bar.querySelector(".ann-reopen")?.addEventListener("click", () => post("/reopen"));
  bar.querySelector(".ann-retry")?.addEventListener("click", () => post("/retry-dispatch"));
  bar.querySelector(".ann-badge")?.addEventListener("click", () => annOpenDrawer());
}

// ── highlights ──
// Degraded by design (codex #18): only `matched` text anchors whose exact string sits
// inside a single text node get a <mark>; ambiguous/orphaned never highlight (the
// drawer lists them instead). First occurrence wins — best-effort, not a range machine.
function annApplyMarks(container) {
  const preview = container.querySelector(".md-preview");
  if (!preview) return;
  const want = (annData?.current || []).filter((c) => c.anchor?.type === "text" && c.anchorStatus === "matched");
  const sig = want.map((c) => `${c.id}:${c.body.length}`).sort().join("|");
  if (preview.dataset.annSig === sig && preview.querySelectorAll("mark.ann-mark").length > 0) return;
  // Unwrap stale marks, then re-mark from scratch (a reload already gave us a clean DOM).
  preview.querySelectorAll("mark.ann-mark").forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  preview.normalize();
  preview.dataset.annSig = sig;
  for (const c of want) {
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest("mark.ann-mark")) continue;
      const i = node.nodeValue.indexOf(c.anchor.exact);
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + c.anchor.exact.length);
      const mark = document.createElement("mark");
      mark.className = "ann-mark";
      mark.dataset.annId = c.id;
      mark.title = c.body; // hover shows the comment body
      mark.addEventListener("click", () => annOpenDrawer(c.id));
      try { range.surroundContents(mark); } catch {}
      break;
    }
  }
}

// ── selection gesture ──
// No comment mode: a non-empty selection inside a .md-preview floats the 💬 button
// (Google-Docs style). The selection context is captured at FAB time because the
// click that follows collapses the selection.
document.addEventListener("mouseup", (e) => {
  if (e.target.closest?.(".ann-fab, .ann-popover, .ann-drawer, .ann-bar-wrap")) return;
  annHideFab();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const selected = sel.toString().trim();
  if (!selected) return;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const elem = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const preview = elem?.closest?.(".md-preview");
  const container = preview?.closest("[data-md-path]");
  if (!preview || !container) return; // selection must be fully inside one preview
  annPending = {
    container,
    path: container.dataset.mdPath,
    selected,
    ordinal: annSelectionOrdinal(preview, range, selected),
  };
  const rect = range.getBoundingClientRect();
  annShowFab(Math.min(rect.right + 6, window.innerWidth - 110), Math.min(rect.bottom + 6, window.innerHeight - 36));
});

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest?.(".ann-fab")) annHideFab();
  if (annPopEl && !e.target.closest?.(".ann-popover, .ann-fab, .ann-doc-btn")) annClosePopover();
});

// How many times `selected` already occurred in the preview's plain text before the
// selection start — used to pick the same ordinal occurrence in the raw markdown.
function annSelectionOrdinal(preview, range, selected) {
  try {
    const pre = document.createRange();
    pre.selectNodeContents(preview);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString();
    let n = 0, i = before.indexOf(selected);
    while (i !== -1) { n++; i = before.indexOf(selected, i + 1); }
    return n;
  } catch { return 0; }
}

// Map the selection to the RAW markdown — that's what the server relocates against
// (preview text ≠ raw: headings lose #, lists lose bullets...). Best-effort heuristic:
//   1. the selected string must appear verbatim in mdRaw (plain inline text does;
//      selections spanning formatting like **bold** or list markers won't);
//   2. pick the occurrence by the rendered ordinal computed above (falls back to the
//      first when raw has fewer occurrences);
//   3. prefix/suffix = 32 raw chars around it, the server's disambiguator.
// Returns null when (1) fails → caller degrades to a whole-doc anchor with the
// excerpt quoted into the body. The loop matters more than perfect anchoring.
function annBuildTextAnchor(container, selected, ordinal) {
  const raw = container.dataset.mdRaw || "";
  const idxs = [];
  let i = raw.indexOf(selected);
  while (i !== -1) { idxs.push(i); i = raw.indexOf(selected, i + 1); }
  if (!idxs.length) return null;
  const at = idxs[Math.min(ordinal, idxs.length - 1)];
  const anchor = { type: "text", exact: selected };
  const prefix = raw.slice(Math.max(0, at - 32), at);
  const suffix = raw.slice(at + selected.length, at + selected.length + 32);
  if (prefix) anchor.prefix = prefix;
  if (suffix) anchor.suffix = suffix;
  return anchor;
}

// ── FAB + composer popover ──
function annShowFab(x, y) {
  if (!annFabEl) {
    annFabEl = document.createElement("div");
    annFabEl.className = "ann-fab";
    annFabEl.textContent = "💬 Comment";
    annFabEl.addEventListener("click", () => {
      const p = annPending;
      annHideFab();
      if (!p) return;
      annOpenComposer({ container: p.container, path: p.path, selected: p.selected, ordinal: p.ordinal },
        parseFloat(annFabEl?.dataset.x || x), parseFloat(annFabEl?.dataset.y || y));
    });
    document.body.appendChild(annFabEl);
  }
  annFabEl.dataset.x = x;
  annFabEl.dataset.y = y;
  annFabEl.style.left = `${x}px`;
  annFabEl.style.top = `${y}px`;
  annFabEl.style.display = "block";
}

function annHideFab() {
  if (annFabEl) annFabEl.style.display = "none";
}

// One composer for both gestures: `spec.selected` set → text anchor (with doc
// fallback), absent → whole-doc comment.
function annOpenComposer(spec, x, y) {
  annClosePopover();
  const pop = document.createElement("div");
  pop.className = "ann-popover";
  pop.innerHTML = `
    ${spec.selected ? `<div class="ann-pop-quote">${esc(spec.selected.length > 90 ? spec.selected.slice(0, 87) + "…" : spec.selected)}</div>` : `<div class="ann-pop-quote ann-pop-quote-doc">Whole document</div>`}
    <textarea class="ann-pop-body" placeholder="Leave a comment for the agent…"></textarea>
    <div class="ann-pop-actions"><span class="ann-pop-hint">Esc to cancel</span><button class="ann-pop-add">Add</button></div>`;
  document.body.appendChild(pop);
  pop.style.left = `${Math.min(x, window.innerWidth - 290)}px`;
  pop.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
  annPopEl = pop;

  const ta = pop.querySelector(".ann-pop-body");
  ta.focus();
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); annClosePopover(); }
  });
  pop.querySelector(".ann-pop-add").addEventListener("click", () => {
    let body = ta.value.trim();
    if (!body || !activeSessionId) return;
    let anchor = { type: "doc" };
    if (spec.selected) {
      const textAnchor = annBuildTextAnchor(spec.container, spec.selected, spec.ordinal);
      if (textAnchor) anchor = textAnchor;
      else body = `> ${spec.selected}\n\n${body}`; // formatting-spanning selection: quote it instead
    }
    fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: spec.path, anchor, body }),
    }).finally(annPoll);
    annClosePopover();
  });
}

function annClosePopover() {
  if (annPopEl) { annPopEl.remove(); annPopEl = null; }
}

// Whole-doc 💬 affordance in the toggle-bar area (left of Preview/Edit + Copy/Download).
function annEnsureDocBtn(container, filePath) {
  if (container.querySelector(":scope > .ann-doc-btn")) return;
  const btn = document.createElement("div");
  btn.className = "ann-doc-btn";
  btn.textContent = "💬";
  btn.title = "Comment on the whole document";
  btn.addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    annOpenComposer({ container, path: filePath }, r.left - 240, r.bottom + 6);
  });
  container.appendChild(btn);
}

// ── drawer ──
function annEnsureDrawer() {
  if (annDrawerEl) return annDrawerEl;
  const d = document.createElement("div");
  d.className = "ann-drawer";
  d.innerHTML = `<div class="ann-drawer-head"><span class="ann-drawer-title">Comments</span><span class="ann-drawer-file"></span><span class="ann-drawer-close" title="Close">×</span></div><div class="ann-rows"></div>`;
  d.querySelector(".ann-drawer-close").addEventListener("click", annCloseDrawer);
  document.body.appendChild(d);
  annDrawerEl = d;
  return d;
}

function annOpenDrawer(scrollToId) {
  annEnsureDrawer();
  annDrawerOpen = true;
  annRenderDrawer();
  requestAnimationFrame(() => annDrawerEl.classList.add("open"));
  if (scrollToId) {
    const row = annDrawerEl.querySelector(`.ann-row[data-ann-id="${scrollToId}"]`);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("ann-row-flash");
      setTimeout(() => row.classList.remove("ann-row-flash"), 1200);
    }
  }
}

function annCloseDrawer() {
  annDrawerOpen = false;
  annEditingId = null;
  if (annDrawerEl) annDrawerEl.classList.remove("open");
}

function annRowHTML(c, withFile) {
  const draft = c.state === "draft";
  const bad = c.anchorStatus !== "matched" && c.anchor?.type === "text";
  return `<div class="ann-row${withFile ? " ann-other" : ""}" data-ann-id="${esc(c.id)}">
    ${withFile ? `<div class="ann-row-file">${esc(c.file)}</div>` : ""}
    <div class="ann-row-head">
      <span class="ann-chip ${draft ? "ann-chip-draft" : "ann-chip-sent"}">${esc(c.state)}</span>
      ${bad ? `<span class="ann-chip ann-chip-bad">${esc(c.anchorStatus)}</span>` : ""}
      <span class="ann-row-loc" title="${esc(c.locationText)}">${esc(c.locationText)}</span>
      ${draft ? `<span class="ann-row-act ann-row-edit" title="Edit">✎</span><span class="ann-row-act ann-row-del" title="Delete">×</span>` : ""}
    </div>
    <div class="ann-row-body">${esc(c.body)}</div>
  </div>`;
}

function annRenderDrawer() {
  if (!annDrawerOpen || !annDrawerEl || !annData) return;
  if (annEditingId) return; // don't clobber an in-progress inline edit; next poll catches up
  annDrawerEl.querySelector(".ann-drawer-file").textContent = annCtx ? annCtx.path.split("/").pop() : "";
  const rows = annDrawerEl.querySelector(".ann-rows");
  const { current, others } = annData;
  let html = current.map((c) => annRowHTML(c, false)).join("");
  if (!current.length) html += `<div class="ann-empty">No comments on this file</div>`;
  if (others.length) {
    html += `<div class="ann-sec-title">Other files</div>`;
    html += others.map((c) => annRowHTML(c, true)).join("");
  }
  rows.innerHTML = html;

  const api = (cid) => `/api/sessions/${encodeURIComponent(annCtx.sessionId)}/annotations/${encodeURIComponent(cid)}`;
  rows.querySelectorAll(".ann-row").forEach((row) => {
    const cid = row.dataset.annId;
    const c = current.find((x) => x.id === cid) || others.find((x) => x.id === cid);
    row.querySelector(".ann-row-del")?.addEventListener("click", () => {
      fetch(api(cid), { method: "DELETE" }).finally(annPoll);
    });
    row.querySelector(".ann-row-edit")?.addEventListener("click", () => {
      annEditingId = cid;
      const bodyEl = row.querySelector(".ann-row-body");
      bodyEl.innerHTML = `<textarea class="ann-row-editbox"></textarea><div class="ann-pop-actions"><span class="ann-pop-hint">Esc to cancel</span><button class="ann-row-save">Save</button></div>`;
      const box = bodyEl.querySelector(".ann-row-editbox");
      box.value = c.body;
      box.focus();
      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.stopPropagation(); annEditingId = null; annRenderDrawer(); }
      });
      bodyEl.querySelector(".ann-row-save").addEventListener("click", () => {
        const body = box.value.trim();
        annEditingId = null;
        if (!body) { annRenderDrawer(); return; }
        fetch(api(cid), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        }).finally(annPoll);
      });
    });
  });
}
