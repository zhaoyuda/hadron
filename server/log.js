// Keyed once-only warnings for the silent-failure class: an invariant that,
// when false, disables a feature without breaking anything. Such a warning
// must fire once per distinct (invariant, agent) — a process-global boolean
// hides the second affected agent. Key convention: `<invariant>:<agentId>`.
// Doctor (step 3) reads the fired set so every warning is also a finding.
export const firedWarnings = new Map(); // key → { msg, at }

export function warnOnce(key, msg, { warn = console.warn } = {}) {
  if (firedWarnings.has(key)) return false;
  firedWarnings.set(key, { msg, at: new Date().toISOString() });
  warn(msg);
  return true;
}

export function resetWarnOnce() { firedWarnings.clear(); }
