import { Editor } from './editor/editor.js';
import { CanvasRenderer } from './render/canvas-renderer.js';
import { themes } from './render/theme.js';
import { Emitter } from './engine/emitter.js';
import { center, overlaps } from './engine/geometry.js';
import { architectureSchema, icons, palette, sampleDiagram } from './domain/architecture.js';
import { bindInput } from './ui/input.js';
import { createGrid } from './ui/grid.js';
import { createLabelEditor } from './ui/label-editor.js';
import { createDock, createHints, createMinimap, createPresentBar, createToaster, createTopBar, createViewControls } from './ui/chrome.js';
import { createInspector, createSelectionBar } from './ui/inspector.js';
import { createHoverCard } from './ui/hovercard.js';
import { createChecks } from './ui/checks.js';
import { createCommandPalette, createContextMenu, createHelp, createImportDialog, createTemplatePicker } from './ui/overlays.js';
import { templates } from './domain/templates.js';
import { extractMermaid, fromMermaid, looksLikeMermaid, toMermaid } from './domain/formats/mermaid.js';
import { toPlantUML } from './domain/formats/plantuml.js';
import { toStructurizr } from './domain/formats/structurizr.js';
import { toMarkdown } from './domain/formats/markdown.js';
import { isEditable } from './ui/dom.js';
import * as files from './ui/files.js';
import { decodeDiagram, encodeDiagram, parseShareHash } from './ui/share.js';
import { sanitizeDiagram } from './engine/schema.js';

const TEXT_FORMATS = {
  mermaid: { name: 'Mermaid', ext: 'mmd', build: toMermaid },
  plantuml: { name: 'PlantUML', ext: 'puml', build: toPlantUML },
  structurizr: { name: 'Structurizr DSL', ext: 'dsl', build: toStructurizr },
  markdown: { name: 'Markdown', ext: 'md', build: toMarkdown },
};

const DOC_KEY = 'archie:document';
const PREFS_KEY = 'archie:prefs';
const SETTING_KEYS = ['snapToGrid', 'snapToObjects', 'showGrid', 'layoutDirection'];

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: the diagram still works, it just won't persist.
  }
};

const prefs = read(PREFS_KEY) ?? {};
const stage = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const root = document.getElementById('ui');

const editor = new Editor({
  schema: architectureSchema,
  settings: Object.fromEntries(SETTING_KEYS.filter((k) => k in (prefs.settings ?? {})).map((k) => [k, prefs.settings[k]])),
});

/** Application shell state (theme, panels, file I/O). The editor itself stays UI-agnostic. */
class App extends Emitter {
  title = 'Untitled architecture';
  theme = prefs.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  inspectorOpen = prefs.inspectorOpen ?? innerWidth > 1100;
  minimapOpen = prefs.minimapOpen ?? true;
  /** The file this diagram is bound to (File System Access API), and whether it has unsaved changes. */
  fileHandle = null;
  fileDirty = false;
  /** Presenting: read-only, chrome hidden. A view-only link presents and never autosaves. */
  presenting = false;
  viewOnly = false;

  get colors() { return themes[this.theme]; }
  get fileName() { return this.fileHandle?.name ?? null; }
  get canSaveInPlace() { return files.supported; }

  bindFile(handle, { dirty = false } = {}) {
    this.fileHandle = handle;
    this.fileDirty = !!handle && dirty;
    files.rememberHandle(handle);
    this.emit('file');
    scheduleSave();
  }

  markDirty() {
    if (!this.fileHandle || this.fileDirty) return;
    this.fileDirty = true;
    this.emit('file');
  }

