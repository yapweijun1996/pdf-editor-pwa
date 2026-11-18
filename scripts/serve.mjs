import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.wasm': 'application/wasm',
  '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream' };
const allowed = /^(?:index\.html|style\.css|manifest\.webmanifest|sw\.js|precache\.js|(?:icons|src|vendor)\/[\w./-]+)$/;
export function serve(port = 8080) {
  return createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html';
      if (!allowed.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
      const data = await readFile(new URL(pathname, root));
      res.writeHead(200, { 'Content-Type': types[extname(pathname)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'GET' ? data : undefined);
    } catch { res.writeHead(404).end(); }
  }).listen(port, '127.0.0.1');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = serve(Number(process.env.PORT ?? 8080));
  server.on('listening', () => console.log(`Paperplane: http://127.0.0.1:${server.address().port}/`));
}
