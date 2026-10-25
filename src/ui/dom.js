/** Tiny DOM helpers shared by the UI modules. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'html') k === 'html' ? (el.innerHTML = v) : (el[k] = v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function svg(d, { size = 18, stroke = 2, cls = 'ico' } = {}) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  return t.content.firstChild;
}

export const ui = {
  cursor: 'M4 4l7 17 2.5-7.5L21 11z',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5 M14 10V4a2 2 0 0 0-4 0v6 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15',
  undo: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  layout: 'M3 3h6v6H3z M15 3h6v6h-6z M9 15h6v6H9z M6 9v3h12V9 M12 12v3',
  dirLR: 'M4 12h16 M14 6l6 6-6 6',
  dirTB: 'M12 4v16 M6 14l6 6 6-6',
  grid: 'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18 M15 3v18',
  guides: 'M4 12h16 M12 4v16 M8 8h8v8H8z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-4.3-4.3',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3 M12 17h.01',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  fit: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z M9 4v14 M15 6v14',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6 M10 11v6 M14 11v6',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  group: 'M3 7V3h4 M17 3h4v4 M21 17v4h-4 M7 21H3v-4 M8 8h8v8H8z',
  ungroup: 'M4 4h8v8H4z M12 12h8v8h-8z',
  alignLeft: 'M4 3v18 M8 6h12v4H8z M8 14h7v4H8z',
  alignHC: 'M12 3v18 M6 6h12v4H6z M8.5 14h7v4h-7z',
  alignRight: 'M20 3v18 M4 6h12v4H4z M9 14h7v4H9z',
  alignTop: 'M3 4h18 M6 8h4v12H6z M14 8h4v7h-4z',
  alignVC: 'M3 12h18 M6 6h4v12H6z M14 8.5h4v7h-4z',
  alignBottom: 'M3 20h18 M6 4h4v12H6z M14 9h4v7h-4z',
  distH: 'M4 3v18 M20 3v18 M10 7h4v10h-4z',
  distV: 'M3 4h18 M3 20h18 M7 10h10v4H7z',
  swap: 'M7 7h13l-4-4 M17 17H4l4 4',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
  upload: 'M12 21V9 M7 14l5-5 5 5 M5 3h14',
  image: 'M3 3h18v18H3z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21',
  file: 'M14 3H6v18h12V7z M14 3v4h4',
  sparkles: 'M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  panel: 'M3 3h18v18H3z M15 3v18',
  x: 'M18 6 6 18 M6 6l12 12',
  routeOrth: 'M4 20v-8h16V4',
  routeCurved: 'M4 20C4 10 20 14 20 4',
  routeStraight: 'M4 20 20 4',
  front: 'M8 8h12v12H8z M4 16V4h12',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  boundary: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M11 4h2 M11 20h2 M4 11v2 M20 11v2',
  fitContent: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M9 9h6v6H9z',
  collapse: 'M4 14h6v6 M20 10h-6V4 M14 10l7-7 M3 21l7-7',
  expand: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7',
  keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
  check: 'M20 6 9 17l-5-5',
  template: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M17.5 14v7 M14 17.5h7',
  warning: 'M12 3 2 20h20z M12 10v4 M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 3.6-7 8-7s8 3 8 7',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  brush: 'M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z M9.2 12c-2.4 0-4.2 1.8-4.2 4.2 0 1.6-1 2.6-2 2.8 1 1.2 2.6 2 4.6 2 3 0 5.4-2.3 5.4-5.4',
  deps: 'M7 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M21 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M21 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M7 11l10-5 M7 13l10 5',
};

export const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

const KEY_NAMES = {
  mod: isMac ? '⌘' : 'Ctrl', shift: isMac ? '⇧' : 'Shift', alt: isMac ? '⌥' : 'Alt',
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', escape: 'Esc', enter: '↵',
  backspace: '⌫', delete: 'Del', tab: 'Tab', space: 'Space', '=': '+',
};

/** Plain-text key combo for tooltips. */
export function keyText(combo) {
  if (!combo) return '';
  return combo.split('+').map((p) => KEY_NAMES[p] ?? p.toUpperCase()).join(isMac ? '' : '+');
}

/** Render a key combo ("mod+shift+z") as keycap elements. */
export function kbd(combo) {
  if (!combo) return null;
  return h('span', { class: 'kbd' }, combo.split('+').map((p) => h('kbd', {}, KEY_NAMES[p] ?? p.toUpperCase())));
}

export function isEditable(el) {
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/** Close a popover when clicking outside of it (and of `ignore`, e.g. its toggle button) or pressing Escape. */
export function dismissable(el, close, ignore = []) {
  const onDown = (e) => { if (![el, ...ignore].some((x) => x.contains(e.target))) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
}
