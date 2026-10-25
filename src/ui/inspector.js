import { overlaps, polylineCrossesRect } from '../engine/geometry.js';
import { boundariesCrossed, busMembers, isOverlay, resolveType } from '../engine/schema.js';
import { h, kbd, svg, ui } from './dom.js';
import { popover } from './chrome.js';
import { linkName, safeUrl, splitLinks } from './links.js';

let focusSeq = 0;

/** Element status: [value, label]; '' is the default (in use, no badge). */
const STATUSES = [['', 'In use'], ['planned', 'Planned'], ['deprecated', 'Deprecated']];

/**
 * Right-hand inspector. Rebuilt on selection change; fields are refreshed in place on
 * document changes (unless focused), and each typing session is one undo step.
 */
export function createInspector(editor, app, root, { icons, palette }) {
  const panel = h('aside', { class: 'panel inspector', 'aria-label': 'Inspector' });
  root.append(panel);
  const doc = editor.doc;
  let refreshers = [];

  const section = (title, ...body) => h('section', { class: 'insp-section' }, title && h('h3', {}, title), ...body);
  const row = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);

  /** Text input bound to a getter/setter; a focus session merges into one history entry. */
  let listSeq = 0;
  const text = (get, set, { placeholder = '', multiline = false, suggestions = null } = {}) => {
    let session = '';
    const listId = suggestions?.length ? 'insp-list-' + ++listSeq : null;
    const el = h(multiline ? 'textarea' : 'input', {
      class: 'input', placeholder, spellcheck: 'false', rows: multiline ? '3' : null, list: listId,
      onfocus: () => (session = 'insp' + ++focusSeq),
      oninput: (e) => set(e.target.value, session),
      onkeydown: (e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && !multiline)) e.target.blur();
      },
    });
    el.value = get() ?? '';
    refreshers.push(() => { if (document.activeElement !== el) el.value = get() ?? ''; });
    if (!listId) return el;
    return h('div', {}, el, h('datalist', { id: listId }, suggestions.map((v) => h('option', { value: v }))));
  };

  /** "Type label" field: shown under the name instead of the type; suggests labels in use. */
  const stereotypeField = (ids, fallback) => {
    const nodes = () => ids.map((id) => doc.nodes.get(id)).filter(Boolean);
    const common = () => {
      const values = new Set(nodes().map((n) => n.data?.stereotype ?? ''));
      return values.size === 1 ? [...values][0] : '';
    };
    const mixed = new Set(nodes().map((n) => n.data?.stereotype ?? '')).size > 1;
    return row('Type label', text(common, (v, s) => editor.setStereotype(ids, v, s), {
      placeholder: mixed ? 'Mixed' : fallback, suggestions: editor.stereotypes(),
    }));
  };

  const number = (get, set) => {
    const el = h('input', {
      class: 'input num', type: 'number', step: '1',
      onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) set(v); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
    });
    el.value = Math.round(get());
    refreshers.push(() => { if (document.activeElement !== el) el.value = Math.round(get()); });
    return el;
  };

  const segmented = (options, get, set, { labels = false } = {}) => {
    const wrap = h('div', { class: 'segmented' });
    const btns = options.map(([value, label, icon]) => {
      const b = h('button', { type: 'button', class: 'seg', 'data-tip': label, onclick: () => set(value) }, icon ? svg(icon, { size: 15 }) : null, icon && !labels ? null : label);
      wrap.append(b);
      return [value, b];
    });
    const sync = () => btns.forEach(([v, b]) => b.classList.toggle('on', v === get()));
    sync();
    refreshers.push(sync);
    return wrap;
  };

  const swatches = (ids, get) => {
    const wrap = h('div', { class: 'swatches' });
    const auto = h('button', { type: 'button', class: 'swatch auto', 'data-tip': 'Default color', onclick: () => editor.setStyle(ids, { color: null }) });
    wrap.append(auto);
    const btns = palette.map((c) => {
      const b = h('button', { type: 'button', class: 'swatch', style: { '--c': c }, 'aria-label': c, onclick: () => editor.setStyle(ids, { color: c }) });
      wrap.append(b);
      return [c, b];
    });
    const sync = () => {
      const cur = get();
      auto.classList.toggle('on', !cur);
      btns.forEach(([c, b]) => b.classList.toggle('on', c === cur));
    };
    sync();
    refreshers.push(sync);
    return wrap;
  };

  const action = (icon, label, run, keys, cls = '') =>
    h('button', { type: 'button', class: 'btn-row ' + cls, onclick: run }, svg(ui[icon], { size: 15 }), h('span', {}, label), kbd(keys));

  const typePicker = (n) => {
    const t = resolveType(editor.schema, n);
    const btn = h('button', { type: 'button', class: 'type-picker', style: { '--c': n.style?.color ?? t.color } },
      h('span', { class: 'chip' }, svg(icons[t.icon], { size: 16 })),
      h('span', { class: 'type-name' }, t.label ?? n.type),
      svg('M6 9l6 6 6-6', { size: 14 }));
    btn.onclick = () => {
      const hasKids = doc.hasChildren(n.id);
      popover(btn, Object.entries(editor.schema.nodeTypes).map(([type, tt]) => [
        icons[tt.icon], tt.label, () => editor.setType([n.id], type), null, { disabled: hasKids && !tt.container },
      ]));
    };
    return btn;
  };

  /** Free text: the words and how they look, nothing else. */
  const textView = (n) => {
    const get = () => doc.nodes.get(n.id);
    const style = (patch) => editor.setTextStyle([n.id], patch);
    return [
      section(null, typePicker(n)),
      section(null, row('Text', text(() => get()?.label, (v, s) => doc.transact('Edit text', () => {
        doc.update(n.id, { label: v });
        editor.fitText(n.id);
      }, { merge: s }), { multiline: true, placeholder: 'Type something…' }))),
      section('Size', segmented([['sm', 'S'], ['md', 'M'], ['lg', 'L'], ['xl', 'Title']],
        () => get()?.style?.textSize ?? 'md', (v) => style({ textSize: v === 'md' ? null : v }))),
      section('Align', segmented([['left', 'Left', ui.alignLeft], ['center', 'Center', ui.alignHC], ['right', 'Right', ui.alignRight]],
        () => get()?.style?.align ?? 'left', (v) => style({ align: v === 'left' ? null : v }))),
      section('Color', swatches([n.id], () => get()?.style?.color)),
      section(null, h('div', { class: 'actions' },
        action('copy', 'Duplicate', () => editor.duplicate(), 'mod+d'),
        action('trash', 'Delete', () => editor.deleteSelection(), 'delete', 'danger'),
      )),
    ];
  };

  const nodeView = (n) => {
    if (editor.isText(n.id)) return textView(n);
    const t = resolveType(editor.schema, n);
    const get = () => doc.nodes.get(n.id);
    const ins = editor.doc.edgesOf(n.id);
    const incoming = ins.filter((e) => e.target === n.id);
    const outgoing = ins.filter((e) => e.source === n.id);
    const link = (e, other) => h('button', { type: 'button', class: 'conn', onclick: () => editor.reveal(e.id) },
      svg(other === e.target ? ui.dirLR : 'M20 12H4 M10 6l-6 6 6 6', { size: 13 }),
      h('span', {}, doc.nodes.get(other)?.label || '—'),
      e.label ? h('em', {}, e.label) : null);
    const variants = editor.schema.nodeTypes[n.type]?.variants;
    const members = t.shape === 'bus' ? busMembers(doc, n.id) : [];
    const networks = [...new Set(doc.edgesOf(n.id).map((e) => (e.source === n.id ? e.target : e.source)))]
      .map((id) => doc.nodes.get(id)).filter((x) => x && editor.schema.nodeTypes[x.type]?.shape === 'bus');
    const nodeLink = (x, extra) => h('button', { type: 'button', class: 'conn', onclick: () => editor.reveal(x.id) },
      h('span', { class: 'chip sm', style: { '--c': x.style?.color ?? resolveType(editor.schema, x).color } }, svg(icons[resolveType(editor.schema, x).icon], { size: 13 })),
      h('span', {}, x.label || resolveType(editor.schema, x).label), extra ? h('em', {}, extra) : null);
    const crossing = t.boundary ? [...doc.edges.values()].filter((e) => boundariesCrossed(doc, e).some((b) => b.id === n.id)) : [];
    const name = (id) => doc.nodes.get(id)?.label || '—';
    return [
      section(null, typePicker(n)),
      variants && section('Kind', segmented(
        Object.entries(variants).map(([k, v]) => [k, v.label, icons[v.icon]]),
        () => get()?.data?.variant ?? editor.schema.nodeTypes[n.type].defaultVariant,
        (v) => editor.setData(n.id, 'variant', v),
        { labels: true },
      )),
      t.boundary && section('Mode', segmented([
        ['contain', 'Contains elements', ui.group],
        ['border', 'Border only', ui.boundary],
      ], () => (get()?.data?.borderOnly ? 'border' : 'contain'), (v) => editor.setBorderOnly([n.id], v === 'border'), { labels: true }),
      get()?.data?.borderOnly ? h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Surrounds without containing: links crossing the outline are marked. Click it by its tab or outline.') : null),
      section(null,
        row('Name', text(() => get()?.label, (v, s) => doc.transact('Rename', () => doc.update(n.id, { label: v }), { merge: s }))),
        stereotypeField([n.id], t.label),
        row(t.techLabel ?? 'Technology', text(() => get()?.data?.tech, (v, s) => editor.setData(n.id, 'tech', v, s), { placeholder: t.techPlaceholder ?? 'e.g. Go, PostgreSQL, Kafka' })),
        row('Description', text(() => get()?.data?.description, (v, s) => editor.setData(n.id, 'description', v, s), { placeholder: 'What does it do?', multiline: true })),
      ),
      section('Details',
        row('Owner', text(() => get()?.data?.owner, (v, s) => editor.setData(n.id, 'owner', v, s), { placeholder: 'Team or person', suggestions: owners() })),
        row('Status', segmented(STATUSES.map(([k, label]) => [k, label]), () => get()?.data?.status ?? '', (v) => editor.setData(n.id, 'status', v || null))),
        row('Links', text(() => (get()?.data?.links ?? []).join('\n'), (v, s) => editor.setData(n.id, 'links', splitLinks(v), s), { placeholder: 'Docs, repo… one URL per line', multiline: true })),
        linkChips(() => get()?.data?.links),
      ),
      section('Color', swatches([n.id], () => get()?.style?.color)),
      section('Geometry', h('div', { class: 'grid4' },
        row('X', number(() => get().x, (v) => editor.doc.transact('Move', () => doc.moveBy([n.id], v - get().x, 0)))),
        row('Y', number(() => get().y, (v) => editor.doc.transact('Move', () => doc.moveBy([n.id], 0, v - get().y)))),
        row('W', number(() => get().w, (v) => doc.transact('Resize', () => doc.update(n.id, { w: Math.max(40, v) })))),
        row('H', number(() => get().h, (v) => doc.transact('Resize', () => doc.update(n.id, { h: Math.max(30, v) })))),
      )),
      members.length > 0 && section(`Members · ${members.length}`, h('div', { class: 'conns' }, ...members.map((m) => {
        const att = doc.edgesOf(n.id).find((e) => doc.visibleAncestor(e.source) === m.id || doc.visibleAncestor(e.target) === m.id);
        return nodeLink(m, att?.data?.tech || att?.label);
      }))),
      networks.length > 0 && section('Networks', h('div', { class: 'conns' }, ...networks.map((x) => nodeLink(x, x.data?.tech)))),
      crossing.length > 0 && section(`Links crossing · ${crossing.length}`, h('div', { class: 'conns' }, ...crossing.map((e) =>
        h('button', { type: 'button', class: 'conn', onclick: () => editor.reveal(e.id) },
          svg(ui.link, { size: 13 }), h('span', {}, `${name(e.source)} → ${name(e.target)}`), e.label ? h('em', {}, e.label) : null)))),
      (incoming.length || outgoing.length) && section(`Connections · ${incoming.length + outgoing.length}`,
        h('div', { class: 'conns' }, ...outgoing.map((e) => link(e, e.target)), ...incoming.map((e) => link(e, e.source)))),
      section(null, h('div', { class: 'actions' },
        t.container && doc.hasChildren(n.id) && !n.collapsed && action('layout', 'Layout contents', () => editor.autoLayout(), 'l'),
        editor.canFitToContent([n.id]) && action('fitContent', 'Fit to content', () => editor.fitToContent([n.id]), 'f'),
        doc.isContainer(n) && !editor.showsAsCard(n.id) && action(n.collapsed ? 'expand' : 'collapse', n.collapsed ? 'Expand' : 'Collapse', () => editor.toggleCollapse([n.id]), 'c'),
        action('link', 'Add connected node', () => editor.quickAdd(n.id), 'tab'),
        action('copy', 'Duplicate', () => editor.duplicate(), 'mod+d'),
        t.container && doc.hasChildren(n.id) ? action('ungroup', 'Ungroup', () => editor.ungroup(), 'mod+shift+g') : action('group', 'Group into module', () => editor.group(), 'mod+g'),
        action('trash', 'Delete', () => editor.deleteSelection(), 'delete', 'danger'),
      )),
    ];
  };

  /** Owners already named in the diagram, for suggestions. */
  const owners = () => [...new Set([...doc.nodes.values()].map((x) => x.data?.owner).filter(Boolean))].sort();

  /** The element's links as chips that open in a new tab (web links only). */
  const linkChips = (get) => {
    const wrap = h('div', { class: 'link-chips' });
    const sync = () => wrap.replaceChildren(...(get() ?? []).map((raw) => {
      const url = safeUrl(raw);
      return url
        ? h('a', { class: 'link-chip', href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href }, svg(ui.external, { size: 12 }), linkName(url))
        : h('span', { class: 'link-chip bad', title: 'Only http(s) links can be opened' }, raw);
    }));
    sync();
    refreshers.push(sync);
    return wrap;
  };

  /** Protocols used in the diagram first, then common ones. */
  const protocols = () => [...new Set([
    ...[...doc.edges.values()].map((x) => x.data?.tech).filter(Boolean),
    'HTTPS', 'HTTP/1.1', 'HTTP/2', 'gRPC', 'REST/JSON', 'GraphQL', 'WebSocket', 'AMQP', 'Kafka', 'MQTT', 'SQL/TCP', 'SMTP', 'SFTP',
  ])];

  const edgeView = (e) => {
    const get = () => doc.edges.get(e.id);
    const crosses = boundariesCrossed(doc, e);
    const et = editor.schema.edgeTypes[e.type] ?? {};
    const name = (id) => doc.nodes.get(id)?.label || '—';
    return [
      section(null, h('div', { class: 'edge-ends' },
        h('button', { type: 'button', class: 'end', onclick: () => editor.reveal(get().source) }, name(e.source)),
        svg(ui.dirLR, { size: 14 }),
        h('button', { type: 'button', class: 'end', onclick: () => editor.reveal(get().target) }, name(e.target)),
      )),
      section('Kind', segmented(Object.entries(editor.schema.edgeTypes).map(([k, v]) => [k, v.label]), () => get()?.type, (v) => editor.setEdgeType([e.id], v))),
      crosses.length > 0 && section('Crosses', h('div', { class: 'conns' }, ...crosses.map((b) => {
        const bt = resolveType(editor.schema, b);
        return h('button', { type: 'button', class: 'conn', onclick: () => editor.reveal(b.id) },
          h('span', { class: 'chip sm', style: { '--c': b.style?.color ?? bt.color } }, svg(icons[bt.icon], { size: 13 })),
          h('span', {}, b.label || bt.label), h('em', {}, bt.label));
      }))),
      section(null,
        row('Label', text(() => get()?.label, (v, s) => doc.transact('Label', () => doc.update(e.id, { label: v }), { merge: s }), { placeholder: 'e.g. reads orders' })),
        row(et.techLabel ?? 'Protocol', text(() => get()?.data?.tech, (v, s) => editor.setProtocol(e.id, v, s), {
          placeholder: et.techPlaceholder ?? 'e.g. HTTPS, gRPC, AMQP', suggestions: et.techLabel ? null : protocols(),
        })),
      ),
      section('Routing', segmented([
        ['orthogonal', 'Orthogonal', ui.routeOrth], ['curved', 'Curved', ui.routeCurved], ['straight', 'Straight', ui.routeStraight],
      ], () => get()?.style?.routing ?? 'orthogonal', (v) => editor.setStyle([e.id], { routing: v === 'orthogonal' ? null : v }))),
      section('Color', swatches([e.id], () => get()?.style?.color)),
      section(null, h('div', { class: 'actions' },
        action('edit', 'Edit label', () => editor.editLabel(e.id), 'enter'),
        action('swap', 'Reverse direction', () => editor.reverseEdges([e.id])),
        (e.style?.points || e.style?.labelT != null) && action('routeOrth', 'Reset route', () => editor.resetRoute([e.id]), 'r'),
        action('trash', 'Delete', () => editor.deleteSelection(), 'delete', 'danger'),
      )),
    ];
  };

  const wrap = [...editor.commands.values()].find((c) => c.id.startsWith('arrange.wrap.'));
  const outline = [...editor.commands.values()].find((c) => c.id.startsWith('arrange.outline.'));
  const multiView = (nodes, edges) => {
    const top = editor.topLevel(nodes);
    const alignBtn = (icon, label, run) => h('button', { type: 'button', class: 'btn', 'data-tip': label, disabled: top.length < 2, onclick: run }, svg(ui[icon]));
    return [
      section(null, h('div', { class: 'multi-title' },
        h('strong', {}, `${nodes.length} node${nodes.length === 1 ? '' : 's'}`),
        edges.length ? h('span', {}, ` · ${edges.length} link${edges.length === 1 ? '' : 's'}`) : null)),
      nodes.length > 1 && section(null, stereotypeField(nodes, 'Type label for all')),
      nodes.length > 1 && section('Align', h('div', { class: 'align-grid' },
        alignBtn('alignLeft', 'Align left', () => editor.align('left')),
        alignBtn('alignHC', 'Align centers', () => editor.align('hcenter')),
        alignBtn('alignRight', 'Align right', () => editor.align('right')),
        alignBtn('alignTop', 'Align top', () => editor.align('top')),
        alignBtn('alignVC', 'Align middles', () => editor.align('vcenter')),
        alignBtn('alignBottom', 'Align bottom', () => editor.align('bottom')),
        h('button', { type: 'button', class: 'btn', 'data-tip': 'Distribute horizontally', disabled: top.length < 3, onclick: () => editor.distribute('x') }, svg(ui.distH)),
        h('button', { type: 'button', class: 'btn', 'data-tip': 'Distribute vertically', disabled: top.length < 3, onclick: () => editor.distribute('y') }, svg(ui.distV)),
      )),
      nodes.length && section('Color', swatches([...nodes, ...edges], () => null)),
      section(null, h('div', { class: 'actions' },
        nodes.length && action('group', 'Group into module', () => editor.group(), 'mod+g'),
        nodes.length && wrap && action('boundary', wrap.title, () => wrap.run(), 'b'),
        nodes.length && outline && action('boundary', outline.title, () => outline.run(), 'alt+b'),
        editor.canFitToContent(nodes) && action('fitContent', 'Fit to content', () => editor.fitToContent(nodes), 'f'),
        nodes.length && action('layout', 'Auto layout', () => editor.autoLayout(), 'l'),
        nodes.length && action('copy', 'Duplicate', () => editor.duplicate(), 'mod+d'),
        action('trash', 'Delete', () => editor.deleteSelection(), 'delete', 'danger'),
      )),
    ];
  };

  const docView = () => {
    const stat = (n, label) => h('div', { class: 'stat' }, h('strong', {}, String(n)), h('span', {}, label));
    const toggle = (label, key) => {
      const input = h('input', { type: 'checkbox', checked: !!editor.settings[key], onchange: () => editor.toggleSetting(key) });
      refreshers.push(() => (input.checked = !!editor.settings[key]));
      return h('label', { class: 'toggle' }, h('span', {}, label), input, h('i', {}));
    };
    const counts = h('div', { class: 'stats' });
    const updateCounts = () => counts.replaceChildren(
      stat(doc.nodes.size, 'nodes'), stat(doc.edges.size, 'links'),
      stat([...doc.nodes.values()].filter((n) => n.type === editor.schema.groupType).length, 'modules'),
      stat([...doc.nodes.values()].filter((n) => editor.schema.nodeTypes[n.type]?.boundary).length, 'boundaries'));
    updateCounts();
    refreshers.push(updateCounts);
    return [
      section('Diagram', counts),
      section('Canvas',
        toggle('Snap to grid', 'snapToGrid'),
        toggle('Smart guides', 'snapToObjects'),
        toggle('Show grid', 'showGrid'),
      ),
      section('Auto layout',
        segmented([['LR', 'Left → right', ui.dirLR], ['TB', 'Top → bottom', ui.dirTB]], () => editor.settings.layoutDirection,
          (v) => { editor.settings.layoutDirection = v; editor.emit('settings'); }),
        h('div', { class: 'actions' }, action('layout', 'Arrange diagram', () => editor.autoLayout(), 'l'))),
      section(null, h('p', { class: 'muted small' }, 'Select something to edit its properties.')),
    ];
  };

  const render = () => {
    refreshers = [];
    const nodes = editor.selectedNodeIds();
    const edges = editor.selectedEdgeIds();
    let content;
    if (nodes.length === 1 && !edges.length) content = nodeView(doc.nodes.get(nodes[0]));
    else if (edges.length === 1 && !nodes.length) content = edgeView(doc.edges.get(edges[0]));
    else if (nodes.length || edges.length) content = multiView(nodes, edges);
    else content = docView();
    panel.replaceChildren(...content.filter(Boolean));
  };

  let pending = false;
  const refresh = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      refreshers.forEach((f) => f());
    });
  };

  editor.on('selectionchange', render);
  editor.on('docchange', (e) => {
    // Structural changes (type, connections) need a rebuild; edits just refresh values.
    const manualFlip = (op) => {
      const a = op.before.style, b = op.after.style;
      return !!a?.points !== !!b?.points || (a?.labelT == null) !== (b?.labelT == null);
    };
    const rebuild = e.reset || e.patch.ops.some((op) => op.t !== 'set' || 'type' in op.after || 'source' in op.after ||
      'target' in op.after || 'collapsed' in op.after || ('style' in op.after && manualFlip(op)) ||
      ('data' in op.after && !!op.before.data?.borderOnly !== !!op.after.data?.borderOnly));
    if (rebuild && !panel.contains(document.activeElement)) render();
    else refresh();
  });
  editor.on('settings', refresh);
  const sync = () => panel.classList.toggle('hidden', !app.inspectorOpen);
  app.on('change', sync);
  sync();
  render();
}

