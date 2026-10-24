import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { History } from '../src/engine/history.js';
import { SpatialHash } from '../src/engine/spatial.js';
import { snapRect } from '../src/engine/snapping.js';
import { routeOrthogonal } from '../src/engine/routing.js';
import { EdgeRouter } from '../src/engine/router.js';
import { layoutHierarchy, isotonic } from '../src/engine/layout.js';
import { overlaps, polylineCrossesRect } from '../src/engine/geometry.js';

const schema = {
  defaultNodeType: 'box',
  defaultEdgeType: 'link',
  nodeTypes: { box: { w: 100, h: 50 }, group: { w: 300, h: 200, container: true } },
};

function setup() {
  const doc = new DiagramDocument(schema);
  const history = new History(doc);
  return { doc, history };
}

test('add / update / remove are undoable as single transactions', () => {
  const { doc, history } = setup();
  const a = doc.addNode({ id: 'a', x: 0, y: 0 });
  const b = doc.addNode({ id: 'b', x: 200, y: 0 });
  doc.addEdge({ id: 'e', source: 'a', target: 'b' });
  doc.update('a', { label: 'Hello', x: 40 });
  assert.equal(a.label, 'Hello');
  assert.equal(history.undoStack.length, 4);

  doc.remove(['b']);
  assert.ok(!doc.edges.has('e'), 'dangling edge removed with its node');
  history.undo();
  assert.ok(doc.nodes.has('b') && doc.edges.has('e'));
  assert.deepEqual(doc.edgesOf('a').map((e) => e.id), ['e']);

  history.undo();
  assert.equal(doc.getNode('a').label, '');
  assert.equal(doc.getNode('a').x, 0);
  history.redo();
  assert.equal(doc.getNode('a').x, 40);
  assert.equal(b.w, 100, 'schema defaults applied');
});

test('merge keys coalesce a drag into one undo step', () => {
  const { doc, history } = setup();
  doc.addNode({ id: 'a', x: 0, y: 0 });
  for (let i = 1; i <= 10; i++) doc.transact('Move', () => doc.update('a', { x: i * 10 }), { merge: 'drag1' });
  assert.equal(history.undoStack.length, 2);
  history.undo();
  assert.equal(doc.getNode('a').x, 0);
});

test('containers: descendants move together, remove cascades, no cycles', () => {
  const { doc, history } = setup();
  doc.addNode({ id: 'g', type: 'group', x: 0, y: 0 });
  doc.addNode({ id: 'c', parent: 'g', x: 20, y: 60 });
  doc.addNode({ id: 'd', parent: 'c', x: 30, y: 70 });
  doc.moveBy(['g'], 100, 0);
  assert.equal(doc.getNode('d').x, 130);
  assert.throws(() => doc.update('g', { parent: 'd' }));
  assert.deepEqual(doc.order(), ['g', 'c', 'd']);
  doc.remove(['g']);
  assert.equal(doc.nodes.size, 0);
  history.undo();
  assert.equal(doc.nodes.size, 3);
  assert.equal(doc.getNode('d').parent, 'c');
});

test('failed transaction rolls back', () => {
  const { doc } = setup();
  doc.addNode({ id: 'a' });
  assert.throws(() => doc.transact('Bad', () => {
    doc.update('a', { x: 99 });
    throw new Error('boom');
  }));
  assert.equal(doc.getNode('a').x, 0);
});

test('spatial hash queries', () => {
  const h = new SpatialHash(100);
  h.set('a', { x: 0, y: 0, w: 50, h: 50 });
  h.set('b', { x: 1000, y: 1000, w: 50, h: 50 });
  h.set('c', { x: -500, y: -500, w: 2000, h: 10 });
  assert.deepEqual(h.query({ x: 10, y: 10, w: 0, h: 0 }).sort(), ['a']);
  assert.deepEqual(h.query({ x: -10000, y: -10000, w: 20000, h: 20000 }).sort(), ['a', 'b', 'c']);
  h.set('a', { x: 5000, y: 5000, w: 10, h: 10 });
  assert.deepEqual(h.query({ x: 10, y: 10, w: 0, h: 0 }), []);
});

test('snapping prefers object alignment, then grid', () => {
  const others = [{ x: 200, y: 0, w: 100, h: 50 }];
  const s = snapRect({ rect: { x: 0, y: 3, w: 100, h: 50 }, others, threshold: 6, grid: 20 });
  assert.equal(s.dy, -3);
  assert.equal(s.dx, 0);
  assert.ok(s.lines.some((l) => l.axis === 'y' && l.pos === 0));
  const g = snapRect({ rect: { x: 13, y: 200, w: 100, h: 50 }, others, threshold: 6, grid: 20 });
  assert.equal(g.dx, 7);
});

test('snapping detects equal spacing', () => {
  const others = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 }];
  const s = snapRect({ rect: { x: 147, y: 0, w: 100, h: 50 }, others, threshold: 6, grid: 0 });
  assert.equal(s.dx, 3);
  assert.ok(s.gaps.length >= 2);
});

