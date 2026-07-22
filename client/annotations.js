// ═══ ANNOTATIONS (v0.8 review loop) ═══ — classic <script>, loaded after artifacts.js, before app.js.
// The production side of the inline review loop: selection-gesture comments on markdown
// previews, segmented <mark> highlights driven by a rendered-text flatten index, the
// hover/pinned comment card, the bottom-right floating bar (driven purely off the server
// summary), and the comment drawer. The server (server/annotations.js) owns all state —
// this file only paints GET responses and calls the dedicated endpoints; it never
// derives batch state itself.
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
let annPending = null;    // selection captured at FAB time: { container, path, selected, ordinal, rendered }
let annCardEl = null;     // hover/pinned comment card (D4)
let annCardPinned = false; // pinned via click/Enter — poll repaints must not clobber it
let annCardMark = null;   // the <mark> the card is anchored to
let annCardShowT = null;  // 150ms hover-intent timer
let annCardHideT = null;  // grace timer so the pointer can travel into the card
// ── rail state (P1, design-notes/comment-rail-spec.md) ──
let annRailEl = null;       // mounted .ann-rail (inside the active .md-preview), or null
let annRailActiveId = null; // exact-aligned + accented card (R4); survives rebuilds
let annRailBusy = false;    // edit card or composer open — poll repaints leave the rail DOM alone (R6)
let annRailLive = null;     // the live busy element, preserved across preview rebuilds:
                            // { el, kind: "composer"|"edit", id, anchorY?, path? }
let annRailRO = null;       // ResizeObserver re-evaluating R1 on preview width flips
let annRailROTarget = null;
// Layout floor: the top-right corner of the preview is overlaid by the
// .md-toggle / artifact-actions chrome (absolute, ~30px tall) — cards pinned
// at the raw top would sit under it and be unclickable.
const ANN_RAIL_FLOOR = 36;

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
    // Split layouts force activeTab to "terminal" (app.js cycleLayout) and render
    // artifact tabs as panes instead — without this fallback the whole annotation
    // system silently no-ops in vsplit/hsplit (the bug Yuda hit for two days).
    // Among the open markdown artifact tabs, prefer one whose pane currently has
    // a VISIBLE PREVIEW (tab order alone could bind annCtx to a pane sitting in
    // edit mode while another pane's preview goes unannotated — codex delta P1);
    // when none has rendered yet (async first paint), fall back to the first md
    // tab and let annotationsOnPreviewRendered re-sync when a preview appears.
    // Multi-md splits get one annotated pane (documented limitation).
    if (!next && activeSessionId && typeof layoutMode === "string" && layoutMode !== "tabs" && typeof getOpenTabs === "function") {
      const s = sessions.find((x) => x.id === activeSessionId);
      const mdPaths = [];
      for (const tab of (s ? getOpenTabs(s) : [])) {
        if (typeof tab.id !== "string" || !tab.id.startsWith("artifact:")) continue;
        const art = s.artifacts?.[parseInt(tab.id.split(":")[1])];
        if (art && art.type === "file" && isMarkdownFile(art.value)) mdPaths.push(art.value);
      }
      const preferred = mdPaths.find((p) => annVisiblePreviewFor(p));
      const pick = preferred || mdPaths[0];
      if (pick) next = { sessionId: s.id, path: pick };
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
  annCardHide();
  annRailTeardown();
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
// A rebuild also invalidates any selection captured against the OLD DOM: a pending
// FAB is silently dropped (nothing typed yet), while an open composer keeps the
// user's text and revalidates the anchor at Add time (see annOpenComposer).
let annDomEpoch = 0;
function annotationsOnPreviewRendered(container, filePath) {
  // The rail composer holds its spec by closure (annPending may already be null),
  // so it needs its own epoch bump — same staleness contract as the popover.
  const railComposer = annRailLive?.kind === "composer" && annRailLive.path === filePath;
  if ((annPending && annPending.path === filePath) || railComposer) {
    annDomEpoch++;
    if (!annPopEl && !railComposer) { annPending = null; annHideFab(); }
  }
  if (annCtx && filePath === annCtx.path) annRenderUI();
  // Split mode: a preview just rendered for a DIFFERENT path than the bound
  // context (async first paint, or an edit→preview toggle on the pane the
  // tab-order fallback skipped). Re-derive — the sync prefers a path with a
  // visible preview and no-ops when the pick is unchanged, so this can't loop.
  else if (typeof layoutMode === "string" && layoutMode !== "tabs" &&
           (!annCtx || annCtx.path !== filePath)) {
    annotationsSyncPolling();
  }
}

// ── DOM lookup ──
// The preview container can be the cached artifact element or a split pane; ignore
// anything stashed in the offscreen pool or display:none.
function annVisibleContainerFor(path) {
  for (const el of document.querySelectorAll("[data-md-path]")) {
    if (el.dataset.mdPath !== path) continue;
    if (el.closest("#artifact-pool")) continue;
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
    return el;
  }
  return null;
}

// Split-context preference: a path only counts as "paintable" when its visible
// container is actually showing a PREVIEW (an edit-mode pane has no marks to paint).
function annVisiblePreviewFor(path) {
  const el = annVisibleContainerFor(path);
  return el && el.dataset.mdMode === "preview" ? el : null;
}

function annFindContainer() {
  return annCtx ? annVisibleContainerFor(annCtx.path) : null;
}

function annRenderUI() {
  if (!annCtx) return;
  // Split mode: the bound pane may have flipped to edit mode AFTER binding —
  // re-derive (runs on every 3s poll) so a sibling pane with a live preview
  // isn't left unannotated. Same pick → sync no-ops and we fall through.
  if (typeof layoutMode === "string" && layoutMode !== "tabs" && !annVisiblePreviewFor(annCtx.path)) {
    const prev = annCtx;
    annotationsSyncPolling();
    if (annCtx !== prev) return; // re-bound (its own poll renders) or dropped
  }
  // A preview rebuild can orphan the hover card's mark; drop the card unless the
  // user pinned it (they may be mid-edit — Save works by id, not by DOM position).
  if (annCardMark && !annCardMark.isConnected && !annCardPinned) annCardHide();
  const container = annFindContainer();
  if (container) {
    annRenderBar(container);
    annApplyMarks(container);
    annRenderRail(container); // after the painter — card anchor Y comes from the marks
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

// ── flatten index ──
// The shared substrate for anchor creation (D2) and the painter (D3): one TreeWalker
// pass over the preview's text nodes yields `flat` (raw concatenation + a segment
// table back to nodes) and `norm` (whitespace runs collapsed to one space, PLUS a
// virtual single space between adjacent text nodes whose nearest BLOCK ancestors
// differ — rendered blocks have no whitespace in `flat`, but sel.toString() and the
// user's mental model have a break there). normToFlat maps every norm char back to a
// flat offset, so a match in norm space converts to node/offset ranges for wrapping.
const ANN_BLOCK_RE = /^(P|H[1-6]|LI|PRE|BLOCKQUOTE|TD|TH|TR|TABLE|THEAD|TBODY|UL|OL|DL|DT|DD|DIV|HR|SECTION|ARTICLE)$/;

function annFlattenPreview(preview) {
  const nearestBlock = (node) => {
    let el = node.parentElement;
    while (el && el !== preview) {
      if (ANN_BLOCK_RE.test(el.tagName)) return el;
      el = el.parentElement;
    }
    return preview;
  };
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      // Our own chrome must never leak into the document text (marks are fine —
      // their text IS document text; the painter unwraps them before flattening).
      // .ann-rail lives INSIDE .md-preview, so it must be rejected here too.
      return n.parentElement?.closest(".ann-bar-wrap, .ann-card, .ann-rail")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const segs = [];          // [{ start, end, node }] in flat space
  let flat = "";
  let norm = "";
  const normToFlat = [];    // normToFlat[i] = flat offset of norm[i] (ws → run start)
  let pendingFlat = -1;     // -1 = no space owed; else flat offset where the ws run/boundary began
  let prevBlock = null;
  let node;
  while ((node = walker.nextNode())) {
    const start = flat.length;
    const text = node.nodeValue;
    flat += text;
    segs.push({ start, end: flat.length, node });
    const block = nearestBlock(node);
    if (prevBlock !== null && block !== prevBlock && norm.length && pendingFlat === -1) pendingFlat = start;
    prevBlock = block;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (/\s/.test(ch)) {
        if (norm.length && pendingFlat === -1) pendingFlat = start + k;
        continue;
      }
      if (pendingFlat !== -1) { norm += " "; normToFlat.push(pendingFlat); pendingFlat = -1; }
      norm += ch;
      normToFlat.push(start + k);
    }
  }
  return { segs, flat, norm, normToFlat };
}

// Whitespace-normalize a needle (trimmed) / a context slice (run-collapse only —
// keeping edge spaces matters: a raw prefix ending in "\n\n" must still meet the
// virtual block space in norm).
const annNormText = (s) => String(s).replace(/\s+/g, " ").trim();
const annNormCtx = (s) => String(s).replace(/\s+/g, " ");

// Flat offset of an arbitrary DOM boundary point (selection start). Text-node
// boundaries hit the segment table directly; element boundaries take the first text
// node at/after the point.
function annFlatPos(idx, container, offset) {
  for (const seg of idx.segs) {
    if (seg.node === container) return seg.start + Math.min(offset, seg.node.nodeValue.length);
  }
  const r = document.createRange();
  try { r.setStart(container, offset); r.collapse(true); } catch { return 0; }
  for (const seg of idx.segs) {
    try { if (r.comparePoint(seg.node, 0) >= 0) return seg.start; } catch {}
  }
  return idx.flat.length;
}

// First norm index whose flat offset is >= flatPos (normToFlat is monotonic).
function annNormPosOfFlat(idx, flatPos) {
  const a = idx.normToFlat;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < flatPos) lo = mid + 1; else hi = mid; }
  return lo;
}