  savePrefs() {
    write(PREFS_KEY, {
      theme: this.theme, inspectorOpen: this.inspectorOpen, minimapOpen: this.minimapOpen,
      settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, editor.settings[k]])),
    });
  }

  setTitle(t, { edit = true } = {}) {
    this.title = t;
    this.emit('title', t);
    document.title = `${t || 'Untitled'} — Archie`;
    if (edit) this.markDirty();
    scheduleSave();
  }

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    this.savePrefs();
    this.emit('change');
  }

  toggleInspector() {
    this.inspectorOpen = !this.inspectorOpen;
    this.savePrefs();
    this.emit('change');
  }

  toggleMinimap() {
    this.minimapOpen = !this.minimapOpen;
    this.savePrefs();
    this.emit('change');
  }

  /** Add a node from the dock: view center, nudged to the nearest free spot. */
  addNode(type) {
    const t = architectureSchema.nodeTypes[type];
    const c = center(editor.visibleRect());
    const spots = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) spots.push([i, j]);
    spots.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
    let at = c;
    for (const [i, j] of spots) {
      const p = { x: c.x + i * (t.w + 40), y: c.y + j * (t.h + 40) };
      const r = { x: p.x - t.w / 2 - 12, y: p.y - t.h / 2 - 12, w: t.w + 24, h: t.h + 24 };
      const busy = editor.doc.index.query(r).some((id) => !editor.doc.isContainer(id) && overlaps(r, editor.doc.nodes.get(id)));
      if (!busy) {
        at = p;
        break;
      }
    }
    editor.createNode(type, at, { edit: true });
  }

  newDiagram() {
    const json = editor.toJSON();
    editor.load({ nodes: [] }, { fit: false });
    editor.camera.set({ x: -editor.camera.size.w / 2, y: -editor.camera.size.h / 2, zoom: 1 });
    this.setTitle('Untitled architecture', { edit: false });
    this.bindFile(null);
    if (json.nodes.length) toast('New diagram', { action: { label: 'Restore', run: () => restore(json) }, timeout: 6000, icon: 'file' });
  }

  loadSample() {
    this.#openModel(sampleDiagram(), 'E-commerce platform');
  }

  /** Start from a template; the diagram it replaces can be restored from the toast. */
  newFromTemplate(id) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const json = editor.toJSON();
    const title = this.title;
    this.#openModel(t.build(), t.title);
    if (json.nodes.length) toast(`New ${t.title.toLowerCase()}`, { action: { label: 'Restore', run: () => restore({ ...json, title }) }, timeout: 6000, icon: 'file' });
  }

  /** Load a model without positions: lay it out, frame it, unbind the file. */
  #openModel(model, title) {
    editor.load(model, { fit: false });
    editor.autoLayout({ history: false, animate: false, fit: false });
    editor.fitView({ animate: false });
    this.setTitle(title, { edit: false });
    this.bindFile(null);
  }

  stressTest() {
    const nodes = [], edges = [];
    const kinds = ['component', 'service', 'database', 'queue'];
    const t0 = performance.now();
    for (let m = 0; m < 20; m++) {
      nodes.push({ id: `m${m}`, type: 'module', label: `Domain ${m + 1}` });
      for (let i = 0; i < 99; i++) {
        const type = kinds[i % 4];
        nodes.push({ id: `m${m}n${i}`, type, parent: `m${m}`, label: `${architectureSchema.nodeTypes[type].label} ${m + 1}.${i + 1}` });
        if (i > 0) edges.push({ source: `m${m}n${Math.floor(Math.random() * i)}`, target: `m${m}n${i}` });
      }
    }
    for (let k = 0; k < 40; k++) {
      const a = Math.floor(Math.random() * 20), b = (a + 1 + Math.floor(Math.random() * 3)) % 20;
      edges.push({ source: `m${a}n${Math.floor(Math.random() * 99)}`, target: `m${b}n${Math.floor(Math.random() * 99)}`, type: 'async' });
    }
    editor.load({ nodes, edges }, { fit: false });
    editor.autoLayout({ history: false, animate: false, fit: false });
    editor.fitView({ animate: false });
    this.setTitle('Stress test', { edit: false });
    this.bindFile(null);
    toast(`${nodes.length.toLocaleString()} nodes, ${edges.length.toLocaleString()} links laid out in ${Math.round(performance.now() - t0)} ms`, { icon: 'zap' });
  }

  #serialize() {
    return JSON.stringify({ title: this.title, ...editor.toJSON() }, null, 2);
  }

  #download() {
    download(new Blob([this.#serialize()], { type: 'application/json' }), `${slug(this.title)}.archie.json`);
  }

  /** Save: write back into the current file; the first time (or without the API) ask / download. */
  async save() {
    if (!files.supported) return this.#download();
    if (!this.fileHandle) return this.saveAs();
    try {
      await files.writeFile(this.fileHandle, this.#serialize());
      this.fileDirty = false;
      this.emit('file');
      scheduleSave();
      toast(`Saved to ${this.fileName}`, { icon: 'download', timeout: 2200 });
    } catch (err) {
      toast(`Could not save to ${this.fileName}: ${err.message}`, {
        icon: 'x', timeout: 7000, action: { label: 'Save as…', run: () => this.saveAs() },
      });
    }
  }

  /** Save as: pick a new file, which becomes the current one. */
  async saveAs() {
    if (!files.supported) return this.#download();
    try {
      const handle = await files.pickSave(this.fileName ?? `${slug(this.title)}.archie.json`, this.fileHandle ?? undefined);
      if (!handle) return;
      this.bindFile(handle);
      await this.save();
    } catch (err) {
      toast(`Could not save: ${err.message}`, { icon: 'x', timeout: 5000 });
    }
  }

  async openFile() {
    if (!files.supported) {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
      input.onchange = () => input.files[0] && openJSONFile(input.files[0]);
      input.click();
      return;
    }
    try {
      const handle = await files.pickOpen(this.fileHandle ?? undefined);
      if (handle) await openJSONFile(await handle.getFile(), handle);
    } catch (err) {
      toast(`Could not open the file: ${err.message}`, { icon: 'x', timeout: 5000 });
    }
  }

  async exportPNG() {
    const blob = await renderer.exportPNG({ scale: 2 });
    if (blob) download(blob, `${slug(this.title)}.png`);
    else toast('Nothing to export yet', { icon: 'image' });
  }

  exportSVG() {
    const svg = renderer.exportSVG();
    if (svg) download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(this.title)}.svg`);
    else toast('Nothing to export yet', { icon: 'image' });
  }

  /** The diagram as text: 'mermaid' | 'plantuml' | 'structurizr' | 'markdown'. */
  textOf(format) {
    const opts = { title: this.title, direction: editor.settings.layoutDirection };
    return TEXT_FORMATS[format].build(editor.doc, opts);
  }

  exportText(format) {
    if (!editor.doc.nodes.size) return toast('Nothing to export yet', { icon: 'file' });
    const f = TEXT_FORMATS[format];
    download(new Blob([this.textOf(format)], { type: 'text/plain' }), `${slug(this.title)}.${f.ext}`);
  }

  async copyText(format) {
    try {
      await navigator.clipboard.writeText(this.textOf(format));
      toast(`Copied as ${TEXT_FORMATS[format].name}`, { icon: 'copy' });
    } catch (err) {
      toast(`Could not copy: ${err.message}`, { icon: 'x', timeout: 5000 });
    }
  }

  /** Mermaid flowchart text → elements: added to this diagram, or opened as a new one. */
  importMermaid(text, { replace = false } = {}) {
    const model = fromMermaid(text);
    if (!model.nodes.length) throw new Error('No elements in that flowchart');
    if (replace) {
      const json = editor.toJSON(), title = this.title;
      this.#openModel(model, 'Imported diagram');
      if (json.nodes.length) toast('Imported as a new diagram', { action: { label: 'Restore', run: () => restore({ ...json, title }) }, timeout: 6000, icon: 'upload' });
    } else {
      const top = editor.importModel(model);
      toast(`Imported ${plural(model.nodes.length, 'element')} and ${plural(model.edges.length, 'link')}`, { icon: 'upload', action: { label: 'Undo', run: () => editor.undo() } });
      return top;
    }
  }

  openImport() { importDialog.open(); }

  /** Present: the diagram alone, read-only, framed. A view-only link can't leave it (Edit a copy instead). */
  present(on = !this.presenting) {
    if (on === this.presenting || (!on && this.viewOnly)) return;
    this.presenting = on;
    editor.setReadOnly(on);
    document.documentElement.classList.toggle('presenting', on);
    this.emit('change');
    editor.setSelection([]);
    editor.fitView();
  }

  /** From a view-only link: keep the diagram as your own, editable (your previous one can be restored). */
  editCopy() {
    this.viewOnly = false;
    history.replaceState(null, '', location.pathname + location.search);
    this.present(false);
    keepAsOwn('Now editing your copy');
  }

  /** Copy a link that carries the whole diagram (`view`: opens read-only, presenting). */
  async shareLink(mode = 'edit') {
    if (!editor.doc.nodes.size) return toast('Nothing to share yet', { icon: 'link' });
    try {
      const code = await encodeDiagram({ title: this.title, ...editor.toJSON() });
      const url = `${location.origin}${location.pathname}#${mode === 'view' ? 'v' : 'd'}=${code}`;
      if (url.length > 1_500_000) throw new Error('the diagram is too large for a link; save it as a file instead');
      await navigator.clipboard.writeText(url);
      const size = url.length < 10_000 ? `${url.length.toLocaleString()} characters` : `${Math.round(url.length / 1024)} KB`;
      toast(`${mode === 'view' ? 'View-only link' : 'Link'} copied (${size}). The diagram travels in the link; nothing is uploaded.`, { icon: 'link', timeout: 5000 });
    } catch (err) {
      toast(`Could not copy the link: ${err.message}`, { icon: 'x', timeout: 6000 });
    }
  }

  openTemplates() { templatePicker.open(); }
  openPalette() { palette_.open(); }
  openHelp() { help.open(); }
}

