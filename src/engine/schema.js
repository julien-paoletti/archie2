/**
 * Schema helpers. A node type may declare `variants` (e.g. a boundary that is either a
 * trust boundary or a network zone); `node.data.variant` picks one, falling back to the
 * type's `defaultVariant`. Variant fields (label, color, icon, ...) override the type's.
 */
export function resolveType(schema, node) {
  const t = schema.nodeTypes?.[node?.type] ?? {};
  const v = t.variants?.[node?.data?.variant ?? t.defaultVariant];
  return v ? { ...t, ...v, typeLabel: t.label } : t;
}

const LIMITS = { items: 50000, id: 200, text: 20000, size: 200000 };

/**
 * Make diagram JSON from outside (a file, a shared link, storage) safe to load: arrays of
 * plain objects, string ids, finite geometry within bounds, bounded text, known types (unknown
 * ones fall back to the defaults), existing parents without cycles, links between existing
 * elements. Throws on something that isn't a diagram at all; otherwise repairs quietly.
 */
export function sanitizeDiagram(json, schema) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.nodes)) throw new Error('not an Archie diagram (no elements)');
  if (json.nodes.length > LIMITS.items || (json.edges?.length ?? 0) > LIMITS.items) throw new Error('too many elements');
  const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const str = (v, max = LIMITS.text) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
  const num = (v, d, lo = -LIMITS.size, hi = LIMITS.size) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const clean = (o) => JSON.parse(JSON.stringify(plain(o), (k, v) => (typeof v === 'string' ? v.slice(0, LIMITS.text) : v)));
  const ids = new Set();
  const nodes = [];
  for (const raw of json.nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const id = str(raw.id, LIMITS.id);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const type = schema.nodeTypes?.[raw.type] ? raw.type : schema.defaultNodeType;
    const t = schema.nodeTypes?.[type] ?? {};
    nodes.push({
      id, type, parent: raw.parent == null ? null : str(raw.parent, LIMITS.id),
      x: num(raw.x, 0), y: num(raw.y, 0), w: num(raw.w, t.w ?? 160, 1), h: num(raw.h, t.h ?? 80, 1),
      label: str(raw.label), data: clean(raw.data), style: clean(raw.style),
      ...(Number.isFinite(raw.z) ? { z: raw.z } : {}),
      ...(raw.collapsed ? { collapsed: true, expanded: raw.expanded && Number.isFinite(raw.expanded.w) ? { w: num(raw.expanded.w, 160, 1), h: num(raw.expanded.h, 80, 1) } : null } : {}),
    });
  }
  // Parents must exist, and following them must never come back round.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.parent != null && !byId.has(n.parent)) n.parent = null;
    const seen = new Set([n.id]);
    for (let p = n.parent; p != null; p = byId.get(p)?.parent) {
      if (seen.has(p)) {
        n.parent = null;
        break;
      }
      seen.add(p);
    }
  }
  const edges = [];
  const edgeIds = new Set();
  for (const raw of Array.isArray(json.edges) ? json.edges : []) {
    if (!raw || typeof raw !== 'object' || !byId.has(raw.source) || !byId.has(raw.target)) continue;
    const id = str(raw.id, LIMITS.id);
    if (!id || edgeIds.has(id) || ids.has(id)) continue;
    edgeIds.add(id);
    edges.push({
      id, type: schema.edgeTypes?.[raw.type] ? raw.type : schema.defaultEdgeType,
      source: raw.source, target: raw.target, label: str(raw.label), data: clean(raw.data), style: clean(raw.style),
    });
  }
  const c = json.camera;
  const camera = c && [c.x, c.y, c.zoom].every(Number.isFinite) ? { x: num(c.x, 0), y: num(c.y, 0), zoom: num(c.zoom, 1, 0.02, 8) } : null;
  return { title: json.title == null ? null : str(json.title, 300), camera, fileDirty: !!json.fileDirty, nodes, edges };
}

/** A boundary drawn as an outline only: it surrounds things without containing them. */
export function isOverlay(doc, node) {
  const n = typeof node === 'string' ? doc.nodes.get(node) : node;
  return !!n?.data?.borderOnly && !!doc.schema.nodeTypes?.[n.type]?.boundary;
}

/**
 * Boundaries an edge crosses: boundaries holding exactly one of its two ends. Containing
 * boundaries are checked through the tree (any nesting depth); border-only outlines by
 * geometry (the visible end's center inside the outline). Callers checking many edges pass
 * the `overlays` (border-only outlines) once instead of having every call scan all nodes.
 */
export function boundariesCrossed(doc, edge, overlays = null) {
  const chain = (id) => new Set([id, ...doc.ancestors(id)]);
  const a = chain(edge.source), b = chain(edge.target);
  const out = [];
  for (const id of new Set([...a, ...b])) {
    if (a.has(id) && b.has(id)) continue;
    if (id === edge.source || id === edge.target) continue;
    const n = doc.nodes.get(id);
    if (doc.schema.nodeTypes?.[n.type]?.boundary) out.push(n);
  }
  const ends = [edge.source, edge.target].map((id) => doc.nodes.get(doc.visibleAncestor(id))).filter(Boolean);
  if (ends.length === 2) {
    for (const o of overlays ?? doc.nodes.values()) {
      if (!isOverlay(doc, o) || ends.some((e) => e.id === o.id)) continue;
      const inside = ends.map((e) => {
        const c = { x: e.x + e.w / 2, y: e.y + e.h / 2 };
        return c.x > o.x && c.x < o.x + o.w && c.y > o.y && c.y < o.y + o.h;
      });
      if (inside[0] !== inside[1]) out.push(o);
    }
  }
  return out;
}

/** Nodes attached to a bus (shared network) by a link, as the visible nodes standing in for them. */
export function busMembers(doc, busId) {
  const out = new Map();
  for (const e of doc.edgesOf(busId)) {
    const other = doc.visibleAncestor(e.source === busId ? e.target : e.source);
    if (other !== busId) out.set(other, doc.nodes.get(other));
  }
  return [...out.values()].filter(Boolean);
}

/**
 * Hosting containers (`host: true`: servers, VMs, containers...) are drawn and handled as
 * ordinary cards while they are empty and card-sized. Dropping something in turns them into
 * a box; a box emptied later stays a box until it is resized back to card size.
 */
export function showsAsCard(doc, node) {
  const n = typeof node === 'string' ? doc.nodes.get(node) : node;
  const t = n && doc.schema.nodeTypes?.[n.type];
  return !!t?.host && !n.collapsed && !doc.hasChildren(n.id) && n.h <= (t.h ?? 72) * 1.5;
}