function annNormCandidates(norm, needle) {
  const out = [];
  if (!needle) return out;
  let i = norm.indexOf(needle);
  while (i !== -1) { out.push(i); i = norm.indexOf(needle, i + 1); }
  return out;
}

// ── highlights (painter v2) ──
// Locate every active text-anchor comment in NORM space and wrap the covered flat
// ranges per text node — selections across headings/paragraphs/inline formatting all
// paint. Honesty rule: a comment whose occurrence can't be disambiguated (context →
// rOrdinal → single candidate, in that order) paints NOTHING — a wrong mark is worse
// than none. Server anchorStatus is a raw-space verdict; the painter trusts its own
// rendered-space lookup (the preview is what the user is actually reading).
function annLocateInNorm(idx, anchor) {
  const needle = annNormText(anchor.exact || "");
  if (!needle) return null;
  const cands = annNormCandidates(idx.norm, needle);
  if (!cands.length) return null;
  // Rendered context when present; legacy anchors reuse raw prefix/suffix normalized.
  const pre = anchor.rPrefix !== undefined ? anchor.rPrefix
    : anchor.prefix !== undefined ? annNormCtx(anchor.prefix) : undefined;
  const suf = anchor.rSuffix !== undefined ? anchor.rSuffix
    : anchor.suffix !== undefined ? annNormCtx(anchor.suffix) : undefined;
  if (pre !== undefined || suf !== undefined) {
    const hit = cands.filter((s) => {
      const okP = !pre || idx.norm.slice(Math.max(0, s - pre.length), s) === pre;
      const okS = !suf || idx.norm.startsWith(suf, s + needle.length);
      return okP && okS;
    });
    if (hit.length === 1) return { s: hit[0], e: hit[0] + needle.length };
    // Context present but ZERO hits: the neighborhood changed since creation.
    // A single occurrence can't lie (the needle IS the commented text) — paint
    // it. With several occurrences a stale rOrdinal could repoint at the wrong
    // one — paint nothing.
    if (hit.length === 0) {
      return cands.length === 1 ? { s: cands[0], e: cands[0] + needle.length } : null;
    }
    // ≥2 context hits = true identical-context duplicates: the ordinal pick is
    // trustworthy only if it lands on one of the hits.
    if (Number.isInteger(anchor.rOrdinal) && anchor.rOrdinal >= 0 && anchor.rOrdinal < cands.length) {
      const s = cands[anchor.rOrdinal];
      if (hit.includes(s)) return { s, e: s + needle.length };
    }
    return null; // ambiguous → paint nothing
  }
  if (Number.isInteger(anchor.rOrdinal) && anchor.rOrdinal >= 0 && anchor.rOrdinal < cands.length) {
    const s = cands[anchor.rOrdinal];
    return { s, e: s + needle.length };
  }
  if (cands.length === 1) return { s: cands[0], e: cands[0] + needle.length };
  return null; // ambiguous → paint nothing
}

