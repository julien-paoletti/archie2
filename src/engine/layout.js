/**
 * Hierarchical layered layout (Sugiyama-style), container-aware.
 *
 * Containers are laid out bottom-up: each container's children are arranged first, which
 * gives the container its size; then the container is treated as a single node one level
 * up. Edges between nested nodes are "lifted" to the ancestors that are siblings at the
 * current level. Collapsed containers are laid out as plain nodes (their contents are kept).
 *
 * Per level: connected components → cycle breaking (DFS) → longest-path ranking →
 * dummy nodes for long edges → barycentric crossing reduction (keeping the best ordering)
 * → cross-axis placement by weighted isotonic regression (pool-adjacent-violators), which
 * pulls nodes towards their neighbours while keeping order and spacing exact.
 */

/** Space kept on each side of a link label between two ranks. */
const LABEL_MARGIN = 18;

const DEFAULTS = {
  direction: 'LR',
  nodeGap: 40,
  rankGap: 100,
  componentGap: 80,
  padding: 28,
  header: 52,
  minContainerWidth: 240,
  scope: null,
};

/** Returns Map<nodeId, {x,y,w,h}> with the new absolute geometry of every laid-out node. */
export function layoutHierarchy(doc, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const edges = [...doc.edges.values()];
  const result = new Map();

  const layoutLevel = (parentId) => {
    // Border-only outlines and annotations (free text) are not laid out: they stay where placed.
    const kids = doc.children(parentId).filter((n) => !n.data?.borderOnly && !doc.schema.nodeTypes?.[n.type]?.annotation);
    const items = kids.map((n) => {
      if (doc.isContainer(n) && doc.hasChildren(n.id) && !n.collapsed) {
        const sub = layoutLevel(n.id);
        return {
          id: n.id,
          w: Math.max(sub.w + 2 * o.padding, o.minContainerWidth),
          h: sub.h + o.header + o.padding,
          sub,
        };
      }
      return { id: n.id, w: n.w, h: n.h };
    });
    const indexOf = new Map(kids.map((n, i) => [n.id, i]));
    const lift = (id) => {
      for (let cur = id, guard = 0; cur != null && guard < 1000; guard++) {
        const n = doc.getNode(cur);
        if (!n) return -1;
        if ((n.parent ?? null) === parentId) return indexOf.get(cur);
        cur = n.parent;
      }
      return -1;
    };
    const links = [];
    const seen = new Map();
    for (const e of edges) {
      const s = lift(e.source), t = lift(e.target);
      if (s < 0 || t < 0 || s === t) continue;
      const room = labelRoom(e, o.direction !== 'TB');
      const link = seen.get(s + ':' + t);
      if (link) link[2] = Math.max(link[2], room);
      else {
        const l = [s, t, room];
        seen.set(s + ':' + t, l);
        links.push(l);
      }
    }
    const arranged = arrange(items, links, o);
    return { items, pos: arranged.pos, w: arranged.w, h: arranged.h };
  };

  const place = (level, ox, oy) => {
    level.items.forEach((it, i) => {
      const r = { x: ox + level.pos[i].x, y: oy + level.pos[i].y, w: it.w, h: it.h };
      result.set(it.id, r);
      if (it.sub) place(it.sub, r.x + (r.w - it.sub.w) / 2, r.y + o.header);
    });
  };

  if (o.scope != null) {
    const c = doc.getNode(o.scope);
    if (!c) return result;
    const level = layoutLevel(o.scope);
    if (!level.items.length) return result;
    const w = Math.max(level.w + 2 * o.padding, o.minContainerWidth);
    result.set(o.scope, { x: c.x, y: c.y, w, h: level.h + o.header + o.padding });
    place(level, c.x + (w - level.w) / 2, c.y + o.header);
  } else {
    const level = layoutLevel(null);
    const b = doc.bounds(doc.children(null).map((n) => n.id)) ?? { x: 0, y: 0 };
    place(level, b.x, b.y);
  }
  return result;
}

/**
 * Room a link's tag (label over protocol) needs along the main axis: its width when ranks
 * are columns, its height when they are rows. Estimated from the text (the engine has no
 * fonts), matching the renderer's 220px cap and padding.
 */
