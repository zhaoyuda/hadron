/**
 * Module M24 — the quota widget in the top bar.
 *
 * "Claude 5h 28% · 7d 4%   Codex 5h 61% · 7d 9%" next to the needs-me counter:
 * how much of each subscription window is used, from claude's statusline
 * receipt (<CLAUDE_CONFIG_DIR>/hadron-quota.json, written by `hadron
 * quota-sink`) and codex's newest rollout (server/quota.js). What this proves
 * in a real browser:
 *   - both vendors render with their windows; colour by threshold (plain < 50,
 *     amber < 80, red from 80); the tooltip spells out resets + receipt age
 *   - the widget follows the files: a new receipt moves the number on the next
 *     poll, a vendor with nothing known disappears, both gone → widget hidden
 *   - a window's number is drawn only once View → Show Quota (default 30%) of it is used; a
 *     known-but-quiet vendor keeps a dimmed logo + the tooltip (never the same as "nothing
 *     known"); "Always" shows all, the choice persists; each vendor is its logo (SVG, aria-labelled)
 *   - an anonymous GET /api/quota is refused (the page's token is what shows it)
 *
 * Run: node test/e2e/m24-quota.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bootWorkspace, reporter, screenshotDir } from "./harness.js";

const r = reporter("M24 Quota widget");
const TMP = mkdtempSync(join(tmpdir(), "hadron-m24-"));
const CFG = join(TMP, "claude"), CODEX = join(TMP, "codex");
mkdirSync(CFG, { recursive: true });
const DAY = join(CODEX, "sessions", "2026", "09", "29");
mkdirSync(DAY, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = CFG; // the harness spreads process.env into the server
process.env.CODEX_HOME = CODEX;
const nowS = Math.floor(Date.now() / 1000);
const receipt = (five, seven) => writeFileSync(join(CFG, "hadron-quota.json"), JSON.stringify({ at: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: five, resets_at: nowS + 7200 }, seven_day: { used_percentage: seven, resets_at: nowS + 86400 * 3 } } }));
const rollout = (primary, secondary) => writeFileSync(join(DAY, "rollout-2026-09-29T10-00-00-abcd.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: primary && { used_percent: primary, window_minutes: 300, resets_at: nowS + 3000 }, secondary: secondary && { used_percent: secondary, window_minutes: 10080, resets_at: nowS + 500000 }, plan_type: "plus" } } }) + "\n");
receipt(28, 4);
rollout(61, 9);

const env = await bootWorkspace({ name: "m24" });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
let browser;
try {
  const res = await fetch(`${env.baseUrl}/api/quota`);
  r.ok(res.status === 401, "anonymous GET /api/quota → 401");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  const widget = page.locator("#quota");
  await widget.waitFor({ state: "visible", timeout: 10000 });
  const text = async () => (await widget.innerText()).replace(/\s+/g, " ").trim();
  const vendorText = async (vendor) => ((await widget.locator(`.q-vendor[data-vendor="${vendor}"]`).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const cls = async (vendor, win) => widget.locator(`.q-vendor[data-vendor="${vendor}"] .q-win[data-win="${win}"]`).getAttribute("class");

  // Default: a window is drawn once 30% of it is used — 28/4/9 stay out of the
  // bar, Codex 5h 61% is the only thing shown. The tooltip keeps every window.
  const t0 = await text();
  r.ok(t0 === "5h 61%" && (await widget.locator(".q-vendor").count()) === 2 && (await vendorText("codex")) === "5h 61%" && (await vendorText("claude")) === "", `default threshold 30%: only Codex 5h 61% in the bar (${t0})`);
  r.ok((await widget.locator('.q-vendor.q-quiet[data-vendor="claude"]').count()) === 1 && (await widget.locator('.q-vendor.q-quiet[data-vendor="codex"]').count()) === 0, "Claude (all windows under 30%) keeps a dimmed logo, Codex is not dimmed");
  const title0 = await widget.getAttribute("title");
  r.ok(/Claude \(claude's statusline, just now\)/.test(title0) && /5h window: 28% used/.test(title0) && /7d window: 4% used/.test(title0) && /7d window: 9% used/.test(title0), `tooltip still lists the hidden windows (${title0.replace(/\n/g, " | ")})`);
  const logo = async (vendor) => widget.locator(`.q-vendor[data-vendor="${vendor}"] .q-name[role="img"]`).getAttribute("aria-label");
  r.ok((await logo("codex")) === "Codex" && (await widget.locator('.q-vendor[data-vendor="codex"] svg.q-logo-codex path').count()) === 1, "the vendor is a logo (inline SVG) labelled for screen readers, not a word");

  // View → Show Quota → Always: every window, colour by threshold; the choice
  // survives a reload (UI state).
  await page.locator("#menu-view").click();
  await page.locator(".menu-dropdown-item.has-submenu", { hasText: "Show Quota" }).hover();
  r.ok((await page.locator('.menu-dropdown-item[data-action="set-quota-from"]').count()) === 3, "View → Show Quota offers Always / 30% / 50%");
  await page.locator('.menu-dropdown-item[data-action="set-quota-from"][data-quota-from="0"]').click();
  const t1 = await text();
  r.ok(t1 === "5h 28% · 7d 4% 5h 61% · 7d 9%" && (await logo("claude")) === "Claude", `Always: both vendors, all windows (${t1})`);
  r.ok(!/q-warn|q-hot/.test(await cls("claude", "5h")) && /q-warn/.test(await cls("codex", "5h")) && !/q-warn|q-hot/.test(await cls("codex", "7d")), "colour by threshold: 28% plain, 61% amber, 9% plain");
  const title = await widget.getAttribute("title");
  r.ok(/Claude \(claude's statusline, just now\)/.test(title) && /5h window: 28% used, resets in \d+h \d+m/.test(title) && /Codex \(codex rollout, just now, plus\)/.test(title) && /7d window: 9% used, resets in \d+d \d+h/.test(title), `tooltip spells out source, receipt age, resets (${title.replace(/\n/g, " | ")})`);
  await page.screenshot({ path: join(screenshotDir(), "m24-quota.png") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await widget.waitFor({ state: "visible", timeout: 10000 });
  r.ok((await text()) === "5h 28% · 7d 4% 5h 61% · 7d 9%", `"Always" survives a reload (${await text()})`);
  // A bogus value falls back to the 30% default.
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "17" } }));
  r.ok((await text()) === "5h 61%", `an unknown threshold falls back to 30% (${await text()})`);
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "50" } }));
  r.ok((await text()) === "5h 61%", `50%: 61 stays, nothing else (${await text()})`);
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "0" } }));

  // The files move → the widget follows (poll forced; the real cadence is 30 s).
  receipt(85, 40);
  rollout(61, 9);
  await wait(11000); // past the server's 10 s cache
  await page.evaluate(() => pollQuota());
  r.ok(/^5h 85% · 7d 40%/.test(await text()) && /q-hot/.test(await cls("claude", "5h")), `a new receipt: 85% red (${await text()})`);
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "30" } }));
  r.ok((await text()) === "5h 85% · 7d 40% 5h 61%", `back at 30%: 85/40/61 shown, 9 hidden (${await text()})`);
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "0" } }));

  rmSync(join(CFG, "hadron-quota.json"));
  await wait(11000);
  await page.evaluate(() => pollQuota());
  r.ok((await text()) === "5h 61% · 7d 9%" && (await widget.locator(".q-vendor").count()) === 1 && (await logo("codex")) === "Codex", `receipt gone → only Codex (${await text()})`);
  // Known but quiet: everything under the threshold → logos only, tooltip intact,
  // never the same as "nothing known".
  rollout(28, 9);
  await wait(11000);
  await page.evaluate(() => pollQuota());
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "30" } }));
  r.ok(await widget.isVisible() && (await text()) === "" && (await widget.locator(".q-vendor.q-quiet").count()) === 1 && /5h window: 28% used/.test(await widget.getAttribute("title")), `all windows under 30%: dimmed logo, no numbers, tooltip keeps 28% (${await text()})`);
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "0" } }));

  rollout(null, null);
  await wait(11000);
  await page.evaluate(() => pollQuota());
  r.ok(await widget.isHidden(), "nothing known for either vendor → widget hidden");

  // A generic source (hadron-quota.d/<name>.json — README "Quota sources") is a
  // third vendor under its own label behind a neutral gauge, same rules.
  const srcDir = join(CFG, "hadron-quota.d");
  mkdirSync(srcDir, { recursive: true });
  const source = (file, rec) => writeFileSync(join(srcDir, file), typeof rec === "string" ? rec : JSON.stringify(rec));
  source("litellm.json", { at: new Date().toISOString(), label: "LiteLLM", windows: [{ label: "1mo", usedPct: 45, resetsAt: nowS + 86400 * 12 }, { label: "day", usedPct: 12, resetsAt: null }] });
  source("broken.json", "{ nope");
  source("spicy.json", { at: new Date().toISOString(), label: "<b>Spicy</b>", windows: [{ label: "1mo", usedPct: 90 }] });
  // Optional `detail` + `level`: the writer's verdict colours the window and
  // puts it in the bar under the threshold; its text is one hover away.
  source("budget.json", { at: new Date().toISOString(), label: "Budget", budget: { monthlyUsd: 50 }, windows: [{ label: "day", usedPct: 12, level: "bad", detail: "daily cap hit", resetsAt: nowS + 3600 }, { label: "1mo", usedPct: 60, level: "ok", detail: "$6.10 of $50" }, { label: "wk", usedPct: 85, level: "warn" }, { label: "yr", usedPct: 95, level: "ok" }, { label: "qtr", usedPct: 2, level: "red", detail: "x".repeat(81) }] });
  await wait(11000);
  await page.evaluate(() => pollQuota());
  await page.evaluate(() => handleMenuAction("set-quota-from", { dataset: { quotaFrom: "30" } }));
  await widget.waitFor({ state: "visible", timeout: 5000 });
  r.ok((await widget.locator(".q-vendor").count()) === 3 && (await vendorText("src:litellm")) === "LiteLLM 1mo 45%" && (await logo("src:litellm")) === "LiteLLM" && (await widget.locator('.q-vendor[data-vendor="src:litellm"] .q-label').innerText()) === "LiteLLM", `a source file is a vendor under its label, drawn as text (every source shares the gauge mark); 45 shown, 12 hidden at 30% (${await text()})`);
  r.ok((await widget.locator('.q-vendor[data-vendor="src:litellm"] svg.q-logo-source').count()) === 1, "behind the neutral gauge mark, not a vendor logo");
  const ts = await widget.getAttribute("title");
  r.ok(/LiteLLM \(hadron-quota\.d\/litellm\.json, just now\)/.test(ts) && /1mo window: 45% used, resets in \d+d/.test(ts) && /day window: 12% used/.test(ts) && !/day window: 12% used,/.test(ts), `tooltip: file name as the source, age, every window, countdown only with resetsAt (${ts.replace(/\n/g, " | ")})`);
  r.ok((await vendorText("src:spicy")) === "<b>Spicy</b> 1mo 90%" && (await logo("src:spicy")) === "<b>Spicy</b>" && (await widget.locator('.q-vendor[data-vendor="src:spicy"] b').count()) === 0 && /q-hot/.test(await cls("src:spicy", "1mo")), "a label with markup is drawn as text (escaped), red from 80%");
  r.ok((await widget.locator('.q-vendor[data-vendor="src:broken"]').count()) === 0, "the invalid file is not a vendor (doctor names it)");
  r.ok((await vendorText("src:budget")) === "Budget day 12% · 1mo 60% · wk 85% · yr 95%", `level: a "bad" window at 12% is drawn under the 30% threshold, an ignored level (qtr, "red") still hides at 2% — the file was not skipped (${await vendorText("src:budget")})`);
  r.ok(/q-hot/.test(await cls("src:budget", "day")) && !/q-warn|q-hot/.test(await cls("src:budget", "1mo")) && /q-warn/.test(await cls("src:budget", "wk")) && !/q-hot/.test(await cls("src:budget", "wk")) && !/q-warn|q-hot/.test(await cls("src:budget", "yr")), `level replaces the 50/80 thresholds: bad → red at 12%, ok → plain at 60% AND at 95% (the writer's verdict, never a floor; the number still draws), warn → amber at 85% (${await cls("src:budget", "day")} / ${await cls("src:budget", "1mo")} / ${await cls("src:budget", "wk")})`);
  const tb = await widget.getAttribute("title");
  r.ok(/day window: 12% used \(bad\), resets in \d+h?\s?\d*m — daily cap hit/.test(tb) && /1mo window: 60% used — \$6\.10 of \$50/.test(tb) && /wk window: 85% used \(warn\)$/m.test(tb) && /qtr window: 2% used$/m.test(tb) && !/xxxx/.test(tb), `tooltip: level in words after the number, detail after the countdown, nothing for an ignored field (${tb.split("\n").filter((l) => /Budget|day|1mo window: 60|wk|qtr/.test(l)).join(" | ")})`);
  rmSync(join(srcDir, "litellm.json")); rmSync(join(srcDir, "spicy.json")); rmSync(join(srcDir, "broken.json")); rmSync(join(srcDir, "budget.json"));
  await wait(11000);
  await page.evaluate(() => pollQuota());
  r.ok(await widget.isHidden(), "files removed → the sources drop out, widget hidden again");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(r.finish() ? 0 : 1);
