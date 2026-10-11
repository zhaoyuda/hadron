/**
 * Module M22 — cards + the stale fold (many-agent phase 1, step 3).
 *
 * With 25 agents the deck is mostly history. Three timestamps describe each
 * card's recent past — last transcript activity, waiting-since (attentionAt)
 * and you-last-looked (ackAt); the newest is "last touched". An agent
 * untouched for longer than View → Fold Stale After (default 3 days) folds
 * under its own group's "▸ N stale" row (opened in place). `hadron park` /
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
    // Raised 5 days ago and never acked — an agent answered from a channel
    // Hadron cannot see (claude's phone app). An unread raise older than the
    // stale window counts for nothing and folds like any quiet card.
    write("remote", { attentionRev: 2, ackRev: 0, attentionAt: iso(5 * DAY) });
    // A stale agent in a SECOND group: its row must keep its own memory when
    // Workers' row is clicked with Show Stale Agents on.
    write("zed", { group: "Backup", attentionRev: 1, ackRev: 1, attentionAt: iso(9 * DAY), ackAt: iso(8 * DAY) });
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
  // Each group folds its own stale cards under a "▸ N stale" row at its bottom;
  // old/remote are in Workers (the row under test), zed alone in Backup.
  const stale = () => page.locator('.deck-group[data-group="workers"] .deck-stale-row');
  const backupRow = () => page.locator('.deck-group[data-group="backup"] .deck-stale-row');
  const staleLabel = async () => ((await stale().count()) ? (await stale().textContent()).trim() : null);
  const inStale = async (id) => (await page.locator(`.deck-stale-cards .dk[data-sid="${id}"]`).count()) > 0;
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
  r.ok((await stale().count()) === 1, "Workers has a stale row");
  r.ok(await page.evaluate(() => { const row = document.querySelector('.deck-group[data-group="workers"] .deck-stale-row'); return row && row === row.parentElement.lastElementChild; }), "…the last line of its own group, not a section of the deck");
  r.ok((await page.locator(".deck-group-stale").count()) === 0, "…no global Stale section");
  r.ok((await staleLabel()) === "▸ 2 stale", `closed row with the count (${await staleLabel()})`);
  r.ok(!(await visible("old")), "old (last touched 5 d ago): folded — card not rendered while collapsed");
  r.ok(!(await visible("remote")), "remote (unread raise 5 d old, never acked): folded too — an aged-out raise is not exempt");
  r.ok(await page.evaluate(() => { const s = sessions.find((x) => x.id === "remote"); return s.attentionRev === 2 && !s.ackRev && !needsMe(s) && !needsMeList().length; }), "…the client still sees rev 2 > ack 0 but it needs nobody (aged out) — count 0");
  r.ok(await page.locator("#needs-me").isHidden(), "…counter hidden");
  r.ok((await visible("fresh")) && !(await inStale("fresh")), "fresh (looked at 1 h ago): visible in its group");
  r.ok((await visible("blank")) && !(await inStale("blank")), "blank (no timestamps): visible — unknown is not stale");
  r.ok((await visible("ant")) && (await visible("bee")), "new agents visible");
  r.ok(!(await order()).includes("old"), "a collapsed fold takes no Alt+N slot (getDisplayOrder)");
  r.ok((await page.evaluate(() => getDisplayOrder({ filtered: false }).map((s) => s.id))).includes("old"), "…but the palette's full order still reaches it");
  await shot("collapsed");

  // ── 2. toggle; open state survives refresh + reload ──
  await stale().click();
  r.ok(await until(() => visible("old")), "click on the row opens the fold in place — old's card renders");
  r.ok((await inStale("old")) && (await page.locator('.deck-group[data-group="workers"] .deck-stale-cards .dk[data-sid="old"]').count()) === 1, "…under the live cards of its own group");
  r.ok((await staleLabel()) === "▾ 2 stale", "row flips to ▾");
  r.ok((await inStale("remote")) && !(await card("remote").evaluate((el) => el.classList.contains("dk-needs"))), "remote renders inside the fold, not lit");
  r.ok(/last needed you 5d/.test((await card("remote").getAttribute("title")) || ""), `remote's tooltip reads "last needed you 5d" (${JSON.stringify(await card("remote").getAttribute("title"))})`);
  r.ok((await order()).includes("old"), "an open fold's cards are in the Alt+N order");
  const tip = await card("old").getAttribute("title");
  r.ok(/last needed you 6d/.test(tip || "") && /you last looked or answered 5d/.test(tip || ""), `tooltip spells out the timestamps (${JSON.stringify(tip)})`);
  await wait(3500);
  r.ok(await visible("old"), "fold stays open across the 3-s deck refresh");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok(await until(() => visible("old")), "fold stays open across a reload (ui state)");
  r.ok(await page.evaluate(() => deckStaleOpen instanceof Set && deckStaleOpen.has("group:workers") && deckShowStale === false), "deckStaleOpen remembers the group (per-group, not a global flag)");
  r.ok((await backupRow().textContent()).trim() === "▸ 1 stale" && !(await visible("zed")), "Backup's own row is still closed — opening Workers' row touched nothing else");
  await shot("open");

  // ── 3. the active agent never folds ──
  await card("old").click();
  r.ok(await until(async () => (await visible("old")) && !(await inStale("old"))), "switching to old pulls it out of the fold (active never folds)");
  r.ok((await staleLabel()) === "▾ 1 stale" && (await inStale("remote")), `…the row keeps only remote (${await staleLabel()})`);
  await card("ant").click();
  r.ok(await until(() => inStale("old")), "switching away folds it again");

  // ── 4. park via context menu ──
  r.ok(/^Park BEE/.test(await ctx("bee", "park")), "context menu offers Park for an unparked card");
  r.ok(await until(() => inStale("bee")), "Park → bee moves under the stale row");
  r.ok((await staleLabel()) === "▾ 3 stale (1 parked)", `row counts parked (${await staleLabel()})`);
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
  r.ok((await staleLabel()) === "▾ 2 stale", "row back to 2");

  // ── 7. View → Fold Stale After: Never / 1 day ──
  await page.locator("#menu-view").click();
  r.ok(await until(async () => (await page.locator('.menu-dropdown-item[data-action="set-stale-after"]').count()) === 4), "View menu offers Fold Stale After (1d/3d/7d/Never)");
  await page.locator(".menu-dropdown-item.has-submenu", { hasText: "Fold Stale After" }).hover();
  await page.locator('.menu-dropdown-item[data-action="set-stale-after"][data-stale-after="never"]').click();
  r.ok(await until(async () => (await visible("old")) && !(await inStale("old"))), "Never → the age fold is gone (old back in its group)");
  r.ok((await stale().count()) === 0, "…no stale row left");
  r.ok(await until(async () => (await visible("remote")) && !(await inStale("remote")) && (await card("remote").evaluate((el) => el.classList.contains("dk-needs")))), "Never → remote's 5-day-old raise counts again: back in its group, lit");
  r.ok(await until(async () => (await page.locator("#needs-me").textContent()).includes("1 needs me")), "…counter says 1 needs me");
  r.ok(/waiting for you 5d/.test((await card("remote").getAttribute("title")) || ""), "…tooltip reads \"waiting for you 5d\"");
  await api("PATCH", "/api/sessions/bee", { parked: true });
  r.ok(await until(() => inStale("bee")), "…but a parked card still folds under Never");
  r.ok((await staleLabel()) === "▾ 1 stale (1 parked)", `row shows only the parked one (${await staleLabel()})`);
  await api("PATCH", "/api/sessions/bee", { parked: false });
  r.ok(await until(async () => (await stale().count()) === 0), "unpark → stale row gone again");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok((await page.evaluate(() => deckStaleAfter)) === "never", "threshold survives a reload");
  await page.evaluate(() => handleMenuAction("set-stale-after", { dataset: { staleAfter: "1d" } }));
  r.ok(await until(() => inStale("old")), "1 day → old folds again");
  r.ok(await until(async () => (await inStale("remote")) && (await page.locator("#needs-me").isHidden())), "1 day → remote ages out again: folded, counter hidden");
  r.ok(!(await inStale("fresh")) && (await visible("fresh")), "fresh (1 h) still not stale at 1 day");

  // ── 8. View → Show Stale Agents opens every row; a row click closes just one ──
  await stale().click(); // close Workers' row (it was remembered open)
  r.ok(await until(async () => (await staleLabel()) === "▸ 2 stale" && !(await visible("old"))), "row closed again by a click");
  await page.locator("#menu-view").click();
  await page.locator('.menu-dropdown-item[data-action="toggle-show-stale"]').waitFor({ state: "visible", timeout: 3000 });
  r.ok(!/✓/.test(await page.locator('.menu-dropdown-item[data-action="toggle-show-stale"]').textContent()), "View menu offers Show Stale Agents, unchecked");
  await page.locator('.menu-dropdown-item[data-action="toggle-show-stale"]').click();
  r.ok(await until(async () => (await inStale("old")) && (await staleLabel()) === "▾ 2 stale"), "Show Stale Agents → the row is open, old rendered dimmed in Workers");
  r.ok((await inStale("zed")) && (await backupRow().textContent()).trim() === "▾ 1 stale", "…and Backup's row too (every group)");
  r.ok((await order()).includes("old"), "…and in the Alt+N order");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok((await until(() => inStale("old"))) && (await page.evaluate(() => deckShowStale)) === true, "Show Stale Agents survives a reload");
  await stale().click();
  r.ok(await until(async () => !(await visible("old")) && (await page.evaluate(() => deckShowStale)) === false), "a row click with Show Stale Agents on closes that row and turns the global off");
  r.ok((await inStale("zed")) && (await backupRow().textContent()).trim() === "▾ 1 stale" && JSON.stringify(await page.evaluate(() => [...deckStaleOpen])) === JSON.stringify(["group:backup"]),
    `…while every OTHER open row is remembered: Backup stays ▾ and deckStaleOpen is exactly its key (${JSON.stringify(await page.evaluate(() => [...deckStaleOpen]))})`);
  await backupRow().click();
  r.ok(await until(async () => !(await visible("zed")) && (await page.evaluate(() => deckStaleOpen.size)) === 0), "closing Backup's row forgets its key");

  // ── 9. status layout folds per bucket too ──
  await page.evaluate(() => handleMenuAction("set-groupby", { dataset: { groupby: "status" } }));
  const idleRow = page.locator('.deck-group-status .deck-stale-row');
  r.ok(await until(async () => (await idleRow.count()) === 1 && /^▸ 3 stale$/.test((await idleRow.textContent()).trim())), `status layout: the Idle bucket carries its own closed "3 stale" row (old, remote and zed across two groups) (${await idleRow.count() ? (await idleRow.textContent()).trim() : "none"})`);
  r.ok(!(await visible("old")), "…old not rendered while closed");
  await idleRow.click();
  r.ok(await until(() => inStale("old")), "…opens in place under Idle");
  await page.evaluate(() => handleMenuAction("set-groupby", { dataset: { groupby: "group" } }));
  r.ok(await until(async () => (await stale().count()) === 1 && (await staleLabel()) === "▸ 2 stale"), "back to groups: Workers' row is still closed (per-group memory keyed by layout)");
  await page.evaluate(() => handleMenuAction("set-stale-after", { dataset: { staleAfter: "bogus" } }));
  r.ok((await page.evaluate(() => deckStaleAfter)) === "3d", "an unknown threshold falls back to 3 days");
  await page.evaluate(() => handleMenuAction("set-stale-after", { dataset: { staleAfter: "toString" } }));
  r.ok((await page.evaluate(() => deckStaleAfter)) === "3d", "a prototype key (toString) is not a threshold either");
  await page.evaluate(() => { localStorage.setItem("hadron-ui-state", JSON.stringify({ ...JSON.parse(localStorage.getItem("hadron-ui-state") || "{}"), deckStaleAfter: "constructor" })); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok((await page.evaluate(() => deckStaleAfter)) === "3d" && (await until(async () => (await staleLabel()) === "▸ 2 stale")), "a prototype key in localStorage is ignored — the fold still works at the default");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
