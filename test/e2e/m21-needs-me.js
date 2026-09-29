/**
 * Module M21 — "Needs me" triage (attention/ack, the mail model).
 *
 * The 5-second done→idle PATCH is gone: `state` is what the pane is doing
 * (detector-owned), attention is whether the operator has SEEN the last time
 * it needed them. What this proves in a real browser:
 *   - cards whose agent entered done/blocked light up (dk-needs + dot); the
 *     topbar "N need me" counter matches
 *   - looking at an agent (terminal on screen, window focused, ≥1 s) acks it:
 *     the card goes quiet (dk-acked), the counter drops, ackRev is persisted —
 *     and the client never PATCHes `state` (the detector's state is untouched)
 *   - an unread agent stays unread when the detector moves its state on (an
 *     idle shell pane), so "you never looked" survives the pane going quiet
 *   - Alt+N jumps to the next agent that needs me (wraps past the active one)
 *   - "Only agents that need me" filter hides the rest but keeps the active
 *     card, and survives a reload
 *   - the palette lists every agent (the old 8-row cap is gone) with a
 *     "needs me" hint
 *
 * Run: node test/e2e/m21-needs-me.js
 */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join } from "path";
import { bootWorkspace, authHeaders, reporter, screenshotDir } from "./harness.js";

const r = reporter("M21 Needs me");
const env = await bootWorkspace({ name: "m21" });
let browser;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await wait(200); }
  return fn();
}
const api = (method, path, body) => fetch(`${env.baseUrl}${path}`, {
  method, headers: authHeaders(env.token), ...(body ? { body: JSON.stringify(body) } : {}),
});
const live = async (id) => (await (await fetch(`${env.baseUrl}/api/sessions`)).json()).find((s) => s.id === id);
const agentJson = (id) => JSON.parse(readFileSync(join(env.ws, ".hadron", "agents", `${id}.json`), "utf-8"));
const NAMES = ["Ant", "Bee", "Cat", "Dog", "Eel", "Fox", "Gnu", "Hen", "Ibis", "Jay"];
const ids = NAMES.map((n) => n.toLowerCase());

