// Localhost only. Unlike a directory server, this cannot expose tools or source.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (!['/', '/index.html', '/app.js', '/qr.js'].includes(path) && !/^\/pkg\/[a-zA-Z0-9_.]+$/.test(path)) {
    res.writeHead(404).end(); return;
  }
  try {
    const file = join(import.meta.dirname, path === '/' ? 'index.html' : path);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
}).listen(8743, '127.0.0.1', () => console.log('Transfer experiment: http://127.0.0.1:8743'));
