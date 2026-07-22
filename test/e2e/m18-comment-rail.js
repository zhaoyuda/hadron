/**
 * Module M18 — Comment rail (comment-rail-spec.md, P1).
 *
 * The GDocs-style margin rail: every comment on the current file is PERMANENTLY
 * visible as a card in a right-hand column inside the preview — the fix for the
 * P0 acceptance failure ("我创建评论之后没有看到内容": content existed but both
 * P0 surfaces were on-demand). Covers: rail mounts at wide previews and shows
 * card bodies with zero interaction; the composer card creation flow (rendered
 * anchor fields intact); two-way mark↔card linking (activate + exact alignment,
 * scroll + flash); in-rail edit/delete of drafts; the orphan section; the pure
 * layout keeping far-apart cards ordered and non-overlapping; the <560px
 * fallback to the P0 hover card; the annRailBusy guard protecting an open edit
 * from poll repaints; and doc comments in the top section.
 *
 * Post-acceptance additions: R5 epoch staleness through the rail composer (the
 * preview rebuilds mid-compose → at-Add re-derivation); live edit cards
 * surviving preview REBUILDS in every section (anchored, doc, orphan — the
 * P1 re-insert fix); the narrow-width flip mid-edit (edit UI hides, typed text
 * restored on remount); and the floating bar clearing the rail column.
 *
 * Run: node test/e2e/m18-comment-rail.js
 */
import { chromium } from "playwright";
import { writeFileSync, appendFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { bootWorkspace, reporter, screenshotDir, authHeaders } from "./harness.js";

const r = reporter("M18 Comment rail");
const env = await bootWorkspace({ name: "m18" });
let browser;

// ── fixture: distinct sentences near the top, ~55 filler paragraphs so the two
// case-8 anchors sit ≥2000px apart, and a unique closer at the bottom ──
const P1 = "The pipeline overview paragraph sets the scene for reviewers.";
const P2 = "Latency dropped sharply once the cache layer landed.";
const FAR = "The closing summary paragraph needs a decision from the team.";
const filler = Array.from({ length: 55 }, (_, i) =>
  `Operational log entry ${i + 1}: routine deploy telemetry recorded without incident during the overnight window.`);
const md = [
  "# Rail fixture report",
  "",
  "## Section one",
  "",
  P1,
  "",
  P2,
  "",
  ...filler.flatMap((f) => [f, ""]),
  FAR,
  "",
].join("\n");

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(150); }
  return fn();
}

