import { dependencies, pathsBetween } from '../engine/analysis.js';

/**
 * Dependency focus (D): while on, the selection decides what stays lit. One node: what it
 * depends on and what depends on it. Two: the paths between them. Toggling emits
 * `dependencies` on the editor. DOM-free.
 */
export class DependencyFocus {
  on = false;
  #cache = { key: null, value: null };

  constructor(ed) {
    this.ed = ed;
  }

  toggle(on = !this.on) {
    this.on = on;
    this.ed.emit('dependencies', on);
    this.ed.invalidate();
  }

  /**
   * What stays lit, or null when off or there is nothing to focus on. Lit nodes include
   * their containers, so the context stays readable. Returns { nodes, edges, up?, down?,
   * found? }; cached per document version and selection.
   */
  sets() {
    if (!this.on) return null;
    const doc = this.ed.doc, ids = this.ed.selectedNodeIds();
    const key = doc.version + '|' + ids.join(',');
    if (this.#cache.key === key) return this.#cache.value;
    let value = null;
    if (ids.length === 1) value = dependencies(doc, ids[0]);
    else if (ids.length === 2) value = pathsBetween(doc, ids[0], ids[1]);
    if (value) {
      const nodes = new Set(value.nodes);
      for (const id of value.nodes) for (const a of doc.ancestors(id)) nodes.add(a);
      value = { ...value, nodes };
    }
    this.#cache = { key, value };
    return value;
  }
}
