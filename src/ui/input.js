import { isEditable } from './dom.js';

/** Translate DOM pointer/wheel/keyboard events into the editor's normalized input API. */
export function bindInput(editor, el) {
  let rect = el.getBoundingClientRect();
  new ResizeObserver(() => (rect = el.getBoundingClientRect())).observe(el);

  const norm = (e) => ({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    button: e.button,
    shift: e.shiftKey,
    alt: e.altKey,
    mod: e.ctrlKey || e.metaKey,
    pointerType: e.pointerType,
  });

  // Two-finger touch: pinch to zoom, drag to pan.
  const touches = new Map();
  let pinch = null;
  const pinchState = () => {
    const [a, b] = [...touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  el.addEventListener('pointerdown', (e) => {
    rect = el.getBoundingClientRect();
    if (isEditable(document.activeElement)) document.activeElement.blur();
    if (e.button === 1) e.preventDefault();
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, norm(e));
      if (touches.size === 2) {
        editor.cancelGesture();
        pinch = pinchState();
        return;
      }
    }
    el.setPointerCapture(e.pointerId);
    editor.pointerDown(norm(e));
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, norm(e));
      if (pinch && touches.size === 2) {
        const next = pinchState();
        editor.camera.panBy(next.mid.x - pinch.mid.x, next.mid.y - pinch.mid.y);
        editor.camera.zoomAt(next.mid, next.d / Math.max(pinch.d, 1));
        pinch = next;
        return;
      }
    }
    if (!pinch) editor.pointerMove(norm(e));
  });

  const end = (e, cancel) => {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (pinch) {
        if (touches.size < 2) pinch = null;
        return;
      }
    }
    if (cancel) editor.cancelGesture();
    else editor.pointerUp(norm(e));
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));
  el.addEventListener('pointerleave', (e) => {
    if (!e.buttons) editor.pointerLeave();
  });
  el.addEventListener('dblclick', (e) => editor.doubleClick(norm(e)));
  // The editor opens its own menu on right-click release, so the browser's `contextmenu`
  // event can land on that menu (or any panel) rather than the canvas: suppress it app-wide,
  // keeping the native menu only in text fields (spellcheck, paste...).
  document.addEventListener('contextmenu', (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    editor.wheel({ ...norm(e), dx: e.deltaX * k, dy: e.deltaY * k, deltaMode: e.deltaMode });
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (isEditable(e.target) || e.defaultPrevented) return;
    const handled = editor.keyDown({
      key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey, repeat: e.repeat,
    });
    if (handled) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => editor.keyUp({ key: e.key, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey }));
  window.addEventListener('blur', () => editor.keyUp({ key: ' ' }));

  editor.on('cursor', (c) => (el.style.cursor = c));
}
