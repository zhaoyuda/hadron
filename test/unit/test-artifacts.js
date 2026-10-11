/**
 * Integration tests for the artifacts-ux server surface (spec sections A/B):
 *   - /api/files/browse jail: canonical (realpath) containment incl. symlink escape,
 *     ".." to the root allowed / above it rejected, hidden=1 dotfiles with .git and
 *     .hadron always hidden, the bulky-dir IGNORE list applied in both modes.
 *   - POST /api/sessions/:id/artifacts: url validation, dir validation (exists, is a
 *     directory, inside the jail), the canonical stored-path contract
 *     (workspace-relative under the workspace, absolute outside).
 *   - DELETE /api/sessions/:id/artifacts: index+value match removes under the
 *     per-agent lock; mismatch → 409; concurrent append + delete lose no update.
 *
 * Self-contained: boots its own Hadron server on a throwaway workspace + port.
 * Run: node test/unit/test-artifacts.js
 */
import "./hadron-home.js"; // private HADRON_HOME before any server spawns
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// Store primitives imported directly for the lock-barrier test (separate throwaway
// workspace in THIS process — the HTTP server above runs in its own).
import { initWorkspace as storeInit, withAgentLock, appendAgentField, saveAgent, saveAgentLocked } from "../../server/agent-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// The server is pointed at a SYMLINK alias of the workspace so the macOS path
// divergence is reproduced on every platform: there mkdtemp lives under /var
// (really /private/var), and the state detector rewrites session.cwd to the
// pane's kernel-reported canonical path every poll. A cwd containment check
// done on raw prefixes against the workspace as typed then rejects the agent's
// own cwd, and browse/suggest silently fall back to the workspace root.
const WS_REAL = mkdtempSync(join(tmpdir(), "hadron-arttest-"));
const WS = `${WS_REAL}-link`;
symlinkSync(WS_REAL, WS);
let server, TOKEN;

function authHeaders(extra = {}) {
  return { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": ORIGIN, ...extra };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/sessions`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

function killTmux() {
  try {
    const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter((n) => n.includes(`hadron-${WS.split("/").pop()}`));
    for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
  } catch {}
}

const agentJson = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));

