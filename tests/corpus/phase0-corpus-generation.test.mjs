// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { buildCorpus, corpusDirectory } from '../../scripts/corpus/generate.mjs';
import { verify } from '../../scripts/corpus/verify.mjs';

const { manifest, files } = verify(corpusDirectory);
const byId = new Map(manifest.samples.map(sample => [sample.id, sample]));
const source = id => files.get(id).toString('latin1');
const sample = id => byId.get(id);
const counts = (samples, group) => {
  const result = {};
  for (const sample of samples) { const key = group(sample); result[key] = (result[key] ?? 0) + 1; }
  return result;
};
const plans = {
  SYN: ['syntax', { 'line-ending': 3, lexical: 4, 'object-layout': 2, 'contents-layout': 3 }],
  XRT: ['xref-table', { 'contiguous-table': 2, 'split-table-full-coverage': 4, 'free-generation': 4 }],
  XRS: ['xref-stream', { 'field-widths': 3, 'index-layout': 3, 'xref-filter': 2, 'hybrid-update': 2 }],
  OBJ: ['object-stream', { 'single-container': 4, 'cross-container': 2, 'container-filter': 2 }],
  INC: ['incremental', { 'replace-marker': 2, 'change-page-tree': 4, 'update-optional-objects': 4 }],
  PAG: ['page-tree', { 'tree-depth-fanout': 4, 'box-rotation-overrides': 4, 'resource-inheritance': 4, 'mixed-geometry': 4 }],
  TXT: ['text', { 'standard-font-encoding': 4, 'drawn-type3': 4, 'text-state': 4, 'to-unicode': 2 }],
  GFX: ['graphics', { 'path-clip': 2, 'state-transform-color': 4, 'blend-alpha': 4, 'isolated-soft-mask': 2 }],
  IMG: ['image', { 'image-xobject': 4, 'inline-or-flate': 4, 'image-mask': 4 }],
  ANN: ['annotation', { 'text-note': 2, 'internal-link': 2, 'text-markup': 2, 'appearance-flags': 2 }],
  FRM: ['form', { 'text-field': 2, checkbox: 2, 'radio-group': 2, 'choice-field': 2 }],
  MET: ['metadata', { 'info-dictionary': 2, 'catalog-xml': 2, 'component-xml': 2 }],
  ENC: ['encryption', { 'legacy-password': 4, 'aesv2-password': 4, 'empty-user-password': 2 }],
  BAD: ['malformed', { 'recoverable-defect': 4, 'no-usable-page-tree': 6 }],
  PER: ['performance', { 'vector-text-light': 2, 'image-heavy': 2 }]
};

test('checked-in bytes and manifest agree with two fresh in-memory builds', () => {
  const first = buildCorpus(), second = buildCorpus();
  assert.equal(first.size, 150);
  for (const [id, a] of first) {
    assert.deepEqual(a, second.get(id), id);
    assert.deepEqual(a.sample, sample(id), id);
    assert(a.buffer.equals(files.get(id)), id);
  }
});

test('matrix, policy, safe unique paths, hashes, and explicit parent links', () => {
  for (const [prefix, [category, groups]] of Object.entries(plans)) {
    const items = manifest.samples.filter(({ id }) => id.startsWith(`${prefix}-`));
    assert(items.every(item => item.category === category), category);
    assert.deepEqual(counts(items, item => item.source.recipe), groups);
    assert.equal(new Set(items.map(item => item.source.recipeId)).size, items.length);
  }
  assert.deepEqual(counts(manifest.samples, item => item.expected.policy), { open: 130, password_error: 8, observe_encryption_policy: 2, recover_or_corrupt_error: 4, corrupt_error: 6 });
  for (const s of manifest.samples) {
    assert.equal(s.path, `samples/${s.id}.pdf`);
    assert(s.specSections.length);
    assert.deepEqual(s.source.externalAssetInputs, []);
    assert.equal(s.standardsValid, s.category !== 'malformed');
    assert(!/\/(?:JavaScript|JS|URI|Launch|GoToR|SubmitForm|ImportData|XFA)\b/.test(source(s.id)), s.id);
  }
  for (const id of ['BAD-01', 'BAD-02', 'BAD-03', 'BAD-04', 'BAD-05', 'BAD-06', 'BAD-10']) {
    assert.deepEqual(sample(id).source.parents, [{ id: 'SYN-01', sha256: sample('SYN-01').sha256 }]);
    assert(sample(id).intentionalInvalidity);
  }
  assert(!/\d+ 0 obj/.test(source('BAD-05')));
  assert.equal(source('SYN-01').replace(/%%EOF\n$/, ''), source('BAD-01'));
});

