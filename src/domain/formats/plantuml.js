import { resolveType } from '../../engine/schema.js';
import { describe, exported, identifiers, isGroup, kids } from './shared.js';

/**
 * PlantUML component / deployment diagram. Element kinds map to PlantUML elements
 * (actor, database, queue, cloud...), boxes holding others to packages (modules), dashed
 * rectangles (boundaries) or nodes (hosts), link kinds to arrow styles.
 */

const LEAF = {
  actor: 'actor', database: 'database', queue: 'queue', external: 'cloud', client: 'component',
  service: 'component', component: 'component', application: 'component', firewall: 'rectangle',
  network: 'rectangle', note: 'note', server: 'node', vm: 'node', container: 'node',
};
const ARROWS = { uses: '-->', dataflow: '-[bold]->', async: '..>', association: '--', attachment: '--' };

/** A name as a quoted PlantUML string (no way to escape a double quote: use a single one). */
const q = (s) => `"${String(s).replace(/"/g, "'").replace(/\n/g, '\\n')}"`;

export function toPlantUML(doc, { title = '', direction = 'LR' } = {}) {
  const ids = identifiers(doc);
  const lines = ['@startuml'];
  if (title) lines.push(`title ${String(title).replace(/\n/g, ' ')}`);
  if (direction !== 'TB') lines.push('left to right direction');
  lines.push('skinparam componentStyle rectangle', 'skinparam shadowing false', '');
  const node = (n, pad) => {
    const d = describe(doc, n);
    const t = resolveType(doc.schema, n);
    const id = ids.get(n.id);
    const name = d.tech ? `${d.name}\\n<size:10>${d.tech.replace(/"/g, "'")}</size>` : d.name;
    if (n.type === 'note') {
      lines.push(`${pad}note ${q(d.name)} as ${id}`);
      return;
    }
    if (isGroup(doc, n)) {
      const kw = t.boundary ? 'rectangle' : t.host ? 'node' : 'package';
      lines.push(`${pad}${kw} ${q(name)} as ${id} <<${d.kind}>>${t.boundary ? ' #line.dashed' : ''} {`);
      for (const k of kids(doc, n.id)) node(k, pad + '  ');
      lines.push(`${pad}}`);
      return;
    }
    lines.push(`${pad}${LEAF[n.type] ?? 'component'} ${q(name)} as ${id}${d.kind !== d.typeLabel ? ` <<${d.kind}>>` : ''}`);
  };
  for (const n of kids(doc, null)) node(n, '');
  lines.push('');
  for (const e of doc.edges.values()) {
    const s = doc.nodes.get(e.source), t = doc.nodes.get(e.target);
    if (!exported(doc, s) || !exported(doc, t)) continue;
    const text = [e.label, e.data?.tech].filter(Boolean).join(' · ').replace(/\n/g, ' ');
    lines.push(`${ids.get(e.source)} ${ARROWS[e.type] ?? '-->'} ${ids.get(e.target)}${text ? ` : ${text}` : ''}`);
  }
  lines.push('@enduml');
  return lines.join('\n') + '\n';
}
