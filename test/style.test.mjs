import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comboOf } from '../src/editor/commands.js';

globalThis.performance ??= { now: () => Date.now() };

const schema = {
  defaultNodeType: 'box',
  defaultEdgeType: 'uses',
  nodeTypes: { box: { w: 100, h: 50 }, text: { shape: 'text', w: 80, h: 20 } },
  edgeTypes: { uses: {}, async: {} },
};

async function editor() {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema });
  ed.doc.addNode({ id: 'a', style: { color: '#ef4444' } });
  ed.doc.addNode({ id: 'b', x: 300 });
  ed.doc.addNode({ id: 'c', x: 600, style: { color: '#22c55e' } });
  ed.doc.addNode({ id: 't', type: 'text', y: 200, style: { textSize: 'lg', align: 'center', color: '#3b82f6' } });
  ed.doc.addNode({ id: 'u', type: 'text', x: 300, y: 200 });
  ed.doc.addEdge({ id: 'e1', source: 'a', target: 'b', type: 'async', style: { routing: 'curved', color: '#f97316', points: [{ x: 1, y: 2 }] } });
  ed.doc.addEdge({ id: 'e2', source: 'b', target: 'c' });
  return ed;
}

test('copy / paste style between elements, links and text, in one undo step', async () => {
  const ed = await editor();
  const notices = [];
  ed.on('notice', (n) => notices.push(n.message));

  ed.setSelection(['a']);
  ed.copyStyle();
  assert.equal(notices.length, 1);
  ed.setSelection(['b', 'c', 'e2']);
  ed.pasteStyle();
  assert.equal(ed.doc.getNode('b').style.color, '#ef4444');
  assert.equal(ed.doc.getNode('c').style.color, '#ef4444');
  assert.deepEqual(ed.doc.getEdge('e2').style, { color: '#ef4444' }, 'element → link: colour only');
  ed.undo();
  assert.equal(ed.doc.getNode('c').style.color, '#22c55e', 'one undo step');
  assert.equal(ed.doc.getNode('b').style.color, undefined);

  ed.setSelection(['e1']);
  ed.copyStyle();
  ed.setSelection(['e2']);
  ed.pasteStyle();
  const e2 = ed.doc.getEdge('e2');
  assert.equal(e2.type, 'async', 'link kind carries over');
  assert.deepEqual(e2.style, { routing: 'curved', color: '#f97316' }, 'but not the hand-made shape');

  ed.setSelection(['t']);
  ed.copyStyle();
  ed.setSelection(['u', 'b']);
  ed.pasteStyle();
  assert.deepEqual(ed.doc.getNode('u').style, { textSize: 'lg', align: 'center', color: '#3b82f6' });
  assert.deepEqual(ed.doc.getNode('b').style, { color: '#3b82f6' }, 'text → box: colour only');
});

test('shortcuts with Option on a Mac match by physical key', () => {
  assert.equal(comboOf({ key: 'ç', code: 'KeyC', mod: true, alt: true }), 'mod+alt+c');
  assert.equal(comboOf({ key: 'å', code: 'KeyA', alt: true }), 'alt+a');
  assert.equal(comboOf({ key: 'a', code: 'KeyQ', alt: true }), 'alt+a', 'AZERTY letters still follow the layout');
});