// These byte assertions are intentionally limited to our emitted shapes.
function streams(id) {
  const serial = source(id);
  return [...serial.matchAll(/^(\d+) (\d+) obj\r?\n?(<< [^\r\n]*?\/Length (\d+) >>)\r?\n?stream\r?\n/gm)].map(match => {
    const start = match.index + match[0].length;
    const end = start + Number(match[4]);
    assert.match(serial.slice(end), /^\r?\n?endstream(?:\r\n|\r|\n)endobj/, `${id} stream length for ${match[1]}`);
    return { at: match.index, id: +match[1], dict: match[3], payload: Buffer.from(serial.slice(start, end), 'latin1') };
  });
}

function decode({ dict, payload }) { return /\/Filter \/FlateDecode/.test(dict) ? inflateSync(payload) : payload; }
function numbers(dict, key) { return dict.match(new RegExp(`/${key} \\[([^\\]]*)\\]`))?.[1].split(' ').map(Number); }
function tableSections(serial, offset) {
  const heading = /^xref(\r\n|\r|\n)/.exec(serial.slice(offset));
  assert(heading);
  const eol = heading[1];
  const groups = [], entries = new Map();
  let cursor = offset + heading[0].length;
  while (!serial.startsWith('trailer', cursor)) {
    const section = /^(\d+) (\d+)/.exec(serial.slice(cursor));
    assert(section);
    groups.push(section.slice(1).map(Number));
    cursor += section[0].length + eol.length;
    for (let i = 0; i < +section[2]; i++, cursor += 20) {
      const key = +section[1] + i;
      const row = /^(\d{10}) (\d{5}) ([fn])(?:\r\n| [\r\n])$/.exec(serial.slice(cursor, cursor + 20));
      assert(row && !entries.has(key));
      if (row[3] === 'n') assert(serial.startsWith(`${key} ${+row[2]} obj`, +row[1]), `xref ${key} at ${row[1]}`);
      entries.set(key, [row[3], +row[1], +row[2]]);
    }
  }
  return { groups, entries };
}

function xrefStream(serial, obj, all) {
  const widths = numbers(obj.dict, 'W');
  const size = +obj.dict.match(/\/Size (\d+)/)[1];
  const index = numbers(obj.dict, 'Index') ?? [0, size];
  const payload = decode(obj);
  let cursor = 0;
  const rows = new Map();
  for (let pair = 0; pair < index.length; pair += 2) {
    for (let id = index[pair]; id < index[pair] + index[pair + 1]; id++) {
      assert(!rows.has(id));
      const [type, pos, gen] = widths.map((width, i) => {
        if (!width) return i === 0 ? 1 : 0;
        const value = payload.readUIntBE(cursor, width); cursor += width; return value;
      });
      rows.set(id, [type, pos, gen]);
      if (type === 1) assert(serial.startsWith(`${id} ${gen} obj`, pos));
      if (type === 2) {
        const container = all.find(candidate => candidate.id === pos && candidate.dict.includes('/Type /ObjStm'));
        assert(container);
        const first = +container.dict.match(/\/First (\d+)/)[1];
        const count = +container.dict.match(/\/N (\d+)/)[1];
        const data = decode(container);
        const header = data.subarray(0, first).toString('ascii').trim().split(/\s+/).map(Number);
        assert.equal(header.length, 2 * count);
        assert.equal(header[2 * gen], id);
        assert.equal(data[first + header[2 * gen + 1]], '<'.charCodeAt(0));
      }
    }
  }
  assert.equal(cursor, payload.length);
  return rows;
}

