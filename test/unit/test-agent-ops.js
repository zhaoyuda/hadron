/**
 * Integration tests for agent ops (design-notes/agent-ops-spec.md):
 *   - `pinned` field: PATCH persists to disk, strict-boolean 400s, absent-unless-true
 *     round-trip, survives archive→restore
 *   - archive lifecycle over HTTP: DELETE defaults to soft archive (JSON kept,
 *     archived:true) vs ?force=true unlink; GET /api/sessions/archived contract;
 *     POST /restore brings the agent back into the live map
 *   - CLI verbs: pin/unpin/close/restore/ls --archived + name→id resolution
 *     (exact id, case-insensitive name, ambiguous → exit 1 with candidates)
 *
 * Self-contained: boots its own Hadron server on a throwaway workspace + port.
 *
 * Run: node test/unit/test-agent-ops.js
 * Requires: tmux on PATH.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
// Random high port — never 3000 (production), never the other suites' fixed ports.
const PORT = 5600 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-opstest-"));
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
let server, TOKEN;

const req = (method, p, body) => fetch(`${BASE}${p}`, {
  method,
  headers: { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": BASE },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function createAgent(name) {
  const r = await req("POST", "/api/sessions", { name, launchCommand: "shell" });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  return (await r.json()).id;
}

const agentFile = (id) => join(WS, ".hadron", "agents", `${id}.json`);
const readAgentFile = (id) => JSON.parse(readFileSync(agentFile(id), "utf-8"));
const liveList = async () => (await (await fetch(`${BASE}/api/sessions`)).json());
const archivedList = async () => (await (await fetch(`${BASE}/api/sessions/archived`)).json());

function tmuxAlive(agentId) {
  try {
    execFileSync("tmux", ["has-session", "-t", `hadron-${WS_NAME}-${agentId}`], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

// runs OUTSIDE any hadron tmux session → no whoami, no message attribution
function hadron(args, opts = {}) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: String(PORT), HADRON_TOKEN: TOKEN, TMUX: "" },
    ...opts,
  });
}
function hadronFails(args) {
  try { hadron(args, { stdio: ["ignore", "pipe", "pipe"] }); return null; }
  catch (e) { return { status: e.status, stderr: String(e.stderr || "") }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/sessions`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}

function killTmux() {
  try {
    const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter((n) => n.includes(`hadron-${WS_NAME}`));
    for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
  } catch {}
}

async function main() {
  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  const A = await createAgent("Ops Alpha");   // pinned round-trip + archive/restore
  const B = await createAgent("Ops Beta");    // force delete
  const C = await createAgent("Ops Gamma");   // CLI verbs

  console.log("\n[PATCH pinned — strict boolean, absent-unless-true]");
  {
    const r = await req("PATCH", `/api/sessions/${A}`, { pinned: true });
    ok(r.status === 200 && (await r.json()).pinned === true, "PATCH {pinned:true} → 200 with pinned in response");
    ok(readAgentFile(A).pinned === true, "pinned:true persisted to disk");
    ok((await liveList()).find((s) => s.id === A)?.pinned === true, "GET /api/sessions carries pinned through");

    const rOff = await req("PATCH", `/api/sessions/${A}`, { pinned: false });
    ok(rOff.status === 200, "PATCH {pinned:false} → 200");
    ok(!("pinned" in readAgentFile(A)), "pinned:false round-trips to ABSENT on disk (like icon/sortOrder)");

    for (const bad of ["yes", 1, null, {}]) {
      const rBad = await req("PATCH", `/api/sessions/${A}`, { pinned: bad });
      ok(rBad.status === 400, `non-boolean pinned (${JSON.stringify(bad)}) → 400`);
    }
    ok(!("pinned" in readAgentFile(A)), "rejected PATCHes did not touch the stored agent");
  }

  console.log("\n[DELETE default = soft archive; ?force=true unlinks]");
  {
    await req("PATCH", `/api/sessions/${A}`, { pinned: true });
    const r = await req("DELETE", `/api/sessions/${A}`);
    ok(r.status === 200, "DELETE (no force) → 200");
    ok(existsSync(agentFile(A)), "agent JSON still on disk");
    const data = readAgentFile(A);
    ok(data.archived === true && typeof data.archivedAt === "string", "archived:true + archivedAt stamped");
    ok(data.pinned === true, "archive keeps the pinned field");
    ok(!tmuxAlive(A), "tmux session killed by archive");
    ok(!(await liveList()).some((s) => s.id === A), "archived agent gone from GET /api/sessions");

    const arch = await archivedList();
    const entry = arch.find((s) => s.id === A);
    ok(!!entry && typeof entry.archivedAt === "string", "GET /api/sessions/archived lists it with archivedAt");
    ok(!arch.some((s) => s.id === B), "archived list excludes live agents");

    const rForce = await req("DELETE", `/api/sessions/${B}?force=true`);
    ok(rForce.status === 200 && !existsSync(agentFile(B)), "DELETE ?force=true unlinks the JSON");
  }

  console.log("\n[restore — archived → live, pinned survives]");
  {
    const r = await req("POST", `/api/sessions/${A}/restore`);
    ok(r.status === 200, "POST /restore → 200");
    const live = (await liveList()).find((s) => s.id === A);
    ok(!!live && !live.archived, "restored agent reappears in GET /api/sessions un-archived");
    ok(live?.pinned === true, "pinned survived archive → restore");
    ok(!(await archivedList()).some((s) => s.id === A), "restored agent left the archived list");
    await req("PATCH", `/api/sessions/${A}`, { pinned: false });
  }

  console.log("\n[CLI: pin/unpin with name→id resolution]");
  {
    const out = hadron(["pin", "ops gamma"]); // case-insensitive exact name
    ok(/pinned Ops Gamma \(ops-gamma\)/.test(out), "hadron pin by name resolves + reports id");
    ok(readAgentFile(C).pinned === true, "CLI pin persisted");
    hadron(["unpin", C]); // bare id keeps working
    ok(!("pinned" in readAgentFile(C)), "hadron unpin by id persisted");

    const miss = hadronFails(["pin", "no-such-agent"]);
    ok(miss !== null && miss.status === 1, "unknown target → exit 1");
    ok(/no agent matches/.test(miss.stderr) && miss.stderr.includes("ops-gamma"), "error lists known candidates");
    ok(!/at .*\.js/.test(miss.stderr), "clean one-shot error, no stack trace");

    // Two live agents sharing a name → ambiguous, no partial matching.
    await req("PATCH", `/api/sessions/${A}`, { name: "Twin" });
    await req("PATCH", `/api/sessions/${C}`, { name: "Twin" });
    const amb = hadronFails(["pin", "twin"]);
    ok(amb !== null && amb.status === 1, "ambiguous name → exit 1");
    ok(amb.stderr.includes(A) && amb.stderr.includes(C), "ambiguity error lists both candidates");
    ok(!("pinned" in readAgentFile(A)) && !("pinned" in readAgentFile(C)), "nothing was pinned on ambiguity");
    await req("PATCH", `/api/sessions/${A}`, { name: "Ops Alpha" });
    await req("PATCH", `/api/sessions/${C}`, { name: "Ops Gamma" });
  }

  console.log("\n[CLI: close / ls --archived / restore]");
  {
    const out = hadron(["close", "Ops Gamma"]);
    ok(/archived Ops Gamma \(ops-gamma\)/.test(out), "hadron close reports the archive");
    ok(readAgentFile(C).archived === true && !tmuxAlive(C), "close = soft archive (JSON kept, tmux dead)");

    const ls = hadron(["ls", "--archived"]);
    ok(ls.includes("ops-gamma") && ls.includes("Ops Gamma") && /archived \d{4}-/.test(ls), "ls --archived: id, name, archivedAt");
    const lsJson = JSON.parse(hadron(["ls", "--archived", "--json"]));
    ok(Array.isArray(lsJson) && lsJson.some((a) => a.id === C), "ls --archived --json is the raw list");

    // restore resolves against the ARCHIVED list (the live list doesn't have it)
    const rst = hadron(["restore", "ops gamma"]);
    ok(/restored Ops Gamma \(ops-gamma\)/.test(rst), "hadron restore resolves the name from the archive");
    ok((await liveList()).some((s) => s.id === C), "restored agent is live again");

    const rstMiss = hadronFails(["restore", "ops gamma"]);
    ok(rstMiss !== null && /no archived agent matches/.test(rstMiss.stderr), "restore of a live agent → not found in archive");
  }

  console.log("\n[CLI: deletable:false surfaces the server error cleanly]");
  {
    await req("PATCH", `/api/sessions/${A}`, { deletable: false });
    const res = hadronFails(["close", "Ops Alpha"]);
    ok(res !== null && res.status === 1, "close of a protected agent → exit 1");
    ok(/non-deletable/.test(res.stderr) && !/at .*\.js/.test(res.stderr), "server error body surfaced, no stack trace");
    ok(!readAgentFile(A).archived, "protected agent was not archived");
  }

  console.log("\n[CLI: boolean flags before positionals don't swallow the target]");
  {
    const D = await createAgent("Ops Delta"); // fresh agent with a live tmux pane
    ok(tmuxAlive(D), "delta's tmux session is up (message precondition)");
    // Pre-BOOLEAN_FLAGS, --raw consumed "Ops Delta" as its value and the CLI
    // tried to resolve "hi there" as the target → exit 1.
    const out = hadron(["message", "--no-enter", "--raw", "Ops Delta", "hi there"]);
    ok(/delivered \d+ bytes \(no Enter\)/.test(out), "message --no-enter --raw <name> \"text\" delivers");
  }

  console.log("\n[custom launchers from config.json — names only through the API]");
  {
    // getLaunchers() re-reads config per spawn — no restart needed after editing.
    const cfgPath = join(WS, ".hadron", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.launchers = {
      "cc-echo": { argv: ["echo", "custom-launcher-ran"] },
      "bad name!": { argv: ["echo", "never"] },      // invalid name → ignored
      "no-argv": { kind: "claude" },                  // malformed → ignored
      "empty-argv": { argv: [] },                     // malformed → ignored
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const rBad = await req("POST", "/api/sessions", { name: "Ops Freeform", launchCommand: "echo hi" });
    ok(rBad.status === 400, "free-form command string still → 400");
    ok((await rBad.json()).error.includes("cc-echo"), "400 lists the config launcher as a valid name");
    const rIgn = await req("POST", "/api/sessions", { name: "Ops Ignored", launchCommand: "no-argv" });
    ok(rIgn.status === 400, "malformed launcher def is not registered");

    const rE = await req("POST", "/api/sessions", { name: "Ops Echo", launchCommand: "cc-echo", autostart: true });
    ok(rE.status === 201, "spawn with a config-defined launcher → 201");
    const E = (await rE.json()).id;
    let pane = "";
    for (let i = 0; i < 25 && !pane.includes("custom-launcher-ran"); i++) {
      await sleep(200);
      try { pane = execFileSync("tmux", ["capture-pane", "-p", "-t", `hadron-${WS_NAME}-${E}`], { encoding: "utf-8" }); } catch {}
    }
    ok(pane.includes("custom-launcher-ran"), "autostart typed the custom launcher argv into the pane");
    ok(readAgentFile(E).launchCommand === "cc-echo", "launcher name persisted on the agent");

    // argv boundary preservation: with a bare join(" ") the shell would parse
    // `echo one two;three` as two commands; quoted, the pane prints the literal.
    cfg.launchers["cc-spaced"] = { argv: ["echo", "one two;three"] };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const rS = await req("POST", "/api/sessions", { name: "Ops Spaced", launchCommand: "cc-spaced", autostart: true });
    ok(rS.status === 201, "spawn with a spaced/metachar argv element → 201");
    const S = (await rS.json()).id;
    let paneS = "";
    for (let i = 0; i < 25 && !/^one two;three$/m.test(paneS); i++) {
      await sleep(200);
      try { paneS = execFileSync("tmux", ["capture-pane", "-p", "-t", `hadron-${WS_NAME}-${S}`], { encoding: "utf-8" }); } catch {}
    }
    ok(/^one two;three$/m.test(paneS), "argv element with space + metachar survives as ONE argument (quoted through the shell)");
  }

  console.log("\n[auth: Authorization Bearer accepted as alias for x-hadron-token]");
  {
    // The header every hand-written client tries first (real-world 401 report,
    // 2026-08-10). Same token, same gate — just a second spelling.
    const bearerReq = (tok) => fetch(`${BASE}/api/sessions/${A}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tok}`, "Origin": BASE },
      body: JSON.stringify({ notes: "via bearer" }),
    });
    ok((await bearerReq(TOKEN)).status === 200, "Bearer <token> authenticates a mutating request");
    ok((await bearerReq("wrong-token")).status === 401, "Bearer with a bad token still 401s");
    ok((await bearerReq("")).status === 401, "empty Bearer still 401s");
  }

  console.log("\n[CLI: bulk close/restore — resolve-all-first, nothing on partial failure]");
  {
    const G = await createAgent("Bulk One");
    const H = await createAgent("Bulk Two");
    const failed = hadronFails(["close", "Bulk One", "definitely-missing"]);
    ok(failed !== null && failed.status === 1, "one unknown target in the batch → exit 1");
    ok(!readAgentFile(G).archived && !readAgentFile(H).archived, "NOTHING archived when resolution fails");

    const out = hadron(["close", "Bulk One", "bulk two", G]);
    ok(out.includes(`(${G})`) && out.includes(`(${H})`), "bulk close archives every target");
    ok((out.match(/archived /g) || []).length === 2, "duplicate target de-duped (2 archives, not 3)");
    ok(readAgentFile(G).archived === true && readAgentFile(H).archived === true, "both on disk as archived");

    const back = hadron(["restore", "Bulk One", "Bulk Two"]);
    ok((back.match(/restored /g) || []).length === 2, "bulk restore brings both back");
    ok((await liveList()).filter((s) => [G, H].includes(s.id)).length === 2, "both live again");
  }

  console.log("\n[CLI: kernels show/set — merge semantics + env validation]");
  {
    ok(hadron(["kernels", "show"]).includes("no kernels configured"), "empty config → 'no kernels configured'");
    const mkEnv = (name) => {
      const env = join(WS, name);
      mkdirSync(join(env, "bin"), { recursive: true });
      writeFileSync(join(env, "bin", "python3"), "");
      return env;
    };
    const env1 = mkEnv("venv1"), env2 = mkEnv("venv2");
    hadron(["kernels", "set", "--marimo", env1]);
    ok(JSON.parse(hadron(["kernels", "show", "--json"])).marimo === env1, "set --marimo persists");
    hadron(["kernels", "set", "--jupyter", env2]);
    const k = JSON.parse(hadron(["kernels", "show", "--json"]));
    ok(k.marimo === env1 && k.jupyter === env2, "setting jupyter KEEPS marimo (merge — PUT alone would drop it)");
    const bad = hadronFails(["kernels", "set", "--marimo", join(WS, "not-a-venv")]);
    ok(bad !== null && /bin\/python3/.test(bad.stderr), "path without bin/python3 rejected before any request");
    ok(JSON.parse(hadron(["kernels", "show", "--json"])).marimo === env1, "rejected set left config untouched");

    // PATCH is the atomic-merge primitive the CLI rides on: a partial body must
    // merge server-side (PUT would replace and drop marimo).
    const rP = await req("PATCH", "/api/kernels", { jupyter: env1 });
    const merged = await rP.json();
    ok(rP.status === 200 && merged.marimo === env1 && merged.jupyter === env1, "PATCH /api/kernels merges partial bodies atomically");
    const rPut = await req("PUT", "/api/kernels", { marimo: env1 });
    ok((await rPut.json()).jupyter === undefined, "PUT still replaces wholesale (back-compat contract intact)");
  }

  console.log("\n[/api/file cannot write .hadron internals (launcher-definition boundary)]");
  {
    // Without this jail, any authenticated API caller could define a launcher argv
    // by writing config.json through the editor endpoint — command execution.
    const cfgAbs = join(WS, ".hadron", "config.json");
    const before = readFileSync(cfgAbs, "utf-8");
    const r1 = await req("POST", "/api/file", { path: ".hadron/config.json", content: "{}" });
    ok(r1.status === 403, "relative .hadron/config.json write → 403");
    const r2 = await req("POST", "/api/file", { path: cfgAbs, content: "{}" });
    ok(r2.status === 403, "absolute .hadron path write → 403");
    symlinkSync(cfgAbs, join(WS, "innocent.json"));
    const r3 = await req("POST", "/api/file", { path: "innocent.json", content: "{}" });
    ok(r3.status === 403, "symlink detour into .hadron → 403 (canonical path check)");
    ok(readFileSync(cfgAbs, "utf-8") === before, "config.json untouched by the attempts");
    const agentJson = agentFile(A);
    const r4 = await req("POST", "/api/file", { path: agentJson, content: "{}" });
    ok(r4.status === 403, "agent JSON write → 403 too");
    writeFileSync(join(WS, "normal.txt"), "before");
    const r5 = await req("POST", "/api/file", { path: "normal.txt", content: "after" });
    ok(r5.status === 200 && readFileSync(join(WS, "normal.txt"), "utf-8") === "after", "ordinary workspace file still writable");
  }

  console.log("\n[server restart — pinned survives a full store reload]");
  {
    await req("PATCH", `/api/sessions/${A}`, { pinned: true });
    server.kill("SIGKILL");
    server = spawn("node", [join(REPO, "server", "index.js"), WS], {
      env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer();
    const live = (await liveList()).find((s) => s.id === A);
    ok(live?.pinned === true, "pinned survives server restart (fresh loadAgents)");
    ok(live?.state === "idle", "restart still resets state to idle (loader contract intact)");
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    if (server) try { server.kill("SIGKILL"); } catch {}
    killTmux();
    try { rmSync(WS, { recursive: true, force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  });
