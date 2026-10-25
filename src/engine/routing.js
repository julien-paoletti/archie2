import { boundaryPoint, boundsOf, center, clamp, cubicPoint, dist, pointAlong, polylineMidpoint, sampleCubic } from './geometry.js';

/**
 * Edge routing. All routers return the same shape:
 *   { kind: 'poly' | 'bezier', points, poly, bbox, mid: {x,y}, start: {x,y}, end: {x,y}, manual?, smooth?, legs?, straight? }
 * `poly` is a polyline usable for hit testing; `start` and `end` are the unit directions out of
 * the source and into the target.
 * `straight` marks a centre-to-centre line (straight routing), which port spreading leaves alone.
 *
 * The orthogonal router runs A* over a sparse "orthogonal visibility" grid built from
 * obstacle boundaries (plus a clearance margin). State = (grid point, heading), with a
 * bend penalty, so it finds short routes with few corners and picks the best ports.
 */

export const SIDES = ['top', 'right', 'bottom', 'left'];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const SIDE_INDEX = { top: 0, right: 1, bottom: 2, left: 3 };

export function portPoint(r, side) {
  switch (side) {
    case 'top': return { x: r.x + r.w / 2, y: r.y };
    case 'right': return { x: r.x + r.w, y: r.y + r.h / 2 };
    case 'bottom': return { x: r.x + r.w / 2, y: r.y + r.h };
    default: return { x: r.x, y: r.y + r.h / 2 };
  }
}

export function sideNormal(side) {
  const i = SIDE_INDEX[side];
  return { x: DX[i], y: DY[i] };
}

/** Facing sides for two rects, based on which axis separates them the most. */
export function pickSides(src, tgt) {
  const gx = Math.max(tgt.x - (src.x + src.w), src.x - (tgt.x + tgt.w));
  const gy = Math.max(tgt.y - (src.y + src.h), src.y - (tgt.y + tgt.h));
  const sc = center(src), tc = center(tgt);
  if (gx >= gy) return tc.x >= sc.x ? ['right', 'left'] : ['left', 'right'];
  return tc.y >= sc.y ? ['bottom', 'top'] : ['top', 'bottom'];
}

export function routeEdge(mode, src, tgt, { obstacles = [], fast = false, self = false, margin = 20, points = null } = {}) {
  if (self) return routeSelfLoop(src);
  if (points?.length) {
    const manual = routeManual(mode, src, tgt, points);
    if (manual) return manual;
  }
  if (mode === 'straight') return routeStraight(src, tgt);
  if (mode === 'curved') return routeCurved(src, tgt);
  return fast ? routeSimpleOrthogonal(src, tgt) : routeOrthogonal(src, tgt, obstacles, { margin });
}

export function routeStraight(src, tgt) {
  const a = center(src), b = center(tgt);
  return finish('poly', [boundaryPoint(src, b), boundaryPoint(tgt, a)], { straight: true });
}

export function routeCurved(src, tgt) {
  const [s0, s1] = pickSides(src, tgt);
  const p0 = portPoint(src, s0), p3 = portPoint(tgt, s1);
  const n0 = sideNormal(s0), n1 = sideNormal(s1);
  const k = clamp(dist(p0, p3) * 0.45, 24, 180);
  return finish('bezier', [p0, { x: p0.x + n0.x * k, y: p0.y + n0.y * k }, { x: p3.x + n1.x * k, y: p3.y + n1.y * k }, p3]);
}

/**
 * User-shaped route through waypoints (`edge.style.points`).
 * Orthogonal: the points are the bends; the ends slide along the node sides to stay
 * aligned with the first/last bend, with an elbow added when they can't.
 * Straight: a polyline through the points. Curved: a Catmull-Rom spline through them.
 * Manual routes carry `manual: true` (exempt from port spreading) and `legs`, which maps
 * each `poly` segment to the waypoint interval it belongs to.
 */