test('xref row widths and offsets, Prev chain, split coverage, type-2 indices, hybrid pointers and live generations', () => {
  for (const s of manifest.samples.filter(x => x.standardsValid)) {
    const raw = source(s.id), payloads = streams(s.id);
    const revisions = [...raw.matchAll(/startxref[\r\n]+(\d+)[\r\n]+%%EOF/g)];
    assert.equal(revisions.length, s.source.parameters.revisions ?? 1, s.id);
    revisions.forEach((match, i) => {
      const offset = +match[1];
      assert(offset < match.index);
      const pdfSection = raw.slice(offset, match.index);
      const prev = pdfSection.match(/\/Prev (\d+)/);
      assert.equal(prev?.[1], revisions[i - 1]?.[1], s.id);
      if (pdfSection.startsWith('xref')) {
        const { groups, entries } = tableSections(raw, offset);
        if (i === 0) assert.deepEqual(groups, [[0, +pdfSection.match(/\/Size (\d+)/)[1]]]);
        if (i === 1 && s.source.parameters.updateSections) {
          assert.deepEqual(groups, s.source.parameters.updateSections);
          assert.deepEqual([...entries.keys()], [0, 1, 2, 3, 4, 5]);
        }
        if (s.id === 'XRT-09' || s.id === 'XRT-10') {
          const row = entries.get(s.source.parameters.object);
          assert.equal(row[0], i === 1 ? 'f' : 'n');
          assert.equal(row[2], i === 0 ? 0 : 1);
        }
        const supplement = pdfSection.match(/\/XRefStm (\d+)/);
        if (supplement) {
          const hidden = s.source.parameters.supplementalObject;
          assert(!entries.has(hidden));
          const supplemental = payloads.find(obj => obj.at === +supplement[1]);
          assert.equal(xrefStream(raw, supplemental, payloads).get(hidden)[0], 2);
        }
      } else {
        const obj = payloads.find(obj => obj.at === offset);
        assert(obj?.dict.includes('/Type /XRef'), s.id);
        const rows = xrefStream(raw, obj, payloads);
        assert.equal(rows.get(obj.id)[1], offset);
        if (s.category === 'object-stream') {
          const packed = [...rows.entries()].filter(([, entry]) => entry[0] === 2).map(([id]) => id).sort((a, b) => a - b);
          assert.deepEqual(packed, s.source.parameters.containers.flat().sort((a, b) => a - b));
        }
      }
    });
  }
});

