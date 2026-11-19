import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { emptyStages, measureUI, performancePages } from '../scripts/baseline/browser.mjs';
import { compareContent, contentSettings, createPageIdentity, expectsBlank, hasMeaningfulInk, identityScore,
  parsePpm, rasterStats, rotatedReference } from '../scripts/baseline/content.mjs';
import { checkOutput, detectReaders, referenceRaster } from '../scripts/baseline/readers.mjs';
import { classify, reportExitCode, sha256, stages, summarize, validateManifest, validationOutcome } from '../scripts/baseline/report.mjs';
import { runtimeSnapshot, serveRuntime } from '../scripts/baseline/runtime.mjs';

const positive = Object.fromEntries(stages.map(stage => [stage, 'success']));
const negative = { open: 'error', render: 'not-applicable', save: 'not-applicable', reopen: 'not-applicable' };
const status = status => ({ status });
const success = status('success'), blocked = status('blocked'), error = status('error');
const opened = (pages = 1) => ({ ...success, checksMatch: true, pages });
const painted = (page = 1) => ({ ...success, content: { match: true }, stable: true, page });
const downloaded = { ...success, bytes: 10, sha256: 'a'.repeat(64) };
const reader = { inputInfo: success, pdfinfo: success, qpdf: success, pageCountMatches: true, rotationMatches: true };
const healthy = (pages = 1) => structuredClone({ actual: { open: opened(pages), render: painted(), save: downloaded, reopen: painted() },
  reopenOpen: opened(pages), reopenRender: painted(), edit: success, secondReader: reader });
const rejected = () => structuredClone({ actual: { open: { ...error, errorKind: 'corrupt-or-unsupported', uiMessage: 'Corrupt or unsupported PDF.' },
  render: blocked, save: blocked, reopen: blocked }, edit: blocked, secondReader: blocked,
  recovery: { id: 'known-good', expectedPages: 1, open: opened(), render: painted() } });
const fixture = (index, more = {}) => ({ id: `case-${index}`, category: 'synthetic', path: `samples/${index}.pdf`,
  sha256: 'a'.repeat(64), bytes: 10, source: { type: 'self-generated', generator: 'test', recipe: 'unit' },
  license: 'CC0-1.0', expected: positive, pageCount: 1, ...more });
const manifest = (...samples) => ({ schemaVersion: 1, samples });

const negativeSample = fixture('negative', { expected: { ...negative, probeKnownGoodAfterRejection: true, policy: 'corrupt_error' } });
const alternative = { ...negativeSample, expected: { ...negativeSample.expected, policy: 'recover_or_corrupt_error',
  alternativeOpen: 'success', onAlternativeSuccess: { render: 'success' } } };
const perfSample = fixture('performance', { category: 'performance', pageCount: 50 });
const navigated = () => ({ ...healthy(50), middlePage: painted(25), lastPage: painted(50), returnToFirst: painted() });

test('every required stage rejects missing, blocked, unavailable, unknown, timeout and observed error', () => {
  const cases = [
    ...stages.map(key => [fixture(1), healthy, 'actual', key]),
    ...['edit', 'reopenOpen', 'reopenRender'].map(key => [fixture(1), healthy, null, key]),
    ...['open', 'render'].map(key => [negativeSample, rejected, 'recovery', key]),
    ...['middlePage', 'lastPage', 'returnToFirst'].map(key => [perfSample, navigated, null, key]),
    ...['inputInfo', 'pdfinfo', 'qpdf'].map(key => [fixture(1), healthy, 'secondReader', key]),
  ];
  for (const [sample, make, parent, key] of cases) {
    const name = parent === 'recovery' ? `recovery${key === 'open' ? 'Open' : 'Render'}` : parent === 'secondReader' ? parent : key;
    for (const value of [undefined, {}, status('unavailable'), status('not-attempted'), status('unknown'), blocked,
      status('timeout'), status('infrastructure-failure'), error, { ...success, checksMatch: false }]) {
      if (parent === 'secondReader' && value?.checksMatch === false) continue; // Reader comparisons use count and rotation flags.
      const row = make();
      const entry = parent ? row[parent] : row;
      if (value === undefined) delete entry[key];
      else entry[key] = value;
      if (key === 'open' && parent === 'recovery' && value?.status === 'error') row.recovery.render = blocked;
      const { comparisons, outcome } = classify(sample, row);
      const expected = value?.status === 'error' || value?.checksMatch === false ? 'mismatch' : 'infrastructure-failure';
      assert.equal(comparisons[name], expected, `${parent}.${key} ${JSON.stringify(value)}`);
      assert.ok(['mismatch', 'infrastructure-failure'].includes(outcome), `${parent}.${key} falsely passed`);
    }
  }
});

