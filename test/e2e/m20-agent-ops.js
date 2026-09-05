/**
 * Module M20 — Agent ops (design-notes/agent-ops-spec.md).
 *
 * Pin/close/restore/message as a user journey across both surfaces:
 *   - browser: context-menu Pin → "📌 Pinned" section renders FIRST, card moved
 *     (not duplicated) out of its group with a visible indicator; survives the 3s
 *     refresh and a full reload; shows in BOTH deck modes; Unpin restores.
 *   - script + browser: `hadron pin <name>` (by NAME) reflects in the deck.
 *   - script: `hadron close <name>` → tmux actually dead, JSON kept archived:true,
 *     `hadron ls --archived` lists it, `hadron restore <name>` revives it.
 *   - tmux: `hadron message` fired from INSIDE agent A's pane carries the sender
 *     attribution prefix into agent B's pane; --raw suppresses it.
 *   - ambiguous names exit 1 with candidates and deliver nothing.
 *
 * Run: node test/e2e/m20-agent-ops.js
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const r = reporter("M20 Agent ops");
const env = await bootWorkspace({ name: "m20" });
const port = env.baseUrl.split(":").pop();
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}

// TMUX cleared: these CLI calls model a plain (non-agent) shell — no attribution.
function hadron(args, opts = {}) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token, TMUX: "" },
    ...opts,
  });
}

const paneOf = (id) => `hadron-${env.wsName}-${id}`;
function capturePane(id) {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", paneOf(id), "-p", "-J"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}
function tmuxAlive(id) {
  try { execFileSync("tmux", ["has-session", "-t", paneOf(id)], { stdio: "ignore" }); return true; }
  catch { return false; }
}
function typeInPane(id, cmd) {
  execFileSync("tmux", ["send-keys", "-t", paneOf(id), "-l", "--", cmd]);
  execFileSync("tmux", ["send-keys", "-t", paneOf(id), "Enter"]);
}

const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, {
  method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}),
});
const agentJson = (id) => JSON.parse(readFileSync(join(env.ws, ".hadron", "agents", `${id}.json`), "utf-8"));

try {
  // ── fixtures: two shell agents (panes double as message endpoints) ──
  for (const name of ["Alpha One", "Beta Two"]) {
    const res = await api("POST", "/api/sessions", { name, launchCommand: "shell" });
    r.ok(res.status === 201, `agent "${name}" created`);
  }
  const A = "alpha-one", B = "beta-two";

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="${A}"]`).waitFor({ state: "visible", timeout: 10000 });

  const pinnedSection = page.locator(".deck-group-pinned");
  const inPinned = (sid) => page.locator(`.deck-group-pinned .dk[data-sid="${sid}"]`);
  const inWorkers = (sid) => page.locator(`.deck-group[data-group="workers"] .dk[data-sid="${sid}"]`);
  const shot = (name) => page.screenshot({ path: join(screenshotDir(), `m20-${name}.png`) });

  async function ctxAction(sid, action) {
    await page.locator(`.dk[data-sid="${sid}"]`).first().click({ button: "right" });
    await page.locator(`#ctx-menu .cm-item[data-action="${action}"]`).waitFor({ state: "visible", timeout: 3000 });
    await page.locator(`#ctx-menu .cm-item[data-action="${action}"]`).click();
  }

  // ── 1. pin via context menu (group mode) ──
  await ctxAction(A, "pin");
  await pinnedSection.waitFor({ state: "visible", timeout: 5000 });
  r.ok(await page.locator(".deck-group").first().evaluate((el) => el.classList.contains("deck-group-pinned")),
    "'📌 Pinned' section renders FIRST in the deck");
  r.ok(await inPinned(A).count() === 1, "pinned card lives in the Pinned section");
  r.ok(await inWorkers(A).count() === 0, "card MOVED out of its group (not duplicated)");
  r.ok(await inPinned(A).locator(".dk-pin").isVisible(), "pin indicator visible on the card");
  r.ok(agentJson(A).pinned === true, "pinned persisted to the agent JSON");
  await shot("pinned-group-mode");

  // survives the 3s deck refresh (renderDeck from polled state, not local memory)
  await wait(3500);
  r.ok(await inPinned(A).count() === 1, "pinned section survives the 3s deck refresh");

  // survives a full reload
  await page.reload({ waitUntil: "domcontentloaded" });
  await pinnedSection.waitFor({ state: "visible", timeout: 10000 });
  r.ok(await inPinned(A).count() === 1, "pinned section survives a full page reload");

  // ── both deck modes: status buckets show it too ──
  await page.evaluate(() => { deckGroupBy = "status"; renderDeck(); });
  r.ok(await page.locator(".deck-group").first().evaluate((el) => el.classList.contains("deck-group-pinned")),
    "status mode: pinned section still renders first");
  r.ok(await inPinned(A).count() === 1, "status mode: card stays in the Pinned section");
  r.ok(await page.locator(`.deck-group-status .dk[data-sid="${A}"]`).count() === 0,
    "status mode: card is not duplicated into a status bucket");
  await shot("pinned-status-mode");
  await page.evaluate(() => { deckGroupBy = "group"; renderDeck(); });

  // ── unpin via context menu → section disappears, card back in its group ──
  await ctxAction(A, "pin");
  await until(async () => (await pinnedSection.count()) === 0);
  r.ok(await pinnedSection.count() === 0, "unpin removes the Pinned section (no empty header)");
  r.ok(await inWorkers(A).count() === 1, "card returned to its group");
  r.ok(!("pinned" in agentJson(A)), "unpin persisted (field absent on disk)");

  // ── 2. CLI pin by NAME reflects in the deck ──
  const pinOut = hadron(["pin", "Beta Two"]);
  r.ok(/pinned Beta Two \(beta-two\)/.test(pinOut), "hadron pin resolves the NAME to the id");
  r.ok(await until(async () => (await inPinned(B).count()) === 1), "deck shows the CLI-pinned agent after refresh");
  hadron(["unpin", "Beta Two"]);
  await until(async () => (await pinnedSection.count()) === 0);

  // ── 4. messaging with attribution, fired from INSIDE agent A's pane ──
  // (before close/restore so B's original pane is still the delivery target)
  const CLI = join(REPO, "bin", "hadron.js");
  typeInPane(A, `node ${CLI} message "Beta Two" "ping-e2e-attr" --no-enter --force`);
  r.ok(await until(() => capturePane(B).includes("ping-e2e-attr")), "message text landed in the target pane");
  r.ok(capturePane(B).includes(`[hadron message from Alpha One (${A})]`),
    "attribution prefix names the SENDING agent (whoami inside the pane)");
  execFileSync("tmux", ["send-keys", "-t", paneOf(B), "C-c"]);

  typeInPane(A, `node ${CLI} message "Beta Two" "ping-raw-probe" --raw --no-enter --force`);
  r.ok(await until(() => capturePane(B).includes("ping-raw-probe")), "--raw message landed");
  const attrCount = (capturePane(B).match(/\[hadron message from/g) || []).length;
  r.ok(attrCount === 1, "--raw suppressed the attribution prefix (only the earlier one on screen)");
  execFileSync("tmux", ["send-keys", "-t", paneOf(B), "C-c"]);

  // ── 5. ambiguous name → exit 1, candidates listed, nothing delivered ──
  await api("PATCH", `/api/sessions/${A}`, { name: "Twin" });
  await api("PATCH", `/api/sessions/${B}`, { name: "Twin" });
  let amb = null;
  try { hadron(["message", "Twin", "never-delivered"], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { amb = { status: e.status, stderr: String(e.stderr || "") }; }
  r.ok(amb !== null && amb.status === 1, "ambiguous target name → CLI exits non-zero");
  r.ok(amb !== null && amb.stderr.includes(A) && amb.stderr.includes(B), "error lists both candidates (id + name)");
  await wait(600);
  r.ok(!capturePane(A).includes("never-delivered") && !capturePane(B).includes("never-delivered"),
    "no message was delivered to either candidate");
  await api("PATCH", `/api/sessions/${A}`, { name: "Alpha One" });
  await api("PATCH", `/api/sessions/${B}`, { name: "Beta Two" });

  // ── 3. close → archived on disk, tmux dead; ls --archived; restore → back ──
  const closeOut = hadron(["close", "Beta Two"]);
  r.ok(/archived Beta Two \(beta-two\)/.test(closeOut), "hadron close resolves the name and archives");
  r.ok(await until(async () => (await page.locator(`.dk[data-sid="${B}"]`).count()) === 0),
    "closed agent leaves the deck");
  r.ok(!tmuxAlive(B), "tmux session is actually gone (has-session fails)");
  r.ok(existsSync(join(env.ws, ".hadron", "agents", `${B}.json`)) && agentJson(B).archived === true,
    "agent JSON kept on disk with archived:true");

  const lsOut = hadron(["ls", "--archived"]);
  r.ok(lsOut.includes(B) && lsOut.includes("Beta Two"), "hadron ls --archived lists the closed agent");

  const restoreOut = hadron(["restore", "Beta Two"]);
  r.ok(/restored Beta Two \(beta-two\)/.test(restoreOut), "hadron restore resolves against the ARCHIVED list");
  r.ok(await until(async () => (await page.locator(`.dk[data-sid="${B}"]`).count()) === 1),
    "restored agent is back in the deck");
  await shot("after-restore");

  r.ok(pageErrors.length === 0, `zero page errors${pageErrors.length ? ` (got: ${pageErrors.join(" | ")})` : ""}`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
