import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectureSchema } from '../src/domain/architecture.js';

globalThis.performance ??= { now: () => Date.now() };

async function editor() {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1200, 800);
  ed.camera.set({ x: 0, y: 0, zoom: 1 });
  ed.doc.addNode({ id: 'a', type: 'service', x: 100, y: 100, w: 200, h: 72 });
  ed.doc.addNode({ id: 'b', type: 'service', x: 500, y: 100, w: 200, h: 72 });
  ed.doc.addEdge({ id: 'e', source: 'a', target: 'b' });
  ed.setReadOnly(true);
  return ed;
}

const drag = (ed, from, to) => {
  ed.pointerDown({ ...from, button: 0 });
  ed.pointerMove({ ...to, button: 0 });
  ed.pointerUp({ ...to, button: 0 });
};

test('read-only: selecting and panning work, nothing changes the diagram', async () => {
  const ed = await editor();
  const v0 = ed.doc.version;
  // Click selects; dragging a node pans the view instead of moving it.
  ed.pointerDown({ x: 200, y: 136, button: 0 });
  ed.pointerUp({ x: 200, y: 136, button: 0 });
  assert.deepEqual([...ed.selection], ['a']);
  const cam = ed.camera.x;
  drag(ed, { x: 200, y: 136 }, { x: 260, y: 136 });
  assert.equal(ed.doc.getNode('a').x, 100, 'the node stayed');
  assert.ok(ed.camera.x < cam, 'the view moved');
  // Keys that edit do nothing; view keys still work.
  for (const key of ['Delete', 'Enter', 'Tab', 'l', 'c']) ed.keyDown({ key, code: '' });
  ed.run('edit.delete');
  ed.editLabel('a');
  ed.doubleClick({ x: 900, y: 600, button: 0 });
  assert.equal(ed.editingId, null);
  assert.equal(ed.doc.version, v0, 'no change at all');
  assert.equal(ed.doc.nodes.size, 2);
  ed.keyDown({ key: 'd', code: 'KeyD' });
  assert.equal(ed.focusDeps, true, 'view commands run');
  assert.equal(ed.allowed({ group: 'Edit' }), false);
  assert.equal(ed.allowed({ group: 'File', readOnly: true }), true);
});

test('read-only: Esc deselects, leaves the focus, then asks the app to stop presenting', async () => {
  const ed = await editor();
  const asked = [];
  ed.on('escape', () => asked.push(true));
  ed.setSelection(['a']);
  ed.toggleDependencies(true);
  ed.escape();
  ed.escape();
  assert.equal(asked.length, 0);
  ed.escape();
  assert.equal(asked.length, 1);
  ed.setReadOnly(false);
  drag(ed, { x: 200, y: 136 }, { x: 260, y: 136 });
  assert.ok(ed.doc.getNode('a').x > 100, 'editing again once read-only is off');
});

test('read-only: the document itself refuses edits, whatever path they take', async () => {
  const ed = await editor();
  ed.setReadOnly(false);
  ed.doc.addNode({ id: 'm', type: 'module', x: 0, y: 300, w: 400, h: 200 });
  ed.doc.transact('x', () => ed.doc.update('a', { parent: 'm' }));
  ed.setReadOnly(true);
  const v0 = ed.doc.version;
  ed.setSelection(['a', 'b']);
  ed.setStyle(['a'], { color: '#ef4444' });
  ed.moveNodes(['a'], 50, 0);
  ed.deleteSelection();
  assert.equal(ed.group(), undefined);
  assert.equal(ed.createNode('service', { x: 0, y: 0 }), null);
  assert.equal(ed.quickAdd('a'), null);
  assert.deepEqual(ed.importModel({ nodes: [{ id: 'z' }], edges: [] }), []);
  assert.equal(ed.createFlow(), null);
  ed.setData('a', 'owner', 'me');
  ed.reverseEdges(['e']);
  assert.equal(ed.doc.version, v0, 'nothing changed');
  ed.toggleCollapse(['m']);
  assert.equal(ed.doc.getNode('m').collapsed, true, 'collapsing (to look) still works');
  ed.setReadOnly(false);
  ed.setStyle(['a'], { color: '#ef4444' });
  assert.equal(ed.doc.getNode('a').style.color, '#ef4444', 'unlocked again');
});
