import { snapRect, applyEdges } from '../engine/snapping.js';
import { boundsOf, clamp, containsRect, dist, inflate, projectOnPolyline, rectFromPoints, snap } from '../engine/geometry.js';
import { uid } from '../engine/document.js';
import { insideRect, routeManual, sideOf } from '../engine/routing.js';

/**
 * Pointer gestures. Each one owns the interaction from the moment the pointer passes the
 * drag threshold until release: `move(e)`, `up(e)`, `cancel()`. Continuous edits use a
 * history merge key so a whole gesture is a single undo step.
 */

const AUTOPAN_EDGE = 28;

function snapCandidates(ed, exclude) {
  const view = inflate(ed.camera.viewRect(), 200 / ed.camera.zoom);
  const hidden = ed.doc.hidden();
  return ed.doc.index.query(view)
    .filter((id) => !exclude.has(id) && !hidden.has(id))
    .map((id) => ed.doc.nodes.get(id));
}

function autopan(ed, e) {
  const { w, h } = ed.camera.size;
  const dx = e.x < AUTOPAN_EDGE ? 8 : e.x > w - AUTOPAN_EDGE ? -8 : 0;
  const dy = e.y < AUTOPAN_EDGE ? 8 : e.y > h - AUTOPAN_EDGE ? -8 : 0;
  if (dx || dy) ed.camera.panBy(dx, dy);
}

export class PanGesture {
  constructor(ed, e) {
    this.ed = ed;
    this.start = { x: e.x, y: e.y };
    this.last = { x: e.x, y: e.y };
    this.button = e.button;
    this.cursor = 'grabbing';
  }

  move(e) {
    this.ed.camera.panBy(e.x - this.last.x, e.y - this.last.y);
    this.last = { x: e.x, y: e.y };
  }

  up(e) {
    if (this.button === 2 && dist(this.start, e) < 4) this.ed.openContextMenu(e);
  }

  cancel() {}
}

/**
 * Move the selection. Holding Ctrl/⌘ drags a copy instead; it can be pressed or released
 * mid-drag to switch between moving and copying. Alt disables snapping, Shift locks an axis.
 */
