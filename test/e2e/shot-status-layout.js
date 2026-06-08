/**
 * Ad-hoc screenshot for the "Deck Layout: Status" view (not part of npm test).
 * Boots a throwaway workspace, spawns agents across two groups with mixed states,
 * captures the default group layout, flips the menu to Status, and captures the
 * status-bucketed deck.
 *
 * Run: node test/e2e/shot-status-layout.js
 */
import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { bootWorkspace, screenshotDir } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = await bootWorkspace({ name: "status" });
const port = env.baseUrl.split(":").pop();

function hadron(args) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token },
  });
}

// State is derived from live tmux panes, which all read idle in a headless box.
// Freeze the session poller and inject states into the client's in-memory model
// so we can exercise the bucketing/layout logic deterministically.
async function injectStates(page) {
  await page.evaluate(() => {
    fetchSessions = async () => {}; // freeze: stop the 3s poll from resetting states
    const set = (id, st) => { const s = sessions.find((x) => x.id === id); if (s) s.state = st; };
    set("ingest", "working");
    set("report", "done");
    set("deploy", "blocked");
    set("monitor", "idle");
    const d = sessions.find((x) => x.id === "deploy");
    if (d) d.blockReason = "permission prompt";
    renderDeck();
  });
}

let browser;
try {
  hadron(["spawn", "ingest", "--group", "Workers", "--launch", "shell"]);
  hadron(["spawn", "report", "--group", "Workers", "--launch", "shell"]);
  hadron(["spawn", "deploy", "--group", "DevOps", "--launch", "shell"]);
  hadron(["spawn", "monitor", "--group", "DevOps", "--launch", "shell"]);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid]').first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(500);

  const dir = screenshotDir();
  const deck = page.locator('#deck-groups');

  // Group layout (default) with mixed states.
  await injectStates(page);
  await deck.screenshot({ path: join(dir, "status-layout-group.png") });
  console.log(`  📸 ${join(dir, "status-layout-group.png")}`);

  // Flip to Status layout via the View menu, then re-inject (menu render is fine,
  // but re-assert states in case a stray poll landed) and screenshot.
  await page.locator('text=View').first().click();
  await page.waitForTimeout(150);
  await page.locator('.menu-dropdown-item.has-submenu', { hasText: 'Deck Layout' }).hover();
  await page.waitForTimeout(200);
  await page.locator('.menu-submenu [data-groupby="status"]').click();
  await injectStates(page);
  await page.waitForTimeout(200);

  await deck.screenshot({ path: join(dir, "status-layout-status.png") });
  console.log(`  📸 ${join(dir, "status-layout-status.png")}`);

  // Assert headers reflect buckets and the blocked agent leads.
  const headers = await page.locator('.deck-group-label').allInnerTexts();
  const txt = headers.join("|").toLowerCase();
  if (!txt.includes("blocked") || !txt.includes("working") || !txt.includes("idle")) {
    throw new Error(`status headers missing: ${txt}`);
  }
  const firstHeader = (await page.locator('.deck-group-label').first().innerText()).toLowerCase();
  if (!firstHeader.includes("blocked")) throw new Error(`expected blocked bucket first, got: ${firstHeader}`);
  console.log("  ✓ status buckets render, blocked leads");
} catch (e) {
  console.error("error:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}
