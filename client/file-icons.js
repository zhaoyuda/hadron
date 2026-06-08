// ═══ FILE ICONS (VS Code Seti-style) ═══ — extracted from app.js (classic <script>, loaded before app.js).
// Self-contained: fileIcon/folderIcon/fileExtIcon + icon data + marimoNameCache. No external app.js globals.
const FILE_ICON_DEFS = {
  md:       { color: "#5FB8D8", letter: "M" },
  markdown: { color: "#5FB8D8", letter: "M" },
  py:       { color: "#3572A5", letter: "py" },
  marimo:   { color: "#2ecc71", letter: "py" },
  ipynb:    { color: "#e37933", letter: "J" },
  csv:      { color: "#89e051", letter: "," },
  sql:      { color: "#e6c07b", letter: "S" },
  js:       { color: "#cbcb41", letter: "js" },
  ts:       { color: "#3178c6", letter: "ts" },
  jsx:      { color: "#61dafb", letter: "⚛" },
  tsx:      { color: "#3178c6", letter: "⚛" },
  json:     { color: "#cbcb41", letter: "{}" },
  yaml:     { color: "#a074c4", letter: "Y" },
  yml:      { color: "#a074c4", letter: "Y" },
  sh:       { color: "#89e051", letter: "$" },
  bash:     { color: "#89e051", letter: "$" },
  zsh:      { color: "#89e051", letter: "$" },
  go:       { color: "#00ADD8", letter: "Go" },
  rs:       { color: "#dea584", letter: "rs" },
  rb:       { color: "#cc3e44", letter: "rb" },
  html:     { color: "#F06A2A", letter: "<>" },
  htm:      { color: "#F06A2A", letter: "<>" },
  css:      { color: "#563d7c", letter: "#" },
  scss:     { color: "#c76494", letter: "#" },
  txt:      { color: "#8b949e", letter: "T" },
  toml:     { color: "#9c4221", letter: "T" },
  cfg:      { color: "#8b949e", letter: "⚙" },
  ini:      { color: "#8b949e", letter: "⚙" },
  java:     { color: "#cc3e44", letter: "J" },
  c:        { color: "#519aba", letter: "C" },
  cpp:      { color: "#519aba", letter: "++" },
  h:        { color: "#a074c4", letter: "H" },
  php:      { color: "#a074c4", letter: "P" },
  swift:    { color: "#e37933", letter: "S" },
  kt:       { color: "#a074c4", letter: "K" },
  xml:      { color: "#e37933", letter: "X" },
  svg:      { color: "#e37933", letter: "◇" },
  parquet:  { color: "#4caf50", letter: "⊞" },
  arrow:    { color: "#4caf50", letter: "→" },
  xlsx:     { color: "#207245", letter: "X" },
  xls:      { color: "#207245", letter: "X" },
};

const URL_TAB_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.6 9.4l2.8-2.8M6.9 4.6l.9-.9a2.4 2.4 0 013.4 3.4l-1.1 1.1M9.1 11.4l-.9.9a2.4 2.4 0 01-3.4-3.4l1.1-1.1" stroke="#58a6ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Marimo notebooks are plain `.py` and only detectable by content. Once an
// artifact has been classified at render time (via isMarimoNotebook), we remember
// its basename so the file-type icon upgrades from generic Python to marimo.
const marimoNameCache = new Set();
function noteMarimoNotebook(pathOrName) {
  const base = (pathOrName || "").toLowerCase().split("/").pop();
  if (!base || marimoNameCache.has(base)) return false;
  marimoNameCache.add(base);
  return true;
}