const app = new App();
const renderer = new CanvasRenderer(editor, canvas, { theme: themes[app.theme], icons });

function applyTheme() {
  document.documentElement.dataset.theme = app.theme;
  renderer.setTheme(themes[app.theme]);
}
applyTheme();

// Keep fit/zoom-to framing clear of the floating panels (presenting hides most of them).
const updateInsets = () => {
  editor.camera.insets = app.presenting
    ? { top: 72, left: 24, right: 24, bottom: 24 }
    : { top: 64, left: 64, right: app.inspectorOpen && innerWidth > 700 ? 312 : 0, bottom: 52 };
};
app.on('change', updateInsets);
updateInsets();

const resize = () => {
  const r = stage.getBoundingClientRect();
  renderer.resize(r.width, r.height);
};
new ResizeObserver(resize).observe(stage);
resize();

bindInput(editor, canvas);
createGrid(editor, stage);
createLabelEditor(editor, stage);
createTopBar(editor, app, root, { extras: [createChecks(editor)] });
createPresentBar(editor, app, root);
createDock(editor, app, root, icons);
createMinimap(editor, createViewControls(editor, app, root), app);
createHints(editor, root);
createInspector(editor, app, root, { icons, palette });
createSelectionBar(editor, app, root, { palette });
createHoverCard(editor, root, { icons });
createContextMenu(editor, app, { icons });
const toast = createToaster(root);
const palette_ = createCommandPalette(editor, app, { icons });
const help = createHelp(editor);
const templatePicker = createTemplatePicker(app, { icons, templates });
const importDialog = createImportDialog(app, { extract: extractMermaid });

