/**
 * Ad-hoc screenshot script for the UI-polish cluster (not part of npm test).
 * Boots a throwaway workspace, spawns an agent whose artifacts cover a spread
 * of file types (one with a very long label), opens several as tabs, and
 * captures: (1) the tab bar (truncation + per-type icons) and (2) the artifact
 * sidebar list (new icon set).
 *
 * Run: node test/e2e/shot-ui-polish.js
 */
import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { bootWorkspace, screenshotDir } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = await bootWorkspace({ name: "polish" });
const port = env.baseUrl.split(":").pop();

function hadron(args) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token },
  });
}

let browser;
try {
  // Write a spread of artifact files into the workspace.
  const dir = join(env.ws, "deliverables");
  mkdirSync(dir, { recursive: true });
  const files = {
    "Escalations T-100 gate-feature mismatch incl Slack draft.md": "# Escalation report\n\nA **very long** label lives in the tab bar.\n",
    "queries.sql": "SELECT id, name FROM agents WHERE state = 'blocked';\n",
    "metrics.csv": "agent,state,count\nalpha,idle,3\nbeta,working,7\n",
    "analysis.py": "import pandas as pd\nprint('hello')\n",
    "notebook.ipynb": JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    "dashboard.html": "<!doctype html><html><body><h1>Dashboard</h1><p>Static HTML artifact.</p></body></html>",
    "config.json": JSON.stringify({ name: "hadron", port: 3000 }, null, 2),
  };
  for (const [fn, content] of Object.entries(files)) {
    writeFileSync(join(dir, fn), content);
  }

  // Spawn an agent with all of them as artifacts (relative to workspace root).
  const rel = Object.keys(files).map((fn) => `deliverables/${fn}`).join(",");
  hadron(["spawn", "polish demo", "--group", "Demo", "--launch", "shell", "--artifact", rel]);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  // Select the agent.
  await page.locator('.dk[data-sid="polish-demo"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('.dk[data-sid="polish-demo"]').click();

  // Wait for the artifact sidebar list to paint, then screenshot it.
  await page.locator('.af[data-art-idx]').first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(400);

  const dir2 = screenshotDir();
  const sidebarShot = join(dir2, "ui-polish-sidebar.png");
  // Screenshot the right context panel containing the artifact list.
  const rightPanel = page.locator('#right').first();
  if (await rightPanel.count() && await rightPanel.isVisible()) {
    await rightPanel.screenshot({ path: sidebarShot });
  } else {
    await page.screenshot({ path: sidebarShot, fullPage: false });
  }
  console.log(`  📸 ${sidebarShot}`);

  // Open several artifacts as tabs (click each row in the sidebar).
  const rows = page.locator('.af[data-art-idx]');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);

  // Screenshot the tab bar region (the workspace header holds the tabs).
  const tabBarShot = join(dir2, "ui-polish-tabs.png");
  const header = page.locator('#work-header').first();
  if (await header.count() && await header.isVisible()) {
    await header.screenshot({ path: tabBarShot });
  } else {
    await page.screenshot({ path: tabBarShot, fullPage: false });
  }
  console.log(`  📸 ${tabBarShot}`);

  // Also a full-page shot for overall context.
  const fullShot = join(dir2, "ui-polish-full.png");
  await page.screenshot({ path: fullShot, fullPage: false });
  console.log(`  📸 ${fullShot}`);
} catch (e) {
  console.error("error:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}
