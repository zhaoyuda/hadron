/**
 * Shared harness for Hadron end-to-end module tests.
 *
 * bootWorkspace() scaffolds a throwaway workspace (with the sample agent),
 * starts a real server on a free loopback port, and waits until it answers.
 * Script checks hit the returned baseUrl directly; browser checks (Playwright)
 * drive the same instance. Call stop() to kill the server + its tmux sessions
 * and remove the temp dir.
 *
 * This is convention, not a framework: each e2e/m*.js file is a plain node
 * script that boots a workspace, asserts, and exits non-zero on failure.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(__dirname));
export const SCREENSHOT_DIR = join(__dirname, "screenshots");

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

export async function bootWorkspace({ name = "e2e" } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "hadron-e2e-"));
  execFileSync("node", [join(REPO, "scripts", "setup-workspace.js"), ws, "--name", name], { stdio: "ignore" });

  const port = await freePort();
  const proc = spawn("node", [join(REPO, "server", "index.js"), ws], {
    env: { ...process.env, PORT: String(port), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${baseUrl}/api/sessions`); if (r.ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) { try { proc.kill("SIGKILL"); } catch {} throw new Error("e2e server did not start"); }

  const token = readFileSync(join(ws, ".hadron", "token"), "utf-8").trim();
  const wsName = ws.split("/").pop();

  function stop() {
    try { proc.kill("SIGKILL"); } catch {}
    try {
      const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split("\n").filter((n) => n.includes(`hadron-${wsName}`));
      for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
    } catch {}
    try { rmSync(ws, { recursive: true, force: true }); } catch {}
  }

  return { baseUrl, token, ws, wsName, proc, stop };
}

// Server is loopback-bound with no Origin (node fetch sends none), so token alone gates.
export function authHeaders(token, extra = {}) {
  return { "Content-Type": "application/json", "x-hadron-token": token, ...extra };
}

export function screenshotDir() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return SCREENSHOT_DIR;
}

export function reporter(title) {
  if (title) console.log(`\n# ${title}`);
  let passed = 0, failed = 0;
  return {
    ok(cond, msg) {
      if (cond) { passed++; console.log(`  ✓ ${msg}`); }
      else { failed++; console.error(`  ✗ ${msg}`); }
    },
    fail(msg) { failed++; console.error(`  ✗ ${msg}`); },
    finish() {
      console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
      return failed === 0;
    },
  };
}
