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

test('sanitizeDiagram loads retired types as their successor', () => {
  const out = sanitizeDiagram({ nodes: [{ id: 'web', type: 'client', label: 'Web', data: { tech: 'React' } }] }, architectureSchema);
  assert.deepEqual([out.nodes[0].type, out.nodes[0].data], ['application', { tech: 'React' }], 'a Client is now an Application');
});

test('sanitizeDiagram keeps only known data and style fields, with the right types', () => {
  const out = sanitizeDiagram({
    nodes: [
      { id: 'a', type: 'constructor' },
      {
        id: 'b', type: 'boundary',
        data: { variant: '__proto__', status: 'toString', stereotype: 5, links: 'x', tech: 'Go', borderOnly: 'yes', junk: { deep: 1 } },
        style: { color: 'url(https://evil.example/p)', textSize: 'huge', align: 'center' },
      },
      {
        id: 'c', type: 'boundary',
        data: { variant: 'network', status: 'planned', links: ['ok.io', 3, 'b.io'], borderOnly: true },
        style: { color: '#22C55E', borderWidth: 3 },
      },
      { id: 'd', type: 'service', style: { borderWidth: 7 } },
      { id: 'g', type: 'service', style: { borderWidth: '3' } },
    ],
    edges: [
      { id: 'e', source: 'b', target: 'c', type: 'hasOwnProperty', data: { tech: 7 },
        style: { color: 1, routing: 'curved', labelT: 3, points: [{ x: 1, y: 2 }, { x: 'a', y: 0 }, null] } },
      { id: 'f', source: 'b', target: 'c', style: { color: '#fff', points: [], routing: 'zigzag' } },
    ],
  }, architectureSchema);
  const [a, b, c] = out.nodes;
  assert.equal(a.type, 'component', 'inherited names are not types');
  assert.deepEqual(b.data, { tech: 'Go' });
  assert.deepEqual(b.style, { align: 'center' }, 'a url() colour is dropped (it could leak who opened the link)');
  assert.deepEqual(c.data, { variant: 'network', status: 'planned', links: ['ok.io', 'b.io'], borderOnly: true });
  assert.deepEqual(c.style, { color: '#22C55E', borderWidth: 3 });
  assert.deepEqual(out.nodes[3].style, {}, 'a width outside the choices is dropped');
  assert.deepEqual(out.nodes[4].style, {}, 'so is one written as text');
  const [e, f] = out.edges;
  assert.equal(e.type, 'uses');
  assert.deepEqual(e.data, {});
  assert.deepEqual(e.style, { routing: 'curved', labelT: 1, points: [{ x: 1, y: 2 }] });
  assert.deepEqual(f.style, {}, 'short hex, empty points and unknown routing dropped');
});
