// Static server for a Pouch dist with models, mirroring deploy.mjs's _headers.
// node local-serve.mjs <dir> <port>
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const [dir, port] = process.argv.slice(2);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream' };
createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/pouch.html';
  const f = join(dir, p);
  if (p.includes('..') || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream', 'content-length': statSync(f).size,
    'cache-control': p.startsWith('/models/') ? 'public, max-age=31536000, immutable' : 'no-store, no-transform' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(f).pipe(res);
}).listen(+port, '127.0.0.1', () => console.log('serving', dir, port));