try {
  for (const name of NAMES) {
    const res = await api("POST", "/api/sessions", { name, launchCommand: "shell" });
    r.ok(res.status === 201, `agent "${name}" created`);
  }
  // Attention raised through the manual-PATCH twin of the detector path.
  for (const id of ["bee", "cat"]) await api("PATCH", `/api/sessions/${id}`, { state: "done" });
  await api("PATCH", `/api/sessions/dog`, { state: "blocked", blockReason: "permission" });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const statePatches = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && /\/api\/sessions\//.test(req.url())) {
      try { const b = JSON.parse(req.postData() || "{}"); if ("state" in b) statePatches.push(b); } catch {}
    }
  });
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(`.dk[data-sid="ant"]`).waitFor({ state: "visible", timeout: 10000 });
  const card = (id) => page.locator(`.dk[data-sid="${id}"]`).first();
  const has = (id, cls) => card(id).evaluate((el, c) => el.classList.contains(c), cls);
  const shot = (name) => page.screenshot({ path: join(screenshotDir(), `m21-${name}.png`) });
  const count = () => page.locator("#needs-me .nm-count").textContent();

  // ── 1. lit cards + counter ──
  await until(async () => (await page.locator("#needs-me").isVisible()) && (await count()) === "3");
  r.ok((await count()) === "3", "topbar shows '3 need me'");
  for (const id of ["bee", "cat", "dog"]) {
    r.ok(await has(id, "dk-needs") && (await card(id).locator(".dk-dot").count()) === 1, `${id}: card lit (dk-needs + dot)`);
  }
  r.ok(!(await has("ant", "dk-needs")) && (await card("ant").locator(".dk-dot").count()) === 0, "ant (idle, never done): not lit");
  r.ok((await card("bee").locator(".dk-sub").textContent()).includes("needs review"), "unseen done card says 'needs review'");
  await shot("lit");

  // ── 2. looking acks — but never touches state ──
  const focused = await page.evaluate(() => document.hasFocus() && !document.hidden);
  r.ok(focused, "harness: page reports focus (the dwell ack needs it)");
  await card("bee").click();
  r.ok(await until(async () => (await live("bee")).ackRev === 1, 6000), "after ~1 s on bee's terminal, server ackRev = 1");
  const beeNow = await live("bee");
  r.ok(beeNow.state === "done", "server state is still 'done' — looking is not doing");
  r.ok(await until(async () => !(await has("bee", "dk-needs")) && (await has("bee", "dk-acked"))), "bee's card goes quiet (dk-acked, no dk-needs)");
  r.ok((await card("bee").locator(".dk-dot").count()) === 0, "…dot gone");
  r.ok((await card("bee").locator(".dk-sub").textContent()).startsWith("done"), "…label reads 'done' (state is truthful, just not shouting)");
  r.ok(await until(async () => (await count()) === "2"), "counter drops to 2");
  r.ok(agentJson("bee").ackRev === 1, "ackRev persisted to bee's agent file");
  r.ok(statePatches.length === 0, `client sent no PATCH with a state field (${statePatches.length})`);
  await shot("acked");

  // ── 3. unread survives the state moving on ──
  // cat goes back to idle (the pane went quiet) without anyone looking: its
  // attention is untouched, so the card stays lit with the quiet gray dot.
  await api("PATCH", `/api/sessions/cat`, { state: "idle" });
  r.ok(await until(async () => (await card("cat").locator(".dk-sub").textContent()).trim() !== "needs review"), "cat's label follows the state (no longer 'needs review')");
  r.ok(await has("cat", "dk-needs") && (await card("cat").locator(".dk-dot").count()) === 1, "cat is still lit: unread is unread until I look");
  r.ok((await live("cat")).attentionRev === 1 && !(await live("cat")).ackRev, "cat: attentionRev 1, no ack");

  // ── 4. Alt+N → next agent that needs me ──
  await page.keyboard.press("Alt+n");
  r.ok(await until(async () => (await page.evaluate(() => activeSessionId)) === "cat"), "Alt+N from bee lands on cat (next unread in deck order)");
  r.ok(await until(async () => (await live("cat")).ackRev === 1, 6000), "…and dwelling on cat acks it");
  await page.keyboard.press("Alt+n");
  r.ok(await until(async () => (await page.evaluate(() => activeSessionId)) === "dog"), "Alt+N again → dog (blocked)");
  // The detector treats dog's bare shell prompt after "blocked" as a finished
  // turn (blocked→done) once the manual-override window lapses — a genuine new
  // entry, so it may re-raise while we look and the dwell acks it again.
  // Assert the invariant, not a fixed number: the ack catches up to the rev.
  const caughtUp = async (id) => { const d = await live(id); return (d.ackRev || 0) >= 1 && d.ackRev === d.attentionRev; };
  r.ok(await until(() => caughtUp("dog"), 15000), "…acked too (ackRev caught up with attentionRev)");
  r.ok(await until(async () => (await page.locator("#needs-me").isHidden()), 15000), "counter hides at 0");
  await page.keyboard.press("Alt+n");
  await wait(300);
  r.ok((await page.evaluate(() => activeSessionId)) === "dog", "Alt+N with nobody unread stays put");

  // ── 5. a new round re-lights an acked agent ──
  // Baseline AFTER the idle PATCH: its 5-s manual override freezes the detector
  // (dog's bare shell pane flaps blocked→done otherwise) for the next two lines.
  await api("PATCH", `/api/sessions/dog`, { state: "idle" });
  const dogRev = (await live("dog")).attentionRev;
  await api("PATCH", `/api/sessions/eel`, { state: "done" });
  await api("PATCH", `/api/sessions/dog`, { state: "done" });
  r.ok((await live("dog")).attentionRev === dogRev + 1, `dog finishing another round → attentionRev ${dogRev + 1} (> ack ${dogRev})`);
  // dog is the ACTIVE agent, so the dwell acks it again as soon as it re-lights
  r.ok(await until(() => caughtUp("dog"), 8000), "…and since I am looking at it, the ack follows the rev");
  r.ok(await until(async () => (await count()) === "1", 15000), "eel is the one unread now");

  // ── 6. filter: only agents that need me (+ the active one), persisted ──
  await page.evaluate(() => setDeckFilter("needs"));
  await until(async () => (await page.locator(".dk").count()) === 2);
  const shown = await page.locator(".dk").evaluateAll((els) => els.map((e) => e.dataset.sid).sort());
  r.ok(JSON.stringify(shown) === JSON.stringify(["dog", "eel"]), `filter shows eel (unread) + dog (active) only (${shown.join(",")})`);
  r.ok(await page.locator("#needs-me").evaluate((el) => el.classList.contains("nm-filtered")), "counter marks the filter as on");
  await shot("filtered");
  // The palette is the way back to a quiet agent the filter hides: cat is
  // acked (not on the deck) but must still be reachable by name.
  r.ok((await page.locator(`.dk[data-sid="cat"]`).count()) === 0, "cat (read) is hidden by the filter");
  await page.locator("#palette-trigger").click();
  await page.locator("#palette-overlay.active").waitFor({ state: "visible", timeout: 3000 });
  await page.locator("#palette-input").fill("cat");
  await wait(200);
  r.ok((await page.locator(".palette-row", { hasText: "Cat" }).count()) === 1, "…but ⌘K still lists it while the filter is on");
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.dk[data-sid="eel"]`).waitFor({ state: "visible", timeout: 10000 });
  r.ok((await page.evaluate(() => deckFilter)) === "needs", "filter survives a reload (ui state)");
  r.ok((await page.locator(".dk").count()) <= 2, "…and still hides the quiet agents");
  // Empty state: ack eel by jumping to it → nobody unread → the deck says so.
  await page.keyboard.press("Alt+n");
  r.ok(await until(async () => (await page.evaluate(() => activeSessionId)) === "eel"), "Alt+N under the filter reaches eel");
  r.ok(await until(async () => (await page.locator(".deck-empty").count()) === 1, 8000), "with nobody unread the filtered deck shows 'Nobody needs you right now'");
  await page.evaluate(() => setDeckFilter("all"));
  const total = (await (await fetch(`${env.baseUrl}/api/sessions`)).json()).length; // the 10 + the workspace's sample agent
  r.ok(await until(async () => (await page.locator(".dk").count()) === total), `filter off → all ${total} agents back`);

  // ── 7. the focus guard: an unfocused / hidden window acks nothing ──
  // A dashboard left open on a second monitor must not silently read the
  // fleet. Headless Chromium keeps every page focused (bringToFront on another
  // tab does not blur this one), so the guard's inputs are stubbed in place:
  // this proves the dwell CONSULTS document.hasFocus() / document.hidden and
  // does nothing while either says "not looking".
  await api("PATCH", `/api/sessions/fox`, { state: "done" });
  await page.evaluate(() => { window._realHasFocus = document.hasFocus; document.hasFocus = () => false; });
  await page.evaluate(() => switchSession("fox"));
  await wait(3000);
  r.ok(!(await live("fox")).ackRev, "3 s on fox's terminal with hasFocus() false → not acked");
  await page.evaluate(() => { document.hasFocus = window._realHasFocus; Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); });
  await wait(2500);
  r.ok(!(await live("fox")).ackRev, "…with the document hidden → still not acked");
  await page.evaluate(() => { delete document.hidden; });
  r.ok(await page.evaluate(() => document.hasFocus() && !document.hidden), "harness: guard inputs restored");
  r.ok(await until(async () => (await live("fox")).ackRev === (await live("fox")).attentionRev, 6000), "…looking again → the dwell acks it");

  // ── 8. palette lists every agent, with the needs-me hint ──
  await page.locator("#palette-trigger").click();
  await page.locator("#palette-overlay.active").waitFor({ state: "visible", timeout: 3000 });
  await page.locator("#palette-input").fill("");
  await wait(200);
  const agentRows = await page.locator(".palette-row").evaluateAll((els, names) => els.filter((e) => names.some((n) => e.textContent.includes(n))).length, NAMES);
  r.ok(agentRows >= ids.length, `palette lists all ${ids.length} agents (rows: ${agentRows}; the 8-row cap is gone)`);
  await api("PATCH", `/api/sessions/gnu`, { state: "blocked", blockReason: "permission" });
  await until(async () => (await page.evaluate(() => needsMeList().length)) >= 1);
  await page.locator("#palette-input").fill("gnu"); await wait(200);
  r.ok((await page.locator(".palette-row", { hasText: "Gnu" }).first().textContent()).includes("needs me"), "unread agent row carries a 'needs me' hint");
  await shot("palette");
  await page.keyboard.press("Escape");

  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ") || "none"})`);
} catch (e) {
  r.fail(`exception: ${e.stack || e.message}`);
} finally {
  if (browser) await browser.close();
  env.stop();
}
process.exit(r.finish() ? 0 : 1);
