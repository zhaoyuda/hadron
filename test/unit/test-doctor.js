/**
 * `hadron doctor` at the real boundary — a Hadron server + a private tmux server
 * + processes actually named `claude` / `claude.exe`, plus the real CLI binary.
 *
 * Reuses step 2's fixture (a bash script that records its argv then `exec -a
 * <name> sleep`, so tmux reports pane_current_command=<name>). Isolation is the
 * same: HADRON_TMUX_SOCKET (private `tmux -S` server) + HOME=<tmp>. If the
 * platform reports a kernel proc name instead of argv[0] (macOS), the suite
 * prints an honest skip rather than a vacuous pass.
 *
 * Covers (reliability-plan step 3): one shell agent (n/a), one fake claude with a
 * seeded transcript (green), one fake claude sharing a cwd (red, shared-cwd text),
 * one claude.exe with the tracker's recognition disabled via a test-only env
 * (red "untracked"); CLI exit code 1; /api/doctor without a token → 401; the
 * response carries no "sessionId" key anywhere; a disk-seeded malformed
 * checkpoint loaded on restart with a live pane → the nominally-green row is
 * demoted to red by the decideResume cross-check (both CLI modes exit 1);
 * server down → CLI still exits 1 with "server unreachable" first.
 *
 * Run: node test/unit/test-doctor.js      Requires: tmux, bash.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { claudeProjectDir } from "../../server/resume.js";

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

const T = mkdtempSync(join(tmpdir(), "hadron-doctor-"));
const SOCK = join(T, "tmux.sock");
const HOME = join(T, "home");
const FIX = join(T, "bin");
const WS = join(T, "ws");
const ARGV_LOG = join(T, "argv.log");
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
for (const d of [HOME, FIX, WS, join(WS, "shell"), join(WS, "green"), join(WS, "shared"), join(WS, "untracked"), join(WS, "seed"), join(WS, "exhausted"), join(WS, "badconf"), join(WS, "badts"), join(WS, "nofile"), join(WS, "pinmiss"), join(WS, "pinnew")]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME, ".profile"), `export PATH="${FIX}:$PATH"\n`);
writeFileSync(join(HOME, ".bashrc"), `export PATH="${FIX}:$PATH"\n`);
mkdirSync(join(WS, ".hadron"), { recursive: true });
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({ name: "doctor", groups: ["Workers"] }, null, 2));

function installFixture(name) {
  const p = join(FIX, name);
  writeFileSync(p, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${ARGV_LOG}'
case " $* " in *" --help "*) echo "Usage: ${name} [options]  --resume <id>  --session-id <id>"; exit 0;; esac
exec -a ${name} sleep 300
`);
  chmodSync(p, 0o755);
}
installFixture("claude");
installFixture("claude.exe");

const tenv = { ...process.env, PATH: `${FIX}:${process.env.PATH}`, HOME };
delete tenv.TMUX;
function tmuxS(args, opts = {}) {
  return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: tenv, ...opts });
}
function tmuxSafe(args) { try { return tmuxS(args).trim(); } catch { return null; } }
const paneOf = (id) => `hadron-${WS_NAME}-${id}`;
const paneCmd = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_current_command}"]);
function sendLine(id, line) { tmuxS(["send-keys", "-t", paneOf(id), "-l", "--", line]); tmuxS(["send-keys", "-t", paneOf(id), "Enter"]); }

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

let server, TOKEN, serverLog = "";
function bootServer(extraEnv = {}) {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash",
    PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: "doctor",
    // The one agent named claude.exe must be UNrecognised so it reproduces the
    // "looks like claude but the tracker never tracked it" class. Agents named
    // plain `claude` stay recognised.
    HADRON_TEST_UNRECOGNIZE_CLAUDE_CMD: "claude.exe",
    INVOCATION_ID: "", XPC_SERVICE_NAME: "",
    ...extraEnv,
  };
  delete env.TMUX; delete env.TMUX_PANE;
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
// Claude's session registry (~/.claude/sessions/<pid>.json, under the test
// HOME) — written here exactly as claude writes it for a live process: the
// fixture claude's own pid + kernel start time, and the pane's exact
// `session:@window.%pane` target. The fixture is `exec -a claude sleep`, so
// argv[0] is claude (what tmux and processIdentity both read) and the pid is
// the pane shell's child.
const REG = join(HOME, ".claude", "sessions");
function fixturePid(id) {
  const panePid = tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_pid}"]);
  const kids = readFileSync(`/proc/${panePid}/task/${panePid}/children`, "utf-8").trim().split(/\s+/).filter(Boolean);
  const claude = kids.find((k) => { try { return readFileSync(`/proc/${k}/cmdline`, "utf-8").split("\0")[0] === "claude"; } catch { return false; } });
  if (!claude) throw new Error(`no claude child under pane pid ${panePid} (children: ${kids.join(",")})`);
  return Number(claude);
}
function procStartOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}
function writeRegistryRecord(id, sid, { pid = fixturePid(id), procStart = procStartOf(pid), tmux = `${paneOf(id)}:${tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{window_id}.#{pane_id}"])}` } = {}) {
  mkdirSync(REG, { recursive: true });
  // pidDomain as claude writes it: linux:<machine-id>:pid:[<ns>] — a machine id, NOT the boot id
  writeFileSync(join(REG, `${pid}.json`), JSON.stringify({
    pid, procStart, pidDomain: `linux:${randomUUID().replace(/-/g, "")}:pid:[4026531836]`, sessionId: sid, cwd: onDisk(id).cwd, tmux,
    status: "idle", updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), version: "2.1.283", kind: "interactive", entrypoint: "cli",
  }, null, 2));
  return pid;
}

// Run the REAL CLI. cwd=WS so it finds .hadron/{token,runtime.json}; token+port
// via env so discovery never depends on a running server for the down-case.
function runCli(args, { withServer = true } = {}) {
  const env = { ...process.env, HOME, HADRON_PORT: String(PORT) };
  if (withServer) env.HADRON_TOKEN = TOKEN;
  try {
    const stdout = execFileSync("node", [CLI, ...args], { cwd: WS, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

async function main() {
  const probe = validateFixture();
  if (!probe.ok) { console.log(`skip (process-name fixture unavailable on ${process.platform}: ${probe.why})`); return; }
  console.log("fixture: pane_current_command reports the exec -a name — doctor suite is authoritative here");

  bootServer();
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  // agents
  console.log("\nseeding agents");
  const shellId = await createAgent("doc-shell", join(WS, "shell"));                 // stays a bare shell

  const greenCwd = join(WS, "green"), greenSid = randomUUID();
  seedTranscript(greenCwd, greenSid);
  const greenId = await createAgent("doc-green", greenCwd);

  const sharedCwd = join(WS, "shared");
  const shA = await createAgent("doc-shared-a", sharedCwd);
  const shB = await createAgent("doc-shared-b", sharedCwd);

  const untrackedId = await createAgent("doc-untracked", join(WS, "untracked"));
  // doc-registry: a THIRD claude in the shared cwd — unscrapable like its
  // siblings, but claude's session registry names its pane, so the tracker
  // takes the id from there (confidence registry) and doctor goes green.
  const regSid = randomUUID();
  seedTranscript(sharedCwd, regSid);
  const regId = await createAgent("doc-registry", sharedCwd);

  await sleep(1500);
  sendLine(greenId, "claude");
  sendLine(shA, "claude");
  sendLine(shB, "claude");
  sendLine(untrackedId, "claude.exe");
  sendLine(regId, "claude");
  // green must reach a scraped sessionId; the others just need to settle (~3 polls)
  await waitDisk(greenId, (a) => a.runtime?.sessionId, 12000);
  await sleep(6000);
  ok(paneCmd(regId) === "claude" && !onDisk(regId).runtime?.sessionId, `registry agent settled with no id (shared cwd, no record yet) (${paneCmd(regId)})`);
  const regPid = writeRegistryRecord(regId, regSid);
  // a record for the GREEN agent's pane whose pid is gone: must read as stale, never matched
  const deadPid = (() => { const r = execFileSync("bash", ["-c", "sleep 0.01 & echo $!"], { encoding: "utf-8" }).trim(); return Number(r); })();
  execFileSync("sleep", ["0.3"]);
  writeRegistryRecord(greenId, randomUUID(), { pid: deadPid, procStart: 1 });
  const regDisk = await waitDisk(regId, (a) => a.runtime?.confidence === "registry", 15000);
  ok(regDisk.runtime?.sessionId === regSid && regDisk.runtime?.confidence === "registry", `tracker took the registry's id for the shared-cwd agent within the no-id poll interval (confidence ${regDisk.runtime?.confidence})`);
  ok(onDisk(greenId).runtime?.confidence === "correlated", "a stale record (dead pid) never replaced the green agent's scraped id");

  ok(paneCmd(greenId) === "claude", `green pane is claude (${paneCmd(greenId)})`);
  ok(paneCmd(untrackedId) === "claude.exe", `untracked pane is claude.exe (${paneCmd(untrackedId)})`);

  // ── endpoint: authentication ────────────────────────────────────────────
  console.log("\nGET /api/doctor authentication");
  const noTok = await fetch(`${BASE}/api/doctor`);
  ok(noTok.status === 401, `GET /api/doctor without a token → 401 (${noTok.status})`);
  const withTok = await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } });
  ok(withTok.status === 200, `GET /api/doctor with a token → 200 (${withTok.status})`);
  const doc = await withTok.json();

  // ── no session id leaks ─────────────────────────────────────────────────
  const raw = JSON.stringify(doc);
  ok(!/sessionId/.test(raw), "doctor response contains no \"sessionId\" key anywhere");
  ok(!raw.includes(greenSid), "doctor response does not leak the green agent's session id value");

  // ── per-agent classification ────────────────────────────────────────────
  console.log("\nper-agent classification");
  const byName = Object.fromEntries(doc.agents.map((a) => [a.name, a]));
  const F = (n) => byName[n]?.finding || {};
  ok(F("doc-shell").level === "na" && /not a claude session/.test(F("doc-shell").message), `shell agent → n/a "not a claude session" (${F("doc-shell").level}: ${F("doc-shell").message})`);
  ok(F("doc-green").level === "green" && /resumes as correlated/.test(F("doc-green").message), `seeded claude → green "resumes as correlated" (${F("doc-green").level}: ${F("doc-green").message})`);
  ok(!F("doc-green").crossCheck, "green agent passes the decideResume cross-check (no disagreement)");
  const sharedFinding = F("doc-shared-a").level === "red" ? F("doc-shared-a") : F("doc-shared-b");
  ok(sharedFinding.level === "red" && /shared cwd/.test(sharedFinding.message), `shared-cwd claude → red "shared cwd" (${sharedFinding.level}: ${sharedFinding.message})`);
  ok(F("doc-untracked").level === "red" && /untracked/.test(F("doc-untracked").message), `claude.exe (recognition disabled) → red "untracked" (${F("doc-untracked").level}: ${F("doc-untracked").message})`);
  ok(F("doc-registry").level === "green" && /resumes as registry/.test(F("doc-registry").message) && !F("doc-registry").crossCheck, `registry-named shared-cwd claude → green "resumes as registry" (${F("doc-registry").level}: ${F("doc-registry").message})`);
  ok(byName["doc-registry"].registry === "matched" && byName["doc-registry"].confidence === "registry", `row: registry=matched, confidence=registry (${byName["doc-registry"].registry}/${byName["doc-registry"].confidence})`);
  ok(byName["doc-registry"].registryAgrees === true && byName["doc-green"].registryAgrees === null && byName["doc-shell"].registryAgrees === null, `registryAgrees: true when matched with the checkpoint id, null otherwise (${byName["doc-registry"].registryAgrees}/${byName["doc-green"].registryAgrees})`);
  ok(byName["doc-green"].registry === "stale", `row: green agent's dead-pid record reads as registry=stale (${byName["doc-green"].registry})`);
  ok(sharedFinding && /session registry has no record for this pane/.test(sharedFinding.message) && (byName["doc-shared-a"].registry === "none" || byName["doc-shared-b"].registry === "none"), "shared-cwd red row says the registry had no record before blaming the scrape; row registry=none");
  ok(byName["doc-shell"].registry === null, "a shell pane has registry=null (not consulted)");
  ok(doc.sessionRegistry && doc.sessionRegistry.available === true && doc.sessionRegistry.entries === 2 && typeof doc.sessionRegistry.root === "string", `payload summarises the registry: available, 2 records (${JSON.stringify(doc.sessionRegistry)})`);
  ok(!raw.includes(regSid) && !raw.includes(String(regPid)), "doctor response leaks neither the registry session id nor the pid");

  // PATH column: fresh-shell PATH resolves `claude` to the fixture
  ok(byName["doc-green"].pathResolvesClaudeTo === join(FIX, "claude"), `green pathResolvesClaudeTo = fixture claude (${byName["doc-green"].pathResolvesClaudeTo})`);

  // caps probe present and re-mapped (no "sessionId" key)
  ok(doc.claudeCaps && typeof doc.claudeCaps.supportsSessionId === "boolean", "response includes a server-side claude caps probe (supportsSessionId)");

  // ── CLI: exit 1 when reds exist ─────────────────────────────────────────
  console.log("\nCLI hadron doctor");
  const cli = runCli(["doctor"]);
  ok(cli.code === 1, `hadron doctor exits 1 when red rows exist (exit ${cli.code})`);
  ok(/no session id \(.*shared cwd cannot be scraped/.test(cli.stdout), "CLI output shows the shared-cwd red row");
  ok(/untracked/.test(cli.stdout), "CLI output shows the untracked red row");
  ok(/resumes as correlated/.test(cli.stdout), "CLI output shows the green row");
  ok(/resumes as registry/.test(cli.stdout) && /· registry: matched/.test(cli.stdout) && /^registry \d+ live claude records in /m.test(cli.stdout), "CLI shows the registry-green row, per-row registry status and the registry header line");
  ok(!cli.stdout.includes(regSid), "CLI leaks no registry session id");
  ok(/will NOT restart after a reboot/.test(cli.stdout), "CLI flags the hand-started server as red (won't survive reboot)");
  ok(/tmux session PATH resolves claude to/.test(cli.stdout), "CLI prints the PATH-resolves-claude column for claude panes");
  const cliJson = runCli(["doctor", "--json"]);
  ok(cliJson.code === 1 && !/sessionId/.test(cliJson.stdout), "hadron doctor --json also exits 1 and leaks no sessionId");

  // ── hadron adopt: hand the operator's session id to a shared-cwd agent ───
  // Report 3 (macOS fleet, 2026-09-07): four hand-attached agents in shared
  // cwds could never get a session id — scraping is (correctly) refused there
  // and nothing let the operator supply the id they can read off `claude`.
  console.log("\nPOST /api/sessions/:id/adopt + hadron adopt");
  const shASid = randomUUID(), shBSid = randomUUID();
  seedTranscript(sharedCwd, shASid);
  seedTranscript(sharedCwd, shBSid);
  const bad = await POST(`/api/sessions/${shA}/adopt`, { sessionId: "$(rm -rf /)" });
  ok(bad.status === 400, `adopt with a malformed id → 400 (${bad.status})`);
  const noTx = await POST(`/api/sessions/${shA}/adopt`, { sessionId: randomUUID() });
  ok(noTx.status === 404 && /no transcript/.test((await noTx.json()).error), `adopt with a uuid that has no transcript for this cwd → 404 (${noTx.status})`);
  const nobody = await POST(`/api/sessions/no-such-agent/adopt`, { sessionId: shASid });
  ok(nobody.status === 404, `adopt on an unknown agent → 404 (${nobody.status})`);
  ok((onDisk(shA).runtime || {}).confidence !== "manual", "refused adopts left nothing on disk");
  const good = await POST(`/api/sessions/${shA}/adopt`, { sessionId: shASid });
  ok(good.status === 200, `adopt with the transcript-backed id → 200 (${good.status})`);
  const shADisk = await waitDisk(shA, (a) => a.runtime?.confidence === "manual", 5000);
  ok(shADisk.runtime?.sessionId === shASid && shADisk.runtime?.confidence === "manual", "adopted id persisted on disk with confidence manual");
  const cliAdopt = runCli(["adopt", "doc-shared-b", "--session-id", shBSid]);
  ok(cliAdopt.code === 0 && /adopted session id for doc-shared-b/.test(cliAdopt.stdout), `hadron adopt <name> --session-id <uuid> → exit 0 (${cliAdopt.code}: ${cliAdopt.stdout.trim()})`);
  const cliAdoptBad = runCli(["adopt", "doc-shared-b", "--session-id", randomUUID()]);
  ok(cliAdoptBad.code !== 0, `hadron adopt with an unverifiable id exits non-zero (${cliAdoptBad.code})`);
  await sleep(4000); // let the trackers poll again: a scrape must NOT demote the manual ids
  const docA = await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json();
  const FA = (n) => docA.agents.find((a) => a.name === n)?.finding || {};
  ok(FA("doc-shared-a").level === "green" && /resumes as manual/.test(FA("doc-shared-a").message), `adopted shared-cwd agent → green "resumes as manual" (${FA("doc-shared-a").level}: ${FA("doc-shared-a").message})`);
  ok(FA("doc-shared-b").level === "green" && /resumes as manual/.test(FA("doc-shared-b").message), `CLI-adopted agent → green "resumes as manual" (${FA("doc-shared-b").level}: ${FA("doc-shared-b").message})`);
  ok(!FA("doc-shared-a").crossCheck && !FA("doc-shared-b").crossCheck, "manual rows pass the decideResume cross-check");
  ok(!JSON.stringify(docA).includes(shASid) && !JSON.stringify(docA).includes(shBSid), "doctor still leaks no adopted session id");

  // ── transcript summary on the wire form (server/transcript.js) ─────────────
  // An adopted (or correlated) session id is what licenses reading claude's
  // transcript for an agent; the last prompt/reply then ride /api/sessions as
  // `transcript` (never persisted, no session id inside). Appending a reply to
  // the seeded file must show up within a couple of polls; an agent with no
  // session id (the plain shell agent) never gets a transcript field.
  console.log("\ntranscript summary via adopted session id");
  {
    const file = join(HOME, ".claude", "projects", claudeProjectDir(sharedCwd), `${shASid}.jsonl`);
    const at = new Date().toISOString();
    appendFileSync(file, JSON.stringify({ type: "user", sessionId: shASid, cwd: sharedCwd, timestamp: at, message: { role: "user", content: "what is the status?" } }) + "\n"
      + JSON.stringify({ type: "assistant", sessionId: shASid, cwd: sharedCwd, timestamp: at, message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "All green.\nDetails below." }] } }) + "\n");
    let wire = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const list = await (await fetch(`${BASE}/api/sessions`, { headers: { "x-hadron-token": TOKEN } })).json();
      wire = list.find((x) => x.id === shA);
      if (wire?.transcript?.lastReply) break;
      await sleep(300);
    }
    ok(wire?.transcript?.lastReply?.text === "All green.\nDetails below.", `adopted agent's /api/sessions carries transcript.lastReply from claude's file (${JSON.stringify(wire?.transcript?.lastReply?.text)})`);
    ok(wire?.transcript?.lastPrompt?.text === "what is the status?" && wire.transcript.lastActivityAt === at, "…and lastPrompt + lastActivityAt");
    ok(!JSON.stringify(wire.transcript).includes(shASid), "transcript summary carries no session id");
    const list = await (await fetch(`${BASE}/api/sessions`, { headers: { "x-hadron-token": TOKEN } })).json();
    const shellWire = list.find((x) => x.id === shellId);
    ok(shellWire && !("transcript" in shellWire), "shell agent (no session id) has no transcript field");
    // API GETs are open on the bound host; the conversation is not.
    const anon = await (await fetch(`${BASE}/api/sessions`)).json();
    ok(anon.every((x) => !("transcript" in x)), "GET /api/sessions without the token carries no transcript for any agent");
    const fullAnon = await fetch(`${BASE}/api/sessions/${shA}/transcript`);
    ok(fullAnon.status === 401, `GET /api/sessions/:id/transcript without the token → 401 (${fullAnon.status})`);
    const full = await (await fetch(`${BASE}/api/sessions/${shA}/transcript`, { headers: { "x-hadron-token": TOKEN } })).json();
    ok(full?.lastReply?.text === "All green.\nDetails below." && !JSON.stringify(full).includes(shASid), "…with the token: full summary, no session id");
    const docTx = await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json();
    ok(docTx.agents.find((a) => a.id === shA)?.transcriptPreview === "ok" && docTx.agents.find((a) => a.id === shellId)?.transcriptPreview === null,
      "doctor row: transcriptPreview \"ok\" for the adopted agent, null for the shell agent");
  }
  ok(onDisk(shA).runtime.sessionId === shASid && onDisk(shB).runtime.sessionId === shBSid, "manual ids survived further tracker polls (no scrape demotion)");

  // ── disk-seed + restart: a nominally-green row decideResume refuses ───────
  // The live scraper filters non-UUIDs, so a malformed / mistrusted checkpoint
  // is only reachable by loading a corrupted on-disk checkpoint at boot. Seed
  // one in a no-transcript cwd (so the settling tracker can't scrape a real id
  // over it), reboot with the pane still alive (created=false → no auto-resume
  // overwrite), and prove classifyAgentHealth demotes the nominally-green row to
  // red via the decideResume cross-check — and that both CLI modes exit 1. This
  // is the defense-in-depth path: presence-only green checks would pass it.
  // Two agents, both live in no-transcript cwds, seeded with checkpoints that
  // classify green on presence but decideResume refuses when it simulates the
  // NEXT boot:
  //   doc-seed      — malformed session id ("not-a-uuid").
  //   doc-exhausted — a fresh VALID checkpoint whose restoreAttempt is
  //     { generation: <this boot>, attempts: 3, state: "ready" }: a session that
  //     resumed on its 3rd try and is now live. Against the CURRENT generation
  //     decideResume returns "already attempted this boot" (would mask it green);
  //     against a real reboot the generation changes and it becomes "attempts
  //     exhausted" — it would NOT come back. Doctor must report red.
  //   doc-badconf   — a fresh VALID checkpoint whose `confidence` is a corrupt
  //     token-like string. Doctor must red it (unknown confidence is below every
  //     policy) with a SANITIZED reason ("confidence invalid below policy …") and
  //     must not echo the raw token in the field, the reason, or the CLI.
  //   doc-badts     — a BARE-SHELL pane (the tracker leaves a shell pane's runtime
  //     untouched, so seeded timestamp corruption survives; on a live claude pane
  //     it would be healed at settle). Its three timestamp fields carry untrusted
  //     junk: cleanExitAt and lastObservedAt are non-parseable tokens, and
  //     lastPersistedAt is materially in the future (now + 1 day). Doctor must
  //     (a) never echo any of them — every emitted timestamp is null; (b) not
  //     trust the token cleanExitAt as a clean exit (→ yellow "claude gone", not
  //     n/a "exited cleanly"); and (c) reject the future lastPersistedAt via the
  //     same safeTimestamp used by the durability + decideResume freshness checks,
  //     so a future/clock-skewed checkpoint can't report fresh indefinitely.
  console.log("\ndisk-seed + restart: green demoted to red by the cross-check");
  const seedCwd = join(WS, "seed");
  const seedId = await createAgent("doc-seed", seedCwd);
  const exhCwd = join(WS, "exhausted");
  const exhId = await createAgent("doc-exhausted", exhCwd);
  const bcCwd = join(WS, "badconf");
  const bcId = await createAgent("doc-badconf", bcCwd);
  const btCwd = join(WS, "badts");
  const btId = await createAgent("doc-badts", btCwd);   // stays a bare shell (no claude launched)
  //   doc-nofile    — a VALID correlated checkpoint whose transcript does not exist
  //     under the agent's cwd (claude cleaned it up, or it was scraped while the
  //     pane was cd'd elsewhere — prod 2026-09-28, two agents). `claude --resume`
  //     would fail. Doctor must red it before the tracker settles, and the
  //     tracker must drop the id at settle (exclusive cwd, nothing to re-scrape →
  //     red "no session id"), so the on-disk checkpoint stops lying.
  const nfCwd = join(WS, "nofile");
  const nfId = await createAgent("doc-nofile", nfCwd);
  //   doc-pinmiss   — a MANUAL (pinned) id whose transcript does not exist. The
  //     identity is kept (never demoted), but it is not resumable: doctor must
  //     red it and keep the id on disk (astra review 2026-09-28, finding 3).
  const pmCwd = join(WS, "pinmiss");
  const pmId = await createAgent("doc-pinmiss", pmCwd);
  //   doc-pinnew    — a MANUAL id whose transcript was NEVER seen (claude has not
  //     written the first turn — every Hadron spawn passes through this): yellow,
  //     not a false alarm (Opus review 2026-09-28, finding 3).
  const pnCwd = join(WS, "pinnew");
  const pnId = await createAgent("doc-pinnew", pnCwd);
  await sleep(1500);
  sendLine(seedId, "claude");
  sendLine(exhId, "claude");
  sendLine(bcId, "claude");
  sendLine(nfId, "claude");
  sendLine(pmId, "claude");
  sendLine(pnId, "claude");
  await sleep(6000);
  ok(paneCmd(nfId) === "claude", `nofile pane is claude (${paneCmd(nfId)})`);
  ok(paneCmd(pmId) === "claude", `pinmiss pane is claude (${paneCmd(pmId)})`);
  ok(paneCmd(pnId) === "claude", `pinnew pane is claude (${paneCmd(pnId)})`);
  ok(paneCmd(seedId) === "claude", `seed pane is claude (${paneCmd(seedId)})`);
  ok(paneCmd(exhId) === "claude", `exhausted pane is claude (${paneCmd(exhId)})`);
  ok(paneCmd(bcId) === "claude", `badconf pane is claude (${paneCmd(bcId)})`);
  ok(paneCmd(btId) !== "claude", `badts pane is a bare shell, not claude (${paneCmd(btId)})`);

  await killServer();
  // Overwrite the on-disk runtimes with the inconsistent checkpoints. The panes
  // survive on the private tmux socket, so the reboot sees created=false (no
  // auto-resume overwrite). doc-seed has no transcript (its id is malformed, the
  // tracker's file check skips it); doc-exhausted/doc-badconf carry a seeded
  // transcript for their VALID id so the file check keeps it — the exclusive-cwd
  // scrape then finds that same id and the `rt.sessionId !== hit.sessionId`
  // guard leaves the seeded fields (attempts, corrupt confidence) untouched.
  const seedNow = new Date().toISOString();
  const seedDisk = onDisk(seedId);
  seedDisk.runtime = {
    ...(seedDisk.runtime || {}),
    desiredRuntime: "claude",
    observedRuntime: "claude",
    cleanExitAt: null,
    sessionId: "not-a-uuid",        // present but malformed → decideResume refuses
    confidence: "correlated",
    lastObservedAt: seedNow,
    lastPersistedAt: seedNow,
  };
  writeFileSync(join(WS, ".hadron", "agents", `${seedId}.json`), JSON.stringify(seedDisk, null, 2));

  const exhSid = randomUUID();     // a VALID id — the only defect is exhausted attempts
  const exhDisk = onDisk(exhId);
  exhDisk.runtime = {
    ...(exhDisk.runtime || {}),
    desiredRuntime: "claude",
    observedRuntime: "claude",
    cleanExitAt: null,
    sessionId: exhSid,
    confidence: "correlated",
    lastObservedAt: seedNow,
    lastPersistedAt: seedNow,
    // resumed on the 3rd try THIS boot and is live (state "ready" → the health
    // classifier passes it; only the reboot cross-check catches it).
    restoreAttempt: { generation: "boot-doctor", attempts: 3, state: "ready", at: seedNow },
  };
  writeFileSync(join(WS, ".hadron", "agents", `${exhId}.json`), JSON.stringify(exhDisk, null, 2));
  seedTranscript(exhCwd, exhSid); // the id is real: only the attempts are the defect

  const bcSid = randomUUID();
  const badConfToken = `leaked-secret-${randomUUID()}`; // a corrupt confidence value doctor must never echo
  const bcDisk = onDisk(bcId);
  bcDisk.runtime = {
    ...(bcDisk.runtime || {}),
    desiredRuntime: "claude",
    observedRuntime: "claude",
    cleanExitAt: null,
    sessionId: bcSid,
    confidence: badConfToken,       // present but not an allowlisted value
    lastObservedAt: seedNow,
    lastPersistedAt: seedNow,
  };
  writeFileSync(join(WS, ".hadron", "agents", `${bcId}.json`), JSON.stringify(bcDisk, null, 2));
  seedTranscript(bcCwd, bcSid); // the id is real: only the confidence is the defect

  const nfSid = randomUUID(); // valid, correlated, and NO transcript under nfCwd
  const nfDisk = onDisk(nfId);
  nfDisk.runtime = {
    ...(nfDisk.runtime || {}),
    desiredRuntime: "claude",
    observedRuntime: "claude",
    cleanExitAt: null,
    sessionId: nfSid,
    confidence: "correlated",
    lastObservedAt: seedNow,
    lastPersistedAt: seedNow,
  };
  writeFileSync(join(WS, ".hadron", "agents", `${nfId}.json`), JSON.stringify(nfDisk, null, 2));

  const pmSid = randomUUID(); // valid, MANUAL (pinned), transcript SEEN before and NO transcript under pmCwd now
  const pmDisk = onDisk(pmId);
  pmDisk.runtime = { ...(pmDisk.runtime || {}), desiredRuntime: "claude", observedRuntime: "claude", cleanExitAt: null, sessionId: pmSid, confidence: "manual", transcriptSeen: true, lastObservedAt: seedNow, lastPersistedAt: seedNow };
  writeFileSync(join(WS, ".hadron", "agents", `${pmId}.json`), JSON.stringify(pmDisk, null, 2));
  const pnSid = randomUUID(); // valid, MANUAL, transcript never seen (first turn not written)
  const pnDisk = onDisk(pnId);
  pnDisk.runtime = { ...(pnDisk.runtime || {}), desiredRuntime: "claude", observedRuntime: "claude", cleanExitAt: null, sessionId: pnSid, confidence: "manual", lastObservedAt: seedNow, lastPersistedAt: seedNow };
  writeFileSync(join(WS, ".hadron", "agents", `${pnId}.json`), JSON.stringify(pnDisk, null, 2));

  // Untrusted timestamp fields on a shell pane (tracker won't heal them). Two
  // non-parseable tokens + one materially-future value; doctor must emit all
  // three as null and never leak the raw strings.
  const btCleanTok = `badts-clean-${randomUUID()}`;
  const btObservedTok = `badts-observed-${randomUUID()}`;
  const btFutureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // +1 day
  const btDisk = onDisk(btId);
  btDisk.runtime = {
    ...(btDisk.runtime || {}),
    desiredRuntime: "claude",       // a claude agent whose pane is now a bare shell
    cleanExitAt: btCleanTok,        // token, not a timestamp → must not read as "exited cleanly"
    lastObservedAt: btObservedTok,  // token → emitted null, never echoed
    lastPersistedAt: btFutureIso,   // materially future → rejected, emitted null
  };
  writeFileSync(join(WS, ".hadron", "agents", `${btId}.json`), JSON.stringify(btDisk, null, 2));

  // Second boot claims launchd provenance (XPC_SERVICE_NAME is what launchd
  // sets) — Report 3: doctor only ever accepted systemd, so a launchd-managed
  // Mac fleet could never go green.
  bootServer({ XPC_SERVICE_NAME: "com.example.hadron" });
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  // Before the tracker settles (3 one-second polls; this fetch follows the
  // health probe immediately), the doctor's own file check must already refuse
  // to call the missing-transcript checkpoint green — strictly its message, so
  // the classifier branch cannot be deleted behind the tracker's later drop.
  const docEarly = await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json();
  const nfEarly = docEarly.agents.find((a) => a.name === "doc-nofile")?.finding || {};
  ok(nfEarly.level === "red" && /checkpoint transcript missing/.test(nfEarly.message),
    `missing-transcript checkpoint is never green, even before the tracker settles (${nfEarly.level}: ${nfEarly.message})`);
  await sleep(6000); // let the tracker re-settle on the still-live panes (seeded transcripts → keeps those seeds)
  const nfRow = (await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json()).agents.find((a) => a.name === "doc-nofile") || {};
  ok(nfRow.finding?.level === "red" && /no session id \(.*scrape found nothing/.test(nfRow.finding?.message) && nfRow.hasCheckpointId === false,
    `after settle the tracker dropped the stale id: red "no session id", hasCheckpointId=false (${nfRow.finding?.level}: ${nfRow.finding?.message})`);
  ok(onDisk(nfId).runtime.sessionId === null, "…and the on-disk checkpoint no longer carries the dead id");
  const pmEarly = docEarly.agents.find((a) => a.name === "doc-pinmiss")?.finding || {};
  ok(pmEarly.level === "red" && /checkpoint transcript missing/.test(pmEarly.message) && /manual id is kept \(its transcript existed before\)/.test(pmEarly.message),
    `pinned (manual) id whose transcript was seen and is gone → red, identity kept, not resumable (${pmEarly.level}: ${pmEarly.message})`);
  const pnEarly = docEarly.agents.find((a) => a.name === "doc-pinnew")?.finding || {};
  ok(pnEarly.level === "yellow" && /identity known \(manual\), not resumable yet/.test(pnEarly.message) && !pnEarly.message.includes(pnSid),
    `pinned id whose transcript was never seen → yellow "not written yet", no id in the text (${pnEarly.level}: ${pnEarly.message})`);
  const pmRow = (await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json()).agents.find((a) => a.name === "doc-pinmiss") || {};
  ok(pmRow.finding?.level === "red" && /checkpoint transcript missing/.test(pmRow.finding?.message) && pmRow.hasCheckpointId === true && pmRow.confidence === "manual",
    `after settle the pinned id is still there and still red (${pmRow.finding?.level}: hasCheckpointId=${pmRow.hasCheckpointId}, ${pmRow.confidence})`);
  ok(onDisk(pmId).runtime.sessionId === pmSid && onDisk(pmId).runtime.confidence === "manual", "…on disk: manual id never dropped for a missing file");
  const pnRow = (await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json()).agents.find((a) => a.name === "doc-pinnew") || {};
  ok(pnRow.finding?.level === "yellow" && pnRow.hasCheckpointId === true && onDisk(pnId).runtime.sessionId === pnSid && onDisk(pnId).runtime.transcriptSeen === undefined,
    `after settle the never-seen pinned id is still yellow and still on disk (${pnRow.finding?.level})`);
  // now the transcript appears (first turn written) → green, and the tracker's next check will record transcriptSeen
  seedTranscript(pnCwd, pnSid);
  const pnGreen = (await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json()).agents.find((a) => a.name === "doc-pinnew") || {};
  ok(pnGreen.finding?.level === "green" && /resumes as manual/.test(pnGreen.finding?.message), `…and green the moment the transcript exists (${pnGreen.finding?.level}: ${pnGreen.finding?.message})`);
  const regReboot = (await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json()).agents.find((a) => a.name === "doc-registry") || {};
  ok(regReboot.finding?.level === "green" && /resumes as registry/.test(regReboot.finding?.message) && regReboot.registry === "matched",
    `registry id survives a server restart and re-matches (${regReboot.finding?.level}: ${regReboot.finding?.message})`);

  const doc2 = await (await fetch(`${BASE}/api/doctor`, { headers: { "x-hadron-token": TOKEN } })).json();
  const seedFinding = doc2.agents.find((a) => a.name === "doc-seed")?.finding || {};
  ok(seedFinding.level === "red" && /would not resume — malformed session id/.test(seedFinding.message),
    `seeded malformed checkpoint → red "would not resume — malformed session id" (${seedFinding.level}: ${seedFinding.message})`);
  const exhFinding = doc2.agents.find((a) => a.name === "doc-exhausted")?.finding || {};
  ok(exhFinding.level === "red" && /would not resume — attempts exhausted/.test(exhFinding.message),
    `exhausted-attempts checkpoint → red "would not resume — attempts exhausted" (${exhFinding.level}: ${exhFinding.message})`);
  const bcRow = doc2.agents.find((a) => a.name === "doc-badconf") || {};
  const bcFinding = bcRow.finding || {};
  ok(bcFinding.level === "red" && /would not resume — confidence invalid below policy/.test(bcFinding.message),
    `corrupt-confidence checkpoint → red with SANITIZED reason (${bcFinding.level}: ${bcFinding.message})`);
  ok(bcRow.confidence === "invalid", `corrupt confidence is emitted as "invalid", not the raw token (${bcRow.confidence})`);
  const seedRaw = JSON.stringify(doc2);
  ok(!/sessionId/.test(seedRaw) && !seedRaw.includes("not-a-uuid") && !seedRaw.includes(exhSid) && !seedRaw.includes(bcSid) && !seedRaw.includes(nfSid) && !seedRaw.includes(pmSid) && !seedRaw.includes(regSid),
    "reboot doctor response still leaks no session id (key or value, malformed or valid)");
  ok(!seedRaw.includes(badConfToken) && !seedRaw.includes("leaked-secret"),
    "reboot doctor response never echoes the corrupt confidence token");

  // doc-badts: token + future timestamp fields must be normalized, never echoed.
  const btRow = doc2.agents.find((a) => a.name === "doc-badts") || {};
  ok(btRow.cleanExitAt === null && btRow.lastObservedAt === null && btRow.lastPersistedAt === null,
    `corrupt/future timestamp fields all emit null (clean=${btRow.cleanExitAt}, observed=${btRow.lastObservedAt}, persisted=${btRow.lastPersistedAt})`);
  const btFinding = btRow.finding || {};
  ok(btFinding.level === "yellow" && /claude gone/.test(btFinding.message),
    `token cleanExitAt is not trusted as a clean exit → yellow "claude gone" (${btFinding.level}: ${btFinding.message})`);
  ok(!seedRaw.includes(btCleanTok) && !seedRaw.includes(btObservedTok) && !seedRaw.includes(btFutureIso) && !seedRaw.includes("badts-"),
    "reboot doctor response never echoes any raw timestamp token or the future ISO value");

  const cli2 = runCli(["doctor"]);
  ok(cli2.code === 1, `hadron doctor exits 1 with the demoted-green red rows (exit ${cli2.code})`);
  ok(/server is managed by launchd \(boot-restarts\)/.test(cli2.stdout) && !/will NOT restart after a reboot/.test(cli2.stdout),
    "launchd-managed server is green in hadron doctor (not only systemd)");
  const shAReboot = doc2.agents.find((a) => a.name === "doc-shared-a")?.finding || {};
  ok(shAReboot.level === "green" && /resumes as manual/.test(shAReboot.message), `manual adoption survives a server restart (${shAReboot.level}: ${shAReboot.message})`);
  ok(/would not resume — malformed session id/.test(cli2.stdout), "CLI shows the malformed-id demoted-green red row");
  ok(/would not resume — attempts exhausted/.test(cli2.stdout), "CLI shows the exhausted-attempts demoted-green red row");
  ok(/would not resume — confidence invalid below policy/.test(cli2.stdout), "CLI shows the corrupt-confidence red row with a sanitized reason");
  ok(!cli2.stdout.includes(badConfToken) && !cli2.stdout.includes("leaked-secret"), "CLI never echoes the corrupt confidence token");
  const cli2Json = runCli(["doctor", "--json"]);
  ok(cli2Json.code === 1 && !/sessionId/.test(cli2Json.stdout) && !cli2Json.stdout.includes(exhSid) && !cli2Json.stdout.includes(bcSid),
    "hadron doctor --json exits 1 for the demoted-green rows and leaks no sessionId");
  ok(!cli2Json.stdout.includes(badConfToken) && !cli2Json.stdout.includes("leaked-secret"), "hadron doctor --json never echoes the corrupt confidence token");
  ok(!cli2.stdout.includes("badts-") && !cli2.stdout.includes(btFutureIso), "CLI never echoes a raw timestamp token or the future ISO value");
  ok(!cli2Json.stdout.includes("badts-") && !cli2Json.stdout.includes(btFutureIso), "hadron doctor --json never echoes a raw timestamp token or the future ISO value");

  // ── CLI: server down ────────────────────────────────────────────────────
  console.log("\nCLI with the server down");
  await killServer();
  try { execFileSync("tmux", ["-S", SOCK, "kill-server"], { stdio: "ignore", env: tenv }); } catch {}
  const down = runCli(["doctor"], { withServer: false });
  ok(down.code === 1, `hadron doctor exits 1 when the server is down (exit ${down.code})`);
  const firstLine = (down.stdout.split("\n").find((l) => /server unreachable/.test(l)) || "");
  ok(/server unreachable/.test(down.stdout), "CLI reports 'server unreachable' when the server is down");
  ok(down.stdout.indexOf("server unreachable") < down.stdout.indexOf("Agents ("), "'server unreachable' appears before any agent section");
}

main().catch((e) => { failed++; console.error(`  ✗ ${e.stack || e}`); }).finally(async () => {
  await killServer();
  try { execFileSync("tmux", ["-S", SOCK, "kill-server"], { stdio: "ignore", env: tenv }); } catch {}
  await sleep(500);
  rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
