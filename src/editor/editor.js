import { Emitter } from '../engine/emitter.js';
import { DiagramDocument, isMove, uid } from '../engine/document.js';
import { History } from '../engine/history.js';
import { EdgeRouter } from '../engine/router.js';
import { layoutHierarchy } from '../engine/layout.js';
import { dependencies, pathsBetween } from '../engine/analysis.js';
import { legendEntries, legendHeight } from '../engine/legend.js';
import {
  boundsOf, center, containsPoint, containsRect, dist, distToPolyline, distToSegment, inflate, overlaps, pointAlong,
  polylineLength, projectOnPolyline, rectEquals, snap, union,
} from '../engine/geometry.js';
import { SIDES, labelPoint, portPoint, sideNormal } from '../engine/routing.js';
import { Camera } from './camera.js';
import {
  ConnectGesture, DragGesture, LabelGesture, MarqueeGesture, PanGesture, ReconnectGesture, ResizeGesture,
  SegmentGesture, WaypointGesture, cursorForHandle,
} from './gestures.js';
import { comboOf, createCommands } from './commands.js';
import { busMembers, isOverlay, resolveType, showsAsCard } from '../engine/schema.js';

const DRAG_THRESHOLD = 4;
// Pressing a link's body and dragging reshapes it, so a click that wobbles a few pixels
// must not: it would add a waypoint (curved/straight) or shift a segment (orthogonal).
const EDGE_DRAG_THRESHOLD = 10;
export const PORT_OFFSET = 18;
const PORT_HIT = 11;
const HANDLE_HIT = 8;
const BORDER_HIT = 5;
const EDGE_HIT = 6;
const HOVER_STICKY = 44;

/**
 * The editor: binds document, history, router and camera, and implements every user-level
 * action. It is renderer- and DOM-agnostic: input arrives as normalized events
 * `{ x, y, button, shift, alt, mod, pointerType }` in canvas-relative screen pixels,
 * and views subscribe to events (`invalidate`, `selectionchange`, `edit-label`, ...).
 */
export class Editor extends Emitter {
  selection = new Set();
  hover = null;
  portNode = null;
  gesture = null;
  press = null;
  editingId = null;
  editingField = 'label';
  /** Optional view that reports where text was drawn (set by the renderer). */
  layoutProbe = null;
  clipboard = null;
  /** Copied look (Copy style / Paste style): { kind, type, style }. */
  styleClip = null;
  tool = 'select';
  cursor = 'default';
  keys = { space: false };
  pointer = { x: 0, y: 0, world: { x: 0, y: 0 }, inside: false };
  overlay = { guides: [], gaps: [], sideMarks: [], marquee: null, connect: null, dropTarget: null, insertEdge: null };
  /** Dependency focus: dim everything not upstream or downstream of the selection. */
  focusDeps = false;
  /**
   * Read-only (presenting, view-only links): selecting, panning, zooming, hovering and the
   * dependency focus work; anything that would change the diagram does not.
   */
  readOnly = false;
  /**
   * The flow on show: its steps are numbered on the canvas. `step` ≥ 0 while playing (that
   * step highlighted, the rest of the diagram dimmed); `recording`: clicking links adds steps.
   */
  flow = { id: null, step: -1, recording: false };

  #pasteCount = 0;
  #copyPoint = null;
  #focusCache = { key: null, value: null };
  #legendGeometry = false;
  #legendsPending = false;

