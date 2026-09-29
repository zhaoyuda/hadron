/**
 * M30 — Installable web app (PWA): manifest, icons, Dock badge, Safari fallbacks.
 *
 * Proves the contract:
 *   - GET /manifest.webmanifest (open, no token) is application/manifest+json,
 *     no-cache, carries EXACTLY the allowlisted fields, is named after THIS
 *     instance's workspace (two instances → two names), never the token; every
 *     icon it lists answers 200 image/png with a real PNG of the declared size
 *   - index.html links the manifest, theme-color, apple-touch-icon and carries
 *     the workspace name as apple-mobile-web-app-title, HTML-escaped
 *   - Dock badge (navigator.setAppBadge / clearAppBadge, stubbed — headless
 *     Chromium has no Dock): an agent going done sets the badge to the needs-me
 *     count, acking it (the M21 dwell) clears it, a rejecting API does not break
 *     the page, an absent API leaves the topbar counter intact, and a failed
 *     /api/sessions poll never clears the badge (frozen beats a false zero)
 *   - a system notification body carries the workspace name (M28 pins the text)
 *   - an OSC 52 copy the browser refuses (Safari: no user gesture) becomes a
 *     one-click "Copy" offer that writes on the click and goes away
 *
 * Run: node test/e2e/m30-pwa.js
 */
import { chromium } from "playwright";
import { bootWorkspace, authHeaders, reporter } from "./harness.js";

const r = reporter("M30 Installable web app (PWA)");
const NAME = 'Lab <b>&"amp';
const env = await bootWorkspace({ name: NAME });
const env2 = await bootWorkspace({ name: "second" });
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
const MANIFEST_KEYS = ["id", "name", "short_name", "start_url", "scope", "display", "background_color", "theme_color", "icons"];
const BADGE_STUB = `
  window.__badge = [];
  window.__badgeReject = false;
  navigator.setAppBadge = (n) => { window.__badge.push(n); return window.__badgeReject ? Promise.reject(new Error("no")) : Promise.resolve(); };
  navigator.clearAppBadge = () => { window.__badge.push(0); return window.__badgeReject ? Promise.reject(new Error("no")) : Promise.resolve(); };
`;
const badge = (page) => page.evaluate(() => window.__badge.slice());
const live = async (id) => (await (await fetch(`${env.baseUrl}/api/sessions`)).json()).find((s) => s.id === id);