test('orthogonal router avoids obstacles and stays axis-aligned', () => {
  const src = { x: 0, y: 0, w: 100, h: 50 };
  const tgt = { x: 400, y: 0, w: 100, h: 50 };
  const wall = { x: 200, y: -100, w: 50, h: 250 };
  const r = routeOrthogonal(src, tgt, [wall]);
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], b = r.points[i];
    assert.ok(a.x === b.x || a.y === b.y, 'segments are orthogonal');
    const seg = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    assert.ok(!overlaps(seg, wall), 'segment does not cross the wall');
  }
  const p0 = r.points[0];
  assert.ok((p0.x === 100 && p0.y === 25) || (p0.x === 50 && (p0.y === 0 || p0.y === 50)), 'starts on a source port');
  assert.ok(r.points.length <= 5, 'few bends');
  const direct = routeOrthogonal(src, tgt, []);
  assert.equal(direct.points.length, 2, 'straight shot when nothing is in the way');
});

test('router invalidates routes crossed by moving nodes', () => {
  const { doc } = setup();
  doc.addNode({ id: 'a', x: 0, y: 0 });
  doc.addNode({ id: 'b', x: 400, y: 0 });
  doc.addNode({ id: 'w', x: 2000, y: 0 });
  doc.addEdge({ id: 'e', source: 'a', target: 'b' });
  const router = new EdgeRouter(doc);
  assert.equal(router.get('e').points.length, 2);
  doc.update('w', { x: 200, y: -50, h: 200 });
  assert.equal(router.peek('e'), null);
  assert.ok(router.get('e').points.length > 2);
});

test('layered layout: ranks follow edges, no overlaps, containers wrap children', () => {
  const { doc } = setup();
  doc.addNode({ id: 'g', type: 'group' });
  for (const id of ['a', 'b', 'c']) doc.addNode({ id, parent: 'g' });
  doc.addNode({ id: 'x' });
  doc.addNode({ id: 'y' });
  doc.addEdge({ source: 'a', target: 'b' });
  doc.addEdge({ source: 'a', target: 'c' });
  doc.addEdge({ source: 'x', target: 'a' });
  doc.addEdge({ source: 'c', target: 'y' });
  doc.addEdge({ source: 'y', target: 'x' }); // cycle across levels
  const rects = layoutHierarchy(doc, { direction: 'LR' });
  assert.equal(rects.size, 6);
  const r = (id) => rects.get(id);
  assert.ok(r('b').x > r('a').x && r('c').x > r('a').x, 'successors placed after');
  const g = r('g');
  for (const id of ['a', 'b', 'c']) {
    const n = r(id);
    assert.ok(n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h, `${id} inside group`);
  }
  const roots = ['g', 'x', 'y'].map(r);
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) assert.ok(!overlaps(roots[i], roots[j]));
  assert.ok(!overlaps(r('b'), r('c')));
});

test('isotonic regression', () => {
  assert.deepEqual([...isotonic([1, 3, 2, 4], [1, 1, 1, 1])], [1, 2.5, 2.5, 4]);
});

test('port spreading fans out ends sharing a side and keeps routes orthogonal', async () => {
  const { spreadPorts, routeSimpleOrthogonal } = await import('../src/engine/routing.js');
  const a = { x: 0, y: 100, w: 100, h: 60 };
  const b = { x: 300, y: 0, w: 100, h: 60 };
  const c = { x: 300, y: 200, w: 100, h: 60 };
  const items = [
    { id: 'ab', sourceId: 'a', targetId: 'b', source: a, target: b, route: routeSimpleOrthogonal(a, b) },
    { id: 'ac', sourceId: 'a', targetId: 'c', source: a, target: c, route: routeSimpleOrthogonal(a, c) },
  ];
  const out = spreadPorts(items);
  const ab = out.get('ab'), ac = out.get('ac');
  assert.ok(ab && ac);
  assert.ok(ab.points[0].y < ac.points[0].y, 'upper target gets the upper slot');
  for (const r of [ab, ac]) {
    for (let i = 1; i < r.points.length; i++) {
      const p = r.points[i - 1], q = r.points[i];
      assert.ok(Math.abs(p.x - q.x) < 1e-9 || Math.abs(p.y - q.y) < 1e-9);
    }
    assert.equal(r.points[0].x, 100, 'still attached to the right side');
  }
});

test('port spreading leaves straight links alone', async () => {
  const { spreadPorts, routeStraight, sideOf } = await import('../src/engine/routing.js');
  const a = { x: 0, y: 0, w: 100, h: 60 };
  const b = { x: 0, y: 200, w: 100, h: 60 };
  const t = { x: 300, y: 100, w: 100, h: 60 };
  const items = [
    { id: 'at', sourceId: 'a', targetId: 't', source: a, target: t, route: routeStraight(a, t) },
    { id: 'bt', sourceId: 'b', targetId: 't', source: b, target: t, route: routeStraight(b, t) },
  ];
  for (const it of items) assert.equal(sideOf(t, it.route.points[1]), 'left', 'both end on the same side');
  assert.equal(spreadPorts(items).size, 0);
});

