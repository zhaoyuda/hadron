/**
 * M28 — System notifications (OS-level, on top of the in-page banner).
 *
 * Proves the contract:
 *   - View → Notifications → "System Notifications" asks for permission once, turns the
 *     item on (✓), persists across a reload (ui state), and fires a confirmation
 *   - an agent going done/blocked while the tab is HIDDEN (or the window unfocused)
 *     raises a Notification titled "<Name> is done|blocked" tagged per agent; clicking
 *     it switches to that agent
 *   - while the tab is visible + focused nothing is raised (banner + title flash cover it)
 *   - Notifications "Off" silences it too; toggling System off stops it while the level stays
 *   - without the Notification API, or with permission denied, the item stays off and an
 *     in-page message says why — never a silent no-op; a grant revoked LATER turns the
 *     item off with a message (never a ✓ that does nothing)
 *   - a burst (many agents flipping in one poll) raises 3 and collapses the rest into one
 *     "N agents need you"; Safari's callback-style requestPermission still enables it
 *
 * The Notification constructor is stubbed via addInitScript (headless Chromium raises
 * no OS notification): every instance is recorded on window.__notifs.
 *
 * Run: node test/e2e/m28-system-notifications.js
 */
import { chromium } from "playwright";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M28 System notifications");
const env = await bootWorkspace({ name: "m28" });
let browser;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, {
  method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}),
});
const STUB = (permission) => `
  window.__notifs = [];
  class FakeNotification {
    constructor(title, opts) { this.title = title; this.opts = opts || {}; this.closed = false; window.__notifs.push(this); }
    close() { this.closed = true; }
    static get permission() { return window.__perm; }
    static requestPermission() { window.__permAsked = (window.__permAsked || 0) + 1; window.__perm = window.__permResult; return Promise.resolve(window.__perm); }
  }
  window.__perm = ${JSON.stringify(permission)};
  window.__permResult = ${JSON.stringify(permission === "default" ? "granted" : permission)};
  window.Notification = FakeNotification;
`;
const openSysItem = async (page) => {
  await page.locator("#menu-view").click();
  await page.locator(".menu-dropdown-item.has-submenu", { hasText: "Notifications" }).hover();
  return page.locator('.menu-dropdown-item[data-action="toggle-sysnotify"]');
};
const sysChecked = async (page) => {
  const item = await openSysItem(page);
  const checked = ((await item.locator(".menu-check").innerText()) || "").trim() === "✓";
  await page.keyboard.press("Escape");
  await page.mouse.click(640, 400);
  return checked;
};
const setVisible = (page, visible) => page.evaluate((v) => {
  Object.defineProperty(document, "hidden", { get: () => !v, configurable: true });
  document.hasFocus = () => v;
}, visible);
const notifs = (page) => page.evaluate(() => window.__notifs.map((n) => ({ title: n.title, tag: n.opts.tag, body: n.opts.body, silent: n.opts.silent, closed: n.closed })));

