/**
 * Module M31 — an unreadable agent record is recovered, never dropped.
 *
 * Prod 2026-10-01 (Mac): an agent's .hadron/agents/<id>.json was 0 bytes at
 * boot; loadAgents() swallowed the parse error and the agent vanished from
 * the dashboard while its tmux session (claude at a permission prompt) kept
 * running for 15 hours. Now the file is moved aside (<id>.json.corrupt-<stamp>),
 * a placeholder record is written, and the card is drawn with a ⚠ badge that
 * says what was lost and where the original is. What this proves in a real
 * browser (the harness `seed(ws)` hook writes the broken record before boot):
 *   - the card for the 0-byte record is painted, name = id, with the badge
 *   - the badge's tooltip names the quarantined file
 *   - a healthy sibling has no badge
 *   - on disk: a valid placeholder with recoveredFrom, the original kept aside
 *
 * Run: node test/e2e/m31-corrupt-record.js
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir } from "./harness.js";

const r = reporter("M31 Corrupt record");
const env = await bootWorkspace({
  name: "m31",
  seed(ws) {
    const dir = join(ws, ".hadron", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "");
    writeFileSync(join(dir, "fine.json"), JSON.stringify({ id: "fine", name: "Fine", group: "Workers", task: "still here" }, null, 2));
  },
});
let browser;

try {
  const agentsDir = join(env.ws, ".hadron", "agents");
  const listed = await (await fetch(`${env.baseUrl}/api/sessions`)).json();
  const broken = listed.find((s) => s.id === "broken");
  r.ok(!!broken && broken.name === "broken" && broken.recoveredFrom && broken.recoveredFrom.bytes === 0, `the 0-byte record boots as a placeholder (${listed.map((s) => s.id).join(",")})`);
  r.ok(listed.find((s) => s.id === "fine")?.task === "still here", "the healthy sibling loads unchanged");
  const aside = readdirSync(agentsDir).filter((n) => n.startsWith("broken.json.corrupt-"));
  r.ok(aside.length === 1 && statSync(join(agentsDir, aside[0])).size === 0 && broken?.recoveredFrom?.file === aside[0], `the original is kept aside as ${aside[0] || "?"}`);
  const onDisk = JSON.parse(readFileSync(join(agentsDir, "broken.json"), "utf-8"));
  r.ok(onDisk.id === "broken" && onDisk.recoveredFrom?.file === aside[0], "broken.json is a valid placeholder carrying recoveredFrom");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  const card = page.locator(`.dk[data-sid="broken"]`);
  await card.waitFor({ state: "visible", timeout: 10000 });
  r.ok((await card.locator(".dk-name").innerText()).toLowerCase().includes("broken"), "the card is painted with the id as its name");
  const badge = card.locator(".dk-recovered");
  r.ok((await badge.count()) === 1, "…with the ⚠ recovered badge");
  const title = (await badge.getAttribute("title")) || "";
  r.ok(/unreadable at boot/.test(title) && title.includes(aside[0]), `the badge's tooltip explains and names the file (${title})`);
  r.ok((await page.locator(`.dk[data-sid="fine"] .dk-recovered`).count()) === 0, "the healthy sibling has no badge");
  await page.screenshot({ path: join(screenshotDir(), "m31-recovered-card.png") });

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