try {
  // ── 1. manifest: open GET, explicit fields, named after the workspace ──
  const mr = await fetch(`${env.baseUrl}/manifest.webmanifest`);
  r.ok(mr.status === 200 && /^application\/manifest\+json/.test(mr.headers.get("content-type") || ""), `manifest answers 200 application/manifest+json (${mr.status} ${mr.headers.get("content-type")})`);
  r.ok(/no-cache/.test(mr.headers.get("cache-control") || ""), "manifest is no-cache (a renamed workspace shows on the next launch)");
  const mtext = await mr.text();
  const m = JSON.parse(mtext);
  r.ok(JSON.stringify(Object.keys(m).sort()) === JSON.stringify([...MANIFEST_KEYS].sort()), `manifest carries exactly the allowlisted fields (${Object.keys(m).join(",")})`);
  r.ok(m.name === `Hadron — ${NAME}` && m.short_name === NAME, `named after the workspace, verbatim JSON (${m.name} / ${m.short_name})`);
  r.ok(m.id === "/" && m.start_url === "/" && m.scope === "/" && m.display === "standalone", "id/start_url/scope '/', display standalone");
  r.ok(m.theme_color === "#0d1117" && m.background_color === "#0d1117", "theme + background are the dark palette");
  r.ok(!mtext.includes(env.token), "manifest never carries the token");
  const m2 = await (await fetch(`${env2.baseUrl}/manifest.webmanifest`)).json();
  r.ok(m2.short_name === "second" && m2.name === "Hadron — second", `a second instance is its own app (${m2.name})`);
  r.ok(Array.isArray(m.icons) && m.icons.length === 3 && m.icons.some((i) => i.purpose === "maskable"), "three icons, one maskable");
  for (const icon of m.icons) {
    const ir = await fetch(`${env.baseUrl}${icon.src}`);
    const buf = Buffer.from(await ir.arrayBuffer());
    const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
    const w = isPng ? buf.readUInt32BE(16) : 0, h = isPng ? buf.readUInt32BE(20) : 0;
    r.ok(ir.status === 200 && /^image\/png/.test(ir.headers.get("content-type") || "") && isPng && `${w}x${h}` === icon.sizes,
      `${icon.src}: 200 image/png, real PNG ${w}x${h} = declared ${icon.sizes}`);
  }
  const at = await fetch(`${env.baseUrl}/assets/icons/apple-touch-icon.png`);
  const atb = Buffer.from(await at.arrayBuffer());
  r.ok(at.status === 200 && atb.readUInt32BE(0) === 0x89504e47 && atb.readUInt32BE(16) === 180 && atb.readUInt32BE(20) === 180, "apple-touch-icon is a 180x180 PNG");

  // ── 2. index.html: manifest link, metas, escaped workspace title ──
  const html = await (await fetch(env.baseUrl)).text();
  r.ok(/<link rel="manifest" href="\/manifest.webmanifest"/.test(html), "index.html links the manifest");
  r.ok(/<meta name="theme-color" content="#0d1117"/.test(html) && /<link rel="apple-touch-icon" href="\/assets\/icons\/apple-touch-icon.png"/.test(html), "theme-color + apple-touch-icon present");
  r.ok(html.includes('<meta name="apple-mobile-web-app-title" content="Lab &lt;b&gt;&amp;&quot;amp" />'), "apple-mobile-web-app-title is the workspace name, HTML-escaped");
  r.ok(!html.includes("<b>&\"amp"), "…and the raw name never lands in the markup");

  // ── 3. Dock badge follows the needs-me count ──
  r.ok((await api("POST", "/api/sessions", { name: "Ant", launchCommand: "shell" })).status === 201, "agent ant created");
  r.ok((await api("POST", "/api/sessions", { name: "Bee", launchCommand: "shell" })).status === 201, "agent bee created");
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(BADGE_STUB);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".dk").first().waitFor({ timeout: 10000 });
  await page.locator('.dk[data-sid="ant"]').first().click();
  await until(() => page.evaluate(() => activeSessionId === "ant"));
  await until(async () => (await badge(page)).length > 0, 6000);
  r.ok((await badge(page)).at(-1) === 0, `first successful poll clears the badge (nobody needs me): ${JSON.stringify(await badge(page))}`);
  r.ok((await api("PATCH", "/api/sessions/bee", { state: "done" })).status === 200, "bee → done");
  r.ok(await until(async () => (await badge(page)).at(-1) === 1), `badge set to 1 as bee needs me: ${JSON.stringify(await badge(page))}`);
  const before = (await badge(page)).length;
  await wait(3500);
  r.ok((await badge(page)).length === before, "the same count is not re-sent on every 3-s poll");
  // acking bee (dwell on its terminal, focused window) clears the badge
  await page.locator('.dk[data-sid="bee"]').first().click();
  r.ok(await until(async () => (await live("bee")).ackRev === 1, 8000), "dwelling on bee acks it (ackRev 1)");
  r.ok(await until(async () => (await badge(page)).at(-1) === 0), `badge cleared once acked: ${JSON.stringify(await badge(page))}`);

  // a failed poll must not clear (or touch) the badge
  r.ok((await api("PATCH", "/api/sessions/ant", { state: "blocked", blockReason: "permission" })).status === 200, "ant → blocked (active agent, not acked while we re-route the poll)");
  await page.locator('.dk[data-sid="bee"]').first().click();
  r.ok(await until(async () => (await badge(page)).at(-1) === 1), "badge 1 for ant");
  await page.route("**/api/sessions", (route) => route.fulfill({ status: 500, body: "boom" }));
  const frozenLen = (await badge(page)).length;
  await page.evaluate(() => { window.__badge.push("marker"); });
  // outside knowledge changes (ant acked by another client) while our polls fail
  // (ackRev is clamped to attentionRev server-side, so a large value acks whatever the
  // shell pane's detector may have raised meanwhile — the ack, not the count, is the point)
  r.ok((await api("PATCH", "/api/sessions/ant", { ackRev: 1e6 })).status === 200, "ant acked from another client while this page's polls fail");
  await wait(7000);
  r.ok((await badge(page)).length === frozenLen + 1, `no badge call while polls fail — a frozen count beats a false zero: ${JSON.stringify(await badge(page))}`);
  await page.unroute("**/api/sessions");
  r.ok((await api("PATCH", "/api/sessions/ant", { ackRev: 1e6 })).status === 200, "(ack again in case the detector re-raised while the polls were down)");
  r.ok(await until(async () => (await badge(page)).at(-1) === 0, 9000), `polls back → badge re-derived and cleared: ${JSON.stringify(await badge(page))}`);

  // a rejecting Badging API never breaks the page; the counter stays the truth
  await page.evaluate(() => { window.__badgeReject = true; });
  r.ok((await api("PATCH", "/api/sessions/ant", { state: "blocked", blockReason: "again" })).status === 200, "ant → blocked again");
  r.ok(await until(async () => (await badge(page)).at(-1) === 1), "setAppBadge called (and rejected)");
  await wait(500);
  r.ok(await page.locator("#needs-me").evaluate((el) => !el.hidden && /1 needs me/.test(el.textContent)), "topbar '1 needs me' unaffected by the rejection");
  r.ok(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);

  // absent API (a plain browser without Badging): the stub-free context is checked to HAVE
  // Chromium's own API, then it is removed — so the "no API" run is not vacuous
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addInitScript(() => { window.__hadBadge = typeof navigator.setAppBadge === "function"; delete Navigator.prototype.setAppBadge; delete Navigator.prototype.clearAppBadge; });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on("pageerror", (e) => errs2.push(e.message));
  await p2.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p2.locator(".dk").first().waitFor({ timeout: 10000 });
  r.ok(await until(() => p2.locator("#needs-me").evaluate((el) => !el.hidden && /1 needs me/.test(el.textContent))), "without a Badging API the counter still renders");
  const badgeApi = await p2.evaluate(() => ({ had: window.__hadBadge, now: typeof navigator.setAppBadge }));
  r.ok(errs2.length === 0 && badgeApi.had === true && badgeApi.now === "undefined", `…with no errors, the API removed for real (${JSON.stringify(badgeApi)} ${errs2.join(" | ")})`);
  await ctx2.close();

  // ── 4. OSC 52 refused by the browser → one-click offer ──
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx3.addInitScript(() => {
    window.__writes = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { window.__writes.push(t); return window.__writes.length === 1 ? Promise.reject(new DOMException("gesture", "NotAllowedError")) : Promise.resolve(); } }, configurable: true });
  });
  const p3 = await ctx3.newPage();
  await p3.goto(env.baseUrl, { waitUntil: "domcontentloaded" });
  await p3.locator(".dk").first().waitFor({ timeout: 10000 });
  await p3.locator('.dk[data-sid="ant"]').first().click();
  await p3.locator("#terminal-container.active .xterm").waitFor({ state: "visible", timeout: 10000 });
  await wait(1200);
  // Fed to xterm.js directly: tmux forwards a pane's OSC 52 only with the server
  // option `set-clipboard on` (the default `external` drops it — the real reason
  // M10 is an XFAIL), and the e2e harness must not change the shared tmux server.
  // The browser-side contract (handler → refused write → offer) is what this proves.
  const b64 = Buffer.from("hello from the pane").toString("base64");
  await p3.evaluate((seq) => { term.write(seq); }, `\x1b]52;c;${b64}\x07`);
  r.ok(await until(() => p3.locator(".cn-clipboard").count().then((n) => n > 0), 8000), "refused clipboard write → a Copy offer appears");
  r.ok(await p3.evaluate(() => window.__writes.length === 1 && window.__writes[0] === "hello from the pane"), "the first write was attempted with the pane's text");
  await p3.locator('.cn-clipboard [data-act="copy"]').click();
  r.ok(await until(() => p3.evaluate(() => window.__writes.length === 2 && window.__writes[1] === "hello from the pane")), "clicking Copy writes the same text from the gesture");
  r.ok(await until(() => p3.locator(".cn-clipboard").count().then((n) => n === 0), 3000), "the offer goes away once copied");
  await ctx3.close();
} catch (e) {
  r.fail(`exception: ${e.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  env.stop();
  env2.stop();
}
process.exit(r.finish() ? 0 : 1);
