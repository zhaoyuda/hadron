/**
 * Module M8 — Annotation review loop (v0.8).
 *
 * The centerpiece loop: a human circles text in the markdown preview and leaves
 * comments, batches them, one-click Sends — the agent gets a single
 * `/hadron-review` trigger in its tmux pane, pulls the content over the API,
 * resolves comment by comment, and the panel empties itself. This module
 * simulates both sides:
 *   - browser: select a paragraph → 💬 → comment lands as a draft (sidecar on
 *     disk has the exact anchor); whole-doc comment; drawer edit + delete of
 *     drafts; Send flips the floating bar to 等待修改 with the server's 口径
 *   - script: tmux capture-pane proves the literal trigger arrived; PATCH on a
 *     sent comment 409s; resolves go through the HTTP API (deterministic — the
 *     CLI resolves identity via tmux, which a test shouldn't depend on)
 *   - browser again: resolved comments vanish within one poll; full batch flips
 *     the bar to re-open; re-open recalls everything as drafts (disk agrees);
 *     rewriting the anchored text orphans the comment in the drawer and nothing
 *     gets falsely highlighted (screenshot)
 *
 * Run: node test/e2e/m8-annotations.js
 */
import { chromium } from "playwright";
import { execFileSync } from "child_process";
import { writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const r = reporter("M8 Annotation review loop");
const env = await bootWorkspace({ name: "m8" });
let browser;

const PARA_A = "Latency dropped sharply after the cache rewrite.";
const PARA_C = "The conclusion needs stronger evidence before we ship.";
const md = [
  "# Release review",
  "",
  "The quarterly metrics improved across all regions.",
  "",
  PARA_A,
  "",
  PARA_C,
  "",
].join("\n");

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(150); }
  return fn();
}

