import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const WINDOW = 80;
const BASE = 16777619;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOKENS = 700_000;
const MAX_STEPS = 5_000_000;
const PARSER_SHA = '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [parser] = process.argv.slice(2);

function readBounded(path, maxBytes = MAX_BYTES) {
  const file = resolve(path);
  if (realpathSync(file) !== file) throw new Error();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (n === 0) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs) throw new Error();
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function engine(ts) {
  const k = ts.SyntaxKind;
  const identifiers = new Set([k.Identifier, k.PrivateIdentifier]);
  function tokens(text) {
    // Parse without executing; unlike a standalone lexer this knows regex and template contexts.
    const ast = ts.createSourceFile('input.js', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error();
    const out = [];
    const stack = [ast];
    while (stack.length) {
      const node = stack.pop();
      if (node.kind === k.EndOfFileToken || node.kind === k.JSDocComment) continue;
      const children = identifiers.has(node.kind) || node.kind <= k.LastToken ? [] : node.getChildren(ast);
      if (children.length) {
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      } else if (node.kind <= k.LastToken && node.kind >= k.FirstLiteralToken && node.end > node.pos) {
        // Token kind preserves operators, keywords and literal classes, not spellings or values.
        if (out.length === MAX_TOKENS) throw new Error();
        out.push(node.kind);
      }
    }
    return out;
  }

  let leading = 1;
  for (let i = 0; i < WINDOW; i++) leading = Math.imul(leading, BASE);
  function windows(values, visit) {
    let code = 0;
    for (let i = 0; i < values.length; i++) {
      code = (Math.imul(code, BASE) + values[i]) | 0;
      if (i >= WINDOW) code = (code - Math.imul(values[i - WINDOW], leading)) | 0;
      if (i >= WINDOW - 1) visit(code, i - WINDOW + 1);
    }
  }

  function scan(authored, comparators) {
    const index = new Map();
    for (let a = 0; a < authored.length; a++) {
      if (!authored[a].tokens) continue;
      windows(authored[a].tokens, (code, at) => {
        if (!index.has(code)) index.set(code, []);
        index.get(code).push([a, at]);
      });
    }
    const hits = [];
    let steps = 0;
    for (let c = 0; c < comparators.length; c++) {
      const comparator = comparators[c];
      const matched = new Set();
      // Check whole-file equality too, even for short inputs without a full window.
      for (let a = 0; a < authored.length; a++) {
        if (comparator.sha256 && comparator.sha256 === authored[a].sha256) {
          hits.push([a, c, 'exact', 0, 0]);
          matched.add(a);
        }
      }
      if (!comparator.tokens) continue;
      windows(comparator.tokens, (code, at) => {
        for (const [a, start] of index.get(code) ?? []) {
          if (++steps > MAX_STEPS) throw new Error();
          if (matched.has(a)) continue;
          let i = 0;
          while (i < WINDOW && authored[a].tokens[start + i] === comparator.tokens[at + i]) i++;
          if (i !== WINDOW) continue;
          hits.push([a, c, 'window', start, at]);
          matched.add(a);
        }
      });
    }
    return hits;
  }
  return { tokens, scan };
}

function controls({ tokens, scan }) {
  const a = 'function total(value){' + 'value = value * 3 + 18;\n'.repeat(12) + 'return value;}';
  const b = 'let unused=1;function t(x){/* removal */' + 'x=x*7+2;'.repeat(12) + 'return x;}';
  const different = 'function f(){' + 'if (true) { throw new Error(`bad ${/x+/.source}`); }'.repeat(15) + '}';
  const parse = source => ({ sha256: sha(source), tokens: tokens(source) });
  const result = scan([parse(a)], [parse(b), parse(different), parse(a), parse('let x=0;')]);
  let rejectsInvalid = false;
  try { tokens('const synthetic_canary = "unterminated'); } catch { rejectsInvalid = true; }
  return [result.length === 2 && result[0][1] === 0 && result[0][2] === 'window',
    !result.some(hit => hit[1] === 1 || hit[1] === 3), result.some(hit => hit[1] === 2 && hit[2] === 'exact'),
    rejectsInvalid];
}

function main() {
  const { authored, comparators, runtime } = JSON.parse(readFileSync(0, 'utf8'));
  if (sha(readBounded(parser, 16 * 1024 * 1024)) !== PARSER_SHA) throw new Error();
  const ts = createRequire(import.meta.url)(parser);
  if (ts.version !== '5.9.3') throw new Error();
  const matcher = engine(ts);
  const selfTest = controls(matcher);
  if (!selfTest.every(Boolean)) throw new Error();
  const cache = new Map();
  function input(path) {
    if (!cache.has(path)) {
      try { cache.set(path, readBounded(path)); } catch { cache.set(path, null); }
    }
    return cache.get(path);
  }
  function code(path) {
    const bytes = input(path);
    if (!bytes) return { status: 'unreadable', sha256: null, bytes: null, tokens: null };
    const fields = { sha256: sha(bytes), bytes: bytes.length };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { ...fields, status: 'scanned', tokens: matcher.tokens(text) };
    } catch {
      return { ...fields, status: 'tokenization-failed', tokens: null };
    }
  }
  const a = authored.map(code);
  const c = comparators.map(code);
  const hits = matcher.scan(a, c);
  const inventory = items => items.map(row => [row.status, row.sha256, row.bytes, row.tokens?.length ?? null]);
  let equal = runtime.length > 0;
  const runtimeInventory = [];
  for (const [path, expected] of runtime) {
    const bytes = input(path);
    if (!bytes || !expected || createHash(expected.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== expected) equal = false;
    runtimeInventory.push([path, bytes ? sha(bytes) : null]);
  }
  return { selfTest, authored: inventory(a), comparators: inventory(c), hits,
    runtimeEqual: equal, runtimeDigest: sha(JSON.stringify(runtimeInventory)) };
}

try {
  process.stdout.write(JSON.stringify(main()));
} catch {
  // Never include errors, source text, parser diagnostics or paths from the comparator.
  process.exitCode = 2;
}
