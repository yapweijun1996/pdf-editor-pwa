import { sha256 } from './report.mjs';

export const contentSettings = Object.freeze({ rasterSize: 256, gridSize: 32, contrast: 24,
  minimumInkFraction: 0.00015, minimumOccupiedCells: 3, minimumOpacity: 0.995, opaqueAlpha: 250,
  aspectTolerance: 0.035, neighborhood: 1, minimumRecall: 0.72, minimumPrecision: 0.50,
  minimumInkRatio: 0.25, maximumInkRatio: 4, identityGridSize: 128, minimumIdentitySignal: 0.05,
  minimumIdentityMargin: 0.10, stableMs: 60, pollMs: 25 });

export function rasterStats(bytes, width, height, channels = 4) {
  const { gridSize, contrast, opaqueAlpha } = contentSettings;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      ![3, 4].includes(channels) || bytes.length !== width * height * channels) throw new Error('Invalid raster dimensions');
  const cells = Array(gridSize ** 2).fill(0);
  let ink = 0, nonwhite = 0, opaque = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    const alpha = channels === 4 ? bytes[i + 3] : 255;
    if (alpha >= opaqueAlpha) opaque++;
    const darkness = (255 - Math.min(bytes[i], bytes[i + 1], bytes[i + 2])) * alpha / 255;
    if (darkness > 0) nonwhite++;
    if (darkness < contrast) continue;
    ink++;
    cells[Math.floor(y * gridSize / height) * gridSize + Math.floor(x * gridSize / width)]++;
  }
  const pixels = width * height;
  return { width, height, ink, nonwhite, inkFraction: ink / pixels, opacity: opaque / pixels, cells,
    sha256: sha256(bytes), bytes, channels };
}

export function rotatedReference(reference) {
  const { width, height, bytes, channels } = reference;
  const rotated = Buffer.alloc(bytes.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * channels;
    bytes.copy(rotated, (x * height + height - 1 - y) * channels, offset, offset + channels);
  }
  return { ...rasterStats(rotated, height, width, channels), blank: reference.blank, clockwise: true,
    inputSha256: reference.sha256 };
}

const bitmapKey = ({ width, height, sha256: hash }) => `${width}x${height}:${hash}`;
const aspectDelta = (a, b) => Math.abs(Math.log((a.width / a.height) / (b.width / b.height)));

// Sample common normalized locations with bilinear interpolation and composite onto white.
// This preserves differences in glyphs and channel values even when occupied cells agree.
function identityGrid({ width, height, bytes, channels }) {
  const n = contentSettings.identityGridSize;
  const grid = new Float32Array(n * n * 3);
  const sample = (x, y, c) => {
    const i = (y * width + x) * channels;
    return (255 - bytes[i + c]) * (channels === 3 ? 1 : bytes[i + 3] / 255);
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * width / n - 0.5));
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * height / n - 0.5));
    const ix = Math.floor(sx), iy = Math.floor(sy), dx = sx - ix, dy = sy - iy;
    const jx = Math.min(ix + 1, width - 1), jy = Math.min(iy + 1, height - 1);
    for (let c = 0; c < 3; c++) {
      grid[(y * n + x) * 3 + c] = (1 - dy) * ((1 - dx) * sample(ix, iy, c) + dx * sample(jx, iy, c)) +
        dy * ((1 - dx) * sample(ix, jy, c) + dx * sample(jx, jy, c));
    }
  }
  return grid;
}

export function identityScore(target, rival, observed) {
  let difference = 0, advantage = 0;
  for (let i = 0; i < target.length; i++) {
    difference += Math.abs(target[i] - rival[i]);
    advantage += Math.abs(observed[i] - rival[i]) - Math.abs(observed[i] - target[i]);
  }
  return { signal: difference / target.length, margin: difference ? advantage / difference : 0 };
}

