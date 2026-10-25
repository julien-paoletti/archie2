# Archie

A fast architecture-diagram editor that runs entirely in the browser. You model systems as modules, components, services, data stores and the relationships between them.

```sh
npm start      # http://localhost:5173  (zero-dependency static server)
npm test       # engine unit tests (node --test)
```

You can also host it from any static server. It has no build step and no dependencies.

## Highlights

- **Fast, minimal-interaction workflow:**
  - Double-click to create a node; you're typing its name right away.
  - <kbd>Tab</kbd> adds the next connected node.
  - Drag a node's port onto empty space to create a linked node, or click a port to add one in that direction.
  - Drag nodes into or out of modules to nest them. Hold <kbd>Ctrl/⌘</kbd> while dragging to drop a copy instead.
- **Your own vocabulary:** double-click the line under an element's name (or use the inspector) to replace "Component" with "Frontend", "Backend", or anything else. Labels you have already used are suggested.
- **Smart canvas:** magnetic grid, alignment guides, equal-spacing snapping, infinite pan and zoom (mouse, trackpad and pinch), minimap, animated zoom to fit.
- **Automatic layout:** hierarchical and container-aware, animated, and undoable in one step.
- **Edge routing:** orthogonal, obstacle-avoiding (A\*) routing with rounded corners. Ports are spread and shared corridors are split into lanes. Curved and straight routing are also available.
- **Hand-made routes:** drag a link to reshape it (segments on orthogonal links, waypoints on curved and straight ones), slide labels along links, and press <kbd>R</kbd> to reset. A link end you slide along an element's side snaps to the quarter, third and half marks, so you can spread any number of links evenly.
- **Deployment modeling:** Server, Virtual machine and Container start as compact cards. Drop an element onto one and it becomes a box hosting it, so Server → VM → Container → Application takes three drags.
- **Free text:** press <kbd>T</kbd> (or use the dock) to put plain text anywhere: no box, sizes S to Title, alignment and colour. Auto layout leaves it where you put it.
- **Legend:** drop a Legend from the dock: it lists the kinds of elements (by type label), boundaries and links the diagram uses, plus crossing markers and status badges, and keeps itself up to date. It exports with the diagram.
- **Firewalls:** drop a Firewall onto a link (from the dock or by dragging) to put it in the path: A → B becomes A → Firewall → B.
- **Shared networks:** a Network bus element that components attach to from anywhere, even from different modules. Attachments drop straight onto the bus, and <kbd>F</kbd> stretches the bus to span its members.
- **Trust boundaries and network zones:** dashed boundaries that can be nested anywhere (a VPC around modules, a PCI scope inside one). Press <kbd>B</kbd> or <kbd>Shift+B</kbd> to wrap the selection, or <kbd>Alt+B</kbd> / <kbd>Alt+Shift+B</kbd> to draw a border-only outline around it without moving anything. Links crossing a trust boundary are marked at the crossing point, and the inspector lists every crossing.
- **Fit to content:** press <kbd>F</kbd>, or double-click a resize handle, to shrink a module, boundary or host so it wraps its contents with no wasted space (nested ones included).
- **Element details:** description, owner, status (planned and deprecated elements get a badge) and links to docs or repos. Hover an element for a moment to see them; links open from the inspector (web links only).
- **Diagram checks:** the check button in the top bar counts warnings (links crossing a trust boundary without a protocol, elements without links, duplicate names) and suggestions (links without a protocol, default names, empty modules). Click one to jump to it.
- **Dependencies:** press <kbd>D</kbd> (or use the toolbar) and select an element: everything it depends on and everything depending on it stays lit, the rest fades back. Select two elements to see the paths between them.
- **Views:** select a module and press <kbd>O</kbd> to open it as its own view: its contents, plus what they link to outside (faded). It is the same model, so editing there edits the diagram. A breadcrumb shows where you are; <kbd>Esc</kbd> goes up a level.
- **Collapsible modules:** click a module's chevron or press <kbd>C</kbd>. Links re-attach to the collapsed card, and neighbours shift to make room.
- **Editing:** full undo/redo (a whole gesture is one step), copy/paste across tabs, copy and paste style (<kbd>Ctrl/⌘ Alt C</kbd> / <kbd>V</kbd>), grouping, align and distribute, inspector, command palette (<kbd>Ctrl/⌘ K</kbd>), context menus, help sheet (<kbd>?</kbd>).
- **Border width:** any element (cards, modules, boundaries, collapsed modules, networks, legends) can have a thicker border: Auto, 2, 3 or 4 px in the inspector; a thicker card border takes the element’s colour.
- **Polish:** light and dark themes, eased hover and selection states, drop-target highlights, appear and disappear animations, and flow animation on focused links.
- **Text formats:** export to Mermaid, PlantUML, Structurizr DSL or a Markdown catalog of elements and links (with their details). Import Mermaid flowcharts from the menu, or paste one straight onto the canvas: subgraphs become modules, shapes become element kinds.
- **Request flows:** number the links a request goes through (Flows in the inspector, then click links in order; a step can go back along a link as a response), label each step, and play it: <kbd>←</kbd> <kbd>→</kbd> step through while the rest of the diagram fades. Copy a flow as a Mermaid sequence diagram. The sample has a Checkout flow.
- **Share and present:** copy a link that carries the whole diagram (nothing is uploaded), editable or view-only. Press <kbd>P</kbd> to present: the diagram alone, read-only, with dependencies and zoom still at hand. A view-only link opens presenting and never touches the visitor’s own diagram; “Edit a copy” keeps it (theirs stays restorable).
- **Templates:** start from a web application, an event-driven system, a Kubernetes deployment or a system context (menu → New from template…).
- **Files:** in Chrome and Edge, <kbd>Ctrl/⌘ S</kbd> saves back into the file you opened or saved (File System Access API) instead of downloading a new copy; <kbd>Ctrl/⌘ Shift S</kbd> is Save as. A dot next to the title shows unsaved changes, and the file is remembered across reloads. Other browsers download the JSON. Everything also autosaves to `localStorage`, and you can export PNG or SVG.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the engine works.