test('manual orthogonal routes pass through bends and re-attach when nodes move', async () => {
  const { routeManual } = await import('../src/engine/routing.js');
  const a = { x: 0, y: 0, w: 100, h: 60 };
  const b = { x: 400, y: 200, w: 100, h: 60 };
  const r = routeManual('orthogonal', a, b, [{ x: 250, y: 30 }, { x: 250, y: 230 }]);
  assert.deepEqual(r.points[0], { x: 100, y: 30 }, 'leaves the right side aligned with the first bend');
  assert.deepEqual(r.points[r.points.length - 1], { x: 400, y: 230 });
  assert.ok(r.manual);
  // Source moved so the bend is no longer beside it: an elbow keeps it orthogonal.
  const r2 = routeManual('orthogonal', { x: 0, y: 300, w: 100, h: 60 }, b, [{ x: 250, y: 30 }, { x: 250, y: 230 }]);
  for (let i = 1; i < r2.points.length; i++) {
    const p = r2.points[i - 1], q = r2.points[i];
    assert.ok(Math.abs(p.x - q.x) < 1e-9 || Math.abs(p.y - q.y) < 1e-9);
  }
  const curved = routeManual('curved', a, b, [{ x: 250, y: 30 }]);
  assert.ok(curved.smooth && curved.legs.length === curved.poly.length - 1);
});

test('segments sharing a corridor are separated into lanes', async () => {
  const { separateSegments, finish } = await import('../src/engine/routing.js');
  const routes = new Map([
    ['up', finish('poly', [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 50 }])],
    ['down', finish('poly', [{ x: 50, y: 200 }, { x: 50, y: 100 }, { x: 350, y: 100 }, { x: 350, y: 150 }])],
  ]);
  const out = separateSegments(routes, { gap: 10 });
  const y = (id) => (out.get(id) ?? routes.get(id)).points[1].y;
  assert.notEqual(y('up'), y('down'));
  assert.ok(y('up') < y('down'), 'edge heading up takes the upper lane');
});

test('collapsed containers: hidden descendants, proxy endpoints, layout as a leaf', () => {
  const { doc } = setup();
  doc.addNode({ id: 'g', type: 'group' });
  doc.addNode({ id: 'a', parent: 'g', x: 20, y: 60 });
  doc.addNode({ id: 'x', x: 600 });
  doc.addEdge({ id: 'e', source: 'a', target: 'x' });
  const router = new EdgeRouter(doc);
  const before = router.get('e');
  doc.update('g', { collapsed: true, expanded: { w: 300, h: 200 }, w: 200, h: 70 });
  assert.ok(doc.hidden().has('a'));
  assert.equal(doc.visibleAncestor('a'), 'g');
  const after = router.get('e');
  assert.notDeepEqual(after.points[0], before.points[0], 'edge now starts at the collapsed module');
  const rects = layoutHierarchy(doc);
  assert.equal(rects.has('a'), false, 'contents of a collapsed module are not laid out');
  assert.equal(rects.get('g').w, 200);
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  const copy = new DiagramDocument(schema);
  copy.load(json);
  assert.equal(copy.getNode('g').collapsed, true);
});

test('editor: collapse/expand shifts neighbours like an accordion and undoes in one step', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, groupType: 'group', edgeTypes: {} } });
  ed.doc.addNode({ id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 200 });
  ed.doc.addNode({ id: 'a', parent: 'g', x: 20, y: 60 });
  ed.doc.addNode({ id: 'r', x: 340, y: 0 });
  ed.doc.addNode({ id: 'b', x: 0, y: 240 });
  ed.toggleCollapse(['g'], true);
  const g = ed.doc.getNode('g');
  assert.ok(g.collapsed && g.w < 300);
  assert.equal(ed.doc.getNode('r').x, 340 - (300 - g.w), 'right neighbour pulled in');
  assert.equal(ed.doc.getNode('b').y, 240 - (200 - g.h), 'neighbour below pulled up');
  ed.toggleCollapse(['g'], false);
  assert.equal(ed.doc.getNode('r').x, 340);
  assert.equal(ed.doc.getNode('b').y, 240);
  ed.undo();
  assert.ok(ed.doc.getNode('g').collapsed);
  assert.equal(ed.doc.getNode('a').x, 20, 'contents untouched while collapsed');
});