const appCommands = [
  { id: 'app.palette', title: 'Command palette', group: 'View', keys: ['mod+k', '/'], run: () => app.openPalette() },
  { id: 'app.help', title: 'Keyboard shortcuts', group: 'View', keys: ['shift+?', '?'], run: () => app.openHelp() },
  { id: 'app.theme', title: 'Toggle dark mode', group: 'View', keys: ['shift+t'], run: () => app.toggleTheme() },
  { id: 'app.inspector', title: 'Toggle inspector', group: 'View', keys: ['i'], run: () => app.toggleInspector() },
  { id: 'app.minimap', title: 'Toggle minimap', group: 'View', keys: ['m'], run: () => app.toggleMinimap() },
  { id: 'file.new', title: 'New diagram', group: 'File', run: () => app.newDiagram() },
  { id: 'file.template', title: 'New from template…', group: 'File', run: () => app.openTemplates() },
  { id: 'file.open', title: 'Open…', group: 'File', keys: ['mod+o'], run: () => app.openFile() },
  { id: 'file.save', title: 'Save', group: 'File', keys: ['mod+s'], run: () => app.save() },
  { id: 'file.saveAs', title: 'Save as…', group: 'File', keys: ['mod+shift+s'], run: () => app.saveAs() },
  // `readOnly: true`: also available while presenting or viewing a shared diagram.
  { id: 'file.png', title: 'Export PNG', group: 'File', keys: ['mod+shift+e'], readOnly: true, run: () => app.exportPNG() },
  { id: 'file.svg', title: 'Export SVG', group: 'File', readOnly: true, run: () => app.exportSVG() },
  ...Object.entries(TEXT_FORMATS).map(([k, f]) => ({ id: 'file.' + k, title: `Export ${f.name}`, group: 'File', readOnly: true, run: () => app.exportText(k) })),
  { id: 'file.copyMermaid', title: 'Copy as Mermaid', group: 'File', readOnly: true, run: () => app.copyText('mermaid') },
  { id: 'file.share', title: 'Copy link to this diagram', group: 'File', run: () => app.shareLink('edit') },
  { id: 'file.shareView', title: 'Copy view-only link', group: 'File', readOnly: true, run: () => app.shareLink('view') },
  { id: 'view.present', title: 'Present (read-only)', group: 'View', keys: ['p'], run: () => app.present() },
  { id: 'file.import', title: 'Import from Mermaid…', group: 'File', run: () => app.openImport() },
  { id: 'file.sample', title: 'Load sample architecture', group: 'File', run: () => app.loadSample() },
  { id: 'debug.stress', title: 'Stress test: 2,000 nodes', group: 'File', run: () => app.stressTest() },
];
appCommands.forEach((c) => editor.registerCommand(c));