test('dependencies explain explicit blocks, not omitted, contradictory or failed evidence', () => {
  const positiveSample = fixture(1);
  const notOpened = { actual: { open: error, render: blocked, save: blocked, reopen: blocked }, edit: blocked, secondReader: blocked };
  const notSaved = { ...healthy(), reopenOpen: undefined, reopenRender: undefined, secondReader: blocked };
  Object.assign(notSaved.actual, { save: error, reopen: blocked });
  const notReopened = healthy();
  Object.assign(notReopened, { reopenOpen: error, reopenRender: blocked });
  notReopened.actual.reopen = error;
  for (const row of [notOpened, notSaved, notReopened]) assert.equal(classify(positiveSample, row).outcome, 'mismatch');
  assert.equal(classify(positiveSample, { ...notReopened, reopenRender: undefined }).outcome, 'infrastructure-failure');
  for (const [stage, change, expected] of [
    ['open', { pages: 9 }, 'mismatch'], ['open', { checksMatch: undefined }, 'infrastructure-failure'],
    ['render', { stable: false }, 'mismatch'], ['render', { content: undefined }, 'infrastructure-failure'],
    ['save', { bytes: 0 }, 'infrastructure-failure'], ['save', { sha256: undefined }, 'infrastructure-failure'],
  ]) {
    const row = healthy();
    Object.assign(row.actual[stage], change);
    assert.equal(classify(positiveSample, row).outcome, expected, stage);
  }
  const wrongPage = navigated();
  wrongPage.lastPage = painted(25);
  assert.equal(classify(perfSample, wrongPage).comparisons.lastPage, 'mismatch');
});

test('negative and alternative paths keep the rejection and audit the selected follow-up', () => {
  for (const sample of [negativeSample, alternative]) {
    assert.equal(classify(sample, rejected()).outcome, 'expected-rejection');
    for (const recovery of [undefined, blocked, { status: 'success' }, { ...rejected().recovery, id: undefined },
      { ...rejected().recovery, status: 'timeout' }]) {
      assert.equal(classify(sample, { ...rejected(), recovery }).outcome, 'infrastructure-failure');
    }
    const row = rejected();
    row.actual.open.errorKind = 'app-error';
    assert.equal(classify(sample, row).outcome, 'mismatch');
    row.actual.open = status('timeout');
    delete row.recovery;
    assert.equal(classify(sample, row).outcome, 'infrastructure-failure');
  }
  for (const [recovery, failed] of [
    [{ ...rejected().recovery, open: error, render: blocked }, 'recoveryOpen'],
    [{ ...rejected().recovery, open: opened(9) }, 'recoveryOpen'],
    [{ ...rejected().recovery, render: error }, 'recoveryRender'],
    [{ ...rejected().recovery, status: 'error' }, 'recovery'],
  ]) {
    const result = classify(alternative, { ...rejected(), recovery });
    assert.equal(result.outcome, 'mismatch');
    assert.equal(result.comparisons.open, 'expected-rejection');
    assert.equal(result.comparisons[failed], 'mismatch');
  }
  const accepted = { actual: { open: opened(), render: painted(), save: blocked, reopen: blocked }, secondReader: blocked };
  assert.equal(classify(alternative, accepted).outcome, 'alternative-observed');
  assert.equal(classify(alternative, { ...accepted, recovery: { ...rejected().recovery, render: error } }).outcome, 'mismatch');
  for (const render of [blocked, undefined, error, { ...painted(), content: { match: false } }]) {
    assert.notEqual(classify(alternative, { ...accepted, actual: { ...accepted.actual, render } }).outcome, 'alternative-observed');
  }
});

