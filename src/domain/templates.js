/**
 * Starter templates: small, realistic models laid out by the auto-layout engine when opened.
 * Each `build()` returns { nodes, edges } in the document format.
 */

function model() {
  const nodes = [], edges = [];
  const n = (id, type, label, parent = null, tech = '', data = {}) =>
    nodes.push({ id, type, label, parent, data: { ...(tech ? { tech } : {}), ...data } });
  const e = (source, target, type = 'uses', label = '', tech = '') =>
    edges.push({ id: `e_${source}_${target}`, type, source, target, label, data: tech ? { tech } : {} });
  return { nodes, edges, n, e };
}

export const templates = [
  {
    id: 'web-app',
    title: 'Web application',
    description: 'Three tiers: a single-page app, an API and its data, with identity provider, cache and object storage.',
    icon: 'application',
    build() {
      const { nodes, edges, n, e } = model();
      n('user', 'actor', 'User');
      n('idp', 'external', 'Identity provider', null, 'OIDC');
      n('cdn', 'external', 'CDN', null, 'Static assets');
      n('vpc', 'boundary', 'Production', null, '10.0.0.0/16', { variant: 'network' });
      n('app', 'module', 'Web application', 'vpc');
      n('spa', 'application', 'Web app', 'app', 'React', { stereotype: 'Frontend' });
      n('api', 'service', 'API', 'app', 'Node.js', { stereotype: 'Backend' });
      n('worker', 'component', 'Background jobs', 'app', 'Node.js');
      n('data', 'module', 'Data', 'vpc');
      n('db', 'database', 'Main database', 'data', 'PostgreSQL');
      n('cache', 'database', 'Cache', 'data', 'Redis');
      n('files', 'database', 'File storage', 'data', 'S3');
      n('jobs', 'queue', 'Job queue', 'data', 'SQS');
      e('user', 'spa', 'uses', 'browses');
      e('user', 'idp', 'uses', 'signs in', 'HTTPS');
      e('spa', 'cdn', 'uses', 'loads', 'HTTPS');
      e('spa', 'api', 'uses', '', 'HTTPS/JSON');
      e('api', 'idp', 'uses', 'verifies tokens', 'HTTPS');
      e('api', 'db', 'dataflow', '', 'SQL');
      e('api', 'cache', 'dataflow', '', 'RESP');
      e('api', 'files', 'dataflow', 'uploads', 'HTTPS');
      e('api', 'jobs', 'async', 'enqueues', 'SQS');
      e('jobs', 'worker', 'async', '', 'SQS');
      e('worker', 'db', 'dataflow', '', 'SQL');
      return { nodes, edges };
    },
  },
  {
    id: 'event-driven',
    title: 'Event-driven system',
    description: 'Services publish domain events to a broker; consumers react, with a dead-letter topic and stream processing.',
    icon: 'queue',
    build() {
      const { nodes, edges, n, e } = model();
      n('client', 'application', 'Clients', null, 'Web · Mobile');
      n('producers', 'module', 'Commands');
      n('orders', 'service', 'Orders', 'producers', 'Java');
      n('payments', 'service', 'Payments', 'producers', 'Go');
      n('broker', 'module', 'Event broker');
      n('topic', 'queue', 'Domain events', 'broker', 'Kafka');
      n('dlq', 'queue', 'Dead letters', 'broker', 'Kafka');
      n('consumers', 'module', 'Reactions');
      n('shipping', 'service', 'Shipping', 'consumers', 'Kotlin');
      n('notify', 'component', 'Notifications', 'consumers', 'Python');
      n('stream', 'component', 'Stream processor', 'consumers', 'Flink');
      n('ordersdb', 'database', 'Orders DB', 'producers', 'PostgreSQL');
      n('warehouse', 'database', 'Analytics', null, 'BigQuery');
      n('email', 'external', 'Email provider', null, 'SendGrid');
      e('client', 'orders', 'uses', 'places orders', 'HTTPS');
      e('orders', 'ordersdb', 'dataflow', '', 'SQL');
      e('orders', 'topic', 'async', 'OrderPlaced', 'Kafka');
      e('payments', 'topic', 'async', 'PaymentCaptured', 'Kafka');
      e('topic', 'shipping', 'async', '', 'Kafka');
      e('topic', 'notify', 'async', '', 'Kafka');
      e('topic', 'stream', 'async', '', 'Kafka');
      e('topic', 'payments', 'async', 'OrderPlaced', 'Kafka');
      e('shipping', 'dlq', 'async', 'failures', 'Kafka');
      e('notify', 'email', 'uses', '', 'SMTP');
      e('stream', 'warehouse', 'dataflow', '', 'gRPC');
      return { nodes, edges };
    },
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes deployment',
    description: 'Where things run: an ingress, node pools hosting pods, and managed services outside the cluster.',
    icon: 'container',
    build() {
      const { nodes, edges, n, e } = model();
      n('users', 'actor', 'Users');
      n('lb', 'firewall', 'Load balancer', null, 'allow 443');
      n('cluster', 'boundary', 'Kubernetes cluster', null, 'EKS 1.31', { variant: 'network' });
      n('ingress', 'component', 'Ingress controller', 'cluster', 'NGINX');
      n('pool1', 'vm', 'General node pool', 'cluster', 'm7i.large × 3');
      n('webpod', 'container', 'web', 'pool1', 'nginx:1.27');
      n('web', 'application', 'Web front end', 'webpod', 'Static');
      n('apipod', 'container', 'api', 'pool1', 'api:2.4.1');
      n('api', 'service', 'API', 'apipod', 'Go');
      n('pool2', 'vm', 'Jobs node pool', 'cluster', 'c7i.xlarge × 2');
      n('jobpod', 'container', 'worker', 'pool2', 'worker:2.4.1');
      n('worker', 'component', 'Worker', 'jobpod', 'Go');
      n('managed', 'boundary', 'Managed services', null, 'Private endpoints', { variant: 'trust' });
      n('db', 'database', 'Database', 'managed', 'RDS PostgreSQL');
      n('queue', 'queue', 'Queue', 'managed', 'SQS');
      n('secrets', 'component', 'Secrets', 'managed', 'Secrets Manager');
      e('users', 'lb', 'uses', '', 'HTTPS');
      e('lb', 'ingress', 'uses', '', 'HTTPS');
      e('ingress', 'web', 'uses', '/', 'HTTP');
      e('ingress', 'api', 'uses', '/api', 'HTTP');
      e('api', 'db', 'dataflow', '', 'SQL/TLS');
      e('api', 'queue', 'async', 'jobs', 'HTTPS');
      e('queue', 'worker', 'async', '', 'HTTPS');
      e('worker', 'db', 'dataflow', '', 'SQL/TLS');
      e('api', 'secrets', 'uses', 'reads', 'HTTPS');
      return { nodes, edges };
    },
  },
  {
    id: 'context',
    title: 'System context',
    description: 'The big picture: your system as one box, the people who use it and the systems it talks to.',
    icon: 'actor',
    build() {
      const { nodes, edges, n, e } = model();
      n('customer', 'actor', 'Customer', null, '', { description: 'Buys products online.' });
      n('staff', 'actor', 'Support staff', null, '', { description: 'Helps customers with their orders.' });
      n('shop', 'application', 'Online shop', null, 'Web · Mobile', { stereotype: 'Software system', description: 'Lets customers browse and buy products.' });
      n('erp', 'external', 'ERP', null, 'Stock and invoicing');
      n('payments', 'external', 'Payment provider', null, 'Card payments');
      n('email', 'external', 'Email service', null, 'Transactional email');
      e('customer', 'shop', 'uses', 'browses and buys', 'HTTPS');
      e('staff', 'shop', 'uses', 'manages orders', 'HTTPS');
      e('shop', 'erp', 'uses', 'syncs stock', 'REST/JSON');
      e('shop', 'payments', 'uses', 'charges cards', 'HTTPS');
      e('shop', 'email', 'uses', 'sends receipts', 'HTTPS');
      return { nodes, edges };
    },
  },
];
