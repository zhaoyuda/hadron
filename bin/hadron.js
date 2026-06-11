#!/usr/bin/env node
/**
 * hadron — thin CLI over the Hadron HTTP API.
 *
 * Skills (and humans) call this instead of raw curl. It reads the workspace token
 * from `.hadron/token` (walking up from cwd) and self-identifies the current agent
 * by asking the SERVER to resolve its tmux session — it never reverse-engineers ids.
 */
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
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
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) { flags[key] = true; }
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
      const id = positional[0];
      const keys = positional[1];
      if (!id || keys === undefined) die("usage: hadron send <id> \"keys\"");
      await api("POST", `/api/sessions/${id}/send-keys`, { keys });
      console.log("sent");
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
          const suggested = await api("GET", `/api/files/suggest?agentId=${encodeURIComponent(me.id)}&cwd=${encodeURIComponent(me.cwd || "")}`);
          paths = suggested.filter((f) => f.score > 0).map((f) => f.path);
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
  hadron ls [--json]                       list all agents
  hadron whoami [--json]                   show the current agent (resolved by the server)
  hadron spawn <name> [flags]              create an agent
       --group G  --task "..."  --cwd path
       --launch claude|codex|shell  --start  --related a,b  --artifact p
  hadron artifacts add [--auto | <path...>]  attach files to the current agent
  hadron artifacts ls                      list the current agent's artifacts
  hadron notes [show|set "..."|append "..."]
  hadron annotations ls [--json]           list pending review comments for the current agent
  hadron annotations resolve <id>          mark a review comment done
  hadron skills install                    symlink operation skills into ~/.claude/skills/ (additive)
  hadron skills sync                       like install, but also prune our own dead links
  hadron skills [status|uninstall]
  hadron send <id> "keys"                  low-level: type keys into a pane

Env: HADRON_PORT / HADRON_TOKEN override; otherwise both are read from the
nearest .hadron/ (runtime.json + token) walking up from cwd; port defaults to 3000.`);
  }
}

main();
