import { resolveType } from '../engine/schema.js';
import { h, svg, ui } from './dom.js';
import { linkName, safeUrl } from './links.js';

const DELAY = 550;

/** Does a node have details worth a card (beyond the name and caption already drawn)? */
const hasDetails = (n) => !!(n?.data?.description || n?.data?.owner || n?.data?.status || n?.data?.links?.length);

/**
 * After a short pause over an element, a card with its details: description, owner, status
 * and links. It never takes the pointer, and goes away as soon as anything else happens.
 */
export function createHoverCard(editor, root, { icons }) {
  const card = h('div', { class: 'panel hovercard', role: 'tooltip' });
  root.append(card);
  const doc = editor.doc;
  let timer = 0, shown = null;

  const hide = () => {
    clearTimeout(timer);
    timer = 0;
    shown = null;
    card.classList.remove('in');
  };

  const show = (id) => {
    const n = doc.nodes.get(id);
    if (!n || editor.gesture || editor.editingId) return;
    const t = resolveType(editor.schema, n);
    const d = n.data ?? {};
    const color = n.style?.color ?? t.color;
    const status = editor.schema.statuses?.[d.status];
    card.replaceChildren(
      h('div', { class: 'hc-head' },
        h('span', { class: 'chip sm', style: { '--c': color } }, svg(icons[t.icon], { size: 13 })),
        h('div', { class: 'hc-title' },
          h('strong', {}, n.label || t.label),
          h('span', {}, [d.stereotype || t.label, d.tech].filter(Boolean).join(' · '))),
        status ? h('span', { class: 'hc-status', style: { background: status.color } }, status.label) : null),
      d.description ? h('p', { class: 'hc-desc' }, d.description) : null,
      d.owner ? h('div', { class: 'hc-row' }, svg(ui.user, { size: 13 }), h('span', {}, d.owner)) : null,
      ...(d.links ?? []).map((raw) => {
        const url = safeUrl(raw);
        return h('div', { class: 'hc-row' }, svg(ui.link, { size: 13 }), h('span', {}, url ? linkName(url) : raw));
      }),
    );
    // Above the element if it fits, else below; kept on screen.
    const a = editor.toScreen(n), b = editor.toScreen({ x: n.x + n.w, y: n.y + n.h });
    const { w: vw, h: vh } = editor.camera.size;
    card.style.transform = 'translate(-9999px, 0)';
    card.classList.add('in');
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const x = Math.max(12, Math.min((a.x + b.x) / 2 - cw / 2, vw - cw - 12));
    const y = a.y - ch - 12 >= 64 ? a.y - ch - 12 : Math.min(b.y + 12, vh - ch - 12);
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    shown = id;
  };

  editor.on('hover', (hit) => {
    const id = hit?.kind === 'node' ? hit.id : null;
    if (id && id === shown) return;
    hide();
    if (id && !editor.gesture && hasDetails(doc.nodes.get(id))) timer = setTimeout(() => show(id), DELAY);
  });
  for (const ev of ['camera', 'gesture', 'edit-label', 'docchange', 'contextmenu', 'selectionchange']) editor.on(ev, hide);
}
