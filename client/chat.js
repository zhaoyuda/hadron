// ═══ CHAT VIEW ═══ (tab "chat") — the agent's conversation rebuilt from claude's own
// transcript (server/conversation.js → GET /api/sessions/:id/conversation). Classic
// <script> loaded before app.js; reads app.js globals (esc, sessions, switchTab,
// timeAgo) and markdown.js's mdRender (marked + the DOM sanitizer) at call time.
//
// Model per agent (chatModels): items by id, placed by `ord`, replaced when their
// `rev` moves (a tool result landing bumps its assistant message). A poll asks
// `?after=rev` and pages with `nextAfter` until `more` is false; a `generation`
// or conversationId change (file replaced, /clear, resume) drops the picture and
// reloads. Scroll follows the tail only while the reader is at the bottom
// (autoScrollPaused: a wheel/scroll away pauses it, a "↓ N new" pill jumps back);
// programmatic scrolls are flagged so they never count as the reader's. Unchanged
// items are left alone (a selection in them and the reader's place survive every
// poll); only an item whose rev moved is re-rendered, with its open thinking /
// tool cards kept (m.open). The paging cursor (m.rev) advances only as far as the
// pages actually applied, so a tick cut at CHAT_PAGES_PER_TICK resumes where it
// stopped; a page fetched with a cursor the server no longer honours (new
// conversation, rebuilt cache: rev went backwards) drops the picture and refetches
// the tail in the same tick.
//
// Reading is stable (G2b): the reader's place is an anchor {id, offset} taken on
// every reader scroll while paused and restored when the tab is drawn again or
// the server rebuilt its cache of the SAME conversation (earlier pages are
// loaded until the anchored item is back, bounded); only a different
// conversation goes to the bottom. While following, every arrival — a
// multi-screen reply included — keeps the view at the bottom (the operator's
// call, 2026-11-08: "有输出之后应该默认往下翻"); only a reader who scrolled up
// is left alone, with the pill. An
// assistant message is patched block by block (data-sig): a block whose content
// did not change keeps its node, so a selection in it and an open Thinking
// survive a tool result landing on the same message; the pill counts items that
// arrived AND messages that grew a visible block while the reader was away.
// The live line claims only what the transcript records ("last activity 12s
// ago"), is replaced by "Needs input — Open Primary" while the pane is blocked
// and by an offline banner when the server cannot be reached; attention is
// acked from the chat tab only while the latest content is actually visible
// (chatAttentionVisible, read by app.js's ackTick).
const CHAT_POLL_MS = 1000;
const CHAT_PAGE = 200;
const CHAT_PAGES_PER_TICK = 5;
const CHAT_MODELS_MAX = 6; // pictures kept for agents not on screen (LRU)
const chatModels = new Map(); // sessionId → model, insertion order = recency
const chatPolls = new WeakMap(); // container → interval id
let chatExpandAll = false; // header toggle: every tool card open

function chatModel(sessionId) {
  let m = chatModels.get(sessionId);
  if (m) chatModels.delete(sessionId); else m = chatFreshModel(sessionId);
  chatModels.set(sessionId, m);
  while (chatModels.size > CHAT_MODELS_MAX) chatModels.delete(chatModels.keys().next().value);
  return m;
}
function chatFreshModel(sessionId) {
  return { sessionId, conversationId: null, generation: null, rev: null, items: new Map(), title: null, mode: null, permissionMode: null,
    firstOrd: null, evicted: 0, skipped: 0, orphanResults: 0, readable: true, complete: true, offline: false, reason: null, open: new Set(), paused: false, unseen: 0,
    anchor: null, // {id, offset}: the item at the top of the view and its offset from it, while paused
    rebuild: null, // during a same-conversation cache rebuild: { anchor, lastOrd } to restore once the tail is back
  };
}
const chatTeardown = new WeakMap(); // container → fn run when the view is left (flushes the draft)
function stopChatPoll(el) {
  const t = chatPolls.get(el); if (t) { clearInterval(t); chatPolls.delete(el); }
  const td = chatTeardown.get(el); if (td) { chatTeardown.delete(el); try { td(); } catch {} }
}
// Is the conversation's latest content on screen for this agent? app.js's dwell
// ack counts the chat tab as "looking at the agent" only when this holds: a
// reader scrolled up, a picture the server stopped answering for, or a pane
// blocked on a dialog that exists only in the terminal must not be acked.
function chatAttentionVisible(sessionId) {
  const m = chatModels.get(sessionId);
  if (!m || !m.items.size || m.paused || m.offline || m.rebuild || m.readable === false) return false;
  const sess = (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === sessionId);
  if (sess && sess.state === "blocked") return false;
  return true;
}

