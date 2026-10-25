/**
 * Architecture-modeling schema. The engine is domain-agnostic; this file is the only place
 * that knows about modules, services, databases... Icons are 24×24 stroke paths (SVG path
 * syntax) shared by the canvas renderer (Path2D) and the HTML UI.
 */

export const icons = {
  module: 'M21 8 12 3 3 8v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  component: 'M8 3h12v18H8z M4 7h7v3H4z M4 14h7v3H4z',
  service: 'M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  application: 'M3 4h18v16H3z M3 9h18 M6.5 6.5h.01 M9.5 6.5h.01 M7 13h6 M7 16.5h4',
  server: 'M3 4h18v7H3z M3 13h18v7H3z M7 7.5h.01 M7 16.5h.01 M11 7.5h6 M11 16.5h6',
  vm: 'M8 3h13v13H8z M4 8v12.5c0 .3.2.5.5.5H16 M12 7h5 M12 10.5h3',
  container: 'M3 12h6v6H3z M9 12h6v6H9z M15 12h6v6h-6z M6 6h6v6H6z M12 6h6v6h-6z',
  firewall: 'M3 3h18v18H3z M3 9h18 M3 15h18 M8 3v6 M16 3v6 M12 9v6 M8 15v6 M16 15v6',
  bus: 'M3 15h18 M6 15V9 M12 15V6 M18 15v-4 M4.5 9h3 M10.5 6h3 M16.5 11h3',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  queue: 'M3 7h18v10H3z M8 7v10 M13 7v10 M18 7v10',
  client: 'M3 4h18v12H3z M8 20h8 M12 16v4',
  external: 'M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z',
  actor: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 3.6-7 8-7s8 3 8 7',
  note: 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6',
  text: 'M5 6V4h14v2 M12 4v16 M9 20h6',
  legend: 'M4 4h16v16H4z M7 8h2 M12 8h5 M7 12h2 M12 12h5 M7 16h2 M12 16h5',
  boundary: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M11 4h2 M11 20h2 M4 11v2 M20 11v2',
  shield: 'M12 21s7-3.5 7-9.5V5.5L12 3 5 5.5v6c0 6 7 9.5 7 9.5z M9.5 12l2 2 3.5-4',
  network: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
};

