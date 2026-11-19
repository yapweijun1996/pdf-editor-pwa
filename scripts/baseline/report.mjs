import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const stages = ['open', 'render', 'save', 'reopen'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.samples) || !manifest.samples.length) {
    throw new Error('Expected a nonempty version 1 corpus manifest');
  }
  const ids = new Set();
  const paths = new Set();
  for (const sample of manifest.samples) {
    const { id, path, category, bytes, sha256: hash, source, license, expected, pageCount } = sample ?? {};
    if (typeof id !== 'string' || !id.trim() || ids.has(id) ||
        typeof path !== 'string' || paths.has(path) || posix.isAbsolute(path) ||
        /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof category !== 'string' || !category.trim() ||
        !Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/.test(hash) ||
        source?.type !== 'self-generated' || !source.generator || !source.recipe || license !== 'CC0-1.0' ||
        !(pageCount === null || Number.isSafeInteger(pageCount) && pageCount > 0) ||
        stages.some(stage => !['success', 'error', ...(stage === 'open' ? [] : ['not-applicable'])].includes(expected?.[stage]))) {
      throw new Error(`Invalid or duplicate manifest sample: ${JSON.stringify(id)}`);
    }
    ids.add(id);
    paths.add(path);
  }
  return manifest.samples;
}

export function compare(expected, actual) {
  if (['timeout', 'infrastructure-failure'].includes(actual.status)) return 'infrastructure-failure';
  if (expected === 'not-applicable') return actual.status === 'blocked' ? 'not-applicable' : 'mismatch';
  if (expected !== actual.status || actual.checksMatch === false) return 'mismatch';
  return expected === 'error' ? 'expected-rejection' : 'match';
}

export function validationOutcome(reader) {
  if (reader.status === 'blocked') return 'blocked';
  const { pdfinfo, qpdf, pageCountMatches, rotationMatches } = reader;
  if ([pdfinfo.status, qpdf.status].includes('error') || pageCountMatches === false || rotationMatches === false) return 'mismatch';
  if ([pdfinfo.status, qpdf.status].some(status => ['infrastructure-failure', 'timeout'].includes(status))) return 'infrastructure-failure';
  if (qpdf.status === 'warning' || pdfinfo.diagnostics?.length) return 'warning';
  if (pdfinfo.status !== 'success' || pageCountMatches !== true || rotationMatches !== true) return 'unconfirmed';
  return 'confirmed';
}

export function classify(expected, actual, infrastructureFailure = false, supplementalMismatch = false) {
  const alternative = expected.alternativeOpen === 'success' && actual.open.status === 'success';
  const target = alternative ? { open: 'success', render: expected.onAlternativeSuccess?.render,
    save: 'not-applicable', reopen: 'not-applicable' } : expected;
  const comparisons = Object.fromEntries(stages.map(stage => [stage, compare(target[stage], actual[stage])]));
  const text = actual.open.uiMessage ?? '';
  if (!alternative && comparisons.open === 'expected-rejection' &&
      ((expected.policy === 'password_error' && !/password/i.test(text)) ||
       (['recover_or_corrupt_error', 'corrupt_error'].includes(expected.policy) && actual.open.errorKind !== 'corrupt-or-unsupported') ||
       (expected.policy === 'observe_encryption_policy' && !/encrypt|permission|restrict|password/i.test(text)))) {
    comparisons.open = 'mismatch';
  }
  const values = Object.values(comparisons);
  const outcome = infrastructureFailure || values.includes('infrastructure-failure') ? 'infrastructure-failure'
    : supplementalMismatch || values.includes('mismatch') ? 'mismatch'
      : alternative ? 'alternative-observed' : values.includes('expected-rejection') ? 'expected-rejection' : 'match';
  return { comparisons, outcome };
}

export function summarize(samples, results) {
  const byCategory = new Map();
  const emptyCounts = () => ({ match: 0, 'expected-rejection': 0, 'alternative-observed': 0, mismatch: 0, 'infrastructure-failure': 0 });
  const totals = emptyCounts();
  const stageTotals = Object.fromEntries(stages.map(stage => [stage, Object.create(null)]));
  const validationTotals = Object.create(null);
  const expected = new Map(samples.map(sample => [sample.id, sample]));
  if (expected.size !== samples.length) throw new Error('Duplicate sample ID');
  for (const result of results) {
    const sample = expected.get(result.id);
    if (!sample || sample.category !== result.category || sample.path !== result.path || sample.sha256 !== result.sha256) {
      throw new Error(`Unexpected, duplicate or misidentified result: ${result.id}`);
    }
    expected.delete(result.id);
    if (!Object.hasOwn(totals, result.outcome)) throw new Error(`Unknown outcome for ${result.id}`);
    const counts = byCategory.get(sample.category) ?? emptyCounts();
    counts[result.outcome]++;
    byCategory.set(sample.category, counts);
    totals[result.outcome]++;
    const validation = result.validation;
    if (validation) validationTotals[validation] = (validationTotals[validation] ?? 0) + 1;
    for (const stage of stages) {
      const status = result.actual[stage].status;
      stageTotals[stage][status] = (stageTotals[stage][status] ?? 0) + 1;
    }
  }
  if (expected.size) throw new Error(`Missing results: ${[...expected.keys()].join(', ')}`);
  return {
    manifestEntries: samples.length,
    represented: results.length,
    complete: true,
    phase0Shape: samples.length === 150 && [50, 500].every(pages =>
      samples.some(sample => sample.category === 'performance' && sample.pageCount === pages)),
    totals,
    stageTotals,
    validationTotals,
    byCategory: Object.fromEntries(byCategory),
  };
}
