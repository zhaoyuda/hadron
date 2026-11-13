/**
 * Dialog parser for the chat view's permission cards (G4).
 *
 * Claude Code draws its interactive dialogs (tool permission, plan approval,
 * AskUserQuestion, folder trust) as plain text at the bottom of the pane: a
 * body, usually fenced by ╌╌╌ rules, a question, a numbered option list with
 * the selection marked ❯, and a hint line ("Esc to cancel · Tab to amend").
 * parseDialog turns the pane capture into {kind, title, sections, question,
 * options, hints, …} so the card can show the ACTUAL operation and choices —
 * never generic "1 / 2 / Esc" buttons. A pane the parser cannot read gives
 * null and the card hands over to the terminal.
 *
 * `key` is a hash of the dialog's text (the selection marker excluded — it
 * moves): the answer route refuses an answer whose key is not the dialog on
 * screen (the dialog changed, another device answered first, claude moved on)
 * and re-reads the pane under the pane lock before typing. `render` hashes
 * the whole screen, so the same dialog shown again is a new showing.
 *
 * Pure: no tmux, no I/O. Shapes captured from Claude Code 2.1.304 are in
 * test/unit/fixtures/state-detector/blocked-dialog-*.txt.
 */

export const DIALOG_MAX_BODY_LINES = 40;
export const DIALOG_MAX_LINE = 240;
export const DIALOG_MAX_BYTES = 8192;

const NUMBERED_RE = /^(\s*)(❯\s+)?(\d{1,2})\.\s(.*)$/;      // ` ❯ 1. Yes` / `   2. Yes, and …`
const UNNUMBERED_RE = /^(\s*)❯\s+(\S.*)$/;                   // ` ❯ No, exit` (folder trust)
const DASHED_RULE_RE = /^\s*╌{8,}\s*$/;                       // section fence inside a dialog
const SOLID_RULE_RE = /^\s*─{8,}\s*$/;                        // dialog boundary / separator
const HINT_RE = /Esc to cancel|Enter to (select|confirm)|Tab to amend|ctrl\+g|shift\+tab|↑\/↓/;
// Where a dialog's body ends going upwards: claude's own transcript bullets.
const TRANSCRIPT_MARK_RE = /^(\s*⎿|[●⏺✻]\s|❯\s(?!\d{1,2}\.\s))/;
const TIP_RE = /^\s*Tip: /;
// An option that opens a text field (or hands the typed text to claude).
const TEXT_OPTION_RE = /tell Claude what|Type something|Chat about this/i;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const clip = (s) => (s.length > DIALOG_MAX_LINE ? `${s.slice(0, DIALOG_MAX_LINE - 1)}…` : s);

