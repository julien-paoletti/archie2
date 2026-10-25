/**
 * Command registry entries: one definition drives keyboard shortcuts, the command palette,
 * menus and the help sheet. `passive` keys are shown but handled by native events
 * (copy/cut/paste go through the browser clipboard events).
 */

export function comboOf(e) {
  let key;
  if (/^Digit\d$/.test(e.code ?? '')) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code ?? '')) key = e.code.slice(6);
  else key = (e.key ?? '').toLowerCase();
  // Option on a Mac turns letters into other characters (⌥C types "ç"): fall back to the
  // physical key then, but only then, so letters still follow the layout (AZERTY...).
  if (key.length === 1 && !/[a-z0-9]/.test(key) && /^Key[A-Z]$/.test(e.code ?? '')) key = e.code.slice(3).toLowerCase();
  if (key === ' ') key = 'space';
  if (key === '+') key = '=';
  return [e.mod && 'mod', e.alt && 'alt', e.shift && 'shift', key].filter(Boolean).join('+');
}

export function createCommands(ed) {
  const hasNodes = () => ed.selectedNodeIds().length > 0;
  const hasAny = () => ed.selection.size > 0;
  const single = () => ed.singleSelected() !== null;
  const singleNode = () => ed.doc.nodes.has(ed.singleSelected());
  const multi = (n) => () => ed.topLevel(ed.selectedNodeIds()).length >= n;
  const nudge = (dx, dy) => () => {
    const step = ed.settings.snapToGrid ? ed.settings.grid : 1;
    ed.nudge(dx * step, dy * step);
  };

  const cmds = [
    { id: 'edit.undo', title: 'Undo', group: 'Edit', keys: ['mod+z'], run: () => ed.undo(), enabled: () => ed.history.canUndo },
    { id: 'edit.redo', title: 'Redo', group: 'Edit', keys: ['mod+shift+z', 'mod+y'], run: () => ed.redo(), enabled: () => ed.history.canRedo },
    { id: 'edit.delete', title: 'Delete', group: 'Edit', keys: ['delete', 'backspace'], run: () => ed.deleteSelection(), enabled: hasAny },
    { id: 'edit.selectAll', title: 'Select all', group: 'Edit', keys: ['mod+a'], run: () => ed.selectAll() },
    { id: 'edit.duplicate', title: 'Duplicate', group: 'Edit', keys: ['mod+d'], run: () => ed.duplicate(), enabled: hasNodes },
    { id: 'edit.copy', title: 'Copy', group: 'Edit', keys: ['mod+c'], passive: true, run: () => ed.copy(), enabled: hasNodes },
    { id: 'edit.cut', title: 'Cut', group: 'Edit', keys: ['mod+x'], passive: true, run: () => ed.cut(), enabled: hasNodes },
    { id: 'edit.paste', title: 'Paste', group: 'Edit', keys: ['mod+v'], passive: true, run: () => ed.paste(), enabled: () => !!ed.clipboard },
    { id: 'edit.copyStyle', title: 'Copy style', group: 'Edit', keys: ['mod+alt+c'], run: () => ed.copyStyle(), enabled: single },
    { id: 'edit.pasteStyle', title: 'Paste style', group: 'Edit', keys: ['mod+alt+v'], run: () => ed.pasteStyle(), enabled: () => !!ed.styleClip && hasAny() },
    { id: 'edit.rename', title: 'Rename', group: 'Edit', keys: ['enter', 'f2'], run: () => ed.editLabel(ed.singleSelected()), enabled: single },
    {
      id: 'edit.stereotype', title: 'Edit type label / link protocol', group: 'Edit', keys: ['shift+enter', 'shift+f2'],
      run: () => ed.editLabel(ed.singleSelected(), 'stereotype'), enabled: single,
    },
    { id: 'edit.quickAdd', title: 'Add connected node', group: 'Edit', keys: ['tab'], run: () => ed.quickAdd(ed.singleSelected()),
      enabled: () => singleNode() && !ed.schema.nodeTypes[ed.doc.nodes.get(ed.singleSelected()).type]?.noPorts },
    { id: 'edit.escape', title: 'Deselect', group: 'Edit', keys: ['escape'], hidden: true, run: () => ed.escape() },

    { id: 'arrange.layout', title: 'Auto layout', group: 'Arrange', keys: ['l'], run: () => ed.autoLayout() },
    {
      id: 'arrange.layoutFlip', title: 'Auto layout (flip direction)', group: 'Arrange', keys: ['shift+l'],
      run: () => {
        ed.settings.layoutDirection = ed.settings.layoutDirection === 'LR' ? 'TB' : 'LR';
        ed.emit('settings');
        ed.autoLayout();
      },
    },
    { id: 'arrange.group', title: 'Group into module', group: 'Arrange', keys: ['mod+g'], run: () => ed.group(), enabled: hasNodes },
    ...boundaryCommands(ed, hasNodes),
    { id: 'arrange.ungroup', title: 'Ungroup', group: 'Arrange', keys: ['mod+shift+g'], run: () => ed.ungroup(), enabled: () => ed.selectedNodeIds().some((id) => ed.doc.isContainer(id)) },
    {
      id: 'arrange.collapse', title: 'Collapse / expand module', group: 'Arrange', keys: ['c'],
      run: () => ed.toggleCollapse(), enabled: () => ed.selectedNodeIds().some((id) => ed.doc.isContainer(id)),
    },
    {
      id: 'edge.resetRoute', title: 'Reset link route', group: 'Arrange', keys: ['r'],
      run: () => ed.resetRoute(),
      enabled: () => ed.selectedEdgeIds().some((id) => { const s = ed.doc.edges.get(id).style; return s?.points || s?.labelT != null; }),
    },
    {
      id: 'arrange.fit', title: 'Fit to content', group: 'Arrange', keys: ['f'],
      run: () => ed.fitToContent(), enabled: () => ed.canFitToContent(),
    },
    { id: 'arrange.front', title: 'Bring to front', group: 'Arrange', keys: [']'], run: () => ed.bringToFront(), enabled: hasNodes },
    { id: 'arrange.back', title: 'Send to back', group: 'Arrange', keys: ['['], run: () => ed.sendToBack(), enabled: hasNodes },
    { id: 'align.left', title: 'Align left', group: 'Align', keys: ['alt+a'], run: () => ed.align('left'), enabled: multi(2) },
    { id: 'align.hcenter', title: 'Align horizontal centers', group: 'Align', keys: ['alt+h'], run: () => ed.align('hcenter'), enabled: multi(2) },
    { id: 'align.right', title: 'Align right', group: 'Align', keys: ['alt+d'], run: () => ed.align('right'), enabled: multi(2) },
    { id: 'align.top', title: 'Align top', group: 'Align', keys: ['alt+w'], run: () => ed.align('top'), enabled: multi(2) },
    { id: 'align.vcenter', title: 'Align vertical centers', group: 'Align', keys: ['alt+v'], run: () => ed.align('vcenter'), enabled: multi(2) },
    { id: 'align.bottom', title: 'Align bottom', group: 'Align', keys: ['alt+s'], run: () => ed.align('bottom'), enabled: multi(2) },
    { id: 'align.distributeH', title: 'Distribute horizontally', group: 'Align', keys: ['alt+shift+h'], run: () => ed.distribute('x'), enabled: multi(3) },
    { id: 'align.distributeV', title: 'Distribute vertically', group: 'Align', keys: ['alt+shift+v'], run: () => ed.distribute('y'), enabled: multi(3) },

    { id: 'nudge.left', title: 'Nudge left', hidden: true, keys: ['arrowleft'], run: nudge(-1, 0) },
    { id: 'nudge.right', title: 'Nudge right', hidden: true, keys: ['arrowright'], run: nudge(1, 0) },
    { id: 'nudge.up', title: 'Nudge up', hidden: true, keys: ['arrowup'], run: nudge(0, -1) },
    { id: 'nudge.down', title: 'Nudge down', hidden: true, keys: ['arrowdown'], run: nudge(0, 1) },
    { id: 'nudge.left5', title: 'Nudge left ×5', hidden: true, keys: ['shift+arrowleft'], run: nudge(-5, 0) },
    { id: 'nudge.right5', title: 'Nudge right ×5', hidden: true, keys: ['shift+arrowright'], run: nudge(5, 0) },
    { id: 'nudge.up5', title: 'Nudge up ×5', hidden: true, keys: ['shift+arrowup'], run: nudge(0, -5) },
    { id: 'nudge.down5', title: 'Nudge down ×5', hidden: true, keys: ['shift+arrowdown'], run: nudge(0, 5) },

    { id: 'view.dependencies', title: 'Show dependencies (dim the rest)', group: 'View', keys: ['d'], run: () => ed.toggleDependencies() },
    { id: 'view.fit', title: 'Zoom to fit', group: 'View', keys: ['shift+1'], run: () => ed.fitView() },
    { id: 'view.fitSelection', title: 'Zoom to selection', group: 'View', keys: ['shift+2'], run: () => ed.zoomToSelection(), enabled: hasAny },
    { id: 'view.actual', title: 'Zoom to 100%', group: 'View', keys: ['shift+0'], run: () => ed.zoomTo(1) },
    { id: 'view.zoomIn', title: 'Zoom in', group: 'View', keys: ['mod+=', '='], run: () => ed.zoomBy(1.25) },
    { id: 'view.zoomOut', title: 'Zoom out', group: 'View', keys: ['mod+-', '-'], run: () => ed.zoomBy(0.8) },
    { id: 'tool.select', title: 'Select tool', group: 'View', keys: ['v'], run: () => ed.setTool('select') },
    { id: 'tool.hand', title: 'Hand tool', group: 'View', keys: ['h'], run: () => ed.setTool('hand') },
    { id: 'settings.snapGrid', title: 'Toggle snap to grid', group: 'View', keys: ["mod+'"], run: () => ed.toggleSetting('snapToGrid') },
    { id: 'settings.snapObjects', title: 'Toggle smart guides', group: 'View', keys: ['mod+;'], run: () => ed.toggleSetting('snapToObjects') },
  ];

  for (const [type, t] of Object.entries(ed.schema.nodeTypes)) {
    cmds.push({
      id: 'create.' + type,
      title: `Add ${t.label}`,
      group: 'Create',
      keys: t.shortcut ? [t.shortcut] : [],
      run: () => ed.createNode(type, ed.insertionPoint(), { edit: true }),
    });
  }
  return cmds;
}

/** "Wrap in …" commands for each variant of the schema's boundary type, if it has one. */
function boundaryCommands(ed, enabled) {
  const entry = Object.entries(ed.schema.nodeTypes).find(([, t]) => t.boundary);
  if (!entry) return [];
  const [type, t] = entry;
  const variants = Object.entries(t.variants ?? { [t.defaultVariant ?? 'default']: t });
  return variants.flatMap(([variant, v], i) => [{
    id: 'arrange.wrap.' + variant,
    title: 'Wrap in ' + v.label.toLowerCase(),
    group: 'Arrange',
    keys: i === 0 ? ['b'] : i === 1 ? ['shift+b'] : [],
    run: () => ed.group(type, { variant }),
    enabled,
  }, {
    id: 'arrange.outline.' + variant,
    title: 'Outline with ' + v.label.toLowerCase() + ' (border only)',
    group: 'Arrange',
    keys: i === 0 ? ['alt+b'] : i === 1 ? ['alt+shift+b'] : [],
    run: () => ed.outlineSelection(variant),
    enabled,
  }]);
}
