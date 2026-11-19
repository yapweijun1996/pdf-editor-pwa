// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { corpusDirectory } from './generate.mjs';
import { verify } from './verify.mjs';

const { values } = parseArgs({ options: { corpus: { type: 'string', default: corpusDirectory }, report: { type: 'string' } } });
const directory = resolve(values.corpus);
const { manifest, sha256 } = verify(directory);
const run = (tool, args) => {
  const result = spawnSync(tool, args, { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 15000, maxBuffer: 2 ** 20 });
  if (result.error || result.signal) throw result.error ?? new Error(`${tool} terminated by ${result.signal}`);
  return { code: result.status, binary: result.stdout, out: result.stdout.toString('utf8'), err: result.stderr.toString('utf8').trim() };
};
const version = (tool, flag) => {
  const result = run(tool, [flag]);
  return (result.out || result.err).split('\n')[0];
};
const tools = { qpdf: version('qpdf', '--version'), pdfinfo: version('pdfinfo', '-v'), pdftotext: version('pdftotext', '-v'), pdftoppm: version('pdftoppm', '-v') };

function raster(page, file, credential) {
  const result = run('pdftoppm', [...credential, '-scale-to', '160', '-f', `${page}`, '-l', `${page}`, '-singlefile', file]);
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(result.binary.toString('ascii', 0, 64));
  const data = header && result.binary.subarray(header[0].length);
  if (!header || data.length !== +header[1] * +header[2] * 3) return { page, exit: result.code, dimensions: null, nonwhitePixels: null, diagnostic: result.err || null };
  let nonwhite = 0;
  for (let i = 0; i < data.length; i += 3) if (Math.min(data[i], data[i + 1], data[i + 2]) < 240) nonwhite++;
  return { page, exit: result.code, dimensions: [+header[1], +header[2]], nonwhitePixels: nonwhite, diagnostic: result.err || null };
}