function annApplyMarks(container) {
  const preview = container.querySelector(".md-preview");
  if (!preview) return;
  if (annCardPinned) return; // a pinned/editing card must not be clobbered by the 3s poll
  const want = (annData?.current || []).filter((c) => c.anchor?.type === "text");
  // Signature covers everything that can move a mark (the old id:bodyLength sig
  // missed anchor/status changes).
  const sig = want.map((c) => JSON.stringify([c.id, c.state, c.anchor.exact, c.anchor.rOrdinal ?? null,
    c.anchor.rPrefix ?? null, c.anchor.rSuffix ?? null, c.anchor.prefix ?? null, c.anchor.suffix ?? null,
    c.anchorStatus])).sort().join("|");
  if (preview.dataset.annSig === sig &&
      (preview.querySelector("mark.ann-mark") || preview.dataset.annPainted === "0")) return;

  // Unwrap stale marks, then re-mark from scratch (a reload already gave us a clean DOM).
  preview.querySelectorAll("mark.ann-mark").forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  preview.normalize();
  preview.dataset.annSig = sig;

  const idx = annFlattenPreview(preview);       // ONE flatten per repaint
  const intervals = [];                          // [{ fs, fe, id }] in flat space
  for (const c of want) {
    const loc = annLocateInNorm(idx, c.anchor);
    if (!loc) continue;
    // Norm endpoints are non-space chars (needle is trimmed), so they map exactly.
    intervals.push({ fs: idx.normToFlat[loc.s], fe: idx.normToFlat[loc.e - 1] + 1, id: c.id });
  }
  preview.dataset.annPainted = String(intervals.length);
  if (!intervals.length) return;

  // Split overlaps into atomic pieces, each carrying the id set that covers it.
  const bounds = [...new Set(intervals.flatMap((iv) => [iv.fs, iv.fe]))].sort((a, b) => a - b);
  const pieces = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const ps = bounds[b], pe = bounds[b + 1];
    const ids = intervals.filter((iv) => iv.fs <= ps && iv.fe >= pe).map((iv) => iv.id);
    if (ids.length) pieces.push({ ps, pe, ids });
  }

  // Wrap per text node, per piece — right-to-left within each node so earlier
  // offsets stay valid after surroundContents splits the node.
  for (const seg of idx.segs) {
    const local = pieces
      .map((p) => ({ a: Math.max(p.ps, seg.start) - seg.start, b: Math.min(p.pe, seg.end) - seg.start, ids: p.ids }))
      .filter((p) => p.a < p.b)
      .sort((x, y) => y.a - x.a);
    for (const p of local) {
      if (!/\S/.test(seg.node.nodeValue.slice(p.a, p.b))) continue; // inter-block "\n" nodes: nothing to see
      const range = document.createRange();
      range.setStart(seg.node, p.a);
      range.setEnd(seg.node, p.b);
      const mark = document.createElement("mark");
      mark.className = "ann-mark";
      mark.dataset.annId = p.ids[0];             // primary id (first located)
      mark.dataset.annIds = p.ids.join(" ");
      mark.tabIndex = 0;                          // keyboard: Tab to it, Enter opens the card
      annWireMark(mark);
      try { range.surroundContents(mark); } catch {}
    }
  }
}

// ── selection gesture ──
// No comment mode: a non-empty selection inside a .md-preview floats the 💬 button
// (Google-Docs style). The selection context — including the rendered-space anchor
// fields — is captured at FAB time because the click that follows collapses the
// selection (and a poll repaint could rebuild the nodes under the range).
document.addEventListener("mouseup", (e) => {
  if (e.target.closest?.(".ann-fab, .ann-popover, .ann-drawer, .ann-bar-wrap, .ann-card, .ann-rail")) return;
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
  if (elem?.closest?.(".ann-rail")) return; // rail is inside the preview — its text is not document text
  // Rail composer anchor Y (R5): top of the selection's FIRST rect, in preview
  // scroll coordinates. Captured now — the FAB click collapses the selection.
  let railY = 0;
  try {
    const first = range.getClientRects()[0] || range.getBoundingClientRect();
    railY = first.top - preview.getBoundingClientRect().top + preview.scrollTop;
  } catch {}
  annPending = {
    container,
    path: container.dataset.mdPath,
    selected,
    railY,
    ordinal: annSelectionOrdinal(preview, range, selected),
    rendered: annRenderedAnchor(preview, range, selected), // null only when unlocatable
  };
  // D1: follow the release point when the event has plausible coords. Synthetic
  // mouseups (tests) carry clientX/Y 0 → fall back to the LAST client rect of the
  // range — the visual end of the selection. Never getBoundingClientRect: its right
  // edge is meaningless for multi-line selections (today's far-right-FAB bug).
  let x, y;
  if ((e.clientX || e.clientY) && e.clientX >= 0 && e.clientY >= 0 &&
      e.clientX <= window.innerWidth && e.clientY <= window.innerHeight) {
    x = e.clientX + 8; y = e.clientY + 8;
  } else {
    const rects = range.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    x = last.right + 6; y = last.bottom + 6;
  }
  annShowFab(x, y);
});

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest?.(".ann-fab")) annHideFab();
  if (annPopEl && !e.target.closest?.(".ann-popover, .ann-fab")) annClosePopover();
  if (annCardEl && !e.target.closest?.(".ann-card, mark.ann-mark")) annCardHide();
  // R4: clicking anywhere outside a mark or the rail clears the active card
  // (mark clicks re-activate on the click event that follows this mousedown).
  if (annRailActiveId && annRailOn() && !e.target.closest?.(".ann-rail, mark.ann-mark")) annRailActivate(null);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (annCardEl) annCardHide();
  if (annRailActiveId) annRailActivate(null);
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

