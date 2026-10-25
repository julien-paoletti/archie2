import { boundariesCrossed, isOverlay, resolveType } from './schema.js';

/**
 * Legend content, derived from what the diagram actually uses. DOM-free, so the size of a
 * legend is known without measuring text. Entries, in sections:
 *   { kind: 'node', label, sub, icon, color, shape }    element kinds (by type label)
 *   { kind: 'boundary', label, color, dashed }          boundary kinds
 *   { kind: 'edge', label, dash, arrow, width, both }   link kinds (both: used both ways)
 *   { kind: 'marker', label, color }                    trust boundary crossings
 *   { kind: 'status', label, status, color }            status badges in use (schema.statuses)
 */
export const LEGEND = { width: 240, header: 40, section: 26, row: 24, pad: 12 };

const memo = new WeakMap();

/**
 * The legend's sections for the document as it is now: computed once per document version,
 * shared by whoever asks (the editor sizing legends, the renderer drawing them).
 * `geometryMatters` (on the result) tells whether moving things can change it: only
 * through border-only outlines, whose crossings are found by position.
 */
export function legendEntries(doc) {
  const hit = memo.get(doc);
  if (hit && (hit.sections.geometryMatters ? hit.version === doc.version : hit.content === doc.contentVersion)) return hit.sections;
  const sections = computeEntries(doc);
  memo.set(doc, { version: doc.version, content: doc.contentVersion, sections });
  return sections;
}

function computeEntries(doc) {
  const schema = doc.schema;
  const nodes = new Map(), boundaries = new Map(), edges = new Map(), statuses = new Set();
  for (const id of doc.order()) {
    const n = doc.nodes.get(id);
    const t = schema.nodeTypes?.[n.type] ?? {};
    if (t.annotation || t.shape === 'legend') continue;
    const r = resolveType(schema, n);
    if (n.data?.status) statuses.add(n.data.status);
    if (t.boundary) {
      const key = n.type + ':' + (n.data?.variant ?? t.defaultVariant ?? '');
      if (!boundaries.has(key)) boundaries.set(key, { kind: 'boundary', label: r.label, color: r.color, overlay: isOverlay(doc, n), colors: new Map() });
      tally(boundaries.get(key).colors, n.style?.color ?? r.color);
      continue;
    }
    const label = n.data?.stereotype || r.label;
    const key = n.type + ':' + label.toLowerCase();
    if (!nodes.has(key)) nodes.set(key, { kind: 'node', label, sub: n.data?.stereotype ? r.label : null, icon: r.icon, shape: t.shape ?? 'card', colors: new Map() });
    tally(nodes.get(key).colors, n.style?.color ?? r.color);
  }
  let crossings = null;
  const overlays = [...doc.nodes.values()].filter((n) => isOverlay(doc, n));
  for (const e of doc.edges.values()) {
    const et = schema.edgeTypes?.[e.type] ?? {};
    const both = !!e.data?.bidirectional && et.arrow !== 'none';
    const key = e.type + (both ? ':both' : '');
    if (!edges.has(key)) edges.set(key, { kind: 'edge', label: (et.label ?? e.type) + (both ? ' (both ways)' : ''), dash: et.dash ?? null, arrow: et.arrow ?? 'filled', width: et.width ?? 1.5, both });
    if (!crossings) {
      const b = boundariesCrossed(doc, e, overlays).find((x) => resolveType(schema, x).markCrossings);
      if (b) crossings = { kind: 'marker', label: `Crosses a ${resolveType(schema, b).label.toLowerCase()}`, color: b.style?.color ?? resolveType(schema, b).color };
    }
  }
  const pick = (e) => ({ ...e, color: top(e.colors), colors: undefined });
  const sections = [
    { title: 'Elements', entries: [...nodes.values()].map(pick) },
    { title: 'Boundaries', entries: [...boundaries.values()].map(pick) },
    { title: 'Links', entries: [...edges.values()] },
    { title: 'Markers', entries: [
      ...(crossings ? [crossings] : []),
      ...Object.entries(schema.statuses ?? {}).filter(([s]) => statuses.has(s)).map(([status, s]) => ({ kind: 'status', status, label: s.label, color: s.color })),
    ] },
  ];
  const out = sections.filter((s) => s.entries.length);
  out.geometryMatters = overlays.length > 0;
  return out;
}

/** Height a legend needs for its sections (an empty one keeps a row for its placeholder). */
export function legendHeight(sections) {
  const { header, section, row, pad } = LEGEND;
  if (!sections.length) return header + row;
  return header + sections.reduce((h, s) => h + section + s.entries.length * row, 0) + pad;
}

function tally(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** The most frequent key of a tally (first seen on ties). */
function top(map) {
  let best = null, n = -1;
  for (const [k, c] of map) if (c > n) { best = k; n = c; }
  return best;
}
