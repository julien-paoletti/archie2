import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { architectureSchema } from '../src/domain/architecture.js';
import { dependencies, pathsBetween } from '../src/engine/analysis.js';
import { routeStraight, routeCurved } from '../src/engine/routing.js';
import { sanitizeDiagram } from '../src/engine/schema.js';
import { legendEntries } from '../src/engine/legend.js';
import { fromMermaid, toMermaid } from '../src/domain/formats/mermaid.js';
import { toPlantUML } from '../src/domain/formats/plantuml.js';
import { toStructurizr } from '../src/domain/formats/structurizr.js';
import { toMarkdown } from '../src/domain/formats/markdown.js';

/** api ↔ cache (both ways), web → api, api → db. */
function doc() {
  const d = new DiagramDocument(architectureSchema);
  d.addNode({ id: 'web', type: 'client', label: 'Web' });
  d.addNode({ id: 'api', type: 'service', label: 'API' });
  d.addNode({ id: 'cache', type: 'database', label: 'Cache' });
  d.addNode({ id: 'db', type: 'database', label: 'DB' });
  d.addEdge({ id: 'wa', source: 'web', target: 'api' });
  d.addEdge({ id: 'ac', source: 'api', target: 'cache', type: 'dataflow', label: 'sync', data: { bidirectional: true } });
  d.addEdge({ id: 'ad', source: 'api', target: 'db' });
  return d;
}

test('routes know their direction at both ends', () => {
  const a = { x: 0, y: 0, w: 100, h: 60 }, b = { x: 300, y: 0, w: 100, h: 60 };
  for (const r of [routeStraight(a, b), routeCurved(a, b)]) {
    assert.deepEqual([Math.round(r.start.x), Math.round(r.start.y)], [1, 0], 'out of the source');
    assert.deepEqual([Math.round(r.end.x), Math.round(r.end.y)], [1, 0], 'into the target');
  }
});

test('a link both ways is a dependency both ways', () => {
  const d = doc();
  assert.deepEqual([...dependencies(d, 'cache').down].sort(), ['api', 'db'], 'cache depends on api, so on db too');
  assert.deepEqual([...dependencies(d, 'cache').up].sort(), ['api', 'web']);
  const p = pathsBetween(d, 'cache', 'db');
  assert.equal(p.found, true, 'cache → api → db, going back along the both-ways link');
  assert.deepEqual([...p.edges].sort(), ['ac', 'ad']);
});

test('editor: switch a link between one way and both ways, in one undo step', async () => {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.load(doc().toJSON(), { fit: false });
  ed.setBidirectional(['wa', 'ad'], true);
  assert.equal(ed.doc.getEdge('wa').data.bidirectional, true);
  ed.setBidirectional(['wa'], false);
  assert.equal('bidirectional' in ed.doc.getEdge('wa').data, false, 'one way again: the flag goes');
  ed.undo();
  assert.equal(ed.doc.getEdge('wa').data.bidirectional, true);
});

test('loading keeps the flag only as a flag', () => {
  const json = doc().toJSON();
  json.edges[0].data = { bidirectional: 'yes' };
  const clean = sanitizeDiagram(json, architectureSchema);
  assert.deepEqual(clean.edges[0].data, {});
  assert.deepEqual(clean.edges[1].data, { bidirectional: true });
});

test('the legend lists a kind used both ways on its own row', () => {
  const links = legendEntries(doc()).find((s) => s.title === 'Links').entries;
  assert.deepEqual(links.map((e) => [e.label, e.both]), [['Uses', false], ['Data flow (both ways)', true]]);
});

test('exports: <--> in Mermaid and PlantUML, two relationships in Structurizr, read back from Mermaid', () => {
  const d = doc();
  const m = toMermaid(d);
  assert.match(m, /api <==>\|"sync"\| cache/);
  assert.match(m, /web --> api/);
  const back = fromMermaid(m);
  assert.deepEqual(back.edges.map((e) => [e.source, e.target, e.type, !!e.data.bidirectional]), [
    ['web', 'api', 'uses', false], ['api', 'cache', 'dataflow', true], ['api', 'db', 'uses', false],
  ]);
  assert.equal(fromMermaid('graph LR\nA <-- text --> B').edges[0].data.bidirectional, true, 'with text in the middle too');
  assert.match(toPlantUML(d), /api <-\[bold\]-> cache : sync/);
  const s = toStructurizr(d);
  assert.match(s, /api -> cache "sync"/);
  assert.match(s, /cache -> api "sync"/);
  assert.match(toMarkdown(d), /\| API \| Cache \| Data flow \(both ways\) \| sync \|/);
});
