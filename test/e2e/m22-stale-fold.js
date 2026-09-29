/**
 * Module M22 — cards + the stale fold (many-agent phase 1, step 3).
 *
 * With 25 agents the deck is mostly history. Three timestamps describe each
 * card's recent past — last transcript activity, waiting-since (attentionAt)
 * and you-last-looked (ackAt); the newest is "last touched". An agent
 * untouched for longer than View → Fold Stale After (default 3 days) folds
 * into a collapsed "Stale" section at the END of the deck. `hadron park` /
 * the card's context menu folds one by hand (persisted `parked`). Nothing in
 * that section is archived or killed. What this proves in a real browser:
 *   - a seeded agent whose timestamps are days old folds, collapsed, last;
 *     an agent with fresh or UNKNOWN timestamps stays visible (fail visible)
 *   - the header toggles the fold; the open state survives the 3-s deck
 *     refresh and a reload; a collapsed fold takes no Alt+N slots
 *   - the active agent never folds
 *   - Park via the context menu → fold + ⏸ marker + `parked:true` on disk,
 *     tmux untouched; needing me pulls a parked card back out lit; acking
 *     folds it again; Unpark restores it
 *   - "Never" removes the age fold (parked cards stay folded)
 *   - the tooltip spells out the three timestamps
 *
 * Run: node test/e2e/m22-stale-fold.js
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M22 Stale fold");
const DAY = 86400e3;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const env = await bootWorkspace({
  name: "m22",
  seed(ws) {
    const dir = join(ws, ".hadron", "agents");
    mkdirSync(dir, { recursive: true });
    const write = (id, extra) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, name: id[0].toUpperCase() + id.slice(1), group: "Workers", state: "idle", ...extra }, null, 2));
    // Raised 6 days ago, looked at 5 days ago → last touched 5 d → stale at 3 d.
    write("old", { attentionRev: 1, ackRev: 1, attentionAt: iso(6 * DAY), ackAt: iso(5 * DAY) });
    // Raised 6 days ago, looked at an hour ago → fresh.
    write("fresh", { attentionRev: 1, ackRev: 1, attentionAt: iso(6 * DAY), ackAt: iso(3600e3) });
    // No timestamps at all → never stale (unknown fails toward visible).
    write("blank", {});
  },
});
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
const agentJson = (id) => JSON.parse(readFileSync(join(env.ws, ".hadron", "agents", `${id}.json`), "utf-8"));
const tmuxAlive = (id) => { try { execFileSync("tmux", ["has-session", "-t", `hadron-${env.wsName}-${id}`], { stdio: "ignore" }); return true; } catch { return false; } };

try {
  for (const name of ["Ant", "Bee"]) {
    const res = await api("POST", "/api/sessions", { name, launchCommand: "shell" });
    r.ok(res.status === 201, `agent "${name}" created`);
  }
  const listed = await (await fetch(`${env.baseUrl}/api/sessions`)).json();
  r.ok(listed.some((s) => s.id === "old") && listed.find((s) => s.id === "old").ackAt, "seeded agent loaded with its ackAt");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`.dk[data-sid="ant"]`).first().click();
  const card = (id) => page.locator(`.dk[data-sid="${id}"]`).first();
  const visible = async (id) => (await page.locator(`.dk[data-sid="${id}"]`).count()) > 0;
  const stale = () => page.locator(".deck-group-stale");
  const staleLabel = async () => ((await stale().count()) ? (await stale().locator(".deck-group-label").textContent()).trim() : null);
  const inStale = async (id) => (await stale().locator(`.dk[data-sid="${id}"]`).count()) > 0;
  const shot = (name) => page.screenshot({ path: join(screenshotDir(), `m22-${name}.png`) });
  const order = () => page.evaluate(() => getDisplayOrder().map((s) => s.id));
  async function ctx(sid, action) {
    await card(sid).click({ button: "right" });
    const item = page.locator(`#ctx-menu .cm-item[data-action="${action}"]`);
    await item.waitFor({ state: "visible", timeout: 3000 });
    const label = (await item.textContent()).trim();
    await item.click();
    return label;
  }

  // ── 1. stale-by-age folds, collapsed, last; fresh/unknown stay ──
  await until(async () => (await stale().count()) === 1);
  r.ok((await stale().count()) === 1, "a Stale section exists");
  r.ok(await page.evaluate(() => { const g = [...document.querySelectorAll("#deck .deck-group, .deck-group")]; return g[g.length - 1]?.classList.contains("deck-group-stale"); }), "…and it is the LAST section of the deck");
  r.ok((await staleLabel()) === "▸ Stale · 1", `collapsed header with count (${await staleLabel()})`);
  r.ok(!(await visible("old")), "old (last touched 5 d ago): folded — card not rendered while collapsed");
  r.ok((await visible("fresh")) && !(await inStale("fresh")), "fresh (looked at 1 h ago): visible in its group");
  r.ok((await visible("blank")) && !(await inStale("blank")), "blank (no timestamps): visible — unknown is not stale");
  r.ok((await visible("ant")) && (await visible("bee")), "new agents visible");
  r.ok(!(await order()).includes("old"), "a collapsed fold takes no Alt+N slot (getDisplayOrder)");
  r.ok((await page.evaluate(() => getDisplayOrder({ filtered: false }).map((s) => s.id))).includes("old"), "…but the palette's full order still reaches it");
  await shot("collapsed");

  // ── 2. toggle; open state survives refresh + reload ──
  await stale().locator(".deck-group-label").click();
  r.ok(await until(() => visible("old")), "click on the header opens the fold — old's card renders");
  r.ok(await inStale("old"), "…inside the Stale section");
  r.ok((await staleLabel()) === "▾ Stale · 1", "header flips to ▾");
  r.ok((await order()).includes("old"), "an open fold's cards are in the Alt+N order");
  const tip = await card("old").getAttribute("title");
  r.ok(/last needed you 6d/.test(tip || "") && /you last looked 5d/.test(tip || ""), `tooltip spells out the timestamps (${JSON.stringify(tip)})`);
  await wait(3500);
  r.ok(await visible("old"), "fold stays open across the 3-s deck refresh");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok(await until(() => visible("old")), "fold stays open across a reload (ui state)");
  r.ok((await page.evaluate(() => deckStaleOpen)) === true, "deckStaleOpen restored");
  await shot("open");

  // ── 3. the active agent never folds ──
  await card("old").click();
  r.ok(await until(async () => (await visible("old")) && !(await inStale("old"))), "switching to old pulls it out of the fold (active never folds)");
  r.ok((await stale().count()) === 0, "…and the now-empty Stale section is gone");
  await card("ant").click();
  r.ok(await until(() => inStale("old")), "switching away folds it again");

  // ── 4. park via context menu ──
  r.ok(/^Park BEE/.test(await ctx("bee", "park")), "context menu offers Park for an unparked card");
  r.ok(await until(() => inStale("bee")), "Park → bee moves into the Stale section");
  r.ok((await staleLabel()) === "▾ Stale · 2 (1 parked)", `header counts parked (${await staleLabel()})`);
  r.ok((await card("bee").locator(".dk-parked").count()) === 1, "⏸ marker on the parked card");
  r.ok(await until(() => { try { return agentJson("bee").parked === true; } catch { return false; } }), "parked:true persisted to disk");
  r.ok(!agentJson("bee").archived && tmuxAlive("bee"), "parking did not archive or kill anything");
  r.ok((await page.locator(`.dk[data-sid="bee"]`).count()) === 1, "card moved, not duplicated");
  await shot("parked");

  // ── 5. needing me beats parked; acking folds it again ──
  await api("PATCH", "/api/sessions/bee", { state: "done" });
  r.ok(await until(async () => (await visible("bee")) && !(await inStale("bee"))), "PATCH state done → the parked card comes back out");
  r.ok(await card("bee").evaluate((el) => el.classList.contains("dk-needs")), "…lit (dk-needs)");
  r.ok((await card("bee").locator(".dk-parked").count()) === 1, "…still marked parked");
  const live = (await (await fetch(`${env.baseUrl}/api/sessions`)).json()).find((s) => s.id === "bee");
  await api("PATCH", "/api/sessions/bee", { ackRev: live.attentionRev });
  r.ok(await until(() => inStale("bee")), "acking it folds it again (parked still set)");
  await api("PATCH", "/api/sessions/bee", { state: "idle" });

  // ── 6. unpark ──
  r.ok(/^Unpark BEE/.test(await ctx("bee", "park")), "context menu offers Unpark for a parked card");
  r.ok(await until(async () => (await visible("bee")) && !(await inStale("bee"))), "Unpark → bee is back in its group");
  r.ok(await until(() => { try { return !("parked" in agentJson("bee")); } catch { return false; } }), "parked absent on disk after unpark");
  r.ok((await staleLabel()) === "▾ Stale · 1", "header back to 1");

  // ── 7. View → Fold Stale After: Never / 1 day ──
  await page.locator("#menu-view").click();
  r.ok(await until(async () => (await page.locator('.menu-dropdown-item[data-action="set-stale-after"]').count()) === 4), "View menu offers Fold Stale After (1d/3d/7d/Never)");
  await page.locator(".menu-dropdown-item.has-submenu", { hasText: "Fold Stale After" }).hover();
  await page.locator('.menu-dropdown-item[data-action="set-stale-after"][data-stale-after="never"]').click();
  r.ok(await until(async () => (await visible("old")) && !(await inStale("old"))), "Never → the age fold is gone (old back in its group)");
  r.ok((await stale().count()) === 0, "…no Stale section left");
  await api("PATCH", "/api/sessions/bee", { parked: true });
  r.ok(await until(() => inStale("bee")), "…but a parked card still folds under Never");
  r.ok((await staleLabel()) === "▾ Stale · 1 (1 parked)", `header shows only the parked one (${await staleLabel()})`);
  await api("PATCH", "/api/sessions/bee", { parked: false });
  r.ok(await until(async () => (await stale().count()) === 0), "unpark → Stale section gone again");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok((await page.evaluate(() => deckStaleAfter)) === "never", "threshold survives a reload");
  await page.evaluate(() => handleMenuAction("set-stale-after", { dataset: { staleAfter: "1d" } }));
  r.ok(await until(() => inStale("old")), "1 day → old folds again");
  r.ok(!(await inStale("fresh")) && (await visible("fresh")), "fresh (1 h) still not stale at 1 day");
  await page.evaluate(() => handleMenuAction("set-stale-after", { dataset: { staleAfter: "bogus" } }));
  r.ok((await page.evaluate(() => deckStaleAfter)) === "3d", "an unknown threshold falls back to 3 days");
  await page.evaluate(() => handleMenuAction("set-stale-after", { dataset: { staleAfter: "toString" } }));
  r.ok((await page.evaluate(() => deckStaleAfter)) === "3d", "a prototype key (toString) is not a threshold either");
  await page.evaluate(() => { localStorage.setItem("hadron-ui-state", JSON.stringify({ ...JSON.parse(localStorage.getItem("hadron-ui-state") || "{}"), deckStaleAfter: "constructor" })); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok((await page.evaluate(() => deckStaleAfter)) === "3d" && (await until(() => inStale("old"))), "a prototype key in localStorage is ignored — the fold still works at the default");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
