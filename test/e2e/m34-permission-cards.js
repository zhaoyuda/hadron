/**
 * Module M34 — permission cards under the chat view (G4).
 *
 * A fixture process NAMED claude (test/e2e/fixtures/claude-m34.sh, exec'd over
 * the shell after boot) shows claude's own Bash permission dialog and logs
 * every key it gets; the server parses the dialog out of the pane and the chat
 * view draws it as a card between the transcript and the composer:
 *   - the card says "Bash command", shows `rm -f zz.txt` as code, the question,
 *     the four real options (option 2 with its scope detail) and Amend / Cancel;
 *     the live line says "Needs input · answer below"
 *   - Yes → claude gets "1", the card says Answered, then goes away when the
 *     pane is idle again; the composer stays
 *   - the dialog back (D) → the card is back; Cancel (Esc) → claude gets ESC
 *   - Amend… → an inline field; Enter → Tab, the text, Enter reach claude
 *   - a key the pane no longer shows (the dialog answered from elsewhere) →
 *     the card repaints from the 409, nothing typed twice
 *   - the folder-trust list (T): unnumbered rows, a row click → Down, Enter
 *
 * Run: node test/e2e/m34-permission-cards.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, chmodSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";
import { claudeProjectDir } from "../../server/resume.js";

const r = reporter("M34 permission cards");
const CONFIG = mkdtempSync(join(tmpdir(), "hadron-m34-claude-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const SID = randomUUID();
const now = () => new Date().toISOString();
const rec = (o) => JSON.stringify({ uuid: randomUUID(), timestamp: now(), ...o }) + "\n";
const user = (text) => rec({ type: "user", message: { role: "user", content: text } });
const asst = (id, text) => rec({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }], model: "claude-x", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" } });
let ws;
const FIXDIR = mkdtempSync(join(tmpdir(), "hadron-m34-fix-"));
const FIXTURE = join(FIXDIR, "claude");
const LOG = join(FIXDIR, "claude-keys.log");
writeFileSync(FIXTURE, readFileSync(new URL("./fixtures/claude-m34.sh", import.meta.url), "utf-8"));
chmodSync(FIXTURE, 0o755);

const env = await bootWorkspace({
  name: "m34",
  seed(w) {
    ws = w;
    const dir = join(CONFIG, "projects", claudeProjectDir(ws));
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(ws, ".hadron", "agents"), { recursive: true });
    writeFileSync(join(ws, ".hadron", "agents", "alpha.json"), JSON.stringify({
      id: "alpha", name: "Alpha", group: "Workers", cwd: ws,
      runtime: { desiredRuntime: "claude", observedRuntime: "shell", cleanExitAt: now(), sessionId: SID, confidence: "manual", lastObservedAt: now(), lastPersistedAt: now() },
    }, null, 2));
    writeFileSync(join(dir, `${SID}.jsonl`), user("删掉 zz.txt") + asst("m1", "好的，我来删。"));
  },
});
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, { method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}) });
const alpha = async () => (await (await api("GET", "/api/sessions")).json()).find((s) => s.id === "alpha");
const keys = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8") : "").split("\n").filter(Boolean);
const tmuxName = `hadron-${env.wsName}-alpha`;
const tmux = (args) => execFileSync("tmux", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TMUX: undefined } }).trim();
const press = (k) => api("POST", "/api/sessions/alpha/send-keys", { keys: k, enter: false });

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="alpha"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="alpha"]`).first().click();
  r.ok(await until(() => { try { tmux(["has-session", "-t", tmuxName]); return true; } catch { return false; } }), "alpha's tmux session exists after the switch");
  tmux(["resize-window", "-t", tmuxName, "-x", "130", "-y", "40"]);
  tmux(["send-keys", "-t", tmuxName, `exec ${FIXTURE} ${LOG}`, "Enter"]);
  r.ok(await until(() => tmux(["display-message", "-t", tmuxName, "-p", "#{pane_current_command}"]) === "claude"), "…and a process named claude shows its dialog");
  r.ok(await until(async () => { const s = await alpha(); return s?.state === "blocked" && s.dialog?.kind === "permission"; }), "the detector reads it blocked with a parsed permission dialog");

  await page.locator("#af-chat-btn").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#af-chat-btn").click();
  const chat = page.locator("#chat-container");
  const card = chat.locator(".chat-dialog");
  await card.waitFor({ state: "visible", timeout: 8000 });

  // ── the card ──
  r.ok((await card.locator(".cd-kind").textContent()) === "Permission" && (await card.locator(".cd-title").textContent()) === "Bash command", `kind + title: "${await card.locator(".cd-kind").textContent()} · ${await card.locator(".cd-title").textContent()}"`);
  r.ok((await card.locator(".cd-code").textContent()) === "rm -f zz.txt", `the command is a code block ("${await card.locator(".cd-code").textContent()}")`);
  r.ok((await card.locator(".cd-q").textContent()) === "Do you want to proceed?", "the question line");
  const opts = card.locator(".cd-opt");
  r.ok((await opts.count()) === 4, `four option buttons (${await opts.count()})`);
  r.ok(/^1Yes$/.test((await opts.nth(0).textContent()).trim()) && (await opts.nth(0).getAttribute("class")).includes("cd-sel"), "option 1 is Yes and marked selected");
  r.ok((await opts.nth(1).locator(".cd-detail").textContent()) === "/home/user/proj from this project", "option 2 carries its scope detail");
  r.ok((await opts.nth(3).textContent()).trim() === "4No", "option 4 is No");
  r.ok((await card.locator(".cd-amend").count()) === 1 && (await card.locator(".cd-cancel").count()) === 1, "Amend… and Cancel (Esc) are offered");
  r.ok(/Needs input · answer below/.test(await chat.locator(".chat-live").textContent()), `the live line hands over to the card ("${(await chat.locator(".chat-live").textContent()).trim()}")`);
  r.ok(await chat.locator(".chat-input").isVisible(), "the composer is still there under the card");
  await page.screenshot({ path: join(screenshotDir(), "m34-permission-cards.png") });

  // ── Yes ──
  await opts.nth(0).click();
  r.ok(await until(() => keys().join(",") === "1", 5000), `Yes → claude got "1" (${keys().join(",")})`);
  r.ok(await until(async () => /Answered/.test(await card.locator(".cd-status").textContent().catch(() => "")) || (await card.isHidden()), 3000), "the card says Answered…");
  r.ok(await until(() => card.isHidden(), 10000), "…and goes away once the pane is idle again");
  r.ok(await until(async () => (await alpha())?.state === "idle"), "the agent is idle");

  // ── back, then Cancel ──
  await press("D");
  await card.waitFor({ state: "visible", timeout: 10000 });
  r.ok((await card.locator(".cd-opt").count()) === 4, "the dialog back in the pane → the card is back");
  await card.locator(".cd-cancel").click();
  r.ok(await until(() => keys().at(-1) === "ESC", 5000), `Cancel → claude got ESC (${keys().at(-1)})`);
  r.ok(await until(() => card.isHidden(), 10000), "card gone again");

  // ── Amend ──
  await press("D");
  await card.waitFor({ state: "visible", timeout: 10000 });
  await card.locator(".cd-amend").click();
  const inp = card.locator(".cd-input");
  r.ok(await inp.isVisible() && await inp.evaluate((el) => document.activeElement === el), "Amend… opens a focused inline field");
  await inp.type("只删这个文件", { delay: 20 });
  await inp.press("Enter");
  r.ok(await until(() => { const k = keys(); const i = k.lastIndexOf("TAB"); return i > 0 && k.at(-1) === "ENTER" && k.length > i + 2; }, 6000), `Enter → Tab, the text, Enter reached claude (${keys().slice(keys().lastIndexOf("TAB")).length} keys)`);
  r.ok(await until(() => card.isHidden(), 10000), "card gone after the amendment");

  // ── a stale card: the dialog answered from elsewhere ──
  await press("D");
  await card.waitFor({ state: "visible", timeout: 10000 });
  const before = keys().length;
  // the operator answers in Primary; the browser's poll is held back so the
  // card still shows the dialog when the server already reads the pane idle
  await page.route("**/api/sessions", async (route) => { await wait(4000); try { await route.continue(); } catch {} });
  tmux(["send-keys", "-t", tmuxName, "4"]);
  await until(() => keys().length === before + 1, 3000);
  r.ok(await until(async () => (await alpha())?.state === "idle"), "the server reads the pane idle");
  r.ok(await card.isVisible(), "…while the card still shows the dialog");
  await card.locator(".cd-opt").nth(0).click({ timeout: 3000 }).catch(() => {});
  r.ok(await until(async () => card.isHidden() || /not showing|changed/.test(await card.locator(".cd-status").textContent().catch(() => "")), 6000), "a click on the stale card is refused and the card follows the server's answer");
  await page.unroute("**/api/sessions");
  await wait(800);
  r.ok(keys().length === before + 1 && keys().at(-1) === "4", `nothing was typed on top of the operator's answer (${keys().slice(before).join(",")})`);
  r.ok(await until(() => card.isHidden(), 10000), "card gone");

  // ── an unnumbered list ──
  await press("T");
  await card.waitFor({ state: "visible", timeout: 10000 });
  r.ok((await card.locator(".cd-kind").textContent()) === "Choose" && (await card.locator(".cd-opt").count()) === 2, `the folder-trust list is a Choose card with 2 rows (${await card.locator(".cd-kind").textContent()})`);
  r.ok(/trust this folder/.test(await card.locator(".cd-opt").nth(1).textContent()), "the rows keep their text");
  const t0 = keys().length;
  await card.locator(".cd-opt").nth(1).click();
  r.ok(await until(() => keys().slice(t0).join(",") === "DOWN,ENTER", 5000), `a row click → Down, Enter (${keys().slice(t0).join(",")})`);
  r.ok(await until(() => card.isHidden(), 10000), "card gone");
  // the operator moves the ❯ in the terminal: the card follows it, and a row
  // click moves from where the marker IS (the pane is re-read under the lock)
  await press("T");
  await card.waitFor({ state: "visible", timeout: 10000 });
  r.ok((await card.locator(".cd-opt").nth(0).getAttribute("class")).includes("cd-sel"), "row 1 is marked selected");
  tmux(["send-keys", "-t", tmuxName, "Down"]);
  r.ok(await until(async () => (await card.locator(".cd-opt").nth(1).getAttribute("class") || "").includes("cd-sel"), 10000), "↓ in the terminal: the card's mark moves to row 2");
  const t1 = keys().length;
  await card.locator(".cd-opt").nth(0).click();
  r.ok(await until(() => keys().slice(t1).join(",") === "UP,ENTER", 5000), `clicking row 1 → Up, Enter (${keys().slice(t1).join(",")})`);
  r.ok(await until(() => card.isHidden(), 10000), "card gone");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ")})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
