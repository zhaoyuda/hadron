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
import { execFile, execFileSync } from "child_process";
import { CLAUDE_PROJECTS_ROOT } from "./session-registry.js";
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { tmuxSafe, shellQuoteArgv } from "./tmux.js";
import { warnOnce } from "./log.js";

export const UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/; // strict enough to be shell-inert (and path-inert)
export const RESUME_TTL_MS = 7 * 24 * 3600 * 1000;

// ── boot generation ──────────────────────────────────────────────────────
// Semantics: ONE resume attempt per agent per MACHINE boot. A service restart
// mid-boot must not re-fire a resume that already ran (or failed) this boot, so
// the generation is derived from the machine's boot id, not the process.
// HADRON_BOOT_ID overrides it (tests simulate reboots); when no source works
// the fallback is per-process and says so — silently degrading to "every
// restart is a new boot" is exactly the class of failure this module guards.
export function readBootId(env = process.env, platform = process.platform, { warn = warnOnce } = {}) {
  const override = env.HADRON_BOOT_ID;
  if (override !== undefined && override !== "") {
    if (/^[A-Za-z0-9._-]{1,64}$/.test(override)) return { id: `boot-${override}`, source: "env" };
    warn("bootid:server", `[resume] HADRON_BOOT_ID ${JSON.stringify(override)} ignored — must match [A-Za-z0-9._-]{1,64}`);
  }
  try {
    if (platform === "linux") {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      if (UUID_RE.test(id)) return { id: `boot-${id}`, source: "linux-boot_id" };
    } else if (platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/sec\s*=\s*(\d+)/);
      if (m) return { id: `boot-darwin-${m[1]}`, source: "darwin-kern.boottime" };
    }
  } catch {}
  const id = `boot-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  warn("bootid:server", `[resume] machine boot id unavailable on ${platform} — using per-process id ${id}; "one resume attempt per boot" degrades to per-server-start`);
  return { id, source: "process-random" };
}
export const BOOT = readBootId();
export const BOOT_GENERATION = BOOT.id;

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

// Does the transcript for a checkpointed id still exist under the agent's
// CURRENT cwd? A correlated id is only as good as that file: claude deletes
// old transcripts (cleanupPeriodDays), and an agent that scraped its id while
// cd'd elsewhere carries an id whose file lives under another project dir —
// `claude --resume` fails for both. (Seen on prod 2026-09-28: two green
// "resumes as correlated" agents whose files were gone.)
export function sessionFileExists(cwd, sessionId, { projectsRoot = CLAUDE_PROJECTS_ROOT } = {}) {
  if (!cwd || typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return false;
  return existsSync(join(projectsRoot, claudeProjectDir(cwd), `${sessionId}.jsonl`));
}

// Newest transcript in the agent-cwd's project dir, content-validated.
// Returns {sessionId, confidence} or null. Never returns an unvalidated guess.
export function scrapeSessionId(cwd, { projectsRoot = CLAUDE_PROJECTS_ROOT } = {}) {
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
// Operator-supplied session id (`hadron adopt`). Pure: returns { ok: true } or
// { ok: false, status, error }. Unless force, the id must be backed by the
// transcript claude wrote for THIS agent's cwd — and that cwd must actually be
// known: never fall back to the workspace/server cwd, or an unrelated root
// transcript could validate a hand-attached agent's id.
export function verifyAdoption(session, sessionId, { force = false, projectsRoot = CLAUDE_PROJECTS_ROOT } = {}) {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!UUID_RE.test(sid)) return { ok: false, status: 400, error: "sessionId must be a claude session uuid" };
  if (force === true) return { ok: true, sessionId: sid };
  const cwd = session && session.cwd;
  if (!cwd) return { ok: false, status: 400, error: "agent cwd is not known yet (pane not observed) — cannot verify the transcript; retry shortly or pass force" };
  const projectDir = join(projectsRoot, claudeProjectDir(cwd));
  const file = join(projectDir, `${sid}.jsonl`);
  if (!existsSync(file) || !validateSessionFile(file, sid, cwd)) {
    return { ok: false, status: 404, error: `no transcript for that session id under ${projectDir} (cwd ${cwd}) — pass force to adopt anyway` };
  }
  return { ok: true, sessionId: sid };
}

// Confidence levels that resume under every policy except "off" and that a
// later scrape may never overwrite: Hadron launched it (authoritative), the
// operator told us (manual, via `hadron adopt`), or claude's own process
// registry named it for this exact pane (registry, see session-registry.js).
// Pinned = identity is known; whether the transcript exists (resumability) is
// a separate question that performResume and doctor ask for EVERY level.
export const PINNED_CONFIDENCE = new Set(["authoritative", "manual", "registry"]);

export const isClaudeCmd = (c) => {
  if (!c) return false;
  const raw = String(c).trim().toLowerCase();
  // Test-only: force a specific pane command to be UNrecognised, to reproduce
  // the "looks like claude but the tracker never tracked it" class (the
  // claude.exe bug) without disabling recognition for every agent in the server.
  const un = process.env.HADRON_TEST_UNRECOGNIZE_CLAUDE_CMD;
  if (un && raw === un.toLowerCase()) return false;
  return CLAUDE_CMDS.has(raw.replace(/\.exe$/, ""));
};
// Sentinel for the silent-failure class this guards against: a command that
// looks like claude but isn't recognised means auto-resume is dead for that
// agent while nothing else complains. Warn once per (invariant, agent).
function warnClaudeish(cmd, agentId) {
  if (!/^claude/i.test(cmd || "")) return;
  warnOnce(`claudeish:${agentId}`, `[resume] agent ${agentId}: pane_current_command ${JSON.stringify(cmd)} looks like claude but is not tracked — auto-resume checkpoints will not be written`);
}
const SETTLE_POLLS = 3; // claude must be foreground this long before we track it
// How often the tracker consults claude's session registry: fast while the
// agent has no id at all (a readdir + a few small reads; the tmux spawn only
// happens when a record names this session), relaxed once it has one — a
// /clear or in-app /resume changes the id and is picked up within this.
export const REGISTRY_POLL_NO_ID_MS = 5 * 1000;
export const REGISTRY_POLL_MS = 30 * 1000;

export class RuntimeTracker {
  constructor(session, { save, cwdShared, scrape = scrapeSessionId, fileExists = sessionFileExists, registry = null }) {
    this.session = session;
    this.save = save; // (session, urgent) => void — urgent flushes immediately
    this.scrape = scrape; // (cwd) => { sessionId, confidence } | null — injectable for tests
    this.fileExists = fileExists; // (cwd, sessionId) => boolean — injectable for tests
    // registry: () => findRegistrySession(...) result for THIS agent's pane, or
    // null when the server has not wired one (unit tests). The deterministic
    // source: consulted before any scrape, and the only thing that may replace
    // a pinned id (it is claude itself reporting the current conversation).
    this.registry = registry;
    this.lastRegistryAt = 0;
    this.registryStatus = null; // last result status, for doctor
    // cwdShared(): does any OTHER agent share this agent's cwd right now?
    // Shared-cwd transcripts validate identically for every sharer (the head
    // only proves the cwd, not which agent owns the session), so scraping
    // there can adopt a sibling's session — refuse rather than guess.
    this.cwdShared = cwdShared || (() => false);
    this.claudePolls = 0;
    this.lastScrapeAt = 0;
    this.lastCheckAt = 0; // last transcript-exists validation of a correlated id
  }

  // Ask claude's registry which session runs in this pane. A different id
  // (fresh claude, /clear, in-app /resume) replaces whatever we had — pinned
  // or not: this is not a scrape guess, it is the process itself. The same id
  // is idempotent and keeps its provenance (an authoritative launch stays
  // authoritative). Nothing else about the checkpoint is touched — in
  // particular restoreAttempt, which a performResume in flight still owns.
  // Returns true when the id changed.
  consultRegistry(rt, now) {
    this.lastRegistryAt = now;
    let r;
    try { r = this.registry(); } catch (e) { r = { status: "unavailable", reason: e && e.message }; }
    this.registryStatus = r && r.status ? r.status : "unavailable";
    if (this.registryStatus === "matched") {
      if (rt.sessionId === r.sessionId) {
        // Same id: a pinned provenance stands; a scraped one is now confirmed
        // by claude itself — promote it so the 5-min file check cannot drop it.
        if (PINNED_CONFIDENCE.has(rt.confidence)) return false;
        rt.confidence = "registry";
        return true;
      }
      rt.sessionId = r.sessionId;
      rt.confidence = "registry";
      delete rt.transcriptSeen; // a new conversation: its file is not known to exist yet
      this.lastCheckAt = 0;
      console.log(`[resume] agent ${this.session.id}: session id taken from claude's session registry (pane matched, pid verified)`);
      return true;
    }
    if (this.registryStatus === "unverified") {
      // Live claude by pid+name only (no start time on this platform): good
      // enough to fill an empty checkpoint as a scrape-grade id (the 5-min
      // file check and a verified match can still correct it), never to
      // replace one — a crash-leftover record whose pid was reused would
      // otherwise pin a dead conversation over an authoritative id.
      if (rt.sessionId || !r.sessionId) return false;
      rt.sessionId = r.sessionId;
      rt.confidence = "correlated";
      // Explicitly "not seen yet": unlike a scraped id this one was never
      // validated against a file, so the missing-transcript drop below must
      // wait until the file has existed once (else fill/drop flaps every poll).
      // The trade: a pid-reuse ghost taken this way sits at permanent yellow
      // until a scrape or a later `matched` corrects it — in a shared cwd only
      // `hadron adopt` does. It can never resume (performResume needs the file).
      rt.transcriptSeen = false;
      this.lastCheckAt = 0;
      console.log(`[resume] agent ${this.session.id}: session id taken from claude's session registry (pane matched; the pid's start time could not be verified, so treated like a scrape)`);
      return true;
    }
    // Silent-failure rule: the deterministic path is off for this agent —
    // say so once, and let doctor show the status. Scraping still runs.
    const why = { none: `has no record for this pane${r && r.tmuxless ? ` (${r.tmuxless} record${r.tmuxless === 1 ? "" : "s"} in it lack the tmux field — an old claude or a claude outside tmux; \`hadron doctor\` sorts them)` : " (a claude launched before the registry existed, or not claude)"}`, unverified: "names this pane but the platform cannot verify the pid's start time and an id is already known — keeping it", stale: "names this pane only in records of exited processes", ambiguous: "has two live claudes claiming this pane", unavailable: `is unavailable (${r && r.reason || "unknown"})` }[this.registryStatus];
    warnOnce(`registry:${this.session.id}`, `[resume] agent ${this.session.id}: claude's session registry ${why} — falling back to transcript scraping`);
    return false;
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
        }
        // The settle itself is a transition, not a heartbeat: persist now. Otherwise a
        // Hadron-spawned session (desiredRuntime already "claude") has no lastObservedAt
        // on disk for up to 30 s, and a crash in that window is "checkpoint stale".
        urgent = true;
      }
      if (this.claudePolls >= SETTLE_POLLS) {
        rt.observedRuntime = "claude";
        rt.lastObservedAt = new Date().toISOString();
        // Session id: cheap to skip, expensive to find — only when missing or
        // stale (revalidate every 5 min; ids change when sessions fork).
        const now = Date.now();
        const shared = this.cwdShared();
        // Claude's own registry first: deterministic pane → session id. With
        // no id, poll fast (a fresh claude writes its record within seconds);
        // with one, every 30 s catches /clear. paneTarget is only resolved
        // when some record names this session, so old claudes cost a readdir.
        if (this.registry && now - this.lastRegistryAt > (rt.sessionId ? REGISTRY_POLL_MS : REGISTRY_POLL_NO_ID_MS)) {
          if (this.consultRegistry(rt, now)) urgent = true;
        }
        if (shared && !rt.sessionId) {
          warnOnce(`sharedcwd:${this.session.id}`, `[resume] agent ${this.session.id}: cwd ${JSON.stringify(this.session.cwd || null)} is shared with another agent (or unset) — its claude session id cannot be scraped; auto-resume is off for it until claude's session registry names this pane, it is launched by Hadron with --session-id, or \`hadron adopt\` pins it`);
        }
        const due = !rt.sessionId || now - this.lastScrapeAt > 5 * 60 * 1000;
        // Re-validate a correlated id every 5 min (its own clock — a shared cwd
        // never advances lastScrapeAt): its transcript must still exist under
        // the CURRENT cwd, or the checkpoint is a lie that `hadron doctor` would
        // show green and a reboot would fail on. Drop it (a fresh scrape follows
        // when the cwd is exclusive; a shared cwd goes red "no session id" —
        // honest, and `hadron adopt` fixes it). Pinned ids are never dropped
        // here: their identity is known (Hadron, the operator, or claude's
        // registry said so) and the file appears once claude writes the first
        // turn; a pinned id whose file is missing is red in doctor and refused
        // by performResume instead.
        // Every id, pinned or not, records once that its transcript has been
        // seen (rt.transcriptSeen): doctor tells "not written yet" (yellow)
        // from "was there, now gone" (red) by it.
        const checkDue = now - this.lastCheckAt > 5 * 60 * 1000;
        let fileThere = null;
        if (checkDue && UUID_RE.test(String(rt.sessionId)) && this.session.cwd) {
          this.lastCheckAt = now;
          fileThere = this.fileExists(this.session.cwd, rt.sessionId);
          if (fileThere && !rt.transcriptSeen) { rt.transcriptSeen = true; urgent = true; }
        }
        // Drop a non-pinned id whose transcript is gone — "gone" needs it to
        // have been there: scraped ids were validated against the file when
        // taken (transcriptSeen true), legacy checkpoints predate the flag
        // (undefined → treated as seen, the pre-flag behaviour); only an
        // unverified registry fill is explicitly false.
        if (fileThere === false && !PINNED_CONFIDENCE.has(rt.confidence) && rt.transcriptSeen !== false) {
          warnOnce(`stalesid:${this.session.id}`, `[resume] agent ${this.session.id}: the correlated session's transcript no longer exists under ${claudeProjectDir(this.session.cwd)} (deleted, or scraped while the pane was in another cwd) — checkpoint dropped${shared ? "; cwd is shared, so it cannot be re-scraped: run `hadron adopt <agent> --session-id <uuid>`" : ", re-scraping"}`);
          rt.sessionId = null;
          delete rt.confidence;
          delete rt.transcriptSeen;
          urgent = true;
        }
        // cwdShared() already returns true for an unset cwd (the server's own
        // cwd would attribute a foreign transcript), so no process.cwd() fallback.
        if (due && !shared && this.session.cwd) {
          this.lastScrapeAt = now;
          const hit = this.scrape(this.session.cwd);
          // Never demote an authoritative or manually adopted id with a scrape guess.
          if (hit && !PINNED_CONFIDENCE.has(rt.confidence) && rt.sessionId !== hit.sessionId) {
            rt.sessionId = hit.sessionId;
            rt.confidence = hit.confidence;
            rt.transcriptSeen = true; // the scrape read the file it names
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
    delete rt.transcriptSeen;
    this.lastCheckAt = 0;
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
  if (!PINNED_CONFIDENCE.has(conf) && !(conf === "correlated" && policy === "correlated")) {
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
// HADRON_RESUME_READY_POLLS: how many 2 s polls to wait for the TUI (default 30
// = 60 s; tests shorten the failed-resume path). Must be an integer 1..300 —
// anything else (incl. "Infinity") falls back to 30 so the wait stays bounded.
export function readyPollsFrom(raw) {
  const n = /^\d{1,3}$/.test(String(raw ?? "").trim()) ? Number(raw) : 30;
  return n >= 1 && n <= 300 ? n : 30;
}
const READY_POLLS = readyPollsFrom(process.env.HADRON_RESUME_READY_POLLS);

export async function performResume(session, tmuxName, { deliver, save, generation = BOOT_GENERATION, log = console.log, launchArgv = ["claude"], readyPolls = READY_POLLS, fileExists = sessionFileExists }) {
  const rt = session.runtime;
  const decision = decideResume(rt, { generation });
  if (!decision.resume) return decision;
  // Same check `hadron doctor` makes (doctor must never disagree with the code
  // that decides): an id whose transcript is gone from the agent's cwd — at
  // ANY confidence; identity being pinned does not make missing data
  // resumable — would burn the 60 s readiness wait and an attempt on a
  // `--resume` that cannot succeed.
  if (session.cwd && !fileExists(session.cwd, decision.sessionId)) {
    log(`[resume] ${session.id}: not resuming — the checkpoint's transcript is missing under ${claudeProjectDir(session.cwd)} (confidence ${rt.confidence || "ambiguous"})`);
    return { resume: false, reason: "transcript missing" };
  }

  rt.restoreAttempt = { generation, state: "started", attempts: (rt.restoreAttempt?.attempts || 0) + 1, at: new Date().toISOString() };
  save(session);
  // Logs carry agent ids, never session ids (the id is on disk in the checkpoint).
  log(`[resume] ${session.id}: resuming the checkpointed session (confidence ${rt.confidence || "ambiguous"}, attempt ${rt.restoreAttempt.attempts})`);

  await sleep(1500); // fresh pane: let the shell finish initializing
  // launchArgv: the agent's claude-kind launcher (a cc-* wrapper resumes through
  // the same wrapper, not bare claude — the provider config lives in it).
  // shellQuoteArgv: the line is re-parsed by the pane's shell, so argv boundaries
  // must be quoted through it. sessionId is UUID-validated by decideResume.
  deliver(tmuxName, `${shellQuoteArgv(launchArgv)} --resume ${decision.sessionId}`, true);

  // Wait for the TUI to own the pane before declaring ready (and before any
  // resumeCommand — pasting into a bash prompt would be shell execution).
  let up = false;
  for (let i = 0; i < readyPolls; i++) {
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