// Find the option block: the bottom-most run of numbered lines 1..k (or ❯-marked
// unnumbered lines) with their continuation lines. Returns {start, end, options,
// numbered} over indices into `lines`, or null.
function findOptions(lines) {
  // bottom-most numbered line
  let last = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    if (NUMBERED_RE.test(lines[i])) { last = i; break; }
  }
  if (last >= 0) {
    const rows = []; // {i, n, col, selected, label, detail}
    let i = last;
    let numCol = null;
    let pending = []; // continuation lines read before (= below) their numbered line
    for (; i >= 0; i--) {
      const line = lines[i];
      const m = NUMBERED_RE.exec(line);
      if (m) {
        const col = m[1].length + (m[2] ? m[2].length : 0);
        if (numCol !== null && Math.abs(col - numCol) > 2) break; // a numbered list further up is not this block
        numCol = col;
        rows.unshift({ i, n: Number(m[3]), col, selected: Boolean(m[2]), label: m[4].trim(), detail: pending });
        pending = [];
        if (Number(m[3]) === 1) break;
        continue;
      }
      if (!rows.length) break;
      if (SOLID_RULE_RE.test(line)) { rows[0].sepAbove = true; continue; }         // "────" between option groups
      const indent = line.length - line.trimStart().length;
      if (line.trim() && numCol !== null && indent > numCol) { pending.unshift(line.trim()); continue; }
      break;
    }
    if (!rows.length || rows[0].n !== 1) return null;
    for (let k = 1; k < rows.length; k++) if (rows[k].n !== rows[k - 1].n + 1) return null;
    if (!rows.some((r) => r.selected)) return null;
    // continuation lines BELOW the last numbered line (… "from this project")
    let end = rows[rows.length - 1].i;
    for (let j = end + 1; j < lines.length; j++) {
      const l = lines[j];
      const indent = l.length - l.trimStart().length;
      if (l.trim() && indent > numCol) { rows[rows.length - 1].detail.push(l.trim()); end = j; } else break; // deeper than the number: still the option
    }
    const options = rows.map((r) => ({ n: r.n, label: r.label, selected: r.selected, ...(r.detail.length ? { detail: r.detail.join(" ") } : {}), ...(r.sepAbove ? { sepAbove: true } : {}), ...(TEXT_OPTION_RE.test(r.label) ? { text: true } : {}) }));
    return { start: rows[0].i, end, options, numbered: true };
  }
  // unnumbered: a ❯ line with sibling lines at the same indent as its text
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const m = UNNUMBERED_RE.exec(lines[i]);
    if (!m) continue;
    const col = lines[i].indexOf(m[2]);
    const rows = [{ i, label: m[2].trim(), selected: true }];
    for (let j = i - 1; j >= 0; j--) { const l = lines[j]; if (l.trim() && l.length - l.trimStart().length === col && !UNNUMBERED_RE.test(l) && !HINT_RE.test(l)) rows.unshift({ i: j, label: l.trim(), selected: false }); else break; }
    for (let j = i + 1; j < lines.length; j++) { const l = lines[j]; if (l.trim() && l.length - l.trimStart().length === col && !UNNUMBERED_RE.test(l) && !HINT_RE.test(l)) rows.push({ i: j, label: l.trim(), selected: false }); else break; }
    if (rows.length < 2) return null;
    // a quoted "❯ something" with aligned neighbours is not a dialog: the real
    // list has claude's hint row ("Enter to confirm · Esc to cancel") under it
    const end = rows[rows.length - 1].i;
    if (!lines.slice(end + 1, end + 5).some((l) => HINT_RE.test(l))) return null;
    return { start: rows[0].i, end, options: rows.map((r, idx) => ({ n: idx + 1, label: r.label, selected: r.selected })), numbered: false };
  }
  return null;
}

/**
 * @param {string[]} rawLines  a tmux capture-pane, top to bottom
 * @returns {object|null} the dialog, or null when the pane shows no readable one
 */
