import { Emitter } from './emitter.js';
import { compressOps } from './document.js';

/**
 * Patch-based undo/redo. Each committed transaction becomes one entry; consecutive
 * transactions sharing a `merge` key (a drag, a typing burst, arrow nudges) collapse
 * into a single entry. An optional `capture()` snapshots view state (e.g. selection)
 * before and after each entry so undo can restore it.
 */
export class History extends Emitter {
  undoStack = [];
  redoStack = [];
  #pendingBefore = null;
  #capture;

  constructor(doc, { limit = 500, capture = null } = {}) {
    super();
    this.doc = doc;
    this.limit = limit;
    this.#capture = capture;
    doc.on('txstart', ({ opts }) => {
      if (opts.history !== false) this.#pendingBefore = this.#capture?.() ?? null;
    });
    doc.on('commit', (patch) => this.#record(patch));
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  #record(patch) {
    const after = this.#capture?.() ?? null;
    const top = this.undoStack.at(-1);
    if (patch.merge != null && top && top.merge === patch.merge) {
      top.ops = compressOps([...top.ops, ...patch.ops]);
      top.after = after;
    } else {
      this.undoStack.push({ label: patch.label, ops: patch.ops, merge: patch.merge, before: this.#pendingBefore, after });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.emit('change');
  }

  /** Stop the top entry from absorbing further transactions with the same merge key. */
  seal() {
    const top = this.undoStack.at(-1);
    if (top) top.merge = null;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.doc.applyPatch(entry.ops, { inverse: true, source: 'undo', animate: true });
    this.redoStack.push(entry);
    this.emit('change');
    this.emit('restore', { state: entry.before, entry });
    return entry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.doc.applyPatch(entry.ops, { source: 'redo', animate: true });
    this.undoStack.push(entry);
    this.emit('change');
    this.emit('restore', { state: entry.after, entry });
    return entry;
  }

  /** Drop the top entry without applying it (after it was reverted by other means). */
  discardTop() {
    this.undoStack.pop();
    this.emit('change');
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit('change');
  }
}
