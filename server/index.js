import express from "express";
import http from "http";
const { createServer } = http;
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";
import { execSync, execFileSync, spawn as cpSpawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, watch as fsWatch, chmodSync, unlinkSync, mkdtempSync, mkdirSync, rmSync, renameSync, realpathSync } from "fs";
import { connect as netConnect } from "net";
import { networkInterfaces, hostname, tmpdir } from "os";
import { URL } from "url";
import { randomBytes } from "crypto";
import { StateDetector, isShellCmd } from "./state-detector.js";
import { probeClaudeCaps, RuntimeTracker, performResume, BOOT } from "./resume.js";
import { randomUUID } from "crypto";
import { loadAgents, loadAgent, saveAgent, saveAgentLocked, archiveAgent, deleteAgent, initWorkspace, getWorkspaceDir, appendAgentField, removeAgentArtifact, isSelfWrite } from "./agent-store.js";
import { resolve } from "path";
import { tmux, tmuxSafe, isValidId, shellQuoteArgv, tmuxArgv } from "./tmux.js";
import { syncSkills } from "./skills.js";
import { collectProvenance } from "./provenance.js";
import {
  listAnnotations, createAnnotation, updateAnnotation, deleteAnnotation,
  sendAnnotations, resolveAnnotation, reopenAnnotations, retryDispatch,
} from "./annotations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);

// Auth state — populated in the listen() callback once the workspace (.hadron) exists.
let AUTH_TOKEN = null;

// Notebook proxies sit in front of tokenless marimo/jupyter servers (jupyter runs with
// XSRF off), so they MUST be defended like a mutating route. Token can't be required —
// the notebook's own JS fetches subresources/WS without it — but host+origin checks stop
// the real threats: CSRF from a page you visit and DNS-rebinding to a localhost notebook.
function proxyGuard(req, res, next) {
  if (!isAllowedHost(req.headers.host)) return res.status(403).send("host not allowed");
  if (!isAllowedOrigin(req.headers.origin)) return res.status(403).send("origin not allowed");
  next();
}

// Marimo reverse proxy — must be before express.json() to preserve raw body stream
app.use("/marimo-proxy/:port", proxyGuard, (req, res) => {
  const targetPort = parseInt(req.params.port);
  if (!targetPort) return res.status(400).send("invalid port");

  const targetPath = req.url || "/";
  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    res.status(502).send(`Marimo proxy error: ${err.message}`);
  });

  req.pipe(proxyReq, { end: true });
});

// Jupyter reverse proxy — must be before express.json() to preserve raw body stream
app.use("/jupyter-proxy/:port", proxyGuard, (req, res) => {
  const targetPort = parseInt(req.params.port);
  if (!targetPort) return res.status(400).send("invalid port");

  const targetPath = `/jupyter-proxy/${targetPort}${req.url || "/"}`;
  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    res.status(502).send(`Jupyter proxy error: ${err.message}`);
  });

  req.pipe(proxyReq, { end: true });
});

// JSON body parsing
app.use(express.json());

// Serve index.html with the workspace token injected, so the browser app can
// authenticate its own API/WS calls without the user ever copy-pasting a token.
app.get(["/", "/index.html"], (req, res, next) => {
  try {
    let html = readFileSync(join(__dirname, "..", "client", "index.html"), "utf-8");
    const inject = `<script>window.HADRON_TOKEN=${JSON.stringify(AUTH_TOKEN || "")};</script>`;
    html = html.includes("</head>") ? html.replace("</head>", `${inject}</head>`) : inject + html;
    // Revalidate the shell on every load so a new app.js is picked up without a hard-refresh.
    // (app.js itself is served by express.static with max-age=0, which already revalidates.)
    res.set("Cache-Control", "no-cache");
    res.type("html").send(html);
  } catch { next(); }
});

// Serve static files from client/
app.use(express.static(join(__dirname, "..", "client")));

// Serve xterm assets from node_modules
const nodeModules = join(__dirname, "..", "node_modules");
app.use("/xterm", express.static(join(nodeModules, "@xterm/xterm")));
app.use(
  "/xterm-addon-fit",
  express.static(join(nodeModules, "@xterm/addon-fit"))
);
app.use(
  "/xterm-addon-web-links",
  express.static(join(nodeModules, "@xterm/addon-web-links"))
);

// ═══ AUTH / ORIGIN GUARD ═══
// Loopback bind + auto-generated token + Origin/Host allowlist. This raises the bar
// from "any local process or any web page you visit can drive tmux send-keys (RCE)"
// to "needs the workspace token AND a same-origin request." GET/render routes stay
// open; mutating methods are guarded.
function loadOrCreateToken() {
  const tokenPath = join(getWorkspaceDir(), ".hadron", "token");
  try {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing) return existing;
  } catch {}
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch {}
  return token;
}

// Record which port THIS workspace's server is on, so the `hadron` CLI can discover
// it the same way it discovers the token — by walking up from an agent's cwd to the
// nearest `.hadron/`. This makes the CLI correct for pre-existing tmux sessions and
// across restarts, where the per-session env stamp (applyAgentEnv) can't reach. The
// pid lets the CLI tell a stale file (dead server) from a live one.
function runtimeFilePath() {
  return join(getWorkspaceDir(), ".hadron", "runtime.json");
}
function writeRuntimeFile() {
  try {
    writeFileSync(runtimeFilePath(), JSON.stringify({ port: PORT, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  } catch {}
}
function removeRuntimeFile() {
  try { unlinkSync(runtimeFilePath()); } catch {}
}

// When bound to all interfaces, the browser reaches us via a concrete IP (LAN/Tailscale),
// NOT "0.0.0.0" — so enumerate this machine's own addresses and allow those. The host
// check still rejects arbitrary Host headers (DNS-rebind to a domain won't match an IP),
// and the Origin check still gates cross-origin pages. HADRON_ALLOWED_HOSTS adds hostnames.
function ownAddresses() {
  const addrs = [];
  try {
    for (const iface of Object.values(networkInterfaces())) {
      for (const a of iface || []) addrs.push(a.address);
    }
  } catch {}
  return addrs;
}
function hostAllowlist() {
  const hosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, "localhost", "127.0.0.1"];
  if (HADRON_HOST && HADRON_HOST !== "127.0.0.1") {
    hosts.push(`${HADRON_HOST}:${PORT}`, HADRON_HOST);
    // 0.0.0.0/:: mean "all interfaces" — clients connect to a specific IP, so allow each.
    for (const ip of ownAddresses()) hosts.push(`${ip}:${PORT}`, ip, `[${ip}]:${PORT}`, `[${ip}]`);
    // Clients often reach the box by name (e.g. http://my-host:3000) rather than IP —
    // allow this machine's hostname and its short form. Custom DNS (Tailscale MagicDNS,
    // a reverse proxy domain) still goes through HADRON_ALLOWED_HOSTS.
    const hn = hostname();
    for (const name of new Set([hn, hn.split(".")[0]].filter(Boolean))) {
      hosts.push(name, `${name}:${PORT}`);
    }
  }
  for (const h of (process.env.HADRON_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    hosts.push(h, `${h}:${PORT}`);
  }
  // Hostnames are case-insensitive (DNS), and URL.host lowercases — so normalize
  // both the allowlist and the lookup, else a mixed-case hostname (e.g. "Mac")
  // stored verbatim never matches the lowercased Origin host and 403s.
  return new Set(hosts.map((h) => h.toLowerCase()));
}
function isAllowedHost(host) {
  return !!host && hostAllowlist().has(host.toLowerCase());
}
function isAllowedOrigin(origin) {
  if (!origin) return true; // CLI/curl send no Origin — token alone gates those
  try { return isAllowedHost(new URL(origin).host); } catch { return false; }
}

function requireAuth(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!isAllowedHost(req.headers.host)) return res.status(403).json({ error: "host not allowed" });
  if (!isAllowedOrigin(req.headers.origin)) return res.status(403).json({ error: "origin not allowed" });
  // `Authorization: Bearer <token>` accepted as an alias: it's the first header
  // every hand-written client tries, and rejecting it costs a debugging session
  // (same token, same check — no security delta).
  const bearer = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const token = req.headers["x-hadron-token"] || bearer || req.query.token;
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) return res.status(401).json({ error: "invalid or missing token" });
  next();
}
app.use("/api", requireAuth);

// ═══ SESSION MANAGEMENT ═══

const sessions = new Map();

// Autostart launch commands are a known table, NOT a free-form string — a string
// would be a shell footgun (and agent-supplied via the API). "shell" means no
// autostart. Custom launchers (e.g. a `cc-kimi` wrapper) come from
// .hadron/config.json `launchers` — filesystem-owned, so defining a command
// already requires workspace write access; the API only ever accepts a NAME.
// `kind: "claude"` marks a wrapper that IS Claude Code underneath, opting it
// into the claude-specific autostart path (--session-id injection / resume).
const BUILTIN_LAUNCHERS = {
  claude: { argv: ["claude"], kind: "claude" },
  codex: { argv: ["codex"] },
  shell: null,
};

function getLaunchers() {
  const table = { ...BUILTIN_LAUNCHERS };
  try {
    const config = JSON.parse(readFileSync(join(getWorkspaceDir(), ".hadron", "config.json"), "utf-8"));
    for (const [name, def] of Object.entries(config.launchers || {})) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(name)) continue;
      if (!def || !Array.isArray(def.argv) || def.argv.length === 0) continue;
      if (!def.argv.every((a) => typeof a === "string" && a.length > 0)) continue;
      table[name] = { argv: def.argv, kind: def.kind === "claude" ? "claude" : undefined };
    }
  } catch {}
  return table;
}
const launchLocks = new Set(); // ids currently autostarting (TOCTOU guard)

function tmuxSessionName(id) {
  return `${TMUX_PREFIX}-${id}`;
}

function getDefaultLaunchCommand() {
  try {
    const config = JSON.parse(readFileSync(join(getWorkspaceDir(), ".hadron", "config.json"), "utf-8"));
    if (config.launchCommand && getLaunchers()[config.launchCommand] !== undefined) return config.launchCommand;
  } catch {}
  return "claude";
}

