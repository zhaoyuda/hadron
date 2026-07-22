// Pure card layout for the comment rail (R3, design-notes/comment-rail-spec.md).
// Loaded as a <script type="module"> in the browser (exposed on window for the
// classic-script annotations.js) and imported directly by the unit test — so it
// must stay free of DOM and app globals.
//
// items:    [{ id, anchorY, height }] sorted by anchorY (caller's contract;
//           ties keep insertion order — doc cards are fed in first at
//           anchorY = floor so one collision-aware pass covers them too).
// activeId: the card that wants to sit EXACTLY at its anchorY, or null/absent.
// opts:     { gap = 8, floor = 0 } — floor is a hard upper boundary (the rail
//           top): no card is ever placed above it.
// Returns { id → top }.
//
// Rules: no two cards overlap; a card never rises above its predecessor; no
// card rises above `floor`. Without an active card: greedy top-down — each
// card at max(anchorY, prevBottom + gap), i.e. only ever pushed DOWN from its
// anchor. With an active card: exact alignment is subject to FEASIBILITY —
// the cards above it must fit between the floor and the active card, so its
// position is max(anchorY, floor + Σ(height + gap) of all cards above). When
// exact alignment is physically impossible (dense cluster, doc cards pinned
// at the floor), the active card lands at that minimal feasible Y — the
// documented compromise (spec R3). Cards above walk up only as far as the
// collision demands (the min() against the greedy position keeps them at
// their natural spot when there is room) and never pass the floor; cards
// below are re-laid greedily from the active card down.
export function annRailLayout(items, activeId, { gap = 8, floor = 0 } = {}) {
  const tops = {};
  if (!items.length) return tops;
  const a = activeId == null ? -1 : items.findIndex((it) => it.id === activeId);

  // Greedy pass — the whole answer when nothing is active, and the "natural"
  // ceiling for the cards above an active one. Seeding bottom at floor - gap
  // makes the first card land at max(anchorY, floor).
  const g = [];
  let bottom = floor - gap;
  for (let i = 0; i < items.length; i++) {
    g[i] = Math.max(items[i].anchorY, bottom + gap);
    bottom = g[i] + items[i].height;
  }
  if (a === -1) {
    items.forEach((it, i) => { tops[it.id] = g[i]; });
    return tops;
  }

  // Feasibility bound: everything above the active card must stack between the
  // floor and the card — exact alignment below that stack is impossible.
  let minTop = floor;
  for (let i = 0; i < a; i++) minTop += items[i].height + gap;
  const at = Math.max(items[a].anchorY, minTop);
  tops[items[a].id] = at;

  // Above: walk upward; each card takes its greedy spot unless the card below
  // (already placed) forces it higher. The feasibility bound guarantees this
  // walk never crosses the floor (inductively: ceil - gap - height stays ≥
  // floor + the stack of everything still above), and min() preserves order
  // + the gap.
  let ceil = at;
  for (let i = a - 1; i >= 0; i--) {
    const t = Math.min(g[i], ceil - gap - items[i].height);
    tops[items[i].id] = t;
    ceil = t;
  }
  // Below: greedy again, seeded from the active card's true position.
  bottom = at + items[a].height;
  for (let i = a + 1; i < items.length; i++) {
    const t = Math.max(items[i].anchorY, bottom + gap);
    tops[items[i].id] = t;
    bottom = t + items[i].height;
  }
  return tops;
}

if (typeof window !== "undefined") window.annRailLayout = annRailLayout;
