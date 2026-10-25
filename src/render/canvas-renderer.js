import { boundariesCrossed, busMembers, isOverlay, resolveType, showsAsCard } from '../engine/schema.js';
import { boundsOf, clamp, dist, inflate, intersects, lerpRect, union } from '../engine/geometry.js';
import { SIDES, labelPoint, routeEdge, routeSimpleOrthogonal, sideNormal } from '../engine/routing.js';
import { LEGEND, legendEntries } from '../engine/legend.js';
import { SVGContext } from './svg-context.js';
import { withAlpha } from './theme.js';

const FONT = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace';
/** Free-text sizes: S, M, L and a bold title. */
export const TEXT_SIZES = {
  sm: { size: 12, lh: 16, weight: 500 },
  md: { size: 14, lh: 20, weight: 500 },
  lg: { size: 18, lh: 24, weight: 600 },
  xl: { size: 26, lh: 32, weight: 700 },
};
export const TEXT_PAD = 4;
const STATUS_BADGES = {
  planned: { label: 'PLANNED', color: '#0284c7' },
  deprecated: { label: 'DEPRECATED', color: '#e11d48' },
};
const GEOM = ['x', 'y', 'w', 'h'];
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/**
 * Frame-rate independent exponential smoothing of named values (hover, selection, ...).
 * Values not touched during a frame are dropped, so state never leaks.
 */
class Smoother {
  active = false;
  #vals = new Map();
  #dt = 0.016;
  #last = 0;
  #frame = 0;

  begin(now) {
    this.#dt = this.#last ? clamp((now - this.#last) / 1000, 0.001, 1 / 30) : 0.016;
    this.#last = now;
    this.active = false;
    this.#frame++;
  }