export function labelRoom(e, horizontal) {
  const label = e.label ?? '', tech = e.data?.tech ?? '';
  if (!label && !tech) return 0;
  if (!horizontal) return label && tech ? 33 : 21;
  return Math.min(Math.max(label.length * 6.6, tech.length * 6.3), 220) + 14;
}

/**
 * Arrange sized items given directed links `[source, target, room?]` (indices; `room` is the
 * space the link's label needs between ranks). Returns top-left positions and extent.
 */
export function arrange(items, links, o = DEFAULTS) {
  const n = items.length;
  if (!n) return { pos: [], w: 0, h: 0 };
  const horizontal = o.direction !== 'TB';
  const mainOf = (it) => (horizontal ? it.w : it.h);
  const crossOf = (it) => (horizontal ? it.h : it.w);

  const parent = items.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const [s, t] of links) parent[find(s)] = find(t);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const connected = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  const singles = [...groups.values()].filter((g) => g.length === 1).flat();

  const pos = new Array(n);
  let crossOffset = 0;
  let mainExtent = 0;
  for (const comp of connected) {
    const local = layered(comp, links, items, o, mainOf, crossOf);
    for (const [i, p] of local.pos) pos[i] = { m: p.m, c: p.c + crossOffset };
    crossOffset += local.c + o.componentGap;
    mainExtent = Math.max(mainExtent, local.m);
  }

  if (singles.length) {
    // Unconnected siblings stack like a rank (a column for LR), wrapping into a grid when many.
    const perLine = singles.length <= 4 ? singles.length : Math.ceil(Math.sqrt(singles.length));
    const lines = [];
    for (let k = 0; k < singles.length; k += perLine) lines.push(singles.slice(k, k + perLine));
    let m = 0;
    for (const line of lines) {
      const width = Math.max(...line.map((i) => mainOf(items[i])));
      let c = crossOffset;
      for (const i of line) {
        pos[i] = { m: m + (width - mainOf(items[i])) / 2, c };
        c += crossOf(items[i]) + o.nodeGap;
      }
      m += width + o.nodeGap;
    }
    mainExtent = Math.max(mainExtent, m - o.nodeGap);
    crossOffset += Math.max(...lines.map((line) => line.reduce((s, i) => s + crossOf(items[i]) + o.nodeGap, -o.nodeGap)));
  } else {
    crossOffset -= o.componentGap;
  }

  return {
    pos: pos.map((p) => (horizontal ? { x: p.m, y: p.c } : { x: p.c, y: p.m })),
    w: horizontal ? mainExtent : crossOffset,
    h: horizontal ? crossOffset : mainExtent,
  };
}

