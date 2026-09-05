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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "fs";
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
for (const d of [HOME, FIX, WS, join(WS, "shell"), join(WS, "green"), join(WS, "shared"), join(WS, "untracked"), join(WS, "seed"), join(WS, "exhausted"), join(WS, "badconf"), join(WS, "badts")]) mkdirSync(d, { recursive: true });
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
function bootServer() {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash",
    PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: "doctor",
    // The one agent named claude.exe must be UNrecognised so it reproduces the
    // "looks like claude but the tracker never tracked it" class. Agents named
    // plain `claude` stay recognised.
    HADRON_TEST_UNRECOGNIZE_CLAUDE_CMD: "claude.exe",
    INVOCATION_ID: "", XPC_SERVICE_NAME: "",
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

  await sleep(1500);
  sendLine(greenId, "claude");
  sendLine(shA, "claude");
  sendLine(shB, "claude");
  sendLine(untrackedId, "claude.exe");
  // green must reach a scraped sessionId; the others just need to settle (~3 polls)
  await waitDisk(greenId, (a) => a.runtime?.sessionId, 12000);
  await sleep(6000);

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

  // PATH column: fresh-shell PATH resolves `claude` to the fixture
  ok(byName["doc-green"].pathResolvesClaudeTo === join(FIX, "claude"), `green pathResolvesClaudeTo = fixture claude (${byName["doc-green"].pathResolvesClaudeTo})`);

  // caps probe present and re-mapped (no "sessionId" key)
  ok(doc.claudeCaps && typeof doc.claudeCaps.supportsSessionId === "boolean", "response includes a server-side claude caps probe (supportsSessionId)");

  // ── CLI: exit 1 when reds exist ─────────────────────────────────────────
  console.log("\nCLI hadron doctor");
  const cli = runCli(["doctor"]);
  ok(cli.code === 1, `hadron doctor exits 1 when red rows exist (exit ${cli.code})`);
  ok(/no session id \(shared cwd/.test(cli.stdout), "CLI output shows the shared-cwd red row");
  ok(/untracked/.test(cli.stdout), "CLI output shows the untracked red row");
  ok(/resumes as correlated/.test(cli.stdout), "CLI output shows the green row");
  ok(/will NOT restart after a reboot/.test(cli.stdout), "CLI flags the hand-started server as red (won't survive reboot)");
  ok(/tmux session PATH resolves claude to/.test(cli.stdout), "CLI prints the PATH-resolves-claude column for claude panes");
  const cliJson = runCli(["doctor", "--json"]);
  ok(cliJson.code === 1 && !/sessionId/.test(cliJson.stdout), "hadron doctor --json also exits 1 and leaks no sessionId");

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
  await sleep(1500);
  sendLine(seedId, "claude");
  sendLine(exhId, "claude");
  sendLine(bcId, "claude");
  await sleep(6000);
  ok(paneCmd(seedId) === "claude", `seed pane is claude (${paneCmd(seedId)})`);
  ok(paneCmd(exhId) === "claude", `exhausted pane is claude (${paneCmd(exhId)})`);
  ok(paneCmd(bcId) === "claude", `badconf pane is claude (${paneCmd(bcId)})`);
  ok(paneCmd(btId) !== "claude", `badts pane is a bare shell, not claude (${paneCmd(btId)})`);

  await killServer();
  // Overwrite the on-disk runtimes with the inconsistent checkpoints. The panes
  // survive on the private tmux socket, so the reboot sees created=false (no
  // auto-resume overwrite) and — no transcript in either cwd — the settling
  // tracker cannot scrape a real id over the seeds.
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

  bootServer();
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  await sleep(6000); // let the tracker re-settle on the still-live panes (no transcript → keeps the seeds)

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
  ok(!/sessionId/.test(seedRaw) && !seedRaw.includes("not-a-uuid") && !seedRaw.includes(exhSid) && !seedRaw.includes(bcSid),
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
