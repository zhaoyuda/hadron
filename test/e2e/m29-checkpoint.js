/**
 * Module M29 — Checkpoint (the agent's own handoff, server/checkpoint.js).
 *
 *   - script (in-pane): `hadron checkpoint --goal … --next …` run from INSIDE the
 *     agent's pane lands on the record ({goal,next,at}, no --blocked → no key).
 *   - browser: the card's sub line shows "→ next" (.dk-cp) while the agent is
 *     idle; the tooltip carries goal + next under "checkpoint"; a `--blocked`
 *     update wins the sub line ("⚠ …"); the card survives a reload; `clear`
 *     removes the line again; the open GET carries the checkpoint (no token
 *     needed — it is the agent's own summary, not a secret).
 *
 * Run: node test/e2e/m29-checkpoint.js
 */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { bootWorkspace, reporter, screenshotDir } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(REPO, "bin", "hadron.js");
const r = reporter("M29 Checkpoint");
const env = await bootWorkspace({ name: "m29" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}
const paneOf = (id) => `hadron-${env.wsName}-${id}`;
function typeInPane(id, cmd) {
  execFileSync("tmux", ["send-keys", "-t", paneOf(id), "-l", "--", cmd]);
  execFileSync("tmux", ["send-keys", "-t", paneOf(id), "Enter"]);
}
function capturePane(id) {
  try { return execFileSync("tmux", ["capture-pane", "-t", paneOf(id), "-p", "-J"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}
const agentJson = (id) => JSON.parse(readFileSync(join(env.ws, ".hadron", "agents", `${id}.json`), "utf-8"));
const openGet = async () => (await (await fetch(`${env.baseUrl}/api/sessions`)).json());

try {
  const res = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-hadron-token": env.token },
    body: JSON.stringify({ name: "Writer", launchCommand: "shell" }),
  });
  r.ok(res.status === 201, "shell agent created");
  const A = "writer";

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  const card = page.locator(`.dk[data-sid="${A}"]`).first();
  await card.waitFor({ state: "visible", timeout: 10000 });
  const shot = (n) => page.screenshot({ path: join(screenshotDir(), `m29-${n}.png`) });

  r.ok((await card.locator(".dk-cp").count()) === 0, "no checkpoint line before one is written");

  // ── in-pane CLI: the agent writes its own handoff ──
  typeInPane(A, `node ${CLI} checkpoint --goal "wire the M29 module" --next "run the e2e gate" -- test/e2e/m29-checkpoint.js`);
  r.ok(await until(() => agentJson(A).checkpoint?.next === "run the e2e gate"), "checkpoint on the record within the poll");
  const cp = agentJson(A).checkpoint;
  r.ok(cp.goal === "wire the M29 module" && !("blocked" in cp) && Array.isArray(cp.outputs) && cp.outputs[0] === "test/e2e/m29-checkpoint.js" && !Number.isNaN(Date.parse(cp.at)),
    `record: goal + next + outputs + at, no blocked key (${JSON.stringify(cp)})`);
  r.ok(await until(() => capturePane(A).includes("checkpoint: wire the M29 module")), "the CLI echoes the checkpoint it wrote");

  r.ok(await until(async () => (await card.locator(".dk-cp").textContent().catch(() => "")) === "→ run the e2e gate"),
    'card sub line shows "→ next" while idle');
  let tip = await card.getAttribute("title");
  r.ok(/^checkpoint/.test(tip || "") && tip.includes("goal: wire the M29 module") && tip.includes("next: run the e2e gate") && tip.includes("outputs: test/e2e/m29-checkpoint.js"),
    `tooltip lists goal / next / outputs under "checkpoint" (${JSON.stringify(tip)})`);
  await shot("next-line");

  const wire = (await openGet()).find((s) => s.id === A);
  r.ok(wire?.checkpoint?.next === "run the e2e gate" && wire.checkpoint.goal === "wire the M29 module", "open GET /api/sessions carries the checkpoint");

  // ── blocked wins the sub line; merge keeps goal + next ──
  typeInPane(A, `node ${CLI} checkpoint --blocked "waiting on the gate"`);
  r.ok(await until(() => agentJson(A).checkpoint?.blocked === "waiting on the gate"), "--blocked merges into the existing checkpoint");
  r.ok(agentJson(A).checkpoint.goal === "wire the M29 module" && agentJson(A).checkpoint.next === "run the e2e gate", "goal and next kept by the merge");
  r.ok(await until(async () => (await card.locator(".dk-cp").textContent().catch(() => "")) === "⚠ waiting on the gate"),
    'card sub line switches to "⚠ blocked"');
  tip = await card.getAttribute("title");
  r.ok((tip || "").includes("blocked: waiting on the gate"), "tooltip carries the blocked line");
  await shot("blocked-line");

  // ── reload: the line comes from the server, not client memory ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await card.waitFor({ state: "visible", timeout: 10000 });
  r.ok(await until(async () => (await card.locator(".dk-cp").textContent().catch(() => "")) === "⚠ waiting on the gate"),
    "checkpoint line survives a reload");

  // ── show + clear ──
  typeInPane(A, `node ${CLI} checkpoint show`);
  r.ok(await until(() => /⚠ waiting on the gate/.test(capturePane(A))), "`hadron checkpoint show` prints the blocked line");
  typeInPane(A, `node ${CLI} checkpoint clear`);
  r.ok(await until(() => !("checkpoint" in agentJson(A))), "`hadron checkpoint clear` removes it from the record");
  r.ok(await until(async () => (await card.locator(".dk-cp").count()) === 0), "card line gone after clear");
  r.ok(!((await openGet()).find((s) => s.id === A) || {}).checkpoint, "open GET no longer carries a checkpoint");
  await shot("cleared");

  r.ok(pageErrors.length === 0, `zero page errors${pageErrors.length ? ` (got: ${pageErrors.join(" | ")})` : ""}`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
