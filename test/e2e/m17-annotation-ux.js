/**
 * Module M17 — Annotation UX (trustworthy anchors, comment-ux-p0).
 *
 * Regression coverage for D1–D5 (design-notes/comment-ux-p0-spec.md): the FAB
 * follows the selection instead of the far right edge (D1); selections crossing
 * headings/paragraphs/inline formatting become TEXT anchors instead of silently
 * degrading to doc comments (D2); the flatten-index painter marks cross-block,
 * formatted, duplicate (rOrdinal) and overlapping ranges — honestly, never in
 * the wrong place (D3); the hover card replaces the native title tooltip and
 * supports in-place edit/delete, read-only once sent (D4); the CLI/agent sees
 * an excerpt for formatted anchors instead of "(original text no longer
 * found)" (D5); and marks survive an mtime auto-reload of the preview.
 *
 * Rail compatibility (comment-rail-spec.md "M17 compatibility"): this module
 * regression-covers the P0 surfaces — popover composer, hover/pinned card,
 * chooser — which are the sub-560px fallback now that the comment rail owns
 * mark interaction at wide previews. Choice (a) for every interaction case:
 * run the WHOLE module at a viewport whose preview is < 560px wide so the P0
 * surfaces stay authoritative and every original assert keeps its meaning
 * (asserted below so a layout change can't silently flip the regime). The
 * rail's own behavior is covered at a wide viewport by M18. Case 11
 * (stale-context honesty) is viewport-independent and unchanged.
 *
 * Run: node test/e2e/m17-annotation-ux.js
 */
import { chromium } from "playwright";
import { execFileSync } from "child_process";
import { writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const r = reporter("M17 Annotation UX (trustworthy anchors)");
const env = await bootWorkspace({ name: "m17" });
let browser;

// ── fixture: h2, plain paragraphs, a **bold** span mid-sentence, TWO identical
// sentences with distinct context, and enough filler that the doc scrolls ──
const H2 = "Cache rewrite results";
const P1 = "The quarterly metrics improved in every region.";
const P2 = "Latency dropped sharply once the storage migration finished.";
const DUP = "The build is reproducible on every host.";
const UNIQUE = "The conclusion needs stronger evidence before we ship.";
const OV_A = "the pipeline caches artifacts aggressively";
const OV_B = "artifacts aggressively and prunes stale entries";
const BOLD_SEL = "were carefully staged across"; // spans the **bold** span below

const filler = Array.from({ length: 14 }, (_, i) =>
  `Operational log entry ${i + 1}: routine deploy telemetry recorded without incident during the overnight window.`);
const md = [
  "# Annotation UX report",
  "",
  `## ${H2}`,
  "",
  P1,
  "",
  P2,
  "",
  "Rollouts were **carefully staged** across three rings this quarter.",
  "",
  `Alpha context opens this paragraph. ${DUP} Alpha remarks close it out.`,
  "",
  ...filler.flatMap((f) => [f, ""]),
  `Beta context opens this paragraph. ${DUP} Beta remarks close it out.`,
  "",
  UNIQUE,
  "",
  `Meanwhile ${OV_A} and prunes stale entries nightly.`,
  "",
].join("\n");

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(150); }
  return fn();
}

