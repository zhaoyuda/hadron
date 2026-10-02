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
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, mkdirSync, readdirSync, statSync, truncateSync, chmodSync } from "fs";
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
// The server registers itself under HADRON_HOME/servers (hadron ls --all): a
// private dir keeps this suite's records out of the user's ~/.hadron.
const HH = mkdtempSync(join(tmpdir(), "hadron-opshome-"));
process.env.HADRON_HOME = HH;
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
  const id = (await r.json()).id;
  // tmux 3.4 sizes a new detached session from the server's LATEST client (a tiny
  // hidden web terminal on the developer's tmux → 10x5 panes where readline
  // hard-wraps). Give this throwaway pane a real width for capture-pane.
  try { execFileSync("tmux", ["resize-window", "-t", `hadron-${WS_NAME}-${id}`, "-x", "120", "-y", "30"], { stdio: "ignore" }); } catch {}
  return id;
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

  console.log("\n[PATCH coreDismissed — array of path strings, replaced whole, absent-unless-non-empty]");
  {
    const r = await req("PATCH", `/api/sessions/${A}`, { coreDismissed: ["/tmp/a.js", "/tmp/a.js", "~/b.md"] });
    ok(r.status === 200, "PATCH {coreDismissed:[…]} → 200");
    ok(JSON.stringify((await (await req("GET", "/api/sessions")).json()).find((s) => s.id === A)?.coreDismissed) === JSON.stringify(["/tmp/a.js", "~/b.md"]), "the token-bearing list carries it, de-duplicated (the single-session response is the reduced form, like files)");
    ok(!("coreDismissed" in ((await liveList()).find((s) => s.id === A) || {})), "…the open GET does not (paths the transcript named)");
    ok(JSON.stringify(readAgentFile(A).coreDismissed) === JSON.stringify(["/tmp/a.js", "~/b.md"]), "coreDismissed persisted to disk");
    const r2 = await req("PATCH", `/api/sessions/${A}`, { coreDismissed: ["/tmp/c.py"] });
    ok(r2.status === 200 && JSON.stringify(readAgentFile(A).coreDismissed) === JSON.stringify(["/tmp/c.py"]), "a second PATCH replaces the list whole (the client sends the full list)");
    for (const bad of ["x", 1, null, {}, [1], [""], ["  "], [null], ["a\nb"], ["a\0b"], ["x".repeat(4097)], Array.from({ length: 201 }, (_, i) => `/p${i}`)]) {
      const rBad = await req("PATCH", `/api/sessions/${A}`, { coreDismissed: bad });
      ok(rBad.status === 400, `bad coreDismissed (${JSON.stringify(bad).slice(0, 40)}) → 400`);
    }
    ok(JSON.stringify(readAgentFile(A).coreDismissed) === JSON.stringify(["/tmp/c.py"]), "rejected PATCHes did not touch the stored list");
    const rClear = await req("PATCH", `/api/sessions/${A}`, { coreDismissed: [] });
    ok(rClear.status === 200 && !("coreDismissed" in readAgentFile(A)), "an empty array clears it — absent on disk");
  }

  console.log("\n[PATCH parked — strict boolean, absent-unless-true, tmux untouched]");
  {
    const r = await req("PATCH", `/api/sessions/${A}`, { parked: true });
    ok(r.status === 200 && (await r.json()).parked === true, "PATCH {parked:true} → 200 with parked in response");
    ok(readAgentFile(A).parked === true, "parked:true persisted to disk");
    ok(!readAgentFile(A).archived, "parking is not archiving (no archived flag)");
    ok(tmuxAlive(A), "parking leaves the tmux session running");
    ok((await liveList()).find((s) => s.id === A)?.parked === true, "GET /api/sessions carries parked through (still a live agent)");

    const rOff = await req("PATCH", `/api/sessions/${A}`, { parked: false });
    ok(rOff.status === 200 && !("parked" in readAgentFile(A)), "parked:false round-trips to ABSENT on disk");
    for (const bad of ["yes", 1, null, {}]) {
      const rBad = await req("PATCH", `/api/sessions/${A}`, { parked: bad });
      ok(rBad.status === 400, `non-boolean parked (${JSON.stringify(bad)}) → 400`);
    }
    ok(!("parked" in readAgentFile(A)), "rejected PATCHes did not touch the stored agent");
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
    // Report 3 (macOS fleet, 2026-09-07): the store used to fall back to
    // `hadron-<id>` (wrong prefix — the real name is hadron-<workspace>-<id>) so
    // every archived/restored JSON carried a tmux name that didn't exist.
    const disk = JSON.parse(readFileSync(agentFile(A), "utf-8"));
    ok(disk.tmuxSession === `hadron-${WS_NAME}-${A}`, `restored JSON carries the real tmux name hadron-<ws>-<id> (${disk.tmuxSession})`);
    ok(!/^hadron-[^-]/.test(disk.tmuxSession) || disk.tmuxSession.startsWith(`hadron-${WS_NAME}-`), "no fabricated hadron-<id> name on disk");
    await req("PATCH", `/api/sessions/${A}`, { pinned: false });
  }

  console.log("\n[CLI: pin/unpin with name→id resolution]");
  {
    const out = hadron(["pin", "ops gamma"]); // case-insensitive exact name
    ok(/pinned Ops Gamma \(ops-gamma\)/.test(out), "hadron pin by name resolves + reports id");
    ok(readAgentFile(C).pinned === true, "CLI pin persisted");
    hadron(["unpin", C]); // bare id keeps working
    ok(!("pinned" in readAgentFile(C)), "hadron unpin by id persisted");
    const parkOut = hadron(["park", "ops gamma"]);
    ok(/parked Ops Gamma \(ops-gamma\)/.test(parkOut) && /keep running/.test(parkOut), "hadron park by name resolves + says nothing is killed");
    ok(readAgentFile(C).parked === true && tmuxAlive(C), "CLI park persisted, tmux still alive");
    hadron(["unpark", C]);
    ok(!("parked" in readAgentFile(C)), "hadron unpark by id persisted");

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
    const out = hadron(["message", "--no-enter", "--raw", "--force", "Ops Delta", "hi there"]);
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
    try { execFileSync("tmux", ["resize-window", "-t", `hadron-${WS_NAME}-${E}`, "-x", "120", "-y", "30"], { stdio: "ignore" }); } catch {} // see createAgent
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
    try { execFileSync("tmux", ["resize-window", "-t", `hadron-${WS_NAME}-${S}`, "-x", "120", "-y", "30"], { stdio: "ignore" }); } catch {} // see createAgent
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

  console.log("\n[CLI: help renders (a stray backtick once turned the whole text into NaN)]");
  {
    for (const args of [["help"], ["--help"], []]) {
      const out = hadron(args);
      ok(out.includes("Commands:") && out.includes("hadron message") && !/^NaN/.test(out), `hadron ${args.join(" ") || "(no args)"} prints the help text`);
    }
  }

  console.log("\n[triage: attentionRev / ackRev — the mail model over PATCH]");
  {
    const get = async () => (await liveList()).find((s) => s.id === A);
    const before = await get();
    ok(!before.attentionRev && !before.ackRev, "fresh agent carries no attention revision");
    // Entering done raises attention; the detector path (_setState) does the
    // same for a real pane, the manual PATCH is the HTTP-testable twin.
    let r = await req("PATCH", `/api/sessions/${A}`, { state: "done" });
    ok(r.status === 200, "PATCH state=done → 200");
    let s = await get();
    ok(s.attentionRev === 1 && !s.ackRev && typeof s.attentionAt === "string",
      `entering done → attentionRev 1, ackRev unset, attentionAt stamped (${s.attentionRev}/${s.ackRev || 0})`);
    ok(s.state === "done", "state stays done — looking is not doing (no auto idle)");
    r = await req("PATCH", `/api/sessions/${A}`, { state: "done" });
    s = await get();
    ok(s.attentionRev === 1, "PATCHing the same state again does not bump attentionRev (entries, not ticks)");
    let disk = readAgentFile(A);
    ok(disk.attentionRev === 1 && disk.ackRev === undefined && typeof disk.attentionAt === "string",
      "attentionRev/attentionAt persisted, ackRev absent-unless-set");

    // Ack: clamp to attentionRev, monotonic, validated.
    for (const bad of [-1, 1.5, "1", null, true]) {
      r = await req("PATCH", `/api/sessions/${A}`, { ackRev: bad });
      ok(r.status === 400, `ackRev ${JSON.stringify(bad)} → 400`);
    }
    r = await req("PATCH", `/api/sessions/${A}`, { ackRev: 99 });
    s = await get();
    ok(r.status === 200 && s.ackRev === 1, `ackRev 99 clamps to attentionRev (ackRev ${s.ackRev})`);
    ok(readAgentFile(A).ackRev === 1, "ackRev persisted to disk");
    ok(typeof s.ackAt === "string" && Date.parse(s.ackAt) > Date.parse(s.attentionAt) - 1 && Date.now() - Date.parse(s.ackAt) < 10000,
      "the ack stamps ackAt (\"you last looked\" — the card's third timestamp)");
    ok(readAgentFile(A).ackAt === s.ackAt, "ackAt persisted alongside ackRev");
    r = await req("PATCH", `/api/sessions/${A}`, { ackRev: 0 });
    s = await get();
    ok(s.ackRev === 1, "ackRev never moves backwards (0 after 1 ignored)");
    ok(s.ackAt === readAgentFile(A).ackAt, "an ignored ack does not restamp ackAt");
    ok(s.state === "done", "ack leaves the detector state alone (still done)");

    // Blocked is a fresh entry → re-lights even though done was acked.
    await req("PATCH", `/api/sessions/${A}`, { state: "blocked", blockReason: "permission" });
    s = await get();
    ok(s.attentionRev === 2 && s.ackRev === 1, "done→blocked is a new entry: attentionRev 2 > ackRev 1 (needs me again)");
    // Working / idle never raise attention.
    await req("PATCH", `/api/sessions/${A}`, { state: "working" });
    await req("PATCH", `/api/sessions/${A}`, { state: "idle" });
    s = await get();
    ok(s.attentionRev === 2, "working/idle do not raise attention");
    // done → idle → done is two entries (the 'finished another round while I looked' case).
    await req("PATCH", `/api/sessions/${A}`, { ackRev: 2 });
    await req("PATCH", `/api/sessions/${A}`, { state: "done" });
    s = await get();
    ok(s.attentionRev === 3 && s.ackRev === 2, "a later round re-raises attention past the ack (3 > 2)");
    // state + ackRev in one PATCH: the ack names a revision, so a stale ack
    // cannot swallow the bump that the same request causes.
    await req("PATCH", `/api/sessions/${A}`, { state: "idle" });
    r = await req("PATCH", `/api/sessions/${A}`, { state: "blocked", ackRev: 3 });
    s = await get();
    ok(s.attentionRev === 4 && s.ackRev === 3, "PATCH {state:blocked, ackRev:3} → rev 4 raised, ack stays 3 (still needs me)");
    ok(readAgentFile(A).attentionState === "blocked", "the state that raised is persisted (attentionState) for the post-restart re-recognition rule");
    await req("PATCH", `/api/sessions/${A}`, { state: "idle" });
  }

  console.log("\n[hadron ls --all: every running server of this user, from ~/.hadron/servers]");
  {
    const recDir = join(HH, "servers");
    const recs = readdirSync(recDir).filter((n) => n.endsWith(".json"));
    ok(recs.length === 1, `the server registered one record under HADRON_HOME/servers (${recs.length})`);
    const rec = JSON.parse(readFileSync(join(recDir, recs[0]), "utf-8"));
    ok(rec.workspace === WS && String(rec.port) === String(PORT) && rec.pid === server.pid, `record names workspace, port and the server's pid (${JSON.stringify(rec)})`);
    // A crash leftover: a record whose pid is dead is skipped by the CLI (and
    // pruned by the next server boot — checked in the restart block below).
    writeFileSync(join(recDir, "deadbeef00000000.json"), JSON.stringify({ workspace: "/nowhere/stale", port: 1, pid: 2147483000, startedAt: 1 }));
    // No workspace context at all: --all finds the server through the record,
    // not through HADRON_PORT / the cwd's .hadron.
    const bare = { ...process.env, TMUX: "" }; delete bare.HADRON_PORT; delete bare.HADRON_TOKEN;
    const out = execFileSync("node", [join(REPO, "bin", "hadron.js"), "ls", "--all"], { encoding: "utf-8", env: bare, cwd: tmpdir() });
    ok(out.includes(`== ${WS}  :${PORT}  pid ${server.pid}`) && out.includes("Ops Alpha"), `text lists the workspace header and its agents:\n${out.split("\n").slice(0, 3).join("\n")}`);
    ok(!out.includes("/nowhere/stale"), "a record with a dead pid is not listed");
    const js = JSON.parse(execFileSync("node", [join(REPO, "bin", "hadron.js"), "ls", "--all", "--json"], { encoding: "utf-8", env: bare, cwd: tmpdir() }));
    const mine = js.find((r) => r.workspace === WS), stale = js.find((r) => r.workspace === "/nowhere/stale");
    ok(mine && mine.status === "ok" && Array.isArray(mine.agents) && mine.agents.some((a) => a.name === "Ops Alpha") && mine.pid === server.pid, "--json: status ok + the agents array for the live server");
    ok(stale && stale.status === "stale" && stale.agents === undefined, "--json still reports the dead record as stale (no agents)");
    ok(!JSON.stringify(js).includes(TOKEN), "the listing carries no token");
    ok(/--all/.test(hadron(["ls", "--help"])), "ls usage mentions --all");
  }

  console.log("\n[server restart — pinned/parked survive a full store reload]");
  {
    await req("PATCH", `/api/sessions/${A}`, { pinned: true, parked: true });
    const ackAtBefore = readAgentFile(A).ackAt;
    server.kill("SIGKILL");
    server = spawn("node", [join(REPO, "server", "index.js"), WS], {
      env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer();
    {
      const recs = readdirSync(join(HH, "servers")).filter((n) => n.endsWith(".json"));
      const rec = JSON.parse(readFileSync(join(HH, "servers", recs.find((n) => n !== "deadbeef00000000.json") || recs[0]), "utf-8"));
      ok(recs.length === 1 && rec.pid === server.pid, `after a SIGKILL + reboot the record names the new pid and the dead sibling is pruned (${recs.join(",")})`);
    }
    const live = (await liveList()).find((s) => s.id === A);
    ok(live?.pinned === true, "pinned survives server restart (fresh loadAgents)");
    ok(live?.parked === true, "parked survives server restart");
    ok(typeof ackAtBefore === "string" && live?.ackAt === ackAtBefore, "ackAt survives the restart");
    await req("PATCH", `/api/sessions/${A}`, { parked: false });
    ok(live?.state === "idle", "restart still resets state to idle (loader contract intact)");
    ok(live?.attentionRev === 4 && live?.ackRev === 3,
      `attentionRev/ackRev survive the restart (${live?.attentionRev}/${live?.ackRev}) — an unread agent stays unread across a service restart`);
  }

  console.log("\n[archive kills shell sub-sessions; orphan adopt restores a record instead of blanking it]");
  {
    // A shell tab is its own tmux session (hadron-<ws>-<id>-sh1). Before this
    // fix `hadron close` killed only the main session; the survivor showed up
    // as an orphan at the next boot and adopting it saved a BLANK record over
    // the archived one (name/group/task/artifacts gone, agent resurrected).
    const tmuxName = (n) => `hadron-${WS_NAME}-${n}`;
    // Exact-name check: `has-session -t X` prefix-matches X-sh1, which would
    // report the main session alive as long as the shell survives.
    const tmuxHas = (n) => { try { return execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").includes(n); } catch { return false; } };
    const tmuxNew = (n) => execFileSync("tmux", ["new-session", "-d", "-s", n, "sleep 600"], { stdio: "ignore" });

    const O = await createAgent("Orphan Owl");
    await req("PATCH", `/api/sessions/${O}`, { group: "Reviewers", task: "keep me" });
    tmuxNew(`${tmuxName(O)}-sh1`);
    ok(tmuxHas(`${tmuxName(O)}-sh1`), "fixture: shell sub-session hadron-<ws>-<id>-sh1 exists alongside the agent");
    const dO = await req("DELETE", `/api/sessions/${O}`);
    ok(dO.status === 200 && !tmuxHas(tmuxName(O)), "soft DELETE (archive) kills the main tmux session");
    ok(!tmuxHas(`${tmuxName(O)}-sh1`), "…and the shell sub-session too (no orphan left for the next boot)");
    ok(readAgentFile(O).archived === true && readAgentFile(O).group === "Reviewers", "record archived, group intact");

    // Name-space collision: an agent whose id ends in -sh1 looks like a shell
    // sub-session of the shorter id. Archiving the short one must not kill it.
    const F = await createAgent("Foo");
    const F1 = await createAgent("Foo sh1");
    ok(F === "foo" && F1 === "foo-sh1" && tmuxHas(tmuxName(F1)), "fixture: agents foo and foo-sh1 both live");
    ok((await req("DELETE", `/api/sessions/${F}`)).status === 200 && !tmuxHas(tmuxName(F)), "archive foo kills hadron-<ws>-foo");
    ok(tmuxHas(tmuxName(F1)) && (await liveList()).some((s) => s.id === F1), "…but NOT agent foo-sh1's own main session (it is a known agent, not a shell tab)");

    // whoami from inside such an agent's own pane must resolve to THAT agent,
    // not to the shorter id its name happens to extend (foo-sh1 → foo, and,
    // now that -vim-N is stripped too, foo-vim-3 → foo).
    const F3 = await createAgent("Foo vim 3");
    const who1 = await (await fetch(`${BASE}/api/whoami?tmuxSession=${tmuxName(F1)}`)).json();
    const who3 = await (await fetch(`${BASE}/api/whoami?tmuxSession=${tmuxName(F3)}`)).json();
    ok(F3 === "foo-vim-3" && who1.id === F1 && who3.id === F3,
      `whoami keeps a real agent id that ends in a sub-session suffix (${who1.id}, ${who3.id})`);
    const whoTab = await (await fetch(`${BASE}/api/whoami?tmuxSession=${tmuxName(F3)}-vim-1758000000001`)).json();
    ok(whoTab.id === F3, "…and a real vim pane of that agent still maps back to it");
    // …also when that agent is archived and its own main session outlived the
    // archive: adopting it must restore foo-vim-3, not mint/restore foo.
    await req("PATCH", `/api/sessions/${F3}`, { task: "vim3 task" });
    ok((await req("DELETE", `/api/sessions/${F3}`)).status === 200 && !tmuxHas(tmuxName(F3)), "archive foo-vim-3");
    tmuxNew(tmuxName(F3));

    // Now the world the bug left behind: sessions that survived an archive
    // (recreated by hand), plus a tmux session for an id with no record at all.
    const P = await createAgent("Orphan Pig");
    await req("PATCH", `/api/sessions/${P}`, { group: "Reviewers", task: "keep me too", notes: "pig notes" });
    ok((await req("DELETE", `/api/sessions/${P}`)).status === 200, "archive Orphan Pig");
    // An editor pane (client/markdown.js opens vim in hadron-<ws>-<id>-vim-<ts>)
    // that outlived its archived agent. adopt used to strip only -shN, so this
    // adopted as a blank agent literally named "<id>-vim-1758…".
    const V = await createAgent("Orphan Vole");
    await req("PATCH", `/api/sessions/${V}`, { group: "Reviewers", task: "vole task" });
    ok((await req("DELETE", `/api/sessions/${V}`)).status === 200, "archive Orphan Vole");
    tmuxNew(`${tmuxName(P)}-sh1`);   // surviving shell tab of an archived agent
    tmuxNew(`${tmuxName(V)}-vim-1758000000000`); // surviving editor pane of an archived agent
    tmuxNew(tmuxName(O));            // main session of an archived agent
    tmuxNew(tmuxName("nobody"));     // no record on disk at all
    server.kill("SIGKILL");
    server = spawn("node", [join(REPO, "server", "index.js"), WS], {
      env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer();
    const orphans = await (await fetch(`${BASE}/api/orphans`)).json();
    const names = orphans.map((o) => o.tmuxSession);
    ok([`${tmuxName(P)}-sh1`, `${tmuxName(V)}-vim-1758000000000`, tmuxName(O), tmuxName("nobody")].every((n) => names.includes(n)),
      `boot lists all four as orphans (${orphans.length} pending)`);
    ok(names.includes(tmuxName(F3)), "…and the archived foo-vim-3's own session as a fifth");
    ok(!(await liveList()).some((s) => s.id === P || s.id === O), "…and neither archived agent is live before any adopt");
    ok(!names.includes(tmuxName(F1)) && (await liveList()).some((s) => s.id === F1),
      "the live agent foo-sh1's own session is not listed as an orphan of archived foo");


    const a1 = await req("POST", `/api/orphans/${tmuxName(P)}-sh1/adopt`);
    ok(a1.status === 200 && (await a1.json()).agentId === P, `adopt <id>-sh1 → agentId ${P}`);
    const pj = readAgentFile(P);
    ok(pj.name === "Orphan Pig" && pj.group === "Reviewers" && pj.task === "keep me too" && pj.notes === "pig notes",
      `adopt kept the record: name ${JSON.stringify(pj.name)}, group ${pj.group}, task, notes`);
    ok(pj.archived === undefined && pj.archivedAt === undefined, "…and cleared archived/archivedAt (adopt == restore)");
    const pl = (await liveList()).find((s) => s.id === P);
    ok(pl && pl.name === "Orphan Pig" && pl.group === "Reviewers", "…live session carries the restored name/group, not the id");

    const av = await req("POST", `/api/orphans/${tmuxName(V)}-vim-1758000000000/adopt`);
    ok(av.status === 200 && (await av.json()).agentId === V, `adopt <id>-vim-<ts> → agentId ${V} (suffix stripped like -shN)`);
    const vj = readAgentFile(V);
    ok(vj.name === "Orphan Vole" && vj.group === "Reviewers" && vj.task === "vole task" && vj.archived === undefined,
      "…record restored and un-archived");
    ok(!existsSync(join(WS, ".hadron", "agents", `${V}-vim-1758000000000.json`)) && !(await liveList()).some((s) => s.id.startsWith(`${V}-vim`)),
      "…and no blank \"<id>-vim-<ts>\" agent was minted");

    const a3 = await req("POST", `/api/orphans/${tmuxName(F3)}/adopt`);
    ok(a3.status === 200 && (await a3.json()).agentId === F3, `adopt the archived agent's own session hadron-<ws>-foo-vim-3 → agentId ${F3}, not foo`);
    ok(readAgentFile(F3).task === "vim3 task" && readAgentFile(F3).archived === undefined && readAgentFile(F).archived === true,
      "…foo-vim-3 restored with its task, archived foo untouched");

    const a2 = await req("POST", "/api/orphans/adopt-all");
    const adopted = (await a2.json()).adopted || [];
    ok(a2.status === 200 && adopted.includes(O) && adopted.includes("nobody") && !adopted.includes(F),
      `adopt-all adopted the rest and nothing else (${adopted.join(", ")})`);
    ok(readAgentFile(F).archived === true && !(await liveList()).some((s) => s.id === F), "…archived foo stays archived (not resurrected via foo-sh1)");
    const oj = readAgentFile(O);
    ok(oj.name === "Orphan Owl" && oj.group === "Reviewers" && oj.task === "keep me" && oj.archived === undefined,
      "adopt-all restored Orphan Owl's record (name/group/task) and un-archived it");
    const nj = readAgentFile("nobody");
    ok(nj.name === "nobody" && nj.group === "Workers", "an id with no record still gets a fresh blank one (name = id, Workers)");
    ok((await (await fetch(`${BASE}/api/orphans`)).json()).length === 0, "no orphans pending afterwards");
  }

  console.log("\n[atomic record writes; an unreadable record is recovered, never dropped; orphans in the CLI; server.log]");
  {
    // prod 2026-10-01 (Mac, 0.7.0): t289-sol.json ended up 0 bytes while the
    // server ran; the next boot's loadAgents skipped it with an empty catch
    // and the agent — tmux alive, claude at a permission prompt — was invisible
    // to the dashboard, `hadron ls` and `hadron message` for 15 hours.
    const tmuxName = (n) => `hadron-${WS_NAME}-${n}`;
    const tmuxHas = (n) => { try { return execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").includes(n); } catch { return false; } };
    const tmuxNew = (n) => execFileSync("tmux", ["new-session", "-d", "-s", n, "sleep 600"], { stdio: "ignore" });
    const tmuxKill = (n) => { try { execFileSync("tmux", ["kill-session", "-t", n], { stdio: "ignore" }); } catch {} };
    const agentsDir = join(WS, ".hadron", "agents");
    const logPathOf = (ws) => join(ws, ".hadron", "server.log");
    const restart = async () => {
      server.kill("SIGKILL");
      server = spawn("node", [join(REPO, "server", "index.js"), WS], { env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer();
    };

    // 1. Atomic writes: a burst of saves leaves exactly the records, no temp
    //    file, every one parseable (the write goes to <id>.json.<pid>.tmp and
    //    is renamed over the record — a plain writeFileSync truncated first).
    const R = await createAgent("Repro A");
    for (let i = 0; i < 20; i++) await req("PATCH", `/api/sessions/${R}`, { task: `x${i}` });
    await req("PATCH", `/api/sessions/${R}`, { task: "x", group: "Reviewers", notes: "keep" });
    const entries = readdirSync(agentsDir);
    ok(!entries.some((n) => n.endsWith(".tmp")), `no temp file left behind after 21 saves (${entries.filter((n) => !n.endsWith(".json")).join(",") || "only .json"})`);
    ok(entries.filter((n) => n.endsWith(".json")).every((n) => { try { JSON.parse(readFileSync(join(agentsDir, n), "utf-8")); return true; } catch { return false; } }), "every record parses");
    ok(readAgentFile(R).task === "x" && readAgentFile(R).notes === "keep", "the last save won");

    // 2. The incident: truncate the record to 0 bytes, keep the tmux session,
    //    restart. Plus an orphan with no record at all for the CLI.
    truncateSync(agentFile(R), 0);
    ok(statSync(agentFile(R)).size === 0 && tmuxAlive(R), "fixture: 0-byte record, tmux session alive");
    tmuxNew(tmuxName("ghost"));
    await restart();
    const live = await liveList();
    const rec = live.find((s) => s.id === R);
    ok(!!rec, `the agent is still listed after the restart (${live.map((s) => s.id).join(",")})`);
    ok(rec && rec.name === R && rec.group === "Workers" && !rec.task, "…as a placeholder: name = id, Workers, no task");
    ok(rec && rec.recoveredFrom && /^repro-a\.json\.corrupt-\d{8}T\d{6}Z$/.test(rec.recoveredFrom.file) && rec.recoveredFrom.bytes === 0,
      `…carrying recoveredFrom {file: ${rec && rec.recoveredFrom && rec.recoveredFrom.file}, bytes: ${rec && rec.recoveredFrom && rec.recoveredFrom.bytes}}`);
    const aside = rec && rec.recoveredFrom ? join(agentsDir, rec.recoveredFrom.file) : null;
    ok(aside && existsSync(aside) && statSync(aside).size === 0, "the unreadable file is kept aside, untouched (0 bytes)");
    ok(readAgentFile(R).recoveredFrom && readAgentFile(R).recoveredFrom.file === rec.recoveredFrom.file, "a valid placeholder record is on disk (a second restart keeps the agent too)");
    ok(tmuxAlive(R) && rec.tmuxSession === tmuxName(R), "its tmux session is the agent's own again — not an orphan, not killed");
    const orphans1 = await (await fetch(`${BASE}/api/orphans`)).json();
    ok(!orphans1.some((o) => o.tmuxSession === tmuxName(R)) && orphans1.some((o) => o.tmuxSession === tmuxName("ghost")),
      `orphans after boot: ghost only (${orphans1.map((o) => o.agentId).join(",")})`);
    await restart();
    ok((await liveList()).some((s) => s.id === R) && readdirSync(agentsDir).filter((n) => n.startsWith("repro-a.json.corrupt-")).length === 1,
      "a second restart loads the placeholder normally — no second quarantine file");

    // 3. The CLI sees both: the recovered row and the orphan row.
    const ls = hadron(["ls"]);
    ok(ls.includes(`${R} (${R})`) && ls.includes("⚠ record was unreadable at boot") && ls.includes(rec.recoveredFrom.file), "hadron ls shows the placeholder with the recovery note and the quarantined file name");
    ok(ls.includes(`⚠ orphan tmux session ${tmuxName("ghost")}`) && ls.includes("hadron orphans adopt"), "hadron ls lists the orphan tmux session with the adopt/kill hint");
    const doc = await (await req("GET", "/api/doctor")).json();
    const drow = (doc.agents || []).find((a) => a.id === R);
    ok(drow && drow.finding.level === "yellow" && /record was unreadable at boot \(0 bytes\)/.test(drow.finding.message) && drow.recovered && drow.recovered.file === rec.recoveredFrom.file,
      `doctor row is yellow and names the file (${drow && drow.finding.level}: ${drow && drow.finding.message})`);
    const oc = hadron(["orphans"]);
    ok(oc.includes(tmuxName("ghost")) && oc.includes("agent id ghost"), "hadron orphans lists it");
    const oj = JSON.parse(hadron(["orphans", "--json"]));
    ok(Array.isArray(oj) && oj.length === 1 && oj[0].agentId === "ghost", "hadron orphans --json is the raw list");
    ok(hadron(["orphans", "adopt", "ghost"]).includes("adopted hadron-") && (await liveList()).some((s) => s.id === "ghost"), "hadron orphans adopt <agentId> brings it back as an agent");
    ok(hadron(["orphans"]).trim() === "no orphan tmux sessions", "…and the list is empty afterwards");
    const bad = hadronFails(["orphans", "adopt", "nope"]);
    ok(bad && bad.status === 1 && /no pending orphan matches/.test(bad.stderr), "adopting an unknown name exits 1 with a message");
    ok(hadronFails(["orphans", "frobnicate"])?.status === 1, "an unknown subcommand exits 1");

    // 4. Re-validation (3b): the boot-time list must not outlive the world it
    //    described. (a) the orphan's id is spawned again → dropped, kill → 409,
    //    kill-all leaves the live agent alone; (b) the session vanished → dropped.
    tmuxNew(tmuxName("phoenix"));
    tmuxNew(tmuxName("vanish"));
    await restart();
    const o2 = (await (await fetch(`${BASE}/api/orphans`)).json()).map((o) => o.agentId);
    ok(o2.includes("phoenix") && o2.includes("vanish"), `fixture: both listed as orphans (${o2.join(",")})`);
    tmuxKill(tmuxName("phoenix"));            // what the operator did: killed it by hand…
    const PX = await createAgent("Phoenix");   // …and re-spawned the same name → same tmux session name
    ok(PX === "phoenix" && tmuxAlive("phoenix"), "fixture: a live agent now owns hadron-<ws>-phoenix");
    tmuxKill(tmuxName("vanish"));
    const o3 = (await (await fetch(`${BASE}/api/orphans`)).json()).map((o) => o.agentId);
    ok(!o3.includes("phoenix") && !o3.includes("vanish"), `GET /api/orphans drops the re-spawned id and the vanished session (${o3.join(",") || "empty"})`);
    const k1 = await req("POST", `/api/orphans/${tmuxName("phoenix")}/kill`);
    ok(k1.status === 409 && (await k1.json()).agentId === "phoenix", "kill on a session a live agent now owns → 409 naming the agent");
    ok(tmuxAlive("phoenix"), "…and the live agent's tmux session was not killed");
    const k2 = await req("POST", `/api/orphans/${tmuxName("vanish")}/kill`);
    ok(k2.status === 404, "kill on a session that is gone → 404");
    const ka = await req("POST", "/api/orphans/kill-all");
    const kaj = await ka.json();
    ok(ka.status === 200 && Array.isArray(kaj.killed) && !kaj.killed.includes(tmuxName("phoenix")) && tmuxAlive("phoenix"),
      `kill-all after a re-spawn kills nothing of the live agent (killed: ${kaj.killed && kaj.killed.join(",") || "none"})`);
    const a9 = await req("POST", `/api/orphans/${tmuxName("phoenix")}/adopt`);
    ok(a9.status === 409, "adopt on a session a live agent owns → 409 too");

    // 4b. Recovery must never touch a GOOD record. (a) a read ERROR is not a
    //     parse error: a record the server cannot open (EACCES here; EMFILE on
    //     an fd-exhausted box is the same path) stays exactly where it is and
    //     is loaded again once readable. (b) a stem that is not an agent id is
    //     never minted into a placeholder. (c) recovery runs at BOOT only — the
    //     archived GET re-reads the directory at runtime while agents may be
    //     mid-write on their own files, and a torn read there is skipped.
    const G = await createAgent("Guarded");
    await req("PATCH", `/api/sessions/${G}`, { task: "precious", notes: "keep me" });
    writeFileSync(join(agentsDir, "Bad_Name.json"), "");
    const canDropPerms = typeof process.getuid === "function" && process.getuid() !== 0;
    if (canDropPerms) chmodSync(agentFile(G), 0o000);
    await restart();
    if (canDropPerms) {
      const afterLs = await liveList();
      ok(!afterLs.some((s) => s.id === G), "fixture: the unreadable (0000) record is not loaded this boot");
      ok(existsSync(agentFile(G)) && !readdirSync(agentsDir).some((n) => n.startsWith(`${G}.json.corrupt-`)), "…and it was NOT quarantined — a read error is not a parse error");
      const log2 = readFileSync(logPathOf(WS), "utf-8");
      ok(new RegExp(` warn \\[agents\\] ${G}\\.json could not be read \\(EACCES\\)`).test(log2), "server.log names the read error and the file");
      chmodSync(agentFile(G), 0o600);
      await restart();
      const back = (await liveList()).find((s) => s.id === G);
      ok(back && back.task === "precious" && back.notes === "keep me" && !back.recoveredFrom, "readable again → the record loads with every field intact");
    } else {
      ok(true, "skip: running as root, EACCES cannot be provoked");
    }
    ok(existsSync(join(agentsDir, "Bad_Name.json")) && statSync(join(agentsDir, "Bad_Name.json")).size === 0 && !readdirSync(agentsDir).some((n) => n.startsWith("Bad_Name.json.corrupt-")) && !(await liveList()).some((s) => s.id === "Bad_Name"),
      "a 0-byte file whose stem is not an agent id is left in place — no placeholder, no quarantine");
    rmSync(join(agentsDir, "Bad_Name.json"));
    const T = await createAgent("Torn");
    await req("PATCH", `/api/sessions/${T}`, { task: "mid-write" });
    truncateSync(agentFile(T), 0); // what an agent's own `>` write looks like for an instant
    const arch = await req("GET", "/api/sessions/archived");
    ok(arch.status === 200 && statSync(agentFile(T)).size === 0 && !readdirSync(agentsDir).some((n) => n.startsWith(`${T}.json.corrupt-`)), "GET /api/sessions/archived over a torn record quarantines nothing (recovery is boot-only)");
    ok((await liveList()).find((s) => s.id === T)?.task === "mid-write", "…and the live session is untouched");
    await req("PATCH", `/api/sessions/${T}`, { task: "written back" });
    ok(readAgentFile(T).task === "written back", "the next save repairs the file");

    // 4c. recoveredFrom is server-minted but lives on disk: a hand-edited value
    //     is sanitised on the OPEN list like the checkpoint fields are.
    const rj = readAgentFile(R);
    rj.recoveredFrom = { file: "../evil<b>/x.json", at: "sk-not-a-timestamp", bytes: -5 };
    writeFileSync(agentFile(R), JSON.stringify(rj));
    await restart();
    const rf = (await liveList()).find((s) => s.id === R)?.recoveredFrom;
    ok(rf && rf.file === "..evilbx.json" && rf.at === null && rf.bytes === null, `a junk recoveredFrom on disk reaches the wire sanitised (${JSON.stringify(rf)})`);

    // 5. server.log: the console is mirrored into the workspace, 0600.
    const logPath = logPathOf(WS);
    ok(existsSync(logPath) && (statSync(logPath).mode & 0o777) === 0o600, "…/.hadron/server.log exists, mode 0600");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    ok(/ warn \[agents\] repro-a\.json was unreadable \(0 bytes/.test(log) && log.includes("moved to repro-a.json.corrupt-"), "the recovery warning is in server.log with the file names");
    ok(/ info Found \d+ orphaned tmux session/.test(log), "the orphan notice is in server.log");
    const doc2 = await (await req("GET", "/api/doctor")).json();
    ok(doc2.serverLog && doc2.serverLog.ok === true && doc2.serverLog.error === null, "GET /api/doctor reports serverLog {ok:true}");
    const docOut = (() => { try { return hadron(["doctor"], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return String(e.stdout || ""); } })(); // exit 1 on the hand-started server's red row is expected
    ok(docOut.includes("server.log: console mirrored"), "hadron doctor shows the server.log row");
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    // the boot generation line carries the machine's boot_id — a uuid, not a secret
    const leak = log.split("\n").find((l) => l.includes(TOKEN) || (UUID.test(l) && !l.includes("boot generation boot-")));
    ok(!leak, `server.log carries no token and no session id${leak ? ` (${leak.replace(TOKEN, "<token>").replace(UUID, "<uuid>")})` : ""}`);
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    if (server) try { server.kill("SIGKILL"); } catch {}
    killTmux();
    try { rmSync(WS, { recursive: true, force: true }); } catch {}
    try { rmSync(HH, { recursive: true, force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  });