// Map the selection to the RAW markdown — the server's fast relocation path
// (preview text ≠ raw: headings lose #, lists lose bullets...). Best-effort heuristic:
//   1. the selected string must appear verbatim in mdRaw (plain inline text does;
//      selections spanning formatting like **bold** or list markers won't);
//   2. pick the occurrence by the rendered ordinal computed above (falls back to the
//      first when raw has fewer occurrences);
//   3. prefix/suffix = 32 raw chars around it, the server's disambiguator.
// Returns null when (1) fails — the rendered-space fields (annRenderedAnchor) then
// carry the anchor alone.
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

// D2: rendered-space anchor fields, computed against the flatten index at gesture
// time. rOrdinal is what keeps duplicate text honest — the client KNOWS which
// occurrence the user selected (the selection start pins it down); the painter and
// (post-D5) the server just replay that choice. Returns null only when the selection
// can't be found in the flatten index at all (→ doc-comment degradation).
function annRenderedAnchor(preview, range, selected) {
  try {
    const idx = annFlattenPreview(preview);
    const needle = annNormText(selected);
    const cands = annNormCandidates(idx.norm, needle);
    if (!cands.length) return null;
    const normStart = annNormPosOfFlat(idx, annFlatPos(idx, range.startContainer, range.startOffset));
    let best = 0;
    for (let k = 1; k < cands.length; k++) {
      if (Math.abs(cands[k] - normStart) < Math.abs(cands[best] - normStart)) best = k;
    }
    const s = cands[best], e = s + needle.length;
    const out = { rOrdinal: best };
    const rPrefix = idx.norm.slice(Math.max(0, s - 32), s);
    const rSuffix = idx.norm.slice(e, e + 32);
    if (rPrefix) out.rPrefix = rPrefix;
    if (rSuffix) out.rSuffix = rSuffix;
    return out;
  } catch { return null; }
}

// ── FAB + composer popover ──
// Clamp a fixed-position element fully inside the viewport (measure AFTER display).
function annClampToViewport(el, x, y, pad = 6) {
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - w - pad))}px`;
  el.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - h - pad))}px`;
}

function annShowFab(x, y) {
  if (!annFabEl) {
    annFabEl = document.createElement("div");
    annFabEl.className = "ann-fab";
    annFabEl.textContent = "💬 Comment";
    annFabEl.addEventListener("click", () => {
      const p = annPending;
      const fx = parseFloat(annFabEl.dataset.x), fy = parseFloat(annFabEl.dataset.y);
      annHideFab();
      if (!p) return;
      // R5: rail active for this preview → composer card in the rail; otherwise
      // the P0 floating popover path runs unchanged (narrow fallback included).
      if (annRailOn() && annRailEl.closest("[data-md-path]") === p.container) annOpenRailComposer(p);
      else annOpenComposer(p, fx, fy);
    });
    document.body.appendChild(annFabEl);
  }
  annFabEl.style.display = "block";
  annClampToViewport(annFabEl, x, y);
  annFabEl.dataset.x = parseFloat(annFabEl.style.left);
  annFabEl.dataset.y = parseFloat(annFabEl.style.top);
}

function annHideFab() {
  if (annFabEl) annFabEl.style.display = "none";
}

// One composer for both gestures: `spec.selected` set → text anchor, absent →
// whole-doc comment. Degradation to a doc comment happens ONLY when the selection is
// findable neither in the raw markdown nor in the flatten index (near-impossible) —
// and then the composer says so up front instead of silently downgrading.
function annOpenComposer(spec, x, y) {
  annClosePopover();
  const epoch = annDomEpoch; // stale ⇢ the preview rebuilt while the composer was open
  const rawAnchor = spec.selected ? annBuildTextAnchor(spec.container, spec.selected, spec.ordinal) : null;
  const degraded = !!spec.selected && !rawAnchor && !spec.rendered;
  const pop = document.createElement("div");
  pop.className = "ann-popover";
  pop.innerHTML = `
    ${spec.selected ? `<div class="ann-pop-quote">${esc(spec.selected.length > 90 ? spec.selected.slice(0, 87) + "…" : spec.selected)}</div>` : `<div class="ann-pop-quote ann-pop-quote-doc">Whole document</div>`}
    ${degraded ? `<div class="ann-pop-degraded">⚠ 无法精确锚定 — 将作为整篇评论</div>` : ""}
    <textarea class="ann-pop-body" placeholder="Leave a comment for the agent…"></textarea>
    <div class="ann-pop-actions"><span class="ann-pop-hint">Esc to cancel</span><button class="ann-pop-add">Add</button></div>`;
  document.body.appendChild(pop);
  annClampToViewport(pop, x, y);
  annPopEl = pop;

  const ta = pop.querySelector(".ann-pop-body");
  ta.focus();
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); annClosePopover(); }
  });
  pop.querySelector(".ann-pop-add").addEventListener("click", () => {
    if (annComposerSubmit(spec, epoch, rawAnchor, degraded, ta.value)) annClosePopover();
  });
}

// Shared Add handler for both composers (floating popover + rail card): the P0
// creation honesty rules live here so the rail can't drift from them.
// Returns false when there is nothing to submit (empty body / no session).
function annComposerSubmit(spec, epoch, rawAnchor, degraded, bodyText) {
  let body = String(bodyText || "").trim();
  if (!body || !activeSessionId) return false;
  // The preview rebuilt while the user typed (agent write → mtime reload): the
  // captured selection/context describe a DOM that no longer exists. Keep the
  // typed comment, but re-derive the anchor against the CURRENT preview — only
  // a now-unique occurrence is safe to anchor; otherwise degrade to doc+quote
  // rather than risk pointing at the wrong occurrence.
  let raw = rawAnchor, rendered = spec.rendered, stale = false;
  if (spec.selected && epoch !== annDomEpoch) {
    stale = true;
    raw = annBuildTextAnchor(spec.container, spec.selected, 0);
    rendered = null;
    const preview = spec.container.querySelector(".md-preview");
    if (preview) {
      const idx = annFlattenPreview(preview);
      const cands = annNormCandidates(idx.norm, annNormText(spec.selected));
      if (cands.length === 1) {
        const s = cands[0], e = s + annNormText(spec.selected).length;
        rendered = { rOrdinal: 0 };
        const rPrefix = idx.norm.slice(Math.max(0, s - 32), s);
        const rSuffix = idx.norm.slice(e, e + 32);
        if (rPrefix) rendered.rPrefix = rPrefix;
        if (rSuffix) rendered.rSuffix = rSuffix;
      }
    }
  }
  let anchor = { type: "doc" };
  if (spec.selected && (stale ? rendered : !degraded)) {
    anchor = raw || { type: "text", exact: spec.selected };
    if (rendered) { // rendered-space fields ride along whenever we have them
      if (rendered.rPrefix) anchor.rPrefix = rendered.rPrefix;
      if (rendered.rSuffix) anchor.rSuffix = rendered.rSuffix;
      anchor.rOrdinal = rendered.rOrdinal;
    }
  } else if (spec.selected) {
    body = `> ${spec.selected}\n\n${body}`; // truly unlocatable: quote it instead
  }
  fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: spec.path, anchor, body }),
  }).finally(annPoll);
  return true;
}