export class DragGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.key = 'drag:' + uid('g');
    this.cursor = 'grabbing';
    const doc = ed.doc;
    this.originals = ed.topLevel([...ed.selection].filter((id) => doc.nodes.has(id)));
    this.snapshot = ed.snapshot(this.originals);
    this.copy = false;
    this.bbox = doc.bounds(this.originals);
    this.origin = press.world;
    this.parents = new Set(this.originals.map((id) => doc.nodes.get(id).parent ?? null));
    this.dx = 0;
    this.dy = 0;
    this.target = null;
    this.last = null;
    this.#track(this.originals);
    ed.router.setLive(true);
  }

  /** Make `ids` (plus descendants, and hand-made routes among them) the set being moved. */
  #track(ids) {
    const doc = this.ed.doc;
    this.ids = ids;
    this.all = new Set();
    for (const id of ids) {
      this.all.add(id);
      for (const d of doc.descendants(id)) this.all.add(d);
    }
    this.start = new Map([...this.all].map((id) => [id, { x: doc.nodes.get(id).x, y: doc.nodes.get(id).y }]));
    this.routes = [...doc.edges.values()].filter((e) => e.style?.points && this.all.has(e.source) && this.all.has(e.target))
      .map((e) => ({ id: e.id, style: e.style }));
    this.others = snapCandidates(this.ed, this.all);
  }

  /** Switch between moving the originals and moving a copy (originals stay put). */
  #setCopy(on) {
    const ed = this.ed, doc = ed.doc;
    this.copy = on;
    doc.transact(on ? 'Duplicate' : 'Move', () => {
      if (on) {
        for (const [id, p] of this.start) doc.update(id, p);
        for (const { id, style } of this.routes) doc.update(id, { style });
        this.#track(ed.insertSnapshot(this.snapshot, 0, 0));
      } else {
        doc.remove(this.ids);
        this.#track(this.originals);
      }
    }, { merge: this.key });
    ed.setSelection(this.ids);
    this.cursor = on ? 'copy' : 'grabbing';
    ed.setCursor(this.cursor);
    this.dx = this.dy = NaN;
  }

  /** Modifier keys changed mid-drag (e.g. Ctrl pressed): re-apply the last move. */
  keys(e) {
    if (this.last) this.move({ ...this.last, mod: e.mod, alt: e.alt, shift: e.shift });
  }

  move(e) {
    const ed = this.ed;
    this.last = e;
    if (!!e.mod !== this.copy) this.#setCopy(!!e.mod);
    autopan(ed, e);
    const w = ed.toWorld(e);
    let dx = w.x - this.origin.x, dy = w.y - this.origin.y;
    const lockX = e.shift && Math.abs(dx) < Math.abs(dy);
    const lockY = e.shift && !lockX;
    if (lockX) dx = 0;
    if (lockY) dy = 0;
    const snapping = !e.alt;
    const s = snapRect({
      rect: { ...this.bbox, x: this.bbox.x + dx, y: this.bbox.y + dy },
      others: this.others,
      threshold: 7 / ed.camera.zoom,
      grid: snapping && ed.settings.snapToGrid ? ed.settings.grid : 0,
      guides: snapping && ed.settings.snapToObjects,
    });
    if (!lockX) dx += s.dx;
    if (!lockY) dy += s.dy;
    ed.overlay.guides = s.lines;
    ed.overlay.gaps = s.gaps;
    if (dx !== this.dx || dy !== this.dy) {
      this.dx = dx;
      this.dy = dy;
      ed.doc.transact('Move', () => {
        for (const [id, p] of this.start) ed.doc.update(id, { x: p.x + dx, y: p.y + dy });
        for (const { id, style } of this.routes) {
          ed.doc.update(id, { style: { ...style, points: style.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } });
        }
      }, { merge: this.key });
    }
    // A lone, unlinked inline node (firewall...) can be dropped onto a link to sit in its path.
    const inline = this.ids.length === 1 && ed.schema.nodeTypes[ed.doc.nodes.get(this.ids[0]).type]?.inline &&
      !ed.doc.edgesOf(this.ids[0]).length;
    ed.overlay.insertEdge = inline ? ed.edgeAt(w, this.all)?.id ?? null : null;
    this.dropPoint = w;
    const target = ed.containerAt(w, this.all);
    this.target = target?.id ?? null;
    const sameParent = this.parents.size === 1 && this.parents.has(this.target);
    ed.overlay.dropTarget = target && !sameParent ? target.id : null;
    ed.invalidate();
  }

  up() {
    const ed = this.ed;
    const intoCard = this.target != null && ed.showsAsCard(this.target);
    ed.doc.transact('Move', () => {
      for (const id of this.ids) {
        const n = ed.doc.nodes.get(id);
        if (n && !ed.isOverlay(id) && (n.parent ?? null) !== this.target) ed.doc.update(id, { parent: this.target, z: ed.doc.nextZ() });
      }
      if (intoCard) ed.adoptIntoHost(this.target, this.ids);
      if (ed.overlay.insertEdge) ed.insertIntoEdge(this.ids[0], ed.overlay.insertEdge, this.dropPoint);
      ed.fitContainers(this.ids);
    }, { merge: this.key });
    ed.history.seal();
    this.#end();
  }

  cancel() {
    this.ed.revertGesture(this.key);
    this.#end();
  }

  #end() {
    const ed = this.ed;
    ed.overlay.guides = [];
    ed.overlay.gaps = [];
    ed.overlay.dropTarget = null;
    ed.overlay.insertEdge = null;
    ed.router.setLive(false);
    ed.invalidate();
  }
}

