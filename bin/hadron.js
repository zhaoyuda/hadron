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
import { gitInfo, packageVersion, short } from "../server/provenance.js";

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

function ago(iso) {
  const ms = Date.now() - Date.parse(iso || "");
  if (!(ms >= 0)) return "unknown time ago";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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
const BOOLEAN_FLAGS = new Set(["json", "archived", "raw", "no-enter", "start", "auto", "force"]);
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
      // force: paste even when the pane is a bare shell (default: the server
      // refuses — a shell would execute the text and the message would be lost).
      const out = await api("POST", `/api/sessions/${agent.id}/message`, { text, enter: !flags["no-enter"], force: !!flags.force });
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
    case "doctor": {
      // "If this machine reboots now, what comes back?" Read-only. The CLI does
      // the local checks itself (they must run even when the server is down);
      // per-agent findings come from the authenticated GET /api/doctor.
      const icon = { green: "✓", yellow: "⚠", red: "✗", na: "·" };
      const local = []; // { level, message }
      const cli = { version: packageVersion(REPO), repoRoot: REPO, ...gitInfo(REPO) };

      // 1. server reachable (unreachable = first finding, the rest still runs)
      let health = null, reachable = false;
      try {
        const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) { health = await r.json().catch(() => null); reachable = !!(health && health.ok); }
      } catch {}
      if (!reachable) local.push({ level: "red", message: `server unreachable on :${PORT} (set HADRON_PORT to change) — nothing can be checked live` });

      // 2. runtime.json present + parseable
      if (HADRON_DIR) {
        const rtPath = join(HADRON_DIR, "runtime.json");
        if (!existsSync(rtPath)) local.push({ level: reachable ? "yellow" : "na", message: "runtime.json absent (clean shutdown, or server never wrote it)" });
        else { try { JSON.parse(readFileSync(rtPath, "utf-8")); local.push({ level: "green", message: "runtime.json present and parseable" }); } catch { local.push({ level: "red", message: "runtime.json is corrupt (not JSON) — the CLI cannot discover the port" }); } }
      } else {
        local.push({ level: "yellow", message: "no .hadron/ found walking up from cwd — using defaults" });
      }

      // 3. provenance: server code vs this working tree
      if (reachable) {
        if (health.commit && cli.commit) {
          if (health.commit !== cli.commit) local.push({ level: "red", message: `server is running ${short(health.commit)} (started ${ago(health.startedAt)}), working tree is ${short(cli.commit)} — restart it` });
          else local.push({ level: "green", message: `server matches the working tree (${short(cli.commit)})` });
        } else local.push({ level: "yellow", message: "no git metadata to compare server vs working tree" });
        if (health.dirty) local.push({ level: "yellow", message: "server was started from a dirty tree — what runs is not any commit" });
        if (cli.dirty) local.push({ level: "yellow", message: "working tree has uncommitted changes" });
        // 4. managedBy: hand-started will not come back
        if (health.managedBy === "systemd") local.push({ level: "green", message: "server is managed by systemd (boot-restarts)" });
        else local.push({ level: "red", message: `server is ${health.managedBy || "hand-started"} — it will NOT restart after a reboot (run it under systemd)` });
      }

      // per-agent findings + caps (authenticated GET — send the token on this GET)
      let doctor = null;
      if (reachable) {
        try {
          const headers = TOKEN ? { "x-hadron-token": TOKEN } : {};
          const r = await fetch(`${BASE}/api/doctor`, { headers, signal: AbortSignal.timeout(8000) });
          if (r.status === 401) local.push({ level: "red", message: "GET /api/doctor rejected the token (401) — check .hadron/token" });
          else if (!r.ok) local.push({ level: "red", message: `GET /api/doctor failed (${r.status})` });
          else doctor = await r.json();
        } catch (e) { local.push({ level: "red", message: `GET /api/doctor errored — ${e.message}` }); }
      }

      const agents = (doctor && doctor.agents) || [];
      const reds = local.filter((f) => f.level === "red").length + agents.filter((a) => a.finding.level === "red").length;
      const yellows = local.filter((f) => f.level === "yellow").length + agents.filter((a) => a.finding.level === "yellow").length;

      if (flags.json) {
        console.log(JSON.stringify({ cli, server: health, local, doctor }, null, 2));
        process.exit(reds ? 1 : 0);
      }

      console.log("hadron doctor — if this machine reboots now, what comes back?\n");
      if (reachable) {
        const st = health.dirty ? " (dirty)" : health.commit ? " (clean)" : "";
        console.log(`server   ${short(health.commit)}${st}  pid ${health.pid}  ${health.managedBy || "hand-started"}  started ${ago(health.startedAt)}`);
      } else {
        console.log(`server   unreachable on :${PORT}`);
      }
      if (doctor && doctor.claudeCaps) {
        const c = doctor.claudeCaps;
        console.log(`caps     ${c.probed ? `claude --session-id: ${c.supportsSessionId ? "yes" : "no"}  --resume: ${c.resume ? "yes" : "no"}` : "claude not found on the server's PATH"}   (server-side probe)`);
        console.log(`boot     ${doctor.bootGeneration} (source: ${doctor.bootIdSource})`);
      }

      console.log("\nLocal:");
      for (const f of local) console.log(`  ${icon[f.level]} ${f.message}`);

      console.log(`\nAgents (${agents.length} live):`);
      if (!agents.length) console.log("  (none)");
      for (const a of agents) {
        console.log(`  ${icon[a.finding.level]} ${a.name}${a.group ? ` [${a.group}]` : ""}  ${a.paneCommand || "(no pane)"}  — ${a.finding.message}${a.finding.crossCheck ? `  [${a.finding.crossCheck}]` : ""}`);
        if (/^claude/i.test(a.paneCommand || "")) {
          console.log(`      tmux session PATH resolves claude to: ${a.pathResolvesClaudeTo || "(not on the fresh-shell PATH)"}   (a shell rc file may change it)`);
        }
      }

      const verdict = reds ? "FAIL" : yellows ? "OK (with warnings)" : "OK";
      console.log(`\n${reds} red, ${yellows} yellow  →  ${verdict}`);
      if (reds) process.exit(1);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      // Provenance gate: is the server on :PORT running the code in this
      // working tree? Exit 1 on mismatch, dirty tree, or whenever the server's
      // provenance cannot actually be verified (unreachable, error, malformed,
      // older build) — a gate that passes without comparing is not a gate.
      const cli = { version: packageVersion(REPO), repoRoot: REPO, ...gitInfo(REPO) };
      let srv = null, status = "ok", detail = "";
      try {
        const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) { status = "error"; detail = `HTTP ${r.status}`; }
        else {
          try { srv = await r.json(); } catch { status = "malformed"; detail = "response is not JSON"; }
          if (srv && (typeof srv !== "object" || srv.ok !== true)) { status = "malformed"; detail = "not a Hadron health response"; srv = null; }
          else if (srv && !srv.commit && !srv.version) { status = "no-provenance"; detail = "server predates provenance reporting"; }
        }
      } catch (e) {
        status = e && e.name === "TimeoutError" ? "timeout" : "unreachable";
        detail = status === "timeout" ? "no response within 5s" : `nothing listening on :${PORT} (set HADRON_PORT to change)`;
      }
      const problems = [];
      if (status !== "ok") problems.push(`server provenance not verified — ${status}: ${detail}${status === "no-provenance" ? " — restart it" : ""}`);
      else if (srv.commit && cli.commit) {
        if (srv.commit !== cli.commit) problems.push(`server is running ${short(srv.commit)} (started ${ago(srv.startedAt)}), working tree is ${short(cli.commit)} — restart it`);
      } else if (srv.version !== cli.version) {
        problems.push(`no git metadata to compare commits; server version ${srv.version || "?"} (started ${ago(srv.startedAt)}) ≠ working tree ${cli.version || "?"} — restart it`);
      } else problems.push(`no git metadata on ${!cli.commit && !srv.commit ? "either side" : !cli.commit ? "the CLI side" : "the server side"} — only package versions compared (both ${cli.version || "?"})`);
      if (srv && srv.dirty) problems.push(`server was started from a dirty tree (${short(srv.commit)}+local edits) — what runs is not any commit`);
      if (cli.dirty) problems.push("working tree has uncommitted changes");
      // "versions match, no commits" is informational only — it must not fail the gate.
      const blocking = problems.filter((p) => !p.startsWith("no git metadata on "));
      if (flags.json) { console.log(JSON.stringify({ cli, server: srv, status, problems }, null, 2)); if (blocking.length) process.exit(1); break; }
      const state = (g) => g.dirty === null ? "" : g.dirty ? " (dirty)" : " (clean)";
      console.log(`hadron ${cli.version || "?"}`);
      console.log(`cli:    ${short(cli.commit)}${state(cli)}  ${cli.repoRoot}`);
      if (status !== "ok") console.log(`server: ${status} on :${PORT} — ${detail}`);
      else console.log(`server: ${short(srv.commit)}${state(srv)}  started ${ago(srv.startedAt)}, pid ${srv.pid}, ${srv.managedBy || "hand-started"}${srv.repoRoot && srv.repoRoot !== cli.repoRoot ? `, from ${srv.repoRoot}` : ""}`);
      for (const p of problems) console.error(`${blocking.includes(p) ? "⚠" : "ℹ"} ${p}`);
      if (blocking.length) process.exit(1);
      break;
    }
    default: {
      const known = cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h";
      if (!known) console.error(`hadron: unknown command "${cmd}"\n`);
      (known ? console.log : console.error)(`hadron — manage Hadron agents from the terminal

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
  hadron doctor [--json]                   "if this machine reboots now, what comes back?" —
                                           server provenance/managedBy + per-agent resume health;
                                           exit 1 on any red row or red summary item
  hadron version [--json]                  CLI vs server provenance (commit/dirty/managedBy);
                                           exit 1 when the server is stale, a tree is dirty, or
                                           the server could not be verified (down/timeout/older)
  hadron skills install                    symlink operation skills into ~/.claude/skills/ (additive)
  hadron skills sync                       like install, but also prune our own dead links
  hadron skills [status|uninstall]
  hadron message <name|id> "text" [--no-enter] [--raw] [--force]
                                           deliver a prompt to a running agent — reliable for
                                           multiline/special chars (tmux buffer paste); '-' or
                                           piped stdin reads the text from stdin. Sent from inside
                                           a hadron agent session, the text is prefixed with a
                                           sender-attribution line (--raw suppresses it).
                                           Refused when the agent's pane is a bare shell
                                           (agent exited) — --force pastes anyway
  hadron send <name|id> "keys"             low-level: type raw keys into a pane (single short line)

Targets accept an agent id or its exact name (case-insensitive); ambiguous
names list the candidates and exit. Permanent deletion is deliberately not a
CLI verb — use the dashboard (Agents → Delete Agent).

Env: HADRON_PORT / HADRON_TOKEN override; otherwise both are read from the
nearest .hadron/ (runtime.json + token) walking up from cwd; port defaults to 3000.`);
      if (!known) process.exit(1);
    }
  }
}

main();
