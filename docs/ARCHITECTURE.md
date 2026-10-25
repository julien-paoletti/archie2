# Archie: editor engine architecture

Archie is a static, dependency-free web app (ES modules, no build step). The code has four layers. Each one only depends on the layers below it; `domain/` (the schema, templates and text formats) sits beside the engine and may use its helpers.

```text
 ui/       DOM chrome: toolbar, dock, inspector, palette, menus, label editor, minimap,
           hover card, checks panel, presentation bar, flow player, breadcrumb, share links
 render/   Canvas 2D renderer: draws the scene, owns visual-only animation state
 editor/   Interaction model: selection, gestures, commands, camera, views, flows (no DOM)
 engine/   Headless core: document, history, spatial index, snapping, routing, layout,
           graph analysis, diagram checks, legend content, input sanitizing
 domain/   The architecture schema (node/edge kinds, icons, colors), starter templates and
           text formats (Mermaid, PlantUML, Structurizr, Markdown). The only domain-aware code
```

`src/main.js` is the app shell: it builds the editor, renderer and UI, and owns files, autosave, sharing, presenting and toasts.

The engine and the editor never touch the DOM. They run in Node, which is why `npm test` exercises them directly. A different renderer (SVG, WebGL) or front-end (React) could replace `render/` and `ui/` without touching the core.

## Engine (`src/engine`)

| Module | Responsibility |
| --- | --- |
| `document.js` | `DiagramDocument`: a tree of nodes (`parent` links) plus edges. All indices (children, adjacency, spatial hash, paint order) are maintained incrementally. |
| `history.js` | Patch-based undo/redo with merge keys and selection restore. |
| `spatial.js` | Uniform-grid spatial hash. Viewport culling, hit testing, snapping candidates and router obstacles all query it. |
| `snapping.js` | Grid, object alignment (edges and centers) and equal-spacing snapping. Also returns guide geometry. |
| `routing.js` | Orthogonal A\* router, plus simple, curved and straight variants and port spreading. |
| `router.js` | `EdgeRouter`: route cache with precise invalidation and a per-frame time budget. |
| `layout.js` | Container-aware layered (Sugiyama-style) auto layout. Gaps between ranks widen to fit link labels. |
| `analysis.js` | Graph queries over links: transitive `dependencies` (up and down) and `pathsBetween` two nodes. |
| `checks.js` | `checkDiagram`: review rules (boundary crossings without protocol, orphans, duplicates, default names…). |
| `legend.js` | What a legend lists (kinds in use) and how tall it is, without measuring text. |
| `schema.js` | Type resolution, boundary and bus helpers, and `sanitizeDiagram` for anything loaded from outside. |

### Data model

```js
node = { id, type, parent, x, y, w, h, label, data: {}, style: {}, z, collapsed?, expanded?: { w, h } }
edge = { id, type, source, target, label, data: {}, style: { routing?, points?, labelT?, color? } }
flow = { id, name, steps: [{ edge, label, reverse? }] }   // a request scenario over links
```

- Element details live in `data`: `description`, `owner`, `status` (`planned` / `deprecated`), `links` (URLs, opened only if http(s): `ui/urls.js`).
- Flows are a third kind in the document (`k: 'flow'` ops), so they undo, save and share like the rest. Removing a link removes its steps in the same transaction.
- `doc.setScope(id)` limits what is shown to a module's contents plus their direct neighbours (`doc.context()`), for module views. It is view state: not undoable, not in the patches.

