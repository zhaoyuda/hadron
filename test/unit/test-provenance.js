/**
 * Provenance: /api/health says WHAT is running (version, commit, dirty,
 * repoRoot, startedAt, pid, node, platform, managedBy) and `hadron version`
 * compares it with the working tree. Motivated by a week where prod ran a
 * commit nobody could name and every "is it deployed?" answer was a guess.
 *
 * Boots servers from a throwaway git copy of this repo so commit/dirty can be
 * asserted against a HEAD the test controls.
 *
 * Run: node test/unit/test-provenance.js
 */
import { spawn, execFileSync } from "child_process";
import { createServer as createNetServer } from "net";
import { createServer as createHttpServer } from "http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const PORT = 6500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const TMP = mkdtempSync(join(tmpdir(), "hadron-prov-"));
const COPY = join(TMP, "repo");
const WS = join(TMP, "ws");
mkdirSync(WS);

// Throwaway copy: the working tree as it is now (uncommitted changes included),
// committed into its own fresh git history → a HEAD this test owns.
execFileSync("bash", ["-c", `mkdir -p "${COPY}" && tar -C "${REPO}" --exclude=.git --exclude=node_modules --exclude=test/e2e/screenshots -cf - . | tar -C "${COPY}" -xf -`]);
symlinkSync(join(REPO, "node_modules"), join(COPY, "node_modules"));
const git = (...args) => execFileSync("git", ["-C", COPY, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git("init", "-q");
git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "snapshot");
const COPY_HEAD = git("rev-parse", "HEAD");

let server = null;
async function boot(root, env = {}) {
  server = spawn("node", [join(root, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", INVOCATION_ID: "", XPC_SERVICE_NAME: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}
function stop() { if (server) { server.kill("SIGKILL"); server = null; } }
const health = async () => (await (await fetch(`${BASE}/api/health`)).json());

function hadron(args, env = {}) {
  try {
    const out = execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HADRON_PORT: String(PORT), TMUX: "", ...env },
    });
    return { status: 0, out, err: "" };
  } catch (e) { return { status: e.status, out: String(e.stdout || ""), err: String(e.stderr || "") }; }
}

function killTmux() {
  const ws = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter((n) => n.includes(`hadron-${ws}`));
    for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
  } catch {}
}

async function main() {
  console.log("[health provenance from a clean tree]");
  await boot(COPY);
  {
    const h = await health();
    ok(h.ok === true && typeof h.livePtys === "number", "legacy fields still present");
    ok(h.commit === COPY_HEAD, `commit equals git rev-parse HEAD of the repo the server runs from (${COPY_HEAD.slice(0, 7)})`);
    ok(h.dirty === false, "dirty=false right after commit");
    ok(h.version === JSON.parse(readFileSync(join(COPY, "package.json"), "utf-8")).version, "version from package.json");
    ok(h.repoRoot === COPY, "repoRoot is the tree the server was started from");
    ok(h.pid === server.pid && h.node === process.version && h.platform === process.platform, "pid / node / platform describe the server process");
    ok(Number.isFinite(Date.parse(h.startedAt)) && Date.now() - Date.parse(h.startedAt) < 60_000, "startedAt is a fresh ISO timestamp");
    ok(h.managedBy === null, "managedBy=null when hand-started (no INVOCATION_ID / XPC_SERVICE_NAME)");
    const r = await fetch(`${BASE}/api/health`, { headers: { "x-hadron-token": "wrong" } });
    ok(r.status === 200, "health stays unauthenticated (nothing secret in it)");
  }

  console.log("\n[hadron version: server matches the tree it was started from]");
  {
    // The CLI in COPY compares its own tree (HEAD, clean) with the server (same).
    const r = execFileSync("node", [join(COPY, "bin", "hadron.js"), "version", "--json"], { encoding: "utf-8", env: { ...process.env, HADRON_PORT: String(PORT), TMUX: "" } });
    const j = JSON.parse(r);
    ok(j.cli.commit === COPY_HEAD && j.server.commit === COPY_HEAD && j.problems.length === 0, "version --json: cli and server on the same commit, no problems, exit 0");
    const txt = execFileSync("node", [join(COPY, "bin", "hadron.js"), "version"], { encoding: "utf-8", env: { ...process.env, HADRON_PORT: String(PORT), TMUX: "" } });
    ok(/^hadron \d/.test(txt) && txt.includes(`cli:    ${COPY_HEAD.slice(0, 7)} (clean)`) && txt.includes(`server: ${COPY_HEAD.slice(0, 7)} (clean)`) && txt.includes("hand-started"), "human output names both commits and hand-started");
  }
  stop();

  console.log("\n[dirty tree + managedBy + stale-server mismatch]");
  appendFileSync(join(COPY, "server", "index.js"), "\n// local edit\n");
  await boot(COPY, { INVOCATION_ID: "abc123", HADRON_TEST_COMMIT: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  {
    const h = await health();
    ok(h.dirty === true, "dirty=true after editing a tracked file (captured at boot)");
    ok(h.managedBy === "systemd", "managedBy=systemd when INVOCATION_ID is set");
    ok(h.commit === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "HADRON_TEST_COMMIT overrides the reported commit (test hook)");
  }
  {
    let res;
    try { execFileSync("node", [join(COPY, "bin", "hadron.js"), "version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HADRON_PORT: String(PORT), TMUX: "" } }); res = { status: 0 }; }
    catch (e) { res = { status: e.status, out: String(e.stdout), err: String(e.stderr) }; }
    ok(res.status === 1, "mismatch → exit 1");
    ok(/server is running deadbee \(started \d+m ago\), working tree is [0-9a-f]{7} — restart it/.test(res.err || ""), "…and says which commit runs, which is checked out, and to restart");
    ok(/dirty tree/.test(res.err || ""), "…and flags that the server started from a dirty tree");
    ok((res.out || "").includes("systemd"), "human output shows managedBy");
  }
  {
    git("checkout", "--", "server/index.js"); // tree is clean again…
    ok(git("status", "--porcelain") === "", "(tree reverted to clean)");
    ok((await health()).dirty === true, "…but health still says dirty: provenance describes the tree the process STARTED from");
  }
  stop();

  console.log("\n[launchd detection + unreachable server]");
  await boot(COPY, { XPC_SERVICE_NAME: "com.example.hadron" });
  ok((await health()).managedBy === "launchd", "managedBy=launchd when XPC_SERVICE_NAME is set and not \"0\"");
  stop();
  await boot(COPY, { XPC_SERVICE_NAME: "0" });
  ok((await health()).managedBy === null, "XPC_SERVICE_NAME=0 (interactive shell) is not launchd");
  stop();
  // Async: the fake servers below run in THIS process, so the CLI must not be
  // awaited with execFileSync (it would block the event loop they answer on).
  const gateJson = (env = {}) => new Promise((resolve) => {
    const c = spawn("node", [join(REPO, "bin", "hadron.js"), "version", "--json"], { env: { ...process.env, HADRON_PORT: String(PORT), TMUX: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("close", (status) => { let j = null; try { j = JSON.parse(out); } catch {} resolve({ status, out, err, j }); });
  });
  const hadronAsync = (args, env = {}) => new Promise((resolve) => {
    const c = spawn("node", [join(REPO, "bin", "hadron.js"), ...args], { env: { ...process.env, HADRON_PORT: String(PORT), TMUX: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("close", (status) => resolve({ status, out, err }));
  });
  {
    const r = await gateJson();
    ok(r.status === 1 && r.j && r.j.status === "unreachable" && r.j.server === null, "unreachable → status unreachable, exit 1 (no comparison happened, so the gate fails)");
    ok(r.j.problems.some((p) => /not verified — unreachable/.test(p)) && !r.j.problems.some((p) => /restart it/.test(p)), "…problem says unverified, makes no stale claim");
  }

  console.log("\n[the gate refuses to pass without a real comparison]");
  {
    // stalled: accepts the TCP connection, never answers
    const stall = createNetServer((sock) => { sock.on("error", () => {}); });
    await new Promise((r) => stall.listen(PORT, "127.0.0.1", r));
    const t0 = Date.now();
    const r = await gateJson();
    stall.close();
    ok(r.status === 1 && r.j && r.j.status === "timeout", `stalled server → status timeout, exit 1 (${Math.round((Date.now() - t0) / 1000)}s, bounded)`);
    ok(Date.now() - t0 < 15_000, "…and it gave up within the 5s budget rather than hanging");
  }
  const fakeHttp = async (handler, fn) => {
    const srv = createHttpServer(handler);
    await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
    try { return await fn(); } finally { await new Promise((r) => srv.close(r)); }
  };
  await fakeHttp((req, res) => { res.statusCode = 503; res.end("nope"); }, async () => {
    const r = await gateJson();
    ok(r.status === 1 && r.j.status === "error" && /HTTP 503/.test(r.j.problems[0]), "HTTP 503 → status error, exit 1");
  });
  await fakeHttp((req, res) => { res.setHeader("content-type", "application/json"); res.end("{not json"); }, async () => {
    const r = await gateJson();
    ok(r.status === 1 && r.j.status === "malformed", "non-JSON body → status malformed, exit 1");
  });
  await fakeHttp((req, res) => { res.end(JSON.stringify({ hello: "world" })); }, async () => {
    const r = await gateJson();
    ok(r.status === 1 && r.j.status === "malformed" && r.j.server === null, "JSON that is not a Hadron health response → malformed, exit 1");
  });
  await fakeHttp((req, res) => { res.end(JSON.stringify({ ok: true, livePtys: 0 })); }, async () => {
    const r = await gateJson();
    ok(r.status === 1 && r.j.status === "no-provenance" && /restart it/.test(r.j.problems[0]), "pre-provenance health shape (older server) → no-provenance, exit 1, says restart");
    const h = await hadronAsync(["version"]);
    ok(h.status === 1 && /server: no-provenance on :\d+/.test(h.out), "human output labels the older server");
  });

  console.log("\n[no git metadata: package versions are compared instead]");
  {
    // Hide git from both sides: commit/dirty become null, versions decide.
    const NOGIT = join(TMP, "nogit-bin");
    mkdirSync(NOGIT);
    for (const b of ["node", "tmux", "sh", "bash"]) { try { symlinkSync(execFileSync("which", [b], { encoding: "utf-8" }).trim(), join(NOGIT, b)); } catch {} }
    const noGitEnv = { PATH: NOGIT };
    const pkgPath = join(COPY, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: pkg.version + "-other" }));
    await boot(COPY, noGitEnv);
    {
      const h = await health();
      ok(h.commit === null && h.dirty === null && h.version === pkg.version + "-other", "server without git on PATH → commit/dirty null, version still reported");
      const r = await gateJson(noGitEnv); // CLI from REPO: same version as the copy had before the bump
      ok(r.status === 1 && r.j.status === "ok" && r.j.cli.commit === null && r.j.problems.some((p) => /no git metadata to compare commits; server version .*-other .* ≠ working tree .* — restart it/.test(p)), "commits unavailable on both sides + versions differ → exit 1, names both versions");
    }
    stop();
    writeFileSync(pkgPath, JSON.stringify(pkg));
    await boot(COPY, noGitEnv);
    {
      const r = await gateJson(noGitEnv);
      ok(r.j.status === "ok" && r.j.problems.some((p) => /^no git metadata on either side — only package versions compared/.test(p)), "versions equal, no commits → informational note that only versions were compared");
      ok(r.status === (r.j.cli.dirty ? 1 : 0) && r.status === 0, "…and that note alone does not fail the gate (exit 0)");
    }
    stop();
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => { stop(); killTmux(); rmSync(TMP, { recursive: true, force: true }); process.exit(failed ? 1 : 0); });
