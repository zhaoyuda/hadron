import express from "express";
import http from "http";
const { createServer } = http;
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";
import { execSync, execFileSync, spawn as cpSpawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, watch as fsWatch, chmodSync } from "fs";
import { connect as netConnect } from "net";
import { networkInterfaces, hostname } from "os";
import { URL } from "url";
import { randomBytes } from "crypto";
import { StateDetector } from "./state-detector.js";
import { loadAgents, loadAgent, saveAgent, archiveAgent, deleteAgent, initWorkspace, getWorkspaceDir, appendAgentField, isSelfWrite } from "./agent-store.js";
import { resolve } from "path";
import { tmux, tmuxSafe, isValidId } from "./tmux.js";

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
  const token = req.headers["x-hadron-token"] || req.query.token;
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) return res.status(401).json({ error: "invalid or missing token" });
  next();
}
app.use("/api", requireAuth);

// ═══ SESSION MANAGEMENT ═══

const sessions = new Map();

// Autostart launch commands are a known enum, NOT a free-form string — a string would
// be a shell footgun (and agent-supplied via the API). "shell" means no autostart.
const LAUNCH_COMMANDS = { claude: ["claude"], codex: ["codex"], shell: null };
const launchLocks = new Set(); // ids currently autostarting (TOCTOU guard)

function tmuxSessionName(id) {
  return `${TMUX_PREFIX}-${id}`;
}