// Strip control chars (newlines, ESC, etc.) so pasted terminal escapes / multiline
// task text can't alter what gets submitted when typed into the agent's prompt.
function sanitizeForKeystrokes(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

// Autostart: type ONLY the enum's launch command into the (detached) pane, then — as a
// SEPARATE literal step — type the task into the prompt. The task is never glued into a
// command string (no `claude "<task>"`), so quotes/newlines/$() in it stay inert data.
function autostartAgent(id, launchCommand, task) {
  const launcher = getLaunchers()[launchCommand];
  if (!launcher) return; // shell → nothing to launch
  if (launchLocks.has(id)) return;
  const session = sessions.get(id);
  if (session && session.autostartedAt) return; // once per creation
  launchLocks.add(id);
  const tmuxName = tmuxSessionName(id);
  (async () => {
    try {
      let cmdLine = shellQuoteArgv(launcher.argv); // preserves argv boundaries through the pane's shell
      // Claude-kind launches get a Hadron-chosen session id — the authoritative
      // source for later auto-resume (see resume.js). Server-generated UUID,
      // never user input, so gluing it into the command line is inert.
      if (launcher.kind === "claude" && (await probeClaudeCaps()).sessionId) {
        const sid = randomUUID();
        cmdLine += ` --session-id ${sid}`;
        runtimeTrackers.get(id)?.recordSpawnedSession(sid);
      }
      tmux(["send-keys", "-t", tmuxName, "--", cmdLine, "Enter"]);
      const clean = task ? sanitizeForKeystrokes(task) : "";
      if (clean) {
        await new Promise((r) => setTimeout(r, 4000)); // let the agent boot
        tmux(["send-keys", "-t", tmuxName, "-l", "--", clean]);
        await new Promise((r) => setTimeout(r, 300));
        tmux(["send-keys", "-t", tmuxName, "Enter"]);
      }
      if (session) {
        session.autostartedAt = new Date().toISOString();
        saveAgent(session);
      }
    } catch (e) {
      console.error(`[autostart] ${id}: ${e.message}`);
    } finally {
      launchLocks.delete(id);
    }
  })();
}

// Stamp Hadron's own port + token onto a freshly created tmux session so the
// bundled `hadron` CLI (bin/hadron.js) running inside it targets THIS server,
// regardless of the agent's cwd or which workspace/port it belongs to. Without
// this an agent on a non-3000 server falls back to :3000 with the wrong token.
//
// tmux does NOT import arbitrary client env into a session when its server is
// already running (the common multi-agent case), so passing `env` to new-session
// is unreliable. We set it explicitly with set-environment, then respawn the
// initial shell so it inherits the values. set-environment (not the global
// update-environment option) keeps it per-session and immune to later browser
// attaches clobbering it. respawn-pane is portable to our tmux >= 3.0 floor
// (the cleaner `new-session -e` is 3.2+).
function applyAgentEnv(tmuxName, cwd) {
  tmux(["set-environment", "-t", tmuxName, "HADRON_PORT", String(PORT)]);
  tmux(["set-environment", "-t", tmuxName, "HADRON_TOKEN", AUTH_TOKEN || ""]);
  tmuxSafe(["respawn-pane", "-k", "-t", tmuxName, "-c", cwd || WORKSPACE]);
}

// Let tmux size each window to the SMALLEST attached client so no client's view is ever
// clipped on the right. NOTE: never call `tmux resize-window` for this — it permanently flips
// the window to `window-size manual`, freezing it at one width. A window frozen wider than the
// browser's visible area is the cause of right-edge text clipping. Setting `window-size smallest`
// also un-freezes windows already pinned to manual by older versions.
function fitWindowToClients(tmuxName) {
  tmuxSafe(["set-window-option", "-t", tmuxName, "window-size", "smallest"]);
}

// Returns true when it had to CREATE the session — i.e. the pane is a brand-new
// shell (post-crash boot), the one moment auto-resume is allowed to trigger.
function ensureTmuxSession(sessionId, cwd) {
  const tmuxName = tmuxSessionName(sessionId);
  let created = false;
  try {
    tmux(["has-session", "-t", tmuxName]);
  } catch {
    tmux(["new-session", "-d", "-s", tmuxName, "-x", "80", "-y", "24", "-c", cwd || WORKSPACE]);
    applyAgentEnv(tmuxName, cwd || WORKSPACE);
    created = true;
  }
  fitWindowToClients(tmuxName);
  return created;
}

function killTmuxSession(sessionId) {
  const tmuxName = tmuxSessionName(sessionId);
  tmuxSafe(["kill-session", "-t", tmuxName]);
}

function tmuxSessionHasProcesses(sessionName) {
  try {
    const panes = tmux(["list-panes", "-t", sessionName, "-F", "#{pane_pid}"]).trim().split("\n");
    for (const pid of panes) {
      if (!pid) continue;
      try {
        const children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (children) return true;
      } catch {}
    }
  } catch {}
  return false;
}

const pendingOrphans = [];

function detectOrphanedTmuxSessions() {
  try {
    const output = tmuxSafe(["ls", "-F", "#{session_name}"]) || "";
    const tmuxSessions = output.trim().split("\n").filter(Boolean);
    const knownIds = new Set([...sessions.keys()]);
    pendingOrphans.length = 0;
    for (const name of tmuxSessions) {
      if (!name.startsWith(`${TMUX_PREFIX}-`)) continue;
      const suffix = name.slice(TMUX_PREFIX.length + 1);
      const subMatch = suffix.match(/^(.+)-(sh\d+|vim-\d+)$/);
      if (subMatch) {
        if (knownIds.has(subMatch[1])) {
          // Auto-kill orphaned vim sessions for known agents (editor leftovers)
          if (/vim-\d+$/.test(suffix)) {
            tmuxSafe(["kill-session", "-t", name]);
            console.log(`[cleanup] killed orphan vim session: ${name}`);
          }
          continue;
        }
      } else {
        if (knownIds.has(suffix)) continue;
      }
      const hasProcs = tmuxSessionHasProcesses(name);
      pendingOrphans.push({ tmuxSession: name, agentId: suffix, hasRunningProcesses: hasProcs });
    }
    if (pendingOrphans.length > 0) {
      console.log(`Found ${pendingOrphans.length} orphaned tmux session(s) — waiting for user decision`);
    }
  } catch {}
}

function ensureDefaults() {
  for (const s of sessions.values()) {
    if (!s.group) {
      s.group = "Workers";
      saveAgent(s);
    }
  }
}

// ═══ REST API ═══

// Ops visibility: live pty count is the early-warning signal for the macOS
// ptmx-exhaustion incident class (system cap 511 — the user finds out from
// iTerm failing to open unless we surface it first).
// Provenance (version/commit/dirty/managedBy…) is captured once at boot so a
// service still running last week's code says so — `hadron version` and
// `hadron doctor` compare it against the working tree.
let PROVENANCE = null;
app.get("/api/health", (req, res) => {
  res.json({ ok: true, livePtys: livePtys.size, liveSessions: sessions.size, wsClients: wss.clients.size, ...(PROVENANCE || {}) });
});

app.get("/api/workspace", (req, res) => {
  const configPath = join(getWorkspaceDir(), ".hadron", "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.cwd = getWorkspaceDir();
    res.json(config);
  } catch {
    res.json({ name: "workspace", cwd: getWorkspaceDir() });
  }
});

app.patch("/api/workspace", (req, res) => {
  const configPath = join(getWorkspaceDir(), ".hadron", "config.json");
  let config;
  try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch { config = { name: "workspace" }; }
  const { groups, groupConfig: gc } = req.body;
  if (groups !== undefined) config.groups = groups;
  if (gc !== undefined) config.groupConfig = gc;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json(config);
});

app.get("/api/sessions", (req, res) => {
  ensureDefaults();
  const sorted = [...sessions.values()].sort((a, b) => {
    const gc = (a.group || "").localeCompare(b.group || "");
    if (gc !== 0) return gc;
    const aSort = a.sortOrder ?? Infinity;
    const bSort = b.sortOrder ?? Infinity;
    if (aSort !== bSort) return aSort - bSort;
    return a.id.localeCompare(b.id);
  });
  res.json(sorted.map(resolvedSession));
});

// The wire form of a session: stored artifact values are canonical (workspace-
// relative when under the workspace — see canonicalArtifactPath), the client always
// sees them resolved to absolute. Every endpoint that hands a session (or its
// artifacts) to the client goes through this, so the client-side identity of an
// artifact is ONE form.
function resolvedSession(s) {
  return {
    ...s,
    artifacts: (s.artifacts || []).map(a => ({
      ...a,
      value: a.value ? resolveFilePath(a.value) : a.value
    }))
  };
}

// Server-owned identity resolution: the CLI passes its tmux session name (or pane id)
// and the server — which authoritatively knows TMUX_PREFIX — maps it to an agent.
// The CLI never reverse-engineers the id itself.
app.get("/api/whoami", (req, res) => {
  let sessionName = req.query.tmuxSession || "";
  const pane = req.query.pane;
  if (!sessionName && pane) {
    sessionName = tmuxSafe(["display-message", "-t", pane, "-p", "#{session_name}"]) || "";
  }
  if (!sessionName.startsWith(`${TMUX_PREFIX}-`)) {
    return res.status(404).json({ error: "not a hadron-managed tmux session", tmuxPrefix: TMUX_PREFIX });
  }
  const id = sessionName.slice(TMUX_PREFIX.length + 1).replace(/-(sh\d+)$/, "");
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "agent not found", id });
  res.json(session);
});

app.get("/api/sessions/archived", (req, res) => {
  const loaded = loadAgents();
  const archived = [];
  for (const [id, agent] of loaded) {
    if (agent.archived) archived.push(agent);
  }
  res.json(archived);
});

app.post("/api/sessions/:id/restore", (req, res) => {
  const { id } = req.params;
  const agent = loadAgent(id);
  if (!agent) return res.status(404).json({ error: "agent not found" });
  if (!agent.archived) return res.status(400).json({ error: "agent is not archived" });
  delete agent.archived;
  delete agent.archivedAt;
  agent.state = "idle";
  sessions.set(id, agent);
  saveAgent(agent);
  startMonitor(id);
  res.json(agent);
});

