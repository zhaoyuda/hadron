/**
 * Ad-hoc screenshot script for the CSV preview/edit toggle (not part of npm test).
 * Boots a throwaway workspace, spawns an agent with a CSV artifact, opens it,
 * captures the table (preview), flips to Edit, edits + saves, flips back to
 * Preview to confirm the table reflects the saved change.
 *
 * Run: node test/e2e/shot-csv-edit.js
 */
import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { bootWorkspace, screenshotDir } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = await bootWorkspace({ name: "csv" });
const port = env.baseUrl.split(":").pop();

function hadron(args) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token },
  });
}

let browser;
try {
  const csvPath = join(env.ws, "metrics.csv");
  writeFileSync(csvPath, "agent,state,count\nalpha,idle,3\nbeta,working,7\ngamma,blocked,1\n");

  hadron(["spawn", "csv demo", "--group", "Demo", "--launch", "shell", "--artifact", "metrics.csv"]);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  await page.locator('.dk[data-sid="csv-demo"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('.dk[data-sid="csv-demo"]').click();

  await page.locator('.af[data-art-idx]').first().waitFor({ state: "visible", timeout: 10000 });
  await page.locator('.af[data-art-idx]').first().click();

  // Preview (table) shot.
  await page.locator('.csv-table').waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  const dir = screenshotDir();
  await page.locator('#artifact-container, #work-area').first().screenshot({ path: join(dir, "csv-preview.png") });
  console.log(`  📸 ${join(dir, "csv-preview.png")}`);

  // Flip to Edit.
  await page.locator('.csv-toggle-btn[data-mode="edit"]').click();
  await page.locator('.csv-edit-area').waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(200);

  // Delete the last data row (gamma) and add a new one, then save.
  await page.locator('.csv-edit-area').fill("agent,state,count\nalpha,idle,3\nbeta,working,7\ndelta,done,9\n");
  await page.locator('.csv-edit-area').screenshot({ path: join(dir, "csv-edit.png") }).catch(() => {});
  await page.locator('.csv-edit-save').click();
  await page.locator('.csv-edit-status').filter({ hasText: "Saved" }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
  await page.locator('#artifact-container, #work-area').first().screenshot({ path: join(dir, "csv-edit.png") });
  console.log(`  📸 ${join(dir, "csv-edit.png")}`);

  const onDisk = readFileSync(csvPath, "utf-8");
  if (!onDisk.includes("delta,done,9") || onDisk.includes("gamma")) {
    throw new Error(`disk did not reflect edit:\n${onDisk}`);
  }
  console.log("  ✓ save wrote new content to disk");

  // Flip back to Preview — table should show the edited rows.
  await page.locator('.csv-toggle-btn[data-mode="preview"]').click();
  await page.locator('.csv-table').waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(300);
  const bodyText = await page.locator('.csv-table tbody').innerText();
  if (!bodyText.includes("delta") || bodyText.includes("gamma")) {
    throw new Error(`preview did not reflect edit:\n${bodyText}`);
  }
  console.log("  ✓ preview reflects saved edit");
  await page.locator('#artifact-container, #work-area').first().screenshot({ path: join(dir, "csv-preview-after.png") });
  console.log(`  📸 ${join(dir, "csv-preview-after.png")}`);
} catch (e) {
  console.error("error:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}