/**
 * Floating quick-actions bar just above the selection: the most common actions are
 * one short mouse move away.
 */
export function createSelectionBar(editor, app, root, { palette }) {
  const bar = h('div', { class: 'panel selbar', role: 'toolbar', 'aria-label': 'Selection actions' });
  root.append(bar);
  const doc = editor.doc;
  const btn = (icon, label, run) => h('button', { type: 'button', class: 'btn', 'data-tip': label, 'aria-label': label, onclick: run }, svg(ui[icon] ?? icon, { size: 16 }));

  const colorBtn = (ids) => {
    const first = doc.get(ids[0]);
    const t = resolveType(editor.schema, first);
    const b = h('button', { type: 'button', class: 'btn color-dot', 'data-tip': 'Color', style: { '--c': first?.style?.color ?? t.color ?? '#94a3b8' } }, h('i', {}));
    b.onclick = () => {
      const pop = h('div', { class: 'panel swatch-pop' });
      for (const c of [null, ...palette]) {
        pop.append(h('button', {
          type: 'button', class: 'swatch' + (c ? '' : ' auto'), style: c ? { '--c': c } : null,
          onclick: () => { editor.setStyle(ids, { color: c }); close(); },
        }));
      }
      document.body.append(pop);
      const r = b.getBoundingClientRect();
      Object.assign(pop.style, { left: Math.min(r.left, innerWidth - 260) + 'px', top: r.bottom + 8 + 'px' });
      requestAnimationFrame(() => pop.classList.add('open'));
      const onDown = (e) => { if (!pop.contains(e.target)) close(); };
      const close = () => {
        document.removeEventListener('pointerdown', onDown, true);
        pop.classList.remove('open');
        setTimeout(() => pop.remove(), 150);
      };
      setTimeout(() => document.addEventListener('pointerdown', onDown, true));
    };
    return b;
  };

  const build = () => {
    const nodes = editor.selectedNodeIds();
    const edges = editor.selectedEdgeIds();
    const items = [];
    const depsBtn = (label) => {
      const b = btn('deps', label + '  ·  D', () => editor.toggleDependencies());
      b.classList.toggle('on', editor.focusDeps);
      return b;
    };
    if (nodes.length === 1 && !edges.length) {
      const n = doc.nodes.get(nodes[0]);
      items.push(colorBtn(nodes), btn('edit', (editor.isText(n.id) ? 'Edit text' : 'Rename') + '  ·  Enter', () => editor.editLabel(n.id)));
      if (!editor.schema.nodeTypes[n.type]?.noPorts) items.push(btn('link', 'Add connected  ·  Tab', () => editor.quickAdd(n.id)), depsBtn('Dependencies'));
      if (doc.isContainer(n) && doc.hasChildren(n.id) && !n.collapsed) items.push(btn('layout', 'Layout contents  ·  L', () => editor.autoLayout()));
      if (editor.canFitToContent([n.id])) items.push(btn('fitContent', 'Fit to content  ·  F', () => editor.fitToContent([n.id])));
      if (doc.isContainer(n) && !editor.showsAsCard(n.id)) items.push(btn(n.collapsed ? 'expand' : 'collapse', (n.collapsed ? 'Expand' : 'Collapse') + '  ·  C', () => editor.toggleCollapse([n.id])));
      items.push(btn('copy', 'Duplicate', () => editor.duplicate()));
    } else if (nodes.length > 1) {
      const alignMenu = btn('alignLeft', 'Align & distribute', () => popover(alignMenu, [
        ['alignLeft', 'Align left', () => editor.align('left'), 'alt+a'],
        ['alignHC', 'Align centers', () => editor.align('hcenter'), 'alt+h'],
        ['alignRight', 'Align right', () => editor.align('right'), 'alt+d'],
        null,
        ['alignTop', 'Align top', () => editor.align('top'), 'alt+w'],
        ['alignVC', 'Align middles', () => editor.align('vcenter'), 'alt+v'],
        ['alignBottom', 'Align bottom', () => editor.align('bottom'), 'alt+s'],
        null,
        ['distH', 'Distribute horizontally', () => editor.distribute('x'), 'alt+shift+h'],
        ['distV', 'Distribute vertically', () => editor.distribute('y'), 'alt+shift+v'],
      ]));
      items.push(colorBtn(nodes), alignMenu, btn('group', 'Group  ·  Ctrl+G', () => editor.group()));
      if (nodes.length === 2) items.push(depsBtn('Paths between them'));
      const wrap = [...editor.commands.values()].find((c) => c.id.startsWith('arrange.wrap.'));
      if (wrap) items.push(btn('boundary', wrap.title + '  ·  B', () => wrap.run()));
      items.push(btn('layout', 'Auto layout', () => editor.autoLayout()));
    } else if (edges.length) {
      const e = doc.edges.get(edges[0]);
      const modes = ['orthogonal', 'curved', 'straight'];
      const icons = { orthogonal: ui.routeOrth, curved: ui.routeCurved, straight: ui.routeStraight };
      const cur = e.style?.routing ?? 'orthogonal';
      const next = modes[(modes.indexOf(cur) + 1) % 3];
      items.push(colorBtn(edges), btn(icons[cur], `Routing: ${cur} (click to change)`, () => editor.setStyle(edges, { routing: next === 'orthogonal' ? null : next })));
      if (edges.length === 1) items.push(btn('edit', 'Label  ·  Enter', () => editor.editLabel(e.id)));
      items.push(btn('swap', 'Reverse', () => editor.reverseEdges(edges)));
      if (edges.some((id) => { const s = doc.edges.get(id).style; return s?.points || s?.labelT != null; })) {
        items.push(btn('undo', 'Reset route  ·  R', () => editor.resetRoute(edges)));
      }
    }
    if (!items.length) return false;
    items.push(h('i', { class: 'sep' }), btn('trash', 'Delete', () => editor.deleteSelection()));
    bar.replaceChildren(...items);
    return true;
  };

  let visible = false;
  const worldRect = (x, y, w, hh) => {
    const a = editor.toWorld({ x, y }), b = editor.toWorld({ x: x + w, y: y + hh });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };
  /**
   * Would the bar at (x, y) hide something you may want to grab: the header of an enclosing
   * container, or another element (e.g. the element a selected link points at)?
   */
  const coversSomething = (x, y, w, hh) => {
    const bar = worldRect(x, y, w, hh);
    const head = editor.settings.containerHeader;
    const selected = new Set(editor.selectedNodeIds());
    const ancestors = new Set([...selected].flatMap((id) => doc.ancestors(id)));
    const hidden = doc.hidden();
    return doc.index.query(bar).some((id) => {
      if (selected.has(id) || hidden.has(id)) return false;
      const c = doc.nodes.get(id);
      if (ancestors.has(id) || (doc.isContainer(c) && !editor.showsAsCard(id))) {
        return overlaps(bar, { x: c.x, y: c.y - 14, w: c.w, h: head + 14 });
      }
      return overlaps(bar, c);
    });
  };
  /** Would the bar at (x, y) sit on another link? A click meant for that link would hit a button instead. */
  const coversLink = (x, y, w, hh) => {
    const bar = worldRect(x, y, w, hh);
    for (const e of doc.edges.values()) {
      if (editor.selection.has(e.id)) continue;
      const r = editor.router.peek(e.id);
      if (r && overlaps(bar, r.bbox) && polylineCrossesRect(r.poly, bar)) return true;
    }
    return false;
  };

  let replaceQueued = false;
  const place = () => {
    const show = visible && !editor.gesture && !editor.editingId && !editor.camera.animating;
    const b = show && editor.selectionBounds();
    // A selected link's tag is measured when drawn; if it hasn't been yet, place again next frame.
    const unmeasured = show && editor.selectedEdgeIds().some((id) => {
      const e = doc.edges.get(id);
      return (e.label || e.data?.tech) && !editor.layoutProbe?.labelRect?.(id);
    });
    if (unmeasured && !replaceQueued) {
      replaceQueued = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { replaceQueued = false; place(); }));
    }
    if (!b) {
      bar.classList.remove('in');
      return;
    }
    const tl = editor.toScreen(b), br = editor.toScreen({ x: b.x + b.w, y: b.y + b.h });
    const w = bar.offsetWidth, hh = bar.offsetHeight;
    const size = editor.camera.size;
    const maxX = size.w - w - (app.inspectorOpen ? 310 : 12);
    const clampX = (v) => Math.max(70, Math.min(v, maxX));
    const midX = clampX((tl.x + br.x) / 2 - w / 2), midY = (tl.y + br.y) / 2 - hh / 2;
    // Above the selection by default (centred, then flush with either end), then below, right,
    // left: the first spot that is on screen and hides nothing you may want to grab (an element,
    // an enclosing header, a link). Failing that, one that at least keeps links clickable.
    const startX = clampX(tl.x), endX = clampX(br.x - w);
    const spots = [
      [midX, tl.y - hh - 14], [startX, tl.y - hh - 14], [endX, tl.y - hh - 14],
      [midX, br.y + 14], [startX, br.y + 14], [endX, br.y + 14],
      [br.x + 14, midY], [tl.x - w - 14, midY],
    ].filter(([sx, sy]) => sy >= 70 && sy <= size.h - hh - 12 && sx >= 70 && sx <= maxX);
    const [x, y] = spots.find(([sx, sy]) => !coversSomething(sx, sy, w, hh) && !coversLink(sx, sy, w, hh)) ??
      spots.find(([sx, sy]) => !coversLink(sx, sy, w, hh)) ?? spots[0] ?? [midX, Math.max(br.y + 14, 70)];
    if (y > size.h - hh - 12 || br.y < 0 || tl.y > size.h) {
      bar.classList.remove('in');
      return;
    }
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    bar.classList.add('in');
  };
  const rebuild = () => {
    visible = build();
    place();
  };
  editor.on('selectionchange', rebuild);
  editor.on('focus', rebuild);
  editor.on('docchange', () => {
    if (editor.selection.size && !editor.gesture) rebuild();
  });
  editor.on('gesture', (active) => (active ? place() : rebuild()));
  for (const ev of ['camera', 'edit-label', 'edit-end']) editor.on(ev, place);
  app.on('change', place);
}
