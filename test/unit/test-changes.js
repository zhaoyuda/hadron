/**
 * Changes view — server side (server/changes.js + the two routes).
 *
 * What git sees in the agent's cwd: status per file with +/- against HEAD,
 * a unified diff per changed file, `touched` for the files this session's
 * transcript wrote. Read-only: no staging, no commit, no branch verbs.
 *
 *   - GET /api/sessions/:id/changes: 401 without the token; a non-git cwd is
 *     { root: null, cwd }; a repo lists branch + every status kind (modified,
 *     staged modification, untracked, renamed, deleted, binary) with numstat,
 *     untracked files counted by lines, total/truncated over CHANGES_MAX_FILES
 *   - touched: true only for a path this agent's transcript wrote (seeded
 *     transcript, CLAUDE_CONFIG_DIR relocated) — git cannot tell agents apart
 *   - GET …/changes/diff?path=: the diff of one changed file (untracked via
 *     --no-index with a repo-relative header, tracked vs HEAD), 400 without a
 *     path, 404 for a path outside the change set (incl. ../ escapes — the
 *     endpoint is a diff viewer, not a file reader), truncated over DIFF_MAX_BYTES
 *   - nothing about changes reaches the record on disk; no session id on the wire
 *
 * Run: node test/unit/test-changes.js
 */
import "./hadron-home.js"; // private HADRON_HOME before any server spawns
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { claudeProjectDir } from "../../server/resume.js";
import { parseStatusZ, parseNumstatZ, statusOf, CHANGES_MAX_FILES, DIFF_MAX_BYTES } from "../../server/changes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const PORT = 6200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WS = mkdtempSync(join(tmpdir(), "hadron-chgtest-"));
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-chgcfg-"));
const GIT = join(WS, "repo");
const SID = randomUUID();
let server, TOKEN;
const req = (p, auth = true) => fetch(`${BASE}${p}`, { headers: auth ? { "x-hadron-token": TOKEN, "Origin": BASE } : {} });
const git = (...a) => execFileSync("git", ["-C", GIT, ...a], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });

function seedRepo() {
  mkdirSync(join(GIT, "src"), { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", GIT]);
  writeFileSync(join(GIT, "src", "app.js"), "line1\nline2\nline3\n");
  writeFileSync(join(GIT, "a.txt"), "a\n");
  writeFileSync(join(GIT, "old.txt"), "old\n");
  writeFileSync(join(GIT, "gone.txt"), "gone\n");
  writeFileSync(join(GIT, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(GIT, ".gitignore"), "ignored/\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  writeFileSync(join(GIT, "src", "app.js"), "line1\nLINE2\nline3\nline4\nline5\n"); // unstaged: +3 -1
  writeFileSync(join(GIT, "a.txt"), "a\nb\n"); git("add", "a.txt");               // staged: +1
  writeFileSync(join(GIT, "new.txt"), "n1\nn2\nn3");                                // untracked, 3 lines (no trailing NL)
  git("mv", "old.txt", "renamed.txt");                                              // staged rename
  git("rm", "-q", "gone.txt");                                                      // staged delete
  writeFileSync(join(GIT, "bin.dat"), Buffer.from([0, 9, 9, 9, 9]));                // binary modified
  mkdirSync(join(GIT, "ignored")); writeFileSync(join(GIT, "ignored", "x"), "x");   // gitignored: never listed
  writeFileSync(join(GIT, "big.txt"), "x".repeat(DIFF_MAX_BYTES + 4096));           // untracked, diff over the cap
}
function seedAgents() {
  const dir = join(WS, ".hadron", "agents");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "gitter.json"), JSON.stringify({
    id: "gitter", name: "Gitter", group: "Workers", cwd: GIT,
    runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now, sessionId: SID, confidence: "manual", lastObservedAt: now, lastPersistedAt: now },
  }));
  writeFileSync(join(dir, "plain.json"), JSON.stringify({ id: "plain", name: "Plain", group: "Workers", cwd: WS }));
  const tdir = join(CONFIG, "projects", claudeProjectDir(GIT));
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, `${SID}.jsonl`),
    JSON.stringify({ type: "user", timestamp: now, message: { role: "user", content: "hi" } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: now, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(GIT, "src", "app.js"), old_string: "a", new_string: "b" } }] } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: now, message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: join(GIT, "a.txt") } }] } }) + "\n");
  // A repo with no commit yet (just scaffolded, `git add`ed) and an agent whose cwd is gone.
  const FRESH = join(WS, "fresh");
  mkdirSync(FRESH);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", FRESH]);
  writeFileSync(join(FRESH, "hello.txt"), "hello\n");
  execFileSync("git", ["-C", FRESH, "add", "-A"]);
  writeFileSync(join(dir, "fresh.json"), JSON.stringify({ id: "fresh", name: "Fresh", group: "Workers", cwd: FRESH }));
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/sessions`)).ok) return; } catch {} await sleep(200); }
  throw new Error("server did not start");
}

console.log("[parsers]");
{
  const st = parseStatusZ("R  renamed.txt\0old.txt\0 M src/app.js\0?? new.txt\0");
  ok(st.length === 3 && st[0].from === "old.txt" && st[0].path === "renamed.txt" && st[1].xy === " M" && st[2].xy === "??", `parseStatusZ: rename consumes its source field (${JSON.stringify(st)})`);
  const ns = parseNumstatZ(["3\t1\tsrc/app.js", "-\t-\tbin.dat", "0\t0\t", "old.txt", "renamed.txt", ""].join("\0"));
  ok(ns.get("src/app.js").add === 3 && ns.get("bin.dat").add === null && ns.has("renamed.txt") && !ns.has("old.txt"), `parseNumstatZ: numbers, binary null, rename keyed by destination (${JSON.stringify([...ns])})`);
  ok(statusOf("??") === "untracked" && statusOf("UU") === "conflict" && statusOf("AD") === "deleted" && statusOf("A ") === "added" && statusOf("R ") === "renamed" && statusOf(" M") === "modified" && statusOf("MM") === "modified", "statusOf folds index + work tree into one word, conflict before add/delete");
}

async function main() {
  seedRepo(); seedAgents();
  server = spawn("node", [join(REPO, "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1", CLAUDE_CONFIG_DIR: CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  console.log("\n[GET /api/sessions/:id/changes]");
  ok((await req("/api/sessions/gitter/changes", false)).status === 401, "401 without the token");
  ok((await req("/api/sessions/nope/changes")).status === 404, "404 for an unknown agent");
  const plain = await (await req("/api/sessions/plain/changes")).json();
  ok(plain.root === null && plain.cwd === WS, `a non-git cwd → { root: null, cwd } (${JSON.stringify(plain)})`);
  let c;
  for (let i = 0; i < 20 && !(c && c.files?.some((f) => f.touched)); i++) { c = await (await req("/api/sessions/gitter/changes")).json(); if (!c.files?.some((f) => f.touched)) await sleep(500); }
  ok(c.root === GIT && c.branch === "main", `root + branch (${c.root === GIT} / ${c.branch})`);
  const by = Object.fromEntries((c.files || []).map((f) => [f.path, f]));
  ok(Object.keys(by).sort().join() === "a.txt,big.txt,bin.dat,gone.txt,new.txt,renamed.txt,src/app.js", `every kind listed once, gitignored never (${Object.keys(by).sort().join()})`);
  ok(by["src/app.js"]?.status === "modified" && by["src/app.js"].add === 3 && by["src/app.js"].del === 1, `unstaged modification: +3 −1 (${JSON.stringify(by["src/app.js"])})`);
  ok(by["a.txt"]?.status === "modified" && by["a.txt"].add === 1 && by["a.txt"].del === 0, `staged modification counted against HEAD too (${JSON.stringify(by["a.txt"])})`);
  ok(by["new.txt"]?.status === "untracked" && by["new.txt"].add === 3 && by["new.txt"].del === 0, `untracked: lines counted, last line without newline included (${JSON.stringify(by["new.txt"])})`);
  ok(by["renamed.txt"]?.status === "renamed" && by["renamed.txt"].from === "old.txt", `rename carries its source (${JSON.stringify(by["renamed.txt"])})`);
  ok(by["gone.txt"]?.status === "deleted" && by["gone.txt"].del === 1, `deleted: −1 (${JSON.stringify(by["gone.txt"])})`);
  ok(by["bin.dat"]?.status === "modified" && by["bin.dat"].add === null && by["bin.dat"].del === null, `binary: add/del null (${JSON.stringify(by["bin.dat"])})`);
  ok(by["src/app.js"].touched === true && Object.values(by).filter((f) => f.touched).length === 1, `touched only for the file this session's transcript wrote (${Object.values(by).filter((f) => f.touched).map((f) => f.path)})`);
  ok(by["a.txt"].touched === false, "a file the transcript only READ (dirty in git) is not attributed to this session");
  const fresh0 = await (await req("/api/sessions/fresh/changes")).json();
  ok(fresh0.root === join(WS, "fresh") && fresh0.files.length === 1 && fresh0.files[0].status === "added" && fresh0.files[0].add === 1, `no-commit repo: staged files listed as added with counts (${JSON.stringify(fresh0.files)})`);
  ok(c.total === 7 && c.truncated === false && by["src/app.js"].abs === join(GIT, "src", "app.js"), `total 7, not truncated, abs path present (${c.total}/${c.truncated})`);
  ok(!JSON.stringify(c).includes(SID), "no session id on the wire");

  console.log("\n[GET /api/sessions/:id/changes/diff]");
  ok((await req("/api/sessions/gitter/changes/diff?path=src/app.js", false)).status === 401, "401 without the token");
  ok((await req("/api/sessions/gitter/changes/diff")).status === 400, "400 without a path");
  const dm = await (await req("/api/sessions/gitter/changes/diff?path=src/app.js")).json();
  ok(dm.path === "src/app.js" && dm.status === "modified" && dm.diff.includes("-line2\n") && dm.diff.includes("+LINE2\n") && dm.diff.includes("+line5") && dm.truncated === false, `tracked file: unified diff against HEAD (${dm.diff?.split("\n").length} lines)`);
  const du = await (await req("/api/sessions/gitter/changes/diff?path=new.txt")).json();
  ok(du.status === "untracked" && du.diff.includes("+n1\n") && du.diff.includes("+n3") && du.diff.includes("+++ b/new.txt") && !du.diff.includes(GIT), `untracked file: whole file as additions, header repo-relative (${JSON.stringify(du.diff?.split("\n").slice(0, 4))})`);
  const dd = await (await req("/api/sessions/gitter/changes/diff?path=gone.txt")).json();
  ok(dd.status === "deleted" && dd.diff.includes("-gone"), `deleted file: removals (${JSON.stringify(dd.diff?.split("\n").slice(-2))})`);
  const dr = await (await req("/api/sessions/gitter/changes/diff?path=renamed.txt")).json();
  ok(dr.status === "renamed" && /rename from old\.txt/.test(dr.diff) && !dr.diff.includes("+old"), `renamed file: git keeps the rename, no whole-file additions (${JSON.stringify(dr.diff?.split("\n").slice(0, 5))})`);
  const dn = await (await req("/api/sessions/fresh/changes/diff?path=hello.txt")).json();
  ok(dn.status === "added" && dn.diff?.includes("+hello"), `no-commit repo: an added file diffs against the empty index, not a missing HEAD (${JSON.stringify(dn)})`);
  const db = await (await req("/api/sessions/gitter/changes/diff?path=big.txt")).json();
  ok(db.truncated === true && Buffer.byteLength(db.diff) <= DIFF_MAX_BYTES, `a diff over ${DIFF_MAX_BYTES} bytes is clipped with truncated:true (${Buffer.byteLength(db.diff || "")})`);
  ok((await req("/api/sessions/gitter/changes/diff?path=.gitignore")).status === 404, "a tracked but unchanged file → 404 (not a file reader)");
  ok((await req(`/api/sessions/gitter/changes/diff?path=${encodeURIComponent("../../../etc/passwd")}`)).status === 404, "a ../ escape → 404 (never in the change set)");
  ok((await req(`/api/sessions/gitter/changes/diff?path=${encodeURIComponent("ignored/x")}`)).status === 404, "a gitignored file → 404");
  ok((await req("/api/sessions/plain/changes/diff?path=x")).status === 404, "a non-git agent → 404");

  console.log("\n[cap + cache]");
  mkdirSync(join(GIT, "many"));
  for (let i = 0; i < CHANGES_MAX_FILES + 5; i++) writeFileSync(join(GIT, "many", `f${i}.txt`), "x\n");
  writeFileSync(join(GIT, "zzz-past.txt"), "past the cap\n"); // sorts last: listed by git, past the 500-row slice
  await sleep(3200); // the per-agent cache is 3 s
  const big = await (await req("/api/sessions/gitter/changes")).json();
  ok(big.total === CHANGES_MAX_FILES + 5 + 8 && big.files.length === CHANGES_MAX_FILES && big.truncated === true, `over ${CHANGES_MAX_FILES} rows: total ${big.total}, ${big.files.length} on the wire, truncated`);
  const past = await (await req(`/api/sessions/gitter/changes/diff?path=${encodeURIComponent(big.files.length ? "zzz-past.txt" : "")}`)).json();
  ok(/truncated/.test(past.error || ""), `a changed file past the cap says the list is truncated, not that it moved on (${past.error})`);
  rmSync(join(GIT, "many"), { recursive: true }); unlinkSync(join(GIT, "zzz-past.txt"));
  const cached = await (await req("/api/sessions/gitter/changes")).json();
  ok(cached.truncated === true, "within 3 s the cached picture is served (the client polls; git is not run per request)");
  await sleep(3200);
  const fresh = await (await req("/api/sessions/gitter/changes")).json();
  ok(fresh.total === 7 && fresh.truncated === false, `after the cache window the picture is current again (${fresh.total})`);

  const rec = readFileSync(join(WS, ".hadron", "agents", "gitter.json"), "utf-8");
  ok(!rec.includes("changes") && !rec.includes("numstat") && !rec.includes("touched"), "nothing about changes reaches the record on disk");
}

main().catch((e) => { console.error(e); failed++; }).finally(() => {
  try { server?.kill("SIGKILL"); } catch {}
  try { rmSync(WS, { recursive: true, force: true }); rmSync(CONFIG, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