export function routeManual(mode, src, tgt, points) {
  // Waypoints left inside the link's own ends (an element was moved or resized over them)
  // are stale: drop them. If the shape would still run through either end, it is no longer
  // valid (the arrowhead would hide under an element): return null so the caller routes
  // automatically.
  const kept = points.filter((p) => !insideRect(src, p) && !insideRect(tgt, p));
  if (!kept.length) return null;
  let route;
  if (mode === 'orthogonal') {
    route = routeOrthogonalVia(src, tgt, kept);
  } else {
    const ctrl = [boundaryPoint(src, kept[0]), ...kept, boundaryPoint(tgt, kept[kept.length - 1])];
    if (mode === 'curved') {
      const { pts, legs } = catmullRom(ctrl);
      route = finish('poly', pts, { manual: true, smooth: true, legs });
    } else {
      route = finish('poly', ctrl, { manual: true, legs: ctrl.slice(1).map((_, i) => i) });
    }
  }
  return crossesRects(route.poly, [src, tgt]) ? null : route;
}

export const insideRect = (r, p) => p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5;

/** Does a polyline run through the interior of any of the rects (ends on borders are fine)? */
function crossesRects(poly, rects) {
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    for (let k = 1; k < 16; k++) {
      const q = { x: a.x + (b.x - a.x) * k / 16, y: a.y + (b.y - a.y) * k / 16 };
      if (rects.some((r) => insideRect(r, q))) return true;
    }
  }
  return false;
}

/** Port on `r` from which an orthogonal segment reaches `b`, plus an elbow if one is needed. */
function attachOrthogonal(r, b) {
  if (b.y > r.y && b.y < r.y + r.h) {
    if (b.x >= r.x + r.w) return [{ x: r.x + r.w, y: b.y }];
    if (b.x <= r.x) return [{ x: r.x, y: b.y }];
  }
  if (b.x > r.x && b.x < r.x + r.w) {
    if (b.y >= r.y + r.h) return [{ x: b.x, y: r.y + r.h }];
    if (b.y <= r.y) return [{ x: b.x, y: r.y }];
  }
  const c = center(r);
  if (Math.abs(b.x - c.x) / r.w > Math.abs(b.y - c.y) / r.h) {
    return [{ x: b.x > c.x ? r.x + r.w : r.x, y: c.y }, { x: b.x, y: c.y }];
  }
  return [{ x: c.x, y: b.y > c.y ? r.y + r.h : r.y }, { x: c.x, y: b.y }];
}

export function routeOrthogonalVia(src, tgt, bends) {
  const mid = [bends[0]];
  for (let i = 1; i < bends.length; i++) {
    const a = mid[mid.length - 1], b = bends[i];
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) mid.push({ x: b.x, y: a.y });
    mid.push(b);
  }
  const head = attachOrthogonal(src, mid[0]);
  const tail = attachOrthogonal(tgt, mid[mid.length - 1]).reverse();
  const pts = simplify([...head, ...mid, ...tail]);
  return finish('poly', pts, { manual: true });
}

function catmullRom(ctrl, steps = 14) {
  const pts = [ctrl[0]], legs = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const b1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const b2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let s = 1; s <= steps; s++) {
      pts.push(cubicPoint(p1, b1, b2, p2, s / steps));
      legs.push(i);
    }
  }
  return { pts, legs };
}

/**
 * Separate collinear, overlapping segments of different orthogonal routes ("shared
 * corridors") by small perpendicular offsets. Edges heading towards lower coordinates take
 * the lower lanes, which keeps the bundle free of extra crossings. Returns Map<id, route>.
 */