- Coordinates are absolute world units. Moving a container moves its descendants (`moveBy`).
- `type` is resolved through the schema: default size, whether it's a container, and visuals.
- `data` holds domain fields (`tech`, `description`, `stereotype`). `stereotype` is a free-text type label shown under the name instead of the type ("Backend" rather than "Component"); the caption reads "type label · tech". `style` holds presentation overrides (`color`, `routing`). Both are treated as immutable values: they are replaced, never mutated.
- `edge.data.tech` is a link's protocol, drawn under its label in monospace (the tag is two lines when both are set).
- `edge.style.points` holds a hand-made route: bends for orthogonal links, waypoints for straight and curved ones. `labelT` (0–1) is the label's position along the path.
- A collapsed container keeps its contents, which stay in the tree and still move with it, but hides them. `expanded` remembers the size to restore.
- `doc.hidden()` answers "is this node off screen" (inside a collapsed module, or outside the open view). `doc.visibleAncestor(id)` answers "what stands in for it"; collapsing above an open view doesn't count.

### Transactions and patches

Every mutation runs inside `doc.transact(label, fn, opts)` and is recorded as an invertible op:

```js
{ t: 'add' | 'del', k: 'node' | 'edge', id, v }        // full snapshot
{ t: 'set', k, id, before: {...}, after: {...} }       // changed keys only
```

- Ops are compressed as they're recorded. For example, a `set` that follows an `add` folds into the snapshot, and an `add` followed by a `del` cancels out.
- A failed transaction rolls back.
- On commit the document emits `change` (for views, router and renderer) and `commit` (for history).
- `applyPatch(ops, { inverse })` replays patches. Undo and redo use it, and remote sync or collaboration could use it too.

Options:

- **`merge`:** consecutive commits with the same key collapse into one history entry. A whole drag, a typing session in the inspector, or a burst of arrow nudges each becomes one undo step.
- **`animate`:** a hint for views to tween geometry changes. Layout, align and undo/redo use it.
- **`history: false`:** don't record the change. Used for loading samples or generated content.

### Edge routing

`routeOrthogonal` builds a sparse *orthogonal visibility grid* from:

- obstacle boundaries, inflated by a clearance margin;
- the port exit points;
- channel midlines between the source and target.

It then runs A\* over `(grid point, heading)` states with a bend penalty:

- **Ports:** all four sides of the source and target are candidates, so the router picks the best sides itself.
- **Grid checks:** segment validity is memoized, and the grid is exact (a segment either crosses an obstacle's interior or it doesn't).
- **Obstacles:** nodes near the edge, excluding the endpoints and their ancestors. An edge may leave its own module, but goes around others.
- **Fallback:** a two-bend route.

`EdgeRouter` caches routes and invalidates them precisely:

- An edge is re-routed when an endpoint changes.
- An edge is also re-routed when a node moves into or out of the area its route covers.
- Full routing is budgeted per frame. Over budget, a cheap route is drawn and refined on the next frame.
- During a drag (`live` mode), only edges attached to moving nodes re-route. Other affected routes are refreshed when the gesture ends.

The router also handles three more cases:

- **Hand-made routes** (`routeManual`):
  - Orthogonal links pass through stored bends. The ends slide along the node sides to stay aligned with the first and last bend, and an elbow is added when they can't.
  - Straight links are polylines through the waypoints; curved links are Catmull-Rom splines through them.
  - Manual routes skip obstacle avoidance and the display pass.
- **Collapsed modules:** an end inside a collapsed module attaches to the module (a proxy). Hidden nodes are never obstacles. Collapsing or expanding clears the cache.
- **Display pass** (`router.spread`, run on the routes on screen):
  - `spreadPorts` fans out edge ends that share a node side, ordered by where each edge heads, so no crossings are added.
  - `separateSegments` puts collinear, overlapping segments of different links (a shared corridor) into parallel lanes. Links heading lower take the lower lanes.
  - Both passes only shift segments perpendicular to themselves, so routes stay orthogonal.

### Auto layout

`layoutHierarchy` works bottom-up through containers:

1. A container's children are laid out first, which gives the container its size.
2. The container is then treated as a single node one level up.
3. Edges between nested nodes are lifted to the ancestors that are siblings at the current level.

Each level goes through these steps:

1. Split into connected components.
2. Break cycles with a DFS.
3. Rank by longest path.
4. Add dummy nodes on long edges.
5. Reduce crossings with barycentric sweeps, counting crossings with a Fenwick tree and keeping the best ordering.
6. Place nodes on the cross axis with weighted isotonic regression (pool-adjacent-violators). This pulls nodes towards their neighbours while keeping order and spacing exact.

Unconnected siblings stack like a rank. Directions are `LR` and `TB`. On a 2,000-node, 20-module stress diagram, layout takes about 40 ms.

## Editor (`src/editor`)

`Editor` composes the document, history, router and camera, and implements every user-level action. Input arrives as normalized events, `{ x, y, button, shift, alt, mod, pointerType }`, in canvas-relative pixels.

- **Hit testing priority:**
  1. Resize handles, then hovered-node ports, then resize borders.
  2. For a selected link: its endpoints, then its route grips.
  3. Leaf nodes, then module collapse toggles.
  4. Link labels and link bodies (reporting the segment that was hit).
  5. Containers.
- **Gestures** (`gestures.js`): a small state machine. Each gesture is one undo step; Esc cancels it and reverts.
  - `Pan` and `Marquee`.
  - `Drag`: snapping (Alt frees it), axis lock (Shift), drop-to-nest, and Ctrl/⌘ to drag a copy. Pressing or releasing Ctrl mid-drag switches between moving and copying. Hand-made routes between moved nodes travel with them.
  - `Resize`: edge-aware snapping, aspect lock, min size, contains children.
  - `Connect` (drop on empty space to create a linked node) and `Reconnect`.
  - `Segment`: drag an orthogonal link's segment sideways.
  - `Waypoint`: insert or move a waypoint on a straight or curved link.
  - `Label`: slide a link label along its path, magnetic at the middle.
