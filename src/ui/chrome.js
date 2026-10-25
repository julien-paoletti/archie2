import { resolveType } from '../engine/schema.js';
import { dismissable, h, kbd, keyText, svg, ui } from './dom.js';
import { inflate, union } from '../engine/geometry.js';
import { ConnectGesture, DragGesture } from '../editor/gestures.js';

const tip = (label, cmd, editor) => {
  const keys = cmd && editor.commands.get(cmd)?.keys?.[0];
  return keys ? `${label}  ·  ${keyText(keys)}` : label;
};

function iconButton(icon, label, onclick, extra = {}) {
  return h('button', { class: 'btn', type: 'button', 'aria-label': label, 'data-tip': label, onclick, ...extra }, svg(ui[icon]));
}

/** Top bar: document identity + file menu, main tools, view toggles (`extras` go before them). */
export function createTopBar(editor, app, root, { extras = [] } = {}) {
  const title = h('input', {
    class: 'doc-title', value: app.title, spellcheck: 'false', 'aria-label': 'Diagram title',
    oninput: (e) => app.setTitle(e.target.value),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
  });
  app.on('title', (t) => { if (document.activeElement !== title) title.value = t; });

  const menuBtn = iconButton('menu', 'Menu', () => openMenu(menuBtn));
  // Unsaved-changes dot for the file the diagram is bound to (click to save).
  const fileState = h('button', { class: 'file-state', type: 'button', 'aria-label': 'Save', onclick: () => app.save() });
  const syncFile = () => {
    fileState.classList.toggle('bound', !!app.fileName);
    fileState.classList.toggle('dirty', !!app.fileDirty);
    fileState.dataset.tip = app.fileName
      ? (app.fileDirty ? `Unsaved changes in ${app.fileName}  ·  ${keyText('mod+s')}` : `Saved to ${app.fileName}`)
      : '';
  };
  app.on('file', syncFile);
  syncFile();
  const brand = h('div', { class: 'panel brand' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, svg('M12 3 3 8l9 5 9-5z M3 16l9 5 9-5 M3 12l9 5 9-5', { size: 16, stroke: 2.2 })),
    title,
    fileState,
    menuBtn,
  );

  const openMenu = (anchor) => {
    const items = [
      ['file', 'New diagram', () => app.newDiagram()],
      ['template', 'New from template…', () => app.openTemplates()],
      ['upload', 'Open…', () => app.openFile(), 'mod+o'],
      ['download', app.fileName ? `Save to ${app.fileName}` : 'Save', () => app.save(), 'mod+s'],
      ['download', 'Save as…', () => app.saveAs(), 'mod+shift+s'],
      ['image', 'Export PNG', () => app.exportPNG(), 'mod+shift+e'],
      ['image', 'Export SVG', () => app.exportSVG()],
      null,
      ['sparkles', 'Load sample architecture', () => app.loadSample()],
      ['zap', 'Stress test (2,000 nodes)', () => app.stressTest()],
    ];
    popover(anchor, items, 'below');
  };

  const undo = iconButton('undo', tip('Undo', 'edit.undo', editor), () => editor.undo());
  const redo = iconButton('redo', tip('Redo', 'edit.redo', editor), () => editor.redo());
  const select = iconButton('cursor', tip('Select', 'tool.select', editor), () => editor.setTool('select'));
  const hand = iconButton('hand', tip('Pan  ·  or hold Space', 'tool.hand', editor), () => editor.setTool('hand'));
  const layout = h('button', { class: 'btn btn-label', type: 'button', 'data-tip': tip('Auto layout', 'arrange.layout', editor), onclick: () => editor.autoLayout() },
    svg(ui.layout), h('span', {}, 'Auto layout'));
  const dir = iconButton('dirLR', 'Layout direction', () => {
    editor.settings.layoutDirection = editor.settings.layoutDirection === 'LR' ? 'TB' : 'LR';
    editor.emit('settings');
    editor.autoLayout();
  });
  const snapGrid = iconButton('grid', tip('Snap to grid', 'settings.snapGrid', editor), () => editor.toggleSetting('snapToGrid'));
  const guides = iconButton('guides', tip('Smart guides', 'settings.snapObjects', editor), () => editor.toggleSetting('snapToObjects'));
  const deps = iconButton('deps', tip('Show dependencies', 'view.dependencies', editor), () => editor.toggleDependencies());

  const tools = h('div', { class: 'panel toolbar' },
    select, hand, h('i', { class: 'sep' }), undo, redo, h('i', { class: 'sep' }), layout, dir, h('i', { class: 'sep' }), snapGrid, guides,
    h('i', { class: 'sep' }), deps);

  const search = h('button', { class: 'btn btn-search', type: 'button', 'data-tip': 'Commands & search', onclick: () => app.openPalette() },
    svg(ui.search, { size: 16 }), h('span', {}, 'Search'), kbd('mod+k'));
  const theme = iconButton('moon', 'Toggle theme', () => app.toggleTheme());
  const inspector = iconButton('panel', 'Inspector  ·  I', () => app.toggleInspector());
  const help = iconButton('help', 'Shortcuts  ·  ?', () => app.openHelp());
  const right = h('div', { class: 'panel toolbar' }, search, h('i', { class: 'sep' }), ...extras, theme, inspector, help);

  root.append(h('div', { class: 'topbar' }, brand, tools, right));

  const sync = () => {
    undo.disabled = !editor.history.canUndo;
    redo.disabled = !editor.history.canRedo;
    select.classList.toggle('on', editor.tool === 'select');
    hand.classList.toggle('on', editor.tool === 'hand');
    snapGrid.classList.toggle('on', editor.settings.snapToGrid);
    guides.classList.toggle('on', editor.settings.snapToObjects);
    deps.classList.toggle('on', editor.focusDeps);
    const lr = editor.settings.layoutDirection === 'LR';
    dir.replaceChildren(svg(lr ? ui.dirLR : ui.dirTB));
    dir.dataset.tip = tip(lr ? 'Direction: left → right' : 'Direction: top → bottom', 'arrange.layoutFlip', editor);
    theme.replaceChildren(svg(app.theme === 'dark' ? ui.sun : ui.moon));
    inspector.classList.toggle('on', app.inspectorOpen);
  };
  for (const ev of ['history', 'tool', 'settings', 'focus']) editor.on(ev, sync);
  app.on('change', sync);
  sync();
}

