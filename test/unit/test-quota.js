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
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, statSync } from "fs";
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

  console.log("\n[GET /api/quota + doctor row]");
  await boot();
  const token = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  let res = await fetch(`${BASE}/api/quota`);
  ok(res.status === 401, "GET /api/quota without a token → 401 (account information is not open)");
  res = await fetch(`${BASE}/api/quota`, { headers: { "x-hadron-token": token } });
  let body = await res.json();
  ok(res.status === 200 && body.claude.windows.length === 2 && body.claude.source === "statusline" && body.codex.windows.length === 2 && body.codex.source === "rollout" && typeof body.at === "string", `with the token: {claude, codex, at} (${JSON.stringify(body).slice(0, 160)}…)`);
  ok(!JSON.stringify(body).includes("SECRET") && !JSON.stringify(body).includes(CODEX) && !JSON.stringify(body).includes(CFG), "payload carries no session id, cwd, or file path");
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
