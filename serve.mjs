// Zero-dependency static server. ES modules can't load from file://, so `npm start` serves the app.
// Local only by default (HOST=0.0.0.0 to share on the network); never serves dotfiles such as .git.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    const inside = path === root || path.startsWith(root + sep);
    if (!inside || path.slice(root.length).split(sep).some((part) => part.startsWith('.'))) return res.writeHead(403).end();
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    // Missing file, or a malformed path (e.g. a stray "%"): never let one request stop the server.
    if (!res.headersSent) res.writeHead(404).end('Not found');
  }
}).listen(port, host, () => console.log(`Archie running at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`));