editor.on('layout', () => toast('Auto layout applied', { icon: 'layout', action: { label: 'Undo', run: () => editor.undo() } }));
editor.on('settings', () => app.savePrefs());
editor.on('notice', ({ message, icon }) => toast(message, { icon }));
// Esc with nothing left to undo (no selection, no focus): leave the presentation.
editor.on('escape', () => app.present(false));

// ── Clipboard: native events so copy/paste also works across tabs and windows.
document.addEventListener('copy', (e) => {
  if (isEditable(e.target)) return;
  const clip = editor.copy();
  if (!clip) return;
  e.clipboardData.setData('text/plain', JSON.stringify(clip));
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (isEditable(e.target) || editor.readOnly) return;
  const clip = editor.cut();
  if (!clip) return;
  e.clipboardData.setData('text/plain', JSON.stringify(clip));
  e.preventDefault();
});
document.addEventListener('paste', (e) => {
  if (isEditable(e.target) || editor.readOnly) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  // Mermaid flowchart text (or Markdown holding one): import it as elements.
  const mermaid = looksLikeMermaid(text) ? extractMermaid(text) : null;
  if (mermaid) {
    try {
      app.importMermaid(mermaid);
    } catch (err) {
      toast(`Could not import that Mermaid: ${err.message}`, { icon: 'x', timeout: 6000 });
    }
    return;
  }
  let clip = null;
  try {
    const data = JSON.parse(text);
    if (data?.format === 'archie-clip') clip = data;
  } catch {
    // Not ours: fall back to the in-app clipboard.
  }
  if (clip) editor.clipboard = editor.clipboard ?? clip;
  editor.paste(clip ?? editor.clipboard);
});