test('reader warnings cannot mask unknown required checks or become infrastructure errors by themselves', () => {
  const sample = fixture(1);
  for (const [secondReader, validation, outcome] of [
    [reader, 'confirmed', 'match'], [{ ...reader, qpdf: status('warning') }, 'warning', 'mismatch'],
    [{ ...reader, qpdf: status('warning'), rotationMatches: null }, 'unconfirmed', 'infrastructure-failure'],
    [{ ...reader, qpdf: status('error'), pdfinfo: status('timeout') }, 'infrastructure-failure', 'infrastructure-failure'],
    [{ ...reader, rotationMatches: false }, 'mismatch', 'mismatch'], [blocked, 'blocked', 'infrastructure-failure'],
    [{ ...reader, status: 'error' }, 'mismatch', 'mismatch'],
    [{ ...reader, status: 'timeout' }, 'infrastructure-failure', 'infrastructure-failure'],
    [undefined, 'infrastructure-failure', 'infrastructure-failure'],
  ]) {
    assert.equal(validationOutcome(secondReader), validation);
    assert.equal(classify(sample, { ...healthy(), secondReader }).outcome, outcome);
  }
  assert.equal(reportExitCode({ totals: { mismatch: 1 } }, [], false), 0);
  assert.equal(reportExitCode({ totals: { mismatch: 1 } }, [], true), 3);
  for (const strict of [false, true]) {
    assert.equal(reportExitCode({ totals: { mismatch: 1, 'infrastructure-failure': 1 } }, [], strict), 2);
    assert.equal(reportExitCode({ totals: {} }, ['shutdown failed'], strict), 2);
  }
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
  const results = samples.map(sample => {
    const row = sample.category === 'performance'
      ? { ...healthy(sample.pageCount), middlePage: painted(sample.pageCount / 2), lastPage: painted(sample.pageCount), returnToFirst: painted() }
      : healthy();
    return { ...sample, ...row, ...classify(sample, row) };
  });
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
      result.secondReader = await checkOutput(tools, inputPath, join(temp, 'download.pdf'), result.actual.open.pages,
        result.edit.status === 'success', timeout);
      Object.assign(result, classify(sample, result));
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

// Serialized into a child-process preload. Change pixels only after the public
// chooser submits the known-good file in the negative trial's context.
function interceptRecoveryDraw(chromium) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await launch(...args);
    const newContext = browser.newContext.bind(browser);
    let trial = 0;
    browser.newContext = async (...options) => {
      const context = await newContext(...options);
      if (++trial === 2) await context.addInitScript(() => {
        let recovering = false;
        document.addEventListener('change', event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
            recovering = event.target.files[0]?.name === 'SYN-02.pdf';
          }
        }, true);
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          const result = Reflect.apply(draw, this, args);
          if (recovering && this.canvas.id === 'canvas') {
            this.save();
            this.resetTransform();
            this.globalAlpha = 1;
            this.globalCompositeOperation = 'copy';
            this.fillStyle = '#fff';
            this.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.restore();
          }
          return result;
        };
      });
      return context;
    };
    return browser;
  };
}

