/**
 * The composer's outbox (chat view, G3) at the REAL tmux boundary:
 * POST /api/sessions/:id/message with a requestId — idempotent, serialised per
 * pane, pasted at once while working (claude queues it), queued while blocked, handed/failed/uncertain on
 * the record — plus GET/DELETE …/outbox and the list wire form.
 *
 * Private tmux server (HADRON_TMUX_SOCKET) + a process actually NAMED claude:
 * the fixture reads lines from its tty into a log and prints `❯ ` so the state
 * detector reads idle. What reached "claude" is what is in the log.
 *
 * Run: node test/unit/test-outbox.js
 * Requires: tmux on PATH.
 */
import "./hadron-home.js";
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const PORT = await new Promise((res, rej) => {
  const srv = createServer(); srv.on("error", rej);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const TTL_MS = 4000; // handed entries are forgotten after this (HADRON_OUTBOX_HANDED_TTL_MS)

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

const T = mkdtempSync(join(tmpdir(), "hadron-outbox-"));
const SOCK = join(T, "tmux.sock");
const HOME = join(T, "home");
const FIX = join(T, "bin");
const WS = join(T, "ws");
const LOG = join(T, "claude-input.log");
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
for (const d of [HOME, FIX, WS, join(WS, "a1"), join(WS, ".hadron")]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME, ".profile"), `export PATH="${FIX}:$PATH"\n`);
writeFileSync(join(HOME, ".bashrc"), `export PATH="${FIX}:$PATH"\n`);
const FIXTURE = join(FIX, "claude");
const DLG = join(T, "dialog.txt");
// claude refusing a turn at its empty prompt / a block claude is still retrying (state-detector fixtures).
for (const [to, from] of [["model.txt", "blocked-model-issue.txt"], ["ratelim.txt", "blocked-retry-banner-dot-in-message.txt"]]) {
  writeFileSync(join(T, to), readFileSync(new URL(`./fixtures/state-detector/${from}`, import.meta.url), "utf-8").split("\n").filter((l) => l.trim()).slice(-14).join("\n") + "\n");
}
// claude's Bash permission dialog (the blocked-dialog-bash-v2 shape) — what the
// fixture paints on a DIALOG line, pinned at the bottom like claude does.
writeFileSync(DLG, `──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Remove zz.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 rm -f zz.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /home/user/proj
      from this project
   3. No

 Esc to cancel · Tab to amend
`);
// A process named claude (exec -a) that logs every line typed at it and shows
// a ❯ prompt — enough for pane_current_command, the shell guard and the state
// detector. Bracketed-paste markers arrive as bytes in the line; stripped below.
writeFileSync(FIXTURE, `#!/usr/bin/env bash
if [ -z "$HADRON_FIX_REEXEC" ]; then HADRON_FIX_REEXEC=1 exec -a claude bash "$0" "$@"; fi
LOG="$1"; DLG="$2"
printf '\\n❯ \\n'
while IFS= read -r line; do
  if [ -n "$SPIN" ] && { [ "$line" = DIALOG ] || [ "$line" = IDLE ] || [ "$line" = WORK ] || [ "$line" = STALE ]; }; then kill "$SPIN" 2>/dev/null; wait "$SPIN" 2>/dev/null; SPIN=; fi
  if [ "$line" = DIALOG ]; then printf '\\e[2J\\e[H'; yes '' | head -n 40; cat "$DLG"; continue; fi
  if [ "$line" = IDLE ]; then printf '\\e[2J\\e[H\\n❯ \\n'; continue; fi
  if [ "$line" = WORK ]; then ( i=1; while :; do printf '\\e[2J\\e[H\\n✻ Thinking… (%ss · 12 tokens)\\n\\n❯ \\n' "$i"; i=$((i+1)); sleep 0.3; done ) & SPIN=$!; continue; fi
  if [ "$line" = EDITOR ]; then printf '\\e[?1049h\\e[2J\\e[Hsome notes in an editor\\n'; continue; fi
  if [ "$line" = NOEDITOR ]; then printf '\\e[?1049l\\e[2J\\e[H\\n❯ \\n'; continue; fi
  if [ "$line" = DRAFT ]; then printf '\\e[2J\\e[H\\n❯ half-typed thought\\n'; continue; fi
  if [ "$line" = DRAFT2 ]; then printf '\\e[2J\\e[H\\n────────\\n❯ \\n  second line of a draft\\n────────\\n  footer text\\n'; continue; fi
  if [ "$line" = DRAFT3 ]; then printf '\\e[2J\\e[H\\n❯ \\e[38;2;170;180;190mcoloured draft\\e[0m\\n'; continue; fi
  if [ "$line" = BOXED ]; then printf '\\e[2J\\e[H\\n────────\\n❯\\302\\240\\n────────\\n  footer text\\n'; continue; fi
  if [ "$line" = HINT ]; then printf '\\e[2J\\e[H\\n❯\\302\\240\\e[2mtry this\\e[0m\\n'; continue; fi
  if [ "$line" = MODELERR ]; then printf '\\e[2J\\e[H'; yes '' | head -n 40; cat "$(dirname "$DLG")/model.txt"; continue; fi
  if [ "$line" = RATELIM ]; then printf '\\e[2J\\e[H'; yes '' | head -n 40; cat "$(dirname "$DLG")/ratelim.txt"; continue; fi
  if [ "$line" = NOPROMPT ]; then printf '\\e[2J\\e[Hplain output, no prompt\\n'; continue; fi
  if [ "$line" = STALE ]; then printf '\\e[2J\\e[H\\n✻ Thinking… (3s · 12 tokens)\\n\\n❯ \\n'; continue; fi
  printf '%s\\n' "$line" >> "$LOG"; printf '\\n❯ \\n'
done
`);
chmodSync(FIXTURE, 0o755);
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({
  name: "outbox", groups: ["Workers"],
  launchers: { "cc-fix": { argv: [FIXTURE, LOG, DLG], kind: "claude" } },
}, null, 2));

