import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { emptyStages, measureUI, performancePages } from '../scripts/baseline/browser.mjs';
import { compareContent, contentSettings, createPageIdentity, expectsBlank, hasMeaningfulInk, identityScore,
  parsePpm, rasterStats, rotatedReference } from '../scripts/baseline/content.mjs';
import { detectReaders, referenceRaster } from '../scripts/baseline/readers.mjs';
import { classify, compare, sha256, stages, summarize, validateManifest, validationOutcome } from '../scripts/baseline/report.mjs';
import { runtimeSnapshot, serveRuntime } from '../scripts/baseline/runtime.mjs';

const positive = Object.fromEntries(stages.map(stage => [stage, 'success']));
const negative = { open: 'error', render: 'not-applicable', save: 'not-applicable', reopen: 'not-applicable' };
const observed = (...statuses) => Object.fromEntries(stages.map((stage, index) => [stage, { status: statuses[index] }]));
const fixture = (index, more = {}) => ({ id: `case-${index}`, category: 'synthetic', path: `samples/${index}.pdf`,
  sha256: 'a'.repeat(64), bytes: 10, source: { type: 'self-generated', generator: 'test', recipe: 'unit' },
  license: 'CC0-1.0', expected: positive, pageCount: 1, ...more });
const manifest = (...samples) => ({ schemaVersion: 1, samples });

test('expected rejection is separate from an observed mismatch and from a timeout', () => {
  assert.equal(classify(negative, observed('error', 'blocked', 'blocked', 'blocked')).outcome, 'expected-rejection');
  assert.equal(classify(positive, observed('error', 'blocked', 'blocked', 'blocked')).outcome, 'mismatch');
  assert.equal(classify(negative, observed('timeout', 'blocked', 'blocked', 'blocked')).outcome, 'infrastructure-failure');
  assert.equal(classify(negative, observed('success', 'success', 'success', 'success')).outcome, 'mismatch');
  assert.equal(compare('success', { status: 'success', checksMatch: false }), 'mismatch');
  assert.equal(compare('success', { status: 'blocked' }), 'mismatch');
  assert.equal(compare('error', { status: 'infrastructure-failure' }), 'infrastructure-failure');
  assert.equal(classify(positive, observed('success', 'success', 'success', 'success'), false, true).outcome, 'mismatch');
});

test('a declared recovery branch does not pass an unverified export', () => {
  const expected = { ...negative, policy: 'recover_or_corrupt_error', alternativeOpen: 'success', onAlternativeSuccess: { render: 'success' } };
  assert.equal(classify(expected, observed('success', 'success', 'blocked', 'blocked')).outcome, 'alternative-observed');
  assert.equal(classify(expected, observed('success', 'success', 'success', 'success')).outcome, 'mismatch');
  const rejected = observed('error', 'blocked', 'blocked', 'blocked');
  rejected.open.errorKind = 'password-or-encryption';
  assert.equal(classify(expected, rejected).outcome, 'mismatch');
  rejected.open.errorKind = 'corrupt-or-unsupported';
  assert.equal(classify(expected, rejected).outcome, 'expected-rejection');
});

test('reader confirmation, warning, unavailable, and failure are not interchangeable', () => {
  const reader = { pdfinfo: { status: 'success', diagnostics: [] }, qpdf: { status: 'success' }, pageCountMatches: true, rotationMatches: true };
  assert.equal(validationOutcome(reader), 'confirmed');
  assert.equal(validationOutcome({ ...reader, qpdf: { status: 'warning' } }), 'warning');
  assert.equal(validationOutcome({ ...reader, pdfinfo: { status: 'unavailable', diagnostics: [] }, pageCountMatches: null }), 'unconfirmed');
  assert.equal(validationOutcome({ ...reader, qpdf: { status: 'error' } }), 'mismatch');
  assert.equal(validationOutcome({ ...reader, qpdf: { status: 'timeout' } }), 'infrastructure-failure');
  assert.equal(validationOutcome({ ...reader, rotationMatches: false }), 'mismatch');
  assert.equal(validationOutcome({ status: 'blocked' }), 'blocked');
});