function renderChatView(el, s) {
  stopChatPoll(el);
  if (!s) return;
  const sessionId = s.id;
  const m = chatModel(sessionId);
  el.innerHTML = `<div class="chat">
    <div class="chat-hdr"><span class="chat-title"></span><span class="chat-mode"></span><span class="chat-note"></span><span class="chat-tools" title="Open every tool card">${chatExpandAll ? "Collapse tools" : "Expand tools"}</span></div>
    <div class="chat-banner" hidden></div>
    <div class="chat-scroll"><div class="chat-earlier" hidden></div><div class="chat-list"></div><div class="chat-live" hidden></div></div>
    <div class="chat-jump" hidden>↓</div>
    <div class="chat-notice" hidden></div>
    <div class="chat-outbox" hidden></div>
    <div class="chat-dialog" hidden></div>
    <div class="chat-composer"><textarea class="chat-input" rows="1" placeholder="Message claude — Enter to send, Shift+Enter for a new line"></textarea><button class="chat-send" title="Send (Enter)">↑</button><div class="chat-draft-st"></div></div>
  </div>`;
  const scroll = el.querySelector(".chat-scroll"), list = el.querySelector(".chat-list"), jump = el.querySelector(".chat-jump"), live = el.querySelector(".chat-live");
  // A programmatic scroll is consumed by the first scroll event that finds the
  // view where it was sent (no rAF: a hidden tab fires none, and the guard
  // would swallow the reader's first real scrolls after returning).
  let programmatic = null; // expected scrollTop, or null
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  const scrollTo = (top) => { scroll.scrollTop = top; programmatic = scroll.scrollTop; };
  const toBottom = () => scrollTo(scroll.scrollHeight);
  // The reader's place: the item whose box spans the top of the view (binary
  // search over the list, items are stacked in ord order) and its offset.
  const takeAnchor = () => {
    if (!scroll.clientHeight) return; // hidden (another tab): every rect is 0, the place would be lost
    const kids = [...list.children].filter((c) => !c.hidden), top = scroll.getBoundingClientRect().top;
    if (!kids.length) { m.anchor = null; return; }
    let lo = 0, hi = kids.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (kids[mid].getBoundingClientRect().bottom <= top) lo = mid + 1; else hi = mid; }
    const el = kids[lo];
    m.anchor = { id: el.dataset.id, offset: el.getBoundingClientRect().top - top };
  };
  // Put the anchored item back where it was; false when it is not on screen.
  const restoreAnchor = () => {
    if (!m.anchor) return false;
    const el = list.querySelector(`[data-id="${CSS.escape(m.anchor.id)}"]`);
    if (!el) return false;
    scrollTo(scroll.scrollTop + (el.getBoundingClientRect().top - scroll.getBoundingClientRect().top) - m.anchor.offset);
    return true;
  };
  // Only the READER pauses the follow: a scroll with no wheel / touch / key /
  // scrollbar drag behind it is layout (an image or code block finishing its
  // height, the browser's scroll anchoring, a hidden tab shown again) — a
  // following view is put back on the tail instead of counting "↓ N new".
  let userScrollAt = 0, pointerDown = false;
  const userInput = () => { userScrollAt = Date.now(); };
  const byReader = () => pointerDown || Date.now() - userScrollAt < 1000;
  scroll.addEventListener("wheel", userInput, { passive: true });
  scroll.addEventListener("touchstart", userInput, { passive: true });
  scroll.addEventListener("touchmove", userInput, { passive: true });
  // A mouse held down on the list (the scrollbar, a text selection). Touch has
  // touchstart/touchmove; a panning finger ends in pointercancel, not pointerup,
  // and would leave this stuck.
  scroll.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") pointerDown = true; userInput(); });
  const onPointerUp = () => { if (pointerDown) { pointerDown = false; userInput(); } };
  const onBlur = () => { pointerDown = false; }; // a drag released outside the window
  // Keyboard scrolling targets the body (the list is not focusable), not the composer.
  const onKey = (e) => { if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/.test(e.key) && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) userInput(); };
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("keydown", onKey, true);
  scroll.addEventListener("scroll", () => {
    if (programmatic !== null && Math.abs(scroll.scrollTop - programmatic) < 2) { programmatic = null; return; }
    programmatic = null;
    if (!byReader()) {
      // A paused view that something else took to the latest is following.
      if (m.paused) { if (!m.rebuild && scroll.clientHeight && atBottom()) follow(); else takeAnchor(); }
      else if (!m.rebuild && !atBottom()) toBottom();
      return;
    }
    const paused = !atBottom();
    if (paused) takeAnchor(); else m.anchor = null;
    if (paused === m.paused) return;
    m.paused = paused;
    if (!paused) m.unseen = 0;
    drawJump();
  });
  const drawJump = () => {
    jump.hidden = !m.paused;
    jump.textContent = m.unseen ? `↓ ${m.unseen} new` : "↓";
    jump.title = m.unseen ? `${m.unseen} new since you scrolled up — jump to the latest` : "Jump to the latest";
  };
  const follow = () => { m.paused = false; m.unseen = 0; m.anchor = null; toBottom(); drawJump(); };
  // Content or viewport changing size under a following reader (late layout,
  // the tab shown again after display:none) keeps the tail on screen.
  // Not right after the reader's own input: a tool card or Thinking opened by
  // hand near the bottom stays where it was clicked.
  const stick = new ResizeObserver(() => { if (!m.paused && !m.rebuild && !byReader() && scroll.clientHeight && !atBottom()) toBottom(); });
  stick.observe(list); stick.observe(scroll); if (live) stick.observe(live);
  jump.addEventListener("click", follow);
  el.querySelector(".chat-tools").addEventListener("click", (e) => {
    chatExpandAll = !chatExpandAll; if (typeof saveUIState === "function") saveUIState();
    e.target.textContent = chatExpandAll ? "Collapse tools" : "Expand tools";
    list.querySelectorAll(".ci-tool").forEach((t) => chatSetOpen(m, t, chatExpandAll));
  });
  const earlier = el.querySelector(".chat-earlier"), banner = el.querySelector(".chat-banner"), root = el.querySelector(".chat");
  earlier.addEventListener("click", async () => {
    if (earlier.dataset.busy) return;
    earlier.dataset.busy = "1"; earlier.textContent = "Loading…";
    const first = chatFirstOrd(m);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversation?before=${first}&limit=${CHAT_PAGE}`);
      if (r.ok) {
        const data = await r.json();
        if (data.generation === m.generation && data.conversationId === m.conversationId) {
          const h0 = scroll.scrollHeight, t0 = scroll.scrollTop;
          chatApplyItems(m, list, data.items);
          scrollTo(t0 + (scroll.scrollHeight - h0));
        }
      }
    } catch {}
    delete earlier.dataset.busy;
    drawHeader();
  });

  const drawHeader = () => {
    const title = el.querySelector(".chat-title"), mode = el.querySelector(".chat-mode"), note = el.querySelector(".chat-note");
    title.textContent = m.title || "Conversation";
    mode.textContent = m.permissionMode && m.permissionMode !== "default" ? m.permissionMode : "";
    // Warnings get a banner of their own (never the ellipsized header slot);
    // bookkeeping notes stay in the header.
    let warn = "";
    if (m.offline) warn = "Offline — the server cannot be reached, retrying. What is shown may be behind.";
    else if (m.reason === "token") warn = "Sign-in needed — the server rejected the token.";
    else if (m.items.size && !m.conversationId) warn = "This agent is no longer running claude — showing the last picture.";
    else if (!m.readable) warn = "The transcript could not be read — showing the last picture.";
    banner.hidden = !warn; banner.textContent = warn;
    const notes = [];
    if (!warn && !m.complete) notes.push("reading…");
    if (m.evicted) notes.push(`${m.evicted} earlier item${m.evicted === 1 ? "" : "s"} not held`);
    if (m.skipped) notes.push(`${m.skipped} oversize record${m.skipped === 1 ? "" : "s"} skipped`);
    if (m.orphanResults) notes.push(`${m.orphanResults} tool result${m.orphanResults === 1 ? "" : "s"} without a call`);
    note.textContent = notes.join(" · ");
    note.title = note.textContent;
    const first = chatFirstOrd(m);
    const older = first !== null && m.firstOrd !== null && first > m.firstOrd;
    earlier.hidden = !older;
    if (older && !earlier.dataset.busy) earlier.textContent = `Load earlier (${first - m.firstOrd} more)`;
  };
  // What the live line may claim: the pane's state (from /api/sessions) and
  // the age of the last RECORDED item — not the turn's elapsed time (an
  // assistant item's `at` moves with every completed block). Blocked: the
  // dialog exists only in the terminal, say so and hand over. Offline: no live
  // claim at all (the banner says why).
  const drawLive = () => {
    const sess = (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === sessionId);
    const state = sess ? sess.state : null;
    root.classList.toggle("chat-working", state === "working" && !m.offline);
    if (m.offline || !sess || (state !== "working" && state !== "blocked")) { live.hidden = true; return; }
    live.hidden = false;
    if (state === "blocked") {
      live.className = "chat-live chat-live-blocked";
      if (sess.dialog && sess.dialog.key) { live.innerHTML = `<span class="chat-live-dot chat-live-dot-warn"></span>Needs input · answer below`; return; }
      live.innerHTML = `<span class="chat-live-dot chat-live-dot-warn"></span>Needs input — ${esc(sess.blockReason || "claude is waiting in the terminal")} · <span class="chat-open-primary" title="The dialog is in the terminal">Open Primary</span>`;
      live.querySelector(".chat-open-primary").addEventListener("click", () => { if (typeof switchTab === "function") switchTab("terminal"); });
      return;
    }
    live.className = "chat-live";
    const last = chatLastItem(m);
    let since = "";
    if (last && last.at) { const sec = Math.max(0, Math.round((Date.now() - Date.parse(last.at)) / 1000)); if (Number.isFinite(sec)) since = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`; }
    let act = "";
    if (last && last.kind === "assistant") {
      const tu = [...last.blocks].reverse().find((b) => b.type === "tool_use");
      if (tu) act = tu.result ? `${tu.name} ${tu.result.isError ? "✗" : "✓"}` : `running: ${tu.name} ${chatToolSummary(tu, sess)}`.trim();
    }
    live.innerHTML = `<span class="chat-live-dot"></span>Working${since ? ` · last activity ${esc(since)} ago` : ""}${act ? ` · <span class="chat-live-act">${esc(act)}</span>` : ""}`;
    live.title = "The pane is working. The time is the age of the last item the transcript holds, not the turn's length.";
  };
  const drawEmpty = () => {
    const empty = list.querySelector(".chat-empty");
    if (m.items.size) { if (empty) empty.remove(); return; }
    const text = m.reason === "no session" ? "No conversation yet — this agent is not running claude, or claude has not written its first turn." : m.reason === "transcript unreadable" ? "The transcript could not be read." : m.reason === "token" ? "Sign-in needed — the server rejected the token." : m.offline ? "Could not reach the server." : "Nothing in this conversation yet.";
    if (empty) empty.textContent = text; else list.insertAdjacentHTML("beforeend", `<div class="chat-empty">${esc(text)}</div>`);
  };

  // Returns false when the page was fetched with a cursor this conversation
  // does not honour (the picture was dropped): the caller refetches the tail.
  const applyPage = (data, fromCursor) => {
    if (data.conversationId !== m.conversationId || (m.generation !== null && data.generation !== m.generation) || (m.rev !== null && data.rev < m.rev)) {
      // The picture is dropped, never silently extended. A different
      // conversation (/clear, resume) starts at the bottom; a rebuild of the
      // SAME one (replaced file, server cache rebuilt from scratch) keeps the
      // reader's place to restore once the tail is back (finishRebuild) and
      // remembers the last ord so what arrived meanwhile is counted.
      const same = data.conversationId === m.conversationId && m.items.size > 0;
      // A drop from a cursor is followed by the tail's drop (the model is
      // blank by then): the pending rebuild carries over, never a new one.
      const rebuild = same ? { anchor: m.paused ? m.anchor : null, unseen: m.unseen, lastOrd: chatLastItem(m)?.ord ?? null } : (m.conversationId === null ? m.rebuild : null);
      const fresh = chatFreshModel(sessionId);
      Object.assign(m, fresh, { open: m.open, rebuild, outbox: m.outbox, outboxGone: m.outboxGone });
      list.innerHTML = "";
      if (fromCursor) return false;
    }
    // The cursor advances only as far as this page: a tick cut short resumes
    // from nextAfter, not from the server's head (items would be lost for good).
    m.conversationId = data.conversationId; m.generation = data.generation; m.rev = data.more ? data.nextAfter : data.rev;
    m.title = data.title; m.mode = data.mode; m.permissionMode = data.permissionMode;
    m.firstOrd = data.firstOrd; m.evicted = data.evicted || 0; m.skipped = data.skipped || 0; m.orphanResults = data.orphanResults || 0;
    m.readable = data.readable !== false; m.complete = data.complete !== false; m.reason = data.reason || null;
    const { added, grew, first } = chatApplyItems(m, list, data.items || []);
    if (m.rebuild) return true; // placed, not scrolled: finishRebuild decides
    if (m.paused) { if (added + grew) { m.unseen += added + grew; drawJump(); } return true; }
    if (!first) return true; // an unchanged tick never moves the view
    toBottom(); // following: the latest stays on screen however much arrived
    return true;
  };
  // The tail of a rebuilt picture is in: put the reader back where they were,
  // loading earlier pages (bounded) until the anchored item is on screen; a
  // place that cannot be found goes to the bottom, following.
  const finishRebuild = async () => {
    const rb = m.rebuild; if (!rb) return;
    m.rebuild = null;
    if (rb.lastOrd !== null) { let n = 0; for (const it of m.items.values()) if (it.ord > rb.lastOrd && !chatHidden(it)) n++; rb.unseen += n; }
    if (!rb.anchor) { follow(); return; }
    m.paused = true; m.anchor = rb.anchor; m.unseen = rb.unseen;
    for (let pages = 0; pages < CHAT_PAGES_PER_TICK && !list.querySelector(`[data-id="${CSS.escape(rb.anchor.id)}"]`); pages++) {
      const first = chatFirstOrd(m);
      if (first === null || m.firstOrd === null || first <= m.firstOrd) break;
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversation?before=${first}&limit=${CHAT_PAGE}`);
      if (!r.ok || !el.isConnected) break;
      const data = await r.json();
      if (data.generation !== m.generation || data.conversationId !== m.conversationId) break;
      chatApplyItems(m, list, data.items || []);
    }
    if (restoreAnchor()) drawJump(); else follow();
  };
  // One refresh at a time: a tick that outlasts the interval (pages of a long
  // catch-up) is not overlapped by the next, whose stale cursor would place
  // pages out of order and move m.rev backwards.
  let busy = false;
  const refresh = async () => {
    if (!el.isConnected) { stopChatPoll(el); return; }
    if (busy) return;
    busy = true;
    try { await refreshOnce(); } finally { busy = false; }
  };
  const refreshOnce = async () => {
    let pages = 0, after = m.rev;
    try {
      while (pages < CHAT_PAGES_PER_TICK) {
        const q = after === null ? `limit=${CHAT_PAGE}` : `after=${after}&limit=${CHAT_PAGE}`;
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversation?${q}`);
        if (!r.ok) { m.offline = r.status !== 401; if (r.status === 401) m.reason = "token"; break; }
        const data = await r.json();
        if (!el.isConnected) return;
        m.offline = false; if (m.reason === "token") m.reason = null;
        pages++;
        if (!data.conversationId) { m.reason = data.reason || null; m.conversationId = null; break; }
        if (!applyPage(data, after !== null)) { after = null; continue; } // dropped: refetch the tail
        // A tail page says `more` for the EARLIER items it could not hold
        // (nextAfter = rev): nothing to page forward from.
        after = data.more && data.nextAfter !== data.rev ? data.nextAfter : null;
        if (after === null) break;
      }
    } catch { m.offline = true; }
    if (!el.isConnected) return;
    if (m.rebuild && !m.offline && after === null) { try { await finishRebuild(); } catch {} }
    if (!el.isConnected) return;
    drawHeader(); drawLive(); drawEmpty();
    try { dialogCard.tick(); } catch {}
    try { await composer.tick(); } catch {}
  };
  const composer = chatComposer(el, m, sessionId, { list });
  const dialogCard = chatDialogCard(el, sessionId);
  chatTeardown.set(el, () => { stick.disconnect(); window.removeEventListener("pointerup", onPointerUp); window.removeEventListener("pointercancel", onPointerUp); window.removeEventListener("blur", onBlur); window.removeEventListener("keydown", onKey, true); composer.flush(); if (chatActiveComposer === composer) chatActiveComposer = null; });
  // Draw what the model already holds (back from another tab) before the first
  // poll — at the reader's place when they had scrolled up, with the pill.
  if (m.items.size) {
    chatApplyItems(m, list, [...m.items.values()]);
    drawHeader(); drawLive();
    if (m.paused && restoreAnchor()) drawJump(); else follow();
  }
  try { dialogCard.tick(); } catch {}
  refresh();
  chatPolls.set(el, setInterval(refresh, CHAT_POLL_MS));
  composer.focus();
}