function layered(comp, links, items, o, mainOf, crossOf) {
  const N = comp.length;
  const local = new Map(comp.map((g, l) => [g, l]));
  const out = Array.from({ length: N }, () => []);
  // Label room per pair, either way round (cycle breaking may reverse a link).
  const room = new Map();
  for (const [s, t, r = 0] of links) {
    const a = local.get(s), b = local.get(t);
    if (a === undefined || b === undefined) continue;
    out[a].push(b);
    for (const key of [a + ':' + b, b + ':' + a]) room.set(key, Math.max(room.get(key) ?? 0, r));
  }

  // 1. Break cycles: DFS from sources, reversing back edges.
  const state = new Uint8Array(N);
  const dag = [];
  const hasIn = new Uint8Array(N);
  for (const list of out) for (const v of list) hasIn[v] = 1;
  const visit = (root) => {
    const stack = [[root, 0]];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, k] = top;
      if (k < out[u].length) {
        top[1]++;
        const v = out[u][k];
        if (state[v] === 1) dag.push([v, u]);
        else {
          dag.push([u, v]);
          if (state[v] === 0) {
            state[v] = 1;
            stack.push([v, 0]);
          }
        }
      } else {
        state[u] = 2;
        stack.pop();
      }
    }
  };
  for (let u = 0; u < N; u++) if (!hasIn[u] && !state[u]) visit(u);
  for (let u = 0; u < N; u++) if (!state[u]) visit(u);

  const succ = Array.from({ length: N }, () => []);
  const pred = Array.from({ length: N }, () => []);
  const uniq = new Set();
  for (const [u, v] of dag) {
    if (u === v || uniq.has(u + ':' + v)) continue;
    uniq.add(u + ':' + v);
    succ[u].push(v);
    pred[v].push(u);
  }

  // 2. Longest-path ranking, then pull sources next to their first successor.
  const rank = new Int32Array(N);
  const indeg = pred.map((p) => p.length);
  const topo = [];
  for (let u = 0; u < N; u++) if (!indeg[u]) topo.push(u);
  for (let q = 0; q < topo.length; q++) {
    const u = topo[q];
    for (const v of succ[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      if (--indeg[v] === 0) topo.push(v);
    }
  }
  for (let q = topo.length - 1; q >= 0; q--) {
    const u = topo[q];
    if (!pred[u].length && succ[u].length) rank[u] = Math.min(...succ[u].map((v) => rank[v])) - 1;
  }
  const minRank = Math.min(...rank);
  for (let u = 0; u < N; u++) rank[u] -= minRank;

  // 3. Virtual graph: real nodes + dummies on long edges.
  const V = [];
  const up = [], down = [];
  for (let u = 0; u < N; u++) {
    const it = items[comp[u]];
    V.push({ item: u, rank: rank[u], m: mainOf(it), c: crossOf(it) });
    up.push([]);
    down.push([]);
  }
  for (let u = 0; u < N; u++) {
    for (const v of succ[u]) {
      let prev = u;
      for (let r = rank[u] + 1; r < rank[v]; r++) {
        const d = V.length;
        V.push({ item: -1, rank: r, m: 0, c: 0 });
        up.push([prev]);
        down.push([]);
        down[prev].push(d);
        prev = d;
      }
      down[prev].push(v);
      up[v].push(prev);
    }
  }
  const R = Math.max(...V.map((v) => v.rank)) + 1;
  let layers = Array.from({ length: R }, () => []);

  // Initial order: DFS discovery from the first layer keeps related nodes adjacent.
  const seen = new Uint8Array(V.length);
  const dfs = (v) => {
    const stack = [v];
    while (stack.length) {
      const x = stack.pop();
      if (seen[x]) continue;
      seen[x] = 1;
      layers[V[x].rank].push(x);
      for (let k = down[x].length - 1; k >= 0; k--) stack.push(down[x][k]);
    }
  };
  for (let v = 0; v < V.length; v++) if (V[v].rank === 0) dfs(v);
  for (let v = 0; v < V.length; v++) dfs(v);

  // 4. Crossing reduction.
  const posIn = new Float64Array(V.length);
  const index = () => layers.forEach((L) => L.forEach((v, i) => (posIn[v] = i)));
  index();
  const sortLayer = (L, nbrs) => {
    const bc = new Map();
    for (const v of L) {
      const ns = nbrs[v];
      bc.set(v, ns.length ? ns.reduce((s, x) => s + posIn[x], 0) / ns.length : posIn[v]);
    }
    L.sort((a, b) => bc.get(a) - bc.get(b) || posIn[a] - posIn[b]);
    L.forEach((v, i) => (posIn[v] = i));
  };
  let best = layers.map((L) => [...L]);
  let bestCross = countCrossings(layers, down, posIn);
  for (let it = 0; it < 16 && bestCross > 0; it++) {
    if (it % 2 === 0) for (let r = 1; r < R; r++) sortLayer(layers[r], up);
    else for (let r = R - 2; r >= 0; r--) sortLayer(layers[r], down);
    const c = countCrossings(layers, down, posIn);
    if (c < bestCross) {
      bestCross = c;
      best = layers.map((L) => [...L]);
    }
  }
  layers = best;
  index();

  // 5. Cross-axis placement.
  const C = new Float64Array(V.length);
  const gap = (a, b) => (V[a].item < 0 || V[b].item < 0 ? o.nodeGap / 2 : o.nodeGap);
  for (const L of layers) {
    let acc = 0;
    L.forEach((v, i) => {
      if (i) acc += gap(L[i - 1], v);
      C[v] = acc + V[v].c / 2;
      acc += V[v].c;
    });
    for (const v of L) C[v] -= acc / 2;
  }
  const placeLayer = (L, nbrs) => {
    const k = L.length;
    const target = new Float64Array(k), weight = new Float64Array(k), off = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      const v = L[i];
      const ns = nbrs(v);
      if (ns.length) {
        target[i] = ns.reduce((s, x) => s + C[x], 0) / ns.length;
        weight[i] = V[v].item < 0 ? 2 : 1;
      } else {
        target[i] = C[v];
        weight[i] = 0.2;
      }
      if (i) off[i] = off[i - 1] + V[L[i - 1]].c / 2 + V[v].c / 2 + gap(L[i - 1], v);
    }
    const z = isotonic(target.map((t, i) => t - off[i]), weight);
    for (let i = 0; i < k; i++) C[L[i]] = z[i] + off[i];
  };
  for (let it = 0; it < 8; it++) {
    for (let r = 1; r < R; r++) placeLayer(layers[r], (v) => up[v]);
    for (let r = R - 2; r >= 0; r--) placeLayer(layers[r], (v) => down[v]);
  }
  for (let r = 0; r < R; r++) placeLayer(layers[r], (v) => [...up[v], ...down[v]]);

  // 6. Main-axis placement: ranks are columns (LR) or rows (TB), nodes centred in them. A gap
  // widens to fit the labels sitting in it: a link's label is halfway along, so in the
  // middle gap it crosses.
  const rankSize = new Float64Array(R);
  for (const v of V) rankSize[v.rank] = Math.max(rankSize[v.rank], v.m);
  const gapSize = new Float64Array(R).fill(o.rankGap);
  for (let u = 0; u < N; u++) {
    for (const v of succ[u]) {
      const r = room.get(u + ':' + v) ?? 0;
      const g = rank[u] + Math.floor((rank[v] - rank[u] - 1) / 2);
      if (r) gapSize[g] = Math.max(gapSize[g], r + 2 * LABEL_MARGIN);
    }
  }
  const rankStart = new Float64Array(R);
  let acc = 0;
  for (let r = 0; r < R; r++) {
    rankStart[r] = acc;
    acc += rankSize[r] + gapSize[r];
  }
  acc -= gapSize[R - 1] - o.rankGap;
  let minC = Infinity, maxC = -Infinity;
  for (let u = 0; u < N; u++) {
    minC = Math.min(minC, C[u] - V[u].c / 2);
    maxC = Math.max(maxC, C[u] + V[u].c / 2);
  }
  const pos = new Map();
  for (let u = 0; u < N; u++) {
    const v = V[u];
    pos.set(comp[u], { m: rankStart[v.rank] + (rankSize[v.rank] - v.m) / 2, c: C[u] - v.c / 2 - minC });
  }
  return { pos, m: acc - o.rankGap, c: maxC - minC };
}