/** Floating menu anchored to an element or a point. items: [icon, label, run, keys?] | null */
export function popover(anchor, items, placement = 'below') {
  const menu = h('div', { class: 'panel menu', role: 'menu' });
  let close;
  const clean = items.filter((it, i, a) => (it && it !== '-') || (i > 0 && i < a.length - 1 && a[i - 1] && a[i - 1] !== '-'));
  for (const item of clean) {
    if (!item || item === '-') {
      menu.append(h('i', { class: 'menu-sep' }));
      continue;
    }
    const [icon, label, run, keys, opts = {}] = item;
    menu.append(h('button', {
      class: 'menu-item' + (opts.danger ? ' danger' : ''), type: 'button', role: 'menuitem', disabled: opts.disabled,
      onclick: () => { close(); run(); },
    }, icon ? svg(ui[icon] ?? icon, { size: 16 }) : h('span', { class: 'ico-space' }), h('span', { class: 'menu-label' }, label), kbd(keys)));
  }
  document.body.append(menu);
  const mr = menu.getBoundingClientRect();
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = placement === 'right' ? r.right + 8 : r.left;
    y = placement === 'right' ? r.top : placement === 'above' ? r.top - mr.height - 8 : r.bottom + 8;
  } else {
    ({ x, y } = anchor);
  }
  x = Math.min(Math.max(8, x), innerWidth - mr.width - 8);
  y = Math.min(Math.max(8, y), innerHeight - mr.height - 8);
  Object.assign(menu.style, { left: x + 'px', top: y + 'px' });
  requestAnimationFrame(() => menu.classList.add('open'));
  const undismiss = dismissable(menu, () => close());
  close = () => {
    undismiss();
    menu.classList.remove('open');
    setTimeout(() => menu.remove(), 150);
  };
  menu.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  return close;
}

