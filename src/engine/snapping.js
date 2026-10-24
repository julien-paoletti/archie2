/**
 * Snapping for moving and resizing rects.
 *
 * Priority per axis: object alignment (edges/centers) and equal spacing, then the grid.
 * Returns the correction to apply plus visual hints: guide `lines` and equal-`gaps` markers.
 */

const AXES = {
  x: { pos: (r) => r.x, size: (r) => r.w, cpos: (r) => r.y, csize: (r) => r.h },
  y: { pos: (r) => r.y, size: (r) => r.h, cpos: (r) => r.x, csize: (r) => r.w },
};
const anchors = (r, axis) => {
  const a = AXES[axis];
  const p = a.pos(r), s = a.size(r);
  return [p, p + s / 2, p + s];
};

/**
 * @param {object} p
 * @param {{x,y,w,h}} p.rect      rect at its unsnapped position
 * @param {Array<{x,y,w,h}>} p.others  candidate rects to align with
 * @param {number} p.threshold   snap distance in world units
 * @param {number} [p.grid]      grid step, 0 disables
 * @param {boolean} [p.guides]   snap to other objects
 * @param {{left?,right?,top?,bottom?}|null} [p.edges]  resize mode: which edges move
 */
export function snapRect({ rect, others = [], threshold = 6, grid = 0, guides = true, edges = null }) {
  const move = !edges;
  const idx = {
    x: move ? [0, 1, 2] : [edges.left && 0, edges.right && 2].filter((v) => v === 0 || v === 2),
    y: move ? [0, 1, 2] : [edges.top && 0, edges.bottom && 2].filter((v) => v === 0 || v === 2),
  };
  const out = { dx: 0, dy: 0, lines: [], gaps: [] };

  for (const axis of ['x', 'y']) {
    if (!idx[axis].length) continue;
    const mine = anchors(rect, axis);
    let best = null;
    const consider = (d) => {
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best) - 1e-6)) best = d;
    };
    if (guides) {
      for (const o of others) {
        const theirs = anchors(o, axis);
        for (const i of idx[axis]) for (const a of theirs) consider(a - mine[i]);
      }
      if (move) for (const d of spacingCandidates(rect, others, axis, threshold)) consider(d);
    }
    if (best === null && grid) {
      const v = mine[idx[axis][0]];
      best = Math.round(v / grid) * grid - v;
    }
    out['d' + axis] = best ?? 0;
  }

  if (guides) {
    const snapped = move
      ? { x: rect.x + out.dx, y: rect.y + out.dy, w: rect.w, h: rect.h }
      : applyEdges(rect, edges, out.dx, out.dy);
    out.lines = collectLines(snapped, others, idx);
    if (move) out.gaps = [...collectGaps(snapped, others, 'x'), ...collectGaps(snapped, others, 'y')];
  }
  return out;
}

/** Apply an edge displacement to a rect being resized. */
export function applyEdges(r, edges, dx, dy) {
  const o = { ...r };
  if (edges.left) { o.x += dx; o.w -= dx; }
  if (edges.right) o.w += dx;
  if (edges.top) { o.y += dy; o.h -= dy; }
  if (edges.bottom) o.h += dy;
  return o;
}

function band(rect, others, axis) {
  const a = AXES[axis];
  const c0 = a.cpos(rect), c1 = c0 + a.csize(rect);
  return others.filter((o) => a.cpos(o) < c1 && a.cpos(o) + a.csize(o) > c0);
}