  value(key, target, speed = 18) {
    let e = this.#vals.get(key);
    if (!e) {
      if (target === 0) return 0;
      this.#vals.set(key, (e = { v: 0, f: 0 }));
    }
    e.v += (target - e.v) * (1 - Math.exp(-speed * this.#dt));
    if (Math.abs(target - e.v) < 0.003) e.v = target;
    else this.active = true;
    e.f = this.#frame;
    return e.v;
  }

  peek(key) {
    return this.#vals.get(key)?.v ?? 0;
  }

  end() {
    for (const [k, e] of this.#vals) if (e.f !== this.#frame || e.v === 0) this.#vals.delete(k);
  }
}

/**
 * Canvas 2D renderer. Draws only what is in view (spatial index), with three levels of
 * detail, and only when something changed: frames are scheduled on demand and keep
 * running only while animations are in flight.
 */
export class CanvasRenderer {
  shadows = true;
  stats = { ms: 0, nodes: 0, edges: 0 };

  #raf = 0;
  #fx = new Smoother();
  #tweens = new Map();
  #appear = new Map();
  #ghosts = [];
  #paths = new Map();
  #measure = new Map();
  #wraps = new Map();
  #animating = false;
  #exporting = false;
  #bundles = new Map();
  #captions = new Map();
  #labels = new Map();
  #tabs = new Map();
  #members = new Set();
  #memberColor = '#0284c7';
  #focus = null;
  #legend = { version: -1, sections: [] };
  #tagMemo = null;

  constructor(editor, canvas, { theme, icons = {} }) {
    this.ed = editor;
    this.schema = editor.schema;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = theme;
    this.icons = icons;
    this.dpr = 1;
    this.z = 1;
    this.lod = 2;
    this.now = 0;
    editor.layoutProbe = this;
    editor.on('invalidate', () => this.invalidate());
    editor.doc.on('change', (e) => this.#onDocChange(e));
  }

  /** World rect of a node's caption line as last drawn (for in-place editing), or null. */
  captionRect(id) {
    return this.#captions.get(id) ?? null;
  }

  /** World rect of a boundary's name tab as last drawn, or null. */
  tabRect(id) {
    return this.#tabs.get(id) ?? null;
  }

  /** World rect of a link's tag as last drawn (`line`: its label line), or null. */
  labelRect(id) {
    return this.#labels.get(id) ?? null;
  }

  setTheme(theme) {
    this.theme = theme;
    this.invalidate();
  }

  resize(w, h, dpr = globalThis.devicePixelRatio || 1) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ed.resize(w, h);
    this.invalidate();
  }

  invalidate() {
    if (!this.#raf) this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(now) {
    this.#raf = 0;
    const t0 = performance.now();
    const more = this.render(now);
    const ms = performance.now() - t0;
    this.stats.ms = this.stats.ms ? this.stats.ms * 0.9 + ms * 0.1 : ms;
    if (more) this.invalidate();
  }

  /** Draw one frame. Returns true if another frame is needed (animations in flight). */
  render(now) {
    const { ed, ctx, dpr } = this;
    const cam = ed.camera;
    const camMoving = cam.tick(now);
    this.now = now;
    this.#animating = false;
    this.#fx.begin(now);
    const z = cam.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
    ed.router.beginFrame(10);
    this.#scene(ctx, inflate(cam.viewRect(), 60 / z), z);
    ed.router.endFrame();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#screenOverlays(ctx);
    this.#fx.end();
    return camMoving || this.#fx.active || this.#animating || ed.router.pending ||
      this.#tweens.size > 0 || this.#appear.size > 0 || this.#ghosts.length > 0;
  }

  /** Render the whole diagram to a PNG blob (no selection or hover decorations). */
  /** Area covering every visible node and link, plus padding. */
  #exportRect(padding) {
    const { doc, router } = this.ed;
    const hidden = doc.hidden();
    let b = boundsOf([...doc.nodes.values()].filter((n) => !hidden.has(n.id)));
    if (!b) return null;
    for (const e of doc.edges.values()) {
      if (doc.visibleAncestor(e.source) !== doc.visibleAncestor(e.target)) b = union(b, router.get(e.id).bbox);
    }
    return inflate(b, padding);
  }

  /** Render the whole diagram as a standalone SVG document (vector, same look as the canvas). */
  exportSVG({ padding = 56 } = {}) {
    const rect = this.#exportRect(padding);
    if (!rect) return null;
    const ctx = new SVGContext(document.createElement('canvas').getContext('2d'));
    ctx.setTransform(1, 0, 0, 1, -rect.x, -rect.y);
    const saved = this.dpr;
    this.dpr = 1;
    this.#exporting = true;
    try {
      this.#scene(ctx, rect, 1);
    } finally {
      this.#exporting = false;
      this.dpr = saved;
    }
    return ctx.toSVG(rect.w, rect.h, this.theme.bg);
  }

  async exportPNG({ scale = 2, padding = 56 } = {}) {
    const rect = this.#exportRect(padding);
    if (!rect) return null;
    scale = Math.min(scale, 16000 / rect.w, 16000 / rect.h);
    const c = document.createElement('canvas');
    c.width = Math.ceil(rect.w * scale);
    c.height = Math.ceil(rect.h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
    const saved = { dpr: this.dpr };
    this.dpr = scale;
    this.#exporting = true;
    try {
      this.#scene(ctx, rect, 1);
    } finally {
      this.#exporting = false;
      this.dpr = saved.dpr;
    }
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  // ───────────────────────────── animation bookkeeping

  #onDocChange({ patch, source, reset }) {
    const now = performance.now();
    if (reset) {
      this.#tweens.clear();
      this.#appear.clear();
      this.#ghosts = [];
      this.invalidate();
      return;
    }
    const animate = patch.animate || source === 'undo' || source === 'redo' || source === 'cancel';
    const few = patch.ops.length <= 400;
    for (const op of patch.ops) {
      if (op.k === 'edge') {
        if (op.t === 'add' && few) this.#appear.set(op.id, now);
        continue;
      }
      if (op.t === 'set' && 'collapsed' in op.after) {
        // Expanding reveals the contents with the appear animation; collapsing fades them out.
        const doc = this.ed.doc;
        const kids = doc.descendants(op.id);
        if (kids.length <= 400) {
          for (const d of kids) {
            if (!op.after.collapsed) this.#appear.set(d, now);
            else if (!doc.isContainer(d)) this.#ghosts.push({ node: { ...doc.nodes.get(d) }, start: now });
          }
        }
      }
      if (op.t === 'add') {
        if (few) this.#appear.set(op.id, now);
      } else if (op.t === 'del') {
        this.#tweens.delete(op.id);
        if (few) this.#ghosts.push({ node: op.v, start: now });
      } else if (animate && patch.ops.length <= 4000 && GEOM.some((k) => k in op.before)) {
        const n = this.ed.doc.nodes.get(op.id);
        if (!n) continue;
        const before = { x: n.x, y: n.y, w: n.w, h: n.h };
        for (const k of GEOM) if (k in op.before) before[k] = op.before[k];
        const tw = this.#tweens.get(op.id);
        const from = tw ? lerpRect(tw.from, before, easeOut(clamp((now - tw.start) / tw.dur, 0, 1))) : before;
        this.#tweens.set(op.id, { from, start: now, dur: 460 });
      }
    }
    this.invalidate();
  }

  displayRect(n) {
    const tw = this.#tweens.get(n.id);
    if (!tw) return n;
    const t = (this.now - tw.start) / tw.dur;
    if (t >= 1 || this.#exporting) {
      this.#tweens.delete(n.id);
      return n;
    }
    return lerpRect(tw.from, n, easeOut(Math.max(0, t)));
  }

  #appearT(id) {
    const s = this.#appear.get(id);
    if (s === undefined || this.#exporting) return 1;
    const t = (this.now - s) / 260;
    if (t >= 1) {
      this.#appear.delete(id);
      return 1;
    }
    return Math.max(0, t);
  }

  // ───────────────────────────── scene

  #scene(ctx, view, z) {
    const { ed } = this;
    const doc = ed.doc;
    this.z = z;
    this.lod = this.#exporting ? 2 : z < 0.2 ? 0 : z < 0.45 ? 1 : 2;

    const hidden = doc.hidden();
    const idSet = new Set(doc.index.query(view));
    for (const id of this.#tweens.keys()) if (doc.nodes.has(id)) idSet.add(id);
    const ids = [...idSet].filter((id) => !hidden.has(id)).sort((a, b) => doc.orderIndex(a) - doc.orderIndex(b));
    const containers = [], leaves = [], overlays = [];
    for (const id of ids) {
      const n = doc.nodes.get(id);
      const r = this.displayRect(n);
      if (isOverlay(doc, n)) overlays.push([n, r]);
      else (doc.isContainer(n) && !n.collapsed && !showsAsCard(doc, n) ? containers : leaves).push([n, r]);
    }
    this.shadows = leaves.length < 400;
    this.#focus = this.#exporting ? null : ed.dependencyFocus();
    this.#members = new Set();
    if (!this.#exporting) {
      for (const id of ed.selection) {
        const sel = doc.nodes.get(id);
        if (sel && this.schema.nodeTypes[sel.type]?.shape === 'bus') {
          this.#memberColor = sel.style?.color ?? resolveType(this.schema, sel).color ?? this.theme.accent;
          for (const m of busMembers(doc, id)) this.#members.add(m.id);
        }
      }
    }
    this.stats.nodes = ids.length;

    for (const [n, r] of containers) this.#drawContainer(ctx, n, r);

    // Links into collapsed modules attach to the module; links between the same pair of
    // visible nodes are drawn once and labelled with their count.
    const visible = [];
    const pairs = new Map();
    for (const e of doc.edges.values()) {
      if (ed.overlay.connect?.edgeId === e.id) continue;
      const sid = doc.visibleAncestor(e.source), tid = doc.visibleAncestor(e.target);
      if (sid === tid && e.source !== e.target) continue;
      const proxied = sid !== e.source || tid !== e.target;
      if (proxied) {
        const key = sid + '>' + tid;
        const seen = pairs.get(key);
        if (seen) {
          seen.count++;
          continue;
        }
        pairs.set(key, { count: 1, edge: e });
      }
      const s = doc.nodes.get(sid), t = doc.nodes.get(tid);
      if (!s || !t) continue;
      const sr = this.displayRect(s), tr = this.displayRect(t);
      if (!intersects(view, inflate(union(sr, tr), 200))) continue;
      visible.push([e, sr, tr, sr !== s || tr !== t]);
    }
    this.#bundles = new Map([...pairs.values()].filter((p) => p.count > 1).map((p) => [p.edge.id, p.count]));
    const fast = !this.#exporting && (z < 0.4 || visible.length > 800);
    const settled = [];
    const moving = [];
    for (const [e, sr, tr, isMoving] of visible) {
      const route = isMoving
        ? ed.router.compute(e, { fast: true, rects: { source: sr, target: tr } })
        : ed.router.get(e.id, { fast });
      if (route) (isMoving ? moving : settled).push({ edge: e, route });
    }
    const spread = this.lod > 0 ? ed.router.spread(settled) : new Map();
    const routed = [...settled.map(({ edge, route }) => [edge, spread.get(edge.id) ?? route]), ...moving.map(({ edge, route }) => [edge, route])];
    this.stats.edges = routed.length;
    if (this.lod === 0) {
      this.#overviewBatch(ctx, routed, leaves);
    } else {
      for (const [e, route] of routed) this.#drawEdge(ctx, e, route);
      for (const [n, r] of overlays) this.#drawOverlay(ctx, n, r, 'outline');
      this.#crossingMarkers(ctx, routed, [...containers, ...overlays]);
      const tags = this.#placeTags(ctx, routed);
      for (const [e] of routed) this.#drawEdgeLabel(ctx, e, tags.get(e.id));
      for (const [n, r] of leaves) {
        if (n.collapsed) this.#drawCollapsed(ctx, n, r);
        else this.#drawNode(ctx, n, r);
      }
      for (const [n, r] of overlays) this.#drawOverlay(ctx, n, r, 'tab');
    }
    this.#drawGhosts(ctx);
    if (!this.#exporting) this.#worldOverlays(ctx);
  }

  /**
   * Far-zoom overview: everything is tiny, so draw calls dominate. All links go in one
   * path and nodes are batched by color: a handful of fills instead of thousands.
   */
  #overviewBatch(ctx, routed, leaves) {
    const { ed, theme: th, z } = this;
    ctx.beginPath();
    for (const [, route] of routed) {
      const pts = route.poly;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = th.edge;
    ctx.stroke();
    const byColor = new Map();
    for (const [n, r] of leaves) {
      if (this.schema.nodeTypes[n.type]?.shape === 'text') continue;
      const color = ed.selection.has(n.id) ? th.accent : n.style?.color ?? resolveType(this.schema, n).color ?? th.accent;
      let list = byColor.get(color);
      if (!list) byColor.set(color, (list = []));
      list.push(r);
    }
    for (const [color, rects] of byColor) {
      ctx.beginPath();
      for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = color === th.accent ? color : withAlpha(color, th.dark ? 0.7 : 0.55);
      ctx.fill();
    }
  }

  /** Opacity under the dependency focus: whatever it leaves out fades back. */
  #fade(id, kind) {
    if (this.#exporting) return 1;
    const lit = !this.#focus || (kind === 'edge' ? this.#focus.edges : this.#focus.nodes).has(id);
    return 1 - 0.82 * this.#fx.value('f' + id, lit ? 0 : 1, 14);
  }

  #state(id, kind) {
    if (this.#exporting) return { hs: 0, ss: 0 };
    const ed = this.ed;
    const hov = (ed.hover?.id === id && (kind === 'edge') === (ed.hover.kind === 'edge')) || ed.portNode === id;
    return {
      hs: this.#fx.value('h' + id, hov ? 1 : 0),
      ss: this.#fx.value('s' + id, ed.selection.has(id) ? 1 : 0),
    };
  }

  #drawContainer(ctx, n, r) {
    const { ed, theme: th, z, lod } = this;
    const type = resolveType(this.schema, n);
    const color = n.style?.color ?? type.color ?? th.accent;
    const { hs, ss } = this.#state(n.id, 'node');
    const ds = this.#exporting ? 0 : this.#fx.value('d' + n.id, ed.overlay.dropTarget === n.id ? 1 : 0, 22);
    const ap = this.#appearT(n.id);
    ctx.save();
    ctx.globalAlpha = easeOut(ap) * this.#fade(n.id, 'node');
    if (type.shape === 'boundary') {
      this.#drawBoundary(ctx, n, r, type, color, hs, ss, ds);
      ctx.restore();
      return;
    }
    const radius = 16;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.fillStyle = withAlpha(color, th.dark ? 0.075 : 0.05);
    ctx.fill();
    if (ds > 0) {
      ctx.fillStyle = withAlpha(th.accent, 0.08 * ds);
      ctx.fill();
    }
    ctx.lineWidth = Math.max(1.25, 1 / z);
    ctx.strokeStyle = withAlpha(color, 0.38 + 0.3 * hs);
    if (type.dashed) ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (ds > 0) {
      ctx.lineWidth = 2 / z;
      ctx.strokeStyle = withAlpha(th.accent, 0.9 * ds);
      ctx.stroke();
    }

    const editing = ed.editingId === n.id ? ed.editingField : null;
    this.#captions.delete(n.id);
    {
      // Headers scale up when zoomed out so the overview stays readable.
      const f = lod === 2 ? 1 : Math.min(0.6 / z, Math.max(1, r.w / 200));
      const size = 13 * f;
      const ix = r.x + 16, iy = r.y + 16;
      this.#icon(ctx, type.icon, ix, iy, 18 * f, color, 2);
      ctx.font = `600 ${size}px ${FONT}`;
      ctx.fillStyle = th.text;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const lx = ix + 18 * f + 8 * f;
      const maxW = r.w - (lx - r.x) - 44;
      const label = this.#ellipsize(ctx, n.label || type.label, maxW);
      if (editing !== 'label') ctx.fillText(label, lx, iy + 9 * f + 0.5);
      if (lod === 2) {
        const used = this.#measureText(ctx, label);
        const caption = captionOf(n) || (type.label ?? '').toUpperCase();
        ctx.font = `500 10.5px ${FONT}`;
        ctx.fillStyle = th.muted;
        const room = maxW - used - 10;
        if (room > 40) {
          this.#captions.set(n.id, { x: lx + used + 10, y: iy + 1.5, w: room, h: 16, size: 10.5, align: 'left' });
          if (editing !== 'stereotype') ctx.fillText(this.#ellipsize(ctx, caption, room), lx + used + 10, iy + 9.5);
        }
      }
    }
    if (lod > 0) this.#toggleButton(ctx, n, color, Math.max(hs, ss), false);
    this.#statusBadge(ctx, n, r, 64);
    this.#selectionRing(ctx, r, radius, ss);
    ctx.restore();
  }

  /** "Planned" / "Deprecated" pill sitting on the top border, near the right (`inset` clears a header button). */
  #statusBadge(ctx, n, r, inset = 14) {
    const s = STATUS_BADGES[n.data?.status];
    if (!s || this.lod < 2) return;
    ctx.font = `700 9px ${FONT}`;
    const w = this.#measureText(ctx, s.label) + 12, h = 15;
    const x = r.x + r.w - inset - w, y = r.y - h / 2;
    if (x < r.x + 8) return;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, 1 / this.z);
    ctx.strokeStyle = this.theme.bg;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.label, x + w / 2, y + h / 2 + 0.5);
  }

  /**
   * Boundary (trust boundary, network zone): a dashed outline with a name tab sitting on
   * the border. Almost no fill, so it reads as a line drawn across the architecture.
   */
  #drawBoundary(ctx, n, r, type, color, hs, ss, ds, { outline = true, tab = true, overlay = false } = {}) {
    const { ed, theme: th, z, lod } = this;
    const radius = 12;
    if (outline) {
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, radius);
      // Border-only outlines have no fill (they contain nothing), except a hint on hover.
      const fill = overlay ? 0.03 * hs : (th.dark ? 0.04 : 0.025) + 0.03 * hs;
      if (fill > 0.001) {
        ctx.fillStyle = withAlpha(color, fill);
        ctx.fill();
      }
      if (ds > 0) {
        ctx.fillStyle = withAlpha(th.accent, 0.07 * ds);
        ctx.fill();
      }
      const k = Math.max(1, 0.8 / z);
      ctx.lineWidth = Math.max(overlay ? 2 : 1.75, 1.25 / z);
      // Dash-dot marks an outline that doesn't contain; dashes a containing boundary.
      ctx.setLineDash(overlay ? [12 * k, 5 * k, 2 * k, 5 * k] : [9 * k, 6 * k]);
      ctx.strokeStyle = ds > 0.5 ? th.accent : withAlpha(color, 0.7 + 0.3 * hs);
      ctx.stroke();
      ctx.setLineDash([]);
      // The selection ring goes under the name tab: the tab sits on the border and must stay legible.
      this.#selectionRing(ctx, r, radius, ss);
    }
    if (!tab) return;

    const editing = ed.editingId === n.id ? ed.editingField : null;
    this.#captions.delete(n.id);
    this.#tabs.delete(n.id);
    if (lod > 0) {
      const f = lod === 2 ? 1 : Math.min(0.6 / z, Math.max(1, r.w / 240));
      const h = 24 * f, pad = 10 * f, icon = 15 * f, gap = 6 * f;
      const room = r.w - 18 - 56;
      ctx.font = `600 ${12.5 * f}px ${FONT}`;
      const label = this.#ellipsize(ctx, n.label || type.label, Math.max(40, room * 0.6));
      const lw = this.#measureText(ctx, label);
      ctx.font = `500 ${10.5 * f}px ${FONT}`;
      const caption = lod === 2 ? [n.data?.stereotype || type.label, n.data?.tech].filter(Boolean).join(' · ') : '';
      const cap = caption ? this.#ellipsize(ctx, caption, room - lw - icon - pad * 2 - gap - 8 * f) : '';
      const cw = cap ? this.#measureText(ctx, cap) + 8 * f : 0;
      const x = r.x + 18, y = r.y - h / 2;
      const tw = pad + icon + gap + lw + cw + pad;
      this.#tabs.set(n.id, { x, y, w: tw, h });
      ctx.beginPath();
      ctx.roundRect(x, y, tw, h, h / 2);
      ctx.fillStyle = th.labelBg;
      ctx.fill();
      ctx.lineWidth = Math.max(1.25, 1 / z);
      ctx.strokeStyle = ds > 0.5 || ss > 0.5 ? th.accent : withAlpha(color, 0.85);
      ctx.stroke();
      this.#icon(ctx, type.icon, x + pad, y + (h - icon) / 2, icon, color, 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${12.5 * f}px ${FONT}`;
      ctx.fillStyle = th.text;
      if (editing !== 'label') ctx.fillText(label, x + pad + icon + gap, y + h / 2 + 0.5);
      if (cap) {
        const cx = x + pad + icon + gap + lw + 8 * f;
        this.#captions.set(n.id, { x: cx, y: y + h / 2 - 8, w: Math.max(cw, 120), h: 16, size: 10.5 * f, align: 'left' });
        ctx.font = `500 ${10.5 * f}px ${FONT}`;
        ctx.fillStyle = th.muted;
        if (editing !== 'stereotype') ctx.fillText(cap, cx, y + h / 2 + 0.5);
      }
    }
    if (lod > 0 && !overlay) this.#toggleButton(ctx, n, color, Math.max(hs, ss), false);
  }