/** Left dock: node types, in sections (`dock` in the schema). Click to add, or drag onto the canvas. */
export function createDock(editor, app, root, icons) {
  const dock = h('div', { class: 'panel dock', role: 'toolbar', 'aria-label': 'Shapes' });
  let section;
  for (const [type, t] of Object.entries(editor.schema.nodeTypes)) {
    if (section !== undefined && t.dock !== section) dock.append(h('i', { class: 'sep h' }));
    section = t.dock;
    const item = h('button', {
      class: 'dock-item', type: 'button', draggable: 'true', style: { '--c': t.color },
      'data-tip': `${t.label}${t.shortcut ? '  ·  ' + t.shortcut : ''}${t.host ? '\nDrop things onto it to host them' : ''}`,
      'data-tip-pos': 'right', 'aria-label': t.label,
      onclick: () => app.addNode(type),
    }, svg(icons[t.icon], { size: 20, stroke: 1.8 }));
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-archie-type', type);
      e.dataTransfer.effectAllowed = 'copy';
      const ghost = h('div', { class: 'drag-ghost', style: { '--c': t.color } }, svg(icons[t.icon], { size: 16 }), t.label);
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 24, 20);
      setTimeout(() => ghost.remove());
    });
    dock.append(item);
  }
  root.append(dock);
  // Centre the dock vertically while keeping it clear of the top bar.
  const measure = () => dock.style.setProperty('--dock-h', dock.offsetHeight + 'px');
  new ResizeObserver(measure).observe(dock);
  measure();
}

/** Bottom-right: minimap + zoom controls. */
export function createViewControls(editor, app, root) {
  const pct = h('button', { class: 'btn zoom-pct', type: 'button', 'data-tip': tip('Reset zoom', 'view.actual', editor), onclick: () => editor.zoomTo(1) }, '100%');
  const mapBtn = iconButton('map', 'Minimap  ·  M', () => app.toggleMinimap());
  const bar = h('div', { class: 'panel toolbar zoombar' },
    iconButton('minus', tip('Zoom out', 'view.zoomOut', editor), () => editor.zoomBy(0.8)),
    pct,
    iconButton('plus', tip('Zoom in', 'view.zoomIn', editor), () => editor.zoomBy(1.25)),
    h('i', { class: 'sep' }),
    iconButton('fit', tip('Zoom to fit', 'view.fit', editor), () => editor.fitView()),
    mapBtn);
  const mapWrap = h('div', { class: 'panel minimap' });
  root.append(h('div', { class: 'viewctl' }, mapWrap, bar));
  editor.on('camera', () => (pct.textContent = Math.round(editor.camera.zoom * 100) + '%'));
  const sync = () => {
    mapWrap.classList.toggle('hidden', !app.minimapOpen);
    mapBtn.classList.toggle('on', app.minimapOpen);
  };
  app.on('change', sync);
  sync();
  return mapWrap;
}

/** Overview map: whole diagram + viewport; click or drag to navigate. */
export function createMinimap(editor, wrap, app) {
  const W = 220, H = 140;
  const canvas = h('canvas', { width: W * devicePixelRatio, height: H * devicePixelRatio, style: { width: W + 'px', height: H + 'px' } });
  wrap.append(canvas);
  const ctx = canvas.getContext('2d');
  let map = null;
  let raf = 0;

  const draw = () => {
    raf = 0;
    if (!app.minimapOpen) return;
    const doc = editor.doc;
    const view = editor.camera.viewRect();
    const content = doc.bounds();
    const world = inflate(content ? union(content, view) : view, 80);
    const s = Math.min(W / world.w, H / world.h);
    const ox = (W - world.w * s) / 2 - world.x * s, oy = (H - world.h * s) / 2 - world.y * s;
    map = { s, ox, oy };
    const dpr = devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const th = app.colors;
    const hidden = doc.hidden();
    for (const id of doc.order()) {
      if (hidden.has(id)) continue;
      const n = doc.nodes.get(id);
      const t = resolveType(editor.schema, n);
      const color = n.style?.color ?? t.color ?? th.accent;
      const x = n.x * s + ox, y = n.y * s + oy, w = Math.max(n.w * s, 1.5), hh = Math.max(n.h * s, 1.5);
      if (t.container && !n.collapsed) {
        ctx.fillStyle = color + '1c';
        ctx.strokeStyle = color + '66';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, w, hh, 3);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = editor.selection.has(id) ? th.accent : color + 'b0';
        ctx.fillRect(x, y, w, hh);
      }
    }
    ctx.fillStyle = th.accent + '14';
    ctx.strokeStyle = th.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(view.x * s + ox, view.y * s + oy, view.w * s, view.h * s, 3);
    ctx.fill();
    ctx.stroke();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  for (const ev of ['camera', 'docchange', 'selectionchange']) editor.on(ev, schedule);
  app.on('change', schedule);

  const go = (e, animate) => {
    if (!map) return;
    const r = canvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - map.ox) / map.s, wy = (e.clientY - r.top - map.oy) / map.s;
    const z = editor.camera.zoom, { w, h: hh } = editor.camera.size;
    editor.camera.set({ x: wx - w / 2 / z, y: wy - hh / 2 / z }, { animate, duration: 260 });
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    go(e, true);
  });
  canvas.addEventListener('pointermove', (e) => { if (e.buttons) go(e, false); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    editor.zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });
  schedule();
}