  constructor({ schema, settings = {} }) {
    super();
    this.schema = schema;
    this.settings = {
      grid: 20,
      snapToGrid: true,
      snapToObjects: true,
      showGrid: true,
      layoutDirection: 'LR',
      containerPadding: 28,
      containerHeader: 52,
      ...settings,
    };
    this.doc = new DiagramDocument(schema);
    this.history = new History(this.doc, { capture: () => [...this.selection] });
    this.router = new EdgeRouter(this.doc);
    this.camera = new Camera();

    this.commands = new Map();
    this.keymap = new Map();
    for (const c of createCommands(this)) this.registerCommand(c);

    this.doc.on('change', (e) => this.#onDocChange(e));
    this.history.on('restore', ({ state }) => state && this.setSelection(state));
    this.history.on('change', () => this.emit('history'));
    this.camera.on('change', () => {
      this.pointer.world = this.camera.toWorld(this.pointer);
      this.emit('camera');
      this.invalidate();
    });
  }

  // ───────────────────────────── plumbing

  invalidate() {
    this.emit('invalidate');
  }

  resize(w, h) {
    this.camera.size = { w, h };
    this.invalidate();
  }

  toWorld(p) { return this.camera.toWorld(p); }
  toScreen(p) { return this.camera.toScreen(p); }

  registerCommand(cmd) {
    this.commands.set(cmd.id, cmd);
    if (!cmd.passive) for (const k of cmd.keys ?? []) this.keymap.set(k, cmd);
  }

  run(id) {
    const cmd = this.commands.get(id);
    if (cmd && this.allowed(cmd) && (!cmd.enabled || cmd.enabled())) cmd.run();
  }

  /** Whether a command may run now: in read-only mode, only view commands and those marked `readOnly`. */
  allowed(cmd) {
    return !this.readOnly || cmd.group === 'View' || !!cmd.readOnly;
  }

  setReadOnly(on) {
    if (this.readOnly === on) return;
    this.cancelGesture();
    this.endEdit();
    this.readOnly = on;
    this.portNode = null;
    this.emit('readonly', on);
    this.invalidate();
  }

  setTool(tool) {
    this.tool = tool;
    this.emit('tool', tool);
    this.setCursor(this.#cursorFor(this.hover));
  }

  toggleSetting(key) {
    this.settings[key] = !this.settings[key];
    this.emit('settings');
  }

  setCursor(c) {
    if (c === this.cursor) return;
    this.cursor = c;
    this.emit('cursor', c);
  }

  #onDocChange(e) {
    this.#fitLegends(e);
    const gone = [...this.selection].filter((id) => !this.doc.has(id));
    if (gone.length || e.reset) {
      this.selection = new Set([...this.selection].filter((id) => this.doc.has(id)));
      this.emit('selectionchange', this.selection);
    }
    if (this.portNode && !this.doc.nodes.has(this.portNode)) this.portNode = null;
    if (this.editingId && !this.doc.has(this.editingId)) this.endEdit();
    // The open view's module may have gone (deleted, ungrouped, undone): back to everything.
    if (this.viewRoot != null && !this.canShowView(this.viewRoot)) {
      this.doc.setScope(null);
      this.emit('view', null);
    }
    // The flow on show may have gone (undo) or lost steps.
    if (this.flow.id) {
      const f = this.doc.flows.get(this.flow.id);
      if (!f) this.showFlow(null);
      else if (this.flow.step >= f.steps.length) this.showFlow(f.id, { step: f.steps.length - 1, record: this.flow.recording });
    }
    this.emit('docchange', e);
    this.invalidate();
  }

  /**
   * A legend's height follows its content (what the diagram uses). Kept out of the history:
   * it is derived, and undoing the change that caused it recomputes it anyway.
   */
  #fitLegends(e) {
    // Moving things only matters through border-only outlines, and then once the drag is over.
    if (!e.reset && e.patch.ops.every(isMove)) {
      if (!this.#legendGeometry) return;
      if (this.gesture) {
        this.#legendsPending = true;
        return;
      }
    }
    this.#legendsPending = false;
    const legends = [...this.doc.nodes.values()].filter((n) => this.schema.nodeTypes[n.type]?.shape === 'legend');
    this.#legendGeometry = false;
    if (!legends.length) return;
    const sections = legendEntries(this.doc);
    this.#legendGeometry = sections.geometryMatters;
    const h = legendHeight(sections);
    const stale = legends.filter((n) => n.h !== h);
    if (stale.length) this.doc.transact('Legend', () => stale.forEach((n) => this.doc.update(n.id, { h })), { history: false });
  }

  // ───────────────────────────── selection

  setSelection(ids) {
    const next = new Set([...ids].filter((id) => this.#selectable(id)));
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
    this.selection = next;
    this.emit('selectionchange', next);
    this.invalidate();
  }

  selectAll() {
    this.setSelection([...this.doc.nodes.keys(), ...this.doc.edges.keys()]);
  }

  /** Visible items only: anything inside a collapsed module is not selectable. */
  #selectable(id) {
    const hidden = this.doc.hidden();
    const e = this.doc.edges.get(id);
    if (e) return this.edgeShown(e);
    return this.doc.nodes.has(id) && !hidden.has(id);
  }

  selectedNodeIds() { return [...this.selection].filter((id) => this.doc.nodes.has(id)); }
  selectedEdgeIds() { return [...this.selection].filter((id) => this.doc.edges.has(id)); }

  singleSelected() {
    return this.selection.size === 1 ? [...this.selection][0] : null;
  }

  /** Drop ids whose ancestor is also in the list (moving a parent moves its children). */
  topLevel(ids) {
    const set = new Set(ids);
    return ids.filter((id) => !this.doc.ancestors(id).some((a) => set.has(a)));
  }

  selectionBounds() {
    const rects = this.selectedNodeIds().map((id) => this.doc.nodes.get(id));
    for (const id of this.selectedEdgeIds()) {
      const r = this.router.peek(id) ?? this.router.get(id);
      if (r) rects.push(r.bbox);
      const tag = this.layoutProbe?.labelRect?.(id);
      if (tag) rects.push(tag);
    }
    return boundsOf(rects);
  }

  // ───────────────────────────── dependency focus

  /**
   * Esc steps back one level: deselect, stop recording or playing a flow, leave the
   * dependency focus, go up from a view, then tell the app (`escape`).
   */
  escape() {
    if (this.selection.size) this.setSelection([]);
    else if (this.flow.recording) this.showFlow(this.flow.id);
    else if (this.flow.step >= 0) this.showFlow(this.flow.id);
    else if (this.focusDeps) this.toggleDependencies(false);
    else if (this.viewRoot != null) this.viewUp();
    else this.emit('escape');
  }

  // ───────────────────────────── views

  /** The module whose view is open (null: the whole diagram). */
  get viewRoot() {
    return this.doc.scope;
  }

  /** Can this node be opened as a view (a box holding things)? */
  canOpenView(id) {
    return this.canShowView(id) && this.doc.hasChildren(id) && id !== this.viewRoot;
  }

  /** Can an open view stay on this node (it may have been emptied meanwhile)? */
  canShowView(id) {
    const n = this.doc.nodes.get(id);
    return !!n && this.doc.isContainer(n) && !showsAsCard(this.doc, n);
  }

  /**
   * Open a module as its own view: its contents, plus what they link to outside it (faded,
   * as context). Same model: editing here edits the diagram. null goes back to everything.
   */
  openView(id, { animate = true } = {}) {
    if (id != null && !this.canOpenView(id)) return;
    const n = id != null && this.doc.nodes.get(id);
    if (n?.collapsed) this.toggleCollapse([id], false);
    this.cancelGesture();
    this.endEdit();
    this.doc.setScope(id);
    this.setSelection([]);
    this.emit('view', this.viewRoot);
    this.fitView({ animate });
    this.invalidate();
  }

  /** Up one level: the view of the module around this one, or the whole diagram. */
  viewUp() {
    const root = this.viewRoot;
    if (root == null) return;
    const parent = this.doc.ancestors(root).find((a) => this.canOpenView(a));
    const was = root;
    this.openView(parent ?? null);
    this.setSelection([was]);
  }

  /** The chain of modules from the top down to the open view (for a breadcrumb). */
  viewPath() {
    const root = this.viewRoot;
    return root == null ? [] : [...this.doc.ancestors(root).reverse(), root].filter((id) => this.doc.isContainer(id));
  }

  /** Shown as context in the open view (outside it, linked to it). */
  isContext(id) {
    return this.viewRoot != null && this.doc.context().has(id);
  }

  /** Bounds of what is shown (the view, or everything). */
  visibleBounds() {
    const hidden = this.doc.hidden();
    return boundsOf([...this.doc.nodes.values()].filter((n) => !hidden.has(n.id)));
  }

  // ───────────────────────────── flows

  /** Show a flow (null: none). `step` ≥ 0 plays it from that step; `record` adds clicked links. */
  showFlow(id, { step = -1, record = false } = {}) {
    const f = id && this.doc.flows.get(id);
    this.flow = f
      ? { id, step: f.steps.length ? Math.min(step, f.steps.length - 1) : -1, recording: record && !this.readOnly }
      : { id: null, step: -1, recording: false };
    this.emit('flow', this.flow);
    this.invalidate();
  }

  playFlow(id = this.flow.id, from = 0) {
    this.showFlow(id, { step: from });
    const f = this.doc.flows.get(id);
    if (f?.steps.length) this.#frameStep();
  }

  /** Move through the flow being played; the view follows the step. */
  stepFlow(delta) {
    const f = this.doc.flows.get(this.flow.id);
    if (!f || this.flow.step < 0) return;
    const step = Math.max(0, Math.min(f.steps.length - 1, this.flow.step + delta));
    if (step === this.flow.step) return;
    this.flow = { ...this.flow, step };
    this.emit('flow', this.flow);
    this.#frameStep();
    this.invalidate();
  }

  /** Keep the current step's two ends in view. */
  #frameStep() {
    const s = this.currentStep();
    if (!s) return;
    const e = this.doc.edges.get(s.edge);
    const ends = [e.source, e.target].map((id) => this.doc.nodes.get(this.doc.visibleAncestor(id)));
    this.ensureVisible(boundsOf(ends));
  }

  /** The step being played: { edge, label, reverse, index }, or null. */
  currentStep() {
    const f = this.doc.flows.get(this.flow.id);
    const s = f?.steps[this.flow.step];
    return s ? { ...s, index: this.flow.step } : null;
  }

  createFlow(name) {
    let flow;
    this.doc.transact('New flow', () => (flow = this.doc.addFlow({ name: name ?? `Flow ${this.doc.flows.size + 1}` })));
    this.showFlow(flow.id, { record: true });
    return flow;
  }

  addFlowStep(edgeId, flowId = this.flow.id) {
    const f = this.doc.flows.get(flowId);
    if (!f || !this.doc.edges.has(edgeId)) return;
    this.doc.transact('Add step', () => this.doc.update(flowId, { steps: [...f.steps, { edge: edgeId, label: '' }] }));
  }

  /** Change a step: { label?, reverse? }; `merge` coalesces a typing session. */
  updateFlowStep(flowId, index, patch, merge) {
    const f = this.doc.flows.get(flowId);
    if (!f?.steps[index]) return;
    const steps = f.steps.map((s, i) => {
      if (i !== index) return s;
      const next = { ...s, ...patch };
      if (!next.reverse) delete next.reverse;
      return next;
    });
    this.doc.transact('Edit step', () => this.doc.update(flowId, { steps }), { merge });
  }

  removeFlowStep(flowId, index) {
    const f = this.doc.flows.get(flowId);
    if (!f?.steps[index]) return;
    this.doc.transact('Remove step', () => this.doc.update(flowId, { steps: f.steps.filter((_, i) => i !== index) }));
  }

  moveFlowStep(flowId, index, delta) {
    const f = this.doc.flows.get(flowId);
    const to = index + delta;
    if (!f?.steps[index] || to < 0 || to >= f.steps.length) return;
    const steps = [...f.steps];
    [steps[index], steps[to]] = [steps[to], steps[index]];
    this.doc.transact('Reorder steps', () => this.doc.update(flowId, { steps }));
  }

  renameFlow(flowId, name, merge) {
    if (this.doc.flows.has(flowId)) this.doc.transact('Rename flow', () => this.doc.update(flowId, { name }), { merge });
  }

  deleteFlow(flowId) {
    if (this.flow.id === flowId) this.showFlow(null);
    this.doc.transact('Delete flow', () => this.doc.remove([flowId]));
  }

  /**
   * While a flow plays: its links and their ends stay lit (the rest dims), like the
   * dependency focus. Returns { nodes, edges } or null.
   */
  flowFocus() {
    const f = this.flow.step >= 0 && this.doc.flows.get(this.flow.id);
    if (!f) return null;
    const key = this.doc.version + '|flow|' + f.id;
    if (this.#focusCache.key === key) return this.#focusCache.value;
    const nodes = new Set(), edges = new Set();
    for (const s of f.steps) {
      const e = this.doc.edges.get(s.edge);
      if (!e) continue;
      edges.add(e.id);
      for (const id of [e.source, e.target]) for (const n of [id, ...this.doc.ancestors(id)]) nodes.add(n);
    }
    const value = { nodes, edges };
    this.#focusCache = { key, value };
    return value;
  }

  toggleDependencies(on = !this.focusDeps) {
    this.focusDeps = on;
    this.emit('focus', on);
    this.invalidate();
  }

  /**
   * What the dependency focus keeps lit, or null when it is off or there is nothing to focus
   * on. One selected node: everything it depends on and everything depending on it. Two:
   * the paths between them. Lit nodes include their containers, so the context stays readable.
   * Returns { nodes, edges, up?, down?, found? }; cached per document version and selection.
   */
  dependencyFocus() {
    if (!this.focusDeps) return null;
    const ids = this.selectedNodeIds();
    const key = this.doc.version + '|' + ids.join(',');
    if (this.#focusCache.key === key) return this.#focusCache.value;
    let value = null;
    if (ids.length === 1) value = dependencies(this.doc, ids[0]);
    else if (ids.length === 2) value = pathsBetween(this.doc, ids[0], ids[1]);
    if (value) {
      const nodes = new Set(value.nodes);
      for (const id of value.nodes) for (const a of this.doc.ancestors(id)) nodes.add(a);
      value = { ...value, nodes };
    }
    this.#focusCache = { key, value };
    return value;
  }

  // ───────────────────────────── hit testing

  portPosition(id, side) {
    const n = this.doc.nodes.get(id);
    const p = portPoint(n, side);
    const k = sideNormal(side);
    const off = PORT_OFFSET / this.camera.zoom;
    return { x: p.x + k.x * off, y: p.y + k.y * off };
  }

  /** Where a container's collapse/expand toggle sits. */
  togglePosition(n) {
    return n.collapsed ? { x: n.x + n.w - 24, y: n.y + n.h / 2 } : { x: n.x + n.w - 24, y: n.y + 24 };
  }

  /**
   * Grips a selected edge offers. Orthogonal: one per segment (drag to shift it).
   * Straight/curved: one per waypoint (drag to move, double-click to remove) and one in the
   * middle of each leg (drag to insert a waypoint).
   */
  edgeHandles(id) {
    const e = this.doc.edges.get(id);
    const r = e && this.router.peek(id);
    if (!r || this.doc.visibleAncestor(e.source) === this.doc.visibleAncestor(e.target)) return [];
    const z = this.camera.zoom;
    const tag = this.layoutProbe?.labelRect?.(id);
    const out = [];
    const grip = (h, path) => {
      const p = this.#placeGrip(path, tag);
      if (p) out.push({ ...h, x: p.x, y: p.y });
    };
    if ((e.style?.routing ?? 'orthogonal') === 'orthogonal') {
      const p = r.points;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        if (dist(a, b) * z < 26) continue;
        grip({ kind: 'edge-seg', id, segment: i, axis: Math.abs(a.y - b.y) < 0.5 ? 'h' : 'v' }, [a, b]);
      }
      return out;
    }
    const pts = r.manual ? e.style?.points ?? [] : [];
    pts.forEach((q, index) => out.push({ kind: 'waypoint', id, index, x: q.x, y: q.y }));
    const ctrl = [r.poly[0], ...pts, r.poly[r.poly.length - 1]];
    for (let i = 0; i < ctrl.length - 1; i++) {
      if (dist(ctrl[i], ctrl[i + 1]) * z < 44) continue;
      let path = [ctrl[i], ctrl[i + 1]];
      if (r.legs && r.smooth) {
        const segs = r.legs.map((l, k) => (l === i ? k : -1)).filter((k) => k >= 0);
        path = r.poly.slice(segs[0], segs[segs.length - 1] + 2);
      } else if (r.kind === 'bezier') {
        path = r.poly;
      }
      grip({ kind: 'edge-seg', id, segment: i, insert: true }, path);
    }
    return out;
  }

  /**
   * Grip position on a path: its middle, or, if that is under the link's tag (label /
   * protocol), the nearest spot along the path just clear of it. Null if there is no room.
   */
  #placeGrip(path, tag) {
    const mid = pointAlong(path, 0.5);
    if (!tag) return mid;
    const z = this.camera.zoom;
    const clear = inflate(tag, 12 / z);
    if (!containsPoint(clear, mid)) return mid;
    const len = polylineLength(path);
    const margin = Math.min(0.45, (14 / z) / Math.max(len, 1));
    for (let d = 0.02; d <= 0.5; d += 0.02) {
      for (const t of [0.5 - d, 0.5 + d]) {
        if (t < margin || t > 1 - margin) continue;
        const p = pointAlong(path, t);
        if (!containsPoint(clear, p)) return p;
      }
    }
    return null;
  }

  /** Top-most thing under a screen point. Leaves beat edges, edges beat containers. */
  hitTest(sp) {
    const z = this.camera.zoom;
    const p = this.toWorld(sp);
    const single = this.singleSelected();
    const selNode = single && !this.editingId && !this.readOnly ? this.doc.nodes.get(single) : null;
    const singleNode = selNode && !selNode.collapsed ? selNode : null;

    if (singleNode) {
      const n = singleNode;
      const corners = [['nw', n.x, n.y], ['ne', n.x + n.w, n.y], ['se', n.x + n.w, n.y + n.h], ['sw', n.x, n.y + n.h]];
      for (const [handle, hx, hy] of corners) {
        if (Math.hypot(p.x - hx, p.y - hy) * z <= HANDLE_HIT) return { kind: 'handle', id: n.id, handle };
      }
    }
    const tab = this.#overlayAt(p, 'tab');
    if (tab) return { kind: 'node', id: tab.id };
    const under = this.nodeAt(p, { leavesOnly: true });
    if (this.portNode && this.doc.nodes.has(this.portNode) && (!under || under.id === this.portNode)) {
      for (const side of SIDES) {
        if (dist(this.portPosition(this.portNode, side), p) * z <= PORT_HIT) return { kind: 'port', id: this.portNode, side };
      }
    }
    if (singleNode) {
      const n = singleNode, t = BORDER_HIT / z;
      if (p.y > n.y + t && p.y < n.y + n.h - t) {
        if (Math.abs(p.x - n.x) <= t) return { kind: 'handle', id: n.id, handle: 'w' };
        if (Math.abs(p.x - n.x - n.w) <= t) return { kind: 'handle', id: n.id, handle: 'e' };
      }
      if (p.x > n.x + t && p.x < n.x + n.w - t) {
        if (Math.abs(p.y - n.y) <= t) return { kind: 'handle', id: n.id, handle: 'n' };
        if (Math.abs(p.y - n.y - n.h) <= t) return { kind: 'handle', id: n.id, handle: 's' };
      }
    }
    if (single && this.doc.edges.has(single) && !this.editingId && !this.readOnly) {
      const r = this.router.peek(single);
      if (r) {
        if (dist(r.points[0], p) * z <= HANDLE_HIT) return { kind: 'edge-end', id: single, end: 'source' };
        if (dist(r.points[r.points.length - 1], p) * z <= HANDLE_HIT) return { kind: 'edge-end', id: single, end: 'target' };
      }
      for (const h of this.edgeHandles(single)) if (Math.hypot(h.x - p.x, h.y - p.y) * z <= HANDLE_HIT) return h;
    }

    if (under) return { kind: 'node', id: under.id };
    const outline = this.#overlayAt(p, 'border');
    if (outline) return { kind: 'node', id: outline.id };

    const box = this.nodeAt(p);
    if (box && this.doc.isContainer(box) && !showsAsCard(this.doc, box) && dist(this.togglePosition(box), p) * z <= Math.max(11, 11 * z)) {
      return { kind: 'toggle', id: box.id };
    }

    // Labels first; then, where links run close together, the selected one (you are working
    // on it), else the nearest, else the one drawn on top (later in the list).
    const tol = EDGE_HIT / z;
    let best = null, bestD = tol, selected = null;
    for (const e of this.doc.edges.values()) {
      const r = this.router.peek(e.id);
      if (!r || !this.edgeShown(e)) continue;
      const tag = this.layoutProbe?.labelRect?.(e.id);
      if (tag) {
        if (containsPoint(tag, p)) return { kind: 'edge', id: e.id, label: true };
      } else if (e.label || e.data?.tech) {
        // No view reporting drawn tags (headless): approximate from the text length.
        const at = labelPoint(r, e.style?.labelT);
        const len = Math.max(e.label?.length ?? 0, e.data?.tech?.length ?? 0);
        const lw = (Math.min(len * 6.4, 220) + 16) / 2, lh = e.label && e.data?.tech ? 17 : 11;
        if (Math.abs(p.x - at.x) <= lw && Math.abs(p.y - at.y) <= lh) return { kind: 'edge', id: e.id, label: true };
      }
      const bb = r.bbox;
      if (p.x < bb.x - tol || p.x > bb.x + bb.w + tol || p.y < bb.y - tol || p.y > bb.y + bb.h + tol) continue;
      const d = distToPolyline(p, r.poly);
      if (e.id === single && d <= tol) selected = { e, r };
      if (d <= bestD) {
        bestD = d;
        best = { e, r };
      }
    }
    best = selected ?? best;
    if (best) {
      const { e, r } = best;
      const seg = nearestSegment(p, r.poly);
      return { kind: 'edge', id: e.id, segment: r.legs ? r.legs[seg] : r.kind === 'bezier' ? 0 : seg };
    }

    return box ? { kind: 'node', id: box.id } : null;
  }

  /**
   * Border-only boundaries are hit only on their name tab (`'tab'`, as drawn) or close to
   * their outline (`'border'`); clicks inside go through to whatever is underneath.
   */
  #overlayAt(p, part) {
    const z = this.camera.zoom, t = (BORDER_HIT + 1) / z;
    let best = null, bestI = -1;
    for (const id of this.doc.index.query(inflate({ x: p.x, y: p.y, w: 0, h: 0 }, 16 / z))) {
      const n = this.doc.nodes.get(id);
      if (!isOverlay(this.doc, n) || this.doc.hidden().has(id)) continue;
      let hit;
      if (part === 'tab') {
        const r = this.layoutProbe?.tabRect?.(id);
        hit = !!r && containsPoint(r, p);
      } else {
        hit = containsPoint(inflate(n, t), p) && !containsPoint(inflate(n, -t), p);
      }
      const i = this.doc.orderIndex(id);
      if (hit && i > bestI) { best = n; bestI = i; }
    }
    return best;
  }

