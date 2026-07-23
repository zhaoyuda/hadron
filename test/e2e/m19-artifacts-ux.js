/**
 * Module M19 — Artifacts add/remove UX rework (design-notes/artifacts-ux-spec.md).
 *
 * The reported bug: clicking a folder in the add-artifact popover's Browse tab
 * CLOSED the popover (dir click rebuilt the list via innerHTML, detaching the
 * clicked node before the document-level click listener ran → treated as an
 * outside click). Fix: capture-phase pointerdown decides "outside" from where the
 * gesture STARTED. Around it, the spec's whole surface: hidden-files toggle,
 * keyboard nav, atomic add (canonical de-dupe), URL validation + escaping, atomic
 * remove with 409 recovery, dir artifacts (live folder groups — new files appear
 * without re-adding), ephemeral `file:` tabs, add-concurrency, viewport clamping.
 *
 * Run: node test/e2e/m19-artifacts-ux.js
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M19 Artifacts UX");
const env = await bootWorkspace({ name: "m19" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(150); }
  return fn();
}

try {
  // ── fixtures ──
  mkdirSync(join(env.ws, "docs", "deep"), { recursive: true });
  writeFileSync(join(env.ws, "docs", "guide.md"), "# guide");
  writeFileSync(join(env.ws, "docs", "deep", "notes.md"), "# deep notes");
  writeFileSync(join(env.ws, "notes4.md"), "# notes4");
  writeFileSync(join(env.ws, "plain.md"), "# plain");
  writeFileSync(join(env.ws, ".hidden-fixture.md"), "# shh");
  mkdirSync(join(env.ws, ".git"), { recursive: true });
  mkdirSync(join(env.ws, "folder-live"), { recursive: true });
  writeFileSync(join(env.ws, "folder-live", "seed.md"), "# seed");
  const created = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name: "m19", launchCommand: "shell" }),
  });
  r.ok(created.status === 201, "agent created");

  const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, {
    method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const serverArts = async () =>
    (await (await fetch(`${env.baseUrl}/api/sessions`)).json()).find((s) => s.id === "m19").artifacts;

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('.dk[data-sid="m19"]').click();
  await page.locator("#af-add-btn").waitFor({ state: "visible", timeout: 5000 });

  const pop = page.locator("#add-popover");
  const rows = page.locator("#art-browse-list .art-browse-item");
  const rowNamed = (name) => page.locator("#art-browse-list .art-browse-item", { hasText: name });
  const shot = (name) => page.screenshot({ path: join(screenshotDir(), `m19-${name}.png`) });

  async function openBrowse() {
    await page.locator("#af-add-btn").click();
    await pop.waitFor({ state: "visible", timeout: 3000 });
    await page.locator('.add-pop-tab[data-tab="browse"]').click();
    await page.locator("#art-browse-list .art-browse-item, #art-browse-list .art-suggest-empty")
      .first().waitFor({ timeout: 5000 });
  }

  // ── 1. Browse navigation: the popover STAYS OPEN (the reported bug) ──
  await openBrowse();
  await rowNamed("docs").first().click();
  r.ok(await pop.count() === 1, "descending into a folder keeps the popover open (the reported bug)");
  await until(() => rowNamed("guide.md").count().then((c) => c > 0));
  r.ok(await rowNamed("guide.md").count() > 0, "first level listed (guide.md visible)");
  await rowNamed("deep").first().click();
  await until(() => rowNamed("notes.md").count().then((c) => c > 0));
  r.ok(await pop.count() === 1 && await rowNamed("notes.md").count() > 0, "second level listed, popover still open");
  await shot("browse");
  await page.locator('.art-browse-crumb-seg[data-path="docs"]').click();
  await until(() => rowNamed("guide.md").count().then((c) => c > 0));
  r.ok(await rowNamed("deep").count() > 0, "breadcrumb click ascends to docs/");
  await page.locator("#art-browse-list .art-browse-item").first().click(); // ".." row
  await until(() => rowNamed("notes4.md").count().then((c) => c > 0));
  r.ok(await rowNamed("docs").count() > 0, "\"..\" ascends to the workspace root");
  await page.keyboard.press("Escape");
  r.ok(await pop.count() === 0, "Escape closes the popover");
  r.ok(await page.evaluate(() => document.activeElement && document.activeElement.id === "af-add-btn"),
    "focus returns to the + add button on dismissal");

  // ── 2. Hidden files toggle + persistence ──
  await openBrowse();
  r.ok(await rowNamed(".hidden-fixture.md").count() === 0, "dotfile invisible by default");
  await page.locator("#art-hidden-toggle").click();
  await until(() => rowNamed(".hidden-fixture.md").count().then((c) => c > 0));
  r.ok(await rowNamed(".hidden-fixture.md").count() > 0, "checkbox reveals dotfiles");
  r.ok(await rowNamed(".git").count() === 0, ".git never visible even with hidden on");
  await page.keyboard.press("Escape");
  await openBrowse();
  r.ok(await page.locator("#art-hidden-toggle").isChecked(), "hidden preference persists across popover reopen");
  await until(() => rowNamed(".hidden-fixture.md").count().then((c) => c > 0));
  r.ok(await rowNamed(".hidden-fixture.md").count() > 0, "reopened Browse honors the persisted preference");
  await page.locator("#art-hidden-toggle").click(); // back off for later cases
  await page.keyboard.press("Escape");

  // ── 3. Keyboard: arrows + Enter descend and add, no mouse on the list ──
  await openBrowse();
  r.ok(await page.evaluate(() => document.activeElement && document.activeElement.id === "art-browse-list"),
    "browse list takes focus when the tab activates");
  await page.keyboard.press("ArrowDown"); // → docs (first dir)
  r.ok(await page.locator("#art-browse-list .art-browse-item.kb-active", { hasText: "docs" }).count() === 1,
    "ArrowDown highlights the first row (docs)");
  await page.keyboard.press("Enter"); // descend into docs
  await until(() => rowNamed("guide.md").count().then((c) => c > 0));
  await page.keyboard.press("ArrowDown"); // ..
  await page.keyboard.press("ArrowDown"); // deep
  await page.keyboard.press("ArrowDown"); // guide.md
  await page.keyboard.press("Enter"); // add it
  await until(async () => (await serverArts()).some((a) => a.value.endsWith("/docs/guide.md")));
  r.ok((await serverArts()).some((a) => a.value.endsWith("/docs/guide.md")), "Enter on a file adds it (keyboard only)");
  r.ok(await pop.count() === 0, "adding closes the popover");
  await until(() => page.locator(".wh-tab", { hasText: "guide.md" }).count().then((c) => c > 0));
  r.ok(await page.locator(".wh-tab", { hasText: "guide.md" }).count() > 0, "added file's tab opens");

  // ── 4. Add via Browse click; same file in another path form de-dupes ──
  await openBrowse();
  await rowNamed("notes4.md").first().click();
  await until(async () => (await serverArts()).some((a) => a.value.endsWith("/notes4.md")));
  r.ok((await serverArts()).some((a) => a.value.endsWith("/notes4.md")), "click on a Browse file adds it");
  const lenBefore = (await serverArts()).length;
  await page.evaluate(async (abs) => { await addArtifact("file", abs); }, join(env.ws, "notes4.md"));
  await wait(300);
  r.ok((await serverArts()).length === lenBefore, "re-add under the absolute path form de-dupes (no second row)");
  await openBrowse();
  await page.locator('.add-pop-tab[data-tab="suggest"]').click();
  await until(() => page.locator("#art-suggest-list .art-suggest-item, #art-suggest-list .art-suggest-empty").count().then((c) => c > 0));
  r.ok(await page.locator("#art-suggest-list .art-suggest-item", { hasText: "notes4.md" }).count() === 0,
    "Suggested no longer offers the already-added file (canonical de-dupe)");
  await page.keyboard.press("Escape");

  // ── 5. URL tab: garbage rejected inline; labels render as text ──
  const evilLabel = '<img src=x onerror=alert(1)>evil label';
  await page.locator("#af-add-btn").click();
  await pop.waitFor({ state: "visible" });
  await page.locator('.add-pop-tab[data-tab="url"]').click();
  await page.locator("#art-url-input").fill("not a url");
  await page.keyboard.press("Enter");
  r.ok(await pop.count() === 1, "garbage URL keeps the popover open");
  r.ok((await page.locator("#art-url-error").textContent()).length > 0, "inline error shown for garbage URL");
  r.ok(!(await serverArts()).some((a) => a.type === "url"), "no artifact created for garbage URL");
  await page.locator("#art-url-input").fill("https://example.com/page");
  await page.locator("#art-url-label").fill(evilLabel);
  await page.locator("#art-url-input").press("Enter");
  await until(async () => (await serverArts()).some((a) => a.type === "url"));
  r.ok((await serverArts()).some((a) => a.type === "url" && a.value === "https://example.com/page"), "valid https URL added");
  await until(() => page.locator("#right .af-label", { hasText: "evil label" }).count().then((c) => c > 0));
  const sidebarLabel = page.locator("#right .af-label", { hasText: "evil label" }).first();
  r.ok((await sidebarLabel.textContent()).trim() === evilLabel, "sidebar renders the HTML-metachar label as text");
  r.ok(await sidebarLabel.locator("img").count() === 0, "no element injected from the label (sidebar)");
  const tabLabel = page.locator(".wh-tab-label", { hasText: "evil label" }).first();
  r.ok((await tabLabel.textContent()).trim() === evilLabel && await tabLabel.locator("img").count() === 0,
    "tab label renders as text too");

  // ── 6. Remove: row + open tab go; stale remove → 409 → client recovers ──
  const notesRow = page.locator('#right .af[data-art-idx]', { hasText: "notes4.md" });
  await notesRow.locator(".af-rm").click();
  await until(async () => !(await serverArts()).some((a) => a.value.endsWith("/notes4.md")));
  r.ok(!(await serverArts()).some((a) => a.value.endsWith("/notes4.md")), "× removes the artifact server-side");
  await until(() => page.locator('#right .af[data-art-idx]', { hasText: "notes4.md" }).count().then((c) => c === 0));
  r.ok(await page.locator('#right .af[data-art-idx]', { hasText: "notes4.md" }).count() === 0, "row disappears");
  r.ok(await page.locator(".wh-tab", { hasText: "notes4.md" }).count() === 0, "its open tab closes");
  {
    // Drift the server (delete guide.md, append drift.md), then fire a remove from a
    // deliberately stale client array — the 409 path must refetch and re-render.
    writeFileSync(join(env.ws, "drift.md"), "# drift");
    const snap = await page.evaluate(() => {
      const s = sessions.find((x) => x.id === activeSessionId);
      return {
        arts: s.artifacts.map((a) => ({ ...a })),
        idx: s.artifacts.findIndex((a) => a.value.endsWith("/docs/guide.md")),
      };
    });
    r.ok(snap.idx >= 0, "stale snapshot still holds guide.md");
    let dr = await api("DELETE", "/api/sessions/m19/artifacts", { index: snap.idx, value: join(env.ws, "docs", "guide.md") });
    r.ok(dr.status === 200, "server-side drift: guide.md deleted via API");
    await api("POST", "/api/sessions/m19/artifacts", { type: "file", value: "drift.md" });
    await page.evaluate(async ({ arts, idx }) => {
      const s = sessions.find((x) => x.id === activeSessionId);
      s.artifacts = arts; // rewind to the pre-drift render
      await removeArtifact(idx);
    }, snap);
    const clientArts = await page.evaluate(() =>
      sessions.find((x) => x.id === activeSessionId).artifacts.map((a) => a.value));
    r.ok(clientArts.some((v) => v.endsWith("/drift.md")) && !clientArts.some((v) => v.endsWith("/guide.md")),
      "409 path refetched — client state matches the drifted server");
    await until(() => page.locator('#right .af[data-art-idx]', { hasText: "drift.md" }).count().then((c) => c > 0));
    await page.locator('#right .af[data-art-idx]', { hasText: "drift.md" }).locator(".af-rm").click();
    await until(async () => !(await serverArts()).some((a) => a.value.endsWith("/drift.md")));
    r.ok(!(await serverArts()).some((a) => a.value.endsWith("/drift.md")), "row is still removable after recovery");
  }

  // ── 7. Dir artifact: live folder group (THE acceptance criterion) ──
  await openBrowse();
  await rowNamed("folder-live").first().locator(".art-browse-adddir").click();
  await until(async () => (await serverArts()).some((a) => a.type === "dir"));
  r.ok((await serverArts()).some((a) => a.type === "dir" && a.value.endsWith("/folder-live")), "folder added as a dir artifact");
  r.ok(await pop.count() === 0, "adding the folder closes the popover");
  const group = page.locator('#right .af-group[data-af-dirart]');
  await group.waitFor({ state: "visible", timeout: 5000 });
  r.ok(!(await group.evaluate((el) => el.classList.contains("open"))), "dir group starts COLLAPSED");
  await group.locator(".af-group-hdr").click();
  await until(() => group.locator(".af", { hasText: "seed.md" }).count().then((c) => c > 0));
  r.ok(await group.locator(".af", { hasText: "seed.md" }).count() === 1, "expanding lists the folder's files");
  writeFileSync(join(env.ws, "folder-live", "brand-new.md"), "# brand new");
  const appeared = await until(() => group.locator(".af", { hasText: "brand-new.md" }).count().then((c) => c > 0));
  r.ok(appeared, "a NEW file written to disk appears automatically (acceptance criterion)");
  await shot("dir-group");
  // A file that is ALSO an individual artifact renders once, inside the group.
  await page.evaluate(async (abs) => { await addArtifact("file", abs); }, join(env.ws, "folder-live", "seed.md"));
  await until(() => group.locator('.af[data-art-idx]', { hasText: "seed.md" }).count().then((c) => c > 0));
  r.ok(await page.locator('#right .af-label', { hasText: "seed.md" }).count() === 1,
    "file-as-artifact renders once (inside the group, not twice)");
  // × on the group removes ONLY the dir artifact; real files untouched.
  const dirIdx = (await serverArts()).findIndex((a) => a.type === "dir");
  await group.locator(".af-group-hdr .af-rm").click();
  await until(async () => !(await serverArts()).some((a) => a.type === "dir"));
  r.ok(!(await serverArts()).some((a) => a.type === "dir"), "group × removes the dir artifact only");
  r.ok(existsSync(join(env.ws, "folder-live", "seed.md")) && existsSync(join(env.ws, "folder-live", "brand-new.md")),
    "files on disk untouched by group removal");
  r.ok(dirIdx >= 0 && (await serverArts()).some((a) => a.value.endsWith("/seed.md")), "sibling artifacts survive");

  // ── 8. Ephemeral file: tab — view a child without creating an artifact ──
  await api("POST", "/api/sessions/m19/artifacts", { type: "dir", value: "folder-live" });
  await until(() => page.locator('#right .af-group[data-af-dirart]').count().then((c) => c > 0), 6000);
  const group2 = page.locator('#right .af-group[data-af-dirart]');
  await group2.locator(".af-group-hdr").click();
  await until(() => group2.locator('.af[data-file-path]', { hasText: "brand-new.md" }).count().then((c) => c > 0));
  await group2.locator('.af[data-file-path]', { hasText: "brand-new.md" }).click();
  await until(() => page.locator(".wh-tab", { hasText: "brand-new.md" }).count().then((c) => c > 0));
  r.ok(await page.locator(".wh-tab", { hasText: "brand-new.md" }).count() === 1, "clicking a child opens a file: tab");
  await until(() => page.locator("#artifact-container .md-preview", { hasText: "brand new" }).count().then((c) => c > 0));
  r.ok(await page.locator("#artifact-container .md-preview", { hasText: "brand new" }).count() > 0,
    "file: tab renders through the artifact pipeline");
  await page.evaluate(() => cycleLayout()); // → vsplit
  await until(() => page.locator(".split-pane .md-preview", { hasText: "brand new" }).count().then((c) => c > 0));
  r.ok(await page.locator(".split-pane .md-preview", { hasText: "brand new" }).count() > 0, "file: tab works in a split pane");
  await page.evaluate(() => { cycleLayout(); cycleLayout(); }); // hsplit → tabs
  await page.locator('.wh-tab-x[data-close-tab^="file:"]').click();
  r.ok(await page.locator(".wh-tab", { hasText: "brand-new.md" }).count() === 0, "file: tab closes");
  r.ok(!(await serverArts()).some((a) => a.value && a.value.endsWith("/brand-new.md")),
    "no artifact was created for the viewed file (API check)");

  // ── 9. Concurrency: two UI adds + one CLI-style append, none lost ──
  // The end-state assert alone is a nondeterministic discriminator (the old
  // whole-array PATCH could pass it depending on response ordering) — so ALSO
  // record the browser's write traffic and prove the UI issues atomic POSTs and
  // never a PATCH carrying an artifacts array.
  {
    const writes = [];
    await page.route("**/api/sessions/**", (route) => {
      const req = route.request();
      if (req.method() === "POST" && /\/artifacts(\?|$)/.test(req.url())) writes.push("POST");
      if (req.method() === "PATCH") {
        try {
          const body = JSON.parse(req.postData() || "{}");
          if (body.artifacts !== undefined) writes.push("PATCH-artifacts");
        } catch {}
      }
      route.continue();
    });
    const before = (await serverArts()).length;
    await Promise.all([
      page.evaluate(async () => {
        await Promise.all([addArtifact("file", "conc-a.md"), addArtifact("file", "conc-b.md")]);
      }),
      api("POST", "/api/sessions/m19/artifacts", { type: "file", value: "conc-c.md" }),
    ]);
    await wait(400);
    await page.unroute("**/api/sessions/**");
    r.ok(writes.filter((w) => w === "POST").length === 2 && !writes.includes("PATCH-artifacts"),
      `UI adds go through atomic POST /artifacts, never a whole-array PATCH (saw: ${writes.join(",") || "none"})`);
    const vals = (await serverArts()).map((a) => a.value);
    const gotAll = ["conc-a.md", "conc-b.md", "conc-c.md"].every((n) => vals.some((v) => v.endsWith(`/${n}`)));
    r.ok(gotAll && vals.length === before + 3, "two UI adds + one API append all landed (no lost update)");
  }

  // ── 10. Popover viewport clamp: open near the bottom edge → fully visible ──
  {
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "clamp-probe";
      b.textContent = "+";
      b.style.cssText = "position:fixed;left:24px;bottom:6px;z-index:9999";
      document.body.appendChild(b);
      b.addEventListener("click", (e) => showArtifactPopover(e));
      b.click();
    });
    await pop.waitFor({ state: "visible" });
    // Let the async Suggested scan land (the popover grows) and the reclamp run.
    await page.locator("#art-suggest-list .art-suggest-item, #art-suggest-list .art-suggest-empty")
      .first().waitFor({ timeout: 5000 });
    await wait(250);
    const box = await pop.boundingBox();
    const vp = page.viewportSize();
    r.ok(box && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width,
      `popover opened at the bottom edge is fully on-screen (flipped/clamped) [y=${box && Math.round(box.y)} h=${box && Math.round(box.height)}]`);
    await shot("clamp");
    await page.evaluate(() => { hideAddPopover(); document.getElementById("clamp-probe")?.remove(); });
  }

  // ── 11. Suggest submission disambiguation (codex round-3): the same filename
  // exists at the workspace root AND the agent cwd — selecting the suggestion
  // must add the CWD file (base-joined submission), never the root one ──
  writeFileSync(join(env.ws, "dup.md"), "# root copy");
  mkdirSync(join(env.ws, "subws"), { recursive: true });
  writeFileSync(join(env.ws, "subws", "dup.md"), "# cwd copy");
  const created2 = await fetch(`${env.baseUrl}/api/sessions`, {
    method: "POST", headers: authHeaders(env.token),
    body: JSON.stringify({ name: "m19cwd", launchCommand: "shell", cwd: join(env.ws, "subws") }),
  });
  r.ok(created2.status === 201, "cwd'd agent created for the dup-name case");
  await page.reload({ waitUntil: "networkidle" });
  await wait(600);
  await page.locator('.dk[data-sid="m19cwd"]').click();
  await wait(400);
  await page.locator("#af-add-btn").click();
  await wait(300);
  await page.locator("#art-filter").fill("dup");
  await wait(300);
  await page.locator(".art-suggest-item", { hasText: "dup.md" }).first().click();
  await wait(800);
  const cwdArts = (await (await fetch(`${env.baseUrl}/api/sessions`)).json())
    .find((s) => s.id === "m19cwd").artifacts.map((a) => a.value);
  r.ok(cwdArts.some((v) => v.endsWith("subws/dup.md")) && !cwdArts.includes("dup.md"),
    `suggest-select stored the cwd copy, not the root one (got: ${JSON.stringify(cwdArts)})`);

  r.ok(pageErrors.length === 0, `zero page errors (${pageErrors.join("; ") || "none"})`);
} catch (e) {
  r.fail(`unexpected error: ${e.message}`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  env.stop();
}

process.exit(r.finish() ? 0 : 1);
