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

const terminal = new Set(['success', 'error', 'warning', 'blocked']);
const stopped = step => ['error', 'timeout', 'infrastructure-failure'].includes(step?.status);
const succeeded = step => step?.status === 'success';
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function compare(expected, actual, evidence = true) {
  if (!terminal.has(actual?.status)) return 'infrastructure-failure';
  if (actual.status === 'blocked') return ['blocked', 'not-applicable'].includes(expected)
    ? expected : 'infrastructure-failure';
  if (expected !== actual.status || actual.checksMatch === false || evidence === false) return 'mismatch';
  if (evidence !== true) return 'infrastructure-failure';
  return expected === 'error' ? 'expected-rejection' : 'match';
}

export function navigationPlan(sample) {
  if (sample.category !== 'performance' || !(sample.pageCount > 1)) return {};
  return { ...(sample.pageCount > 2 ? { middlePage: Math.ceil(sample.pageCount / 2) } : {}),
    lastPage: sample.pageCount, returnToFirst: 1 };
}

const openEvidence = (step, pages) => !succeeded(step) || (step.checksMatch === false ||
  (positiveInteger(step.pages) && pages != null && step.pages !== pages) ? false
  : step.checksMatch === true && positiveInteger(step.pages) ? true : null);
const paintEvidence = (step, page) => !succeeded(step) || (step.content?.match === false || step.stable === false ||
  (positiveInteger(step.page) && step.page !== page) ? false
  : step.content?.match === true && step.stable === true && step.page === page ? true : null);

export function validationOutcome(reader) {
  if (reader?.status === 'blocked') return 'blocked';
  if (reader?.status != null) return reader.status === 'error' ? 'mismatch' : 'infrastructure-failure';
  const tools = [reader?.inputInfo, reader?.pdfinfo, reader?.qpdf];
  if (tools.some((step, index) => !['success', 'error', ...(index === 2 ? ['warning'] : [])].includes(step?.status))) {
    return 'infrastructure-failure';
  }
  if (tools.some(step => step.status === 'error') || reader.pageCountMatches === false || reader.rotationMatches === false) {
    return 'mismatch';
  }
  if (reader.pageCountMatches !== true || reader.rotationMatches !== true) return 'unconfirmed';
  if (reader.qpdf.status === 'warning' || reader.pdfinfo.diagnostics?.length || reader.inputInfo.diagnostics?.length) return 'warning';
  return 'confirmed';
}

