/**
 * Permission cards (chat view, G4): server/dialog.js parses the dialog claude
 * is showing out of the pane (kind, title, sections, the real options with
 * their details, hints, cancel/amend) and POST /api/sessions/:id/dialog/answer
 * answers it at the REAL tmux boundary — digit / Escape / Tab + text / ↓ Enter
 * — bound to the dialog's key (409 when the dialog on screen is not the one
 * the answer was read from).
 *
 * Private tmux server (HADRON_TMUX_SOCKET) + a process actually NAMED claude
 * (test/e2e/fixtures/claude-m34.sh): it shows claude's own dialog text and logs
 * every key it gets. What reached "claude" is what is in the log.
 *
 * Run: node test/unit/test-dialog.js
 * Requires: tmux on PATH.
 */
import "./hadron-home.js";
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { parseDialog, DIALOG_MAX_BODY_LINES } from "../../server/dialog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const FIXDIR = join(__dirname, "fixtures", "state-detector");
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
}
const fixture = (name) => readFileSync(join(FIXDIR, `${name}.txt`), "utf-8").split("\n");

console.log("1. parser — the installed claude's dialogs (fixtures captured from 2.1.304)");
{
  const d = parseDialog(fixture("blocked-dialog-bash-v2"));
  ok(d && d.kind === "permission" && d.title === "Bash command", `Bash permission: kind ${d?.kind}, title "${d?.title}"`);
  ok(d.sections.some((s) => s.code && s.text === "rm -f zz.txt"), "the command is a code section");
  ok(d.question === "Do you want to proceed?", `question "${d.question}"`);
  ok(d.options.length === 4 && d.options.map((o) => o.n).join("") === "1234", `4 options numbered 1..4 (${d.options.length})`);
  ok(d.options[0].selected && d.options[0].label === "Yes" && d.options[3].label === "No", "option 1 (Yes) is the selected one, 4 is No");
  ok(d.options[1].detail === "/home/user/proj from this project", `option 2's continuation lines are its detail ("${d.options[1].detail}")`);
  ok(/auto mode/.test(d.options[2].label), "option 3 keeps its full label");
  ok(d.numbered === true && d.cancel === true && d.amend === true, "numbered, Esc cancels, Tab amends");
  ok(!d.sections.some((s) => /Tip: auto mode/.test(s.text)), "the Tip line is dropped");
  ok(/^[0-9a-f]{8}$/.test(d.key) && parseDialog(fixture("blocked-dialog-bash-v2")).key === d.key, `key is stable for the same screen (${d.key})`);
  {
    const again = fixture("blocked-dialog-bash-v2"); const i = again.findIndex((l) => /^─{8,}/.test(l));
    again.splice(i, 0, " ⎿  Removed zz.txt");
    const r = parseDialog(again);
    ok(/^[0-9a-f]{8}$/.test(d.render) && r.key === d.key && r.render !== d.render, `the same dialog under a new transcript line keeps its key and changes its render (${d.render} → ${r.render})`);
    const moved = fixture("blocked-dialog-trust-folder").map((l) => l.replace(/^ ❯ No, exit$/, "   No, exit").replace(/^   Yes, I trust this folder$/, " ❯ Yes, I trust this folder"));
    const t0 = parseDialog(fixture("blocked-dialog-trust-folder")), t1 = parseDialog(moved);
    ok(t1 && t1.key === t0.key && t1.options[1].selected && !t1.options[0].selected && t1.render !== t0.render, "a moved ❯ keeps the key (the selection is read fresh), changes the render");
    const noHint = fixture("blocked-dialog-trust-folder").filter((l) => !/Enter to confirm/.test(l));
    ok(parseDialog(noHint) === null, "an unnumbered ❯ list without claude's hint row is not a dialog (quoted output)");
  }
  const d2 = parseDialog(fixture("blocked-dialog-write-v2"));
  ok(d2 && d2.kind === "permission" && d2.options.length === 3 && d2.key !== d.key, `Write dialog: permission, 3 options, a different key (${d2?.options.length})`);
  const wf = parseDialog(fixture("blocked-dialog-webfetch-v2"));
  ok(wf && wf.kind === "permission" && wf.options.length === 3 && wf.cancel === true && wf.amend === false && /\(esc\)/.test(wf.options[2].label), `WebFetch: permission, 3 options, no hint line — Esc comes from the "(esc)" option, no amend (${wf?.kind})`);
  {
    const ar = parseDialog(fixture("blocked-dialog-ask-rule"));
    const code = ar?.sections.find((x) => x.code)?.text || "";
    ok(ar && ar.kind === "permission" && ar.title === "Bash command" && ar.question === "Do you want to proceed?", `"Ask rule … overrides auto mode" permission parses (${ar?.kind}, ${ar?.title})`);
    ok(ar && ar.options.map((o) => `${o.n}.${o.label.slice(0, 3)}`).join(" ") === "1.Yes 2.Yes 3.No" && ar.options[1].detail?.startsWith("/usr/bin/python3") && ar.cancel && ar.amend, `…three options, option 2's wrapped command as its detail, Esc + Tab (${ar?.options.map((o) => o.n).join(",")})`);
    ok(code.startsWith("R=/tmp/hooktest/repo2;") && !code.includes("│") && code.split("\n").length === 2, `…the command without the │ border claude draws down its edge (${code.slice(0, 30)})`);
    ok(ar && ar.sections.some((x) => !x.code && x.text.includes("Ask rule Bash(rm -rf *) overrides auto mode")), "…the ask-rule note is a text section");
  }
  const am = parseDialog(fixture("blocked-dialog-bash-amend"));
  ok(am && am.options[0] && /tell Claude what/.test(am.options[0].label) && am.options[0].text === true, `after Tab, option 1 is the text option ("${am?.options[0]?.label}")`);
  const q = parseDialog(fixture("blocked-dialog-question-v2"));
  ok(q && q.kind === "question" && q.options.length === 5, `AskUserQuestion: question, 5 options (${q?.kind} ${q?.options.length})`);
  ok(q.options[0].detail === "Prefer red" && q.options[3].text === true && q.options[4].text === true && q.options[4].sepAbove === true, "details under the colours, type/chat options flagged text, separator before 5");
  ok(q.cancel === true && q.amend === false, "Esc cancels, no amend");
  const p = parseDialog(fixture("blocked-dialog-plan-v2"));
  ok(p && p.kind === "plan" && p.options.length === 3, `plan approval: plan, 3 options (${p?.kind})`);
  ok(/shift\+tab to approve/.test(p.options[2].detail || ""), `option 3's continuation is its detail ("${p.options[2].detail}")`);
  ok(p.hints.some((h) => /ctrl\+g/.test(h)), "the ctrl+g hint survives as a hint");
  const t = parseDialog(fixture("blocked-dialog-trust-folder"));
  ok(t && t.kind === "select" && t.numbered === false && t.options.length === 2, `folder trust: select, unnumbered, 2 rows (${t?.kind} ${t?.numbered})`);
  ok(t.options[0].selected && /No, exit/.test(t.options[0].label) && /trust this folder/.test(t.options[1].label), "rows keep their text, ❯ marks the selected one");
  ok(t.cancel === true && !t.question, `Esc cancels; no question line ("${t.question}")`);
  ok(parseDialog(fixture("blocked-plan-approval"))?.kind === "plan" && parseDialog(fixture("blocked-selection-4options"))?.kind === "select", "older fixtures still parse (plan / select)");
  for (const n of readdirSync(FIXDIR).filter((f) => /^blocked-api-error|^blocked-allow-deny|^idle|^working/.test(f)).slice(0, 12)) {
    const r = parseDialog(fixture(n.replace(/\.txt$/, "")));
    ok(r === null, `${n} → null`);
  }
  const big = fixture("blocked-dialog-bash-v2");
  const i = big.findIndex((l) => /^\s*Bash command/.test(l));
  const padded = [...big.slice(0, i - 1), ...Array.from({ length: DIALOG_MAX_BODY_LINES + 20 }, (_, k) => ` filler line ${k}`), ...big.slice(i - 1)];
  const tb = parseDialog(padded);
  ok(tb && tb.options.length === 4 && tb.truncated !== true, "filler above the solid rule is dropped, not counted");
  const padded2 = [...big.slice(0, i + 1), ...Array.from({ length: DIALOG_MAX_BODY_LINES + 20 }, (_, k) => ` filler line ${k}`), ...big.slice(i + 1)];
  const tb2 = parseDialog(padded2);
  ok(tb2 && tb2.truncated === true && tb2.options.length === 4, `a body over ${DIALOG_MAX_BODY_LINES} lines is clipped and flagged truncated`);
  ok(JSON.stringify(tb2).length < 9000, `…and the wire form stays small (${JSON.stringify(tb2).length} bytes)`);
}

