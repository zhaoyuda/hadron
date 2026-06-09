/**
 * Probe the CLI's `.hadron/` port discovery (not part of npm test). On a non-3000
 * server, the bundled `hadron` CLI must target the RIGHT server with NO HADRON_PORT
 * in the environment — by reading `.hadron/runtime.json` (written at server startup),
 * the same way it reads `.hadron/token`. This is the path the per-session env stamp
 * (applyAgentEnv) can't cover: pre-existing tmux sessions and post-restart shells.
 *
 * Run: node test/e2e/probe-port-discovery.js
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { bootWorkspace, reporter } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = await bootWorkspace({ name: "portdisc" });
const port = env.baseUrl.split(":").pop();
const r = reporter("CLI port discovery");

// Run the CLI with a deliberately CLEAN env (no HADRON_PORT/HADRON_TOKEN) so the only
// way it can reach the right server is by discovering the workspace `.hadron/`.
function cleanHadron(args, cwd) {
  const e = { ...process.env };
  delete e.HADRON_PORT;
  delete e.HADRON_TOKEN;
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], { encoding: "utf-8", cwd, env: e });
}
// Seeding spawn still needs to target the test server explicitly.
function hadron(args) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8", env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token },
  });
}

try {
  // 0. server wrote runtime.json with the right port + a live pid
  const rtPath = join(env.ws, ".hadron", "runtime.json");
  r.ok(existsSync(rtPath), "server wrote .hadron/runtime.json");
  const rt = JSON.parse(readFileSync(rtPath, "utf-8"));
  r.ok(String(rt.port) === String(port), `runtime.json port is ${port} (got ${rt.port})`);
  r.ok(Number.isInteger(rt.pid) && rt.pid > 0, `runtime.json has a pid (${rt.pid})`);

  hadron(["spawn", "alpha", "--group", "Workers", "--launch", "shell", "--start"]);
  await new Promise((res) => setTimeout(res, 1200));

  // 1. `hadron ls` from the workspace cwd with NO env resolves the right server.
  // (This is the core: port + token both come from the discovered `.hadron/`.)
  const ls = cleanHadron(["ls"], env.ws);
  r.ok(/alpha/.test(ls), "clean-env `hadron ls` (no HADRON_PORT) reached the right server");

  // 2. Feedback's exact repro: run `hadron whoami` INSIDE a pre-existing agent pane
  // after stripping HADRON_PORT/HADRON_TOKEN from that shell — must still resolve via
  // runtime.json rather than 404 against :3000.
  const tmuxName = `hadron-${env.wsName}-alpha`;
  const outFile = `/tmp/probe-portdisc-${process.pid}.txt`;
  const script = `unset HADRON_PORT HADRON_TOKEN; node ${join(REPO, "bin", "hadron.js")} whoami > ${outFile} 2>&1`;
  execFileSync("tmux", ["send-keys", "-t", tmuxName, "-l", script]);
  execFileSync("tmux", ["send-keys", "-t", tmuxName, "Enter"]);
  await new Promise((res) => setTimeout(res, 1000));
  const out = existsSync(outFile) ? readFileSync(outFile, "utf-8") : "(no output)";
  try { execFileSync("rm", ["-f", outFile]); } catch {}
  r.ok(/alpha/.test(out) && !/404/.test(out), `pre-existing pane whoami resolves with no env (got: ${out.trim().split("\n")[0]})`);
} catch (e) {
  console.error("error:", e.message);
  r.fail("threw: " + e.message);
} finally {
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