// Hand-drawn distinct glyphs for high-value file types. Each returns the inner
// SVG markup (children of a 16x16 viewBox). The long tail falls back to a
// colored letter-in-document below.
const FILE_ICON_GLYPHS = {
  // Markdown — document badge with "MD" fold-corner (24→16), reads clearly as a file
  md: () => `<g transform="scale(.6667)"><path d="M6 3.5h8.5L19 8v12.5H6V3.5z" fill="#24566A" stroke="#5FB8D8" stroke-width="1.3"/><path d="M14.5 3.5V8H19" stroke="#5FB8D8" stroke-width="1.3"/><text x="12" y="16" font-family="Inter, Arial, sans-serif" font-size="6.5" font-weight="700" fill="#D7E8EE" text-anchor="middle">MD</text></g>`,
  markdown: () => FILE_ICON_GLYPHS.md(),
  // SQL — database cylinder (stacked ellipses)
  sql: (c) => `<path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" fill="${c}" opacity="0.15" stroke="${c}" stroke-width="1" stroke-linecap="round"/><ellipse cx="8" cy="4" rx="5" ry="1.9" fill="${c}" opacity="0.2" stroke="${c}" stroke-width="1"/><path d="M3 7.7c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" fill="none" stroke="${c}" stroke-width="1"/>`,
  // Python — two-tone interlocking blocks
  py: () => `<path d="M8 1.5c-2 0-3.4.5-3.4 2.2v1.6h3.6v.5H3.3C1.7 5.8 1.2 7 1.2 8.8s.6 3 2.1 3h1.2V9.9c0-1.5 1.2-2.6 2.6-2.6h3.2c1.3 0 2.3-1 2.3-2.3V3.7C12.6 2.2 11.4 1.5 8 1.5zM6 2.9a.7.7 0 110 1.4.7.7 0 010-1.4z" fill="#3572A5"/><path d="M8 14.5c2 0 3.4-.5 3.4-2.2v-1.6H7.8v-.5h4.9c1.6 0 2.1-1.2 2.1-3s-.6-3-2.1-3h-1.2v1.9c0 1.5-1.2 2.6-2.6 2.6H5.7c-1.3 0-2.3 1-2.3 2.3v1.3c0 1.5 1.2 2.2 4.6 2.2zm2-1.4a.7.7 0 110-1.4.7.7 0 010 1.4z" fill="#FFD43B"/>`,
  // Marimo — reactive cells (green): a node graph of connected cells
  marimo: () => `<rect x="1" y="3" width="14" height="10" rx="2" fill="#1f6f3f" opacity="0.18" stroke="#2ecc71" stroke-width="1"/><circle cx="5" cy="6" r="1.4" fill="#2ecc71"/><circle cx="11" cy="6" r="1.4" fill="#2ecc71"/><circle cx="8" cy="10.5" r="1.4" fill="#2ecc71"/><path d="M5 7.2l2.4 2.5M11 7.2L8.6 9.7M5.4 6h5.2" stroke="#2ecc71" stroke-width="0.9" fill="none" stroke-linecap="round"/>`,
  // Jupyter — official Jupyter logo (Simple Icons, CC0), scaled from 24→16
  ipynb: () => `<g transform="scale(.6667)" fill="#f37726"><path d="M7.157 22.201A1.784 1.799 0 0 1 5.374 24a1.784 1.799 0 0 1-1.784-1.799 1.784 1.799 0 0 1 1.784-1.799 1.784 1.799 0 0 1 1.783 1.799zM20.582 1.427a1.415 1.427 0 0 1-1.415 1.428 1.415 1.427 0 0 1-1.416-1.428A1.415 1.427 0 0 1 19.167 0a1.415 1.427 0 0 1 1.415 1.427zM4.992 3.336A1.047 1.056 0 0 1 3.946 4.39a1.047 1.056 0 0 1-1.047-1.055A1.047 1.056 0 0 1 3.946 2.28a1.047 1.056 0 0 1 1.046 1.056zm7.336 1.517c3.769 0 7.06 1.38 8.768 3.424a9.363 9.363 0 0 0-3.393-4.547 9.238 9.238 0 0 0-5.377-1.728A9.238 9.238 0 0 0 6.95 3.73a9.363 9.363 0 0 0-3.394 4.547c1.713-2.04 5.004-3.424 8.772-3.424zm.001 13.295c-3.768 0-7.06-1.381-8.768-3.425a9.363 9.363 0 0 0 3.394 4.547A9.238 9.238 0 0 0 12.33 21a9.238 9.238 0 0 0 5.377-1.729 9.363 9.363 0 0 0 3.393-4.547c-1.712 2.044-5.003 3.425-8.772 3.425Z"/></g>`,
  // CSV — small table/grid
  csv: (c) => `<rect x="2" y="3" width="12" height="10" rx="1.5" fill="${c}" opacity="0.15" stroke="${c}" stroke-width="1"/><path d="M2 6.3h12M2 9.6h12M6 3v10M10 3v10" stroke="${c}" stroke-width="0.9"/>`,
  // HTML — HTML5 shield (24→16), the most recognizable HTML mark
  html: () => `<g transform="scale(.6667)"><path d="M5 3.5h14l-1.25 15L12 21l-5.75-2.5L5 3.5z" fill="#6B2D18" stroke="#F06A2A" stroke-width="1.2"/><path d="M8.1 7.2h7.8l-.15 1.55H9.85l.13 1.55h5.62l-.45 5.15L12 16.8l-3.15-1.35-.2-2.25h1.55l.1 1.15 1.7.72 1.7-.72.18-2.05H8.5L8.1 7.2z" fill="#FFE5D8"/></g>`,
  htm: () => FILE_ICON_GLYPHS.html(),
  // JSON — braces
  json: (c) => `<rect x="2" y="2.5" width="12" height="11" rx="2" fill="${c}" opacity="0.12" stroke="${c}" stroke-width="0.8"/><path d="M6.2 3.5c-1.2 0-1.6.6-1.6 1.6 0 1.4 0 1.5-1 1.9 1 .4 1 .5 1 1.9 0 1 .4 1.6 1.6 1.6" stroke="${c}" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1.5)"/><path d="M9.8 3.5c1.2 0 1.6.6 1.6 1.6 0 1.4 0 1.5 1 1.9-1 .4-1 .5-1 1.9 0 1-.4 1.6-1.6 1.6" stroke="${c}" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1.5)"/>`,
};