const tenv = { ...process.env, PATH: `${FIX}:${process.env.PATH}`, HOME };
delete tenv.TMUX;
function tmuxS(args) { return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: tenv }); }
function tmuxSafe(args) { try { return tmuxS(args).trim(); } catch { return null; } }
const paneOf = (id) => `hadron-${WS_NAME}-${id}`;
const paneCmd = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_current_command}"]);
const typed = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8") : "").replace(/\x1b\[20[01]~/g, "").split("\n").filter(Boolean);
const listBuffers = () => tmuxSafe(["list-buffers", "-F", "#{buffer_name}"]) || "";
const tmpLeaks = () => readdirSync(tmpdir()).filter((n) => n.startsWith("hadron-msg-"));

let server, TOKEN, serverLog = "";
function bootServer() {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash", PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: "outbox-boot", HADRON_OUTBOX_HANDED_TTL_MS: String(TTL_MS),
    INVOCATION_ID: "", XPC_SERVICE_NAME: "",
  };
  delete env.TMUX; delete env.TMUX_PANE;
  server = spawn("node", [join(REPO, "server", "index.js"), WS], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { const h = await r.json(); if (h.pid === server.pid) return h; throw new Error(`port ${PORT} is owned by pid ${h.pid}`); }
    } catch (e) { if (/owned by/.test(e.message)) throw e; }
    await sleep(100);
  }
  throw new Error("server did not come up");
}
async function killServer() {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGKILL");
  await gone;
}
const H = () => ({ "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: BASE });
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const msg = (id, body) => api("POST", `/api/sessions/${id}/message`, body);
const setState = (id, state) => api("PATCH", `/api/sessions/${id}`, { state });
const outbox = async (id) => (await api("GET", `/api/sessions/${id}/outbox`)).json.outbox;
const listed = async (id) => (await api("GET", "/api/sessions")).json.find((s) => s.id === id);
const onDisk = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));
let seq = 0;
const rid = () => `t-${Date.now().toString(36)}-${++seq}`;

