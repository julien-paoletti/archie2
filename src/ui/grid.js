const NS = 'http://www.w3.org/2000/svg';

/**
 * Dot grid as an SVG pattern behind the canvas: GPU-composited, crisp at any DPR, and it
 * costs nothing in the canvas frame. Density adapts by powers of 5 with a cross-fade.
 */
export function createGrid(editor, stage) {
  const el = document.createElementNS(NS, 'svg');
  el.classList.add('grid');
  el.innerHTML = `
    <defs>
      <pattern id="grid-minor" patternUnits="userSpaceOnUse"><circle class="grid-dot" r="1"/></pattern>
      <pattern id="grid-major" patternUnits="userSpaceOnUse"><circle class="grid-dot major" r="1.25"/></pattern>
    </defs>
    <rect class="minor" width="100%" height="100%" fill="url(#grid-minor)"/>
    <rect width="100%" height="100%" fill="url(#grid-major)"/>`;
  stage.prepend(el);
  const [minor, major] = el.querySelectorAll('pattern');
  const minorRect = el.querySelector('rect.minor');

  const set = (p, step, ox, oy) => {
    p.setAttribute('width', step);
    p.setAttribute('height', step);
    p.setAttribute('x', ox - step / 2);
    p.setAttribute('y', oy - step / 2);
    p.firstElementChild.setAttribute('cx', step / 2);
    p.firstElementChild.setAttribute('cy', step / 2);
  };

  const update = () => {
    const cam = editor.camera;
    let step = editor.settings.grid * cam.zoom;
    while (step < 14) step *= 5;
    const ox = -cam.x * cam.zoom, oy = -cam.y * cam.zoom;
    set(minor, step, ox, oy);
    set(major, step * 5, ox, oy);
    minorRect.style.opacity = Math.min(1, Math.max(0, (step - 14) / 22));
    el.style.display = editor.settings.showGrid === false ? 'none' : '';
  };
  editor.on('camera', update);
  editor.on('settings', update);
  update();
  return { update };
}