function annClosePopover() {
  if (annPopEl) { annPopEl.remove(); annPopEl = null; }
}

// ── hover card (D4) ──
// The in-context surface replacing the native title tooltip and the drawer hunt:
// hover a mark (~150ms intent delay, grace period to travel into the card) → floating
// card with the comment body + state chip. Click/Enter pins it; a pinned draft is
// editable in place (Save/Cancel/Delete → existing endpoints → annPoll). Marks
// carrying several ids show a chooser first. Esc or an outside click unpins.
// While the rail is mounted it supersedes the floating card (two surfaces for the
// same data is noise) — the listeners stay, the routing decision is per-event.
function annWireMark(mark) {
  mark.addEventListener("mouseenter", () => {
    if (annRailOn()) annRailMarkHover(mark, true);
    else annCardHoverIn(mark);
  });
  mark.addEventListener("mouseleave", () => {
    if (annRailOn()) annRailMarkHover(mark, false);
    else annCardHoverOut();
  });
  mark.addEventListener("focus", () => { if (!annRailOn()) annCardHoverIn(mark); });
  const open = (e) => {
    e.stopPropagation();
    // Multi-id mark → first id becomes active; all its cards are visible anyway.
    if (annRailOn()) annRailActivate((mark.dataset.annIds || mark.dataset.annId || "").split(/\s+/)[0]);
    else annCardShow(mark, true);
  };
  mark.addEventListener("click", open);
  mark.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); open(e); }
  });
}

function annCardHoverIn(mark) {
  if (annCardPinned) return;
  clearTimeout(annCardHideT); annCardHideT = null;
  clearTimeout(annCardShowT);
  annCardShowT = setTimeout(() => annCardShow(mark, false), 150);
}

function annCardHoverOut() {
  clearTimeout(annCardShowT);
  if (!annCardPinned) annCardScheduleHide();
}

function annCardScheduleHide() {
  clearTimeout(annCardHideT);
  annCardHideT = setTimeout(() => { if (!annCardPinned) annCardHide(); }, 250);
}

function annCardHide() {
  clearTimeout(annCardShowT);
  clearTimeout(annCardHideT);
  annCardPinned = false;
  annCardMark = null;
  if (annCardEl) { annCardEl.remove(); annCardEl = null; }
}

function annCardEnsure() {
  if (annCardEl) return annCardEl;
  const el = document.createElement("div");
  el.className = "ann-card";
  el.addEventListener("mouseenter", () => { clearTimeout(annCardHideT); });
  el.addEventListener("mouseleave", () => { if (!annCardPinned) annCardScheduleHide(); });
  document.body.appendChild(el);
  annCardEl = el;
  return el;
}

function annCardShow(mark, pin, onlyId) {
  const ids = (mark.dataset.annIds || mark.dataset.annId || "").split(/\s+/).filter(Boolean);
  const all = [...(annData?.current || []), ...(annData?.others || [])];
  let comments = ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  if (onlyId) comments = comments.filter((c) => c.id === onlyId);
  if (!comments.length) { annCardHide(); return; }
  const el = annCardEnsure();
  annCardMark = mark;
  annCardPinned = !!pin;

  const chip = (c) => `<span class="ann-chip ${c.state === "draft" ? "ann-chip-draft" : "ann-chip-sent"}">${c.state === "draft" ? "draft" : "已发送"}</span>`;

  if (comments.length > 1) {
    // Multi-id mark: compact list; picking a row opens (and pins) that comment's card.
    el.innerHTML = comments.map((c) => `
      <div class="ann-card-choice" data-ann-id="${esc(c.id)}">
        ${chip(c)}
        <span class="ann-card-choice-body">${esc(c.body.length > 64 ? c.body.slice(0, 61) + "…" : c.body)}</span>
      </div>`).join("");
    el.querySelectorAll(".ann-card-choice").forEach((row) => {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        annCardShow(mark, true, row.dataset.annId);
      });
    });
  } else {
    const c = comments[0];
    if (pin && c.state === "draft") {
      // Pinned draft: edit in place. The annCardPinned guard keeps the 3s poll from
      // rebuilding marks/drawer under the textarea.
      el.innerHTML = `
        <div class="ann-card-head">${chip(c)}</div>
        <textarea class="ann-card-edit"></textarea>
        <div class="ann-card-actions">
          <button class="ann-card-btn ann-card-del">Delete</button>
          <span class="ann-pop-hint">Esc to cancel</span>
          <button class="ann-card-btn ann-card-cancel">Cancel</button>
          <button class="ann-card-btn ann-card-save">Save</button>
        </div>`;
      const api = `/api/sessions/${encodeURIComponent(annCtx.sessionId)}/annotations/${encodeURIComponent(c.id)}`;
      const box = el.querySelector(".ann-card-edit");
      box.value = c.body;
      box.focus();
      box.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.stopPropagation(); annCardHide(); }
      });
      el.querySelector(".ann-card-save").addEventListener("click", () => {
        const body = box.value.trim();
        if (!body) return;
        fetch(api, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) })
          .finally(() => { annCardHide(); annPoll(); });
      });
      el.querySelector(".ann-card-cancel").addEventListener("click", () => annCardHide());
      el.querySelector(".ann-card-del").addEventListener("click", () => {
        fetch(api, { method: "DELETE" }).finally(() => { annCardHide(); annPoll(); });
      });
    } else {
      // Hover, or pinned sent: read-only.
      el.innerHTML = `
        <div class="ann-card-head">${chip(c)}</div>
        <div class="ann-card-body">${esc(c.body)}</div>`;
    }
  }
  el.style.display = "block";
  const r = mark.getBoundingClientRect();
  annClampToViewport(el, r.left, r.bottom + 6);
}