app.delete("/api/sessions/:id/permanent", (req, res) => {
  const { id } = req.params;
  const agent = loadAgent(id);
  if (!agent) return res.status(404).json({ error: "agent not found" });
  if (!agent.archived) return res.status(400).json({ error: "agent must be archived before permanent delete" });
  deleteAgent(id);
  res.json({ ok: true });
});

app.get("/api/orphans", (req, res) => {
  res.json(pendingOrphans);
});

app.post("/api/orphans/:tmuxSession/adopt", (req, res) => {
  const { tmuxSession } = req.params;
  const idx = pendingOrphans.findIndex(o => o.tmuxSession === tmuxSession);
  if (idx === -1) return res.status(404).json({ error: "orphan not found" });
  const orphan = pendingOrphans[idx];
  const id = orphan.agentId.replace(/-(sh\d+)$/, "");
  if (!isValidId(id)) return res.status(400).json({ error: "invalid agent id" });
  if (!sessions.has(id)) {
    const session = { id, name: id, group: "Workers", task: null, state: "idle", tmuxSession: tmuxSessionName(id), artifacts: [], relatedAgents: [], notes: "" };
    sessions.set(id, session);
    saveAgent(session);
    startMonitor(id);
  }
  pendingOrphans.splice(idx, 1);
  res.json({ ok: true, agentId: id });
});

app.post("/api/orphans/:tmuxSession/kill", (req, res) => {
  const { tmuxSession } = req.params;
  const idx = pendingOrphans.findIndex(o => o.tmuxSession === tmuxSession);
  if (idx === -1) return res.status(404).json({ error: "orphan not found" });
  tmuxSafe(["kill-session", "-t", tmuxSession]);
  pendingOrphans.splice(idx, 1);
  res.json({ ok: true });
});

app.post("/api/orphans/adopt-all", (req, res) => {
  const adopted = [];
  for (const orphan of [...pendingOrphans]) {
    const id = orphan.agentId.replace(/-(sh\d+)$/, "");
    if (!isValidId(id)) continue;
    if (!sessions.has(id)) {
      const session = { id, name: id, group: "Workers", task: null, state: "idle", tmuxSession: tmuxSessionName(id), artifacts: [], relatedAgents: [], notes: "" };
      sessions.set(id, session);
      saveAgent(session);
      startMonitor(id);
    }
    adopted.push(id);
  }
  pendingOrphans.length = 0;
  res.json({ ok: true, adopted });
});

app.post("/api/orphans/kill-all", (req, res) => {
  for (const orphan of [...pendingOrphans]) {
    tmuxSafe(["kill-session", "-t", orphan.tmuxSession]);
  }
  pendingOrphans.length = 0;
  res.json({ ok: true });
});

app.post("/api/sessions", (req, res) => {
  const { name, group, task, cwd, relatedAgents, artifacts, autostart } = req.body;
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!isValidId(id)) {
    return res.status(400).json({ error: "name must contain at least one alphanumeric character" });
  }
  if (sessions.has(id)) {
    return res.status(409).json({ error: "session already exists" });
  }

  // launchCommand is a table NAME (builtin or config-defined launcher), never an
  // arbitrary command string from the API.
  let launchCommand = req.body.launchCommand;
  const launchers = getLaunchers();
  if (launchCommand !== undefined && launchers[launchCommand] === undefined) {
    return res.status(400).json({ error: `launchCommand must be one of: ${Object.keys(launchers).join(", ")}` });
  }
  if (launchCommand === undefined) launchCommand = getDefaultLaunchCommand();

  // Validate cwd up front — never silently fall back.
  const cwdResult = validateCwd(cwd);
  if (cwdResult.error) return res.status(400).json({ error: cwdResult.error });

  // Seeded artifacts go through the same per-entry validation + canonicalization
  // as every other artifact write path — session creation is not a bypass.
  let seedArtifacts;
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) return res.status(400).json({ error: "artifacts must be an array" });
    seedArtifacts = [];
    for (const a of artifacts) {
      const out = validateAndCanonicalizeArtifact(a, cwdResult.cwd);
      if (out.error) return res.status(400).json({ error: `artifacts[${seedArtifacts.length}]: ${out.error}` });
      seedArtifacts.push(out.item);
    }
  }

  const existing = loadAgent(id);
  const session = existing
    ? { ...existing, state: "idle", blockReason: undefined }
    : {
        id,
        name,
        group: group || "Workers",
        task: task || null,
        tmuxSession: tmuxSessionName(id),
        artifacts: [],
        relatedAgents: [],
        notes: "",
        state: "idle",
      };
  // Same-name respawn must come back cleanly live (clear the soft-delete flags).
  delete session.archived;
  delete session.archivedAt;
  // A fresh create may seed cwd / initial arrays; a respawn keeps existing ones unless overridden.
  if (cwdResult.cwd !== undefined) session.cwd = cwdResult.cwd;
  if (launchCommand) session.launchCommand = launchCommand;
  if (!existing) {
    if (seedArtifacts) session.artifacts = seedArtifacts;
    if (Array.isArray(relatedAgents)) session.relatedAgents = relatedAgents;
    if (task !== undefined) session.task = task || null;
  }
  // A new creation re-arms autostart.
  if (!existing) delete session.autostartedAt;

  sessions.set(id, session);
  saveAgent(session);
  ensureTmuxSession(id, resolveAgentCwd(session));
  startMonitor(id);
  if (autostart) autostartAgent(id, launchCommand, session.task);
  res.status(201).json(resolvedSession(session));
});

app.patch("/api/sessions/:id", async (req, res) => {
  const { id } = req.params;
  if (!sessions.has(id)) {
    return res.status(404).json({ error: "session not found" });
  }
  const session = sessions.get(id);
  // The whole-array artifacts PATCH stays reachable (CLI / back-compat), so it must
  // be exactly as safe as the dedicated append/delete endpoints: every entry goes
  // through the same validation + canonicalization BEFORE anything mutates, and the
  // write below runs under the same per-agent lock. A garbage url value would
  // otherwise land in an iframe src / tab label forever, and an unlocked save
  // could interleave with append/delete's read-modify-write.
  let patchedArtifacts;
  if (req.body.artifacts !== undefined) {
    if (!Array.isArray(req.body.artifacts)) return res.status(400).json({ error: "artifacts must be an array" });
    patchedArtifacts = [];
    for (const a of req.body.artifacts) {
      const out = validateAndCanonicalizeArtifact(a, session.cwd);
      if (out.error) return res.status(400).json({ error: `artifacts[${patchedArtifacts.length}]: ${out.error}` });
      patchedArtifacts.push(out.item);
    }
  }
  // pinned is a strict boolean — anything else would leak into the deck's
  // section logic (truthy strings) and the persisted JSON.
  const { pinned } = req.body;
  if (pinned !== undefined && typeof pinned !== "boolean") {
    return res.status(400).json({ error: "pinned must be a boolean" });
  }
  const { state, blockReason, name, task } = req.body;
  if (state !== undefined) {
    const prevState = session.state;
    session.state = state;
    // Only suppress detector for intentional manual overrides, not auto-ack (done→idle)
    if (!(prevState === "done" && state === "idle")) {
      session._manualOverrideUntil = Date.now() + 5000;
    }
    const detector = monitors.get(id);
    if (detector) detector.resetCooldown();
  }
  if (blockReason !== undefined) session.blockReason = blockReason;
  if (name !== undefined) session.name = name;
  if (task !== undefined) session.task = task;
  const { notes, artifacts, relatedAgents, group, icon, sortOrder, deletable } = req.body;
  if (group !== undefined) session.group = group;
  if (icon !== undefined) session.icon = icon || null;
  if (notes !== undefined) session.notes = notes;
  if (artifacts !== undefined) session.artifacts = patchedArtifacts;
  if (relatedAgents !== undefined) session.relatedAgents = relatedAgents;
  if (sortOrder !== undefined) session.sortOrder = sortOrder;
  if (deletable !== undefined) session.deletable = deletable;
  if (pinned !== undefined) {
    if (pinned) session.pinned = true;
    else delete session.pinned; // stored form: absent unless true (like icon/sortOrder)
  }
  const shouldSave = [name, task, notes, artifacts, relatedAgents, group, icon, sortOrder, deletable, pinned].some(v => v !== undefined);
  if (shouldSave) await saveAgentLocked(session); // same lock as append/delete — no interleaved read-modify-write
  res.json(resolvedSession(session));
});