export function separateSegments(routes, { gap = 8 } = {}) {
  const groups = new Map();
  for (const [id, r] of routes) {
    if (r.kind !== 'poly' || r.manual || r.smooth || r.points.length < 3) continue;
    const p = r.points;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const h = Math.abs(a.y - b.y) < 0.01, v = Math.abs(a.x - b.x) < 0.01;
      if (h === v) continue;
      const seg = { id, i, h, c: h ? a.y : a.x, a0: h ? Math.min(a.x, b.x) : Math.min(a.y, b.y), a1: h ? Math.max(a.x, b.x) : Math.max(a.y, b.y) };
      const key = (h ? 'h' : 'v') + Math.round(seg.c);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(seg);
    }
  }

  const shifts = new Map();
  const assign = (cluster) => {
    const seen = new Set();
    const lanes = cluster.filter((s) => !seen.has(s.id) && seen.add(s.id));
    if (lanes.length < 2) return;
    const tendency = (s) => {
      const p = routes.get(s.id).points;
      const before = p[s.i - 1], after = p[s.i + 2];
      const at = (q) => (q ? (s.h ? q.y : q.x) - s.c : 0);
      return at(before) + at(after);
    };
    lanes.sort((a, b) => tendency(a) - tendency(b) || a.id.localeCompare(b.id));
    lanes.forEach((s, j) => {
      const off = (j - (lanes.length - 1) / 2) * gap;
      if (!off) return;
      let list = shifts.get(s.id);
      if (!list) shifts.set(s.id, (list = []));
      list.push({ i: s.i, h: s.h, off });
    });
  };
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.a0 - b.a0);
    let cluster = [list[0]], end = list[0].a1;
    for (let k = 1; k < list.length; k++) {
      const s = list[k];
      if (s.a0 < end - 1) {
        cluster.push(s);
        end = Math.max(end, s.a1);
      } else {
        assign(cluster);
        cluster = [s];
        end = s.a1;
      }
    }
    assign(cluster);
  }

  const out = new Map();
  for (const [id, list] of shifts) {
    const pts = routes.get(id).points.map((p) => ({ x: p.x, y: p.y }));
    for (const { i, h, off } of list) {
      if (h) { pts[i].y += off; pts[i + 1].y += off; }
      else { pts[i].x += off; pts[i + 1].x += off; }
    }
    out.set(id, finish('poly', pts));
  }
  return out;
}

/** Two-bend route between facing sides, no obstacle avoidance. Cheap: used for previews and LOD. */
export function routeSimpleOrthogonal(src, tgt) {
  const [s0, s1] = pickSides(src, tgt);
  const p0 = portPoint(src, s0), p3 = portPoint(tgt, s1);
  let pts;
  if (s0 === 'left' || s0 === 'right') {
    const mx = (p0.x + p3.x) / 2;
    pts = [p0, { x: mx, y: p0.y }, { x: mx, y: p3.y }, p3];
  } else {
    const my = (p0.y + p3.y) / 2;
    pts = [p0, { x: p0.x, y: my }, { x: p3.x, y: my }, p3];
  }
  return finish('poly', simplify(pts));
}

export function routeSelfLoop(r) {
  const s = 28;
  const x1 = r.x + r.w * 0.75;
  const y2 = r.y + Math.min(r.h / 2, 24);
  return finish('poly', [
    { x: x1, y: r.y }, { x: x1, y: r.y - s }, { x: r.x + r.w + s, y: r.y - s },
    { x: r.x + r.w + s, y: y2 }, { x: r.x + r.w, y: y2 },
  ]);
}

/** Shortest end segment that still shows an arrowhead clear of the elements. */
export const ARROW_ROOM = 18;

