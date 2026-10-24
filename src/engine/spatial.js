import { intersects } from './geometry.js';

const OFFSET = 1 << 15;
const keyOf = (cx, cy) => (cx + OFFSET) * 65536 + (cy + OFFSET);

/**
 * Uniform-grid spatial hash. O(1) updates, near-O(k) rect queries.
 * Used for viewport culling, hit testing, snapping candidates and router obstacles.
 */
export class SpatialHash {
  constructor(cellSize = 256) {
    this.size = cellSize;
    this.cells = new Map();
    this.items = new Map();
    this.stamp = 0;
  }

  #range(r) {
    const s = this.size;
    return [Math.floor(r.x / s), Math.floor(r.y / s), Math.floor((r.x + r.w) / s), Math.floor((r.y + r.h) / s)];
  }

  set(id, r) {
    const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const [x0, y0, x1, y1] = this.#range(rect);
    const prev = this.items.get(id);
    if (prev && prev.x0 === x0 && prev.y0 === y0 && prev.x1 === x1 && prev.y1 === y1) {
      prev.rect = rect;
      return;
    }
    if (prev) this.#unlink(id, prev);
    const entry = { rect, x0, y0, x1, y1, mark: 0 };
    this.items.set(id, entry);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = keyOf(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = new Set()));
        cell.add(id);
      }
    }
  }

  delete(id) {
    const entry = this.items.get(id);
    if (!entry) return;
    this.#unlink(id, entry);
    this.items.delete(id);
  }

  #unlink(id, e) {
    for (let cx = e.x0; cx <= e.x1; cx++) {
      for (let cy = e.y0; cy <= e.y1; cy++) {
        const k = keyOf(cx, cy);
        const cell = this.cells.get(k);
        if (!cell) continue;
        cell.delete(id);
        if (cell.size === 0) this.cells.delete(k);
      }
    }
  }

  clear() {
    this.cells.clear();
    this.items.clear();
  }

  /** Ids of items whose rect intersects `r` (inclusive). */
  query(r, out = []) {
    const [x0, y0, x1, y1] = this.#range(r);
    const stamp = ++this.stamp;
    // Huge query regions (zoomed far out) are cheaper as a linear scan.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.items.size * 2 + 64) {
      for (const [id, e] of this.items) if (intersects(e.rect, r)) out.push(id);
      return out;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(keyOf(cx, cy));
        if (!cell) continue;
        for (const id of cell) {
          const e = this.items.get(id);
          if (e.mark === stamp) continue;
          e.mark = stamp;
          if (intersects(e.rect, r)) out.push(id);
        }
      }
    }
    return out;
  }
}