test('dragging a vertical link past the nodes turns it into a side bracket', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { SegmentGesture } = await import('../src/editor/gestures.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  ed.resize(1000, 800);
  ed.doc.addNode({ id: 'a', x: 100, y: 100, w: 200, h: 60 });
  ed.doc.addNode({ id: 'b', x: 100, y: 300, w: 200, h: 60 });
  ed.doc.addNode({ id: 'c', x: 150, y: 500, w: 100, h: 60 });
  ed.doc.addEdge({ id: 'e', source: 'a', target: 'b' });
  ed.doc.addEdge({ id: 'f', source: 'b', target: 'c' });
  const drag = (id, from, to) => {
    const g = new SegmentGesture(ed, { hit: { id, segment: 0 }, world: from });
    g.move({ ...to, mod: true });
    g.up();
    return ed.router.get(id).points;
  };
  assert.equal(ed.router.get('e').points.length, 2, 'starts as a straight vertical link');

  // Within the nodes' width: the link just shifts sideways, still vertical.
  let p = drag('e', { x: 200, y: 230 }, { x: 260, y: 230 });
  assert.deepEqual(p, [{ x: 260, y: 160 }, { x: 260, y: 300 }]);

  // Past the right sides: out of A's right side, down, into B's right side.
  ed.resetRoute(['e']);
  p = drag('e', { x: 200, y: 230 }, { x: 380, y: 230 });
  assert.deepEqual(p, [{ x: 300, y: 130 }, { x: 380, y: 130 }, { x: 380, y: 330 }, { x: 300, y: 330 }]);

  // Past only the narrower target: leaves B's bottom, enters C's right side.
  p = drag('f', { x: 200, y: 430 }, { x: 280, y: 430 });
  assert.deepEqual(p[0], { x: 280, y: 360 }, 'source end slides along B’s bottom');
  assert.deepEqual(p[p.length - 1], { x: 250, y: 530 }, 'target end on C’s right side');
});

test('boundaries: variants resolve visuals, crossings are found through nesting', async () => {
  const { resolveType, boundariesCrossed } = await import('../src/engine/schema.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const doc = new DiagramDocument(architectureSchema);
  doc.addNode({ id: 'vpc', type: 'boundary', data: { variant: 'network' } });
  doc.addNode({ id: 'mod', type: 'module', parent: 'vpc' });
  doc.addNode({ id: 'pci', type: 'boundary', parent: 'mod' });
  doc.addNode({ id: 'pay', type: 'component', parent: 'pci' });
  doc.addNode({ id: 'api', type: 'service', parent: 'mod' });
  doc.addNode({ id: 'ext', type: 'external' });
  const t = resolveType(architectureSchema, doc.getNode('pci'));
  assert.equal(t.label, 'Trust boundary');
  assert.equal(t.markCrossings, true);
  assert.equal(resolveType(architectureSchema, doc.getNode('vpc')).icon, 'network');
  const ids = (e) => boundariesCrossed(doc, e).map((n) => n.id).sort();
  assert.deepEqual(ids({ source: 'api', target: 'pay' }), ['pci']);
  assert.deepEqual(ids({ source: 'pay', target: 'ext' }), ['pci', 'vpc']);
  assert.deepEqual(ids({ source: 'api', target: 'mod' }), [], 'links to a container are not crossings');
});

test('editor: wrap selection in a boundary variant', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.doc.addNode({ id: 'a', type: 'component', x: 0, y: 0 });
  ed.doc.addNode({ id: 'b', type: 'component', x: 300, y: 0 });
  ed.setSelection(['a', 'b']);
  ed.run('arrange.wrap.network');
  const box = ed.doc.getNode(ed.doc.getNode('a').parent);
  assert.equal(box.type, 'boundary');
  assert.equal(box.data.variant, 'network');
  assert.equal(box.label, 'Network zone');
  assert.equal(ed.doc.getNode('b').parent, box.id);
});

test('editor: Ctrl+drag drops a copy, toggling Ctrl mid-drag switches copy/move', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { DragGesture } = await import('../src/editor/gestures.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  ed.resize(1000, 800);
  ed.doc.addNode({ id: 'g', type: 'group', x: 400, y: 0, w: 300, h: 200 });
  ed.doc.addNode({ id: 'a', x: 0, y: 0 });
  ed.doc.addNode({ id: 'b', x: 0, y: 100 });
  ed.doc.addEdge({ id: 'ab', source: 'a', target: 'b' });
  ed.setSelection(['a', 'b']);
  const g = new DragGesture(ed, { world: { x: 10, y: 10 } });
  ed.gesture = g;
  g.move({ x: 110, y: 10, mod: true, alt: true });
  assert.equal(ed.doc.nodes.size, 5, 'two copies while Ctrl is held');
  assert.deepEqual([ed.doc.getNode('a').x, ed.doc.getNode('b').x], [0, 0], 'originals stay put');
  g.keys({ mod: false, alt: true });
  assert.equal(ed.doc.nodes.size, 3, 'releasing Ctrl turns it back into a move');
  assert.equal(ed.doc.getNode('a').x, 100);
  g.keys({ mod: true, alt: true });
  g.move({ x: 460, y: 60, mod: true, alt: true });
  ed.gesture = null;
  g.up();
  const copies = [...ed.selection];
  assert.equal(copies.length, 2);
  assert.ok(copies.every((id) => id !== 'a' && id !== 'b'));
  assert.ok(copies.every((id) => ed.doc.getNode(id).parent === 'g'), 'dropped copies nest into the module');
  assert.equal(ed.doc.edges.size, 2, 'the link between them is copied too');
  assert.equal(ed.doc.getNode('a').x, 0);
  ed.undo();
  assert.equal(ed.doc.nodes.size, 3, 'the whole copy-drag is one undo step');
  assert.equal(ed.doc.getNode('a').x, 0);
});