function getDefaultLaunchCommand() {
  try {
    const config = JSON.parse(readFileSync(join(getWorkspaceDir(), ".hadron", "config.json"), "utf-8"));
    if (config.launchCommand && LAUNCH_COMMANDS[config.launchCommand] !== undefined) return config.launchCommand;
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
  const argv = LAUNCH_COMMANDS[launchCommand];
  if (!argv) return; // shell → nothing to launch
  if (launchLocks.has(id)) return;
  const session = sessions.get(id);
  if (session && session.autostartedAt) return; // once per creation
  launchLocks.add(id);
  const tmuxName = tmuxSessionName(id);
  (async () => {
    try {
      tmux(["send-keys", "-t", tmuxName, "--", argv.join(" "), "Enter"]);
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

function ensureTmuxSession(sessionId, cwd) {
  const tmuxName = tmuxSessionName(sessionId);
  try {
    tmux(["has-session", "-t", tmuxName]);
  } catch {
    tmux(["new-session", "-d", "-s", tmuxName, "-x", "80", "-y", "24", "-c", cwd || WORKSPACE]);
    applyAgentEnv(tmuxName, cwd || WORKSPACE);
  }
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
  const resolved = sorted.map(s => ({
    ...s,
    artifacts: (s.artifacts || []).map(a => ({
      ...a,
      value: a.value ? resolveFilePath(a.value) : a.value
    }))
  }));
  res.json(resolved);
});

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

  // launchCommand is enum-only and never an arbitrary command string from the API.
  let launchCommand = req.body.launchCommand;
  if (launchCommand !== undefined && LAUNCH_COMMANDS[launchCommand] === undefined) {
    return res.status(400).json({ error: `launchCommand must be one of: ${Object.keys(LAUNCH_COMMANDS).join(", ")}` });
  }
  if (launchCommand === undefined) launchCommand = getDefaultLaunchCommand();

  // Validate cwd up front — never silently fall back.
  const cwdResult = validateCwd(cwd);
  if (cwdResult.error) return res.status(400).json({ error: cwdResult.error });

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
    if (Array.isArray(artifacts)) session.artifacts = artifacts;
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
  res.status(201).json(session);
});

app.patch("/api/sessions/:id", (req, res) => {
  const { id } = req.params;
  if (!sessions.has(id)) {
    return res.status(404).json({ error: "session not found" });
  }
  const session = sessions.get(id);
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
  if (artifacts !== undefined) session.artifacts = artifacts;
  if (relatedAgents !== undefined) session.relatedAgents = relatedAgents;
  if (sortOrder !== undefined) session.sortOrder = sortOrder;
  if (deletable !== undefined) session.deletable = deletable;
  const shouldSave = [name, task, notes, artifacts, relatedAgents, group, icon, sortOrder, deletable].some(v => v !== undefined);
  if (shouldSave) saveAgent(session);
  res.json(session);
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

// Append one artifact without clobbering the array (atomic, under per-agent lock).
app.post("/api/sessions/:id/artifacts", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  if (!sessions.has(id)) return res.status(404).json({ error: "session not found" });
  const { type = "file", value, label } = req.body;
  if (!value || typeof value !== "string") return res.status(400).json({ error: "value (string) required" });
  const item = { type, value };
  if (label) item.label = label;
  const updated = await appendAgentField(id, "artifacts", item);
  if (updated) sessions.get(id).artifacts = updated.artifacts;
  res.json(sessions.get(id));
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
app.head("/api/file", (req, res) => {
  const filePath = resolveFilePath(req.query.path);
  if (!filePath) return res.status(400).end();
  try {
    const stat = statSync(filePath);
    res.set("X-File-Mtime", String(stat.mtimeMs));
    res.status(200).end();
  } catch { res.status(404).end(); }
});

app.get("/api/file", (req, res) => {
  const filePath = resolveFilePath(req.query.path);
  if (!filePath) return res.status(400).json({ error: "path is required" });
  try {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const ext = filePath.split(".").pop().toLowerCase();
    const mime = ext === "html" || ext === "htm" ? "text/html" : "text/plain";
    res.set("Last-Modified", stat.mtime.toUTCString());
    res.set("X-File-Mtime", String(stat.mtimeMs));
    res.type(mime).send(content);
  } catch (e) {
    res.status(404).json({ error: "file not found" });
  }
});

// Write API — edits an *existing* file in place. Restricted to regular files that
// already exist (so it can't be used to create arbitrary new files anywhere the
// server user can write); token + host + origin are already enforced by requireAuth.
app.post("/api/file", (req, res) => {
  const filePath = resolveFilePath(req.body && req.body.path);
  if (!filePath) return res.status(400).json({ error: "path is required" });
  const content = req.body && req.body.content;
  if (typeof content !== "string") return res.status(400).json({ error: "content (string) is required" });
  let stat;
  try { stat = statSync(filePath); } catch { return res.status(404).json({ error: "file not found" }); }
  if (!stat.isFile()) return res.status(400).json({ error: "not a regular file" });
  try {
    writeFileSync(filePath, content, "utf-8");
    const newStat = statSync(filePath);
    res.set("X-File-Mtime", String(newStat.mtimeMs));
    res.json({ ok: true, mtime: newStat.mtimeMs });
  } catch (e) {
    res.status(500).json({ error: "write failed" });
  }
});

app.get("/api/files/suggest", (req, res) => {
  const cwd = resolveFilePath(req.query.cwd) || WORKSPACE;
  const agentId = (req.query.agentId || "").toLowerCase();
  const PATTERNS = /\.(md|py|ipynb|csv|sql|js|ts|jsx|tsx|yaml|yml|json|sh|go|rs|rb|java|toml|html|css|txt)$/i;
  const IGNORE = /^(node_modules|\.git|__pycache__|\.venv|\.env|\.hadron|\.cache|\.next|dist|build|\.tox)$/;
  const HUMAN_EXT = /\.(md|html|htm|csv|ipynb)$/i;
  const SOURCE_EXT = /\.(js|ts|jsx|tsx|py|go|rs|java|rb|sh)$/i;
  const CONFIG_EXT = /\.(json|yaml|yml|toml|css)$/i;
  const OUTPUT_KW = /output|report|review|summary|result|spike|notes|doc/i;
  const OUTPUT_DIR = /^(docs|output|reports|results|reviews)\//i;
  const MAX_FILES = 80;
  const results = [];

  function scan(dir, depth) {
    if (depth > 3 || results.length >= MAX_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (IGNORE.test(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath, depth + 1);
      } else if (PATTERNS.test(entry.name)) {
        const relPath = fullPath.slice(resolve(cwd).length + 1);
        results.push({ path: relPath, name: entry.name });
      }
    }
  }

  scan(resolve(cwd), 0);

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
  res.json(filtered);
});

app.get("/api/files/browse", (req, res) => {
  const relPath = req.query.path || "";
  const baseCwd = resolveFilePath(req.query.cwd) || WORKSPACE;
  const target = relPath ? resolve(baseCwd, relPath) : resolve(baseCwd);
  const IGNORE = /^(node_modules|\.git|__pycache__|\.venv|\.env|\.hadron|\.cache|\.next|dist|build|\.tox)$/;

  if (!target.startsWith(resolve(baseCwd))) return res.status(403).json({ error: "path outside workspace" });

  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); } catch { return res.status(404).json({ error: "directory not found" }); }

  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (IGNORE.test(entry.name) || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) dirs.push({ name: entry.name, type: "dir" });
    else files.push({ name: entry.name, type: "file" });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  res.json([...dirs, ...files]);
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
      attempts++;
      const checkReq = http.get(`http://127.0.0.1:${port}${baseUrl}api/status`, (r) => {
        r.resume();
        res.json({ port, proxyBase: `/jupyter-proxy/${port}`, fileName });
      });
      checkReq.on("error", () => {
        if (attempts < 20) setTimeout(checkReady, 500);
        else res.json({ port, proxyBase: `/jupyter-proxy/${port}`, fileName });
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

function startMonitor(sessionId) {
  if (monitors.has(sessionId)) return;
  const session = sessions.get(sessionId);
  if (!session) return;

  ensureTmuxSession(sessionId);
  const detector = new StateDetector(tmuxSessionName(sessionId), session);
  monitors.set(sessionId, detector);
  console.log(`Monitor started for session: ${sessionId}`);
}

function stopMonitor(sessionId) {
  const detector = monitors.get(sessionId);
  if (detector) {
    detector.dispose();
    monitors.delete(sessionId);
  }
}

// ═══ WebSocket server ═══
const wss = new WebSocketServer({ noServer: true });

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
  } else {
    ensureTmuxSession(sessionId, resolveAgentCwd(sessions.get(sessionId)));
  }

  let pty;
  try {
    pty = spawn(
      "tmux",
      ["attach-session", "-t", effectiveTmuxName],
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

  // Only start state monitor for primary sessions, not shells
  if (!isShell) {
    startMonitor(sessionId);
  }

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  pty.onExit(({ exitCode }) => {
    console.log(`PTY exited for session ${sessionId}${isShell ? ` (shell: ${shellName})` : ""} with code ${exitCode}`);
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
        pty.resize(cols, rows);
        tmuxSafe(["resize-window", "-t", effectiveTmuxName, "-x", String(cols), "-y", String(rows)]);
      }
    } catch {
      pty.write(msg.toString());
    }
  });

  ws.on("close", () => {
    pty.kill();
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
  for (const [, entry] of marimoProcesses) {
    try { entry.process.kill(); } catch {}
  }
  marimoProcesses.clear();
  for (const [, entry] of jupyterProcesses) {
    try { entry.process.kill(); } catch {}
  }
  jupyterProcesses.clear();
}
process.on("exit", cleanupSubprocesses);
process.on("SIGINT", () => { cleanupSubprocesses(); process.exit(0); });
process.on("SIGTERM", () => { cleanupSubprocesses(); process.exit(0); });