export function routeOrthogonal(src, tgt, obstacles = [], { margin = 20, bendCost = 40 } = {}) {
  const gx = Math.max(tgt.x - (src.x + src.w), src.x - (tgt.x + tgt.w));
  const gy = Math.max(tgt.y - (src.y + src.h), src.y - (tgt.y + tgt.h));
  if (gx < 0 && gy < 0) return routeSimpleOrthogonal(src, tgt);
  // Close elements: never squeeze the route into a gap too narrow for its arrowhead.
  // A straight shot across facing sides is kept when it fits; otherwise the full clearance
  // makes the facing exits unusable, so the search goes around through the other sides.
  if (Math.max(gx, gy) < 2 * margin) {
    const straight = straightAcross(src, tgt, gx, gy);
    if (straight) return straight;
  }
  const m = margin;
  const r2 = (v) => Math.round(v * 2) / 2;

  const all = [src, tgt, ...obstacles];
  const blockers = all.map((o) => [o.x - m + 0.5, o.y - m + 0.5, o.x + o.w + m - 0.5, o.y + o.h + m - 0.5]);
  const inside = (x, y) => {
    for (const b of blockers) if (x > b[0] && x < b[2] && y > b[1] && y < b[3]) return true;
    return false;
  };

  const xs = new Set(), ys = new Set();
  for (const o of all) {
    xs.add(r2(o.x - m)); xs.add(r2(o.x + o.w + m));
    ys.add(r2(o.y - m)); ys.add(r2(o.y + o.h + m));
  }
  const sc = center(src), tc = center(tgt);
  xs.add(r2(sc.x)); xs.add(r2(tc.x)); xs.add(r2((sc.x + tc.x) / 2));
  ys.add(r2(sc.y)); ys.add(r2(tc.y)); ys.add(r2((sc.y + tc.y) / 2));
  if (tgt.x > src.x + src.w) xs.add(r2((src.x + src.w + tgt.x) / 2));
  if (src.x > tgt.x + tgt.w) xs.add(r2((tgt.x + tgt.w + src.x) / 2));
  if (tgt.y > src.y + src.h) ys.add(r2((src.y + src.h + tgt.y) / 2));
  if (src.y > tgt.y + tgt.h) ys.add(r2((tgt.y + tgt.h + src.y) / 2));

  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const NX = X.length, NY = Y.length;
  const xi = new Map(X.map((v, i) => [v, i]));
  const yi = new Map(Y.map((v, i) => [v, i]));

  const valid = new Uint8Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) valid[j * NX + i] = inside(X[i], Y[j]) ? 0 : 1;

  // Segment between neighbouring grid points: 0 unknown, 1 free, 2 blocked (memoized).
  const hSeg = new Uint8Array(NX * NY), vSeg = new Uint8Array(NX * NY);
  const segFree = (i, j, ni, nj) => {
    const horizontal = nj === j;
    const k = horizontal ? j * NX + Math.min(i, ni) : Math.min(j, nj) * NX + i;
    const memo = horizontal ? hSeg : vSeg;
    if (!memo[k]) {
      const mx = horizontal ? (X[i] + X[ni]) / 2 : X[i];
      const my = horizontal ? Y[j] : (Y[j] + Y[nj]) / 2;
      memo[k] = inside(mx, my) ? 2 : 1;
    }
    return memo[k] === 1;
  };

  const pointIndex = (p) => {
    const i = xi.get(r2(p.x)), j = yi.get(r2(p.y));
    return i === undefined || j === undefined ? -1 : j * NX + i;
  };

  const goals = new Map();
  for (let s = 0; s < 4; s++) {
    const p = portPoint(tgt, SIDES[s]);
    const k = pointIndex({ x: p.x + DX[s] * m, y: p.y + DY[s] * m });
    if (k >= 0 && valid[k]) goals.set(k, (s + 2) & 3);
  }
  if (!goals.size) return routeSimpleOrthogonal(src, tgt);
  const goalPts = [...goals.keys()].map((k) => [X[k % NX], Y[(k / NX) | 0]]);
  const h = (x, y) => {
    let best = Infinity;
    for (const [gx, gy] of goalPts) best = Math.min(best, Math.abs(gx - x) + Math.abs(gy - y));
    return best;
  };

  const S = NX * NY * 4;
  const g = new Float64Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const closed = new Uint8Array(S);
  const heap = new MinHeap();
  const relax = (st, cost, from, x, y) => {
    if (cost < g[st]) {
      g[st] = cost;
      prev[st] = from;
      heap.push(st, cost + h(x, y));
    }
  };

  for (let s = 0; s < 4; s++) {
    const p = portPoint(src, SIDES[s]);
    const e = { x: p.x + DX[s] * m, y: p.y + DY[s] * m };
    const k = pointIndex(e);
    if (k >= 0 && valid[k]) relax(k * 4 + s, m, -1, e.x, e.y);
  }

  let found = -1;
  while (heap.size) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const k = st >> 2, d = st & 3;
    const i = k % NX, j = (k / NX) | 0;
    const gd = goals.get(k);
    if (gd !== undefined) {
      if (gd === d) { found = st; break; }
      if (gd !== ((d + 2) & 3)) relax(k * 4 + gd, g[st] + bendCost, st, X[i], Y[j]);
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue;
      const ni = i + DX[nd], nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
      const nk = nj * NX + ni;
      if (!valid[nk] || !segFree(i, j, ni, nj)) continue;
      const len = Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]);
      relax(nk * 4 + nd, g[st] + len + (nd !== d ? bendCost : 0), st, X[ni], Y[nj]);
    }
  }
  if (found < 0) return routeSimpleOrthogonal(src, tgt);

  const pts = [];
  let first = found;
  for (let st = found; st !== -1; st = prev[st]) {
    first = st;
    const k = st >> 2;
    pts.push({ x: X[k % NX], y: Y[(k / NX) | 0] });
  }
  pts.reverse();
  const startSide = SIDES[first & 3];
  const endSide = SIDES[((found & 3) + 2) & 3];
  return finish('poly', simplify([portPoint(src, startSide), ...pts, portPoint(tgt, endSide)]));
}

