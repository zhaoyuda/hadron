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
  const t0 = await text();
  r.ok(/^Claude 5h 28% · 7d 4% Codex 5h 61% · 7d 9%$/.test(t0), `widget shows both vendors (${t0})`);
  const cls = async (vendor, win) => widget.locator(`.q-vendor[data-vendor="${vendor}"] .q-win[data-win="${win}"]`).getAttribute("class");
  r.ok(!/q-warn|q-hot/.test(await cls("claude", "5h")) && /q-warn/.test(await cls("codex", "5h")) && !/q-warn|q-hot/.test(await cls("codex", "7d")), "colour by threshold: 28% plain, 61% amber, 9% plain");
  const title = await widget.getAttribute("title");
  r.ok(/Claude \(claude's statusline, just now\)/.test(title) && /5h window: 28% used, resets in \d+h \d+m/.test(title) && /Codex \(codex rollout, just now, plus\)/.test(title) && /7d window: 9% used, resets in \d+d \d+h/.test(title), `tooltip spells out source, receipt age, resets (${title.replace(/\n/g, " | ")})`);
  await page.screenshot({ path: join(screenshotDir(), "m24-quota.png") });

  // The files move → the widget follows (poll forced; the real cadence is 30 s).
  receipt(85, 40);
  rollout(61, 9);
  await wait(11000); // past the server's 10 s cache
  await page.evaluate(() => pollQuota());
  r.ok(/^Claude 5h 85% · 7d 40%/.test(await text()) && /q-hot/.test(await cls("claude", "5h")), `a new receipt: 85% red (${await text()})`);

  rmSync(join(CFG, "hadron-quota.json"));
  await wait(11000);
  await page.evaluate(() => pollQuota());
  r.ok(/^Codex 5h 61% · 7d 9%$/.test(await text()), `receipt gone → only Codex (${await text()})`);

  rollout(null, null);
  await wait(11000);
  await page.evaluate(() => pollQuota());
  r.ok(await widget.isHidden(), "nothing known for either vendor → widget hidden");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(r.finish() ? 0 : 1);
