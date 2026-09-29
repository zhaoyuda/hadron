/**
 * Module M27 — the per-agent Changes view.
 *
 * "⎇ Changes" in the file panel opens a tab with git's picture of the agent's
 * cwd: branch, one row per changed file (status letter, path, +/−, a dot for
 * files this session wrote), a click shows the unified diff under the list.
 * Read-only enrichment of the transcript's Changed list — no staging, no
 * commit, no branch verbs. What this proves in a real browser:
 *   - a shell agent (no transcript) reaches the view too: the button sits by
 *     "+ pin a file"; the tab lists the seeded repo's rows with +/− and branch
 *   - a row click paints the diff with coloured +/− lines; × closes it
 *   - a change on disk moves the numbers within the poll (no reload)
 *   - the view for a non-git agent says so instead of erroring
 *
 * Run: node test/e2e/m27-changes-view.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M27 Changes view");
let ws, GIT;
const git = (...a) => execFileSync("git", ["-C", GIT, ...a], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: ["ignore", "pipe", "pipe"] });
const env = await bootWorkspace({
  name: "m27",
  seed(w) {
    ws = w; GIT = join(ws, "repo");
    mkdirSync(join(GIT, "src"), { recursive: true });
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", GIT]);
    writeFileSync(join(GIT, "src", "app.js"), "line1\nline2\nline3\n");
    writeFileSync(join(GIT, "README.md"), "# m27\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    writeFileSync(join(GIT, "src", "app.js"), "line1\nLINE2\nline3\nline4\n"); // +2 −1
    writeFileSync(join(GIT, "new.txt"), "n1\nn2\n");                          // untracked
  },
});
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, { method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}) });

try {
  const mk = await api("POST", "/api/sessions", { name: "Gitter", launchCommand: "shell", cwd: GIT });
  r.ok(mk.status === 201, "shell agent created in the repo");
  const gitter = (await mk.json()).id;
  const mk2 = await api("POST", "/api/sessions", { name: "Plain", launchCommand: "shell" });
  const plain = (await mk2.json()).id;

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="${gitter}"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="${gitter}"]`).first().click();
  await page.locator("#af-changes-btn").waitFor({ state: "visible", timeout: 10000 });
  r.ok((await page.locator("#af-changes-btn").textContent()).includes("Changes"), "the file panel offers ⎇ Changes next to + pin a file");
  await page.locator("#af-changes-btn").click();
  r.ok(await until(async () => (await page.locator(".wh-tab.active").textContent()).replace("×", "").trim() === "Changes"), `a Changes tab opens and is active (${await page.locator(".wh-tab.active").textContent()})`);
  const rows = () => page.locator("#changes-container .chg-row .chg-path").allTextContents();
  r.ok(await until(async () => (await rows()).join() === "src/app.js,new.txt"), `rows in git status order: the modified file, then the untracked one (${(await rows()).join()})`);
  r.ok((await page.locator("#changes-container .chg-branch").textContent()).trim() === "⎇ main", `branch shown (${(await page.locator("#changes-container .chg-branch").textContent()).trim()})`);
  const app = page.locator("#changes-container .chg-row", { hasText: "app.js" });
  r.ok((await app.locator(".chg-st").textContent()) === "M" && (await app.locator(".chg-add").textContent()) === "+2" && (await app.locator(".chg-del").textContent()) === "−1", `app.js: M +2 −1 (${await app.locator(".chg-nums").textContent()})`);
  const nw = page.locator("#changes-container .chg-row", { hasText: "new.txt" });
  r.ok((await nw.locator(".chg-st").textContent()) === "U" && (await nw.locator(".chg-add").textContent()) === "+2", `new.txt: U +2 (${await nw.locator(".chg-nums").textContent()})`);
  r.ok((await page.locator("#changes-container .chg-touched").count()) === 0, "a shell agent has no transcript, so no row carries the written-by-this-session dot");

  await app.click();
  const diff = page.locator("#changes-container .chg-diff");
  r.ok(await until(async () => (await diff.textContent()).includes("+LINE2")), "clicking a row paints its diff");
  r.ok((await diff.locator(".chg-l-add").allTextContents()).join("|") === "+LINE2|+line4" && (await diff.locator(".chg-l-del").allTextContents()).join("|") === "-line2" && (await diff.locator(".chg-l-hunk").count()) === 1, `+/− lines coloured, hunk header marked (${(await diff.locator(".chg-l-add").allTextContents()).join("|")})`);
  r.ok(await app.evaluate((el) => el.classList.contains("sel")), "the clicked row is marked selected");
  r.ok((await page.locator("#changes-container .chg-diff-path").textContent()) === "src/app.js", "the diff header names the file");
  await page.screenshot({ path: join(screenshotDir(), "m27-changes.png") });

  // a change on disk moves the numbers within the poll, selection kept
  writeFileSync(join(GIT, "src", "app.js"), "line1\nLINE2\nline3\nline4\nline5\nline6\n");
  r.ok(await until(async () => (await app.locator(".chg-add").textContent()) === "+4", 15000), `an edit on disk updates the row within the poll (${await app.locator(".chg-add").textContent()})`);
  r.ok(await until(async () => (await diff.textContent()).includes("+line6"), 15000), "…and the open diff follows");
  r.ok(await app.evaluate((el) => el.classList.contains("sel")), "…selection survives the refresh");
  await page.locator("#changes-container .chg-diff-close").click();
  r.ok(await page.locator("#changes-container .chg-diff-wrap").evaluate((el) => el.hidden), "× hides the diff");
  r.ok(!(await app.evaluate((el) => el.classList.contains("sel"))), "…and clears the selection");

  // non-git agent
  await page.locator(`.dk[data-sid="${plain}"]`).first().click();
  await page.locator("#af-changes-btn").click();
  r.ok(await until(async () => (await page.locator("#changes-container .chg-empty").textContent()).includes("not inside a git repository")), `a non-git agent's view says so (${await page.locator("#changes-container .chg-empty").textContent()})`);
  await page.locator(".wh-tab", { hasText: "Primary" }).click();
  r.ok(await until(async () => !(await page.locator("#changes-container").evaluate((el) => el.classList.contains("active")))), "switching back to Primary hides the view");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
