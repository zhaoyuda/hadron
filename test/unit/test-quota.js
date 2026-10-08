/**
 * Quota widget (server/quota.js, `hadron quota` / `hadron quota-sink`, GET /api/quota):
 * Claude 5h/7d usage from the JSON claude pipes into its statusLine, Codex usage
 * from the newest rollout's `rate_limits` block. Read-only sources, one explicit
 * install into ~/.claude/settings.json (relocated here via CLAUDE_CONFIG_DIR),
 * an allowlisted receipt (never the session id), never a non-zero exit from the
 * sink, expired windows dropped, /api/quota token-gated.
 *
 * Run: node test/unit/test-quota.js
 */
import "./hadron-home.js"; // private HADRON_HOME before any server spawns
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, statSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const BIN = join(REPO, "bin", "hadron.js");
const PORT = 6500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const TMP = mkdtempSync(join(tmpdir(), "hadron-quota-"));
const CFG = join(TMP, "claude");
const CODEX = join(TMP, "codex");
const WS = join(TMP, "ws");
mkdirSync(CFG, { recursive: true }); mkdirSync(WS);
process.env.CLAUDE_CONFIG_DIR = CFG;
process.env.CODEX_HOME = CODEX;
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: CFG, CODEX_HOME: CODEX, HADRON_PORT: String(PORT), TMUX: "" };
// Import AFTER the env is set: the module reads CLAUDE_CONFIG_DIR / CODEX_HOME at load.
const Q = await import("../../server/quota.js");

const nowS = Math.floor(Date.now() / 1000);
const claudeStdin = (five, seven, extra = {}) => JSON.stringify({
  session_id: "SECRET-SESSION-ID", cwd: "/secret/cwd", model: { id: "claude-x" },
  context_window: { used_percentage: 42 },
  rate_limits: { five_hour: five, seven_day: seven, spend_limit: { used_percentage: 1 } }, ...extra,
});
const codexLine = (primary, secondary, ts = new Date().toISOString(), plan = "plus") => JSON.stringify({
  timestamp: ts, type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1 } }, rate_limits: { limit_id: "codex", primary, secondary, credits: { has_credits: false }, plan_type: plan } },
}) + "\n";
const win = (usedPct, minutes, resetsAt) => ({ used_percent: usedPct, window_minutes: minutes, resets_at: resetsAt });

