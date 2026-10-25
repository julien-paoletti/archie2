// Screenshots of the running app, to check a change by eye (needs Chrome or Edge installed).
//
//   npm run shot -- tools/shots/sample.mjs [dark]
//
// A case module exports `run(page, shot)` and optionally:
//   doc       a diagram to start from (null: the built-in sample)
//   prefs     app preferences (the inspector and minimap start closed)
//   viewport  { width, height }, default 1200 × 760
//   scale     device pixel ratio, default 1
// `shot(name, clip?)` saves .shots/<case>-<name>[-dark].png; whatever `run` returns is printed
// as JSON. The app is scriptable through `window.archie` ({ editor, renderer, app }). Page
// errors are printed at the end. The app is served on a spare port, or set SHOT_URL to use a
// server already running; CHROME_PATH picks the browser.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [file, theme = 'light'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run shot -- <case.mjs> [light|dark]');
  process.exit(1);
}
const mod = await import(pathToFileURL(resolve(file)).href);
const name = basename(file, '.mjs');
const outDir = resolve(import.meta.dirname, '..', '.shots');
mkdirSync(outDir, { recursive: true });

const server = process.env.SHOT_URL ? null : await serve();
const url = process.env.SHOT_URL ?? server.url;
const browser = await launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: mod.viewport ?? { width: 1200, height: 760 }, deviceScaleFactor: mod.scale ?? 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Seed storage on the first load only, so a case can reload and see what the app saved.
  await page.addInitScript(([doc, prefs]) => {
    if (sessionStorage.getItem('shot:seeded')) return;
    sessionStorage.setItem('shot:seeded', '1');
    if (doc) localStorage.setItem('archie:document', JSON.stringify(doc));
    else localStorage.removeItem('archie:document');
    localStorage.setItem('archie:prefs', JSON.stringify(prefs));
  }, [mod.doc ?? null, { inspectorOpen: false, minimapOpen: false, theme, ...mod.prefs }]);
  await page.goto(url);
  await page.waitForFunction(() => globalThis.archie);
  await page.waitForTimeout(700); // fonts and appear animations
  const shot = async (n, clip) => {
    await page.waitForTimeout(350);
    const path = resolve(outDir, `${name}-${n}${theme === 'dark' ? '-dark' : ''}.png`);
    await page.screenshot({ path, clip });
    console.log(path);
  };
  const result = await mod.run(page, shot);
  if (result !== undefined) console.log(JSON.stringify(result, null, 1));
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  await browser.close();
  server?.stop();
}

async function launch() {
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH });
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return chromium.launch({ channel: 'msedge' });
  }
}

/** Starts serve.mjs on a spare port. */
function serve() {
  const port = 5200 + Math.floor(Math.random() * 700);
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`serve.mjs exited (${code})`)));
    child.stdout.once('data', () => done({ url: `http://localhost:${port}/`, stop: () => child.kill() }));
  });
}