test('editor: type labels replace the type caption, can be cleared, and are suggested', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  ed.resize(1000, 800);
  for (const id of ['a', 'b', 'c']) ed.doc.addNode({ id, x: 0, y: 0, data: { tech: 'Go' } });
  ed.setStereotype(['a', 'b'], ' Backend ');
  ed.setStereotype(['c'], 'Frontend');
  assert.equal(ed.doc.getNode('a').data.stereotype, 'Backend', 'trimmed');
  assert.equal(ed.doc.getNode('a').data.tech, 'Go', 'other data kept');
  assert.deepEqual(ed.stereotypes(), ['Backend', 'Frontend'], 'most used first');
  ed.undo();
  assert.equal(ed.doc.getNode('c').data.stereotype, undefined);
  ed.setStereotype(['a'], '');
  assert.ok(!('stereotype' in ed.doc.getNode('a').data), 'empty goes back to the type name');
  assert.ok(JSON.stringify(ed.toJSON()).includes('"stereotype":"Backend"'), 'saved with the diagram');

  // Double-click on the caption edits the type label, elsewhere on the node the name.
  ed.layoutProbe = { captionRect: () => ({ x: 50, y: 40, w: 100, h: 16 }) };
  const field = [];
  ed.on('edit-label', ({ field: f }) => field.push(f));
  ed.doubleClick({ x: 80, y: 48 });
  ed.endEdit();
  ed.doubleClick({ x: 80, y: 20 });
  assert.deepEqual(field, ['stereotype', 'label']);
});

test('hosts: server/VM/container are cards until something is dropped in, then grow around it', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { DragGesture } = await import('../src/editor/gestures.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1600, 1000);
  const vm = ed.createNode('vm', { x: 100, y: 36 });
  const app = ed.createNode('application', { x: 600, y: 300 });
  const right = ed.doc.addNode({ type: 'component', x: vm.x + vm.w + 40, y: vm.y });
  assert.ok(ed.showsAsCard(vm.id), 'an empty VM is a card');
  assert.equal(vm.h, 72);

  // Drag the application onto the VM card.
  ed.setSelection([app.id]);
  const g = new DragGesture(ed, { world: { x: 600, y: 300 } });
  ed.gesture = g;
  g.move({ x: 100, y: 36 });
  assert.equal(ed.overlay.dropTarget, vm.id, 'the card is highlighted as a drop target');
  ed.gesture = null;
  g.up();

  const { containerPadding: pad, containerHeader: head } = ed.settings;
  assert.equal(app.parent, vm.id);
  assert.deepEqual([app.x, app.y], [vm.x + pad, vm.y + head], 'laid out inside the content area');
  assert.ok(!ed.showsAsCard(vm.id) && vm.h > 72, 'the VM became a box around it');
  assert.ok(right.x >= vm.x + vm.w, 'the neighbour moved out of the way');
  ed.undo();
  assert.ok(ed.showsAsCard(vm.id) && app.parent === null, 'one undo step');

  // Creating directly into a host card (palette drop) does the same.
  const c = ed.createNode('container', { x: 100, y: 36 });
  assert.equal(c.parent, vm.id);
  assert.ok(!ed.showsAsCard(vm.id));
});

test('editor: fit to content wraps contents snugly, innermost first, in one undo step', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  const { containerPadding: pad, containerHeader: head } = ed.settings;
  ed.doc.addNode({ id: 'outer', type: 'group', x: 0, y: 0, w: 1000, h: 800 });
  ed.doc.addNode({ id: 'inner', type: 'group', parent: 'outer', x: 100, y: 100, w: 700, h: 500 });
  ed.doc.addNode({ id: 'a', parent: 'inner', x: 200, y: 200, w: 100, h: 50 });
  ed.doc.addNode({ id: 'b', parent: 'inner', x: 400, y: 300, w: 100, h: 50 });
  ed.doc.addNode({ id: 'empty', type: 'group', x: 2000, y: 0 });
  assert.equal(ed.canFitToContent(['empty']), false, 'nothing to fit an empty container to');

  ed.fitToContent(['outer']);
  const r = (id) => { const n = ed.doc.getNode(id); return [n.x, n.y, n.w, n.h]; };
  assert.deepEqual(r('inner'), [200 - pad, 200 - head, 300 + pad * 2, 150 + head + pad]);
  const inner = ed.doc.getNode('inner');
  assert.deepEqual(r('outer'), [inner.x - pad, inner.y - head, inner.w + pad * 2, inner.h + head + pad]);
  ed.undo();
  assert.deepEqual(r('outer'), [0, 0, 1000, 800]);
  assert.deepEqual(r('inner'), [100, 100, 700, 500]);

  // Double-clicking a resize handle of the selected container fits it.
  ed.resize(1600, 1000);
  ed.setSelection(['inner']);
  ed.doubleClick({ x: 100 + 700, y: 100 + 500 });
  assert.equal(ed.doc.getNode('inner').w, 300 + pad * 2);
});

