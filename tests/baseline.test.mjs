import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, compare, stages, summarize, validateManifest, validationOutcome } from '../scripts/baseline/report.mjs';

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