test('Chromium runner: a true rejection cannot hide failed or missing known-good recovery', {
  skip: process.env.BASELINE_CHROMIUM !== '1', timeout: 110000,
}, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const corpus = join(root, 'tests/corpus');
  const all = validateManifest(JSON.parse(await readFile(join(corpus, 'manifest.json'))));
  const samples = ['SYN-02', 'BAD-10'].map(id => all.find(sample => sample.id === id));
  const scratch = await mkdtemp(join(tmpdir(), 'baseline-recovery-test-'));
  const preload = join(scratch, 'recovery-preload.mjs');
  const pair = join(scratch, 'pair.json'), negativeOnly = join(scratch, 'negative-only.json');
  const evidence = { status: 'fail', scratch, cases: [] };
  try {
    await mkdir(join(scratch, 'samples'));
    for (const sample of samples) {
      const input = await readFile(join(corpus, sample.path));
      assert.equal(sha256(input), sample.sha256);
      await writeFile(join(scratch, sample.path), input);
    }
    await writeFile(pair, JSON.stringify(manifest(...samples)));
    await writeFile(negativeOnly, JSON.stringify(manifest(samples[1])));
    await writeFile(preload, `import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};\n(${interceptRecoveryDraw})(chromium);\n`);
    for (const [name, whiten, strict, missing, outcome, exit] of [
      ['healthy-measurement', false, false, false, 'expected-rejection', 0],
      ['healthy-strict', false, true, false, 'expected-rejection', 0],
      ['white-measurement', true, false, false, 'mismatch', 0],
      ['white-strict', true, true, false, 'mismatch', 3],
      ['no-control', false, false, true, 'infrastructure-failure', 2],
    ]) {
      const output = join(scratch, `${name}.json`);
      const args = [...(whiten ? ['--import', preload] : []), 'scripts/baseline/run.mjs',
        '--manifest', missing ? negativeOnly : pair, '--output', output, '--timeout', '3500', ...(strict ? ['--strict'] : [])];
      const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 22000,
        env: { ...process.env, TMPDIR: scratch } });
      evidence.cases.push({ name, cwd: root, TMPDIR: scratch, command: [process.execPath, ...args], exit: child.status,
        signal: child.signal, stdout: child.stdout, stderr: child.stderr, report: output });
      assert.ifError(child.error);
      assert.equal(child.status, exit, child.stderr);
      const report = JSON.parse(await readFile(output));
      assert.equal(report.mode, strict ? 'strict' : 'measurement');
      assert.deepEqual(report.results.map(row => row.id), missing ? ['BAD-10'] : ['SYN-02', 'BAD-10']);
      if (!missing) assert.equal(report.results[0].outcome, 'match');
      const row = report.results.at(-1);
      assert.equal(row.actual.open.status, 'error');
      assert.equal(row.comparisons.open, 'expected-rejection');
      assert.equal(row.outcome, outcome);
      assert.equal(report.summary.totals[outcome], 1);
      assert.equal(report.summary.totals['expected-rejection'], Number(!whiten && !missing));
      assert.equal(report.summary.totals.mismatch, Number(whiten));
      assert.equal(report.summary.totals['infrastructure-failure'], Number(missing));
      if (missing) {
        assert.equal(row.recovery.open.status, 'blocked');
        assert.match(row.recovery.open.reason, /No previously confirmed control/);
        assert.equal(row.comparisons.recoveryOpen, 'infrastructure-failure');
        assert.equal(report.summary.stageTotals.recoveryOpen.blocked, 1);
      } else {
        assert.equal(row.recovery.id, 'SYN-02');
        assert.equal(row.comparisons.recoveryOpen, 'match');
        assert.equal(row.recovery.render.status, whiten ? 'error' : 'success');
        assert.equal(report.summary.comparisonTotals.recoveryRender[whiten ? 'mismatch' : 'match'], 1);
        if (whiten) {
          const observed = row.recovery.render.lastObservation;
          assert.equal(observed.opacity, 1);
          assert.equal(observed.nonwhite, 0);
          assert.equal(observed.content.match, false);
          assert.match(child.stderr, /BAD-10: mismatch .*recoveryRender=mismatch/);
        } else assert.ok(row.recovery.render.ink > 0);
      }
    }
    evidence.status = 'pass';
  } catch (error) {
    evidence.error = String(error);
    throw error;
  } finally {
    if (process.env.BASELINE_RECOVERY_REPORT) {
      await writeFile(process.env.BASELINE_RECOVERY_REPORT, `${JSON.stringify(evidence, null, 2)}\n`);
    }
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
        const temp = await mkdtemp(join(scratch, `${name}-`));
        await measureUI(replayCanvas(browser, replay, result), server, sample, input, temp, timeout, result, references);
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
        result.secondReader = await checkOutput(tools, path, join(temp, 'download.pdf'), result.actual.open.pages,
          result.edit.status === 'success', timeout);
        Object.assign(result, classify(sample, result));
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