try {
  // ── script: fixture + agent with a live tmux session (shell, no autostart) ──
  writeFileSync(join(env.ws, "report.md"), md);
  const created = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "Anno UX", group: "Demo", launchCommand: "shell",
      artifacts: [{ type: "file", value: "report.md" }],
    }),
  });
  r.ok(created.status === 201, "agent created via HTTP API with a markdown artifact");
  const agentId = (await created.json()).id;

  const annBase = `${env.baseUrl}/api/sessions/${agentId}/annotations`;
  const list = (q = "") => fetch(`${annBase}${q}`).then((x) => x.json());
  const byBody = async (b) => (await list()).comments.find((c) => c.body === b);
  const sidecars = () => {
    const dir = join(env.ws, ".hadron", "annotations", agentId);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json"); } catch {}
    return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
  };
  const onDisk = (id) => sidecars().flatMap((s) => s.comments).find((c) => c.id === id);

  // ── browser: open the preview ──
  // 800px viewport → preview ≈517px < 560 (threshold lowered for split panes,
  // 2026-07-21): the rail never mounts (R1), so the
  // P0 surfaces this module regression-covers stay authoritative (choice (a),
  // see header). Wide-viewport rail behavior is M18's job.
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 850 } });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="${agentId}"]`).click();
  await page.locator('.af[data-art-idx]', { hasText: "report.md" }).click();
  await page.locator("#artifact-container .md-preview").waitFor({ state: "visible", timeout: 10000 });
  r.ok(await page.evaluate(() =>
    document.querySelector("#artifact-container .md-preview").scrollHeight > window.innerHeight),
    "fixture is tall enough to scroll");
  r.ok(await page.evaluate(() =>
    document.querySelector("#artifact-container .md-preview").clientWidth < 560),
    "preview is narrower than the 560px rail threshold (P0 surfaces authoritative)");

  // Programmatic selection + SYNTHETIC mouseup (clientX/Y = 0 → exercises the
  // D1 no-coords fallback: FAB from the range's LAST client rect). Start/end
  // may live in different text nodes — that's the point of this module.
  async function makeSelection(startText, endText, startOcc = 0, endOcc = 0) {
    const text = await page.evaluate(({ startText, endText, startOcc, endOcc }) => {
      const preview = document.querySelector("#artifact-container .md-preview");
      const hits = (t) => {
        const out = [];
        const w = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          let i = n.nodeValue.indexOf(t);
          while (i !== -1) { out.push({ node: n, i }); i = n.nodeValue.indexOf(t, i + 1); }
        }
        return out;
      };
      const s = hits(startText)[startOcc];
      const e = hits(endText)[endOcc];
      if (!s || !e) return null;
      const range = document.createRange();
      range.setStart(s.node, s.i);
      range.setEnd(e.node, e.i + endText.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const text = sel.toString();
      preview.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return text;
    }, { startText, endText, startOcc, endOcc });
    if (text === null) throw new Error(`selection anchors not found: "${startText}" … "${endText}"`);
    return text;
  }

  async function addComment(body) {
    await page.locator(".ann-fab").click();
    await page.locator(".ann-pop-body").fill(body);
    await page.locator(".ann-pop-add").click();
    let c = null;
    await until(async () => (c = await byBody(body)));
    if (!c) throw new Error(`comment never appeared over the API: ${body}`);
    return c;
  }

  // Mark census for one comment id, computed in-page (Sets don't serialize).
  const markInfo = (id) => page.evaluate((id) => {
    const marks = [...document.querySelectorAll(`mark.ann-mark[data-ann-id="${CSS.escape(id)}"]`)];
    const blocks = [...document.querySelectorAll("#artifact-container .md-preview h1,h2,h3,p,li,pre,blockquote,td")];
    return {
      count: marks.length,
      joined: marks.map((m) => m.textContent).join(" "),
      blockCount: new Set(marks.map((m) => blocks.indexOf(m.closest("h1,h2,h3,p,li,pre,blockquote,td")))).size,
      anyTitle: marks.some((m) => m.hasAttribute("title")),
      firstPara: marks[0]?.closest("p")?.textContent || "",
    };
  }, id);
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  // ── 1. FAB proximity: cross-block selection (h2 + two paragraphs) ──
  const crossSel = await makeSelection(H2, P2);
  r.ok(crossSel.includes(H2) && crossSel.includes(P1) && crossSel.includes(P2),
    "selection spans the heading and both paragraphs");
  const geo = await page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const rects = sel.getRangeAt(0).getClientRects();
    const fabEl = document.querySelector(".ann-fab");
    if (!rects.length || !fabEl || fabEl.style.display === "none") return null;
    const last = rects[rects.length - 1];
    const fab = fabEl.getBoundingClientRect();
    const cx = fab.left + fab.width / 2, cy = fab.top + fab.height / 2;
    const dx = Math.max(last.left - cx, cx - last.right, 0);
    const dy = Math.max(last.top - cy, cy - last.bottom, 0);
    return {
      dist: Math.hypot(dx, dy),
      inVp: fab.left >= 0 && fab.top >= 0 && fab.right <= innerWidth && fab.bottom <= innerHeight,
    };
  });
  r.ok(geo && geo.dist <= 80, `FAB center within 80px of the selection's LAST client rect (dist=${geo ? geo.dist.toFixed(1) : "n/a"})`);
  r.ok(geo && geo.inVp, "FAB is fully inside the viewport (not clipped at the right edge)");

  // ── 2. cross-block anchor: text anchor, no silent doc degradation ──
  const cross = await addComment("tighten the cross-section summary");
  const crossDisk = onDisk(cross.id);
  r.ok(crossDisk?.anchor?.type === "text", "cross-block selection lands as a TEXT anchor in the sidecar (not doc)");
  r.ok(!crossDisk?.body.startsWith("> "), "body was not quote-degraded (no '> ' prefix)");
  r.ok(await until(async () => (await markInfo(cross.id)).count >= 2), "cross-block marks painted");
  const crossMarks = await markInfo(cross.id);
  r.ok(crossMarks.blockCount >= 2, `marks span ≥2 distinct block elements (got ${crossMarks.blockCount})`);
  r.ok(norm(crossMarks.joined) === norm(crossSel),
    "joined mark text equals the selection (whitespace-normalized)");

  // ── 3. inline formatting: selection crossing a **bold** span ──
  const boldSel = await makeSelection("were ", " across");
  r.ok(norm(boldSel) === BOLD_SEL, `selection crosses the bold span (got: "${boldSel}")`);
  const bold = await addComment("call out ring order explicitly");
  r.ok(onDisk(bold.id)?.anchor?.type === "text", "formatted selection still becomes a TEXT anchor");
  r.ok(await until(async () => (await markInfo(bold.id)).count >= 3),
    "≥3 mark segments painted across the inline formatting");
  r.ok((await markInfo(bold.id)).count >= 3 && norm((await markInfo(bold.id)).joined) === BOLD_SEL,
    "all segments share one data-ann-id and reassemble the selection");

  // ── 4. duplicate honesty: the SECOND identical sentence gets the mark ──
  await makeSelection(DUP, DUP, 1, 1);
  const dup = await addComment("second occurrence needs a footnote");
  r.ok(await until(async () => (await markInfo(dup.id)).count === 1), "duplicate-sentence comment painted exactly one mark");
  const dupMarks = await markInfo(dup.id);
  r.ok(dupMarks.firstPara.includes("Beta context"), "the mark wraps occurrence #2 (Beta paragraph)");
  const alphaClean = await page.evaluate(() => {
    const p = [...document.querySelectorAll("#artifact-container .md-preview p")]
      .find((el) => el.textContent.includes("Alpha context"));
    return p && !p.querySelector("mark.ann-mark");
  });
  r.ok(alphaClean, "occurrence #1 (Alpha paragraph) has no mark — rOrdinal at work");

  // ── 5. overlap: shared piece carries both ids; click → chooser ──
  // (chooser is a P0 floating-card surface — only reachable because the preview
  // is < 560px; at rail width a mark click activates a rail card instead)
  await makeSelection(OV_A, OV_A);
  const ovA = await addComment("cache policy is too aggressive");
  r.ok(await until(async () => (await markInfo(ovA.id)).count >= 1), "first overlap comment painted");
  await makeSelection("artifacts aggressively", "and prunes stale entries");
  const ovB = await addComment("prune cadence deserves a comment");
  const sharedSel = `mark.ann-mark[data-ann-ids~="${ovA.id}"][data-ann-ids~="${ovB.id}"]`;
  r.ok(await until(() => page.locator(sharedSel).count().then((n) => n === 1)),
    "the shared piece carries BOTH ids in data-ann-ids");
  await page.locator(sharedSel).click();
  await page.locator(".ann-card").waitFor({ state: "visible", timeout: 5000 });
  const choices = await page.locator(".ann-card .ann-card-choice").allInnerTexts();
  r.ok(choices.length === 2 &&
    choices.some((t) => t.includes("cache policy is too aggressive")) &&
    choices.some((t) => t.includes("prune cadence deserves a comment")),
    "clicking the shared mark opens a chooser listing both comments");
  await page.keyboard.press("Escape");
  await until(() => page.locator(".ann-card").count().then((n) => n === 0));

  // ── 6. single-node compat: plain unique selection → EXACTLY one mark ──
  await makeSelection(UNIQUE, UNIQUE);
  const uniq = await addComment("needs citations");
  r.ok(await until(async () => (await markInfo(uniq.id)).count === 1) &&
    (await markInfo(uniq.id)).count === 1,
    "plain unique selection yields exactly ONE mark element (M8 contract)");

  // ── 7. hover card: no title attr; hover shows body; pin → edit/save/delete ──
  // (hover card is the P0 narrow-fallback surface — see the viewport note above;
  // the rail equivalents of these interactions are M18 cases 3/5/6)
  const uniqMark = page.locator(`mark.ann-mark[data-ann-id="${uniq.id}"]`);
  r.ok(!(await markInfo(uniq.id)).anyTitle, "marks carry no native title attribute (card replaces it)");
  await uniqMark.hover();
  await page.locator(".ann-card").waitFor({ state: "visible", timeout: 5000 });
  r.ok((await page.locator(".ann-card").innerText()).includes("needs citations"),
    "hovering the mark shows the comment body in the floating card");
  await uniqMark.click(); // pin → draft becomes editable in place
  await page.locator(".ann-card .ann-card-edit").waitFor({ state: "visible", timeout: 5000 });
  const shot = join(screenshotDir(), "m17-annotation-ux.png");
  await page.screenshot({ path: shot });
  console.log(`  📸 ${shot}`);
  await page.locator(".ann-card .ann-card-edit").fill("needs citations (Q3 report)");
  await page.locator(".ann-card .ann-card-save").click();
  r.ok(await until(() => onDisk(uniq.id)?.body === "needs citations (Q3 report)"),
    "in-card Save PATCHes the draft body (sidecar agrees)");
  await uniqMark.click();
  await page.locator(".ann-card .ann-card-del").waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".ann-card .ann-card-del").click();
  r.ok(await until(async () => (await markInfo(uniq.id)).count === 0 && !(await byBody("needs citations (Q3 report)"))),
    "in-card Delete removes the comment and its mark");

  // ── 8. sent read-only: Send the batch → card loses edit affordances ──
  await page.locator(".ann-send").click();
  r.ok(await until(async () => {
    const s = (await list()).summary;
    return s.sent === 5 && s.draft === 0;
  }), "Send: all 5 drafts became sent");
  await page.locator(`mark.ann-mark[data-ann-id="${dup.id}"]`).click();
  await page.locator(".ann-card").waitFor({ state: "visible", timeout: 5000 });
  const sentCard = await page.evaluate(() => {
    const card = document.querySelector(".ann-card");
    return {
      chip: card.querySelector(".ann-chip-sent")?.textContent || "",
      editable: !!card.querySelector("textarea, .ann-card-save, .ann-card-del"),
    };
  });
  r.ok(sentCard.chip.includes("已发送"), "pinned sent card shows the 已发送 chip");
  r.ok(!sentCard.editable, "sent card is read-only (no textarea/Save/Delete)");
  await page.keyboard.press("Escape");
  await until(() => page.locator(".ann-card").count().then((n) => n === 0));

  // ── 9. CLI honesty: `hadron annotations ls` run inside the agent's pane
  // (the CLI self-identifies via tmux; HADRON_PORT/HADRON_TOKEN point it at the
  // throwaway server) reports formatted anchors with an excerpt, never
  // "(original text no longer found)" ──
  const tmuxSession = `hadron-${env.wsName}-${agentId}`;
  const cliOut = join(env.ws, "cli-ls.txt");
  const port = new URL(env.baseUrl).port;
  const cliCmd = `HADRON_PORT=${port} HADRON_TOKEN=${env.token} node ${join(REPO, "bin", "hadron.js")} annotations ls > ${cliOut} 2>&1; echo CLI-DONE >> ${cliOut}`;
  execFileSync("tmux", ["send-keys", "-t", tmuxSession, "-l", cliCmd]);
  execFileSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
  r.ok(await until(() => existsSync(cliOut) && readFileSync(cliOut, "utf-8").includes("CLI-DONE"), 15000),
    "CLI ran to completion inside the agent's tmux pane");
  const cli = existsSync(cliOut) ? readFileSync(cliOut, "utf-8") : "";
  r.ok(cli.includes(`"${BOLD_SEL}" (formatted text)`),
    "formatted anchor's locationText carries the excerpt + (formatted text)");
  r.ok(!cli.includes("original text no longer found"),
    "no comment degraded to '(original text no longer found)'");
  r.ok(/\(line \d+\)/.test(cli), "raw-mappable anchors still report a line number");

  // ── 10. reload survival: rewrite preserving anchors → marks come back ──
  appendFileSync(join(env.ws, "report.md"), "\nAppended coda paragraph: reload survival marker text.\n");
  r.ok(await until(() => page.evaluate(() =>
    document.querySelector("#artifact-container .md-preview")?.textContent.includes("reload survival marker")), 12000),
    "mtime auto-reload re-rendered the preview with the appended paragraph");
  r.ok(await until(async () =>
    (await markInfo(cross.id)).count >= 2 &&
    (await markInfo(bold.id)).count >= 3 &&
    (await markInfo(dup.id)).count === 1, 12000),
    "cross-block, formatted and duplicate marks all re-painted after the reload");
  r.ok((await markInfo(dup.id)).firstPara.includes("Beta context"),
    "duplicate mark still wraps occurrence #2 after the reload");

  // ── 11. stale-context honesty (codex acceptance P1): when the saved context no
  // longer matches anything, a stale rOrdinal must not repoint among DUPLICATES
  // (paint nothing) — but a UNIQUE occurrence can't lie and stays painted. Posted
  // directly with fabricated context to simulate "the neighborhood was edited".
  const postAnchor = (anchor, body) => fetch(annBase, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ path: "report.md", anchor, body }),
  }).then((x) => x.json());
  const staleDup = await postAnchor(
    { type: "text", exact: DUP, rPrefix: "context that no longer exists", rSuffix: "also gone from the doc", rOrdinal: 1 },
    "stale-context duplicate probe");
  const staleUnique = await postAnchor(
    { type: "text", exact: UNIQUE, rPrefix: "context that no longer exists", rSuffix: "also gone from the doc", rOrdinal: 0 },
    "stale-context unique probe");
  r.ok(await until(async () => (await markInfo(staleUnique.comment.id)).count === 1, 10000),
    "unique occurrence stays painted despite a stale context (can't point wrong)");
  r.ok((await markInfo(staleDup.comment.id)).count === 0,
    "duplicate with stale context paints NOTHING (stale rOrdinal must not repoint)");
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
