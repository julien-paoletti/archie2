import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramDocument } from '../src/engine/document.js';
import { architectureSchema, sampleDiagram } from '../src/domain/architecture.js';
import { fromMermaid, toMermaid } from '../src/domain/formats/mermaid.js';
import { toPlantUML } from '../src/domain/formats/plantuml.js';
import { toStructurizr } from '../src/domain/formats/structurizr.js';
import { toMarkdown } from '../src/domain/formats/markdown.js';

const sample = () => {
  const doc = new DiagramDocument(architectureSchema);
  doc.load(sampleDiagram());
  return doc;
};

/** Every opening brace has its closing one, in order. */
const balanced = (text) => {
  let depth = 0;
  for (const line of text.split('\n')) {
    const t = line.replace(/"(?:[^"\\]|\\.)*"/g, '');
    depth += (t.match(/{/g) ?? []).length - (t.match(/}/g) ?? []).length;
    if (depth < 0) return false;
  }
  return depth === 0;
};

test('Mermaid export: shapes, nested subgraphs, arrow kinds, labels', () => {
  const m = toMermaid(sample());
  assert.match(m, /^flowchart LR\n/);
  assert.match(m, /subgraph production_vpc \["Production VPC<br\/>10\.0\.0\.0\/16"\]/);
  assert.match(m, /orders_db\[\("Orders DB<br\/>PostgreSQL"\)\]/, 'database as a cylinder');
  assert.match(m, /customer\(\["Customer"\]\)/, 'actor as a stadium');
  assert.match(m, /order_service -\.->\|"OrderPlaced"\| event_bus/, 'async is dotted');
  assert.match(m, /payment_orchestrator ==>\|"charges<br\/>HTTPS"\| stripe/, 'data flow is thick');
  assert.equal((m.match(/^\s*subgraph /gm) ?? []).length, (m.match(/^\s*end$/gm) ?? []).length);
});

test('Mermaid round trip keeps names, kinds, nesting, links and protocols', () => {
  const doc = sample();
  const model = fromMermaid(toMermaid(doc));
  const byName = new Map(model.nodes.map((n) => [n.label, n]));
  assert.equal(model.nodes.length, doc.nodes.size);
  assert.equal(model.edges.length, doc.edges.size);
  assert.equal(byName.get('Orders DB').type, 'database');
  assert.equal(byName.get('Orders DB').data.tech, 'PostgreSQL');
  assert.equal(byName.get('Customer').type, 'actor');
  assert.equal(byName.get('Commerce Platform').type, 'module');
  assert.equal(byName.get('Order Service').parent, byName.get('Commerce Platform').id, 'nesting kept');
  const charges = model.edges.find((e) => e.label === 'charges');
  assert.deepEqual([charges.type, charges.data.tech], ['dataflow', 'HTTPS']);
  assert.equal(model.edges.find((e) => e.label === 'OrderPlaced').type, 'async');
  // And it loads as a valid document.
  const back = new DiagramDocument(architectureSchema);
  back.load(model);
  assert.equal(back.edges.size, doc.edges.size);
});

test('Mermaid import: the syntax people actually write', () => {
  const m = fromMermaid(`
    graph TD
      %% a comment
      A[Web app] --> B(API);
      B -->|reads| C[(Orders DB)]
      B -- publishes --> Q{{Events}} --> W[[Worker]] & N[Notifier]:::hot
      A-->B
      U((User)) -.-> A
      X --- Y
      subgraph Backend services
        B
        W
      end
      subgraph data [Data stores]
        C
      end
      classDef hot fill:#f00
      click A callback
  `);
  const n = Object.fromEntries(m.nodes.map((x) => [x.id, x]));
  assert.equal(m.direction, 'TB');
  assert.equal(n.A.label, 'Web app');
  assert.equal(n.C.type, 'database');
  assert.equal(n.Q.type, 'queue');
  assert.equal(n.W.type, 'service');
  assert.equal(n.U.type, 'actor');
  const pairs = m.edges.map((e) => `${e.source}>${e.target}:${e.type}:${e.label}`);
  assert.deepEqual(pairs, [
    'A>B:uses:', 'B>C:uses:reads', 'B>Q:uses:publishes', 'Q>W:uses:', 'Q>N:uses:', 'A>B:uses:', 'U>A:async:', 'X>Y:association:',
  ]);
  const backend = m.nodes.find((x) => x.label === 'Backend services');
  assert.equal(backend.type, 'module');
  assert.deepEqual([n.B.parent, n.W.parent], [backend.id, backend.id], 'listed in a subgraph: moved into it');
  assert.equal(n.C.parent, 'data');
  assert.equal(n.data.label, 'Data stores');
  assert.equal(n.A.parent, null);
});

