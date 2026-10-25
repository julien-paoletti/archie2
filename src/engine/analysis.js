/**
 * Graph queries over the document's links. A link A → B reads "A depends on B" (A uses,
 * calls or sends to B). Containment is not a dependency, but a container stands for
 * everything inside it: the dependencies of a module are those of its contents.
 */

/** The node and everything nested in it. */
function members(doc, id) {
  return [id, ...doc.descendants(id)];
}

/** Breadth-first walk along links (`down`: source → target, else backwards). */
function walk(doc, start, down) {
  const seen = new Set(start);
  const edges = new Set();
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift();
    for (const e of doc.edgesOf(id)) {
      const [from, to] = down ? [e.source, e.target] : [e.target, e.source];
      if (from !== id) continue;
      edges.add(e.id);
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return { nodes: seen, edges };
}

/**
 * What a node depends on (downstream) and what depends on it (upstream), transitively.
 * Returns { nodes, edges, up, down } where `up` / `down` exclude the node's own members.
 */
export function dependencies(doc, id) {
  const own = new Set(members(doc, id));
  const d = walk(doc, own, true), u = walk(doc, own, false);
  const strip = (set) => new Set([...set].filter((n) => !own.has(n)));
  return {
    nodes: new Set([...d.nodes, ...u.nodes]),
    edges: new Set([...d.edges, ...u.edges]),
    up: strip(u.nodes),
    down: strip(d.nodes),
  };
}

/**
 * Nodes and links on any path between two nodes, in either direction. `found` is false when
 * neither reaches the other (then only the two nodes are returned).
 */
export function pathsBetween(doc, a, b) {
  const nodes = new Set([...members(doc, a), ...members(doc, b)]);
  const edges = new Set();
  let found = false;
  for (const [from, to] of [[a, b], [b, a]]) {
    const target = members(doc, to);
    const fwd = walk(doc, members(doc, from), true);
    if (!target.some((n) => fwd.nodes.has(n))) continue;
    found = true;
    // On a path: reachable from `from`, and still leading to `to`.
    const back = walk(doc, target, false);
    for (const n of fwd.nodes) if (back.nodes.has(n)) nodes.add(n);
    for (const id of fwd.edges) if (back.nodes.has(doc.edges.get(id).target)) edges.add(id);
  }
  return { nodes, edges, found };
}
