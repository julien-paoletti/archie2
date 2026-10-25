import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDiagram, encodeDiagram, parseShareHash } from '../src/ui/share.js';
import { sanitizeDiagram } from '../src/engine/schema.js';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';

test('share links round-trip a diagram and stay compact', async () => {
  const json = { title: 'Shop — “quoted” ✓', ...sampleDiagram() };
  const code = await encodeDiagram(json);
  assert.match(code, /^[A-Za-z0-9_-]+$/, 'URL-safe');
  assert.ok(code.length < JSON.stringify(json).length / 2, `compressed: ${code.length} chars`);
  assert.deepEqual(await decodeDiagram(code), json);
});

test('share hashes: edit and view modes, nothing else', () => {
  assert.deepEqual(parseShareHash('#d=abc_-1'), { mode: 'edit', data: 'abc_-1' });
  assert.deepEqual(parseShareHash('#v=xyz'), { mode: 'view', data: 'xyz' });
  for (const h of ['', '#', '#x=abc', '#d=', '#d=a b', '#d=<script>']) assert.equal(parseShareHash(h), null, h);
});

test('a link that inflates past the limit is refused', async () => {
  const huge = { nodes: [{ id: 'a', label: 'x'.repeat(25 * 1024 * 1024) }] };
  const code = await encodeDiagram(huge);
  await assert.rejects(decodeDiagram(code), /too large/);
});

test('sanitizeDiagram repairs what it can and refuses what is not a diagram', () => {
  assert.throws(() => sanitizeDiagram(null, architectureSchema), /not an Archie diagram/);
  assert.throws(() => sanitizeDiagram({ edges: [] }, architectureSchema), /not an Archie diagram/);
  const out = sanitizeDiagram({
    title: 42,
    camera: { x: 1, y: 2, zoom: 1e9 },
    nodes: [
      { id: 'a', type: 'nope', x: 'NaN', w: -5, label: 'A', data: { links: ['x'] }, style: [1, 2] },
      { id: 'a', type: 'service' },
      { id: 'b', type: 'service', parent: 'c' },
      { id: 'c', type: 'module', parent: 'b' },
      { id: 'd', parent: 'ghost', label: { toString: () => 'obj' } },
      'junk',
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b', type: 'weird' },
      { id: 'e2', source: 'a', target: 'ghost' },
      { id: 'a', source: 'a', target: 'b' },
    ],
  }, architectureSchema);
  assert.equal(out.title, '42');
  assert.equal(out.camera.zoom, 8, 'zoom clamped');
  assert.deepEqual(out.nodes.map((n) => n.id), ['a', 'b', 'c', 'd'], 'duplicates and junk dropped');
  const a = out.nodes[0];
  assert.deepEqual([a.type, a.x, a.w, a.style], ['component', 0, 1, {}], 'unknown type → default; bad numbers fixed');
  assert.deepEqual(a.data, { links: ['x'] });
  const parents = Object.fromEntries(out.nodes.map((n) => [n.id, n.parent]));
  assert.ok(parents.b === null || parents.c === null, 'the b ↔ c cycle is broken');
  assert.equal(parents.d, null, 'missing parent dropped');
  assert.deepEqual(out.edges.map((e) => [e.id, e.type]), [['e1', 'uses']], 'dangling and id-clashing links dropped');
});
