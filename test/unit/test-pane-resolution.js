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
 * Batching + backoff (2026-09-23, macOS field report: 57 agents → ~185 tmux
 * spawns/s → 1.45 cores of endpoint-security CPU): the per-pane display-message
 * pair became ONE `list-panes -a` batch shared by every detector polled in the
 * same tick, and capture-pane backs off on quiet panes. The live section counts
 * real tmux spawns through a PATH shim, so the saving is measured, not assumed.
 *
 * Isolation: a private tmux server via HADRON_TMUX_SOCKET (tmux -S). $TMUX would
 * otherwise win over TMUX_TMPDIR from inside a pane; -S beats $TMUX. Nothing here
 * can touch the developer's real tmux server. Live section requires: tmux, node.
 *
 * Run: node test/unit/test-pane-resolution.js
 */
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const T = mkdtempSync(join(tmpdir(), "hadron-panes-"));
const SOCK = join(T, "tmux.sock");
// Must be set BEFORE importing tmux.js (it reads the env at module load).
process.env.HADRON_TMUX_SOCKET = SOCK;
const {
  StateDetector, parseCmdProbe, stripLine, CMD_PROBE_FORMAT,
  parsePaneList, probePanes, BATCH_CMD_FORMAT, BATCH_PATH_FORMAT,
  QUIET_AFTER_POLLS, CAPTURE_BACKOFF_POLLS, livePollerCount,
} = await import("../../server/state-detector.js");
const { tmux, tmuxSafe, tmuxAsync, TMUX_TIMEOUT_MS, tmuxArgv, exactTarget } = await import("../../server/tmux.js");

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

console.log("parsePaneList (pure) — the batched list-panes read");
{
  ok(!/[\x00-\x1f]/.test(BATCH_CMD_FORMAT) && !/[\x00-\x1f]/.test(BATCH_PATH_FORMAT),
    "batch formats contain no control characters (tmux >= 3.5 rewrites them to _)");
  ok(BATCH_CMD_FORMAT.endsWith("|" + CMD_PROBE_FORMAT), "cmd line ends in the single-pane probe (alternate_on first, remainder is the command)");
  ok(BATCH_PATH_FORMAT.endsWith("|#{pane_current_path}"), "path line ends in the path — the one unbounded field on that line");

  const cmdOut = [
    "hadron-ws-a|11|0|claude",
    "hadron-ws-b|11|1|we|rd|name",      // "|" inside the command name
    "hadron-ws-b|10|0|bash",            // b's other window's pane (not active) — ignored
    "hadron-ws-c|01|0|vim",             // active pane of an inactive window — ignored
    "hadron-ws-c|11|0|node",
    "garbage-no-separator",
    "hadron-ws-d|11|0|zsh ",            // trailing space is data
    "",
  ].join("\n") + "\n";
  const pathOut = [
    "hadron-ws-a|11|/home/u/w|ith|pipes",
    "hadron-ws-b|11|",                  // empty path → null
    "hadron-ws-c|10|/not/the/active/pane",
    "hadron-ws-zzz|11|/no/cmd/line",    // path without a cmd line → ignored
    "",
  ].join("\n") + "\n";
  const m = parsePaneList(cmdOut, pathOut);
  ok(m.size === 4 && !m.has("hadron-ws-zzz") && !m.has("garbage-no-separator"),
    `4 sessions parsed, path-only and separator-less lines ignored (${[...m.keys()].join(",")})`);
  ok(m.get("hadron-ws-a")?.cmd === "claude" && m.get("hadron-ws-a")?.altScreen === false && m.get("hadron-ws-a")?.path === "/home/u/w|ith|pipes",
    `a: cmd/altScreen from the cmd line, a path full of "|" intact (${JSON.stringify(m.get("hadron-ws-a"))})`);
  ok(m.get("hadron-ws-b")?.cmd === "we|rd|name" && m.get("hadron-ws-b")?.altScreen === true && m.get("hadron-ws-b")?.path === null,
    `b: "|" inside the command preserved, altScreen=true, empty path → null, inactive pane line ignored (${JSON.stringify(m.get("hadron-ws-b"))})`);
  ok(m.get("hadron-ws-c")?.cmd === "node" && m.get("hadron-ws-c")?.path === null,
    `c: only the active-window active-pane line counts, for cmd AND path (${JSON.stringify(m.get("hadron-ws-c"))})`);
  ok(m.get("hadron-ws-d")?.cmd === "zsh ", "d: trailing space in the command is data");
  ok(parsePaneList("", "").size === 0 && parsePaneList(undefined, undefined).size === 0, "empty/undefined output → empty map, never throws");
  // The macOS tmux 3.6a symptom, batched: control chars in a hypothetical bad
  // format collapse to "_"; the parser must not throw or invent a session.
  ok(parsePaneList("hadron-ws-a_11_0_claude\n", "").size === 0, "a collapsed (all-_) line yields no session rather than garbage");
  // A foreign session named `hadron-ws-a|11` parses as a second active pane of
  // agent a; neither line may win.
  const dup = parsePaneList("hadron-ws-a|11|0|claude\nhadron-ws-a|11|11|0|bash\n", "hadron-ws-a|11|/p\n");
  ok(dup.get("hadron-ws-a")?.ambiguous === true && dup.get("hadron-ws-a").cmd === undefined,
    `duplicate active-pane lines for one name → ambiguous, no cmd/path taken from either (${JSON.stringify(dup.get("hadron-ws-a"))})`);
}