test('manifest validation rejects duplicate identities, unsafe paths and absent expectations', () => {
  assert.equal(validateManifest(manifest(fixture(1))).length, 1);
  for (const path of ['../x.pdf', '/x.pdf', 'samples//x.pdf', 'a\\x.pdf', 'a/./x.pdf', 'x:\u0000.pdf']) {
    assert.throws(() => validateManifest(manifest(fixture(1, { path }))));
  }
  assert.throws(() => validateManifest(manifest(fixture(1), fixture(1))));
  assert.throws(() => validateManifest(manifest(fixture(1), fixture(2, { path: 'samples/1.pdf' }))));
  assert.throws(() => validateManifest(manifest(fixture(1, { expected: { ...positive, open: 'not-applicable' } }))));
  assert.throws(() => validateManifest(manifest(fixture(1, { sha256: 'bad' }))));
});

test('all 150 identities must appear once; complete smoke is not a Phase 0 corpus', () => {
  const samples = validateManifest(manifest(...Array.from({ length: 150 }, (_, index) => fixture(index,
    index < 2 ? { category: 'performance', pageCount: index === 0 ? 50 : 500 } : {}))));
  const actual = observed('success', 'success', 'success', 'success');
  const results = samples.map(sample => ({ ...sample, actual, outcome: 'match' }));
  const summary = summarize(samples, results);
  assert.equal(summary.represented, 150);
  assert.equal(summary.phase0Shape, true);
  assert.equal(summary.stageTotals.reopen.success, 150);
  assert.equal(summary.byCategory.performance.match, 2);
  assert.equal(summarize(samples.slice(0, 1), results.slice(0, 1)).phase0Shape, false);
  assert.throws(() => summarize(samples, results.slice(0, -1)), /Missing results/);
  assert.throws(() => summarize(samples, [...results, results[0]]), /duplicate/);
  assert.throws(() => summarize(samples, [{ ...results[0], sha256: 'b'.repeat(64) }, ...results.slice(1)]), /misidentified/);
});

