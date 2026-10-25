import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeCurved, sideOf, spreadPorts } from '../src/engine/routing.js';

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

test('moving a module carries the routes inside it instead of routing them again', async () => {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, nodeTypes: { ...schema.nodeTypes, group: { container: true, w: 300, h: 200 } } } });
  ed.doc.addNode({ id: 'g', type: 'group', x: 0, y: 0, w: 600, h: 300 });
  ed.doc.addNode({ id: 'a', parent: 'g', x: 40, y: 80, w: 100, h: 60 });
  ed.doc.addNode({ id: 'b', parent: 'g', x: 400, y: 160, w: 100, h: 60 });
  ed.doc.addNode({ id: 'out', x: 900, y: 80, w: 100, h: 60 });
  ed.doc.addEdge({ id: 'in', source: 'a', target: 'b' });
  ed.doc.addEdge({ id: 'cross', source: 'b', target: 'out' });
  const before = ed.router.get('in'), crossBefore = ed.router.get('cross');
  let computed = 0;
  const compute = ed.router.compute.bind(ed.router);
  ed.router.compute = (...args) => { computed++; return compute(...args); };

  ed.router.setLive(true);
  ed.doc.transact('Move', () => ed.doc.moveBy(['g'], 30, 50));
  const after = ed.router.get('in');
  assert.deepEqual(after.points, before.points.map((p) => ({ x: p.x + 30, y: p.y + 50 })), 'translated');
  assert.equal(computed, 0, 'not routed again');
  assert.notEqual(ed.router.get('cross'), crossBefore, 'a link to the outside is re-routed');
  assert.equal(computed, 1);
  ed.router.setLive(false);
});