export function classify(sample, result) {
  const { expected, pageCount } = sample;
  const { open, render, save, reopen } = result.actual ?? {};
  const { recovery, edit, reopenOpen, reopenRender, secondReader } = result;
  const alternative = expected.alternativeOpen === 'success' && succeeded(open);
  const target = alternative ? { open: 'success', render: expected.onAlternativeSuccess?.render,
    save: 'not-applicable', reopen: 'not-applicable' } : expected;
  // A recorded upstream failure can explain a downstream block, never a missing record
  // or a downstream failure. Render disagreement does not cancel the export probe.
  const downstream = (expectation, prerequisiteFailed) => expectation === 'not-applicable' ? expectation
    : prerequisiteFailed ? 'blocked' : expectation;
  const comparisons = {
    open: compare(target.open, open, openEvidence(open, pageCount)),
    render: compare(downstream(target.render, stopped(open)), render, paintEvidence(render, 1)),
    save: compare(downstream(target.save, stopped(open)), save, !succeeded(save) ||
      (positiveInteger(save.bytes) && /^[a-f0-9]{64}$/.test(save.sha256 ?? '') ? true : null)),
    reopen: compare(downstream(target.reopen, stopped(open) || stopped(save) || save?.status === 'blocked'), reopen),
  };
  const text = open?.uiMessage ?? '';
  if (comparisons.open === 'expected-rejection' &&
      ((expected.policy === 'password_error' && !/password/i.test(text)) ||
       (['recover_or_corrupt_error', 'corrupt_error'].includes(expected.policy) && open.errorKind !== 'corrupt-or-unsupported') ||
       (expected.policy === 'observe_encryption_policy' && !/encrypt|permission|restrict|password/i.test(text)))) {
    comparisons.open = 'mismatch';
  }
  const needsEdit = succeeded(open) && target.save === 'success';
  if (needsEdit || edit != null) comparisons.edit = compare(needsEdit ? 'success' : 'not-applicable', edit);
  if (succeeded(save) || reopenOpen != null || reopenRender != null) {
    comparisons.reopenOpen = compare(succeeded(save) ? 'success' : 'not-applicable', reopenOpen, openEvidence(reopenOpen, open?.pages));
    comparisons.reopenRender = compare(succeeded(save) ? downstream('success', stopped(reopenOpen)) : 'not-applicable',
      reopenRender, paintEvidence(reopenRender, 1));
  }
  const validation = validationOutcome(secondReader);
  comparisons.secondReader = succeeded(save) ? ({ confirmed: 'match', mismatch: 'mismatch', warning: 'mismatch' })[validation] ?? 'infrastructure-failure'
    : ['confirmed', 'mismatch', 'warning'].includes(validation) ? 'mismatch' : compare('blocked', secondReader);

  const recoveryRequired = open?.status === 'error' &&
    (expected.open === 'error' || expected.probeKnownGoodAfterRejection === true || recovery != null);
  if (recoveryRequired || recovery != null) {
    const recoveryOpen = recovery?.open;
    if (recovery?.status != null) comparisons.recovery = compare(recoveryRequired ? 'success' : 'not-applicable', recovery, null);
    comparisons.recoveryOpen = compare(recoveryRequired ? 'success' : 'not-applicable', recoveryOpen,
      typeof recovery?.id === 'string' && recovery.id.trim() && positiveInteger(recovery.expectedPages)
        ? openEvidence(recoveryOpen, recovery.expectedPages) : null);
    comparisons.recoveryRender = compare(recoveryRequired ? downstream('success', stopped(recoveryOpen)) : 'not-applicable',
      recovery?.render, paintEvidence(recovery?.render, 1));
  }

  const planned = navigationPlan(sample);
  // The browser navigates only after a confirmed first page and page count.
  const navBlocked = stopped(open) || stopped(render) || openEvidence(open, pageCount) === false;
  for (const stage of ['middlePage', 'lastPage', 'returnToFirst']) {
    if (planned[stage] || result[stage] != null) {
      comparisons[stage] = compare(planned[stage] ? downstream('success', navBlocked) : 'not-applicable',
        result[stage], paintEvidence(result[stage], planned[stage]));
    }
  }
  const values = Object.values(comparisons);
  const outcome = result.infrastructure || result.blockedNetworkRequests || result.saveConfirmation || values.includes('infrastructure-failure')
    ? 'infrastructure-failure' : values.includes('mismatch') ? 'mismatch'
      : alternative ? 'alternative-observed' : comparisons.open === 'expected-rejection' ? 'expected-rejection' : 'match';
  return { comparisons, validation, outcome };
}

export function reportExitCode(summary, infrastructureIssues, strict) {
  if (summary.totals['infrastructure-failure'] || infrastructureIssues.length) return 2;
  return strict && summary.totals.mismatch ? 3 : 0;
}

export function summarize(samples, results) {
  const byCategory = new Map();
  const emptyCounts = () => ({ match: 0, 'expected-rejection': 0, 'alternative-observed': 0, mismatch: 0, 'infrastructure-failure': 0 });
  const totals = emptyCounts();
  const stageTotals = Object.create(null);
  const comparisonTotals = Object.create(null);
  const validationTotals = Object.create(null);
  const count = (table, key) => { table[key] = (table[key] ?? 0) + 1; };
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
    count(validationTotals, result.validation);
    const supplemental = { ...result, recoveryOpen: result.recovery?.open, recoveryRender: result.recovery?.render };
    for (const [stage, comparison] of Object.entries(result.comparisons)) {
      const status = stage === 'secondReader' ? result.validation : (result.actual?.[stage] ?? supplemental[stage])?.status ?? 'missing';
      count(stageTotals[stage] ??= Object.create(null), status);
      count(comparisonTotals[stage] ??= Object.create(null), comparison);
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
    comparisonTotals,
    validationTotals,
    byCategory: Object.fromEntries(byCategory),
  };
}
