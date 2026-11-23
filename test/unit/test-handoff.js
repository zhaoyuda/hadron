/**
 * Handoff between backends (C3) — server/handoff.js + POST /api/sessions/:id/handoff.
 *
 * Pure: the handoff text (checkpoint, git changes, exchanges, queued messages,
 * control characters stripped, clipped), exchanges from Hadron's conversation
 * items and from a cursor-agent transcript, the cursor project slug, peer ids.
 *
 * Live, at the REAL tmux boundary (private socket): a process NAMED claude
 * (cc-fix) hands off to a process NAMED cursor-agent painting cursor-agent's
 * composer (cur-fix) — the linked peer is created in the same cwd, the handoff
 * file is written 0600, the source is parked with its queued messages moved
 * into the handoff, and the handoff reaches the cursor fixture as its first
 * message; the way back unparks the source and carries the cursor transcript's
 * exchanges. Refusals: 401 / 400 / 404 / 409 while working.
 *
 * Run: node test/unit/test-handoff.js      Requires: tmux, git on PATH.
 */
import "./hadron-home.js";
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { handoffText, exchangesFromItems, exchangesFromCursorTranscript, newestCursorTranscript, cursorProjectSlug, peerIdFor, HANDOFF_TEXT_MAX } from "../../server/handoff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
}

const T = mkdtempSync(join(tmpdir(), "hadron-handoff-"));

// ── pure ────────────────────────────────────────────────────────────────────
console.log("1. handoff text");
{
  const source = { name: "alpha", cwd: "/w/proj", task: "port the parser", checkpoint: { goal: "parser in rust", next: "fix the lexer test", outputs: ["src/lex.rs"] } };
  const changes = { root: "/w/proj", branch: "feat-x", files: [{ path: "src/lex.rs", status: "modified", add: 12, del: 3 }, { path: "new.txt", status: "untracked", add: 1, del: 0 }], total: 2 };
  const text = handoffText({ source, from: "claude", to: "cursor", reason: "Usage limit", exchanges: [{ user: "do the lexer", reply: "Done, one test left" }], changes, queued: ["also update the README"], file: "/w/.hadron/handoff/a.md", at: "2026-11-23T00:00:00.000Z" });
  ok(/^# Handoff from Claude Code — agent "alpha"/.test(text), "title names the source backend and agent");
  ok(text.includes("it stopped: Usage limit") && text.includes("mechanically"), "says why it stopped and that it was written mechanically");
  ok(text.includes("- Working folder: /w/proj") && text.includes("- Task: port the parser"), "working folder + task");
  ok(text.includes("- Goal: parser in rust") && text.includes("- Next: fix the lexer test") && text.includes("- Outputs: src/lex.rs"), "checkpoint");
  ok(text.includes("branch feat-x") && text.includes("- modified src/lex.rs +12 −3") && text.includes("- untracked new.txt +1 −0"), "git changes with +/−");
  ok(text.includes("**User:**\ndo the lexer") && text.includes("**Claude:**\nDone, one test left"), "the exchange, labelled by backend");
  ok(text.includes("## Messages the user had queued") && text.includes("also update the README") && /starting with the queued messages/.test(text), "queued messages + told to start with them");
  ok(text.includes("saved at /w/.hadron/handoff/a.md"), "names the saved copy");
  const back = handoffText({ source, from: "cursor", to: "claude", exchanges: [{ user: "q", reply: "" }] });
  ok(back.includes("**Cursor:**") && back.includes("(no text reply"), "from cursor: Cursor label; an empty reply says so");
  ok(!back.includes("## Uncommitted") && !back.includes("## Messages the user"), "no git section without a repo, no queue section without messages");
  const clean = handoffText({ source: { name: "a", cwd: "/x" }, from: "claude", to: "cursor", changes: { root: "/x", branch: "main", files: [], total: 0 } });
  ok(clean.includes("the working tree is clean"), "a clean tree says so");
  const dirty = handoffText({ source: { name: "a\x1b[31m", cwd: "/x", task: "t\x07" }, from: "claude", to: "cursor", exchanges: [{ user: "a\x00b\tc", reply: "r" }] });
  ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(dirty) && dirty.includes("ab\tc"), "control characters stripped, tab kept (the outbox would refuse them)");
  const huge = handoffText({ source: { name: "a", cwd: "/x" }, from: "claude", to: "cursor", file: "/f.md", exchanges: Array.from({ length: 6 }, () => ({ user: "u".repeat(5000), reply: "r".repeat(5000) })), queued: Array.from({ length: 30 }, () => "q".repeat(3000)) });
  ok(huge.length <= HANDOFF_TEXT_MAX + 200 && huge.endsWith("the whole text is in /f.md]"), `clipped to HANDOFF_TEXT_MAX with a pointer to the file (${huge.length})`);
  ok(handoffText({ source: { name: "a", cwd: "/x" }, from: "claude", to: "cursor", exchanges: [{ user: "x".repeat(4000), reply: "y" }] }).includes("[… 2500 more chars]"), "a long prompt is clipped with a count");
}

