import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { sha256 } from './report.mjs';

const roots = ['index.html', 'style.css', 'manifest.webmanifest', 'sw.js', 'precache.js', 'icons', 'src', 'vendor'];
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
};
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
const fingerprint = files => sha256(JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([name, bytes]) => [name, sha256(bytes)])));

export async function runtimeSnapshot(root, reference = 'HEAD') {
  const commit = git(root, 'rev-parse', '--verify', `${reference}^{commit}`).toString().trim();
  const listed = git(root, 'ls-tree', '-rz', '--name-only', commit, '--', ...roots).toString().split('\0').filter(Boolean);
  // Hash opaque Git blobs; never decode or inspect implementation source.
  const committed = new Map(listed.map(name => [name, git(root, 'cat-file', 'blob', `${commit}:${name}`)]));
  const files = new Map();
  async function collect(name) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await collect(`${name}/${child}`);
    } else if (info.isFile()) files.set(name, await readFile(path));
    else throw new Error(`Non-regular runtime path: ${name}`);
  }
  for (const name of roots) await collect(name);
  const runtimeSha256 = fingerprint(files);
  const committedRuntimeSha256 = fingerprint(committed);
  return { files, identity: { commit, runtimeSha256, committedRuntimeSha256,
    matchesCommit: runtimeSha256 === committedRuntimeSha256, runtimeFiles: files.size } };
}

export async function serveRuntime(files) {
  const assets = new Map([...files].map(([name, bytes]) => [
    `/${name.split('/').map(encodeURIComponent).join('/')}`, { bytes, name },
  ]));
  assets.set('/', assets.get('/index.html'));
  const server = createServer((request, response) => {
    const asset = assets.get(request.url);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[extname(asset.name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : asset.bytes);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    allowed: new Set([...assets.keys()].map(path => `${origin}${path}`)),
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
