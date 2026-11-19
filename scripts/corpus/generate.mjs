// SPDX-License-Identifier: MIT
import { mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Pdf, digest } from './pdf-bytes.mjs';
import { Pages } from './pages.mjs';
import * as structure from './structure-recipes.mjs';
import * as art from './art-recipes.mjs';
import * as document from './document-recipes.mjs';

export const corpusDirectory = fileURLToPath(new URL('../../tests/corpus/', import.meta.url));
const version = '1.0.0', authoredOn = '2026-11-19';
const generator = 'scripts/corpus/generate.mjs';
const sourceId = 'adobe-iso-32000-1-2008';
const legalUrl = 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.en';
const matrix = {
  SYN: [12, 'syntax', '7.2,7.3,7.5.2–7.5.5,7.7.2–7.7.3,7.8.2', 'marker, blankness and lexical decoding'],
  XRT: [10, 'xref-table', '7.3.10,7.5.4–7.5.6', 'live object identity and resolved marker'],
  XRS: [10, 'xref-stream', '7.3.8,7.4.4,7.5.6,7.5.8.1–7.5.8.4', 'latest marker and supplemental annotation where present'],
  OBJ: [8, 'object-stream', '7.3.8,7.3.10,7.4.4,7.5.7,7.5.8.3', 'resolved font resources and their visible labels'],
  INC: [10, 'incremental', '7.5.4–7.5.6,7.7.3,14.3.3', 'latest marker, page order/count and metadata or annotation state'],
  PAG: [16, 'page-tree', '7.7.3.2–7.7.3.4,7.8.3,7.9.5,8.3', 'effective boxes, orientation, page order and resource shadowing'],
  TXT: [14, 'text', '7.8.3,9.2–9.4,9.6,9.10.2–9.10.3', 'glyphs, baselines, spacing, visibility and extractable text'],
  GFX: [12, 'graphics', '8.3–8.6,11.3–11.6', 'interior swatches, clipping and compositing'],
  IMG: [12, 'image', '7.4.4,8.6.4,8.9.2–8.9.7,11.6.5', 'image size, placement, orientation, colors and masking'],
  ANN: [8, 'annotation', '7.7.3.3,12.5.2–12.5.6', 'bounds, destination, content, flags and appearance where observable'],
  FRM: [8, 'form', '12.5.5,12.7.2–12.7.4', 'field values and widget states on standalone save; observe flattening separately'],
  MET: [6, 'metadata', '7.9.2,7.9.4,14.3.2–14.3.3', 'known metadata keys by object scope'],
  ENC: [10, 'encryption', '7.6.1–7.6.3,7.6.5,14.4', 'authorization and expected marker with authorized reader'],
  BAD: [10, 'malformed', '7.2–7.3,7.5.2–7.5.5,7.7.2–7.7.3', 'known marker if recovered; known-good control after rejection'],
  PER: [4, 'performance', '7.7.3,7.8,8.9,9.4', 'page count and first/middle/last identities before and after edit']
};

function expectation(prefix, n) {
  let policy = 'open', open = 'success', alternative = null;
  if (prefix === 'ENC') {
    open = 'error';
    policy = n <= 8 ? 'password_error' : 'observe_encryption_policy';
    if (n > 8) alternative = 'success';
  } else if (prefix === 'BAD') {
    open = 'error';
    policy = n <= 4 ? 'recover_or_corrupt_error' : 'corrupt_error';
    if (n <= 4) alternative = 'success';
  }
  const downstream = open === 'success' ? 'success' : 'not-applicable';
  return { open, render: downstream, save: downstream, reopen: downstream, policy,
    ...(alternative ? { alternativeOpen: alternative, onAlternativeSuccess: { render: 'success', save: prefix === 'BAD' ? 'probe only after marker agreement' : 'record app authorization and do not bypass restrictions', reopen: 'only if a permitted export exists' } } : {}),
    ...(open === 'error' ? { expectedErrors: prefix === 'ENC' ? [n <= 8 ? 'password required' : 'encryption unsupported or permissions restricted'] : ['corrupt PDF'], probeKnownGoodAfterRejection: true } : {}) };
}

export function buildCorpus() {
  const records = new Map();
  const recipes = { ...structure, ...art, ...document };
  for (const [prefix, [count, category, sections, preservation]] of Object.entries(matrix)) {
    for (let n = 1; n <= count; n++) {
      const id = `${prefix}-${String(n).padStart(2, '0')}`;
      const pdf = new Pdf(id, prefix === 'SYN' && n <= 3 ? ['\n', '\r\n', '\r'][n - 1] : '\n');
      const { buffer = pdf.result(), marks = [id], recipe, parameters } = recipes[prefix](new Pages(pdf), records, n, id);
      const sha256 = digest(buffer);
      const expected = expectation(prefix, n);
      const sourceSections = sections.split(',');
      const parents = parameters.parent ? [parameters.parent] : [];
      const sample = {
        id, path: `samples/${id}.pdf`, category, sha256, bytes: buffer.length,
        source: { type: 'self-generated', generator, generatorVersion: version, recipe, recipeId: `${prefix}/${recipe}/${n}`, parameters,
          seed: id, authoredOn, author: 'PDF Editor PWA contributors / Corpus Implementation', parents, externalAssetInputs: [],
          sourceIds: [sourceId, 'cc0-1.0-legalcode'], dedication: 'CC0.md', legalUrl },
        license: 'CC0-1.0', expected, pageCount: marks.length || null, declaredPdfVersion: '1.7', specSections: sourceSections,
        features: [prefix, recipe], standardsValid: prefix !== 'BAD',
        preservation: { probe: preservation, pageMarkers: marks, markerBaseline: marks.some(Boolean) ? [24, 255] : null,
          markerSwatch: marks.some(Boolean) ? [24, 232, 16, 9] : null, intentionallyBlank: id === 'SYN-12' },
        ...(prefix === 'ENC' ? { encryption: parameters } : {}),
        ...(prefix === 'BAD' ? { intentionalInvalidity: parameters.defect } : {})
      };
      records.set(id, { sample, buffer });
    }
  }
  return records;
}

function protect(path, isDirectory = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error(`Unsafe output path: ${path}`);
}

export function generate(output) {
  const records = buildCorpus();
  protect(output, true);
  const samplesPath = join(output, 'samples'); protect(samplesPath, true);
  mkdirSync(samplesPath, { recursive: true });
  for (const { sample, buffer } of records.values()) {
    const path = join(output, sample.path); protect(path); writeFileSync(path, buffer);
  }
  const manifest = {
    schemaVersion: 1, corpusVersion: version, goal: '97e94b6a-60de-44e6-89d0-3b785f0b3a95', authoredOn,
    sources: '../../docs/notes/sources.json', matrixBasis: 'docs/notes/phase0-fixtures.md (research planning assumption)',
    allocation: Object.fromEntries(Object.entries(matrix).map(([prefix, [count]]) => [prefix, count])),
    generatorEnvironment: { referenceNode: '26.13.0', referenceZlib: '1.3.2.1-motley-456ae73' },
    samples: [...records.values()].map(({ sample }) => sample)
  };
  const path = join(output, 'manifest.json'); protect(path); writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: corpusDirectory } } });
  const output = resolve(values.output);
  console.log(`Generated ${generate(output).samples.length} fixtures under ${output}`);
}
