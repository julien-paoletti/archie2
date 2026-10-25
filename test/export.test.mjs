import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';
import { toMermaid } from '../src/domain/formats/mermaid.js';

const sorted = (set) => [...set].sort();

async function editor() {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1400, 900);
  ed.load(sampleDiagram(), { fit: false });
  return ed;
}

test('with nothing selected, an export covers the whole diagram', async () => {
  const ed = await editor();
  assert.equal(ed.exportScope(), null);
  assert.equal(ed.exportDocument(), ed.doc);
});

test('a selection exports its elements, their contents and the links among them', async () => {
  const ed = await editor();
  ed.setSelection(['data', 'orders']);
  const scope = ed.exportScope();
  assert.deepEqual(sorted(scope.nodes), ['bus', 'data', 'orders', 'ordersdb', 'search']);
  assert.deepEqual(sorted(scope.edges), ['e_orders_bus', 'e_orders_ordersdb'], 'not catalog → search: catalog is outside');
});

test('a selected link brings its two ends along', async () => {
  const ed = await editor();
  ed.setSelection(['e_payments_stripe']);
  const scope = ed.exportScope();
  assert.deepEqual(sorted(scope.nodes), ['payments', 'stripe']);
  assert.deepEqual(sorted(scope.edges), ['e_payments_stripe']);
});

test('text exports of a selection read a copy: elements lifted out of unselected boxes, the diagram untouched', async () => {
  const ed = await editor();
  const before = ed.doc.nodes.size;
  ed.setSelection(['orders', 'ordersdb']);
  const doc = ed.exportDocument();
  assert.notEqual(doc, ed.doc);
  assert.deepEqual(sorted(doc.nodes.keys()), ['orders', 'ordersdb']);
  assert.equal(doc.nodes.get('orders').parent, null, 'its module is not exported');
  assert.equal(ed.doc.nodes.get('orders').parent, 'platform');
  assert.equal(ed.doc.nodes.size, before);
  const m = toMermaid(doc);
  assert.match(m, /order_service/);
  assert.doesNotMatch(m, /subgraph|catalog/);
});