function chatFirstOrd(m) { let f = null; for (const it of m.items.values()) if (f === null || it.ord < f) f = it.ord; return f; }
function chatLastItem(m) { let l = null; for (const it of m.items.values()) if (!l || it.ord > l.ord) l = it; return l; }

// Place items by ord; an item whose rev moved is patched in place (assistant
// messages block by block). Returns how many VISIBLE new items landed, how many
// existing messages grew a visible block (text / tool call), and the first
// node that is new or changed (where a multi-screen arrival starts).
function chatApplyItems(m, list, items) {
  let added = 0, grew = 0, first = null;
  const sorted = [...items].sort((a, b) => a.ord - b.ord);
  for (const it of sorted) {
    const prev = m.items.get(it.id);
    const old = list.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
    if (prev && old && prev.rev === it.rev) continue;
    m.items.set(it.id, it);
    if (old) {
      const touched = chatPatchItem(m, old, it);
      if (prev && chatVisibleBlocks(it) > chatVisibleBlocks(prev)) grew++;
      if (touched && !first) first = touched;
      continue;
    }
    const node = chatItemEl(m, it);
    if (!chatHidden(it)) { added++; if (!first) first = node; }
    let before = null;
    for (const c of list.children) { if (c.dataset.ord !== undefined && Number(c.dataset.ord) > it.ord) { before = c; break; } }
    list.insertBefore(node, before);
  }
  return { added, grew, first };
}
// Items drawn as nothing (a turn without a duration, a queue dequeue) never count.
function chatHidden(it) { return (it.kind === "turn" && !it.durationMs) || (it.kind === "queue" && it.op !== "enqueue"); }
function chatVisibleBlocks(it) { return it.kind === "assistant" ? it.blocks.filter((b) => b.type === "text" || b.type === "tool_use").length : 0; }
// Re-render an item whose rev moved. Assistant messages keep every block whose
// signature is unchanged (its node, selection, open state); other kinds are
// replaced whole. Returns the first new/changed node, or null.
function chatPatchItem(m, old, it) {
  if (it.kind !== "assistant") { const node = chatItemEl(m, it); old.replaceWith(node); return node; }
  old.dataset.rev = it.rev;
  return chatRenderAssistant(m, old, it);
}

function chatSetOpen(m, toolEl, open) {
  toolEl.classList.toggle("open", open);
  const id = toolEl.dataset.tool;
  if (open) m.open.add(id); else m.open.delete(id);
}

function chatItemEl(m, it) {
  const div = document.createElement("div");
  div.className = `ci ci-${it.kind}`;
  div.dataset.id = it.id; div.dataset.ord = it.ord; div.dataset.rev = it.rev;
  const when = it.at ? `<span class="ci-when" title="${esc(it.at)}">${esc(timeAgo(it.at) || "")}</span>` : "";
  const sess = (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === m.sessionId);
  switch (it.kind) {
    case "user":
      div.innerHTML = `<div class="ci-bubble">${esc(it.text || "")}${it.truncated ? `<span class="ci-trunc">… (clipped)</span>` : ""}${it.images ? `<span class="ci-chip">🖼 ${it.images} image${it.images === 1 ? "" : "s"}</span>` : ""}</div>${when}`;
      break;
    case "assistant":
      chatRenderAssistant(m, div, it);
      break;
    case "command":
      div.innerHTML = `<div class="ci-line"><span class="ci-cmd">/${esc(it.name)}</span> ${esc(it.args || "")}</div>${when}`;
      break;
    case "output":
      div.innerHTML = `<details class="ci-out"><summary>command output <span class="ci-dim">${esc(chatCount(it.text))}</span></summary><pre>${esc(it.text || "")}</pre></details>`;
      break;
    case "summary":
      div.innerHTML = `<details class="ci-boundary"><summary>— context compacted — summary <span class="ci-dim">${esc(chatCount(it.text))}</span></summary><div class="ci-md md-preview">${chatMarkdown(it.text || "")}</div></details>`;
      break;
    case "compact":
      div.innerHTML = `<div class="ci-boundary-line">— context compacted${it.trigger ? ` (${esc(it.trigger)})` : ""}${it.preTokens ? ` · ${esc(String(Math.round(it.preTokens / 1000)))}k tokens before` : ""} —</div>`;
      break;
    case "turn":
      div.innerHTML = it.durationMs ? `<div class="ci-turn-txt">turn · ${esc(chatDuration(it.durationMs))}</div>` : "";
      if (!it.durationMs) div.hidden = true;
      break;
    case "queue":
      // claude's OWN message queue as the transcript recorded it (historical) —
      // not Hadron's outbox, which G3 draws in the composer.
      div.innerHTML = it.op === "enqueue" ? `<div class="ci-line ci-queue" title="Recorded by claude's own message queue (historical, already consumed)">claude queue · ${esc(it.text || "")}</div>` : "";
      if (it.op !== "enqueue") div.hidden = true;
      break;
    case "system":
      div.innerHTML = `<div class="ci-line ci-sys${it.level === "error" ? " ci-sys-error" : ""}">${esc(it.text || it.subtype || "")}</div>`;
      break;
    case "meta":
      div.innerHTML = `<div class="ci-line ci-sys">${esc(it.text || "")}</div>`;
      break;
    default:
      div.innerHTML = `<div class="ci-line ci-sys">${esc(it.kind)}</div>`;
  }
  return div;
}