console.log("\n2. exchanges, slug, peer ids");
{
  const items = [
    { kind: "user", text: "first" }, { kind: "assistant", blocks: [{ type: "thinking", text: "hm" }, { type: "text", text: "one" }] },
    { kind: "command", name: "/model" }, { kind: "assistant", blocks: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "two" }] },
    { kind: "user", text: "  " }, { kind: "user", text: "second" }, { kind: "assistant", blocks: [{ type: "text", text: "three" }] },
  ];
  const ex = exchangesFromItems(items);
  ok(ex.length === 2 && ex[0].user === "first" && ex[0].reply === "one\n\ntwo" && ex[1].reply === "three", `user + the text blocks after it, thinking/tools left out (${JSON.stringify(ex)})`);
  ok(exchangesFromItems(items, 1).length === 1 && exchangesFromItems(items, 1)[0].user === "second", "the last n");
  ok(exchangesFromItems([{ kind: "assistant", blocks: [{ type: "text", text: "orphan" }] }]).length === 0, "a reply with no prompt before it is dropped");
  ok(cursorProjectSlug("/home/u/work/my_proj.v2") === "home-u-work-my-proj-v2", "cursor slug: / . _ → -, leading - dropped");
  ok(peerIdFor("alpha", "cursor") === "alpha-cursor" && peerIdFor("alpha-cursor", "claude") === "alpha", "alpha ↔ alpha-cursor");
  ok(peerIdFor("beta", "claude") === "beta-claude", "a cursor agent with no -cursor suffix → <id>-claude");

  const home = join(T, "purehome");
  const dir = join(home, ".cursor", "projects", cursorProjectSlug("/w/p"), "agent-transcripts");
  const mk = (chat, lines, mtime) => {
    mkdirSync(join(dir, chat), { recursive: true });
    const f = join(dir, chat, `${chat}.jsonl`);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    utimesSync(f, mtime / 1000, mtime / 1000);
    return f;
  };
  const now = Date.now();
  const u = (q) => ({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Sunday</timestamp>\n<user_query>\n${q}\n</user_query>` }] } });
  const a = (t) => ({ role: "assistant", message: { content: [{ type: "text", text: t }] } });
  mk("old-chat", [u("old"), a("old reply")], now - 3600_000);
  const fnew = mk("new-chat", [u("fix it"), a("looking"), { type: "turn_ended", status: "success" }, a("fixed"), u("now tests"), a("green")], now - 1000);
  ok(newestCursorTranscript("/w/p", 0, home) === fnew, "newest chat in the cwd's project");
  ok(newestCursorTranscript("/w/p", now + 60_000, home) === null, "none written since → null");
  ok(newestCursorTranscript("/w/other", 0, home) === null, "another cwd → null");
  const cx = exchangesFromCursorTranscript(fnew);
  ok(cx.length === 2 && cx[0].user === "fix it" && cx[0].reply === "looking\n\nfixed" && cx[1].user === "now tests" && cx[1].reply === "green", `user_query unwrapped, replies joined (${JSON.stringify(cx)})`);
  ok(exchangesFromCursorTranscript(join(dir, "nope.jsonl")).length === 0, "a missing file → []");
}

// ── live ────────────────────────────────────────────────────────────────────
const PORT = await new Promise((res, rej) => {
  const srv = createServer(); srv.on("error", rej);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = join(T, "tmux.sock");
const HOME = join(T, "home");
const FIX = join(T, "bin");
const WS = join(T, "ws");
const PROJ = join(WS, "proj");
const LOG = join(T, "claude-input.log");
const CLOG = join(T, "cursor-input.log");
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
for (const d of [HOME, FIX, PROJ, join(WS, ".hadron")]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME, ".profile"), `export PATH="${FIX}:$PATH"\n`);
writeFileSync(join(HOME, ".bashrc"), `export PATH="${FIX}:$PATH"\n`);
const FIXTURE = join(FIX, "claude");
writeFileSync(FIXTURE, `#!/usr/bin/env bash
if [ -z "$HADRON_FIX_REEXEC" ]; then HADRON_FIX_REEXEC=1 exec -a claude bash "$0" "$@"; fi
LOG="$1"
printf '\\n❯ \\n'
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$LOG"; printf '\\n❯ \\n'
done
`);
chmodSync(FIXTURE, 0o755);
const CUR = join(T, "cursor-screens");
mkdirSync(CUR);
writeFileSync(join(CUR, "idle.txt"), readFileSync(new URL("./fixtures/cursor/02-idle.txt", import.meta.url), "utf-8").replace(/\n+$/, "\n"));
const CFIXTURE = join(FIX, "cursor-fix");
writeFileSync(CFIXTURE, `#!/usr/bin/env bash
if [ -z "$HADRON_FIX_REEXEC" ]; then HADRON_FIX_REEXEC=1 exec -a cursor-agent bash "$0" "$@"; fi
LOG="$1"; D="$2"
paint() { printf '\\e[2J\\e[H'; cat "$D/$1.txt"; }
paint idle
while IFS= read -r line; do
  if [ -z "$line" ]; then printf '<ENTER>\\n' >> "$LOG"; else printf '%s\\n' "$line" >> "$LOG"; fi
  paint idle
done
`);
chmodSync(CFIXTURE, 0o755);
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({
  name: "handoff", groups: ["Workers"],
  launchers: { "cc-fix": { argv: [FIXTURE, LOG], kind: "claude" }, "cur-fix": { argv: [CFIXTURE, CLOG, CUR], kind: "cursor" } },
  launchCommand: "cc-fix",
}, null, 2));
const git = (...a) => execFileSync("git", ["-C", PROJ, ...a], { stdio: "ignore", env: { ...process.env, HOME, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
git("init", "-q", "-b", "work");
writeFileSync(join(PROJ, "lex.rs"), "fn a() {}\n");
git("add", "."); git("commit", "-q", "-m", "init");
writeFileSync(join(PROJ, "lex.rs"), "fn a() {}\nfn b() {}\n");

const tenv = { ...process.env, PATH: `${FIX}:${process.env.PATH}`, HOME };
delete tenv.TMUX;
function tmuxSafe(args) { try { return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: tenv }).trim(); } catch { return null; } }
const paneOf = (id) => `hadron-${WS_NAME}-${id}`;
const paneCmd = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_current_command}"]);
const read = (f) => (existsSync(f) ? readFileSync(f, "utf-8") : "").replace(/\x1b\[20[01]~/g, "");

let server, TOKEN, serverLog = "";
const H = () => ({ "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: BASE });
const api = async (method, p, body, headers = H()) => {
  const r = await fetch(`${BASE}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const listed = async (id) => (await api("GET", "/api/sessions")).json.find((s) => s.id === id);
const onDisk = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));
const handoff = (id, body) => api("POST", `/api/sessions/${id}/handoff`, body);

