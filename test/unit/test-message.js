/**
 * Integration tests for POST /api/sessions/:id/message + `hadron message` (CLI).
 *
 * The route's contract: text lands in the pane INTACT (multiline + special chars,
 * via tmux load-buffer → bracketed paste-buffer), Enter is a separate keystroke,
 * and nothing leaks (tmux buffers, temp dirs).
 *
 * Self-contained: boots its own Hadron server on a throwaway workspace + port,
 * runs assertions over HTTP and tmux capture-pane, then tears everything down.
 *
 * Run: node test/unit/test-message.js
 * Requires: tmux on PATH.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
// Random high port — never 3000 (production), never the other suites' fixed ports.
const PORT = 4600 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-msgtest-"));
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
let server, TOKEN;

const POST = (p, body) => fetch(`${BASE}${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": BASE },
  body: JSON.stringify(body ?? {}),
});

async function createAgent(name) {
  const r = await POST("/api/sessions", { name, launchCommand: "shell" });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  return (await r.json()).id;
}

const paneOf = (agentId) => `hadron-${WS_NAME}-${agentId}`;
function capturePane(agentId) {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", paneOf(agentId), "-p"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}
// Discard whatever is sitting unsubmitted on the prompt between checks.
function clearPrompt(agentId) {
  execFileSync("tmux", ["send-keys", "-t", paneOf(agentId), "C-c"]);
}
function listBuffers() {
  try {
    return execFileSync("tmux", ["list-buffers", "-F", "#{buffer_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}
function tmpLeaks() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("hadron-msg-"));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hadron(args, opts = {}) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: String(PORT), HADRON_TOKEN: TOKEN },
    ...opts,
  });
}

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
  // Baseline leak sets — assert no NEW leaks, so a concurrent run can't false-fail us.
  const tmpBefore = new Set(tmpLeaks());

  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  const A = await createAgent("msg-a");    // delivery happy paths (API + CLI)
  const DEAD = await createAgent("msg-dead"); // 409: agent exists, tmux gone
  await sleep(500); // let the shells paint their prompts

  console.log("\n[multiline + special chars, enter:false]");
  {
    // Every class send-keys -l historically mangled: quotes, $(), backticks,
    // : = #, backslash, a leading dash, across 3+ lines.
    const payload = [
      `key: value = ok # not "a comment" 'quoted'`,
      "-leading-dash $(echo INJECTED) `echo INJECTED` \\back\\slash",
      "third line survives intact",
    ].join("\n");
    const r = await POST(`/api/sessions/${A}/message`, { text: payload, enter: false });
    const j = await r.json();
    ok(r.status === 200 && j.ok === true, "POST → 200 {ok:true}");
    ok(j.bytes === Buffer.byteLength(payload), `bytes echoes payload size (${j.bytes})`);
    await sleep(400);
    const pane = capturePane(A);
    ok(pane.includes(`key: value = ok # not "a comment" 'quoted'`), "line 1 intact (: = # \" ')");
    ok(pane.includes("-leading-dash $(echo INJECTED) `echo INJECTED` \\back\\slash"), "line 2 intact (leading -, $(), backticks, backslash)");
    ok(pane.includes("third line survives intact"), "line 3 intact (multiline did not truncate)");
    ok(!/^INJECTED$/m.test(pane), "nothing executed — bracketed paste held the multiline text on the prompt");
    clearPrompt(A);
  }

  console.log("\n[enter:true submits]");
  {
    const r = await POST(`/api/sessions/${A}/message`, { text: "echo hadron-msg-ok" });
    ok(r.status === 200, "POST (enter default true) → 200");
    await sleep(600); // paste + 250ms Enter delay + shell echo
    ok(/^hadron-msg-ok$/m.test(capturePane(A)), "command OUTPUT in pane — Enter submitted after the paste");
  }

  console.log("\n[validation]");
  {
    const r404 = await POST("/api/sessions/no-such-agent/message", { text: "hi" });
    ok(r404.status === 404, "unknown session id → 404");
    execFileSync("tmux", ["kill-session", "-t", paneOf(DEAD)]);
    const r409 = await POST(`/api/sessions/${DEAD}/message`, { text: "hi" });
    const j409 = await r409.json();
    ok(r409.status === 409 && /not running/.test(j409.error), "agent without a live tmux session → 409 with clear error");
    const r400a = await POST(`/api/sessions/${A}/message`, { text: "" });
    const r400b = await POST(`/api/sessions/${A}/message`, { text: 42 });
    ok(r400a.status === 400 && r400b.status === 400, "empty / non-string text → 400");
  }

  console.log("\n[CLI: hadron message]");
  {
    const out = hadron(["message", A, "echo hadron-cli-ok"]);
    ok(/delivered \d+ bytes/.test(out), "CLI reports delivered bytes");
    await sleep(600);
    ok(/^hadron-cli-ok$/m.test(capturePane(A)), "CLI positional text landed and submitted");

    // stdin path: `cat brief.md | hadron message <id> -`
    const brief = "stdin line one\nstdin line two with $(echo INJECTED)\nstdin line three";
    hadron(["message", A, "-", "--no-enter"], { input: brief });
    await sleep(400);
    const pane = capturePane(A);
    ok(pane.includes("stdin line two with $(echo INJECTED)") && pane.includes("stdin line three"), "stdin-piped multiline text landed intact");
    ok(!/^INJECTED$/m.test(pane), "--no-enter left it unsubmitted");
    clearPrompt(A);
  }

  console.log("\n[no leaks]");
  {
    ok(!listBuffers().includes("hadron-msg-"), "no hadron-msg-* tmux buffers left behind (-d reclaimed them)");
    const leaked = tmpLeaks().filter((n) => !tmpBefore.has(n));
    ok(leaked.length === 0, `no temp dirs left behind${leaked.length ? ` (leaked: ${leaked.join(", ")})` : ""}`);
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