  isOverlay(id) {
    return isOverlay(this.doc, id);
  }

  /** Is a link on screen: both ends (or what stands in for them) shown, and not the same? */
  edgeShown(e) {
    const hidden = this.doc.hidden();
    const s = this.doc.visibleAncestor(e.source), t = this.doc.visibleAncestor(e.target);
    return s !== t && !hidden.has(s) && !hidden.has(t);
  }

  /** Top-most visible node containing a world point. Prefers leaves over containers. */
  nodeAt(p, { exclude = null, leavesOnly = false } = {}) {
    const hidden = this.doc.hidden();
    let leaf = null, leafI = -1, box = null, boxI = -1;
    for (const id of this.doc.index.query({ x: p.x, y: p.y, w: 0, h: 0 })) {
      if (exclude?.has(id) || hidden.has(id)) continue;
      const n = this.doc.nodes.get(id);
      if (!containsPoint(n, p) || isOverlay(this.doc, n)) continue;
      const i = this.doc.orderIndex(id);
      if (this.doc.isContainer(n)) {
        if (i > boxI) { box = n; boxI = i; }
      } else if (i > leafI) {
        leaf = n;
        leafI = i;
      }
    }
    return leaf ?? (leavesOnly ? null : box);
  }

  /**
   * Deepest expanded container under a world point, ignoring `exclude` (e.g. the nodes being
   * dragged). In a view, things dropped or created outside every box go into the view's
   * module (anywhere else they would vanish from the view); context boxes don't take drops.
   */
  containerAt(p, exclude = null) {
    const hidden = this.doc.hidden();
    let best = null, bestI = -1;
    for (const id of this.doc.index.query({ x: p.x, y: p.y, w: 0, h: 0 })) {
      if (exclude?.has(id) || hidden.has(id) || this.isContext(id)) continue;
      const n = this.doc.nodes.get(id);
      if (!this.doc.isContainer(n) || n.collapsed || !containsPoint(n, p)) continue;
      const i = this.doc.orderIndex(id);
      if (i > bestI) { best = n; bestI = i; }
    }
    const root = this.viewRoot;
    return best ?? (root != null && !exclude?.has(root) ? this.doc.nodes.get(root) : null);
  }

