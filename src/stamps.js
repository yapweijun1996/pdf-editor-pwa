import { selectPages } from './model.js';
import { measureStampText } from './pdf.js';
import { entryView } from './viewer.js';

const positions = { top: 0, center: .5, bottom: 1 };
const tokens = /\{(n|page|total)\}/g;

// Lay out a metric rectangle in displayed points, then convert its baseline
// back to unrotated page coordinates. Positive angles turn counterclockwise.
function place(view, label, metrics, region) {
  const { text, role, opacity, tilt, align, vertical, preferred } = label;
  const { left, top, width, height } = region;
  const angle = tilt * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const { advance, rise, depth } = metrics;
  const line = rise + depth;
  const spanX = Math.abs(advance * cos) + Math.abs(line * sin);
  const spanY = Math.abs(advance * sin) + Math.abs(line * cos);
  const size = Math.min(preferred, width / spanX, height / spanY);
  if (!Number.isFinite(size) || size < 1) throw new Error('A stamp does not fit. Shorten the text or choose a larger page.');
  const cx = left + align * (width - spanX * size) + spanX * size / 2;
  const cy = top + vertical * (height - spanY * size) + spanY * size / 2;
  const dx = advance * size / 2, dy = (rise - depth) * size / 2;
  const [x, y] = view.convertToPdfPoint(cx - dx * cos + dy * sin, cy + dx * sin + dy * cos);
  return { kind: 'stamp', stampId: crypto.randomUUID(), role, text, x, y,
    size: size / view.userUnit, advance: advance * size / view.userUnit,
    angle: (view.rotation + tilt) % 360, opacity, color: role === 'watermark' ? '#333333' : '#000000' };
}

export async function prepareStamps(pages, options, getPage, signal) {
  const targets = selectPages(pages, options.range);
  const header = options.header.trim(), footer = options.footer.trim();
  const format = options.format.trim(), watermark = options.watermark.trim();
  if (!header && !footer && !format && !watermark) throw new Error('Enter at least one stamp.');
  if (format) {
    if (!/\{(?:n|page)\}/.test(format) || /[{}]/.test(format.replace(tokens, ''))) {
      throw new Error('Use {n} or {page} in the number format. {total} is also supported.');
    }
    if (!Number.isSafeInteger(options.start) || options.start < 1 || options.start + (targets.length - 1) > Number.MAX_SAFE_INTEGER) {
      throw new Error('Enter a positive whole start number within the safe integer range.');
    }
  }
  if (watermark && (!Number.isFinite(options.opacity) || options.opacity < 1 || options.opacity > 100 ||
      !Number.isFinite(options.angle) || Math.abs(options.angle) > 180 || !Object.hasOwn(positions, options.position))) {
    throw new Error('Use a watermark opacity of 1–100% and an angle of −180 to 180 degrees.');
  }
  const measures = new Map();
  const measure = text => {
    if (!measures.has(text)) measures.set(text, measureStampText(text));
    return measures.get(text);
  };
  // Validate literal text before loading any target geometry.
  for (const text of [header, footer, format, watermark]) if (text) await measure(text);
  const pageNumbers = new Map(pages.map((page, i) => [page.id, i + 1]));
  const edits = [];
  for (const [index, entry] of targets.entries()) {
    signal?.throwIfAborted();
    const view = entryView(await getPage(entry), entry, 1);
    const margin = Math.min(24, view.width * .08, view.height * .08);
    const width = view.width - 2 * margin, height = view.height - 2 * margin;
    const band = Math.min(16, height / 4);
    const full = { left: margin, top: margin, width, height: band };
    const half = (width - margin) / 2;
    const bottom = { ...full, top: view.height - margin - band };
    const marks = [];
    const add = async (text, role, region, align = 0) => {
      if (!text) return;
      const water = role === 'watermark';
      marks.push(place(view, { text, role, align, preferred: water ? 48 : 12,
        opacity: water ? options.opacity / 100 : 1, tilt: water ? options.angle : 0,
        vertical: water ? positions[options.position] : .5 }, await measure(text), region));
    };
    // Keep watermark ink between the header/footer bands in the same batch.
    const above = header ? band : 0, below = footer || format ? band : 0;
    await add(watermark, 'watermark', { left: margin, top: margin + above, width, height: height - above - below }, .5);
    await add(header, 'header', full);
    await add(footer, 'footer', { ...bottom, width: format ? half : width });
    if (format) {
      const values = { n: options.start + index, page: pageNumbers.get(entry.id), total: pages.length };
      await add(format.replace(tokens, (_, key) => String(values[key])), 'number',
        footer ? { ...bottom, left: view.width - margin - half, width: half } : bottom, 1);
    }
    edits.push({ id: entry.id, marks });
  }
  return edits;
}