try {
  // ── script: fixture + agent with a live tmux session (shell, no autostart cmd) ──
  writeFileSync(join(env.ws, "report.md"), md);
  const created = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "Anno Demo", group: "Demo", launchCommand: "shell",
      artifacts: [{ type: "file", value: "report.md" }],
    }),
  });
  r.ok(created.status === 201, "agent created via HTTP API with a markdown artifact");
  const agentId = (await created.json()).id;

  const annBase = `${env.baseUrl}/api/sessions/${agentId}/annotations`;
  const list = (q = "") => fetch(`${annBase}${q}`).then((x) => x.json());
  const post = (rest, body) => fetch(`${annBase}${rest}`, { method: "POST", headers: authHeaders(env.token), body: JSON.stringify(body ?? {}) });
  const sidecars = () => {
    const dir = join(env.ws, ".hadron", "annotations", agentId);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json"); } catch {}
    return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
  };
  const capturePane = () => {
    try {
      return execFileSync("tmux", ["capture-pane", "-t", `hadron-${env.wsName}-${agentId}`, "-p"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { return ""; }
  };

  // ── browser: open the preview ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="anno-demo"]').click();
  await page.locator('.af[data-art-idx]', { hasText: "report.md" }).click();
  await page.locator("#artifact-container .md-preview").waitFor({ state: "visible", timeout: 10000 });

  // Programmatic selection + mouseup — same path as a real drag, minus the flake.
  async function commentOnText(text, body) {
    const found = await page.evaluate((t) => {
      const preview = document.querySelector("#artifact-container .md-preview");
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const i = node.nodeValue.indexOf(t);
        if (i === -1) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + t.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        preview.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return true;
      }
      return false;
    }, text);
    if (!found) throw new Error(`fixture text not found in preview: ${text}`);
    await page.locator(".ann-fab").click();
    await page.locator(".ann-pop-body").fill(body);
    await page.locator(".ann-pop-add").click();
  }

  // ── 1. selection comment → draft sidecar on disk; edit + delete drafts ──
  await commentOnText(PARA_A, "tighten this claim");
  r.ok(await until(() => sidecars().some((s) => s.comments.length)), "comment sidecar written to .hadron/annotations/<agent>/");
  const draftA = sidecars()[0]?.comments[0];
  r.ok(draftA?.state === "draft" && draftA?.batchId === null, "comment lands as a clean draft");
  r.ok(draftA?.anchor?.type === "text" && draftA?.anchor?.exact === PARA_A, "anchor.exact is the selected text (mapped to raw markdown)");
  r.ok(sidecars()[0]?.file === "report.md" && sidecars()[0]?.scope === "workspace", "sidecar stores the workspace-relative path");
  await page.locator(`mark.ann-mark[data-ann-id="${draftA.id}"]`).waitFor({ state: "visible", timeout: 7000 });
  r.ok(true, "matched comment gets a highlight mark in the preview");

  // Whole-doc comment via the toggle-bar 💬, then a second selection comment.
  await page.locator("#artifact-container .ann-doc-btn").click();
  await page.locator(".ann-pop-body").fill("overall: too long");
  await page.locator(".ann-pop-add").click();
  await commentOnText(PARA_C, "add citations");
  r.ok(await until(async () => (await list("?state=all")).summary.draft === 3), "three drafts (two selections + whole doc) visible over the API");
  const docDraft = (await list()).comments.find((c) => c.anchor.type === "doc");
  const draftC = (await list()).comments.find((c) => c.anchor.exact === PARA_C);

  // Drawer: edit draft A inline, delete the doc draft.
  await page.locator(".ann-badge").click();
  await page.locator(".ann-drawer.open").waitFor({ timeout: 5000 });
  const rowA = page.locator(`.ann-row[data-ann-id="${draftA.id}"]`);
  await rowA.locator(".ann-row-edit").click();
  await rowA.locator(".ann-row-editbox").fill("tighten this claim (cite Q3)");
  await rowA.locator(".ann-row-save").click();
  r.ok(await until(async () => (await list()).comments.find((c) => c.id === draftA.id)?.body === "tighten this claim (cite Q3)"),
    "drawer inline edit PATCHes the draft body");
  await page.locator(`.ann-row[data-ann-id="${docDraft.id}"] .ann-row-del`).click();
  r.ok(await until(async () => (await list("?state=all")).summary.draft === 2), "drawer × deletes the doc draft (2 drafts left)");

  // ── 6. screenshot while the highlight + bar are both on screen ──
  await until(async () => /2 comments · Send to agent/.test(await page.locator(".ann-bar").innerText()), 7000);
  const barText = await page.locator(".ann-bar").innerText();
  r.ok(/2 comments · Send to agent/.test(barText), `floating bar offers Send for 2 drafts (got: ${barText.replace(/\n/g, " ")})`);
  const shot = join(screenshotDir(), "m8-annotations.png");
  await page.locator("#artifact-container").screenshot({ path: shot });
  console.log(`  📸 ${shot}`);
  await page.locator(".ann-drawer-close").click();

  // ── 2. Send: one literal trigger line into the pane; batch locks ──
  await page.locator(".ann-send").click();
  r.ok(await until(() => capturePane().includes("/hadron-review")), "Send dispatched literal /hadron-review into the agent's tmux pane");
  r.ok(await until(async () => (await list()).summary.sent === 2 && (await list()).summary.draft === 0), "both drafts became sent (one batch)");
  const patchSent = await fetch(`${annBase}/${draftA.id}`, {
    method: "PATCH", headers: authHeaders(env.token), body: JSON.stringify({ body: "rewrite" }),
  });
  r.ok(patchSent.status === 409, "PATCH on a sent comment → 409 (batch is locked)");
  await until(async () => (await page.locator(".ann-bar").innerText()).includes("等待修改 (0/2)"), 7000);
  r.ok((await page.locator(".ann-bar").innerText()).includes("等待修改 (0/2)"), "bar flips to 等待修改 (0/2) after Send");

  // ── 3. agent resolves one (HTTP, deterministic) → UI drops it within one poll ──
  r.ok((await post(`/${draftA.id}/resolve`)).status === 200, "resolve via API → 200");
  const dropped = await page.waitForFunction((id) =>
    !document.querySelector(`mark.ann-mark[data-ann-id="${id}"]`) &&
    document.querySelector(".ann-bar")?.innerText.includes("等待修改 (1/2)"),
    draftA.id, { timeout: 6500 }).then(() => true).catch(() => false);
  r.ok(dropped, "resolved comment's mark disappears ≤6s and the bar counts 等待修改 (1/2)");

  // ── 4. full batch resolved → re-open recalls it as drafts ──
  await post(`/${draftC.id}/resolve`);
  await until(async () => (await page.locator(".ann-bar").innerText()).includes("re-open"), 7000);
  r.ok((await page.locator(".ann-bar").innerText()).includes("re-open 上一批"), "all resolved → bar flips to ↻ re-open 上一批");
  await page.locator(".ann-reopen").click();
  await until(async () => (await page.locator(".ann-bar").innerText()).includes("2 comments"), 7000);
  r.ok((await page.locator(".ann-bar").innerText()).includes("2 comments · Send to agent"), "re-open brings the batch back as drafts in the UI");
  const reopened = sidecars().flatMap((s) => s.comments);
  r.ok(reopened.length === 2 && reopened.every((c) => c.state === "draft" && c.batchId === null && c.sentAt === null && c.resolvedAt === null),
    "on disk: reopened comments are clean drafts (batchId/sentAt/resolvedAt null)");

  // ── 5. rewrite the anchored text → orphaned in the list, never falsely marked ──
  writeFileSync(join(env.ws, "report.md"), md.replace(PARA_C, "We trimmed the conclusion."));
  r.ok(await until(async () => (await list()).comments.find((c) => c.id === draftC.id)?.anchorStatus === "orphaned", 5000),
    "GET recomputes the rewritten anchor as orphaned");
  await page.locator(".ann-badge").click();
  const orphanShown = await page.waitForFunction((id) => {
    const row = document.querySelector(`.ann-drawer .ann-row[data-ann-id="${id}"]`);
    return row && row.querySelector(".ann-chip-bad")?.textContent.includes("orphaned") &&
      !document.querySelector(`mark.ann-mark[data-ann-id="${id}"]`);
  }, draftC.id, { timeout: 10000 }).then(() => true).catch(() => false);
  r.ok(orphanShown, "drawer shows the red orphaned chip; no mark highlights the wrong place");
  r.ok((await page.locator(`mark.ann-mark[data-ann-id="${draftA.id}"]`).count()) === 1,
    "the still-matched comment keeps its (only) highlight after the rewrite");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
