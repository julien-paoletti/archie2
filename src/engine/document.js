import { Emitter } from './emitter.js';
import { SpatialHash } from './spatial.js';
import { boundsOf } from './geometry.js';

/**
 * The diagram document: a tree of nodes (containers nest children through `parent`)
 * plus a set of edges. It is schema-driven and knows nothing about rendering or any domain.
 *
 * Every mutation happens inside a transaction and is recorded as an invertible op:
 *   { t: 'add' | 'del', k: 'node' | 'edge', id, v }          // v = full snapshot
 *   { t: 'set', k, id, before: {...}, after: {...} }         // changed keys only
 * A committed transaction emits `change` (for views) and `commit` (for history).
 * Nested objects (`data`, `style`) are treated as immutable values: replace, never mutate.
 */

const GEOM_KEYS = ['x', 'y', 'w', 'h'];

let seq = 0;
export function uid(prefix = 'n') {
  seq = (seq + 1) % 1679616;
  return prefix + Date.now().toString(36).slice(-5) + seq.toString(36).padStart(4, '0') + Math.random().toString(36).slice(2, 5);
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Append an op, folding it into an earlier op on the same entity when possible. */
function pushOp(ops, index, op) {
  const key = op.k + ':' + op.id;
  const i = index.get(key);
  const prev = i === undefined ? null : ops[i];
  if (prev) {
    if (op.t === 'set' && prev.t === 'set') {
      prev.before = { ...op.before, ...prev.before };
      prev.after = { ...prev.after, ...op.after };
      return;
    }
    if (op.t === 'set' && prev.t === 'add') {
      Object.assign(prev.v, structuredClone(op.after));
      return;
    }
    if (op.t === 'del' && prev.t === 'add') {
      ops[i] = null;
      index.delete(key);
      return;
    }
  }
  ops.push(op);
  index.set(key, ops.length - 1);
}

function cloneOp(op) {
  return op.t === 'set'
    ? { t: 'set', k: op.k, id: op.id, before: { ...op.before }, after: { ...op.after } }
    : { t: op.t, k: op.k, id: op.id, v: structuredClone(op.v) };
}

/** Merge a list of ops into the minimal equivalent list. */
export function compressOps(list) {
  const out = [];
  const index = new Map();
  for (const op of list) pushOp(out, index, cloneOp(op));
  return out.filter(Boolean);
}

export class DiagramDocument extends Emitter {
  nodes = new Map();
  edges = new Map();
  index = new SpatialHash(256);
  version = 0;

  #children = new Map();
  #adjacency = new Map();
  #order = null;
  #orderIndex = null;
  #tx = null;
  #z = 0;
  #hidden = { version: -1, set: new Set() };

  constructor(schema = {}) {
    super();
    this.schema = schema;
  }

  // ───────────────────────────── queries

  getNode(id) { return this.nodes.get(id); }
  getEdge(id) { return this.edges.get(id); }
  get(id) { return this.nodes.get(id) ?? this.edges.get(id); }
  has(id) { return this.nodes.has(id) || this.edges.has(id); }
  kindOf(id) { return this.nodes.has(id) ? 'node' : this.edges.has(id) ? 'edge' : null; }

  /** Container types hold children, unless the node is set to `data.borderOnly` (an outline only). */
  isContainer(node) {
    const n = typeof node === 'string' ? this.nodes.get(node) : node;
    return !!n && !!this.schema.nodeTypes?.[n.type]?.container && !n.data?.borderOnly;
  }

  children(id = null) {
    const set = this.#children.get(id);
    if (!set) return [];
    return [...set].map((c) => this.nodes.get(c)).sort((a, b) => a.z - b.z);
  }

  hasChildren(id) {
    return (this.#children.get(id)?.size ?? 0) > 0;
  }

  descendants(id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const set = this.#children.get(stack.pop());
      if (!set) continue;
      for (const c of set) {
        out.push(c);
        stack.push(c);
      }
    }
    return out;
  }

  ancestors(id) {
    const out = [];
    let p = this.nodes.get(id)?.parent;
    while (p != null && this.nodes.has(p) && out.length < 1000) {
      out.push(p);
      p = this.nodes.get(p).parent;
    }
    return out;
  }

  isAncestor(ancestorId, id) {
    let p = this.nodes.get(id)?.parent;
    for (let guard = 0; p != null && guard < 1000; guard++) {
      if (p === ancestorId) return true;
      p = this.nodes.get(p)?.parent;
    }
    return false;
  }

  depth(id) {
    return this.ancestors(id).length;
  }

  edgesOf(id) {
    const set = this.#adjacency.get(id);
    return set ? [...set].map((e) => this.edges.get(e)) : [];
  }

  /** Node ids in painter's order: depth-first through the containment tree, siblings by z. */
  order() {
    if (!this.#order) {
      const out = [];
      const visit = (parent) => {
        for (const n of this.children(parent)) {
          out.push(n.id);
          visit(n.id);
        }
      };
      visit(null);
      // Orphans (parent missing) still need to be drawn.
      if (out.length !== this.nodes.size) {
        const seen = new Set(out);
        for (const id of this.nodes.keys()) if (!seen.has(id)) out.push(id);
      }
      this.#order = out;
      this.#orderIndex = new Map(out.map((id, i) => [id, i]));
    }
    return this.#order;
  }

  orderIndex(id) {
    this.order();
    return this.#orderIndex.get(id) ?? -1;
  }

  /** Ids of nodes inside a collapsed container (cached per document version). */
  hidden() {
    if (this.#hidden.version !== this.version) {
      const set = new Set();
      for (const n of this.nodes.values()) {
        if (n.collapsed && !set.has(n.id)) for (const d of this.descendants(n.id)) set.add(d);
      }
      this.#hidden = { version: this.version, set };
    }
    return this.#hidden.set;
  }

  /** The node itself, or its outermost collapsed ancestor: what stands in for it on screen. */
  visibleAncestor(id) {
    let v = id;
    for (const a of this.ancestors(id)) if (this.nodes.get(a).collapsed) v = a;
    return v;
  }

  bounds(ids) {
    const list = ids ? [...ids].map((id) => this.nodes.get(id)).filter(Boolean) : [...this.nodes.values()];
    return boundsOf(list);
  }

  nextZ() {
    return ++this.#z;
  }

  // ───────────────────────────── transactions

  get inTransaction() {
    return this.#tx !== null;
  }

  /**
   * Run `fn` as one atomic, undoable unit. Nested calls join the outer transaction.
   * opts: { merge?: key (history coalescing), animate?: bool, history?: false, source?: string }
   */
  transact(label, fn, opts = {}) {
    if (this.#tx) {
      if (opts.animate) this.#tx.opts.animate = true;
      return fn(this);
    }
    this.#tx = { label, ops: [], index: new Map(), opts: { ...opts } };
    this.emit('txstart', { label, opts });
    let result;
    try {
      result = fn(this);
    } catch (err) {
      const { ops } = this.#tx;
      this.#tx = null;
      for (const op of ops.filter(Boolean).reverse()) this.#applyRaw(op, true);
      this.#order = null;
      throw err;
    }
    const tx = this.#tx;
    this.#tx = null;
    const ops = tx.ops.filter(Boolean);
    if (ops.length) {
      this.version++;
      const patch = { label: tx.label, ops, merge: tx.opts.merge ?? null, animate: !!tx.opts.animate };
      this.emit('change', { patch, source: tx.opts.source ?? 'local' });
      if (tx.opts.history !== false) this.emit('commit', patch);
    }
    return result;
  }

  #run(label, fn) {
    return this.#tx ? fn() : this.transact(label, fn);
  }

  #rec(op) {
    pushOp(this.#tx.ops, this.#tx.index, op);
  }

  // ───────────────────────────── mutations

  addNode(data) {
    const node = this.#normalizeNode(data);
    if (this.nodes.has(node.id)) throw new Error(`Duplicate id ${node.id}`);
    this.#run('Add node', () => {
      this.#insert('node', node);
      this.#rec({ t: 'add', k: 'node', id: node.id, v: structuredClone(node) });
    });
    return node;
  }

  addEdge(data) {
    const edge = this.#normalizeEdge(data);
    if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) throw new Error('Edge endpoints must exist');
    if (this.edges.has(edge.id)) throw new Error(`Duplicate id ${edge.id}`);
    this.#run('Add edge', () => {
      this.#insert('edge', edge);
      this.#rec({ t: 'add', k: 'edge', id: edge.id, v: structuredClone(edge) });
    });
    return edge;
  }

  /** Shallow-assign `values` to a node or edge. Returns true if anything changed. */
  update(id, values) {
    const kind = this.kindOf(id);
    if (!kind) return false;
    const obj = this.get(id);
    const before = {}, after = {};
    let changed = false;
    for (const k in values) {
      if (k === 'id') continue;
      if (!valuesEqual(obj[k], values[k])) {
        before[k] = obj[k];
        after[k] = values[k];
        changed = true;
      }
    }
    if (!changed) return false;
    if (kind === 'node' && 'parent' in after && after.parent != null) {
      if (after.parent === id || this.isAncestor(id, after.parent)) throw new Error('Cannot parent a node inside itself');
    }
    this.#run('Update', () => {
      this.#assign(kind, id, after);
      this.#rec({ t: 'set', k: kind, id, before, after });
    });
    return true;
  }

  /** Remove nodes (with their descendants) and edges, plus every edge left dangling. */
  remove(ids) {
    const nodeIds = new Set();
    const edgeIds = new Set();
    for (const id of ids) {
      if (this.nodes.has(id)) {
        nodeIds.add(id);
        for (const d of this.descendants(id)) nodeIds.add(d);
      } else if (this.edges.has(id)) {
        edgeIds.add(id);
      }
    }
    for (const n of nodeIds) for (const e of this.#adjacency.get(n) ?? []) edgeIds.add(e);
    if (!nodeIds.size && !edgeIds.size) return;
    const depth = new Map([...nodeIds].map((id) => [id, this.depth(id)]));
    this.#run('Delete', () => {
      for (const id of edgeIds) {
        this.#rec({ t: 'del', k: 'edge', id, v: structuredClone(this.edges.get(id)) });
        this.#delete('edge', id);
      }
      for (const id of [...nodeIds].sort((a, b) => depth.get(b) - depth.get(a))) {
        this.#rec({ t: 'del', k: 'node', id, v: structuredClone(this.nodes.get(id)) });
        this.#delete('node', id);
      }
    });
  }

  /** Translate nodes together with all their descendants. */
  moveBy(ids, dx, dy) {
    if (!dx && !dy) return;
    const all = new Set();
    for (const id of ids) {
      if (!this.nodes.has(id)) continue;
      all.add(id);
      for (const d of this.descendants(id)) all.add(d);
    }
    this.#run('Move', () => {
      for (const id of all) {
        const n = this.nodes.get(id);
        this.update(id, { x: n.x + dx, y: n.y + dy });
      }
    });
  }

  /** Apply a recorded op list forwards or backwards (undo/redo, remote sync). */
  applyPatch(ops, { inverse = false, source = 'patch', animate = false } = {}) {
    const list = inverse ? [...ops].reverse() : ops;
    this.transact(source, () => {
      for (const op of list) {
        const t = !inverse ? op.t : op.t === 'add' ? 'del' : op.t === 'del' ? 'add' : 'set';
        if (t === 'add') {
          if (this.has(op.id)) continue;
          this.#insert(op.k, structuredClone(op.v));
          this.#rec({ t: 'add', k: op.k, id: op.id, v: structuredClone(op.v) });
        } else if (t === 'del') {
          const cur = this.get(op.id);
          if (!cur) continue;
          this.#rec({ t: 'del', k: op.k, id: op.id, v: structuredClone(cur) });
          this.#delete(op.k, op.id);
        } else {
          if (!this.has(op.id)) continue;
          const before = inverse ? op.after : op.before;
          const after = inverse ? op.before : op.after;
          this.#assign(op.k, op.id, after);
          this.#rec({ t: 'set', k: op.k, id: op.id, before: { ...before }, after: { ...after } });
        }
      }
    }, { history: false, source, animate });
  }

  // ───────────────────────────── serialization

  toJSON() {
    return {
      format: 'archie',
      version: 1,
      nodes: this.order().map((id) => structuredClone(this.nodes.get(id))),
      edges: [...this.edges.values()].map((e) => structuredClone(e)),
    };
  }

  /** Replace the whole content. Not undoable; emits a `change` with `reset: true`. */
  load(json = {}) {
    this.#clearRaw();
    for (const raw of json.nodes ?? []) this.#insert('node', this.#normalizeNode(raw));
    for (const raw of json.edges ?? []) {
      const e = this.#normalizeEdge(raw);
      if (this.nodes.has(e.source) && this.nodes.has(e.target)) this.#insert('edge', e);
    }
    this.version++;
    this.emit('change', { patch: { label: 'Load', ops: [], merge: null, animate: false }, source: 'load', reset: true });
  }

  clear() {
    this.load({});
  }

  // ───────────────────────────── internals

  #normalizeNode(d) {
    const type = d.type ?? this.schema.defaultNodeType ?? 'node';
    const t = this.schema.nodeTypes?.[type] ?? {};
    const z = d.z ?? ++this.#z;
    if (z > this.#z) this.#z = z;
    return {
      id: d.id ?? uid('n'),
      type,
      parent: d.parent ?? null,
      x: d.x ?? 0,
      y: d.y ?? 0,
      w: d.w ?? t.w ?? 160,
      h: d.h ?? t.h ?? 80,
      label: d.label ?? '',
      data: d.data ? { ...d.data } : {},
      style: d.style ? { ...d.style } : {},
      z,
      ...(d.collapsed ? { collapsed: true, expanded: d.expanded ?? null } : {}),
    };
  }

  #normalizeEdge(d) {
    return {
      id: d.id ?? uid('e'),
      type: d.type ?? this.schema.defaultEdgeType ?? 'edge',
      source: d.source,
      target: d.target,
      label: d.label ?? '',
      data: d.data ? { ...d.data } : {},
      style: d.style ? { ...d.style } : {},
    };
  }

  #link(map, key, id) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(id);
  }

  #unlink(map, key, id) {
    const set = map.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }

  #insert(kind, obj) {
    if (kind === 'node') {
      this.nodes.set(obj.id, obj);
      this.#link(this.#children, obj.parent ?? null, obj.id);
      this.index.set(obj.id, obj);
      if (obj.z > this.#z) this.#z = obj.z;
      this.#order = null;
    } else {
      this.edges.set(obj.id, obj);
      this.#link(this.#adjacency, obj.source, obj.id);
      this.#link(this.#adjacency, obj.target, obj.id);
    }
  }

  #delete(kind, id) {
    if (kind === 'node') {
      const n = this.nodes.get(id);
      if (!n) return;
      this.nodes.delete(id);
      this.#unlink(this.#children, n.parent ?? null, id);
      this.index.delete(id);
      this.#order = null;
    } else {
      const e = this.edges.get(id);
      if (!e) return;
      this.edges.delete(id);
      this.#unlink(this.#adjacency, e.source, id);
      this.#unlink(this.#adjacency, e.target, id);
    }
  }

  #assign(kind, id, values) {
    const obj = kind === 'node' ? this.nodes.get(id) : this.edges.get(id);
    if (!obj) return;
    if (kind === 'node') {
      if ('parent' in values && values.parent !== obj.parent) {
        this.#unlink(this.#children, obj.parent ?? null, id);
        this.#link(this.#children, values.parent ?? null, id);
        this.#order = null;
      }
      Object.assign(obj, values);
      if ('z' in values) this.#order = null;
      if (GEOM_KEYS.some((k) => k in values)) this.index.set(id, obj);
    } else {
      if ('source' in values || 'target' in values) {
        this.#unlink(this.#adjacency, obj.source, id);
        this.#unlink(this.#adjacency, obj.target, id);
        Object.assign(obj, values);
        this.#link(this.#adjacency, obj.source, id);
        this.#link(this.#adjacency, obj.target, id);
      } else {
        Object.assign(obj, values);
      }
    }
  }

  #applyRaw(op, inverse) {
    const t = !inverse ? op.t : op.t === 'add' ? 'del' : op.t === 'del' ? 'add' : 'set';
    if (t === 'add') this.#insert(op.k, structuredClone(op.v));
    else if (t === 'del') this.#delete(op.k, op.id);
    else this.#assign(op.k, op.id, inverse ? op.before : op.after);
  }

  #clearRaw() {
    this.nodes.clear();
    this.edges.clear();
    this.index.clear();
    this.#children.clear();
    this.#adjacency.clear();
    this.#order = null;
    this.#z = 0;
  }
}
