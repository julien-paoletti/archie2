import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { legendEntries, legendHeight, LEGEND } from '../src/engine/legend.js';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';

globalThis.performance ??= { now: () => Date.now() };

test('legend lists the kinds in use, by type label, with their usual colour', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.addNode({ id: 'a', type: 'service', data: { stereotype: 'Backend' } });
  doc.addNode({ id: 'b', type: 'service', data: { stereotype: 'backend' }, style: { color: '#ef4444' } });
  doc.addNode({ id: 'c', type: 'service', data: { stereotype: 'Backend' }, style: { color: '#ef4444' } });
  doc.addNode({ id: 'd', type: 'service', data: { status: 'planned' } });
  doc.addNode({ id: 't', type: 'text', label: 'not listed' });
  doc.addNode({ id: 'l', type: 'legend' });
  doc.addEdge({ source: 'a', target: 'b', type: 'async' });
  doc.addEdge({ source: 'b', target: 'c', type: 'async' });
  const sections = legendEntries(doc);
  assert.deepEqual(sections.map((s) => s.title), ['Elements', 'Links', 'Markers']);
  const [elements, links, markers] = sections;
  assert.deepEqual(elements.entries.map((e) => [e.label, e.sub, e.color]), [
    ['Backend', 'Service', '#ef4444'],
    ['Service', null, '#14b8a6'],
  ]);
  assert.deepEqual(links.entries.map((e) => [e.label, e.dash?.length > 0]), [['Async', true]]);
  assert.deepEqual(markers.entries.map((e) => e.label), ['Planned']);
  assert.equal(legendHeight(sections), LEGEND.header + 3 * LEGEND.section + 4 * LEGEND.row + LEGEND.pad);
});

test('the sample architecture legend shows boundaries and trust crossings', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.load(sampleDiagram());
  const sections = Object.fromEntries(legendEntries(doc).map((s) => [s.title, s.entries.map((e) => e.label)]));
  assert.deepEqual(sections.Boundaries, ['Network zone', 'Trust boundary']);
  assert.deepEqual(sections.Markers, ['Crosses a trust boundary']);
  assert.ok(sections.Elements.includes('Database'));
});

test('a legend keeps its height in step with the diagram, outside the undo history', async () => {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  const legend = ed.createNode('legend', { x: 0, y: 0 });
  const h0 = ed.doc.getNode(legend.id).h;
  assert.equal(h0, legendHeight([]), 'empty');
  ed.createNode('service', { x: 400, y: 0 });
  const h1 = ed.doc.getNode(legend.id).h;
  assert.equal(h1, LEGEND.header + LEGEND.section + LEGEND.row + LEGEND.pad, 'one section, one row');
  ed.undo();
  assert.equal(ed.doc.getNode(legend.id).h, h0, 'undo shrinks it back');
  assert.equal(ed.history.undoStack.length, 1, 'only the legend creation is in the history');
});
