import { boundsOf } from '../engine/geometry.js';

/**
 * Request flows on the editor: which flow is on show, whether it is playing (and which
 * step) or recording (link clicks add steps), and the edits on flows, one undo step each.
 * Every change of state emits `flow` on the editor. DOM-free.
 */
export class Flows {
  /** `step` ≥ 0 while playing; `recording`: clicking links adds steps. */
  state = { id: null, step: -1, recording: false };
  #focus = { key: null, value: null };

  constructor(ed) {
    this.ed = ed;
  }

  get #doc() {
    return this.ed.doc;
  }

  /** Show a flow (null: none). `step` ≥ 0 plays it from that step; `record` adds clicked links. */
  show(id, { step = -1, record = false } = {}) {
    const f = id && this.#doc.flows.get(id);
    this.state = f
      ? { id, step: f.steps.length ? Math.min(step, f.steps.length - 1) : -1, recording: record && !this.ed.readOnly }
      : { id: null, step: -1, recording: false };
    this.#changed();
  }

  play(id = this.state.id, from = 0) {
    this.show(id, { step: from });
    if (this.#doc.flows.get(id)?.steps.length) this.#frame();
  }

  /** Move through the flow being played; the view follows the step. */
  step(delta) {
    const f = this.#doc.flows.get(this.state.id);
    if (!f || this.state.step < 0) return;
    const step = Math.max(0, Math.min(f.steps.length - 1, this.state.step + delta));
    if (step === this.state.step) return;
    this.state = { ...this.state, step };
    this.#changed();
    this.#frame();
  }

  /** The step being played: { edge, label, reverse, index }, or null. */
  current() {
    const s = this.#doc.flows.get(this.state.id)?.steps[this.state.step];
    return s ? { ...s, index: this.state.step } : null;
  }

  /** After a document change: the flow on show may have gone (undo) or lost steps. */
  sync() {
    if (!this.state.id) return;
    const f = this.#doc.flows.get(this.state.id);
    if (!f) this.show(null);
    else if (this.state.step >= f.steps.length) this.show(f.id, { step: f.steps.length - 1, record: this.state.recording });
  }

  create(name) {
    if (this.ed.readOnly) return null;
    let flow;
    this.#doc.transact('New flow', () => (flow = this.#doc.addFlow({ name: name ?? `Flow ${this.#doc.flows.size + 1}` })));
    this.show(flow.id, { record: true });
    return flow;
  }

  addStep(edgeId, flowId = this.state.id) {
    const f = this.#doc.flows.get(flowId);
    if (!f || !this.#doc.edges.has(edgeId)) return;
    this.#doc.transact('Add step', () => this.#doc.update(flowId, { steps: [...f.steps, { edge: edgeId, label: '' }] }));
  }

  /** Change a step: { label?, reverse? }; `merge` coalesces a typing session. */
  updateStep(flowId, index, patch, merge) {
    const f = this.#doc.flows.get(flowId);
    if (!f?.steps[index]) return;
    const steps = f.steps.map((s, i) => {
      if (i !== index) return s;
      const next = { ...s, ...patch };
      if (!next.reverse) delete next.reverse;
      return next;
    });
    this.#doc.transact('Edit step', () => this.#doc.update(flowId, { steps }), { merge });
  }

  removeStep(flowId, index) {
    const f = this.#doc.flows.get(flowId);
    if (!f?.steps[index]) return;
    this.#doc.transact('Remove step', () => this.#doc.update(flowId, { steps: f.steps.filter((_, i) => i !== index) }));
  }

  moveStep(flowId, index, delta) {
    const f = this.#doc.flows.get(flowId);
    const to = index + delta;
    if (!f?.steps[index] || to < 0 || to >= f.steps.length) return;
    const steps = [...f.steps];
    [steps[index], steps[to]] = [steps[to], steps[index]];
    this.#doc.transact('Reorder steps', () => this.#doc.update(flowId, { steps }));
  }

  rename(flowId, name, merge) {
    if (this.#doc.flows.has(flowId)) this.#doc.transact('Rename flow', () => this.#doc.update(flowId, { name }), { merge });
  }

  remove(flowId) {
    if (this.state.id === flowId) this.show(null);
    this.#doc.transact('Delete flow', () => this.#doc.remove([flowId]));
  }

  /**
   * While a flow plays: its links and their ends stay lit (the rest dims), like the
   * dependency focus. Returns { nodes, edges } or null; cached per document version.
   */
  focus() {
    const f = this.state.step >= 0 && this.#doc.flows.get(this.state.id);
    if (!f) return null;
    const key = this.#doc.version + '|' + f.id;
    if (this.#focus.key !== key) {
      const nodes = new Set(), edges = new Set();
      for (const s of f.steps) {
        const e = this.#doc.edges.get(s.edge);
        if (!e) continue;
        edges.add(e.id);
        for (const id of [e.source, e.target]) for (const n of [id, ...this.#doc.ancestors(id)]) nodes.add(n);
      }
      this.#focus = { key, value: { nodes, edges } };
    }
    return this.#focus.value;
  }

  #changed() {
    this.ed.emit('flow', this.state);
    this.ed.invalidate();
  }

  /** Keep the current step's two ends in view. */
  #frame() {
    const s = this.current();
    if (!s) return;
    const e = this.#doc.edges.get(s.edge);
    this.ed.ensureVisible(boundsOf([e.source, e.target].map((id) => this.#doc.nodes.get(this.#doc.visibleAncestor(id)))));
  }
}