// Low-level pane-write primitive. Types `keys` literally (no shell) and optionally Enter.
app.post("/api/sessions/:id/send-keys", (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const { keys, enter = true } = req.body;
  if (typeof keys !== "string") return res.status(400).json({ error: "keys (string) required" });
  const tmuxName = tmuxSessionName(id);
  try {
    tmux(["send-keys", "-t", tmuxName, "-l", "--", keys]);
    if (enter) tmux(["send-keys", "-t", tmuxName, "Enter"]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reliable prompt delivery into a TUI input box. send-keys -l is flaky for long /
// multiline / special-char payloads ("not in a mode", partial delivery); a tmux
// buffer + bracketed paste (-p) is not, and the bracketing keeps multiline text
// from auto-submitting line by line. Enter goes as a separate keystroke after a
// short delay so the TUI has absorbed the paste before the submit.
app.post("/api/sessions/:id/message", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const { text, enter = true, force = false } = req.body;
  if (typeof text !== "string" || text.length === 0) {
    return res.status(400).json({ error: "text (non-empty string) required" });
  }
  if (typeof force !== "boolean") return res.status(400).json({ error: "force must be a boolean" });
  const tmuxName = tmuxSessionName(id);
  if (tmuxSafe(["has-session", "-t", tmuxName]) === null) {
    return res.status(409).json({ error: `agent tmux session ${tmuxName} is not running` });
  }
  // A message is a prompt for the agent. If the agent's process has exited the
  // pane is a bare shell, and pasting there hands arbitrary text to the shell
  // for execution while reporting success (2026-09 field report: a finished
  // deliverable "delivered 937 bytes" straight into zsh, lost for days). Refuse
  // unless the caller explicitly wants the shell (force).
  // Fails closed: an unreadable foreground command is treated like a shell.
  // Re-checked right before the paste (guard) — the agent can exit between
  // the first look and the buffer landing.
  const shellCheck = () => {
    const fg = (tmuxSafe(["display-message", "-t", tmuxName, "-p", "#{pane_current_command}"]) || "").trim();
    return !fg || isShellCmd(fg) ? fg || "(unknown)" : null;
  };
  const shell = force ? null : shellCheck();
  if (shell) {
    return res.status(409).json({ error: `agent is not running — its pane is at a ${shell} prompt (pass force to paste into the shell anyway)`, shell });
  }
  try {
    await deliverToPane(tmuxName, text, enter, force ? null : shellCheck);
  } catch (e) {
    if (e.shell) return res.status(409).json({ error: `agent exited while the message was in flight — pane is now a ${e.shell} prompt; nothing pasted`, shell: e.shell });
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, bytes: Buffer.byteLength(text) });
});

// The text reaches tmux via a temp file (load-buffer), never argv or a shell —
// length and content are unconstrained. Unique buffer name so concurrent
// deliveries can't clobber each other; -d reclaims it on paste. Shared by the
// message API and the auto-resume path (resume.js).
// guard: optional () => shellName|null, consulted after the buffer is loaded
// and immediately before the paste — the last possible moment to notice the
// target became a shell. Throws { shell } and reclaims the buffer.
async function deliverToPane(tmuxName, text, enter = true, guard = null) {
  const dir = mkdtempSync(join(tmpdir(), "hadron-msg-"));
  const file = join(dir, "text");
  const buf = `hadron-msg-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(file, text);
    tmux(["load-buffer", "-b", buf, file]);
    const shell = guard ? guard() : null;
    if (shell) throw Object.assign(new Error(`pane is a ${shell} prompt`), { shell });
    tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", tmuxName]);
  } catch (e) {
    tmuxSafe(["delete-buffer", "-b", buf]);
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (enter) {
    await new Promise((r) => setTimeout(r, 250));
    tmux(["send-keys", "-t", tmuxName, "Enter"]);
  }
}

// Paste-to-upload: raw image bytes in, server-constructed absolute path out. The
// client supplies NO path — extension comes from a Content-Type whitelist, the
// directory from workspace + agent id, so there is no traversal surface. No svg:
// pasted screenshots never are, and svg is a script vector.
const UPLOAD_EXTS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
app.post("/api/sessions/:id/upload", express.raw({ type: "image/*", limit: "12mb" }), (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const ct = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = UPLOAD_EXTS[ct];
  if (!ext) return res.status(415).json({ error: `unsupported image type: ${ct || "(none)"}` });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "empty body" });
  const dir = join(getWorkspaceDir(), ".hadron", "uploads", id);
  const rand = randomBytes(4).readUInt32BE(0).toString(36).padStart(4, "0").slice(-4);
  const file = join(dir, `img-${Date.now()}-${rand}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, req.body);
    res.json({ ok: true, path: file, bytes: req.body.length });
  } catch (e) {
    res.status(500).json({ error: "write failed" });
  }
});

// ═══ ANNOTATIONS API (v0.8 review loop) ═══
// Store + transition logic live in server/annotations.js; routes only validate the
// agent and map { error, status } results. State transitions go through dedicated
// endpoints only — PATCH cannot move a comment's lifecycle.

function annotationAgent(req, res) {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: "invalid id" }); return null; }
  if (!sessions.has(id)) { res.status(404).json({ error: "session not found" }); return null; }
  return id;
}

// The dispatch is ONE literal trigger line — comment content never crosses tmux
// send-keys (it lives in the sidecars; the agent pulls it via `hadron annotations ls`).
function dispatchReviewTrigger(id) {
  const tmuxName = tmuxSessionName(id);
  tmux(["send-keys", "-t", tmuxName, "-l", "--", "/hadron-review"]);
  tmux(["send-keys", "-t", tmuxName, "Enter"]);
}

function sendAnnotationResult(res, out, okStatus = 200) {
  if (out && out.error) return res.status(out.status || 500).json({ error: out.error });
  res.status(okStatus).json(out);
}

app.get("/api/sessions/:id/annotations", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, listAnnotations(id, { path: req.query.path, state: req.query.state || "active" }));
});

app.post("/api/sessions/:id/annotations", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  const { path, anchor, body } = req.body || {};
  sendAnnotationResult(res, createAnnotation(id, { path, anchor, body }), 201);
});

app.patch("/api/sessions/:id/annotations/:cid", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, updateAnnotation(id, req.params.cid, { body: (req.body || {}).body }));
});

app.delete("/api/sessions/:id/annotations/:cid", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, deleteAnnotation(id, req.params.cid));
});

app.post("/api/sessions/:id/annotations/send", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, sendAnnotations(id, () => dispatchReviewTrigger(id)));
});

app.post("/api/sessions/:id/annotations/:cid/resolve", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, resolveAnnotation(id, req.params.cid));
});

app.post("/api/sessions/:id/annotations/reopen", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, reopenAnnotations(id));
});

app.post("/api/sessions/:id/annotations/retry-dispatch", (req, res) => {
  const id = annotationAgent(req, res);
  if (!id) return;
  sendAnnotationResult(res, retryDispatch(id, () => dispatchReviewTrigger(id)));
});

// Canonicalize a possibly-not-yet-existing absolute path: realpath the nearest
// existing ancestor and rejoin the remainder, so symlinked components resolve even
// when the leaf itself doesn't exist. Falls back to the lexical path when nothing
// on it exists.
function canonicalRealpath(abs) {
  let base = abs;
  const rest = [];
  for (;;) {
    try { return join(realpathSync(base), ...rest); } catch {}
    const parent = dirname(base);
    if (parent === base) return abs;
    rest.unshift(basename(base));
    base = parent;
  }
}

// ONE canonical stored form for file/dir artifact paths, applied unconditionally at
// write time: workspace-relative when the path lives under the workspace root,
// absolute otherwise — with "under" decided CANONICALLY (realpath), so a file
// reached through an in-workspace symlink to an outside target stores as its real
// absolute path, not a misleading workspace-relative one. Relative inputs that
// don't exist under the workspace but do under the agent's cwd resolve there first
// (people add files relative to where the agent runs). Stored paths stay
// unambiguous forever after; resolvedSession maps them back to absolute for the
// client, so client-side identity is the resolved form.
function canonicalArtifactPath(value, agentCwd) {
  if (/^https?:/.test(value)) return value;
  let abs;
  if (value.startsWith("~")) abs = resolve(value.replace(/^~/, process.env.HOME || ""));
  else if (value.startsWith("/")) abs = resolve(value);
  else {
    abs = resolve(WORKSPACE, value);
    if (agentCwd && !existsSync(abs) && existsSync(resolve(agentCwd, value))) {
      abs = resolve(agentCwd, value);
    }
  }
  const rootCanon = canonicalRealpath(resolve(WORKSPACE));
  const canonical = canonicalRealpath(abs);
  if (canonical === rootCanon) return ".";
  if (canonical.startsWith(rootCanon + "/")) return canonical.slice(rootCanon.length + 1);
  return canonical;
}

// Shared per-entry validation + canonicalization for EVERY artifact write path —
// the append endpoint, the whole-array PATCH, and the session-create seed all go
// through here, so none of them is a validation bypass. Returns { item } or
// { error }.
function validateAndCanonicalizeArtifact(entry, agentCwd) {
  if (!entry || typeof entry !== "object") return { error: "artifact must be an object" };
  const { type = "file", value, label } = entry;
  if (!value || typeof value !== "string") return { error: "value (string) required" };
  if (type !== "file" && type !== "url" && type !== "dir") {
    return { error: "type must be file, url or dir" };
  }
  if (type === "url" && !isValidHttpUrl(value)) {
    return { error: "url artifact value must be a valid http(s) URL" };
  }
  const item = { type, value };
  if (type !== "url") item.value = canonicalArtifactPath(value, agentCwd);
  if (type === "dir") {
    // A dir artifact is a live listing of a real directory INSIDE the workspace jail
    // (agent cwds are validated inside it too). Canonical containment on the real
    // path — same symlink-safe check as /api/files/browse.
    let canonical;
    try { canonical = realpathSync(resolveFilePath(item.value)); } catch {
      return { error: "dir artifact must point to an existing directory" };
    }
    let root;
    try { root = realpathSync(WORKSPACE); } catch { return { error: "workspace root unavailable" }; }
    if (canonical !== root && !canonical.startsWith(root + "/")) {
      return { error: "dir artifact must be inside the workspace" };
    }
    try {
      if (!statSync(canonical).isDirectory()) return { error: "dir artifact must point to a directory" };
    } catch { return { error: "dir artifact must point to an existing directory" }; }
    if (entry.open === true) item.open = true; // default absent = collapsed
  }
  if (label) item.label = label;
  return { item };
}

function isValidHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

// Append one artifact without clobbering the array (atomic, under per-agent lock).
app.post("/api/sessions/:id/artifacts", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const out = validateAndCanonicalizeArtifact(req.body, sessions.get(id).cwd);
  if (out.error) return res.status(400).json({ error: out.error });
  const updated = await appendAgentField(id, "artifacts", out.item);
  if (updated) sessions.get(id).artifacts = updated.artifacts;
  res.json(resolvedSession(sessions.get(id)));
});

// Remove one artifact atomically (same per-agent lock as append). Body { index,
// value }: the pair must still match server-side — a mismatch means the array
// drifted since the client rendered (a concurrent CLI append / another tab's
// remove) → 409, the client refetches and re-renders. Never touches real files.
app.delete("/api/sessions/:id/artifacts", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const { index, value } = req.body || {};
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: "index (non-negative integer) required" });
  if (!value || typeof value !== "string") return res.status(400).json({ error: "value (string) required" });
  // The client sees resolved values, the file stores canonical ones — compare both raw
  // and resolved so either form matches its own artifact and nothing else.
  const matches = (stored, given) => stored === given || resolveFilePath(stored) === resolveFilePath(given);
  const out = await removeAgentArtifact(id, index, value, matches);
  if (!out) return res.status(404).json({ error: "agent file not found" });
  if (out.conflict) return res.status(409).json({ error: "artifact index/value mismatch — refetch and retry" });
  sessions.get(id).artifacts = out.data.artifacts;
  res.json({ ok: true, artifacts: resolvedSession(sessions.get(id)).artifacts });
});