// Draw an assistant message into `div`, block by block. Each block node carries
// data-sig (its content's signature): a node whose sig is unchanged is left
// alone; a changed one is replaced; new blocks are appended. The timestamp and
// the "more blocks" note are redrawn. Returns the first node new or changed.
function chatRenderAssistant(m, div, it) {
  const sess = (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === m.sessionId);
  div.classList.toggle("ci-error", !!it.error);
  let first = null;
  // Nodes are looked up by their block index, never by position: a block that
  // renders nothing (an empty thinking block) has no node, so a positional
  // list would be off by one from there on and every later block would be
  // torn down and recreated on each patch.
  const olds = [...div.querySelectorAll(":scope > [data-blk]")];
  const byIdx = new Map(olds.map((n) => [Number(n.dataset.blk), n]));
  it.blocks.forEach((b, i) => {
    const { sig, html } = chatBlockDesc(m, b, it, i, sess);
    const old = byIdx.get(i);
    if (old && old.dataset.sig === sig) return;
    if (!html) { if (old) old.remove(); return; }
    const node = chatBlockNode(m, html, i, sig);
    if (old) old.replaceWith(node); else {
      const anchor = olds.find((n) => n.isConnected && Number(n.dataset.blk) > i) || div.querySelector(":scope > .ci-more, :scope > .ci-when");
      div.insertBefore(node, anchor || null);
    }
    if (!first) first = node;
  });
  for (const n of olds) if (Number(n.dataset.blk) >= it.blocks.length) n.remove();
  div.querySelectorAll(":scope > .ci-more, :scope > .ci-when").forEach((n) => n.remove());
  if (it.blocksTruncated) div.insertAdjacentHTML("beforeend", `<div class="ci-trunc ci-more">… more blocks not shown</div>`);
  if (it.at) div.insertAdjacentHTML("beforeend", `<span class="ci-when" title="${esc(it.at)}">${esc(timeAgo(it.at) || "")}</span>`);
  return first;
}
function chatBlockDesc(m, b, it, i, sess) {
  if (b.type === "thinking") {
    if (!b.text) return { sig: "t:0", html: "" };
    const key = `${it.id}:think:${i}`;
    return { sig: `t:${chatSig(b.text)}`, html: `<details class="ci-think" data-think="${esc(key)}"${m.open.has(key) ? " open" : ""}><summary>Thinking <span class="ci-dim">${esc(chatCount(b.text))}</span></summary><div class="ci-think-body">${esc(b.text)}</div></details>` };
  }
  if (b.type === "text") return { sig: `x:${chatSig(b.text || "")}${b.truncated ? ":T" : ""}`, html: `<div class="ci-md md-preview">${chatMarkdown(b.text || "")}${b.truncated ? `<div class="ci-trunc">… (clipped)</div>` : ""}</div>` };
  if (b.type === "tool_use") return { sig: `u:${b.id}:${b.result ? `${b.result.isError ? "e" : "o"}${chatSig(b.result.text || "")}${b.result.truncated ? "T" : ""}` : "-"}${b.inputTruncated ? ":I" : ""}`, html: chatToolHtml(m, b, it, sess) };
  return { sig: `?:${b.type}`, html: "" };
}
function chatBlockNode(m, html, i, sig) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const node = wrap.firstElementChild;
  node.dataset.blk = i; node.dataset.sig = sig;
  if (node.classList.contains("ci-tool")) {
    node.querySelector(".ci-tool-hd").addEventListener("click", (e) => { if (e.target.closest("a,[data-open-path]")) return; chatSetOpen(m, node, !node.classList.contains("open")); });
    node.querySelectorAll("[data-open-path]").forEach((a) => a.addEventListener("click", (e) => { e.stopPropagation(); if (typeof switchTab === "function") switchTab(`file:${a.dataset.openPath}`); }));
  } else if (node.classList.contains("ci-think")) {
    node.addEventListener("toggle", () => { if (node.open) m.open.add(node.dataset.think); else m.open.delete(node.dataset.think); });
  } else chatDecorateCode(node);
  return node;
}
// Content signature: length + a 32-bit FNV-1a over the text (cheap, only computed for an item whose rev moved).
function chatSig(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return `${text.length}.${(h >>> 0).toString(36)}`; }

