/**
 * Integration tests for the v0.8 annotation review loop (server/annotations.js + routes).
 *
 * Self-contained: boots its own Hadron server on a throwaway workspace + port,
 * runs assertions over HTTP, then tears everything down (server + tmux sessions).
 *
 * Run: node test/unit/test-annotations.js
 * Requires: tmux on PATH.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Random high port — never 3000 (production), never the other suites' fixed ports.
const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const WS = mkdtempSync(join(tmpdir(), "hadron-anno-"));
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
let server, TOKEN;

function authHeaders(extra = {}) {
  return { "Content-Type": "application/json", "x-hadron-token": TOKEN, "Origin": ORIGIN, ...extra };
}
const GET = (p) => fetch(`${BASE}${p}`).then((r) => r.json());
const POST = (p, body) => fetch(`${BASE}${p}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body ?? {}) });
const PATCH = (p, body) => fetch(`${BASE}${p}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(body ?? {}) });
const DEL = (p) => fetch(`${BASE}${p}`, { method: "DELETE", headers: authHeaders() });

async function createAgent(name) {
  const r = await POST("/api/sessions", { name, launchCommand: "shell" });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  return (await r.json()).id;
}
const annUrl = (id, rest = "") => `/api/sessions/${id}/annotations${rest}`;

function capturePane(agentId) {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", `hadron-${WS_NAME}-${agentId}`, "-p"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/sessions`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}

function killTmux() {
  try {
    const names = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter((n) => n.includes(`hadron-${WS_NAME}`));
    for (const n of names) try { execFileSync("tmux", ["kill-session", "-t", n]); } catch {}
  } catch {}
}

async function main() {
  server = spawn("node", [join(__dirname, "..", "..", "server", "index.js"), WS], {
    env: { ...process.env, PORT: String(PORT), HADRON_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.DEBUG && console.error(`[server] ${d}`));
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();

  const A = await createAgent("anno-a"); // CRUD + relocation + corrupted sidecar
  const B = await createAgent("anno-b"); // batch lifecycle: send / resolve / reopen
  const C = await createAgent("anno-c"); // purge scope + no-draft send
  const D = await createAgent("anno-d"); // dispatch failure + retry

  console.log("\n[CRUD]");
  let cid;
  {
    const r = await POST(annUrl(A), { path: "notes.md", body: "tighten the intro" }); // no anchor → doc
    const j = await r.json();
    cid = j.comment && j.comment.id;
    ok(r.status === 201 && /^c_\d+_[a-z0-9]{4}$/.test(cid), "create draft → 201, id is c_<ts>_<rand>");
    ok(j.comment.state === "draft" && j.comment.batchId === null, "new comment starts as draft, no batch");
    ok(j.comment.file === "notes.md" && j.comment.scope === "workspace", "workspace path stored relative, scope workspace");
    ok(j.comment.locationText === "(whole document)", "doc anchor → locationText '(whole document)'");
    const list = await GET(annUrl(A, "?state=all"));
    ok(list.comments.length === 1 && list.summary.draft === 1 && list.errors.length === 0, "list shows the draft; summary.draft=1; no errors");
  }
  {
    const r = await PATCH(annUrl(A, `/${cid}`), { body: "tighten the intro, drop the cliché" });
    const j = await r.json();
    ok(r.status === 200 && j.comment.body.includes("cliché"), "PATCH draft body → 200, body updated");
    // PATCH must not be a state side-channel — transitions only via dedicated endpoints.
    await PATCH(annUrl(A, `/${cid}`), { body: "still a draft", state: "resolved" });
    const list = await GET(annUrl(A, "?state=all"));
    ok(list.comments[0].state === "draft", "PATCH cannot change state (state field ignored)");
  }
  {
    const r = await DEL(annUrl(A, `/${cid}`));
    ok(r.status === 200, "DELETE draft → 200");
    const list = await GET(annUrl(A, "?state=all"));
    ok(list.comments.length === 0, "deleted draft is gone");
  }

  console.log("\n[path validation]");
  {
    const r = await POST(annUrl(A), { path: "http://evil.example.com/a.md", body: "x" });
    ok(r.status === 400, "http(s) URL path rejected (400)");
    const r2 = await POST(annUrl("no-such-agent"), { path: "a.md", body: "x" });
    ok(r2.status === 404, "unknown agentId rejected (404)");
    const r3 = await POST(annUrl(A), { path: "/tmp/outside-the-workspace.md", body: "x" });
    const j3 = await r3.json();
    ok(r3.status === 201 && j3.comment.scope === "external" && j3.comment.file.startsWith("/"), "absolute path outside workspace → scope external, stored absolute");
    await DEL(annUrl(A, `/${j3.comment.id}`));
  }

  console.log("\n[anchor relocation]");
  {
    writeFileSync(join(WS, "anchored.md"), [
      "intro line one",
      "the unique target sentence",
      "alpha bravo charlie",
      "middle filler",
      "alpha bravo charlie",
      "closing line",
    ].join("\n"));
    const mk = async (anchor) => (await (await POST(annUrl(A), { path: "anchored.md", anchor, body: "b" })).json()).comment.id;
    const idUnique = await mk({ type: "text", exact: "the unique target sentence" });
    const idPrefix = await mk({ type: "text", exact: "alpha bravo charlie", prefix: "middle filler\n" });
    const idAmbig = await mk({ type: "text", exact: "alpha bravo charlie" });
    const idGone = await mk({ type: "text", exact: "text that was never here" });
    const list = await GET(annUrl(A, "?path=anchored.md&state=all"));
    const by = Object.fromEntries(list.comments.map((c) => [c.id, c]));
    ok(by[idUnique].anchorStatus === "matched" && by[idUnique].locationText.includes("(line 2)"), "unique exact → matched, with line hint");
    ok(by[idPrefix].anchorStatus === "matched" && by[idPrefix].locationText.includes("(line 5)"), "duplicated exact disambiguated by prefix → matched");
    ok(by[idAmbig].anchorStatus === "ambiguous", "duplicated exact, no context → ambiguous");
    ok(by[idGone].anchorStatus === "orphaned" && by[idGone].locationText === "(original text no longer found)", "removed text → orphaned");
  }

  console.log("\n[corrupted sidecar]");
  {
    writeFileSync(join(WS, ".hadron", "annotations", A, "deadbeef.json"), "{{{ not json");
    const r = await fetch(`${BASE}${annUrl(A, "?state=all")}`);
    const j = await r.json();
    ok(r.status === 200, "list with a corrupted sidecar still 200");
    ok(j.errors.length === 1 && j.errors[0].sidecar === "deadbeef.json", "corrupted sidecar reported in errors array");
    ok(j.comments.length === 4, "healthy sidecars unaffected");
  }

  console.log("\n[atomic send + multi-file batch]");
  let b1, b2;
  {
    b1 = (await (await POST(annUrl(B), { path: "b-one.md", body: "fix table" })).json()).comment.id;
    b2 = (await (await POST(annUrl(B), { path: "b-two.md", body: "fix chart" })).json()).comment.id;
    // Double-click safety: two immediate sends → exactly one carries the batch.
    const [r1, r2] = await Promise.all([POST(annUrl(B, "/send")), POST(annUrl(B, "/send"))]);
    const [j1, j2] = [await r1.json(), await r2.json()];
    const sent = [j1.sent, j2.sent].sort();
    ok(r1.status === 200 && r2.status === 200 && sent[0] === 0 && sent[1] === 2, "two immediate sends → one batch of 2, other sent:0");
    const list = await GET(annUrl(B, "?state=all"));
    const batchIds = new Set(list.comments.map((c) => c.batchId));
    ok(batchIds.size === 1 && /^b_\d+_[a-z0-9]{4}$/.test([...batchIds][0]), "drafts across 2 files share ONE batchId");
    ok(list.comments.every((c) => c.state === "sent" && c.sentAt), "all drafts stamped sent + sentAt");
    ok(list.summary.sent === 2 && list.summary.currentBatchId === [...batchIds][0], "summary counts span files; currentBatchId set");
    await sleep(400);
    ok(capturePane(B).includes("/hadron-review"), "send dispatched literal /hadron-review into the agent pane");
  }

  console.log("\n[transition whitelist]");
  {
    const r = await PATCH(annUrl(B, `/${b1}`), { body: "rewrite" });
    ok(r.status === 409, "PATCH on sent comment → 409");
    const r2 = await DEL(annUrl(B, `/${b1}`));
    ok(r2.status === 409, "DELETE on sent comment → 409");
  }

  console.log("\n[resolve idempotency + batch completion]");
  {
    const r = await POST(annUrl(B, `/${b1}/resolve`));
    const j = await r.json();
    ok(r.status === 200 && j.ok && j.summary.resolvedInCurrentBatch === 1 && j.summary.sent === 1, "resolve sent → resolved; summary 1/2");
    const r2 = await POST(annUrl(B, `/${b1}/resolve`));
    const j2 = await r2.json();
    ok(r2.status === 200 && j2.ok && j2.summary.resolvedInCurrentBatch === 1, "second resolve of same id → ok, counts unchanged (idempotent)");
    const r3 = await POST(annUrl(B, `/${b2}/resolve`));
    const j3 = await r3.json();
    ok(j3.summary.currentBatchId === null && j3.summary.lastBatchId && j3.summary.sent === 0, "last resolve completes the batch: lastBatchId set, currentBatchId cleared");
  }

  console.log("\n[reopen]");
  {
    const r = await POST(annUrl(B, "/reopen"));
    const j = await r.json();
    ok(r.status === 200 && j.reopened === 2, "reopen recalls the whole last batch");
    const list = await GET(annUrl(B, "?state=all"));
    ok(list.comments.every((c) => c.state === "draft" && c.batchId === null && c.sentAt === null && c.resolvedAt === null), "reopened comments are clean drafts (batchId/sentAt/resolvedAt reset)");
    ok(list.summary.lastBatchId === null && list.summary.draft === 2, "manifest lastBatchId cleared");
    const r2 = await POST(annUrl(B, "/reopen"));
    ok(r2.status === 409, "reopen with no last batch → 409");
    // New sends always mint a fresh batch id.
    const j3 = await (await POST(annUrl(B, "/send"))).json();
    ok(j3.sent === 2 && /^b_/.test(j3.batchId), "re-send after reopen mints a fresh batchId");
  }

  console.log("\n[purge scope: only lastBatch resolved]");
  {
    // No drafts yet → send is a no-op and must NOT dispatch.
    const j0 = await (await POST(annUrl(C, "/send"))).json();
    ok(j0.ok && j0.sent === 0, "send with no drafts → {ok, sent:0}");
    await sleep(300);
    ok(!capturePane(C).includes("/hadron-review"), "no-draft send did not dispatch send-keys");

    const c1 = (await (await POST(annUrl(C), { path: "c.md", body: "one" })).json()).comment.id;
    const c2 = (await (await POST(annUrl(C), { path: "c.md", body: "two" })).json()).comment.id;
    await POST(annUrl(C, "/send"));                 // batch A
    await POST(annUrl(C, `/${c1}/resolve`));        // A incomplete → lastBatchId stays null
    const c3 = (await (await POST(annUrl(C), { path: "c.md", body: "three" })).json()).comment.id;
    await POST(annUrl(C, "/send"));                 // batch B — nothing purged (no lastBatch)
    let list = await GET(annUrl(C, "?state=all"));
    ok(list.comments.length === 3, "send with no fully-resolved last batch purges nothing");
    await POST(annUrl(C, `/${c2}/resolve`));        // A leftovers done
    await POST(annUrl(C, `/${c3}/resolve`));        // B complete → lastBatchId = B
    const c4 = (await (await POST(annUrl(C), { path: "c.md", body: "four" })).json()).comment.id;
    await POST(annUrl(C, "/send"));                 // batch C — purges resolved ∩ batch B only
    list = await GET(annUrl(C, "?state=all"));
    const ids = list.comments.map((x) => x.id);
    ok(!ids.includes(c3), "next send purged the resolved last-batch comment");
    ok(ids.includes(c1) && ids.includes(c2) && ids.includes(c4), "resolved comments from OTHER batches survive the purge");
  }

  console.log("\n[dispatch failure + retry]");
  {
    execFileSync("tmux", ["kill-session", "-t", `hadron-${WS_NAME}-${D}`]);
    await POST(annUrl(D), { path: "d.md", body: "fix it" });
    const j = await (await POST(annUrl(D, "/send"))).json();
    ok(j.ok && j.sent === 1 && j.dispatchError, "send with dead tmux → batch committed (sent:1) + dispatchError returned");
    const list = await GET(annUrl(D, "?state=sent"));
    ok(list.comments.length === 1 && list.summary.dispatchError, "dispatchError persisted in manifest summary");
    const jr = await (await POST(annUrl(D, "/retry-dispatch"))).json();
    ok(jr.ok === false && jr.dispatchError, "retry while tmux still dead → ok:false + dispatchError");
    execFileSync("tmux", ["new-session", "-d", "-s", `hadron-${WS_NAME}-${D}`, "-x", "80", "-y", "24"]);
    const jr2 = await (await POST(annUrl(D, "/retry-dispatch"))).json();
    ok(jr2.ok === true && jr2.summary.dispatchError === null, "retry after tmux back → ok, dispatchError cleared");
    await sleep(400);
    ok(capturePane(D).includes("/hadron-review"), "retry re-sent /hadron-review into the pane");
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    if (server) try { server.kill("SIGKILL"); } catch {}
    killTmux();
    try { rmSync(WS, { recursive: true, force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  });
