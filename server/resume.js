/**
 * Agent session resume — checkpoint + self-heal (ROADMAP v0.9).
 *
 * Design: design-notes/deploy-resume-design.md (§2 as revised by §5).
 *
 * Three pieces:
 *  - RuntimeTracker: piggybacks on the state detector's 1s poll to keep a
 *    per-agent `runtime` checkpoint in the agent JSON: what the pane is
 *    running (claude vs shell), which claude session id, at what confidence,
 *    plus a clean-exit tombstone so a deliberate exit is never "healed".
 *  - decideResume(): pure decision — resume only when the checkpoint says the
 *    agent WAS in claude, didn't exit cleanly, is fresh, and the session id is
 *    trustworthy. Ambiguous ids never auto-resume. `--continue` is never used
 *    automatically (directory-recency has no agent-identity guarantee).
 *  - performResume(): injects `claude --resume <id>` into the freshly created
 *    pane, waits for the TUI, then sends the agent's OPT-IN resumeCommand
 *    (default: nothing — agents without e.g. /rc are never force-fed one).
 *
 * The only automatic trigger is "Hadron itself just created this tmux session"
 * (server boot after a machine crash). A pane the user parked at a shell is a
 * legal state and is left alone.
 */
import { execFile } from "child_process";
import { readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { tmuxSafe, shellQuoteArgv } from "./tmux.js";
import { warnOnce } from "./log.js";

const UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/; // strict enough to be shell-inert
export const RESUME_TTL_MS = 7 * 24 * 3600 * 1000;
export const BOOT_GENERATION = `boot-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

// ── capability probe ─────────────────────────────────────────────────────
// Codex review: probe and persist, never silently fall back to guessing.
// Under systemd the service PATH is minimal and `claude` lives in the user's
// login PATH (~/.local/bin) — the agents' interactive shells find it, so the
// probe must look where THEY look: try the bare name first, then the same
// user-level install locations a login shell would.
const CLAUDE_CANDIDATES = [
  "claude",
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".npm-global", "bin", "claude"),
  "/usr/local/bin/claude",
];
let capsPromise = null;
export function probeClaudeCaps() {
  if (capsPromise) return capsPromise;
  capsPromise = (async () => {
    for (const bin of CLAUDE_CANDIDATES) {
      const caps = await new Promise((res) => {
        execFile(bin, ["--help"], { timeout: 15000 }, (err, stdout) => {
          const help = String(stdout || "");
          res(err ? null : { probed: true, resume: help.includes("--resume"), sessionId: help.includes("--session-id") });
        });
      });
      if (caps) {
        console.log(`[resume] claude caps via ${bin}: resume=${caps.resume} session-id=${caps.sessionId}`);
        return caps;
      }
    }
    console.log("[resume] claude caps: probe failed (claude not found) — spawn-id injection disabled");
    return { probed: false, resume: false, sessionId: false };
  })();
  return capsPromise;
}

// ── claude project-dir mapping + session file validation ────────────────
export function claudeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

// A transcript's own head records its sessionId + cwd — cross-check both so a
// filename picked by mtime can be promoted from "guess" to "correlated".
export function validateSessionFile(file, expectSessionId, expectCwd) {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    for (const line of buf.toString("utf-8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // partial last line of the chunk
      const sid = rec.sessionId || rec.session_id;
      if (!sid) continue;
      return sid === expectSessionId && (!rec.cwd || rec.cwd === expectCwd);
    }
  } catch {}
  return false;
}

// Newest transcript in the agent-cwd's project dir, content-validated.
// Returns {sessionId, confidence} or null. Never returns an unvalidated guess.
export function scrapeSessionId(cwd, { projectsRoot = join(homedir(), ".claude", "projects") } = {}) {
  try {
    const dir = join(projectsRoot, claudeProjectDir(cwd));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(0, 3)) {
      const sid = f.slice(0, -6);
      if (!UUID_RE.test(sid)) continue;
      if (validateSessionFile(join(dir, f), sid, cwd)) {
        return { sessionId: sid, confidence: "correlated" };
      }
    }
  } catch {}
  return null;
}

// ── runtime checkpoint tracker ───────────────────────────────────────────
// "claude" only — deliberately NOT "node": a dev server running in the pane
// must not be checkpointed as a claude session (a wrong auto-resume is worse
// than a missed one). The claude CLI reports pane_current_command="claude" on
// Linux and "claude.exe" on macOS (how the native binary is shipped) — the
// suffix is normalized away, not enumerated, in case it changes again.
const CLAUDE_CMDS = new Set(["claude"]);
export const isClaudeCmd = (c) => !!c && CLAUDE_CMDS.has(String(c).trim().toLowerCase().replace(/\.exe$/, ""));
// Sentinel for the silent-failure class this guards against: a command that
// looks like claude but isn't recognised means auto-resume is dead for that
// agent while nothing else complains. Warn once per (invariant, agent).
function warnClaudeish(cmd, agentId) {
  if (!/^claude/i.test(cmd || "")) return;
  warnOnce(`claudeish:${agentId}`, `[resume] agent ${agentId}: pane_current_command ${JSON.stringify(cmd)} looks like claude but is not tracked — auto-resume checkpoints will not be written`);
}
const SETTLE_POLLS = 3; // claude must be foreground this long before we track it

export class RuntimeTracker {
  constructor(session, { save, cwdShared }) {
    this.session = session;
    this.save = save; // (session, urgent) => void — urgent flushes immediately
    // cwdShared(): does any OTHER agent share this agent's cwd right now?
    // Shared-cwd transcripts validate identically for every sharer (the head
    // only proves the cwd, not which agent owns the session), so scraping
    // there can adopt a sibling's session — refuse rather than guess.
    this.cwdShared = cwdShared || (() => false);
    this.claudePolls = 0;
    this.lastScrapeAt = 0;
  }

  // Called from the state detector's poll with the pane's foreground command.
  // Transitions persist immediately (urgent); heartbeat refreshes are throttled
  // by the caller-provided save.
  observe(cmd) {
    const rt = this.session.runtime || (this.session.runtime = {});
    const isClaude = isClaudeCmd(cmd);
    if (!isClaude) warnClaudeish(cmd, this.session.id);

    if (isClaude) {
      this.claudePolls++;
      let urgent = false;
      if (this.claudePolls === SETTLE_POLLS) {
        // shell → claude: the agent is (back) in a session; clear any tombstone.
        if (rt.desiredRuntime !== "claude" || rt.cleanExitAt) {
          rt.desiredRuntime = "claude";
          rt.cleanExitAt = null;
          delete rt.restoreAttempt; // a live session supersedes old attempts
          urgent = true;
        }
      }
      if (this.claudePolls >= SETTLE_POLLS) {
        rt.observedRuntime = "claude";
        rt.lastObservedAt = new Date().toISOString();
        // Session id: cheap to skip, expensive to find — only when missing or
        // stale (revalidate every 5 min; ids change when sessions fork).
        const now = Date.now();
        if ((!rt.sessionId || now - this.lastScrapeAt > 5 * 60 * 1000) && !this.cwdShared()) {
          this.lastScrapeAt = now;
          const hit = scrapeSessionId(this.session.cwd || process.cwd());
          // Never demote an authoritative id with a scrape guess.
          if (hit && rt.confidence !== "authoritative" && rt.sessionId !== hit.sessionId) {
            rt.sessionId = hit.sessionId;
            rt.confidence = hit.confidence;
            urgent = true;
          }
        }
        this.save(this.session, urgent);
      }
    } else {
      // claude → shell while the server is alive = a deliberate exit.
      if (this.claudePolls >= SETTLE_POLLS) {
        rt.observedRuntime = "shell";
        rt.desiredRuntime = "shell";
        rt.cleanExitAt = new Date().toISOString();
        this.save(this.session, true);
      }
      this.claudePolls = 0;
    }
  }

  // Hadron launched claude itself with a chosen --session-id: exact knowledge.
  recordSpawnedSession(sessionId) {
    const rt = this.session.runtime || (this.session.runtime = {});
    rt.sessionId = sessionId;
    rt.confidence = "authoritative";
    rt.desiredRuntime = "claude";
    rt.cleanExitAt = null;
    this.save(this.session, true);
  }
}

// ── resume decision (pure) ───────────────────────────────────────────────
// policy: "authoritative" (only spawn-injected ids) | "correlated" (default:
// also content-validated scraped ids) | "off"
export function decideResume(runtime, { now = Date.now(), ttlMs = RESUME_TTL_MS, policy = "correlated", generation = BOOT_GENERATION } = {}) {
  if (policy === "off") return { resume: false, reason: "autoResume off" };
  if (!runtime) return { resume: false, reason: "no checkpoint" };
  if (runtime.desiredRuntime !== "claude") return { resume: false, reason: "was not in claude" };
  if (runtime.cleanExitAt) return { resume: false, reason: "clean exit tombstone" };
  if (!runtime.sessionId) return { resume: false, reason: "no session id" };
  if (!UUID_RE.test(runtime.sessionId)) return { resume: false, reason: "malformed session id" };
  const conf = runtime.confidence || "ambiguous";
  if (conf !== "authoritative" && !(conf === "correlated" && policy === "correlated")) {
    return { resume: false, reason: `confidence ${conf} below policy ${policy}` };
  }
  const seen = Date.parse(runtime.lastObservedAt || 0);
  if (!seen || now - seen > ttlMs) return { resume: false, reason: "checkpoint stale" };
  const ra = runtime.restoreAttempt;
  if (ra && ra.generation === generation) return { resume: false, reason: "already attempted this boot" };
  if (ra && (ra.attempts || 0) >= 3) return { resume: false, reason: "attempts exhausted" };
  return { resume: true, sessionId: runtime.sessionId };
}

// ── resume execution ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deliver: (tmuxName, text, enter) => void — the server's bracketed-paste
// message path, injected so this module stays free of buffer bookkeeping.
export async function performResume(session, tmuxName, { deliver, save, generation = BOOT_GENERATION, log = console.log, launchArgv = ["claude"] }) {
  const rt = session.runtime;
  const decision = decideResume(rt, { generation });
  if (!decision.resume) return decision;

  rt.restoreAttempt = { generation, state: "started", attempts: (rt.restoreAttempt?.attempts || 0) + 1, at: new Date().toISOString() };
  save(session);
  log(`[resume] ${session.id}: resuming session ${decision.sessionId}`);

  await sleep(1500); // fresh pane: let the shell finish initializing
  // launchArgv: the agent's claude-kind launcher (a cc-* wrapper resumes through
  // the same wrapper, not bare claude — the provider config lives in it).
  // shellQuoteArgv: the line is re-parsed by the pane's shell, so argv boundaries
  // must be quoted through it. sessionId is UUID-validated by decideResume.
  deliver(tmuxName, `${shellQuoteArgv(launchArgv)} --resume ${decision.sessionId}`, true);

  // Wait for the TUI to own the pane before declaring ready (and before any
  // resumeCommand — pasting into a bash prompt would be shell execution).
  let up = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const cmd = tmuxSafe(["display-message", "-t", tmuxName, "-p", "#{pane_current_command}"]);
    if (isClaudeCmd(cmd)) { up = true; break; }
  }
  rt.restoreAttempt.state = up ? "ready" : "failed";
  save(session);
  if (!up) {
    log(`[resume] ${session.id}: claude TUI did not come up`);
    return { resume: true, failed: true };
  }

  // Opt-in per-agent follow-up (e.g. "/rc"). Default: none — an agent that
  // doesn't have the skill is never force-fed a slash command.
  const cmd = typeof session.resumeCommand === "string" ? session.resumeCommand.replace(/[\x00-\x1f\x7f]/g, "").trim() : "";
  if (cmd) {
    await sleep(6000); // let the resumed conversation finish loading
    deliver(tmuxName, cmd, true);
    log(`[resume] ${session.id}: sent resumeCommand ${JSON.stringify(cmd)}`);
  }
  return { resume: true, ready: true };
}