// Append one related-agent id without clobbering the array.
app.post("/api/sessions/:id/related", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const related = req.body.related ?? req.body.agentId;
  if (!related || typeof related !== "string") return res.status(400).json({ error: "related (string) required" });
  if (related === id) return res.status(400).json({ error: "cannot relate an agent to itself" });
  const updated = await appendAgentField(id, "relatedAgents", related);
  if (updated) sessions.get(id).relatedAgents = updated.relatedAgents;
  // Links are mutual: if the other agent exists, add this id back so both decks show the relationship.
  if (sessions.has(related)) {
    const back = await appendAgentField(related, "relatedAgents", id);
    if (back) sessions.get(related).relatedAgents = back.relatedAgents;
  }
  res.json(sessions.get(id));
});

app.post("/api/sessions/reorder", (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });
  for (const item of order) {
    const session = sessions.get(item.id);
    if (!session) continue;
    session.sortOrder = item.sortOrder;
    if (item.group !== undefined) session.group = item.group;
    saveAgent(session);
  }
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", (req, res) => {
  const { id } = req.params;
  if (!sessions.has(id)) {
    return res.status(404).json({ error: "session not found" });
  }
  const session = sessions.get(id);
  if (session.deletable === false) {
    return res.status(400).json({ error: "this agent is marked as non-deletable" });
  }
  const force = req.query.force === "true";
  if (force) {
    sessions.delete(id);
    stopMonitor(id);
    killTmuxSession(id);
    deleteAgent(id);
  } else {
    const session = sessions.get(id);
    session.archived = true;
    sessions.delete(id);
    stopMonitor(id);
    killTmuxSession(id);
    archiveAgent(id);
  }
  res.json({ ok: true });
});

// ═══ SHELL CLEANUP API ═══
app.delete("/api/sessions/:id/shells/:shellName", (req, res) => {
  const { id, shellName } = req.params;
  if (!isValidId(id) || !/^[a-z0-9-]+$/.test(shellName)) {
    return res.status(400).json({ error: "invalid id or shell name" });
  }
  const tmuxName = `${TMUX_PREFIX}-${id}-${shellName}`;
  tmuxSafe(["kill-session", "-t", tmuxName]);
  res.json({ ok: true });
});

// ═══ FILE READ API ═══
// Opaque per-file revision for conditional writes (editor draft model). mtime
// alone is not a reliable revision (coarse resolution, restorable) — fold in
// size too. Callers must treat it as opaque.
function fileRevision(stat) {
  return `${stat.mtimeMs}-${stat.size}`;
}

app.head("/api/file", (req, res) => {
  const filePath = resolveFilePath(req.query.path);
  if (!filePath) return res.status(400).end();
  try {
    const stat = statSync(filePath);
    res.set("Cache-Control", "no-store");
    res.set("X-File-Mtime", String(stat.mtimeMs));
    res.set("X-File-Revision", fileRevision(stat));
    res.status(200).end();
  } catch { res.status(404).end(); }
});

// Images need their real mime (and bytes, not utf-8) so markdown previews can
// reference them through this endpoint (relative <img src> in .md files).
const IMAGE_MIMES = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon" };

app.get("/api/file", (req, res) => {
  const filePath = resolveFilePath(req.query.path);
  if (!filePath) return res.status(400).json({ error: "path is required" });
  try {
    const stat = statSync(filePath);
    const ext = filePath.split(".").pop().toLowerCase();
    // no-store: artifact content must always be served fresh. With heuristic
    // caching (Last-Modified, no Cache-Control) the browser could revalidate
    // into a 304 that resurrects a stale cached body — the editor's preview
    // toggle then rendered old file content (flaky M7 repro). The same URL is
    // also HEAD-polled with different headers, which corrupts cache validators.
    res.set("Cache-Control", "no-store");
    res.set("Last-Modified", stat.mtime.toUTCString());
    res.set("X-File-Mtime", String(stat.mtimeMs));
    res.set("X-File-Revision", fileRevision(stat));
    if (IMAGE_MIMES[ext]) {
      res.type(IMAGE_MIMES[ext]).send(readFileSync(filePath));
      return;
    }
    const content = readFileSync(filePath, "utf-8");
    const mime = ext === "html" || ext === "htm" ? "text/html" : "text/plain";
    res.type(mime).send(content);
  } catch (e) {
    res.status(404).json({ error: "file not found" });
  }
});