function chatCount(text) { const n = (text || "").length; return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`; }
function chatDuration(ms) { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; }
function chatMarkdown(text) {
  try { return typeof mdRender === "function" ? mdRender(text) : esc(text); } catch { return esc(text); }
}

const CHAT_PATH_TOOLS = new Set(["Edit", "Write", "Read", "MultiEdit", "NotebookEdit"]);
function chatRelPath(p, sess) {
  if (typeof p !== "string") return "";
  const cwd = sess && sess.cwd ? sess.cwd.replace(/\/+$/, "") + "/" : null;
  return cwd && p.startsWith(cwd) ? p.slice(cwd.length) : p;
}
// Offer a path as a link only inside the agent's cwd or the workspace: the
// server's jail decides anyway, but a Read of /etc/passwd should not look like
// a tab waiting to open.
function chatPathLinkable(p, sess) {
  const bases = [sess && sess.cwd, typeof wsRoot !== "undefined" ? wsRoot : null].filter((b) => typeof b === "string" && b).map((b) => b.replace(/\/+$/, "") + "/");
  return bases.some((b) => p.startsWith(b));
}
function chatToolSummary(b, sess) {
  const i = b.input || {};
  if (CHAT_PATH_TOOLS.has(b.name)) return chatRelPath(i.file_path || i.notebook_path || "", sess);
  if (b.name === "Bash") return String(i.command || "").split("\n")[0].slice(0, 160);
  if (b.name === "Grep" || b.name === "Glob") return String(i.pattern || "").slice(0, 120);
  if (b.name === "Agent" || b.name === "Task") return String(i.description || "").slice(0, 120);
  if (b.name === "WebFetch" || b.name === "WebSearch") return String(i.url || i.query || "").slice(0, 120);
  if (b.name === "Skill") return String(i.skill || "").slice(0, 80);
  for (const v of Object.values(i)) if (typeof v === "string" && v.trim()) return v.split("\n")[0].slice(0, 120);
  return "";
}
function chatToolHtml(m, b, it, sess) {
  const open = chatExpandAll || m.open.has(b.id);
  const path = CHAT_PATH_TOOLS.has(b.name) ? (b.input && (b.input.file_path || b.input.notebook_path)) : null;
  const summary = chatToolSummary(b, sess);
  const linkable = path && typeof path === "string" && path.startsWith("/") && chatPathLinkable(path, sess);
  const sumHtml = linkable ? `<span class="ci-tool-sum" data-open-path="${esc(path)}" title="Open ${esc(path)}">${esc(summary)}</span>` : `<span class="ci-tool-sum">${esc(summary)}</span>`;
  let status, cls;
  if (b.result) { status = b.result.isError ? "✗" : "✓"; cls = b.result.isError ? "err" : "ok"; }
  else { status = ""; cls = "pending"; } // glyph from CSS: "…" while the pane works (.chat-working), "–" otherwise
  let body = "";
  if (b.name === "Edit" && b.input && typeof b.input.old_string === "string") {
    body += `<pre class="ci-diff">${String(b.input.old_string).split("\n").map((l) => `<span class="ci-l-del">− ${esc(l)}</span>`).join("\n")}\n${String(b.input.new_string || "").split("\n").map((l) => `<span class="ci-l-add">+ ${esc(l)}</span>`).join("\n")}</pre>`;
  } else if (b.name === "Write" && b.input && typeof b.input.content === "string") {
    body += `<pre class="ci-pre">${esc(b.input.content)}</pre>`;
  } else if (b.name === "Bash" && b.input && typeof b.input.command === "string") {
    body += `<pre class="ci-pre">${esc(b.input.command)}</pre>`;
  } else {
    let j = ""; try { j = JSON.stringify(b.input || {}, null, 2); } catch { j = String(b.input); }
    body += `<pre class="ci-pre">${esc(j)}</pre>`;
  }
  if (b.inputTruncated) body += `<div class="ci-trunc">… input clipped</div>`;
  if (b.result) {
    const t = b.result.text || "";
    body += `<div class="ci-tool-res${b.result.isError ? " err" : ""}"><div class="ci-tool-res-hd">${b.result.isError ? "error" : "result"}${b.result.images ? ` · ${b.result.images} image${b.result.images === 1 ? "" : "s"}` : ""}</div>${t ? `<pre class="ci-pre">${esc(t)}</pre>` : `<div class="ci-dim">(empty)</div>`}${b.result.truncated ? `<div class="ci-trunc">… result clipped</div>` : ""}</div>`;
  } else body += `<div class="ci-dim ci-tool-nores">no result recorded</div>`;
  return `<div class="ci-tool${open ? " open" : ""}" data-tool="${esc(b.id)}"><div class="ci-tool-hd"><span class="ci-tool-st ci-tool-st-${cls}">${status}</span><span class="ci-tool-name">${esc(b.name)}</span>${sumHtml}<span class="ci-tool-caret">▸</span></div><div class="ci-tool-body">${body}</div></div>`;
}

// Code blocks in assistant markdown get a sticky header: language + Copy.
function chatDecorateCode(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    if (!pre.closest(".ci-md")) return;
    if (pre.parentElement.classList.contains("ci-code")) return;
    const code = pre.querySelector("code");
    const lang = code ? (code.className.match(/language-([\w+-]+)/) || [])[1] || "" : "";
    const wrap = document.createElement("div");
    wrap.className = "ci-code";
    const hd = document.createElement("div");
    hd.className = "ci-code-hd";
    hd.innerHTML = `<span class="ci-code-lang">${esc(lang || "text")}</span><span class="ci-code-copy" title="Copy code">Copy</span>`;
    hd.querySelector(".ci-code-copy").addEventListener("click", async (e) => {
      const text = (code || pre).textContent;
      let ok = false;
      try { await copyTextToClipboard(text); ok = true; } catch {} // artifacts.js: execCommand fallback for plain http
      e.target.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => { e.target.textContent = "Copy"; }, 1500);
    });
    pre.replaceWith(wrap);
    wrap.appendChild(hd);
    wrap.appendChild(pre);
  });
}

// ── The composer: drafts, sending, the outbox ─────────────────────────────
// Drafts live in two places: localStorage (every keystroke, this device) and
// the agent record (PATCH /draft, debounced, every device). The server keeps a
// revision; a PATCH names the revision it last saw and is refused 409 when
// another device moved on — both versions are then offered, never merged.
// Sending hands the text to the outbox: POST /message with a request id (a
// retry can never paste twice), `when: auto` (queued on the record while the
// pane is working or blocked, delivered by the server once it is at its
// prompt). Rows under the composer follow the entry's state until claude
// records the turn (the user bubble appears) — or say honestly that it has
// not. An uncertain send (no answer from the server) is never resent on its own.
const CHAT_DRAFT_DEBOUNCE_MS = 500, CHAT_DRAFT_MAX_WAIT_MS = 3000, CHAT_DRAFT_RETRY_MS = 5000;
const CHAT_HANDED_WARN_MS = 20000; // handed, no user turn seen for this long → "Handed to claude, not in the conversation yet"
const CHAT_OUTBOX_GONE_MS = 10000; // a row removed here is ignored on the (3-s old) sessions list for this long
let chatActiveComposer = null;
function chatDeviceId() {
  try {
    let d = localStorage.getItem("hadron-device-id");
    if (!d || !/^[A-Za-z0-9._:-]{1,128}$/.test(d)) { d = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem("hadron-device-id", d); }
    return d;
  } catch { return "d-mem"; }
}
function chatLocalDraft(sessionId) {
  try { const v = JSON.parse(localStorage.getItem(`hadron-draft-${sessionId}`) || "null"); return v && typeof v.text === "string" && Number.isInteger(v.revision) ? v : null; } catch { return null; }
}
function chatSaveLocalDraft(sessionId, d) {
  try { if (d) localStorage.setItem(`hadron-draft-${sessionId}`, JSON.stringify(d)); else localStorage.removeItem(`hadron-draft-${sessionId}`); } catch {}
}
const chatRequestId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// Has claude recorded this handed message as a user turn? Same text (a clipped
// bubble matches its prefix), recorded no earlier than the send.
function chatObserved(m, row) {
  const t0 = Date.parse(row.at || "") - 5000;
  for (const it of m.items.values()) {
    if (it.kind !== "user" || typeof it.text !== "string") continue;
    if (Number.isFinite(t0) && it.at && Date.parse(it.at) < t0) continue;
    if (it.text === row.text || (it.truncated && row.text.startsWith(it.text)) || (row.truncated && it.text.startsWith(row.text))) return true;
  }
  return false;
}

// ── the dialog card (G4) ──
// The dialog claude is showing, parsed from the pane by the server (the
// command, the file, the choices — never generic 1/2/Esc buttons). Every
// answer carries the dialog's key: 409 means the dialog on screen is not the
// one that was read (another device answered, claude moved on) and the card
// repaints from the server's answer instead of guessing. After an answer the
// card says so until the pane stops being blocked or a NEW dialog appears.
function chatDialogCard(el, sessionId) {
  const box = el.querySelector(".chat-dialog");
  const api = (path) => `/api/sessions/${encodeURIComponent(sessionId)}${path}`;
  const sess = () => (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === sessionId);
  let shownKey = null, shownSig = null, answered = null, busy = false, notice = "";
  const KIND = { permission: "Permission", plan: "Plan", question: "Question", select: "Choose" };
  const hide = () => { if (!box.hidden) { box.hidden = true; box.innerHTML = ""; box.className = "chat-dialog"; } shownKey = null; shownSig = null; busy = false; };
  // "answered" is this dialog's showing, not its key: the same dialog shown
  // again after the pane was idle (a retried tool) carries a fresh `at`
  const showing = (d) => `${d.key}@${d.at || ""}`;
  // what the card is drawn from: the showing, its answered state, the row the ❯
  // is on (it moves when the operator uses the terminal), a failed delivery
  const sigOf = (d, isAnswered) => `${showing(d)}|${isAnswered ? 1 : 0}|${(d.options || []).findIndex((o) => o.selected)}|${d.answerError || ""}`;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const render = (d, state) => {
    shownKey = d.key; busy = false;
    box.innerHTML = ""; box.hidden = false; box.className = "chat-dialog";
    box.dataset.key = d.key; box.dataset.kind = d.kind;
    const hdr = node("div", "cd-hdr");
    hdr.appendChild(node("span", "cd-kind", KIND[d.kind] || "Dialog"));
    hdr.appendChild(node("span", "cd-title", d.title || ""));
    const open = node("span", "cd-open", "Open Primary"); open.title = "See the dialog in the terminal";
    open.addEventListener("click", () => { if (typeof switchTab === "function") switchTab("terminal"); });
    hdr.appendChild(open);
    box.appendChild(hdr);
    const body = node("div", "cd-body");
    for (const sec of d.sections || []) {
      if (sec.code) { const pre = node("pre", "cd-code", sec.text); body.appendChild(pre); continue; }
      let text = sec.text;
      if (sec === d.sections[0] && d.title && text.startsWith(d.title)) text = text.slice(d.title.length).replace(/^\n+/, "");
      if (sec === d.sections[d.sections.length - 1] && d.question && text.endsWith(d.question)) text = text.slice(0, -d.question.length).replace(/\n+$/, "");
      if (text.trim()) body.appendChild(node("div", "cd-text", text));
    }
    if (d.truncated) body.appendChild(node("div", "cd-trunc", "… (clipped — the terminal has all of it)"));
    if (d.question) body.appendChild(node("div", "cd-q", d.question));
    box.appendChild(body);
    const opts = node("div", "cd-opts");
    const status = node("div", "cd-status");
    const done = state === "answered";
    const setBusy = (b) => { busy = b; box.classList.toggle("cd-busy", b); for (const el2 of box.querySelectorAll("button")) el2.disabled = b || done; };
    const answer = async (payload, label) => {
      if (busy || done) return;
      setBusy(true); notice = ""; status.textContent = `Sending ${label}…`;
      let r = null, j = {};
      try { r = await fetch(api("/dialog/answer"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, key: d.key }) }); j = await r.json().catch(() => ({})); } catch { r = null; }
      if (!el.isConnected) return;
      if (r && r.ok) { answered = showing(d); render(d, "answered"); return; }
      setBusy(false);
      if (!r) { status.textContent = "Not sent — the server could not be reached"; return; }
      notice = r.status === 409 ? (j.error || "the dialog changed") : `Not sent — ${j.error || `HTTP ${r.status}`}`;
      // the refusal carries the pane's current picture: draw that, not the stale card
      if (j.dialog && j.dialog.key) { render(j.dialog, j.dialog.answeredAt ? "answered" : null); return; }
      if (j.state && j.state !== "blocked") { hide(); return; }
      status.textContent = notice;
    };
    let textRow = null;
    const askText = (placeholder, submit) => {
      if (textRow) textRow.remove();
      textRow = node("div", "cd-textrow");
      const inp = node("input", "cd-input"); inp.type = "text"; inp.placeholder = placeholder; inp.maxLength = 500;
      const go = node("button", "cd-go", "Send");
      go.addEventListener("click", () => submit(inp.value.trim()));
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(inp.value.trim()); } });
      textRow.appendChild(inp); textRow.appendChild(go);
      opts.after(textRow); inp.focus();
    };
    for (const o of d.options || []) {
      if (o.sepAbove) opts.appendChild(node("div", "cd-sep"));
      const b = node("button", `cd-opt${o.selected ? " cd-sel" : ""}`);
      b.dataset.n = String(o.n);
      b.appendChild(node("span", "cd-n", d.numbered ? `${o.n}` : "›"));
      const lab = node("span", "cd-lab", o.label);
      if (o.detail) lab.appendChild(node("span", "cd-detail", o.detail));
      b.appendChild(lab);
      const twoDigits = d.numbered && o.n > 9;
      b.title = twoDigits ? "A two-digit option is chosen in the terminal" : d.numbered ? `Types ${o.n} into the dialog` : "Moves the ❯ there (from where the terminal has it when you click) and presses Enter";
      if (twoDigits) b.disabled = true;
      b.addEventListener("click", () => {
        if (o.text) askText("What should claude do? (optional — Send with nothing to just pick this)", (t) => answer({ action: "option", n: o.n, ...(t ? { text: t } : {}) }, `${o.n}`));
        else answer({ action: "option", n: o.n }, `${o.n}`);
      });
      opts.appendChild(b);
    }
    box.appendChild(opts);
    const foot = node("div", "cd-foot");
    if (d.amend) { const am = node("button", "cd-amend", "Amend…"); am.title = "Tab in the dialog: say what to do instead"; am.addEventListener("click", () => askText("Tell claude what to do instead", (t) => { if (t) answer({ action: "amend", text: t }, "the amendment"); })); foot.appendChild(am); }
    if (d.cancel) { const c = node("button", "cd-cancel", "Cancel (Esc)"); c.title = "Escape in the dialog"; c.addEventListener("click", () => answer({ action: "cancel" }, "Escape")); foot.appendChild(c); }
    foot.appendChild(status);
    box.appendChild(foot);
    if (done) { status.textContent = "Answered · waiting for claude…"; box.classList.add("cd-answered"); for (const el2 of box.querySelectorAll("button")) el2.disabled = true; }
    else if (notice) status.textContent = notice;
    shownSig = sigOf(d, done);
  };
  const tick = () => {
    const s = sess();
    if (!s || s.state !== "blocked") { hide(); answered = null; return; }
    const d = s.dialog;
    if (!d || !d.key) {
      // blocked with no readable dialog: the live line hands over to the
      // terminal; after an answer the card stays as "waiting" until the pane moves on
      if (answered && box.classList.contains("cd-answered")) return;
      hide(); return;
    }
    const isAnswered = Boolean(d.answeredAt) || answered === showing(d);
    if (sigOf(d, isAnswered) === shownSig) return;
    if (busy && d.key === shownKey) return;
    if (d.answerError && !isAnswered) notice = `Not delivered — ${d.answerError}. Check the terminal before answering again`;
    render(d, isAnswered ? "answered" : null);
  };
  return { tick };
}

function chatComposer(el, m, sessionId, { list }) {
  const root = el.querySelector(".chat"), ta = el.querySelector(".chat-input"), sendBtn = el.querySelector(".chat-send");
  const status = el.querySelector(".chat-draft-st"), notice = el.querySelector(".chat-notice"), obEl = el.querySelector(".chat-outbox");
  const deviceId = chatDeviceId();
  const api = (path) => `/api/sessions/${encodeURIComponent(sessionId)}${path}`;
  const sess = () => (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === sessionId);

  // ── draft ──
  let local = chatLocalDraft(sessionId); // { text, revision, conversationId, synced, at }
  let touched = false, timer = null, firstEdit = 0, inflight = false, offline = false, lastTry = 0, conflict = null;
  const autosize = () => {
    ta.style.height = "auto";
    const max = Math.max(80, Math.floor((root.clientHeight || 600) * 0.4));
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  };
  const drawStatus = () => {
    let t = "";
    if (conflict) t = "";
    else if (local && (local.text || !local.synced)) t = inflight ? "Saving draft…" : local.synced ? "Draft synced" : offline ? "Offline — draft saved locally" : "Draft saved locally";
    status.textContent = t;
    status.className = `chat-draft-st${offline && local && !local.synced ? " chat-draft-off" : ""}`;
  };
  const drawNotice = () => {
    notice.innerHTML = ""; notice.hidden = !conflict;
    if (!conflict) return;
    const c = conflict;
    const span = document.createElement("span"); span.className = "chat-notice-txt";
    if (c.kind === "stale") span.textContent = `Draft from an earlier conversation: “${c.draft.text.slice(0, 80)}${c.draft.text.length > 80 ? "…" : ""}”`;
    else span.textContent = `Draft changed on another device: “${(c.draft?.text || "").slice(0, 80)}${(c.draft?.text || "").length > 80 ? "…" : ""}”`;
    notice.appendChild(span);
    const btn = (label, title, fn) => { const b = document.createElement("span"); b.className = "chat-notice-btn"; b.textContent = label; b.title = title; b.addEventListener("click", fn); notice.appendChild(b); };
    if (c.kind === "stale") {
      btn("Restore", "Put that draft in the composer, for this conversation", () => { conflict = null; ta.value = c.draft.text; touched = true; local = { text: c.draft.text, revision: c.draft.revision, conversationId: m.conversationId || null, synced: false, at: Date.now() }; chatSaveLocalDraft(sessionId, local); autosize(); drawNotice(); sync(); });
      btn("Discard", "Forget that draft", () => { conflict = null; local = { text: "", revision: c.draft.revision, conversationId: null, synced: false, at: Date.now() }; drawNotice(); sync(); });
    } else {
      btn("Use this device", "Keep what is in the composer here; the other device's draft is replaced", () => { conflict = null; local = { ...(local || { text: ta.value, conversationId: m.conversationId || null }), revision: c.draft ? c.draft.revision : 0, synced: false, at: Date.now() }; chatSaveLocalDraft(sessionId, local); drawNotice(); sync(); });
      btn("Use other device", "Replace the composer with the other device's draft", () => { conflict = null; const d = c.draft; ta.value = d ? d.text : ""; local = d ? { text: d.text, revision: d.revision, conversationId: d.conversationId || null, synced: true, at: Date.now() } : null; chatSaveLocalDraft(sessionId, local); autosize(); drawNotice(); drawStatus(); });
    }
  };
  const schedule = () => {
    if (!firstEdit) firstEdit = Date.now();
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(CHAT_DRAFT_DEBOUNCE_MS, firstEdit + CHAT_DRAFT_MAX_WAIT_MS - Date.now()));
    timer = setTimeout(() => { timer = null; sync(); }, wait);
  };
  const sync = async () => {
    clearTimeout(timer); timer = null; firstEdit = 0;
    if (inflight || conflict || !local || local.synced) return;
    inflight = true; lastTry = Date.now(); drawStatus();
    const snap = { ...local };
    let r = null, j = null;
    try {
      r = await fetch(api("/draft"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: snap.text, attachments: [], deviceId, revision: snap.revision, conversationId: snap.conversationId || m.conversationId || null }) });
      j = await r.json().catch(() => ({}));
    } catch { r = null; }
    inflight = false;
    if (!el.isConnected) return;
    if (!r) { offline = true; drawStatus(); return; }
    offline = false;
    if (r.ok) {
      const rev = j.draft ? j.draft.revision : 0;
      if (local && local.text === snap.text) local = rev ? { ...local, revision: rev, synced: true } : null;
      else if (local) { local.revision = rev; schedule(); }
      chatSaveLocalDraft(sessionId, local);
    } else if (r.status === 409) {
      const d = j.draft || null;
      if (!d) { if (local) { local.revision = 0; schedule(); } } // cleared on another device (sent, probably): our newer typing stands
      else if (local && d.text === snap.text) { local = { ...local, revision: d.revision, synced: local.text === snap.text }; if (!local.synced) schedule(); chatSaveLocalDraft(sessionId, local); }
      else { conflict = { kind: "conflict", draft: d }; drawNotice(); }
    } else if (r.status === 401) { offline = true; }
    drawStatus();
  };
  const onInput = () => {
    touched = true;
    local = { text: ta.value, revision: local ? local.revision : 0, conversationId: m.conversationId || null, synced: false, at: Date.now() };
    if (!local.text && !local.revision) local = null;
    chatSaveLocalDraft(sessionId, local);
    autosize(); drawStatus();
    if (local) schedule();
  };
  ta.addEventListener("input", onInput);
  // What the server has, once, when the composer opens: a newer draft from
  // another device fills an untouched composer; one for an earlier
  // conversation is offered, not pasted in; unsynced local typing is sent.
  const load = async () => {
    let d;
    try { const r = await fetch(api("/draft")); if (!r.ok) { if (r.status !== 401) offline = true; drawStatus(); return; } d = (await r.json()).draft; } catch { offline = true; drawStatus(); return; }
    if (!el.isConnected) return;
    offline = false;
    if (!d) {
      if (local && !local.synced && local.text) sync();
      else if (local && local.synced) { local = null; chatSaveLocalDraft(sessionId, null); if (!touched) { ta.value = ""; autosize(); } }
    } else if (d.stale) {
      if (!ta.value.trim() && !conflict) { conflict = { kind: "stale", draft: d }; drawNotice(); }
    } else if (!local || d.revision > local.revision) {
      if (!local || (local.synced && !touched) || !ta.value) {
        ta.value = d.text; local = { text: d.text, revision: d.revision, conversationId: d.conversationId || null, synced: true, at: Date.now() };
        chatSaveLocalDraft(sessionId, local); autosize();
      } else if (local.text === d.text) { local = { ...local, revision: d.revision, synced: true }; chatSaveLocalDraft(sessionId, local); }
      else { conflict = { kind: "conflict", draft: d }; drawNotice(); }
    } else if (!local.synced) sync();
    drawStatus();
  };
  if (local && local.text) ta.value = local.text;
  autosize(); drawStatus();
  load();

  // ── outbox ──
  if (!m.outbox) m.outbox = new Map();
  if (!m.outboxGone) m.outboxGone = new Map();
  let obSig = "";
  const label = (row) => {
    switch (row.state) {
      case "pending": case "sending": return "Sending…";
      case "queued": return row.stale ? "Written for an earlier conversation — held" : "Send after this turn";
      case "handed":
        if (m.readable === false || !m.conversationId) return "Handed to the terminal"; // no transcript to see it recorded in
        // Pasted while claude was working: claude takes it with its next step and
        // records it as a prompt then (staging 2026-11-08: the bubble came at the
        // end of a 25-s tool call), so the wait is as long as the turn — the
        // warning counts only once the pane has left `working`.
        let late = Date.now() - Date.parse(row.handedAt || row.at || 0) > CHAT_HANDED_WARN_MS;
        if (row.handedWhile === "working") {
          if (!m.handedIdleAt) m.handedIdleAt = new Map();
          if (sess()?.state === "working") { m.handedIdleAt.delete(row.id); return "Delivered mid-turn · claude reads it with its next step"; }
          if (!m.handedIdleAt.has(row.id)) m.handedIdleAt.set(row.id, Date.now());
          late = Date.now() - m.handedIdleAt.get(row.id) > CHAT_HANDED_WARN_MS;
          return late ? "Delivered mid-turn, not in the conversation — Primary shows what claude did with it" : "Delivered mid-turn · waiting for claude…";
        }
        return late ? "Handed to claude, not in the conversation yet" : "Sent · waiting for claude…";
      case "failed": return `Not delivered — ${row.error || "refused"}`;
      case "uncertain": return `Not sure this was sent — ${row.error || "the server did not answer"}`;
      default: return row.state;
    }
  };
  const drawOutbox = () => {
    const rows = [...m.outbox.values()].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
    const sig = rows.map((r) => `${r.id}:${r.state}:${r.text.length}:${label(r)}`).join("|");
    if (sig === obSig) return;
    obSig = sig;
    obEl.innerHTML = "";
    obEl.hidden = !rows.length;
    for (const row of rows) {
      const div = document.createElement("div");
      div.className = `ob-row ob-${row.state}${row.stale ? " ob-stale" : ""}`; div.dataset.oid = row.id;
      const text = document.createElement("div"); text.className = "ob-text"; text.textContent = row.text; text.title = row.text.length > 200 ? row.text.slice(0, 2000) : "";
      const meta = document.createElement("div"); meta.className = "ob-meta";
      const st = document.createElement("span"); st.className = "ob-st"; st.textContent = label(row);
      meta.appendChild(st);
      const act = (name, lbl, title) => { const b = document.createElement("span"); b.className = "ob-act"; b.dataset.act = name; b.textContent = lbl; b.title = title; b.addEventListener("click", () => action(name, row)); meta.appendChild(b); };
      if (row.state === "queued") { if (!row.stale) act("now", "Send now", "Send it now, dialog or not — into a dialog the text lands wherever its cursor is"); act("edit", "Edit", row.stale ? "Take it back into the composer, for this conversation" : "Take it back into the composer"); act("cancel", "×", "Cancel — not sent"); }
      if (row.state === "failed") { act("retry", "Retry", "Send it again"); act("edit", "Edit", "Take it back into the composer"); act("discard", "Discard", "Forget it"); }
      if (row.state === "uncertain") { act("retry", "Send again", "Send it again — if the first one did land, claude gets it twice"); act("edit", "Edit", "Take it back into the composer — if the first one did land, claude gets it twice"); act("discard", "Discard", "Forget it"); }
      div.appendChild(text); div.appendChild(meta);
      obEl.appendChild(div);
    }
    // Several messages waiting: one button folds them into a single queued
    // message (in order, a blank line between) — one paste, one bubble.
    const queued = rows.filter((r) => r.state === "queued" && !r.stale);
    if (queued.length > 1) {
      const bar = document.createElement("div"); bar.className = "ob-row ob-merge";
      const b = document.createElement("span"); b.className = "ob-act"; b.dataset.act = "merge"; b.textContent = `Merge ${queued.length} into one message`; b.title = "Send them as one message, in this order";
      b.addEventListener("click", () => action("merge", queued));
      bar.appendChild(b); obEl.appendChild(bar);
    }
  };
  // The record may hold the entry even when this tab never heard so (a POST
  // without an answer): the DELETE is always tried; 409 = being delivered now.
  const remove = (row, del) => {
    m.outbox.delete(row.id); m.outboxGone.set(row.id, Date.now());
    if (del) fetch(api(`/outbox/${encodeURIComponent(row.id)}`), { method: "DELETE" }).catch(() => {});
    drawOutbox();
  };
  const lookup = async (row) => {
    try { const g = await fetch(api("/outbox")); if (g.ok) return ((await g.json()).outbox || []).find((e) => e.id === row.id) || null; } catch {}
    return null;
  };
  const post = async (row) => {
    row.state = "pending"; delete row.error; drawOutbox();
    let r = null, j = {};
    try {
      r = await fetch(api("/message"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: row.text, requestId: row.id, when: "auto", deviceId }) });
      j = await r.json().catch(() => ({}));
    } catch { r = null; }
    if (!m.outbox.has(row.id)) return; // removed meanwhile
    if (r && j.entry) { Object.assign(row, { state: j.entry.state, error: j.entry.error, handedAt: j.entry.handedAt, handedWhile: j.entry.handedWhile, at: j.entry.at || row.at, stale: j.entry.stale, server: true }); }
    else {
      // No entry in the answer (or no answer): the POST may still have landed.
      // Ask the record before claiming anything.
      const found = await lookup(row);
      if (found) Object.assign(row, { state: found.state, error: found.error, handedAt: found.handedAt, at: found.at, stale: found.stale, server: true });
      else if (r) { row.state = "failed"; row.error = j.error || `HTTP ${r.status}`; row.server = false; }
      else { row.state = "uncertain"; row.error = "the server could not be reached"; row.server = false; }
    }
    drawOutbox();
  };
  // A row that came off the sessions list carries the wire form (500 chars,
  // `truncated`); Edit and Merge need the whole text — one GET /outbox fills
  // every clipped row. False when the record could not be read.
  const fullText = async (rows) => {
    if (!rows.some((r) => r.truncated)) return true;
    let list = null;
    try { const g = await fetch(api("/outbox")); if (g.ok) list = (await g.json()).outbox || []; } catch {}
    if (!list) return false;
    for (const r of rows) { const e = list.find((x) => x.id === r.id); if (e) { r.text = e.text; r.truncated = false; } else r.gone = true; }
    return rows.every((r) => !r.truncated || r.gone); // a row the record no longer has is the merge loop's 404, not a failed read
  };
  const action = async (name, row) => {
    if (name === "cancel" || name === "edit") {
      if (name === "edit" && !(await fullText([row]))) { status.textContent = "Could not read the whole message from the server — try again"; return; }
      let r = null;
      try { r = await fetch(api(`/outbox/${encodeURIComponent(row.id)}`), { method: "DELETE" }); } catch {}
      if (r && r.status === 409) { row.state = "sending"; drawOutbox(); return; } // being delivered right now
      if (r && !r.ok && r.status !== 404) return;
      m.outbox.delete(row.id); m.outboxGone.set(row.id, Date.now()); drawOutbox();
      if (name === "edit") { ta.value = ta.value.trim() ? `${row.text}\n${ta.value}` : row.text; onInput(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    } else if (name === "retry") {
      let r = null;
      try { r = await fetch(api(`/outbox/${encodeURIComponent(row.id)}`), { method: "DELETE" }); } catch {}
      if (r && r.status === 409) { row.state = "sending"; drawOutbox(); return; } // the first one IS going out
      m.outbox.delete(row.id); m.outboxGone.set(row.id, Date.now());
      const fresh = { id: chatRequestId(), text: row.text, state: "pending", at: new Date().toISOString(), server: false };
      m.outbox.set(fresh.id, fresh); post(fresh);
    } else if (name === "discard") remove(row, true);
    else if (name === "now") {
      row.state = "sending"; drawOutbox();
      let r = null, j = {};
      try { r = await fetch(api(`/outbox/${encodeURIComponent(row.id)}/send`), { method: "POST" }); j = await r.json().catch(() => ({})); } catch {}
      if (!el.isConnected) return;
      if (j.entry) Object.assign(row, { state: j.entry.state, error: j.entry.error, handedAt: j.entry.handedAt, handedWhile: j.entry.handedWhile });
      else if (r && r.status === 404) { m.outbox.delete(row.id); m.outboxGone.set(row.id, Date.now()); }
      else row.state = "queued"; // no answer: the record decides on the next tick
      drawOutbox();
    } else if (name === "merge") {
      // `row` is the queued list, in order. Each is cancelled (one being
      // delivered right now is left alone and out of the merge), then the
      // texts go out as one new entry through the normal path.
      if (!(await fullText(row))) { status.textContent = "Could not read the whole messages from the server — not merged"; return; }
      const parts = [];
      let stopped = false;
      for (const q of row) {
        let r = null, j = {};
        try { r = await fetch(api(`/outbox/${encodeURIComponent(q.id)}`), { method: "DELETE" }); j = await r.json().catch(() => ({})); } catch {}
        if (r && r.status === 409) { q.state = "sending"; continue; } // going out right now: not ours to fold in
        if (r && r.status === 404) { m.outbox.delete(q.id); m.outboxGone.set(q.id, Date.now()); continue; } // already gone
        if (!r || !r.ok) { stopped = true; break; } // the server did not answer: the rows after this one stay as they are
        m.outbox.delete(q.id); m.outboxGone.set(q.id, Date.now());
        // Only a message that was still waiting is folded in — one the record
        // says went out (handed, failed) must not be sent a second time.
        if (j.removed === "queued") parts.push(q.text);
      }
      if (!el.isConnected) return;
      if (stopped) {
        // Nothing is lost and nothing is reordered: what was taken off the
        // record goes back into the composer, the rest stays queued.
        if (parts.length) { ta.value = ta.value.trim() ? `${parts.join("\n\n")}\n${ta.value}` : parts.join("\n\n"); onInput(); ta.focus(); }
        status.textContent = `Merge stopped — the server did not answer${parts.length ? `; ${parts.length} message${parts.length === 1 ? "" : "s"} taken back into the composer` : ""}`;
        drawOutbox(); return;
      }
      if (!parts.length) { drawOutbox(); return; }
      const fresh = { id: chatRequestId(), text: parts.join("\n\n"), state: "pending", at: new Date().toISOString(), server: false };
      m.outbox.set(fresh.id, fresh); post(fresh);
    }
  };
  const send = () => {
    const text = ta.value.replace(/\s+$/, "");
    if (!text) return;
    if (text.includes("[uploading image…]")) { status.textContent = "Wait for the image to upload…"; return; }
    // The draft is cleared on this device at once and on the record right after;
    // the message is a separate thing from here on.
    ta.value = ""; touched = true; autosize();
    const rev = local ? local.revision : 0;
    local = rev ? { text: "", revision: rev, conversationId: null, synced: false, at: Date.now() } : null;
    chatSaveLocalDraft(sessionId, local); drawStatus();
    if (rev) sync();
    const row = { id: chatRequestId(), text, state: "pending", at: new Date().toISOString(), server: false };
    m.outbox.set(row.id, row);
    post(row);
    ta.focus();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.isComposing || e.keyCode === 229) return; // the IME is composing: Enter commits the candidate, never sends
    if (e.shiftKey) return; // newline
    e.preventDefault();
    send();
  });
  sendBtn.addEventListener("click", send);
  // Each tick: the record's picture (fresh while anything is in flight, else
  // the sessions list for entries made elsewhere), handed rows that claude has
  // recorded since are done, a draft that could not sync is tried again.
  const tick = async () => {
    const wire = sess()?.outbox;
    let fresh = null;
    if (m.outbox.size) { try { const g = await fetch(api("/outbox")); if (g.ok) fresh = (await g.json()).outbox || []; } catch {} }
    if (!el.isConnected) return;
    const src = fresh || (Array.isArray(wire) ? wire : null);
    if (src) {
      const now = Date.now();
      for (const [id, t] of m.outboxGone) if (now - t > CHAT_OUTBOX_GONE_MS) m.outboxGone.delete(id);
      const seen = new Set();
      for (const e of src) {
        seen.add(e.id);
        if (m.outboxGone.has(e.id)) continue;
        const row = m.outbox.get(e.id);
        if (row) { if (row.state !== "pending") Object.assign(row, { state: e.state, error: e.error, handedAt: e.handedAt, handedWhile: e.handedWhile, at: e.at, stale: e.stale, server: true }, fresh ? { text: e.text, truncated: false } : {}); }
        else m.outbox.set(e.id, { id: e.id, text: e.text, truncated: !fresh && Boolean(e.truncated), state: e.state, at: e.at, error: e.error, handedAt: e.handedAt, handedWhile: e.handedWhile, stale: e.stale, server: true });
      }
      if (fresh) for (const row of m.outbox.values()) if (row.server && row.state !== "pending" && !seen.has(row.id)) m.outbox.delete(row.id);
    }
    // A handed row goes once claude recorded the text as a prompt — a mid-turn
    // paste included (claude records it when it takes it, at its next step). A
    // paste that got lost stays as a row that never goes, which is the truth;
    // the label says so once the turn is over.
    for (const row of m.outbox.values()) if (row.state === "handed" && chatObserved(m, row)) remove(row, true);
    drawOutbox();
    if (local && !local.synced && !inflight && !timer && !conflict && Date.now() - lastTry > CHAT_DRAFT_RETRY_MS) sync();
  };
  const flush = () => { clearTimeout(timer); timer = null; if (local && !local.synced) sync(); };
  const focus = () => { try { if (!matchMedia("(pointer: coarse)").matches) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } } catch {} };
  drawOutbox();
  const c = { tick, flush, focus };
  chatActiveComposer = c;
  return c;
}
document.addEventListener("visibilitychange", () => { if (document.hidden && chatActiveComposer) chatActiveComposer.flush(); });
window.addEventListener("pagehide", () => { if (chatActiveComposer) chatActiveComposer.flush(); });
