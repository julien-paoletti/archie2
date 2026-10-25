import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templates } from '../src/domain/templates.js';
import { architectureSchema } from '../src/domain/architecture.js';
import { checkDiagram } from '../src/engine/checks.js';
import { overlaps } from '../src/engine/geometry.js';

for (const t of templates) {
  test(`template "${t.title}" loads, lays out cleanly and passes the checks`, async () => {
    const { Editor } = await import('../src/editor/editor.js');
    const ed = new Editor({ schema: architectureSchema });
    const model = t.build();
    ed.load(model, { fit: false });
    assert.equal(ed.doc.nodes.size, model.nodes.length);
    assert.equal(ed.doc.edges.size, model.edges.length, 'every link has both ends');
    for (const n of model.nodes) assert.ok(architectureSchema.nodeTypes[n.type], `${n.id}: known type ${n.type}`);
    ed.autoLayout({ history: false, animate: false, fit: false });
    // Siblings never overlap after layout.
    for (const n of ed.doc.nodes.values()) {
      const sibs = ed.doc.children(n.parent).filter((s) => s.id !== n.id);
      for (const s of sibs) assert.ok(!overlaps(n, s), `${n.id} overlaps ${s.id}`);
    }
    const warnings = checkDiagram(ed.doc).filter((i) => i.severity === 'warning');
    assert.deepEqual(warnings.map((w) => `${w.rule}: ${w.message}`), []);
  });
}