try {
  for (const name of ["Ant", "Bee"]) r.ok((await api("POST", "/api/sessions", { name, launchCommand: "shell" })).status === 201, `agent "${name}" created`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(STUB("default"));
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".dk").first().waitFor({ timeout: 10000 });
  await page.locator('.dk[data-sid="ant"]').first().click();
  await until(() => page.evaluate(() => activeSessionId === "ant"));

  // ── 1. turn it on: permission asked once, item checked, confirmation raised, persisted ──
  r.ok((await sysChecked(page)) === false, "System Notifications starts off");
  const item = await openSysItem(page);
  await item.click();
  await until(async () => (await notifs(page)).length === 1);
  const asked = await page.evaluate(() => window.__permAsked);
  const n0 = await notifs(page);
  r.ok(asked === 1 && n0.length === 1 && n0[0].title === "Hadron" && n0[0].tag === "hadron-enabled", `enabling asks for permission once and raises a confirmation (asked ${asked}, ${JSON.stringify(n0)})`);
  r.ok((await sysChecked(page)) === true, "the item is checked");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("hadron-ui-state") || "{}").sysNotify);
  r.ok(stored === true, "sysNotify persisted in the ui state");

  // ── 2. hidden tab: a non-active agent going done raises "<Name> is done" ──
  await setVisible(page, false);
  await api("PATCH", "/api/sessions/bee", { state: "done" });
  r.ok(await until(async () => (await notifs(page)).some((n) => n.title === "Bee is done")), "hidden tab: Bee → done raises a system notification");
  const nb = (await notifs(page)).find((n) => n.title === "Bee is done");
  r.ok(nb && nb.tag === "hadron-bee" && nb.body === "Task complete · m28" && nb.silent === false, `tagged per agent, body "Task complete · <workspace>" (several Hadrons share one icon), not silent at Sound + Banner (${JSON.stringify(nb)})`);
  r.ok((await page.locator(".center-notif.cn-done").count()) >= 1, "the in-page banner is raised as well");

  // click → switches to the agent
  await page.evaluate(() => { const n = window.__notifs.find((x) => x.title === "Bee is done"); n.onclick(); });
  r.ok(await until(() => page.evaluate(() => activeSessionId === "bee")), "clicking the notification switches to Bee");
  r.ok((await notifs(page)).find((n) => n.title === "Bee is done").closed === true, "and closes it");

  // the ACTIVE agent going blocked while hidden is raised too (you are not looking)
  await api("PATCH", "/api/sessions/bee", { state: "blocked", blockReason: "permission" });
  r.ok(await until(async () => (await notifs(page)).some((n) => n.title === "Bee is blocked")), "hidden tab: the active agent's blocked is raised too");
  const nbb = (await notifs(page)).find((n) => n.title === "Bee is blocked");
  r.ok(nbb && nbb.body === "permission · m28", `blocked carries the block reason + workspace (${nbb && nbb.body})`);

  // ── 3. visible + focused: nothing raised ──
  await setVisible(page, true);
  await api("PATCH", "/api/sessions/bee", { state: "idle" });
  await wait(1500);
  const before = (await notifs(page)).length;
  await api("PATCH", "/api/sessions/ant", { state: "done" });
  r.ok(await until(() => page.locator(".center-notif.cn-done").count().then((c) => c >= 1)), "visible: Ant → done shows the banner");
  await wait(1500);
  r.ok((await notifs(page)).length === before, "visible + focused: no system notification");

  // ── 4. Notifications "Off" silences the system one too; System off stops it while the level stays ──
  await page.locator("#menu-view").click();
  await page.locator(".menu-dropdown-item.has-submenu", { hasText: "Notifications" }).hover();
  await page.locator('.menu-dropdown-item[data-action="set-notify"][data-level="off"]').click();
  await setVisible(page, false);
  await api("PATCH", "/api/sessions/ant", { state: "blocked", blockReason: "x" });
  await wait(2500);
  r.ok((await notifs(page)).length === before, "Notifications Off: nothing raised");
  await page.locator("#menu-view").click();
  await page.locator(".menu-dropdown-item.has-submenu", { hasText: "Notifications" }).hover();
  await page.locator('.menu-dropdown-item[data-action="set-notify"][data-level="banner"]').click();
  await api("PATCH", "/api/sessions/ant", { state: "idle" });
  await wait(1500);
  await api("PATCH", "/api/sessions/ant", { state: "done" });
  r.ok(await until(async () => (await notifs(page)).length === before + 1), "Banner Only: raised again");
  r.ok((await notifs(page)).at(-1).silent === true, "…silent at Banner Only (no sound from the OS either)");
  const item2 = await openSysItem(page);
  await item2.click();
  r.ok((await sysChecked(page)) === false, "System Notifications toggled off");
  await api("PATCH", "/api/sessions/ant", { state: "idle" });
  await wait(1500);
  await api("PATCH", "/api/sessions/ant", { state: "done" });
  await wait(2500);
  r.ok((await notifs(page)).length === before + 1, "System off: nothing raised while the level stays Banner Only");

  // ── 5. persists across a reload ──
  const item3 = await openSysItem(page);
  await item3.click();
  r.ok((await sysChecked(page)) === true, "on again");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".dk").first().waitFor({ timeout: 10000 });
  r.ok((await sysChecked(page)) === true, "still on after a reload");
  await page.evaluate(() => { window.__perm = "granted"; }); // the stub forgets the grant on reload; a real browser keeps it
  await page.screenshot({ path: join(screenshotDir(), "m28-system-notifications.png") });
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);

  // ── 6. a burst (many agents flipping in ONE poll) is coalesced: 3 raised, the rest collapse ──
  await setVisible(page, false);
  for (const name of ["C1", "C2", "C3", "C4", "C5"]) await api("POST", "/api/sessions", { name, launchCommand: "shell" });
  await until(() => page.evaluate(() => sessions.length >= 7));
  await page.evaluate(() => { window.__notifs = []; });
  await Promise.all(["c1", "c2", "c3", "c4", "c5"].map((id) => api("PATCH", `/api/sessions/${id}`, { state: "done" })));
  r.ok(await until(async () => (await notifs(page)).some((n) => n.tag === "hadron-burst")), "5 agents done at once → a collapsed \"N agents need you\" notification");
  await until(async () => (await notifs(page)).some((n) => n.title === "5 agents need you" && !n.closed));
  const burst = await notifs(page);
  const single = burst.filter((n) => /^C\d is done$/.test(n.title));
  const coll = burst.filter((n) => n.tag === "hadron-burst" && !n.closed);
  r.ok(single.length === 3 && coll.length === 1 && coll[0].title === "5 agents need you", `3 raised individually + one "5 agents need you" (${single.length} single, ${JSON.stringify(coll.map((n) => n.title))})`);

  // ── 7. permission revoked later: the ✓ comes off and an in-page message says why ──
  await page.evaluate(() => { window.__perm = "denied"; });
  await api("PATCH", "/api/sessions/c1", { state: "idle" });
  await wait(1500);
  await api("PATCH", "/api/sessions/c1", { state: "blocked", blockReason: "x" });
  r.ok(await until(() => page.locator(".center-notif", { hasText: "turned off" }).count().then((c) => c >= 1)), "revoked permission → \"System notifications were turned off\" message");
  r.ok((await sysChecked(page)) === false, "…and the item is unchecked");
  r.ok((await page.evaluate(() => JSON.parse(localStorage.getItem("hadron-ui-state") || "{}").sysNotify)) === false, "…persisted off (a stale true is not kept)");
  r.ok(!(await notifs(page)).some((n) => n.title === "C1 is blocked"), "nothing raised without the grant");

  // ── 8. agent names are escaped in the Agents menu (labels are text, never markup) ──
  await api("POST", "/api/sessions", { name: "<b id=\"pwned\">Evil</b>", launchCommand: "shell" });
  await until(() => page.evaluate(() => sessions.some((x) => x.name.startsWith("<b"))));
  await page.locator("#menu-agents").click();
  await page.locator("#active-menu").waitFor({ timeout: 5000 });
  const menuHtml = await page.evaluate(() => document.getElementById("active-menu").innerHTML);
  r.ok((await page.locator("#pwned").count()) === 0 && menuHtml.includes("&lt;b id="), `an agent named <b …> renders as text in the Agents menu (${menuHtml.includes("&lt;b id=") ? "escaped" : menuHtml.slice(0, 300)})`);
  await page.keyboard.press("Escape");

  // ── 9. honest refusals: no API / permission denied ──
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addInitScript("delete window.Notification;");
  const p2 = await ctx2.newPage();
  await p2.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p2.locator(".dk").first().waitFor({ timeout: 10000 });
  await (await openSysItem(p2)).click();
  r.ok(await until(() => p2.locator(".center-notif", { hasText: "no Notification API" }).count().then((c) => c === 1)), "no Notification API → in-page message, item stays off");
  r.ok((await sysChecked(p2)) === false, "…and the item is not checked");
  await ctx2.close();

  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx3.addInitScript(STUB("denied"));
  const p3 = await ctx3.newPage();
  await p3.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p3.locator(".dk").first().waitFor({ timeout: 10000 });
  await (await openSysItem(p3)).click();
  r.ok(await until(() => p3.locator(".center-notif", { hasText: "permission denied" }).count().then((c) => c === 1)), "permission denied → in-page message naming it");
  r.ok((await sysChecked(p3)) === false && (await p3.evaluate(() => window.__notifs.length)) === 0, "…item off, nothing raised");
  await ctx3.close();

  // ── 10. Safari-style callback requestPermission (resolves undefined) still turns it on ──
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx4.addInitScript(STUB("default") + `
    window.Notification.requestPermission = (cb) => { window.__perm = "granted"; if (cb) cb("granted"); return undefined; };`);
  const p4 = await ctx4.newPage();
  await p4.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p4.locator(".dk").first().waitFor({ timeout: 10000 });
  await (await openSysItem(p4)).click();
  r.ok(await until(() => p4.evaluate(() => window.__notifs.length === 1)), "callback-style requestPermission: enabling still raises the confirmation");
  r.ok((await sysChecked(p4)) === true, "…and the item is checked (permission re-read from the property)");
  await ctx4.close();
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
