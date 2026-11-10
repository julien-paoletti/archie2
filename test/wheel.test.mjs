import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectureSchema } from '../src/domain/architecture.js';
import { Editor } from '../src/editor/editor.js';

function editor() {
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1200, 800);
  ed.camera.set({ x: 0, y: 0, zoom: 1 });
  return ed;
}
const at = { x: 600, y: 400 };

test('the mouse wheel pans: down, and sideways with Shift', () => {
  const ed = editor();
  ed.wheel({ ...at, dx: 0, dy: 100, deltaMode: 0 });
  assert.deepEqual([ed.camera.x, ed.camera.y, ed.camera.zoom], [0, 100, 1]);
  ed.wheel({ ...at, dx: 0, dy: 48, deltaMode: 1, shift: true });
  assert.deepEqual([ed.camera.x, ed.camera.y, ed.camera.zoom], [48, 100, 1]);
});

test('Ctrl/⌘ + wheel zooms around the pointer, one even step per notch', () => {
  const ed = editor();
  const before = ed.camera.toWorld(at);
  ed.wheel({ ...at, dx: 0, dy: -100, deltaMode: 0, mod: true });
  const z = ed.camera.zoom;
  assert.ok(z > 1.1 && z < 1.3, `a notch zooms in a little (${z})`);
  assert.deepEqual(ed.camera.toWorld(at), before, 'the point under the pointer stays put');
  ed.wheel({ ...at, dx: 0, dy: 100, deltaMode: 0, mod: true });
  assert.ok(Math.abs(ed.camera.zoom - 1) < 1e-9, 'a notch back undoes it');
});

test('a pinch (Ctrl + fine deltas) follows the fingers', () => {
  const ed = editor();
  ed.wheel({ ...at, dx: 0, dy: -3.5, deltaMode: 0, mod: true });
  assert.ok(Math.abs(ed.camera.zoom - Math.exp(0.035)) < 1e-9);
});
