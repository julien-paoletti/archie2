import { resolveType } from '../engine/schema.js';
import { commandItem, h, kbd, linkKindIcon, modal, popover, svg, ui } from './dom.js';

/** Subsequence fuzzy match; returns a score (higher is better) or -1. */
function fuzzy(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase(), t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 ? 50 : 0);
  let score = 0, ti = 0, streak = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    streak = i === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - Math.min(i - ti, 5) * 0.2;
    ti = i + 1;
  }
  return score;
}

/** ⌘K: run any command, or jump to any node or link by name. */
export function createCommandPalette(editor, app, { icons }) {
  const input = h('input', { class: 'palette-input', placeholder: 'Type a command or search nodes…', spellcheck: 'false', 'aria-label': 'Command' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const box = h('div', { class: 'panel palette', role: 'dialog', 'aria-label': 'Command palette' },
    h('div', { class: 'palette-head' }, svg(ui.search, { size: 18 }), input, kbd('escape')), list);
  const backdrop = h('div', { class: 'backdrop' }, box);
  document.body.append(backdrop);
  let items = [], shown = [], active = 0;

  const collect = () => {
    const out = [];
    for (const c of editor.commands.values()) {
      if (c.hidden || !editor.allowed(c)) continue;
      out.push({ kind: 'cmd', title: c.title, group: c.group ?? 'General', keys: c.keys?.[0], run: () => editor.run(c.id), enabled: !c.enabled || c.enabled() });
    }
    for (const f of editor.doc.flows.values()) {
      out.push({ kind: 'cmd', title: `Play flow: ${f.name || 'Untitled flow'}`, group: 'Flows', run: () => editor.playFlow(f.id), enabled: f.steps.length > 0 });
    }
    if (!editor.readOnly) out.push({ kind: 'cmd', title: 'New flow', group: 'Flows', run: () => editor.createFlow(), enabled: true });
    for (const n of editor.doc.nodes.values()) {
      const t = resolveType(editor.schema, n);
      out.push({ kind: 'node', title: n.label || t.label, group: n.data?.stereotype || t.label, icon: icons[t.icon], color: n.style?.color ?? t.color, run: () => editor.reveal(n.id), enabled: true });
    }
    for (const e of editor.doc.edges.values()) {
      if (!e.label) continue;
      const s = editor.doc.nodes.get(e.source)?.label, t = editor.doc.nodes.get(e.target)?.label;
      out.push({ kind: 'edge', title: e.label, group: `${s} → ${t}`, icon: ui.link, run: () => editor.reveal(e.id), enabled: true });
    }
    return out;
  };

  const render = () => {
    const q = input.value.trim();
    shown = items
      .map((it) => ({ it, s: Math.max(fuzzy(q, it.title), fuzzy(q, it.group) - 20) }))
      .filter((x) => x.s >= 0 && (q || x.it.kind === 'cmd'))
      .sort((a, b) => b.s - a.s || (a.it.kind === 'cmd' ? -1 : 1))
      .slice(0, 60)
      .map((x) => x.it);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((it, i) => h('button', {
      type: 'button', class: 'palette-item' + (i === active ? ' active' : '') + (it.enabled ? '' : ' disabled'), role: 'option',
      onpointermove: () => { if (active !== i) { active = i; highlight(); } },
      onclick: () => choose(i),
    },
    it.kind === 'cmd' ? svg(ui.sparkles, { size: 15 }) : h('span', { class: 'chip sm', style: { '--c': it.color ?? 'var(--accent)' } }, svg(it.icon, { size: 13 })),
    h('span', { class: 'pi-title' }, it.title),
    h('span', { class: 'pi-group' }, it.kind === 'cmd' ? it.group : it.kind === 'edge' ? it.group : 'Go to ' + it.group.toLowerCase()),
    kbd(it.keys))));
    if (!shown.length) list.append(h('div', { class: 'palette-empty' }, 'No matches'));
  };
  const highlight = () => {
    [...list.children].forEach((el, i) => el.classList.toggle('active', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    const it = shown[i];
    if (!it || !it.enabled) return;
    close();
    it.run();
  };
  const open = () => {
    items = collect();
    input.value = '';
    active = 0;
    render();
    backdrop.classList.add('open');
    requestAnimationFrame(() => input.focus());
  };
  const close = () => {
    backdrop.classList.remove('open');
    input.blur();
  };

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); highlight(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  return { open, close };
}

/**
 * Right-click menu, contextual to what's under the pointer. Entries for registered commands
 * take their title, shortcut and state from the registry; read-only mode leaves out the rest.
 */
export function createContextMenu(editor, app, { icons }) {
  editor.on('contextmenu', ({ x, y, world, hit }) => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const at = { x: x + stage.left, y: y + stage.top };
    const cmd = (id, icon, opts) => commandItem(editor, id, icon, { hideDisabled: true, ...opts });
    const edit = !editor.readOnly;
    let items;
    if (hit?.kind === 'node' || hit?.kind === 'port' || hit?.kind === 'handle') {
      items = [
        cmd('view.open', 'enter'),
        cmd('edit.rename', 'edit'),
        cmd('edit.quickAdd', 'link'),
        cmd('edit.duplicate', 'copy'),
        cmd('edit.copyStyle', 'brush'),
        cmd('edit.pasteStyle', 'brush'),
        '-',
        cmd('arrange.group', 'group'),
        ...[...editor.commands.keys()].filter((id) => id.startsWith('arrange.wrap.') || id.startsWith('arrange.outline.')).map((id) => cmd(id, 'boundary')),
        cmd('arrange.ungroup', 'ungroup'),
        cmd('arrange.layout', 'layout', { label: editor.selectedNodeIds().some((id) => editor.doc.isContainer(id)) ? 'Layout contents' : null }),
        cmd('arrange.fit', 'fitContent'),
        cmd('arrange.collapse', 'collapse'),
        cmd('arrange.front', 'front'),
        cmd('arrange.back', 'front'),
        '-',
        cmd('view.dependencies', 'deps', { label: editor.focusDeps ? 'Hide dependencies' : 'Show dependencies' }),
        cmd('view.fitSelection', 'fit'),
        cmd('edit.delete', 'trash', { danger: true }),
      ];
    } else if (hit?.kind === 'edge') {
      const ids = editor.selectedEdgeIds();
      items = [
        cmd('edit.rename', 'edit', { label: 'Edit label' }),
        edit && ['swap', 'Reverse direction', () => editor.reverseEdges(ids)],
        edit && (() => {
          const both = ids.every((id) => editor.doc.edges.get(id)?.data?.bidirectional);
          return ['both', both ? 'One way' : 'Both ways', () => editor.setBidirectional(ids, !both)];
        })(),
        cmd('edge.resetRoute', 'undo'),
        cmd('edit.copyStyle', 'brush'),
        cmd('edit.pasteStyle', 'brush'),
        '-',
        ...(edit ? Object.entries(editor.schema.edgeTypes).map(([k, v]) => [linkKindIcon(v), v.label, () => editor.setEdgeType(ids, k)]) : []),
        '-',
        edit && ['routeOrth', 'Orthogonal', () => editor.setStyle(ids, { routing: null })],
        edit && ['routeCurved', 'Curved', () => editor.setStyle(ids, { routing: 'curved' })],
        edit && ['routeStraight', 'Straight', () => editor.setStyle(ids, { routing: 'straight' })],
        '-',
        cmd('view.fitSelection', 'fit'),
        cmd('edit.delete', 'trash', { danger: true }),
      ];
    } else {
      const types = edit ? Object.entries(editor.schema.nodeTypes).slice(0, 6) : [];
      items = [
        cmd('view.up', 'layers'),
        '-',
        ...types.map(([type, t]) => [icons[t.icon], `Add ${t.label.toLowerCase()}`, () => editor.createNode(type, world, { edit: true }), t.shortcut]),
        '-',
        cmd('edit.paste', 'copy', { label: 'Paste here' }),
        cmd('edit.selectAll', 'cursor'),
        cmd('arrange.layout', 'layout'),
        cmd('view.fit', 'fit'),
      ];
    }
    popover(at, items);
  });
}

/** "New from template": a card per template, plus a blank diagram and the sample. */
export function createTemplatePicker(app, { icons, templates }) {
  const card = (icon, title, description, run) => h('button', {
    type: 'button', class: 'tpl-card', onclick: () => { dialog.close(); run(); },
  }, h('span', { class: 'chip' }, svg(icons[icon] ?? ui[icon], { size: 18 })), h('strong', {}, title), h('span', {}, description));
  const grid = h('div', { class: 'tpl-grid' },
    ...templates.map((t) => card(t.icon, t.title, t.description, () => app.newFromTemplate(t.id))),
    card('module', 'E-commerce platform', 'The sample: modules, a network zone, a trust boundary and a dozen services.', () => app.loadSample()),
    card('file', 'Blank diagram', 'An empty canvas.', () => app.newDiagram()));
  const dialog = modal('Start from a template', { cls: 'templates', label: 'New from template', onOpen: () => grid.querySelector('.tpl-card')?.focus() });
  dialog.body.append(grid);
  return dialog;
}

/**
 * Import from Mermaid: paste a flowchart (or pick a .mmd / Markdown file), then add it to the
 * diagram or open it as a new one. Errors show inline, with their line number.
 */
export function createImportDialog(app, { extract }) {
  const area = h('textarea', {
    class: 'input mono import-text', rows: '12', spellcheck: 'false',
    placeholder: 'flowchart LR\n  web[Web app] -->|HTTPS| api[[API]]\n  api --> db[(Database)]',
  });
  const error = h('p', { class: 'import-error', role: 'alert' });
  const file = h('input', { type: 'file', accept: '.mmd,.mermaid,.md,.markdown,.txt,text/plain', style: { display: 'none' } });
  const run = (replace) => {
    try {
      app.importMermaid(extract(area.value), { replace });
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
    }
  };
  file.onchange = async () => {
    if (file.files[0]) area.value = extract(await file.files[0].text());
    file.value = '';
    error.textContent = '';
  };
  area.addEventListener('input', () => (error.textContent = ''));
  area.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(false);
  });
  const dialog = modal('Import from Mermaid', {
    cls: 'import',
    onOpen: () => {
      error.textContent = '';
      area.focus();
    },
  });
  dialog.body.append(
    h('p', { class: 'muted small' }, 'Paste a flowchart, or a Markdown file containing one. Subgraphs become modules; cylinders, stadiums and hexagons become databases, actors and queues. You can also paste Mermaid straight onto the canvas.'),
    area, error, file,
    h('div', { class: 'import-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, svg(ui.upload, { size: 15 }), 'Choose file…'),
      h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', class: 'btn', onclick: () => run(true) }, 'Open as new diagram'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => run(false) }, 'Add to diagram', kbd('mod+enter'))));
  return dialog;
}

const GESTURES = [
  ['Double-click canvas', 'Add a component (inside a module: add to it)'],
  ['Drag a port ●', 'Connect — drop on empty space to create a linked node'],
  ['Click a port ●', 'Add a connected node in that direction'],
  ['Drag into a module', 'Nest it (drag out to un-nest)'],
  ['Ctrl/⌘ + drag', 'Duplicate (press or release Ctrl mid-drag to switch)'],
  ['Shift + drag', 'Lock to an axis'],
  ['Alt + drag', 'Move, resize or reshape without snapping'],
  ['Space + drag, middle or right drag', 'Pan'],
  ['Wheel / pinch', 'Zoom (trackpad two-finger scroll pans)'],
  ['Drag empty canvas', 'Box select (Shift adds)'],
  ['Drag a link', 'Reshape its route (orthogonal: move a segment; others: add a waypoint)'],
  ['Drag a link end along a side', 'Snaps to the quarter, third and half marks'],
  ['Drag a port onto a Network', 'Attach it to that shared network'],
  ['Drop a Firewall onto a link', 'Insert it in the path (A → Firewall → B)'],
  ['Double-click a resize handle', 'Fit a module, boundary or host to its content'],
  ['Double-click a caption', 'Change the type label (e.g. Frontend, Backend)'],
  ['Double-click a waypoint', 'Remove it'],
  ['Drag a link label', 'Slide it along the link'],
  ['Click a module chevron', 'Collapse / expand it'],
  ['Hover an element', 'Its details: description, owner, status, links'],
  ['Click links while recording a flow', 'Add them as steps, in order'],
  ['Paste Mermaid text', 'Import it as elements'],
];

/** Keyboard & gesture reference, generated from the command registry each time it opens. */
export function createHelp(editor) {
  const build = () => {
    const groups = new Map();
    for (const c of editor.commands.values()) {
      if (c.hidden || !c.keys?.length) continue;
      const g = c.group ?? 'General';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    return h('div', { class: 'help-grid' },
      h('section', {}, h('h3', {}, 'Mouse'), ...GESTURES.map(([a, b]) => h('div', { class: 'help-row' }, h('span', { class: 'gesture' }, a), h('span', {}, b)))),
      ...[...groups].map(([g, cmds]) => h('section', {}, h('h3', {}, g),
        ...cmds.map((c) => h('div', { class: 'help-row' }, h('span', {}, c.title), kbd(c.keys[0]))))));
  };
  const dialog = modal('Shortcuts & gestures', { cls: 'help', label: 'Keyboard shortcuts', onOpen: () => dialog.body.replaceChildren(build()) });
  return dialog;
}
