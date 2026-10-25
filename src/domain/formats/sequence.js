import { describe, identifiers } from './shared.js';

/**
 * A flow as a Mermaid sequence diagram: each element on the way becomes a participant (people
 * as actors), each step a message (a response step: a dashed reply), in order.
 */
export function flowToMermaidSequence(doc, flowId) {
  const flow = doc.flows.get(flowId);
  if (!flow) throw new Error('No such flow');
  const ids = identifiers(doc);
  const lines = ['sequenceDiagram'];
  if (flow.name) lines.push(`  title ${flow.name.replace(/\n/g, ' ')}`);
  const seen = new Set();
  const steps = flow.steps.map((s) => ({ s, e: doc.edges.get(s.edge) })).filter((x) => x.e);
  for (const { s, e } of steps) {
    for (const id of s.reverse ? [e.target, e.source] : [e.source, e.target]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const n = doc.nodes.get(id);
      const name = describe(doc, n).name.replace(/[;#\n]/g, ' ');
      lines.push(`  ${n.type === 'actor' ? 'actor' : 'participant'} ${ids.get(id)} as ${name}`);
    }
  }
  for (const { s, e } of steps) {
    const [from, to] = s.reverse ? [e.target, e.source] : [e.source, e.target];
    const arrow = s.reverse ? '-->>' : e.type === 'async' ? '-)' : '->>';
    const text = (s.label || e.label || e.data?.tech || '').replace(/[;#\n]/g, ' ');
    lines.push(`  ${ids.get(from)}${arrow}${ids.get(to)}: ${text}`);
  }
  return lines.join('\n') + '\n';
}
