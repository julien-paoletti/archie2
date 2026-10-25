import { resolveType } from '../../engine/schema.js';

/**
 * Helpers shared by the text formats (Mermaid, PlantUML, Structurizr, Markdown). DOM-free.
 */

/** Elements worth exporting: everything but free text and legends (they describe the drawing). */
export function exported(doc, n) {
  const t = doc.schema.nodeTypes?.[n.type] ?? {};
  return !(t.annotation || t.shape === 'legend');
}

/** Does the node draw as a box holding others (module, boundary, host with content)? */
export function isGroup(doc, n) {
  return doc.isContainer(n) && doc.hasChildren(n.id);
}

/**
 * Readable, unique identifiers for the format's syntax, derived from names
 * ("Order Service" → order_service, then order_service_2...). `valid` checks a candidate.
 */
export function identifiers(doc, { reserved = [] } = {}) {
  const used = new Set(reserved.map((r) => r.toLowerCase()));
  const ids = new Map();
  for (const id of doc.order()) {
    const n = doc.nodes.get(id);
    let base = slug(n.label || resolveType(doc.schema, n).label || n.type) || 'element';
    if (/^[0-9]/.test(base)) base = 'n_' + base;
    let candidate = base;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base}_${i}`;
    used.add(candidate.toLowerCase());
    ids.set(id, candidate);
  }
  return ids;
}

/** Lowercase ASCII word characters joined by underscores; accents folded. */
export function slug(text) {
  return String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** Children in drawing order, keeping only exported ones. */
export function kids(doc, parentId) {
  return doc.children(parentId).filter((n) => exported(doc, n));
}

/** Name, kind label and technology of an element, as plain strings. */
export function describe(doc, n) {
  const t = resolveType(doc.schema, n);
  return {
    name: n.label || t.label || n.type,
    kind: n.data?.stereotype || t.label || n.type,
    typeLabel: t.label ?? n.type,
    tech: n.data?.tech ?? '',
    description: n.data?.description ?? '',
  };
}