const HANDLE_CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
export const cursorForHandle = (h) => HANDLE_CURSORS[h] ?? 'default';

export class ResizeGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.key = 'resize:' + uid('g');
    this.id = press.hit.id;
    this.handle = press.hit.handle;
    this.cursor = cursorForHandle(this.handle);
    const n = ed.doc.nodes.get(this.id);
    this.start = { x: n.x, y: n.y, w: n.w, h: n.h };
    this.origin = press.world;
    const h = this.handle;
    this.edges = { left: h.includes('w'), right: h.includes('e'), top: h.includes('n'), bottom: h.includes('s') };
    const container = ed.doc.isContainer(n) && !ed.showsAsCard(n.id);
    this.min = container ? { w: 160, h: 100 } : { w: 60, h: 36 };
    const kids = ed.doc.children(this.id);
    const { containerPadding: pad, containerHeader: head } = ed.settings;
    const b = kids.length ? boundsOf(kids) : null;
    this.inner = b && { x: b.x - pad, y: b.y - head, r: b.x + b.w + pad, b: b.y + b.h + pad };
    const exclude = new Set([this.id, ...ed.doc.descendants(this.id)]);
    this.others = snapCandidates(ed, exclude);
    ed.router.setLive(true);
  }

  move(e) {
    const ed = this.ed;
    autopan(ed, e);
    const w = ed.toWorld(e);
    const { start, edges } = this;
    let r = applyEdges(start, edges, w.x - this.origin.x, w.y - this.origin.y);
    const corner = (edges.left || edges.right) && (edges.top || edges.bottom);
    if (e.shift && corner) {
      const s = Math.max(r.w / start.w, r.h / start.h);
      const nw = start.w * s, nh = start.h * s;
      r = { x: edges.left ? start.x + start.w - nw : start.x, y: edges.top ? start.y + start.h - nh : start.y, w: nw, h: nh };
      ed.overlay.guides = [];
    } else {
      const snapping = !e.alt;
      const s = snapRect({
        rect: r, others: this.others, edges,
        threshold: 7 / ed.camera.zoom,
        grid: snapping && ed.settings.snapToGrid ? ed.settings.grid : 0,
        guides: snapping && ed.settings.snapToObjects,
      });
      r = applyEdges(r, edges, s.dx, s.dy);
      ed.overlay.guides = s.lines;
    }
    let l = r.x, t = r.y, rr = r.x + r.w, b = r.y + r.h;
    const R = start.x + start.w, B = start.y + start.h;
    if (edges.left) l = Math.min(l, R - this.min.w, this.inner?.x ?? Infinity);
    if (edges.right) rr = Math.max(rr, start.x + this.min.w, this.inner?.r ?? -Infinity);
    if (edges.top) t = Math.min(t, B - this.min.h, this.inner?.y ?? Infinity);
    if (edges.bottom) b = Math.max(b, start.y + this.min.h, this.inner?.b ?? -Infinity);
    ed.doc.transact('Resize', () => ed.doc.update(this.id, { x: l, y: t, w: rr - l, h: b - t }), { merge: this.key });
    ed.invalidate();
  }

  up() {
    const ed = this.ed;
    ed.doc.transact('Resize', () => {
      // Free text given a width now wraps within it, and its height follows the content.
      if (ed.isText(this.id)) {
        const n = ed.doc.nodes.get(this.id);
        ed.doc.update(this.id, { style: { ...n.style, autoWidth: false } });
        ed.fitText(this.id);
      }
      ed.fitContainers([this.id]);
    }, { merge: this.key });
    this.ed.history.seal();
    this.#end();
  }

  cancel() {
    this.ed.revertGesture(this.key);
    this.#end();
  }

  #end() {
    this.ed.overlay.guides = [];
    this.ed.router.setLive(false);
    this.ed.invalidate();
  }
}