/**
 * Attachment of a member to a bus (a shared network segment drawn as a bar): a straight drop
 * perpendicular to the bus, at the member's center; if the member lies beyond the bus's
 * ends, the drop turns and enters the bus from its end. `memberIsSource` sets the direction.
 */
export function routeToBus(member, bus, memberIsSource) {
  const horizontal = bus.w >= bus.h;
  const c = center(member), inset = Math.min(16, (horizontal ? bus.w : bus.h) / 4);
  let pts;
  if (horizontal) {
    const above = c.y < bus.y + bus.h / 2;
    const from = { x: c.x, y: above ? member.y + member.h : member.y };
    const x = clamp(c.x, bus.x + inset, bus.x + bus.w - inset);
    pts = x === c.x
      ? [from, { x, y: above ? bus.y : bus.y + bus.h }]
      : [from, { x: c.x, y: bus.y + bus.h / 2 }, { x: c.x < bus.x ? bus.x : bus.x + bus.w, y: bus.y + bus.h / 2 }];
  } else {
    const left = c.x < bus.x + bus.w / 2;
    const from = { x: left ? member.x + member.w : member.x, y: c.y };
    const y = clamp(c.y, bus.y + inset, bus.y + bus.h - inset);
    pts = y === c.y
      ? [from, { x: left ? bus.x : bus.x + bus.w, y }]
      : [from, { x: bus.x + bus.w / 2, y: c.y }, { x: bus.x + bus.w / 2, y: c.y < bus.y ? bus.y : bus.y + bus.h }];
  }
  return finish('poly', memberIsSource ? pts : pts.reverse(), { manual: true });
}

/** Where an edge label sits: fraction `t` along the route, the midpoint by default. */
export function labelPoint(route, t) {
  return t == null ? route.mid : pointAlong(route.poly, t);
}

/** Which side of `r` a port point lies on, or null. */
export function sideOf(r, p) {
  const e = 0.75;
  if (Math.abs(p.x - r.x) < e) return 'left';
  if (Math.abs(p.x - r.x - r.w) < e) return 'right';
  if (Math.abs(p.y - r.y) < e) return 'top';
  if (Math.abs(p.y - r.y - r.h) < e) return 'bottom';
  return null;
}

/**
 * Fan out edge ends that share a node side so parallel links don't overlap.
 * `items` are `{ id, route, source, target }` (rects). Ends are ordered by where the
 * edge heads, which avoids introducing crossings. Only the first/last segments move,
 * so orthogonal routes stay orthogonal; a curve's end moves with its control point, so it
 * still leaves the side square. Returns Map<id, adjusted route>.
 */
export function spreadPorts(items, { maxGap = 18 } = {}) {
  const groups = new Map();
  const add = (key, entry) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(entry);
  };
  for (const it of items) {
    const pts = it.route.points;
    if (it.route.manual || it.route.straight || pts.length < 2 || it.source === it.target) continue;
    const s = sideOf(it.source, pts[0]);
    const t = sideOf(it.target, pts[pts.length - 1]);
    if (s) add(it.sourceId + '|' + s, { it, end: 0, side: s, rect: it.source, far: pts[Math.min(2, pts.length - 1)] });
    if (t) add(it.targetId + '|' + t, { it, end: 1, side: t, rect: it.target, far: pts[Math.max(0, pts.length - 3)] });
  }
  const offsets = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const alongX = list[0].side === 'top' || list[0].side === 'bottom';
    const len = alongX ? list[0].rect.w : list[0].rect.h;
    const gap = Math.min(maxGap, len / (list.length + 1));
    list.sort((a, b) => (alongX ? a.far.x - b.far.x : a.far.y - b.far.y) || a.it.id.localeCompare(b.it.id));
    list.forEach((entry, i) => {
      const off = (i - (list.length - 1) / 2) * gap;
      if (!off) return;
      let o = offsets.get(entry.it.id);
      if (!o) offsets.set(entry.it.id, (o = { it: entry.it, s: null, t: null }));
      o[entry.end ? 't' : 's'] = { off, alongX };
    });
  }
  const out = new Map();
  for (const { it, s, t } of offsets.values()) {
    let pts = it.route.points.map((p) => ({ x: p.x, y: p.y }));
    const shift = (i, { off, alongX }) => {
      if (alongX) pts[i].x += off;
      else pts[i].y += off;
    };
    const bezier = it.route.kind === 'bezier';
    if (pts.length === 2) {
      // Straight shot between facing sides: add a jog so both ends can move independently.
      const [a, b] = pts;
      const horizontal = Math.abs(a.y - b.y) < 0.01;
      const m = horizontal ? (a.x + b.x) / 2 : (a.y + b.y) / 2;
      pts = horizontal ? [a, { x: m, y: a.y }, { x: m, y: b.y }, b] : [a, { x: a.x, y: m }, { x: b.x, y: m }, b];
    }
    const n = pts.length;
    if (s) { shift(0, s); shift(1, s); }
    if (t) { shift(n - 1, t); shift(n - 2, t); }
    out.set(it.id, bezier ? finish('bezier', pts) : finish('poly', simplify(pts)));
  }
  return out;
}