const results = [];
for (const sample of manifest.samples) {
  const { id, path, sha256, expected, encryption, pageCount, preservation, source: { parameters } } = sample;
  const file = resolve(directory, path);
  const credential = encryption ? ['-upw', encryption.userPassword] : [];
  const check = run('qpdf', [...(encryption ? [`--password=${encryption.userPassword}`] : []), '--check', file]);
  const info = run('pdfinfo', [...credential, file]);
  const text = run('pdftotext', [...credential, file, '-']);
  const rawCount = info.out.match(/^Pages:\s+(\d+)$/m);
  const reportedPages = rawCount ? +rawCount[1] : null;
  const perPage = text.out.replace(/\f$/, '').split('\f');
  const orderedMarkerCount = text.code === 0 ? preservation.pageMarkers.filter((mark, i) => mark ? perPage[i]?.includes(mark) : perPage.length === pageCount && !perPage[i]?.trim()).length : 0;
  const compact = value => value.replaceAll(file, path);
  const row = { id, sha256, qpdfCheck: check.code, pdfinfo: info.code, pdftotext: text.code, reportedPages, orderedMarkerCount,
    diagnostics: [...new Set([check.err, info.err, text.err].filter(Boolean).map(compact))], findings: [] };
  const insist = (condition, message) => { if (!condition) row.findings.push(message); };
  if (encryption) {
    const unauthorized = run('qpdf', ['--check', file]);
    const noCredInfo = run('pdfinfo', [file]);
    const wrong = run('qpdf', ['--password=not-a-fixture-credential', '--check', file]);
    const owner = run('qpdf', [`--password=${encryption.ownerPassword}`, '--check', file]);
    const p = Number(check.out.match(/^P = (-?\d+)$/m)?.[1]);
    const revision = Number(check.out.match(/^R = (\d+)$/m)?.[1]);
    row.passwordControls = { noCredential: unauthorized.code, pdfinfoNoCredential: noCredInfo.code, wrongCredential: wrong.code, ownerCredential: owner.code, revision, permissions: p };
    insist(unauthorized.code === (encryption.required ? 2 : 0) && noCredInfo.code === (encryption.required ? 1 : 0), 'No-credential behavior mismatch');
    insist(wrong.code === 2 && /invalid password/i.test(wrong.err) && owner.code === 0 && /Supplied password is owner password/i.test(owner.out), 'Wrong/owner credential control mismatch');
    if (encryption.required) insist(/invalid password/i.test(unauthorized.err) && /incorrect password/i.test(noCredInfo.err), 'No-credential password diagnostic missing');
    insist(p === encryption.permissions && revision === (encryption.profile.startsWith('AES') ? 4 : 2), 'Security profile mismatch');
    insist(info.out.match(/^Title:\s+(.+)$/m)?.[1] === encryption.title, 'Authorized encrypted Info string mismatch');
  }
  if (sample.standardsValid || expected.policy === 'recover_or_corrupt_error') {
    const accepted = sample.standardsValid || (info.code === 0 && text.code === 0);
    if (accepted) {
      insist(reportedPages === pageCount && orderedMarkerCount === pageCount, 'Page count or ordered marker mismatch');
      const pages = sample.category === 'performance' ? [1, Math.ceil(pageCount / 2), pageCount] : [1];
      row.raster = pages.map(page => raster(page, file, credential));
      for (const { exit, dimensions, nonwhitePixels, diagnostic } of row.raster) {
        insist(exit === 0 && dimensions && (preservation.intentionallyBlank ? nonwhitePixels === 0 : nonwhitePixels > 0), 'Raster smoke probe mismatch');
        if (sample.standardsValid) insist(!diagnostic, 'Unexpected positive raster diagnostic');
      }
    }
    if (sample.standardsValid) {
      insist(check.code === 0 && info.code === 0 && text.code === 0 && row.diagnostics.length === 0, 'Unexpected positive oracle status/diagnostic');
      if (parameters.expectedText) {
        row.expectedTextFound = text.out.includes(parameters.expectedText);
        insist(row.expectedTextFound, 'Text extraction probe mismatch');
      }
      if (parameters.resourceLabels) {
        row.resourceLabelsFound = parameters.resourceLabels.every(label => text.out.includes(label));
        insist(row.resourceLabelsFound, 'Compressed resource labels missing');
      }
      if (parameters.supplementalObject) {
        const active = run('qpdf', [`--show-object=${parameters.supplementalObject}`, file]);
        row.supplementalAnnotationResolved = active.code === 0 && active.out.includes(`(${id} supplemental note)`) && active.out.includes(`/Name /${parameters.annotationIcon}`);
        insist(row.supplementalAnnotationResolved, 'Hybrid supplemental annotation unresolved');
      }
      if (parameters.geometry) {
        const boxes = run('pdfinfo', ['-f', '1', '-l', `${pageCount}`, '-box', file]);
        row.geometryMatched = boxes.code === 0 && parameters.geometry.every(({ mediaBox, cropBox, rotation }, index) => {
          const get = field => boxes.out.match(new RegExp(`^Page\\s+${index + 1}\\s+${field}:\\s+(.+)$`, 'm'))?.[1].trim().split(/\s+/).map(Number).join(' ');
          return get('rot') === `${rotation}` && get('MediaBox') === mediaBox.slice(1, -1) && get('CropBox') === cropBox.slice(1, -1);
        });
        insist(row.geometryMatched, 'Inherited page geometry mismatch');
      }
    }
    row.outcome = encryption ? (encryption.required ? 'password-required-authorized-open' : 'empty-password-open') : sample.standardsValid ? 'positive-open' : accepted ? 'recovered' : 'rejected-recoverable-defect';
  } else {
    insist(check.code === 2, 'Structural checker did not reject the no-usable-page case');
    if (info.code === 0 || text.code === 0) {
      row.raster = [raster(1, file, [])];
      insist(row.diagnostics.some(line => /wrong type|page tree|invalid|couldn.t read/i.test(line)) && row.raster[0].diagnostic, 'Poppler reported recoverable output without an expected page-structure diagnostic');
    }
    row.outcome = 'no-usable-page';
  }
  results.push(row);
}
const counts = {};
for (const row of results) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
const mismatches = results.filter(row => row.findings.length).map(({ id, findings }) => ({ id, findings }));
const report = { schemaVersion: 1, date: new Date().toISOString().slice(0, 10), purpose: 'Implementation evidence, not independent QA or app behavior',
  manifestSha256: sha256, tools, environment: { platform: process.platform, arch: process.arch, node: process.version, LC_ALL: 'C', TZ: 'UTC' },
  command: 'node scripts/corpus/oracle.mjs --report tests/corpus/oracle-report.json',
  scope: 'qpdf structural check; pdfinfo counts/selected geometry; pdftotext ordered markers/selected text; pdftoppm 160 px raster smoke checks; synthetic password controls. Not feature-level visual or interactive preservation.',
  counts, mismatches, results };
if (values.report) writeFileSync(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ tools, counts, mismatches }, null, 2));
assert.equal(mismatches.length, 0);