async function live() {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash", PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: "handoff-boot", HADRON_CURSOR_AGENT: "/nonexistent/cursor-agent", HADRON_HANDOFF_WAIT_MS: "20000",
    INVOCATION_ID: "", XPC_SERVICE_NAME: "",
  };
  delete env.TMUX; delete env.TMUX_PANE;
  server = spawn("node", [join(REPO, "server", "index.js"), WS], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  if (!await until(async () => { try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; } }, 10000)) throw new Error("server did not start");
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  const r = await api("POST", "/api/sessions", { name: "alpha", cwd: PROJ, launchCommand: "cc-fix", group: "Workers", task: "port the lexer", autostart: true });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  const id = r.json.id;
  ok(await until(() => paneCmd(id) === "claude", 15000), "source runs as claude");
  ok(await until(async () => (await listed(id))?.state === "idle", 15000), "…idle");
  await api("POST", `/api/sessions/${id}/checkpoint`, { goal: "lexer ported", next: "the b() test" });

  console.log("\n3. refusals");
  const noTok = await api("POST", `/api/sessions/${id}/handoff`, { to: "cursor", launchCommand: "cur-fix" }, { "Content-Type": "application/json", Origin: BASE });
  ok(noTok.status === 401, `no token → 401 (${noTok.status})`);
  ok((await handoff(id, { to: "codex" })).status === 400, "to: codex → 400");
  ok((await handoff(id, { to: "claude" })).status === 400, "claude → claude → 400");
  ok((await handoff("nobody", { to: "cursor" })).status === 404, "unknown agent → 404");
  ok((await handoff(id, { to: "cursor", launchCommand: "cc-fix" })).status === 400, "a launcher of the wrong kind → 400");
  await api("PATCH", `/api/sessions/${id}`, { state: "working" });
  const busy = await handoff(id, { to: "cursor", launchCommand: "cur-fix" });
  ok(busy.status === 409 && /middle of a turn/.test(busy.json?.error || ""), `while working → 409 (${busy.status})`);
  ok(!existsSync(join(WS, ".hadron", "agents", `${id}-cursor.json`)), "…and no peer was made");
  await api("PATCH", `/api/sessions/${id}`, { state: "idle" });
  // An unrelated agent already holding the peer's id is never taken over.
  const g = await api("POST", "/api/sessions", { name: "gamma", cwd: PROJ, launchCommand: "cc-fix", group: "Workers" });
  const gc = await api("POST", "/api/sessions", { name: "gamma-cursor", cwd: PROJ, launchCommand: "cur-fix", group: "Workers" });
  const taken = await handoff(g.json.id, { to: "cursor", launchCommand: "cur-fix" });
  ok(gc.json?.id === `${g.json.id}-cursor` && taken.status === 409 && /not linked/.test(taken.json?.error || ""), `an unrelated ${g.json.id}-cursor → 409 (${taken.status} ${taken.json?.error || ""})`);
  ok(!onDisk(gc.json.id).handoff && !onDisk(g.json.id).parked, "…nothing linked or parked");
  await api("DELETE", `/api/sessions/${gc.json.id}`);
  const takenArchived = await handoff(g.json.id, { to: "cursor", launchCommand: "cur-fix" });
  ok(takenArchived.status === 409, `…a closed unrelated one is not revived either (${takenArchived.status})`);
  await api("DELETE", `/api/sessions/${g.json.id}`);

  console.log("\n4. claude → cursor");
  // A message queued for the source (the record's outbox, as a blocked agent would hold it).
  await api("PATCH", `/api/sessions/${id}`, { state: "blocked" });
  const q = await api("POST", `/api/sessions/${id}/message`, { text: "and update the README", requestId: "q-1", when: "auto" });
  ok(q.status === 202 && q.json?.entry?.state === "queued", `a message queued while blocked (${q.status})`);
  // No launcher named, no cursor-agent installed → the workspace's own cursor launcher (cur-fix).
  const h = await handoff(id, { to: "cursor" });
  ok(h.status === 200 && h.json.ok && h.json.peer?.id === `${id}-cursor` && h.json.created === true, `200, a new peer ${id}-cursor (${h.status} ${JSON.stringify(h.json?.error || h.json?.peer?.id)})`);
  ok(h.json.moved === 1, "one queued message moved into the handoff");
  const pid = h.json.peer.id;
  const file = join(WS, h.json.file || "x");
  ok(existsSync(file) && (statSync(file).mode & 0o777) === 0o600 && (statSync(dirname(file)).mode & 0o777) === 0o700, `handoff written under .hadron/handoff/, 0600 in a 0700 dir (${h.json.file})`);
  const text = read(file);
  ok(text.includes('# Handoff from Claude Code — agent "alpha"') && text.includes("- Task: port the lexer") && text.includes("- Goal: lexer ported"), "the file has title, task, checkpoint");
  ok(text.includes("branch work") && /- modified lex\.rs \+1 −0/.test(text), "…git's picture of the cwd");
  ok(text.includes("and update the README"), "…and the queued message");
  const src = onDisk(id), peer = onDisk(pid);
  ok(src.parked === true && src.handoff?.peer === pid && src.handoff.dir === "out", "source parked, linked out");
  ok(!src.outbox?.some((e) => e.state === "queued"), "…its queue is empty (nothing will be pasted into it)");
  ok(peer.launchCommand === "cur-fix" && peer.backend === "cursor" && peer.cwd === PROJ && peer.handoff?.peer === id && peer.handoff.dir === "in" && !peer.parked, "peer: cursor backend, same cwd, linked in, not parked");
  ok(src.relatedAgents?.includes(pid) && peer.relatedAgents?.includes(id), "related both ways");
  ok(peer.task === "port the lexer" && peer.group === "Workers", "peer carries task and group");
  ok(await until(() => read(CLOG).includes("# Handoff from Claude Code"), 20000), "the handoff reached cursor-agent as its first message");
  ok(await until(() => read(CLOG).includes("<ENTER>"), 5000), "…and was submitted");
  ok(await until(async () => (await api("GET", `/api/sessions/${pid}/outbox`)).json?.outbox?.some((e) => /^handoff-/.test(e.id) && e.state === "handed"), 5000), "…as an outbox entry, handed");
  ok(!read(LOG).includes("and update the README"), "the queued message never reached the source");
  const again = await handoff(id, { to: "cursor", launchCommand: "cur-fix" });
  ok(again.status === 200 && again.json.peer.id === pid && again.json.created === false, "a second handoff the same way reuses the linked peer");

  console.log("\n5. cursor → claude (the way back)");
  // cursor-agent's own transcript for the cwd — what the way back carries.
  const cdir = join(HOME, ".cursor", "projects", cursorProjectSlug(PROJ), "agent-transcripts", "c1");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, "c1.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "<timestamp>x</timestamp>\n<user_query>\nwrite b()\n</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "b() written, test passes" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  ok(await until(async () => ["idle", "done"].includes((await listed(pid))?.state), 8000), "peer idle");
  await api("PATCH", `/api/sessions/${id}`, { state: "working" });
  const peerBusy = await handoff(pid, { to: "claude" });
  ok(peerBusy.status === 409 && /middle of a turn/.test(peerBusy.json?.error || ""), `the claude peer mid-turn → 409 (${peerBusy.status})`);
  await api("PATCH", `/api/sessions/${id}`, { state: "idle" });
  const LOGLEN = read(LOG).length;
  const b = await handoff(pid, { to: "claude" });
  ok(b.status === 200 && b.json.peer.id === id && b.json.created === false, `back to the source (${b.status} ${b.json?.error || ""})`);
  const back = read(join(WS, b.json.file));
  ok(back.includes("# Handoff from Cursor (cursor-agent)") && back.includes("**User:**\nwrite b()") && back.includes("**Cursor:**\nb() written, test passes"), "the cursor transcript's exchange is in it");
  const s2 = onDisk(id), p2 = onDisk(pid);
  ok(!s2.parked && s2.handoff.dir === "in" && p2.parked === true && p2.handoff.dir === "out", "source unparked + linked in, cursor peer parked");
  ok(await until(() => read(LOG).slice(LOGLEN).includes("# Handoff from Cursor"), 15000), "the handoff reached the running claude");

  ok(await until(async () => !(await api("GET", `/api/sessions/${id}/outbox`)).json?.outbox?.some((e) => e.state === "sending"), 5000), "…its delivery finished");
  ok((await api("GET", `/api/sessions/${id}/outbox`)).json?.outbox?.some((e) => /^handoff-/.test(e.id) && e.idleOnly === true), "…as an idle-only entry (claude's empty prompt, never mid-turn)");
  console.log("\n6. the peer was closed → revived on the next handoff");
  const del = await api("DELETE", `/api/sessions/${pid}`);
  ok(del.status === 200 && await until(() => tmuxSafe(["has-session", "-t", `=${paneOf(pid)}`]) === null, 5000), `cursor peer archived, tmux gone (${del.status} ${JSON.stringify(del.json)})`);
  const CLEN = read(CLOG).length;
  const c = await handoff(id, { to: "cursor", launchCommand: "cur-fix" });
  ok(c.status === 200 && c.json.peer.id === pid && c.json.created === true && !c.json.peer.archived, `the archived peer is revived (${c.status} ${c.json?.error || ""})`);
  const twice = await handoff(id, { to: "cursor", launchCommand: "cur-fix" });
  ok(twice.status === 409 && /already in progress/.test(twice.json?.error || ""), `a second handoff while the first is still being delivered → 409 (${twice.status})`);
  ok(await until(() => read(CLOG).slice(CLEN).includes("# Handoff from Claude Code"), 20000), "…and gets the handoff");

  console.log("\n7. no leaks");
  ok(!serverLog.includes(TOKEN), "server log carries no token");
  ok(/\[handoff\] .* → .*\(claude → cursor\)/.test(serverLog), "the handoff is logged by agent id");
}

try {
  await live();
} catch (e) {
  failed++; console.error(`  ✗ unexpected: ${e.stack || e}`);
} finally {
  if (server && server.exitCode === null) { const g = new Promise((r) => server.once("exit", r)); server.kill("SIGKILL"); await g; }
  tmuxSafe(["kill-server"]);
  // fixture processes killed with the tmux server may still be writing
  try { rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