test('editor: link protocol can be set, cleared, edited in place, and makes the tag clickable', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  ed.resize(1600, 1000);
  ed.doc.addNode({ id: 'a', x: 0, y: 0 });
  ed.doc.addNode({ id: 'b', x: 400, y: 0 });
  ed.doc.addEdge({ id: 'e', source: 'a', target: 'b' });
  ed.setProtocol('e', ' HTTP/1.1 ');
  assert.equal(ed.doc.getEdge('e').data.tech, 'HTTP/1.1');
  ed.router.get('e');
  // A protocol-only tag (no label) is still a grab target for the tag.
  const mid = ed.router.peek('e').mid;
  assert.deepEqual(ed.hitTest(mid), { kind: 'edge', id: 'e', label: true });
  // Double-click on the protocol line edits the protocol.
  ed.layoutProbe = { captionRect: (id) => (id === 'e' ? { x: mid.x - 50, y: mid.y - 8, w: 100, h: 16 } : null), labelRect: () => null };
  let field;
  ed.on('edit-label', (ev) => (field = ev.field));
  ed.doubleClick(mid);
  assert.equal(field, 'tech');
  ed.commitLabel('e', '', 'tech');
  assert.ok(!('tech' in ed.doc.getEdge('e').data), 'empty removes it');
});

test('editor: route grips step aside from the link tag instead of covering it', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: { ...schema, edgeTypes: {} } });
  ed.resize(1600, 1000);
  ed.doc.addNode({ id: 'a', x: 0, y: 0 });
  ed.doc.addNode({ id: 'b', x: 500, y: 0 });
  ed.doc.addEdge({ id: 'e', source: 'a', target: 'b', label: 'reads' });
  ed.router.get('e');
  const mid = ed.router.peek('e').mid;
  const tag = { x: mid.x - 40, y: mid.y - 16, w: 80, h: 32 };
  ed.layoutProbe = { labelRect: () => tag, captionRect: () => null };
  const [g] = ed.edgeHandles('e');
  assert.ok(g, 'a grip is still offered');
  assert.equal(g.y, mid.y, 'it stays on its segment');
  assert.ok(g.x < tag.x - 10 || g.x > tag.x + tag.w + 10, 'and clear of the tag');

  // No room on either side of the tag: no grip (the line itself stays draggable).
  ed.layoutProbe = { labelRect: () => ({ x: 90, y: mid.y - 16, w: 400, h: 32 }), captionRect: () => null };
  assert.equal(ed.edgeHandles('e').length, 0);

  // Without a tag over it, the grip sits in the middle as before.
  ed.layoutProbe = { labelRect: () => ({ x: 0, y: 500, w: 10, h: 10 }), captionRect: () => null };
  assert.deepEqual([ed.edgeHandles('e')[0].x, ed.edgeHandles('e')[0].y], [mid.x, mid.y]);
});

test('network bus: attachments drop straight onto it, across modules; bus stretches to its members', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const { busMembers } = await import('../src/engine/schema.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1600, 1000);
  ed.doc.addNode({ id: 'm1', type: 'module', x: 0, y: 0, w: 300, h: 200 });
  ed.doc.addNode({ id: 'm2', type: 'module', x: 500, y: 0, w: 300, h: 200 });
  ed.doc.addNode({ id: 'a', type: 'component', parent: 'm1', x: 40, y: 80 });
  ed.doc.addNode({ id: 'b', type: 'component', parent: 'm2', x: 560, y: 80 });
  ed.doc.addNode({ id: 'net', type: 'network', x: 100, y: 400, w: 300, h: 40 });
  const ea = ed.connect('a', 'net');
  const eb = ed.connect('net', 'b');
  assert.equal(ea.type, 'attachment', 'links to a network are attachments');
  assert.equal(eb.type, 'attachment');
  assert.deepEqual(busMembers(ed.doc, 'net').map((n) => n.id).sort(), ['a', 'b']);
  const ra = ed.router.get(ea.id).points;
  assert.deepEqual(ra, [{ x: 140, y: 152 }, { x: 140, y: 400 }], 'straight drop from a member above the bus');
  const rb = ed.router.get(eb.id).points;
  assert.equal(rb.length, 3, 'a member beyond the bus end enters from the end');
  ed.fitToContent(['net']);
  const net = ed.doc.getNode('net');
  assert.ok(net.x <= 140 && net.x + net.w >= 660, 'the bus now spans both members');
  assert.equal(ed.router.get(eb.id).points.length, 2, 'so every drop is straight');
});

