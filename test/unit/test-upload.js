/**
 * Integration tests for POST /api/sessions/:id/upload (paste-to-upload images).
 *
 * The route's contract: raw image bytes + a whitelisted image Content-Type in,
 * file saved verbatim under <workspace>/.hadron/uploads/<agentId>/, absolute
 * path out. The client supplies no path — wrong type 415, empty body 400,
 * unknown session 404, no token 401, >12mb 413.
 *
 * Self-contained: boots its own Hadron server on a throwaway workspace + port,
 * runs assertions over HTTP and the filesystem, then tears everything down.
 *
 * Run: node test/unit/test-upload.js
 * Requires: tmux on PATH.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
// Random high port — never 3000 (production), never the other suites' ranges.
const PORT = 5100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-uploadtest-"));
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
let server, TOKEN;

// 1x1 transparent PNG — real bytes so the saved file is a valid image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const upload = (path, body, contentType, extraHeaders = {}) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": contentType, "x-hadron-token": TOKEN, "Origin": BASE, ...extraHeaders },
  body,
});

async function createAgent(name) {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": BASE },
    body: JSON.stringify({ name, launchCommand: "shell" }),
  });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  return (await r.json()).id;
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

  const A = await createAgent("upload-a");

  console.log("\n[png happy path]");
  {
    const r = await upload(`/api/sessions/${A}/upload`, PNG, "image/png");
    const j = await r.json();
    ok(r.status === 200 && j.ok === true, "POST png → 200 {ok:true}");
    ok(j.bytes === PNG.length, `bytes echoes payload size (${j.bytes})`);
    ok(isAbsolute(j.path || ""), "response path is absolute");
    ok((j.path || "").startsWith(join(WS, ".hadron", "uploads", A) + "/"), "path is inside <workspace>/.hadron/uploads/<agentId>/");
    ok(/\/img-\d+-[a-z0-9]{4}\.png$/.test(j.path || ""), `filename matches img-<ts>-<rand>.png (${(j.path || "").split("/").pop()})`);
    let onDisk = null;
    try { onDisk = readFileSync(j.path); } catch {}
    ok(onDisk && onDisk.equals(PNG), "bytes on disk match the uploaded payload exactly");
  }

  console.log("\n[content-type → extension]");
  {
    const r = await upload(`/api/sessions/${A}/upload`, PNG, "image/jpeg");
    const j = await r.json();
    ok(r.status === 200 && /\.jpg$/.test(j.path || ""), "image/jpeg saves with a .jpg extension");
  }

  console.log("\n[rejections]");
  {
    const r415 = await upload(`/api/sessions/${A}/upload`, Buffer.from("<svg/>"), "image/svg+xml");
    ok(r415.status === 415, "non-whitelisted image type (svg) → 415");
    const r415b = await upload(`/api/sessions/${A}/upload`, Buffer.from("hello"), "text/plain");
    ok(r415b.status === 415, "non-image content-type → 415");
    const r400 = await upload(`/api/sessions/${A}/upload`, Buffer.alloc(0), "image/png");
    ok(r400.status === 400, "empty body → 400");
    const r404 = await upload(`/api/sessions/no-such-agent/upload`, PNG, "image/png");
    ok(r404.status === 404, "unknown session id → 404");
    const r401 = await fetch(`${BASE}/api/sessions/${A}/upload`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: PNG,
    });
    ok(r401.status === 401, "no token → 401 (mutating route is guarded)");
    const big = Buffer.alloc(13 * 1024 * 1024, 1);
    const rBig = await upload(`/api/sessions/${A}/upload`, big, "image/png");
    ok(rBig.status === 413, `oversize body (13mb > 12mb limit) → 413 (got ${rBig.status})`);
  }

  console.log("\n[uploads accumulate, never clobber]");
  {
    const r1 = await upload(`/api/sessions/${A}/upload`, PNG, "image/png");
    const r2 = await upload(`/api/sessions/${A}/upload`, PNG, "image/png");
    const [j1, j2] = [await r1.json(), await r2.json()];
    ok(j1.path !== j2.path, "two uploads get distinct paths");
    ok(statSync(j1.path).isFile() && statSync(j2.path).isFile(), "both files exist on disk");
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
