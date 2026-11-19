import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contentSettings, expectsBlank, hasMeaningfulInk, parsePpm } from './content.mjs';

const run = promisify(execFile);
const environment = { ...process.env, LC_ALL: 'C' };
const readerArgs = ['-f', '1', '-l', '1'];
const checkerArgs = ['--check'];
const rasterArgs = ['-cropbox', '-scale-to', String(contentSettings.rasterSize), '-singlefile'];
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;

export async function detectReaders(timeout) {
  return Object.fromEntries(await Promise.all([
    ['pdfinfo', ['-v'], readerArgs], ['qpdf', ['--version'], checkerArgs], ['pdftoppm', ['-v'], rasterArgs],
  ].map(async ([tool, versionArgs, args]) => {
    try {
      const { stdout, stderr } = await run(tool, versionArgs, { timeout, env: environment });
      return [tool, { available: true, version: (stdout || stderr).trim().split('\n')[0], args }];
    } catch (error) { return [tool, { available: false, reason: error.code ?? error.signal ?? 'unknown' }]; }
  })));
}

function diagnosticsOf(stderr, path) {
  return String(stderr ?? '').replaceAll(path, '<pdf>').split(/\r?\n/)
    .filter(line => /^(WARNING|Syntax (Error|Warning)|Command Line Error|qpdf:|I\/O Error)/i.test(line))
    .slice(0, 8).map(line => line.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240));
}

export async function referenceRaster(config, sample, path, page, timeout) {
  const expectedBlank = expectsBlank(sample, page);
  if (!config.available) return { evidence: { page, expectedBlank, status: 'unavailable', reason: config.reason } };
  try {
    const { stdout, stderr } = await run('pdftoppm', [...config.args, '-f', String(page), '-l', String(page), path],
      { encoding: 'buffer', timeout, env: environment, maxBuffer: 512 * 1024 });
    const raster = parsePpm(stdout);
    const usable = expectedBlank ? raster.nonwhite === 0 : hasMeaningfulInk(raster);
    const evidence = { page, expectedBlank, status: usable ? 'success' : 'unconfirmed',
      width: raster.width, height: raster.height, ink: raster.ink, nonwhite: raster.nonwhite, sha256: raster.sha256,
      diagnostics: diagnosticsOf(stderr, path) };
    if (!usable) evidence.reason = 'Independent raster does not support the declared content expectation';
    return { evidence, raster: usable ? { ...raster, blank: expectedBlank } : undefined };
  } catch (error) {
    return { evidence: { page, expectedBlank, status: error.killed ? 'timeout' : 'error',
      reason: typeof error.code === 'number' ? `pdftoppm exit ${error.code}` : String(error.code ?? error.message),
      diagnostics: diagnosticsOf(error.stderr, path) } };
  }
}

async function invoke(tool, config, path, timeout) {
  if (!config.available) return { status: 'unavailable', ms: null };
  const start = performance.now();
  const result = await run(tool, [...config.args, path], { timeout, env: environment, maxBuffer: 128 * 1024 })
    .then(result => ({ ...result, code: 0 }), error => error);
  const diagnostics = diagnosticsOf(result.stderr, path);
  return { status: result.killed ? 'timeout' : result.code === 0 ? 'success' : tool === 'qpdf' && result.code === 3
    ? 'warning' : typeof result.code === 'number' ? 'error' : 'infrastructure-failure',
  ms: elapsed(start), exitCode: result.code ?? null, signal: result.signal ?? null, diagnostics,
  ...(tool === 'pdfinfo' ? {
    pages: Number(result.stdout?.match(/^Pages:\s*(\d+)/m)?.[1]) || null,
    firstPageRotation: Number(result.stdout?.match(/^Page\s+1\s+rot:\s*(-?\d+)/m)?.[1]) ||
      (result.stdout?.match(/^Page\s+1\s+rot:\s*0\b/m) ? 0 : null),
  } : {}) };
}

export async function checkOutput(tools, input, output, expectedPages, edited, timeout) {
  const [inputInfo, pdfinfo, qpdf] = await Promise.all([
    invoke('pdfinfo', tools.pdfinfo, input, timeout), invoke('pdfinfo', tools.pdfinfo, output, timeout),
    invoke('qpdf', tools.qpdf, output, timeout),
  ]);
  const normalize = angle => ((angle % 360) + 360) % 360;
  return { inputInfo, pdfinfo, qpdf, pageCountMatches: pdfinfo.status === 'success' && pdfinfo.pages !== null
    ? pdfinfo.pages === expectedPages : null,
  rotationMatches: edited && inputInfo.firstPageRotation != null && pdfinfo.firstPageRotation != null
    ? normalize(inputInfo.firstPageRotation + 90) === normalize(pdfinfo.firstPageRotation) : null };
}
