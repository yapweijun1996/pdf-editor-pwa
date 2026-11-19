// SPDX-License-Identifier: MIT
import { hex, ref, stream } from './pdf-bytes.mjs';
import { font, resources, image, pixels, text } from './pages.mjs';

export function TXT(p, m, n, id) {
  const pdf = p.pdf;
  let parameters, script, face;
  if (n <= 4) {
    const base = ['Helvetica', 'Times-Roman', 'Courier', 'Helvetica-BoldOblique'][n - 1];
    const encoding = ['/WinAnsiEncoding', '/MacRomanEncoding', '<< /Type /Encoding /BaseEncoding /StandardEncoding /Differences [65 /B] >>', null][n - 1];
    face = font(pdf, base, encoding ? `/Encoding ${encoding}` : '');
    const encoded = ['<436166e9>', '<4361668e>', '<415542>', '<446f636b>'][n - 1];
    script = `BT /F1 21 Tf 30 156 Td ${encoded} Tj ET`;
    parameters = { base, encoding, encoded, expectedText: ['Café', 'Café', 'BUB', 'Dock'][n - 1] };
  } else if (n <= 8) {
    const shapes = [
      ['80 0 m 340 670 l 610 0 l h f', '80 30 500 570 re S'],
      ['50 45 540 115 re f 250 160 110 480 re f', '50 40 m 600 40 l 490 580 l 140 580 l h f'],
      ['90 200 m 570 200 570 620 90 620 c h f', '120 0 340 320 re f 220 400 160 160 re f'],
      ['50 20 m 430 20 l 620 590 l 250 590 l h f', '90 0 m 330 650 l 580 0 l 350 220 l h f']
    ][n - 5];
    const widths = [690 + (n - 5) * 20, 710 - (n - 5) * 15];
    const glyphs = shapes.map((shape, i) => pdf.add(stream(`${widths[i]} 0 0 -20 660 700 d1\n${shape}\n`)));
    face = pdf.add(`<< /Type /Font /Subtype /Type3 /FontBBox [0 -20 660 700] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A ${ref(glyphs[0])} /B ${ref(glyphs[1])} >> /FirstChar 65 /LastChar 66 /Widths [${widths.join(' ')}] /Encoding << /Type /Encoding /Differences [65 /A /B] >> /Resources << >> >>`);
    script = 'BT /F1 32 Tf 30 155 Td (ABBA) Tj ET'; parameters = { widths, shapes, expectedText: 'ABBA', baseline: [30, 155] };
  } else if (n <= 12) {
    face = font(pdf);
    const controls = ['2.5 Tc 8 Tw (Low tide) Tj', '[(East) -250 (Jetty) 160 (9)] TJ', '74 Tz 8 Ts (Upper) Tj 0 Ts 0 -24 Td (Lower) Tj', '1 Tr (Stroke) Tj 0 -24 Td 3 Tr (Invisible) Tj'][n - 9];
    script = `BT /F1 17 Tf 30 160 Td ${controls} ET`; parameters = { controls, baseline: [30, 160], invisibleText: n === 12 ? 'Invisible' : null };
  } else {
    const mappings = n === 13 ? '<41> <03a9>\n<42> <00660069>' : '<41> <4e2d>\n<42> <d83ddf01>';
    const cmap = pdf.add(stream(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Synthetic) /Ordering (Unicode) /Supplement 0 >> def\n/CMapName /CorpusMap def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n${mappings}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`));
    face = font(pdf, 'Helvetica', `/Encoding /WinAnsiEncoding /ToUnicode ${ref(cmap)}`);
    script = 'BT /F1 21 Tf 30 156 Td (AB) Tj ET'; parameters = { mappings, visibleGlyphs: 'AB', expectedText: n === 13 ? 'Ωfi' : '中🜁' };
  }
  p.simple(id, `${script}\n`, `/Resources << /Font << /F0 ${ref(p.font)} /F1 ${ref(face)} >> >>`); pdf.table();
  return { recipe: n <= 4 ? 'standard-font-encoding' : n <= 8 ? 'drawn-type3' : n <= 12 ? 'text-state' : 'to-unicode', parameters };
}

const form = (pdf, commands, extra = '', width = 100, height = 72) => pdf.add(stream(commands,
  `/Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}] ${extra}`));

export function GFX(p, m, n, id) {
  const pdf = p.pdf;
  const background = 'q .82 .77 .62 rg 40 65 185 110 re f Q\n';
  let art, extra = '', parameters;
  if (n <= 2) {
    art = [
      'q 55 80 82 78 re W n .2 .55 .75 rg 40 68 m 195 102 l 70 177 l h f 3 w 1 0 0 RG 52 94 m 178 146 l S Q',
      'q 50 72 130 98 re 78 93 66 55 re W* n .11 .65 .4 rg 46 70 140 103 re f 2 w 0 .2 .6 RG 60 82 m 75 168 160 165 198 86 c S Q'
    ][n - 1];
    parameters = { clip: n === 1 ? 'nonzero rectangle' : 'even-odd cutout', paintedProbe: n === 1 ? [80, 104] : [64, 90], unpaintedProbe: n === 1 ? [150, 110] : [100, 110] };
  } else if (n <= 6) {
    const variants = ['q .35 g 1.2 0 0 1.1 64 90 cm 0 0 69 49 re f Q', 'q .4 .2 .72 rg 1 .22 .35 1 64 90 cm 0 0 69 49 re f Q', 'q .7 0 .5 .12 k 0 1 -1 0 140 90 cm 0 0 62 69 re f Q', 'q .15 .4 .63 RG .38 g 4 w [5 3] 2 d -1 0 0 1 140 90 cm 0 0 69 48 re B Q'];
    art = variants[n - 3] + '\n.16 g 180 90 12 12 re f'; parameters = { operations: variants[n - 3], interior: [105, 112], restoredStateProbe: [185, 95] };
  } else if (n <= 10) {
    const blend = ['Normal', 'Multiply', 'Screen', 'Difference'][n - 7];
    const alpha = [0.25, 0.5, 0.7, 0.85][n - 7];
    extra = `/ExtGState << /Mix << /Type /ExtGState /BM /${blend} /ca ${alpha} /CA ${1 - alpha} >> >>`;
    art = 'q /Mix gs .1 .35 .8 rg .46 .12 .35 RG 6 w 100 99 150 48 re B Q'; parameters = { blend, fillAlpha: alpha, strokeAlpha: 1 - alpha, overlap: [150, 120], nonOverlap: [237, 120] };
  } else {
    const mode = n === 11 ? 'Alpha' : 'Luminosity';
    const mask = form(pdf, n === 11 ? '0.7 g 0 0 55 72 re f\n' : '.30 g 0 0 54 72 re f .82 g 54 0 46 72 re f\n', '/Group << /S /Transparency /I true /CS /DeviceGray >> /Resources << >>');
    const colored = form(pdf, '.16 .35 .82 rg 0 0 77 72 re f .65 .2 .1 rg 38 12 62 48 re f\n', '/Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources << >>');
    extra = `/XObject << /Patch ${ref(colored)} >> /ExtGState << /Masked << /Type /ExtGState /SMask << /S /${mode} /G ${ref(mask)} >> >> >>`;
    art = 'q 1 0 0 1 80 80 cm /Masked gs /Patch Do Q'; parameters = { mask: mode, isolated: true, probes: [[102, 122], [150, 122]] };
  }
  p.simple(id, background + art + '\n', `/Resources ${resources(p.font, extra)}`); pdf.table();
  return { recipe: n <= 2 ? 'path-clip' : n <= 6 ? 'state-transform-color' : n <= 10 ? 'blend-alpha' : 'isolated-soft-mask', parameters };
}

function bitmap(w, h, variant) {
  const data = Buffer.alloc(Math.ceil(w / 8) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((x * 3 + y + variant) % 9 < 4) data[y * Math.ceil(w / 8) + (x >> 3)] |= 128 >> (x % 8);
  }
  return data;
}

export function IMG(p, m, n, id) {
  const pdf = p.pdf;
  const w = 14 + n, h = 10 + (n * 3) % 11, channels = n % 2 === 1 ? 1 : 3;
  const x = 50 + 2 * n, y = 86, width = 88 + 3 * n, height = 62 + 2 * n;
  const inline = n === 5 || n === 6;
  const flate = n === 7 || n === 8 || n === 12;
  let object, operation, mask = null, sourceBytes;
  const raster = pixels(w, h, channels, n);
  const paint = `q ${n === 7 ? -width : width} 0 ${n === 8 ? 24 : 0} ${height} ${n === 7 ? x + width : x} ${y} cm `;
  if (inline) {
    // ASCIIHex makes inline end-delimiter collisions impossible.
    operation = `BI /W ${w} /H ${h} /BPC 8 /CS /${channels === 1 ? 'G' : 'RGB'} /F /AHx ID\n${raster.toString('hex')}>\nEI`;
  } else {
    let extra = '';
    if (n === 9) {
      const bits = bitmap(w, h, n); sourceBytes = bits.length;
      object = pdf.add(stream(bits, `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ImageMask true /BitsPerComponent 1 /Decode [1 0]`)); mask = 'inverted stencil';
    } else if (n === 10) {
      const bits = bitmap(w, h, n);
      const explicit = pdf.add(stream(bits, `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ImageMask true /BitsPerComponent 1`));
      extra = `/Mask ${ref(explicit)}`; mask = 'explicit 1-bit mask';
    } else if (n === 11) {
      extra = '/Mask [0 95]'; mask = 'gray color key 0–95';
    } else if (n === 12) {
      const gradient = Buffer.from(Array.from({ length: w * h }, (_, i) => Math.round(255 * (i % w) / (w - 1))));
      extra = `/SMask ${ref(image(pdf, w, h, 1, gradient, '', true))}`; mask = 'grayscale soft mask gradient';
    }
    object ??= image(pdf, w, h, channels, raster, extra, flate);
    operation = '/Tile Do';
  }
  p.simple(id, `q .87 .84 .73 rg 45 80 160 100 re f Q\n${paint}.13 .47 .72 rg ${operation} Q\n`, object ? `/Resources ${resources(p.font, `/XObject << /Tile ${ref(object)} >>`)}` : '');
  pdf.table();
  return { recipe: n <= 4 ? 'image-xobject' : n <= 8 ? 'inline-or-flate' : 'image-mask', parameters: { w, h, channels: n === 9 ? null : channels, bitsPerComponent: n === 9 ? 1 : 8, sourceBytes: sourceBytes ?? raster.length, placement: [x, y, width, height], transform: n === 7 ? 'mirrored horizontally' : n === 8 ? 'x shear' : 'scale and translate', inline, flate, mask, pixelSeed: n } };
}

export function PER(p, m, n, id) {
  const pdf = p.pdf;
  const pageCount = n <= 2 ? 50 : 500;
  const heavy = n % 2 === 0;
  const marks = [], kids = [], tileCount = 12, w = 120, h = 96;
  const tiles = heavy ? Array.from({ length: tileCount }, (_, i) => image(pdf, w, h, 3, pixels(w, h, 3, 100 + i), '', true)) : [];
  const res = heavy ? resources(p.font, `/XObject << ${tiles.map((tile, i) => `/T${i} ${ref(tile)}`).join(' ')} >>`) : p.base;
  for (let i = 0; i < pageCount; i++) {
    const mark = `${id}-P${String(i + 1).padStart(3, '0')}`; marks.push(mark);
    const palette = `${((i % 7) + 2) / 10} .31 .54`;
    const artwork = heavy ? `q 125 0 0 100 32 100 cm /T${i % tileCount} Do Q\nq 125 0 0 100 167 100 cm /T${(i + 5) % tileCount} Do Q\n` : `q ${palette} rg 36 95 ${80 + i % 37} 36 re f .18 G 2 w 38 155 m 165 ${170 + i % 28} l S Q\n`;
    kids.push(p.leaf(p.root, ref(p.content(mark, artwork + text(`Sheet ${i + 1} of ${pageCount}`, 26, 204)))));
  }
  p.node(p.root, kids, pageCount, `/MediaBox [0 0 320 290] /Resources ${res}`); pdf.table();
  return { recipe: heavy ? 'image-heavy' : 'vector-text-light', marks, parameters: { pageCount, rawImageBytes: heavy ? tileCount * w * h * 3 : 0, imagePool: heavy ? tileCount : 0, drawsPerPage: heavy ? 2 : 0, imageSize: heavy ? [w, h] : null, reuse: heavy ? 'inherited pool, pair selected by page index mod 12' : 'one inherited standard font, distinct vector/text content' } };
}