test('representative byte and semantic recipe invariants across rendering, forms and metadata', () => {
  assert.match(source('SYN-02'), /^%PDF-1\.7\r\n/);
  assert.match(source('SYN-03'), /\rstream\r\n/);
  assert.match(source('SYN-11'), /\/Contents \[\d+ 0 R \d+ 0 R\]/);
  assert(!source('SYN-12').includes('/Contents'));
  assert.deepEqual(sample('INC-03').preservation.pageMarkers, ['INC-03-C', 'INC-03-B', 'INC-03-A']);
  assert.match(source('INC-09'), /\/Info null/);
  assert.deepEqual(sample('PAG-08').source.parameters.geometry.map(item => item.rotation), [270, 0]);
  assert.match(source('PAG-08'), /\/Rotate 0/);
  assert.match(source('PAG-11'), /\/Resources \d+ 0 R/);
  assert.equal(streams('TXT-07').filter(obj => / d1\b/.test(obj.payload)).length, 2);
  assert.match(source('TXT-12'), /3 Tr \(Invisible\)/);
  assert.match(source('TXT-14'), /<42> <d83ddf01>/);
  assert.match(source('GFX-02'), / W\* n /);
  assert.match(source('GFX-10'), /\/BM \/Difference/);
  assert.match(source('GFX-12'), /\/SMask << \/S \/Luminosity/);
  for (const s of manifest.samples.filter(x => x.category === 'image')) {
    const { w, h, inline, sourceBytes, flate } = s.source.parameters;
    const primary = streams(s.id).filter(obj => obj.dict.includes('/Subtype /Image')).at(-1);
    if (inline) assert.match(source(s.id), new RegExp(`BI /W ${w} /H ${h} .*?>`, 's'));
    else {
      assert(primary.dict.includes(`/Width ${w} /Height ${h}`));
      assert.equal(primary.dict.includes('/FlateDecode'), flate);
      assert.equal(decode(primary).length, sourceBytes);
    }
  }
  assert.match(source('IMG-09'), /\/ImageMask true .*\/Decode \[1 0\]/);
  assert.match(source('IMG-12'), /\/SMask \d+ 0 R/);
  assert.match(source('ANN-04'), /\/S \/GoTo \/D \[/);
  assert.match(source('ANN-08'), /\/F 36 \/AP/);
  assert.equal([...source('FRM-06').matchAll(/\/Subtype \/Widget/g)].length, 3);
  assert.match(source('FRM-06'), /\/AS \/Low/);
  assert.match(source('FRM-08'), /\/Opt \[\[\(S\) \(South\)\]/);
  assert.match(source('MET-02'), /\/Title <feff/);
  assert.match(source('MET-05'), /\/Type \/Page .*\/Metadata \d+ 0 R/);
  assert.match(source('MET-06'), /\/Subtype \/Form .*\/Metadata \d+ 0 R/);
  for (const s of manifest.samples.filter(x => x.category === 'encryption')) {
    assert(!source(s.id).includes(s.encryption.title));
    assert.equal(s.encryption.userPassword.length > 0, s.encryption.required);
    assert.match(source(s.id), /\/Encrypt \d+ 0 R/);
    if (s.encryption.profile.startsWith('AES')) {
      assert.match(source(s.id), /\/CFM \/AESV2/);
      const xml = streams(s.id).find(obj => obj.dict.includes('/Type /Metadata'));
      assert.equal(xml.payload.includes('Synthetic encrypted document'), !s.encryption.encryptMetadata);
    }
    if (!s.encryption.required) assert.notEqual(s.encryption.permissions, -4);
  }
});

test('performance workloads have distinct ordered page marks and a bounded shared image pool', () => {
  for (const [id, count, images] of [['PER-01', 50, 0], ['PER-02', 50, 12], ['PER-03', 500, 0], ['PER-04', 500, 12]]) {
    const s = sample(id), raw = source(id);
    assert.equal(s.pageCount, count);
    assert.equal([...raw.matchAll(/\/Type \/Page\b/g)].length, count);
    assert.equal([...raw.matchAll(/\/Subtype \/Image\b/g)].length, images);
    const pageStreams = streams(id).filter(obj => obj.payload.includes(Buffer.from(`${id}-P`)));
    assert.equal(pageStreams.length, count);
    const marks = pageStreams.map(obj => obj.payload.toString('ascii').match(/\((PER-\d\d-P\d{3})\)/)[1]);
    assert.deepEqual(marks, s.preservation.pageMarkers);
    assert.equal(new Set(marks).size, count);
    assert(s.bytes < 400000);
    assert.equal([...raw.matchAll(/\/T\d+ Do/g)].length, images ? 2 * count : 0);
  }
  assert(sample('PER-02').bytes > sample('PER-01').bytes);
  assert(sample('PER-04').bytes > sample('PER-03').bytes);
});