/** Positions (as deltas) where `rect` would sit at an equal distance from its neighbours. */
function spacingCandidates(rect, others, axis, threshold) {
  const a = AXES[axis];
  const row = band(rect, others, axis);
  if (!row.length) return [];
  const start = a.pos(rect), end = start + a.size(rect);
  const before = row.filter((o) => a.pos(o) + a.size(o) <= start + threshold)
    .sort((p, q) => a.pos(q) + a.size(q) - (a.pos(p) + a.size(p)));
  const after = row.filter((o) => a.pos(o) >= end - threshold).sort((p, q) => a.pos(p) - a.pos(q));
  const prev = before[0], next = after[0];
  const out = [];
  if (prev && next) out.push((a.pos(prev) + a.size(prev) + a.pos(next) - a.size(rect)) / 2 - start);
  for (const g of existingGaps(row, axis)) {
    if (prev) out.push(a.pos(prev) + a.size(prev) + g - start);
    if (next) out.push(a.pos(next) - g - end);
  }
  return out;
}

/** Gaps between consecutive, non-overlapping rects along an axis. */
function existingGaps(rects, axis) {
  const a = AXES[axis];
  const sorted = [...rects].sort((p, q) => a.pos(p) - a.pos(q));
  const gaps = [];
  for (let i = 0; i < sorted.length; i++) {
    const endI = a.pos(sorted[i]) + a.size(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      const g = a.pos(sorted[j]) - endI;
      if (g > 0) {
        gaps.push(g);
        break;
      }
    }
  }
  return gaps;
}

function collectLines(r, others, idx) {
  const lines = new Map();
  for (const axis of ['x', 'y']) {
    if (!idx[axis].length) continue;
    const mine = anchors(r, axis);
    const cross = axis === 'x' ? AXES.y : AXES.x;
    for (const o of others) {
      for (const a of anchors(o, axis)) {
        for (const i of idx[axis]) {
          if (Math.abs(a - mine[i]) > 0.5) continue;
          const key = axis + ':' + Math.round(a * 2);
          let line = lines.get(key);
          if (!line) lines.set(key, (line = { axis, pos: a, from: Infinity, to: -Infinity, marks: [] }));
          line.from = Math.min(line.from, cross.pos(r), cross.pos(o));
          line.to = Math.max(line.to, cross.pos(r) + cross.size(r), cross.pos(o) + cross.size(o));
          line.marks.push(cross.pos(o), cross.pos(o) + cross.size(o), cross.pos(r), cross.pos(r) + cross.size(r));
        }
      }
    }
  }
  return [...lines.values()];
}

/** Equal-spacing indicators: the rect's gaps to its neighbours and every gap they match. */
function collectGaps(r, others, axis) {
  const a = AXES[axis];
  const row = band(r, others, axis);
  if (!row.length) return [];
  const start = a.pos(r), end = start + a.size(r);
  const prev = row.filter((o) => a.pos(o) + a.size(o) <= start + 0.5)
    .sort((p, q) => a.pos(q) + a.size(q) - (a.pos(p) + a.size(p)))[0];
  const next = row.filter((o) => a.pos(o) >= end - 0.5).sort((p, q) => a.pos(p) - a.pos(q))[0];
  const mine = [];
  if (prev) mine.push({ g: start - (a.pos(prev) + a.size(prev)), p: prev, q: r });
  if (next) mine.push({ g: a.pos(next) - end, p: r, q: next });

  const sorted = [...row].sort((p, q) => a.pos(p) - a.pos(q));
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const g = a.pos(sorted[j]) - (a.pos(sorted[i]) + a.size(sorted[i]));
      if (g > 0) {
        pairs.push({ g, p: sorted[i], q: sorted[j] });
        break;
      }
    }
  }

  const out = [];
  const seg = ({ p, q, g }) => {
    const c0 = Math.max(a.cpos(p), a.cpos(q));
    const c1 = Math.min(a.cpos(p) + a.csize(p), a.cpos(q) + a.csize(q));
    const from = a.pos(p) + a.size(p);
    return { axis, from, to: from + g, at: (c0 + c1) / 2, size: g };
  };
  for (const m of mine) {
    if (m.g <= 0) continue;
    const matches = [...pairs, ...mine.filter((x) => x !== m)].filter((x) => Math.abs(x.g - m.g) < 0.5);
    if (!matches.length) continue;
    out.push(seg(m));
    for (const x of matches) out.push(seg(x));
  }
  return out;
}