export const palette = ['#6366f1', '#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

export const architectureSchema = {
  name: 'Architecture',
  groupType: 'module',
  defaultNodeType: 'component',
  defaultEdgeType: 'uses',
  // `dock` groups the shape dock into sections. `host` types are containers that look like
  // ordinary cards until something is dropped into them (deployment nesting).
  nodeTypes: {
    module: { label: 'Module', container: true, w: 360, h: 240, color: '#6366f1', icon: 'module', shortcut: '1', dock: 'structure', hint: 'Groups components' },
    boundary: {
      label: 'Boundary', container: true, boundary: true, shape: 'boundary', w: 480, h: 320, color: '#e11d48', icon: 'boundary', shortcut: '0', dock: 'structure',
      hint: 'Trust boundary or network zone', techLabel: 'Scope', techPlaceholder: 'e.g. 10.0.0.0/16, PCI DSS, VPN only',
      defaultVariant: 'trust',
      variants: {
        trust: { label: 'Trust boundary', color: '#e11d48', icon: 'shield', markCrossings: true },
        network: { label: 'Network zone', color: '#0284c7', icon: 'network' },
      },
    },
    component: { label: 'Component', w: 200, h: 72, color: '#3b82f6', icon: 'component', shortcut: '2', dock: 'software', hint: 'A building block' },
    application: { label: 'Application', w: 200, h: 72, color: '#c026d3', icon: 'application', dock: 'software', hint: 'A program users or systems run' },
    service: { label: 'Service', w: 200, h: 72, color: '#14b8a6', icon: 'service', shortcut: '3', dock: 'software', hint: 'A deployable unit' },
    database: { label: 'Database', w: 160, h: 96, color: '#f59e0b', icon: 'database', shape: 'cylinder', shortcut: '4', dock: 'software', hint: 'Persistent storage' },
    queue: { label: 'Queue', w: 200, h: 64, color: '#ec4899', icon: 'queue', shortcut: '5', dock: 'software', hint: 'Broker, topic, stream' },
    client: { label: 'Client', w: 200, h: 72, color: '#8b5cf6', icon: 'client', shortcut: '6', dock: 'software', hint: 'Web, mobile, CLI' },
    server: {
      label: 'Server', container: true, host: true, w: 200, h: 72, color: '#f97316', icon: 'server', dock: 'infrastructure',
      hint: 'Physical or bare-metal host', techLabel: 'Specs', techPlaceholder: 'e.g. 32 vCPU · 128 GB, Ubuntu 24.04',
    },
    vm: {
      label: 'Virtual machine', container: true, host: true, w: 200, h: 72, color: '#0891b2', icon: 'vm', dock: 'infrastructure',
      hint: 'A virtualized host', techLabel: 'Image / size', techPlaceholder: 'e.g. EC2 m7i.large, Windows Server',
    },
    container: {
      label: 'Container', container: true, host: true, w: 200, h: 72, color: '#16a34a', icon: 'container', dock: 'infrastructure',
      hint: 'Docker / OCI container, pod', techLabel: 'Image', techPlaceholder: 'e.g. node:22-alpine, nginx:1.27',
    },
    network: {
      label: 'Network', shape: 'bus', w: 360, h: 40, color: '#0284c7', icon: 'bus', dock: 'infrastructure',
      linkType: 'attachment', spawn: 'component',
      hint: 'Shared network segment: attach components to it', techLabel: 'CIDR / VLAN', techPlaceholder: 'e.g. 10.20.0.0/24 · VLAN 120 · isolated',
    },
    firewall: {
      label: 'Firewall', w: 200, h: 72, color: '#dc2626', icon: 'firewall', dock: 'infrastructure', inline: true,
      hint: 'Filters traffic: drop it onto a link to put it in the path', techLabel: 'Policy', techPlaceholder: 'e.g. allow 443 from DMZ · deny all',
    },
    external: { label: 'External system', w: 200, h: 72, color: '#64748b', icon: 'external', dashed: true, shortcut: '7', dock: 'context', hint: 'Third-party system' },
    actor: { label: 'Actor', w: 180, h: 72, color: '#0ea5e9', icon: 'actor', shape: 'actor', shortcut: '8', dock: 'context', hint: 'A person or role' },
    text: {
      label: 'Text', shape: 'text', w: 120, h: 28, color: '#64748b', icon: 'text', shortcut: 't', dock: 'context',
      annotation: true, noPorts: true, hint: 'Free text anywhere on the canvas',
    },
    note: { label: 'Note', w: 220, h: 110, color: '#eab308', icon: 'note', shape: 'note', shortcut: '9', dock: 'context', hint: 'Free-form annotation' },
    legend: {
      label: 'Legend', shape: 'legend', w: 240, h: 120, color: '#64748b', icon: 'legend', dock: 'context',
      annotation: true, noPorts: true, hint: 'Lists the kinds of elements and links in use, kept up to date',
    },
  },
  edgeTypes: {
    uses: { label: 'Uses', arrow: 'open' },
    dataflow: { label: 'Data flow', arrow: 'filled', width: 2 },
    async: { label: 'Async', arrow: 'filled', dash: [7, 5] },
    association: { label: 'Association', arrow: 'none' },
    attachment: { label: 'Attachment', arrow: 'none', width: 1.75, techLabel: 'Address', techPlaceholder: 'e.g. 10.20.0.5, eth1' },
  },
};

/** A small but realistic model, laid out by the auto-layout engine on first load. */
export function sampleDiagram() {
  const nodes = [];
  const edges = [];
  const n = (id, type, label, parent = null, tech = '') => nodes.push({ id, type, label, parent, data: tech ? { tech } : {} });
  const e = (source, target, type = 'uses', label = '', tech = '') =>
    edges.push({ id: `e_${source}_${target}`, type, source, target, label, data: tech ? { tech } : {} });

  n('customer', 'actor', 'Customer');
  n('experience', 'module', 'Experience');
  n('web', 'client', 'Web Storefront', 'experience', 'Next.js');
  n('mobile', 'client', 'Mobile App', 'experience', 'Swift · Kotlin');
  nodes.push({ id: 'vpc', type: 'boundary', label: 'Production VPC', data: { variant: 'network', tech: '10.0.0.0/16' } });
  n('platform', 'module', 'Commerce Platform', 'vpc');
  n('gateway', 'service', 'API Gateway', 'platform', 'Envoy');
  n('orders', 'service', 'Order Service', 'platform', 'Go');
  n('catalog', 'service', 'Catalog Service', 'platform', 'Kotlin');
  nodes.push({ id: 'pci', type: 'boundary', label: 'Cardholder data', parent: 'platform', data: { variant: 'trust', tech: 'PCI DSS scope' } });
  n('payments', 'component', 'Payment Orchestrator', 'pci', 'Node.js');
  n('notify', 'component', 'Notification Worker', 'platform', 'Python');
  n('data', 'module', 'Data', 'vpc');
  n('ordersdb', 'database', 'Orders DB', 'data', 'PostgreSQL');
  n('search', 'database', 'Catalog Index', 'data', 'OpenSearch');
  n('bus', 'queue', 'Event Bus', 'data', 'Kafka');
  n('stripe', 'external', 'Stripe', null, 'Payments API');
  n('email', 'external', 'SendGrid', null, 'Email API');

  e('customer', 'web');
  e('customer', 'mobile');
  e('web', 'gateway', 'uses', 'HTTPS');
  e('mobile', 'gateway', 'uses', 'HTTPS');
  e('gateway', 'orders');
  e('gateway', 'catalog');
  e('orders', 'payments', 'uses', '', 'gRPC');
  e('payments', 'stripe', 'dataflow', 'charges', 'HTTPS');
  e('orders', 'ordersdb', 'dataflow');
  e('catalog', 'search', 'dataflow');
  e('orders', 'bus', 'async', 'OrderPlaced');
  e('bus', 'notify', 'async');
  e('notify', 'email', 'uses', 'SMTP');
  return { nodes, edges };
}