  // ───────────────────────────── input

  #track(e) {
    this.pointer.x = e.x;
    this.pointer.y = e.y;
    this.pointer.inside = true;
    this.pointer.world = this.toWorld(e);
  }

  pointerDown(e) {
    this.#track(e);
    if (this.gesture) return;
    if (this.editingId) this.emit('commit-edit');
    if (e.button === 1 || e.button === 2 || this.keys.space || this.tool === 'hand') {
      this.#begin(new PanGesture(this, e));
      return;
    }
    if (e.button !== 0) return;
    const hit = this.hitTest(e);
    this.press = { e, hit, world: this.toWorld(e), wasSelected: !!hit && this.selection.has(hit.id) };
    if (hit && (hit.kind === 'node' || hit.kind === 'edge')) {
      if (this.flow.recording && hit.kind === 'edge') {
        // Recording a flow: the click adds a step (on release) rather than selecting.
      } else if (e.shift) {
        if (!this.selection.has(hit.id)) this.setSelection([...this.selection, hit.id]);
      } else if (!this.selection.has(hit.id)) {
        this.setSelection([hit.id]);
      }
    } else if (!hit && !e.shift) {
      this.setSelection([]);
    }
  }

  pointerMove(e) {
    this.#track(e);
    if (this.gesture) {
      this.gesture.move(e);
      return;
    }
    const pr = this.press;
    if (pr) {
      const threshold = (pr.hit?.kind === 'edge' ? EDGE_DRAG_THRESHOLD : DRAG_THRESHOLD) + (e.pointerType === 'touch' ? 4 : 0);
      if (Math.hypot(e.x - pr.e.x, e.y - pr.e.y) < threshold) return;
      const g = this.#gestureFor(pr);
      if (g) {
        this.#begin(g);
        g.move(e);
      } else {
        this.press = null;
      }
      return;
    }
    this.#updateHover(e);
  }

  pointerUp(e) {
    this.#track(e);
    if (this.gesture) {
      const g = this.gesture;
      this.gesture = null;
      g.up(e);
      this.#gestureEnded();
      this.#updateHover(e);
      return;
    }
    const pr = this.press;
    this.press = null;
    const hit = pr?.hit;
    if (!hit) return;
    if (this.flow.recording && hit.kind === 'edge') {
      this.addFlowStep(hit.id);
      return;
    }
    if (this.readOnly && hit.kind === 'port') return;
    if (hit.kind === 'port') {
      this.quickAdd(hit.id, hit.side);
    } else if (hit.kind === 'toggle') {
      this.toggleCollapse([hit.id]);
    } else if ((hit.kind === 'node' || hit.kind === 'edge') && pr.wasSelected) {
      if (e.shift) this.setSelection([...this.selection].filter((id) => id !== hit.id));
      else if (this.selection.size > 1) this.setSelection([hit.id]);
    }
  }

  pointerLeave() {
    this.pointer.inside = false;
    if (this.gesture) return;
    if (this.hover || this.portNode) {
      this.hover = null;
      this.portNode = null;
      this.emit('hover', null);
      this.invalidate();
    }
  }

  doubleClick(e) {
    const hit = this.hitTest(e);
    const w = this.toWorld(e);
    if (this.readOnly) {
      // Viewing: double-click zooms to what's under the pointer (or everything).
      const n = hit && this.doc.nodes.get(hit.id);
      if (n) this.zoomToRect(inflate(n, 80), { maxZoom: 1.5 });
      else this.fitView();
      return;
    }
    if (!hit) {
      this.createNode(this.schema.defaultNodeType, w, { edit: true });
    } else if (hit.kind === 'handle' && this.canFitToContent([hit.id])) {
      this.fitToContent([hit.id]);
    } else if (hit.kind === 'node' && this.#onCaption(hit.id, w)) {
      this.editLabel(hit.id, 'stereotype');
    } else if (hit.kind === 'waypoint') {
      this.removeWaypoint(hit.id, hit.index);
    } else if (hit.kind === 'edge' && this.#onCaption(hit.id, w)) {
      this.editLabel(hit.id, 'tech');
    } else if (hit.kind === 'edge' || hit.kind === 'edge-seg') {
      this.editLabel(hit.id);
    } else if (hit.kind === 'node') {
      const n = this.doc.nodes.get(hit.id);
      if (n.collapsed) {
        this.toggleCollapse([n.id]);
      } else if (this.doc.isContainer(n) && !showsAsCard(this.doc, n) && w.y > n.y + this.settings.containerHeader) {
        this.createNode(this.schema.defaultNodeType, w, { edit: true, parent: n.id });
      } else {
        this.editLabel(n.id);
      }
    }
  }

  /** Mouse wheels zoom, trackpads pan, pinch (ctrl+wheel) zooms. Shift+wheel pans sideways. */
  wheel(e) {
    let { dx, dy } = e;
    if (e.mod) {
      this.camera.zoomAt(e, Math.exp(-dy * 0.01));
    } else if ((e.deltaMode === 1 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy))) && !e.shift) {
      this.camera.zoomAt(e, Math.exp(-Math.sign(dy) * Math.min(Math.abs(dy), 150) * 0.0018));
    } else {
      if (e.shift && dx === 0) [dx, dy] = [dy, 0];
      this.camera.panBy(-dx, -dy);
    }
    if (!this.gesture) this.#updateHover(e);
    else this.gesture.move({ ...e, ...this.pointer });
  }

  keyDown(e) {
    if (e.key === ' ') {
      if (!this.keys.space) {
        this.keys.space = true;
        this.setCursor(this.#cursorFor(this.hover));
      }
      return true;
    }
    if (this.gesture) {
      if (e.key === 'Escape') this.cancelGesture();
      else this.gesture.keys?.(e);
      return true;
    }
    // Playing a flow: arrows (and a presenter's page keys) step through it.
    if (this.flow.step >= 0 && !e.mod && !e.alt && !e.shift) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { this.stepFlow(1); return true; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { this.stepFlow(-1); return true; }
    }
    const combo = comboOf(e);
    const cmd = this.keymap.get(combo);
    if (!cmd || !this.allowed(cmd)) return false;
    if (cmd.enabled && !cmd.enabled()) return combo.startsWith('mod+') || combo === 'tab';
    cmd.run();
    return true;
  }

  keyUp(e) {
    this.gesture?.keys?.(e);
    if (e.key === ' ') {
      this.keys.space = false;
      this.setCursor(this.#cursorFor(this.hover));
    }
  }

  cancelGesture() {
    this.press = null;
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    g.cancel();
    this.#gestureEnded();
  }

  /** Undo the history entry produced by an aborted gesture, without leaving a redo step. */
  revertGesture(key) {
    const top = this.history.undoStack.at(-1);
    if (!top || top.merge !== key) return;
    this.doc.applyPatch(top.ops, { inverse: true, source: 'cancel', animate: true });
    this.history.discardTop();
  }

  openContextMenu(e) {
    const hit = this.hitTest(e);
    if (hit && (hit.kind === 'node' || hit.kind === 'edge') && !this.selection.has(hit.id)) this.setSelection([hit.id]);
    if (!hit) this.setSelection([]);
    this.emit('contextmenu', { x: e.x, y: e.y, world: this.toWorld(e), hit });
  }

  /** A gesture is over: catch up on work deferred while it ran, then tell the views. */
  #gestureEnded() {
    if (this.#legendsPending) this.#fitLegends({ reset: true });
    this.emit('gesture', false);
  }

  #begin(g) {
    this.gesture = g;
    this.press = null;
    this.hover = null;
    this.portNode = null;
    this.emit('gesture', true);
    this.setCursor(g.cursor);
    this.invalidate();
  }

  #gestureFor(pr) {
    // Viewing: any drag pans, except a marquee from empty canvas (selecting is harmless).
    if (this.readOnly && pr.hit && pr.hit.kind !== 'toggle') return new PanGesture(this, pr.e);
    switch (pr.hit?.kind) {
      case 'handle': return new ResizeGesture(this, pr);
      case 'port': return new ConnectGesture(this, pr);
      case 'edge-end': return new ReconnectGesture(this, pr);
      case 'node': return new DragGesture(this, pr);
      case 'toggle': return null;
      case 'waypoint': return new WaypointGesture(this, pr);
      case 'edge-seg':
      case 'edge': {
        if (pr.hit.label) return new LabelGesture(this, pr);
        const e = this.doc.edges.get(pr.hit.id);
        if (this.doc.visibleAncestor(e.source) === this.doc.visibleAncestor(e.target)) return null;
        return (e.style?.routing ?? 'orthogonal') === 'orthogonal' ? new SegmentGesture(this, pr) : new WaypointGesture(this, pr);
      }
      default: return new MarqueeGesture(this, pr);
    }
  }

  #updateHover(e) {
    const hit = this.pointer.inside ? this.hitTest(e) : null;
    const z = this.camera.zoom;
    let portNode = null;
    if (!this.editingId && !this.readOnly && z >= 0.3 && this.tool === 'select' && !this.keys.space && hit?.kind !== 'edge-end') {
      const cur = this.portNode && this.doc.nodes.get(this.portNode);
      const sticky = cur && containsPoint(inflate(cur, HOVER_STICKY / z), this.toWorld(e)) &&
        (!hit || hit.kind === 'edge' || hit.id === cur.id || (hit.kind === 'node' && this.doc.isAncestor(hit.id, cur.id)));
      if (sticky) portNode = cur.id;
      else if (hit && ['node', 'port', 'handle', 'toggle'].includes(hit.kind) && !isOverlay(this.doc, hit.id) &&
        !this.schema.nodeTypes[this.doc.nodes.get(hit.id)?.type]?.noPorts) portNode = hit.id;
    }
    const changed = portNode !== this.portNode || !sameHit(hit, this.hover);
    this.hover = hit;
    this.portNode = portNode;
    this.setCursor(this.#cursorFor(hit));
    if (changed) {
      this.emit('hover', hit);
      this.invalidate();
    }
  }

  #cursorFor(hit) {
    if (this.gesture) return this.gesture.cursor;
    if (this.keys.space || this.tool === 'hand') return 'grab';
    if (this.readOnly) return hit?.kind === 'node' || hit?.kind === 'edge' || hit?.kind === 'toggle' ? 'pointer' : 'grab';
    if (!hit) return 'default';
    if (hit.kind === 'handle') return cursorForHandle(hit.handle);
    if (hit.kind === 'port' || hit.kind === 'edge-end') return 'crosshair';
    if (hit.kind === 'toggle') return 'pointer';
    if (hit.kind === 'waypoint' || (hit.kind === 'edge' && hit.label)) return 'move';
    if (hit.kind === 'edge-seg') return hit.insert ? 'copy' : hit.axis === 'h' ? 'ns-resize' : 'ew-resize';
    if (hit.kind === 'edge') return 'pointer';
    return 'default';
  }

  // ───────────────────────────── label editing

  /** Start in-place editing of a node's name (`label`) or its type label (`stereotype`). */
  editLabel(id, field = 'label') {
    if (!id || !this.doc.has(id) || this.readOnly) return;
    if (field === 'stereotype' && !this.doc.nodes.has(id)) field = this.doc.edges.has(id) ? 'tech' : 'label';
    if (field === 'tech' && !this.doc.edges.has(id)) field = 'label';
    this.editingId = id;
    this.editingField = field;
    this.portNode = null;
    this.emit('edit-label', { id, field });
    this.invalidate();
  }

  commitLabel(id, text, field = 'label') {
    if (!this.doc.has(id)) return;
    if (field === 'stereotype') this.setStereotype([id], text);
    else if (field === 'tech') this.setProtocol(id, text);
    else if (this.isText(id)) this.setText(id, text);
    else this.doc.transact('Rename', () => this.doc.update(id, { label: text }));
  }

  isText(id) {
    return this.schema.nodeTypes[this.doc.nodes.get(id)?.type]?.shape === 'text';
  }

  /** Set free text and resize it to fit; emptied text is removed. */
  setText(id, text, merge) {
    if (!text.trim()) {
      this.doc.transact('Delete text', () => this.doc.remove([id]), { merge });
      return;
    }
    this.doc.transact('Edit text', () => {
      this.doc.update(id, { label: text });
      this.fitText(id);
    }, { merge });
  }

  /** Resize free text to its content (as measured by the view; no-op headless). */
  fitText(id) {
    const n = this.doc.nodes.get(id);
    const size = n && this.layoutProbe?.measureText?.(n);
    if (size) this.doc.update(id, size);
  }

  /** Text size / alignment / colour; the box refits to the new metrics. */
  setTextStyle(ids, patch) {
    this.doc.transact('Text style', () => {
      this.setStyle(ids, patch);
      for (const id of ids) if (this.isText(id)) this.fitText(id);
    });
  }

  /**
   * Set the type label shown under the name instead of the type ("Frontend" rather than
   * "Component"). An empty value goes back to the type's own name.
   */
  setStereotype(ids, text, merge) {
    const value = (text ?? '').trim();
    this.doc.transact('Type label', () => {
      for (const id of ids) {
        const n = this.doc.nodes.get(id);
        if (!n) continue;
        const data = { ...n.data };
        if (value) data.stereotype = value;
        else delete data.stereotype;
        this.doc.update(id, { data });
      }
    }, { merge });
  }

  /** A link's protocol (shown under its label); empty removes it. */
  setProtocol(id, text, merge) {
    const e = this.doc.edges.get(id);
    if (!e) return;
    const data = { ...e.data };
    const value = (text ?? '').trim();
    if (value) data.tech = value;
    else delete data.tech;
    this.doc.transact('Protocol', () => this.doc.update(id, { data }), { merge });
  }

  /** Type labels already used in the diagram, most frequent first (for suggestions). */
  stereotypes() {
    const counts = new Map();
    for (const n of this.doc.nodes.values()) {
      const s = n.data?.stereotype;
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
  }

  endEdit() {
    if (!this.editingId) return;
    this.editingId = null;
    this.emit('edit-end');
    this.invalidate();
  }

  #onCaption(id, p) {
    const r = this.layoutProbe?.captionRect(id);
    return !!r && containsPoint(inflate(r, 2 / this.camera.zoom), p);
  }

  // ───────────────────────────── creation

  /** Where keyboard-created things go: under the pointer if it's on the canvas, else view center. */
  insertionPoint() {
    if (this.pointer.inside) return { ...this.pointer.world };
    return center(this.visibleRect());
  }

  createNode(type, at, { edit = false, parent, label, select = true } = {}) {
    const t = this.schema.nodeTypes[type];
    if (!t) return null;
    const g = this.settings.snapToGrid ? this.settings.grid : 0;
    const rect = { x: snap(at.x - t.w / 2, g), y: snap(at.y - t.h / 2, g), w: t.w, h: t.h };
    const parentId = parent !== undefined ? parent : this.containerAt(at)?.id ?? null;
    const intoCard = parentId != null && showsAsCard(this.doc, parentId);
    const onLink = t.inline ? this.edgeAt(at) : null;
    let node;
    this.doc.transact(`Add ${t.label}`, () => {
      node = this.doc.addNode({ type, ...rect, parent: parentId, label: label ?? t.label });
      if (t.shape === 'text') this.fitText(node.id);
      if (intoCard) this.adoptIntoHost(parentId, [node.id]);
      if (onLink) this.insertIntoEdge(node.id, onLink.id, at);
      this.fitContainers([node.id]);
    });
    if (select) {
      this.setSelection([node.id]);
      if (edit) this.editLabel(node.id);
    }
    return node;
  }

  /** The link drawn under a world point (as displayed), ignoring links touching `exclude`. */
  edgeAt(p, exclude = null) {
    const tol = 10 / this.camera.zoom;
    let best = null, bestD = tol;
    for (const e of this.doc.edges.values()) {
      if (exclude?.has(e.source) || exclude?.has(e.target) || !this.edgeShown(e)) continue;
      if (this.doc.visibleAncestor(e.source) !== e.source || this.doc.visibleAncestor(e.target) !== e.target) continue;
      const r = this.router.peek(e.id);
      if (!r || !containsPoint(inflate(r.bbox, tol), p)) continue;
      const d = distToPolyline(p, r.poly);
      if (d <= bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * Put a node in the path of a link (e.g. a firewall dropped onto A → B): it is centred on
   * the line and the link becomes A → node → B. The first half keeps the label; both keep
   * the type and protocol. Hand-made shapes are dropped since the geometry changed.
   */
  insertIntoEdge(nodeId, edgeId, at) {
    const e = this.doc.edges.get(edgeId);
    const n = this.doc.nodes.get(nodeId);
    const r = this.router.peek(edgeId) ?? this.router.get(edgeId);
    if (!e || !n || !r || e.source === nodeId || e.target === nodeId) return;
    const p = pointAlong(r.poly, projectOnPolyline(at ?? center(n), r.poly).t);
    const target = e.target;
    const style = withoutKeys(e.style, ['points', 'labelT']);
    this.doc.transact('Insert into link', () => {
      this.moveNodes([nodeId], p.x - (n.x + n.w / 2), p.y - (n.y + n.h / 2));
      this.doc.update(edgeId, { target: nodeId, style });
      this.doc.addEdge({ type: e.type, source: nodeId, target, data: { ...e.data }, style });
      this.fitContainers([nodeId]);
    });
  }

  connect(sourceId, targetId, { type = this.#linkType(sourceId, targetId) } = {}) {
    let edge;
    this.doc.transact('Connect', () => {
      edge = this.doc.addEdge({ type, source: sourceId, target: targetId });
    });
    return edge;
  }

  #linkType(a, b) {
    const t = (id) => this.schema.nodeTypes[this.doc.nodes.get(id)?.type];
    return t(a)?.linkType ?? t(b)?.linkType ?? this.schema.defaultEdgeType;
  }

  /** What a "grow" from `src` creates: its own type, or the type's `spawn` (e.g. a network spawns components). */
  #spawnType(src) {
    const t = this.schema.nodeTypes[src.type];
    if (t?.spawn) return t.spawn;
    return this.doc.isContainer(src) || isOverlay(this.doc, src) ? this.schema.defaultNodeType : src.type;
  }

  /** Create a node at a point, linked from `sourceId` (drop of a connection on empty canvas). */
  createLinkedNode(sourceId, at) {
    const src = this.doc.nodes.get(sourceId);
    if (!src) return null;
    const type = this.#spawnType(src);
    let node;
    this.doc.transact('Add connected node', () => {
      node = this.createNode(type, at, { select: false });
      this.connect(sourceId, node.id);
    });
    this.setSelection([node.id]);
    this.editLabel(node.id);
    return node;
  }

  /** One-click "grow": add a node of the same kind next to `sourceId`, linked, in a free spot. */
  quickAdd(sourceId, side = this.settings.layoutDirection === 'TB' ? 'bottom' : 'right') {
    const src = this.doc.nodes.get(sourceId);
    if (!src) return null;
    const type = this.#spawnType(src);
    const t = this.schema.nodeTypes[type];
    const g = this.settings.snapToGrid ? this.settings.grid : 1;
    const gap = 80;
    const k = sideNormal(side);
    const c = center(src);
    const cx = c.x + k.x * (src.w / 2 + gap + t.w / 2);
    const cy = c.y + k.y * (src.h / 2 + gap + t.h / 2);
    const perp = { x: Math.abs(k.y), y: Math.abs(k.x) };
    const step = (perp.x ? t.w : t.h) + 40;
    const parent = src.parent ?? null;
    let rect;
    for (let i = 0; i < 24; i++) {
      const off = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 ? 1 : -1) * step;
      rect = { x: snap(cx + perp.x * off - t.w / 2, g), y: snap(cy + perp.y * off - t.h / 2, g), w: t.w, h: t.h };
      if (!this.#occupied(rect, parent)) break;
    }
    let node;
    this.doc.transact('Add connected node', () => {
      node = this.doc.addNode({ type, ...rect, parent, label: t.label });
      this.connect(sourceId, node.id);
      this.fitContainers([node.id]);
    });
    this.setSelection([node.id]);
    this.ensureVisible(rect);
    this.editLabel(node.id);
    return node;
  }

  #occupied(rect, parent) {
    const probe = inflate(rect, 16);
    const hidden = this.doc.hidden();
    return this.doc.index.query(probe).some((id) => {
      if (id === parent || hidden.has(id) || this.doc.isAncestor(id, parent)) return false;
      return overlaps(probe, this.doc.nodes.get(id));
    });
  }

  // ───────────────────────────── editing actions

  undo() { this.history.undo(); }
  redo() { this.history.redo(); }

  deleteSelection() {
    if (!this.selection.size) return;
    this.doc.transact('Delete', () => this.doc.remove([...this.selection]));
  }

  /** Grow ancestor containers so they enclose their children (never shrinks). */
  fitContainers(ids) {
    const { containerPadding: pad, containerHeader: head } = this.settings;
    const seen = new Set();
    for (const id of ids) {
      let p = this.doc.nodes.get(id)?.parent;
      while (p != null && !seen.has(p)) {
        seen.add(p);
        const c = this.doc.nodes.get(p);
        if (!c) break;
        const kids = this.doc.children(p);
        if (kids.length && !c.collapsed) {
          const b = boundsOf(kids);
          const r = union(c, { x: b.x - pad, y: b.y - head, w: b.w + pad * 2, h: b.h + head + pad });
          if (!rectEquals(r, c)) this.doc.update(p, { x: r.x, y: r.y, w: r.w, h: r.h });
        }
        p = c.parent;
      }
    }
  }

  /** Move nodes (with descendants) and the hand-made routes of edges that move along entirely. */
  moveNodes(ids, dx, dy) {
    if (!dx && !dy) return;
    const moved = new Set();
    for (const id of ids) {
      moved.add(id);
      for (const d of this.doc.descendants(id)) moved.add(d);
    }
    this.doc.transact('Move', () => {
      this.doc.moveBy(ids, dx, dy);
      for (const e of this.doc.edges.values()) {
        if (e.style?.points && moved.has(e.source) && moved.has(e.target)) {
          this.doc.update(e.id, { style: { ...e.style, points: e.style.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } });
        }
      }
    });
  }

  /**
   * Collapse or expand modules. Collapsed modules shrink to a card, hide their contents and
   * stand in for them as link endpoints. `collapse` forces a direction, otherwise each toggles.
   */
  toggleCollapse(ids = this.selectedNodeIds(), collapse) {
    const boxes = ids.map((id) => this.doc.nodes.get(id)).filter((n) => n && this.doc.isContainer(n) && !showsAsCard(this.doc, n));
    if (!boxes.length) return;
    const expanding = [];
    const label = boxes.every((n) => (collapse ?? !n.collapsed)) ? 'Collapse' : 'Expand';
    this.doc.transact(label, () => {
      for (const n of boxes) {
        const target = collapse ?? !n.collapsed;
        if (target === !!n.collapsed) continue;
        const old = { x: n.x, y: n.y, w: n.w, h: n.h };
        if (target) {
          this.doc.update(n.id, { collapsed: true, expanded: { w: n.w, h: n.h }, w: Math.round(Math.min(Math.max(n.w, 200), 260)), h: 76 });
        } else {
          const ex = n.expanded ?? this.schema.nodeTypes[n.type];
          this.doc.update(n.id, { collapsed: false, expanded: null, w: ex.w, h: ex.h });
          expanding.push(n.id);
        }
        this.#accordion(n, old);
      }
      this.fitContainers(expanding);
    }, { animate: true });
    this.setSelection([...this.selection]);
  }

  /** Containers among `ids` (and inside them) that hold visible content and can be fitted to it. */
  #fittable(ids) {
    const out = new Set();
    for (const id of ids) {
      for (const c of [id, ...this.doc.descendants(id)]) {
        const n = this.doc.nodes.get(c);
        if (n && this.doc.isContainer(n) && !n.collapsed && this.doc.hasChildren(c)) out.add(c);
      }
    }
    return out;
  }

  canFitToContent(ids = this.selectedNodeIds()) {
    return this.#fittable(ids).size > 0 || ids.some((id) => this.#isBus(id) && busMembers(this.doc, id).length) ||
      ids.some((id) => isOverlay(this.doc, id) && this.surrounded(id).length);
  }

  #isBus(id) {
    return this.schema.nodeTypes[this.doc.nodes.get(id)?.type]?.shape === 'bus';
  }

  /** Visible top-level nodes lying fully inside a border-only outline. */
  surrounded(id) {
    const o = this.doc.nodes.get(id);
    if (!o) return [];
    const hidden = this.doc.hidden();
    const inside = this.doc.index.query(o).filter((n) => n !== id && !hidden.has(n) && !isOverlay(this.doc, n) &&
      containsRect(o, this.doc.nodes.get(n)));
    return this.topLevel(inside).map((n) => this.doc.nodes.get(n));
  }

  /** Outline geometry around a set of nodes (border-only boundary). */
  #outlineRect(nodes) {
    const b = boundsOf(nodes);
    return { x: b.x - 24, y: b.y - 36, w: b.w + 48, h: b.h + 60 };
  }

  /**
   * Resize containers to wrap their contents with the standard padding: no wasted space.
   * Containers nested inside are tightened first (deepest first), so the result is snug at
   * every level. Ancestors still grow if needed; they are never shrunk implicitly.
   */
  fitToContent(ids = this.selectedNodeIds()) {
    const targets = [...this.#fittable(ids)].sort((a, b) => this.doc.depth(b) - this.doc.depth(a));
    const buses = ids.filter((id) => this.#isBus(id));
    const outlines = ids.filter((id) => isOverlay(this.doc, id));
    if (!targets.length && !buses.length && !outlines.length) return;
    const { containerPadding: pad, containerHeader: head } = this.settings;
    this.doc.transact('Fit to content', () => {
      for (const id of targets) {
        const b = boundsOf(this.doc.children(id));
        this.doc.update(id, { x: b.x - pad, y: b.y - head, w: Math.max(b.w + pad * 2, 160), h: b.h + head + pad });
      }
      // A bus stretches along its axis to span its members, so every drop is straight.
      for (const id of buses) {
        const bus = this.doc.nodes.get(id);
        const members = busMembers(this.doc, id);
        if (!members.length) continue;
        const b = boundsOf(members);
        if (bus.w >= bus.h) this.doc.update(id, { x: b.x - 24, w: Math.max(b.w + 48, 160) });
        else this.doc.update(id, { y: b.y - 24, h: Math.max(b.h + 48, 160) });
      }
      for (const id of outlines) {
        const inside = this.surrounded(id);
        if (inside.length) this.doc.update(id, this.#outlineRect(inside));
      }
      this.fitContainers([...targets, ...buses, ...outlines]);
    }, { animate: true });
  }

  /** Is this hosting container (server, VM...) still drawn and handled as a plain card? */
  showsAsCard(id) {
    return showsAsCard(this.doc, id);
  }

  /**
   * Nodes just put into a host that was still a card: line them up inside its content area
   * and let it grow into a box, shifting neighbours to make room.
   */
  adoptIntoHost(hostId, ids) {
    const host = this.doc.nodes.get(hostId);
    const b = this.doc.bounds(ids);
    if (!host || !b) return;
    const { containerPadding: pad, containerHeader: head } = this.settings;
    const old = { x: host.x, y: host.y, w: host.w, h: host.h };
    this.doc.transact('Move into', () => {
      this.moveNodes(ids, host.x + pad - b.x, host.y + head - b.y);
      this.fitContainers(ids);
      this.#accordion(host, old);
    });
  }

  /**
   * After a module changes size (collapse/expand), shift the siblings that sit entirely to
   * its right or below it by the same amount, so expanding never lands on top of neighbours
   * and collapsing closes the gap.
   */
  #accordion(n, old) {
    const dw = n.w - old.w, dh = n.h - old.h;
    if (!dw && !dh) return;
    const right = old.x + old.w, bottom = old.y + old.h;
    for (const s of this.doc.children(n.parent ?? null)) {
      if (s.id === n.id) continue;
      const dx = s.x >= right - 1 ? dw : 0;
      const dy = s.y >= bottom - 1 && s.x < right && s.x + s.w > old.x ? dh : 0;
      if (dx || dy) this.moveNodes([s.id], dx, dy);
    }
  }

  /**
   * Switch a boundary between containing its elements and being an outline only. Becoming
   * border-only releases its contents to its parent (they stay where they are).
   */
  setBorderOnly(ids, on) {
    this.doc.transact(on ? 'Border only' : 'Contain elements', () => {
      for (const id of ids) {
        const n = this.doc.nodes.get(id);
        if (!n || !this.schema.nodeTypes[n.type]?.boundary) continue;
        if (on) for (const kid of this.doc.children(id)) this.doc.update(kid.id, { parent: n.parent ?? null });
        const data = { ...n.data };
        if (on) data.borderOnly = true;
        else delete data.borderOnly;
        this.doc.update(id, { data, ...(on && n.collapsed ? { collapsed: false } : {}) });
      }
    });
  }

  /**
   * Draw a border-only boundary around the selection, wherever its elements live (e.g. two
   * components in different modules that share an isolated network). Nothing is re-parented.
   */
  outlineSelection(variant) {
    const nodes = this.topLevel(this.selectedNodeIds()).map((id) => this.doc.nodes.get(id));
    const type = Object.keys(this.schema.nodeTypes).find((k) => this.schema.nodeTypes[k].boundary);
    if (!nodes.length || !type) return;
    let box;
    this.doc.transact('Outline', () => {
      const data = { variant, borderOnly: true };
      box = this.doc.addNode({ type, parent: null, data, label: resolveType(this.schema, { type, data }).label, ...this.#outlineRect(nodes) });
    }, { animate: true });
    this.setSelection([box.id]);
    this.editLabel(box.id);
  }

  /** Forget hand-made routes and label positions: back to automatic routing. */
  resetRoute(ids = this.selectedEdgeIds()) {
    this.doc.transact('Reset route', () => {
      for (const id of ids) {
        const e = this.doc.edges.get(id);
        if (e) this.doc.update(id, { style: withoutKeys(e.style, ['points', 'labelT']) });
      }
    });
  }

  removeWaypoint(id, index) {
    const e = this.doc.edges.get(id);
    const pts = e?.style?.points;
    if (!pts) return;
    const next = pts.filter((_, i) => i !== index);
    this.doc.transact('Remove waypoint', () => this.doc.update(id, {
      style: next.length ? { ...e.style, points: next } : withoutKeys(e.style, ['points']),
    }));
  }

  /** Wrap the selection in a new container (a module by default, or e.g. a boundary). */
  group(type = this.schema.groupType, data = {}) {
    const ids = this.topLevel(this.selectedNodeIds());
    if (!ids.length) return;
    const { containerPadding: pad, containerHeader: head } = this.settings;
    const parents = new Set(ids.map((id) => this.doc.nodes.get(id).parent ?? null));
    const parent = parents.size === 1 ? [...parents][0] : null;
    const b = this.doc.bounds(ids);
    let box;
    this.doc.transact('Group', () => {
      box = this.doc.addNode({
        type, parent, data, label: resolveType(this.schema, { type, data }).label,
        x: b.x - pad, y: b.y - head, w: b.w + pad * 2, h: b.h + head + pad,
      });
      for (const id of ids) this.doc.update(id, { parent: box.id });
      this.fitContainers([box.id]);
    }, { animate: true });
    this.setSelection([box.id]);
    this.editLabel(box.id);
  }

  ungroup() {
    const boxes = this.selectedNodeIds().filter((id) => this.doc.isContainer(id));
    if (!boxes.length) return;
    const freed = [];
    this.doc.transact('Ungroup', () => {
      for (const id of boxes) {
        const c = this.doc.nodes.get(id);
        if (!c) continue;
        for (const kid of this.doc.children(id)) {
          this.doc.update(kid.id, { parent: c.parent ?? null });
          freed.push(kid.id);
        }
        this.doc.remove([id]);
      }
    });
    this.setSelection(freed);
  }

  /** Serializable copy of nodes (with descendants) and the edges among them. */
  snapshot(ids) {
    const top = this.topLevel(ids.filter((id) => this.doc.nodes.has(id)));
    const all = new Set();
    for (const id of top) {
      all.add(id);
      for (const d of this.doc.descendants(id)) all.add(d);
    }
    return {
      format: 'archie-clip',
      nodes: this.doc.order().filter((id) => all.has(id)).map((id) => structuredClone(this.doc.nodes.get(id))),
      edges: [...this.doc.edges.values()].filter((e) => all.has(e.source) && all.has(e.target)).map((e) => structuredClone(e)),
    };
  }

  /** Insert a snapshot with fresh ids, offset by (dx, dy). Returns the new top-level ids. */
  insertSnapshot(snap, dx, dy, parentFor = (n) => n.parent) {
    const map = new Map(snap.nodes.map((n) => [n.id, uid('n')]));
    const top = [];
    this.doc.transact('Paste', () => {
      for (const n of snap.nodes) {
        let parent = map.get(n.parent);
        if (parent === undefined) {
          parent = parentFor(n) ?? null;
          if (parent !== null && !this.doc.nodes.has(parent)) parent = null;
          top.push(map.get(n.id));
        }
        this.doc.addNode({ ...n, id: map.get(n.id), x: n.x + dx, y: n.y + dy, parent, z: undefined });
      }
      for (const e of snap.edges) {
        if (map.has(e.source) && map.has(e.target)) {
          const style = e.style?.points ? { ...e.style, points: e.style.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : e.style;
          this.doc.addEdge({ ...e, style, id: uid('e'), source: map.get(e.source), target: map.get(e.target) });
        }
      }
      this.fitContainers(top);
    });
    return top;
  }

  /**
   * Add a model without positions (e.g. imported from Mermaid) to the diagram: it is laid
   * out on its own, then inserted centred on `at` as one undoable step, and selected.
   */
  importModel(model, { at = this.insertionPoint(), direction = this.settings.layoutDirection } = {}) {
    const scratch = new DiagramDocument(this.schema);
    scratch.load(model);
    const rects = layoutHierarchy(scratch, { direction, padding: this.settings.containerPadding, header: this.settings.containerHeader });
    scratch.transact('Layout', () => { for (const [id, r] of rects) scratch.update(id, r); }, { history: false });
    const clip = { format: 'archie-clip', ...scratch.toJSON() };
    const b = scratch.bounds();
    if (!b) return [];
    const g = this.settings.snapToGrid ? this.settings.grid : 1;
    const into = this.containerAt(at)?.id ?? null;
    const top = this.insertSnapshot(clip, snap(at.x - b.w / 2, g) - b.x, snap(at.y - b.h / 2, g) - b.y, () => into);
    this.setSelection(top);
    this.zoomToRect(inflate(this.selectionBounds(), 60), { maxZoom: Math.max(this.camera.zoom, 1) });
    return top;
  }

  duplicate() {
    const ids = this.selectedNodeIds();
    if (!ids.length) return;
    const off = this.settings.grid * 2;
    const top = this.insertSnapshot(this.snapshot(ids), off, off);
    this.setSelection(top);
  }

  copy() {
    const ids = this.selectedNodeIds();
    if (!ids.length) return null;
    this.clipboard = this.snapshot(ids);
    this.#pasteCount = 0;
    this.#copyPoint = { ...this.pointer.world };
    return this.clipboard;
  }

  cut() {
    const clip = this.copy();
    if (clip) this.deleteSelection();
    return clip;
  }

  /** Paste under the pointer if it moved since copying, else cascade-offset from the originals. */
  paste(clip = this.clipboard) {
    if (!clip?.nodes?.length) return;
    const ids = new Set(clip.nodes.map((n) => n.id));
    const tops = clip.nodes.filter((n) => !ids.has(n.parent));
    const b = boundsOf(tops);
    let dx, dy, parentFor;
    const at = this.pointer.world;
    if (this.pointer.inside && (!this.#copyPoint || dist(at, this.#copyPoint) > 40 / this.camera.zoom)) {
      const g = this.settings.snapToGrid ? this.settings.grid : 1;
      dx = snap(at.x - b.w / 2, g) - b.x;
      dy = snap(at.y - b.h / 2, g) - b.y;
      const box = this.containerAt(at);
      parentFor = () => box?.id ?? null;
    } else {
      this.#pasteCount++;
      dx = dy = this.settings.grid * 2 * this.#pasteCount;
      parentFor = (n) => n.parent;
    }
    this.setSelection(this.insertSnapshot(clip, dx, dy, parentFor));
  }

  nudge(dx, dy) {
    const ids = this.topLevel(this.selectedNodeIds());
    if (!ids.length) {
      this.camera.panBy(-dx * 2, -dy * 2);
      return;
    }
    this.doc.transact('Nudge', () => {
      this.moveNodes(ids, dx, dy);
      this.fitContainers(ids);
    }, { merge: 'nudge:' + ids.join(',') });
  }

  align(mode) {
    const ids = this.topLevel(this.selectedNodeIds());
    if (ids.length < 2) return;
    const b = this.doc.bounds(ids);
    this.doc.transact('Align', () => {
      for (const id of ids) {
        const n = this.doc.nodes.get(id);
        let dx = 0, dy = 0;
        if (mode === 'left') dx = b.x - n.x;
        if (mode === 'hcenter') dx = b.x + b.w / 2 - (n.x + n.w / 2);
        if (mode === 'right') dx = b.x + b.w - (n.x + n.w);
        if (mode === 'top') dy = b.y - n.y;
        if (mode === 'vcenter') dy = b.y + b.h / 2 - (n.y + n.h / 2);
        if (mode === 'bottom') dy = b.y + b.h - (n.y + n.h);
        this.moveNodes([id], dx, dy);
      }
      this.fitContainers(ids);
    }, { animate: true });
  }

  distribute(axis) {
    const ids = this.topLevel(this.selectedNodeIds());
    if (ids.length < 3) return;
    const P = axis === 'x' ? 'x' : 'y', S = axis === 'x' ? 'w' : 'h';
    const nodes = ids.map((id) => this.doc.nodes.get(id)).sort((a, b) => a[P] + a[S] / 2 - (b[P] + b[S] / 2));
    const first = nodes[0], last = nodes[nodes.length - 1];
    const span = last[P] + last[S] - first[P];
    const gap = (span - nodes.reduce((s, n) => s + n[S], 0)) / (nodes.length - 1);
    let cursor = first[P];
    this.doc.transact('Distribute', () => {
      for (const n of nodes) {
        const d = cursor - n[P];
        this.moveNodes([n.id], axis === 'x' ? d : 0, axis === 'x' ? 0 : d);
        cursor += n[S] + gap;
      }
    }, { animate: true });
  }

  bringToFront() {
    const ids = this.selectedNodeIds();
    this.doc.transact('Bring to front', () => ids.forEach((id) => this.doc.update(id, { z: this.doc.nextZ() })));
  }

  sendToBack() {
    const ids = this.selectedNodeIds();
    let z = Math.min(0, ...[...this.doc.nodes.values()].map((n) => n.z));
    this.doc.transact('Send to back', () => ids.forEach((id) => this.doc.update(id, { z: --z })));
  }

  /** Change node type; containers with children can't become leaves. */
  setType(ids, type) {
    const leaf = !this.schema.nodeTypes[type]?.container;
    this.doc.transact('Change type', () => {
      for (const id of ids) {
        if (leaf && this.doc.hasChildren(id)) continue;
        if (this.doc.nodes.has(id)) this.doc.update(id, { type });
      }
    });
  }

  setEdgeType(ids, type) {
    this.doc.transact('Change link type', () => ids.forEach((id) => this.doc.update(id, { type })));
  }

  setStyle(ids, patch) {
    this.doc.transact('Style', () => {
      for (const id of ids) {
        const o = this.doc.get(id);
        if (!o) continue;
        const style = { ...o.style, ...patch };
        for (const k of Object.keys(style)) if (style[k] == null) delete style[k];
        this.doc.update(id, { style });
      }
    });
  }

  /** Short message for the user (the app shows it as a toast). */
  notify(message, icon) {
    this.emit('notice', { message, icon });
  }

  /**
   * Copy the selected item's look: colour and text style for an element; colour, routing and
   * kind for a link. Hand-made shapes (waypoints, label position) are not part of a style.
   */
  copyStyle() {
    const id = this.singleSelected();
    const o = id && this.doc.get(id);
    if (!o) return;
    const kind = this.doc.kindOf(id);
    const text = this.isText(id);
    const keys = kind === 'edge' ? ['color', 'routing'] : text ? ['color', 'textSize', 'align'] : ['color'];
    this.styleClip = { kind, text, type: kind === 'edge' ? o.type : null, style: Object.fromEntries(keys.map((k) => [k, o.style?.[k] ?? null])) };
    this.notify('Style copied: select others and paste it', 'copy');
  }

  /** Apply the copied style to the selection. Across kinds (element ↔ link, text ↔ box) only the colour carries over. */
  pasteStyle() {
    const clip = this.styleClip;
    const ids = [...this.selection];
    if (!clip || !ids.length) return;
    this.doc.transact('Paste style', () => {
      for (const id of ids) {
        const kind = this.doc.kindOf(id);
        const same = kind === clip.kind && (kind === 'edge' || this.isText(id) === clip.text);
        const patch = same ? clip.style : { color: clip.style.color };
        if (same && kind === 'edge') this.doc.update(id, { type: clip.type });
        if (this.isText(id)) this.setTextStyle([id], patch);
        else this.setStyle([id], patch);
      }
    });
  }

  setData(id, key, value, merge) {
    const o = this.doc.get(id);
    if (!o) return;
    this.doc.transact('Edit', () => this.doc.update(id, { data: { ...o.data, [key]: value } }), { merge });
  }

  reverseEdges(ids) {
    this.doc.transact('Reverse', () => {
      for (const id of ids) {
        const e = this.doc.edges.get(id);
        if (e) this.doc.update(id, { source: e.target, target: e.source });
      }
    });
  }

  autoLayout({ scope = this.#layoutScope(), direction = this.settings.layoutDirection, animate = true, history = true, fit = true } = {}) {
    const rects = layoutHierarchy(this.doc, {
      direction, scope,
      padding: this.settings.containerPadding,
      header: this.settings.containerHeader,
    });
    if (!rects.size) return;
    const opts = history ? { animate } : { animate, history: false };
    const outlines = [...this.doc.nodes.values()].filter((n) => isOverlay(this.doc, n))
      .map((o) => ({ id: o.id, inside: this.surrounded(o.id).map((n) => n.id) })).filter((o) => o.inside.length);
    this.doc.transact('Auto layout', () => {
      for (const [id, r] of rects) {
        const n = this.doc.nodes.get(id);
        const x = Math.round(r.x), y = Math.round(r.y);
        if (n.collapsed) this.doc.moveBy([id], x - n.x, y - n.y);
        else this.doc.update(id, { x, y, w: Math.round(r.w), h: Math.round(r.h) });
      }
      // The layout owns the geometry now: drop hand-made routes between laid-out nodes.
      for (const e of this.doc.edges.values()) {
        if (!e.style?.points) continue;
        const inside = (id) => rects.has(id) || this.doc.ancestors(id).some((a) => rects.has(a));
        if (inside(e.source) && inside(e.target)) this.doc.update(e.id, { style: withoutKeys(e.style, ['points']) });
      }
      if (scope) this.fitContainers([scope]);
      // Border-only outlines are not laid out: they re-wrap what they surrounded before.
      for (const o of outlines) this.doc.update(o.id, this.#outlineRect(o.inside.map((id) => this.doc.nodes.get(id))));
    }, opts);
    if (fit) {
      const b = scope ? this.doc.nodes.get(scope) : this.doc.bounds();
      if (b && !containsRect(this.visibleRect(), b)) this.zoomToRect(b, { animate });
    }
    if (history) this.emit('layout', { scope });
  }

  /** What auto layout arranges: the selected box, else the open view's module, else everything. */
  #layoutScope() {
    const id = this.singleSelected();
    if (id && this.doc.isContainer(id) && this.doc.hasChildren(id)) return id;
    return this.viewRoot;
  }

  // ───────────────────────────── view

  zoomBy(factor, around) {
    const at = around ?? { x: this.camera.size.w / 2, y: this.camera.size.h / 2 };
    this.camera.set(this.camera.zoomedAt(at, factor), { animate: true, duration: 220 });
  }

  zoomTo(zoom) {
    const at = { x: this.camera.size.w / 2, y: this.camera.size.h / 2 };
    this.camera.set(this.camera.zoomedAt(at, zoom / this.camera.zoom), { animate: true, duration: 300 });
  }

  zoomToRect(rect, { animate = true, maxZoom = 1 } = {}) {
    this.camera.set(this.camera.fitRect(rect, { maxZoom }), { animate });
  }

  fitView({ animate = true } = {}) {
    const b = this.visibleBounds();
    if (b) this.zoomToRect(b, { animate });
    else this.camera.set({ x: -this.camera.size.w / 2, y: -this.camera.size.h / 2, zoom: 1 }, { animate });
  }

  zoomToSelection() {
    const b = this.selectionBounds();
    if (b) this.zoomToRect(b, { maxZoom: 1.5 });
  }

  /** The part of the view not covered by floating UI, in world coordinates. */
  visibleRect() {
    const { top, right, bottom, left } = this.camera.insets;
    const z = this.camera.zoom, v = this.camera.viewRect();
    return { x: v.x + left / z, y: v.y + top / z, w: v.w - (left + right) / z, h: v.h - (top + bottom) / z };
  }

  ensureVisible(rect) {
    const view = inflate(this.visibleRect(), -40 / this.camera.zoom);
    if (containsRect(view, rect)) return;
    this.camera.set(this.camera.fitRect(rect, { maxZoom: this.camera.zoom }), { animate: true });
  }

  /** Select a node or edge and bring it into view (leaving a view that doesn't show it). */
  reveal(id) {
    const e = this.doc.edges.get(id);
    const ends = e ? [e.source, e.target] : [id];
    if (this.viewRoot != null && ends.some((n) => this.doc.hidden().has(this.doc.visibleAncestor(n)) && !this.isContext(n))) {
      this.openView(null, { animate: false });
    }
    const collapsed = [e?.source ?? id, e?.target].filter(Boolean)
      .flatMap((n) => this.doc.ancestors(n)).filter((a) => this.doc.nodes.get(a).collapsed);
    if (collapsed.length) this.toggleCollapse([...new Set(collapsed)], false);
    this.setSelection([id]);
    const o = this.doc.nodes.get(id) ?? this.router.peek(id)?.bbox;
    if (o) this.zoomToRect(inflate(o, 120), { maxZoom: Math.max(this.camera.zoom, 1) });
  }

  // ───────────────────────────── persistence

  load(json, { fit = true } = {}) {
    this.cancelGesture();
    this.endEdit();
    this.doc.load(json);
    this.history.clear();
    this.setSelection([]);
    this.showFlow(null);
    this.emit('view', null);
    if (fit) this.fitView({ animate: false });
  }

  toJSON() {
    return this.doc.toJSON();
  }
}

function sameHit(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id && a.side === b.side && a.handle === b.handle && a.end === b.end &&
    a.segment === b.segment && a.index === b.index && a.label === b.label;
}

function withoutKeys(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

function nearestSegment(p, pts) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(p, pts[i], pts[i + 1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
