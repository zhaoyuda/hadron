/**
 * Integration tests for the v0.6 security + server additions.
 *
 * Self-contained: boots its own Hadron server on a throwaway workspace + port,
 * runs assertions over HTTP, then tears everything down (server + tmux sessions).
 *
 * Run: node test/unit/test-security.js
 * Requires: tmux on PATH.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir, networkInterfaces } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-test-"));
let server, TOKEN;

function authHeaders(extra = {}) {
  return { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": ORIGIN, ...extra };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/sessions`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

function killTmux() {
  try {
    const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter((n) => n.includes(`hadron-${WS.split("/").pop()}`));
    for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
  } catch {}
}

async function main() {
  server = spawn("node", [join(__dirname, "..", "..", "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();

  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  console.log("\n[auth]");
  ok(TOKEN && TOKEN.length >= 32, "token auto-generated in .hadron/token");
  {
    // mutating route without token → 401
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ name: "no-token" }) });
    ok(r.status === 401, "POST without token rejected (401)");
  }
  {
    // GET stays open (no token)
    const r = await fetch(`${BASE}/api/sessions`);
    ok(r.status === 200, "GET without token allowed (200)");
  }
  {
    // bad Origin → 403
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: "http://evil.example.com" }, body: JSON.stringify({ name: "bad-origin" }) });
    ok(r.status === 403, "POST from disallowed Origin rejected (403)");
  }

  console.log("\n[notebook proxy guard]");
  {
    // The marimo/jupyter proxies front tokenless notebook servers, so they must
    // reject cross-origin requests (CSRF) even though they sit outside /api.
    const r = await fetch(`${BASE}/jupyter-proxy/9999/api`, { headers: { Origin: "http://evil.example.com" } });
    ok(r.status === 403, "jupyter-proxy from disallowed Origin rejected (403)");
    const r2 = await fetch(`${BASE}/marimo-proxy/9999/`, { headers: { Origin: "http://evil.example.com" } });
    ok(r2.status === 403, "marimo-proxy from disallowed Origin rejected (403)");
    // Same-origin passes the guard, then 502s because nothing is listening on 9999.
    const r3 = await fetch(`${BASE}/jupyter-proxy/9999/api`, { headers: { Origin: ORIGIN } });
    ok(r3.status === 502, "jupyter-proxy with allowed Origin passes guard (502, no upstream)");
  }

  console.log("\n[remote bind host allowlist]");
  {
    // When bound to 0.0.0.0, a browser reaches us via a concrete LAN/Tailscale IP,
    // not "0.0.0.0". That IP must be allowed (else the WS + mutating API 403 and the
    // terminal stays blank), while a foreign Host header is still rejected.
    const ownIp = Object.values(networkInterfaces()).flat()
      .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (!ownIp) {
      console.log("  ? SKIP: no non-loopback IPv4 on this host");
    } else {
      const RPORT = PORT + 1;
      const RWS = mkdtempSync(join(tmpdir(), "hadron-rtest-"));
      const rsrv = spawn("node", [join(__dirname, "..", "..", "server", "index.js"), RWS], {
        env: { ...process.env, PORT: String(RPORT), HADRON_HOST: "0.0.0.0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        for (let i = 0; i < 50; i++) {
          try { const r = await fetch(`http://127.0.0.1:${RPORT}/api/sessions`); if (r.ok) break; } catch {}
          await new Promise((r) => setTimeout(r, 200));
        }
        const RTOKEN = readFileSync(join(RWS, ".hadron", "token"), "utf-8").trim();
        const mk = (host) => fetch(`http://127.0.0.1:${RPORT}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-hadron-token": RTOKEN, Host: host, Origin: `http://${host}` },
          body: JSON.stringify({ name: "remote", launchCommand: "shell" }),
        });
        const good = await mk(`${ownIp}:${RPORT}`);
        ok(good.status === 201, `own IP host ${ownIp}:${RPORT} accepted (201) when bound 0.0.0.0`);
        // Browsers often reach the box by name (http://my-host:3000), not IP — the
        // machine hostname must be allowed too, else the deck loads but the WS 401s
        // and the terminal stays blank.
        const hn = (await import("os")).hostname();
        const byName = await mk(`${hn}:${RPORT}`);
        ok(byName.status === 409 || byName.status === 201, `hostname host ${hn}:${RPORT} accepted (not 403) when bound 0.0.0.0`);
        // Host/Origin comparison must be case-insensitive (DNS is). A machine named
        // "Mac" stores "Mac" in the allowlist but browsers/URL.host send "mac" → 403.
        // Repro the mixed-case host with an upper/lower-swapped hostname.
        const swapped = hn.split("").map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
        const byMixedCase = await mk(`${swapped}:${RPORT}`);
        ok(byMixedCase.status === 409 || byMixedCase.status === 201, `mixed-case hostname ${swapped}:${RPORT} accepted (not 403) — case-insensitive allowlist`);
        const bad = await mk(`evil.example.com:${RPORT}`);
        ok(bad.status === 403, "foreign Host header still rejected (403) when bound 0.0.0.0");
      } finally {
        try { rsrv.kill("SIGKILL"); } catch {}
        try {
          const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
            .trim().split("\n").filter((n) => n.includes(`hadron-${RWS.split("/").pop()}`));
          for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
        } catch {}
        try { rmSync(RWS, { recursive: true, force: true }); } catch {}
      }
    }
  }

  console.log("\n[create + launchCommand]");
  {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "T1 Worker", group: "Workers", launchCommand: "shell" }) });
    const j = await r.json();
    ok(r.status === 201 && j.id === "t1-worker", "create slugifies name → id");
    ok(j.launchCommand === "shell", "launchCommand stored");
  }
  {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "bad-lc", launchCommand: "rm -rf /" }) });
    ok(r.status === 400, "arbitrary launchCommand string rejected (enum only)");
  }

  console.log("\n[cwd policy]");
  {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "escape", cwd: "/etc", launchCommand: "shell" }) });
    ok(r.status === 400, "cwd outside workspace rejected");
  }
  {
    const sub = join(WS, "sub");
    mkdirSync(sub, { recursive: true });
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "incwd", cwd: "sub", launchCommand: "shell" }) });
    const j = await r.json();
    ok(r.status === 201 && j.cwd === sub, "cwd inside workspace accepted + normalized");
  }
  {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "nodir", cwd: "does-not-exist", launchCommand: "shell" }) });
    ok(r.status === 400, "nonexistent cwd rejected");
  }

  console.log("\n[file write API]");
  {
    const csv = join(WS, "edit-me.csv");
    writeFileSync(csv, "a,b\n1,2\n");
    // No token → rejected before any write.
    let r = await fetch(`${BASE}/api/file`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ path: "edit-me.csv", content: "x" }) });
    ok(r.status === 401, "file write without token rejected (401)");
    ok(readFileSync(csv, "utf-8") === "a,b\n1,2\n", "unauthenticated write left file untouched");
    // Authenticated edit of existing file round-trips.
    r = await fetch(`${BASE}/api/file`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ path: "edit-me.csv", content: "a,b\n9,9\n" }) });
    ok(r.ok && readFileSync(csv, "utf-8") === "a,b\n9,9\n", "authenticated edit writes to disk");
    // Cannot create a new file (must already exist).
    r = await fetch(`${BASE}/api/file`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ path: "brand-new.csv", content: "x" }) });
    ok(r.status === 404 && !existsSync(join(WS, "brand-new.csv")), "write to nonexistent path rejected (404), no file created");
    // Non-string content rejected.
    r = await fetch(`${BASE}/api/file`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ path: "edit-me.csv", content: 42 }) });
    ok(r.status === 400, "non-string content rejected (400)");
  }

  console.log("\n[malicious task text]");
  {
    const pwned = join(WS, "pwned");
    const task = `foo"; touch ${pwned}; echo "`;
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "mal", task, launchCommand: "shell", autostart: true }) });
    ok(r.status === 201, "create with malicious task text succeeds (stored as data)");
    await new Promise((res) => setTimeout(res, 1500));
    ok(!existsSync(pwned), "malicious task text did NOT execute (no shell injection)");
  }

  console.log("\n[append concurrency]");
  {
    await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "appendee", launchCommand: "shell" }) });
    const adds = [];
    for (let i = 0; i < 8; i++) {
      adds.push(fetch(`${BASE}/api/sessions/appendee/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: `file${i}.md` }) }));
    }
    // also fire a duplicate to test dedupe
    adds.push(fetch(`${BASE}/api/sessions/appendee/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "file0.md" }) }));
    await Promise.all(adds);
    const r = await fetch(`${BASE}/api/sessions`);
    const list = await r.json();
    const me = list.find((s) => s.id === "appendee");
    ok(me.artifacts.length === 8, `concurrent appends all landed + deduped (got ${me.artifacts.length}, want 8)`);
  }

  console.log("\n[archived same-name respawn]");
  {
    await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "recyc", launchCommand: "shell" }) });
    await fetch(`${BASE}/api/sessions/recyc?force=false`, { method: "DELETE", headers: authHeaders() });
    // recreate same name
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "recyc", launchCommand: "shell" }) });
    const j = await r.json();
    ok(r.status === 201 && !j.archived && !j.archivedAt, "respawned agent is cleanly live (archived flags cleared)");
    const onDisk = JSON.parse(readFileSync(join(WS, ".hadron", "agents", "recyc.json"), "utf-8"));
    ok(!onDisk.archived, "archived flag also cleared on disk");
  }

  console.log("\n[whoami]");
  {
    const wsName = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
    const r = await fetch(`${BASE}/api/whoami?tmuxSession=hadron-${wsName}-t1-worker`);
    const j = await r.json();
    ok(r.status === 200 && j.id === "t1-worker", "whoami resolves tmux session name → agent");
    const r2 = await fetch(`${BASE}/api/whoami?tmuxSession=some-other-session`);
    ok(r2.status === 404, "whoami rejects non-hadron session");
  }

  console.log("\n[duplicate spawn]");
  {
    const both = await Promise.all([
      fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "dup", launchCommand: "shell" }) }),
      fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "dup", launchCommand: "shell" }) }),
    ]);
    const codes = both.map((r) => r.status).sort();
    ok(codes[0] === 201 && codes[1] === 409, "concurrent same-name create → one 201, one 409");
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
