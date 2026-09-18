/**
 * Module M9 — Artifact live-reload (mtime poller + HTML update pill).
 *
 * Two real bugs drove this module:
 *  1. Baseline race: the poller used its own first HEAD (3s after render) as the
 *     change baseline, silently swallowing any disk write inside that window —
 *     an HTML tab opened right before an agent rewrote the file stayed stale
 *     forever. The fix keys the baseline to the rendered content's mtime.
 *  2. Split-mode gap: HTML panes rendered outside the artifact cache and the
 *     poller exited when activeTab wasn't an artifact, so vsplit/hsplit HTML
 *     never noticed disk changes at all.
 *
 * Design under test: md/csv keep silent auto-reload (no interaction state to
 * lose); a live HTML iframe instead gets a "File updated ↻ Reload" pill —
 * reloading only on click so scroll/JS/form state isn't yanked away.
 *
 * Two more from a multi-workspace macOS report ("HTML and notebook artifacts
 * don't live-update — I close and reopen the tab"):
 *  3. A tab opened BEFORE the agent wrote the file (artifact attached first,
 *     file lands later) rendered a 404/"could not load" and never recovered:
 *     its cache entry had no mtime, so neither the poller nor the tab-switch
 *     check had anything to compare. Now it is flagged `missing` and paints
 *     silently when the file appears (nothing on screen worth preserving).
 *  4. Live jupyter iframes (proxy URLs) were dropped from polling entirely:
 *     the jupyter server holds the notebook it loaded, so an agent's rewrite
 *     on disk never showed. They now get the same pill; the click re-points
 *     the iframe at the proxy with a cache-busting query param (verified
 *     against a real Notebook 7: a cache-busted reload re-reads the file).
 *     The proxy is route-stubbed here (no jupyter needed): the stub serves
 *     whatever is on disk, so a src swap is observable as new content.
 *     marimo is launched with --watch and reloads its own cells (verified
 *     against marimo 0.23), so it gets no pill.
 *  5. A file artifact that HEADs fine but can't be read (a directory —
 *     `hadron artifacts add <dir>` posts type "file") must not re-render on
 *     every poll: the mtime seen at the failed render is the baseline.
 *
 * Technique: browser (Playwright) — the truths are iframe src swaps, pill
 * rendering, and poller timing, none visible to script-level checks.
 *
 * Run: node test/e2e/m9-artifact-reload.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M9 Artifact live-reload");
const env = await bootWorkspace({ name: "m9" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
// Poller ticks every 3s; give each expectation three ticks of slack.
async function until(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(250); }
  return fn();
}

try {
  const htmlPath = join(env.ws, "report.html");
  const mdPath = join(env.ws, "notes.md");
  writeFileSync(htmlPath, "<html><body><h1 id='v'>VERSION-1</h1></body></html>");
  writeFileSync(mdPath, "# md-v1");
  await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "m9", launchCommand: "shell",
      artifacts: [{ type: "file", value: "report.html" }, { type: "file", value: "notes.md" }],
    }),
  });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="m9"]').click();

  // ── HTML tab: change inside the first 3s window → pill, not a silent swap ──
  await page.locator(".af[data-art-idx]", { hasText: "report.html" }).click();
  const iframe = page.locator('#artifact-container iframe[data-html-iframe="1"]');
  const frame = page.frameLocator('#artifact-container iframe[data-html-iframe="1"]');
  await frame.locator("#v").waitFor({ state: "visible", timeout: 10000 });
  const src1 = await iframe.getAttribute("src");

  await wait(1500); // land the write inside the old swallow window
  writeFileSync(htmlPath, "<html><body><h1 id='v'>VERSION-2</h1></body></html>");
  r.ok(await until(() => page.locator("#artifact-container .artifact-update-pill").count()),
    "disk write right after open → update pill appears (baseline race fixed)");
  r.ok((await iframe.getAttribute("src")) === src1 && (await frame.locator("#v").innerText()) === "VERSION-1",
    "iframe NOT silently reloaded — old content stays until the user opts in");

  await page.locator("#artifact-container .artifact-update-pill").click();
  r.ok(await until(async () => (await frame.locator("#v").innerText().catch(() => "")) === "VERSION-2"),
    "clicking the pill reloads the iframe to the new content");
  r.ok((await page.locator("#artifact-container .artifact-update-pill").count()) === 0,
    "pill is gone after reload");

  // ── markdown tab: still silent auto-reload, also immune to the race ──
  await page.locator(".af[data-art-idx]", { hasText: "notes.md" }).click();
  await page.locator("#artifact-container .md-preview", { hasText: "md-v1" }).waitFor({ timeout: 10000 });
  await wait(1500);
  writeFileSync(mdPath, "# md-v2");
  r.ok(await until(async () =>
    (await page.locator("#artifact-container .md-preview").innerText().catch(() => "")).includes("md-v2")),
    "markdown artifact silently auto-reloads on disk change (early write included)");

  // ── split mode: HTML pane is watched too ──
  await page.evaluate(() => cycleLayout()); // tabs → vsplit; both artifacts become panes
  const paneFrame = page.frameLocator('.split-pane[data-html-path] iframe[data-html-iframe="1"]');
  await paneFrame.locator("#v").waitFor({ state: "visible", timeout: 10000 });
  await wait(1500); // let the watch baseline settle
  writeFileSync(htmlPath, "<html><body><h1 id='v'>VERSION-3</h1></body></html>");
  r.ok(await until(() => page.locator(".split-pane .artifact-update-pill").count()),
    "split-mode HTML pane detects the disk change (was: never)");
  await page.screenshot({ path: join(screenshotDir(), "m9-split-update-pill.png") });
  await page.locator(".split-pane .artifact-update-pill").click();
  r.ok(await until(async () => (await paneFrame.locator("#v").innerText().catch(() => "")) === "VERSION-3"),
    "split-pane pill click reloads the pane iframe");

  // ── tab opened before the file exists: recovers when the file appears ──
  await page.evaluate(() => cycleLayout()); // vsplit → hsplit
  await page.evaluate(() => cycleLayout()); // hsplit → tabs
  const lateHtml = join(env.ws, "late.html");
  const lateMd = join(env.ws, "late.md");
  const nbPath = join(env.ws, "live.ipynb");
  const nbJson = (n) => JSON.stringify({ cells: [{ cell_type: "code", source: [`x = ${n}`], outputs: [], execution_count: null, metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  writeFileSync(nbPath, nbJson(1));
  mkdirSync(join(env.ws, "adir"));
  const m9 = (await (await fetch(`${env.baseUrl}/api/sessions`, { headers: authHeaders(env.token) })).json()).find((x) => x.id === "m9");
  await fetch(`${env.baseUrl}/api/sessions/m9`, {
    method: "PATCH", headers: authHeaders(env.token),
    body: JSON.stringify({ artifacts: [...m9.artifacts,
      { type: "file", value: "late.html" }, { type: "file", value: "late.md" },
      { type: "file", value: "live.ipynb" }, { type: "file", value: "adir" }] }),
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="m9"]').click();

  await page.locator(".af[data-art-idx]", { hasText: "late.html" }).click();
  await wait(1500); // pane has rendered its 404 iframe; poller is up
  writeFileSync(lateHtml, "<html><body><h1 id='late'>LATE-HTML-1</h1></body></html>");
  const lateFrame = page.frameLocator('#artifact-container iframe[data-html-iframe="1"]');
  r.ok(await until(async () => (await lateFrame.locator("#late").innerText().catch(() => "")) === "LATE-HTML-1"),
    "HTML tab opened before the file existed paints it when it appears (was: stale 404 until close/reopen)");
  r.ok((await page.locator("#artifact-container .artifact-update-pill").count()) === 0,
    "…silently — no pill for a pane that showed nothing");
  writeFileSync(lateHtml, "<html><body><h1 id='late'>LATE-HTML-2</h1></body></html>");
  r.ok(await until(() => page.locator("#artifact-container .artifact-update-pill").count()),
    "…and from then on it is a normal live HTML pane (next change → pill)");

  await page.locator(".af[data-art-idx]", { hasText: "late.md" }).click();
  await page.locator("#artifact-container .artifact-file-error").waitFor({ timeout: 10000 });
  await wait(1000);
  writeFileSync(lateMd, "# late-md-1");
  r.ok(await until(async () =>
    (await page.locator("#artifact-container .md-preview").innerText().catch(() => "")).includes("late-md-1")),
    "markdown tab opened before the file existed renders it when it appears");

  // ── live notebook iframes: update pill + cache-busted reload ──
  // Stub the launch endpoints and the proxies. The proxy stub serves the file
  // as it is on disk right now, so a reload is visible as new content.
  const { readFileSync } = await import("fs");
  await page.route("**/api/jupyter/start", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ port: 1, proxyBase: "/jupyter-proxy/1" }) }));
  await page.route("**/jupyter-proxy/1/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<html><body><p id="nb">${JSON.parse(readFileSync(nbPath, "utf-8")).cells[0].source.join("")}</p></body></html>` }));

  await page.locator(".af[data-art-idx]", { hasText: "live.ipynb" }).click();
  const nbFrame = page.frameLocator("#artifact-container iframe.jupyter-live");
  await nbFrame.locator("#nb").waitFor({ state: "visible", timeout: 10000 });
  r.ok((await nbFrame.locator("#nb").innerText()) === "x = 1", "jupyter: live iframe (stubbed proxy) shows the notebook as launched");
  const nbSrc1 = await page.locator("#artifact-container iframe.jupyter-live").getAttribute("src");
  r.ok(await page.locator("#artifact-container iframe.jupyter-live").getAttribute("data-mtime"), "…iframe carries the launch-time mtime baseline");
  await wait(1000);
  writeFileSync(nbPath, nbJson(2));
  r.ok(await until(() => page.locator("#artifact-container .artifact-update-pill").count()),
    "jupyter: agent rewrites the .ipynb on disk → update pill on the live pane (was: nothing, ever)");
  r.ok((await page.locator("#artifact-container iframe.jupyter-live").getAttribute("src")) === nbSrc1 && (await nbFrame.locator("#nb").innerText()) === "x = 1",
    "…iframe not silently reloaded (editor state would be lost)");
  await page.locator("#artifact-container .artifact-update-pill").click();
  r.ok(await until(async () => (await nbFrame.locator("#nb").innerText().catch(() => "")) === "x = 2"),
    "…clicking the pill reloads the notebook from disk through the proxy");
  const nbSrc2 = await page.locator("#artifact-container iframe.jupyter-live").getAttribute("src");
  r.ok(nbSrc2 !== nbSrc1 && /[?&]_=/.test(nbSrc2) && nbSrc2.startsWith(nbSrc1),
    `…via a cache-busting query param on the same proxy URL (${nbSrc2})`);
  r.ok((await page.locator("#artifact-container .artifact-update-pill").count()) === 0, "…pill gone after reload");
  writeFileSync(nbPath, nbJson(3));
  r.ok(await until(() => page.locator("#artifact-container .artifact-update-pill").count()), "…a further write → pill again (baseline advanced)");
  await page.locator("#artifact-container .artifact-update-pill").click();
  r.ok(await until(async () => (await nbFrame.locator("#nb").innerText().catch(() => "")) === "x = 3"), "…and reloads to the third version");
  const nbSrc3 = await page.locator("#artifact-container iframe.jupyter-live").getAttribute("src");
  r.ok(nbSrc3.startsWith(nbSrc1) && (nbSrc3.match(/_=/g) || []).length === 1, "…without stacking cache-busters on the URL");

  // ── a file artifact whose HEAD succeeds but GET fails (a directory) must
  // not be re-rendered every poll: "missing" means "not there YET", and the
  // mtime seen at the failed render is the baseline for "appeared".
  const getCount = { n: 0 };
  page.on("request", (req) => { if (req.method() === "GET" && /\/api\/file\?path=[^&]*adir/.test(req.url())) getCount.n++; });
  await page.locator(".af[data-art-idx]", { hasText: "adir" }).click();
  await page.locator("#artifact-container .artifact-file-error").waitFor({ timeout: 10000 });
  const after1 = getCount.n;
  await wait(7500); // > 2 poller ticks
  r.ok(getCount.n === after1 && after1 >= 1,
    `directory-as-file artifact: rendered once and left alone (GETs: ${after1} then ${getCount.n} after 7.5s; was: re-rendered every 3s forever)`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