export class MarqueeGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.cursor = 'crosshair';
    this.origin = press.world;
    this.base = press.e.shift ? new Set(ed.selection) : new Set();
  }

  move(e) {
    const ed = this.ed;
    autopan(ed, e);
    const rect = rectFromPoints(this.origin, ed.toWorld(e));
    ed.overlay.marquee = rect;
    const picked = new Set(this.base);
    for (const id of ed.doc.index.query(rect)) if (containsRect(rect, ed.doc.nodes.get(id))) picked.add(id);
    for (const edge of ed.doc.edges.values()) {
      if (picked.has(edge.source) && picked.has(edge.target)) picked.add(edge.id);
    }
    ed.setSelection(picked);
    ed.invalidate();
  }

  up() {
    this.ed.overlay.marquee = null;
    this.ed.invalidate();
  }

  cancel() {
    this.ed.setSelection(this.base);
    this.up();
  }
}

/** Drag from a port: drop on a node to link, drop on empty canvas to create a linked node. */
export class ConnectGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.cursor = 'crosshair';
    this.sourceId = press.hit.id;
    this.side = press.hit.side;
  }

  move(e) {
    const ed = this.ed;
    autopan(ed, e);
    const w = ed.toWorld(e);
    const found = ed.nodeAt(w, { exclude: new Set([this.sourceId]) });
    const target = found && !ed.schema.nodeTypes[found.type]?.noPorts ? found : null;
    ed.overlay.connect = { sourceId: this.sourceId, targetId: target?.id ?? null, point: w, side: this.side };
    ed.invalidate();
  }

  up(e) {
    const ed = this.ed;
    const c = ed.overlay.connect;
    ed.overlay.connect = null;
    if (!c) return;
    if (c.targetId) {
      const edge = ed.connect(this.sourceId, c.targetId);
      ed.setSelection([edge.id]);
    } else {
      ed.createLinkedNode(this.sourceId, ed.toWorld(e));
    }
    ed.invalidate();
  }

  cancel() {
    this.ed.overlay.connect = null;
    this.ed.invalidate();
  }
}

/** Drag a selected edge's endpoint onto another node. */
export class ReconnectGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.cursor = 'crosshair';
    this.edgeId = press.hit.id;
    this.end = press.hit.end;
    const edge = ed.doc.edges.get(this.edgeId);
    this.fixed = this.end === 'target' ? edge.source : edge.target;
  }

  move(e) {
    const ed = this.ed;
    const w = ed.toWorld(e);
    const target = ed.nodeAt(w);
    ed.overlay.connect = {
      sourceId: this.fixed, targetId: target?.id ?? null, point: w,
      reverse: this.end === 'source', edgeId: this.edgeId,
    };
    ed.invalidate();
  }

  up() {
    const ed = this.ed;
    const c = ed.overlay.connect;
    ed.overlay.connect = null;
    if (c?.targetId) ed.doc.transact('Reconnect edge', () => ed.doc.update(this.edgeId, { [this.end]: c.targetId }));
    ed.invalidate();
  }

  cancel() {
    this.ed.overlay.connect = null;
    this.ed.invalidate();
  }
}

/** Remove repeated and collinear bends so stored routes stay minimal. */
function cleanBends(pts) {
  const out = [];
  const same = (a, b) => Math.abs(a - b) < 0.01;
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && same(last.x, p.x) && same(last.y, p.y)) continue;
    const prev = out[out.length - 2];
    if (prev && ((same(prev.x, last.x) && same(last.x, p.x)) || (same(prev.y, last.y) && same(last.y, p.y)))) out.pop();
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

const setStyle = (ed, id, patch, merge) => {
  const e = ed.doc.edges.get(id);
  const style = { ...e.style, ...patch };
  for (const k of Object.keys(style)) if (style[k] == null) delete style[k];
  ed.doc.transact('Reshape link', () => ed.doc.update(id, { style }), { merge });
};

