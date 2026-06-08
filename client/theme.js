// ═══ THEME SYSTEM ═══ — extracted from app.js (classic <script>, loaded before app.js).
// Reads app.js globals (currentTheme) and helpers (saveUIState, render) at call time only.
// Themes: "default", "exploration" (v0.2 CSS box-shadow sprites), "exploration2" (PNG sprite sheets)
// ── v0.2 Classic CSS box-shadow sprites ──
const CLASSIC_CREW = [
  { name: "captain", palette: { H: "#4a2a10", T: "#d4a030", C: "#1a3a6a", W: "#ddd", S: "#c48b6a", E: "#1a1a2e", M: "#aa7755", B: "#3a2510", G: "#c4a060" },
    idle: ["....HHHH....","...HTTTTH...","...HTTTTH...","...SEESET...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCCCCCC...","..GCCCCCG...","...CCCCC....","....CCC.....","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
  { name: "navigator", palette: { H: "#5a3a1a", T: "#c49050", C: "#2a5a2a", W: "#ddd", S: "#d4a878", E: "#1a1a2e", M: "#bb8866", B: "#3a2510", P: "#eee8d0" },
    idle: ["....HHHH....","...HTTTTH...","...HTTTTH...","...SEESES...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCCCCCC...","..CCCCCCC.P.","...CCCCC.PP.","....CCC..P..","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
  { name: "merchant", palette: { H: "#3a1a0a", T: "#aa7040", C: "#8a2020", W: "#eee", S: "#c48b6a", E: "#1a1a2e", M: "#aa7755", B: "#3a2510", G: "#d4a030" },
    idle: ["....HHHH....","...HTTTTH...","..HHTTTHH...","...SEESES...","...SSMSSS...","....SSS.....","...GCCCCG...","..CCWCWCC...","..CCCCCCC...","..CCCCCCC...","...CCCCC....","....CCC.....","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
  { name: "lookout", palette: { H: "#5a4a30", T: "#d4c090", C: "#2255aa", W: "#ddd", S: "#c48b6a", E: "#1a1a2e", M: "#aa7755", B: "#3a2510" },
    idle: ["....HHHH....","...HTTTH....","...HTTTH....","...SEESES...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCCCCCC...","..CCCCCCC...","...CCCCC....","....CCC.....","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
  { name: "gunner", palette: { H: "#2a1a0a", T: "#8a6a40", C: "#3a3a3a", W: "#ccc", S: "#c48b6a", E: "#1a1a2e", M: "#aa7755", B: "#3a2510" },
    idle: ["....HHHH....","...HTTTTH...","...HTTTH....","...SEESES...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCCCCCC...","..CCCCCCC...","...CCCCC....","....CCC.....","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
  { name: "medic", palette: { H: "#4a3020", T: "#bb8855", C: "#eee8d0", W: "#cc3333", S: "#d4a878", E: "#1a1a2e", M: "#bb8866", B: "#3a2510", G: "#cc3333" },
    idle: ["....HHHH....","...HTTTTH...","...HTTTTH...","...SEESES...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCGCCCC...","..CGGCCCC...","...CCCCC....","....CCC.....","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
  { name: "cook", palette: { H: "#eee", T: "#eee", C: "#eee8d0", W: "#ddd", S: "#c48b6a", E: "#1a1a2e", M: "#aa7755", B: "#3a2510", G: "#8a6a40" },
    idle: ["....HHHH....","...HHHHHH...","...HTTTTH...","...SEESES...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCCCCCC...","..CCCCCCC...","...CCCCC....","....CCC.....","...CC.CC....","...GG.GG....","...BB.BB....","...BB.BB...."] },
  { name: "bosun", palette: { H: "#1a1a2e", T: "#6a5a40", C: "#5a3020", W: "#ddd", S: "#c48b6a", E: "#1a1a2e", M: "#aa7755", B: "#3a2510" },
    idle: ["....HHHH....","...HTTTTH...","..HHTTTHH...","...SEESES...","...SSMSSS...","....SSS.....","...CCCCC....","..CCWCWCC...","..CCCCCCC...","..CCCCCCC...","...CCCCC....","....CCC.....","...CC.CC....","...CC.CC....","...BB.BB....","...BB.BB...."] },
];

const CLASSIC_STATE_OVERLAYS = {
  working: { overlay: ["............","............","............","............","............","............","R...........","RR..........","R...........","............","............","............","............","............","............","............"], palette: { R: "#cc3333" }},
  blocked: { overlay: ["............","............","............","..x...x.....","...x.x......","............","............","............","............","............","............","............","............","............","............","............"], palette: { x: "#cc3333" }},
  done: { overlay: [".....*......","...*.*.*....",".....*......","............","............","............","............","............","............","............","............","............","............","............","............","............"], palette: { "*": "#FFD700" }},
};

function renderClassicSprite(s) {
  const crew = CLASSIC_CREW[getCrewIndex(s, CLASSIC_CREW.length)];
  const rows = crew.idle;
  const palette = crew.palette;
  const state = s.state || "idle";
  const stateOv = CLASSIC_STATE_OVERLAYS[state];
  const px = 3;
  const shadows = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (stateOv) {
        const oc = stateOv.overlay[y]?.[x];
        if (oc && oc !== '.' && stateOv.palette[oc]) { shadows.push(`${x*px}px ${y*px}px 0 ${stateOv.palette[oc]}`); continue; }
      }
      const color = palette[row[x]];
      if (color) shadows.push(`${x*px}px ${y*px}px 0 ${color}`);
    }
  });
  const stateClass = state && state !== "idle" ? ` crew-${state}` : " crew-idle";
  return `<div class="classic-sprite${stateClass}" style="width:${px}px;height:${px}px;box-shadow:${shadows.join(",")};"></div>`;
}

// ── v0.3 PNG sprite sheets (Puny Characters, CC0) ──
// Layout: 6 cols x 4 rows @ 32x32 — row0=idle(lying), row1=working(walk), row2=blocked(stand), row3=done(stand)
const PNG_SPRITES = [
  "soldier-blue", "soldier-red", "soldier-yellow",
  "warrior-blue", "warrior-red",
  "archer-green", "archer-purple",
  "mage-cyan", "mage-red",
  "human-soldier-cyan", "human-soldier-red",
  "human-worker-cyan", "human-worker-red",
  "orc-grunt", "orc-peon-cyan", "orc-peon-red",
  "orc-soldier-cyan", "orc-soldier-red",
];

const SPRITE_FRAME_COUNTS = { idle: 2, working: 6, blocked: 2, done: 2 };
const SPRITE_ROW = { idle: 0, working: 1, blocked: 2, done: 3 };

function renderPngSprite(s, size = "dk") {
  const state = s.state || "idle";
  const row = SPRITE_ROW[state] ?? 0;
  const frames = SPRITE_FRAME_COUNTS[state] ?? 2;
  const idx = getCrewIndex(s, PNG_SPRITES.length);
  const url = `assets/sprites/${PNG_SPRITES[idx]}.png`;
  return `<div class="crew-sprite sprite-${state} sprite-${size}" data-frames="${frames}" style="background-image:url('${url}');background-position:0 -${row * 32}px;"></div>`;
}

// ── Shared ──

const RPG_BLOCKED_LINES = [
  "迷失方向了…", "遭遇暴風雨！", "船帆破損！", "遇到海盜！",
  "糧食不足…", "遇到漩渦！", "霧中航行…", "需要指示！",
  "航線受阻！", "等待補給…", "船員嘩變！", "觸礁了！",
];

function getCrewIndex(s, count) {
  let hash = 0;
  for (let i = 0; i < s.id.length; i++) hash = ((hash << 5) - hash + s.id.charCodeAt(i)) | 0;
  return Math.abs(hash) % count;
}

function renderThemeAvatar(s, size = "dk") {
  if (currentTheme === "exploration") return renderClassicSprite(s);
  if (currentTheme === "exploration2") return renderPngSprite(s, size);
  return null;
}

function rpgBlockedLine(s) {
  let hash = 0;
  for (let i = 0; i < s.id.length; i++) hash = ((hash << 5) - hash + s.id.charCodeAt(i)) | 0;
  return RPG_BLOCKED_LINES[Math.abs(hash) % RPG_BLOCKED_LINES.length];
}

function animateSprites() {
  document.querySelectorAll(".crew-sprite").forEach(el => {
    const frames = parseInt(el.dataset.frames) || 1;
    if (frames <= 1) return;
    const current = parseInt(el.dataset.frame) || 0;
    const next = (current + 1) % frames;
    el.dataset.frame = next;
    const bgPos = el.style.backgroundPosition.split(" ");
    const yPos = bgPos[1] || "0px";
    el.style.backgroundPosition = `-${next * 32}px ${yPos}`;
  });
}
setInterval(animateSprites, 200);

function isExplorationTheme() {
  return currentTheme === "exploration" || currentTheme === "exploration2";
}

function applyTheme(theme) {
  currentTheme = theme;
  const cssTheme = theme === "exploration2" ? "exploration" : theme;
  document.documentElement.setAttribute("data-theme", cssTheme);
  saveUIState();
  render();
}
