/**
 * Unit runner — runs every suite and summarizes, instead of the old
 * `a && b && …` chain in package.json. The chain stopped at the FIRST failing
 * file, so one failure hid every suite after it (a macOS report found the
 * test-provenance failure only by running files by hand, because
 * test-terminal-ws failed first). This runs all of them regardless and exits
 * non-zero if ANY failed. Same shape as test/e2e/run-all.js, minus XFAIL:
 * nothing in the unit suite is allowed to fail for an environment reason —
 * a suite that can't measure something prints an honest `skip` and passes.
 */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));

// Explicit order (fast, dependency-free suites first; the live tmux/pty ones
// last) — add new suites here AND to the listing in CLAUDE.md.
const SUITES = [
  "test-state-eval.js", "test-state-machine.js", "test-pane-resolution.js", "test-security.js",
  "test-annotations.js", "test-message.js", "test-upload.js", "test-resume.js", "test-file-revision.js",
  "test-artifacts.js", "test-agent-ops.js", "test-terminal-ws.js", "test-provenance.js",
  "test-resume-live.js", "test-doctor.js", "test-watchdog.js", "test-cli-flags.js",
];

const results = [];
for (const suite of SUITES) {
  const label = suite.replace(/\.js$/, "");
  process.stdout.write(`\n──────── ${label} ────────\n`);
  const res = spawnSync(process.execPath, [join(here, suite)], { stdio: "inherit" });
  results.push({ label, failed: res.status !== 0, status: res.status ?? `signal ${res.signal}` });
}

const failed = results.filter((r) => r.failed);
process.stdout.write("\n════════ UNIT SUMMARY ════════\n");
for (const r of results) process.stdout.write(`  ${r.failed ? "FAIL " : "PASS "} ${r.label}${r.failed ? ` (exit ${r.status})` : ""}\n`);
process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length) {
  process.stdout.write(`\nFAILED: ${failed.map((r) => r.label).join(", ")}\n`);
  process.exit(1);
}
