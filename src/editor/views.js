import { showsAsCard } from '../engine/schema.js';

/**
 * Module views: open a module on its own (its contents, plus what they link to outside, as
 * context), go up a level, or back to everything. A view is the document's scope: a way of
 * looking, not an edit. Every change emits `view` on the editor. DOM-free.
 */
export class Views {
  constructor(ed) {
    this.ed = ed;
  }

  /** The module whose view is open (null: the whole diagram). */
  get root() {
    return this.ed.doc.scope;
  }

  /** Can this node be opened as a view (a box holding things)? */
  canOpen(id) {
    return this.canShow(id) && this.ed.doc.hasChildren(id) && id !== this.root;
  }

  /** Can an open view stay on this node (it may have been emptied meanwhile)? */
  canShow(id) {
    const doc = this.ed.doc, n = doc.nodes.get(id);
    return !!n && doc.isContainer(n) && !showsAsCard(doc, n);
  }

  /** Open a module as its own view (null: everything). Same model: editing here edits the diagram. */
  open(id, { animate = true } = {}) {
    const ed = this.ed;
    if (id != null && !this.canOpen(id)) return;
    if (id != null && ed.doc.nodes.get(id).collapsed) ed.toggleCollapse([id], false);
    ed.cancelGesture();
    ed.endEdit();
    ed.doc.setScope(id);
    ed.setSelection([]);
    ed.emit('view', this.root);
    ed.fitView({ animate });
    ed.invalidate();
  }

  /** Up one level: the view of the module around this one, or the whole diagram; the module you left stays selected. */
  up() {
    const root = this.root;
    if (root == null) return;
    this.open(this.ed.doc.ancestors(root).find((a) => this.canOpen(a)) ?? null);
    this.ed.setSelection([root]);
  }

  /** The chain of modules from the top down to the open view (for a breadcrumb). */
  path() {
    const doc = this.ed.doc, root = this.root;
    return root == null ? [] : [...doc.ancestors(root).reverse(), root].filter((id) => doc.isContainer(id));
  }

  /** Shown as context in the open view (outside it, linked to it). */
  isContext(id) {
    return this.root != null && this.ed.doc.context().has(id);
  }

  /** After a document change: the view's module may have gone (deleted, ungrouped, undone). */
  sync() {
    if (this.root != null && !this.canShow(this.root)) {
      this.ed.doc.setScope(null);
      this.ed.emit('view', null);
    }
  }
}
