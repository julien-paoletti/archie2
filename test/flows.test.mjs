import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { History } from '../src/engine/history.js';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';
import { flowToMermaidSequence } from '../src/domain/formats/sequence.js';
import { sanitizeDiagram } from '../src/engine/schema.js';

test('flows live in the document: undoable, saved, and pruned with their links', () => {
  const doc = new DiagramDocument(architectureSchema);
  const history = new History(doc);
  doc.load(sampleDiagram());
  const f = doc.flows.get('checkout');
  assert.equal(f.steps.length, 9);
  assert.deepEqual(doc.toJSON().flows[0].steps[6], { edge: 'e_payments_stripe', label: 'Payment confirmed', reverse: true });

  doc.transact('x', () => doc.remove(['stripe']));
  assert.equal(doc.flows.get('checkout').steps.length, 7, 'steps over the removed links went with them');
  history.undo();
  assert.equal(doc.flows.get('checkout').steps.length, 9, 'and came back with undo');

  doc.transact('x', () => doc.remove(['checkout']));
  assert.equal(doc.flows.size, 0);
  history.undo();
  assert.equal(doc.flows.get('checkout').name, 'Checkout');
});

test('loading and sanitizing drop steps over links that do not exist', () => {
  const json = { ...sampleDiagram() };
  json.flows = [{ id: 'f', name: 'x', steps: [{ edge: 'nope' }, { edge: 'e_web_gateway', label: 'ok' }] }, { id: 'e_web_gateway', name: 'clash' }];
  const clean = sanitizeDiagram(json, architectureSchema);
  assert.deepEqual(clean.flows, [{ id: 'f', name: 'x', steps: [{ edge: 'e_web_gateway', label: 'ok' }] }]);
  const doc = new DiagramDocument(architectureSchema);
  doc.load({ ...json, flows: [{ id: 'g', steps: [{ edge: 'nope' }] }] });
  assert.deepEqual(doc.flows.get('g').steps, []);
});

test('editor: record a flow by clicking links, edit steps, play it', async () => {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1200, 800);
  ed.camera.set({ x: 0, y: 0, zoom: 1 });
  ed.doc.addNode({ id: 'a', type: 'service', x: 100, y: 100, w: 200, h: 72 });
  ed.doc.addNode({ id: 'b', type: 'service', x: 500, y: 100, w: 200, h: 72 });
  ed.doc.addNode({ id: 'c', type: 'database', x: 900, y: 100, w: 160, h: 96 });
  ed.doc.addEdge({ id: 'ab', source: 'a', target: 'b' });
  ed.doc.addEdge({ id: 'bc', source: 'b', target: 'c' });
  for (const id of ['ab', 'bc']) ed.router.get(id);

  const f = ed.createFlow('Read');
  assert.equal(ed.flow.recording, true);
  const click = (x, y) => { ed.pointerDown({ x, y, button: 0 }); ed.pointerUp({ x, y, button: 0 }); };
  click(400, 136);
  click(800, 148);
  click(400, 136);
  assert.deepEqual(ed.doc.flows.get(f.id).steps.map((s) => s.edge), ['ab', 'bc', 'ab']);
  assert.equal(ed.selection.size, 0, 'recording does not select');

  ed.updateFlowStep(f.id, 2, { reverse: true, label: 'rows' });
  ed.moveFlowStep(f.id, 2, -1);
  assert.deepEqual(ed.doc.flows.get(f.id).steps.map((s) => `${s.edge}${s.reverse ? '<' : ''}`), ['ab', 'ab<', 'bc']);
  ed.removeFlowStep(f.id, 2);

  ed.playFlow(f.id);
  assert.equal(ed.flow.step, 0);
  ed.keyDown({ key: 'ArrowRight' });
  assert.equal(ed.currentStep().label, 'rows');
  ed.keyDown({ key: 'ArrowRight' });
  assert.equal(ed.flow.step, 1, 'stops at the last step');
  const focus = ed.flowFocus();
  assert.deepEqual([...focus.edges], ['ab']);
  assert.ok(focus.nodes.has('a') && focus.nodes.has('b') && !focus.nodes.has('c'));
  ed.escape();
  assert.equal(ed.flow.step, -1, 'Esc stops playing');
  assert.equal(ed.flow.id, f.id, 'but keeps the flow on show');

  // Undoing the flow's creation clears it from view.
  while (ed.doc.flows.size) ed.undo();
  assert.equal(ed.flow.id, null);
});

test('a flow as a Mermaid sequence diagram', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.load(sampleDiagram());
  const seq = flowToMermaidSequence(doc, 'checkout');
  assert.match(seq, /^sequenceDiagram\n  title Checkout\n  actor customer as Customer\n  participant web_storefront as Web Storefront/);
  assert.match(seq, /payment_orchestrator->>stripe: Create payment intent\n  stripe-->>payment_orchestrator: Payment confirmed/);
  assert.match(seq, /order_service-\)event_bus: Publish OrderPlaced/, 'async step');
});
