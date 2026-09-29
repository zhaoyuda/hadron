/**
 * `hadron checkpoint` + claude's SessionStart hook at the real boundary —
 * server/checkpoint.js wired through server/index.js, bin/hadron.js and a
 * private tmux server (HADRON_TMUX_SOCKET) with a process actually named
 * `claude` (the test-doctor fixture shape: `exec -a claude bash -c …`).
 *
 * Covers:
 *   handoff checkpoint — POST /api/sessions/:id/checkpoint validation (400s),
 *     clear on an all-empty body, `at` from the server clock, persisted in the
 *     agent's JSON and back on the open GET after a restart, wire form typed
 *     (a corrupt on-disk value never reaches the list), CLI set/show/clear/
 *     merge semantics through the real binary, 404 unknown agent, no token
 *   SessionStart hook — the fixture claude runs `hadron checkpoint --hook`
 *     with claude's hook JSON on stdin (env from the tmux session: HADRON_PORT
 *     / HADRON_TOKEN / TMUX_PANE) → runtime.sessionId set with confidence
 *     `hook`, doctor row green "resumes as hook"; a forged POST from a process
 *     outside the pane → 403; a claim naming a shell-tab pane → 409; another
 *     agent's pane → 403 with that agent untouched; a pane outside Hadron →
 *     404; an older `at` → 409 (freshness); claude's registry naming a
 *     different id → 409 (the registry wins); the same id again is idempotent
 *     and keeps a pinned provenance; a newer id replaces a hook-pinned one
 *     (a /clear); the CLI with no HADRON_* env exits 0 and posts nothing;
 *     logs carry the agent id, never the session id or the token
 *   settings.json — --install-hook / --uninstall-hook in a relocated
 *     CLAUDE_CONFIG_DIR: idempotent, other hooks/keys untouched, backup
 *     written, invalid JSON refused untouched, another checkout's hook
 *     repointed, a user hook that merely mentions "checkpoint --hook" is not ours
 *
 * Run: node test/unit/test-checkpoint.js      Requires: tmux, bash, Linux /proc.
 */
import "./hadron-home.js";
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { claudeProjectDir } from "../../server/resume.js";
import { validateCheckpoint, safeCheckpoint, verifyHookClaim, applyHookClaim, installSessionHook, uninstallSessionHook, hookInstallStatus, HOOK_MARK } from "../../server/checkpoint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const CLI = join(REPO, "bin", "hadron.js");
const PORT = await new Promise((res, rej) => {
  const srv = createServer();
  srv.on("error", rej);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
});
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = mkdtempSync(join(tmpdir(), "hadron-checkpoint-"));
const SOCK = join(T, "tmux.sock");
const HOME = join(T, "home");
const FIX = join(T, "bin");
const WS = join(T, "ws");
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
for (const d of [HOME, FIX, WS, join(WS, "a"), join(WS, "b"), join(WS, "c")]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME, ".profile"), `export PATH="${FIX}:$PATH"\n`);
writeFileSync(join(HOME, ".bashrc"), `export PATH="${FIX}:$PATH"\n`);
mkdirSync(join(WS, ".hadron"), { recursive: true });
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({ name: "checkpoint", groups: ["Workers"] }, null, 2));

// The fixture claude: argv[0] is `claude` (what tmux's pane_current_command
// and processIdentity both read). When HADRON_HOOK_JSON names a file it runs
// the real SessionStart hook command with that JSON on stdin — exactly how
// claude runs the hook: a child of the claude process, in the pane, with the
// tmux session's env — then stays alive as claude with a sleep child.
writeFileSync(join(FIX, "claude"), `#!/usr/bin/env bash
exec -a claude bash -c 'if [ -n "$HADRON_HOOK_JSON" ] && [ -f "$HADRON_HOOK_JSON" ]; then node "${CLI}" checkpoint --hook < "$HADRON_HOOK_JSON" > "$HADRON_HOOK_JSON.out" 2>&1; echo "hook exit $?" >> "$HADRON_HOOK_JSON.out"; fi; sleep 300; true'
`);
chmodSync(join(FIX, "claude"), 0o755);

const tenv = { ...process.env, PATH: `${FIX}:${process.env.PATH}`, HOME };
delete tenv.TMUX;
function tmuxS(args, opts = {}) {
  return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: tenv, ...opts });
}
function tmuxSafe(args) { try { return tmuxS(args).trim(); } catch { return null; } }
const paneOf = (id) => `hadron-${WS_NAME}-${id}`;
const paneCmd = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_current_command}"]);
const paneId = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_id}"]);
function sendLine(id, line) { tmuxS(["send-keys", "-t", paneOf(id), "-l", "--", line]); tmuxS(["send-keys", "-t", paneOf(id), "Enter"]); }

function validateFixture() {
  tmuxS(["new-session", "-d", "-s", "probe", "-x", "80", "-y", "24", "claude --probe"]);
  let seen = null;
  for (let i = 0; i < 30; i++) {
    seen = tmuxSafe(["display-message", "-t", "probe", "-p", "#{pane_current_command}"]);
    if (seen === "claude") break;
    execFileSync("sleep", ["0.1"]);
  }
  tmuxSafe(["kill-session", "-t", "probe"]);
  if (seen === null) throw new Error("probe pane vanished before tmux could report its command");
  if (seen !== "claude") return { ok: false, why: `tmux reports ${JSON.stringify(seen)} for a process whose argv[0] is claude` };
  return { ok: true };
}