console.log("exact targets (pure) — tmux resolves a bare -t name as exact-THEN-PREFIX");
{
  ok(exactTarget("hadron-ws-dummy") === "=hadron-ws-dummy:", "bare session name → =name: (exact session match, its active pane)");
  ok(exactTarget("=already") === "=already" && exactTarget("%3") === "%3" && exactTarget("$1") === "$1",
    "already-exact, pane id and session id targets are untouched");
  ok(exactTarget("name:0.0") === "name:0.0" && exactTarget("name:1") === "name:1", "window/pane targets are untouched");
  ok(exactTarget("") === "" && exactTarget(undefined) === undefined, "empty/undefined pass through");
  const argv = tmuxArgv(["capture-pane", "-t", "hadron-ws-a", "-p"]).filter((a) => a !== "-S" && a !== SOCK);
  ok(argv.join(" ") === "capture-pane -t =hadron-ws-a: -p", `tmuxArgv rewrites every -t value (${argv.join(" ")})`);
  const argv2 = tmuxArgv(["-u", "attach-session", "-t", "hadron-ws-a"]).filter((a) => a !== "-S" && a !== SOCK);
  ok(argv2.join(" ") === "-u attach-session -t =hadron-ws-a:", "the WS terminal's attach goes through the same rewrite");
  ok(tmuxArgv(["send-keys", "-t", "%5", "x"]).includes("%5") && !tmuxArgv(["send-keys", "-t", "%5", "x"]).includes("=%5"), "a %N pane target is not rewritten");
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
  const det = new StateDetector(name, session, { poll: false });   // drive _poll() manually — no shared-ticker races
  det.skipCount = 0;              // skip the 3-poll warmup
  det.minStateDuration = 0;       // canTransition always true → deterministic
  return { det, session };
}
async function pump(det, n) { for (let i = 0; i < n; i++) { await det._poll(); await sleep(20); } }

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

    // ── Test 3: batching + backoff, MEASURED. A PATH shim logs every tmux
    // spawn (the test's own calls included — the tallies below filter by
    // subcommand), then exec's the real binary.
    {
      const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf-8" }).trim();
      const shimDir = join(T, "bin"); mkdirSync(shimDir);
      const LOG = join(T, "spawns.log");
      writeFileSync(join(shimDir, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(LOG)}\nexec ${JSON.stringify(realTmux)} "$@"\n`, { mode: 0o755 });
      process.env.PATH = `${shimDir}:${process.env.PATH}`;
      const tally = () => {
        const lines = existsSync(LOG) ? readFileSync(LOG, "utf-8").split("\n") : [];
        const n = (re) => lines.filter((l) => re.test(l)).length;
        return { list: n(/ list-panes /), capA: n(/ capture-pane -t =agentA: /), capF: n(/ capture-pane -t =foreign: /) };
      };
      const reset = () => writeFileSync(LOG, "");
      ok(execFileSync("tmux", ["-V"], { encoding: "utf-8" }).startsWith("tmux") && tally().list === 0 && existsSync(LOG),
        "PATH shim is in front of the real tmux and logs spawns");

      // Coalescing contract: two detectors polled in one synchronous loop (what
      // the shared ticker does) share ONE in-flight batch.
      const p1 = probePanes(), p2 = probePanes();
      ok(p1 === p2, "probePanes() called twice in the same tick returns the same in-flight promise");
      const panes = await p1;
      ok(panes.get("agentA")?.cmd && /^(bash|zsh|sh|dash|fish)$/.test(panes.get("agentA").cmd) && /^node$/.test(panes.get("foreign")?.cmd || ""),
        `batch reads both sessions' foreground commands (agentA=${panes.get("agentA")?.cmd} foreign=${panes.get("foreign")?.cmd})`);
      ok(panes.get("agentA")?.path === realpathSync(T), `batch carries pane_current_path (${JSON.stringify(panes.get("agentA")?.path)})`);
      { const p3 = probePanes(); p3.catch(() => {}); ok(p3 !== p1, "after it settles, the next call is a fresh read (no stale cache across ticks)"); await p3; }

      const { det: detF, session: sessF } = makeDetector("foreign");
      // The content hash samples the LAST 20 rows of the 24-row pane; push the
      // shell prompt to the bottom so what we type below lands inside the sample.
      tx(["send-keys", "-t", "agentA", "seq 1 40", "Enter"]);
      await sleep(200);
      // Warm both to a steady state: agentA idle shell (quiet), foreign working.
      const tick = async (n) => { for (let i = 0; i < n; i++) { const a = detA._poll(), f = detF._poll(); await a; await f; await sleep(20); } };
      await tick(QUIET_AFTER_POLLS + 3);
      ok(sessF.state === "working", `foreign is working (state=${sessF.state})`);
      ok(detA.quietPolls >= QUIET_AFTER_POLLS, `agentA is quiet after ${QUIET_AFTER_POLLS}+ unchanged captures (quietPolls=${detA.quietPolls}, state=${sessA.state})`);

      reset();
      const N = 2 * CAPTURE_BACKOFF_POLLS;
      await tick(N);
      let t = tally();
      ok(t.list === 2 * N, `${N} ticks × 2 detectors → ${t.list} list-panes spawns (2 per tick: cmd list + path list — NOT 2 per agent)`);
      ok(t.capF === N, `working pane never backs off: ${t.capF}/${N} capture-pane for foreign`);
      const expectA = Math.ceil(N / CAPTURE_BACKOFF_POLLS);
      ok(t.capA <= expectA && t.capA >= 1, `quiet idle pane backs off: ${t.capA} capture-pane for agentA in ${N} ticks (every ${CAPTURE_BACKOFF_POLLS}th)`);
      const perTickBefore = 3 * 2, perTickAfter = (t.list + t.capA + t.capF) / N;
      console.log(`  · spawns per tick for these 2 panes: ${perTickBefore} before → ${perTickAfter} now`);

      // wake(): the next tick captures, whatever the backoff phase.
      await tick(1); reset(); detA.wake(); await tick(1);
      ok(tally().capA === 1, "wake() (input / manual state) → the very next tick captures the quiet pane");

      // Content change on a backoff capture ends the backoff: the following
      // QUIET_AFTER_POLLS ticks all capture (the pane must re-earn quiet).
      await tick(CAPTURE_BACKOFF_POLLS + 1);   // back into quiet
      reset();
      tx(["send-keys", "-t", "agentA", "echo hadron-woke-up", "Enter"]);
      await sleep(150);
      await tick(CAPTURE_BACKOFF_POLLS + QUIET_AFTER_POLLS);
      t = tally();
      ok(t.capA >= QUIET_AFTER_POLLS + 1, `content change seen within ${CAPTURE_BACKOFF_POLLS} ticks, then full-rate for ${QUIET_AFTER_POLLS}+ (${t.capA} captures in ${CAPTURE_BACKOFF_POLLS + QUIET_AFTER_POLLS} ticks)`);

      // A foreground-command change is free (it is in the batch) and wakes the
      // pane on the same tick, even mid-backoff.
      await tick(CAPTURE_BACKOFF_POLLS + 1);
      ok(detA.quietPolls >= QUIET_AFTER_POLLS, `agentA quiet again (quietPolls=${detA.quietPolls})`);
      reset();
      tx(["send-keys", "-t", "agentA", "sleep 30", "Enter"]);
      await sleep(150);
      await tick(1);
      ok(tally().capA === 1 && detA.lastCmd === "sleep", `foreground bash → sleep wakes the pane on that tick (lastCmd=${detA.lastCmd}, captured=${tally().capA})`);
      tx(["send-keys", "-t", "agentA", "C-c", ""]);

      // Shared ticker lifecycle: detectors built without { poll: false } share
      // one interval that stops when the last one is disposed.
      ok(livePollerCount() === 0, "manually-driven detectors are not on the shared ticker");
      const d1 = new StateDetector("agentA", { id: "t1", state: "idle" }), d2 = new StateDetector("foreign", { id: "t2", state: "idle" });
      ok(livePollerCount() === 2, "two auto-polling detectors registered on the shared ticker");
      d1.dispose(); ok(livePollerCount() === 1, "dispose unregisters"); d2.dispose();
      ok(livePollerCount() === 0, "last dispose leaves nothing polling");
      detF.dispose();
    }

    // ── Test 5: prefix aliasing at the real boundary. Only "prefix2" exists;
    // every Hadron call aimed at "prefix" must fail to find it rather than
    // land on prefix2 (has-session → never created; paste → wrong agent).
    {
      newSession("prefix2", null);
      await sleep(150);
      ok(txSafe(["has-session", "-t", "prefix"]) !== null, "raw tmux: has-session -t prefix (no = ) DOES match prefix2 — the trap");
      ok(tmuxSafe(["has-session", "-t", "prefix"]) === null, "tmux.js: has-session -t prefix fails — the missing session is NOT aliased to prefix2");
      ok(tmuxSafe(["has-session", "-t", "prefix2"]) !== null, "tmux.js: has-session -t prefix2 (exact) still succeeds");
      ok(tmuxSafe(["capture-pane", "-t", "prefix", "-p"]) === null, "tmux.js: capture-pane -t prefix fails instead of reading prefix2");
      let err = null; try { tmux(["send-keys", "-t", "prefix", "echo leaked", "Enter"]); } catch (e) { err = e; }
      ok(err !== null, "tmux.js: send-keys -t prefix throws — nothing is typed into prefix2");
      await sleep(150);
      ok(!/leaked/.test(txSafe(["capture-pane", "-t", "prefix2", "-p"]) || ""), "prefix2's pane did not receive the keys");
      // The batched probe is keyed by the exact session name, so a detector for
      // "prefix" sees no pane at all (returns without a state update).
      const { det, session } = makeDetector("prefix");
      session.state = "idle";
      await det._poll();
      ok(session.state === "idle" && session.cwd === "/__unset__", `detector for the missing "prefix" reads nothing — not prefix2's pane (state=${session.state}, cwd=${session.cwd})`);
      const panes = await probePanes();
      ok(!panes.has("prefix") && panes.has("prefix2"), "batch has prefix2 and no entry for prefix");
      txSafe(["kill-session", "-t", "prefix2"]);
    }

    // ── Test 4: a tmux call that never returns cannot wedge the process.
    // `wait-for <channel>` blocks until the channel is signalled — a real,
    // deterministic never-returning client. Pre-fix tmux() had no timeout, so
    // one such call parked the whole server in kevent for good (macOS, 2026-09-17).
    {
      ok(Number.isFinite(TMUX_TIMEOUT_MS) && TMUX_TIMEOUT_MS > 0 && TMUX_TIMEOUT_MS <= 10000,
        `tmux() has a bounded default timeout (${TMUX_TIMEOUT_MS}ms)`);
      let t0 = Date.now(), err = null;
      try { tmux(["wait-for", "hadron-test-never-signalled"], { timeout: 400 }); } catch (e) { err = e; }
      const dt = Date.now() - t0;
      ok(err && dt < 3000, `never-returning tmux client is killed at the timeout, call throws (${dt}ms, ${err && (err.code || err.signal)})`);
      ok(err && err.signal === "SIGKILL", `killed with SIGKILL, not SIGTERM (got ${err && err.signal})`);
      t0 = Date.now();
      ok(tmuxSafe(["wait-for", "hadron-test-never-signalled"], { timeout: 400 }) === null && Date.now() - t0 < 3000,
        "tmuxSafe reports the hung call as null, like any failed tmux call");
      // tmuxAsync (the monitor poll path) has the same contract: bounded,
      // SIGKILL, and every failure — kill-server guard included — is a rejection.
      t0 = Date.now(); err = null;
      try { await tmuxAsync(["wait-for", "hadron-test-never-signalled"], { timeout: 400 }); } catch (e) { err = e; }
      ok(err && err.signal === "SIGKILL" && Date.now() - t0 < 3000, `tmuxAsync rejects with SIGKILL at the timeout (${Date.now() - t0}ms, ${err && err.signal})`);
      ok((await tmuxAsync(["display-message", "-p", "ok"])).trim() === "ok", "tmuxAsync resolves stdout on the private socket");
      err = null;
      try { await tmuxAsync(["kill-server"]); } catch (e) { err = e; }
      ok(err && /kill-server/.test(err.message), "tmuxAsync(kill-server) rejects (never a sync throw)");
      // The DEFAULT applies when a caller passes no timeout — that is the case
      // every monitor poll and HTTP handler is in.
      // (guarded: on pre-fix code this call would never return, and a test that
      // hangs is worse than one that fails)
      if (Number.isFinite(TMUX_TIMEOUT_MS)) {
        t0 = Date.now(); err = null;
        try { tmux(["wait-for", "hadron-test-never-signalled"]); } catch (e) { err = e; }
        const dtDefault = Date.now() - t0;
        ok(err && dtDefault > TMUX_TIMEOUT_MS * 0.8 && dtDefault < TMUX_TIMEOUT_MS + 2000,
          `with no opts the DEFAULT timeout is what bounds the call (${dtDefault}ms)`);
      } else {
        ok(false, "no default timeout exported — a caller passing no opts can hang the server");
      }
      ok(txSafe(["display-message", "-p", "ok"]) === "ok", "the tmux server itself is unaffected by killing the parked client");
    }
  } finally {
    for (const s of ["agentA", "foreign", "prefix2"]) txSafe(["kill-session", "-t", s]);
    txSafe(["kill-server"]);   // private socket only — never the developer's server
  }
}
rmSync(T, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
