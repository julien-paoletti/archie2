import { RULES, checkDiagram } from '../engine/checks.js';
import { dismissable, h, svg, ui } from './dom.js';

const SHOWN_PER_RULE = 40;

/**
 * Diagram checks: a toolbar button with the warning count, opening a list of issues grouped
 * by rule. Clicking an issue selects the element or link and brings it into view.
 */
export function createChecks(editor) {
  const badge = h('span', { class: 'badge' });
  const button = h('button', { class: 'btn checks-btn', type: 'button', 'aria-label': 'Diagram checks', onclick: () => toggle() }, svg(ui.check), badge);
  const panel = h('div', { class: 'panel checks', role: 'dialog', 'aria-label': 'Diagram checks' });
  document.body.append(panel);
  let issues = [], undismiss = null, timer = 0;

  const refresh = () => {
    timer = 0;
    // Not in the middle of a drag: the diagram is still changing (the gesture end reschedules).
    if (editor.gesture) return;
    issues = checkDiagram(editor.doc);
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const tips = issues.length - warnings;
    badge.textContent = warnings ? String(warnings) : '';
    button.dataset.tip = issues.length
      ? `Checks: ${plural(warnings, 'warning')}, ${plural(tips, 'suggestion')}`
      : 'Checks: no issues';
    if (panel.classList.contains('open')) render();
  };
  // Debounced: checks run once things settle, not several times a second while editing.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  };

  const render = () => {
    const groups = new Map();
    for (const i of issues) {
      if (!groups.has(i.rule)) groups.set(i.rule, []);
      groups.get(i.rule).push(i);
    }
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    panel.replaceChildren(...[
      h('div', { class: 'checks-head' }, h('strong', {}, 'Checks'),
        h('span', {}, issues.length ? `${plural(warnings, 'warning')} · ${plural(issues.length - warnings, 'suggestion')}` : '')),
      !issues.length && h('div', { class: 'checks-empty' }, svg(ui.check, { size: 22 }), h('span', {}, 'No issues found')),
      ...[...groups].map(([rule, list]) => h('section', {},
        h('h3', {}, RULES[rule].title, h('span', {}, String(list.length))),
        ...list.slice(0, SHOWN_PER_RULE).map((i) => h('button', {
          type: 'button', class: 'check-item ' + i.severity,
          onclick: () => { close(); editor.reveal(i.id); },
        }, svg(i.severity === 'warning' ? ui.warning : ui.info, { size: 14 }), h('span', {}, i.message))),
        list.length > SHOWN_PER_RULE ? h('p', { class: 'muted small' }, `and ${list.length - SHOWN_PER_RULE} more`) : null)),
    ].filter(Boolean));
  };

  const open = () => {
    refresh();
    render();
    const r = button.getBoundingClientRect();
    Object.assign(panel.style, { top: r.bottom + 10 + 'px', right: Math.max(8, innerWidth - r.right - 6) + 'px' });
    panel.classList.add('open');
    button.classList.add('on');
    undismiss = dismissable(panel, () => close(), [button]);
  };
  const close = () => {
    undismiss?.();
    undismiss = null;
    panel.classList.remove('open');
    button.classList.remove('on');
  };
  const toggle = () => (panel.classList.contains('open') ? close() : open());

  editor.on('docchange', schedule);
  editor.on('gesture', (active) => { if (!active) schedule(); });
  editor.registerCommand({ id: 'view.checks', title: 'Check diagram', group: 'View', run: open });
  refresh();
  return button;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
