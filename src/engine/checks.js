import { boundariesCrossed, isOverlay, resolveType } from './schema.js';

/**
 * Diagram checks: things a reviewer would point out. Each issue is
 *   { id, kind: 'node' | 'edge', severity: 'warning' | 'info', rule, message }
 * Warnings first, then suggestions, each in document order.
 */
export const RULES = {
  'crossing-protocol': { severity: 'warning', title: 'Boundary crossings without a protocol' },
  orphan: { severity: 'warning', title: 'Elements without links' },
  'duplicate-name': { severity: 'warning', title: 'Duplicate names' },
  'no-protocol': { severity: 'info', title: 'Links without a protocol' },
  unnamed: { severity: 'info', title: 'Elements with a default name' },
  'empty-module': { severity: 'info', title: 'Empty modules' },
};

export function checkDiagram(doc) {
  const schema = doc.schema;
  const issues = [];
  const add = (rule, kind, id, message) => issues.push({ id, kind, rule, severity: RULES[rule].severity, message });
  const name = (n) => n.label || resolveType(schema, n).label || n.type;
  const typeOf = (n) => schema.nodeTypes?.[n.type] ?? {};
  // Things that are drawn but are not part of the architecture itself.
  const decoration = (n) => typeOf(n).annotation || typeOf(n).shape === 'note' || typeOf(n).boundary || isOverlay(doc, n);
  const overlays = [...doc.nodes.values()].filter((n) => isOverlay(doc, n));

  for (const e of doc.edges.values()) {
    const et = schema.edgeTypes?.[e.type] ?? {};
    if (e.data?.tech || et.arrow === 'none') continue;
    const s = doc.nodes.get(e.source), t = doc.nodes.get(e.target);
    const what = `${name(s)} → ${name(t)}`;
    const trust = boundariesCrossed(doc, e, overlays).filter((b) => resolveType(schema, b).markCrossings);
    if (trust.length) add('crossing-protocol', 'edge', e.id, `${what} crosses ${trust.map(name).join(', ')}`);
    else add('no-protocol', 'edge', e.id, what);
  }

  const seen = new Map();
  for (const id of doc.order()) {
    const n = doc.nodes.get(id);
    if (decoration(n)) continue;
    const t = resolveType(schema, n);
    const container = doc.isContainer(n) && doc.hasChildren(n.id);
    if (!container && !doc.edgesOf(n.id).length) add('orphan', 'node', n.id, name(n));
    if (typeOf(n).container && !typeOf(n).host && !doc.hasChildren(n.id)) add('empty-module', 'node', n.id, name(n));
    const label = (n.label ?? '').trim();
    if (!label || label === t.label || label === typeOf(n).label) {
      add('unnamed', 'node', n.id, label || `Unnamed ${(t.label ?? n.type).toLowerCase()}`);
      continue;
    }
    const key = n.type + '\u0000' + label.toLowerCase();
    const first = seen.get(key);
    if (first === undefined) seen.set(key, n.id);
    else {
      if (first) add('duplicate-name', 'node', first, label);
      add('duplicate-name', 'node', n.id, label);
      seen.set(key, null);
    }
  }
  const rank = { warning: 0, info: 1 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
