import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { dependencies, pathsBetween } from '../src/engine/analysis.js';

const schema = { defaultNodeType: 'box', defaultEdgeType: 'link', nodeTypes: { box: {}, group: { container: true } } };

/** web → api → orders → db, api → catalog, worker → db; m holds api and orders. */
function shop() {
  const doc = new DiagramDocument(schema);
  for (const id of ['web', 'catalog', 'db', 'worker', 'lonely']) doc.addNode({ id });
  doc.addNode({ id: 'm', type: 'group' });
  doc.addNode({ id: 'api', parent: 'm' });
  doc.addNode({ id: 'orders', parent: 'm' });
  const link = (s, t) => doc.addEdge({ id: `${s}-${t}`, source: s, target: t });
  link('web', 'api');
  link('api', 'orders');
  link('orders', 'db');
  link('api', 'catalog');
  link('worker', 'db');
  return doc;
}

const sorted = (set) => [...set].sort();

test('dependencies: transitive, both directions', () => {
  const d = dependencies(shop(), 'orders');
  assert.deepEqual(sorted(d.down), ['db']);
  assert.deepEqual(sorted(d.up), ['api', 'web']);
  assert.deepEqual(sorted(d.edges), ['api-orders', 'orders-db', 'web-api']);
  assert.ok(!d.nodes.has('worker'), 'a sibling user of db is not a dependency of orders');
  assert.ok(!d.nodes.has('catalog'));
});

test('dependencies of a module are those of its contents', () => {
  const d = dependencies(shop(), 'm');
  assert.deepEqual(sorted(d.down), ['catalog', 'db']);
  assert.deepEqual(sorted(d.up), ['web']);
  assert.ok(d.edges.has('api-orders'), 'links inside the module count');
});

test('paths between two nodes, in either direction', () => {
  const doc = shop();
  const p = pathsBetween(doc, 'db', 'web');
  assert.equal(p.found, true);
  assert.deepEqual(sorted(p.nodes), ['api', 'db', 'orders', 'web']);
  assert.deepEqual(sorted(p.edges), ['api-orders', 'orders-db', 'web-api']);

  const none = pathsBetween(doc, 'worker', 'web');
  assert.equal(none.found, false);
  assert.deepEqual(sorted(none.nodes), ['web', 'worker']);
  assert.equal(none.edges.size, 0);
});

test('editor dependency focus lights containers of lit nodes and follows the selection', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  ed.doc.load(shop().toJSON());
  assert.equal(ed.dependencyFocus(), null, 'off by default');
  ed.toggleDependencies(true);
  assert.equal(ed.dependencyFocus(), null, 'nothing selected');
  ed.setSelection(['db']);
  const f = ed.dependencyFocus();
  assert.ok(f.nodes.has('m'), 'the module holding orders and api stays lit');
  assert.ok(f.nodes.has('worker') && !f.nodes.has('catalog'));
  assert.equal(ed.dependencyFocus(), f, 'cached');
  ed.escape();
  assert.equal(ed.focusDeps, true, 'first Esc deselects');
  ed.escape();
  assert.equal(ed.focusDeps, false, 'second Esc leaves the focus');
});
