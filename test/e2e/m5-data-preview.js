/**
 * Module M5 — Data-aware preview (v0.8).
 *
 * The artifact panel is a review surface: rendering a CSV/notebook should catch
 * silent errors fast, not just paint the file. This module simulates a human:
 *   - script: write a CSV (known shape, a null-ridden numeric column) and an
 *     .ipynb (one errored cell, one clean) into the workspace; create an agent
 *     via the HTTP API with both attached
 *   - browser: click the CSV artifact like a user → the stats strip shows the
 *     shape, flags exactly the null column (dtype + null count + min/μ/max);
 *     click the notebook → the error banner names the exception and exactly the
 *     errored cell is red-marked; rewrite a clean cell's source on disk → the
 *     mtime auto-reload badges exactly that cell as "changed" (screenshots)
 *
 * /api/jupyter/start is route-intercepted to answer "no live server" so the
 * static renderer (the thing under test) paints — same path as a machine
 * without jupyter installed.
 *
 * Run: node test/e2e/m5-data-preview.js
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const r = reporter("M5 Data-aware preview");
const env = await bootWorkspace({ name: "m5" });
let browser;

// 6 rows × 4 cols; "score" is numeric with 2 nulls (min 3, μ 11.25, max 25).
const csv = [
  "name,score,joined,active",
  "alpha,10,2024-01-05,true",
  "beta,,2024-02-11,false",
  "gamma,7,2024-03-02,true",
  "delta,,2024-04-19,false",
  "epsilon,3,2024-05-23,true",
  "zeta,25,2024-06-30,true",
].join("\n") + "\n";

const nb = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
  cells: [
    {
      cell_type: "code", execution_count: 1, metadata: {}, source: ["x = 1\n", "x"],
      outputs: [{ output_type: "execute_result", execution_count: 1, metadata: {}, data: { "text/plain": ["1"] } }],
    },
    {
      cell_type: "code", execution_count: 2, metadata: {}, source: ["1/0"],
      outputs: [{
        output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero",
        traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"],
      }],
    },
  ],
};

try {
  // ── script: fixtures on disk + agent created over the HTTP API ──
  const nbPath = join(env.ws, "analysis.ipynb");
  writeFileSync(join(env.ws, "report.csv"), csv);
  writeFileSync(nbPath, JSON.stringify(nb, null, 1));
  // md with a relative image (regression: resolved against the dashboard
  // origin instead of the md file's directory, so logos never rendered)
  const { mkdirSync } = await import("fs");
  mkdirSync(join(env.ws, "docs", "img"), { recursive: true });
  writeFileSync(join(env.ws, "docs", "img", "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#58a6ff"/></svg>');
  writeFileSync(join(env.ws, "docs", "summary.md"),
    '# Summary\n\n<img src="img/logo.svg" alt="logo" />\n\n![same](./img/logo.svg)\n');

  const resp = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "data demo", group: "Demo", launchCommand: "shell",
      artifacts: [
        { type: "file", value: "report.csv" },
        { type: "file", value: "analysis.ipynb" },
        { type: "file", value: "docs/summary.md" },
      ],
    }),
  });
  r.ok(resp.status === 201, "agent created via HTTP API with CSV + notebook artifacts");

  // ── browser: a user clicks through both artifacts ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.route("**/api/jupyter/start", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });

  await page.locator('.dk[data-sid="data-demo"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('.dk[data-sid="data-demo"]').click();

  // CSV: stats strip above the table — shape + the null column called out.
  await page.locator('.af[data-art-idx]', { hasText: "report.csv" }).click();
  await page.locator('.csv-stats').waitFor({ state: "visible", timeout: 10000 });
  const statsText = await page.locator('.csv-stats').innerText();
  r.ok(statsText.includes("6 rows × 4 cols"), `stats strip shows the shape (got: ${statsText.split("\n")[0]})`);
  r.ok((await page.locator('.csv-stat-col.has-nulls').count()) === 1, "exactly one column is flagged for nulls");
  const nullChip = await page.locator('.csv-stat-col.has-nulls').innerText();
  r.ok(nullChip.includes("score") && nullChip.includes("2 null"), `the score column reports its 2 nulls (got: ${nullChip})`);
  r.ok(nullChip.includes("number"), "score still infers as number despite the nulls");
  r.ok(nullChip.includes("3") && nullChip.includes("11.25") && nullChip.includes("25"), `numeric min/μ/max computed (got: ${nullChip})`);
  const dir = screenshotDir();
  await page.locator('#artifact-container').screenshot({ path: join(dir, "m5-csv-stats.png") });
  console.log(`  📸 ${join(dir, "m5-csv-stats.png")}`);

  // Notebook: error banner + the errored cell (and only it) marked.
  await page.locator('.af[data-art-idx]', { hasText: "analysis.ipynb" }).click();
  await page.locator('.jupyter-error-banner').waitFor({ state: "visible", timeout: 10000 });
  const banner = await page.locator('.jupyter-error-banner').innerText();
  r.ok(banner.includes("1 cell errored") && banner.includes("ZeroDivisionError"), `banner counts errors and names the first (got: ${banner})`);
  r.ok((await page.locator('.jupyter-cell-errored').count()) === 1, "exactly the errored cell is red-marked");
  r.ok((await page.locator('.jupyter-cell-badge').count()) === 0, "no 'changed' badges on first render");
  await page.locator('#artifact-container').screenshot({ path: join(dir, "m5-nb-error.png") });
  console.log(`  📸 ${join(dir, "m5-nb-error.png")}`);

  // Changed cells: rewrite the clean cell on disk → mtime poll (3s) reloads the
  // artifact and badges exactly that cell.
  nb.cells[0].source = ["x = 2\n", "x"];
  writeFileSync(nbPath, JSON.stringify(nb, null, 1));
  await page.locator('.jupyter-cell-badge').waitFor({ state: "visible", timeout: 15000 });
  r.ok((await page.locator('.jupyter-cell-badge').count()) === 1, "auto-reload badges exactly one cell as changed");
  const changedSrc = await page.locator('.jupyter-cell:has(.jupyter-cell-badge) .jupyter-source').innerText();
  r.ok(changedSrc.includes("x = 2"), "the badge sits on the cell whose source changed");
  r.ok((await page.locator('.jupyter-cell-errored').count()) === 1, "error marking survives the reload");
  await page.locator('#artifact-container').screenshot({ path: join(dir, "m5-nb-changed.png") });
  console.log(`  📸 ${join(dir, "m5-nb-changed.png")}`);

  // Markdown relative images: both md-syntax and inline-HTML imgs get rewritten
  // through /api/file and actually load (naturalWidth > 0 ⇒ HTTP 200 + image mime).
  await page.locator('.af[data-art-idx]', { hasText: "summary.md" }).click();
  await page.locator('.md-preview img').first().waitFor({ state: "visible", timeout: 10000 });
  const imgs = await page.locator('.md-preview img').evaluateAll((els) =>
    els.map((el) => ({ src: el.getAttribute("src"), loaded: el.complete && el.naturalWidth > 0 })));
  r.ok(imgs.length === 2 && imgs.every((i) => i.src.startsWith("/api/file?path=")), "relative img srcs rewritten through /api/file (md syntax + inline HTML)");
  r.ok(imgs.every((i) => i.src.includes(encodeURIComponent("docs/img/logo.svg"))), "rewritten srcs resolve against the md file's directory");
  r.ok(imgs.every((i) => i.loaded), "both images actually load (server serves image mime + bytes)");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