async function main() {
  // Fixture tree (before boot so nothing races):
  //   sub/inner/deep.md, sub/a.md, plain.md, .secret.md, .git/, node_modules/, esc -> /etc
  mkdirSync(join(WS, "sub", "inner"), { recursive: true });
  writeFileSync(join(WS, "sub", "inner", "deep.md"), "# deep");
  writeFileSync(join(WS, "sub", "a.md"), "# a");
  writeFileSync(join(WS, "plain.md"), "# plain");
  writeFileSync(join(WS, ".secret.md"), "# secret");
  mkdirSync(join(WS, ".git"), { recursive: true });
  mkdirSync(join(WS, "node_modules", "pkg"), { recursive: true });
  symlinkSync("/etc", join(WS, "esc"));
  // A record from before folders pinned as files were coerced: one in-workspace
  // folder pin, one outside — proven below to be migrated / left alone at boot.
  mkdirSync(join(WS, ".hadron", "agents"), { recursive: true });
  mkdirSync(join(WS, "legacydir"), { recursive: true });
  writeFileSync(join(WS, ".hadron", "agents", "legacy.json"), JSON.stringify({ id: "legacy", name: "Legacy", group: "Workers", launchCommand: "shell",
    artifacts: [{ type: "file", value: "legacydir" }, { type: "file", value: "/etc" }, { type: "file", value: "plain.md" }], relatedAgents: [], notes: "" }));

  server = spawn("node", [join(__dirname, "..", "..", "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "arty", launchCommand: "shell", cwd: "sub" }) });

  console.log("\n[boot: folders pinned as files before the coercion become folder listings]");
  {
    const arts = agentJson("legacy").artifacts;
    ok(arts.find((a) => a.value === "legacydir")?.type === "dir", "an in-workspace folder pinned as a file is a dir artifact after boot, saved on the record");
    ok(arts.find((a) => a.value === "/etc")?.type === "file", "…a folder outside the workspace is left as it was");
    ok(arts.find((a) => a.value === "plain.md")?.type === "file", "…a real file pin untouched");
    const r = await fetch(`${BASE}/api/sessions`, { headers: authHeaders() });
    const j = await r.json();
    ok(j.find((s) => s.id === "legacy")?.artifacts.find((a) => a.value.endsWith("legacydir"))?.type === "dir", "…and the wire shows the listing");
    // An ARCHIVED legacy record misses the boot pass; restore migrates it.
    writeFileSync(join(WS, ".hadron", "agents", "legacyarch.json"), JSON.stringify({ id: "legacyarch", name: "LegacyArch", group: "Workers", launchCommand: "shell", archived: true, archivedAt: new Date().toISOString(),
      artifacts: [{ type: "file", value: "legacydir" }], relatedAgents: [], notes: "" }));
    const rr = await fetch(`${BASE}/api/sessions/legacyarch/restore`, { method: "POST", headers: authHeaders() });
    ok(rr.status === 200 && agentJson("legacyarch").artifacts[0].type === "dir", `restoring an archived record migrates its folder pin too (${rr.status}, ${agentJson("legacyarch").artifacts[0].type})`);
    await fetch(`${BASE}/api/sessions/legacyarch`, { method: "DELETE", headers: authHeaders() }).catch(() => {});
  }

  console.log("\n[browse: start dir + rel contract]");
  {
    // No path param → the agent's cwd, with its workspace-relative prefix as `rel`.
    let r = await fetch(`${BASE}/api/files/browse?agentId=arty`);
    let j = await r.json();
    ok(r.status === 200 && j.rel === "sub", `omitting path starts at the agent cwd (rel="${j.rel}")`);
    ok(j.entries.some((e) => e.name === "a.md" && e.type === "file"), "start listing shows the agent cwd contents");
    // Unknown agent (or none) → workspace root.
    r = await fetch(`${BASE}/api/files/browse`);
    j = await r.json();
    ok(r.status === 200 && j.rel === "", "no agentId falls back to the workspace root (rel=\"\")");
    const dirEntry = j.entries.find((e) => e.name === "sub");
    ok(dirEntry && dirEntry.type === "dir" && dirEntry.count === 2, "dir entries carry a non-recursive child count");
  }

  console.log("\n[browse: jail]");
  {
    // Symlink inside the workspace pointing outside: canonical containment rejects it.
    let r = await fetch(`${BASE}/api/files/browse?path=${encodeURIComponent("esc")}`);
    ok(r.status === 403, "symlinked dir escaping the workspace rejected (403)");
    // ".." above the root rejected; down-and-up to the root allowed.
    r = await fetch(`${BASE}/api/files/browse?path=${encodeURIComponent("..")}`);
    ok(r.status === 403, "\"..\" above the workspace root rejected (403)");
    r = await fetch(`${BASE}/api/files/browse?path=${encodeURIComponent("sub/..")}`);
    const j = await r.json();
    ok(r.status === 200 && j.rel === "", "\"sub/..\" lands on the workspace root (allowed)");
    r = await fetch(`${BASE}/api/files/browse?path=${encodeURIComponent("/etc")}`);
    ok(r.status === 403 || r.status === 404, "absolute path outside the workspace rejected");
  }

  console.log("\n[browse: hidden files]");
  {
    let r = await fetch(`${BASE}/api/files/browse?path=`);
    let names = (await r.json()).entries.map((e) => e.name);
    ok(!names.includes(".secret.md"), "default mode hides dotfiles");
    ok(!names.includes(".git") && !names.includes("node_modules"), "default mode applies the IGNORE list");
    r = await fetch(`${BASE}/api/files/browse?path=&hidden=1`);
    names = (await r.json()).entries.map((e) => e.name);
    ok(names.includes(".secret.md"), "hidden=1 includes dotfiles");
    ok(!names.includes(".git") && !names.includes(".hadron"), "hidden=1 never shows .git/.hadron");
    ok(!names.includes("node_modules"), "hidden=1 still applies the IGNORE list");
  }

  console.log("\n[POST artifacts: validation]");
  {
    let r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "url", value: "not a url" }) });
    ok(r.status === 400, "non-URL url artifact rejected (400)");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "url", value: "ftp://example.com/x" }) });
    ok(r.status === 400, "non-http(s) protocol rejected (400)");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "url", value: "https://example.com/ok" }) });
    ok(r.status === 200, "valid https URL accepted");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "dir", value: "does-not-exist" }) });
    ok(r.status === 400, "dir artifact must exist (400)");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "dir", value: "plain.md" }) });
    ok(r.status === 400, "dir artifact must be a directory (400)");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "dir", value: "/etc" }) });
    ok(r.status === 400, "dir artifact outside the workspace rejected (400)");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "dir", value: "esc" }) });
    ok(r.status === 400, "dir artifact through an escaping symlink rejected (400)");
    // A folder pinned as type "file" (what `hadron artifacts pin <dir>` posts)
    // becomes the dir artifact it should have been; outside the jail it is
    // refused with a message that says it is a folder.
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "sub/inner" }) });
    let coerced = (await r.json()).artifacts.find((a) => /sub\/inner$/.test(a.value));
    ok(r.status === 200 && coerced && coerced.type === "dir", `a folder pinned as a file lands as a dir artifact (${JSON.stringify(coerced)})`);
    ok(agentJson("arty").artifacts.find((a) => a.value === "sub/inner")?.type === "dir", "…persisted as type dir");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "/etc" }) });
    ok(r.status === 400 && /\/etc is a folder outside the workspace/.test((await r.json()).error), "a folder outside the workspace pinned as a file → 400 naming it as a folder");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "weird", value: "x" }) });
    ok(r.status === 400, "unknown artifact type rejected (400)");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "dir", value: "sub/inner" }) });
    const j = await r.json();
    ok(r.status === 200 && j.artifacts.some((a) => a.type === "dir"), "valid dir artifact accepted");
  }

  console.log("\n[PATCH sessions: url whitelist]");
  {
    const r = await fetch(`${BASE}/api/sessions/arty`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [{ type: "url", value: "garbage" }] }) });
    ok(r.status === 400, "PATCH with an invalid url artifact rejected (400)");
  }

  console.log("\n[canonical stored-path contract]");
  {
    // Absolute path UNDER the workspace → stored workspace-relative; response resolved.
    let r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: join(WS, "sub", "a.md") }) });
    let j = await r.json();
    const stored = agentJson("arty").artifacts;
    ok(stored.some((a) => a.value === "sub/a.md"), "absolute path under the workspace stored workspace-relative");
    ok(j.artifacts.some((a) => a.value === join(WS, "sub", "a.md")), "response returns the resolved absolute value");
    // cwd-relative path that only exists under the agent cwd → resolved there, then canonical.
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "inner/deep.md" }) });
    ok(agentJson("arty").artifacts.some((a) => a.value === "sub/inner/deep.md"), "agent-cwd-relative path canonicalized to workspace-relative");
    // Absolute path OUTSIDE the workspace → stored absolute.
    const outside = mkdtempSync(join(tmpdir(), "hadron-outside-"));
    writeFileSync(join(outside, "ext.md"), "# ext");
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: join(outside, "ext.md") }) });
    // realpath the expectation: on macOS tmpdir() is /var/... but the server
    // canonicalizes to /private/var/... (Linux /tmp is not a symlink, so only
    // macOS exposed the mismatch).
    ok(agentJson("arty").artifacts.some((a) => a.value === join(realpathSync(outside), "ext.md")), "absolute path outside the workspace stored absolute (canonical)");
    // Same file added in two forms de-dupes to one entry.
    const before = agentJson("arty").artifacts.length;
    r = await fetch(`${BASE}/api/sessions/arty/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "sub/a.md" }) });
    ok(agentJson("arty").artifacts.length === before, "re-adding the same file in canonical form de-dupes");
    rmSync(outside, { recursive: true, force: true });
  }

  console.log("\n[DELETE artifacts]");
  {
    await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "deletee", launchCommand: "shell" }) });
    for (const v of ["one.md", "two.md", "three.md"]) {
      await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: v }) });
    }
    // Mismatched value at the index → 409, nothing removed.
    let r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: 1, value: "wrong.md" }) });
    ok(r.status === 409, "index/value mismatch → 409");
    ok(agentJson("deletee").artifacts.length === 3, "409 removed nothing");
    // Matching pair removes exactly that artifact; resolved value matches too.
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: 1, value: join(WS, "two.md") }) });
    let j = await r.json();
    ok(r.status === 200 && j.artifacts.length === 2, "matching remove succeeds (resolved-form value accepted)");
    ok(agentJson("deletee").artifacts.map((a) => a.value).join(",") === "one.md,three.md", "exactly the matched artifact removed");
    // Bad shapes.
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: -1, value: "one.md" }) });
    ok(r.status === 400, "negative index rejected (400)");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: 0 }) });
    ok(r.status === 400, "missing value rejected (400)");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: 9, value: "one.md" }) });
    ok(r.status === 409, "out-of-range index → 409 (array drifted)");

    // Value-only (`hadron artifacts unpin`): no index was ever rendered, so the
    // path is canonicalised like a pin and the artifact it names goes.
    mkdirSync(join(WS, "sub"), { recursive: true });
    writeFileSync(join(WS, "sub", "deck-v0.8.md"), "old");
    writeFileSync(join(WS, "sub", "deck-v0.10.md"), "new");
    for (const v of ["sub/deck-v0.8.md", "sub/deck-v0.10.md"]) {
      await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: v }) });
    }
    ok(agentJson("deletee").artifacts.map((a) => a.value).join(",") === "one.md,three.md,sub/deck-v0.8.md,sub/deck-v0.10.md", "harness: four pinned");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: "sub/nope.md" }) });
    ok(r.status === 404, "value-only: a path that is not pinned → 404");
    ok(agentJson("deletee").artifacts.length === 4, "…and nothing removed");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: join(WS, "sub", "deck-v0.8.md") }) });
    j = await r.json();
    ok(r.status === 200 && j.artifacts.length === 3, "value-only: the absolute form of a workspace-relative pin removes it");
    ok(agentJson("deletee").artifacts.map((a) => a.value).join(",") === "one.md,three.md,sub/deck-v0.10.md", "exactly deck-v0.8 removed, deck-v0.10 (shared prefix) untouched");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: "./sub/../sub/deck-v0.10.md" }) });
    ok(r.status === 200 && agentJson("deletee").artifacts.map((a) => a.value).join(",") === "one.md,three.md", "value-only: a non-normalised relative path canonicalises to its pin");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: null }) });
    ok(r.status === 400, "neither index nor value → 400");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: "0", value: "one.md" }) });
    ok(r.status === 400 && agentJson("deletee").artifacts.length === 2, "a string index is neither form → 400, nothing removed");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: null, value: "one.md" }) });
    ok(r.status === 400 && agentJson("deletee").artifacts.length === 2, "index: null is the index form with a bad index → 400, never a silent by-value removal");
    // url and dir artifacts unpin by value too.
    await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "url", value: "https://example.com/dash" }) });
    await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "dir", value: "sub" }) });
    ok(agentJson("deletee").artifacts.length === 4, "harness: a url and a dir pinned");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: "https://example.com/dash" }) });
    ok(r.status === 200 && !agentJson("deletee").artifacts.some((a) => a.type === "url"), "value-only removes a url artifact");
    r = await fetch(`${BASE}/api/sessions/deletee/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: join(WS, "sub") }) });
    ok(r.status === 200 && !agentJson("deletee").artifacts.some((a) => a.type === "dir"), "value-only removes a dir artifact by its absolute path");
  }

  console.log("\n[unpin by value: the deleted-file case and the cwd/workspace ambiguity]");
  {
    // An agent whose cwd is a subdirectory pins "a.md" → stored "proj/a.md".
    // The motivating stale pin is a DELETED file: the same "a.md" must still
    // unpin it (the existence-gated base pick in canonicalArtifactPath would
    // otherwise resolve it against the workspace and 404).
    mkdirSync(join(WS, "proj"), { recursive: true });
    writeFileSync(join(WS, "proj", "a.md"), "a");
    writeFileSync(join(WS, "proj", "both.md"), "p");
    writeFileSync(join(WS, "both.md"), "w");
    let r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "subcwd", launchCommand: "shell", cwd: join(WS, "proj") }) });
    ok(r.status === 201, `harness: agent with cwd <ws>/proj (${r.status})`);
    await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "a.md" }) });
    ok(agentJson("subcwd").artifacts.map((a) => a.value).join(",") === "proj/a.md", "harness: pinned from the cwd, stored workspace-relative under proj/");
    rmSync(join(WS, "proj", "a.md"));
    r = await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: "a.md" }) });
    ok(r.status === 200 && agentJson("subcwd").artifacts.length === 0, "the path that pinned a now-DELETED file still unpins it (cwd base tried without the file)");
    // Both bases name a pinned artifact → 409 naming both, nothing removed; the absolute form is never ambiguous.
    await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "both.md" }) });
    await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: join(WS, "proj", "both.md") }) });
    ok(agentJson("subcwd").artifacts.map((a) => a.value).sort().join(",") === "both.md,proj/both.md", `harness: both.md pinned at the workspace root (the relative pin: the workspace base wins while both exist) AND under the cwd (${agentJson("subcwd").artifacts.map((a) => a.value).join(",")})`);
    r = await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: "both.md" }) });
    const j = await r.json();
    ok(r.status === 409 && /both\.md and proj\/both\.md|proj\/both\.md and both\.md/.test(j.error) && /absolute path/.test(j.error), `a relative path naming two pinned artifacts → 409 naming both (${j.error})`);
    ok(agentJson("subcwd").artifacts.length === 2, "…nothing removed on ambiguity");
    r = await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ value: join(WS, "proj", "both.md") }) });
    ok(r.status === 200 && agentJson("subcwd").artifacts.map((a) => a.value).join(",") === "both.md", "the absolute path unpins exactly the one it names");
    // Revalidation (whole-array PATCH) never rejects a pin that was valid when made.
    mkdirSync(join(WS, "proj", "becomesdir.md"));
    writeFileSync(join(WS, "proj", "keep.md"), "k");
    rmSync(join(WS, "both.md"));
    // A legacy outside-folder pin is staged as a FILE that is pinned, then
    // replaced by a folder on disk — the shape a record from before this
    // change has.
    const outsideDir = mkdtempSync(join(tmpdir(), "hadron-outside-"));
    const legacyOutside = join(outsideDir, "was-a-file");
    writeFileSync(legacyOutside, "f");
    r = await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: legacyOutside }) });
    ok(r.status === 201 || r.status === 200, `harness: outside file pinned while it was a file (${r.status})`);
    rmSync(legacyOutside); mkdirSync(legacyOutside);
    let cur = agentJson("subcwd").artifacts;
    r = await fetch(`${BASE}/api/sessions/subcwd`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [...cur, { type: "file", value: "proj/keep.md" }, { type: "file", value: "proj/becomesdir.md" }] }) });
    ok(r.status === 200, `a whole-array PATCH re-sending a stored file pin whose path became a folder outside the workspace is not rejected (${r.status})`);
    const after = agentJson("subcwd").artifacts;
    ok(after.find((a) => a.value === "proj/becomesdir.md")?.type === "dir", "…an in-workspace path that became a folder is the folder listing");
    ok(after.find((a) => a.value === legacyOutside)?.type === "file", "…the stored outside one is left as the file pin it was");
    cur = agentJson("subcwd").artifacts;
    r = await fetch(`${BASE}/api/sessions/subcwd`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [...cur, { type: "file", value: outsideDir }] }) });
    ok(r.status === 400 && agentJson("subcwd").artifacts.length === cur.length, `…but a PATCH ADDING a fresh outside-folder file pin is refused like POST (${r.status})`);
    r = await fetch(`${BASE}/api/sessions/subcwd/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: outsideDir }) });
    ok(r.status === 400, "…and so is a fresh POST of it");
    rmSync(outsideDir, { recursive: true, force: true });
  }

  console.log("\n[concurrent append + delete]");
  {
    await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "racer", launchCommand: "shell" }) });
    for (const v of ["r0.md", "r1.md", "r2.md"]) {
      await fetch(`${BASE}/api/sessions/racer/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: v }) });
    }
    // Fire a delete of r1 and an append of r3 simultaneously — both serialize under
    // the per-agent lock, so neither update is lost whichever order they land in.
    const [delRes, addRes] = await Promise.all([
      fetch(`${BASE}/api/sessions/racer/artifacts`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ index: 1, value: "r1.md" }) }),
      fetch(`${BASE}/api/sessions/racer/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "r3.md" }) }),
    ]);
    ok(addRes.status === 200, "concurrent append succeeded");
    const vals = agentJson("racer").artifacts.map((a) => a.value);
    ok(vals.includes("r3.md"), "append not lost to the concurrent delete");
    ok(vals.includes("r0.md") && vals.includes("r2.md"), "untouched artifacts survive");
    // The delete either matched (r1 gone) or 409'd because the append re-shaped the
    // array first — but the array must never end up torn/inconsistent.
    if (delRes.status === 200) ok(!vals.includes("r1.md") && vals.length === 3, "delete landed → exactly r1 removed");
    else ok(delRes.status === 409 && vals.length === 4, "delete conflicted (409) → nothing removed");
  }

  console.log("\n[session-create artifact seed validation]");
  {
    // Session creation must not be a validation bypass — same per-entry checks as append.
    let r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "seed-bad-url", launchCommand: "shell", artifacts: [{ type: "url", value: "garbage" }] }) });
    ok(r.status === 400, "create with invalid url seed rejected (400)");
    r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "seed-bad-dir", launchCommand: "shell", artifacts: [{ type: "dir", value: "does-not-exist" }] }) });
    ok(r.status === 400, "create with nonexistent dir seed rejected (400)");
    r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "seed-bad-shape", launchCommand: "shell", artifacts: "nope" }) });
    ok(r.status === 400, "create with non-array artifacts rejected (400)");
    ok(!existsSync(join(WS, ".hadron", "agents", "seed-bad-url.json")), "rejected create leaves no agent file behind");
    r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "seeded", launchCommand: "shell", artifacts: [{ type: "file", value: join(WS, "plain.md") }] }) });
    const j = await r.json();
    ok(r.status === 201 && agentJson("seeded").artifacts[0].value === "plain.md", "valid file seed canonicalized at create (stored workspace-relative)");
    ok(j.artifacts[0].value === join(WS, "plain.md"), "create response returns the resolved value");
  }

  console.log("\n[PATCH artifacts: full validation + locked write]");
  {
    await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "patchy", launchCommand: "shell" }) });
    let r = await fetch(`${BASE}/api/sessions/patchy`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [{ type: "weird", value: "x" }] }) });
    ok(r.status === 400, "PATCH with unknown artifact type rejected (400)");
    r = await fetch(`${BASE}/api/sessions/patchy`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [{ type: "dir", value: "/etc" }] }) });
    ok(r.status === 400, "PATCH with out-of-jail dir artifact rejected (400)");
    r = await fetch(`${BASE}/api/sessions/patchy`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [{ type: "dir", value: "esc" }] }) });
    ok(r.status === 400, "PATCH dir through an escaping symlink rejected (400)");
    r = await fetch(`${BASE}/api/sessions/patchy`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [{ type: "file", value: join(WS, "plain.md") }, { type: "dir", value: "sub" }] }) });
    ok(r.status === 200, "PATCH with valid entries accepted");
    const stored = agentJson("patchy").artifacts;
    ok(stored[0].value === "plain.md" && stored[1].type === "dir" && stored[1].value === "sub",
      "PATCH entries canonicalized like append (workspace-relative)");
    // HTTP end-state sanity only — the LOCK discriminator is the store-level
    // barrier block below (this cannot force an interleave over HTTP).
    const [pr, ar] = await Promise.all([
      fetch(`${BASE}/api/sessions/patchy`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ artifacts: [{ type: "file", value: "px.md" }] }) }),
      fetch(`${BASE}/api/sessions/patchy/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "py.md" }) }),
    ]);
    ok(pr.status === 200 && ar.status === 200, "concurrent PATCH + append both succeed (HTTP sanity)");
    ok(agentJson("patchy").artifacts.map((a) => a.value).includes("px.md"),
      "agent file parses and holds the PATCHed entry (HTTP sanity)");
  }

  console.log("\n[store-level lock barrier (the serialization discriminator)]");
  {
    // Prove FIFO serialization at the store layer: hold agent X's lock with a slow
    // fn, then immediately queue an append and a whole-snapshot save behind it.
    // Unlocked writes would complete out of order (the save would finish while the
    // hold is still sleeping); under withAgentLock the completion order MUST be
    // hold → append → patch-save, and both queued effects land on disk.
    const WS2 = mkdtempSync(join(tmpdir(), "hadron-lockbar-"));
    storeInit(WS2);
    saveAgent({ id: "bar", name: "bar", artifacts: [{ type: "file", value: "seed.md" }], relatedAgents: [], notes: "" });
    const order = [];
    const hold = withAgentLock("bar", () => new Promise((done) => setTimeout(() => { order.push("hold"); done(); }, 200)));
    const append = appendAgentField("bar", "artifacts", { type: "file", value: "app.md" }).then(() => order.push("append"));
    // The snapshot models a PATCH whose caller saw the appended state (whole-array
    // PATCH is last-write-wins by design — the lock's job is ordering, not merging).
    const patchSave = saveAgentLocked({
      id: "bar", name: "bar", relatedAgents: [], notes: "",
      artifacts: [{ type: "file", value: "seed.md" }, { type: "file", value: "app.md" }, { type: "file", value: "patched.md" }],
    }).then(() => order.push("patch-save"));
    await Promise.all([hold, append, patchSave]);
    ok(order.join(",") === "hold,append,patch-save",
      `lock queue is FIFO: hold → append → patch-save (got: ${order.join(",")})`);
    const onDisk = JSON.parse(readFileSync(join(WS2, ".hadron", "agents", "bar.json"), "utf-8")).artifacts.map((a) => a.value);
    ok(onDisk.includes("app.md") && onDisk.includes("patched.md") && onDisk.includes("seed.md"),
      `both queued effects present on disk, nothing lost (got: [${onDisk.join(",")}])`);
    rmSync(WS2, { recursive: true, force: true });
  }

  console.log("\n[suggest jail + base contract]");
  {
    // Agent "arty" has cwd=sub — suggest scans from there, and only from there.
    // Response shape is { base, files }: base = the resolved scan root the server
    // ACTUALLY used, the join base for every returned path.
    const wsReal = realpathSync(WS);
    // Pin the trigger: by now the detector must have rewritten arty's cwd from
    // the as-created alias path to the pane's canonical path. Everything below
    // runs against THAT cwd — the case that clamped to the root on macOS.
    let liveCwd = null;
    for (let i = 0; i < 50 && liveCwd !== join(wsReal, "sub"); i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { liveCwd = (await (await fetch(`${BASE}/api/sessions`)).json()).find((s) => s.id === "arty")?.cwd ?? null; } catch {}
    }
    ok(liveCwd === join(wsReal, "sub"), `detector rewrote agent cwd to the pane's canonical path (got ${liveCwd})`);
    let r = await fetch(`${BASE}/api/files/suggest?agentId=arty`);
    let j = await r.json();
    ok(j.base === join(wsReal, "sub"), `base reports the resolved scan root (got ${j.base})`);
    ok(j.files.some((f) => f.path === "a.md"), "suggest scans from the agent cwd (agentId-derived)");
    ok(j.files.every((f) => !f.path.startsWith("/") && !f.path.includes("..")), "suggest paths stay relative to base");
    ok(j.files.every((f) => existsSync(join(j.base, f.path))), "every path joins against base to a real file");
    // The old client-supplied cwd param must be dead: pointing it outside the
    // workspace changes nothing.
    const r2 = await fetch(`${BASE}/api/files/suggest?agentId=arty&cwd=${encodeURIComponent("/etc")}`);
    const j2 = await r2.json();
    ok(JSON.stringify(j2) === JSON.stringify(j), "client cwd param is ignored (no arbitrary enumeration root)");
    ok(!j2.files.some((f) => /passwd|hosts/.test(f.path)), "nothing outside the workspace enumerated");
    r = await fetch(`${BASE}/api/files/suggest`);
    j = await r.json();
    ok(j.base === wsReal && j.files.some((f) => f.path === "plain.md"), "no agentId falls back to the workspace root (base = root)");
    // The escaping dir symlink (esc -> /etc) must not contribute results even if
    // it were raced into place: symlinked dirs are never followed.
    ok(!j.files.some((f) => f.path.startsWith("esc/")), "symlinked dirs are not descended");
  }

  console.log("\n[canonical containment through symlinks]");
  {
    // A file reached through an in-workspace symlink to an OUTSIDE dir must store
    // as its canonical absolute path, never a misleading workspace-relative one.
    const outside2 = mkdtempSync(join(tmpdir(), "hadron-symout-"));
    writeFileSync(join(outside2, "f.md"), "# outside");
    symlinkSync(outside2, join(WS, "link-out"));
    await fetch(`${BASE}/api/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "symmy", launchCommand: "shell" }) });
    const r = await fetch(`${BASE}/api/sessions/symmy/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "link-out/f.md" }) });
    ok(r.status === 200, "file through an escaping symlink is accepted (external file artifacts are allowed)");
    const stored = agentJson("symmy").artifacts[0].value;
    const expected = join(realpathSync(outside2), "f.md");
    ok(stored === expected, `stored as canonical absolute (got ${stored})`);
    ok(!stored.startsWith(WS) && stored.startsWith("/"), "NOT stored workspace-relative despite the lexical location");
    // Control: the same shape through a real in-workspace dir still stores relative.
    const r3 = await fetch(`${BASE}/api/sessions/symmy/artifacts`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ type: "file", value: "sub/a.md" }) });
    ok(r3.status === 200 && agentJson("symmy").artifacts[1].value === "sub/a.md", "non-symlinked path still stores workspace-relative");
    rmSync(outside2, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    if (server) try { server.kill("SIGKILL"); } catch {}
    killTmux();
    try { rmSync(WS_REAL, { recursive: true, force: true }); rmSync(WS, { force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  });
