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
// conversation goes to the bottom. A multi-screen arrival while following lands
// the reader at the START of what arrived with a ↓ pill, never at its end. An
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
function stopChatPoll(el) { const t = chatPolls.get(el); if (t) { clearInterval(t); chatPolls.delete(el); } }
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
  scroll.addEventListener("scroll", () => {
    if (programmatic !== null && Math.abs(scroll.scrollTop - programmatic) < 2) { programmatic = null; return; }
    programmatic = null;
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
  jump.addEventListener("click", follow);
  // A multi-screen arrival while following: land at the START of it, paused,
  // with the pill offering the latest — never at its end.
  const landAt = (node) => {
    scrollTo(scroll.scrollTop + (node.getBoundingClientRect().top - scroll.getBoundingClientRect().top) - 8);
    m.paused = true; takeAnchor(); drawJump();
  };
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
      Object.assign(m, fresh, { open: m.open, rebuild });
      list.innerHTML = "";
      if (fromCursor) return false;
    }
    const hadItems = m.items.size > 0;
    // The cursor advances only as far as this page: a tick cut short resumes
    // from nextAfter, not from the server's head (items would be lost for good).
    m.conversationId = data.conversationId; m.generation = data.generation; m.rev = data.more ? data.nextAfter : data.rev;
    m.title = data.title; m.mode = data.mode; m.permissionMode = data.permissionMode;
    m.firstOrd = data.firstOrd; m.evicted = data.evicted || 0; m.skipped = data.skipped || 0; m.orphanResults = data.orphanResults || 0;
    m.readable = data.readable !== false; m.complete = data.complete !== false; m.reason = data.reason || null;
    const h0 = scroll.scrollHeight;
    const { added, grew, first } = chatApplyItems(m, list, data.items || []);
    if (m.rebuild) return true; // placed, not scrolled: finishRebuild decides
    if (m.paused) { if (added + grew) { m.unseen += added + grew; drawJump(); } return true; }
    if (!first) return true; // an unchanged tick never moves the view
    const growth = scroll.scrollHeight - h0;
    if (hadItems && scroll.clientHeight > 0 && growth > scroll.clientHeight * 0.8) landAt(first); else toBottom();
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
  };
  // Draw what the model already holds (back from another tab) before the first
  // poll — at the reader's place when they had scrolled up, with the pill.
  if (m.items.size) {
    chatApplyItems(m, list, [...m.items.values()]);
    drawHeader(); drawLive();
    if (m.paused && restoreAnchor()) drawJump(); else follow();
  }
  refresh();
  chatPolls.set(el, setInterval(refresh, CHAT_POLL_MS));
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
      try { await navigator.clipboard.writeText(text); ok = true; } catch {}
      e.target.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => { e.target.textContent = "Copy"; }, 1500);
    });
    pre.replaceWith(wrap);
    wrap.appendChild(hd);
    wrap.appendChild(pre);
  });
}