// ── the real boundary ──
const PORT = await new Promise((res, rej) => {
  const srv = createServer(); srv.on("error", rej);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const T = mkdtempSync(join(tmpdir(), "hadron-dialog-"));
const SOCK = join(T, "tmux.sock");
const HOME = join(T, "home");
const FIX = join(T, "bin");
const WS = join(T, "ws");
const LOG = join(T, "claude-keys.log");
const WS_NAME = WS.split("/").pop().replace(/[^a-zA-Z0-9_-]/g, "");
for (const d of [HOME, FIX, WS, join(WS, "a1"), join(WS, ".hadron")]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME, ".profile"), `export PATH="${FIX}:$PATH"\n`);
writeFileSync(join(HOME, ".bashrc"), `export PATH="${FIX}:$PATH"\n`);
const FIXTURE = join(FIX, "claude");
writeFileSync(FIXTURE, readFileSync(join(REPO, "test", "e2e", "fixtures", "claude-m34.sh"), "utf-8"));
chmodSync(FIXTURE, 0o755);
writeFileSync(join(WS, ".hadron", "config.json"), JSON.stringify({
  name: "dialog", groups: ["Workers"],
  launchers: { "cc-fix": { argv: [FIXTURE, LOG], kind: "claude" } },
}, null, 2));
const tenv = { ...process.env, PATH: `${FIX}:${process.env.PATH}`, HOME };
delete tenv.TMUX;
function tmuxS(args) { return execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: tenv }); }
function tmuxSafe(args) { try { return tmuxS(args).trim(); } catch { return null; } }
const paneOf = (id) => `hadron-${WS_NAME}-${id}`;
const paneCmd = (id) => tmuxSafe(["display-message", "-t", paneOf(id), "-p", "#{pane_current_command}"]);
const keysLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8") : "").split("\n").filter(Boolean);
let server, TOKEN, serverLog = "";
function bootServer() {
  const env = {
    ...process.env, PORT: String(PORT), HOME, SHELL: "/bin/bash", PATH: `${FIX}:${process.env.PATH}`,
    HADRON_TMUX_SOCKET: SOCK, HADRON_BOOT_ID: "dialog-boot", INVOCATION_ID: "", XPC_SERVICE_NAME: "",
    HADRON_DIALOG_ANSWER_GRACE_MS: "1500",   // 10 s in prod; the grace test should not take 10 s
  };
  delete env.TMUX; delete env.TMUX_PANE;
  server = spawn("node", [join(REPO, "server", "index.js"), WS], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { const h = await r.json(); if (h.pid === server.pid) return h; throw new Error(`port ${PORT} is owned by pid ${h.pid}`); }
    } catch (e) { if (/owned by/.test(e.message)) throw e; }
    await sleep(100);
  }
  throw new Error("server did not come up");
}
async function killServer() {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGKILL");
  await gone;
}
const H = () => ({ "Content-Type": "application/json", "x-hadron-token": TOKEN, Origin: BASE });
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const listed = async (id) => (await api("GET", "/api/sessions")).json.find((s) => s.id === id);
const anon = async (id) => (await (await fetch(`${BASE}/api/sessions`)).json()).find((s) => s.id === id);
const onDisk = (id) => JSON.parse(readFileSync(join(WS, ".hadron", "agents", `${id}.json`), "utf-8"));
const answer = (id, body) => api("POST", `/api/sessions/${id}/dialog/answer`, body);
const press = (id, keys) => api("POST", `/api/sessions/${id}/send-keys`, { keys, enter: false });
const dialogUp = (id, pred = () => true) => until(async () => { const s = await listed(id); return s?.state === "blocked" && s.dialog && pred(s.dialog) ? s.dialog : null; }, 12000);
const idleAgain = (id) => until(async () => { const s = await listed(id); return s?.state === "idle" && !s.dialog; }, 12000);