// ── comment rail (P1 — GDocs-style margin cards) ──
// Permanent, in-context surface for every comment on the current file: cards in a
// width-adaptive column INSIDE .md-preview (they scroll with content for free),
// vertically aligned with their highlights via the pure annRailLayout
// (client/ann-rail-layout.js, loaded as a module that exposes window.annRailLayout).
// Renders only when the container is in preview mode, the preview is ≥560px wide,
// and there is something to show (R1); below that the P0 surfaces (hover card +
// popover composer) take over unchanged. While mounted, the rail supersedes the
// floating hover card — annWireMark routes mark events here at event time.
// The 560px floor + adaptive width exist for SPLIT layouts: a side-by-side
// terminal|artifact split on a laptop gives the preview ~600px, and that pane is
// exactly where the review loop (comment → send → watch the agent) lives.
const ANN_RAIL_MIN_PREVIEW = 560;
function annRailWidth(preview) {
  return Math.max(190, Math.min(260, Math.round(preview.clientWidth * 0.30)));
}
function annRailOn() {
  return !!(annRailEl && annRailEl.isConnected);
}

function annRenderRail(container) {
  const preview = container.querySelector(".md-preview");
  if (preview) annRailObserve(preview);
  const want = preview && container.dataset.mdMode === "preview" &&
    preview.clientWidth >= ANN_RAIL_MIN_PREVIEW &&
    ((annData?.current?.length || 0) > 0 || annRailLive?.kind === "composer");
  if (!want) { annRailUnmount(); return; }
  // R6: a live edit/composer card must not be clobbered by a poll repaint — leave
  // the rail DOM alone (data changes apply on the next poll after busy clears).
  // A preview REBUILD destroys the rail wholesale though; then fall through to a
  // re-mount, which re-inserts the live element (same node, text intact).
  if (annRailBusy && annRailEl && annRailEl.parentElement === preview) {
    annRailPosition(preview); // the busy card may have grown — reposition only
    return;
  }
  annRailBuild(preview);
}

// R1: re-evaluate on preview resize (width flips across the mount threshold, and
// the adaptive rail width tracks the pane — split handles are user-draggable).
// clientWidth is the padding box, so our own padding-right can't oscillate it.
function annRailObserve(preview) {
  if (annRailROTarget === preview) return;
  if (!annRailRO) {
    annRailRO = new ResizeObserver(() => {
      const c = annFindContainer();
      if (c) annRenderRail(c);
    });
  }
  if (annRailROTarget) { try { annRailRO.unobserve(annRailROTarget); } catch {} }
  annRailRO.observe(preview);
  annRailROTarget = preview;
}

// Unmount keeps composer/edit/active state — nothing is lost on a width flip
// (R1): the live composer or edit card (with the user's typed text) is held in
// annRailLive and re-inserts when the rail comes back. While narrow, the edit
// UI is simply not visible — the P0 surfaces take over for new gestures.
function annRailUnmount() {
  if (annRailEl) { annRailEl.remove(); annRailEl = null; }
  document.querySelectorAll(".md-preview.ann-rail-open").forEach((p) => {
    p.classList.remove("ann-rail-open");
    p.style.removeProperty("--ann-rail-w");
  });
  document.querySelectorAll(".ann-rail-host").forEach((el) => {
    el.classList.remove("ann-rail-host");
    el.style.removeProperty("--ann-rail-w");
  });
}

// The one place live busy state (edit/composer) is dropped — also releases the
// textarea ResizeObserver so it can't fire against a dead card.
function annRailLiveClear() {
  if (annRailLive?.ro) { try { annRailLive.ro.disconnect(); } catch {} }
  annRailLive = null;
  annRailBusy = false;
}

function annRailTeardown() {
  annRailUnmount();
  annRailActiveId = null;
  annRailLiveClear();
  if (annRailRO) { annRailRO.disconnect(); annRailRO = null; annRailROTarget = null; }
}

