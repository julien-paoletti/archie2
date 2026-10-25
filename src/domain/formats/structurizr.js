import { describe, identifiers, isGroup, kids } from './shared.js';

/**
 * Structurizr DSL (C4 model). Archie nests freely, C4 doesn't, so the mapping is:
 *   actor → person; top-level module → software system, its contents → containers
 *   (deeper boxes become groups); other top-level elements → software systems (external
 *   ones tagged "External"); top-level boundaries and hosts → groups.
 * Links between mapped elements become relationships (label, protocol as technology).
 * Views: a system landscape plus a container view per software system with contents.
 */

const TAGS = { database: 'Database', document: 'Document', queue: 'Queue', external: 'External', actor: 'Person', client: 'Client' };

/** A string in the DSL: double quotes and backslashes escaped, one line. */
const s = (v) => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

export function toStructurizr(doc, { title = 'Architecture', direction = 'LR' } = {}) {
  const ids = identifiers(doc, { reserved: ['workspace', 'model', 'views', 'person', 'group', 'element', 'styles'] });
  const lines = [`workspace ${s(title)} {`, '  model {'];
  const mapped = new Set();
  const systems = [];

  const tagsOf = (n) => {
    const tag = TAGS[n.type];
    const status = doc.schema.statuses?.[n.data?.status]?.label ?? null;
    return [tag, status].filter(Boolean);
  };
  const props = (n, pad) => {
    const tags = tagsOf(n);
    const out = [];
    if (tags.length) out.push(`${pad}tags ${tags.map(s).join(' ')}`);
    if (n.data?.owner) out.push(`${pad}properties {`, `${pad}  "Owner" ${s(n.data.owner)}`, `${pad}}`);
    const url = (n.data?.links ?? [])[0];
    if (url) out.push(`${pad}url ${s(/^[a-z]+:/i.test(url) ? url : 'https://' + url)}`);
    return out;
  };
  const element = (keyword, n, pad, withTech) => {
    const d = describe(doc, n);
    const head = `${pad}${ids.get(n.id)} = ${keyword} ${s(d.name)} ${s(d.description)}${withTech ? ' ' + s(d.tech) : ''}`;
    const body = props(n, pad + '  ');
    lines.push(body.length ? head + ' {' : head, ...body, ...(body.length ? [`${pad}}`] : []));
    mapped.add(n.id);
  };
  // Groups can't nest without extra configuration: a box inside a group just adds its contents.
  const group = (n, pad, inGroup, body) => {
    if (inGroup) return body(pad);
    lines.push(`${pad}group ${s(describe(doc, n).name)} {`);
    body(pad + '  ');
    lines.push(`${pad}}`);
  };
  /** Contents of a software system: containers; boxes inside it become groups. */
  const contents = (parentId, pad, inGroup = false) => {
    for (const k of kids(doc, parentId)) {
      if (k.type === 'note') continue;
      if (isGroup(doc, k)) group(k, pad, inGroup, (p) => contents(k.id, p, true));
      else element('container', k, pad, true);
    }
  };
  const top = (parentId, pad, inGroup = false) => {
    for (const n of kids(doc, parentId)) {
      const t = doc.schema.nodeTypes?.[n.type] ?? {};
      if (n.type === 'note') continue;
      if (n.type === 'actor') element('person', n, pad, false);
      else if (isGroup(doc, n) && (t.boundary || t.host)) group(n, pad, inGroup, (p) => top(n.id, p, true));
      else if (isGroup(doc, n)) {
        const d = describe(doc, n);
        lines.push(`${pad}${ids.get(n.id)} = softwareSystem ${s(d.name)} ${s(d.description)} {`);
        lines.push(...props(n, pad + '  '));
        contents(n.id, pad + '  ');
        lines.push(`${pad}}`);
        mapped.add(n.id);
        systems.push(n.id);
      } else element('softwareSystem', n, pad, false);
    }
  };
  top(null, '    ');

  // Relationships: source -> destination "description" "technology" "tags", trailing parts optional.
  lines.push('');
  for (const e of doc.edges.values()) {
    if (!mapped.has(e.source) || !mapped.has(e.target)) continue;
    // C4 forbids relationships between an element and what contains it.
    if (doc.isAncestor(e.source, e.target) || doc.isAncestor(e.target, e.source)) continue;
    const parts = [e.label ?? '', e.data?.tech ?? '', e.type === 'async' ? 'Asynchronous' : ''];
    while (parts.length && !parts.at(-1)) parts.pop();
    const rest = parts.map((p) => ' ' + s(p)).join('');
    lines.push(`    ${ids.get(e.source)} -> ${ids.get(e.target)}${rest}`);
    // C4 relationships go one way: a link both ways is one each way.
    if (e.data?.bidirectional) lines.push(`    ${ids.get(e.target)} -> ${ids.get(e.source)}${rest}`);
  }
  const layout = `autoLayout ${direction === 'TB' ? 'tb' : 'lr'}`;
  lines.push('  }', '', '  views {', '    systemLandscape {', '      include *', `      ${layout}`, '    }');
  for (const id of systems) lines.push(`    container ${ids.get(id)} {`, '      include *', `      ${layout}`, '    }');
  lines.push(
    '    styles {',
    '      element "Person" {', '        shape Person', '      }',
    '      element "Database" {', '        shape Cylinder', '      }',
    '      element "Queue" {', '        shape Pipe', '      }',
    '      element "External" {', '        background #94a3b8', '      }',
    '      element "Deprecated" {', '        border dashed', '      }',
    '    }',
    '  }',
    '}',
  );
  return lines.join('\n') + '\n';
}
