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
    firstOrd: null, evicted: 0, skipped: 0, orphanResults: 0, readable: true, complete: true, offline: false, reason: null, open: new Set(), paused: false, unseen: 0, lastFetchAt: 0 };
}
function stopChatPoll(el) { const t = chatPolls.get(el); if (t) { clearInterval(t); chatPolls.delete(el); } }

function renderChatView(el, s) {
  stopChatPoll(el);
  if (!s) return;
  const sessionId = s.id;
  const m = chatModel(sessionId);
  el.innerHTML = `<div class="chat">
    <div class="chat-hdr"><span class="chat-title"></span><span class="chat-mode"></span><span class="chat-note"></span><span class="chat-tools" title="Open every tool card">${chatExpandAll ? "Collapse tools" : "Expand tools"}</span></div>
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
  scroll.addEventListener("scroll", () => {
    if (programmatic !== null && Math.abs(scroll.scrollTop - programmatic) < 2) { programmatic = null; return; }
    programmatic = null;
    const paused = !atBottom();
    if (paused === m.paused) return;
    m.paused = paused;
    if (!paused) m.unseen = 0;
    drawJump();
  });
  const drawJump = () => {
    jump.hidden = !m.paused;
    jump.textContent = m.unseen ? `↓ ${m.unseen} new` : "↓";
  };
  jump.addEventListener("click", () => { m.paused = false; m.unseen = 0; toBottom(); drawJump(); });
  el.querySelector(".chat-tools").addEventListener("click", (e) => {
    chatExpandAll = !chatExpandAll; if (typeof saveUIState === "function") saveUIState();
    e.target.textContent = chatExpandAll ? "Collapse tools" : "Expand tools";
    list.querySelectorAll(".ci-tool").forEach((t) => chatSetOpen(m, t, chatExpandAll));
  });
  const earlier = el.querySelector(".chat-earlier");
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
    const notes = [];
    if (m.offline) notes.push("offline — retrying");
    else if (m.reason === "token") notes.push("sign-in needed — the server rejected the token");
    else if (m.items.size && !m.conversationId) notes.push("this agent is no longer running claude — showing the last picture");
    else if (!m.readable) notes.push("transcript unreadable — showing the last picture");
    else if (!m.complete) notes.push("reading…");
    if (m.evicted) notes.push(`${m.evicted} earlier item${m.evicted === 1 ? "" : "s"} not held`);
    if (m.skipped) notes.push(`${m.skipped} oversize record${m.skipped === 1 ? "" : "s"} skipped`);
    if (m.orphanResults) notes.push(`${m.orphanResults} tool result${m.orphanResults === 1 ? "" : "s"} without a call`);
    note.textContent = notes.join(" · ");
    note.classList.toggle("chat-note-warn", m.offline || !m.readable || m.reason === "token" || (m.items.size > 0 && !m.conversationId));
    const first = chatFirstOrd(m);
    const older = first !== null && m.firstOrd !== null && first > m.firstOrd;
    earlier.hidden = !older;
    if (older && !earlier.dataset.busy) earlier.textContent = `Load earlier (${first - m.firstOrd} more)`;
  };
  const drawLive = () => {
    const sess = (typeof sessions !== "undefined" ? sessions : []).find((x) => x.id === sessionId);
    const working = sess && sess.state === "working";
    const last = chatLastItem(m);
    if (!working) { live.hidden = true; return; }
    let since = "";
    if (last && last.at) { const sec = Math.max(0, Math.round((Date.now() - Date.parse(last.at)) / 1000)); if (Number.isFinite(sec)) since = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`; }
    let act = "";
    if (last && last.kind === "assistant") { const tu = [...last.blocks].reverse().find((b) => b.type === "tool_use"); if (tu) act = `${tu.name} ${chatToolSummary(tu, sess)}`.trim(); }
    live.hidden = false;
    live.innerHTML = `<span class="chat-live-dot"></span>Working${since ? ` · ${esc(since)}` : ""}${act ? ` · <span class="chat-live-act">${esc(act)}</span>` : ""}`;
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
      // A different conversation (/clear, resume), a replaced file, or a
      // server-side cache rebuilt from scratch (rev went backwards, generation
      // 0 again): the picture is dropped, never silently extended.
      const fresh = chatFreshModel(sessionId);
      fresh.paused = false;
      Object.assign(m, fresh, { open: m.open });
      list.innerHTML = "";
      if (fromCursor) return false;
    }
    // The cursor advances only as far as this page: a tick cut short resumes
    // from nextAfter, not from the server's head (items would be lost for good).
    m.conversationId = data.conversationId; m.generation = data.generation; m.rev = data.more ? data.nextAfter : data.rev;
    m.title = data.title; m.mode = data.mode; m.permissionMode = data.permissionMode;
    m.firstOrd = data.firstOrd; m.evicted = data.evicted || 0; m.skipped = data.skipped || 0; m.orphanResults = data.orphanResults || 0;
    m.readable = data.readable !== false; m.complete = data.complete !== false; m.reason = data.reason || null;
    const { added, changed } = chatApplyItems(m, list, data.items || []);
    if (added && m.paused) { m.unseen += added; drawJump(); }
    if (!m.paused && (added || changed)) toBottom(); // an unchanged tick never moves the view
    return true;
  };
  const refresh = async () => {
    if (!el.isConnected) { stopChatPoll(el); return; }
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
        after = data.more ? data.nextAfter : null;
        if (after === null) break;
      }
    } catch { m.offline = true; }
    if (!el.isConnected) return;
    drawHeader(); drawLive(); drawEmpty();
  };
  // Draw what the model already holds (back from another tab) before the first poll.
  if (m.items.size) { m.paused = false; m.unseen = 0; chatApplyItems(m, list, [...m.items.values()]); drawHeader(); toBottom(); }
  refresh();
  chatPolls.set(el, setInterval(refresh, CHAT_POLL_MS));
}