- **Fit to content** (`fitToContent`) resizes containers to their children's bounds plus the standard padding, deepest first, in one animated undo step. Double-clicking a resize handle triggers it.
- **Collapse/expand** behaves like an accordion: siblings entirely to the right or below shift by the size change, so expanding never overlaps neighbours. Auto layout treats a collapsed module as one node and leaves its contents alone.
- **Commands** (`commands.js`): one registry drives keyboard shortcuts, the command palette, menus and the help sheet. Digits map by physical key (`code`) and letters by character (`key`), so shortcuts work on AZERTY and other layouts.
- **Camera** (`camera.js`): an infinite canvas. Animated transitions interpolate zoom in log space. `insets` keep "fit" framing clear of floating panels.
- **Modes and views** (view state, never in the document's history). Each lives in its own module with its own state (`focus.js`, `views.js`, `flows.js`); `Editor` delegates to them, so callers use `editor.openView(...)`, `editor.flow`, `editor.focusDeps`:
  - **Dependency focus** (`focusDeps`, <kbd>D</kbd>): `dependencyFocus()` returns the nodes and links to keep lit for the selection; the renderer fades the rest.
  - **Flows** (`flow = { id, step, recording }`): recording turns link clicks into steps; playing (`step ≥ 0`) highlights one step, `flowFocus()` lights the flow, arrows step through.
  - **Module views** (`openView`, `viewUp`, `viewPath`): set the document scope. New or dropped things outside every box go into the view's module (`containerAt` falls back to it); context nodes are never re-parented.
  - **Read-only** (`setReadOnly`, presenting and view-only links): drags pan, and only commands of the View group or flagged `readOnly` run (`allowed(cmd)`). The document is locked too (`doc.locked`): it refuses any transaction not flagged `force` (collapsing, legend sizing), whatever path tries.
  - `escape()` steps back one level through all of these: selection, flow, focus, view, then emits `escape` for the app.
- **Events** the UI listens to: `invalidate`, `selectionchange`, `docchange`, `history`, `hover`, `gesture`, `camera`, `cursor`, `tool`, `settings`, `edit-label`, `edit-end`, `commit-edit`, `contextmenu`, `layout`, `notice` (a toast), `dependencies` (the focus mode toggled), `flow`, `view`, `escape`.

## Renderer (`src/render`)

`CanvasRenderer` draws on demand. Frames are scheduled only when something changed, and keep running only while an animation is in flight.

- **Culling:** the spatial index returns visible nodes. Edges are filtered by their endpoints' bounds.
- **Level of detail:** blocks only below 20% zoom, labels below 45%, and full cards with icons, captions and shadows above that. Module headers scale up when zoomed out so the overview stays readable.
- **Animation:** hover, selection, drop-target, lift and port states are eased with frame-rate-independent smoothing.
  - Geometry changes flagged `animate` (layout, align, undo) tween from the old rect.
  - Edges attached to tweening nodes use cheap routes for the duration.
  - New items scale in; deleted ones fade out as ghosts.
  - Focused edges show animated "flow" dots in their direction.
- **Grid:** a GPU-composited SVG pattern behind the canvas, adapting by powers of 5. It costs nothing in the canvas frame.
- **Overview batching:** below 20% zoom, all links go into one path and nodes are filled in one batch per color.
- **Collapsed modules:** drawn as stacked cards with an item count. Links proxied to the same pair of visible nodes are drawn once, labelled "N links".
- **Link tags** (label over protocol) are placed by `#placeTags`: each slides along its link to a spot clear of other tags and of element cards (most constrained first, then two repair passes). Places are kept while the document doesn't change, so panning only places links coming into view.
- **Fading:** the dependency focus and a playing flow fade what they leave out; context nodes of a module view are drawn at half strength.
- **Overlays:** flow step badges and the current step's callout, quarter/third marks while sliding a link end, legends (content from `engine/legend.js`, cached per document version), status badges.
- **Export:** `exportPNG()` and `exportSVG()` reuse the same scene drawing, without selection or hover decorations.
  - With a selection, every export covers just that: `editor.exportScope()` gives the selected elements with their contents, selected links with their ends, and the links among them. The renderer draws only those (`only`), and text formats read `editor.exportDocument()`, a scratch copy holding them. With nothing selected, exports cover everything shown.
  - SVG goes through `SVGContext` (`svg-context.js`), a recording, Canvas2D-compatible context that emits paths, text and drop-shadow filters.
  - So the vector output matches the screen, and there is no second drawing implementation to keep in sync.

## Domain schema (`src/domain/architecture.js`)

```js
{
  groupType: 'module', defaultNodeType: 'component', defaultEdgeType: 'uses',
  nodeTypes: { module: { label, container: true, w, h, color, icon, shortcut }, database: { shape: 'cylinder', ... }, ... },
  edgeTypes: { uses: { arrow: 'open' }, async: { arrow: 'filled', dash: [7, 5] }, ... },
  retiredTypes: { client: 'application' },
}
```

`retiredTypes` maps a removed type to the one that replaces it, so `sanitizeDiagram` loads old diagrams without falling back to the default type.

Types can declare `variants`, selected by `node.data.variant` (default: `defaultVariant`). `resolveType(schema, node)` in `engine/schema.js` merges a variant's label, color and icon over its type.

The `boundary` type uses this for trust boundaries and network zones:

- It is a container with `boundary: true` and `shape: 'boundary'`, drawn as a dashed outline with a name tab on the border.
- `boundariesCrossed(doc, edge)` returns the boundaries holding exactly one end of a link. It works through any nesting: boundaries in modules, modules in boundaries, boundaries in boundaries.
- Variants with `markCrossings` (trust boundaries) get a marker where links cross their border.
- The inspector lists the boundaries a link crosses and the links crossing a boundary.
- "Wrap in …" commands are generated per variant: <kbd>B</kbd> wraps in the first variant and <kbd>Shift+B</kbd> in the second.

Shapes: `card` (default), `cylinder`, `note`, `actor`, `document` (a wave along the bottom, swinging around the box's bottom edge so links meet it) and `boundary`.

Two more schema flags:

- **`host: true`** (Server, Virtual machine, Container): the type is a container, but `showsAsCard(doc, node)` keeps it drawn and handled as a plain card while it is empty and card-sized.
  - Dropping or creating something on it calls `editor.adoptIntoHost`. That lines the content up inside, grows the host into a box, and shifts neighbours (the same accordion as collapse/expand).
  - The result is that deployment nesting (Server → VM → Container → Application) takes one drag per level.
- **`dock`:** groups types into sections of the shape dock.
- **`annotation` / `noPorts`** (Text): annotations are skipped by auto layout and routing obstacles, and `noPorts` hides link handles. Free text (`shape: 'text'`) auto-sizes through `layoutProbe.measureText`: width follows the longest line until the user sets one (`style.autoWidth: false`), and height always follows the content. Emptied text is removed.
- **`inline: true`** (Firewall): dropping such a node on a link, as a new node or by dragging it while it has no links, calls `insertIntoEdge`. The node is centred on the line, and the link is split around it with label, type and protocol kept.
- **`shape: 'bus'`** (Network): a bar that members attach to.
  - Links touching a bus use the type's `linkType` (`attachment`) and are routed by `routeToBus` as a straight drop perpendicular to the bar, entering at an end if the member lies beyond it.
  - Membership is by link (`busMembers`), so it works across any containment. Fit to content stretches the bus to its members.
  - `spawn` sets what growing from it creates.

**Border-only boundaries** (`data.borderOnly`) surround without containing:

- `doc.isContainer` is false for them, so they have no children, are never drop targets and are ignored as routing obstacles.
- Their membership is geometric: `editor.surrounded(id)`, and crossings in `boundariesCrossed`.
- They are hit only on their tab or outline.
- They are drawn in two passes: the outline under the leaves, the tab above them.
- Auto layout skips them and then re-wraps whatever they surrounded before.
- `outlineSelection` creates one around the selection without re-parenting anything. `dashed` gives external systems a dashed border. Adding a kind is a schema entry. Kinds with a `shortcut` automatically get a keyboard shortcut, a command and a dock entry.

## Templates and text formats (`src/domain`)

- `templates.js`: starter models without positions, laid out on open.
- `formats/`: one pure module per format, sharing identifier and escaping helpers (`shared.js`).
  - `mermaid.js`: flowchart export and import (`fromMermaid` returns a model; `Editor.importModel` lays it out and inserts it as one undo step).
  - `plantuml.js`, `structurizr.js` (C4 mapping), `markdown.js` (element and link catalog), `sequence.js` (a flow as a sequence diagram).

## Input from outside

Diagrams arrive from files, share links (`#d=` / `#v=`, deflate + base64url in the URL fragment: `ui/share.js`, nothing is uploaded), the clipboard and storage. Everything goes through `sanitizeDiagram` before `load`: shape checks, bounded sizes and text, unknown kinds mapped to defaults, missing parents and parent cycles repaired, dangling links and steps dropped. Decoding a link caps the inflated size. Text is only ever drawn on the canvas or set as DOM text; links open only if http(s).

## Performance notes

- With 2,000 nodes and 2,000 edges, a frame takes about 1.3 ms at 60% zoom and about 2.5 ms fully zoomed out (headless Chrome, software rendering).
- Hover and selection checks are O(1) per item. Edge hit testing is bounding-box filtered and only looks at routes already drawn.
- Document indices update incrementally. Nothing in the hot path is O(n²).

## Roadmap

- Views with their own layout of shared elements (today a module view shows elements where they are in the overview), and C4 level filters.
- Global lane assignment, so corridor separation also minimizes crossings between bundles.
- Collaboration: the op format is already invertible and serializable. Add ids per client and a server relay or CRDT for ordering.
- Use a Web Worker for routing and layout on very large models (the engine is DOM-free already).