// Write API — edits an *existing* file in place. Restricted to regular files that
// already exist (so it can't be used to create arbitrary new files anywhere the
// server user can write); token + host + origin are already enforced by requireAuth.
//
// Conditional write: when the body carries `baseRevision` (the revision the
// editor's draft is based on), a mismatch with the file's CURRENT revision
// means someone (usually an agent) wrote the file since — refuse with 409 and
// hand back the current content so the client can offer Compare/Overwrite.
// Callers that omit baseRevision keep the old unconditional semantics.
// The write itself is temp+rename so a concurrent reader never sees a torn file.
app.post("/api/file", (req, res) => {
  const filePath = resolveFilePath(req.body && req.body.path);
  if (!filePath) return res.status(400).json({ error: "path is required" });
  const content = req.body && req.body.content;
  if (typeof content !== "string") return res.status(400).json({ error: "content (string) is required" });
  const baseRevision = req.body && req.body.baseRevision;
  let stat;
  try { stat = statSync(filePath); } catch { return res.status(404).json({ error: "file not found" }); }
  if (!stat.isFile()) return res.status(400).json({ error: "not a regular file" });
  // .hadron internals are control surfaces, not documents: config.json defines
  // launcher argv (command execution), agents/*.json and token gate auth. A write
  // there via this endpoint would let any authenticated API caller cross the
  // "launchers are filesystem-defined" boundary. Canonical path, so a symlinked
  // detour into .hadron is caught too.
  let canonical;
  try { canonical = realpathSync(filePath); } catch { return res.status(404).json({ error: "file not found" }); }
  if (canonical.split("/").includes(".hadron")) {
    return res.status(403).json({ error: ".hadron internals cannot be edited through the file API" });
  }
  if (baseRevision !== undefined && fileRevision(stat) !== baseRevision) {
    let currentContent = null;
    try { currentContent = readFileSync(filePath, "utf-8"); } catch {}
    return res.status(409).json({
      error: "revision_conflict",
      currentRevision: fileRevision(stat),
      currentContent,
    });
  }
  try {
    const tmp = `${filePath}.hadron-write-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
    const newStat = statSync(filePath);
    res.set("X-File-Mtime", String(newStat.mtimeMs));
    res.set("X-File-Revision", fileRevision(newStat));
    res.json({ ok: true, mtime: newStat.mtimeMs, revision: fileRevision(newStat) });
  } catch (e) {
    res.status(500).json({ error: "write failed" });
  }
});

app.get("/api/files/suggest", (req, res) => {
  // Same jail contract as /api/files/browse: the SERVER owns the start dir — the
  // agent's cwd (via agentId), else the workspace root. The old client-supplied
  // `cwd` param is gone: it let any caller point recursive enumeration at an
  // arbitrary directory. Canonical (realpath) containment in the workspace root;
  // anything outside clamps to the root.
  const rawAgentId = String(req.query.agentId || "");
  let root;
  try { root = realpathSync(WORKSPACE); } catch { return res.status(500).json({ error: "workspace root unavailable" }); }
  let cwd = resolveAgentCwd(rawAgentId && isValidId(rawAgentId) ? sessions.get(rawAgentId) : null);
  try { cwd = realpathSync(cwd); } catch { cwd = root; }
  if (cwd !== root && !cwd.startsWith(root + "/")) cwd = root;
  const agentId = rawAgentId.toLowerCase();
  const PATTERNS = /\.(md|py|ipynb|csv|sql|js|ts|jsx|tsx|yaml|yml|json|sh|go|rs|rb|java|toml|html|css|txt)$/i;
  const IGNORE = /^(node_modules|\.git|__pycache__|\.venv|\.env|\.hadron|\.cache|\.next|dist|build|\.tox)$/;
  const HUMAN_EXT = /\.(md|html|htm|csv|ipynb)$/i;
  const SOURCE_EXT = /\.(js|ts|jsx|tsx|py|go|rs|java|rb|sh)$/i;
  const CONFIG_EXT = /\.(json|yaml|yml|toml|css)$/i;
  const OUTPUT_KW = /output|report|review|summary|result|spike|notes|doc/i;
  const OUTPUT_DIR = /^(docs|output|reports|results|reviews)\//i;
  const MAX_FILES = 80;
  const results = [];

  // Jail contract at EVERY level (check → read → recheck), not just the root: a
  // real subdir can be swapped for an external symlink between the parent readdir
  // and the recursive descent. Each scan() requires its dir to still BE the
  // canonical jail-contained path it was derived as (the parent chain starts at
  // the realpathed scan root, so `realpath(dir) === dir` implies both identity and
  // containment), reads via that canonical path, and re-verifies after the read —
  // a mismatch discards that subtree only. Symlinked dirs are never followed:
  // Dirent.isDirectory() is false for symlinks — keep it that way.
  function scan(dir, depth) {
    if (depth > 3 || results.length >= MAX_FILES) return;
    let canon;
    try { canon = realpathSync(dir); } catch { return; }
    if (canon !== dir) return; // a component was swapped since the parent read
    if (canon !== root && !canon.startsWith(root + "/")) return;
    let entries;
    try { entries = readdirSync(canon, { withFileTypes: true }); } catch { return; }
    // recheck: discard the subtree if the dir was swapped during the read.
    try { if (realpathSync(dir) !== canon) return; } catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (IGNORE.test(entry.name)) continue;
      const fullPath = join(canon, entry.name); // canonical child path
      if (entry.isDirectory()) { // false for symlinks — never descends a symlinked dir
        scan(fullPath, depth + 1);
      } else if (PATTERNS.test(entry.name)) {
        const relPath = fullPath.slice(cwd.length + 1);
        results.push({ path: relPath, name: entry.name });
      }
    }
  }

  scan(cwd, 0);

  const scored = results.map(f => {
    let score = 0;
    const nameLower = f.name.toLowerCase();
    if (agentId && nameLower.includes(agentId)) score += 50;
    if (nameLower === "readme.md") score += 30;
    if (HUMAN_EXT.test(f.name)) score += 20;
    if (OUTPUT_KW.test(nameLower)) score += 15;
    if (OUTPUT_DIR.test(f.path)) score += 10;
    if (SOURCE_EXT.test(f.name)) score -= 10;
    if (CONFIG_EXT.test(f.name)) score -= 15;
    if (f.name.startsWith(".")) score -= 15;
    return { ...f, score };
  });

  const filtered = scored.filter(f => f.score > -15);
  filtered.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  // `base` = the resolved scan root the server ACTUALLY used (realpathed, possibly
  // clamped). Clients must join/de-dupe result paths against it — guessing from the
  // lexical session.cwd disagrees with it for symlinked or clamped cwds.
  res.json({ base: cwd, files: filtered });
});

// Directory listing for the add-artifact popover and dir-artifact groups. The jail
// is the WORKSPACE root (server-owned — the client never supplies a base dir), and
// containment is checked on CANONICAL paths (realpathSync of both sides) so a
// symlink inside the workspace pointing outside can't escape it — a textual
// startsWith on the raw path could. The client sends agentId + a workspace-relative
// `path`; omitting `path` entirely means "the agent's start dir" (resolveAgentCwd),
// whose workspace-relative prefix comes back as `rel` so the breadcrumb can show
// where browsing started. ".." navigation works up to the root, never above.
// `hidden=1` adds dotfiles; the bulky-dir IGNORE list (which includes .git and
// .hadron — always hidden) applies in BOTH modes.
app.get("/api/files/browse", (req, res) => {
  const IGNORE = /^(node_modules|\.git|__pycache__|\.venv|\.env|\.hadron|\.cache|\.next|dist|build|\.tox)$/;
  const showHidden = req.query.hidden === "1";

  let root;
  try { root = realpathSync(WORKSPACE); } catch { return res.status(500).json({ error: "workspace root unavailable" }); }

  let target;
  if (req.query.path === undefined) {
    const agent = req.query.agentId && isValidId(req.query.agentId) ? sessions.get(req.query.agentId) : null;
    target = resolveAgentCwd(agent); // falls back to WORKSPACE
  } else {
    target = resolve(root, String(req.query.path));
  }
  try { target = realpathSync(target); } catch { return res.status(404).json({ error: "directory not found" }); }
  if (target !== root && !target.startsWith(root + "/")) {
    return res.status(403).json({ error: "path outside workspace" });
  }

  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); } catch { return res.status(404).json({ error: "directory not found" }); }

  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (IGNORE.test(entry.name)) continue;
    if (!showHidden && entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      // Non-recursive child count: dir-artifact groups show subdirs as inert rows
      // with a count instead of recursing (v1). The count read gets its OWN
      // check → read → recheck: the child can be swapped for an external symlink
      // after the Dirent snapshot, and rechecking only `target` wouldn't catch it —
      // the count would leak an outside dir's entry count. Any escape, swap or
      // ENOENT just omits the count (null); one racy child never fails the listing.
      let count = null;
      try {
        const childPath = join(target, entry.name);
        const canon = realpathSync(childPath);
        if (canon === root || canon.startsWith(root + "/")) {
          const n = readdirSync(canon).length;
          if (realpathSync(childPath) === canon) count = n;
        }
      } catch {}
      dirs.push({ name: entry.name, type: "dir", count });
    } else {
      files.push({ name: entry.name, type: "file" });
    }
  }
  // Jail contract: check → read → recheck. `target` was canonical and contained
  // before the reads, but a path component can be swapped for a symlink between the
  // containment check and the readdir calls (realpath-to-use race). Re-canonicalize
  // after ALL reads and discard the listing unless the path still resolves to the
  // same jailed target. (Portable revalidate-around-use — no /proc fd tricks.)
  try {
    if (realpathSync(target) !== target) return res.status(403).json({ error: "path outside workspace" });
  } catch { return res.status(404).json({ error: "directory not found" }); }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ entries: [...dirs, ...files], rel: target === root ? "" : target.slice(root.length + 1) });
});

// ═══ TERMINAL PATH RESOLUTION ═══
// Clickable terminal paths: the client matches path-ish tokens in xterm output and
// asks here whether a token resolves to a real file. A relative token (./x, src/x.py)
// is meaningless without a base, so we resolve it against the agent's *pane* cwd —
// what the agent actually printed it relative to — not the static agent.cwd. Absolute
// and ~/ paths resolve through the same resolveFilePath policy as every other file
// read. Returns the canonical path only when it's an existing regular file, so the
// link only lights up for something openable. GET (no mutation) — auth allows reads.
app.get("/api/resolve-path", (req, res) => {
  const raw = req.query.path;
  if (!raw || typeof raw !== "string") return res.status(400).json({ error: "path is required" });
  const id = req.query.session;
  // Pane cwd for relative tokens. tmux exposes the live foreground cwd of the pane;
  // fall back to the agent's configured cwd, then the workspace root.
  let paneCwd = null;
  if (isValidId(id)) {
    paneCwd = tmuxSafe(["display-message", "-p", "-t", tmuxSessionName(id), "-F", "#{pane_current_path}"]);
    if (!paneCwd) paneCwd = resolveAgentCwd(sessions.get(id));
  }
  const base = paneCwd || WORKSPACE;

  let abs;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return res.status(400).json({ error: "not a file path" });
  } else if (raw.startsWith("/") || raw.startsWith("~")) {
    abs = resolveFilePath(raw); // absolute / ~ → same policy as every other file read
  } else {
    abs = resolve(base, raw); // relative → resolve against the pane's cwd
  }

  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return res.status(404).json({ error: "not a regular file" });
    res.json({ path: abs });
  } catch {
    res.status(404).json({ error: "file not found" });
  }
});

// ═══ KERNEL CONFIG API ═══
function getKernelConfig() {
  const configPath = join(getWorkspaceDir(), ".hadron", "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.kernels || {};
  } catch {
    return {};
  }
}

app.get("/api/kernels", (req, res) => {
  const kernels = getKernelConfig();
  res.json(kernels);
});

app.put("/api/kernels", (req, res) => {
  const configPath = join(getWorkspaceDir(), ".hadron", "config.json");
  let config;
  try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch { config = { name: "workspace" }; }
  config.kernels = req.body;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json(config.kernels);
});

// PATCH = atomic partial update. A client-side GET→merge→PUT loses updates when
// two callers race (each PUTs its own stale snapshot); merging HERE — inside one
// synchronous handler on node's single thread — cannot interleave.
app.patch("/api/kernels", (req, res) => {
  const configPath = join(getWorkspaceDir(), ".hadron", "config.json");
  let config;
  try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch { config = { name: "workspace" }; }
  config.kernels = { ...(config.kernels || {}), ...req.body };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json(config.kernels);
});

function resolveKernelEnv(runtime) {
  const kernels = getKernelConfig();
  const envPath = kernels[runtime];
  if (!envPath) return null;
  const resolved = envPath.replace(/^~/, process.env.HOME);
  if (!existsSync(join(resolved, "bin", "python3"))) return null;
  return resolved;
}

// ═══ MARIMO LAUNCHER + PROXY ═══
const marimoProcesses = new Map(); // filePath -> { process, port }
let nextMarimoPort = 7860;

function isPortInUse(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf-8", timeout: 2000 }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function findFreePort() {
  for (let i = 0; i < 100; i++) {
    const port = nextMarimoPort++;
    if (!isPortInUse(port)) return port;
  }
  throw new Error("No free marimo ports in range");
}

function killOrphanedMarimos() {
  // Only kill marimos on ports in our managed range (7860+), not user's own notebooks
  try {
    const lines = execSync("ps ax -o pid=,args= 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim().split("\n");
    for (const line of lines) {
      if (!line.includes("marimo") || !line.includes("edit")) continue;
      const portMatch = line.match(/--port\s+(\d+)/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1]);
      if (port < 7860 || port > 7959) continue;
      const pid = parseInt(line.trim());
      if (!pid || isNaN(pid)) continue;
      console.log(`[marimo] Killing orphaned marimo process ${pid} (port ${port})`);
      try { process.kill(pid); } catch {}
    }
  } catch {}
}

killOrphanedMarimos();

app.post("/api/marimo/start", (req, res) => {
  const filePath = resolveFilePath(req.body.filePath);
  if (!filePath) return res.status(400).json({ error: "filePath required" });
  if (!existsSync(filePath)) return res.status(404).json({ error: "file not found" });

  const existing = marimoProcesses.get(filePath);
  if (existing) {
    return res.json({ port: existing.port, proxyBase: `/marimo-proxy/${existing.port}` });
  }

  try {
    const port = findFreePort();
    const kernelEnv = resolveKernelEnv("marimo");
    const venvDir = kernelEnv || join(__dirname, "..", ".venv");
    const marimoCmd = join(venvDir, "bin", "marimo");
    const marimoExe = existsSync(marimoCmd) ? marimoCmd : "marimo";
    const venvEnv = {
      ...process.env,
      VIRTUAL_ENV: venvDir,
      PATH: `${join(venvDir, "bin")}:${process.env.PATH}`,
    };
    const proc = cpSpawn(
      marimoExe, ["edit", filePath, "--port", String(port), "--headless", "--no-token", "--host", "127.0.0.1", "--watch"],
      { stdio: "pipe", env: venvEnv }
    );
    proc.on("error", (err) => {
      console.error(`Marimo failed to start: ${err.message}`);
      marimoProcesses.delete(filePath);
    });
    proc.on("exit", () => {
      console.log(`Marimo process exited for ${filePath}`);
      marimoProcesses.delete(filePath);
    });
    marimoProcesses.set(filePath, { process: proc, port });
    console.log(`[marimo] Starting on port ${port} for ${filePath}`);

    // Wait for marimo to be ready (poll until it responds)
    let attempts = 0;
    const checkReady = () => {
      attempts++;
      const checkReq = http.get(`http://127.0.0.1:${port}/`, (r) => {
        r.resume();
        res.json({ port, proxyBase: `/marimo-proxy/${port}` });
      });
      checkReq.on("error", () => {
        if (attempts < 15) setTimeout(checkReady, 500);
        else res.json({ port, proxyBase: `/marimo-proxy/${port}` });
      });
      checkReq.setTimeout(1000, () => { checkReq.destroy(); });
    };
    setTimeout(checkReady, 1000);
  } catch (e) {
    res.status(500).json({ error: `Failed to start marimo: ${e.message}` });
  }
});

