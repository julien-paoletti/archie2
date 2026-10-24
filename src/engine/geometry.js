/** Pure 2D geometry helpers. Rects are `{ x, y, w, h }`, points are `{ x, y }`. */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const snap = (v, step) => (step ? Math.round(v / step) * step : v);

export const rectOf = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
export const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function inflate(r, dx, dy = dx) {
  return { x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy };
}

export function union(a, b) {
  if (!a) return b && rectOf(b);
  if (!b) return rectOf(a);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function boundsOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Inclusive overlap test, so zero-size query rects (points) work. */
export function intersects(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Strict overlap: touching edges do not count. */
export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function containsPoint(r, p) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function containsRect(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function rectEquals(a, b, eps = 1e-6) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;
}

export function lerpRect(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

export function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/** Point at fraction `t` (0..1) of a polyline's length, with the direction of its segment. */
export function pointAlong(pts, t) {
  let rest = polylineLength(pts) * clamp(t, 0, 1);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = dist(a, b);
    if (rest <= len && len > 0) {
      const k = rest / len;
      return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
    }
    rest -= len;
  }
  const a = pts[pts.length - 1] ?? { x: 0, y: 0 };
  return { x: a.x, y: a.y, dx: 1, dy: 0 };
}

export const polylineMidpoint = (pts) => pointAlong(pts, 0.5);

/** Closest point of a polyline to `p`: its fraction along the length and the distance. */
export function projectOnPolyline(p, pts) {
  const total = polylineLength(pts) || 1;
  let best = { t: 0, d: Infinity }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const k = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
    const d = Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
    const len = Math.sqrt(len2);
    if (d < best.d) best = { t: (acc + k * len) / total, d };
    acc += len;
  }
  return best;
}

export function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

export function sampleCubic(p0, p1, p2, p3, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) out.push(cubicPoint(p0, p1, p2, p3, i / steps));
  return out;
}

/** Where the ray from the rect's center towards `toward` exits the rect. */
export function boundaryPoint(r, toward) {
  const c = center(r);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx ? (r.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (r.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}
