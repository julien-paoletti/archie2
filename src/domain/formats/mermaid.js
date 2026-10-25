import { resolveType } from '../../engine/schema.js';
import { describe, exported, identifiers, isGroup, kids } from './shared.js';

/**
 * Mermaid flowcharts, both ways. Export maps element kinds to node shapes, boxes holding
 * others to (nested) subgraphs, link kinds to arrow styles and colours to classDefs.
 * Import reads the same subset back (plus the common shapes and arrow forms).
 */

const SHAPES = {
  database: ['[(', ')]'],
  actor: ['([', '])'],
  queue: ['{{', '}}'],
  service: ['[[', ']]'],
  note: ['>', ']'],
};
const ARROWS = { uses: '-->', dataflow: '==>', async: '-.->', association: '---', attachment: '---' };

/** Text inside a Mermaid label: quotes and line breaks escaped. */
const esc = (s) => String(s).replace(/"/g, '#quot;').replace(/\n/g, '<br/>');

export function toMermaid(doc, { direction = 'LR' } = {}) {
  const ids = identifiers(doc, { reserved: ['end', 'graph', 'flowchart', 'subgraph', 'class', 'classDef', 'style', 'click'] });
  const lines = [`flowchart ${direction === 'TB' ? 'TB' : 'LR'}`];
  const classes = new Map();
  const node = (n, pad) => {
    const d = describe(doc, n);
    const label = esc(d.tech ? `${d.name}\n${d.tech}` : d.name);
    if (isGroup(doc, n)) {
      lines.push(`${pad}subgraph ${ids.get(n.id)} ["${label}"]`);
      for (const k of kids(doc, n.id)) node(k, pad + '  ');
      lines.push(`${pad}end`);
    } else {
      const [open, close] = SHAPES[n.type] ?? ['[', ']'];
      lines.push(`${pad}${ids.get(n.id)}${open}"${label}"${close}`);
    }
    const t = resolveType(doc.schema, n);
    const key = `${n.type}${n.style?.color ? '_' + n.style.color.slice(1) : ''}`;
    if (!classes.has(key)) classes.set(key, { color: n.style?.color ?? t.color, dashed: !!t.dashed || !!t.boundary, ids: [] });
    classes.get(key).ids.push(ids.get(n.id));
  };
  for (const n of kids(doc, null)) node(n, '  ');
  for (const e of doc.edges.values()) {
    const s = doc.nodes.get(e.source), t = doc.nodes.get(e.target);
    if (!exported(doc, s) || !exported(doc, t)) continue;
    const text = [e.label, e.data?.tech].filter(Boolean).join('\n');
    const arrow = ARROWS[e.type] ?? '-->';
    lines.push(`  ${ids.get(e.source)} ${arrow}${text ? `|"${esc(text)}"|` : ''} ${ids.get(e.target)}`);
  }
  for (const [key, c] of classes) {
    if (!c.color) continue;
    lines.push(`  classDef ${key} fill:${c.color}1f,stroke:${c.color}${c.dashed ? ',stroke-dasharray:5 4' : ''}`);
    lines.push(`  class ${c.ids.join(',')} ${key}`);
  }
  return lines.join('\n') + '\n';
}

// ───────────────────────────── import

const HEADER = /^\s*(flowchart|graph)\s*(TB|TD|BT|LR|RL)?\s*;?\s*$/im;

/** Does this text hold a Mermaid flowchart (on its own, or in a ```mermaid block)? */
export function looksLikeMermaid(text) {
  return HEADER.test(extractMermaid(text) ?? '');
}

/** The flowchart in a text: the first ```mermaid block of a Markdown file, else the text itself. */
export function extractMermaid(text) {
  const block = /```mermaid[^\n]*\n([\s\S]*?)```/.exec(String(text ?? ''));
  return block ? block[1] : String(text ?? '');
}

/** Node shapes, longest delimiters first so `[(` wins over `[`. */
const OPENERS = [
  ['([', '])', 'actor'], ['[(', ')]', 'database'], ['[[', ']]', 'service'], ['{{', '}}', 'queue'],
  ['((', '))', 'actor'], ['[/', '/]', 'queue'], ['[\\', '\\]', 'queue'], ['[/', '\\]', 'component'], ['[\\', '/]', 'component'],
  ['[', ']', 'component'], ['(', ')', 'component'], ['{', '}', 'component'], ['>', ']', 'note'],
];
// Arrows: --> ---> --- -.-> -.- ==> === --o --x (any length), with an optional |label|.
const EDGE = /^\s*(<?)(-{2,}>|-{3,}|-\.+->|-\.+-|={2,}>|={3,}|-{2,}[ox]|={2,}[ox]|-\.+-[ox])(?:\|([^|]*)\|)?\s*/;
// Text in the middle: A -- label --> B, A -. label .-> B, A == label ==> B.
const TEXT_EDGE = /^\s*(<?)(--|-\.|==)\s+(.+?)\s+(-{2,}>|-{3,}|\.-+>|\.-+|={2,}>|={3,})\s*/;
// Names: letters, digits, underscores, and single dashes inside (my-node), never an arrow.
const ID = /^\s*([A-Za-z0-9_]+(?:-(?![-.>=\s])[A-Za-z0-9_]+)*)/;

/**
 * Parse a Mermaid flowchart into a model `{ nodes, edges, direction }` (no positions: lay it
 * out afterwards). Unknown lines (styles, clicks, comments) are skipped; a missing
 * `flowchart` / `graph` header is an error. Throws Error with a line number when stuck.
 */
export function fromMermaid(text) {
  const src = String(text).replace(/\r/g, '').split('\n');
  const nodes = new Map(), edges = [];
  const stack = [];
  let direction = 'LR';
  let header = false;
  // Mentioning an element inside a subgraph puts it there (that's how Mermaid groups nodes
  // listed by name), unless it already sits in another one; never inside itself.
  const adopt = (n, force) => {
    const into = stack.at(-1);
    if (into && !stack.includes(n.id) && (force || n.parent == null)) n.parent = into;
  };
  const ensure = (id, label, type) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, type: 'component', label: id, parent: null, data: {} }));
    adopt(n, false);
    if (label != null) {
      const [name, ...rest] = unescape(label).split('\n');
      n.label = name.trim() || id;
      if (rest.length) n.data.tech = rest.join(' · ').trim();
    }
    if (type) n.type = type;
    return n;
  };
  /** Read `id` plus an optional shape and label at the start of `s`; returns [id, rest]. */
  const readNode = (s, lineNo) => {
    const m = ID.exec(s);
    if (!m) throw new Error(`Line ${lineNo}: expected an element name in "${s.trim()}"`);
    let rest = s.slice(m[0].length);
    const id = m[1];
    for (const [open, close, type] of OPENERS) {
      if (!rest.startsWith(open)) continue;
      const end = findClose(rest, open.length, close);
      if (end < 0) continue;
      // Defining an element (with a shape) inside a subgraph puts it there in any case.
      adopt(ensure(id, rest.slice(open.length, end), type), true);
      return [id, rest.slice(end + close.length)];
    }
    ensure(id);
    return [id, rest];
  };
  /** One or more `&`-separated nodes. */
  const readGroup = (s, lineNo) => {
    const ids = [];
    let rest = s;
    for (;;) {
      const [id, after] = readNode(rest, lineNo);
      ids.push(id);
      const amp = /^\s*&\s*/.exec(after);
      if (!amp) return [ids, after];
      rest = after.slice(amp[0].length);
    }
  };

  src.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/%%.*$/, '').replace(/:::[\w-]+/g, '').trim().replace(/;$/, '');
    if (!line) return;
    if (!header) {
      const h = /^(flowchart|graph)\s*(TB|TD|BT|LR|RL)?\b/i.exec(line);
      if (!h) throw new Error(`Line ${lineNo}: a Mermaid flowchart starts with "flowchart LR" or "graph TD"`);
      direction = /^(LR|RL)$/i.test(h[2] ?? '') ? 'LR' : h[2] ? 'TB' : 'LR';
      header = true;
      return;
    }
    if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(line)) return;
    const sub = /^subgraph\s+(.*)$/.exec(line);
    if (sub) {
      // subgraph id [title] | subgraph "title" | subgraph id | subgraph Some title
      let id, label;
      const text = sub[1].trim();
      const m = /^([A-Za-z0-9_-]+)\s*\[(.*)\]$/.exec(text);
      if (m) [id, label] = [m[1], m[2]];
      else if (/^[A-Za-z0-9_-]+$/.test(text)) id = text;
      else label = text;
      id ??= 'group_' + (nodes.size + 1);
      const n = ensure(id, label ?? id, 'module');
      n.parent = stack.at(-1) ?? null;
      stack.push(id);
      return;
    }
    if (line === 'end') {
      stack.pop();
      return;
    }
    let [from, rest] = readGroup(line, lineNo);
    for (;;) {
      if (!rest.trim()) break;
      let m = EDGE.exec(rest), arrow, label;
      if (m) [arrow, label] = [m[2], m[3]];
      else if ((m = TEXT_EDGE.exec(rest))) [arrow, label] = [m[4], m[3]];
      else throw new Error(`Line ${lineNo}: can't read "${rest.trim()}"`);
      const [to, after] = readGroup(rest.slice(m[0].length), lineNo);
      for (const s of from) for (const t of to) edges.push(edgeOf(s, t, arrow, label));
      [from, rest] = [to, after];
    }
  });
  if (!header) throw new Error('Empty diagram: a Mermaid flowchart starts with "flowchart LR" or "graph TD"');
  return { nodes: [...nodes.values()], edges, direction };
}

