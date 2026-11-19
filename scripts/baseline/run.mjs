import { mkdir, mkdtemp, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, tmpdir, totalmem, version } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { blocked, emptyStages, measureUI, message, performancePages, viewport, within } from './browser.mjs';
import { checkOutput, detectReaders, referenceRaster } from './readers.mjs';
import { contentSettings } from './content.mjs';
import { classify, navigationPlan, reportExitCode, sha256, stages, summarize, validateManifest } from './report.mjs';
import { runtimeSnapshot, serveRuntime } from './runtime.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const inside = (folder, path) => {
  const remainder = relative(folder, path);
  return remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
};
const harnessFiles = ['run', 'browser', 'content', 'readers', 'report', 'runtime'];

async function main() {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string', default: join(root, 'tests/corpus/manifest.json') },
    output: { type: 'string', default: join(root, 'docs/baseline/results.json') },
    timeout: { type: 'string', default: '8000' }, strict: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/baseline/run.mjs [--manifest PATH] [--output NEW_JSON_PATH] [--timeout MS] [--strict]');
    return;
  }
  const timeout = Number(values.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 250 || timeout > 120000) throw new Error('Timeout must be 250–120000 ms');
  const manifestPath = await realpath(resolve(values.manifest));
  const manifestDir = dirname(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const samples = validateManifest(JSON.parse(manifestBytes));
  const outputPath = resolve(values.output);
  // Only the designated docs folder may receive reports inside the project.
  const docs = join(root, 'docs/baseline');
  if (inside(root, outputPath) && inside(docs, outputPath)) await mkdir(docs, { recursive: true });
  const output = join(await realpath(dirname(outputPath)), basename(outputPath));
  const canonicalRoot = await realpath(root);
  const canonicalDocs = join(canonicalRoot, 'docs/baseline');
  if (!output.endsWith('.json') || inside(canonicalRoot, output) && !inside(canonicalDocs, output)) {
    throw new Error('Choose a .json output in docs/baseline/ or outside the repository');
  }
  if (await stat(output).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    throw new Error('Output already exists; choose a new report path');
  }
  const startedAt = new Date().toISOString();
  const { files, identity: app } = await runtimeSnapshot(root);
  if (!app.matchesCommit) throw new Error('Refusing to benchmark a changed runtime working tree');
  const harness = Object.fromEntries(await Promise.all(harnessFiles.map(async name => {
    const path = `scripts/baseline/${name}.mjs`;
    return [path, sha256(await readFile(join(root, path)))];
  })));
  const readerTools = await detectReaders(timeout);
  const scratch = await mkdtemp(join(tmpdir(), 'paperplane-baseline-'));
  const server = await serveRuntime(files);
  let browser;
  let chromiumVersion = null;
  let control;
  const runDirectory = path => inside(canonicalRoot, path) ? relative(canonicalRoot, path) : path;
  const results = [];
  const infra = [];
  console.error(`Local downloads directory: ${scratch}`);
  try {
    for (const [index, sample] of samples.entries()) {
      const { id, path, category, sha256: hash, bytes, expected, pageCount } = sample;
      const actual = emptyStages();
      const result = { id, path, category, sha256: hash, bytes, expected, pageCount, actual,
        edit: blocked('open did not succeed'), ...Object.fromEntries(Object.keys(navigationPlan(sample))
          .map(name => [name, blocked('navigation prerequisites not met')])) };
      let stage = 'fixture';
      try {
        const pathOnDisk = await realpath(join(manifestDir, path));
        if (!inside(manifestDir, pathOnDisk) || !(await stat(pathOnDisk)).isFile()) throw new Error('Fixture is outside the corpus or not a regular file');
        const input = await readFile(pathOnDisk);
        if (input.length !== bytes || sha256(input) !== hash) throw new Error('Fixture byte count or SHA-256 differs from manifest');
        const temp = join(scratch, `${index + 1}`);
        await mkdir(temp);
        // References and second-reader validation both use the exact verified chooser bytes.
        const localInput = join(temp, 'input.pdf');
        await writeFile(localInput, input, { flag: 'wx' });
        result.artifacts = { input: `${index + 1}/input.pdf` };
        const references = new Map();
        if (expected.render === 'success' || expected.onAlternativeSuccess?.render === 'success') {
          stage = 'reference';
          result.references = await Promise.all(performancePages(sample).map(async page => {
            const { evidence, raster } = await referenceRaster(readerTools.pdftoppm, sample, localInput, page, timeout);
            if (raster) references.set(page, raster);
            return evidence;
          }));
        }
        stage = 'browser';
        if (!browser?.isConnected()) {
          browser = await chromium.launch({ headless: true, timeout });
          chromiumVersion = browser.version();
        }
        await within(measureUI(browser, server, sample, input, temp, timeout, result, references, control), 22 * timeout, 'Sample browser watchdog');
        if (!control && expected.open === 'success' && actual.open.status === 'success' &&
            actual.open.checksMatch && actual.render.status === 'success') {
          control = { id, pages: actual.open.pages, reference: references.get(1),
            file: { name: posix.basename(path), mimeType: 'application/pdf', buffer: input } };
        }
        stage = 'reader';
        if (actual.save.status === 'success') {
          result.artifacts.download = `${index + 1}/download.pdf`;
          result.secondReader = await checkOutput(readerTools, localInput, join(temp, 'download.pdf'),
            actual.open.pages, result.edit.status === 'success', timeout);
        } else result.secondReader = { status: 'blocked', reason: 'No completed download' };
      } catch (error) {
        result.infrastructure = { stage, reason: message(error) };
        if (actual.open.status === 'blocked') actual.open = { status: 'infrastructure-failure', ms: null, reason: message(error) };
        if (browser && stage === 'browser') {
          await within(browser.close(), timeout, 'Browser recovery').catch(error => infra.push(message(error)));
          browser = undefined;
        }
      }
      result.secondReader ??= { status: 'blocked', reason: 'Browser or fixture infrastructure failure' };
      Object.assign(result, classify(sample, result));
      results.push(result);
      const failed = Object.entries(result.comparisons).filter(([, value]) => ['mismatch', 'infrastructure-failure'].includes(value))
        .map(([name, value]) => `${name}=${value}`);
      console.error(`${index + 1}/${samples.length} ${id}: ${result.outcome} (${stages.map(key => actual[key]?.status ?? 'missing').join('/')})` +
        (failed.length ? ` [${failed.join(', ')}]` : ''));
    }
  } finally {
    if (browser) await within(browser.close(), timeout, 'Browser shutdown').catch(error => infra.push(message(error)));
    await server.close();
  }
  const summary = summarize(samples, results);
  const report = {
    schemaVersion: 1, goal: '97e94b6a-60de-44e6-89d0-3b785f0b3a95', startedAt, finishedAt: new Date().toISOString(),
    command: [basename(process.execPath), 'scripts/baseline/run.mjs', ...process.argv.slice(2)],
    mode: values.strict ? 'strict' : 'measurement',
    manifest: { path: runDirectory(manifestPath), sha256: sha256(manifestBytes), entries: samples.length }, app, harness,
    artifactsDirectory: runDirectory(scratch), contentSettings,
    environment: { node: process.version, chromium: chromiumVersion, playwright: require('playwright/package.json').version,
      platform: platform(), osRelease: release(), osVersion: version(), arch: arch(), cpu: cpus()[0]?.model,
      logicalCores: cpus().length, memoryBytes: totalmem(), headless: true, viewport, dpr: 1,
      repetitions: 1, order: 'manifest', warmup: 'none', isolation: 'Fresh context per sample; fresh page on reopen',
      cache: 'Service workers blocked; loopback runtime HTTP no-store; process and OS caches not controlled',
      storage: 'OS temporary filesystem; device and power state not measured', network: 'Loopback runtime allowlist only',
      timeoutMs: timeout, clock: 'Node monotonic performance.now(), milliseconds', memoryMetric: 'not measured', readerTools },
    infrastructureIssues: infra, summary, results,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`${JSON.stringify(summary)}\nReport: ${output}`);
  process.exitCode = reportExitCode(summary, infra, values.strict);
}

main().catch(error => { console.error(message(error)); process.exitCode = 1; });
