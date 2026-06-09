// ═══ DATA-AWARE PREVIEW ═══ — diagnostics layered on the artifact renderers in
// app.js (classic <script>, loaded before app.js; reads esc() at call time).
// Turns "render the file" into "catch silent errors fast":
//   CSV — shape + per-column dtype / null count / numeric min·mean·max in a
//     strip above the table (nulls highlighted; a numeric column gone "string"
//     means a stray non-numeric value snuck in).
//   Notebooks — error-output banner + red-marked cells, and a "changed" badge
//     on cells whose source differs from the previous render of the same file
//     (in-memory only — answers "what changed since I last looked").

// ── CSV column stats ──

// Stats are computed on at most this many rows. The current renderer loads the
// whole file (/api/file streams it all and the table renders every row), so
// this cap only bounds the stats pass; the strip says so when it kicks in.
const CSV_STATS_ROW_CAP = 5000;

// Values treated as null/missing besides the empty string (case-insensitive).
const CSV_NULL_TOKENS = new Set(["", "null", "none", "nan", "na", "n/a"]);

function csvIsNull(v) {
  return v === undefined || CSV_NULL_TOKENS.has(String(v).trim().toLowerCase());
}

function csvCellType(v) {
  const t = v.trim();
  if (/^(true|false)$/i.test(t)) return "bool";
  if (!isNaN(Number(t))) return "number";
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(t) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(t)) return "date";
  return "string";
}

function computeCSVStats(headers, rows) {
  const capped = rows.length > CSV_STATS_ROW_CAP;
  const sample = capped ? rows.slice(0, CSV_STATS_ROW_CAP) : rows;
  const columns = headers.map((name) => ({
    name, nulls: 0, types: new Set(), numCount: 0, numSum: 0, min: Infinity, max: -Infinity,
  }));
  for (const row of sample) {
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const v = row[i];
      if (csvIsNull(v)) { col.nulls++; continue; }
      const t = csvCellType(v);
      col.types.add(t);
      if (t === "number") {
        const n = Number(v);
        col.numCount++;
        col.numSum += n;
        if (n < col.min) col.min = n;
        if (n > col.max) col.max = n;
      }
    }
  }
  for (const col of columns) {
    // All non-null values agree → that dtype; none → "empty"; mixed → "string"
    // (the honest catch-all — one stray word in a numeric column shows here).
    col.dtype = col.types.size === 0 ? "empty" : col.types.size === 1 ? [...col.types][0] : "string";
    delete col.types;
  }
  return { rowCount: rows.length, colCount: headers.length, capped, sampleCount: sample.length, columns };
}

function csvFmtNum(n) {
  if (!isFinite(n)) return "–";
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4)));
}

function csvStatsHTML(stats) {
  const shape = `${stats.rowCount} row${stats.rowCount !== 1 ? "s" : ""} × ${stats.colCount} col${stats.colCount !== 1 ? "s" : ""}`;
  const cap = stats.capped ? `<span class="csv-stats-cap">stats on first ${stats.sampleCount} rows</span>` : "";
  let chips = "";
  for (const col of stats.columns) {
    let bits = `<span class="csv-stat-dtype">${esc(col.dtype)}</span>`;
    if (col.nulls > 0) bits += `<span class="csv-stat-null">${col.nulls} null</span>`;
    if (col.dtype === "number" && col.numCount > 0) {
      bits += `<span class="csv-stat-range">${csvFmtNum(col.min)} · μ ${csvFmtNum(col.numSum / col.numCount)} · ${csvFmtNum(col.max)}</span>`;
    }
    chips += `<span class="csv-stat-col${col.nulls > 0 ? " has-nulls" : ""}"><span class="csv-stat-name">${esc(col.name)}</span>${bits}</span>`;
  }
  return `<div class="csv-stats"><span class="csv-stats-shape">${shape}</span>${cap}<div class="csv-stats-cols">${chips}</div></div>`;
}

// ── Notebook cell diagnostics ──

// Per-file source hashes from the previous render. In-memory only — a page
// reload forgets history, which is fine: the "changed" badge marks what moved
// between two renders this viewer actually saw (mtime auto-reload included).
const nbCellHashesByPath = new Map();

function nbHash(str) {
  let h = 5381; // djb2 — cheap, good enough for "did this cell change"
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

// Returns { errors: [{ index, ename }], changed: Set<index> } and records the
// current hashes so the next render of the same path diffs against this one.
function analyzeNotebookCells(cells, filePath) {
  const prev = nbCellHashesByPath.get(filePath);
  const hashes = [];
  const errors = [];
  const changed = new Set();
  cells.forEach((cell, i) => {
    const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source || "");
    hashes.push(nbHash(cell.cell_type + "\0" + source));
    if (prev && prev[i] !== hashes[i]) changed.add(i);
    for (const out of cell.outputs || []) {
      if (out.output_type === "error") { errors.push({ index: i, ename: out.ename || "Error" }); break; }
    }
  });
  nbCellHashesByPath.set(filePath, hashes);
  return { errors, changed };
}

function nbErrorBannerHTML(errors) {
  if (errors.length === 0) return "";
  const first = errors[0];
  return `<div class="jupyter-error-banner">⚠ ${errors.length} cell${errors.length !== 1 ? "s" : ""} errored — first: ${esc(first.ename)} (cell ${first.index + 1})</div>`;
}