let server, TOKEN, serverLog = "";
function bootServer(extraEnv = {}) {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash",
    PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: "checkpoint",
    INVOCATION_ID: "", XPC_SERVICE_NAME: "",
    ...extraEnv,
  };
  delete env.TMUX; delete env.TMUX_PANE; delete env.HADRON_PORT; delete env.HADRON_TOKEN;
  server = spawn("node", [join(REPO, "server", "index.js"), WS], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  return server;
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { const h = await r.json(); if (h.pid === server.pid) return h; throw new Error(`port ${PORT} answered with pid ${h.pid}, expected ${server.pid}`); }
    } catch (e) { if (/expected \d/.test(e.message)) throw e; }
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
const POST = (p, body) => fetch(`${BASE}${p}`, { method: "POST", headers: H(), body: JSON.stringify(body ?? {}) });
const GETj = async (p) => (await fetch(`${BASE}${p}`, { headers: { "x-hadron-token": TOKEN } })).json();
async function createAgent(name, cwd) {
  const r = await POST("/api/sessions", { name, cwd, launchCommand: "shell", group: "Workers" });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status} ${await r.text()}`);
  return (await r.json()).id;
}
const onDisk = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));
async function waitDisk(id, pred, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const a = onDisk(id); if (pred(a)) return a; } catch {} await sleep(250); }
  return onDisk(id);
}
function seedTranscript(cwd, sid) {
  const dir = join(HOME, ".claude", "projects", claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ type: "summary", sessionId: sid, cwd }) + "\n" + JSON.stringify({ type: "user", sessionId: sid, cwd, message: { role: "user", content: "hi" } }) + "\n");
}
const REG = join(HOME, ".claude", "sessions");
// claude's own transcript_path for a session under a cwd (what the hook posts)
const tpath = (cwd, sid) => join(HOME, ".claude", "projects", claudeProjectDir(cwd), `${sid}.jsonl`);
// a hook claim body for agent cwd `cwd`: transcriptPath bound to the id
const claim = (cwd, sessionId, rest) => ({ sessionId, transcriptPath: tpath(cwd, sessionId), ...rest });
function children(pid) {
  return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8").trim().split(/\s+/).filter(Boolean).map(Number);
}
function fixturePid(id) {
  const panePid = Number(tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_pid}"]));
  const claude = children(panePid).find((k) => { try { return readFileSync(`/proc/${k}/cmdline`, "utf-8").split("\0")[0] === "claude"; } catch { return false; } });
  if (!claude) throw new Error(`no claude child under pane pid ${panePid} (children: ${children(panePid).join(",")})`);
  return claude;
}
function procStartOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}
function writeRegistryRecord(id, sid, { pid = fixturePid(id), procStart = procStartOf(pid), tmux = `${paneOf(id)}:${tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{window_id}.#{pane_id}"])}`, version = "2.1.283" } = {}) {
  mkdirSync(REG, { recursive: true });
  const rec = {
    pid, procStart, pidDomain: `linux:${randomUUID().replace(/-/g, "")}:pid:[4026531836]`, sessionId: sid, cwd: onDisk(id).cwd, tmux,
    status: "idle", updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), version, kind: "interactive", entrypoint: "cli",
  };
  writeFileSync(join(REG, `${pid}.json`), JSON.stringify(rec, null, 2));
  return pid;
}
// Run the REAL CLI. `tmuxSession` = an agent id: the CLI resolves "me" through
// $TMUX (socket) + $TMUX_PANE, pointed at that agent's pane on the private server.
function runCli(args, { env: extra = {}, tmuxSession = null, input = undefined } = {}) {
  const env = { ...process.env, HOME, HADRON_PORT: String(PORT), HADRON_TOKEN: TOKEN, ...extra };
  delete env.TMUX; delete env.TMUX_PANE;
  if (tmuxSession) { env.TMUX = `${SOCK},1,0`; env.TMUX_PANE = paneId(tmuxSession); }
  try {
    const stdout = execFileSync("node", [CLI, ...args], { cwd: WS, env, encoding: "utf-8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

async function main() {
  const probe = validateFixture();
  if (!probe.ok) { console.log(`skip (process-name fixture unavailable on ${process.platform}: ${probe.why})`); return; }

  // ── pure module ─────────────────────────────────────────────────────────
  console.log("server/checkpoint.js (pure)");
  ok(validateCheckpoint({}).checkpoint === null && validateCheckpoint({ goal: "  ", next: "" }).checkpoint === null, "all-empty body → clear (null)");
  ok(/goal must be a string/.test(validateCheckpoint({ goal: 5 }).error), "non-string field → error");
  ok(/at most 500/.test(validateCheckpoint({ goal: "x".repeat(501) }).error), "501 chars → error");
  ok(/control characters/.test(validateCheckpoint({ next: "ab" }).error), "control char → error");
  ok(!validateCheckpoint({ next: "line1\r\nline2\ttab" }).error, "newlines and tabs are allowed");
  ok(/outputs must be an array/.test(validateCheckpoint({ outputs: "x" }).error) && /outputs entries/.test(validateCheckpoint({ outputs: ["a\nb"] }).error), "outputs shape checked");
  const v1 = validateCheckpoint({ goal: " g ", outputs: ["a", "a", " b "] }, { now: 1000 });
  ok(v1.checkpoint.goal === "g" && v1.checkpoint.outputs.join() === "a,b" && v1.checkpoint.at === new Date(1000).toISOString(), "trimmed, de-duplicated, server-stamped");
  const sw = safeCheckpoint({ goal: "g", token: "sk-ant-x", at: "nope", outputs: [1, "p"], next: 42 });
  ok(sw.goal === "g" && sw.token === undefined && sw.at === undefined && sw.next === undefined && sw.outputs.join() === "p", "wire form keeps only typed known fields");
  ok(safeCheckpoint({ junk: 1 }) === null && safeCheckpoint("x") === null, "wire form of nothing is null");
  // verifyHookClaim with a synthetic tree: pane 100 → claude 200 → sh 300 → hook 400; 500 is elsewhere
  const tree = { 400: 300, 300: 200, 200: 100, 100: 1, 500: 1 };
  const ident = (pid) => ({ alive: pid !== 999, claude: pid === 200, start: pid * 7 });
  const parent = (pid) => tree[pid] ?? null;
  const panes = [{ paneId: "%5", panePid: 100 }];
  const good = verifyHookClaim({ panes, pane: "%5", hookPid: 400, identity: ident, parent });
  ok(good.ok && good.claudePid === 200 && good.claudeStart === 1400, "hook → sh → claude → pane resolves the claude pid");
  ok(/not a pane of this agent/.test(verifyHookClaim({ panes, pane: "%6", hookPid: 400, identity: ident, parent }).reason), "another pane → refused");
  ok(/does not descend/.test(verifyHookClaim({ panes, pane: "%5", hookPid: 500, identity: ident, parent }).reason), "a process outside the pane → refused");
  ok(/no live claude/.test(verifyHookClaim({ panes, pane: "%5", hookPid: 300, identity: () => ({ alive: true, claude: false }), parent }).reason), "no claude between hook and pane → refused (someone ran the CLI by hand)");
  ok(/does not descend/.test(verifyHookClaim({ panes, pane: "%5", hookPid: 400, identity: ident, parent, depth: 1 }).reason), "ancestry depth bounded");
  ok(verifyHookClaim({ panes: [{ paneId: "%5", panePid: 200 }], pane: "%5", hookPid: 400, identity: ident, parent }).claudePid === 200, "the pane process itself may be claude");
  // nested claude: pane 100 → claude 200 → bash 300 → NESTED claude 350 → hook 400 (claude -p from the conversation's Bash tool)
  const nestedTree = { 400: 350, 350: 300, 300: 200, 200: 100, 100: 1 };
  const nestedIdent = (pid) => ({ alive: true, claude: pid === 200 || pid === 350, start: pid * 7 });
  ok(/nested claude/.test(verifyHookClaim({ panes, pane: "%5", hookPid: 400, identity: nestedIdent, parent: (pid) => nestedTree[pid] ?? null }).reason), "two live claudes on the path (nested claude) → refused, never the nearest or the outermost");
  ok(/nested claude/.test(verifyHookClaim({ panes: [{ paneId: "%5", panePid: 200 }], pane: "%5", hookPid: 400, identity: nestedIdent, parent: (pid) => nestedTree[pid] ?? null }).reason), "…also when the pane process is the outer claude");
  ok(/pane must be/.test(verifyHookClaim({ panes, pane: "5", hookPid: 400, identity: ident, parent }).reason) && /pid must be/.test(verifyHookClaim({ panes, pane: "%5", hookPid: -1, identity: ident, parent }).reason), "shape checks");
  // applyHookClaim
  const sidA = randomUUID(), sidB = randomUUID();
  let rt = { sessionId: sidA, confidence: "correlated" };
  let r = applyHookClaim(rt, { sessionId: sidA, at: 10, claudePid: 200 });
  ok(r.accepted && r.changed && rt.confidence === "hook" && rt.hookAt === 10 && rt.hookPid === 200, "same id: scraped → promoted to hook");
  r = applyHookClaim(rt, { sessionId: sidA, at: 11, claudePid: 200 });
  ok(r.accepted && !r.changed && rt.hookAt === 11, "same id again: idempotent, freshness advanced");
  r = applyHookClaim(rt, { sessionId: sidB, at: 5, claudePid: 200 });
  ok(!r.accepted && rt.sessionId === sidA && /newer SessionStart/.test(r.reason), "older claim → refused, nothing touched");
  r = applyHookClaim(rt, { sessionId: sidB, at: 12, claudePid: 200 }, { registry: { status: "matched", sessionId: sidA } });
  ok(!r.accepted && rt.sessionId === sidA && /registry names a different/.test(r.reason), "registry naming another id → refused");
  rt = { sessionId: sidA, confidence: "manual", transcriptSeen: true };
  r = applyHookClaim(rt, { sessionId: sidB, at: 12, claudePid: 200 }, { registry: { status: "none" } });
  ok(r.accepted && r.changed && rt.sessionId === sidB && rt.confidence === "hook" && rt.transcriptSeen === undefined, "new id replaces a pinned (manual) one; transcriptSeen reset");
  r = applyHookClaim(rt, { sessionId: sidA, at: 13, claudePid: 200 }, { fileExists: true });
  ok(rt.transcriptSeen === true, "transcriptSeen set when the caller proved the file");
  rt = { sessionId: sidA, confidence: "registry" };
  r = applyHookClaim(rt, { sessionId: sidA, at: 1, claudePid: 200 });
  ok(r.accepted && !r.changed && rt.confidence === "registry", "same id keeps a pinned provenance (registry)");

  // ── settings.json hook install (relocated CLAUDE_CONFIG_DIR) ─────────────
  console.log("\n--install-hook / --uninstall-hook");
  const CFG = join(T, "cfg");
  mkdirSync(CFG, { recursive: true });
  const sp = join(CFG, "settings.json");
  writeFileSync(sp, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }], SessionStart: [{ hooks: [{ type: "command", command: "echo mine checkpoint --hook" }] }] } }, null, 2));
  let ir = installSessionHook({ configDir: CFG, nodePath: "/usr/bin/node", hadronBin: CLI });
  let st = JSON.parse(readFileSync(sp, "utf-8"));
  ok(ir.changed && st.hooks.SessionStart.length === 2 && st.hooks.SessionStart[1].hooks[0].command === `'/usr/bin/node' '${CLI}' checkpoint --hook` && st.hooks.SessionStart[1].hooks[0].timeout === 5, "installed as a new SessionStart group after the user's own");
  ok(st.theme === "dark" && st.hooks.PreToolUse[0].hooks[0].command === "echo pre" && st.hooks.SessionStart[0].hooks[0].command === "echo mine checkpoint --hook", "other keys, other hooks and a user hook that merely mentions checkpoint --hook untouched");
  ok(existsSync(`${sp}.hadron-bak`) && JSON.parse(readFileSync(`${sp}.hadron-bak`, "utf-8")).hooks.SessionStart.length === 1, "backup holds the previous file");
  ir = installSessionHook({ configDir: CFG, nodePath: "/usr/bin/node", hadronBin: CLI });
  ok(!ir.changed && JSON.parse(readFileSync(sp, "utf-8")).hooks.SessionStart.length === 2, "second install is a no-op");
  let hs = hookInstallStatus({ configDir: CFG, hadronBin: CLI });
  ok(hs.installed && hs.current === true, "status: installed, current");
  st = JSON.parse(readFileSync(sp, "utf-8"));
  st.hooks.SessionStart[1].hooks[0].command = `'/usr/bin/node' '/elsewhere/hadron/bin/hadron.js' checkpoint --hook`;
  writeFileSync(sp, JSON.stringify(st));
  hs = hookInstallStatus({ configDir: CFG, hadronBin: CLI });
  ok(hs.installed && hs.current === false, "status: installed from another checkout");
  ir = installSessionHook({ configDir: CFG, nodePath: "/usr/bin/node", hadronBin: CLI });
  st = JSON.parse(readFileSync(sp, "utf-8"));
  ok(ir.changed && /elsewhere/.test(ir.repaired) && st.hooks.SessionStart.length === 2 && st.hooks.SessionStart[1].hooks[0].command.includes(`'${CLI}'`), "another checkout's hook repointed, not duplicated");
  ok(HOOK_MARK.test(`'/x/hadron.js' checkpoint --hook`) && !HOOK_MARK.test(`echo checkpoint --hook`) && !HOOK_MARK.test(`'/x/notes.js' checkpoint --hook`), "ours = quoted hadron.js path + subcommand");
  const ur = uninstallSessionHook({ configDir: CFG });
  st = JSON.parse(readFileSync(sp, "utf-8"));
  ok(ur.changed && st.hooks.SessionStart.length === 1 && st.hooks.SessionStart[0].hooks[0].command === "echo mine checkpoint --hook" && st.hooks.PreToolUse && st.theme === "dark", "uninstall removes only our group");
  ok(!uninstallSessionHook({ configDir: CFG }).changed, "uninstall again is a no-op");
  installSessionHook({ configDir: CFG, nodePath: "/usr/bin/node", hadronBin: CLI });
  st = JSON.parse(readFileSync(sp, "utf-8")); st.hooks.SessionStart = st.hooks.SessionStart.filter((g) => g.hooks[0].command.includes("hadron.js")); writeFileSync(sp, JSON.stringify(st));
  uninstallSessionHook({ configDir: CFG });
  st = JSON.parse(readFileSync(sp, "utf-8"));
  ok(st.hooks.SessionStart === undefined && st.hooks.PreToolUse, "removing the last SessionStart entry drops the key, keeps the other event");
  const CFG2 = join(T, "cfg2");
  ir = installSessionHook({ configDir: CFG2, nodePath: "/usr/bin/node", hadronBin: CLI });
  st = JSON.parse(readFileSync(join(CFG2, "settings.json"), "utf-8"));
  ok(ir.changed && Object.keys(st).join() === "hooks" && st.hooks.SessionStart.length === 1 && !existsSync(join(CFG2, "settings.json.hadron-bak")), "no settings.json → created with only hooks.SessionStart, no backup of nothing");
  writeFileSync(sp, "{ not json");
  let threw = null;
  try { installSessionHook({ configDir: CFG, nodePath: "/usr/bin/node", hadronBin: CLI }); } catch (e) { threw = e.message; }
  ok(/not valid JSON/.test(threw) && readFileSync(sp, "utf-8") === "{ not json", "invalid JSON refused, file untouched");
  writeFileSync(sp, JSON.stringify({ hooks: { SessionStart: "nope" } }));
  threw = null;
  try { installSessionHook({ configDir: CFG, nodePath: "/usr/bin/node", hadronBin: CLI }); } catch (e) { threw = e.message; }
  ok(/SessionStart is not an array/.test(threw), "a non-array SessionStart is refused, not clobbered");
  // through the CLI (CLAUDE_CONFIG_DIR relocated — the real ~/.claude is never touched)
  const CFG3 = join(T, "cfg3");
  let c = runCli(["checkpoint", "--install-hook"], { env: { CLAUDE_CONFIG_DIR: CFG3 } });
  ok(c.code === 0 && /installed in .*cfg3\/settings\.json/.test(c.stdout) && JSON.parse(readFileSync(join(CFG3, "settings.json"), "utf-8")).hooks.SessionStart[0].hooks[0].command.includes("checkpoint --hook"), `CLI --install-hook writes the relocated settings.json (${c.stdout.split("\n")[0]})`);
  c = runCli(["checkpoint", "--install-hook"], { env: { CLAUDE_CONFIG_DIR: CFG3 } });
  ok(c.code === 0 && /already installed/.test(c.stdout), "CLI --install-hook again: already installed");
  c = runCli(["checkpoint", "--uninstall-hook"], { env: { CLAUDE_CONFIG_DIR: CFG3 } });
  ok(c.code === 0 && /removed from/.test(c.stdout) && !("hooks" in JSON.parse(readFileSync(join(CFG3, "settings.json"), "utf-8"))), "CLI --uninstall-hook reverts");
  c = runCli(["checkpoint", "--install-hook", "--uninstall-hook"], { env: { CLAUDE_CONFIG_DIR: CFG3 } });
  ok(c.code === 1 && /choose one/.test(c.stdout), "both flags → exit 1");

  // ── server ──────────────────────────────────────────────────────────────
  console.log("\nserver: handoff checkpoint");
  bootServer();
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const aId = await createAgent("cp-a", join(WS, "a"));
  const bId = await createAgent("cp-b", join(WS, "b"));
  const cId = await createAgent("cp-c", join(WS, "c"));
  await sleep(1200);

  let res = await POST(`/api/sessions/${aId}/checkpoint`, { goal: "ship it", next: "run the gates", outputs: ["README.md"] });
  let j = await res.json();
  ok(res.status === 200 && j.ok && j.checkpoint.goal === "ship it" && j.checkpoint.next === "run the gates" && j.checkpoint.outputs[0] === "README.md" && Number.isFinite(Date.parse(j.checkpoint.at)), "POST sets goal/next/outputs, at stamped by the server");
  const at1 = j.checkpoint.at;
  res = await POST(`/api/sessions/${aId}/checkpoint`, { goal: "x".repeat(501) });
  ok(res.status === 400 && /at most 500/.test((await res.json()).error), "501-char goal → 400");
  res = await POST(`/api/sessions/${aId}/checkpoint`, { next: "ab" });
  ok(res.status === 400, "control chars → 400");
  res = await POST(`/api/sessions/${aId}/checkpoint`, { outputs: new Array(21).fill("p") });
  ok(res.status === 400 && /at most 20/.test((await res.json()).error), "21 outputs → 400");
  res = await POST(`/api/sessions/${aId}/checkpoint`, { goal: "ship it", at: "1999-01-01T00:00:00.000Z" });
  j = await res.json();
  ok(res.status === 200 && j.checkpoint.at !== "1999-01-01T00:00:00.000Z" && Date.parse(j.checkpoint.at) >= Date.parse(at1) && j.checkpoint.next === undefined, "a client-supplied `at` is ignored; whole-object replace drops unmentioned fields");
  ok(onDisk(aId).checkpoint?.goal === "ship it" && onDisk(aId).checkpoint.next === undefined, "persisted in the agent's JSON");
  let list = await (await fetch(`${BASE}/api/sessions`)).json();
  ok(list.find((s) => s.id === aId)?.checkpoint?.goal === "ship it" && list.find((s) => s.id === bId)?.checkpoint === undefined, "open GET carries the checkpoint (absent when none)");
  res = await POST(`/api/sessions/${aId}/checkpoint`, {});
  j = await res.json();
  ok(res.status === 200 && j.checkpoint === null && !("checkpoint" in onDisk(aId)), "empty body clears it on the wire and on disk");
  res = await POST(`/api/sessions/nope/checkpoint`, { goal: "g" });
  ok(res.status === 404, "unknown agent → 404");
  res = await fetch(`${BASE}/api/sessions/${aId}/checkpoint`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal: "g" }) });
  ok(res.status === 401 || res.status === 403, `no token → ${res.status}`);

  console.log("\nCLI: hadron checkpoint (inside the agent's tmux session)");
  c = runCli(["checkpoint"], { tmuxSession: aId });
  ok(c.code === 0 && /\(no checkpoint\)/.test(c.stdout), `show with nothing set (${c.stdout.trim().split("\n")[0]})`);
  c = runCli(["checkpoint", "--goal", "migrate notifier", "--next", "run predeploy", "--", "README.md", "client/app.js"], { tmuxSession: aId });
  ok(c.code === 0 && /checkpoint: migrate notifier/.test(c.stdout) && /→ run predeploy/.test(c.stdout) && /outputs: README\.md, client\/app\.js/.test(c.stdout), `set prints it (${c.stdout.split("\n")[0]})`);
  c = runCli(["checkpoint", "--blocked", "waiting for the prod go-ahead"], { tmuxSession: aId });
  const cpA = onDisk(aId).checkpoint;
  ok(c.code === 0 && cpA.goal === "migrate notifier" && cpA.next === "run predeploy" && cpA.blocked === "waiting for the prod go-ahead" && cpA.outputs.length === 2, "a later call merges over the current one (goal/next/outputs kept)");
  c = runCli(["checkpoint", "--blocked", ""], { tmuxSession: aId });
  ok(c.code === 0 && onDisk(aId).checkpoint.blocked === undefined && onDisk(aId).checkpoint.goal === "migrate notifier", `--blocked "" clears one field`);
  c = runCli(["checkpoint", "--goal"], { tmuxSession: aId });
  ok(c.code === 1 && /--goal needs a value/.test(c.stdout), "--goal without a value → exit 1");
  c = runCli(["checkpoint", "show", "--json"], { tmuxSession: aId });
  ok(c.code === 0 && JSON.parse(c.stdout).next === "run predeploy", "show --json");
  c = runCli(["whoami"], { tmuxSession: aId });
  ok(/checkpoint: migrate notifier/.test(c.stdout) && /→ run predeploy/.test(c.stdout), "whoami prints the checkpoint");
  c = runCli(["checkpoint", "clear"], { tmuxSession: aId });
  ok(c.code === 0 && /cleared/.test(c.stdout) && !("checkpoint" in onDisk(aId)), "clear");
  c = runCli(["checkpoint", "--goal", "g"]);
  ok(c.code === 1 && /Not inside a tmux pane/.test(c.stdout), "outside tmux: exit 1");
  // restart persistence + a corrupt on-disk value never reaches the wire
  runCli(["checkpoint", "--goal", "persist me", "--next", "after restart"], { tmuxSession: aId });
  const bad = onDisk(bId); bad.checkpoint = { goal: "b", token: "sk-ant-api03-LEAK", next: 42, outputs: ["ok", 7], at: "garbage" };
  writeFileSync(join(WS, ".hadron", "agents", `${bId}.json`), JSON.stringify(bad));
  await killServer();
  bootServer();
  await waitForServer();
  await sleep(800);
  list = await (await fetch(`${BASE}/api/sessions`)).json();
  const wa = list.find((s) => s.id === aId), wb = list.find((s) => s.id === bId);
  ok(wa?.checkpoint?.goal === "persist me" && wa.checkpoint.next === "after restart", "survives a restart");
  ok(wb?.checkpoint?.goal === "b" && !("token" in wb.checkpoint) && wb.checkpoint.next === undefined && wb.checkpoint.outputs.join() === "ok" && wb.checkpoint.at === undefined && !JSON.stringify(list).includes("LEAK"), "corrupt on-disk checkpoint is typed on the wire, unknown keys dropped");

  // ── SessionStart hook ───────────────────────────────────────────────────
  console.log("\nSessionStart hook: hadron checkpoint --hook from the fixture claude");
  const cSid = randomUUID();
  seedTranscript(join(WS, "c"), cSid);
  const hookJson = join(T, "hook.json");
  writeFileSync(hookJson, JSON.stringify({ session_id: cSid, transcript_path: join(HOME, ".claude", "projects", claudeProjectDir(join(WS, "c")), `${cSid}.jsonl`), cwd: join(WS, "c"), hook_event_name: "SessionStart", source: "startup" }));
  sendLine(cId, `HADRON_HOOK_JSON='${hookJson}' claude`);
  let cd = await waitDisk(cId, (a) => a.runtime?.sessionId === cSid, 15000);
  const hookOut = existsSync(`${hookJson}.out`) ? readFileSync(`${hookJson}.out`, "utf-8") : "(no output file)";
  ok(cd.runtime?.sessionId === cSid && cd.runtime.confidence === "hook", `the hook's claim set the agent's session id with confidence hook (${cd.runtime?.confidence}; hook: ${hookOut.trim().split("\n").pop()})`);
  ok(/^hook exit 0\n?$/.test(hookOut), "the hook printed nothing and exited 0");
  ok(paneCmd(cId) === "claude", `pane still runs claude (${paneCmd(cId)})`);
  ok(cd.runtime.transcriptSeen === true, "transcript existed at claim time → transcriptSeen");
  ok(/\[resume\] agent .*: session id taken from claude's SessionStart hook \(pane matched, process verified\)/.test(serverLog) && !serverLog.includes(cSid), "log names the agent and the hook, never the id");
  cd = await waitDisk(cId, (a) => a.runtime?.observedRuntime === "claude", 15000); // the tracker's settle polls
  ok(cd.runtime.observedRuntime === "claude" && cd.runtime.sessionId === cSid && cd.runtime.confidence === "hook", "the tracker's settle keeps the hook id + provenance");
  let doc = await GETj("/api/doctor");
  let row = doc.agents.find((a) => a.id === cId);
  ok(row?.finding?.level === "green" && /resumes as hook/.test(row.finding.message), `doctor: green "resumes as hook" (${row?.finding?.level}: ${row?.finding?.message})`);
  ok(!JSON.stringify(doc).includes(cSid), "doctor payload carries no session id");
  const cli = runCli(["doctor"]);
  ok(/resumes as hook/.test(cli.stdout), "hadron doctor prints resumes as hook");
  // a second SessionStart under the same claude (a /clear): new id, later at → replaces the hook-pinned id
  const claudePid = fixturePid(cId);
  const sleepPid = children(claudePid)[0];
  ok(Number.isInteger(sleepPid), `the fixture claude has a child to claim from (${sleepPid})`);
  const pane = paneId(cId);
  const sid2 = randomUUID();
  seedTranscript(join(WS, "c"), sid2);
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), sid2, { pane, pid: sleepPid, at: Date.now() }));
  j = await res.json();
  cd = onDisk(cId);
  ok(res.status === 200 && j.changed === true && j.confidence === "hook" && cd.runtime.sessionId === sid2 && cd.runtime.hookPid === claudePid, `a later claim from under the same claude (a /clear) replaces the id (${res.status} ${JSON.stringify(j)})`);
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), sid2, { pane, pid: sleepPid, at: Date.now() }));
  j = await res.json();
  ok(res.status === 200 && j.changed === false, "the same id again is idempotent (changed:false)");
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane, pid: sleepPid, at: Date.now() - 60000 }));
  ok(res.status === 409 && /newer SessionStart/.test((await res.json()).error) && onDisk(cId).runtime.sessionId === sid2, "an older claim (late SessionStart after /clear) → 409, id kept");
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane, pid: process.pid, at: Date.now() }));
  ok(res.status === 403 && /does not descend/.test((await res.json()).error) && onDisk(cId).runtime.sessionId === sid2, "a POST from a process outside the pane → 403");
  ok(/SessionStart hook claim refused \(the hook process does not descend/.test(serverLog), "refusal logged with the reason");
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane, pid: process.pid, at: Date.now() }));
  ok(res.status === 403 && (serverLog.match(/hook claim refused \(the hook process does not descend/g) || []).length === 1, "the same refusal again is not logged again (warnOnce per agent + reason)");
  // the pane's own shell pid: under the pane, but no claude between → 403
  const paneShellPid = Number(tmuxSafe(["display-message", "-t", paneOf(cId), "-p", "#{pane_pid}"]));
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane, pid: paneShellPid, at: Date.now() }));
  ok(res.status === 403 && /no live claude/.test((await res.json()).error), "the pane shell itself (no claude between) → 403");
  // shell-tab pane: a `-sh1` session of the agent
  tmuxS(["new-session", "-d", "-s", `${paneOf(cId)}-sh1`, "-x", "80", "-y", "24"]);
  const shPane = tmuxSafe(["display-message", "-t", `${paneOf(cId)}-sh1`, "-p", "#{pane_id}"]);
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane: shPane, pid: sleepPid, at: Date.now() }));
  ok(res.status === 409 && /shell tab/.test((await res.json()).error), "a claim naming the agent's shell-tab pane → 409");
  res = await POST("/api/hook/session-start", claim(join(WS, "b"), randomUUID(), { pane: paneId(bId), pid: sleepPid, at: Date.now() }));
  ok(res.status === 403 && onDisk(bId).runtime?.sessionId === undefined, "a claim naming ANOTHER agent's (shell) pane with this claude's pid → 403, that agent untouched");
  tmuxS(["new-session", "-d", "-s", "foreign", "-x", "80", "-y", "24"]);
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane: tmuxSafe(["display-message", "-t", "foreign", "-p", "#{pane_id}"]), pid: sleepPid, at: Date.now() }));
  ok(res.status === 404, "a pane outside Hadron → 404");
  const otherSid = randomUUID();
  for (const [body, why, want, re] of [
    [claim(join(WS, "c"), "nope", { pane, pid: sleepPid, at: Date.now() }), "bad uuid", 400],
    [claim(join(WS, "c"), sid2, { pane: "5", pid: sleepPid, at: Date.now() }), "bad pane", 400],
    [claim(join(WS, "c"), sid2, { pane, pid: "x", at: Date.now() }), "bad pid", 400, /pid must be/],
    [claim(join(WS, "c"), sid2, { pane, pid: sleepPid, at: "soon" }), "bad at", 400],
    [claim(join(WS, "c"), sid2, { pane, pid: sleepPid, at: Date.now() + 60000 }), "future at (would refuse every later claim)", 400, /in the future/],
    [{ sessionId: sid2, pane, pid: sleepPid, at: Date.now() }, "no transcriptPath", 400, /transcriptPath/],
    [{ sessionId: otherSid, transcriptPath: tpath(join(WS, "c"), sid2), pane, pid: sleepPid, at: Date.now() }, "transcriptPath names another id (arbitrary UUID pinned by a token holder)", 400, /transcriptPath/],
    [{ sessionId: otherSid, transcriptPath: tpath(join(WS, "b"), otherSid), pane, pid: sleepPid, at: Date.now() }, "transcriptPath under another agent's cwd project", 409, /agent's cwd/],
    [claim(join(WS, "c"), sid2, { pane: "%99999", pid: sleepPid, at: Date.now() }), "unknown pane", 404],
  ]) {
    res = await POST("/api/hook/session-start", body);
    const err = (await res.json()).error || "";
    ok(res.status === want && (!re || re.test(err)), `${why} → ${res.status} ${err}`);
  }
  ok(onDisk(cId).runtime.sessionId === sid2, "none of those touched the id");
  // a split of the agent's window is not the conversation pane
  const splitPane = tmuxSafe(["split-window", "-d", "-t", paneOf(cId), "-P", "-F", "#{pane_id}"]);
  res = await POST("/api/hook/session-start", claim(join(WS, "c"), randomUUID(), { pane: splitPane, pid: sleepPid, at: Date.now() }));
  ok(res.status === 409 && /conversation pane/.test((await res.json()).error) && onDisk(cId).runtime.sessionId === sid2, `a split pane of the agent's window → 409 (${splitPane})`);
  tmuxS(["kill-pane", "-t", splitPane]);
  // a NESTED claude under the pane's claude (claude -p launched by the conversation's Bash tool) — cp-a: the
  // pane shell becomes the outer claude, which runs the fixture claude as a child → two claudes on the path
  sendLine(aId, "exec -a claude bash -c 'claude; true'");
  await waitDisk(aId, (a) => a.runtime?.observedRuntime === "claude", 15000);
  const aOuter = Number(tmuxSafe(["display-message", "-t", paneOf(aId), "-p", "#{pane_pid}"]));
  const aInner = children(aOuter).find((k) => { try { return readFileSync(`/proc/${k}/cmdline`, "utf-8").split("\0")[0] === "claude"; } catch { return false; } });
  ok(Boolean(aInner), `cp-a: a nested claude ${aInner} under the pane's claude ${aOuter}`);
  const nestedSid = randomUUID();
  res = await POST("/api/hook/session-start", claim(join(WS, "a"), nestedSid, { pane: paneId(aId), pid: children(aInner)[0], at: Date.now() }));
  ok(res.status === 403 && /nested claude/.test((await res.json()).error) && onDisk(aId).runtime?.sessionId === undefined, "the nested claude's SessionStart → 403, cp-a keeps no id");
  res = await POST("/api/hook/session-start", claim(join(WS, "a"), nestedSid, { pane: paneId(aId), pid: aInner, at: Date.now() }));
  ok(res.status === 200 && onDisk(aId).runtime?.sessionId === nestedSid, "…while a hook run by the OUTER claude (one claude on the path, the pane process) is accepted");
  // registry disagreement, on cp-b: its claude has a registry record (taken by
  // the tracker within the no-id poll interval → confidence registry). A hook
  // claim for another id is refused — claude's own record is the process's
  // current state — and a same-id claim keeps the pinned provenance.
  sendLine(bId, "claude");
  await waitDisk(bId, (a) => a.runtime?.observedRuntime === "claude", 15000);
  const sidR = randomUUID();
  writeRegistryRecord(bId, sidR); // no transcript yet: nothing to scrape, the registry is the only source
  let bd = await waitDisk(bId, (a) => a.runtime?.confidence === "registry", 15000);
  seedTranscript(join(WS, "b"), sidR);
  ok(bd.runtime?.sessionId === sidR && bd.runtime.confidence === "registry", `cp-b: the tracker took the registry's id (${bd.runtime?.confidence})`);
  const bPane = paneId(bId), bSleep = children(fixturePid(bId))[0];
  res = await POST("/api/hook/session-start", claim(join(WS, "b"), randomUUID(), { pane: bPane, pid: bSleep, at: Date.now() }));
  ok(res.status === 409 && /registry names a different/.test((await res.json()).error) && onDisk(bId).runtime.sessionId === sidR, "claude's registry naming another id → 409 (the registry wins)");
  res = await POST("/api/hook/session-start", claim(join(WS, "b"), sidR, { pane: bPane, pid: bSleep, at: Date.now() }));
  j = await res.json();
  bd = onDisk(bId);
  ok(res.status === 200 && j.changed === false && j.confidence === "registry" && bd.runtime.confidence === "registry", `a same-id claim keeps the registry provenance (${bd.runtime.confidence})`);
  cd = onDisk(cId);
  ok(!("restoreAttempt" in cd.runtime), "restoreAttempt untouched by hook claims");
  // CLI --hook edge cases: always exit 0, always silent
  const before = serverLog.length;
  c = runCli(["checkpoint", "--hook"], { env: { HADRON_PORT: "", HADRON_TOKEN: "" }, input: JSON.stringify({ session_id: randomUUID() }) });
  ok(c.code === 0 && c.stdout === "" && serverLog.length === before, "--hook without HADRON_PORT/HADRON_TOKEN/TMUX_PANE: exit 0, silent, nothing posted");
  c = runCli(["checkpoint", "--hook"], { env: { TMUX_PANE: pane }, input: "not json" });
  ok(c.code === 0 && c.stdout === "", "--hook with garbage stdin: exit 0, silent");
  c = runCli(["checkpoint", "--hook"], { env: { TMUX_PANE: pane, HADRON_PORT: "1" }, input: JSON.stringify({ session_id: randomUUID() }) });
  ok(c.code === 0 && c.stdout === "", "--hook with an unreachable server: exit 0, silent");
  c = runCli(["checkpoint", "--hook"], { env: { TMUX_PANE: pane }, input: JSON.stringify({ session_id: randomUUID() }) });
  ok(c.code === 0 && c.stdout === "" && onDisk(cId).runtime.sessionId === sid2, "--hook run by hand outside the pane: server refuses (403), CLI exits 0, id kept");
  ok(!serverLog.includes(sidR) && !serverLog.includes(sid2) && !serverLog.includes(cSid), "server log never carries a session id");
  ok(!serverLog.includes(TOKEN), "server log never carries the token");

  console.log(`\n${passed} passed, ${failed} failed`);
}

try { await main(); } catch (e) { console.error(`\n✗ suite crashed: ${e.stack || e}`); failed++; }
await killServer();
try { tmuxS(["kill-server"]); } catch {}
try { rmSync(T, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