// Construct once per input specimen, not per transition. Failed frames never learn an identity.
// Keep the confirmed history through download reopen, but not unrelated recovery/corpus inputs.
export function createPageIdentity() {
  const seen = new Map(), grids = new WeakMap();
  const gridFor = raster => {
    if (!grids.has(raster)) grids.set(raster, identityGrid(raster));
    return grids.get(raster);
  };
  return {
    compare(reference, actual, rivals = []) {
      const content = compareContent(reference, actual);
      if (!content.match) return content;
      const target = bitmapKey(reference);
      const prior = seen.get(bitmapKey(actual));
      if (prior && prior.reference !== target) {
        return { ...content, match: false, reason: 'Canvas replays a confirmed bitmap for a different expected appearance',
          replay: prior };
      }
      const identity = [];
      for (const [page, rival] of rivals) {
        if (bitmapKey(rival) === target || aspectDelta(actual, rival) > contentSettings.aspectTolerance) continue;
        const { signal, margin } = identityScore(gridFor(reference), gridFor(rival), gridFor(actual));
        identity.push({ page, referenceSha256: rival.sha256, signal, margin });
      }
      const ambiguous = identity.some(({ signal, margin }) => signal < contentSettings.minimumIdentitySignal ||
        Math.abs(margin) < contentSettings.minimumIdentityMargin);
      const wrong = identity.some(({ signal, margin }) => signal >= contentSettings.minimumIdentitySignal &&
        margin <= -contentSettings.minimumIdentityMargin);
      return { ...content, identity, match: !wrong && !ambiguous, reason: wrong ? 'Canvas favors a different page reference' :
        ambiguous ? 'Canvas does not distinguish the expected page from a distinct reference' : content.reason };
    },
    confirm(page, reference, actual) {
      if (!seen.has(bitmapKey(actual))) seen.set(bitmapKey(actual), { page, reference: bitmapKey(reference) });
    },
  };
}

function coverage(from, to) {
  const { gridSize: n, neighborhood: r } = contentSettings;
  let total = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!from.cells[y * n + x]) continue;
    found: for (let j = Math.max(0, y - r); j <= Math.min(n - 1, y + r); j++) {
      for (let i = Math.max(0, x - r); i <= Math.min(n - 1, x + r); i++) {
        if (to.cells[j * n + i]) { total += from.cells[y * n + x]; break found; }
      }
    }
  }
  return total / from.ink;
}

export function hasMeaningfulInk(raster) {
  const { minimumInkFraction, minimumOccupiedCells } = contentSettings;
  return raster.inkFraction >= minimumInkFraction && raster.cells.filter(Boolean).length >= minimumOccupiedCells;
}

export function compareContent(reference, actual) {
  const s = contentSettings;
  if (actual.opacity < s.minimumOpacity) return { match: false, reason: 'Canvas not sufficiently opaque' };
  const geometry = { aspectDelta: aspectDelta(actual, reference) };
  if (geometry.aspectDelta > s.aspectTolerance) return { match: false, reason: 'Canvas aspect differs from reference', ...geometry };
  if (reference.blank) return { match: actual.nonwhite === 0, reason: actual.nonwhite === 0
    ? 'Explicit intentional blank' : 'Intentional blank has visible marks', ...geometry };
  if (!hasMeaningfulInk(actual)) return { match: false, reason: 'Canvas lacks meaningful nonwhite content', aspectDelta };
  const recall = coverage(reference, actual), precision = coverage(actual, reference);
  const inkRatio = actual.inkFraction / reference.inkFraction;
  const match = recall >= s.minimumRecall && precision >= s.minimumPrecision &&
    inkRatio >= s.minimumInkRatio && inkRatio <= s.maximumInkRatio;
  return { match, reason: match ? 'Visible content agrees with raster reference' : 'Visible content differs from raster reference',
    recall, precision, inkRatio, ...geometry };
}

export function parsePpm(bytes) {
  // pdftoppm emits a binary P6 header with no comments; do not trim binary image bytes.
  const match = /^P6\n([1-9]\d*) ([1-9]\d*)\n255\n/.exec(bytes.subarray(0, 64).toString('ascii'));
  if (!match) throw new Error('Unexpected pdftoppm P6 header');
  const [, w, h] = match, width = Number(w), height = Number(h);
  if (Math.max(width, height) > contentSettings.rasterSize + 1) throw new Error('Raster exceeds requested scale');
  return rasterStats(bytes.subarray(match[0].length), width, height, 3);
}

export function expectsBlank(sample, page) {
  return sample.preservation?.intentionallyBlank === true && sample.preservation.pageMarkers?.[page - 1] === null;
}