async function main() {
  bootServer();
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const r = await api("POST", "/api/sessions", { name: "ob-a1", cwd: join(WS, "a1"), launchCommand: "cc-fix", group: "Workers", autostart: true });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  const id = r.json.id;
  tmuxSafe(["resize-window", "-t", paneOf(id), "-x", "120", "-y", "30"]);
  ok(await until(() => paneCmd(id) === "claude", 15000), `fixture runs in the pane as "claude" (${paneCmd(id)})`);
  ok(await until(async () => (await listed(id))?.state === "idle", 15000), "state detector reads the fixture's ❯ prompt as idle");

  console.log("\n1. immediate delivery with a requestId → handed, idempotent replay");
  let id1 = rid();
  let a = await msg(id, { text: "你好，第一条", requestId: id1, when: "auto", deviceId: "dev-A" });
  ok(a.status === 200 && a.json.ok === true && a.json.entry?.state === "handed" && a.json.entry.handedAt, `200 handed (${a.status} ${a.json?.entry?.state})`);
  ok(a.json.entry?.deviceId === "dev-A" && a.json.entry.id === id1, "entry carries requestId + deviceId");
  ok(await until(() => typed().includes("你好，第一条"), 5000), "the fixture received the line");
  let b = await msg(id, { text: "你好，第一条", requestId: id1, when: "auto" });
  ok(b.status === 200 && b.json.replay === true && b.json.entry?.state === "handed", `same requestId again → replay of the handed entry (${b.status})`);
  await sleep(600);
  ok(typed().filter((l) => l === "你好，第一条").length === 1, "…and the line was pasted exactly once");
  ok((await outbox(id)).some((e) => e.id === id1 && e.state === "handed"), "GET /outbox lists the handed entry");
  ok(onDisk(id).outbox?.some((e) => e.id === id1), "…and it is on the record");

  console.log("\n2. working: pasted at once (claude queues it for its next step)");
  await setState(id, "working");
  const idw = rid();
  a = await msg(id, { text: "干活时也发", requestId: idw, when: "auto" });
  ok(a.status === 200 && a.json.entry?.state === "handed", `200 handed while working (${a.status})`);
  ok(await until(() => typed().includes("干活时也发"), 2000), "…and the fixture received it at once");
  ok(a.json.entry.handedWhile === "working" && (await outbox(id)).find((e) => e.id === idw)?.handedWhile === "working", "…stamped handedWhile: working, on the wire too (the chat view does not wait for a bubble)");
  await setState(id, "idle");

  console.log("\n2b. queued while blocked, delivered once the dialog is gone");
  await setState(id, "blocked");
  const idq = rid();
  a = await msg(id, { text: "等一下再发", requestId: idq, when: "auto" });
  ok(a.status === 202 && a.json.queued === true && a.json.entry?.state === "queued", `202 queued while blocked (${a.status})`);
  b = await msg(id, { text: "等一下再发", requestId: idq, when: "auto" });
  ok(b.status === 202 && b.json.replay === true, "replay of a queued entry is 202 again");
  await sleep(1500);
  ok(!typed().includes("等一下再发") && (await outbox(id)).find((e) => e.id === idq)?.state === "queued", "nothing pasted into the dialog; entry still queued");
  ok((await listed(id)).outbox?.find((e) => e.id === idq)?.state === "queued", "the sessions list carries the queued entry");
  await setState(id, "idle");
  ok(await until(async () => (await outbox(id)).find((e) => e.id === idq)?.state === "handed", 4000), "handed within a few seconds of idle");
  ok(await until(() => typed().includes("等一下再发"), 2000), "…and the fixture received it");

  console.log("\n2c. a dialog on the screen the detector has not read yet: auto holds, nothing goes into its field");
  // The fixture paints the dialog this instant; the detector's verdict follows
  // within a tick. The POST lands in that window (most runs — the pane is read
  // again under the pane lock, so the entry is held either way), and whichever
  // path held it, the field never gets the text: that is the contract.
  tmuxS(["send-keys", "-t", paneOf(id), "DIALOG", "Enter"]);
  const idd = rid();
  a = await msg(id, { text: "别进对话框", requestId: idd, when: "auto" });
  ok(a.status === 202 && a.json.queued === true && a.json.entry?.state === "queued", `202 queued with the dialog on screen (${a.status}, ${a.json.entry?.state})`);
  // A quiet pane is captured only every 5th tick and blocked latches after two
  // snaps: up to ~10 s during which only the under-lock read protects the field.
  ok(await until(async () => (await listed(id))?.state === "blocked", 15000), "the detector reads the dialog as blocked (quiet-pane throttle + hysteresis: up to 10 s)");
  await new Promise((r) => setTimeout(r, 1500));
  ok(!typed().includes("别进对话框") && (await outbox(id)).find((e) => e.id === idd)?.state === "queued", "…nothing typed into the dialog, the entry is still queued");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  ok(await until(() => typed().includes("别进对话框"), 8000), "…delivered once the dialog is gone");
  ok(await until(async () => (await listed(id))?.state === "idle", 5000), "the detector reads the prompt again");

  console.log("\n2d. a dialog hold that cannot be saved is not queued either (same rule as 12)");
  tmuxS(["send-keys", "-t", paneOf(id), "DIALOG", "Enter"]);
  await until(async () => (await listed(id))?.state === "blocked", 15000);
  await setState(id, "idle"); // the detector's verdict says prompt; only the under-lock read sees the dialog
  chmodSync(join(WS, ".hadron", "agents"), 0o500);
  const idhs = rid();
  const hs = await msg(id, { text: "HOLD-SAVE-FAIL", requestId: idhs, when: "auto" });
  chmodSync(join(WS, ".hadron", "agents"), 0o755);
  ok(hs.status === 500 && /not queued/.test(hs.json.error) && !hs.json.error.includes(WS), `→ 500 "${hs.json.error}", no path echoed`);
  ok(!(await outbox(id)).some((e) => e.id === idhs), "…the entry is not on the record");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  await until(async () => (await listed(id))?.state === "idle", 8000);
  await sleep(2500);
  ok(!typed().includes("HOLD-SAVE-FAIL"), "…and it is never delivered");

  console.log("\n2e. when:idle (the composer bar's /model): never pasted mid-turn, whatever the cached state says");
  tmuxS(["send-keys", "-t", paneOf(id), "WORK", "Enter"]); // a turn on screen: the detector reads working on its own after the override
  await sleep(300);
  await setState(id, "working");
  const idi = rid();
  a = await msg(id, { text: "/model sonnet", requestId: idi, when: "idle" });
  ok(a.status === 202 && a.json.entry?.state === "queued" && a.json.entry.idleOnly === true, `202 queued while working, idleOnly on the entry (${a.status})`);
  ok(onDisk(id).outbox?.find((e) => e.id === idi)?.idleOnly === true, "…idleOnly persisted on the record");
  const idAfter = rid();
  b = await msg(id, { text: "after-the-switch", requestId: idAfter, when: "auto" });
  ok(b.status === 202 && b.json.entry?.state === "queued", `an ordinary message behind it queues too — order kept (${b.status})`);
  const sni = await api("POST", `/api/sessions/${id}/outbox/${idi}/send`);
  ok(sni.status === 202 && sni.json.entry?.state === "queued", `"Send now" cannot force it mid-turn (${sni.status} ${sni.json?.entry?.state})`);
  await sleep(1500);
  ok(!typed().includes("/model sonnet") && !typed().includes("after-the-switch"), "nothing pasted while working");
  // The screen says working, the (manual) verdict says idle: only the under-lock read holds it.
  await setState(id, "idle");
  await sleep(1500);
  ok(!typed().includes("/model sonnet") && ["queued", "sending"].includes((await outbox(id)).find((e) => e.id === idi)?.state), "the screen shows a turn running → held under the lock though the verdict says idle");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  ok(await until(() => typed().includes("/model sonnet"), 10000), "delivered once claude is at its prompt");
  ok(await until(() => typed().includes("after-the-switch"), 8000), "…and the message behind it follows");
  const tl = typed();
  ok(tl.indexOf("/model sonnet") < tl.indexOf("after-the-switch"), "…in that order");
  // A paste handed a moment ago may have started a turn the detector has not read.
  await until(async () => (await listed(id))?.state === "idle", 8000);
  const idps = rid(), idm = rid();
  a = await msg(id, { text: "prompt-just-sent", requestId: idps, when: "auto" });
  b = await msg(id, { text: "/effort high", requestId: idm, when: "idle" });
  ok(a.status === 200 && b.status === 202, `right after a handed paste → held (${a.status}/${b.status})`);
  ok(await until(() => typed().includes("/effort high"), 10000), "…and delivered once the settle window passed");
  // A leftover spinner line above the prompt (claude leaves one after a turn):
  // the screen never moves, so it is not a turn — the pick goes.
  tmuxS(["send-keys", "-t", paneOf(id), "STALE", "Enter"]);
  await sleep(3500);
  await setState(id, "idle");
  const idst = rid();
  a = await msg(id, { text: "/model haiku", requestId: idst, when: "idle" });
  ok(a.status === 200 && a.json.entry?.state === "handed", `a static leftover spinner is not a turn → handed (${a.status} ${a.json?.entry?.state})`);
  // A pick that is being judged (the 1.1-s second look) while a message is posted
  // behind it: the pick goes back to queued, the message must not overtake it.
  tmuxS(["send-keys", "-t", paneOf(id), "WORK", "Enter"]);
  await sleep(3500); // past the settle window of the pick handed above: the pick reaches the lock
  await setState(id, "idle"); // verdict says idle, the screen animates a turn
  const idr1 = rid(), idr2 = rid();
  const p1 = msg(id, { text: "/model opus", requestId: idr1, when: "idle" });
  await sleep(150);
  const p2 = msg(id, { text: "after-opus", requestId: idr2, when: "auto" });
  const [r1, r2] = await Promise.all([p1, p2]);
  ok(r1.status === 202 && r2.status === 202, `both held while the turn runs (${r1.status}/${r2.status} ${r2.json?.entry?.state})`);
  await sleep(1000);
  ok(!typed().includes("after-opus") && !typed().includes("/model opus"), "…nothing typed mid-turn, the message did not overtake the pick");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  ok(await until(() => typed().includes("after-opus"), 12000), "…both delivered once at the prompt");
  const tl2 = typed();
  ok(tl2.indexOf("/model opus") !== -1 && tl2.indexOf("/model opus") < tl2.indexOf("after-opus"), "…the pick first");
  // Only at claude's own ❯ prompt: a screen without one (verdict idle — an
  // inconclusive screen keeps it) holds the pick, and so does a full-screen editor.
  tmuxS(["send-keys", "-t", paneOf(id), "NOPROMPT", "Enter"]);
  await sleep(3500);
  await setState(id, "idle");
  const idnp = rid();
  a = await msg(id, { text: "/model noprompt", requestId: idnp, when: "idle" });
  ok(a.status === 202 && a.json.entry?.state === "queued", `no ❯ prompt on screen → held under the lock (${a.status} ${a.json?.entry?.state})`);
  await sleep(1500);
  ok(!typed().includes("/model noprompt"), "…nothing typed");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  ok(await until(() => typed().includes("/model noprompt"), 10000), "…delivered once the prompt is back");
  tmuxS(["send-keys", "-t", paneOf(id), "EDITOR", "Enter"]);
  await sleep(3500);
  await setState(id, "idle");
  const ided = rid();
  a = await msg(id, { text: "/model ineditor", requestId: ided, when: "idle" });
  ok(a.status === 202 && a.json.entry?.state === "queued", `a full-screen editor in the pane → held (${a.status} ${a.json?.entry?.state})`);
  await sleep(1500);
  ok(!typed().includes("/model ineditor"), "…nothing typed into the editor");
  tmuxS(["send-keys", "-t", paneOf(id), "NOEDITOR", "Enter"]);
  await setState(id, "idle");
  ok(await until(() => typed().includes("/model ineditor"), 10000), "…delivered once the editor is closed");
  // A draft the operator left in claude's input box: the pick would join it and
  // Enter submit both — held until the box is empty. claude's own dim suggestion
  // in an empty box is no draft.
  tmuxS(["send-keys", "-t", paneOf(id), "DRAFT", "Enter"]);
  await sleep(3500);
  await setState(id, "idle");
  const iddr = rid();
  a = await msg(id, { text: "/model ondraft", requestId: iddr, when: "idle" });
  ok(a.status === 202 && a.json.entry?.state === "queued", `text in claude's input box → held (${a.status} ${a.json?.entry?.state})`);
  await sleep(1500);
  ok(!typed().includes("/model ondraft"), "…nothing typed onto the draft");
  tmuxS(["send-keys", "-t", paneOf(id), "DRAFT2", "Enter"]);
  await sleep(1500);
  ok(!typed().includes("/model ondraft"), "…a draft on the box's second row holds it too");
  tmuxS(["send-keys", "-t", paneOf(id), "DRAFT3", "Enter"]);
  await sleep(1500);
  ok(!typed().includes("/model ondraft"), "…and a truecolour draft (38;2;… is a colour, not dim)");
  tmuxS(["send-keys", "-t", paneOf(id), "HINT", "Enter"]);
  ok(await until(() => typed().includes("/model ondraft"), 10000), "…delivered once the box is empty (a dim suggestion is no draft)");
  // claude's real layout: ──── / empty ❯ / ──── / footer — the footer is outside the box.
  tmuxS(["send-keys", "-t", paneOf(id), "BOXED", "Enter"]);
  await sleep(3500);
  await setState(id, "idle");
  a = await msg(id, { text: "/model boxed", requestId: rid(), when: "idle" });
  ok(a.status === 200 && a.json.entry?.state === "handed", `an empty box between ──── borders with a footer below → handed (${a.status} ${a.json?.entry?.state})`);
  // "Model unavailable" at claude's empty prompt: a switch is the way out — it goes.
  // A usage limit claude is still retrying on its own is a turn — held.
  tmuxS(["send-keys", "-t", paneOf(id), "RATELIM", "Enter"]);
  ok(await until(async () => (await listed(id))?.blockReason === "Usage limit", 8000), "a retrying usage-limit screen reads blocked · Usage limit");
  await sleep(3500);
  const idrl = rid();
  a = await msg(id, { text: "/model whileretry", requestId: idrl, when: "idle" });
  await sleep(1500);
  ok(a.status === 202 && !typed().includes("/model whileretry"), `…a switch is held while claude retries (${a.status})`);
  ok((await api("DELETE", `/api/sessions/${id}/outbox/${idrl}`)).status === 200, "…and can be cancelled");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  await until(async () => (await listed(id))?.state !== "blocked", 8000);
  tmuxS(["send-keys", "-t", paneOf(id), "MODELERR", "Enter"]);
  ok(await until(async () => (await listed(id))?.blockReason === "Model unavailable", 8000), "the model-issue screen reads blocked · Model unavailable");
  a = await msg(id, { text: "/model recover", requestId: rid(), when: "idle" });
  ok(a.status === 200 && a.json.entry?.state === "handed" && typed().includes("/model recover"), `…a model switch goes through that block (${a.status} ${a.json?.entry?.state})`);
  b = await msg(id, { text: "ordinary-while-blocked", requestId: rid(), when: "auto" });
  ok(b.status === 202 || (await listed(id))?.state !== "blocked", `…an ordinary message still waits out a block (${b.status})`);
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  ok(await until(() => typed().includes("ordinary-while-blocked"), 10000), "…delivered once the block is gone");
  await until(async () => ["idle", "done"].includes((await listed(id))?.state), 8000);
  // The other order: a message queued during the block, THEN a switch — the switch
  // goes past it (the message waits on the block the switch ends), the message after.
  tmuxS(["send-keys", "-t", paneOf(id), "MODELERR", "Enter"]);
  ok(await until(async () => (await listed(id))?.blockReason === "Model unavailable", 8000), "model-issue screen again");
  b = await msg(id, { text: "ordinary-first", requestId: rid(), when: "auto" });
  ok(b.status === 202, `…an ordinary message queues behind the block (${b.status})`);
  await sleep(3500); // past the settle window of the last handed entry
  a = await msg(id, { text: "/model overtake", requestId: rid(), when: "idle" });
  ok(a.status === 200 && a.json.entry?.state === "handed" && typed().includes("/model overtake") && !typed().includes("ordinary-first"),
    `…a switch after it goes past it (${a.status} ${a.json?.entry?.state})`);
  a = await msg(id, { text: "/model second", requestId: rid(), when: "idle" });
  ok(a.status === 202, `…a second switch inside the settle window queues (${a.status})`);
  ok(await until(() => typed().includes("/model second"), 10000) && !typed().includes("ordinary-first"), "…and the dispatcher takes it past the message too, the block still up");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  ok(await until(() => typed().includes("ordinary-first"), 10000) && typed().includes("/model overtake") && typed().indexOf("/model overtake") < typed().indexOf("ordinary-first"),
    "…and the message is delivered after the switch, once the block is gone");
  await until(async () => ["idle", "done"].includes((await listed(id))?.state), 8000);
  const v1 = await msg(id, { text: "x", requestId: rid(), when: "later" });
  ok(v1.status === 400 && /idle/.test(v1.json.error), `when:"later" → 400 naming the choices (${v1.status})`);

  console.log("\n2f. /interrupt — Escape only into a running turn, judged under the lock");
  await until(async () => ["idle", "done"].includes((await listed(id))?.state), 8000);
  let it = await api("POST", `/api/sessions/${id}/interrupt`);
  ok(it.status === 409 && ["idle", "done"].includes(it.json.state), `at the prompt → 409 nothing to stop (${it.status} ${it.json?.state})`);
  tmuxS(["send-keys", "-t", paneOf(id), "DIALOG", "Enter"]);
  await sleep(300);
  await setState(id, "working"); // the verdict lags the dialog
  it = await api("POST", `/api/sessions/${id}/interrupt`);
  ok(it.status === 409 && /dialog/.test(it.json.error), `a dialog on screen while the verdict says working → 409, no Escape (${it.status} ${it.json?.error})`);
  tmuxS(["send-keys", "-t", paneOf(id), "WORK", "Enter"]);
  await sleep(300);
  await setState(id, "working");
  const before = typed().length;
  it = await api("POST", `/api/sessions/${id}/interrupt`);
  ok(it.status === 200 && it.json.ok === true, `working → 200 (${it.status})`);
  tmuxS(["send-keys", "-t", paneOf(id), "Enter"]);
  ok(await until(() => typed().slice(before).some((l) => l.includes("\x1b")), 3000), "…the pane got the Escape");
  tmuxS(["send-keys", "-t", paneOf(id), "IDLE", "Enter"]);
  await until(async () => (await listed(id))?.state === "idle", 8000);
  ok(!typed().slice(before).some((l) => /DIALOG/.test(l)), "no stray keys");

  console.log("\n3. `when: now` does not wait for the dialog");
  await setState(id, "blocked");
  const idb = rid();
  a = await msg(id, { text: "blocked-wait", requestId: idb, when: "auto" });
  ok(a.status === 202, "202 queued while blocked");
  const idn = rid();
  b = await msg(id, { text: "now-please", requestId: idn, when: "now" });
  ok(b.status === 200 && b.json.entry?.state === "handed", "when:now with a requestId delivers at once");
  await sleep(300);
  ok(typed().includes("now-please") && !typed().includes("blocked-wait"), "now-please typed, blocked-wait not");
  await setState(id, "idle");
  ok(await until(() => typed().includes("blocked-wait"), 4000), "blocked-wait delivered after idle");

  console.log("\n4. five concurrent sends land in order, paste + Enter never interleave");
  const names = [1, 2, 3, 4, 5].map((n) => `并发-${n}`);
  const rs = await Promise.all(names.map((t) => msg(id, { text: t + "\nsecond line", requestId: rid(), when: "auto" })));
  ok(rs.every((x) => x.status === 200 && x.json.entry?.state === "handed"), "all five handed");
  await sleep(500);
  const got = typed().filter((l) => l.startsWith("并发-"));
  ok(JSON.stringify(got) === JSON.stringify(names), `received in order: ${got.join(" ")}`);
  const sec = typed().filter((l) => l === "second line").length;
  ok(sec === 5, `each multiline paste kept its second line (${sec})`);

  console.log("\n5. cancel: a queued entry DELETEd never goes out; a sending/handed one is reported");
  await setState(id, "blocked");
  const idc = rid();
  await msg(id, { text: "cancel-me", requestId: idc, when: "auto" });
  let d = await api("DELETE", `/api/sessions/${id}/outbox/${idc}`);
  ok(d.status === 200 && d.json.removed === "queued", `DELETE queued → 200 (${d.status})`);
  d = await api("DELETE", `/api/sessions/${id}/outbox/${idc}`);
  ok(d.status === 404, "DELETE again → 404");
  await setState(id, "idle");
  await sleep(2500);
  ok(!typed().includes("cancel-me"), "cancelled entry never delivered");
  const idh = rid();
  await msg(id, { text: "dismiss-me", requestId: idh, when: "auto" });
  d = await api("DELETE", `/api/sessions/${id}/outbox/${idh}`);
  ok(d.status === 200 && d.json.removed === "handed", "a handed entry can be dismissed");

  console.log("\n5b. send now: a queued entry goes out at the operator's word, dialog or not");
  await setState(id, "blocked");
  const idsn = rid();
  await msg(id, { text: "马上发", requestId: idsn, when: "auto" });
  let sn = await api("POST", `/api/sessions/${id}/outbox/nope/send`);
  ok(sn.status === 404, `send of an unknown entry → 404 (${sn.status})`);
  sn = await api("POST", `/api/sessions/${id}/outbox/${idsn}/send`);
  ok(sn.status === 200 && sn.json.entry?.state === "handed" && sn.json.entry.handedWhile === "prompt", `send now while blocked → 200 handed (${sn.status}, ${sn.json.entry?.state})`);
  ok(await until(() => typed().includes("马上发"), 2000), "…and the fixture received it");
  sn = await api("POST", `/api/sessions/${id}/outbox/${idsn}/send`);
  ok(sn.status === 409 && /handed/.test(sn.json.error), "send of a handed entry → 409");
  await setState(id, "idle");

  console.log("\n6. validation");
  const bad = [
    [{ text: "x", requestId: "bad id!" }, "requestId"],
    [{ text: "x", requestId: "r1", when: "later" }, "when"],
    [{ text: "x", requestId: "r2", enter: false }, "enter"],
    [{ text: "x", requestId: "r3", force: true }, "force"],
    [{ text: "a\x07b", requestId: "r4" }, "control"],
    [{ text: "x", requestId: "r5", deviceId: "dev id" }, "deviceId"],
    [{ text: "", requestId: "r6" }, "empty text"],
  ];
  for (const [body, what] of bad) {
    const x = await msg(id, body);
    ok(x.status === 400, `${what} → 400 (${x.status})`);
  }
  ok(typed().filter((l) => l === "x").length === 0, "nothing pasted by the refused requests");

  console.log("\n7. cap + wire clipping + auth");
  await setState(id, "blocked");
  const big = "字".repeat(600);
  const idbig = rid();
  a = await msg(id, { text: big, requestId: idbig, when: "auto" });
  ok(a.status === 202, "a 600-char message queues");
  const w = (await listed(id)).outbox?.find((e) => e.id === idbig);
  ok(w && w.text.length === 500 && w.chars === 600 && w.truncated === true, "sessions list clips the text to 500 chars + chars/truncated");
  ok((await outbox(id)).find((e) => e.id === idbig)?.text === big, "GET /outbox has the whole text");
  const open = await (await fetch(`${BASE}/api/sessions`)).json();
  ok(!("outbox" in open.find((s) => s.id === id)), "the open (unauthenticated) list has no outbox");
  ok((await fetch(`${BASE}/api/sessions/${id}/outbox`)).status === 401, "GET /outbox without the token → 401");
  ok((await fetch(`${BASE}/api/sessions/${id}/outbox/${idbig}`, { method: "DELETE" })).status === 401, "DELETE without the token → 401");
  const ids = [];
  for (;;) {
    const x = await msg(id, { text: "fill", requestId: rid(), when: "auto" });
    if (x.status !== 202) { ok(x.status === 429, `the 21st entry → 429 (${x.status})`); break; }
    ids.push(x.json.entry.id);
    if (ids.length > 25) { ok(false, "no cap"); break; }
  }
  // At the cap, a failed/uncertain entry gives way to a new send; a live one never does.
  const { makeRoom, pruneOutbox, entryStale, OUTBOX_MAX } = await import("../../server/outbox.js");
  const full = Array.from({ length: OUTBOX_MAX }, (_, i) => ({ id: `f${i}`, state: i === 3 ? "failed" : "queued", at: new Date().toISOString() }));
  ok(makeRoom(full) === true && full.length === OUTBOX_MAX - 1 && !full.some((e) => e.id === "f3"), "makeRoom evicts the oldest failed/uncertain entry at the cap");
  full.push({ id: "x", state: "queued" });
  ok(makeRoom(full) === false && full.length === OUTBOX_MAX, "…and refuses when every entry is live");
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  ok(pruneOutbox([{ id: "a", state: "failed", at: old }, { id: "b", state: "uncertain", at: old }, { id: "c", state: "queued", at: old }, { id: "d", state: "failed", at: new Date().toISOString() }]).map((e) => e.id).join() === "c,d", "failed/uncertain entries are pruned after a day, queued never");
  ok(entryStale({ conversationId: "aaaa" }, "bbbb") && !entryStale({ conversationId: "aaaa" }, "aaaa") && !entryStale({}, "bbbb") && !entryStale({ conversationId: "aaaa" }, null), "entryStale: only a known, different conversation");
  for (const e of [...ids, idbig]) await api("DELETE", `/api/sessions/${id}/outbox/${e}`);
  ok((await outbox(id)).every((e) => e.state !== "queued"), "queued entries cancelled");
  await setState(id, "idle");
  await sleep(1500);
  ok(typed().filter((l) => l === "fill").length === 0 && !typed().some((l) => l.startsWith("字字")), "none of them were delivered");

  console.log("\n8. handed entries are pruned after the TTL");
  const idt = rid();
  await msg(id, { text: "ttl-me", requestId: idt, when: "auto" });
  ok((await outbox(id)).some((e) => e.id === idt), "handed entry present");
  ok(await until(async () => !(await outbox(id)).some((e) => e.id === idt), TTL_MS + 3000, 250), "…and gone after the TTL");
  ok(await until(() => !onDisk(id).outbox?.some((e) => e.id === idt), 2000, 250), "…on disk too");

  console.log("\n9. restart: queued survives, a `sending` entry becomes uncertain and is never delivered");
  await setState(id, "blocked");
  const idq2 = rid();
  await msg(id, { text: "after-restart", requestId: idq2, when: "auto" });
  await killServer();
  const rec = onDisk(id);
  rec.outbox.push({ id: "seeded-sending", text: "was-in-flight", at: new Date().toISOString(), state: "sending" });
  rec.outbox.push({ id: "bad entry", text: "garbage", at: "x", state: "queued" });
  rec.outbox.push({ id: "bad-state", text: "garbage", at: "x", state: "flying" });
  writeFileSync(join(WS, ".hadron", "agents", `${id}.json`), JSON.stringify(rec, null, 2));
  bootServer();
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  let ob = await outbox(id);
  const unc = ob.find((e) => e.id === "seeded-sending");
  ok(unc?.state === "uncertain" && /restarted/.test(unc.error), `sending → uncertain with the restart reason (${unc?.state})`);
  ok(!ob.some((e) => e.id === "bad entry" || e.id === "bad-state"), "malformed entries dropped at boot");
  ok(await until(async () => (await outbox(id)).find((e) => e.id === idq2)?.state === "handed", 8000), "the queued entry is delivered once the agent is idle after boot");
  ok(await until(() => typed().includes("after-restart"), 2000), "…and reached the fixture");
  await sleep(1500);
  ok(!typed().includes("was-in-flight"), "the uncertain entry was never delivered on its own");
  d = await api("DELETE", `/api/sessions/${id}/outbox/seeded-sending`);
  ok(d.status === 200 && d.json.removed === "uncertain", "an uncertain entry can be dismissed");

  console.log("\n10. a dead agent process fails the entry instead of pasting into the shell");
  tmuxS(["send-keys", "-t", paneOf(id), "C-d"]);
  ok(await until(() => paneCmd(id) !== "claude", 5000), `pane is a shell now (${paneCmd(id)})`);
  const idf = rid();
  a = await msg(id, { text: "echo pwned", requestId: idf, when: "now" });
  ok(a.status === 409 && a.json.entry?.state === "failed" && /prompt/.test(a.json.error), `409 failed (${a.status}: ${a.json?.error})`);
  b = await msg(id, { text: "echo pwned", requestId: idf, when: "now" });
  ok(b.status === 409 && b.json.replay === true && b.json.entry?.state === "failed", "replay of a failed entry is 409 with the entry");
  await setState(id, "blocked");
  const idf2 = rid();
  await msg(id, { text: "echo queued-pwned", requestId: idf2, when: "auto" });
  await setState(id, "idle");
  ok(await until(async () => (await outbox(id)).find((e) => e.id === idf2)?.state === "failed", 5000), "a queued entry dispatched into a shell pane fails");
  await sleep(300);
  const pane = tmuxSafe(["capture-pane", "-t", paneOf(id), "-p"]) || "";
  ok(!/pwned/.test(pane), "nothing pasted into the shell");

  console.log("\n11. Enter lost after the paste → uncertain, never \"not delivered\" (a retry would paste it twice)");
  tmuxS(["send-keys", "-t", paneOf(id), `exec ${FIXTURE} ${LOG}`, "Enter"]);
  ok(await until(() => paneCmd(id) === "claude", 10000), `the fixture runs in the pane again (${paneCmd(id)})`);
  ok(await until(async () => (await listed(id))?.state === "idle", 15000), "…and reads idle");
  const idp = rid();
  const pr = msg(id, { text: "ENTER-LOST", requestId: idp });
  await sleep(120); // inside the 250-ms paste → Enter window
  tmuxS(["rename-session", "-t", paneOf(id), `${paneOf(id)}-away`]);
  await sleep(400);
  tmuxS(["rename-session", "-t", `${paneOf(id)}-away`, paneOf(id)]);
  const pres = await pr;
  ok(pres.status === 409 && pres.json.entry?.state === "uncertain" && /Enter may not have landed/.test(pres.json.entry.error), `→ 409 uncertain "${pres.json.entry?.error}" (${pres.status} ${pres.json.entry?.state})`);
  ok(!typed().includes("ENTER-LOST"), "…claude got no submitted line (the text sits in its input box)");
  tmuxS(["send-keys", "-t", paneOf(id), "Enter"]); // the operator presses Enter in Primary
  ok(await until(() => typed().includes("ENTER-LOST"), 3000), "…and the operator's Enter in Primary submits exactly that text once");
  await api("DELETE", `/api/sessions/${id}/outbox/${idp}`);

  console.log("\n12. a record that cannot be saved is not queued (a 500 is never followed by a delivery)");
  await setState(id, "blocked");
  chmodSync(join(WS, ".hadron", "agents"), 0o500);
  const idsf = rid();
  const sf = await msg(id, { text: "SAVE-FAIL", requestId: idsf, when: "auto" });
  chmodSync(join(WS, ".hadron", "agents"), 0o755);
  ok(sf.status === 500 && /not queued/.test(sf.json.error) && !sf.json.error.includes(WS), `→ 500 "${sf.json.error}", no path echoed`);
  ok(!(await outbox(id)).some((e) => e.id === idsf), "…the entry is not on the record");
  await setState(id, "idle");
  await sleep(2500);
  ok(!typed().includes("SAVE-FAIL"), "…and it is never delivered");

  console.log("\n13. no leaks");
  ok(listBuffers() === "", `no tmux buffers left (${JSON.stringify(listBuffers())})`);
  ok(tmpLeaks().length === 0, "no hadron-msg-* temp dirs");
  ok(!serverLog.includes(TOKEN), "server log carries no token");
}

try {
  await main();
} catch (e) {
  failed++; console.error(`  ✗ unexpected: ${e.stack || e}`);
} finally {
  await killServer();
  tmuxSafe(["kill-server"]);
  rmSync(T, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