app.post("/api/marimo/stop", (req, res) => {
  const filePath = resolveFilePath(req.body.filePath);
  const entry = marimoProcesses.get(filePath);
  if (entry) {
    try { entry.process.kill(); } catch {}
    marimoProcesses.delete(filePath);
  }
  res.json({ ok: true });
});

// ═══ JUPYTER SERVER ═══
const jupyterProcesses = new Map();
let nextJupyterPort = 7900;

app.post("/api/jupyter/start", (req, res) => {
  const filePath = resolveFilePath(req.body.filePath);
  if (!filePath) return res.status(400).json({ error: "filePath required" });
  if (!existsSync(filePath)) return res.status(404).json({ error: "file not found" });

  const existing = jupyterProcesses.get(filePath);
  if (existing) {
    return res.json({ port: existing.port, proxyBase: `/jupyter-proxy/${existing.port}` });
  }

  try {
    const port = findFreePort();
    const kernelEnv = resolveKernelEnv("jupyter");
    const venvDir = kernelEnv || join(__dirname, "..", ".venv");
    const jupyterCmd = join(venvDir, "bin", "jupyter");
    const jupyterExe = existsSync(jupyterCmd) ? jupyterCmd : "jupyter";
    const venvEnv = {
      ...process.env,
      VIRTUAL_ENV: venvDir,
      PATH: `${join(venvDir, "bin")}:${process.env.PATH}`,
    };
    const notebookDir = filePath.substring(0, filePath.lastIndexOf("/"));
    const baseUrl = `/jupyter-proxy/${port}/`;
    const proc = cpSpawn(
      jupyterExe,
      ["notebook", "--no-browser", "--port", String(port), "--ip", "127.0.0.1",
       "--ServerApp.token=", "--ServerApp.password=", "--ServerApp.disable_check_xsrf=True",
       "--ServerApp.allow_origin=*", `--ServerApp.base_url=${baseUrl}`,
       "--notebook-dir", notebookDir],
      { stdio: "pipe", env: venvEnv }
    );
    proc.stderr.on("data", (d) => console.error(`[jupyter] ${d}`));
    proc.on("error", (err) => {
      console.error(`Jupyter failed to start: ${err.message}`);
      jupyterProcesses.delete(filePath);
    });
    proc.on("exit", (code) => {
      console.log(`Jupyter process exited for ${filePath} (code ${code})`);
      jupyterProcesses.delete(filePath);
    });
    jupyterProcesses.set(filePath, { process: proc, port, notebookDir });
    console.log(`Starting Jupyter on port ${port} for ${filePath}`);

    let attempts = 0;
    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
    const checkReady = () => {
      // Spawn failed or exited (e.g. jupyter not installed): say so now, so the
      // client falls back to the static preview instead of iframing a dead proxy.
      if (!jupyterProcesses.has(filePath)) return res.json({ error: "jupyter unavailable" });
      attempts++;
      const checkReq = http.get(`http://127.0.0.1:${port}${baseUrl}api/status`, (r) => {
        r.resume();
        res.json({ port, proxyBase: `/jupyter-proxy/${port}`, fileName });
      });
      checkReq.on("error", () => {
        if (attempts < 20) return setTimeout(checkReady, 500);
        // Never came up: kill it and say so — handing the client a proxyBase
        // to a dead server would iframe a blank pane over the static preview.
        const entry = jupyterProcesses.get(filePath);
        if (entry) {
          try { process.kill(-entry.process.pid); } catch {}
          try { entry.process.kill(); } catch {}
          jupyterProcesses.delete(filePath);
        }
        res.json({ error: "jupyter did not become ready" });
      });
      checkReq.setTimeout(1000, () => { checkReq.destroy(); });
    };
    setTimeout(checkReady, 1500);
  } catch (e) {
    res.status(500).json({ error: `Failed to start Jupyter: ${e.message}` });
  }
});

app.post("/api/jupyter/stop", (req, res) => {
  const { filePath } = req.body;
  const entry = jupyterProcesses.get(filePath);
  if (entry) {
    try { process.kill(-entry.process.pid); } catch {}
    try { entry.process.kill(); } catch {}
    jupyterProcesses.delete(filePath);
  }
  res.json({ ok: true });
});

// ═══ BACKGROUND STATE MONITORS ═══
const monitors = new Map();
const runtimeTrackers = new Map();

// Throttled checkpoint persistence: transitions (tombstone, new session id)
// flush immediately; heartbeat-only refreshes ride a 30s trailing write.
const runtimeSaveTimers = new Map();
function saveRuntimeCheckpoint(session, urgent) {
  if (urgent) {
    clearTimeout(runtimeSaveTimers.get(session.id));
    runtimeSaveTimers.delete(session.id);
    saveAgent(session);
    return;
  }
  if (runtimeSaveTimers.has(session.id)) return;
  runtimeSaveTimers.set(session.id, setTimeout(() => {
    runtimeSaveTimers.delete(session.id);
    saveAgent(session);
  }, 30000));
}

function startMonitor(sessionId) {
  if (monitors.has(sessionId)) return;
  const session = sessions.get(sessionId);
  if (!session) return;

  const created = ensureTmuxSession(sessionId, resolveAgentCwd(session));
  const detector = new StateDetector(tmuxSessionName(sessionId), session);
  monitors.set(sessionId, detector);

  const tracker = new RuntimeTracker(session, {
    save: saveRuntimeCheckpoint,
    // Shared-cwd agents can't be told apart by transcript scraping (the jsonl
    // head proves the cwd, not the owner) — the tracker refuses to scrape there.
    cwdShared: () => {
      const me = sessions.get(sessionId);
      if (!me || !me.cwd) return true; // unknown cwd → be conservative
      return [...sessions.values()].some((s) => s.id !== sessionId && s.cwd === me.cwd);
    },
  });
  runtimeTrackers.set(sessionId, tracker);
  detector.onCmd = (cmd) => tracker.observe(cmd);

  console.log(`Monitor started for session: ${sessionId}`);
  if (created) {
    // Resume through the agent's own claude-kind launcher (cc-* wrappers carry
    // the provider config); non-claude/unknown launchers fall back to bare claude.
    const launcher = getLaunchers()[session.launchCommand];
    const launchArgv = launcher?.kind === "claude" ? launcher.argv : ["claude"];
    performResume(session, tmuxSessionName(sessionId), { deliver: deliverToPane, save: (s) => saveAgent(s), launchArgv })
      .then((r) => { if (r.reason) console.log(`[resume] ${sessionId}: skip — ${r.reason}`); })
      .catch((e) => console.error(`[resume] ${sessionId}: ${e.message}`));
  }
}

function stopMonitor(sessionId) {
  const detector = monitors.get(sessionId);
  if (detector) {
    detector.dispose();
    monitors.delete(sessionId);
  }
  runtimeTrackers.delete(sessionId);
  clearTimeout(runtimeSaveTimers.get(sessionId));
  runtimeSaveTimers.delete(sessionId);
}

// ═══ WebSocket server ═══
const wss = new WebSocketServer({ noServer: true });

// Every live terminal pty, tracked module-level: the only other reference is a
// connection-closure local, so an orphaned pty would otherwise be unreachable
// for the rest of the process lifetime (the macOS ptmx exhaustion incident —
// kern.tty.ptmx_max is 511 system-wide and not adjustable at runtime).
const livePtys = new Set();
const PTY_WARN_THRESHOLD = 128; // well under macOS's 511 cap; Linux default is 4096

// node-pty's kill() only SIGHUPs the child — it never touches the master fd.
// destroy() is what actually releases it, and must run even when kill throws,
// otherwise a child that survives SIGHUP (or is already unkillable) leaks the
// fd permanently.
function reapPty(pty) {
  if (!livePtys.delete(pty)) return; // already reaped (close + onExit both call this)
  try { pty.kill(); } catch {}
  try { pty.destroy(); } catch {}
}