const n = contentSettings.gridSize;
function pixels(marks = [], { width = n, height = n, alpha = 255 } = {}) {
  const bytes = Buffer.alloc(width * height * 4, 255);
  for (let i = 3; i < bytes.length; i += 4) bytes[i] = alpha;
  for (const [x, y, gray = 0] of marks) bytes.fill(gray, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return rasterStats(bytes, width, height);
}
const marks = [[3, 2], [5, 3], [8, 5], [9, 7]];

test('visible ink requires contrast, area and multiple cells; white and transparent pixels are not ink', () => {
  const ref = pixels(marks);
  assert.equal(ref.ink, 4);
  assert.equal(hasMeaningfulInk(ref), true);
  assert.equal(hasMeaningfulInk(pixels(marks.slice(0, 2))), false);
  const size = contentSettings.rasterSize;
  assert.equal(hasMeaningfulInk(pixels(marks, { width: size, height: size })), false);
  const belowContrast = pixels(marks.map(([x, y]) => [x, y, 256 - contentSettings.contrast]));
  assert.equal(belowContrast.ink, 0);
  assert.equal(belowContrast.nonwhite, 4);
  assert.equal(pixels(marks.map(([x, y]) => [x, y, 255 - contentSettings.contrast])).ink, 4);
  assert.equal(pixels(marks, { alpha: 0 }).ink, 0);
  assert.equal(compareContent(ref, pixels()).match, false);
  assert.equal(compareContent(ref, pixels(marks, { alpha: contentSettings.opaqueAlpha - 1 })).match, false);
});

test('coarse raster comparison tolerates neighboring cells but rejects misplaced, missing and excessive content', () => {
  const ref = pixels(marks);
  assert.equal(compareContent(ref, pixels(marks.map(([x, y]) => [x + contentSettings.neighborhood, y]))).match, true);
  assert.equal(compareContent(ref, pixels(marks.map(([x, y]) => [x + 12, y]))).match, false);
  const partial = compareContent(ref, pixels([...marks.slice(0, 2), [17, 17]]));
  assert.equal(partial.recall, 0.5);
  assert.equal(partial.match, false);
  const extras = compareContent(ref, pixels([...marks, [20, 20], [20, 21], [20, 22], [20, 23], [20, 24]]));
  assert.ok(extras.precision < contentSettings.minimumPrecision);
  assert.equal(extras.match, false);
  const dense = Array.from({ length: 25 }, (_, i) => [2 + i % 5, 1 + Math.floor(i / 5)]);
  const excessive = compareContent(pixels([[2, 1], [4, 3], [6, 5], [6, 2]]), pixels(dense));
  assert.ok(excessive.inkRatio > contentSettings.maximumInkRatio);
  assert.equal(excessive.match, false);
  assert.equal(compareContent(ref, pixels(marks, { height: n + 4 })).match, false);
  assert.equal(compareContent(rotatedReference(ref), pixels(marks.map(([x, y]) => [n - 1 - y, x]))).match, true);
  assert.equal(compareContent(rotatedReference(ref), ref).match, false);
});

test('identity scoring uses only unequal channels and treats a tie or negligible signal as ambiguous', () => {
  const target = [0, 100, 128], rival = [100, 0, 128];
  assert.deepEqual(identityScore(target, rival, [0, 100, 255]), { signal: 200 / 3, margin: 1 });
  assert.equal(identityScore(target, rival, rival).margin, -1);
  assert.equal(identityScore(target, rival, [50, 50, 0]).margin, 0);
  assert.deepEqual(identityScore(target, target, rival), { signal: 0, margin: 0 });

  const marked = (gray, count = 8) => pixels(Array.from({ length: count }, (_, i) => [4 + i, 4, gray]));
  const light = marked(180), dark = marked(40), mixed = marked(110);
  const identity = createPageIdentity();
  assert.equal(compareContent(light, dark).match, true);
  assert.equal(identity.compare(light, light, [[2, dark]]).match, true);
  assert.equal(identity.compare(light, dark, [[2, dark]]).identity[0].margin, -1);
  assert.match(identity.compare(light, dark, [[2, dark]]).reason, /favors a different page/);
  assert.match(identity.compare(light, mixed, [[2, dark]]).reason, /does not distinguish/);
  assert.match(identity.compare(light, light, [[2, marked(181)]]).reason, /does not distinguish/);
});

test('identity history survives intervening pages and mismatches, allows identical refs and resets per input', () => {
  const first = pixels(marks), identical = pixels(marks);
  const middle = pixels(marks.map(([x, y]) => [x + 1, y]));
  const last = pixels(marks.map(([x, y]) => [x + 1, y + 1]));
  const identity = createPageIdentity();
  identity.confirm(1, first, first);
  identity.confirm(2, middle, middle);
  assert.equal(identity.compare(last, first).replay.page, 1);
  assert.equal(identity.compare(first, middle).replay.page, 2);
  assert.equal(identity.compare(first, first).match, true);
  assert.equal(identity.compare(identical, first, [[1, first]]).match, true);
  assert.deepEqual(identity.compare(identical, first, [[1, first]]).identity, []);
  assert.equal(createPageIdentity().compare(last, first).match, true);
  const rotated = rotatedReference(first);
  assert.notEqual(rotated.sha256, first.sha256);
  assert.equal(rotated.inputSha256, first.sha256);
  assert.equal(identity.compare(rotated, rotated).match, true);
});

test('blank requires explicit per-page intent and a white, painted canvas', () => {
  const sample = { preservation: { intentionallyBlank: true, pageMarkers: ['marked', null] } };
  assert.equal(expectsBlank(sample, 1), false);
  assert.equal(expectsBlank(sample, 2), true);
  assert.equal(expectsBlank({ preservation: { pageMarkers: [null] } }, 1), false);
  const blank = { ...pixels(), blank: true };
  assert.equal(compareContent(blank, pixels()).match, true);
  assert.equal(compareContent(blank, pixels([], { alpha: 0 })).match, false);
  assert.equal(compareContent(blank, pixels([[0, 0, 254]])).match, false);
  const ppm = Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from([32, 255, 255])]);
  assert.equal(parsePpm(ppm).ink, 1);
  assert.throws(() => parsePpm(ppm.subarray(0, -1)), /dimensions/);
});

