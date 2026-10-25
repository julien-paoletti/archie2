/**
 * A recording Canvas 2D context that emits SVG. It implements the subset of the API the
 * renderer uses, so the exact same drawing code produces both pixels and vectors.
 * Geometry is emitted in device space (transforms applied as it is recorded), which
 * assumes the renderer's transforms are translations and uniform scales.
 */

const STATE_KEYS = [
  'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'font', 'textAlign',
  'textBaseline', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineDashOffset', 'letterSpacing',
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => (Math.round(v * 100) / 100).toString();

/** CSS color → [svg color, alpha]. Handles #rgb(a), rgb() and rgba(). */
function paint(color) {
  if (typeof color !== 'string' || color === 'transparent') return ['none', 0];
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
    return [`rgb(${r},${g},${b})`, parseFloat(a)];
  }
  if (/^#[0-9a-f]{8}$/i.test(color)) return [color.slice(0, 7), parseInt(color.slice(7), 16) / 255];
  return [color, 1];
}

export class SVGContext {
  fillStyle = '#000';
  strokeStyle = '#000';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  shadowColor = 'transparent';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  lineDashOffset = 0;
  letterSpacing = '0px';

  #m = [1, 0, 0, 1, 0, 0];
  #dash = [];
  #stack = [];
  #path = '';
  #cur = null;
  #start = null;
  #out = [];
  #filters = new Map();
  #clips = [];
  /** Groups opened by clip(), closed again by the restore() matching their save(). */
  #open = 0;

  constructor(measure) {
    this.measure = measure;
  }

  // ── state
  save() {
    const s = { m: [...this.#m], dash: [...this.#dash], open: this.#open };
    for (const k of STATE_KEYS) s[k] = this[k];
    this.#stack.push(s);
  }

  restore() {
    const s = this.#stack.pop();
    if (!s) return;
    this.#m = s.m;
    this.#dash = s.dash;
    for (; this.#open > s.open; this.#open--) this.#out.push('</g>');
    for (const k of STATE_KEYS) this[k] = s[k];
  }

  setTransform(a, b, c, d, e, f) { this.#m = [a, b, c, d, e, f]; }
  resetTransform() { this.#m = [1, 0, 0, 1, 0, 0]; }
  translate(x, y) {
    const m = this.#m;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
  }
  scale(sx, sy) {
    const m = this.#m;
    m[0] *= sx; m[1] *= sx; m[2] *= sy; m[3] *= sy;
  }
  setLineDash(d) { this.#dash = [...d]; }
  getLineDash() { return [...this.#dash]; }

  measureText(text) {
    this.measure.font = this.font;
    return this.measure.measureText(text);
  }

  #tp(x, y) {
    const m = this.#m;
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  }

  get #k() {
    const m = this.#m;
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  }

  // ── paths (recorded in user space for arcTo, emitted in device space)
  beginPath() {
    this.#path = '';
    this.#cur = this.#start = null;
  }

  moveTo(x, y) {
    const p = this.#tp(x, y);
    this.#path += `M${num(p.x)} ${num(p.y)}`;
    this.#cur = this.#start = { x, y };
  }

  lineTo(x, y) {
    if (!this.#cur) return this.moveTo(x, y);
    const p = this.#tp(x, y);
    this.#path += `L${num(p.x)} ${num(p.y)}`;
    this.#cur = { x, y };
  }

  closePath() {
    if (!this.#path) return;
    this.#path += 'Z';
    this.#cur = this.#start;
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    if (!this.#cur) this.moveTo(x1, y1);
    const a = this.#tp(x1, y1), b = this.#tp(x2, y2), p = this.#tp(x, y);
    this.#path += `C${num(a.x)} ${num(a.y)} ${num(b.x)} ${num(b.y)} ${num(p.x)} ${num(p.y)}`;
    this.#cur = { x, y };
  }

  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  roundRect(x, y, w, h, r = 0) {
    r = Math.max(0, Math.min(Array.isArray(r) ? r[0] : r, w / 2, h / 2));
    if (!r) return this.rect(x, y, w, h);
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    this.#arcSeg(r, r, false, true, x + w, y + r);
    this.lineTo(x + w, y + h - r);
    this.#arcSeg(r, r, false, true, x + w - r, y + h);
    this.lineTo(x + r, y + h);
    this.#arcSeg(r, r, false, true, x, y + h - r);
    this.lineTo(x, y + r);
    this.#arcSeg(r, r, false, true, x + r, y);
    this.closePath();
  }

  /** SVG elliptical-arc segment to (x, y) in user space. */
  #arcSeg(rx, ry, large, sweep, x, y) {
    const p = this.#tp(x, y), k = this.#k;
    this.#path += `A${num(rx * k)} ${num(ry * k)} 0 ${large ? 1 : 0} ${sweep ? 1 : 0} ${num(p.x)} ${num(p.y)}`;
    this.#cur = { x, y };
  }

  ellipse(cx, cy, rx, ry, rotation, a0, a1, ccw = false) {
    const at = (a) => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    let delta = ccw ? a0 - a1 : a1 - a0;
    const full = Math.abs(delta) >= Math.PI * 2 - 1e-9;
    delta = ((delta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const s = at(a0);
    if (this.#cur) this.lineTo(s.x, s.y);
    else this.moveTo(s.x, s.y);
    if (full) {
      const mid = at(a0 + (ccw ? -Math.PI : Math.PI));
      this.#arcSeg(rx, ry, false, !ccw, mid.x, mid.y);
      this.#arcSeg(rx, ry, false, !ccw, s.x, s.y);
      return;
    }
    const e = at(a1);
    this.#arcSeg(rx, ry, delta > Math.PI, !ccw, e.x, e.y);
  }

  arc(cx, cy, r, a0, a1, ccw = false) {
    this.ellipse(cx, cy, r, r, 0, a0, a1, ccw);
  }

  arcTo(x1, y1, x2, y2, r) {
    const p0 = this.#cur;
    if (!p0) return this.moveTo(x1, y1);
    const v1 = { x: p0.x - x1, y: p0.y - y1 }, v2 = { x: x2 - x1, y: y2 - y1 };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    const cross = v1.x * v2.y - v1.y * v2.x;
    if (!r || !l1 || !l2 || Math.abs(cross) < 1e-9) return this.lineTo(x1, y1);
    const cos = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
    const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
    const t = r / Math.tan(theta / 2);
    this.lineTo(x1 + (v1.x / l1) * t, y1 + (v1.y / l1) * t);
    // Turning clockwise on screen (y down) maps to SVG sweep-flag 1.
    const d1 = { x: -v1.x, y: -v1.y };
    this.#arcSeg(r, r, false, d1.x * v2.y - d1.y * v2.x > 0, x1 + (v2.x / l2) * t, y1 + (v2.y / l2) * t);
  }

  // ── painting
  #filter() {
    const [color, alpha] = paint(this.shadowColor);
    if (!this.shadowBlur || alpha === 0) return '';
    const key = `${color}|${alpha}|${num(this.shadowBlur)}|${num(this.shadowOffsetY)}`;
    let id = this.#filters.get(key);
    if (!id) {
      id = 'shadow' + this.#filters.size;
      this.#filters.set(key, id);
    }
    return ` filter="url(#${id})"`;
  }

  fill() {
    if (!this.#path) return;
    const [color, a] = paint(this.fillStyle);
    if (color === 'none') return;
    this.#out.push(`<path d="${this.#path}" fill="${esc(color)}" fill-opacity="${num(a * this.globalAlpha)}"${this.#filter()}/>`);
  }

  #strokeAttrs() {
    const [color, a] = paint(this.strokeStyle);
    const k = this.#k;
    let s = ` fill="none" stroke="${esc(color)}" stroke-opacity="${num(a * this.globalAlpha)}" stroke-width="${num(this.lineWidth * k)}"`;
    s += ` stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"`;
    if (this.#dash.length) s += ` stroke-dasharray="${this.#dash.map((d) => num(d * k)).join(' ')}" stroke-dashoffset="${num(this.lineDashOffset * k)}"`;
    return s;
  }

  stroke() {
    if (!this.#path) return;
    this.#out.push(`<path d="${this.#path}"${this.#strokeAttrs()}/>`);
  }

  /** Stroke an SVG path string under the current transform (icons). */
  strokeIcon(d) {
    const m = this.#m;
    const [color, a] = paint(this.strokeStyle);
    this.#out.push(`<path d="${esc(d)}" transform="matrix(${m.map(num).join(' ')})" fill="none" stroke="${esc(color)}" stroke-opacity="${num(a * this.globalAlpha)}" stroke-width="${num(this.lineWidth)}" stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"/>`);
  }

  fillRect(x, y, w, h) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.fill();
  }

  strokeRect(x, y, w, h) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.stroke();
  }

  clearRect() {}

  /** Clip what follows (until the matching restore) to the current path. */
  clip(rule = 'nonzero') {
    if (!this.#path) return;
    const id = 'clip' + this.#clips.length;
    this.#clips.push(`<clipPath id="${id}"><path d="${this.#path}" clip-rule="${rule === 'evenodd' ? 'evenodd' : 'nonzero'}"/></clipPath>`);
    this.#out.push(`<g clip-path="url(#${id})">`);
    this.#open++;
  }

  fillText(text, x, y) {
    const [color, a] = paint(this.fillStyle);
    const m = this.font.match(/^(?:(\d+)\s+)?([\d.]+)px\s+(.*)$/);
    const weight = m?.[1] ?? '400', size = parseFloat(m?.[2] ?? '10') * this.#k, family = m?.[3] ?? 'sans-serif';
    const anchor = { center: 'middle', right: 'end', end: 'end' }[this.textAlign] ?? 'start';
    const baseline = this.textBaseline === 'middle' ? ' dominant-baseline="central"' : '';
    const p = this.#tp(x, y);
    this.#out.push(`<text x="${num(p.x)}" y="${num(p.y)}" font-family="${esc(family)}" font-size="${num(size)}" font-weight="${weight}" fill="${esc(color)}" fill-opacity="${num(a * this.globalAlpha)}" text-anchor="${anchor}"${baseline}>${esc(text)}</text>`);
  }

  toSVG(width, height, background) {
    const defs = [...this.#filters].map(([key, id]) => {
      const [color, alpha, blur, dy] = key.split('|');
      return `<filter id="${id}" x="-25%" y="-25%" width="150%" height="170%"><feDropShadow dx="0" dy="${dy}" stdDeviation="${num(blur / 2)}" flood-color="${color}" flood-opacity="${alpha}"/></filter>`;
    }).concat(this.#clips);
    for (; this.#open > 0; this.#open--) this.#out.push('</g>');
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
      defs.length ? `<defs>${defs.join('')}</defs>` : '',
      background ? `<rect width="100%" height="100%" fill="${esc(background)}"/>` : '',
      ...this.#out,
      '</svg>',
    ].join('\n');
  }
}
