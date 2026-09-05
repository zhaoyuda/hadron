/**
 * Auto-resume at the REAL boundary: a Hadron server + a private tmux server +
 * a process that is actually named `claude` / `claude.exe`.
 *
 * Fixture: a bash script on the pane PATH that records its argv, then
 * `exec -a <name> sleep` so tmux reports pane_current_command=<name> (Linux
 * reads /proc/<pid>/cmdline[0]). It validates itself in a probe pane first —
 * where the platform reports a kernel process name instead (macOS), the whole
 * suite prints an honest `skip`, never a vacuous pass.
 *
 * Isolation: the server gets HADRON_TMUX_SOCKET=<tmp>/tmux.sock (tmux -S), so
 * nothing here can touch the developer's own tmux server — TMUX_TMPDIR would
 * NOT do that from inside a pane ($TMUX wins). HOME=<tmp> so the transcripts
 * under ~/.claude/projects are the test's.
 *
 * Scenarios (reliability-plan step 2): checkpoint on disk, claude.exe name,
 * shared cwd refused + warned once per agent, clean-exit tombstone, reboot
 * (resume delivered through the launcher argv; same HADRON_BOOT_ID → no second
 * launch; new boot id → launches), failed resume.
 *
 * Run: node test/unit/test-resume-live.js      Requires: tmux, bash.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createServer } from "net";
import WebSocket from "ws";
import { claudeProjectDir } from "../../server/resume.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
// OS-assigned free port (never a fixed candidate list — a collision with an
// unrelated service would make waitForServer() accept a stranger's 200).
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

const T = mkdtempSync(join(tmpdir(), "hadron-rlive-"));
const SOCK = join(T, "tmux.sock");
const HOME = join(T, "home");
const FIX = join(T, "bin");
const WS = join(T, "ws");
const ARGV_LOG = join(T, "argv.log");
const EXIT_FLAG = join(T, "fixture-exit-now");
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
for (const d of [HOME, FIX, WS, join(WS, "a1"), join(WS, "a2"), join(WS, "shared"), join(WS, "reboot")]) mkdirSync(d, { recursive: true });
// Panes are login shells: make sure the fixture dir wins even if a system
// profile rewrites PATH (the env inherited from the tmux server is the primary path).
writeFileSync(join(HOME, ".profile"), `export PATH="${FIX}:$PATH"\n`);
writeFileSync(join(HOME, ".bashrc"), `export PATH="${FIX}:$PATH"\n`);
mkdirSync(join(WS, ".hadron"), { recursive: true });
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({
  name: "rlive", groups: ["Workers"],
  launchers: { "cc-fix": { argv: ["claude.exe", "--fixture-flag"], kind: "claude" } },
}, null, 2));

// ── fixture ──────────────────────────────────────────────────────────────
function installFixture(name) {
  const p = join(FIX, name);
  writeFileSync(p, `#!/usr/bin/env bash
# test fixture: a process that is NAMED like claude and records its argv
printf '%s\\n' "$*" >> '${ARGV_LOG}'
case " $* " in *" --help "*) echo "Usage: ${name} [options]  --resume <id>  --session-id <id>"; exit 0;; esac
[ -e '${EXIT_FLAG}' ] && exit 1
exec -a ${name} sleep 300
`);
  chmodSync(p, 0o755);
}
installFixture("claude");
installFixture("claude.exe");

// Test-side tmux: always the private socket, never the inherited $TMUX.
const tenv = { ...process.env, PATH: `${FIX}:${process.env.PATH}`, HOME };
delete tenv.TMUX;
function tmuxS(args, opts = {}) {
  return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: tenv, ...opts });
}
function tmuxSafe(args) { try { return tmuxS(args).trim(); } catch { return null; } }
const paneOf = (id) => `hadron-${WS_NAME}-${id}`;
const paneCmd = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_current_command}"]);
const hasPane = (id) => tmuxSafe(["has-session", "-t", paneOf(id)]) !== null;
function sendLine(id, line) { tmuxS(["send-keys", "-t", paneOf(id), "-l", "--", line]); tmuxS(["send-keys", "-t", paneOf(id), "Enter"]); }

// Fixture self-validation in a probe pane on the private server. Only ONE
// outcome is a skip: the fixture demonstrably ran (argv recorded) and tmux
// reported some other process name (a platform that reads the kernel proc
// name, not argv[0]). tmux failure, launch failure, or no argv evidence is a
// FAILURE of this gate — never a silent exit 0.
function validateFixture() {
  tmuxS(["new-session", "-d", "-s", "probe", "-x", "80", "-y", "24", "claude.exe --probe"]);
  let seen = null;
  for (let i = 0; i < 30; i++) {
    seen = tmuxSafe(["display-message", "-t", "probe", "-p", "#{pane_current_command}"]);
    if (seen === "claude.exe") break;
    execFileSync("sleep", ["0.1"]);
  }
  const log = existsSync(ARGV_LOG) ? readFileSync(ARGV_LOG, "utf-8") : "";
  tmuxSafe(["kill-session", "-t", "probe"]);
  if (!log.includes("--probe")) throw new Error(`fixture did not run in the probe pane (pane_current_command=${JSON.stringify(seen)}, argv log=${JSON.stringify(log)})`);
  if (seen === null) throw new Error("probe pane vanished before tmux could report its command");
  rmSync(ARGV_LOG);
  if (seen !== "claude.exe") return { ok: false, why: `tmux reports ${JSON.stringify(seen)} for a process whose argv[0] is claude.exe` };
  return { ok: true };
}

// ── server ───────────────────────────────────────────────────────────────
let server, TOKEN, serverLog = "";
function bootServer(bootId) {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash",
    PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: bootId, HADRON_RESUME_READY_POLLS: "5",
    INVOCATION_ID: "", XPC_SERVICE_NAME: "",
  };
  delete env.TMUX; delete env.TMUX_PANE;
  server = spawn("node", [join(REPO, "server", "index.js"), WS], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  return server;
}
// Ready only when the health response is OUR process (pid) on OUR workspace.
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        const h = await r.json();
        if (h.pid === server.pid) return h;
        throw new Error(`port ${PORT} answered with pid ${h.pid}, expected ${server.pid} — another service owns it`);
      }
    } catch (e) { if (/another service owns it/.test(e.message)) throw e; }
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
async function createAgent(name, cwd, launchCommand = "shell") {
  const r = await POST("/api/sessions", { name, cwd, launchCommand, group: "Workers", autostart: launchCommand !== "shell" });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status} ${await r.text()}`);
  return (await r.json()).id;
}
const onDisk = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));
async function waitDisk(id, pred, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const a = onDisk(id); if (pred(a)) return a; } catch {}
    await sleep(250);
  }
  return onDisk(id);
}
function seedTranscript(cwd, sid) {
  const dir = join(HOME, ".claude", "projects", claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ type: "summary", sessionId: sid, cwd }) + "\n" + JSON.stringify({ type: "user", sessionId: sid, cwd, message: { role: "user", content: "hi" } }) + "\n");
}
const argvLines = () => (existsSync(ARGV_LOG) ? readFileSync(ARGV_LOG, "utf-8").split("\n").filter(Boolean) : []);
const countLog = (re) => (serverLog.match(re) || []).length;

async function main() {
  const probe = validateFixture();
  if (!probe.ok) {
    console.log(`skip (process-name fixture unavailable on ${process.platform}: ${probe.why})`);
    return;
  }
  console.log("fixture: pane_current_command reports the exec -a name — live suite is authoritative here");

  bootServer("boot-A");
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const health = await waitForServer();
  ok(health.pid === server.pid && health.repoRoot === REPO, "health answers with the spawned server's pid + this repo");
  ok(health.bootIdSource === "env", `health.bootIdSource is "env" under HADRON_BOOT_ID (${health.bootIdSource})`);
  ok(/boot generation boot-boot-A \(source: env\)/.test(serverLog), "server log names the boot generation and its source");

  // 1. checkpoint appears on disk (scraped, correlated)
  console.log("\n1. checkpoint appears on disk");
  const cwd1 = join(WS, "a1"), sid1 = randomUUID();
  seedTranscript(cwd1, sid1);
  const a1 = await createAgent("live-a1", cwd1);
  await sleep(1500);
  sendLine(a1, "claude");
  let d = await waitDisk(a1, (a) => a.runtime?.sessionId);
  ok(paneCmd(a1) === "claude", `pane_current_command is "claude" (${paneCmd(a1)})`);
  ok(d.runtime?.observedRuntime === "claude", "on-disk runtime.observedRuntime = claude");
  ok(d.runtime?.desiredRuntime === "claude", "on-disk runtime.desiredRuntime = claude");
  ok(typeof d.runtime?.lastObservedAt === "string" && Date.now() - Date.parse(d.runtime.lastObservedAt) < 60000, "lastObservedAt is fresh");
  ok(d.runtime?.sessionId === sid1, `sessionId = seeded transcript id (${d.runtime?.sessionId})`);
  ok(d.runtime?.confidence === "correlated", `confidence = correlated (${d.runtime?.confidence})`);

  // 2. macOS binary name
  console.log("\n2. claude.exe process name");
  const cwd2 = join(WS, "a2"), sid2 = randomUUID();
  seedTranscript(cwd2, sid2);
  const a2 = await createAgent("live-a2", cwd2);
  await sleep(1500);
  sendLine(a2, "claude.exe");
  d = await waitDisk(a2, (a) => a.runtime?.sessionId);
  ok(paneCmd(a2) === "claude.exe", `pane_current_command is "claude.exe" (${paneCmd(a2)})`);
  ok(d.runtime?.observedRuntime === "claude" && d.runtime?.sessionId === sid2, "claude.exe tracked: observedRuntime claude + seeded sessionId");
  ok(!/claudeish:/.test(serverLog) && !/looks like claude but is not tracked/.test(serverLog), "no 'looks like claude but is not tracked' warning for claude.exe");

  // 3. shared cwd: refused, warned once per agent
  console.log("\n3. shared cwd");
  const cwdS = join(WS, "shared"), sidS = randomUUID();
  seedTranscript(cwdS, sidS);
  const s1 = await createAgent("live-s1", cwdS);
  const s2 = await createAgent("live-s2", cwdS);
  await sleep(1500);
  sendLine(s1, "claude"); sendLine(s2, "claude");
  await sleep(7000);
  const ds1 = onDisk(s1), ds2 = onDisk(s2);
  ok(ds1.runtime?.observedRuntime === "claude" && ds2.runtime?.observedRuntime === "claude", "both shared-cwd agents observed in claude");
  ok(!ds1.runtime?.sessionId && !ds2.runtime?.sessionId, "neither shared-cwd agent got a scraped session id");
  ok(countLog(new RegExp(`agent ${s1}: cwd .* is shared`, "g")) === 1, `shared-cwd warning logged exactly once for ${s1}`);
  ok(countLog(new RegExp(`agent ${s2}: cwd .* is shared`, "g")) === 1, `shared-cwd warning logged exactly once for ${s2}`);
  ok(!new RegExp(`agent ${a1}: cwd .* is shared`).test(serverLog), "unique-cwd agent never warned");
  // Prove the once-ness against REAL further opportunities: exit claude (tombstone on
  // disk = the tracker ran), relaunch, wait for the second settle (cleanExitAt cleared
  // on disk = ≥3 more observe() calls with cwd still shared and no session id).
  for (const id of [s1, s2]) {
    tmuxS(["send-keys", "-t", paneOf(id), "C-c"]);
    await waitDisk(id, (a) => a.runtime?.cleanExitAt);
    sendLine(id, "claude");
    const again = await waitDisk(id, (a) => a.runtime?.observedRuntime === "claude" && !a.runtime?.cleanExitAt);
    ok(again.runtime?.observedRuntime === "claude" && !again.runtime?.cleanExitAt && !again.runtime?.sessionId, `${id}: re-settled in claude after a relaunch, still no scraped id`);
    ok(countLog(new RegExp(`agent ${id}: cwd .* is shared`, "g")) === 1, `${id}: warning count still exactly 1 after a second settle`);
  }

  // 4. tombstone
  console.log("\n4. clean-exit tombstone");
  tmuxS(["send-keys", "-t", paneOf(a2), "C-c"]);
  d = await waitDisk(a2, (a) => a.runtime?.cleanExitAt);
  ok(paneCmd(a2) === "bash", `pane back to a shell (${paneCmd(a2)})`);
  ok(typeof d.runtime?.cleanExitAt === "string", "cleanExitAt written on disk");
  ok(d.runtime?.desiredRuntime === "shell" && d.runtime?.observedRuntime === "shell", "desired/observed runtime = shell");

  // 5. reboot — through a claude-kind launcher (authoritative id via --session-id)
  console.log("\n5. reboot");
  const cwdR = join(WS, "reboot");
  const r1 = await createAgent("live-reboot", cwdR, "cc-fix");
  d = await waitDisk(r1, (a) => a.runtime?.confidence === "authoritative" && a.runtime?.observedRuntime === "claude");
  const sidR = d.runtime?.sessionId;
  ok(/^[0-9a-f-]{36}$/.test(sidR || "") && d.runtime?.confidence === "authoritative", `autostart recorded an authoritative --session-id (${sidR})`);
  ok(d.runtime?.observedRuntime === "claude" && typeof d.runtime?.lastObservedAt === "string", "settle persisted observedRuntime + lastObservedAt on disk immediately (no 30 s heartbeat wait)");
  ok(argvLines().some((l) => l === `--fixture-flag --session-id ${sidR}`), "fixture saw the launcher argv + --session-id");
  ok(paneCmd(r1) === "claude.exe", `launcher ran the claude.exe fixture (${paneCmd(r1)})`);

  const linesBefore = argvLines().length;
  await killServer();
  tmuxS(["kill-session", "-t", paneOf(r1)]);
  ok(!hasPane(r1), "agent pane gone after simulated crash");
  bootServer("boot-A");
  await waitForServer();
  d = await waitDisk(r1, (a) => a.runtime?.restoreAttempt?.state === "ready", 20000);
  ok(hasPane(r1), "server recreated the agent pane");
  const resumeLines = argvLines().slice(linesBefore).filter((l) => l.includes("--resume"));
  if (resumeLines.length !== 1) console.error("server log after restart:\n" + serverLog.split("\n").filter((l) => /resume|rror|warn/i.test(l)).join("\n"));
  ok(resumeLines.length === 1 && resumeLines[0] === `--fixture-flag --resume ${sidR}`, `fixture received exactly the launcher argv + --resume <seeded id> (${JSON.stringify(resumeLines)})`);
  ok(d.runtime?.restoreAttempt?.state === "ready", `restoreAttempt.state = ready (${d.runtime?.restoreAttempt?.state})`);
  ok(d.runtime?.restoreAttempt?.generation === "boot-boot-A" && d.runtime?.restoreAttempt?.attempts === 1, "restoreAttempt carries the boot generation, attempts=1");
  ok(paneCmd(r1) === "claude.exe", "resumed pane is running the fixture");
  ok(new RegExp(`\\[resume\\] ${r1}: resuming session ${sidR}`).test(serverLog), "log says it resumed");
  // shared-cwd warning did not fire for the reboot agent (unique cwd, authoritative id)
  ok(!new RegExp(`agent ${r1}: cwd .* is shared`).test(serverLog), "no shared-cwd warning for the launcher-spawned agent");

  console.log("\n5b. same boot id → no second launch");
  const before2 = argvLines().length;
  serverLog = "";
  await killServer();
  tmuxS(["kill-session", "-t", paneOf(r1)]);
  bootServer("boot-A");
  await waitForServer();
  await sleep(5000);
  ok(hasPane(r1), "pane recreated");
  ok(argvLines().slice(before2).filter((l) => l.includes("--resume")).length === 0, "no --resume delivered");
  ok(new RegExp(`\\[resume\\] ${r1}: skip — already attempted this boot`).test(serverLog), "log: skip — already attempted this boot");
  ok(paneCmd(r1) === "bash", `pane left at a shell (${paneCmd(r1)})`);
  ok(onDisk(r1).runtime?.restoreAttempt?.attempts === 1, "attempts still 1");

  console.log("\n5c. different boot id → launches again");
  const before3 = argvLines().length;
  serverLog = "";
  await killServer();
  tmuxS(["kill-session", "-t", paneOf(r1)]);
  bootServer("boot-B");
  await waitForServer();
  d = await waitDisk(r1, (a) => a.runtime?.restoreAttempt?.generation === "boot-boot-B" && a.runtime?.restoreAttempt?.state === "ready", 20000);
  const resume3 = argvLines().slice(before3).filter((l) => l.includes("--resume"));
  ok(resume3.length === 1 && resume3[0] === `--fixture-flag --resume ${sidR}`, "new boot: --resume delivered once more");
  ok(d.runtime?.restoreAttempt?.generation === "boot-boot-B" && d.runtime?.restoreAttempt?.state === "ready" && d.runtime?.restoreAttempt?.attempts === 2, "restoreAttempt: generation B, ready, attempts=2");

  // 6. failed resume: fixture exits immediately
  console.log("\n6. failed resume");
  writeFileSync(EXIT_FLAG, "");
  const before4 = argvLines().length;
  serverLog = "";
  await killServer();
  tmuxS(["kill-session", "-t", paneOf(r1)]);
  bootServer("boot-C");
  await waitForServer();
  d = await waitDisk(r1, (a) => a.runtime?.restoreAttempt?.generation === "boot-boot-C" && a.runtime?.restoreAttempt?.state !== "started", 25000);
  ok(argvLines().slice(before4).some((l) => l === `--fixture-flag --resume ${sidR}`), "resume was attempted");
  ok(d.runtime?.restoreAttempt?.state === "failed", `restoreAttempt.state = failed (${d.runtime?.restoreAttempt?.state})`);
  ok(new RegExp(`\\[resume\\] ${r1}: claude TUI did not come up`).test(serverLog), "log: claude TUI did not come up");
  ok(paneCmd(r1) === "bash", "pane is a shell after the failed launch");
  ok(!/sharedcwd|looks like claude but is not tracked/.test(serverLog), "no unrelated warnings during the failed resume");

  // 7. WS terminal attaches on the PRIVATE socket. The agent session exists only
  // on HADRON_TMUX_SOCKET; if the server's node-pty `tmux attach-session` used
  // the default socket it would attach to a stranger (or nothing), and a marker
  // typed through the WS would never reach the pane we capture on the private
  // socket. This is the path sol flagged (server/index.js pty spawn).
  console.log("\n7. WS terminal attaches on the private tmux socket");
  const wcwd = join(WS, "wsterm"); mkdirSync(wcwd, { recursive: true });
  const w1 = await createAgent("live-wsterm", wcwd); // shell agent
  try { tmuxS(["resize-window", "-t", paneOf(w1), "-x", "120", "-y", "30"]); } catch {}
  const marker = `WSMARKER_${randomUUID().slice(0, 8)}`;
  const term = await new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${w1}&token=${encodeURIComponent(TOKEN)}`);
    const t = setTimeout(() => rej(new Error("no terminal output within 10s")), 10000);
    ws.on("message", () => { clearTimeout(t); res(ws); });
    ws.on("error", (e) => { clearTimeout(t); rej(e); });
  });
  term.send(JSON.stringify({ type: "input", data: `echo ${marker}\r` }));
  let saw = false;
  for (let i = 0; i < 25 && !saw; i++) { await sleep(200); saw = (tmuxSafe(["capture-pane", "-t", paneOf(w1), "-p", "-J"]) || "").includes(marker); }
  term.close();
  ok(saw, `marker typed through the WS reached the pane on the private socket (${marker})`);
}

main().catch((e) => { failed++; console.error(`  ✗ ${e.stack || e}`); }).finally(async () => {
  await killServer();
  try { execFileSync("tmux", ["-S", SOCK, "kill-server"], { stdio: "ignore", env: tenv }); } catch {}
  await sleep(500); // pane shells write ~/.bash_history as they die
  rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