test('Chromium: marked and intentional blank pass; opaque-white main canvas fails initial render and reopen', {
  skip: process.env.BASELINE_CHROMIUM !== '1', timeout: 60000,
}, async () => {
  const timeout = 5000;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const corpus = join(root, 'tests/corpus');
  const manifestBytes = await readFile(join(corpus, 'manifest.json'));
  const samples = validateManifest(JSON.parse(manifestBytes));
  const scratch = await mkdtemp(join(tmpdir(), 'baseline-content-test-'));
  const evidence = { status: 'fail', manifestSha256: sha256(manifestBytes), scratch, cases: [] };
  let server, browser;
  try {
    const { files, identity } = await runtimeSnapshot(root, 'bcfda7a');
    evidence.app = identity;
    assert.equal(identity.matchesCommit, true);
    const tools = await detectReaders(timeout);
    evidence.reader = tools.pdftoppm;
    assert.equal(tools.pdftoppm.available, true);
    server = await serveRuntime(files);
    browser = await chromium.launch({ timeout, headless: true });
    evidence.chromium = browser.version();
    for (const [id, whiten] of [['SYN-01', []], ['SYN-12', []], ['SYN-01', [0]], ['SYN-01', [1]], ['SYN-01', [0, 1]]]) {
      const sample = samples.find(item => item.id === id);
      const inputPath = join(corpus, sample.path);
      const input = await readFile(inputPath);
      assert.equal(sha256(input), sample.sha256);
      const temp = await mkdtemp(join(scratch, `${id}-`));
      const { raster, evidence: reference } = await referenceRaster(tools.pdftoppm, sample, inputPath, 1, timeout);
      const result = { id, whiten, inputSha256: sample.sha256, reference, actual: emptyStages(), control: [] };
      evidence.cases.push(result);
      assert.ok(raster, JSON.stringify(reference));
      const setup = {
        async newContext(options) {
          const context = await browser.newContext(options);
          return {
            route: (...args) => context.route(...args), routeWebSocket: (...args) => context.routeWebSocket(...args),
            async newPage() {
              const page = await context.newPage();
              const index = context.pages().length - 1;
              if (whiten.includes(index)) {
                await page.addInitScript(() => {
                  const proto = CanvasRenderingContext2D.prototype;
                  const draw = proto.drawImage;
                  // Replace final pixels on the real visible main canvas only; do not fake reads.
                  proto.drawImage = function (...args) {
                    const value = draw.apply(this, args);
                    if (this.canvas.id === 'canvas') {
                      this.save();
                      this.resetTransform();
                      this.globalAlpha = 1;
                      this.globalCompositeOperation = 'copy';
                      this.fillStyle = '#ffffff';
                      this.fillRect(0, 0, this.canvas.width, this.canvas.height);
                      this.restore();
                      this.canvas.dataset.whiteControlDraws = String(Number(this.canvas.dataset.whiteControlDraws ?? 0) + 1);
                    }
                    return value;
                  };
                });
              }
              return page;
            },
            async close() {
              try {
                for (const index of whiten) {
                  const page = context.pages()[index];
                  if (!page) continue;
                  const stats = await page.locator('#canvas').evaluate(canvas => {
                    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    let nonwhite = 0, transparent = 0;
                    for (let i = 0; i < bytes.length; i += 4) {
                      if (Math.min(bytes[i], bytes[i + 1], bytes[i + 2]) !== 255) nonwhite++;
                      if (bytes[i + 3] !== 255) transparent++;
                    }
                    return { nonwhite, transparent, pixels: bytes.length / 4, draws: Number(canvas.dataset.whiteControlDraws) };
                  });
                  result.control.push({ index, ...stats });
                }
              } finally { await context.close(); }
            },
          };
        },
      };
      await measureUI(setup, server, sample, input, temp, timeout, result, new Map([[1, raster]]));
      Object.assign(result, classify(sample.expected, result.actual));
      assert.equal(result.blockedNetworkRequests, 0);
      assert.equal(result.actual.open.checksMatch, true);
      assert.equal(result.reopenOpen.checksMatch, true);
      assert.equal(result.edit.status, 'success');
      assert.equal(result.actual.save.status, 'success');
      assert.equal(result.control.length, whiten.length);
      for (const { pixels, draws, nonwhite, transparent } of result.control) {
        assert.ok(pixels > 0 && draws > 0);
        assert.equal(nonwhite, 0);
        assert.equal(transparent, 0);
      }
      for (const [index, stage] of ['render', 'reopen'].entries()) {
        const actual = result.actual[stage];
        if (whiten.includes(index)) {
          assert.equal(actual.status, 'error', JSON.stringify(actual));
          assert.equal(actual.lastObservation.opacity, 1);
          assert.equal(actual.lastObservation.nonwhite, 0);
          assert.equal(actual.lastObservation.content.match, false);
          assert.equal(result.comparisons[stage], 'mismatch');
        } else {
          assert.equal(actual.status, 'success', JSON.stringify(actual));
          assert.equal(actual.expectedBlank, id === 'SYN-12');
          assert.equal(actual.content.match, true);
          assert.ok(actual.generation > 0 && actual.stable);
          if (id === 'SYN-12') assert.equal(actual.nonwhite, 0);
          else assert.ok(actual.ink > 0);
        }
      }
      assert.equal(result.outcome, whiten.length ? 'mismatch' : 'match');
    }
    evidence.status = 'pass';
  } catch (error) {
    evidence.error = String(error);
    throw error;
  } finally {
    if (process.env.BASELINE_CONTROL_REPORT) {
      await writeFile(process.env.BASELINE_CONTROL_REPORT, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    await browser?.close();
    await server?.close();
  }
});

// A separate test-only document, not a corpus mutation or a reader-produced PDF.
// Pages 1 and 2 are different page objects sharing one visible appearance.
function identicalPageControl() {
  const stream = commands => `<< /Length ${commands.length} >>\nstream\n${commands}endstream`;
  const page = ref => `<< /Type /Page /Parent 2 0 R /Contents ${ref} 0 R >>`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] /MediaBox [0 0 300 400] /Resources << >> >>',
    page(6), page(6), page(7), stream('0.2 0.3 0.7 rg 30 230 95 110 re f\n'),
    stream('0.7 0.3 0.2 rg 160 30 95 110 re f\n')];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`);
}

function replayCanvas(browser, replay, result) {
  return { async newContext(options) {
    const context = await browser.newContext(options);
    // First app page only. Change pixels after actual draws, not selectors, readbacks or references.
    return {
      route: (...args) => context.route(...args), routeWebSocket: (...args) => context.routeWebSocket(...args),
      async newPage() {
        const page = await context.newPage();
        if (context.pages().length === 1) await page.addInitScript(plan => {
          const draw = CanvasRenderingContext2D.prototype.drawImage;
          const cache = new Map();
          window.baselineReplayEvents = [];
          CanvasRenderingContext2D.prototype.drawImage = function (...args) {
            const value = draw.apply(this, args);
            if (this.canvas.id !== 'canvas') return value;
            const selected = Number(document.querySelector('#page-number').value);
            const source = cache.get(plan[selected]);
            if (source && source.width === this.canvas.width && source.height === this.canvas.height) {
              this.putImageData(source, 0, 0);
              window.baselineReplayEvents.push({ selected, source: plan[selected] });
            } else if (!cache.has(selected)) {
              cache.set(selected, this.getImageData(0, 0, this.canvas.width, this.canvas.height));
            }
            return value;
          };
        }, replay);
        return page;
      },
      async close() {
        try { result.events = await context.pages()[0].evaluate(() => window.baselineReplayEvents); }
        finally { await context.close(); }
      },
    };
  } };
}

test('Chromium: rejects direct and nonadjacent raster replays, accepts normal returns and identical pages', {
  skip: process.env.BASELINE_CHROMIUM !== '1', timeout: 60000,
}, async () => {
  const timeout = 5000;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const corpus = join(root, 'tests/corpus');
  const manifestBytes = await readFile(join(corpus, 'manifest.json'));
  const real = validateManifest(JSON.parse(manifestBytes)).find(item => item.id === 'PER-01');
  const scratch = await mkdtemp(join(tmpdir(), 'baseline-navigation-test-'));
  const evidence = { status: 'fail', manifestSha256: sha256(manifestBytes), scratch, cases: [] };
  let server, browser;
  try {
    const { files, identity } = await runtimeSnapshot(root, 'bcfda7a');
    evidence.app = identity;
    assert.equal(identity.matchesCommit, true);
    const tools = await detectReaders(timeout);
    evidence.reader = tools.pdftoppm;
    assert.equal(tools.pdftoppm.available, true);
    server = await serveRuntime(files);
    browser = await chromium.launch({ timeout, headless: true });
    evidence.chromium = browser.version();
    const duplicatePath = join(scratch, 'identical.pdf');
    const duplicateInput = identicalPageControl();
    const duplicate = fixture('identical', { category: 'performance', path: 'identical.pdf', pageCount: 3,
      sha256: sha256(duplicateInput), bytes: duplicateInput.length });
    await writeFile(duplicatePath, duplicateInput);
    for (const [sample, path, trials] of [[real, join(corpus, real.path), [
      ['normal', {}, {}], ['direct', { 25: 1 }, { middlePage: 1 }],
      ['nonadjacent', { 50: 1, 1: 25 }, { lastPage: 1, returnToFirst: 25 }],
    ]], [duplicate, duplicatePath, [['identical', {}, {}], ['identical-replay', { 2: 1 }, {}]]]]) {
      const input = await readFile(path);
      assert.equal(sha256(input), sample.sha256);
      const references = new Map(), independent = [];
      const [first, middle, last] = performancePages(sample);
      for (const number of [first, middle, last]) {
        const { raster, evidence: ref } = await referenceRaster(tools.pdftoppm, sample, path, number, timeout);
        assert.ok(raster, JSON.stringify(ref));
        references.set(number, raster);
        independent.push(ref);
      }
      assert.equal(new Set(independent.map(ref => ref.sha256)).size, sample === real ? 3 : 2);
      if (sample === duplicate) assert.equal(references.get(1).sha256, references.get(2).sha256);
      for (const [name, replay, failures] of trials) {
        const result = { name, id: sample.id, inputSha256: sample.sha256, independent, replay, actual: emptyStages() };
        evidence.cases.push(result);
        await measureUI(replayCanvas(browser, replay, result), server, sample, input, await mkdtemp(join(scratch, `${name}-`)),
          timeout, result, references);
        assert.deepEqual([...new Set(result.events.map(({ selected, source }) => `${source}->${selected}`))].sort(),
          Object.entries(replay).map(([selected, source]) => `${source}->${selected}`).sort());
        assert.equal(result.blockedNetworkRequests, 0);
        for (const step of [...Object.values(result.actual), result.edit]) assert.equal(step.status, 'success', JSON.stringify(step));
        const confirmed = new Map([[first, result.actual.render], [middle, result.middlePage], [last, result.lastPage]]);
        for (const [stage, number] of [['middlePage', middle], ['lastPage', last], ['returnToFirst', first]]) {
          const measurement = result[stage];
          if (failures[stage]) {
            const source = failures[stage];
            assert.equal(measurement.status, 'error', JSON.stringify(measurement));
            assert.equal(measurement.lastObservation.selected, number);
            assert.equal(measurement.lastObservation.stable, true);
            assert.equal(measurement.lastObservation.rasterSha256, confirmed.get(source).rasterSha256);
            assert.equal(measurement.lastObservation.content.replay.page, source);
          } else {
            assert.equal(measurement.status, 'success', JSON.stringify(measurement));
            assert.equal(measurement.page, number);
          }
        }
        if (!failures.returnToFirst) assert.equal(result.returnToFirst.rasterSha256, result.actual.render.rasterSha256);
        if (sample === duplicate) assert.equal(result.middlePage.rasterSha256, result.actual.render.rasterSha256);
        Object.assign(result, classify(sample.expected, result.actual, false,
          [result.middlePage, result.lastPage, result.returnToFirst].some(step => step.status === 'error')));
        assert.equal(result.outcome, Object.keys(failures).length ? 'mismatch' : 'match');
      }
    }
    evidence.status = 'pass';
  } catch (error) {
    evidence.error = String(error);
    throw error;
  } finally {
    if (process.env.BASELINE_NAVIGATION_REPORT) {
      await writeFile(process.env.BASELINE_NAVIGATION_REPORT, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    await browser?.close();
    await server?.close();
  }
});