function annRailBuild(preview) {
  // Adaptive width (R1): 30% of the pane, clamped 190–260px. Inline styles +
  // a CSS var (consumed by .ann-rail / .ann-rail-open / the bar shift) so one
  // number drives all three; set BEFORE measuring marks.
  const w = annRailWidth(preview);
  preview.style.setProperty("--ann-rail-w", `${w}px`);
  preview.classList.add("ann-rail-open");
  // Host class on the container shifts the floating bar clear of the rail column.
  const host = preview.closest("[data-md-path]");
  if (host) { host.classList.add("ann-rail-host"); host.style.setProperty("--ann-rail-w", `${w}px`); }
  if (!annRailEl || annRailEl.parentElement !== preview) {
    if (annRailEl) annRailEl.remove();
    annRailEl = document.createElement("div");
    annRailEl.className = "ann-rail";
    preview.appendChild(annRailEl);
  }
  const rail = annRailEl;
  const pRect = preview.getBoundingClientRect();
  const yOf = (el) => el.getBoundingClientRect().top - pRect.top + preview.scrollTop;

  // R2 sections: doc comments, anchored (sorted by highlight Y), orphans — text
  // comments with no painted mark THIS repaint (the painter's honesty rule and
  // server-orphaned anchors both land here).
  const docs = [], anchored = [], orphans = [];
  for (const c of annData?.current || []) {
    if (c.anchor?.type === "doc") { docs.push(c); continue; }
    if (c.anchor?.type !== "text") continue;
    const m = preview.querySelector(`mark.ann-mark[data-ann-ids~="${CSS.escape(c.id)}"]`);
    if (m) anchored.push({ c, y: yOf(m) });
    else orphans.push(c);
  }
  anchored.sort((a, b) => a.y - b.y);

  // A live edit card is the SAME element across re-mounts in EVERY section —
  // doc, anchored, orphan — so the textarea and unsaved text survive preview
  // rebuilds no matter where the comment lives (R6). Section normalization
  // (classes/top/railY) happens at each insertion site because a comment can
  // change sections between rebuilds (e.g. its mark vanished → orphan).
  const liveEditFor = (id) =>
    (annRailBusy && annRailLive?.kind === "edit" && annRailLive.id === id) ? annRailLive.el : null;

  // Build hidden → measure → position → reveal (R3 anti-flicker).
  rail.style.visibility = "hidden";
  rail.innerHTML = "";
  // Doc cards are layout ITEMS pinned to the rail top (anchorY 0, which the
  // layout floor clamps to ANN_RAIL_FLOOR), inserted first so the stable sort
  // keeps them ahead of same-Y anchored cards — one collision-aware pass
  // replaces the old in-flow section whose height clamped every anchorY (and
  // broke exact alignment near the top).
  for (const c of docs) {
    const el = liveEditFor(c.id) || annRailCard(c);
    el.classList.add("ann-rail-abs", "ann-rail-doc");
    el.dataset.railY = "0";
    rail.appendChild(el);
  }
  for (const { c, y } of anchored) {
    const el = liveEditFor(c.id) || annRailCard(c);
    el.classList.add("ann-rail-abs");
    el.classList.remove("ann-rail-doc");
    el.dataset.railY = String(y);
    rail.appendChild(el);
  }
  if (annRailLive?.kind === "composer") { // live composer survives preview rebuilds (R5)
    const el = annRailLive.el;
    el.classList.add("ann-rail-abs");
    el.dataset.railY = String(annRailLive.anchorY);
    rail.appendChild(el);
  }
  if (orphans.length) {
    const sec = document.createElement("div");
    sec.className = "ann-rail-orphsec ann-rail-abs";
    sec.innerHTML = `<div class="ann-rail-orphhead">⚠ 无法定位</div>`;
    for (const c of orphans) {
      const el = liveEditFor(c.id) || annRailCard(c, true);
      el.classList.remove("ann-rail-abs", "ann-rail-doc"); // in-flow inside the section
      el.style.top = "";
      delete el.dataset.railY;
      sec.appendChild(el);
    }
    rail.appendChild(sec);
  }
  annRailPosition(preview);
  annRailSyncActive();
  rail.style.visibility = "";
  // A re-mount that could NOT re-insert the live edit card (its comment vanished
  // from the data mid-edit) must also drop the busy state, or the rail would
  // skip every future rebuild and freeze.
  if (annRailLive?.kind === "edit" && !annRailLive.el.isConnected) annRailLiveClear();
  // A re-mount pulled the live textarea out of the DOM and dropped its focus on
  // <body>; give it back without stealing focus from anywhere real.
  if (annRailLive && document.activeElement === document.body) {
    annRailLive.el.querySelector("textarea")?.focus();
  }
}

// Measure heights, run the pure layout, write tops. The composer counts as the
// active card so it sits exactly at the selection's anchor Y. Doc cards ride
// along as items at anchorY 0; the layout's floor (0 = rail top) is the hard
// upper boundary, and exact alignment degrades to the minimal feasible Y when
// the cards above can't fit (see ann-rail-layout.js).
function annRailPosition(preview) {
  const rail = annRailEl;
  if (!rail || rail.parentElement !== preview) return;
  const items = [...rail.children]
    .filter((el) => el.classList.contains("ann-rail-abs") && !el.classList.contains("ann-rail-orphsec"))
    .map((el) => ({ id: el.dataset.railId, anchorY: parseFloat(el.dataset.railY) || 0, height: el.offsetHeight, el }))
    .sort((a, b) => a.anchorY - b.anchorY); // stable: doc cards stay first on ties
  const activeId = annRailLive?.kind === "composer" ? "__composer__" : annRailActiveId;
  const tops = typeof annRailLayout === "function"
    ? annRailLayout(items, activeId, { floor: ANN_RAIL_FLOOR }) : {};
  let maxBottom = 0;
  for (const it of items) {
    const t = tops[it.id] ?? it.anchorY;
    it.el.style.top = `${t}px`;
    maxBottom = Math.max(maxBottom, t + it.height);
  }
  // Orphan section trails the lowest card and is re-placed on every pass.
  const orph = rail.querySelector(":scope > .ann-rail-orphsec");
  if (orph) orph.style.top = `${maxBottom + 16}px`;
}

function annRailSyncActive() {
  if (!annRailEl) return;
  annRailEl.querySelectorAll(".ann-rail-card").forEach((el) => {
    el.classList.toggle("active", !!annRailActiveId && el.dataset.railId === annRailActiveId);
  });
}

// R4: activation = exact alignment (R3) + accent. The card lands at its mark's Y,
// so whenever the mark is on screen the card is too — no extra scrolling here.
function annRailActivate(id) {
  annRailActiveId = id || null;
  if (!annRailOn()) return;
  annRailSyncActive();
  annRailPosition(annRailEl.parentElement);
}

function annRailMarksFor(id) {
  const preview = annRailEl?.parentElement;
  if (!preview || !id) return [];
  return [...preview.querySelectorAll(`mark.ann-mark[data-ann-ids~="${CSS.escape(id)}"]`)];
}

// Mark hover → its cards get .hover (a mark may carry several ids → several cards).
function annRailMarkHover(mark, on) {
  if (!annRailEl) return;
  const ids = (mark.dataset.annIds || mark.dataset.annId || "").split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const card = annRailEl.querySelector(`.ann-rail-card[data-rail-id="${CSS.escape(id)}"]`);
    if (card) card.classList.toggle("hover", on);
  }
}

function annRailFlashMarks(marks) {
  for (const m of marks) {
    m.classList.add("ann-mark-flash");
    setTimeout(() => m.classList.remove("ann-mark-flash"), 1200);
  }
}

