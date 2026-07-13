/**
 * E2E runner — runs every m*.js module and summarizes, instead of the old
 * `m1 && m2 && …` chain. The chain aborted at the FIRST non-zero exit, so
 * M10's known headless-chromium clipboard failure (see XFAIL below) silently
 * skipped M11–M16 — exactly the "a bug shipped past every test" gap CLAUDE.md
 * warns about. This runs all modules regardless of individual failures and
 * exits non-zero only on an UNEXPECTED failure, so a real M11–M16 regression
 * can't hide behind M10 again.
 *
 * XFAIL: modules known to fail for a documented environment reason (not a
 * product bug). They still run and print, but don't gate the suite. Remove a
 * module from XFAIL the moment its root cause is fixed — a stale xfail hides
 * regressions just like the old chain did.
 */
import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));

// m10: OSC 52 → xterm.js → navigator.clipboard.writeText does not complete in
// headless chromium (no fix known; fails identically on main). Documented in
// CLAUDE.md. If you fix the clipboard bridge, delete this entry.
const XFAIL = new Set(["m10-clipboard.js"]);

const modules = readdirSync(here)
  .filter((f) => /^m\d+-.*\.js$/.test(f))
  .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));

const results = [];
for (const mod of modules) {
  const label = mod.replace(/\.js$/, "");
  process.stdout.write(`\n──────── ${label} ────────\n`);
  const res = spawnSync(process.execPath, [join(here, mod)], { stdio: "inherit" });
  const failed = res.status !== 0;
  const xfail = XFAIL.has(mod);
  results.push({ mod, label, failed, xfail });
}

const unexpected = results.filter((r) => r.failed && !r.xfail);
const xfailed = results.filter((r) => r.failed && r.xfail);
const passed = results.filter((r) => !r.failed);

process.stdout.write("\n════════ E2E SUMMARY ════════\n");
for (const r of results) {
  const tag = !r.failed ? "PASS " : r.xfail ? "XFAIL" : "FAIL ";
  process.stdout.write(`  ${tag} ${r.label}\n`);
}
process.stdout.write(
  `\n${passed.length} passed, ${unexpected.length} failed` +
    (xfailed.length ? `, ${xfailed.length} xfail (known env)` : "") +
    "\n"
);

if (unexpected.length) {
  process.stdout.write(`\nUNEXPECTED failures: ${unexpected.map((r) => r.label).join(", ")}\n`);
  process.exit(1);
}
if (xfailed.length && xfailed.some((r) => !XFAIL.has(r.mod))) process.exit(1);
process.exit(0);