function chatFirstOrd(m) { let f = null; for (const it of m.items.values()) if (f === null || it.ord < f) f = it.ord; return f; }
function chatLastItem(m) { let l = null; for (const it of m.items.values()) if (!l || it.ord > l.ord) l = it; return l; }

// Place items by ord, replacing an element whose rev moved. Returns how many
// NEW items landed and how many existing ones were re-rendered.
function chatApplyItems(m, list, items) {
  let added = 0, changed = 0;
  const sorted = [...items].sort((a, b) => a.ord - b.ord);
  for (const it of sorted) {
    const prev = m.items.get(it.id);
    const old = list.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
    if (prev && old && prev.rev === it.rev) continue;
    m.items.set(it.id, it);
    const node = chatItemEl(m, it);
    if (old) { old.replaceWith(node); changed++; continue; }
    added++;
    let before = null;
    for (const c of list.children) { if (c.dataset.ord !== undefined && Number(c.dataset.ord) > it.ord) { before = c; break; } }
    list.insertBefore(node, before);
  }
  return { added, changed };
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
    case "assistant": {
      let html = "";
      it.blocks.forEach((b, i) => {
        if (b.type === "thinking") {
          if (!b.text) return;
          const key = `${it.id}:think:${i}`;
          html += `<details class="ci-think" data-think="${esc(key)}"${m.open.has(key) ? " open" : ""}><summary>Thinking <span class="ci-dim">${esc(chatCount(b.text))}</span></summary><div class="ci-think-body">${esc(b.text)}</div></details>`;
        } else if (b.type === "text") {
          html += `<div class="ci-md md-preview">${chatMarkdown(b.text || "")}${b.truncated ? `<div class="ci-trunc">… (clipped)</div>` : ""}</div>`;
        } else if (b.type === "tool_use") {
          html += chatToolHtml(m, b, it, sess);
        }
      });
      if (it.blocksTruncated) html += `<div class="ci-trunc">… more blocks not shown</div>`;
      if (it.error) div.classList.add("ci-error");
      div.innerHTML = `${html}${when}`;
      div.querySelectorAll(".ci-tool-hd").forEach((hd) => hd.addEventListener("click", (e) => { if (e.target.closest("a,[data-open-path]")) return; const t = hd.parentElement; chatSetOpen(m, t, !t.classList.contains("open")); }));
      div.querySelectorAll(".ci-think").forEach((d) => d.addEventListener("toggle", () => { if (d.open) m.open.add(d.dataset.think); else m.open.delete(d.dataset.think); }));
      div.querySelectorAll("[data-open-path]").forEach((a) => a.addEventListener("click", (e) => { e.stopPropagation(); if (typeof switchTab === "function") switchTab(`file:${a.dataset.openPath}`); }));
      chatDecorateCode(div);
      break;
    }
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
      div.innerHTML = it.op === "enqueue" ? `<div class="ci-line ci-queue">queued: ${esc(it.text || "")}</div>` : "";
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
  else if (sess && sess.state === "working") { status = "…"; cls = "run"; }
  else { status = "–"; cls = "none"; }
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
  } else if (cls === "none") body += `<div class="ci-dim ci-tool-nores">no result recorded</div>`;
  return `<div class="ci-tool${open ? " open" : ""}" data-tool="${esc(b.id)}"><div class="ci-tool-hd"><span class="ci-tool-st ci-tool-st-${cls}">${status}</span><span class="ci-tool-name">${esc(b.name)}</span>${sumHtml}<span class="ci-tool-caret">▸</span></div><div class="ci-tool-body">${body}</div></div>`;
}

// Code blocks in assistant markdown get a sticky header: language + Copy.
function chatDecorateCode(root) {
  root.querySelectorAll(".ci-md pre").forEach((pre) => {
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
