/**
 * Module M3 — Agent management (the `hadron` CLI + skills mechanics).
 *
 * The hadron-spawn skill turns "create two related agents" into `hadron spawn`
 * calls. This module proves the mechanics those skills depend on actually work:
 *   - script: spawn two agents via the CLI with a custom group, artifacts, and a
 *     mutual related-link; assert group + artifacts land and the related link is
 *     BIDIRECTIONAL (demo-1 ↔ demo-2)
 *   - browser: both cards render under the custom group; selecting demo-1 shows
 *     demo-2 in its RELATED panel (screenshot)
 *
 * The mutual-related check is the regression guard for the v0.6 bug where
 * `--related` only linked one direction, so the first agent's RELATED panel
 * stayed empty even though the two were "related".
 *
 * Run: node test/e2e/m3-agent-mgmt.js
 */
import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { bootWorkspace, reporter, screenshotDir } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const r = reporter("M3 Agent management");
const env = await bootWorkspace({ name: "m3" });
const port = env.baseUrl.split(":").pop();

function hadron(args) {
  return execFileSync("node", [join(REPO, "bin", "hadron.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HADRON_PORT: port, HADRON_TOKEN: env.token },
  });
}

let browser;
try {
  // ── script: the CLI flow the spawn skill uses ──
  hadron(["spawn", "demo 1", "--group", "Demo Agents", "--launch", "shell",
          "--artifact", "examples/demo.md,examples/demo.py,examples/demo.sql"]);
  hadron(["spawn", "demo 2", "--group", "Demo Agents", "--launch", "shell",
          "--related", "demo-1", "--artifact", "examples/demo.html"]);

  const byId = Object.fromEntries((await (await fetch(`${env.baseUrl}/api/sessions`)).json()).map((s) => [s.id, s]));
  const d1 = byId["demo-1"], d2 = byId["demo-2"];

  r.ok(d1 && d2, "both demo agents created");
  r.ok(d1?.group === "Demo Agents" && d2?.group === "Demo Agents", "both land in the 'Demo Agents' group");
  r.ok((d1?.artifacts || []).length === 3, "demo-1 has its 3 artifacts");
  r.ok((d2?.relatedAgents || []).includes("demo-1"), "demo-2 → related demo-1");
  // The regression guard: the link is mutual, not one-way.
  r.ok((d1?.relatedAgents || []).includes("demo-2"), "demo-1 → related demo-2 (mutual link)");

  // ── script: cwd-relative artifact paths normalize at add time ──
  // Relative paths are workspace-relative by convention, but agents add files
  // relative to their own cwd; the server resolves those against the cwd when the
  // file only exists there (regression: "could not load file" for
  // design-notes/x.md added from a repo nested inside the workspace), then stores
  // the ONE canonical form: workspace-relative for anything under the workspace
  // (artifacts-ux spec A6).
  const { mkdirSync, writeFileSync, readFileSync } = await import("fs");
  mkdirSync(join(env.ws, "subrepo", "notes"), { recursive: true });
  writeFileSync(join(env.ws, "subrepo", "notes", "deep.md"), "# deep\n");
  writeFileSync(join(env.ws, "root.md"), "# root\n");
  hadron(["spawn", "deep", "--launch", "shell", "--cwd", "subrepo"]);
  const { authHeaders } = await import("./harness.js");
  for (const value of ["notes/deep.md", "root.md"]) {
    await fetch(`${env.baseUrl}/api/sessions/deep/artifacts`, {
      method: "POST", headers: authHeaders(env.token),
      body: JSON.stringify({ type: "file", value }),
    });
  }
  // Assert the STORED values (the API resolves workspace-relative on the way out).
  const stored = JSON.parse(readFileSync(join(env.ws, ".hadron", "agents", "deep.json"), "utf-8")).artifacts;
  r.ok(stored[0]?.value === "subrepo/notes/deep.md",
    "cwd-relative artifact path resolved via the agent cwd, stored workspace-relative (canonical)");
  r.ok(stored[1]?.value === "root.md",
    "workspace-relative path that exists at the root is stored untouched");

  // ── browser: group renders + RELATED panel shows the sibling ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  const group = page.locator('.deck-group[data-group="demo agents"]');
  await group.waitFor({ state: "visible", timeout: 10000 });
  r.ok(await group.locator('.dk[data-sid="demo-1"]').isVisible(), "demo-1 card renders under 'Demo Agents'");
  r.ok(await group.locator('.dk[data-sid="demo-2"]').isVisible(), "demo-2 card renders under 'Demo Agents'");

  // Select demo-1 and prove its RELATED panel lists demo-2 (the bug was: empty here).
  await page.locator('.dk[data-sid="demo-1"]').click();
  const relName = page.locator('.ra-agent[data-ra-id="demo-2"] .ra-name');
  const linked = await relName.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
  r.ok(linked, "demo-1's RELATED panel shows demo-2 (mutual link surfaces in UI)");

  const shot = join(screenshotDir(), "m3-related.png");
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`  📸 ${shot}`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