/** Crossings between consecutive layers, O(E log V) with a Fenwick tree. */
function countCrossings(layers, down, posIn) {
  let total = 0;
  for (let r = 0; r < layers.length - 1; r++) {
    const pairs = [];
    for (const u of layers[r]) for (const v of down[u]) pairs.push([posIn[u], posIn[v]]);
    if (pairs.length < 2) continue;
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const size = layers[r + 1].length + 1;
    const tree = new Int32Array(size + 1);
    let inserted = 0;
    for (const [, b] of pairs) {
      let le = 0;
      for (let i = b + 1; i > 0; i -= i & -i) le += tree[i];
      total += inserted - le;
      for (let i = b + 1; i <= size; i += i & -i) tree[i]++;
      inserted++;
    }
  }
  return total;
}

/** Weighted isotonic (non-decreasing) regression via pool-adjacent-violators. */
export function isotonic(y, w) {
  const val = [], wt = [], cnt = [];
  for (let i = 0; i < y.length; i++) {
    val.push(y[i]);
    wt.push(w[i] || 1e-6);
    cnt.push(1);
    while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
      const w2 = wt.pop(), v2 = val.pop(), c2 = cnt.pop();
      const t = val.length - 1;
      const nw = wt[t] + w2;
      val[t] = (val[t] * wt[t] + v2 * w2) / nw;
      wt[t] = nw;
      cnt[t] += c2;
    }
  }
  const out = new Float64Array(y.length);
  let k = 0;
  for (let b = 0; b < val.length; b++) for (let j = 0; j < cnt[b]; j++) out[k++] = val[b];
  return out;
}
