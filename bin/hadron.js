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

const PORT = process.env.HADRON_PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function findToken() {
  if (process.env.HADRON_TOKEN) return process.env.HADRON_TOKEN;
  let dir = process.cwd();
  while (true) {
    const t = join(dir, ".hadron", "token");
    if (existsSync(t)) {
      try { return readFileSync(t, "utf-8").trim(); } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const TOKEN = findToken();

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
      if (flags.json) console.log(JSON.stringify(me, null, 2));
      else printAgent(me);
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
  hadron send <id> "keys"                  low-level: type keys into a pane

Env: HADRON_PORT (default 3000), HADRON_TOKEN (else read from .hadron/token)`);
  }
}

main();
