import { Emitter } from '../engine/emitter.js';
import { clamp } from '../engine/geometry.js';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Infinite-canvas camera. `x, y` is the world point at the screen's top-left corner.
 * Animated transitions interpolate zoom in log space and the view center linearly,
 * which gives the natural "fly to" feel.
 */
export class Camera extends Emitter {
  x = 0;
  y = 0;
  zoom = 1;
  size = { w: 1, h: 1 };
  insets = { top: 0, right: 0, bottom: 0, left: 0 };
  #anim = null;

  toScreen(p) {
    return { x: (p.x - this.x) * this.zoom, y: (p.y - this.y) * this.zoom };
  }

  toWorld(p) {
    return { x: p.x / this.zoom + this.x, y: p.y / this.zoom + this.y };
  }

  viewRect() {
    return { x: this.x, y: this.y, w: this.size.w / this.zoom, h: this.size.h / this.zoom };
  }

  get animating() {
    return this.#anim !== null;
  }

  set(state, { animate = false, duration = 420 } = {}) {
    const to = { x: state.x ?? this.x, y: state.y ?? this.y, zoom: clamp(state.zoom ?? this.zoom, MIN_ZOOM, MAX_ZOOM) };
    if (!animate) {
      this.#anim = null;
      Object.assign(this, to);
    } else {
      this.#anim = { from: { x: this.x, y: this.y, zoom: this.zoom }, to, start: performance.now(), duration };
    }
    this.emit('change');
  }

  zoomAt(screen, factor) {
    this.#anim = null;
    const w = this.toWorld(screen);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.x = w.x - screen.x / this.zoom;
    this.y = w.y - screen.y / this.zoom;
    this.emit('change');
  }

  /** Target state that zooms by `factor` around a screen point (for animated zooms). */
  zoomedAt(screen, factor) {
    const w = this.toWorld(screen);
    const zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    return { zoom, x: w.x - screen.x / zoom, y: w.y - screen.y / zoom };
  }

  panBy(dx, dy) {
    this.#anim = null;
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.emit('change');
  }

  /** Camera state framing `rect` inside the area not covered by floating UI (`insets`). */
  fitRect(rect, { padding = 48, maxZoom = 1 } = {}) {
    const { w, h } = this.size;
    const { top, right, bottom, left } = this.insets;
    const aw = Math.max(w - left - right, 100), ah = Math.max(h - top - bottom, 100);
    const zoom = clamp(Math.min((aw - padding * 2) / Math.max(rect.w, 1), (ah - padding * 2) / Math.max(rect.h, 1), maxZoom), MIN_ZOOM, MAX_ZOOM);
    return { zoom, x: rect.x + rect.w / 2 - (left + aw / 2) / zoom, y: rect.y + rect.h / 2 - (top + ah / 2) / zoom };
  }

  /** Advance the current animation. Returns true while animating. */
  tick(now) {
    const a = this.#anim;
    if (!a) return false;
    const t = clamp((now - a.start) / a.duration, 0, 1);
    const k = easeInOut(t);
    const { w, h } = this.size;
    const zoom = Math.exp(Math.log(a.from.zoom) + (Math.log(a.to.zoom) - Math.log(a.from.zoom)) * k);
    const fc = { x: a.from.x + w / 2 / a.from.zoom, y: a.from.y + h / 2 / a.from.zoom };
    const tc = { x: a.to.x + w / 2 / a.to.zoom, y: a.to.y + h / 2 / a.to.zoom };
    this.zoom = zoom;
    this.x = fc.x + (tc.x - fc.x) * k - w / 2 / zoom;
    this.y = fc.y + (tc.y - fc.y) * k - h / 2 / zoom;
    if (t >= 1) {
      this.#anim = null;
      Object.assign(this, a.to);
    }
    this.emit('change');
    return t < 1;
  }
}
