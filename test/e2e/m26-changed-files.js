/**
 * Module M26 — the file panel's Changed / Core / Pinned model.
 *
 * Above Pinned (the artifacts), a claude agent's panel lists the files its session wrote:
 * every Edit/Write/MultiEdit/NotebookEdit call in claude's own transcript
 * (sidechain included), attributed per SESSION — two agents in one cwd are
 * told apart, which `git status` in that cwd cannot do. What this proves in
 * a real browser:
 *   - seeded transcripts → "CHANGED" group with a count, rows newest write
 *     first, path relative to the agent's cwd, write count + age on the right,
 *     a Read-only file never listed; two agents in one cwd list their own
 *   - a click opens the file as an ephemeral `file:` tab — no artifact is
 *     created
 *   - an Edit appended to the transcript moves the row within poll + refresh
 *   - the header collapses and the collapse survives the 3-s refresh
 *   - CORE: the files the session keeps returning to, by heat (3·writes +
 *     reads, ties by recency), reads included; hover → 📌 pins it (a file
 *     artifact appears under Pinned, the row leaves Core) or × hides it
 *     (`coreDismissed` on the record, survives the refresh); a Pinned file is
 *     never listed in Core twice
 *   - two agents that wrote one file: each Changed row says "also <other>"
 *   - the Artifacts header reads "Pinned", the add button "+ pin a file",
 *     `hadron artifacts pin` is the CLI verb (add stays an alias)
 *   - the wire form: `files` rides /api/sessions only for a token-bearing
 *     GET (paths are the agent's business); /api/sessions/:id/files carries
 *     every touched file (reads too), 401 without the token; a shell agent
 *     has none; nothing reaches the agent's record on disk
 *
 * Run: node test/e2e/m26-changed-files.js
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M26 Changed / Core / Pinned");
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m26-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const SIDS = { alpha: randomUUID(), beta: randomUUID() };
const now = () => new Date().toISOString();
const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const tool = (name, input, when = now(), extra = {}) => JSON.stringify({
  type: "assistant", timestamp: when, ...extra,
  message: { id: `m-${Math.random().toString(36).slice(2)}`, role: "assistant", content: [{ type: "tool_use", id: `t-${Math.random().toString(36).slice(2)}`, name, input }] },
}) + "\n";
let transcriptDir, ws;
const env = await bootWorkspace({
  name: "m26",
  seed(w) {
    ws = w;
    transcriptDir = join(CONFIG, "projects", claudeProjectDir(ws));
    mkdirSync(transcriptDir, { recursive: true });
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "app.js"), "console.log('app')\n");
    writeFileSync(join(ws, "src", "util.js"), "export const u = 1\n");
    writeFileSync(join(ws, "README.md"), "# m26\n");
    writeFileSync(join(ws, "notes.md"), "notes\n");
    const dir = join(ws, ".hadron", "agents");
    mkdirSync(dir, { recursive: true });
    for (const [id, sid] of Object.entries(SIDS)) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({
        id, name: id[0].toUpperCase() + id.slice(1), group: "Workers", cwd: ws,
        runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: sid, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() },
      }, null, 2));
      writeFileSync(join(transcriptDir, `${sid}.jsonl`), JSON.stringify({ type: "user", timestamp: now(), message: { role: "user", content: "hi" } }) + "\n");
    }
    // alpha: README written 30 min ago, app.js edited twice (last 2 min ago),
    // util.js only read, a subagent (sidechain) wrote notes.md 10 min ago.
    appendFileSync(join(transcriptDir, `${SIDS.alpha}.jsonl`),
      tool("Write", { file_path: join(ws, "README.md"), content: "# m26" }, at(30)) +
      tool("Read", { file_path: join(ws, "src", "util.js") }, at(20)) +
      tool("Edit", { file_path: join(ws, "src", "app.js"), old_string: "a", new_string: "b" }, at(15)) +
      tool("Edit", { file_path: join(ws, "src", "app.js"), old_string: "b", new_string: "c" }, at(2)) +
      tool("Write", { file_path: join(ws, "notes.md"), content: "notes" }, at(10), { isSidechain: true }) +
      JSON.stringify({ type: "assistant", timestamp: now(), message: { id: "m-text", role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
    // beta, same cwd: only util.js.
    appendFileSync(join(transcriptDir, `${SIDS.beta}.jsonl`), tool("Edit", { file_path: join(ws, "src", "util.js"), old_string: "1", new_string: "2" }, at(5)));
  },
});
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, {
  method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}),
});
const listed = async (auth = true) => (await (auth ? api("GET", "/api/sessions") : fetch(`${env.baseUrl}/api/sessions`))).json();
const filesOf = async (id, auth = true) => (await listed(auth)).find((s) => s.id === id)?.files ?? null;
const rel = (p) => p.startsWith(ws + "/") ? p.slice(ws.length + 1) : p;

try {
  // ── wire form ──────────────────────────────────────────────────────────
  const shell = await api("POST", "/api/sessions", { name: "Plain", launchCommand: "shell" });
  r.ok(shell.status === 201, "shell agent created");
  const plain = (await shell.json()).id;
  r.ok(await until(async () => (await filesOf("alpha"))?.total === 3), `alpha: files.total 3 on the token-bearing list (${JSON.stringify(await filesOf("alpha"))})`);
  const alpha = await filesOf("alpha");
  r.ok(alpha.complete === true && alpha.changed.map((e) => rel(e.path)).join() === "src/app.js,notes.md,README.md", `changed: newest write first, the sidechain's write included, the Read-only util.js absent (${alpha.changed.map((e) => rel(e.path)).join()})`);
  r.ok(alpha.changed[0].writes === 2 && alpha.changed[0].reads === 0 && typeof alpha.changed[0].lastWriteAt === "string", `app.js: writes 2 (${JSON.stringify(alpha.changed[0])})`);
  const beta = await filesOf("beta");
  r.ok(beta?.total === 1 && rel(beta.changed[0].path) === "src/util.js", `beta, same cwd, lists only its own util.js (${JSON.stringify(beta?.changed.map((e) => rel(e.path)))})`);
  r.ok((await filesOf(plain)) === null, "a shell agent (no session) has no files field");
  const anon = await listed(false);
  r.ok(anon.every((s) => !("files" in s)) && anon.find((s) => s.id === "alpha"), "open GET: no files field on any agent — paths need the token");
  const full = await (await api("GET", "/api/sessions/alpha/files")).json();
  r.ok(full && full.complete && full.files.length === 4 && full.files.find((e) => rel(e.path) === "src/util.js")?.reads === 1 && full.files.find((e) => rel(e.path) === "src/util.js").writes === 0, `/api/sessions/:id/files carries every touched file, reads included (${full?.files.map((e) => rel(e.path)).join()})`);
  r.ok((await fetch(`${env.baseUrl}/api/sessions/alpha/files`)).status === 401, "…401 without the token");
  r.ok((await (await api("GET", `/api/sessions/${plain}/files`)).json()) === null, "…null for a shell agent");
  r.ok(!JSON.stringify(full).includes(SIDS.alpha) && !JSON.stringify(alpha).includes(SIDS.alpha), "no session id anywhere in either form");

  // ── panel ──────────────────────────────────────────────────────────────
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  const group = page.locator(".af-changed");
  const rows = () => page.locator(".af-changed .af-changed-row .af-label").allTextContents();
  r.ok(await until(async () => (await rows()).join() === "src/app.js,notes.md,README.md"), `panel shows CHANGED rows newest first, relative to the agent's cwd (${(await rows()).join()})`);
  r.ok((await group.locator(".af-count").textContent()).trim() === "3", `header count 3 (${(await group.locator(".af-count").textContent()).trim()})`);
  const subs = await page.locator(".af-changed .af-changed-row .af-sub").allTextContents();
  r.ok(subs[0].trim() === "2× 2m" && subs[2].trim() === "30m", `rows carry write count + age: "2× 2m", "30m" (${JSON.stringify(subs)})`);
  const pinnedHdr = page.locator(".rp-hdr", { hasText: "Pinned" });
  r.ok((await pinnedHdr.count()) === 1 && (await page.locator(".rp-hdr", { hasText: "Artifacts" }).count()) === 0 && (await page.locator(".af-changed").boundingBox()).y < (await pinnedHdr.first().boundingBox()).y, "the group sits above the Pinned header (no Artifacts header any more)");
  r.ok((await page.locator("#af-add-btn").textContent()).trim() === "+ pin a file", `the add button says "+ pin a file" (${(await page.locator("#af-add-btn").textContent()).trim()})`);

  // ── Core: heat ranking, pin, dismiss ───────────────────────────────────
  const coreRows = () => page.locator(".af-core .af-core-row .af-label").allTextContents();
  r.ok(await until(async () => (await coreRows()).join() === "src/app.js,notes.md,README.md,src/util.js"), `CORE ranks by heat: app.js (2 writes) first, notes before README (tie → newer), the read-only util.js last (${(await coreRows()).join()})`);
  const coreGroup = page.locator(".af-core");
  r.ok((await coreGroup.boundingBox()).y > (await group.boundingBox()).y && (await coreGroup.boundingBox()).y < (await pinnedHdr.first().boundingBox()).y, "…between Changed and Pinned");
  const coreSubs = await page.locator(".af-core .af-core-row .af-sub").allTextContents();
  r.ok(coreSubs[0].trim() === "2× 2m" && coreSubs[3].trim() === "1× 20m", `rows carry touch count + age (${JSON.stringify(coreSubs)})`);
  r.ok(alpha.core.length === 4 && alpha.core[0].reads === 0 && alpha.core[3].reads === 1 && alpha.core[3].writes === 0, `wire: files.core carries the ranked entries with reads (${JSON.stringify(alpha.core.map((e) => [rel(e.path), e.writes, e.reads]))})`);
  await page.screenshot({ path: join(screenshotDir(), "m26-changed.png") });
  // pin app.js → a file artifact under Pinned, the Core row leaves
  await page.locator(".af-core .af-core-row").first().hover();
  await page.locator(".af-core .af-core-row").first().locator("[data-core-pin]").click();
  r.ok(await until(async () => (await page.locator(".af[data-art-idx] .af-label").allTextContents()).includes("app.js")), `📌 on a Core row pins it: app.js is listed under Pinned (${(await page.locator(".af[data-art-idx] .af-label").allTextContents()).join()})`);
  r.ok(await until(async () => !(await coreRows()).includes("src/app.js")), `…and it left Core (${(await coreRows()).join()})`);
  const recPin = JSON.parse(readFileSync(join(ws, ".hadron", "agents", "alpha.json"), "utf-8"));
  r.ok(recPin.artifacts?.length === 1 && recPin.artifacts[0].type === "file" && recPin.artifacts[0].value.endsWith("src/app.js"), `…persisted as a file artifact (${JSON.stringify(recPin.artifacts)})`);
  r.ok(await until(async () => !((await filesOf("alpha")).core.some((e) => rel(e.path) === "src/app.js"))), "…the server's core list drops the pinned file (pinning is promotion, not duplication)");
  // dismiss README → gone, persisted, still gone after the refresh
  const readme = page.locator(".af-core .af-core-row", { hasText: "README.md" });
  await readme.hover();
  await readme.locator("[data-core-dismiss]").click();
  r.ok(await until(async () => (await coreRows()).join() === "notes.md,src/util.js"), `× hides README from Core (${(await coreRows()).join()})`);
  r.ok(await until(async () => (JSON.parse(readFileSync(join(ws, ".hadron", "agents", "alpha.json"), "utf-8")).coreDismissed || []).some((p) => p.endsWith("README.md"))), "…coreDismissed persisted on the record");
  await wait(3500);
  r.ok((await coreRows()).join() === "notes.md,src/util.js", `…still hidden after the 3-s refresh (${(await coreRows()).join()})`);
  r.ok(await until(async () => (await rows()).join() === "src/app.js,notes.md,README.md"), "Changed still lists README (dismissing from Core is not forgetting the write)");

  // click → ephemeral file tab, no artifact
  await page.locator(".af-changed .af-changed-row").first().click();
  r.ok(await until(async () => (await page.locator(".wh-tab.active").textContent()).includes("app.js")), `clicking a row opens app.js as a tab (${await page.locator(".wh-tab.active").textContent()})`);
  const rec = JSON.parse(readFileSync(join(ws, ".hadron", "agents", "alpha.json"), "utf-8"));
  r.ok((rec.artifacts || []).length === 1, "…ephemeral: no artifact was created (only the one pinned above)");
  r.ok(!("files" in rec) && !readFileSync(join(ws, ".hadron", "agents", "alpha.json"), "utf-8").includes("lastWriteAt"), "nothing about changed files reaches the record on disk");

  // live update: a new edit lands on top — and beta wrote util.js too, so the
  // row says so.
  appendFileSync(join(transcriptDir, `${SIDS.alpha}.jsonl`), tool("Edit", { file_path: join(ws, "src", "util.js"), old_string: "1", new_string: "3" }));
  r.ok(await until(async () => (await rows())[0] === "src/util.js" && (await rows()).length === 4), `an Edit appended to the transcript puts util.js on top within poll + refresh (${(await rows()).join()})`);
  r.ok(await until(async () => (await group.locator(".af-count").textContent()).trim() === "4"), "…count 4");
  const alsoOf = (label) => page.locator(".af-changed .af-changed-row", { hasText: label }).locator(".af-also").allTextContents();
  r.ok(await until(async () => (await alsoOf("src/util.js")).join() === "also Beta"), `util.js, written by both agents, says "also Beta" (${(await alsoOf("src/util.js")).join()})`);
  r.ok((await alsoOf("notes.md")).length === 0, "a file only alpha wrote carries no hint");
  r.ok(await until(async () => (await coreRows())[0] === "src/util.js"), `Core re-ranks: util.js (1 write + 1 read) now hottest of the unpinned (${(await coreRows()).join()})`);

  // collapse survives the refresh
  await group.locator(".af-group-hdr").click();
  r.ok(!(await group.evaluate((el) => el.classList.contains("open"))), "header click collapses the group");
  await wait(3500);
  r.ok(!(await page.locator(".af-changed").evaluate((el) => el.classList.contains("open"))) && (await page.locator(".af-changed .af-count").textContent()).trim() === "4", "…and it stays collapsed across the 3-s refresh, count still shown");
  await page.locator(".af-changed .af-group-hdr").click();
  r.ok(await page.locator(".af-changed").evaluate((el) => el.classList.contains("open")), "…click again re-opens it");

  // beta's panel is its own
  await page.locator(`.dk[data-sid="beta"]`).first().click();
  r.ok(await until(async () => (await rows()).join() === "src/util.js"), `switching to beta shows beta's one file (${(await rows()).join()})`);
  r.ok(await until(async () => (await alsoOf("src/util.js")).join() === "also Alpha"), `…and its row says "also Alpha" (${(await alsoOf("src/util.js")).join()})`);
  r.ok((await coreRows()).join() === "src/util.js" && (await page.locator(".af-core .af-core-row .af-sub").first().textContent()).trim() === "1× 5m", "beta's Core is its own one file");
  // CLI: `hadron artifacts pin` is the verb; usage names it
  const help = execFileSync("node", [join(REPO, "bin", "hadron.js"), "help"], { encoding: "utf-8", env: { ...process.env, HADRON_PORT: env.baseUrl.split(":").pop(), HADRON_TOKEN: env.token } });
  r.ok(/hadron artifacts pin \[--auto \| <path\.\.\.>\].*alias: add/.test(help), "`hadron help` documents `hadron artifacts pin` with add as the alias");
  await page.locator(`.dk[data-sid="${plain}"]`).first().click();
  r.ok(await until(async () => (await page.locator(".af-changed").count()) === 0), "the shell agent's panel has no Changed group");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
  rmSync(CONFIG, { recursive: true, force: true });
}
process.exit(r.finish() ? 0 : 1);
