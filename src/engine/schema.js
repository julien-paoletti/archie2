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