test('Mermaid import errors point at the line', () => {
  assert.throws(() => fromMermaid('sequenceDiagram\nA->>B: hi'), /Line 1: a Mermaid flowchart starts with/);
  assert.throws(() => fromMermaid('flowchart LR\nA --> B\nA ~~> B'), /Line 3: can't read "~~> B"/);
  assert.throws(() => fromMermaid(''), /Empty diagram/);
});

test('PlantUML export: elements, groups, arrows', () => {
  const p = toPlantUML(sample(), { title: 'Shop' });
  assert.match(p, /^@startuml\ntitle Shop\nleft to right direction/);
  assert.match(p, /actor "Customer" as customer/);
  assert.match(p, /database "Orders DB\\n<size:10>PostgreSQL<\/size>" as orders_db/);
  assert.match(p, /queue "Event Bus/);
  assert.match(p, /cloud "Stripe/);
  assert.match(p, /rectangle "Cardholder data\\n<size:10>PCI DSS scope<\/size>" as cardholder_data <<Trust boundary>> #line\.dashed \{/);
  assert.match(p, /order_service \.\.> event_bus : OrderPlaced/);
  assert.match(p, /@enduml\n$/);
  assert.ok(balanced(p));
});

test('Structurizr export: C4 mapping, relationships, views', () => {
  const doc = sample();
  doc.addNode({ id: 'q', type: 'service', label: 'Says "hi"', parent: 'platform' });
  doc.addEdge({ source: 'platform', target: 'q' });
  const s = toStructurizr(doc, { title: 'Shop' });
  assert.ok(balanced(s), 'braces balance');
  assert.match(s, /customer = person "Customer"/);
  assert.match(s, /commerce_platform = softwareSystem "Commerce Platform"/);
  assert.match(s, /order_service = container "Order Service" "" "Go"/);
  assert.match(s, /says_hi = container "Says \\"hi\\""/, 'quotes escaped');
  assert.match(s, /group "Production VPC" \{/);
  assert.match(s, /group "Cardholder data" \{/);
  assert.match(s, /order_service -> event_bus "OrderPlaced" "" "Asynchronous"/);
  assert.match(s, /payment_orchestrator -> stripe "charges" "HTTPS"/);
  assert.ok(!/commerce_platform -> says_hi/.test(s), 'no relationship to its own parent');
  assert.match(s, /container commerce_platform \{/);
  assert.equal((s.match(/group /g) ?? []).length, 2, 'nested boundaries flattened into their group');
});

test('Markdown catalog: elements with where they sit, links table, escaping', () => {
  const doc = sample();
  doc.update('orders', { data: { ...doc.getNode('orders').data, owner: 'Checkout', status: 'deprecated', description: 'a | b\nc', links: ['github.com/acme/orders'] } });
  const md = toMarkdown(doc, { title: 'Shop' });
  assert.match(md, /^# Shop\n/);
  assert.match(md, /\| Order Service \| Service \| Go \| Production VPC › Commerce Platform \| Checkout \| Deprecated \| a \\\| b<br>c \| <github\.com\/acme\/orders> \|/);
  assert.match(md, /\| Payment Orchestrator \| Stripe \| Data flow \| charges \| HTTPS \|/);
});

test('Mermaid in Markdown is found; plain text is not Mermaid', async () => {
  const { extractMermaid, looksLikeMermaid } = await import('../src/domain/formats/mermaid.js');
  const md = '# Notes\n\nSome text.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n';
  assert.equal(extractMermaid(md), 'flowchart LR\n  a --> b\n');
  assert.equal(looksLikeMermaid(md), true);
  assert.equal(looksLikeMermaid('graph TD\nA-->B'), true);
  assert.equal(looksLikeMermaid('just some text about a graph'), false);
  assert.equal(looksLikeMermaid('{"format":"archie-clip"}'), false);
});

test('editor: an imported model is laid out, placed at the pointer and undone in one step', async () => {
  const { Editor } = await import('../src/editor/editor.js');
  const ed = new Editor({ schema: architectureSchema });
  ed.resize(1200, 800);
  ed.doc.addNode({ id: 'existing', type: 'component', x: 0, y: 0 });
  const top = ed.importModel(fromMermaid('flowchart LR\n subgraph s [Shop]\n  a[Web] --> b[(DB)]\n end\n c((User)) --> a'), { at: { x: 2000, y: 1000 } });
  assert.equal(ed.doc.nodes.size, 5);
  assert.equal(top.length, 2, 'the subgraph and the user are top level');
  assert.deepEqual([...ed.selection].sort(), [...top].sort());
  const b = ed.doc.bounds(top);
  assert.ok(Math.abs(b.x + b.w / 2 - 2000) <= 20 && Math.abs(b.y + b.h / 2 - 1000) <= 20, 'centred on the point');
  const shop = ed.doc.nodes.get(top.find((id) => ed.doc.nodes.get(id).type === 'module'));
  for (const kid of ed.doc.children(shop.id)) assert.ok(kid.x >= shop.x && kid.x + kid.w <= shop.x + shop.w, 'contents inside the module');
  ed.undo();
  assert.equal(ed.doc.nodes.size, 1);
});

test('Mermaid import stays fast on hostile input', async () => {
  const { looksLikeMermaid, extractMermaid } = await import('../src/domain/formats/mermaid.js');
  const fast = (label, fn) => {
    const t0 = performance.now();
    try { fn(); } catch { /* errors are fine, hangs are not */ }
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${label}: ${ms.toFixed(0)} ms`);
  };
  fast('spaces after a text arrow', () => fromMermaid('flowchart LR\nA --' + ' '.repeat(9000) + 'x'));
  fast('many space runs', () => fromMermaid('flowchart LR\nA -- ' + 'a '.repeat(4900) + 'b'));
  fast('header scan over many lines', () => looksLikeMermaid('\n'.repeat(500000) + 'x'));
  fast('unclosed tags in a label', () => fromMermaid('flowchart LR\nA["' + '<a'.repeat(4000) + '"]'));
  fast('many ```mermaid openings', () => extractMermaid('```mermaid'.repeat(80000)));
  fast('a huge & cross product', () => fromMermaid('flowchart LR\n' + Array.from({ length: 1000 }, (_, i) => 'a' + i).join(' & ') + ' --> ' + Array.from({ length: 1000 }, (_, i) => 'b' + i).join(' & ')));
  assert.throws(() => fromMermaid('flowchart LR\n' + 'x'.repeat(10001)), /Line 2: too long/);
  assert.throws(() => fromMermaid('flowchart LR\nA -- dangling'), /Line 2: no arrow after/);
  assert.equal(looksLikeMermaid('flowchart LR\n' + 'x'.repeat(1024 * 1024)), false, 'too big to be worth trying');
});