/** Thick arrows read as data flow, dotted as async, arrowless as association, the rest as uses. */
function edgeOf(source, target, arrow, label) {
  const head = /[>ox]$/.test(arrow);
  const type = arrow.includes('=') ? 'dataflow' : arrow.includes('.') ? (head ? 'async' : 'association') : head ? 'uses' : 'association';
  const e = { source, target, type, label: '', data: {} };
  if (label) {
    const [text, ...rest] = unescape(label).split('\n');
    e.label = text.trim();
    if (rest.length) e.data.tech = rest.join(' · ').trim();
  }
  return e;
}

/** Index of `close` after `from`, skipping a quoted label. */
function findClose(s, from, close) {
  let i = from;
  while (i < s.length && s[i] === ' ') i++;
  if (s[i] === '"') {
    const q = s.indexOf('"', i + 1);
    if (q < 0) return -1;
    i = q + 1;
  }
  return s.indexOf(close, i);
}

/** Label text: quotes dropped, entities and <br> turned back into characters. */
function unescape(label) {
  return String(label).trim().replace(/^"(.*)"$/s, '$1')
    .replace(/<br\s*\/?>/gi, '\n').replace(/#quot;/g, '"').replace(/#amp;/g, '&').replace(/<\/?[a-z][^>]*>/gi, '');
}