// ── Drag & drop: shapes from the dock, JSON files from the desktop.
stage.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].some((t) => t === 'application/x-archie-type' || t === 'Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  if (editor.readOnly) return;
  const type = e.dataTransfer.getData('application/x-archie-type');
  const r = stage.getBoundingClientRect();
  const at = editor.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  if (type) {
    editor.createNode(type, at, { edit: true });
    return;
  }
  // Chromium hands out a file handle for dropped files: Save then writes back to that file.
  const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
  const pending = files.supported && item?.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
  const file = e.dataTransfer.files[0];
  if (!file) return;
  Promise.resolve(pending).catch(() => null).then((handle) => openJSONFile(file, handle?.kind === 'file' ? handle : null));
});

// ── Persistence: autosave the document and the view (never a diagram only being viewed).
let saveTimer = 0;
function scheduleSave() {
  if (app.viewOnly) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { x, y, zoom } = editor.camera;
    write(DOC_KEY, { title: app.title, camera: { x, y, zoom }, fileDirty: app.fileDirty, ...editor.toJSON() });
  }, 400);
}
editor.on('docchange', (e) => {
  if (!e.reset) app.markDirty();
  scheduleSave();
});
editor.on('camera', scheduleSave);

/** Load diagram JSON from anywhere (storage, file, link): sanitized first, so it can't break the app. */
function restore(raw) {
  const json = sanitizeDiagram(raw, architectureSchema);
  editor.load(json, { fit: !json.camera });
  if (json.camera) editor.camera.set(json.camera);
  app.setTitle(json.title ?? 'Untitled architecture', { edit: false });
}

/**
 * The diagram on screen (from a link) replaces the one kept in this browser: keep the
 * previous one restorable from the toast.
 */
function keepAsOwn(message) {
  const previous = read(DOC_KEY);
  app.bindFile(null);
  scheduleSave();
  if (previous?.nodes?.length) {
    toast(message, { icon: 'link', timeout: 8000, action: { label: 'Restore yours', run: () => restore(previous) } });
  } else {
    toast(message, { icon: 'link' });
  }
}

/** Open a diagram file; with a handle (native picker or drop), Save writes back to it. */
async function openJSONFile(file, handle = null) {
  try {
    const json = JSON.parse(await file.text());
    restore({ ...json, camera: null, title: json.title ?? file.name.replace(/\.(archie\.)?json$/, '') });
    app.bindFile(handle);
    toast(`Opened ${file.name}`, { icon: 'upload' });
    return true;
  } catch (err) {
    toast(`Could not open ${file.name}: ${err.message}`, { icon: 'x', timeout: 5000 });
    return false;
  }
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function slug(s) {
  return (s || 'diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagram';
}

/** The diagram kept in this browser, else the sample. */
function openSaved() {
  const saved = read(DOC_KEY);
  try {
    if (!saved?.nodes?.length) throw new Error('nothing saved');
    restore(saved);
    // Re-bind the file this diagram was saved to (permission is asked again on the next Save).
    if (files.supported) files.recallHandle().then((h) => h && app.bindFile(h, { dirty: !!saved.fileDirty }));
  } catch {
    app.loadSample();
  }
}

/** A diagram in the link (#d= editable copy, #v= view only), else the saved one. */
async function start() {
  const shared = parseShareHash(location.hash);
  if (!shared) return openSaved();
  await openShared(shared);
}

async function openShared(shared) {
  try {
    const json = await decodeDiagram(shared.data);
    if (shared.mode === 'view') {
      app.viewOnly = true;
      restore({ ...json, camera: null });
      app.present(true);
    } else {
      restore({ ...json, camera: null });
      history.replaceState(null, '', location.pathname + location.search);
      keepAsOwn('Opened the shared diagram');
    }
  } catch (err) {
    app.viewOnly = false;
    app.present(false);
    openSaved();
    toast(`Could not open the shared link: ${err.message}`, { icon: 'x', timeout: 7000 });
  }
}
start();
// A link pasted into this tab's address bar changes only the hash: open it too.
window.addEventListener('hashchange', () => {
  const shared = parseShareHash(location.hash);
  if (shared) openShared(shared);
});

document.fonts?.ready.then(() => renderer.invalidate());

// Handy for debugging and scripting from the console.
Object.assign(globalThis, { archie: { editor, renderer, app } });