// Heartbeat: without ping/pong a half-open socket (laptop sleep, network drop)
// never fires "close", so its pty lives forever — while the client side happily
// reconnects every second and spawns a fresh pty each time (~6/min measured).
const WS_HEARTBEAT_MS = Number(process.env.HADRON_WS_HEARTBEAT_MS) || 30_000; // env: tests shrink it to exercise the half-open path
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; } // terminate → "close" → reapPty
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, WS_HEARTBEAT_MS);
wsHeartbeat.unref();

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  // Proxy WebSocket for marimo
  const marimoMatch = url.pathname.match(/^\/marimo-proxy\/(\d+)(\/.*)?$/);
  if (marimoMatch) {
    if (!isAllowedHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const targetPort = parseInt(marimoMatch[1]);
    const targetPath = (marimoMatch[2] || "/") + (url.search || "");
    // Rewrite the raw HTTP upgrade request to the target path/host
    const upstream = netConnect(targetPort, "127.0.0.1", () => {
      const hdrs = { ...request.headers, host: `127.0.0.1:${targetPort}`, origin: `http://127.0.0.1:${targetPort}` };
      let raw = `GET ${targetPath} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(hdrs)) raw += `${k}: ${v}\r\n`;
      raw += "\r\n";
      upstream.write(raw);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    return;
  }

  // Proxy WebSocket for Jupyter
  const jupyterMatch = url.pathname.match(/^\/jupyter-proxy\/(\d+)(\/.*)?$/);
  if (jupyterMatch) {
    if (!isAllowedHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const targetPort = parseInt(jupyterMatch[1]);
    const targetPath = `/jupyter-proxy/${targetPort}${jupyterMatch[2] || "/"}${url.search || ""}`;
    const upstream = netConnect(targetPort, "127.0.0.1", () => {
      const hdrs = { ...request.headers, host: `127.0.0.1:${targetPort}`, origin: `http://127.0.0.1:${targetPort}` };
      let raw = `GET ${targetPath} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(hdrs)) raw += `${k}: ${v}\r\n`;
      raw += "\r\n";
      upstream.write(raw);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    return;
  }

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  // The WS carries terminal input straight into the pane — guard it like a mutating route.
  if (!isAllowedHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)
      || !AUTH_TOKEN || url.searchParams.get("token") !== AUTH_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.sessionId = url.searchParams.get("session") || "planner";
    ws.shellName = url.searchParams.get("shell") || null;
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const sessionId = ws.sessionId || "planner";
  const shellName = ws.shellName || null;
  const isShell = !!shellName;
  const effectiveTmuxName = isShell ? `${TMUX_PREFIX}-${sessionId}-${shellName}` : tmuxSessionName(sessionId);

  console.log(`WebSocket connected for session: ${sessionId}${isShell ? ` (shell: ${shellName})` : ""}`);

  ensureDefaults();
  if (!sessions.has(sessionId)) {
    const session = {
      id: sessionId,
      name: sessionId,
      group: "Workers",
      task: null,
      state: "idle",
    };
    sessions.set(sessionId, session);
    saveAgent(session);
  }

  if (isShell) {
    // For shell sessions, create the tmux session if it doesn't exist
    const cwd = resolveAgentCwd(sessions.get(sessionId)) || WORKSPACE;
    try {
      tmux(["has-session", "-t", effectiveTmuxName]);
    } catch {
      tmux(["new-session", "-d", "-s", effectiveTmuxName, "-x", "80", "-y", "24", "-c", cwd]);
      applyAgentEnv(effectiveTmuxName, cwd);
    }
    fitWindowToClients(effectiveTmuxName);
  } else {
    ensureTmuxSession(sessionId, resolveAgentCwd(sessions.get(sessionId)));
  }

  let pty;
  try {
    pty = spawn(
      "tmux",
      tmuxArgv(["attach-session", "-t", effectiveTmuxName]),
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: resolveAgentCwd(sessions.get(sessionId)),
        env: {
          ...process.env,
          TERM: "xterm-256color",
        },
      }
    );
  } catch (err) {
    // node-pty can throw synchronously (e.g. a non-executable prebuilt
    // spawn-helper → "posix_spawnp failed"). Fail just this terminal — never let
    // it bubble out of the connection handler and crash the whole server, which
    // would take down every other agent's monitor with it.
    console.error(`PTY spawn failed for session ${sessionId}: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n` }));
      ws.close();
    }
    return;
  }

  // Track + register the cleanup handlers BEFORE anything else that can throw
  // (startMonitor below) — a pty with no reachable reference and no handlers is
  // a guaranteed fd leak.
  livePtys.add(pty);
  if (livePtys.size >= PTY_WARN_THRESHOLD) {
    console.warn(`[pty] ${livePtys.size} live ptys — approaching the OS pty cap (macOS ptmx_max=511); check for leaked/half-open terminal connections`);
  }

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  pty.onExit(({ exitCode }) => {
    console.log(`PTY exited for session ${sessionId}${isShell ? ` (shell: ${shellName})` : ""} with code ${exitCode}`);
    reapPty(pty); // exit alone doesn't free the master fd — destroy() does
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });

  ws.on("message", (msg) => {
    try {
      const message = JSON.parse(msg.toString());
      if (message.type === "input") {
        pty.write(message.data);
      } else if (message.type === "resize") {
        const { cols, rows } = message;
        // Resize the pty only — tmux gets SIGWINCH and refits the window to this client
        // (window-size smallest, set in fitWindowToClients). Do NOT call `tmux resize-window`:
        // it pins window-size to manual and freezes the size, causing right-edge clipping.
        pty.resize(cols, rows);
      }
    } catch {
      pty.write(msg.toString());
    }
  });

  ws.on("close", () => {
    reapPty(pty);
    // vim editor shells never reconnect (each open is a fresh vim-<ts>), so a
    // closed WS means the editor is gone — kill its tmux session to avoid an
    // orphan from reload/tab-close/crash. Main terminal + persistent shells are
    // deliberately preserved so they survive a reload.
    if (isShell && shellName && shellName.startsWith("vim-")) {
      tmuxSafe(["kill-session", "-t", effectiveTmuxName]);
      console.log(`WebSocket disconnected for ${sessionId} (editor: ${shellName}) — vim tmux session killed`);
    } else {
      console.log(
        `WebSocket disconnected for session ${sessionId}${isShell ? ` (shell: ${shellName})` : ""} — tmux session preserved`
      );
    }
  });

  // State monitor last, and never fatal to this connection: it runs shell
  // commands (ensureTmuxSession/execFileSync) that can throw, and before this
  // ordering a throw here orphaned a handler-less pty.
  if (!isShell) {
    try { startMonitor(sessionId); } catch (e) { console.error(`startMonitor failed for ${sessionId}: ${e.message}`); }
  }
});

const PORT = process.env.PORT || 3000;
const HADRON_HOST = process.env.HADRON_HOST || "127.0.0.1";
const WORKSPACE = resolve(process.argv[2] || process.env.HADRON_WORKSPACE || process.cwd());
const WS_NAME = basename(WORKSPACE).replace(/[^a-zA-Z0-9_-]/g, "");
const TMUX_PREFIX = `hadron-${WS_NAME}`;

function resolveFilePath(p) {
  if (!p) return p;
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  if (p.startsWith("/") || p.startsWith("~")) return p.replace(/^~/, process.env.HOME);
  return resolve(WORKSPACE, p);
}

// Validate a user-supplied cwd at agent-creation time. Returns { cwd } on success
// or { error } on failure — never silently falls back. The dir must resolve under
// the workspace root and exist (Hadron is local-code-execution software, but a
// per-agent cwd shouldn't silently widen that to anywhere the server user can read).
function validateCwd(rawCwd) {
  if (rawCwd === undefined || rawCwd === null || rawCwd === "") return { cwd: undefined };
  const expanded = String(rawCwd).replace(/^~/, process.env.HOME || "");
  const abs = resolve(WORKSPACE, expanded);
  const root = resolve(WORKSPACE);
  if (abs !== root && !abs.startsWith(root + "/")) {
    return { error: `cwd must be inside the workspace (${root})` };
  }
  try {
    if (!statSync(abs).isDirectory()) return { error: `cwd is not a directory: ${abs}` };
  } catch {
    return { error: `cwd does not exist: ${abs}` };
  }
  return { cwd: abs };
}

// Runtime resolution for tmux/pty spawn — trusts an already-validated session.cwd,
// falls back to WORKSPACE if absent or no longer valid.
function resolveAgentCwd(session) {
  if (!session || !session.cwd) return WORKSPACE;
  const { cwd } = validateCwd(session.cwd);
  return cwd || WORKSPACE;
}


server.listen(PORT, HADRON_HOST, () => {
  const config = initWorkspace(WORKSPACE);
  AUTH_TOKEN = loadOrCreateToken();
  writeRuntimeFile();
  PROVENANCE = { ...collectProvenance(dirname(__dirname)), bootIdSource: BOOT.source };
  console.log(`[resume] boot generation ${BOOT.id} (source: ${BOOT.source})`);
  probeClaudeCaps(); // warm the capability cache before any autostart needs it
  // Additive self-heal: link any not-yet-linked operation skills into ~/.claude/skills/
  // so a new skill appears after `git pull` + restart. Additive only (never prune or
  // re-point) → safe with multiple servers / checkouts. Full reconcile is `hadron skills sync`.
  try {
    const s = syncSkills(dirname(__dirname));
    if (s.linked) console.log(`Skills: linked ${s.linked} new skill(s) into ~/.claude/skills/`);
  } catch {}
  console.log(`Workspace: ${WORKSPACE} (${config.name})`);
  if (HADRON_HOST !== "127.0.0.1") {
    console.log(`⚠ Binding ${HADRON_HOST} — API is reachable beyond localhost. Token + Origin guard active.`);
  }

  const loaded = loadAgents();
  let activeCount = 0;
  let archivedCount = 0;
  for (const [id, agent] of loaded) {
    if (agent.archived) {
      archivedCount++;
      continue;
    }
    agent.tmuxSession = tmuxSessionName(id);
    sessions.set(id, agent);
    activeCount++;
  }
  console.log(`Loaded ${activeCount} active agents, ${archivedCount} archived`);
  ensureDefaults();
  detectOrphanedTmuxSessions();
  for (const s of sessions.values()) {
    startMonitor(s.id);
    // Heal any window left pinned to `window-size manual` by older versions (caused clipping).
    fitWindowToClients(tmuxSessionName(s.id));
  }
  // Watch agent JSON files for external edits (e.g. Claude agents editing their own config)
  const agentsDir = join(getWorkspaceDir(), ".hadron", "agents");
  try {
    fsWatch(agentsDir, (eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      const id = filename.replace(/\.json$/, "");
      // Ignore our own writes — otherwise the watcher races server-side mutations
      // (e.g. an append) and can revert them.
      if (isSelfWrite(id)) return;
      const session = sessions.get(id);
      if (!session) return;
      try {
        const fresh = loadAgent(id);
        if (!fresh || fresh.archived) return;
        for (const key of ["name", "group", "task", "artifacts", "relatedAgents", "notes", "icon", "sortOrder", "deletable"]) {
          if (fresh[key] !== undefined) session[key] = fresh[key];
        }
      } catch {}
    });
  } catch {}

  console.log(`Hadron server running on http://localhost:${PORT}`);
});

function cleanupSubprocesses() {
  for (const pty of [...livePtys]) reapPty(pty); // release every master fd on shutdown
  for (const [, entry] of marimoProcesses) {
    try { entry.process.kill(); } catch {}
  }
  marimoProcesses.clear();
  for (const [, entry] of jupyterProcesses) {
    try { entry.process.kill(); } catch {}
  }
  jupyterProcesses.clear();
  removeRuntimeFile();
}
process.on("exit", cleanupSubprocesses);
process.on("SIGINT", () => { cleanupSubprocesses(); process.exit(0); });
process.on("SIGTERM", () => { cleanupSubprocesses(); process.exit(0); });