export function parseDialog(rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) return null;
  const lines = rawLines.map((l) => String(l ?? "").replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const opt = findOptions(lines);
  if (!opt) return null;

  // hints: the few non-empty lines right under the options
  const hints = [];
  for (let j = opt.end + 1; j < lines.length && j <= opt.end + 4; j++) {
    const l = lines[j].trim();
    if (!l) continue;
    if (HINT_RE.test(l)) hints.push(l);
    else if (!SOLID_RULE_RE.test(l)) break; // text that is not a hint: the options are not the last thing — read no further
  }

  // body: upwards from the options to a transcript bullet; the preamble above
  // the first ──── rule is not the dialog (claude's status lines, a previous
  // turn that had no bullet). A body longer than the cap keeps its LAST lines —
  // the question and the structure around it — and says so.
  let top = opt.start;
  for (let i = opt.start - 1; i >= 0; i--) {
    if (TRANSCRIPT_MARK_RE.test(lines[i])) break;
    top = i;
  }
  let body = lines.slice(top, opt.start);
  const firstRule = body.findIndex((l) => SOLID_RULE_RE.test(l));
  if (firstRule >= 0) body = body.slice(firstRule + 1);
  body = body.filter((l) => !TIP_RE.test(l));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  let truncated = false, codeAtStart = false;
  if (body.length > DIALOG_MAX_BODY_LINES) {
    const dropped = body.slice(0, body.length - DIALOG_MAX_BODY_LINES);
    codeAtStart = dropped.filter((l) => DASHED_RULE_RE.test(l)).length % 2 === 1; // cut inside a fence
    body = body.slice(-DIALOG_MAX_BODY_LINES);
    truncated = true;
  }

  // sections: text / code, split on ╌╌╌ fences (odd segments are fenced)
  const sections = [];
  let cur = [], code = codeAtStart;
  const flush = () => {
    let text = cur.join("\n").replace(/^\n+|\n+$/g, "");
    if (code) { // code keeps its own indentation, minus the margin claude draws it with
      const ind = text.split("\n").filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
      const m = ind.length ? Math.min(...ind) : 0;
      if (m) text = text.split("\n").map((l) => l.slice(m)).join("\n");
      // newer claude draws a long command with a │ border down its left edge
      const lines = text.split("\n");
      if (lines.every((l) => !l.trim() || /^│/.test(l))) text = lines.map((l) => l.replace(/^│ ?/, "")).join("\n");
    }
    if (text.trim()) sections.push({ code, text });
    cur = [];
  };
  for (const l of body) {
    if (DASHED_RULE_RE.test(l)) { flush(); code = !code; continue; }
    if (!code && SOLID_RULE_RE.test(l)) { flush(); continue; }
    cur.push(code ? clip(l) : clip(l.trim()));
  }
  flush();
  const textSecs = sections.filter((s) => !s.code);
  const title = textSecs.length ? textSecs[0].text.split("\n")[0] : "";
  const lastText = textSecs.length ? textSecs[textSecs.length - 1].text.split("\n").filter(Boolean) : [];
  let question = lastText.length ? lastText[lastText.length - 1] : "";
  if (!/\?$|proceed|allow/i.test(question) || (question === title && textSecs.length === 1 && lastText.length === 1)) question = "";

  const bodyText = sections.map((s) => s.text).join("\n");
  const hintText = hints.join(" · ");
  let kind;
  if (/written up a plan|Here is Claude's plan|Ready to code\?/.test(bodyText)) kind = "plan";
  else if (!opt.numbered) kind = "select";
  else if (/↑\/↓/.test(hintText) || /^[☐☑]/.test(title)) kind = "question";
  else if (/^Do you want to|Allow or deny|wants to/i.test(question) || /Tab to amend/.test(hintText) || opt.options.some((o) => /^Yes\b/.test(o.label)) && opt.options.some((o) => /^No\b/.test(o.label))) kind = "permission";
  else kind = "select";

  const dialog = {
    kind, title, question, sections, options: opt.options, hints,
    numbered: opt.numbered,
    cancel: /Esc to cancel/.test(hintText) || opt.options.some((o) => /\(esc\)/.test(o.label)),
    amend: /Tab to amend/.test(hintText),
    ...(truncated ? { truncated: true } : {}),
  };
  // size cap: drop sections from the top until the wire form fits
  while (JSON.stringify(dialog).length > DIALOG_MAX_BYTES && dialog.sections.length > 1) { dialog.sections.shift(); dialog.truncated = true; }
  if (JSON.stringify(dialog).length > DIALOG_MAX_BYTES && dialog.sections.length) { const s = dialog.sections[0]; s.text = `${s.text.slice(0, 2000)}…`; dialog.truncated = true; }
  dialog.key = hash([bodyText, ...opt.options.map((o) => `${o.n}:${o.label}:${o.detail || ""}`), hintText].join("\n"));
  // `render` is the whole screen: the same dialog drawn again (a retried tool,
  // the ❯ moved) keeps its key and changes its render — the detector uses it
  // to tell "still the showing that was answered" from "shown again"
  dialog.render = hash(lines.join("\n"));
  return dialog;
}
