import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'bcfda7a21d75af4e5c65cbaa4a1d7e4580cb3f22';
const dir = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(dir, '../..'));
const worker = resolve(dir, 'compare.mjs');
const registry = 'docs/provenance/reviews';
const output = `${registry}/phase0-similarity.json`;
const runtimeRoots = ['index.html', 'src', 'vendor', 'style.css', 'icons', 'manifest.webmanifest', 'sw.js', 'precache.js'];
const js = /\.(?:js|mjs|cjs)$/i;
const sorted = values => [...new Set(values)].sort();
const sha = value => createHash('sha256').update(value).digest('hex');
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const safePath = path => /^[\w./-]+$/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..');

function git(args) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.status !== 0 || result.error) throw new Error();
  return result.stdout;
}

function existingRuntime() {
  const paths = [];
  let count = 0;
  function walk(path, depth) {
    if (++count > 4096 || depth > 12) throw new Error();
    const info = lstatSync(resolve(root, path), { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory()) paths.push(path);
    else for (const entry of readdirSync(resolve(root, path))) walk(`${path}/${entry}`, depth + 1);
  }
  for (const path of runtimeRoots) walk(path, 0);
  return paths;
}

function inventories() {
  const tree = new Map(git(['ls-tree', '-rz', base, '--', ...runtimeRoots]).split('\0').filter(Boolean).map(row => {
    const match = /^(100(?:644|755)) blob ([0-9a-f]{40})\t([^\0]+)$/.exec(row);
    if (!match) throw new Error();
    return [match[3], match[2]];
  }));
  const actual = existingRuntime();
  const runtimePaths = sorted([...tree.keys(), ...actual]);
  const runtime = runtimePaths.map(path => [path, tree.get(path) ?? null]);
  const comparators = runtimePaths.filter(path => path.startsWith('vendor/') && js.test(path));
  const changed = git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', '.', ':(exclude)vendor/**'])
    .split('\0');
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0');
  const authored = sorted([...changed, ...untracked].filter(path => js.test(path) &&
    !path.startsWith('vendor/') && lstatSync(resolve(root, path), { throwIfNoEntry: false })));
  if ([...authored, ...runtimePaths].some(path => !safePath(path)) || authored.length > 128 || comparators.length > 64) throw new Error();
  return { authored, comparators, runtime };
}

export function runComparator(input, parserPath) {
  if (Number(process.versions.node.split('.')[0]) !== 26 || !parserPath || !isAbsolute(parserPath)) throw new Error();
  const parser = realpathSync(parserPath);
  const allowed = sorted([worker, parser, dirname(dirname(parser)) + '/package.json',
    ...input.authored.map(path => resolve(root, path)), ...input.comparators.map(path => resolve(root, path)),
    ...input.runtime.map(([path]) => resolve(root, path))]);
  if (allowed.some(path => !/^\/[\w ./-]+$/.test(path))) throw new Error();
  const args = ['--permission', '--disable-proto=throw', '--no-warnings', '--no-experimental-require-module',
    '--max-old-space-size=384', ...allowed.map(path => `--allow-fs-read=${path}`), worker, parser];
  const result = spawnSync(process.execPath, args, { cwd: root, input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8', env: {}, timeout: 45_000, maxBuffer: 2 ** 20 });
  if (result.status !== 0 || result.error) throw new Error();
  const data = JSON.parse(result.stdout);
  const controls = Array.isArray(data.selfTest) && data.selfTest.length === 4 && data.selfTest.every(v => v === true);
  const inventory = (rows, size) => {
    if (!Array.isArray(rows) || rows.length !== size) throw new Error();
    return rows.map(row => {
      if (!Array.isArray(row) || row.length !== 4) throw new Error();
      const [status, sha, bytes, tokens] = row;
      if (!((status === 'unreadable' && sha === null && bytes === null && tokens === null) ||
            (sha256(sha) && integer(bytes) && ((status === 'scanned' && integer(tokens)) ||
            (status === 'tokenization-failed' && tokens === null))))) throw new Error();
      return { status, sha256: sha, bytes, tokens };
    });
  };
  const authored = inventory(data.authored, input.authored.length);
  const comparators = inventory(data.comparators, input.comparators.length);
  if (!controls || typeof data.runtimeEqual !== 'boolean' || !sha256(data.runtimeDigest) || !Array.isArray(data.hits)) throw new Error();
  const ids = new Set();
  const hits = data.hits.map(row => {
    if (!Array.isArray(row) || row.length !== 5) throw new Error();
    const [a, c, kind, start, position] = row;
    if (![a, c, start, position].every(integer) || !authored[a] || !comparators[c] || ids.has(`${a}:${c}`)) throw new Error();
    if (!(kind === 'window' && start + 80 <= authored[a].tokens && position + 80 <= comparators[c].tokens) &&
        !(kind === 'exact' && start === 0 && position === 0 && authored[a].sha256 && authored[a].sha256 === comparators[c].sha256)) throw new Error();
    ids.add(`${a}:${c}`);
    return { a, c, kind, start, position };
  });
  return { controls, authored, comparators, hits, runtimeEqual: data.runtimeEqual, runtimeDigest: data.runtimeDigest };
}

function writeReport(report) {
  if (realpathSync(resolve(root, registry)) !== resolve(root, registry)) throw new Error();
  const tmp = resolve(root, `${output}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, resolve(root, output));
}

function main() {
  const setup = { reportVersion: 1, base, head: git(['rev-parse', 'HEAD']).trim(), node: process.version,
    parser: { version: '5.9.3', sha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675' },
    scanner: { launcherSha256: sha(readFileSync(fileURLToPath(import.meta.url))), workerSha256: sha(readFileSync(worker)), windowTokens: 80 } };
  const input = inventories();
  const id = c => `C${String(c + 1).padStart(3, '0')}`;
  let data;
  try { data = runComparator(input, process.env.CLEAN_ROOM_TYPESCRIPT); } catch {
    writeReport({ ...setup, verdict: 'blocked', omissions: ['comparator-failed-no-coverage'],
      authored: input.authored.map(path => ({ path, status: 'not-scanned' })),
      comparators: input.comparators.map((_, c) => ({ id: id(c), status: 'not-scanned' })) });
    return 2;
  }
  const authored = data.authored.map((row, a) => ({ path: input.authored[a], ...row }));
  const comparators = data.comparators.map((row, c) => ({ id: id(c), ...row }));
  const hits = data.hits.map(({ a, c, kind, start, position }, i) => ({ id: i + 1,
    path: input.authored[a], comparator: id(c), kind, authoredTokenStart: start, comparatorTokenStart: position }));
  const omissions = [];
  if (!authored.length || !comparators.length) omissions.push('empty-inventory');
  if (data.authored.concat(data.comparators).some(row => row.status !== 'scanned')) omissions.push('file-not-scanned');
  if (JSON.stringify(inventories()) !== JSON.stringify(input)) omissions.push('inventory-changed');
  if (!data.runtimeEqual) omissions.push('runtime-not-equal');
  const verdict = omissions.length ? 'blocked' : hits.length ? 'needs-disposition' : 'no-hits';
  writeReport({ ...setup, verdict, omissions, authored, comparators,
    inventorySha256: sha(JSON.stringify([authored, comparators])), hits,
    controls: { normalizedCopy: true, unrelatedAndShort: true, exactCopy: true, invalidSyntaxRejected: true },
    runtime: { equalToBase: data.runtimeEqual, files: input.runtime.length, sha256: data.runtimeDigest } });
  return verdict === 'no-hits' ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
    process.stdout.write(process.exitCode === 0 ? 'Similarity: no hits. See JSON report.\n' : 'Similarity: not clear. See JSON report.\n');
  } catch {
    process.stderr.write('Similarity failed; do not rely on any existing report.\n');
    process.exitCode = 1;
  }
}