async function main() {
  bootServer();
  await waitForServer();
  TOKEN = readFileSync(join(WS, ".hadron", "token"), "utf-8").trim();
  const r = await api("POST", "/api/sessions", { name: "dl-a1", cwd: join(WS, "a1"), launchCommand: "cc-fix", group: "Workers", autostart: true });
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`);
  const id = r.json.id;
  tmuxSafe(["resize-window", "-t", paneOf(id), "-x", "130", "-y", "40"]);
  ok(await until(() => paneCmd(id) === "claude", 15000), `fixture runs in the pane as "claude" (${paneCmd(id)})`);

  console.log("\n2. the dialog on the wire");
  let d = await dialogUp(id);
  ok(d && d.kind === "permission" && d.title === "Bash command" && d.options.length === 4, `blocked with the parsed Bash dialog on the token-bearing list (${d?.kind} ${d?.options?.length})`);
  ok(d.at && !d.answeredAt, "…stamped `at`, not answered");
  ok((await listed(id)).blockReason === "Needs input", "blockReason stays Needs input");
  ok((await anon(id))?.dialog === undefined, "the anonymous list carries no dialog");
  ok(onDisk(id).dialog === undefined, "nothing on the record");
  const key = d.key;
  await sleep(2500);
  ok((await listed(id)).dialog?.key === key && (await listed(id)).dialog?.at === d.at, "the same screen keeps its key and `at` across captures");

  console.log("\n3. a stale key is refused, the right one types the digit");
  let a = await answer(id, { action: "option", n: 1, key: "00000000" });
  ok(a.status === 409 && /changed/.test(a.json.error) && a.json.dialog?.key === key && a.json.state === "blocked", `wrong key → 409 with the current dialog (${a.status} "${a.json.error}")`);
  ok(keysLog().length === 0, "…and nothing was typed");
  a = await answer(id, { action: "option", n: 2, key });
  ok(a.status === 200 && a.json.ok && a.json.n === 2 && /always allow/.test(a.json.label), `option 2 → 200 {n, label} (${a.status} ${JSON.stringify(a.json)})`);
  ok(await until(() => keysLog().join(",") === "2", 3000), `claude got exactly "2" (${keysLog().join(",")})`);
  ok(await idleAgain(id), "the pane is idle again and the dialog is gone from the wire");
  a = await answer(id, { action: "option", n: 1, key });
  ok(a.status === 409 && /not showing/.test(a.json.error) && a.json.dialog === null, `answering while idle → 409 (${a.status} "${a.json.error}")`);

  console.log("\n4. the same dialog again is the same key; a second answer is refused");
  await press(id, "D");
  d = await dialogUp(id);
  ok(d && d.key === key, `D brings the dialog back with the same key (${d?.key})`);
  a = await answer(id, { action: "option", n: 4, key });
  ok(a.status === 200, "option 4 (No) → 200");
  const b = await answer(id, { action: "option", n: 1, key });
  ok(b.status === 409 || b.status === 200 && false, `a second answer to the same dialog → 409 (${b.status} "${b.json.error}")`);
  ok(await until(() => keysLog().join(",") === "2,D,4", 3000), `keys so far: ${keysLog().join(",")}`);
  await idleAgain(id);

  console.log("\n5. cancel is Escape, amend is Tab + text + Enter, an option with text types both");
  await press(id, "D"); d = await dialogUp(id);
  a = await answer(id, { action: "cancel", key: d.key });
  ok(a.status === 200 && a.json.action === "cancel", "cancel → 200");
  ok(await until(() => keysLog().at(-1) === "ESC", 3000) && await idleAgain(id), `claude got ESC and is idle (${keysLog().at(-1)})`);
  await press(id, "D"); d = await dialogUp(id);
  a = await answer(id, { action: "amend", text: "只删 zz.txt，别碰别的", key: d.key });
  ok(a.status === 200 && a.json.action === "amend", "amend → 200");
  ok(await until(() => keysLog().at(-1) === "ENTER", 4000), "…ends with Enter");
  {
    const l = keysLog(); const i = l.lastIndexOf("TAB");
    const typed = l.slice(i + 1, -1).map((t) => t.replace(/^\$'(.*)'$/, "$1").replace(/^'(.*)'$/, "$1")).join("");
    ok(i > 0 && (typed.includes("zz.txt") || /\\u|\\x/.test(typed)), `Tab, then the text, then Enter (${l.slice(i).length} keys)`);
  }
  ok(await idleAgain(id), "idle again after the amendment");
  await press(id, "D"); d = await dialogUp(id);
  a = await answer(id, { action: "option", n: 1, text: "then list the dir", key: d.key });
  ok(a.status === 200, "option 1 + text → 200");
  ok(await until(() => { const l = keysLog(); const i = l.lastIndexOf("D"); return l[i + 1] === "1" && l.at(-1) === "ENTER" && l.length > i + 3; }, 4000), "digit first, then the text and Enter");
  await idleAgain(id);

  console.log("\n6. an unnumbered list moves the ❯ from where the PANE has it, then Enter");
  await press(id, "T");
  d = await dialogUp(id, (x) => x.numbered === false);
  ok(d && d.kind === "select" && d.options.length === 2 && d.options[0].selected, `folder-trust list on the wire (${d?.kind} ${d?.numbered})`);
  a = await answer(id, { action: "option", n: 2, key: d.key });
  ok(a.status === 200 && /trust this folder/.test(a.json.label), `row 2 → 200 "${a.json.label}"`);
  const afterT = () => { const l = keysLog(); return l.slice(l.lastIndexOf("T") + 1).join(","); };
  ok(await until(() => afterT() === "DOWN,ENTER", 4000), `claude got Down, Enter (${afterT()})`);
  ok(await idleAgain(id), "idle again");
  a = await answer(id, { action: "amend", text: "x", key: d.key });
  ok(a.status === 409, "amend while idle → 409");
  // the operator moves the ❯ in the terminal; the card still shows the dialog
  // it read — an answer must act on where the marker IS
  await press(id, "T"); d = await dialogUp(id, (x) => x.numbered === false);
  const trustKey = d.key, trustAt = d.at;
  await press(id, "\x1b[B");
  const moved = await dialogUp(id, (x) => x.key === trustKey && x.options[1].selected);
  ok(moved && moved.at === trustAt && !moved.options[0].selected, "↓ typed in the terminal: the wire shows the ❯ on row 2, same key, same showing");
  a = await answer(id, { action: "option", n: 1, key: trustKey });
  ok(a.status === 200 && /No, exit/.test(a.json.label), `row 1 answered from a card that saw the ❯ on row 1 → 200 "${a.json.label}"`);
  ok(await until(() => afterT() === "DOWN,UP,ENTER", 4000), `claude got ↓ (the terminal), then ↑ Enter — from the fresh read, not the stale copy (${afterT()})`);
  ok(await idleAgain(id), "idle again");

  console.log("\n6b. the same dialog drawn again right after an answer is a NEW showing");
  await press(id, "D"); d = await dialogUp(id);
  await press(id, "A");                                   // the fixture re-shows the dialog on the next answer, result line above
  a = await answer(id, { action: "option", n: 1, key: d.key });
  ok(a.status === 200, "answer 1 → 200");
  const second = await until(async () => { const s = await listed(id); const x = s?.state === "blocked" && s.dialog; return x && x.key === d.key && x.at !== d.at && !x.answeredAt ? x : null; }, 6000);
  ok(second, `the re-drawn dialog: same key, new \`at\`, not answered (${JSON.stringify((await listed(id)).dialog && { at: (await listed(id)).dialog.at, answeredAt: (await listed(id)).dialog.answeredAt })})`);
  a = await answer(id, { action: "option", n: 1, key: d.key });
  ok(a.status === 200, "…and it can be answered (200)");
  ok(await until(() => { const l = keysLog(); return l.slice(-3).join(",") === "A,1,1"; }, 4000) && await idleAgain(id), `claude got both answers (${keysLog().slice(-3).join(",")})`);

  console.log("\n6c. an answer claude never took: the same screen past the grace is answerable again");
  await press(id, "D"); d = await dialogUp(id);
  await press(id, "I");                                   // the fixture swallows the next answer
  a = await answer(id, { action: "option", n: 1, key: d.key });
  ok(a.status === 200 && (await listed(id)).dialog?.answeredAt, "answer 1 → 200, the wire says answered");
  const b1 = await answer(id, { action: "option", n: 1, key: d.key });
  ok(b1.status === 409 && /already answered/.test(b1.json.error), "right away a second answer is 409 (the keystroke may still be in flight)");
  const reopened = await until(async () => { const s = await listed(id); const x = s?.dialog; return x && x.key === d.key && !x.answeredAt && x.at !== d.at ? x : null; }, 6000);
  ok(reopened, "after the grace (1.5 s here) the unchanged screen is a new showing, not answered");
  a = await answer(id, { action: "option", n: 4, key: d.key });
  ok(a.status === 200 && await until(() => keysLog().slice(-3).join(",") === "I,1,4", 4000) && await idleAgain(id), `answerable again, claude got it (${keysLog().slice(-3).join(",")})`);

  console.log("\n6d. a failed send does not count as answered");
  await press(id, "D"); d = await dialogUp(id);
  tmuxS(["rename-session", "-t", paneOf(id), `gone-${id}`]);   // the pane is not where the route expects it: tmux fails
  a = await answer(id, { action: "cancel", key: d.key });
  tmuxS(["rename-session", "-t", `gone-${id}`, paneOf(id)]);
  ok(a.status === 500 && /tmux/.test(a.json.error) && a.json.dialog && !a.json.dialog.answeredAt, `tmux failure → 500 carrying the dialog, NOT answered (${a.status} "${a.json.error}")`);
  const errd = await until(async () => { const x = (await listed(id))?.dialog; return x && x.key === d.key && x.answerError && !x.answeredAt ? x : null; }, 6000);
  ok(errd, `the wire says why (${errd?.answerError})`);
  a = await answer(id, { action: "cancel", key: d.key });
  ok(a.status === 200 && await until(() => keysLog().at(-1) === "ESC", 4000) && await idleAgain(id), "a retry goes through (200, ESC, idle)");
  ok((await listed(id)).dialog == null, "answerError is gone with the dialog");

  console.log("\n6e. a Needs-input screen that is no dialog is counted, warned once, on the doctor row");
  await press(id, "M");
  ok(await until(async () => { const s = await listed(id); return s?.state === "blocked" && !s.dialog; }, 12000), "blocked with no dialog on the wire (the card hands over to the terminal)");
  const dr = await api("GET", "/api/doctor");
  const row = (dr.json.agents || []).find((x) => x.id === id);
  ok(row && ["yellow", "red"].includes(row.finding?.level) && /1 "Needs input" screen\(s\) the chat view could not read as a dialog/.test(row.finding.message), `doctor row not green, names the miss (${row?.finding?.level}: …${row?.finding?.message?.slice(-120)})`);
  ok(/dialog could not be parsed/.test(serverLog) && serverLog.split("dialog could not be parsed").length === 2, "server log warns once");
  await press(id, "1"); await idleAgain(id);

  console.log("\n7. validation");
  await press(id, "D"); d = await dialogUp(id);
  const bad = [
    [{ action: "nope", key: d.key }, "action"],
    [{ action: "option", n: 1 }, "key missing"],
    [{ action: "option", n: 1, key: "zz" }, "key shape"],
    [{ action: "option", key: d.key }, "n missing"],
    [{ action: "option", n: 0, key: d.key }, "n 0"],
    [{ action: "option", n: "1", key: d.key }, "n string"],
    [{ action: "amend", key: d.key }, "amend without text"],
    [{ action: "amend", text: "a\nb", key: d.key }, "text with a newline"],
    [{ action: "option", n: 1, text: "x".repeat(501), key: d.key }, "text too long (send-keys -l is reliable only for short text)"],
  ];
  for (const [body, what] of bad) { const x = await answer(id, body); ok(x.status === 400, `${what} → 400 (${x.status})`); }
  a = await answer(id, { action: "option", n: 9, key: d.key });
  ok(a.status === 409 && /no option 9/.test(a.json.error), `option 9 of 4 → 409 (${a.status})`);
  const amendTrust = await (async () => { await answer(id, { action: "cancel", key: d.key }); await idleAgain(id); await press(id, "T"); const t = await dialogUp(id, (x) => x.numbered === false); return answer(id, { action: "amend", text: "x", key: t.key }); })();
  ok(amendTrust.status === 409 && /cannot be amended/.test(amendTrust.json.error), `amend on a dialog without Tab → 409 (${amendTrust.status})`);
  const na = await fetch(`${BASE}/api/sessions/${id}/dialog/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", key: d.key }) });
  ok(na.status === 401 || na.status === 403, `no token → ${na.status}`);

  console.log("\n8. hygiene");
  ok(!serverLog.includes(TOKEN), "server log carries no token");
  ok(onDisk(id).dialog === undefined, "still nothing on the record");
}

try {
  await main();
} catch (e) {
  failed++; console.error(`  ✗ unexpected: ${e.stack || e}`);
} finally {
  await killServer();
  tmuxSafe(["kill-server"]);
  rmSync(T, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