try {
  // ── script: fixture + agent with a live tmux session ──
  writeFileSync(join(env.ws, "report.md"), md);
  const created = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authHeaders(env.token),
    body: JSON.stringify({
      name: "Rail Demo", group: "Demo", launchCommand: "shell",
      artifacts: [{ type: "file", value: "report.md" }],
    }),
  });
  r.ok(created.status === 201, "agent created via HTTP API with a markdown artifact");
  const agentId = (await created.json()).id;

  const annBase = `${env.baseUrl}/api/sessions/${agentId}/annotations`;
  const list = () => fetch(annBase).then((x) => x.json());
  const byBody = async (b) => (await list()).comments.find((c) => c.body === b);
  const postAnchor = (anchor, body) => fetch(annBase, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ path: "report.md", anchor, body }),
  }).then((x) => x.json()).then((j) => j.comment);
  const sidecars = () => {
    const dir = join(env.ws, ".hadron", "annotations", agentId);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json"); } catch {}
    return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
  };
  const onDisk = (id) => sidecars().flatMap((s) => s.comments).find((c) => c.id === id);

  // ── browser: wide viewport (preview ≈1117px ≥ 560 → rail regime, R1) ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="${agentId}"]`).click();
  await page.locator('.af[data-art-idx]', { hasText: "report.md" }).click();
  await page.locator("#artifact-container .md-preview").waitFor({ state: "visible", timeout: 10000 });
  r.ok(await page.evaluate(() =>
    document.querySelector("#artifact-container .md-preview").clientWidth >= 560),
    "preview is wide enough for the rail (≥560px)");

  const card = (id) => page.locator(`.ann-rail-card[data-rail-id="${id}"]`);
  const mark = (id) => page.locator(`mark.ann-mark[data-ann-ids~="${id}"]`).first();
  const shot = (name) => page.screenshot({ path: join(screenshotDir(), `m18-${name}.png`) }).then(
    (p) => console.log(`  📸 ${join(screenshotDir(), `m18-${name}.png`)}`));

  // Programmatic selection + synthetic mouseup (same helper as M17).
  async function makeSelection(startText, endText) {
    const found = await page.evaluate(({ startText, endText }) => {
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
      const s = hits(startText)[0];
      const e = hits(endText)[0];
      if (!s || !e) return false;
      const range = document.createRange();
      range.setStart(s.node, s.i);
      range.setEnd(e.node, e.i + endText.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      preview.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }, { startText, endText });
    if (!found) throw new Error(`selection anchors not found: "${startText}" … "${endText}"`);
  }

  // Append to the artifact on disk → mtime poller rebuilds the preview (the
  // same mechanism as an agent write). Waits until the marker text renders.
  let rebuildN = 0;
  async function rebuildPreview() {
    const marker = `Rebuild marker paragraph ${++rebuildN}.`;
    appendFileSync(join(env.ws, "report.md"), `\n${marker}\n`);
    const ok = await until(() => page.evaluate((t) =>
      document.querySelector("#artifact-container .md-preview")?.textContent.includes(t), marker), 15000);
    if (!ok) throw new Error("preview did not rebuild after the mtime bump");
  }

  // ── 1. THE acceptance criterion: comment exists → rail card shows the body
  // with zero interaction (no hover, no drawer) ──
  const cA = await postAnchor({ type: "text", exact: P1 }, "tighten the overview");
  // (.ann-rail itself is a zero-height absolute column — wait on the card)
  await card(cA.id).waitFor({ state: "visible", timeout: 8000 });
  r.ok((await page.locator(".ann-rail").count()) === 1, "rail column mounted inside the preview");
  r.ok((await card(cA.id).innerText()).includes("tighten the overview"),
    "rail card shows the comment BODY without any hover");
  // The floating bar (Send pill) must sit clear of the rail column, not under it.
  r.ok(await until(() => page.evaluate(() => {
    const bar = document.querySelector(".ann-bar");
    const rail = document.querySelector(".ann-rail");
    if (!bar || !rail) return false;
    return bar.getBoundingClientRect().right <= rail.getBoundingClientRect().left;
  })), "floating bar is shifted left of the rail column (no overlap)");
  await shot("01-rail-visible");

  // ── 2. creation through the rail: FAB → composer card → Add → real card ──
  await makeSelection(P2, P2);
  await page.locator(".ann-fab").click();
  await page.locator(".ann-rail-composer").waitFor({ state: "visible", timeout: 5000 });
  r.ok((await page.locator(".ann-rail-composer .ann-pop-quote").innerText()).includes("Latency dropped"),
    "composer card carries the quote preview line (honesty rules intact)");
  await page.locator(".ann-rail-composer .ann-pop-body").fill("cache latency comment");
  await shot("02-composer");
  await page.locator(".ann-rail-composer .ann-pop-add").click();
  let cB = null;
  r.ok(await until(async () => (cB = await byBody("cache latency comment"))), "comment landed over the API");
  await card(cB.id).waitFor({ state: "visible", timeout: 8000 });
  r.ok((await card(cB.id).innerText()).includes("cache latency comment"),
    "real card with content visible right after Add");
  const diskB = onDisk(cB.id);
  r.ok(diskB?.anchor?.type === "text" && typeof diskB.anchor.rOrdinal === "number",
    "sidecar anchor is type:text with rendered fields (rOrdinal present)");

  // ── 2b. R5 epoch staleness through the rail composer: the preview rebuilds
  // while the composer is open (agent write → mtime reload) → the composer
  // survives with the typed text, and Add re-derives the anchor against the
  // CURRENT DOM — unique text gets fresh rendered fields, never a stale
  // context posted blind ──
  const FILL3 = "Operational log entry 3: routine deploy telemetry recorded without incident during the overnight window.";
  await makeSelection(FILL3, FILL3);
  await page.locator(".ann-fab").click();
  await page.locator(".ann-rail-composer").waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".ann-rail-composer .ann-pop-body").fill("typed before the rebuild");
  await rebuildPreview();
  r.ok(await until(() => page.evaluate(() => {
    const ta = document.querySelector(".ann-rail-composer .ann-pop-body");
    return !!ta && ta.value === "typed before the rebuild";
  })), "composer card survives the preview rebuild with the typed text intact");
  await page.locator(".ann-rail-composer .ann-pop-add").click();
  let cStale = null;
  r.ok(await until(async () => (cStale = await byBody("typed before the rebuild"))),
    "stale-epoch Add still lands the comment");
  const diskStale = onDisk(cStale.id);
  r.ok(diskStale?.anchor?.type === "text" && diskStale.anchor.rOrdinal === 0 &&
    !diskStale.body.startsWith("> "),
    "at-Add re-derivation produced FRESH rendered fields for the still-unique text (no quote degradation)");
  await card(cStale.id).waitFor({ state: "visible", timeout: 8000 });
  await card(cStale.id).locator(".ann-rail-del").click(); // keep later geometry cases clean
  r.ok(await until(async () => (await card(cStale.id).count()) === 0), "probe comment cleaned up");

  // ── 3. click mark → card ACTIVE + exact alignment (±4px, R3/R4) ──
  await mark(cA.id).click();
  r.ok(await until(() => page.evaluate((id) => {
    const m = document.querySelector(`mark.ann-mark[data-ann-ids~="${CSS.escape(id)}"]`);
    const c = document.querySelector(`.ann-rail-card[data-rail-id="${CSS.escape(id)}"]`);
    return m && c && c.classList.contains("active") &&
      Math.abs(m.getBoundingClientRect().top - c.getBoundingClientRect().top) <= 4;
  }, cA.id)), "mark click: card .active and exactly aligned with the mark (±4px)");
  await shot("03-active-aligned");

  // ── 4. click card → mark scrolled into view + flash (R4) ──
  await card(cB.id).click();
  r.ok(await until(() => page.evaluate((id) => {
    const m = document.querySelector(`mark.ann-mark[data-ann-ids~="${CSS.escape(id)}"]`);
    if (!m || !m.classList.contains("ann-mark-flash")) return false;
    const b = m.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight;
  }, cB.id)), "card click: mark in view and carrying the flash class");
  await shot("04-card-click-flash");

  // ── 5. edit in place: ✎ → textarea → Save → PATCH persisted (R6) ──
  await card(cB.id).locator(".ann-rail-edit").click();
  const editbox = card(cB.id).locator(".ann-rail-editbox");
  await editbox.waitFor({ state: "visible", timeout: 5000 });
  await editbox.fill("cache latency comment (v2)");
  await shot("05-edit-mode");
  await card(cB.id).locator(".ann-card-save").click();
  r.ok(await until(() => onDisk(cB.id)?.body === "cache latency comment (v2)"),
    "rail Save PATCHes the draft body (sidecar agrees)");
  r.ok(await until(async () => (await card(cB.id).innerText()).includes("(v2)")),
    "card shows the updated body");

  // ── 6. delete in rail → card and mark both gone ──
  await card(cB.id).locator(".ann-rail-del").click();
  r.ok(await until(async () =>
    (await card(cB.id).count()) === 0 &&
    (await page.locator(`mark.ann-mark[data-ann-ids~="${cB.id}"]`).count()) === 0),
    "rail × removes both the card and the mark");
  await shot("06-deleted");

  // ── 7. orphan: unfindable anchor → ⚠ 无法定位 section with locationText (R2) ──
  const cO = await postAnchor({ type: "text", exact: "phantom sentence that never existed" }, "orphan probe");
  r.ok(await until(() => page.locator(".ann-rail-orphsec").count().then((n) => n === 1)),
    "orphan section appears for the unlocatable comment");
  const orphText = await page.locator(".ann-rail-orphsec").innerText();
  r.ok(orphText.includes("无法定位") && orphText.includes("original text no longer found") &&
    orphText.includes("orphan probe"),
    "orphan card shows locationText (no highlight to point at) plus the body");
  await shot("07-orphan");

  // ── 8. far-apart anchors: order kept, no overlap (pure layout end-to-end) ──
  const cFar = await postAnchor({ type: "text", exact: FAR }, "closing decision needed");
  await card(cFar.id).waitFor({ state: "visible", timeout: 8000 });
  const geo = await page.evaluate(({ a, b }) => {
    const q = (s) => document.querySelector(s);
    const ca = q(`.ann-rail-card[data-rail-id="${CSS.escape(a)}"]`);
    const cb = q(`.ann-rail-card[data-rail-id="${CSS.escape(b)}"]`);
    const ma = q(`mark.ann-mark[data-ann-ids~="${CSS.escape(a)}"]`);
    const mb = q(`mark.ann-mark[data-ann-ids~="${CSS.escape(b)}"]`);
    return {
      anchorSep: mb.getBoundingClientRect().top - ma.getBoundingClientRect().top,
      topA: ca.offsetTop, botA: ca.offsetTop + ca.offsetHeight, topB: cb.offsetTop,
    };
  }, { a: cA.id, b: cFar.id });
  r.ok(geo.anchorSep >= 2000, `anchors are ≥2000px apart (got ${Math.round(geo.anchorSep)})`);
  r.ok(geo.topA < geo.topB && geo.botA <= geo.topB,
    "cards keep anchor order and do not overlap");

  // ── 9. narrow fallback: <560px unmounts the rail; P0 hover card works (R1) ──
  await page.setViewportSize({ width: 600, height: 900 });
  r.ok(await until(() => page.locator(".ann-rail").count().then((n) => n === 0)),
    "rail unmounts below the 560px preview threshold");
  await mark(cA.id).hover();
  await page.locator(".ann-card").waitFor({ state: "visible", timeout: 5000 });
  r.ok((await page.locator(".ann-card").innerText()).includes("tighten the overview"),
    "P0 floating hover card takes over at narrow width");
  await shot("09-narrow-fallback");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1400, height: 900 });
  r.ok(await until(() => page.locator(".ann-rail").count().then((n) => n === 1)),
    "rail remounts when the preview is wide again (no state lost)");

  // ── 10. annRailBusy: an open edit survives poll repaints; data applies after ──
  await card(cA.id).locator(".ann-rail-edit").click();
  const busyBox = card(cA.id).locator(".ann-rail-editbox");
  await busyBox.waitFor({ state: "visible", timeout: 5000 });
  await busyBox.fill("half-typed edit survives");
  const cNew = await postAnchor({ type: "text", exact: P2 }, "posted while busy");
  await wait(4000); // > one 3s poll cycle — annData updates, rail DOM must not
  r.ok((await busyBox.count()) === 1 && (await busyBox.inputValue()) === "half-typed edit survives",
    "edit textarea and typed draft survive the poll repaint (annRailBusy)");
  r.ok((await card(cNew.id).count()) === 0,
    "the mid-edit comment's card is deferred while the rail is busy");
  await shot("10-busy-edit");
  await card(cA.id).locator(".ann-card-cancel").click();
  r.ok(await until(() => card(cNew.id).count().then((n) => n === 1)),
    "closing the edit applies the deferred data — the new card appears");

  // ── 11. doc comment renders in the top section (R2) ──
  // Doc cards are layout items pinned to the rail top (anchorY = floor), fed
  // first — so "top section" now means: carries the doc marker class AND sits
  // above every other card.
  const cDoc = await postAnchor({ type: "doc" }, "whole-doc note");
  r.ok(await until(() =>
    page.locator(`.ann-rail-card.ann-rail-doc[data-rail-id="${cDoc.id}"]`).count().then((n) => n === 1)),
    "doc comment's card renders with the doc marker at the rail top");
  r.ok(await page.evaluate((id) => {
    const doc = document.querySelector(`.ann-rail-card[data-rail-id="${CSS.escape(id)}"]`);
    const others = [...document.querySelectorAll(".ann-rail > .ann-rail-card")].filter((el) => el !== doc);
    // at the layout floor (36px clears the md-toggle overlay) and above all others
    return doc.offsetTop >= 30 && doc.offsetTop <= 60 && others.every((el) => el.offsetTop > doc.offsetTop);
  }, cDoc.id), "doc card is the topmost card, sitting at the layout floor (clear of the toggle chrome)");
  await shot("11-doc-section");

  // ── 12. live edit survives a preview REBUILD in every section (the P1
  // re-insert fix): the mtime reload destroys the rail wholesale; the re-mount
  // must re-insert the SAME edit element — anchored, doc, and orphan alike ──
  const editRebuildCase = async (id, label) => {
    await card(id).locator(".ann-rail-edit").click();
    const box = card(id).locator(".ann-rail-editbox");
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.fill(`unsaved ${label} edit`);
    await rebuildPreview();
    const alive = await until(async () =>
      (await box.count()) === 1 && (await box.inputValue()) === `unsaved ${label} edit`);
    r.ok(alive, `${label} edit card survives a preview rebuild with the typed text`);
    await card(id).locator(".ann-card-cancel").click();
    await until(async () => (await card(id).locator(".ann-rail-editbox").count()) === 0);
  };
  await editRebuildCase(cNew.id, "anchored");
  await editRebuildCase(cDoc.id, "doc-level");
  await editRebuildCase(cO.id, "orphan");
  await shot("12-edit-rebuilds");

  // ── 13. narrow flip while editing: chosen behavior (documented in
  // annRailUnmount) — the edit UI unmounts with the rail (P0 surfaces take
  // over below 560px) but the element + typed text are RETAINED and restored
  // when the rail remounts; nothing is silently lost ──
  await card(cNew.id).locator(".ann-rail-edit").click();
  const flipBox = card(cNew.id).locator(".ann-rail-editbox");
  await flipBox.waitFor({ state: "visible", timeout: 5000 });
  await flipBox.fill("typed across the width flip");
  await page.setViewportSize({ width: 600, height: 900 });
  r.ok(await until(() => page.locator(".ann-rail").count().then((n) => n === 0)),
    "rail (with the open edit) unmounts below 560px");
  await page.setViewportSize({ width: 1400, height: 900 });
  r.ok(await until(async () =>
    (await flipBox.count()) === 1 && (await flipBox.inputValue()) === "typed across the width flip"),
    "remount restores the live edit card with the typed text (no silent loss)");
  await card(cNew.id).locator(".ann-card-cancel").click();
  await shot("13-width-flip-edit");

  // ── 14. stale async cleanup is owner-scoped (codex round-2 P1): a Save whose
  // PATCH settles late must NOT clear a newer edit's live state. Delay the
  // PATCH, supersede the edit mid-flight, then let it settle ──
  await page.route("**/annotations/**", async (route) => {
    if (route.request().method() === "PATCH") {
      await wait(1200); // hold the completion until a newer owner exists
    }
    await route.continue();
  });
  await card(cNew.id).locator(".ann-rail-edit").click();
  const staleBox = card(cNew.id).locator(".ann-rail-editbox");
  await staleBox.waitFor({ state: "visible", timeout: 5000 });
  await staleBox.fill("slow save");
  await card(cNew.id).locator(".ann-card-save").click(); // PATCH now in flight
  await card(cDoc.id).locator(".ann-rail-edit").click(); // newer owner
  const raceBox = card(cDoc.id).locator(".ann-rail-editbox");
  await raceBox.waitFor({ state: "visible", timeout: 5000 });
  await raceBox.fill("newer edit must survive");
  await wait(2000); // stale PATCH settles; its done() must no-op
  r.ok(await raceBox.count() === 1 && (await raceBox.inputValue()) === "newer edit must survive",
    "a stale Save completion does not clear the newer edit's live state");
  r.ok(await until(async () =>
    (await list()).comments.find((x) => x.id === cNew.id)?.body === "slow save"),
    "the slow PATCH itself still persisted its body");
  await card(cDoc.id).locator(".ann-card-cancel").click();
  await page.unroute("**/annotations/**");
  await shot("14-stale-cleanup-race");

  // ── 15. SPLIT LAYOUT: the whole annotation system must work in vsplit — the
  // context hole (split forces activeTab="terminal" → annCtx never set) is the
  // bug the user hit for two days: creation worked, nothing ever painted ──
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.evaluate(() => cycleLayout()); // tabs → vsplit
  r.ok(await until(() => page.evaluate(() =>
    document.querySelectorAll(".split-pane mark.ann-mark").length > 0), 10000),
    "marks paint inside the split pane (annCtx derived from open md tab)");
  r.ok(await until(() => page.locator(".split-pane .ann-bar").count().then((n) => n === 1)),
    "floating bar renders in the split pane");
  const splitRail = await until(() => page.evaluate(() => {
    const rail = document.querySelector(".split-pane .ann-rail");
    const preview = document.querySelector(".split-pane .md-preview");
    const host = preview?.closest("[data-md-path]");
    if (!rail || !preview || !host) return false;
    // Exact adaptive formula (a fixed 190px or 260px must FAIL this):
    const expected = Math.max(190, Math.min(260, Math.round(preview.clientWidth * 0.30)));
    const w = rail.getBoundingClientRect().width;
    const varPreview = preview.style.getPropertyValue("--ann-rail-w");
    const varHost = host.style.getPropertyValue("--ann-rail-w");
    return preview.clientWidth >= 560 && Math.abs(w - expected) <= 1 &&
      varPreview === `${expected}px` && varHost === `${expected}px`;
  }), 10000);
  r.ok(splitRail, "rail width matches clamp(190, 30% of preview, 260) and both CSS vars agree");
  r.ok(await until(async () =>
    (await page.locator(".split-pane .ann-rail-card").count()) > 0 &&
    (await page.locator(".split-pane .ann-rail-card").first().innerText()).length > 0),
    "rail cards with bodies are visible in the split pane");
  await shot("15-split-mode");
  // ── 16. multi-md split with the FIRST md pane in edit mode: context must
  // prefer the pane with a visible PREVIEW (tab order alone bound annCtx to the
  // edit-mode pane and left the sibling unannotated — codex delta P1) ──
  writeFileSync(join(env.ws, "notes.md"), "A second markdown artifact for split preference.\n");
  await fetch(`${env.baseUrl}/api/sessions/${agentId}/artifacts`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ type: "file", value: "notes.md" }),
  });
  const cNotes = await fetch(annBase, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ path: "notes.md", anchor: { type: "text", exact: "second markdown artifact" }, body: "note on the sibling pane" }),
  }).then((x) => x.json()).then((j) => j.comment);
  // Open notes.md as a second tab (report.md tab is already open and FIRST).
  // NOTE: still in vsplit from case 15 — the .af click opens the tab as a pane.
  await page.locator('.af[data-art-idx]', { hasText: "notes.md" }).click();
  // Both previews render; the context binds report.md (first tab, visible
  // preview). Now flip report.md's pane to EDIT mode.
  await until(() => page.evaluate(() =>
    document.querySelectorAll(".split-pane .md-preview").length === 2), 10000);
  await page.evaluate(() => {
    const host = [...document.querySelectorAll(".split-pane[data-md-path]")]
      .find((el) => el.dataset.mdPath.endsWith("report.md"));
    host.querySelector(".md-toggle").click();
  });
  // Within one 3s poll the context must re-derive to notes.md and paint there.
  r.ok(await until(() => page.evaluate((id) => {
    const host = [...document.querySelectorAll(".split-pane[data-md-path]")]
      .find((el) => el.dataset.mdPath.endsWith("notes.md"));
    return !!host?.querySelector(`mark.ann-mark[data-ann-ids~="${id}"]`);
  }, cNotes.id), 12000),
    "edit-mode first pane → context re-derives to the sibling preview and paints its mark");
  // Inverse transition (codex round-5): toggling report.md BACK to preview must
  // fire the renderPreview hook and re-bind to it (first tab, visible again).
  await page.evaluate(() => {
    const host = [...document.querySelectorAll(".split-pane[data-md-path]")]
      .find((el) => el.dataset.mdPath.endsWith("report.md"));
    host.querySelector(".md-toggle").click();
  });
  r.ok(await until(() => page.evaluate(() => {
    const host = [...document.querySelectorAll(".split-pane[data-md-path]")]
      .find((el) => el.dataset.mdPath.endsWith("report.md"));
    return host?.dataset.mdMode === "preview" && host.querySelectorAll("mark.ann-mark").length > 0;
  }), 12000),
    "edit→preview toggle re-binds the context back to the first pane and repaints");
  await shot("16-multi-md-edit-preference");
  // Deterministic return to tabs: cycle until the split classes are gone
  // (blind cycle counts already bit us once — layoutMode is a `let`, invisible
  // to page.evaluate, so detect via the #ws-content class instead).
  await until(async () => {
    const cls = await page.evaluate(() => document.querySelector("#ws-content").className);
    if (!/ws-(v|h)split/.test(cls)) return true;
    await page.evaluate(() => cycleLayout());
    return false;
  }, 10000);
  await page.setViewportSize({ width: 1400, height: 900 });
  // Back in tabs mode activeTab is "terminal" (split forced it) — the md isn't
  // on screen, so no rail is CORRECT until the artifact tab is re-activated.
  // (report.md's cached container is still in EDIT mode from case 16 — restore.)
  await page.locator('.af[data-art-idx]', { hasText: "report.md" }).click();
  await until(() => page.evaluate(() => {  // container renders async; restore preview mode
    // In tabs mode data-md-path sits ON #artifact-container itself, not a child.
    const host = document.querySelector('#artifact-container[data-md-path], #artifact-container [data-md-path]');
    if (!host) return false;
    if (host.dataset.mdMode !== "preview") { host.querySelector(".md-toggle")?.click(); return false; }
    return true;
  }), 10000);
  r.ok(await until(() => page.locator("#artifact-container .ann-rail").count().then((n) => n === 1)),
    "re-activating the artifact tab brings the rail back in tabs mode");

  r.ok(pageErrors.length === 0, `zero pageerrors (got: ${pageErrors.join(" | ") || "none"})`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
