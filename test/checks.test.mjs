import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { checkDiagram } from '../src/engine/checks.js';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';

const rules = (issues, rule) => issues.filter((i) => i.rule === rule).map((i) => i.id).sort();

test('checks: boundary crossings, orphans, duplicates, default names, empty modules', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.addNode({ id: 'pci', type: 'boundary', label: 'PCI' });
  doc.addNode({ id: 'pay', type: 'component', label: 'Payments', parent: 'pci' });
  doc.addNode({ id: 'api', type: 'service', label: 'API' });
  doc.addNode({ id: 'api2', type: 'service', label: 'api' });
  doc.addNode({ id: 'api3', type: 'service', label: 'API' });
  doc.addNode({ id: 'web', type: 'application', label: 'Web' });
  doc.addNode({ id: 'new', type: 'component', label: 'Component' });
  doc.addNode({ id: 'box', type: 'module', label: 'Later' });
  doc.addNode({ id: 'host', type: 'server', label: 'Host 1' });
  doc.addNode({ id: 'txt', type: 'text', label: 'just a note' });
  doc.addEdge({ id: 'in', source: 'api', target: 'pay' });
  doc.addEdge({ id: 'tls', source: 'web', target: 'api', data: { tech: 'HTTPS' } });
  doc.addEdge({ id: 'plain', source: 'web', target: 'api2' });
  doc.addEdge({ id: 'assoc', source: 'web', target: 'api3', type: 'association' });

  const issues = checkDiagram(doc);
  assert.deepEqual(rules(issues, 'crossing-protocol'), ['in']);
  assert.match(issues.find((i) => i.id === 'in').message, /API → Payments crosses PCI/);
  assert.deepEqual(rules(issues, 'no-protocol'), ['plain'], 'labelled and arrow-less links are fine');
  assert.deepEqual(rules(issues, 'orphan'), ['box', 'host', 'new'], 'not text, not boundaries');
  assert.deepEqual(rules(issues, 'duplicate-name'), ['api', 'api2', 'api3'], 'case-insensitive, same kind');
  assert.deepEqual(rules(issues, 'unnamed'), ['new']);
  assert.deepEqual(rules(issues, 'empty-module'), ['box'], 'hosts may be empty');
  const sev = issues.map((i) => i.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => (a === b ? 0 : a === 'warning' ? -1 : 1)), 'warnings first');
});

test('checks: the sample architecture has no warnings', () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.load(sampleDiagram());
  const warnings = checkDiagram(doc).filter((i) => i.severity === 'warning');
  assert.deepEqual(warnings.map((w) => `${w.rule} ${w.message}`), []);
});
