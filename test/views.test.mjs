import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';

globalThis.performance ??= { now: () => Date.now() };

const sorted = (set) => [...set].sort();

test('a scoped document shows a module, its contents and their direct neighbours', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.load(sampleDiagram());
  doc.setScope('data');
  const shown = [...doc.nodes.keys()].filter((id) => !doc.hidden().has(id));
  assert.deepEqual(sorted(shown), ['bus', 'catalog', 'data', 'notify', 'orders', 'ordersdb', 'search']);
  assert.deepEqual(sorted(doc.context()), ['catalog', 'notify', 'orders'], 'neighbours outside are context');
  doc.setScope(null);
  assert.equal(doc.hidden().size, 0);
  assert.equal(doc.context().size, 0);
});

test('collapsing above the view does not hide it; collapsed neighbours stand in as context', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.load(sampleDiagram());
  doc.update('vpc', { collapsed: true });
  doc.update('experience', { collapsed: true });
  doc.setScope('platform');
  assert.ok(!doc.hidden().has('gateway'), 'inside the view, even though the VPC above is collapsed');
  assert.equal(doc.visibleAncestor('orders'), 'orders', 'not the collapsed VPC');
  assert.ok(doc.context().has('experience'), 'web and mobile are inside a collapsed module: it stands in');
  assert.ok(doc.hidden().has('web'));
});

async function editor() {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1400, 900);
  ed.load(sampleDiagram(), { fit: false });
  ed.autoLayout({ history: false, animate: false, fit: false });
  return ed;
}

test('editor views: open, what can be picked, where new things go, up and out', async () => {
  const ed = await editor();
  assert.equal(ed.canOpenView('platform'), true);
  assert.equal(ed.canOpenView('orders'), false, 'not a box');
  const views = [];
  ed.on('view', (v) => views.push(v));
  ed.openView('platform', { animate: false });
  assert.equal(ed.viewRoot, 'platform');
  assert.deepEqual(ed.viewPath(), ['vpc', 'platform']);
  assert.ok(ed.isContext('ordersdb') && !ed.isContext('orders'));

  ed.selectAll();
  assert.ok(!ed.selection.has('customer'), 'hidden things are not selectable');
  assert.ok(ed.selection.has('e_web_gateway'), 'links to context are');
  assert.ok(!ed.selection.has('e_customer_web'), 'links between hidden things are not');

  // Created outside every box: goes into the view's module, not out of sight.
  const far = { x: ed.doc.getNode('platform').x - 600, y: ed.doc.getNode('platform').y };
  const n = ed.createNode('component', far);
  assert.equal(n.parent, 'platform');
  assert.ok(!ed.doc.hidden().has(n.id));

  // Auto layout arranges the view's module.
  const before = { ...ed.doc.getNode('customer') };
  ed.setSelection([]);
  ed.autoLayout({ animate: false, fit: false });
  assert.deepEqual({ ...ed.doc.getNode('customer') }, before, 'outside the view: untouched');

  // Up a level, then the whole diagram.
  ed.escape();
  assert.equal(ed.viewRoot, 'vpc', 'Esc goes up to the enclosing box');
  assert.deepEqual([...ed.selection], ['platform'], 'and selects where you came from');
  ed.setSelection([]);
  ed.escape();
  assert.equal(ed.viewRoot, null);
  assert.deepEqual(views, ['platform', 'vpc', null]);
});

test('editor views: context is moved but never re-parented; losing the module closes the view', async () => {
  const { DragGesture } = await import('../src/editor/gestures.js');
  const ed = await editor();
  ed.openView('data', { animate: false });
  ed.camera.set({ x: 0, y: 0, zoom: 1 });
  const orders = { ...ed.doc.getNode('orders') };
  ed.setSelection(['orders']);
  const g = new DragGesture(ed, { world: { x: orders.x + 10, y: orders.y + 10 } });
  g.move({ ...ed.toScreen({ x: orders.x - 300, y: orders.y + 10 }) });
  g.up();
  assert.equal(ed.doc.getNode('orders').parent, 'platform', 'still in its own module');
  assert.ok(ed.doc.getNode('orders').x < orders.x, 'but moved');

  ed.reveal('customer');
  assert.equal(ed.viewRoot, null, 'revealing something outside leaves the view');
  ed.openView('data', { animate: false });
  ed.doc.transact('x', () => ed.doc.remove(['data']));
  assert.equal(ed.viewRoot, null, 'deleting the module closes its view');
  ed.undo();
  assert.equal(ed.viewRoot, null, 'and undo does not reopen it');
});
