#!/usr/bin/env node
/**
 * hadron — thin CLI over the Hadron HTTP API.
 *
 * Skills (and humans) call this instead of raw curl. It reads the workspace token
 * from `.hadron/token` (walking up from cwd) and self-identifies the current agent
 * by asking the SERVER to resolve its tmux session — it never reverse-engineers ids.
 */
import { execFileSync } from "child_process";
import { readFileSync, existsSync, writeSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { syncSkills, removeSkills, skillsStatus, userSkillsDir } from "../server/skills.js";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// Find the nearest `.hadron/` dir walking up from cwd. Token AND port are both read
// from THIS dir so they're always a matched pair (right server → right token), which
// matters in multi-workspace setups where each workspace runs its own server/port.
function findHadronDir() {
  let dir = process.cwd();
  while (true) {
    const h = join(dir, ".hadron");
    if (existsSync(join(h, "token"))) return h;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const HADRON_DIR = findHadronDir();

function findToken() {
  if (process.env.HADRON_TOKEN) return process.env.HADRON_TOKEN;
  if (HADRON_DIR) {
    try { return readFileSync(join(HADRON_DIR, "token"), "utf-8").trim(); } catch {}
  }
  return null;
}

// Port resolution mirrors token discovery: explicit env override → the server's
// own record in the same `.hadron/` (handles pre-existing sessions + restarts the
// per-session env stamp can't) → :3000 default. runtime.json is only trusted if
// the pid it names is still alive — the server deletes it on clean exit, but a
// crash/SIGKILL skips cleanup, and a stale port would misdirect the CLI (or, if
// the port got reused, send the token to the wrong server).
function findPort() {
  if (process.env.HADRON_PORT) return process.env.HADRON_PORT;
  if (HADRON_DIR) {
    try {
      const rt = JSON.parse(readFileSync(join(HADRON_DIR, "runtime.json"), "utf-8"));
      if (rt && rt.port && rt.pid) {
        process.kill(rt.pid, 0); // throws if the process is gone
        return rt.port;
      }
    } catch {}
  }
  return 3000;
}

const TOKEN = findToken();
const PORT = findPort();
const BASE = `http://127.0.0.1:${PORT}`;

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    if (!TOKEN) die("No Hadron token found (.hadron/token). Are you inside a Hadron workspace?");
    headers["x-hadron-token"] = TOKEN;
  }
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    die(`Cannot reach Hadron — is the server running on :${PORT}? (set HADRON_PORT to change)`);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const detail = json && json.error ? json.error : res.statusText;
    die(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return json;
}

function currentTmuxSession() {
  if (!process.env.TMUX) return null;
  try {
    return execFileSync("tmux", ["display-message", "-p", "#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function whoami() {
  const sess = currentTmuxSession();
  if (!sess) die("Not inside a tmux pane — can't determine which agent you are.");
  return api("GET", `/api/whoami?tmuxSession=${encodeURIComponent(sess)}`);
}

// Non-fatal identity probe: null when not inside a hadron agent session (plain
// shell, foreign tmux, server can't map it). Verbs that merely ADAPT to being an
// agent (message attribution, close-self notice) use this; verbs that REQUIRE
// self-identity (no-target pin/close) keep the fatal whoami().
async function whoamiSoft() {
  const sess = currentTmuxSession();
  if (!sess) return null;
  try {
    const res = await fetch(`${BASE}/api/whoami?tmuxSession=${encodeURIComponent(sess)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Name→id resolution for every verb that takes a target. Exact id wins; else
// case-insensitive exact name match. Ambiguous or unknown → exit 1 with the
// candidates — never partial/fuzzy matching (a wrong guess messages/kills the
// wrong agent).
async function resolveTarget(arg, { archived = false } = {}) {
  const list = await api("GET", archived ? "/api/sessions/archived" : "/api/sessions");
  const byId = list.find((a) => a.id === arg);
  if (byId) return byId;
  const wanted = String(arg).toLowerCase();
  const byName = list.filter((a) => (a.name || "").toLowerCase() === wanted);
  if (byName.length === 1) return byName[0];
  const kind = archived ? "archived agent" : "agent";
  if (byName.length > 1) {
    die(`"${arg}" is ambiguous — ${byName.length} ${kind}s share that name:\n${byName.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`);
  }
  const known = list.map((a) => `  ${a.id}  ${a.name}`).join("\n");
  die(`no ${kind} matches "${arg}"${list.length ? ` — known ${kind}s:\n${known}` : ""}`);
}

// Target arg → agent; no arg → self (must be inside a hadron agent session).
async function resolveTargetOrSelf(arg, opts) {
  if (arg !== undefined) return resolveTarget(arg, opts);
  return whoami();
}

// ── skills linking (shared logic in ../server/skills.js) ──
// The skill SET is scanned from the repo, so adding a new skill needs no code change.
// `install` is additive (create missing); `sync` also prunes our own dead links.
function reportEvent(kind, name, dest) {
  if (kind === "link") console.log(`  link   ${name} → ${dest}`);
  else if (kind === "prune") console.log(`  prune  ${name} (target gone)`);
  else if (kind === "unlink") console.log(`  unlink ${name}`);
  else if (kind === "skip") console.error(`  skip   ${name} — ${dest} exists and isn't our link; leaving it untouched`);
}

function skillsSync({ prune }) {
  const res = syncSkills(REPO, { prune, onEvent: reportEvent });
  const parts = [`${res.linked} linked`, `${res.already} already`, `${res.skipped} skipped`];
  if (prune) parts.push(`${res.pruned} pruned`);
  console.log(`\nskills ${prune ? "sync" : "install"}: ${parts.join(", ")}`);
  if (res.linked || res.already) {
    const linked = skillsStatus(REPO).filter((s) => s.state === "linked").map((s) => "/" + s.name);
    if (linked.length) console.log(`Agents in any repo can use ${linked.join(", ")}.`);
  }
}

function skillsUninstall() {
  const { removed } = removeSkills(REPO, { onEvent: reportEvent });
  console.log(`\nskills uninstall: ${removed} removed`);
}

function printSkillsStatus() {
  for (const s of skillsStatus(REPO)) {
    const dest = join(userSkillsDir(), s.name);
    console.log(`  ${s.name}: ${s.state}${s.state === "conflict" ? ` (${dest} exists, not our link)` : ""}`);
  }
}

// ── flag parsing ──
// Presence-only flags must be declared here or they swallow the next positional
// (`hadron message --raw "Beta Two" hi` would resolve "hi" as the target).
const BOOLEAN_FLAGS = new Set(["json", "archived", "raw", "no-enter", "start", "auto"]);
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { flags, positional };
}

function printAgent(a) {
  console.log(`${a.name} (${a.id})  [${a.group}]  ${a.state}${a.substatus ? ` · ${a.substatus.type}` : ""}`);
  if (a.task) console.log(`  task: ${a.task}`);
  if (a.cwd) console.log(`  cwd: ${a.cwd}`);
  if (a.artifacts && a.artifacts.length) console.log(`  artifacts: ${a.artifacts.map((x) => x.label || x.value).join(", ")}`);
  if (a.relatedAgents && a.relatedAgents.length) console.log(`  related: ${a.relatedAgents.join(", ")}`);
  if (a.notes) console.log(`  notes: ${a.notes.split("\n")[0]}${a.notes.includes("\n") ? " …" : ""}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);

  switch (cmd) {
    case "ls": {
      if (flags.archived) {
        const list = await api("GET", "/api/sessions/archived");
        if (flags.json) { console.log(JSON.stringify(list, null, 2)); break; }
        if (!list.length) { console.log("no archived agents"); break; }
        for (const a of list) console.log(`${a.id}  ${a.name}  [${a.group}]  archived ${a.archivedAt || "?"}`);
        break;
      }
      const list = await api("GET", "/api/sessions");
      if (flags.json) { console.log(JSON.stringify(list, null, 2)); break; }
      for (const a of list) printAgent(a);
      break;
    }
    case "whoami": {
      const me = await whoami();
      if (flags.json) { console.log(JSON.stringify(me, null, 2)); break; }
      printAgent(me);
      // Surface unfinished review comments — best-effort, silent on any failure
      // (a whoami must never die because the annotations endpoint hiccuped).
      try {
        const r = await fetch(`${BASE}/api/sessions/${me.id}/annotations?state=sent`);
        if (r.ok) {
          const { comments } = await r.json();
          const n = (comments || []).length;
          if (n > 0) console.log(`  pending review comments: ${n} (run /hadron-review)`);
        }
      } catch {}
      break;
    }
    case "spawn": {
      const name = positional[0];
      if (!name) die("usage: hadron spawn <name> [--group G] [--task \"...\"] [--cwd path] [--launch claude|codex|shell] [--start] [--related a,b] [--artifact p]");
      const body = { name };
      if (flags.group) body.group = flags.group;
      if (flags.task) body.task = flags.task;
      if (flags.cwd) body.cwd = flags.cwd;
      if (flags.launch) body.launchCommand = flags.launch;
      if (flags.start) body.autostart = true;
      const created = await api("POST", "/api/sessions", body);
      // related/artifacts via append endpoints (never PATCH-the-array)
      if (flags.related) {
        for (const r of String(flags.related).split(",").map((s) => s.trim()).filter(Boolean)) {
          await api("POST", `/api/sessions/${created.id}/related`, { related: r });
        }
      }
      if (flags.artifact) {
        for (const p of String(flags.artifact).split(",").map((s) => s.trim()).filter(Boolean)) {
          await api("POST", `/api/sessions/${created.id}/artifacts`, { type: "file", value: p });
        }
      }
      console.log(`spawned ${created.name} (${created.id})${flags.start ? " — launching" : ""}`);
      break;
    }
    case "skills": {
      const sub = positional[0] || "status";
      if (sub === "install") { skillsSync({ prune: false }); break; }
      if (sub === "sync") { skillsSync({ prune: true }); break; }
      if (sub === "uninstall") { skillsUninstall(); break; }
      if (sub === "status") { printSkillsStatus(); break; }
      die("usage: hadron skills <install|sync|uninstall|status>");
      break;
    }
    case "send": {
      const target = positional[0];
      const keys = positional[1];
      if (!target || keys === undefined) die("usage: hadron send <name|id> \"keys\"");
      const agent = await resolveTarget(target);
      await api("POST", `/api/sessions/${agent.id}/send-keys`, { keys });
      console.log("sent");
      break;
    }
    case "message": {
      const target = positional[0];
      let text = positional[1];
      // `-` (or no positional) + piped stdin → read the whole prompt from stdin,
      // so `cat brief.md | hadron message t009` just works.
      if ((text === undefined || text === "-") && !process.stdin.isTTY) {
        text = readFileSync(0, "utf-8");
      }
      if (!target || text === undefined || text === "-") {
        die("usage: hadron message <name|id> \"text\" [--no-enter] [--raw]   (or: cat brief.md | hadron message <name|id> -)");
      }
      const agent = await resolveTarget(target);
      // Sender attribution: composed CLIENT-side, only when this CLI runs inside a
      // hadron agent session — a human at a plain shell delivers text unprefixed.
      // --raw suppresses it explicitly. The server endpoint stays untouched.
      if (!flags.raw) {
        const me = await whoamiSoft();
        if (me) text = `[hadron message from ${me.name} (${me.id})]\n${text}`;
      }
      const out = await api("POST", `/api/sessions/${agent.id}/message`, { text, enter: !flags["no-enter"] });
      console.log(`delivered ${out.bytes} bytes${flags["no-enter"] ? " (no Enter)" : ""}`);
      break;
    }
    case "pin":
    case "unpin": {
      const agent = await resolveTargetOrSelf(positional[0]);
      const pinned = cmd === "pin";
      await api("PATCH", `/api/sessions/${agent.id}`, { pinned });
      console.log(`${pinned ? "pinned" : "unpinned"} ${agent.name} (${agent.id})`);
      break;
    }
    case "close": {
      // Multiple targets allowed (bulk cleanup is the common real-world case).
      // Resolve ALL before archiving ANY — one ambiguous name must not leave the
      // batch half-done. De-dupe by id so "close twin twin" archives once.
      const agents = positional.length
        ? await Promise.all(positional.map((t) => resolveTarget(t)))
        : [await whoami()];
      const unique = [...new Map(agents.map((a) => [a.id, a])).values()];
      const me = await whoamiSoft();
      // Self goes LAST: archiving self kills the tmux session this CLI lives in,
      // which would abandon the rest of the batch.
      unique.sort((a, b) => (me && a.id === me.id ? 1 : 0) - (me && b.id === me.id ? 1 : 0));
      for (const agent of unique) {
        if (me && me.id === agent.id) {
          // The response may never make it back once tmux dies — say what's
          // happening BEFORE the request, with a synchronous write.
          writeSync(1, `archiving this agent (${agent.id}) — its tmux session will die now\n`);
        }
        await api("DELETE", `/api/sessions/${agent.id}`);
        console.log(`archived ${agent.name} (${agent.id}) — restore with: hadron restore ${agent.id}`);
      }
      break;
    }
    case "restore": {
      if (!positional.length) die("usage: hadron restore <name|id> [more...]");
      const agents = await Promise.all(positional.map((t) => resolveTarget(t, { archived: true })));
      for (const agent of [...new Map(agents.map((a) => [a.id, a])).values()]) {
        await api("POST", `/api/sessions/${agent.id}/restore`);
        console.log(`restored ${agent.name} (${agent.id})`);
      }
      break;
    }
    case "artifacts": {
      const sub = positional[0];
      const me = await whoami();
      if (sub === "ls") {
        for (const x of me.artifacts || []) console.log(`${x.label ? x.label + "  " : ""}${x.value}`);
        break;
      }
      if (sub === "add") {
        let paths = positional.slice(1);
        if (flags.auto) {
          // The server derives the scan root from agentId (agent cwd, jailed to the
          // workspace) and reports it as `base`; paths are relative to that base.
          const suggested = await api("GET", `/api/files/suggest?agentId=${encodeURIComponent(me.id)}`);
          // Join with the server's resolved scan root: a bare relative path is
          // ambiguous when the same filename exists at the workspace root too.
          const base = suggested.base || "";
          paths = (suggested.files || []).filter((f) => f.score > 0)
            .map((f) => (base && !f.path.startsWith("/")) ? `${base}/${f.path}` : f.path);
          if (!paths.length) die("no high-relevance files found to auto-add");
        }
        if (!paths.length) die("usage: hadron artifacts add [--auto | <path...>]");
        for (const p of paths) await api("POST", `/api/sessions/${me.id}/artifacts`, { type: "file", value: p });
        console.log(`added ${paths.length} artifact(s): ${paths.join(", ")}`);
        break;
      }
      die("usage: hadron artifacts <ls|add>");
      break;
    }
    case "kernels": {
      const sub = positional[0] || "show";
      if (sub === "show") {
        const k = await api("GET", "/api/kernels");
        if (flags.json) { console.log(JSON.stringify(k, null, 2)); break; }
        const entries = Object.entries(k);
        if (!entries.length) { console.log("no kernels configured"); break; }
        for (const [rt, p] of entries) console.log(`${rt}: ${p}`);
        break;
      }
      if (sub === "set") {
        const updates = {};
        for (const rt of ["marimo", "jupyter"]) {
          if (flags[rt] === undefined) continue;
          if (typeof flags[rt] !== "string") die(`--${rt} needs a path`);
          const p = flags[rt].replace(/^~/, process.env.HOME || "");
          // Validate HERE: a path without bin/python3 makes the server resolve
          // the kernel to null and silently fall back to .venv/ — hard to debug.
          if (!existsSync(join(p, "bin", "python3"))) die(`${p} has no bin/python3 — not a usable environment`);
          updates[rt] = p;
        }
        if (!Object.keys(updates).length) die("usage: hadron kernels set [--marimo PATH] [--jupyter PATH]");
        // PATCH sends ONLY the updates; the server merges atomically. A client-side
        // GET→merge→PUT would lose a concurrent caller's runtime.
        const saved = await api("PATCH", "/api/kernels", updates);
        for (const [rt, p] of Object.entries(saved)) console.log(`${rt}: ${p}`);
        break;
      }
      die("usage: hadron kernels [show [--json] | set [--marimo PATH] [--jupyter PATH]]");
      break;
    }
    case "notes": {
      const sub = positional[0] || "show";
      const me = await whoami();
      if (sub === "show") { console.log(me.notes || "(no notes)"); break; }
      if (sub === "set") {
        await api("PATCH", `/api/sessions/${me.id}`, { notes: positional.slice(1).join(" ") });
        console.log("notes updated");
        break;
      }
      if (sub === "append") {
        const add = positional.slice(1).join(" ");
        const notes = me.notes ? `${me.notes}\n${add}` : add;
        await api("PATCH", `/api/sessions/${me.id}`, { notes });
        console.log("notes updated");
        break;
      }
      die("usage: hadron notes [show|set \"...\"|append \"...\"]");
      break;
    }
    case "annotations": {
      const sub = positional[0];
      if (sub === "ls") {
        const me = await whoami();
        const out = await api("GET", `/api/sessions/${me.id}/annotations?state=sent`);
        if (flags.json) { console.log(JSON.stringify(out, null, 2)); break; }
        if (!out.comments || !out.comments.length) { console.log("no pending review comments"); break; }
        for (const c of out.comments) {
          console.log(`[${c.id}] ${c.file} — ${c.locationText}`);
          console.log(`    ${String(c.body).split("\n").join("\n    ")}`);
        }
        break;
      }
      if (sub === "resolve") {
        const cid = positional[1];
        if (!cid) die("usage: hadron annotations resolve <id>");
        const me = await whoami();
        const out = await api("POST", `/api/sessions/${me.id}/annotations/${encodeURIComponent(cid)}/resolve`);
        const left = out.summary ? out.summary.sent : "?";
        console.log(`resolved ${cid} (${left} remaining)`);
        break;
      }
      die("usage: hadron annotations <ls [--json] | resolve <id>>");
      break;
    }
    default:
      console.log(`hadron — manage Hadron agents from the terminal

Commands:
  hadron ls [--json] [--archived]          list all agents (--archived: the archive instead)
  hadron whoami [--json]                   show the current agent (resolved by the server)
  hadron spawn <name> [flags]              create an agent
       --group G  --task "..."  --cwd path
       --launch claude|codex|shell|<custom>  --start  --related a,b  --artifact p
       (custom launchers are defined in .hadron/config.json "launchers" — see docs/CONFIGURATION.md)
  hadron pin [name|id]                     pin an agent to the deck's 📌 Pinned section (no arg = self)
  hadron unpin [name|id]                   unpin (no arg = self)
  hadron close [name|id ...]               archive agent(s): tmux dies, JSON kept (no arg = self;
                                           several targets allowed — self is archived last)
  hadron restore <name|id ...>             bring archived agent(s) back (searches the archive)
  hadron artifacts add [--auto | <path...>]  attach files to the current agent
  hadron artifacts ls                      list the current agent's artifacts
  hadron notes [show|set "..."|append "..."]
  hadron kernels [show [--json]]           show notebook kernel envs (marimo/jupyter)
  hadron kernels set --marimo PATH         set a kernel env (merges — the other runtime is
       [--jupyter PATH]                    kept; path must contain bin/python3)
  hadron annotations ls [--json]           list pending review comments for the current agent
  hadron annotations resolve <id>          mark a review comment done
  hadron skills install                    symlink operation skills into ~/.claude/skills/ (additive)
  hadron skills sync                       like install, but also prune our own dead links
  hadron skills [status|uninstall]
  hadron message <name|id> "text" [--no-enter] [--raw]
                                           deliver a prompt to a running agent — reliable for
                                           multiline/special chars (tmux buffer paste); `-` or
                                           piped stdin reads the text from stdin. Sent from inside
                                           a hadron agent session, the text is prefixed with a
                                           sender-attribution line (--raw suppresses it)
  hadron send <name|id> "keys"             low-level: type raw keys into a pane (single short line)

Targets accept an agent id or its exact name (case-insensitive); ambiguous
names list the candidates and exit. Permanent deletion is deliberately not a
CLI verb — use the dashboard (Agents → Delete Agent).

Env: HADRON_PORT / HADRON_TOKEN override; otherwise both are read from the
nearest .hadron/ (runtime.json + token) walking up from cwd; port defaults to 3000.`);
  }
}

main();