/** Bottom-left contextual hints: the next useful thing to do, with its shortcut. */
export function createHints(editor, root) {
  const el = h('div', { class: 'hints' });
  root.append(el);
  const k = (combo) => kbd(combo);
  const t = (s) => h('span', {}, s);
  const dot = () => h('span', { class: 'hint-dot' });
  let last = '';
  const update = () => {
    const nodes = editor.selectedNodeIds();
    const edges = editor.selectedEdgeIds();
    let key, parts;
    if (editor.gesture instanceof DragGesture) {
      key = 'drag';
      parts = [k('mod'), t('duplicate'), dot(), k('shift'), t('lock axis'), dot(), k('alt'), t('no snapping'), dot(), t('drop onto a module or host to nest')];
    } else if (editor.gesture instanceof ConnectGesture) {
      key = 'connect';
      parts = [t('Release on a node to link'), dot(), t('on empty space to create one')];
    } else if (editor.focusDeps) {
      const f = editor.dependencyFocus();
      const exit = [dot(), k('d'), t('or'), k('escape'), t('exit')];
      if (!f) {
        key = 'deps';
        parts = [t('Select an element to see what it depends on and what depends on it'), dot(), t('two to see the paths between them'), ...exit];
      } else if (f.up) {
        key = `deps:${f.down.size}:${f.up.size}`;
        parts = [t(`Depends on ${f.down.size}`), dot(), t(`${f.up.size} depend on it`), ...exit];
      } else {
        key = `deps:path:${f.found}`;
        parts = [t(f.found ? 'Paths between the two highlighted' : 'No path between these two'), ...exit];
      }
    } else if (!editor.doc.nodes.size) {
      key = 'empty';
      parts = [t('Double-click to add a component'), dot(), t('drag shapes from the left'), dot(), t('or start from a template (menu)'), dot(), k('?'), t('shortcuts')];
    } else if (nodes.length === 1 && !edges.length && editor.isText(nodes[0])) {
      key = 'text';
      parts = [k('enter'), t('edit text'), dot(), k('shift+enter'), t('new line (while editing)'), dot(), t('drag a side handle to set the width')];
    } else if (nodes.length === 1 && !edges.length) {
      key = 'one';
      parts = [k('enter'), t('rename'), dot(), k('tab'), t('add next'), dot(), t('drag a port to connect'), dot(), k('mod'), t('+ drag to duplicate')];
    } else if (nodes.length > 1) {
      key = 'many';
      parts = [k('mod+g'), t('group'), dot(), k('alt+a'), t('align'), dot(), k('l'), t('layout'), dot(), k('delete'), t('remove')];
    } else if (edges.length) {
      key = 'edge';
      parts = [k('enter'), t('label'), dot(), t('drag the line to reshape'), dot(), t('drag the label to slide it'), dot(), k('r'), t('reset route')];
    } else {
      key = 'idle';
      parts = [t('Double-click to add'), dot(), t('hover a node, drag its ports to connect'), dot(), k('space'), t('+ drag to pan'), dot(), k('mod+k'), t('commands')];
    }
    if (key === last) return;
    last = key;
    el.classList.remove('in');
    void el.offsetWidth;
    el.replaceChildren(...parts);
    el.classList.add('in');
  };
  for (const ev of ['selectionchange', 'gesture', 'docchange', 'focus']) editor.on(ev, update);
  update();
}

/** Toast notifications with an optional action (e.g. Undo). */
export function createToaster(root) {
  const host = h('div', { class: 'toasts', 'aria-live': 'polite' });
  root.append(host);
  return (message, { action, timeout = 3200, icon = 'sparkles' } = {}) => {
    const el = h('div', { class: 'panel toast' }, svg(ui[icon] ?? icon, { size: 16 }), h('span', {}, message));
    if (action) el.append(h('button', { class: 'toast-action', type: 'button', onclick: () => { action.run(); dismiss(); } }, action.label));
    host.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    const dismiss = () => {
      el.classList.remove('in');
      setTimeout(() => el.remove(), 220);
    };
    setTimeout(dismiss, timeout);
    return dismiss;
  };
}

