// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { digest } from './pdf-bytes.mjs';

const corpus = fileURLToPath(new URL('../../tests/corpus/', import.meta.url));
const counts = { SYN: 12, XRT: 10, XRS: 10, OBJ: 8, INC: 10, PAG: 16, TXT: 14, GFX: 12, IMG: 12, ANN: 8, FRM: 8, MET: 6, ENC: 10, BAD: 10, PER: 4 };

export function verify(directory) {
  assert(lstatSync(directory).isDirectory());
  const manifestPath = join(directory, 'manifest.json');
  const samplesPath = join(directory, 'samples');
  assert(lstatSync(manifestPath).isFile());
  assert(lstatSync(samplesPath).isDirectory());
  const raw = readFileSync(manifestPath);
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.allocation, counts);
  assert.equal(manifest.samples.length, 150);
  const ids = new Set(), hashes = new Set(), files = new Map();
  for (const sample of manifest.samples) {
    const { id, path, bytes, sha256, license, source, expected } = sample;
    const match = /^([A-Z]{3})-(\d{2})$/.exec(id);
    assert(match && +match[2] >= 1 && +match[2] <= counts[match[1]], `Unexpected ID: ${id}`);
    assert.equal(path, `samples/${id}.pdf`, `Invalid sample path: ${id}`);
    assert(!ids.has(id), `Duplicate ID: ${id}`); ids.add(id);
    assert(!hashes.has(sha256), `Duplicate SHA-256: ${id}`); hashes.add(sha256);
    assert.equal(license, 'CC0-1.0');
    assert.equal(source.type, 'self-generated');
    assert(source.recipe && source.generatorVersion && source.parameters && source.sourceIds.length);
    assert(['success', 'error'].includes(expected.open));
    for (const key of ['render', 'save', 'reopen']) assert(['success', 'error', 'not-applicable'].includes(expected[key]));
    const local = join(directory, path);
    assert(lstatSync(local).isFile(), `Not a regular file: ${id}`);
    const data = readFileSync(local);
    assert.equal(data.length, bytes, id);
    assert.equal(digest(data), sha256, id);
    files.set(id, data);
  }
  assert.deepEqual(readdirSync(samplesPath).sort(), [...ids].map(id => `${id}.pdf`).sort());
  for (const sample of manifest.samples) for (const { id, sha256 } of sample.source.parents) {
    assert(files.has(id));
    assert.equal(digest(files.get(id)), sha256);
  }
  return { manifest, sha256: digest(raw), files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { corpus: { type: 'string', default: corpus }, compare: { type: 'string' } } });
  const checked = verify(resolve(values.corpus));
  console.log(`Verified ${checked.files.size} fixture digests and manifest ${checked.sha256}`);
  if (values.compare) {
    const regenerated = verify(resolve(values.compare));
    assert.equal(regenerated.sha256, checked.sha256);
    for (const [id, data] of checked.files) assert(data.equals(regenerated.files.get(id)), id);
    console.log('Regenerated manifest SHA-256 and all fixture bytes match.');
  }
}