/**
 * At the end of a reshape: waypoints left inside either end are never drawn, so drop them;
 * if what remains can't be drawn either, go back to automatic routing. Otherwise the link
 * would keep an invisible shape that springs back when an element moves.
 */
function dropStaleWaypoints(ed, id, merge) {
  const e = ed.doc.edges.get(id);
  const pts = e?.style?.points;
  if (!pts?.length) return;
  const end = (n) => ed.doc.nodes.get(ed.doc.visibleAncestor(n));
  const s = end(e.source), t = end(e.target);
  if (!s || !t) return;
  const kept = pts.filter((p) => !insideRect(s, p) && !insideRect(t, p));
  const valid = kept.length && routeManual(e.style.routing ?? 'orthogonal', s, t, kept);
  if (!valid) setStyle(ed, id, { points: null }, merge);
  else if (kept.length !== pts.length) setStyle(ed, id, { points: kept }, merge);
}

/**
 * Bend that makes a link leave `r` through the side facing coordinate `c` on `axis`, or null
 * while `c` is still within the node's extent (the end can just slide along its side).
 */
function exitBend(r, c, axis) {
  if (!r) return null;
  if (axis === 'x') return c > r.x && c < r.x + r.w ? null : { x: c, y: r.y + r.h / 2 };
  return c > r.y && c < r.y + r.h ? null : { x: r.x + r.w / 2, y: c };
}

const SIDE_FRACTIONS = [[1 / 4, false], [1 / 3, true], [1 / 2, false], [2 / 3, true], [3 / 4, false]];

/**
 * Quarter, third and half marks on the side of `r` that a link end slides along, or null
 * once `c` (the end's coordinate on `axis`) leaves that side. Thirds suit an even number of
 * links, quarters and the half an odd one.
 */
function sideMarks(r, side, axis, c) {
  if (!r || !side) return null;
  const lo = r[axis], len = axis === 'x' ? r.w : r.h;
  if (c <= lo || c >= lo + len) return null;
  return { rect: { x: r.x, y: r.y, w: r.w, h: r.h }, side, axis, hot: null, marks: SIDE_FRACTIONS.map(([f, third]) => ({ f, third, pos: lo + len * f })) };
}

/** Drag a segment of an orthogonal link sideways; the route becomes hand-made. */
export class SegmentGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.key = 'route:' + uid('g');
    this.id = press.hit.id;
    const r = ed.router.peek(this.id) ?? ed.router.get(this.id);
    let pts = r.points.map((p) => ({ x: p.x, y: p.y }));
    let k = Math.min(press.hit.segment ?? 0, pts.length - 2);
    this.whole = pts.length === 2;
    if (this.whole) {
      pts = [pts[0], { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, pts[1]];
      k = 0;
    }
    const a = pts[k], b = pts[this.whole ? 2 : k + 1];
    this.k = k;
    this.start = pts;
    this.axis = Math.abs(a.y - b.y) < 0.5 ? 'y' : 'x';
    this.cursor = this.axis === 'y' ? 'ns-resize' : 'ew-resize';
    this.origin = press.world;
  }

  move(e) {
    const ed = this.ed, ax = this.axis;
    const w = ed.toWorld(e);
    const raw = this.start[this.whole ? 1 : this.k][ax] + (w[ax] - this.origin[ax]);
    let c = !e.alt && ed.settings.snapToGrid ? snap(raw, ed.settings.grid / 2) : raw;
    const edge = ed.doc.edges.get(this.id);
    const end = (id) => ed.doc.nodes.get(ed.doc.visibleAncestor(id));
    const last = this.start.length - 1;
    // A segment attached to a node slides that end along its side: mark the side and snap to
    // the marks, which beat the grid.
    const sides = [];
    if (this.whole || this.k === 0) sides.push(sideMarks(end(edge.source), sideOf(end(edge.source), this.start[0]), ax, raw));
    if (this.whole || this.k + 1 === last) sides.push(sideMarks(end(edge.target), sideOf(end(edge.target), this.start[last]), ax, raw));
    ed.overlay.sideMarks = sides.filter(Boolean);
    if (!e.alt) {
      let best = null, bestD = 7 / ed.camera.zoom;
      for (const s of ed.overlay.sideMarks) {
        for (const m of s.marks) if (Math.abs(m.pos - raw) <= bestD) { bestD = Math.abs(m.pos - raw); best = m.pos; }
      }
      if (best != null) {
        c = best;
        for (const s of ed.overlay.sideMarks) s.hot = s.marks.find((m) => Math.abs(m.pos - c) < 0.01)?.pos ?? null;
      }
    }
    const pts = this.start.map((p) => ({ x: p.x, y: p.y }));
    if (this.whole) pts[1][ax] = c;
    else pts[this.k][ax] = pts[this.k + 1][ax] = c;
    const bends = pts.slice(1, -1);
    // A segment attached to a node, dragged past that node's extent, leaves from the side
    // facing the drag (e.g. a vertical link pulled to the right becomes a right-side bracket).
    if (this.whole || this.k === 0) {
      const b = exitBend(end(edge.source), c, ax);
      if (b) bends.unshift(b);
    }
    if (this.whole || this.k + 1 === pts.length - 1) {
      const b = exitBend(end(edge.target), c, ax);
      if (b) bends.push(b);
    }
    setStyle(ed, this.id, { points: cleanBends(bends) }, this.key);
    ed.invalidate();
  }

  up() {
    this.ed.overlay.sideMarks = [];
    dropStaleWaypoints(this.ed, this.id, this.key);
    this.ed.history.seal();
  }

  cancel() {
    this.ed.overlay.sideMarks = [];
    this.ed.revertGesture(this.key);
  }
}

