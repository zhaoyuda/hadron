/**
 * Pane-target resolution at the REAL tmux boundary.
 *
 * Regression for the cross-agent state-scramble bug (2026-09-06): StateDetector
 * used to resolve its pane id ONCE in the constructor and cache it for the
 * monitor's whole lifetime. tmux recycles %N pane ids after a pane dies, so a
 * tmux-server restart / session recreation (panes rebuilt hours after the node
 * server booted) left every monitor holding a stale id that now pointed at a
 * DIFFERENT agent's pane — so an idle agent's box showed another agent's
 * working/blocked/compacting state (states landing in the wrong box).
 *
 * The fix: never cache a pane id, and never thread a %N id from one tmux call to
 * the next. paneTarget stays the stable session NAME; every tmux call in _poll
 * targets that name and lets tmux resolve the session's current pane inside that
 * single call, so a recreated session/pane can never alias a foreign pane.
 *
 * Isolation: a private tmux server via HADRON_TMUX_SOCKET (tmux -S). $TMUX would
 * otherwise win over TMUX_TMPDIR from inside a pane; -S beats $TMUX. Nothing here
 * can touch the developer's real tmux server. Requires: tmux, node.
 *
 * Run: node test/unit/test-pane-resolution.js
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

try {
  execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
  console.log("~ skip test-pane-resolution: tmux not available");
  process.exit(0);
}

const T = mkdtempSync(join(tmpdir(), "hadron-panes-"));
const SOCK = join(T, "tmux.sock");
// Must be set BEFORE importing tmux.js (it reads the env at module load).
process.env.HADRON_TMUX_SOCKET = SOCK;
const { StateDetector } = await import("../../server/state-detector.js");

let passed = 0, failed = 0, skipped = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tx(args) { return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
function txSafe(args) { try { return tx(args); } catch { return null; } }
function paneIdOf(sess) { return txSafe(["display-message", "-t", sess, "-p", "#{pane_id}"]); }

// A node process that prints a thinking spinner line (matches THINKING_RE) and
// holds the foreground, so pane_current_command=node (an agent) with a working
// buffer. ✳ = ✳ ; the (5s · 100 tokens) tail satisfies the duration+tokens group.
const THINK_CMD =
  "node -e \"process.stdout.write('\\u2733 Reticulating splines\\u2026 (5s \\u00b7 100 tokens)\\n');setInterval(()=>{},1e9)\"";

function newSession(name, cmd) {
  // cmd omitted → a bare login shell (bash), i.e. an idle/exited pane.
  const args = ["new-session", "-d", "-s", name, "-x", "80", "-y", "24"];
  if (cmd) args.push(cmd);
  tx(args);
}

function makeDetector(name) {
  const session = { id: name, state: "idle", cwd: T, blockReason: undefined, substatus: null };
  const det = new StateDetector(name, session);
  clearInterval(det.pollTimer);   // drive _poll() manually — no background timer races
  det.skipCount = 0;              // skip the 3-poll warmup
  det.minStateDuration = 0;       // canTransition always true → deterministic
  return { det, session };
}
async function pump(det, n) { for (let i = 0; i < n; i++) { det._poll(); await sleep(20); } }

try {
  // ── Test 1: the invariant lock — paneTarget is the stable session name, never
  // a cached %id. This alone fails on the pre-fix code (which stored a %id).
  newSession("agentA", THINK_CMD);
  await sleep(200);
  const { det: detA, session: sessA } = makeDetector("agentA");
  ok(detA.paneTarget === "agentA", `paneTarget is the session name, not a cached pane id (got ${JSON.stringify(detA.paneTarget)})`);
  ok(!/^%\d+$/.test(detA.paneTarget), "paneTarget is not a %N pane id");

  // Reads its own live pane → working.
  await pump(detA, 4);
  ok(sessA.state === "working", `agentA reads its own working pane (state=${sessA.state})`);

  // ── Test 2: the real prod repro. The SAME long-lived detector (built before
  // the churn, as at server boot) must keep reading agentA's CURRENT pane after
  // the tmux world is torn down and rebuilt — never a foreign pane that reused
  // agentA's old %id. Pre-fix (cached %id) polls the reused id → the foreign
  // working pane → stays "working". The fix targets the "agentA" name → the new
  // idle shell → done.
  const oldId = paneIdOf("agentA");           // e.g. %0
  tx(["kill-session", "-t", "agentA"]);       // frees oldId
  newSession("foreign", THINK_CMD);           // reuses the lowest free id (→ oldId)
  await sleep(200);
  const foreignId = paneIdOf("foreign");
  newSession("agentA", null);                 // recreate agentA as an IDLE bare shell (new id)
  await sleep(200);

  await pump(detA, 6);                          // shell branch → done after ≥2 shell reads

  // Deterministic invariant (independent of tmux id-reuse): the long-lived
  // detector still targets the session NAME after the churn — it never latched a
  // %id that could alias a foreign pane. Pre-fix this was a cached "%0".
  ok(detA.paneTarget === "agentA",
    `after churn, detector still targets the session name, not a cached %id (got ${JSON.stringify(detA.paneTarget)})`);

  if (foreignId === oldId) {
    ok(sessA.state !== "working",
      `long-lived detector does NOT inherit foreign pane state after churn (state=${sessA.state}, foreign reused ${oldId})`);
    ok((sessA.substatus?.type) !== "thinking",
      `substatus is not the foreign pane's thinking (${JSON.stringify(sessA.substatus)})`);
    ok(["done", "idle"].includes(sessA.state),
      `detector reads recreated agentA's own idle pane → done/idle (state=${sessA.state})`);
  } else {
    // tmux did not reuse the id this run — the foreign-alias path can't be forced,
    // but we still assert the detector reads agentA's own current (idle) pane.
    skipped++;
    console.log(`  ~ skip foreign-alias case: tmux minted ${foreignId} (not reused ${oldId})`);
    ok(["done", "idle"].includes(sessA.state),
      `detector reads recreated agentA's own current pane → done/idle (state=${sessA.state})`);
  }
  clearInterval(detA.pollTimer);
} finally {
  for (const s of ["agentA", "foreign"]) txSafe(["kill-session", "-t", s]);
  txSafe(["kill-server"]);   // private socket only — never the developer's server
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