/**
 * One straight segment between facing sides of close elements, through the middle of the
 * span they share, if that span is wide enough and the gap leaves room for the arrowhead.
 */
function straightAcross(src, tgt, gx, gy) {
  const vertical = gy >= gx;
  const gap = vertical ? gy : gx;
  if (gap < ARROW_ROOM) return null;
  const lo = vertical ? Math.max(src.x, tgt.x) : Math.max(src.y, tgt.y);
  const hi = vertical ? Math.min(src.x + src.w, tgt.x + tgt.w) : Math.min(src.y + src.h, tgt.y + tgt.h);
  if (hi - lo < 40) return null;
  // Prefer the source's own centre line when it lies in the shared span.
  const sc = vertical ? src.x + src.w / 2 : src.y + src.h / 2;
  const c = sc >= lo + 8 && sc <= hi - 8 ? sc : (lo + hi) / 2;
  if (vertical) {
    const down = tgt.y > src.y;
    return finish('poly', [{ x: c, y: down ? src.y + src.h : src.y }, { x: c, y: down ? tgt.y : tgt.y + tgt.h }]);
  }
  const right = tgt.x > src.x;
  return finish('poly', [{ x: right ? src.x + src.w : src.x, y: c }, { x: right ? tgt.x : tgt.x + tgt.w, y: c }]);
}

function simplify(pts) {
  const out = [];
  const same = (a, b) => Math.abs(a - b) < 0.01;
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && same(last.x, p.x) && same(last.y, p.y)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((same(a.x, last.x) && same(last.x, p.x)) || (same(a.y, last.y) && same(last.y, p.y))) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** The same route moved by (dx, dy): what a link looks like when both its ends moved together. */
export function translateRoute(r, dx, dy) {
  const move = (p) => ({ x: p.x + dx, y: p.y + dy });
  const points = r.points.map(move);
  return {
    ...r, points,
    poly: r.poly === r.points ? points : r.poly.map(move),
    bbox: { ...r.bbox, x: r.bbox.x + dx, y: r.bbox.y + dy },
    mid: move(r.mid),
  };
}

export function finish(kind, points, extra = null) {
  const poly = kind === 'bezier' ? sampleCubic(...points) : points;
  const bbox = boundsOf(poly.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  let mid;
  if (kind === 'bezier') mid = cubicPoint(...points, 0.5);
  else mid = polylineMidpoint(points);
  const n = points.length;
  let a = points[n - 2], b = points[n - 1];
  if (kind === 'bezier' && dist(a, b) < 0.01) a = points[1];
  // Unit directions at both ends: `end` into the target, `start` out of the source.
  let s0 = points[0], s1 = points[1];
  if (kind === 'bezier' && dist(s0, s1) < 0.01) s1 = points[2];
  const len = dist(a, b) || 1, slen = dist(s0, s1) || 1;
  return {
    kind, points, poly, bbox, mid: { x: mid.x, y: mid.y },
    end: { x: (b.x - a.x) / len, y: (b.y - a.y) / len },
    start: { x: (s1.x - s0.x) / slen, y: (s1.y - s0.y) / slen },
    ...extra,
  };
}

class MinHeap {
  ids = [];
  keys = [];
  get size() { return this.ids.length; }

  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }

  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop(), key = keys.pop();
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let c = i, ck = key;
        if (l < n && keys[l] < ck) { c = l; ck = keys[l]; }
        if (r < n && keys[r] < ck) { c = r; }
        if (c === i) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = id; keys[i] = key;
    }
    return top;
  }
}
