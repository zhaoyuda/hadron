/**
 * CLI flag contract: an unrecognised --flag is an error (exit 1, `unknown
 * option: --x` on stderr) instead of being silently ignored, and
 * `hadron <cmd> --help` / `-h` prints usage (exit 0) instead of running the
 * command. Driven by a real report: `hadron watchdog --restrat` printed
 * "running" and exited 0 — from a timer unit that looks like a healthy verdict.
 *
 * No server needed: every case here is decided before any HTTP call, and the
 * one command that touches the filesystem (watchdog) runs from an empty cwd.
 */
import { execFileSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const CWD = mkdtempSync(join(tmpdir(), "hadron-cli-"));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function hadron(...args) {
  // Port 1 is never listening: the version gate must see "unreachable" rather
  // than whatever server happens to run on this machine's :3000.
  const env = { ...process.env, TMUX: "", HADRON_PORT: "1" };
  delete env.HADRON_TOKEN;
  try {
    const out = execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], cwd: CWD, env, timeout: 20000,
    });
    return { status: 0, out, err: "" };
  } catch (e) { return { status: e.status, out: String(e.stdout || ""), err: String(e.stderr || "") }; }
}

console.log("[unknown --flags are rejected]");
{
  const r = hadron("watchdog", "--restrat");
  ok(r.status === 1, `watchdog --restrat exits 1 (got ${r.status})`);
  ok(/^unknown option: --restrat/m.test(r.err), "…stderr names the option: `unknown option: --restrat`");
  ok(!/running|not-running|wedged|booting/.test(r.out), "…and no verdict is printed (the command did not run)");
  ok(/hadron watchdog --help/.test(r.err), "…and points at `hadron watchdog --help`");
}
{
  const r = hadron("ls", "--json", "--archvied");
  ok(r.status === 1 && /unknown option: --archvied/.test(r.err), "ls --archvied: rejected even next to a valid flag");
}
{
  const r = hadron("spawn", "x", "--grup", "G");
  ok(r.status === 1 && /unknown option: --grup/.test(r.err), "spawn --grup: rejected before any HTTP call");
}
{
  const r = hadron("doctor", "--verbose");
  ok(r.status === 1 && /unknown option: --verbose/.test(r.err), "doctor --verbose: rejected");
}
{
  const r = hadron("nonsense", "--whatever");
  ok(r.status === 1 && /unknown command "nonsense"/.test(r.err) && !/unknown option/.test(r.err),
    "an unknown COMMAND is still reported as such (flags of an unknown command are not judged)");
}

console.log("\n[valid flags still parse]");
{
  // watchdog from a cwd with no .hadron/: exit 3 "cannot judge" — proves the
  // command ran with its flags accepted.
  const r = hadron("watchdog", "--restart", "--stale-after", "5", "--boot-grace", "10", "--json");
  let j = null; try { j = JSON.parse(r.out); } catch {}
  ok(r.status === 3 && j && j.staleAfterS === 5 && j.bootGraceS === 10 && j.exitCode === 3,
    `watchdog --restart --stale-after 5 --boot-grace 10 --json: accepted, ran, exit 3 from a cwd without .hadron/ (got ${r.status})`);
}
{
  const r = hadron("version", "--json");
  ok(r.status === 1 && /"status": "unreachable"/.test(r.out), "version --json: accepted (server unreachable → exit 1 is the gate, not a flag error)");
}

console.log("\n[--help / -h on a command prints usage instead of running it]");
{
  const r = hadron("watchdog", "--help");
  ok(r.status === 0 && /^hadron — manage Hadron agents/.test(r.out) && /hadron watchdog \[--restart\]/.test(r.out),
    "watchdog --help: exit 0, usage on stdout (no verdict)");
  ok(!/running|wedged|cannot judge/.test(r.out.split("\n")[0]), "…first line is the usage banner, not a watchdog verdict");
}
{
  const r = hadron("doctor", "-h");
  ok(r.status === 0 && /^hadron — manage Hadron agents/.test(r.out), "doctor -h: exit 0, usage");
}
{
  const r = hadron("--help");
  ok(r.status === 0 && /^hadron — manage Hadron agents/.test(r.out), "bare --help still works");
  const r2 = hadron();
  ok(r2.status === 0 && /^hadron — manage Hadron agents/.test(r2.out), "no arguments still prints usage, exit 0");
}
{
  const r = hadron("help");
  ok(/Unrecognised --flags are an error/.test(r.out) && /`hadron <command> --help`/.test(r.out), "usage text documents the flag contract");
}

console.log("\n[-h / --help as payload or flag value is NOT a help request]");
const usage = (r) => /^hadron — manage Hadron agents/.test(r.out);
{
  // These reach the (unreachable) server and fail there — the point is that
  // they did NOT print usage and exit 0 (a silent no-op is what this fixes).
  const r = hadron("message", "agentx", "-h");
  ok(r.status !== 0 && !usage(r) && !/unknown option/.test(r.err), `message agentx -h: "-h" is the message, not help (exit ${r.status})`);
}
{
  const r = hadron("send", "agentx", "-h");
  ok(r.status !== 0 && !usage(r) && !/unknown option/.test(r.err), "send agentx -h: keys payload, not help");
}
{
  const r = hadron("spawn", "newagent", "--task", "-h");
  ok(r.status !== 0 && !usage(r) && !/unknown option/.test(r.err), "spawn --task -h: flag VALUE, not help");
}
{
  const r = hadron("notes", "set", "--", "--not-a-flag");
  ok(r.status !== 0 && !usage(r) && !/unknown option/.test(r.err), "notes set -- --not-a-flag: `--` ends option parsing");
  const r2 = hadron("notes", "set", "--not-a-flag");
  ok(r2.status === 1 && /unknown option: --not-a-flag/.test(r2.err), "…without `--` it is still rejected as an unknown option");
}
{
  const r = hadron("spawn", "--help");
  ok(r.status === 0 && usage(r), "spawn --help (option position): usage");
  const r2 = hadron("spawn", "-h");
  ok(r2.status === 0 && usage(r2), "spawn -h (first word): usage");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
