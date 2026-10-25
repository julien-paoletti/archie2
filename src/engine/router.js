import { routeEdge, routeManual, routeToBus, separateSegments, spreadPorts } from './routing.js';
import { boundsOf, center, inflate, intersects, union } from './geometry.js';

const ROUTE_KEYS = ['x', 'y', 'w', 'h', 'parent'];

/**
 * Caches edge routes and invalidates them precisely: an edge is re-routed when one of its
 * endpoints changes, or when a node moves through (or out of) the area its route covers.
 *
 * Full obstacle-avoiding routing is time-budgeted per frame: over budget, a cheap route is
 * returned and `pending` is raised so the renderer refines on the next frame.
 * In `live` mode (during a drag) routes merely crossed by moving nodes are kept until the
 * gesture ends, so dragging stays smooth on large diagrams.
 */
export class EdgeRouter {
  pending = false;
  #cache = new Map();
  #stale = new Set();
  #live = false;
  #deadline = Infinity;
  #display = new Map();
  #lastSpread = { routes: [], result: new Map() };

  constructor(doc, { margin = 20, maxObstacles = 40 } = {}) {
    this.doc = doc;
    this.margin = margin;
    this.maxObstacles = maxObstacles;
    doc.on('change', (e) => this.#onChange(e));
    // A view changes what stands in for what (collapsed modules above it no longer do).
    doc.on('scope', () => this.#onChange({ reset: true }));
  }

  beginFrame(budgetMs) {
    this.#deadline = performance.now() + budgetMs;
    this.pending = false;
  }

  endFrame() {
    this.#deadline = Infinity;
  }

  setLive(on) {
    this.#live = on;
    if (!on) {
      for (const id of this.#stale) this.#cache.delete(id);
      this.#stale.clear();
    }
  }

  /** The route as displayed (after port spreading and lane separation), else the raw cached route. */
  peek(id) {
    return this.#display.get(id) ?? this.#cache.get(id)?.route ?? null;
  }

  /**
   * Display pass over a set of routed edges (the ones on screen): fan out ends sharing a node
   * side, then separate segments sharing a corridor. entries: [{ edge, route }].
   * Returns Map<edgeId, adjusted route>; memoized on route identity.
   */
  spread(entries) {
    const last = this.#lastSpread;
    if (entries.length === last.routes.length && entries.every((e, i) => e.route === last.routes[i])) return last.result;
    const items = entries.map(({ edge, route }) => {
      const sourceId = this.doc.visibleAncestor(edge.source), targetId = this.doc.visibleAncestor(edge.target);
      return { id: edge.id, route, sourceId, targetId, source: this.doc.nodes.get(sourceId), target: this.doc.nodes.get(targetId) };
    });
    const result = spreadPorts(items);
    const all = new Map(entries.map(({ edge, route }) => [edge.id, result.get(edge.id) ?? route]));
    for (const [id, r] of separateSegments(all)) result.set(id, r);
    this.#lastSpread = { routes: entries.map((e) => e.route), result };
    this.#display = result;
    return result;
  }

  get(id, { fast = false } = {}) {
    const edge = this.doc.edges.get(id);
    if (!edge) return null;
    const cached = this.#cache.get(id);
    if (cached && (!cached.fast || fast)) return cached.route;
    const full = !fast && performance.now() < this.#deadline;
    if (!fast && !full) this.pending = true;
    if (cached && !full) return cached.route;
    const route = this.compute(edge, { fast: !full });
    const exact = (edge.style?.routing ?? 'orthogonal') !== 'orthogonal' || !!route.manual;
    this.#cache.set(id, { route, fast: !full && !exact });
    return route;
  }

  /**
   * Route an edge without caching. Ends inside a collapsed module attach to the module.
   * `rects` overrides endpoint geometry (used by animations).
   */
  compute(edge, { fast = false, rects = null } = {}) {
    const sid = this.doc.visibleAncestor(edge.source), tid = this.doc.visibleAncestor(edge.target);
    const s = rects?.source ?? this.doc.nodes.get(sid);
    const t = rects?.target ?? this.doc.nodes.get(tid);
    const mode = edge.style?.routing ?? 'orthogonal';
    if (sid === tid) return routeEdge(mode, s, s, { self: true });
    const points = edge.style?.points;
    // A hand-made shape, unless it went stale (then: automatic routing below).
    if (points?.length) {
      const manual = routeManual(mode, s, t, points);
      if (manual) return manual;
    }
    // Links to a bus (shared network) drop straight onto it, wherever the member sits.
    const shape = (id) => this.doc.schema.nodeTypes?.[this.doc.nodes.get(id)?.type]?.shape;
    if (mode === 'orthogonal') {
      if (shape(tid) === 'bus') return routeToBus(s, t, true);
      if (shape(sid) === 'bus') return routeToBus(t, s, false);
    }
    const obstacles = fast || mode !== 'orthogonal' ? [] : this.#obstacles(sid, tid, s, t);
    return routeEdge(mode, s, t, { obstacles, fast, margin: this.margin });
  }

  #obstacles(sid, tid, s, t) {
    const doc = this.doc;
    const hidden = doc.hidden();
    const ignore = new Set([sid, tid, ...doc.ancestors(sid), ...doc.ancestors(tid)]);
    const ids = doc.index.query(inflate(union(s, t), 160))
      .filter((id) => {
        const n = doc.nodes.get(id);
        return !ignore.has(id) && !hidden.has(id) && !n.data?.borderOnly && !doc.schema.nodeTypes?.[n.type]?.annotation;
      });
    const candidates = new Set(ids);
    let out = [];
    for (const id of ids) {
      if (doc.isAncestor(sid, id) || doc.isAncestor(tid, id)) continue;
      // Nodes inside an obstacle container are already covered by it.
      if (doc.ancestors(id).some((a) => candidates.has(a))) continue;
      out.push(doc.nodes.get(id));
    }
    if (out.length > this.maxObstacles) {
      const c = center(union(s, t));
      const d = (n) => Math.hypot(n.x + n.w / 2 - c.x, n.y + n.h / 2 - c.y);
      out = out.sort((a, b) => d(a) - d(b)).slice(0, this.maxObstacles);
    }
    return out;
  }

  #onChange({ patch, reset }) {
    if (reset) {
      this.#display.clear();
      this.#cache.clear();
      this.#stale.clear();
      return;
    }
    if (patch.ops.some((op) => op.t === 'set' && 'collapsed' in op.after)) {
      // Collapsing re-targets edges to proxies and changes obstacles: start over.
      this.#display.clear();
      this.#cache.clear();
      this.#stale.clear();
      return;
    }
    const dirty = [];
    for (const op of patch.ops) {
      if (op.k === 'flow') continue;
      if (op.k === 'edge') {
        this.#cache.delete(op.id);
        continue;
      }
      if (op.t === 'set') {
        if (!ROUTE_KEYS.some((k) => k in op.after)) continue;
        const n = this.doc.nodes.get(op.id);
        if (n) dirty.push({ x: n.x, y: n.y, w: n.w, h: n.h }, { x: n.x, y: n.y, w: n.w, h: n.h, ...pickGeom(op.before) });
      } else {
        dirty.push(op.v);
      }
      for (const e of this.doc.edgesOf(op.id)) this.#cache.delete(e.id);
    }
    if (!dirty.length) return;
    const area = inflate(boundsOf(dirty), this.margin);
    for (const [id, c] of this.#cache) {
      const bb = inflate(c.route.bbox, this.margin);
      if (!intersects(bb, area) || !dirty.some((r) => intersects(bb, r))) continue;
      if (this.#live) this.#stale.add(id);
      else this.#cache.delete(id);
    }
  }
}

function pickGeom(o) {
  const out = {};
  for (const k of ['x', 'y', 'w', 'h']) if (k in o) out[k] = o[k];
  return out;
}