function annRailCard(c, orphan = false) {
  const el = document.createElement("div");
  el.className = "ann-rail-card";
  el.dataset.railId = c.id;
  const draft = c.state === "draft";
  const bad = c.anchor?.type === "text" && (c.anchorStatus === "ambiguous" || c.anchorStatus === "orphaned");
  // No quote/excerpt — the aligned highlight IS the quote — except orphans, which
  // have no highlight to point at and show locationText instead (R2).
  el.innerHTML = `
    <div class="ann-rail-head">
      <span class="ann-chip ${draft ? "ann-chip-draft" : "ann-chip-sent"}">${draft ? "draft" : "已发送"}</span>
      ${bad ? `<span class="ann-chip ann-chip-bad">⚠ ${esc(c.anchorStatus)}</span>` : ""}
      ${draft ? `<span class="ann-rail-act ann-rail-edit" title="Edit">✎</span><span class="ann-rail-act ann-rail-del" title="Delete">×</span>` : ""}
    </div>
    ${orphan ? `<div class="ann-rail-loc" title="${esc(c.locationText || "")}">${esc(c.locationText || "")}</div>` : ""}
    <div class="ann-rail-body">${esc(c.body)}</div>`;
  el.addEventListener("mouseenter", () => annRailMarksFor(c.id).forEach((m) => m.classList.add("ann-mark-hover")));
  el.addEventListener("mouseleave", () => annRailMarksFor(c.id).forEach((m) => m.classList.remove("ann-mark-hover")));
  el.addEventListener("click", (e) => {
    if (e.target.closest(".ann-rail-act, textarea, button")) return;
    annRailActivate(c.id);
    const marks = annRailMarksFor(c.id);
    if (marks.length) {
      marks[0].scrollIntoView({ block: "nearest" });
      annRailFlashMarks(marks); // same flash pattern as md links
    }
  });
  const api = () => `/api/sessions/${encodeURIComponent(annCtx.sessionId)}/annotations/${encodeURIComponent(c.id)}`;
  el.querySelector(".ann-rail-del")?.addEventListener("click", (e) => {
    e.stopPropagation();
    fetch(api(), { method: "DELETE" }).finally(annPoll);
  });
  el.querySelector(".ann-rail-edit")?.addEventListener("click", (e) => {
    e.stopPropagation();
    annRailEditCard(el, c);
  });
  return el;
}

// R6: ✎ on a draft → edit in place. annRailBusy keeps poll repaints from
// rebuilding the rail under the textarea (annApplyMarks may still repaint marks).
function annRailEditCard(card, c) {
  annRailBusy = true;
  annRailLive = { el: card, kind: "edit", id: c.id };
  card.classList.add("ann-rail-editing");
  card.innerHTML = `
    <div class="ann-rail-head"><span class="ann-chip ann-chip-draft">draft</span></div>
    <textarea class="ann-rail-editbox"></textarea>
    <div class="ann-pop-actions">
      <button class="ann-card-btn ann-card-del">Delete</button>
      <span class="ann-pop-hint">Esc to cancel</span>
      <button class="ann-card-btn ann-card-cancel">Cancel</button>
      <button class="ann-card-btn ann-card-save">Save</button>
    </div>`;
  const api = `/api/sessions/${encodeURIComponent(annCtx.sessionId)}/annotations/${encodeURIComponent(c.id)}`;
  const box = card.querySelector(".ann-rail-editbox");
  box.value = c.body;
  // The textarea is user-resizable (resize: vertical) — reflow the cards below
  // as it grows, or they'd overlap the expanded editor.
  annRailLive.ro = new ResizeObserver(() => annRailPosition(annRailEl?.parentElement));
  annRailLive.ro.observe(box);
  // Owner-scoped cleanup: a Save/Delete completion may settle AFTER this edit
  // was superseded (file switch tore it down, or the user opened another
  // edit/composer). Clearing whatever annRailLive holds at completion time
  // would kill the NEWER owner's textarea + ResizeObserver — only clear when
  // this edit still owns the live state.
  const owner = annRailLive;
  const done = () => {
    if (annRailLive !== owner) return;
    annRailLiveClear(); annRenderUI(); annPoll();
  };
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); done(); }
  });
  card.querySelector(".ann-card-save").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const body = box.value.trim();
    if (!body) return;
    fetch(api, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }).finally(done);
  });
  card.querySelector(".ann-card-cancel").addEventListener("click", (ev) => { ev.stopPropagation(); done(); });
  card.querySelector(".ann-card-del").addEventListener("click", (ev) => {
    ev.stopPropagation();
    fetch(api, { method: "DELETE" }).finally(done);
  });
  annRailPosition(annRailEl?.parentElement); // the card grew — reposition (R3)
  box.focus();
}

// R5: composer card in the rail at the selection's anchor Y. Same honesty rules
// as the popover — quote line, degraded warning, and the epoch-checked at-Add
// re-derivation all come from annComposerSubmit.
function annOpenRailComposer(spec) {
  annClosePopover();
  if (annRailLive?.kind === "composer") annCloseRailComposer(false);
  const epoch = annDomEpoch;
  const rawAnchor = spec.selected ? annBuildTextAnchor(spec.container, spec.selected, spec.ordinal) : null;
  const degraded = !!spec.selected && !rawAnchor && !spec.rendered;
  const el = document.createElement("div");
  el.className = "ann-rail-card ann-rail-composer";
  el.dataset.railId = "__composer__";
  const q = spec.selected.length > 90 ? spec.selected.slice(0, 87) + "…" : spec.selected;
  el.innerHTML = `
    <div class="ann-pop-quote">${esc(q)}</div>
    ${degraded ? `<div class="ann-pop-degraded">⚠ 无法精确锚定 — 将作为整篇评论</div>` : ""}
    <textarea class="ann-pop-body" placeholder="Leave a comment for the agent…"></textarea>
    <div class="ann-pop-actions"><span class="ann-pop-hint">Esc to cancel</span><button class="ann-pop-add">Add</button></div>`;
  const ta = el.querySelector(".ann-pop-body");
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); annCloseRailComposer(); }
  });
  el.querySelector(".ann-pop-add").addEventListener("click", () => {
    if (annComposerSubmit(spec, epoch, rawAnchor, degraded, ta.value)) annCloseRailComposer();
  });
  annRailLive = { el, kind: "composer", id: null, anchorY: spec.railY || 0, path: spec.path };
  annRailBusy = true;
  // Same resizable-textarea reflow as the edit card.
  annRailLive.ro = new ResizeObserver(() => annRailPosition(annRailEl?.parentElement));
  annRailLive.ro.observe(ta);
  const preview = spec.container.querySelector(".md-preview");
  if (preview) annRailBuild(preview); // direct build: this IS the busy element's mount
  ta.focus();
}

function annCloseRailComposer(rerender = true) {
  if (annRailLive?.kind !== "composer") return;
  annRailLiveClear();
  if (rerender) annRenderUI();
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
  if (annCardPinned) return; // same rule while a card is pinned/editing (D4 guard)
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