function hadron(args, { input, env = {} } = {}) {
  const r = spawnSync("node", [BIN, ...args], { encoding: "utf-8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...ENV, ...env }, timeout: 20000 });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}

let server = null;
async function boot() {
  server = spawn("node", [join(REPO, "server", "index.js"), WS], { env: { ...ENV, PORT: String(PORT), HADRON_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {} await sleep(200); }
  throw new Error("server did not start");
}
function stop() { if (server) { server.kill("SIGKILL"); server = null; } }

try {
  console.log("\n[pickClaudeRateLimits — allowlist]");
  const picked = Q.pickClaudeRateLimits(JSON.parse(claudeStdin({ used_percentage: 28.4, resets_at: nowS + 7200 }, { used_percentage: 4, resets_at: nowS + 86400 })));
  ok(JSON.stringify(picked) === JSON.stringify({ five_hour: { used_percentage: 28, resets_at: nowS + 7200 }, seven_day: { used_percentage: 4, resets_at: nowS + 86400 } }), `only five_hour/seven_day {used_percentage (rounded), resets_at} survive (${JSON.stringify(picked)})`);
  ok(Q.pickClaudeRateLimits(JSON.parse(claudeStdin({ used_percentage: 28 }, undefined))).seven_day === undefined && Q.pickClaudeRateLimits(JSON.parse(claudeStdin({ used_percentage: 28 }, undefined))).five_hour.resets_at === null, "a window without resets_at keeps the percentage with resets_at null; a missing window is absent");
  ok(Q.pickClaudeRateLimits({ context_window: { used_percentage: 5 } }) === null, "no rate_limits (API-key session) → null");
  ok(Q.pickClaudeRateLimits({ rate_limits: { five_hour: { used_percentage: "lots" } } }) === null && Q.pickClaudeRateLimits(null) === null && Q.pickClaudeRateLimits("x") === null, "malformed payloads → null");
  ok(Q.pickClaudeRateLimits({ rate_limits: { five_hour: { used_percentage: 140, resets_at: String(nowS) } } }).five_hour.used_percentage === 100 && Q.epochSeconds((nowS + 5) * 1000) === nowS + 5 && Q.epochSeconds("2026-01-01T00:00:00Z") === 1767225600, "percent clamped to 0..100; resets_at accepts epoch s, epoch ms, ISO");

  console.log("\n[writeReceipt / readClaudeQuota]");
  const receipt = join(CFG, "hadron-quota.json");
  const rl1 = { five_hour: { used_percentage: 28, resets_at: nowS + 7200 }, seven_day: { used_percentage: 4, resets_at: nowS + 86400 } };
  ok(Q.writeReceipt(rl1) === true && existsSync(receipt), "first receipt written");
  ok(!readFileSync(receipt, "utf-8").includes("SECRET"), "receipt carries no session id / cwd");
  ok(Q.writeReceipt(rl1) === false, "identical numbers within the refresh window → no rewrite");
  const oldAt = new Date(Date.now() - Q.RECEIPT_REFRESH_MS - 1000).toISOString();
  writeFileSync(receipt, JSON.stringify({ at: oldAt, rate_limits: rl1 }));
  ok(Q.writeReceipt(rl1) === true && readFileSync(receipt, "utf-8").includes(oldAt) === false, "identical numbers but a receipt older than the refresh window → rewritten with a fresh `at`");
  ok(Q.writeReceipt({ five_hour: { used_percentage: 29, resets_at: nowS + 7200 } }) === true, "changed numbers → rewritten");
  ok(Q.writeReceipt(null) === false, "nothing to write → no file touched");
  ok(!existsSync(`${receipt}.${process.pid}.tmp`), "no temp file left behind (atomic rename)");
  Q.writeReceipt(rl1);
  let rc = Q.readClaudeQuota();
  ok(rc && rc.source === "statusline" && rc.windows.length === 2 && rc.windows[0].label === "5h" && rc.windows[0].usedPct === 28 && rc.windows[1].label === "7d" && rc.windows[1].resetsAt === nowS + 86400 && Number.isFinite(Date.parse(rc.at)), `reader: two windows with labels, pct, resets_at, at (${JSON.stringify(rc)})`);
  rc = Q.readClaudeQuota({ now: (nowS + 7300) * 1000 });
  ok(rc && rc.windows.length === 1 && rc.windows[0].label === "7d", "a window whose resets_at has passed is dropped (5h gone, 7d stays)");
  ok(Q.readClaudeQuota({ now: (nowS + 90000) * 1000 }) === null, "all windows expired → null (unknown, not 'still 28%')");
  writeFileSync(receipt, "{not json");
  ok(Q.readClaudeQuota() === null, "garbage receipt → null");
  writeFileSync(receipt, JSON.stringify({ at: "x", rate_limits: { five_hour: { used_percentage: 10 } } }));
  ok(Q.readClaudeQuota()?.at === null && Q.readClaudeQuota()?.windows[0].usedPct === 10, "receipt with a bad timestamp and no resets_at still reads (at null, window kept)");
  rmSync(receipt);
  ok(Q.readClaudeQuota() === null, "no receipt → null");

  console.log("\n[readCodexQuota — newest rollout, tail parse]");
  ok(Q.readCodexQuota() === null, "no CODEX_HOME/sessions → null");
  const day = (y, m, d) => { const p = join(CODEX, "sessions", y, m, d); mkdirSync(p, { recursive: true }); return p; };
  const dOld = day("2026", "09", "28"), dNew = day("2026", "09", "29");
  const fOld = join(dOld, "rollout-2026-09-28T10-00-00-aaaa.jsonl");
  const fNew = join(dNew, "rollout-2026-09-29T10-00-00-bbbb.jsonl");
  writeFileSync(fOld, `{"type":"session_meta","payload":{"id":"SECRET"}}\n` + codexLine(win(61, 300, nowS + 3000), win(9, 10080, nowS + 500000), "2026-09-28T10:00:00.000Z"));
  writeFileSync(fNew, `{"type":"session_meta","payload":{"id":"SECRET"}}\n` + codexLine(win(12, 300, nowS + 3000), win(3, 10080, nowS + 500000), "2026-09-29T10:00:00.000Z"));
  let cq = Q.readCodexQuota();
  ok(cq && cq.source === "rollout" && cq.plan === "plus" && cq.windows.map((w) => `${w.label}=${w.usedPct}`).join(",") === "5h=12,7d=3" && cq.at === "2026-09-29T10:00:00.000Z", `newest file wins: primary/secondary → 5h/7d with plan and the record's timestamp (${JSON.stringify(cq)})`);
  // Yesterday's session is still the one being written to → newest by mtime, not by day dir.
  const later = new Date(Date.now() + 5000);
  utimesSync(fOld, later, later);
  cq = Q.readCodexQuota();
  ok(cq && cq.windows[0].usedPct === 61, "a rollout in an older day dir with a newer mtime wins (a session that started yesterday)");
  const past = new Date(Date.now() - 3600_000);
  utimesSync(fOld, past, past); // back to being the older file for the rest
  // Several rate_limits lines: the LAST one counts; a line after it without rate_limits is ignored.
  writeFileSync(fNew, codexLine(win(12, 300, nowS + 3000), win(3, 10080, nowS + 500000)) + codexLine(win(77, 300, nowS + 3000), win(30, 10080, nowS + 500000)) + `{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}\n`);
  cq = Q.readCodexQuota();
  ok(cq && cq.windows[0].usedPct === 77 && cq.windows[1].usedPct === 30, "the last rate_limits line in the file is the current picture");
  // Torn tail: the first line of the read window is cut mid-record → skipped, the next full line parses.
  const pad = `{"type":"event_msg","payload":{"type":"agent_message","message":"${"x".repeat(1000)}"}}\n`;
  writeFileSync(fNew, codexLine(win(55, 300, nowS + 3000), win(5, 10080, nowS + 500000)) + pad.repeat(Math.ceil(Q.CODEX_TAIL_BYTES / pad.length) + 2));
  ok(Q.readCodexQuota()?.windows[0].usedPct === 61, "a rate_limits line beyond the tail window is not seen — same as a fresh session: the previous rollout's picture (its own `at` says how old)");
  const tornTail = codexLine(win(1, 300, nowS + 3000), win(1, 10080, nowS + 500000)).slice(40) + codexLine(win(88, 300, nowS + 3000), win(6, 10080, nowS + 500000));
  writeFileSync(fNew, "x".repeat(Q.CODEX_TAIL_BYTES - tornTail.length + 30) + "\n" + tornTail);
  ok(Q.parseCodexRateLimits(readFileSync(fNew, "utf-8").slice(-Q.CODEX_TAIL_BYTES))?.windows[0].usedPct === 88, "a torn first line in the tail is skipped, the full line after it parses");
  writeFileSync(fNew, codexLine(win(50, 300, nowS - 10), win(6, 10080, nowS + 500000)));
  cq = Q.readCodexQuota();
  ok(cq && cq.windows.length === 1 && cq.windows[0].label === "7d", "an expired primary window is dropped, secondary stays");
  writeFileSync(fNew, codexLine(null, null));
  ok(Q.readCodexQuota() === null, "rate_limits with null windows (no plan info yet) → null");
  writeFileSync(fNew, `{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":40,"window_minutes":300,"resets_at":${nowS + 3000}},"plan_type":${JSON.stringify("p".repeat(100))}}}}\n`);
  cq = Q.readCodexQuota();
  ok(cq && cq.plan.length === 32 && cq.windows.length === 1 && cq.at !== "t", "plan string capped at 32 chars; a bad record timestamp falls back to the file mtime");
  writeFileSync(fNew, codexLine(win(12, 300, nowS + 3000), win(3, 10080, nowS + 500000)));
  // A codex that has just launched owns the newest rollout but has not emitted rate_limits yet.
  const fFresh = join(dNew, "rollout-2026-09-29T11-00-00-cccc.jsonl");
  writeFileSync(fFresh, `{"type":"session_meta","payload":{"id":"SECRET"}}\n`);
  const fresher = new Date(statSync(fNew).mtimeMs + 5000);
  utimesSync(fFresh, fresher, fresher); // strictly newer than fNew (back-to-back writes can share an mtime)
  cq = Q.readCodexQuota();
  ok(cq && cq.windows[0].usedPct === 12, `newest rollout has no rate_limits yet (codex just launched) → the previous rollout's picture, not a blank (${JSON.stringify(cq?.windows)}; order ${Q.recentRollouts(CODEX).map((f) => basename(f.path).slice(8, 27) + "@" + f.mtimeMs)})`);
  ok(Q.recentRollouts(CODEX).map((f) => basename(f.path)).join(",") === [fFresh, fNew, fOld].map((f) => basename(f)).join(","), "recentRollouts: newest-first by mtime across day dirs");
  writeFileSync(fFresh, codexLine(win(50, 300, nowS - 10), win(6, 10080, nowS - 10)));
  utimesSync(fFresh, fresher, fresher);
  ok(Q.readCodexQuota() === null, "newest rollout says every window has reset → null (never falls back to an older, staler picture)");
  rmSync(fFresh);

  console.log("\n[hadron quota-sink — the statusline filter]");
  const stdin = claudeStdin({ used_percentage: 28.4, resets_at: nowS + 7200 }, { used_percentage: 4, resets_at: nowS + 86400 });
  let r = hadron(["quota-sink", "--tee"], { input: stdin });
  ok(r.status === 0 && r.out === stdin, "--tee echoes claude's JSON byte-for-byte (the wrapped statusline still gets it) and exits 0");
  ok(existsSync(receipt) && !readFileSync(receipt, "utf-8").includes("SECRET") && JSON.parse(readFileSync(receipt, "utf-8")).rate_limits.five_hour.used_percentage === 28, "…and the receipt is written, allowlisted");
  r = hadron(["quota-sink"], { input: stdin });
  ok(r.status === 0 && r.out === "5h 28% · 7d 4%\n", `bare sink prints a compact statusline (${JSON.stringify(r.out)})`);
  r = hadron(["quota-sink", "--tee"], { input: "not json at all\n" });
  ok(r.status === 0 && r.out === "not json at all\n" && r.err === "", "garbage stdin: echoed unchanged, exit 0, nothing on stderr");
  r = hadron(["quota-sink"], { input: JSON.stringify({ context_window: { used_percentage: 3 } }) });
  ok(r.status === 0 && r.out === "", "no rate_limits (API-key session): prints nothing, exit 0");
  r = hadron(["quota-sink"]);
  ok(r.status === 0 && r.out === "", "no stdin at all: exit 0, nothing printed");
  r = hadron(["quota-sink", "--tee"], { input: stdin, env: { CLAUDE_CONFIG_DIR: "/dev/null/x" } });
  ok(r.status === 0 && r.out === stdin, "unwritable config dir: still echoes and exits 0 (a failing statusline is one claude stops showing)");
  const big = JSON.stringify({ rate_limits: JSON.parse(stdin).rate_limits, pad: "y".repeat(900 * 1024) });
  r = hadron(["quota-sink", "--tee"], { input: big });
  ok(r.status === 0 && r.out.length === big.length && r.out === big, `--tee of a ${Math.round(big.length / 1024)} KB payload is echoed whole (a pipe buffer is 64 KB; exit waits for stdout to drain — ${r.out.length} bytes)`);
  const huge = "z".repeat(Q.STDIN_MAX_BYTES + 10);
  r = hadron(["quota-sink"], { input: huge });
  ok(r.status === 0 && r.out === "", "stdin over the cap: not parsed, exit 0");
  r = hadron(["quota-sink", "--bogus"], { input: stdin });
  ok(r.status === 1 && /unknown option: --bogus/.test(r.err), "unknown flag is still rejected up front (install writes the exact command, so this can only be a typo)");

  console.log("\n[hadron quota --install / --uninstall]");
  const settings = join(CFG, "settings.json");
  r = hadron(["quota", "--install"]);
  let st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && st.statusLine.type === "command" && /quota-sink$/.test(st.statusLine.command) && !/--tee/.test(st.statusLine.command), `no settings.json → bare sink installed (${st.statusLine.command})`);
  ok(st.statusLine.command.includes(`'${BIN}'`) && st.statusLine.command.startsWith(`'${process.execPath}'`), "…with absolute node + hadron.js paths (a statusline runs with claude's PATH, not ours)");
  r = hadron(["quota", "--install"]);
  ok(r.status === 0 && /already installed/.test(r.out) && JSON.stringify(JSON.parse(readFileSync(settings, "utf-8"))) === JSON.stringify(st), "second --install is a no-op");
  r = hadron(["quota", "--uninstall"]);
  ok(r.status === 0 && !("statusLine" in JSON.parse(readFileSync(settings, "utf-8"))), "--uninstall removes the entry we added (there was none before)");
  r = hadron(["quota", "--uninstall"]);
  ok(r.status === 0 && /not installed/.test(r.out), "--uninstall twice: nothing to do, exit 0");
  writeFileSync(settings, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls:*)"] }, statusLine: { type: "command", command: "bash ~/.claude/sl.sh", padding: 0 } }, null, 2));
  r = hadron(["quota", "--install"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && /quota-sink --tee \| bash ~\/\.claude\/sl\.sh$/.test(st.statusLine.command) && st.statusLine.padding === 0 && st.model === "opus" && st.permissions.allow[0] === "Bash(ls:*)", `existing statusline is wrapped (sink --tee | previous), every other key untouched (${st.statusLine.command})`);
  ok(existsSync(`${settings}.hadron-bak`) && JSON.parse(readFileSync(`${settings}.hadron-bak`, "utf-8")).statusLine.command === "bash ~/.claude/sl.sh", "the previous settings.json is backed up beside it");
  r = hadron(["quota", "--uninstall"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && st.statusLine.command === "bash ~/.claude/sl.sh" && st.statusLine.padding === 0 && st.model === "opus", "--uninstall restores exactly the previous command");
  writeFileSync(settings, "{ broken json");
  r = hadron(["quota", "--install"]);
  ok(r.status === 1 && /not valid JSON/.test(r.err) && readFileSync(settings, "utf-8") === "{ broken json", "a settings.json that is not JSON: refused, exit 1, file untouched");
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "static", text: "hi" } }));
  r = hadron(["quota", "--install"]);
  ok(r.status === 1 && /not "command"/.test(r.err) && JSON.parse(readFileSync(settings, "utf-8")).statusLine.text === "hi", "a non-command statusLine is refused, untouched");
  writeFileSync(settings, JSON.stringify({ statusLine: "bash x.sh" }));
  r = hadron(["quota", "--install"]);
  ok(r.status === 1 && /not an object/.test(r.err) && JSON.parse(readFileSync(settings, "utf-8")).statusLine === "bash x.sh", "a string statusLine is refused, untouched");
  // A sink installed from a checkout that is gone (worktree removed): repoint it, keep what it wrapped.
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "'/usr/bin/node' '/home/x/old-hadron/bin/hadron.js' quota-sink --tee | bash ~/.claude/sl.sh" } }));
  r = hadron(["quota", "--install"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && /repointed/.test(r.out) && st.statusLine.command.includes(`'${BIN}'`) && !st.statusLine.command.includes("old-hadron") && /quota-sink --tee \| bash ~\/\.claude\/sl\.sh$/.test(st.statusLine.command), `a sink from another checkout is repointed at this one, the wrapped statusline kept (${st.statusLine.command})`);
  r = hadron(["quota"]);
  ok(/^sink\s+installed in claude's statusLine/m.test(r.out), "…and `hadron quota` calls it installed");
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "'/usr/bin/node' '/home/x/old-hadron/bin/hadron.js' quota-sink" } }));
  r = hadron(["quota"]);
  ok(/^sink\s+installed from ANOTHER checkout/m.test(r.out), "a bare sink from another checkout: `hadron quota` says so instead of \"installed\"");
  r = hadron(["quota", "--install"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && /repointed/.test(r.out) && st.statusLine.command === `'${process.execPath}' '${BIN}' quota-sink`, "a bare sink from another checkout is repointed, still bare");
  ok(Q.SINK_MARK.test(Q.sinkCommand("/usr/bin/node", "/home/o'brien/my hadron/bin/hadron.js")) && Q.SINK_MARK.test(Q.sinkCommand("/usr/bin/node", "/x/hadron.js") + " --tee | bash x.sh"), "SINK_MARK matches our own sinkCommand, quoted single quote in the path included, wrapped or bare");
  // A statusline that merely MENTIONS quota-sink is the user's command: wrapped, then unwrapped — never repointed or removed.
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "bash /my/sl.sh --mode quota-sink extra" } }));
  r = hadron(["quota", "--install"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && !/repointed/.test(r.out) && /quota-sink --tee \| bash \/my\/sl\.sh --mode quota-sink extra$/.test(st.statusLine.command), `a user command that mentions quota-sink is wrapped like any other (${st.statusLine.command})`);
  r = hadron(["quota", "--uninstall"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && st.statusLine.command === "bash /my/sl.sh --mode quota-sink extra", "…and uninstall gives it back exactly");
  r = hadron(["quota", "--uninstall"]);
  ok(r.status === 0 && /not installed/.test(r.out) && JSON.parse(readFileSync(settings, "utf-8")).statusLine.command === "bash /my/sl.sh --mode quota-sink extra", "a second uninstall does not mistake it for ours");
  // Bare install on a statusLine that had only padding: uninstall keeps the padding.
  writeFileSync(settings, JSON.stringify({ statusLine: { padding: 0 } }));
  r = hadron(["quota", "--install"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && /quota-sink$/.test(st.statusLine.command) && st.statusLine.padding === 0, "install over {padding:0}: bare sink, padding kept");
  r = hadron(["quota", "--uninstall"]);
  st = JSON.parse(readFileSync(settings, "utf-8"));
  ok(r.status === 0 && JSON.stringify(st.statusLine) === JSON.stringify({ padding: 0 }), `uninstall of that: only type/command removed, padding stays (${JSON.stringify(st.statusLine)})`);
  r = hadron(["quota", "--install", "--uninstall"]);
  ok(r.status === 1 && /choose one/.test(r.err), "--install --uninstall together is an error");
  writeFileSync(settings, JSON.stringify({ model: "opus" }));

  console.log("\n[hadron quota — local read, no server]");
  r = hadron(["quota", "--install"]);
  hadron(["quota-sink"], { input: stdin });
  r = hadron(["quota"]);
  ok(r.status === 0 && /^claude 5h 28% \(resets in \d+h \d+m\)\s+·\s+7d 4% \(resets in \d+h \d+m\)\s+as of 0m ago$/m.test(r.out) && /^codex\s+5h 12% \(resets in \d+m\)\s+·\s+7d 3%/m.test(r.out) && /^sink\s+installed/m.test(r.out), `text form: claude + codex lines with reset countdowns, sink status\n${r.out}`);
  r = hadron(["quota", "--json"]);
  const j = JSON.parse(r.out);
  ok(r.status === 0 && j.claude.windows.length === 2 && j.codex.windows.length === 2 && j.sink.installed === true && !r.out.includes("SECRET"), "--json: {claude, codex, at, sink} — no secrets");
  ok(r.status === 0 && /quota-sink/.test(j.sink.command), "…sink.command names the installed filter");
  hadron(["quota", "--uninstall"]);
  r = hadron(["quota"]);
  ok(/^sink\s+not installed — `hadron quota --install`/m.test(r.out) && /^claude 5h 28%/m.test(r.out), "not installed: says so, still shows the receipt it has");
  r = hadron(["quota", "--help"]);
  ok(r.status === 0 && /hadron quota \[--json\]/.test(r.out), "`hadron quota --help` prints usage");

  console.log("\n[generic sources: hadron-quota.d/<name>.json]");
  {
    const { parseQuotaSource, readQuotaSources, SOURCES_DIR, SOURCE_STALE_MS } = Q;
    const nowMs = Date.now(), nowS2 = Math.floor(nowMs / 1000);
    const good = { at: new Date(nowMs - 60000).toISOString(), label: "LiteLLM", windows: [{ label: "1mo", usedPct: 9.4, resetsAt: nowS2 + 86400 * 20 }, { label: "day", usedPct: 55, resetsAt: null }] };
    const p = parseQuotaSource(good, { now: nowMs });
    ok(p.label === "LiteLLM" && p.windows.length === 2 && p.windows[0].usedPct === 9 && p.windows[0].resetsAt === nowS2 + 86400 * 20 && p.windows[1].resetsAt === null, `the contract parses, usedPct rounded, resetsAt null allowed (${JSON.stringify(p.windows)})`);
    ok(parseQuotaSource({ ...good, windows: [{ label: "1mo", usedPct: 9, resetsAt: nowS2 - 5 }] }, { now: nowMs }).windows.length === 0, "a window whose reset passed is dropped (none left → nothing to show)");
    ok(p.windows[0].detail === null && p.windows[0].level === null && Array.isArray(p.notes) && p.notes.length === 0, "detail/level absent → null on the window, no note");
    // Optional per-window detail + level; unknown keys at both levels (a writer's own `budget` block) are allowed, silently.
    const rich = { ...good, budget: { monthlyUsd: 50, note: "claude-hud reads this" }, windows: [{ label: "1mo", usedPct: 12, resetsAt: nowS2 + 86400, detail: "$6.10 of $50", level: "ok", extra: 1 }, { label: "day", usedPct: 12, level: "bad", detail: "daily cap hit" }, { label: "wk", usedPct: 70, level: "warn", detail: null }] };
    const pr = parseQuotaSource(rich, { now: nowMs });
    ok(pr.windows.length === 3 && pr.windows[0].detail === "$6.10 of $50" && pr.windows[0].level === "ok" && pr.windows[1].level === "bad" && pr.windows[1].detail === "daily cap hit" && pr.windows[2].level === "warn" && pr.windows[2].detail === null && pr.notes.length === 0, `detail (≤ 80 printable) and level (ok/warn/bad) ride on the window; a null detail is absent (${JSON.stringify(pr.windows)})`);
    ok(!("budget" in pr) && !("extra" in pr.windows[0]) && JSON.stringify(pr).indexOf("claude-hud") === -1, "unknown top-level and window keys are allowed and not forwarded (the file stays the writer's — no reserved key needed)");
    const lax = { ...good, windows: [{ label: "1mo", usedPct: 12, detail: "x".repeat(81), level: "purple" }, { label: "day", usedPct: 55, detail: "a\nb", level: 2 }, { label: "wk", usedPct: 1, detail: " padded", level: "BAD" }, { label: "ok", usedPct: 1, detail: "", level: "ok" }] };
    const pl = parseQuotaSource(lax, { now: nowMs });
    ok(pl.windows.length === 4 && pl.windows.every((w) => w.detail === null) && pl.windows.slice(0, 3).every((w) => w.level === null) && pl.windows[3].level === "ok", `an out-of-contract detail/level is dropped per FIELD — the window and the other field stay; "" is absent (${JSON.stringify(pl.windows.map((w) => [w.label, w.usedPct, w.detail, w.level]))})`);
    ok(pl.notes.length === 6 && /^windows\[0\] \("1mo"\)\.detail ignored: must be a string of 1-80 printable characters$/.test(pl.notes[0]) && /^windows\[0\] \("1mo"\)\.level ignored: must be "ok", "warn" or "bad" \(lower-case\)$/.test(pl.notes[1]) && /windows\[1\] \("day"\)\.detail/.test(pl.notes[2]) && /windows\[1\] \("day"\)\.level/.test(pl.notes[3]) && /windows\[2\] \("wk"\)\.detail/.test(pl.notes[4]) && /windows\[2\] \("wk"\)\.level/.test(pl.notes[5]), `…each named in notes[] by window index, label and field; an empty detail is no note (${pl.notes.join(" | ")})`);
    ok(!/purple|BAD|padded/.test(pl.notes.join("\n")), "the rejected value is never echoed (attacker-shaped text)");
    for (const bad of ["a\u2028b", "a\u2029b", "\u202Eabc", "a\u200Bb", "\uFEFFx"]) { const r = parseQuotaSource({ ...good, windows: [{ label: "1mo", usedPct: 1, detail: bad }] }, { now: nowMs }); ok(r.windows[0].detail === null && r.notes.length === 1, `a Unicode line separator / bidi override / zero-width in detail is out of contract (${JSON.stringify(bad)})`); }
    const gone = parseQuotaSource({ ...good, windows: [{ label: "gone", usedPct: 1, resetsAt: nowS2 - 5, level: "purple" }, { label: "live", usedPct: 5 }] }, { now: nowMs });
    ok(gone.windows.length === 1 && gone.windows[0].label === "live" && gone.notes.length === 1 && /^windows\[0\] \("gone"\)\.level ignored/.test(gone.notes[0]), `a note on an expired window still names it by label — the index alone would point at the wrong row (${gone.notes[0]})`);
    const bad = [
      [null, /object/], [[], /object/], [{ ...good, label: "" }, /label/], [{ ...good, label: "x".repeat(33) }, /label/], [{ ...good, label: "a\nb" }, /label/], [{ ...good, label: " pad" }, /label/],
      [{ ...good, at: "yesterday" }, /ISO/], [{ ...good, at: new Date(nowMs + 3600000).toISOString() }, /future/], [{ ...good, windows: [] }, /1-8/], [{ ...good, windows: new Array(9).fill(good.windows[0]) }, /1-8/],
      [{ ...good, windows: [1] }, /windows\[0\] is not an object/], [{ ...good, windows: [{ label: "1mo", usedPct: "9" }] }, /usedPct/], [{ ...good, windows: [{ label: "1mo", usedPct: 101 }] }, /usedPct/],
      [{ ...good, windows: [{ label: "1mo", usedPct: 9, resetsAt: "soon" }] }, /resetsAt/], [{ ...good, windows: [{ label: "", usedPct: 9 }] }, /windows\[0\]\.label/],
      [{ ...good, windows: [{ label: "1mo", usedPct: 1 }, { label: "1mo", usedPct: 2 }] }, /distinct/],
      [{ ...good, windows: [{ label: "1mo", usedPct: 9, resetsAt: nowS2 - 5 }, { label: "x", usedPct: "bad" }] }, /usedPct/],
    ];
    let rejected = 0;
    for (const [rec, re] of bad) { try { parseQuotaSource(rec, { now: nowMs }); } catch (e) { if (re.test(e.message)) rejected++; else console.log(`    (unexpected reason: ${e.message})`); } }
    ok(rejected === bad.length, `${rejected}/${bad.length} out-of-contract records refused with the field named (an expired bad window still fails the file)`);
    const dir = join(CFG, SOURCES_DIR);
    ok(readQuotaSources({ configDir: CFG, now: nowMs }).sources.length === 0, "no directory → no sources, no problems");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "litellm.json"), JSON.stringify(good));
    // Stays for the API/doctor/CLI block below: detail + level, a writer's own budget block, one ignored level.
    writeFileSync(join(dir, "budget.json"), JSON.stringify({ at: good.at, label: "Budget", budget: { monthlyUsd: 50 }, windows: [{ label: "1mo", usedPct: 12, detail: "$6.10 of $50", level: "ok" }, { label: "day", usedPct: 12, level: "bad", detail: "daily cap hit", resetsAt: nowS2 + 3600 }, { label: "wk", usedPct: 3, level: "red" }] }));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "half.json"), JSON.stringify({ ...good, label: "Half", windows: [{ label: "ok", usedPct: 50 }, { label: "bad", usedPct: -1 }] }));
    writeFileSync(join(dir, "old.json"), JSON.stringify({ ...good, label: "Old", at: new Date(nowMs - SOURCE_STALE_MS - 1000).toISOString() }));
    writeFileSync(join(dir, "reset.json"), JSON.stringify({ ...good, label: "Reset", windows: [{ label: "1mo", usedPct: 9, resetsAt: nowS2 - 5 }] }));
    writeFileSync(join(dir, "reset-typo.json"), JSON.stringify({ ...good, label: "ResetTypo", windows: [{ label: "1mo", usedPct: 9, resetsAt: nowS2 - 5, level: "Bad" }] }));
    writeFileSync(join(dir, "bad name.json"), JSON.stringify(good));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    writeFileSync(join(dir, "big.json"), JSON.stringify({ ...good, label: "Big", windows: [{ label: "1mo", usedPct: 1 }], pad: "x".repeat(70000) }));
    symlinkSync(join(dir, "gone-elsewhere.json"), join(dir, "dangling.json")); // a writer mid-rename, or a stale link
    mkdirSync(join(dir, "adir.json"));
    writeFileSync(join(dir, "esc\x1b[31mred.json"), JSON.stringify(good));
    const r2 = readQuotaSources({ configDir: CFG, now: nowMs });
    const lite = r2.sources.find((v) => v.name === "litellm"), budget = r2.sources.find((v) => v.name === "budget");
    const typo = r2.sources.find((v) => v.name === "reset-typo");
    ok(r2.sources.length === 3 && lite && lite.label === "LiteLLM" && lite.source === "file" && lite.windows.length === 2 && lite.notes.length === 0, `only the good files are sources (${JSON.stringify(r2.sources.map((v) => v.name))})`);
    ok(typo && typo.windows.length === 0 && typo.notes.length === 1 && /\("1mo"\)\.level ignored/.test(typo.notes[0]) && !r2.sources.some((v) => v.name === "reset") && !("reset-typo" in Object.fromEntries(r2.problems.map((x) => [x.name, 1]))), `a fully reset receipt with a note stays a (windowless) source so the typo is named now, not when the window comes back; without a note it is dropped (${JSON.stringify(typo && typo.notes)})`);
    ok(budget && budget.windows.length === 3 && budget.windows[1].level === "bad" && budget.windows[1].detail === "daily cap hit" && budget.windows[2].level === null && budget.notes.length === 1 && /^windows\[2\] \("wk"\)\.level ignored/.test(budget.notes[0]) && !("budget" in budget), `a file with an ignored level is still a source, the note rides on it, its own budget block is not forwarded (${JSON.stringify(budget && budget.notes)})`);
    const probs = Object.fromEntries(r2.problems.map((x) => [x.name, x.error]));
    ok(/JSON/.test(probs.broken) && /usedPct/.test(probs.half) && /stale/.test(probs.old) && /file name/.test(probs["bad name"]) && /bytes/.test(probs.big) && !("reset" in probs) && !("notes" in probs), `each skipped file is a named problem — invalid JSON, one bad window fails the whole file, stale, bad name, too big; a fully reset receipt is not a problem (${JSON.stringify(probs)})`);
    ok(/^unreadable \(ENOENT\)$/.test(probs.dangling) && probs.adir === "not a regular file", `a dangling symlink and a directory are problems with a code, not a path (${probs.dangling} / ${probs.adir})`);
    const files = Object.fromEntries(r2.problems.map((x) => [x.name, x.file]));
    ok(files["bad name"] === "hadron-quota.d/bad name.json" && files.broken === "hadron-quota.d/broken.json" && files["esc?[31mred"] === "hadron-quota.d/esc?[31mred.json", `problems carry the display path, control characters stripped from the file name (${files["esc?[31mred"]})`);
    ok(!JSON.stringify(r2).includes(CFG) && !/\x1b/.test(JSON.stringify(r2)), "no file path and no control character in the result");
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.json`), "{ nope");
    const r3 = readQuotaSources({ configDir: CFG, now: nowMs });
    const over = r3.problems.find((x) => x.name === SOURCES_DIR);
    ok(over && over.file === SOURCES_DIR && /32 files, only the first 16 by name are read — 16 skipped, the first of them f\d\d\.json/.test(over.error), `over the file cap the row says how many were skipped and where they start (${over && over.error})`);
    for (let i = 0; i < 20; i++) rmSync(join(dir, `f${String(i).padStart(2, "0")}.json`));
    for (const f of ["broken", "half", "old", "reset", "reset-typo", "big", "bad name", "dangling", "esc\x1b[31mred"]) rmSync(join(dir, `${f}.json`));
    rmSync(join(dir, "adir.json"), { recursive: true });
    rmSync(join(dir, "notes.txt"));
  }

  console.log("\n[GET /api/quota + doctor row]");
  await boot();
  const token = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  let res = await fetch(`${BASE}/api/quota`);
  ok(res.status === 401, "GET /api/quota without a token → 401 (account information is not open)");
  res = await fetch(`${BASE}/api/quota`, { headers: { "x-hadron-token": token } });
  let body = await res.json();
  ok(res.status === 200 && body.claude.windows.length === 2 && body.claude.source === "statusline" && body.codex.windows.length === 2 && body.codex.source === "rollout" && typeof body.at === "string", `with the token: {claude, codex, at} (${JSON.stringify(body).slice(0, 160)}…)`);
  ok(!JSON.stringify(body).includes("SECRET") && !JSON.stringify(body).includes(CODEX) && !JSON.stringify(body).includes(CFG), "payload carries no session id, cwd, or file path");
  ok(Array.isArray(body.sources) && body.sources.length === 2 && body.sources.some((v) => v.name === "litellm" && v.label === "LiteLLM" && v.source === "file") && Array.isArray(body.sourceProblems) && body.sourceProblems.length === 0, `the generic sources ride on /api/quota as sources[] (${JSON.stringify(body.sources)})`);
  {
    const b = body.sources.find((v) => v.name === "budget");
    ok(b && b.windows[0].detail === "$6.10 of $50" && b.windows[0].level === "ok" && b.windows[1].level === "bad" && b.notes.length === 1 && /windows\[2\] \("wk"\)\.level ignored/.test(b.notes[0]) && !("budget" in b), `detail, level and notes are on the wire; the writer's own keys are not (${JSON.stringify(b && b.windows)})`);
    let log = "";
    for (let i = 0; i < 20 && !/budget\.json: windows\[2\] \("wk"\)\.level ignored/.test(log); i++) { await sleep(100); try { log = readFileSync(join(WS, ".hadron", "server.log"), "utf-8"); } catch {} }
    ok(/\[quota\] hadron-quota\.d\/budget\.json: windows\[2\] \("wk"\)\.level ignored: must be "ok", "warn" or "bad" \(lower-case\) \(the file is still read\)/.test(log) && !/budget\.json skipped/.test(log), `silent-failure rule: the ignored field is a warnOnce in server.log, and the file was not skipped (${(log.split("\n").find((l) => /budget\.json/.test(l)) || "no line")})`);
  }
  res = await fetch(`${BASE}/api/quota?token=${token}`);
  ok(res.status === 200, "…query-string token accepted like the other authenticated GETs");
  r = hadron(["doctor", "--json"], { env: { HADRON_TOKEN: token } });
  let dj = JSON.parse(r.out);
  let row = dj.local.find((f) => /^quota widget/.test(f.message));
  ok(row && row.level === "info" && /not installed/.test(row.message) && /hadron quota --install/.test(row.message), `doctor: sink not installed → info row naming the install command (${row && row.message})`);
  hadron(["quota", "--install"]);
  rmSync(receipt, { force: true });
  r = hadron(["doctor", "--json"], { env: { HADRON_TOKEN: token } });
  row = JSON.parse(r.out).local.find((f) => /^quota widget/.test(f.message));
  ok(row && row.level === "info" && /no receipt yet/.test(row.message), `doctor: installed, no receipt → info (${row && row.message})`);
  hadron(["quota-sink"], { input: stdin });
  r = hadron(["doctor", "--json"], { env: { HADRON_TOKEN: token } });
  dj = JSON.parse(r.out);
  row = dj.local.find((f) => /^quota widget/.test(f.message));
  ok(row && row.level === "green" && /claude receipt 0m ago \(5h 28% · 7d 4%\)/.test(row.message), `doctor: receipt present → green with age + numbers (${row && row.message})`);
  ok(!r.out.includes("SECRET"), "doctor output carries no session id");
  r = hadron(["doctor"], { env: { HADRON_TOKEN: token } });
  ok(/✓ quota widget: claude receipt/.test(r.out), "doctor text form shows the row");
  ok(/✓ quota source LiteLLM \(hadron-quota\.d\/litellm\.json\): receipt \d+m ago \(1mo 9% · day 55%\)$/m.test(r.out), `doctor: one green row per generic source (${r.out.split("\n").find((l) => /quota source LiteLLM/.test(l))})`);
  ok(/✓ quota source Budget \(hadron-quota\.d\/budget\.json\): receipt \d+m ago \(1mo 12% · day 12% \[bad\] · wk 3%\) — windows\[2\] \("wk"\)\.level ignored: must be "ok", "warn" or "bad" \(lower-case\) \(the file is still read — the contract is in README "Quota sources"\)/.test(r.out), `doctor: a source with an ignored field stays GREEN, the level marks its window, the note names the field (${r.out.split("\n").find((l) => /quota source Budget/.test(l))})`);
  writeFileSync(join(CFG, Q.SOURCES_DIR, "proxy.json"), "{ nope");
  r = hadron(["doctor", "--json"], { env: { HADRON_TOKEN: token } });
  row = JSON.parse(r.out).local.find((f) => /^quota source hadron-quota\.d\/proxy\.json skipped/.test(f.message));
  ok(row && row.level === "yellow" && /not valid JSON/.test(row.message) && /README/.test(row.message), `doctor: a skipped file is a yellow row with the reason (${row && row.message})`);
  r = hadron(["quota"]);
  ok(/^LiteLLM 1mo 9%/m.test(r.out) && /^proxy   skipped: not valid JSON \(hadron-quota\.d\/proxy\.json\)/m.test(r.out) && /^claude  /m.test(r.out), `\`hadron quota\` lists the source and the skipped file (${r.out.split("\n").filter((l) => /LiteLLM|proxy/.test(l)).join(" | ")})`);
  ok(/^Budget +1mo 12% — \$6\.10 of \$50  ·  day 12% \[bad\] \(resets in [\dhm ]+\) — daily cap hit  ·  wk 3%   as of \d+m ago$/m.test(r.out) && /^ +note: windows\[2\] \("wk"\)\.level ignored: must be "ok", "warn" or "bad" \(lower-case\) \(the file is still read\)$/m.test(r.out), `\`hadron quota\`: detail after the number, [level] beside it, the ignored field as a note line (${r.out.split("\n").filter((l) => /Budget|note:/.test(l)).join(" | ")})`);
  rmSync(join(CFG, Q.SOURCES_DIR, "proxy.json"));
  hadron(["quota", "--uninstall"]);
} catch (e) {
  failed++;
  console.error(`  ✗ exception: ${e.stack || e}`);
} finally {
  stop();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