  /** Border-only boundary, in two passes: the outline under the leaves, the tab above them. */
  #drawOverlay(ctx, n, r, part) {
    const type = resolveType(this.schema, n);
    const color = n.style?.color ?? type.color ?? this.theme.accent;
    const { hs, ss } = part === 'outline' ? this.#state(n.id, 'node') : { hs: this.#peek('h' + n.id), ss: this.#peek('s' + n.id) };
    ctx.save();
    ctx.globalAlpha = easeOut(this.#appearT(n.id)) * (part === 'outline' ? this.#fade(n.id, 'node') : 1 - 0.82 * this.#peek('f' + n.id));
    this.#drawBoundary(ctx, n, r, type, color, hs, ss, 0, { outline: part === 'outline', tab: part === 'tab', overlay: true });
    ctx.restore();
  }

  /** Smoothed state values already computed this frame (without advancing them twice). */
  #peek(key) {
    return this.#exporting ? 0 : this.#fx.peek(key);
  }

  /**
   * Where a link crosses a boundary whose variant asks for it (trust boundaries), mark the
   * crossing point on the border, so the places that need authentication, validation or
   * encryption stand out.
   */
  #crossingMarkers(ctx, routed, containers) {
    const marking = new Map();
    for (const [n, r] of containers) {
      const t = resolveType(this.schema, n);
      if (t.markCrossings) marking.set(n.id, { r, color: n.style?.color ?? t.color });
    }
    if (!marking.size) return;
    const { theme: th, z } = this;
    const s = 6;
    // Only outlines in view can carry markers: don't let every link scan the whole document.
    const outlines = containers.map(([n]) => n).filter((n) => isOverlay(this.ed.doc, n));
    for (const [e, route] of routed) {
      for (const b of boundariesCrossed(this.ed.doc, e, outlines)) {
        const m = marking.get(b.id);
        if (!m) continue;
        for (const p of borderCrossings(route.poly, m.r)) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - s);
          ctx.lineTo(p.x + s, p.y);
          ctx.lineTo(p.x, p.y + s);
          ctx.lineTo(p.x - s, p.y);
          ctx.closePath();
          ctx.fillStyle = m.color;
          ctx.fill();
          ctx.lineWidth = Math.max(1.5, 1 / z);
          ctx.strokeStyle = th.labelBg;
          ctx.stroke();
        }
      }
    }
  }

  /** A collapsed module: a card with a stacked-sheets look, its item count and an expand button. */
  #drawCollapsed(ctx, n, r) {
    const { ed, theme: th, z, lod } = this;
    const type = resolveType(this.schema, n);
    const color = n.style?.color ?? type.color ?? th.accent;
    const { hs, ss } = this.#state(n.id, 'node');
    const lift = this.#exporting ? 0 : this.#fx.value('l' + n.id, ed.gesture?.all?.has(n.id) ? 1 : 0, 14);
    const ap = this.#appearT(n.id);
    ctx.save();
    ctx.globalAlpha = easeOut(ap) * this.#fade(n.id, 'node');
    if (lod === 0) {
      ctx.fillStyle = withAlpha(color, th.dark ? 0.6 : 0.45);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
      return;
    }
    ctx.lineWidth = Math.max(1, 1 / z);
    for (const k of [8, 4]) {
      ctx.beginPath();
      ctx.roundRect(r.x + k, r.y + k, r.w, r.h, 12);
      ctx.fillStyle = th.nodeFill;
      ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.28);
      ctx.stroke();
    }
    if (this.shadows && lod === 2) {
      const k = Math.max(hs * 0.6, lift);
      ctx.shadowColor = k > 0.05 ? th.shadowStrong : th.shadow;
      ctx.shadowBlur = (8 + 14 * k) * z * this.dpr;
      ctx.shadowOffsetY = (2 + 6 * lift) * z * this.dpr;
    }
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 12);
    ctx.fillStyle = th.nodeFill;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = withAlpha(color, th.dark ? 0.1 : 0.06);
    ctx.fill();
    ctx.lineWidth = Math.max(1.25, 1 / z);
    ctx.strokeStyle = withAlpha(color, 0.5 + 0.35 * hs);
    ctx.stroke();

    const s = 32, cx = r.x + 14, cy = r.y + r.h / 2 - s / 2;
    ctx.beginPath();
    ctx.roundRect(cx, cy, s, s, 9);
    ctx.fillStyle = withAlpha(color, th.dark ? 0.22 : 0.14);
    ctx.fill();
    this.#icon(ctx, type.icon, cx + 7, cy + 7, 18, color, 2);
    {
      const editing = ed.editingId === n.id ? ed.editingField : null;
      const count = ed.doc.descendants(n.id).length;
      const maxW = r.w - 58 - 44;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `600 13.5px ${FONT}`;
      ctx.fillStyle = th.text;
      if (editing !== 'label') ctx.fillText(this.#ellipsize(ctx, n.label || type.label, maxW), r.x + 58, r.y + r.h / 2 - 8);
      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = th.muted;
      this.#captions.set(n.id, { x: r.x + 58, y: r.y + r.h / 2 + 1, w: maxW, h: 16, size: 11, align: 'left' });
      const kind = n.data?.stereotype || type.label;
      if (editing !== 'stereotype') ctx.fillText(this.#ellipsize(ctx, `${count} item${count === 1 ? '' : 's'} · ${kind}`, maxW), r.x + 58, r.y + r.h / 2 + 9);
    }
    this.#toggleButton(ctx, n, color, 1, true);
    this.#statusBadge(ctx, n, r, 44);
    this.#selectionRing(ctx, r, 12, ss);
    ctx.restore();
  }

  /** Round collapse/expand button; `vis` fades it in (expanded modules show it on hover). */
  #toggleButton(ctx, n, color, vis, collapsed) {
    if (vis <= 0.01 || this.#exporting) return;
    const ed = this.ed, th = this.theme;
    const hot = this.#fx.value('t' + n.id, ed.hover?.kind === 'toggle' && ed.hover.id === n.id ? 1 : 0, 24);
    const p = ed.togglePosition(n);
    const rad = 10 + 1.5 * hot;
    ctx.save();
    ctx.globalAlpha *= vis;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = hot > 0.5 ? th.accent : withAlpha(color, th.dark ? 0.22 : 0.12);
    ctx.fill();
    ctx.beginPath();
    const d = collapsed ? 1 : -1;
    ctx.moveTo(p.x - 4, p.y - 2 * d);
    ctx.lineTo(p.x, p.y + 2 * d);
    ctx.lineTo(p.x + 4, p.y - 2 * d);
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hot > 0.5 ? '#fff' : color;
    ctx.stroke();
    ctx.restore();
  }

  #drawNode(ctx, n, r) {
    const { ed, theme: th, z, lod } = this;
    const type = resolveType(this.schema, n);
    const color = n.style?.color ?? type.color ?? th.accent;
    const { hs, ss } = this.#state(n.id, 'node');
    const lift = this.#exporting ? 0 : this.#fx.value('l' + n.id, ed.gesture?.all?.has(n.id) ? 1 : 0, 14);
    const ap = this.#appearT(n.id);
    const shape = type.shape ?? 'card';
    ctx.save();
    if (ap < 1) {
      const s = 0.82 + 0.18 * easeOutBack(ap);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      ctx.globalAlpha = Math.min(1, ap * 1.8);
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
    }
    ctx.globalAlpha *= this.#fade(n.id, 'node');
    if (shape === 'text') {
      this.#drawText(ctx, n, r, hs, ss);
      ctx.restore();
      return;
    }
    if (lod === 0) {
      ctx.fillStyle = withAlpha(color, th.dark ? 0.7 : 0.55);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (ss > 0) {
        ctx.lineWidth = 2 / z;
        ctx.strokeStyle = withAlpha(th.accent, ss);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
      return;
    }

    if (this.shadows && lod === 2) {
      const k = Math.max(hs * 0.6, lift);
      ctx.shadowColor = k > 0.05 ? th.shadowStrong : th.shadow;
      ctx.shadowBlur = (8 + 14 * k) * z * this.dpr;
      ctx.shadowOffsetY = (2 + 6 * lift) * z * this.dpr;
    }
    this.#shapePath(ctx, shape, r);
    ctx.fillStyle = th.nodeFill;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (shape === 'note' || shape === 'bus') {
      ctx.fillStyle = withAlpha(color, shape === 'bus' ? (th.dark ? 0.2 : 0.12) : th.dark ? 0.18 : 0.16);
      ctx.fill();
    }
    ctx.lineWidth = Math.max(shape === 'bus' ? 1.5 : 1, 1 / z);
    if (type.dashed) ctx.setLineDash([5, 4]);
    ctx.strokeStyle = shape === 'note' ? withAlpha(color, 0.45) : shape === 'bus' ? withAlpha(color, 0.65) : th.nodeStroke;
    ctx.stroke();
    if (hs > 0.01) {
      ctx.strokeStyle = withAlpha(color, 0.75 * hs * (1 - ss));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    this.#shapeDecoration(ctx, shape, r, color);
    this.#nodeContent(ctx, n, r, type, color, shape, ed.editingId === n.id ? ed.editingField : null);
    this.#statusBadge(ctx, n, r);
    const radius = shape === 'actor' ? Math.min(r.h / 2, 36) : shape === 'bus' ? Math.min(r.w, r.h) / 2 : 10;
    // While a network bus is selected, its members get a soft dashed halo.
    const ms = this.#exporting ? 0 : this.#fx.value('m' + n.id, this.#members.has(n.id) ? 1 : 0, 18);
    if (ms > 0.01) {
      const pad = 5 / z;
      ctx.beginPath();
      ctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, radius + pad);
      ctx.setLineDash([4 / z, 3 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = withAlpha(this.#memberColor, 0.9 * ms);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // A host still shown as a card is a drop target too: dashed accent halo while hovering it.
    const ds = this.#exporting ? 0 : this.#fx.value('d' + n.id, ed.overlay.dropTarget === n.id ? 1 : 0, 22);
    if (ds > 0.01) {
      const pad = 6 / z;
      ctx.beginPath();
      ctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, radius + pad);
      ctx.fillStyle = withAlpha(th.accent, 0.08 * ds);
      ctx.fill();
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.lineWidth = 2 / z;
      ctx.strokeStyle = withAlpha(th.accent, ds);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.#selectionRing(ctx, r, radius, ss);
    ctx.restore();
  }

  #shapePath(ctx, shape, r) {
    ctx.beginPath();
    if (shape === 'cylinder') {
      const ry = Math.min(12, r.h * 0.14), cx = r.x + r.w / 2;
      ctx.moveTo(r.x, r.y + ry);
      ctx.ellipse(cx, r.y + ry, r.w / 2, ry, 0, Math.PI, 0);
      ctx.lineTo(r.x + r.w, r.y + r.h - ry);
      ctx.ellipse(cx, r.y + r.h - ry, r.w / 2, ry, 0, 0, Math.PI);
      ctx.closePath();
    } else if (shape === 'note') {
      const f = 16;
      ctx.moveTo(r.x + 6, r.y);
      ctx.lineTo(r.x + r.w - f, r.y);
      ctx.lineTo(r.x + r.w, r.y + f);
      ctx.lineTo(r.x + r.w, r.y + r.h - 6);
      ctx.arcTo(r.x + r.w, r.y + r.h, r.x + r.w - 6, r.y + r.h, 6);
      ctx.lineTo(r.x + 6, r.y + r.h);
      ctx.arcTo(r.x, r.y + r.h, r.x, r.y + r.h - 6, 6);
      ctx.lineTo(r.x, r.y + 6);
      ctx.arcTo(r.x, r.y, r.x + 6, r.y, 6);
      ctx.closePath();
    } else {
      ctx.roundRect(r.x, r.y, r.w, r.h, shape === 'actor' ? Math.min(r.h / 2, 36) : shape === 'bus' ? Math.min(r.w, r.h) / 2 : 10);
    }
  }

  #shapeDecoration(ctx, shape, r, color) {
    if (shape === 'cylinder') {
      const ry = Math.min(12, r.h * 0.14);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + ry, r.w / 2, ry, 0, 0, Math.PI);
      ctx.strokeStyle = withAlpha(color, 0.55);
      ctx.stroke();
    } else if (shape === 'note') {
      const f = 16;
      ctx.beginPath();
      ctx.moveTo(r.x + r.w - f, r.y);
      ctx.lineTo(r.x + r.w - f, r.y + f);
      ctx.lineTo(r.x + r.w, r.y + f);
      ctx.strokeStyle = withAlpha(color, 0.45);
      ctx.stroke();
    }
  }

  #nodeContent(ctx, n, r, type, color, shape, editing) {
    const { theme: th, lod } = this;
    const label = n.label || '';
    ctx.textBaseline = 'middle';

    this.#captions.delete(n.id);
    if (shape === 'bus') return this.#busContent(ctx, n, r, type, color, editing);
    if (shape === 'legend') return this.#legendContent(ctx, n, r, editing);
    if (shape === 'note') {
      if (editing) return;
      ctx.font = `500 13px ${FONT}`;
      ctx.fillStyle = th.text;
      ctx.textAlign = 'left';
      const lines = this.#wrap(ctx, label, r.w - 28, Math.max(1, Math.floor((r.h - 24) / 18)));
      lines.forEach((l, i) => ctx.fillText(l, r.x + 14, r.y + 22 + i * 18));
      return;
    }

    const caption = lod === 2 ? captionOf(n) || type.label : null;
    const chip = lod === 2 && shape !== 'cylinder' && r.w >= 140 && r.h >= 44;
    const left = chip ? r.x + 58 : r.x + 14;
    const maxW = r.x + r.w - 14 - left;
    ctx.font = `600 13.5px ${FONT}`;
    const lines = this.#wrap(ctx, label, maxW, r.h >= 72 || !caption ? 2 : 1);
    const lineH = 17;
    const block = lines.length * lineH + (caption ? 15 : 0);
    const cy = r.y + r.h / 2 + (shape === 'cylinder' ? Math.min(12, r.h * 0.14) / 2 : 0);
    let y = cy - block / 2 + lineH / 2;

    if (chip) {
      const s = 32, cxp = r.x + 14, cyp = r.y + r.h / 2 - s / 2;
      ctx.beginPath();
      if (shape === 'actor') ctx.arc(cxp + s / 2, cyp + s / 2, s / 2, 0, Math.PI * 2);
      else ctx.roundRect(cxp, cyp, s, s, 9);
      ctx.fillStyle = withAlpha(color, th.dark ? 0.2 : 0.12);
      ctx.fill();
      this.#icon(ctx, type.icon, cxp + 7, cyp + 7, 18, color, 2);
    }
    ctx.textAlign = chip ? 'left' : 'center';
    const tx = chip ? left : r.x + r.w / 2;
    ctx.fillStyle = th.text;
    for (const l of lines) {
      if (editing !== 'label') ctx.fillText(l, tx, y);
      y += lineH;
    }
    if (caption) {
      this.#captions.set(n.id, { x: left, y: y - 9, w: maxW, h: 16, size: 11, align: chip ? 'left' : 'center' });
      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = th.muted;
      if (editing !== 'stereotype') ctx.fillText(this.#ellipsize(ctx, caption, maxW), tx, y - 1);
    }
  }

  /**
   * Free text (annotation): just the words, no box. A faint dashed outline shows on hover;
   * selection uses the usual ring.
   */
  #drawText(ctx, n, r, hs, ss) {
    const { ed, theme: th, z, lod } = this;
    if (hs > 0.01 && ss < 0.5) {
      ctx.beginPath();
      ctx.roundRect(r.x - 3, r.y - 2, r.w + 6, r.h + 4, 6);
      ctx.setLineDash([4 / z, 3 / z]);
      ctx.lineWidth = 1 / z;
      ctx.strokeStyle = withAlpha(th.muted, 0.6 * hs);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.#selectionRing(ctx, { x: r.x - 3, y: r.y - 2, w: r.w + 6, h: r.h + 4 }, 6, ss);
    if (lod === 0 || (ed.editingId === n.id && ed.editingField === 'label')) return;
    const st = TEXT_SIZES[n.style?.textSize] ?? TEXT_SIZES.md;
    ctx.font = `${st.weight} ${st.size}px ${FONT}`;
    ctx.fillStyle = n.style?.color ?? th.text;
    ctx.textBaseline = 'middle';
    const align = n.style?.align ?? 'left';
    ctx.textAlign = align;
    const x = align === 'center' ? r.x + r.w / 2 : align === 'right' ? r.x + r.w - TEXT_PAD : r.x + TEXT_PAD;
    const lines = this.#wrap(ctx, n.label || '', r.w - TEXT_PAD * 2, 200);
    lines.forEach((line, i) => ctx.fillText(line, x, r.y + TEXT_PAD + st.lh / 2 + i * st.lh));
  }

  /**
   * Size free text needs for `text`: auto-width text (the default) is as wide as its longest
   * line (up to a cap); text the user gave a width wraps within it.
   */
  measureText(n, text = n.label) {
    const st = TEXT_SIZES[n.style?.textSize] ?? TEXT_SIZES.md;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${st.weight} ${st.size}px ${FONT}`;
    const auto = n.style?.autoWidth !== false;
    const maxW = auto ? 480 : n.w - TEXT_PAD * 2;
    const lines = this.#wrap(ctx, text || ' ', maxW, 200);
    const longest = Math.max(...lines.map((l) => this.#measureText(ctx, l)));
    ctx.restore();
    return {
      w: auto ? Math.ceil(Math.min(Math.max(longest, 24), 480) + TEXT_PAD * 2) : n.w,
      h: Math.ceil(lines.length * st.lh + TEXT_PAD * 2),
    };
  }

  /** Legend: the kinds of elements, boundaries and links the diagram uses, one row each. */
  #legendContent(ctx, n, r, editing) {
    const { theme: th, lod } = this;
    const doc = this.ed.doc;
    if (this.#legend.version !== doc.version) this.#legend = { version: doc.version, sections: legendEntries(doc) };
    const { header, section, row } = LEGEND;
    const x = r.x + 14, right = r.x + r.w - 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `650 13px ${FONT}`;
    ctx.fillStyle = th.text;
    if (editing !== 'label') ctx.fillText(this.#ellipsize(ctx, n.label || 'Legend', right - x), x, r.y + 22);
    if (lod < 2) return;
    let y = r.y + header;
    if (!this.#legend.sections.length) {
      ctx.font = `500 11.5px ${FONT}`;
      ctx.fillStyle = th.muted;
      ctx.fillText('Add elements and links to fill it', x, y + 6);
      return;
    }
    for (const s of this.#legend.sections) {
      ctx.font = `600 9.5px ${FONT}`;
      ctx.fillStyle = th.muted;
      ctx.fillText(s.title.toUpperCase(), x, y + section / 2 + 2);
      y += section;
      for (const e of s.entries) {
        const cy = y + row / 2;
        this.#legendSwatch(ctx, e, x, cy);
        ctx.font = `500 12px ${FONT}`;
        ctx.fillStyle = th.text;
        const label = this.#ellipsize(ctx, e.label, right - x - 34);
        ctx.fillText(label, x + 34, cy + 0.5);
        if (e.sub) {
          const lw = this.#measureText(ctx, label);
          ctx.font = `500 11px ${FONT}`;
          ctx.fillStyle = th.muted;
          const sub = this.#ellipsize(ctx, e.sub, right - x - 34 - lw - 8);
          if (sub) ctx.fillText(sub, x + 34 + lw + 8, cy + 0.5);
        }
        y += row;
      }
    }
  }

  /** The 24px-wide sample in front of a legend row. */
  #legendSwatch(ctx, e, x, cy) {
    const th = this.theme, z = this.z;
    ctx.save();
    if (e.kind === 'node') {
      ctx.beginPath();
      if (e.shape === 'actor') ctx.arc(x + 11, cy, 9, 0, Math.PI * 2);
      else ctx.roundRect(x + 2, cy - 9, 18, 18, 5);
      ctx.fillStyle = withAlpha(e.color ?? th.accent, th.dark ? 0.22 : 0.14);
      ctx.fill();
      this.#icon(ctx, e.icon, x + 5, cy - 6, 12, e.color ?? th.accent, 2.2);
    } else if (e.kind === 'boundary') {
      ctx.beginPath();
      ctx.roundRect(x, cy - 7, 24, 14, 3);
      ctx.setLineDash(e.overlay ? [5, 2, 1, 2] : [4, 2.5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = e.color;
      ctx.stroke();
    } else if (e.kind === 'edge') {
      const lw = Math.max(e.width, 1 / z);
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x + (e.arrow === 'filled' ? 17 : 23), cy);
      if (e.dash) ctx.setLineDash(e.dash.map((d) => d * 0.7));
      ctx.lineWidth = lw;
      ctx.strokeStyle = th.edge;
      ctx.stroke();
      ctx.setLineDash([]);
      this.#arrow(ctx, { points: [{ x, y: cy }, { x: x + 24, y: cy }], end: { x: 1, y: 0 } }, e.arrow, th.edge, lw);
    } else if (e.kind === 'marker') {
      ctx.beginPath();
      ctx.moveTo(x + 12, cy - 6);
      ctx.lineTo(x + 18, cy);
      ctx.lineTo(x + 12, cy + 6);
      ctx.lineTo(x + 6, cy);
      ctx.closePath();
      ctx.fillStyle = e.color;
      ctx.fill();
    } else if (e.kind === 'status') {
      ctx.beginPath();
      ctx.roundRect(x, cy - 5, 24, 10, 5);
      ctx.fillStyle = STATUS_BADGES[e.status].color;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Network bus: icon, name and CIDR on one line along the bar (rotated for a vertical bus). */
  #busContent(ctx, n, r, type, color, editing) {
    const { theme: th, lod } = this;
    const horizontal = r.w >= r.h;
    ctx.save();
    let R = r;
    if (!horizontal) {
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.rotate(-Math.PI / 2);
      R = { x: -r.h / 2, y: -r.w / 2, w: r.h, h: r.w };
    }
    const cy = R.y + R.h / 2;
    const s = Math.min(18, R.h - 12);
    let x = R.x + Math.max(10, R.h / 2 - 4);
    this.#icon(ctx, type.icon, x, cy - s / 2, s, color, 2);
    x += s + 8;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `600 13px ${FONT}`;
    const label = this.#ellipsize(ctx, n.label || type.label, R.x + R.w - 14 - x);
    if (editing !== 'label') {
      ctx.fillStyle = th.text;
      ctx.fillText(label, x, cy + 0.5);
    }
    if (lod === 2) {
      const cx = x + this.#measureText(ctx, label) + 10;
      const room = R.x + R.w - 14 - cx;
      if (room > 40) {
        if (horizontal) this.#captions.set(n.id, { x: cx, y: cy - 8, w: room, h: 16, size: 11, align: 'left' });
        ctx.font = `500 11px ${MONO}`;
        ctx.fillStyle = th.muted;
        if (editing !== 'stereotype') ctx.fillText(this.#ellipsize(ctx, captionOf(n) || type.label, room), cx, cy + 0.5);
      }
    }
    ctx.restore();
  }

  #selectionRing(ctx, r, radius, ss) {
    if (ss <= 0.01) return;
    const z = this.z, pad = 3.5 / z;
    ctx.beginPath();
    ctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, radius + pad);
    ctx.lineWidth = 6 / z;
    ctx.strokeStyle = withAlpha(this.theme.accent, 0.14 * ss);
    ctx.stroke();
    ctx.lineWidth = 1.75 / z;
    ctx.strokeStyle = withAlpha(this.theme.accent, ss);
    ctx.stroke();
  }

  #drawGhosts(ctx) {
    const now = this.now;
    this.#ghosts = this.#ghosts.filter((g) => now - g.start < 180);
    for (const g of this.#ghosts) {
      const t = (now - g.start) / 180;
      const r = g.node;
      const s = 1 - 0.06 * t;
      ctx.save();
      ctx.globalAlpha = 1 - easeOut(t);
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.scale(s, s);
      ctx.translate(-r.x - r.w / 2, -r.y - r.h / 2);
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 10);
      ctx.fillStyle = this.theme.nodeFill;
      ctx.fill();
      ctx.strokeStyle = this.theme.nodeStroke;
      ctx.lineWidth = 1 / this.z;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ───────────────────────────── edges

  #drawEdge(ctx, e, route) {
    const { ed, theme: th, z, lod } = this;
    const et = this.schema.edgeTypes[e.type] ?? {};
    const { hs, ss } = this.#state(e.id, 'edge');
    const related = !this.#exporting && (ed.selection.has(e.source) || ed.selection.has(e.target));
    const rs = this.#exporting ? 0 : this.#fx.value('r' + e.id, related ? 1 : 0);
    // Link a dragged firewall (or other inline node) would be inserted into: strong highlight.
    const is = this.#exporting ? 0 : this.#fx.value('i' + e.id, ed.overlay.insertEdge === e.id ? 1 : 0, 22);
    const hi = Math.max(ss, hs * 0.75, rs * 0.6, is);
    const ap = this.#appearT(e.id);
    const width = et.width ?? 1.5;
    const lw = Math.max(width, 1 / z);
    const arrow = et.arrow ?? 'filled';
    const color = hi > 0.4 ? th.accent : e.style?.color ?? th.edge;
    const shorten = arrow === 'filled' ? 7 + lw : 0.5;

    ctx.save();
    ctx.globalAlpha = easeOut(ap) * this.#fade(e.id, 'edge');
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (hi > 0.01 && lod > 0) {
      this.#tracePath(ctx, route, shorten);
      ctx.strokeStyle = withAlpha(th.accent, 0.16 * hi + 0.14 * is);
      ctx.lineWidth = lw + (7 + 6 * is) / z;
      ctx.stroke();
    }
    this.#tracePath(ctx, route, shorten);
    if (et.dash && lod > 0) ctx.setLineDash(et.dash);
    ctx.lineWidth = lw + 0.5 * ss;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
    if ((ss > 0.5 || hs > 0.6 || is > 0.5) && lod > 0) {
      // Marching dots show direction on focused edges.
      this.#tracePath(ctx, route, shorten);
      ctx.setLineDash([0.01, 16]);
      ctx.lineDashOffset = -((this.now / 28) % 16);
      ctx.lineWidth = lw + 1.6;
      ctx.strokeStyle = th.flow;
      ctx.stroke();
      ctx.setLineDash([]);
      this.#animating = true;
    }
    if (lod > 0) this.#arrow(ctx, route, arrow, color, lw);
    ctx.restore();
  }

  /**
   * Link tag size and text: the label, with the protocol (`data.tech`) under it in monospace;
   * either one alone gives a single-line tag. Null when the link has neither.
   */
  #tag(ctx, e) {
    const count = this.#bundles.get(e.id);
    const text = count ? `${count} links` : e.label;
    const proto = count ? '' : e.data?.tech;
    if (!text && !proto) return null;
    ctx.font = `500 11.5px ${FONT}`;
    const tw = text ? Math.min(this.#measureText(ctx, text), 220) : 0;
    ctx.font = `500 10px ${MONO}`;
    const pw = proto ? Math.min(this.#measureText(ctx, proto), 220) : 0;
    return { text, proto, bundle: !!count, w: Math.max(tw, pw) + 14, h: text && proto ? 33 : 21 };
  }

  /**
   * Where each link tag goes. By default, halfway along the link; where that would cover
   * another tag or an element, the tag slides along its link to a clear spot, else the least
   * covered one (covering a tag counts more than an element's edge). Tags with the fewest
   * clear spots are placed first, so a tag with room to move doesn't take the only spot of
   * one that has none. Tags the user placed (`labelT`) and bundle counts stay put.
   * Returns Map<edgeId, {x, y}>.
   */
  #placeTags(ctx, routed) {
    // While the document doesn't change (panning, zooming, animations), tags keep their
    // places: only links coming into view are placed, around the ones already there.
    const version = this.ed.doc.version;
    let memo = this.#tagMemo;
    if (!memo || memo.version !== version) memo = this.#tagMemo = { version, placed: new Map() };
    const fresh = routed.filter(([e, r]) => memo.placed.get(e.id)?.route !== r);
    if (fresh.length) {
      const ids = new Set(fresh.map(([e]) => e.id));
      const others = [...memo.placed].filter(([id, v]) => v.rect && !ids.has(id)).map(([, v]) => v.rect);
      const spots = this.#computeTags(ctx, fresh, others);
      // Links without a tag are remembered too, so they don't count as new on every frame.
      for (const [e, route] of fresh) memo.placed.set(e.id, spots.get(e.id) ?? { route, p: null, rect: null });
    }
    return new Map(routed.map(([e]) => [e.id, memo.placed.get(e.id)?.p]));
  }

  /** Place the tags of `routed` around the `others` (tag rects already placed). Map<id, {p, rect, route}>. */
  #computeTags(ctx, routed, others = []) {
    const doc = this.ed.doc, hidden = doc.hidden();
    const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const onCards = (rect) => {
      let s = 0;
      for (const id of doc.index.query(rect)) {
        const n = doc.nodes.get(id);
        if (!hidden.has(id) && (!doc.isContainer(n) || n.collapsed || showsAsCard(doc, n)) && !isOverlay(doc, n)) s += area(n, rect);
      }
      return s;
    };
    // Beyond a few hundred tags the search costs more than it brings: keep default places.
    const crowded = routed.filter(([e]) => e.label || e.data?.tech).length > 400;
    const tags = [];
    for (const [e, route] of routed) {
      const tag = this.#tag(ctx, e);
      if (!tag) continue;
      const fixed = tag.bundle || e.style?.labelT != null || crowded;
      const spots = (fixed ? [null] : [null, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]).map((t) => {
        const p = t === null ? (tag.bundle ? route.mid : labelPoint(route, e.style?.labelT)) : labelPoint(route, t);
        const rect = { x: p.x - tag.w / 2 - 3, y: p.y - tag.h / 2 - 3, w: tag.w + 6, h: tag.h + 6 };
        return { p, rect, base: fixed ? 0 : onCards(rect) };
      });
      tags.push({ id: e.id, route, spots, fixed, free: fixed ? -1 : spots.filter((s) => !s.base).length });
    }
    tags.sort((a, b) => a.free - b.free);
    // Greedy placement, then two repair passes: each tag moves to its best spot given where
    // all the others ended up (a tag placed early may have blocked a later one needlessly).
    const chosen = new Array(tags.length).fill(null);
    const pick = (i) => {
      let best = null;
      for (const s of tags[i].spots) {
        let score = s.base;
        for (let j = 0; j < tags.length; j++) if (j !== i && chosen[j]) score += 3 * area(chosen[j].rect, s.rect);
        for (const r of others) score += 3 * area(r, s.rect);
        if (!best || score < best.score) best = { ...s, score };
        if (score === 0) break;
      }
      chosen[i] = best;
    };
    for (let i = 0; i < tags.length; i++) pick(i);
    for (let pass = 0; pass < 2 && !crowded; pass++) for (let i = 0; i < tags.length; i++) if (!tags[i].fixed) pick(i);
    return new Map(tags.map((t, i) => [t.id, { p: chosen[i].p, rect: chosen[i].rect, route: t.route }]));
  }

  /**
   * Draw a link's tag at `at` (from #placeTags). Records the tag and protocol-line rects for
   * hit testing and in-place editing.
   */
  #drawEdgeLabel(ctx, e, at) {
    this.#labels.delete(e.id);
    this.#captions.delete(e.id);
    const tag = at && this.#tag(ctx, e);
    if (!tag) return;
    const { text, proto, w, h } = tag;
    const editing = this.ed.editingId === e.id ? this.ed.editingField : null;
    const th = this.theme;
    const sel = !this.#exporting && this.ed.selection.has(e.id);
    const { x, y } = at;
    ctx.save();
    ctx.globalAlpha = 1 - 0.82 * this.#peek('f' + e.id);
    const two = !!(text && proto);
    const ly = two ? y - 7 : y, py = two ? y + 8 : y;
    this.#labels.set(e.id, { x: x - w / 2, y: y - h / 2, w, h, line: { x: x - 100, y: ly - 10, w: 200, h: 20 } });
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 7);
    ctx.fillStyle = th.labelBg;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1 / this.z);
    ctx.strokeStyle = sel ? th.accent : th.nodeStroke;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (text && editing !== 'label') {
      ctx.font = `500 11.5px ${FONT}`;
      ctx.fillStyle = sel ? th.accent : th.muted;
      ctx.fillText(this.#ellipsize(ctx, text, 220), x, ly + 0.5);
    }
    if (proto) {
      this.#captions.set(e.id, { x: x - 100, y: py - 8, w: 200, h: 16, size: 10, align: 'center', mono: true });
      if (editing !== 'tech') {
        ctx.font = `500 10px ${MONO}`;
        ctx.fillStyle = withAlpha(sel ? th.accent : th.muted, 0.85);
        ctx.fillText(this.#ellipsize(ctx, proto, 220), x, py + 0.5);
      }
    }
    ctx.restore();
  }

  #tracePath(ctx, route, shorten = 0) {
    const pts = route.points;
    const d = route.end;
    ctx.beginPath();
    if (route.kind === 'bezier') {
      const [p0, c1, c2, p3] = pts;
      ctx.moveTo(p0.x, p0.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x - d.x * shorten, p3.y - d.y * shorten);
      return;
    }
    if (route.smooth) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) ctx.lineTo(pts[i].x, pts[i].y);
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x - d.x * shorten, last.y - d.y * shorten);
      return;
    }
    const n = pts.length;
    const last = { x: pts[n - 1].x - d.x * shorten, y: pts[n - 1].y - d.y * shorten };
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n - 1; i++) {
      const p = pts[i], q = i === n - 2 ? last : pts[i + 1];
      const rad = Math.min(12, dist(pts[i - 1], p) / 2, dist(p, q) / 2);
      ctx.arcTo(p.x, p.y, q.x, q.y, rad);
    }
    ctx.lineTo(last.x, last.y);
  }

  #arrow(ctx, route, kind, color, lw) {
    if (kind === 'none') return;
    const p = route.points[route.points.length - 1];
    const d = route.end;
    const L = 9 + lw * 1.5, W = 4.5 + lw;
    const bx = p.x - d.x * L, by = p.y - d.y * L;
    const px = -d.y, py = d.x;
    ctx.beginPath();
    ctx.moveTo(bx + px * W, by + py * W);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(bx - px * W, by - py * W);
    if (kind === 'open') {
      ctx.lineWidth = lw;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // ───────────────────────────── overlays

  #worldOverlays(ctx) {
    const { ed, theme: th, z } = this;
    const doc = ed.doc;

    const nodes = ed.selectedNodeIds();
    if (nodes.length > 1 && !ed.gesture) {
      const b = doc.bounds(nodes);
      const pad = 8 / z;
      ctx.setLineDash([4 / z, 4 / z]);
      ctx.lineWidth = 1 / z;
      ctx.strokeStyle = withAlpha(th.accent, 0.7);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.setLineDash([]);
    }

    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = th.guide;
    for (const g of ed.overlay.guides) {
      ctx.beginPath();
      if (g.axis === 'x') {
        ctx.moveTo(g.pos, g.from - 12 / z);
        ctx.lineTo(g.pos, g.to + 12 / z);
      } else {
        ctx.moveTo(g.from - 12 / z, g.pos);
        ctx.lineTo(g.to + 12 / z, g.pos);
      }
      ctx.stroke();
      const s = 3 / z;
      ctx.beginPath();
      for (const m of g.marks) {
        const x = g.axis === 'x' ? g.pos : m, y = g.axis === 'x' ? m : g.pos;
        ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
        ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s);
      }
      ctx.stroke();
    }

    // Where a sliding link end can sit: ticks at the half and quarters, dots at the thirds.
    // Drawn just inside the side, clear of the arrowheads arriving outside it.
    for (const s of ed.overlay.sideMarks) {
      const { rect: r, side } = s;
      const out = sideNormal(side), n = { x: -out.x, y: -out.y };
      for (const m of s.marks) {
        const p = s.axis === 'x'
          ? { x: m.pos, y: side === 'top' ? r.y : r.y + r.h }
          : { x: side === 'left' ? r.x : r.x + r.w, y: m.pos };
        const hot = s.hot != null && Math.abs(s.hot - m.pos) < 0.01;
        ctx.strokeStyle = ctx.fillStyle = hot ? th.guide : withAlpha(th.accent, 0.75);
        ctx.beginPath();
        if (!m.third) {
          const len = (m.f === 0.5 ? 12 : 8) / z;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + n.x * len, p.y + n.y * len);
          ctx.lineWidth = (hot ? 2.5 : 2) / z;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.lineCap = 'butt';
        } else {
          ctx.arc(p.x + n.x * 9 / z, p.y + n.y * 9 / z, (hot ? 3.25 : 2.5) / z, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const seen = new Set();
    for (const g of ed.overlay.gaps) {
      const key = `${g.axis}${Math.round(g.from)}:${Math.round(g.at)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = 4 / z;
      ctx.beginPath();
      if (g.axis === 'x') {
        ctx.moveTo(g.from, g.at); ctx.lineTo(g.to, g.at);
        ctx.moveTo(g.from, g.at - t); ctx.lineTo(g.from, g.at + t);
        ctx.moveTo(g.to, g.at - t); ctx.lineTo(g.to, g.at + t);
      } else {
        ctx.moveTo(g.at, g.from); ctx.lineTo(g.at, g.to);
        ctx.moveTo(g.at - t, g.from); ctx.lineTo(g.at + t, g.from);
        ctx.moveTo(g.at - t, g.to); ctx.lineTo(g.at + t, g.to);
      }
      ctx.stroke();
      const mx = g.axis === 'x' ? (g.from + g.to) / 2 : g.at;
      const my = g.axis === 'x' ? g.at : (g.from + g.to) / 2;
      this.#pill(ctx, String(Math.round(g.size)), mx, my, th.guide, '#fff');
    }

    const m = ed.overlay.marquee;
    if (m) {
      ctx.fillStyle = withAlpha(th.accent, 0.07);
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = withAlpha(th.accent, 0.75);
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }

    const c = ed.overlay.connect;
    if (c) {
      const s = doc.nodes.get(c.sourceId);
      const t = c.targetId ? doc.nodes.get(c.targetId) : null;
      if (s) {
        const pt = { x: c.point.x, y: c.point.y, w: 0, h: 0 };
        const [a, b] = c.reverse ? [t ?? pt, s] : [s, t ?? pt];
        const route = t ? routeEdge('orthogonal', a, b, { fast: true }) : routeSimpleOrthogonal(a, b);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        this.#tracePath(ctx, route, 8);
        ctx.setLineDash([6 / z, 5 / z]);
        ctx.lineDashOffset = -((this.now / 40) % (11 / z));
        ctx.lineWidth = 2 / z;
        ctx.strokeStyle = th.accent;
        ctx.stroke();
        ctx.setLineDash([]);
        this.#arrow(ctx, route, 'filled', th.accent, 2 / z);
        ctx.restore();
        this.#animating = true;
        if (t) {
          const pad = 5 / z;
          ctx.beginPath();
          ctx.roundRect(t.x - pad, t.y - pad, t.w + pad * 2, t.h + pad * 2, 14);
          ctx.fillStyle = withAlpha(th.accent, 0.06);
          ctx.fill();
          ctx.lineWidth = 2 / z;
          ctx.strokeStyle = th.accent;
          ctx.stroke();
        }
      }
    }
  }

  #screenOverlays(ctx) {
    const { ed, theme: th } = this;
    const doc = ed.doc;
    const single = ed.singleSelected();
    const busy = ed.gesture && !ed.gesture.handle;

    if (single && doc.nodes.has(single) && !busy && !ed.editingId && !ed.readOnly && this.lod > 0) {
      const n = this.displayRect(doc.nodes.get(single));
      const a = ed.toScreen(n), b = ed.toScreen({ x: n.x + n.w, y: n.y + n.h });
      for (const [x, y] of [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]]) {
        ctx.beginPath();
        ctx.roundRect(x - 4.5, y - 4.5, 9, 9, 2.5);
        ctx.fillStyle = th.handleFill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = th.accent;
        ctx.stroke();
      }
    }

    if (single && doc.edges.has(single) && (!ed.gesture || ed.gesture.id === single) && !ed.editingId && !ed.readOnly) {
      // Route grips: segment pills (orthogonal), waypoints and insert points (straight/curved).
      for (const hd of ed.edgeHandles(single)) {
        const s = ed.toScreen(hd);
        const hot = ed.hover?.kind === hd.kind && ed.hover.id === single &&
          (hd.kind === 'waypoint' ? ed.hover.index === hd.index : ed.hover.segment === hd.segment);
        ctx.beginPath();
        if (hd.kind === 'waypoint') ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        else if (hd.insert) ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        else if (hd.axis === 'h') ctx.roundRect(s.x - 9, s.y - 3.5, 18, 7, 3.5);
        else ctx.roundRect(s.x - 3.5, s.y - 9, 7, 18, 3.5);
        ctx.globalAlpha = hd.insert && !hot ? 0.7 : 1;
        ctx.fillStyle = hot || hd.kind === 'waypoint' ? th.accent : th.handleFill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = hd.kind === 'waypoint' ? th.handleFill : th.accent;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const r = ed.router.peek(single);
      if (r) {
        for (const p of [r.points[0], r.points[r.points.length - 1]]) {
          const s = ed.toScreen(p);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = th.handleFill;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = th.accent;
          ctx.stroke();
        }
      }
    }

    // Connection ports: fade in around the hovered node, grow when targeted.
    for (const id of new Set([ed.portNode, ...this.#portFading()])) {
      if (!id || !doc.nodes.has(id)) continue;
      const vis = this.#fx.value('p' + id, ed.portNode === id ? 1 : 0, 20);
      if (vis <= 0.01) continue;
      for (const side of SIDES) {
        const hot = ed.hover?.kind === 'port' && ed.hover.id === id && ed.hover.side === side;
        const k = this.#fx.value(`p${id}${side}`, hot ? 1 : 0, 24);
        const p = ed.toScreen(ed.portPosition(id, side));
        const rad = (4.5 + 4 * k) * (0.6 + 0.4 * vis);
        ctx.globalAlpha = vis;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 3 * k, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(th.accent, 0.18 * k);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = k > 0.5 ? th.accent : th.handleFill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = th.accent;
        ctx.stroke();
        if (k > 0.3) {
          ctx.beginPath();
          const q = 3.2 * k;
          ctx.moveTo(p.x - q, p.y); ctx.lineTo(p.x + q, p.y);
          ctx.moveTo(p.x, p.y - q); ctx.lineTo(p.x, p.y + q);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  #lastPorts = [];
  #portFading() {
    const cur = this.ed.portNode;
    if (cur && !this.#lastPorts.includes(cur)) this.#lastPorts.push(cur);
    this.#lastPorts = this.#lastPorts.slice(-3);
    return this.#lastPorts.filter((id) => id !== cur);
  }

  #pill(ctx, text, x, y, bg, fg) {
    const z = this.z;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1 / z, 1 / z);
    ctx.font = `600 10.5px ${FONT}`;
    const w = this.#measureText(ctx, text) + 10;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -8.5, w, 17, 5);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }

  // ───────────────────────────── text & icons

  #icon(ctx, name, x, y, size, color, width) {
    const d = this.icons[name];
    if (!d) return;
    let p = this.#paths.get(name);
    if (!p) this.#paths.set(name, (p = new Path2D(d)));
    const s = size / 24;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    if (ctx.strokeIcon) ctx.strokeIcon(d);
    else ctx.stroke(p);
    ctx.restore();
  }

  #measureText(ctx, text) {
    const key = ctx.font + '\u0000' + text;
    let w = this.#measure.get(key);
    if (w === undefined) {
      if (this.#measure.size > 20000) this.#measure.clear();
      w = ctx.measureText(text).width;
      this.#measure.set(key, w);
    }
    return w;
  }

  #ellipsize(ctx, text, maxW) {
    if (this.#measureText(ctx, text) <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#measureText(ctx, text.slice(0, mid) + '…') <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo ? text.slice(0, lo).trimEnd() + '…' : '';
  }

  #wrap(ctx, text, maxW, maxLines) {
    const key = `${ctx.font}\u0000${Math.round(maxW)}\u0000${maxLines}\u0000${text}`;
    let lines = this.#wraps.get(key);
    if (lines) return lines;
    lines = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = cur ? cur + ' ' + word : word;
        if (!cur || this.#measureText(ctx, test) <= maxW) cur = test;
        else {
          lines.push(cur);
          cur = word;
        }
      }
      lines.push(cur);
    }
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] += '…';
    }
    lines = lines.map((l) => this.#ellipsize(ctx, l, maxW));
    if (this.#wraps.size > 5000) this.#wraps.clear();
    this.#wraps.set(key, lines);
    return lines;
  }
}

/** Points where a polyline crosses the border of rect `r` (bisection on each crossing segment). */
function borderCrossings(poly, r) {
  const inside = (p) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  const out = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const ia = inside(a);
    if (ia === inside(b)) continue;
    let lo = 0, hi = 1;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
      if (inside(p) === ia) lo = mid;
      else hi = mid;
    }
    out.push({ x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi });
  }
  return out;
}

/** Caption under a name: the element's own type label and/or technology, if any. */
function captionOf(n) {
  return [n.data?.stereotype, n.data?.tech].filter(Boolean).join(' · ');
}
