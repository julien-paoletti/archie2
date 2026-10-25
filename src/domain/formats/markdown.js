import { describe, exported, kids } from './shared.js';

/**
 * Element catalog in Markdown: one table of elements (with where they sit, owner, status,
 * description and links) and one of links. Meant for docs, wikis and pull requests.
 */

/** A table cell: pipes escaped, line breaks as <br>. */
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>').trim();

export function toMarkdown(doc, { title = 'Architecture' } = {}) {
  const out = [`# ${cell(title)}`, ''];
  const rows = [];
  const walk = (parentId, path) => {
    for (const n of kids(doc, parentId)) {
      if (n.type === 'note') continue;
      const d = describe(doc, n);
      rows.push([d.name, d.kind, d.tech, path.join(' › '), n.data?.owner, doc.schema.statuses?.[n.data?.status]?.label ?? '', d.description,
        (n.data?.links ?? []).map((l) => `<${l}>`).join(' ')]);
      walk(n.id, [...path, d.name]);
    }
  };
  walk(null, []);
  out.push('## Elements', '', '| Name | Kind | Technology | In | Owner | Status | Description | Links |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) out.push('| ' + r.map(cell).join(' | ') + ' |');

  const name = (id) => describe(doc, doc.nodes.get(id)).name;
  const links = [...doc.edges.values()].filter((e) => exported(doc, doc.nodes.get(e.source)) && exported(doc, doc.nodes.get(e.target)));
  if (links.length) {
    out.push('', '## Links', '', '| From | To | Kind | Label | Protocol |', '|---|---|---|---|---|');
    for (const e of links) {
      const kind = doc.schema.edgeTypes?.[e.type]?.label ?? e.type;
      out.push('| ' + [name(e.source), name(e.target), kind, e.label, e.data?.tech].map(cell).join(' | ') + ' |');
    }
  }
  return out.join('\n') + '\n';
}
