/**
 * Pane-target resolution at the REAL tmux boundary, plus the pure parsers for
 * the display-message probe.
 *
 * Regression 1 — cross-agent state scramble (2026-09-06): StateDetector used to
 * resolve its pane id ONCE in the constructor and cache it for the monitor's
 * whole lifetime. tmux recycles %N pane ids after a pane dies, so a tmux-server
 * restart / session recreation left every monitor holding a stale id pointing
 * at a DIFFERENT agent's pane (states landing in the wrong box). Fix: never
 * cache a pane id, never thread a %N id across tmux calls — target the session
 * NAME in every call.
 *
 * Regression 2 — frozen states + dead auto-resume on tmux >= 3.5 (macOS, tmux
 * 3.6a): the probe packed three fields into one display-message call with a
 * TAB separator. tmux >= 3.5 rewrites every control character in that output
 * to "_", so it collapsed into one garbage field: cmd never matched an agent
 * (every state froze) and the resume tracker never saw "claude" (no checkpoint
 * ever written). tmux 3.4 preserves TAB, so Linux never showed it. Fix:
 * printable separator, the 1-char alternate_on field FIRST so the command is
 * recoverable even if it contains "|", and the path in its own single-field
 * read. Parsing is pure (parseCmdProbe / stripLine) so the edge cases below
 * run without tmux.
 *
 * Isolation: a private tmux server via HADRON_TMUX_SOCKET (tmux -S). $TMUX would
 * otherwise win over TMUX_TMPDIR from inside a pane; -S beats $TMUX. Nothing here
 * can touch the developer's real tmux server. Live section requires: tmux, node.
 *
 * Run: node test/unit/test-pane-resolution.js
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const T = mkdtempSync(join(tmpdir(), "hadron-panes-"));
const SOCK = join(T, "tmux.sock");
// Must be set BEFORE importing tmux.js (it reads the env at module load).
process.env.HADRON_TMUX_SOCKET = SOCK;
const { StateDetector, parseCmdProbe, stripLine, CMD_PROBE_FORMAT } = await import("../../server/state-detector.js");

let passed = 0, failed = 0, skipped = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tx(args) { return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
function txSafe(args) { try { return tx(args); } catch { return null; } }
function paneIdOf(sess) { return txSafe(["display-message", "-t", sess, "-p", "#{pane_id}"]); }

// ── Pure parser contract (no tmux needed) ────────────────────────────────────
console.log("parseCmdProbe / stripLine (pure)");
{
  // Static guard: reintroducing a control-char separator fails on EVERY platform,
  // not only on the tmux version that rewrites it.
  ok(!/[\x00-\x1f]/.test(CMD_PROBE_FORMAT), "probe format contains no control characters (tmux >= 3.5 rewrites them to _)");
  ok(CMD_PROBE_FORMAT.startsWith("#{alternate_on}|"), "1-char alternate_on is the FIRST field, so the separator is never ambiguous");

  let r = parseCmdProbe("1|claude\n");
  ok(r.altScreen === true && r.cmd === "claude", `basic: altScreen=true cmd=claude (${JSON.stringify(r)})`);
  r = parseCmdProbe("0|node\n");
  ok(r.altScreen === false && r.cmd === "node", `basic: altScreen=false cmd=node (${JSON.stringify(r)})`);

  // A process name containing the separator is recovered intact.
  r = parseCmdProbe("0|we|rd|name\n");
  ok(r.cmd === "we|rd|name" && r.altScreen === false, `"|" inside the command name is preserved (${JSON.stringify(r)})`);

  // Trailing whitespace is DATA — only the newline is stripped.
  r = parseCmdProbe("0|claude \n");
  ok(r.cmd === "claude ", `trailing space in command is preserved, only newline stripped (${JSON.stringify(r.cmd)})`);
  ok(stripLine("/path/with space \n") === "/path/with space ", "stripLine keeps a path's trailing space");
  ok(stripLine("/a|b/c\r\n") === "/a|b/c", "stripLine handles CRLF and leaves | in a path alone");
  ok(stripLine("") === "" && stripLine(undefined) === "", "stripLine tolerates empty/undefined");

  // The exact macOS tmux 3.6a symptom: a TAB-packed probe collapsed to "_".
  // With no separator the parser must not throw and must not invent an
  // alt-screen flag — it degrades to "whole line is the command", which the
  // agent regex then (correctly) refuses to match.
  r = parseCmdProbe("zsh_/Users/x/work_0\n");
  ok(r.altScreen === false && r.cmd === "zsh_/Users/x/work_0", `no separator → degrades safely, never throws (${JSON.stringify(r)})`);
}

// ── Live section: needs a real tmux ──────────────────────────────────────────
let haveTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { haveTmux = false; }

// A node process that prints a thinking spinner line (matches THINKING_RE) and
// holds the foreground, so pane_current_command=node (an agent) with a working
// buffer. ✳ = ✳ ; the (5s · 100 tokens) tail satisfies the duration+tokens group.
const THINK_CMD =
  "node -e \"process.stdout.write('\\u2733 Reticulating splines\\u2026 (5s \\u00b7 100 tokens)\\n');setInterval(()=>{},1e9)\"";

function newSession(name, cmd) {
  // cmd omitted → a bare login shell (bash), i.e. an idle/exited pane.
  // -c T: pane cwd is the temp dir, so pane_current_path is a known value.
  const args = ["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "-c", T];
  if (cmd) args.push(cmd);
  tx(args);
}

function makeDetector(name) {
  // cwd starts as a sentinel: _poll must replace it with the pane's real path.
  const session = { id: name, state: "idle", cwd: "/__unset__", blockReason: undefined, substatus: null };
  const det = new StateDetector(name, session);
  clearInterval(det.pollTimer);   // drive _poll() manually — no background timer races
  det.skipCount = 0;              // skip the 3-poll warmup
  det.minStateDuration = 0;       // canTransition always true → deterministic
  return { det, session };
}
async function pump(det, n) { for (let i = 0; i < n; i++) { det._poll(); await sleep(20); } }

if (!haveTmux) {
  skipped++;
  console.log("  ~ skip live tmux section: tmux not available");
} else {
  console.log("live tmux");
  try {
    // ── Test 1: the invariant lock — paneTarget is the stable session name,
    // never a cached %id. This alone fails on the pre-fix code (which stored a %id).
    newSession("agentA", THINK_CMD);
    await sleep(200);
    const { det: detA, session: sessA } = makeDetector("agentA");
    ok(detA.paneTarget === "agentA", `paneTarget is the session name, not a cached pane id (got ${JSON.stringify(detA.paneTarget)})`);
    ok(!/^%\d+$/.test(detA.paneTarget), "paneTarget is not a %N pane id");

    // Reads its own live pane → working. This proves the cmd field: state=working
    // needs pane_current_command to match AGENT_PROCESS_RE.
    await pump(detA, 4);
    ok(sessA.state === "working", `agentA reads its own working pane (state=${sessA.state})`);
    // The path field is proven separately: _poll must have replaced the sentinel
    // cwd with the pane's real path. Stays "/__unset__" if the path read broke.
    ok(sessA.cwd === realpathSync(T),
      `pane_current_path read → session.cwd (got ${JSON.stringify(sessA.cwd)})`);

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

    await pump(detA, 6);                        // shell branch → done after ≥2 shell reads

    // Deterministic invariant (independent of tmux id-reuse): the long-lived
    // detector still targets the session NAME after the churn — it never latched
    // a %id that could alias a foreign pane. Pre-fix this was a cached "%0".
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
  }
}
rmSync(T, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
