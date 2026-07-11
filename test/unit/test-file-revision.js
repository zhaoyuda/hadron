/**
 * Unit tests for /api/file conditional writes (editor draft model, P0).
 *
 * The editor saves with the revision its draft is based on; if the file moved
 * since (an agent wrote it), the server must refuse with 409 + the current
 * content instead of silently overwriting. Also: revisions are exposed on
 * GET/HEAD, writes are atomic (temp+rename leaves no droppings), and the
 * legacy unconditional save (no baseRevision) still works.
 *
 * Run: node test/unit/test-file-revision.js
 */
import { spawn } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3989;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-rev-"));
let server, TOKEN;

const H = () => ({ "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: BASE });
const save = (path, content, baseRevision) =>
  fetch(`${BASE}/api/file`, { method: "POST", headers: H(), body: JSON.stringify({ path, content, ...(baseRevision !== undefined ? { baseRevision } : {}) }) });

async function main() {
  server = spawn("node", [join(__dirname, "..", "..", "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/sessions`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  const file = join(WS, "doc.md");
  writeFileSync(file, "v1");

  console.log("\n[revision exposure]");
  const g1 = await fetch(`${BASE}/api/file?path=${encodeURIComponent(file)}`);
  const rev1 = g1.headers.get("X-File-Revision");
  ok(!!rev1, `GET exposes X-File-Revision (${rev1})`);
  const h1 = await fetch(`${BASE}/api/file?path=${encodeURIComponent(file)}`, { method: "HEAD" });
  ok(h1.headers.get("X-File-Revision") === rev1, "HEAD exposes the same revision");

  console.log("\n[conditional write]");
  const s1 = await save(file, "v2 (mine)", rev1);
  ok(s1.status === 200, "save with matching baseRevision succeeds");
  const rev2 = s1.headers.get("X-File-Revision");
  ok(!!rev2 && rev2 !== rev1, "successful save returns the NEW revision");
  ok(readFileSync(file, "utf-8") === "v2 (mine)", "content written");

  // Simulate an agent writing the file while a draft (based on rev2) is open.
  await new Promise((r) => setTimeout(r, 20)); // ensure mtime moves
  writeFileSync(file, "v3 (the agent's work)");
  const s2 = await save(file, "v4 (would clobber)", rev2);
  ok(s2.status === 409, "save against a stale revision → 409");
  const conflict = await s2.json();
  ok(conflict.error === "revision_conflict", "409 body carries revision_conflict");
  ok(conflict.currentContent === "v3 (the agent's work)", "409 body returns the current disk content for Compare");
  ok(!!conflict.currentRevision, "409 body returns the current revision for a retry");
  ok(readFileSync(file, "utf-8") === "v3 (the agent's work)", "the agent's version was NOT overwritten");

  console.log("\n[overwrite retry + legacy path]");
  const s3 = await save(file, "v4 (deliberate overwrite)", conflict.currentRevision);
  ok(s3.status === 200, "retry with the conflict's currentRevision succeeds (explicit overwrite)");
  const s4 = await save(file, "v5 (legacy unconditional)");
  ok(s4.status === 200, "save WITHOUT baseRevision keeps old unconditional semantics");
  ok(readFileSync(file, "utf-8") === "v5 (legacy unconditional)", "unconditional write landed");

  console.log("\n[atomicity hygiene]");
  ok(!readdirSync(WS).some((f) => f.includes("hadron-write-")), "no temp-file droppings left in the directory");
  const sMissing = await save(join(WS, "nope.md"), "x", "1-1");
  ok(sMissing.status === 404, "conditional save to a missing file → 404 (not a create)");

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { failed++; console.error(`  ✗ unexpected: ${e.message}`); })
  .finally(() => {
    try { server.kill("SIGKILL"); } catch {}
    try { rmSync(WS, { recursive: true, force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  });
