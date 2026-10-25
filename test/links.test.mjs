import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeCurved, sideOf, spreadPorts } from '../src/engine/routing.js';

globalThis.performance ??= { now: () => Date.now() };

const schema = {
  defaultNodeType: 'box',
  defaultEdgeType: 'link',
  nodeTypes: { box: { w: 100, h: 50 } },
  edgeTypes: {},
};

async function editor() {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema });
  ed.resize(1000, 800);
  return ed;
}

test('port spreading fans out curved links meeting on one side, keeping them square to it', () => {
  const a = { x: 0, y: 0, w: 100, h: 60 };
  const b = { x: 0, y: 200, w: 100, h: 60 };
  const t = { x: 300, y: 100, w: 100, h: 60 };
  const items = [
    { id: 'at', sourceId: 'a', targetId: 't', source: a, target: t, route: routeCurved(a, t) },
    { id: 'bt', sourceId: 'b', targetId: 't', source: b, target: t, route: routeCurved(b, t) },
  ];
  assert.deepEqual(items[0].route.points[3], items[1].route.points[3], 'both start on the same point');
  const out = spreadPorts(items);
  const at = out.get('at'), bt = out.get('bt');
  assert.equal(at.kind, 'bezier');
  assert.ok(at.points[3].y < bt.points[3].y, 'the upper source gets the upper end');
  for (const r of [at, bt]) {
    assert.equal(sideOf(t, r.points[3]), 'left', 'still on the left side');
    assert.equal(r.points[2].y, r.points[3].y, 'control point moved with the end');
  }
});

test('a waypoint dropped inside the target is discarded when the drag ends', async () => {
  const { WaypointGesture } = await import('../src/editor/gestures.js');
  const ed = await editor();
  ed.doc.addNode({ id: 'a', x: 0, y: 0, w: 100, h: 60 });
  ed.doc.addNode({ id: 'b', x: 400, y: 0, w: 100, h: 60 });
  ed.doc.addEdge({ id: 'e', source: 'a', target: 'b', style: { routing: 'curved' } });
  ed.router.get('e');

  const drag = (to) => {
    const g = new WaypointGesture(ed, { hit: { kind: 'edge', id: 'e', segment: 0 }, world: { x: 250, y: 30 } });
    g.move({ ...ed.toScreen(to), alt: true });
    g.up();
  };
  drag({ x: 250, y: 200 });
  assert.deepEqual(ed.doc.getEdge('e').style.points, [{ x: 250, y: 200 }], 'a valid waypoint is kept');
  ed.resetRoute(['e']);
  drag({ x: 450, y: 30 });
  assert.equal(ed.doc.getEdge('e').style.points, undefined, 'inside the target: dropped');
  ed.undo();
  assert.equal(ed.doc.getEdge('e').style.points, undefined, 'the whole drag is one undo step');
});

test('clicking where two links overlap picks the selected one', async () => {
  const ed = await editor();
  ed.doc.addNode({ id: 'a', x: 0, y: 0, w: 100, h: 60 });
  ed.doc.addNode({ id: 'b', x: 400, y: 0, w: 100, h: 60 });
  ed.doc.addEdge({ id: 'e1', source: 'a', target: 'b', style: { routing: 'straight' } });
  ed.doc.addEdge({ id: 'e2', source: 'a', target: 'b', style: { routing: 'straight' } });
  for (const id of ['e1', 'e2']) ed.router.get(id);
  const at = ed.toScreen({ x: 250, y: 30 });
  assert.equal(ed.hitTest(at).id, 'e2', 'unselected: the one drawn on top');
  ed.setSelection(['e1']);
  assert.equal(ed.hitTest(at).id, 'e1', 'the selected one wins');
});