function fileIcon(name, size = 16) {
  const lower = (name || "").toLowerCase();
  const base = lower.split("/").pop();
  let ext = base.split(".").pop();
  // marimo notebooks are plain `.py`: use the `.marimo.py` naming convention, or
  // a content classification cached at render time (see marimoNameCache).
  if (lower.endsWith(".marimo.py") || (base.endsWith(".py") && marimoNameCache.has(base))) ext = "marimo";
  const def = FILE_ICON_DEFS[ext] || { color: "#8b949e", letter: "" };
  const glyph = FILE_ICON_GLYPHS[ext];
  if (glyph) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${glyph(def.color)}</svg>`;
  }
  const { color, letter } = def;
  const fontSize = letter.length > 2 ? 5 : letter.length > 1 ? 6 : 7;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h6.5L13 4.5V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" fill="${color}" opacity="0.15" stroke="${color}" stroke-width="1"/><path d="M9.5 1v2.5a1 1 0 001 1H13" stroke="${color}" stroke-width="1"/>${letter ? `<text x="8" y="11.5" text-anchor="middle" fill="${color}" font-family="monospace" font-size="${fontSize}" font-weight="bold">${letter}</text>` : ""}</svg>`;
}

function folderIcon(open, size = 16) {
  const color = "#c09553";
  if (open) return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path d="M1.5 13V4a1 1 0 011-1H6l1.5 1.5H13a1 1 0 011 1V6H5.5L4 8l-1.5 5H2.5a1 1 0 01-1-1z" fill="${color}" opacity="0.15" stroke="${color}"/><path d="M4.5 6H14l-2 7H2.5L4.5 6z" fill="${color}" opacity="0.25" stroke="${color}"/></svg>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path d="M1.5 13V4a1 1 0 011-1H6l1.5 1.5H13a1 1 0 011 1V13a1 1 0 01-1 1H2.5a1 1 0 01-1-1z" fill="${color}" opacity="0.15" stroke="${color}"/></svg>`;
}

function fileExtIcon(name) {
  return fileIcon(name, 15);
}
