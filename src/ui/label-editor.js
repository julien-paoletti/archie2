import { resolveType, showsAsCard } from '../engine/schema.js';
import { labelPoint } from '../engine/routing.js';
import { h } from './dom.js';
import { TEXT_PAD, TEXT_SIZES } from '../render/canvas-renderer.js';

/**
 * In-place label editing: a transparent textarea laid exactly over the label area,
 * scaled with the zoom. Enter commits, Shift+Enter adds a line, Esc cancels,
 * Tab commits and spawns the next connected node (fast outlining).
 * The same editor handles a node's type label (the caption under its name).
 */
export function createLabelEditor(editor, stage) {
  const ta = h('textarea', { class: 'label-editor', spellcheck: 'false', rows: '1', 'aria-label': 'Label' });
  stage.append(ta);
  let id = null;
  let field = 'label';
  let mode = null;

  const layout = (o) => {
    const doc = editor.doc;
    if (doc.edges.has(o.id)) {
      const drawn = field === 'tech' ? editor.layoutProbe?.captionRect(o.id) : editor.layoutProbe?.labelRect?.(o.id)?.line;
      if (drawn) return { rect: drawn, align: 'center', size: field === 'tech' ? 10 : 11.5, weight: 500, vcenter: true, mono: field === 'tech' };
      const r = editor.router.peek(o.id);
      const m = r ? labelPoint(r, o.style?.labelT) : { x: 0, y: 0 };
      return { rect: { x: m.x - 100, y: m.y - 12, w: 200, h: 24 }, align: 'center', size: 11.5, weight: 500, vcenter: true };
    }
    const type = resolveType(editor.schema, o);
    if (field === 'stereotype') {
      const r = editor.layoutProbe?.captionRect(o.id) ?? { x: o.x + 8, y: o.y + o.h - 22, w: o.w - 16, h: 16, size: 11, align: 'center' };
      return { rect: r, align: r.align, size: r.size, weight: 500, vcenter: true };
    }
    if (o.collapsed) return { rect: { x: o.x + 57, y: o.y + 18, w: o.w - 100, h: 22 }, align: 'left', size: 13.5, weight: 600, vcenter: true };
    if (type.shape === 'boundary') return { rect: { x: o.x + 49, y: o.y - 11, w: Math.max(120, o.w - 120), h: 22 }, align: 'left', size: 12.5, weight: 600, vcenter: true };
    if (type.container && !showsAsCard(editor.doc, o)) return { rect: { x: o.x + 40, y: o.y + 13, w: o.w - 56, h: 24 }, align: 'left', size: 13, weight: 600, vcenter: true };
    if (type.shape === 'bus' && o.w >= o.h) return { rect: { x: o.x + Math.max(10, o.h / 2 - 4) + 26, y: o.y + o.h / 2 - 11, w: o.w - 60, h: 22 }, align: 'left', size: 13, weight: 600, vcenter: true };
    if (type.shape === 'text') {
      const st = TEXT_SIZES[o.style?.textSize] ?? TEXT_SIZES.md;
      const w = o.style?.autoWidth === false ? o.w : Math.max(o.w, 360);
      const align = o.style?.align ?? 'left';
      const x = align === 'center' ? o.x + o.w / 2 - w / 2 : align === 'right' ? o.x + o.w - w : o.x;
      return { rect: { x: x + TEXT_PAD, y: o.y + TEXT_PAD, w: w - TEXT_PAD * 2, h: o.h - TEXT_PAD * 2 }, align, size: st.size, weight: st.weight, lineHeight: st.lh, grow: true };
    }
    if (type.shape === 'note') return { rect: { x: o.x + 13, y: o.y + 12, w: o.w - 26, h: o.h - 22 }, align: 'left', size: 13, weight: 500, vcenter: false };
    const chip = type.shape !== 'cylinder' && o.w >= 140 && o.h >= 44;
    return chip
      ? { rect: { x: o.x + 57, y: o.y + 6, w: o.w - 68, h: o.h - 12 }, align: 'left', size: 13.5, weight: 600, vcenter: true }
      : { rect: { x: o.x + 8, y: o.y + 6, w: o.w - 16, h: o.h - 12 }, align: 'center', size: 13.5, weight: 600, vcenter: true };
  };

  const place = () => {
    if (!id) return;
    const o = editor.doc.get(id);
    if (!o) return finish(false);
    mode = layout(o);
    const z = editor.camera.zoom;
    const s = editor.toScreen(mode.rect);
    ta.style.width = mode.rect.w * z + 'px';
    ta.style.fontSize = mode.size * z + 'px';
    ta.style.fontWeight = mode.weight;
    ta.style.lineHeight = mode.lineHeight ? mode.lineHeight * z + 'px' : '';
    ta.style.color = mode.grow ? editor.doc.get(id)?.style?.color ?? '' : '';
    ta.classList.toggle('mono', !!mode.mono);
    ta.style.textAlign = mode.align;
    ta.style.height = 'auto';
    const box = mode.rect.h * z;
    const hgt = mode.vcenter ? ta.scrollHeight : mode.grow ? Math.max(box, ta.scrollHeight) : box;
    ta.style.height = hgt + 'px';
    ta.style.left = s.x + 'px';
    ta.style.top = s.y + (mode.vcenter ? (box - hgt) / 2 : 0) + 'px';
  };

  /** Close the editor; `handoff` means another edit is starting, so keep the editor state. */
  const finish = (commit, handoff = false) => {
    if (!id) return;
    const cur = id;
    id = null;
    ta.classList.remove('open');
    if (commit && (field === 'stereotype' || field === 'tech')) {
      const v = ta.value.trim();
      if (v !== (editor.doc.get(cur)?.data?.[field] ?? '')) editor.commitLabel(cur, v, field);
    } else if (commit) {
      const o = editor.doc.get(cur);
      const v = ta.value.trim();
      if (o && editor.isText(cur)) {
        if (v !== o.label) editor.commitLabel(cur, v);
      } else if (o && v !== o.label) {
        const fallback = editor.doc.nodes.has(cur) ? editor.schema.nodeTypes[o.type]?.label ?? '' : '';
        editor.commitLabel(cur, v || fallback);
      }
    }
    if (document.activeElement === ta) ta.blur();
    if (!handoff && editor.editingId === cur) editor.endEdit();
    return cur;
  };

  editor.on('edit-label', ({ id: next, field: f = 'label' }) => {
    if (id) finish(true, true);
    id = next;
    field = f;
    const o = editor.doc.get(id);
    ta.value = (field === 'label' ? o?.label : o?.data?.[field]) ?? '';
    ta.placeholder = field === 'stereotype' ? resolveType(editor.schema, o).label ?? '' : field === 'tech' ? 'Protocol' : '';
    ta.setAttribute('aria-label', { stereotype: 'Type label', tech: 'Protocol' }[field] ?? 'Label');
    ta.classList.add('open');
    place();
    requestAnimationFrame(() => {
      ta.focus();
      ta.select();
    });
  });
  editor.on('edit-end', () => id && finish(false));
  editor.on('commit-edit', () => finish(true));
  editor.on('camera', place);

  ta.addEventListener('input', place);
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const wasLabel = field === 'label';
      const cur = finish(true);
      if (wasLabel && editor.doc.nodes.has(cur)) editor.quickAdd(cur);
    }
  });
}