/** Move a waypoint of a straight/curved link, or insert one by dragging a leg. */
export class WaypointGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.key = 'route:' + uid('g');
    this.id = press.hit.id;
    this.cursor = 'grabbing';
    // Start from the shape shown: stale waypoints (ignored by the router) are discarded.
    const shown = ed.router.peek(this.id);
    this.points = shown?.manual ? (ed.doc.edges.get(this.id).style?.points ?? []).map((p) => ({ x: p.x, y: p.y })) : [];
    if (press.hit.kind === 'waypoint') {
      this.index = press.hit.index;
    } else {
      this.index = clamp(press.hit.segment ?? 0, 0, this.points.length);
      this.points.splice(this.index, 0, { ...press.world });
    }
  }

  move(e) {
    const ed = this.ed;
    const w = ed.toWorld(e);
    const g = !e.alt && ed.settings.snapToGrid ? ed.settings.grid / 2 : 0;
    this.points[this.index] = { x: snap(w.x, g), y: snap(w.y, g) };
    setStyle(ed, this.id, { points: this.points.map((p) => ({ ...p })) }, this.key);
    ed.invalidate();
  }

  up() {
    dropStaleWaypoints(this.ed, this.id, this.key);
    this.ed.history.seal();
  }

  cancel() {
    this.ed.revertGesture(this.key);
  }
}

/** Slide a link's label along its path (magnetic at the middle). */
export class LabelGesture {
  constructor(ed, press) {
    this.ed = ed;
    this.key = 'label:' + uid('g');
    this.id = press.hit.id;
    this.cursor = 'grabbing';
  }

  move(e) {
    const ed = this.ed;
    const r = ed.router.peek(this.id) ?? ed.router.get(this.id);
    if (!r) return;
    let { t } = projectOnPolyline(ed.toWorld(e), r.poly);
    t = clamp(t, 0.04, 0.96);
    setStyle(ed, this.id, { labelT: Math.abs(t - 0.5) < 0.04 ? null : Math.round(t * 1000) / 1000 }, this.key);
    ed.invalidate();
  }

  up() {
    this.ed.history.seal();
  }

  cancel() {
    this.ed.revertGesture(this.key);
  }
}