test('border-only boundaries: surround without containing, hit on outline only, re-wrap after layout', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const { boundariesCrossed } = await import('../src/engine/schema.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1600, 1000);
  ed.doc.addNode({ id: 'm1', type: 'module', x: 0, y: 0, w: 300, h: 200 });
  ed.doc.addNode({ id: 'm2', type: 'module', x: 500, y: 0, w: 300, h: 200 });
  ed.doc.addNode({ id: 'a', type: 'component', parent: 'm1', x: 40, y: 80 });
  ed.doc.addNode({ id: 'b', type: 'component', parent: 'm2', x: 560, y: 80 });
  ed.doc.addNode({ id: 'c', type: 'component', x: 1200, y: 80 });
  ed.doc.addEdge({ id: 'ac', source: 'a', target: 'c' });

  ed.setSelection(['a', 'b']);
  ed.run('arrange.outline.network');
  const o = ed.doc.getNode([...ed.selection][0]);
  assert.ok(o.data.borderOnly && o.data.variant === 'network');
  assert.equal(ed.doc.getNode('a').parent, 'm1', 'members stay in their own modules');
  assert.equal(ed.doc.isContainer(o), false);
  assert.deepEqual(ed.surrounded(o.id).map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(boundariesCrossed(ed.doc, ed.doc.getEdge('ac')).map((n) => n.id), [o.id], 'crossing by geometry');

  // Inside the outline you hit what's there; on its outline you hit the outline.
  ed.setSelection([]);
  ed.endEdit();
  assert.equal(ed.hitTest({ x: 400, y: 100 }), null, 'empty space between the modules is just canvas');
  assert.equal(ed.hitTest({ x: 140, y: 110 }).id, 'a');
  assert.equal(ed.hitTest({ x: o.x + o.w / 2, y: o.y + o.h }).id, o.id);
  assert.equal(ed.containerAt({ x: 400, y: 100 }), null, 'never a drop target');

  ed.autoLayout({ animate: false, fit: false });
  const a = ed.doc.getNode('a'), b = ed.doc.getNode('b'), o2 = ed.doc.getNode(o.id);
  assert.ok(containsAll(o2, [a, b]), 'after layout the outline still wraps its members');

  // Switching a containing boundary to border-only releases its contents.
  const box = ed.doc.addNode({ type: 'boundary', x: 0, y: 600, w: 300, h: 200 });
  ed.doc.addNode({ id: 'k', type: 'component', parent: box.id, x: 30, y: 660 });
  ed.setBorderOnly([box.id], true);
  assert.equal(ed.doc.getNode('k').parent, null);
  ed.undo();
  assert.equal(ed.doc.getNode('k').parent, box.id);
});

function containsAll(o, nodes) {
  return nodes.every((n) => n.x >= o.x && n.y >= o.y && n.x + n.w <= o.x + o.w && n.y + n.h <= o.y + o.h);
}

test('firewall: dropped onto a link it is put in its path, in one undo step', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { DragGesture } = await import('../src/editor/gestures.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1600, 1000);
  ed.doc.addNode({ id: 'web', type: 'client', x: 0, y: 0 });
  ed.doc.addNode({ id: 'api', type: 'service', x: 600, y: 0 });
  ed.doc.addEdge({ id: 'e', source: 'web', target: 'api', label: 'calls', data: { tech: 'HTTPS' } });
  ed.router.get('e');

  // From the dock: created right on the link.
  const fw = ed.createNode('firewall', { x: 400, y: 36 });
  const links = [...ed.doc.edges.values()].map((x) => [x.source, x.target, x.label, x.data.tech]);
  assert.deepEqual(links.sort(), [['web', fw.id, 'calls', 'HTTPS'], [fw.id, 'api', '', 'HTTPS']].sort());
  assert.equal(fw.y + fw.h / 2, 36, 'centred on the line');
  ed.undo();
  assert.equal(ed.doc.edges.size, 1);
  assert.equal(ed.doc.getEdge('e').target, 'api');

  // By dragging an unlinked firewall onto the link.
  const fw2 = ed.createNode('firewall', { x: 300, y: 400 });
  ed.router.get('e');
  ed.setSelection([fw2.id]);
  const g = new DragGesture(ed, { world: { x: 300, y: 400 } });
  ed.gesture = g;
  g.move({ x: 350, y: 36, alt: true });
  assert.equal(ed.overlay.insertEdge, 'e', 'the link lights up as the drop target');
  ed.gesture = null;
  g.up();
  assert.equal(ed.doc.edges.size, 2);
  assert.ok(ed.doc.edgesOf(fw2.id).length === 2);
  ed.undo();
  assert.equal(ed.doc.edges.size, 1, 'drag and insert undo together');
});

test('routing: close elements always get an end segment long enough to show the arrowhead', async () => {
  const { routeOrthogonal, ARROW_ROOM } = await import('../src/engine/routing.js');
  const inside = (n, q) => q.x > n.x + 0.5 && q.x < n.x + n.w - 0.5 && q.y > n.y + 0.5 && q.y < n.y + n.h - 0.5;
  for (const gap of [0, 2, 4, 8, 12, 16, 18, 24, 32, 39]) {
    for (const dx of [0, 60, 100, 180, 260, -120]) {
      const up = { x: 0, y: 0, w: 200, h: 72 };
      const lo = { x: dx, y: 72 + gap, w: 200, h: 72 };
      for (const [s, t] of [[lo, up], [up, lo]]) {
        const p = routeOrthogonal(s, t).points;
        const last = Math.hypot(p.at(-1).x - p.at(-2).x, p.at(-1).y - p.at(-2).y);
        assert.ok(last >= ARROW_ROOM, `gap ${gap} dx ${dx}: end segment ${last} too short for the arrowhead`);
        for (let i = 0; i < p.length - 1; i++) {
          for (let k = 1; k < 10; k++) {
            const q = { x: p[i].x + (p[i + 1].x - p[i].x) * k / 10, y: p[i].y + (p[i + 1].y - p[i].y) * k / 10 };
            assert.ok(!inside(s, q) && !inside(t, q), `gap ${gap} dx ${dx}: route crosses an element`);
          }
        }
      }
    }
  }
  // Facing and aligned with room for the arrow: a single straight segment.
  assert.equal(routeOrthogonal({ x: 0, y: 100, w: 200, h: 72 }, { x: 0, y: 0, w: 200, h: 72 }).points.length, 2);
});

test('routing: stale hand-made bends never make a link run through its own ends', async () => {
  const { routeManual } = await import('../src/engine/routing.js');
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const inside = (n, q) => q.x > n.x + 0.5 && q.x < n.x + n.w - 0.5 && q.y > n.y + 0.5 && q.y < n.y + n.h - 0.5;
  const crosses = (pts, ...rs) => pts.slice(1).some((b, i) => {
    const a = pts[i];
    for (let k = 1; k < 16; k++) if (rs.some((r) => inside(r, { x: a.x + (b.x - a.x) * k / 16, y: a.y + (b.y - a.y) * k / 16 }))) return true;
    return false;
  });
  const idp = { x: 0, y: 0, w: 200, h: 72 }, sso = { x: 0, y: 140, w: 200, h: 72 };
  // A bend above both stacked elements (left over from an earlier arrangement).
  assert.equal(routeManual('orthogonal', sso, idp, [{ x: 100, y: -40 }]), null, 'invalid shape is rejected');
  // A bend that ended up inside an end element is dropped; the rest of the shape is kept.
  const fe = { x: 0, y: 0, w: 200, h: 72 }, fw = { x: 300, y: 200, w: 200, h: 72 };
  const kept = routeManual('orthogonal', fe, fw, [{ x: 250, y: 36 }, { x: 250, y: 236 }, { x: 360, y: 250 }]);
  assert.ok(kept && !crosses(kept.points, fe, fw));

  // End to end: the editor shows a clean automatic route instead.
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1600, 1000);
  ed.doc.addNode({ id: 'idp', type: 'service', ...idp });
  ed.doc.addNode({ id: 'sso', type: 'container', ...sso });
  ed.doc.addEdge({ id: 'e', source: 'sso', target: 'idp', style: { points: [{ x: 100, y: -40 }] } });
  const r = ed.router.get('e');
  assert.ok(!crosses(r.points, idp, sso), 'no pass-through');
  assert.deepEqual(r.points.at(-1), { x: 100, y: 72 }, 'arrives on the facing (bottom) side of the upper element');
});

