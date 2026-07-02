/**
 * Module M14 — Agent groups are case-insensitive.
 *
 * Real bug: getSessionGroups() keyed the group map by the exact string, so
 * agents tagged "Workers", "workers", and "WORKERS" became three separate
 * deck groups — which then rendered identically once CSS uppercases the label,
 * so the user couldn't tell them apart. Fix: key the group map by lowercase and
 * carry a single canonical display label.
 *
 * Technique: browser (Playwright) — the truth is "how many deck-group boxes
 * actually render," which only the painted DOM shows.
 *
 * Run: node test/e2e/m14-group-case.js
 */
import { chromium } from "playwright";
import { bootWorkspace, authHeaders, reporter } from "./harness.js";

const r = reporter("M14 Group case-insensitivity");
const env = await bootWorkspace({ name: "m14" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const mk = (name, group) => fetch(`${env.baseUrl}/api/sessions`, {
  method: "POST", headers: authHeaders(env.token),
  body: JSON.stringify({ name, launchCommand: "shell", group }),
});

try {
  // Same group, three casings — must collapse into one.
  await mk("a1", "Reviewers");
  await mk("a2", "reviewers");
  await mk("a3", "REVIEWERS");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await wait(800);

  // Count only the "reviewers" group (the sample agent sits in its own group).
  const reviewerGroups = await page.evaluate(() =>
    [...document.querySelectorAll("#deck-groups .deck-group-label")]
      .filter((el) => el.textContent.trim().toLowerCase() === "reviewers").length);
  r.ok(reviewerGroups === 1, `three casings of "reviewers" merge into ONE group (got ${reviewerGroups})`);

  const cards = await page.evaluate(() => {
    const lbl = [...document.querySelectorAll("#deck-groups .deck-group")]
      .find((g) => g.querySelector(".deck-group-label")?.textContent.trim().toLowerCase() === "reviewers");
    return lbl ? lbl.querySelectorAll(".dk").length : 0;
  });
  r.ok(cards === 3, `all 3 agents land in the one merged group (got ${cards})`);

  // Renaming the merged label must re-tag every casing, not just the exact one.
  await page.evaluate(async () => {
    const lbl = [...document.querySelectorAll(".deck-group-label[data-group-name]")]
      .find((el) => el.textContent.trim().toLowerCase() === "reviewers");
    lbl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = lbl.querySelector("input.deck-group-edit");
    input.value = "Audit";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await wait(800);
  const stragglers = await page.evaluate(() =>
    sessions.filter((s) => (s.group || "").toLowerCase() === "reviewers").length);
  r.ok(stragglers === 0, `rename re-tags every casing (left ${stragglers} on the old name)`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