test('free text: stays where placed, no links, refits on edit, removed when emptied', async () => {
  globalThis.performance ??= { now: () => Date.now() };
  const { Editor } = await import('../src/editor/editor.js');
  const { architectureSchema } = await import('../src/domain/architecture.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1600, 1000);
  ed.layoutProbe = { measureText: (n, t = n.label) => ({ w: t.length * 8 + 8, h: 28 }), captionRect: () => null, labelRect: () => null, tabRect: () => null };
  ed.doc.addNode({ id: 'a', type: 'component', x: 0, y: 0 });
  ed.doc.addNode({ id: 'b', type: 'component', x: 600, y: 0 });
  ed.doc.addEdge({ id: 'e', source: 'a', target: 'b' });
  const t = ed.createNode('text', { x: 400, y: 30 });
  assert.equal(t.w, 'Text'.length * 8 + 8, 'sized to its content on creation');
  const before = { x: t.x, y: t.y };

  ed.commitLabel(t.id, 'Only via VPN');
  assert.equal(ed.doc.getNode(t.id).w, 'Only via VPN'.length * 8 + 8, 'refits after editing');
  assert.equal(ed.router.get('e').points.length, 2, 'not an obstacle for links');

  ed.autoLayout({ animate: false, fit: false });
  assert.deepEqual({ x: ed.doc.getNode(t.id).x, y: ed.doc.getNode(t.id).y }, before, 'auto layout leaves it in place');

  ed.setSelection([t.id]);
  assert.equal(ed.commands.get('edit.quickAdd').enabled(), false, 'no "add connected" from text');
  ed.camera.set({ zoom: 1, x: 0, y: 0 });
  ed.pointerMove({ x: t.x + 10, y: t.y + 10 });
  assert.equal(ed.portNode, null, 'no link handles on hover');

  ed.commitLabel(t.id, '   ');
  assert.equal(ed.doc.nodes.has(t.id), false, 'emptied text is removed');
});

test('polylineCrossesRect: passes through, ends inside, misses', () => {
  const r = { x: 10, y: 10, w: 20, h: 10 };
  assert.equal(polylineCrossesRect([{ x: 0, y: 15 }, { x: 40, y: 15 }], r), true);
  assert.equal(polylineCrossesRect([{ x: 0, y: 0 }, { x: 15, y: 12 }], r), true);
  assert.equal(polylineCrossesRect([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }], r), false);
  assert.equal(polylineCrossesRect([{ x: 0, y: 30 }, { x: 30, y: 21 }], r), false);
});
