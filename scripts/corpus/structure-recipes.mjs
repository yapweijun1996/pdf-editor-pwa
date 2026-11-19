// SPDX-License-Identifier: MIT
import { bytes, ref, arr, str, stream } from './pdf-bytes.mjs';
import { font, resources, box, marker, text } from './pages.mjs';

const probe = (recipe, parameters) => ({ recipe, parameters });

export function SYN(p, m, n, id) {
  const pdf = p.pdf;
  if (n <= 3) { p.simple(id); pdf.table(); return probe('line-ending', { layout: ['LF', 'CRLF', 'CR with CRLF after stream keyword'][n - 1] }); }
  if (n <= 7) {
    const variants = ['escaped literal delimiters and octal', 'hex string with whitespace and odd nibble', 'escaped name', 'inter-token comments'];
    const payload = [String.raw`BT /F0 13 Tf 24 150 Td (Ring \(east\) \053) Tj ET`, 'BT /F0 13 Tf 24 150 Td <42 6c 7565204> Tj ET', 'BT /F#30 13 Tf 24 150 Td (Name alias) Tj ET', 'BT /F0 % inter-token tide note\n13 Tf 24 150 Td (Compass) Tj ET'][n - 4];
    p.simple(id, `${payload}\n`); pdf.table();
    return probe('lexical', { variant: variants[n - 4], expectedText: ['Ring (east) +', 'Blue @', 'Name alias', 'Compass'][n - 4] });
  }
  if (n <= 9) {
    const info = pdf.add(n === 8 ? '<< /Title (Harbor) /CorpusScalars [true false null -7 .25] >>' : `<< /Title ${ref(pdf.add('(Tidal index)'))} /CorpusNested << /Slots [${ref(pdf.add('[true -3 0.25]'))} << /Point [2 4] >>] >> >>`);
    pdf.trailer = `/Info ${ref(info)}`; p.simple(id); pdf.table();
    return probe('object-layout', { variant: n === 8 ? 'direct scalars' : 'nested arrays and indirect string/array' });
  }
  if (n === 10) p.simple(id, 'q 1 0 0 rg 52 160 18 15 re f Q\n');
  else {
    const array = n === 11 ? arr([ref(pdf.add(stream('q .7 .2 .1 rg 52 160 18 15 re f\n'))), ref(pdf.add(stream(`Q\n${marker(id)}`)))]) : null;
    p.node(p.root, [p.leaf(p.root, array)]);
  }
  pdf.table();
  return { ...probe('contents-layout', { contents: ['single', 'two-stream array sharing graphics state', 'absent'][n - 10] }), ...(n === 12 ? { marks: [null] } : {}) };
}

export function XRT(p, m, n, id) {
  const pdf = p.pdf;
  if (n <= 6) {
    const padding = [0, 211, 0, 0, 0, 0][n - 1];
    if (padding) pdf.append(`% ${'offset '.repeat(padding)}\n`);
    const { data, page } = p.simple(n <= 2 ? id : `${id}-prior`);
    const splits = [null, null, [[0, 1], [1, 5]], [[0, 2], [2, 4]], [[0, 3], [3, 1], [4, 2]], [[0, 1], [1, 2], [3, 1], [4, 2]]][n - 1];
    pdf.table();
    // ISO requires a contiguous initial subsection. The split update still covers every ID.
    if (splits) {
      pdf.set(data, stream(marker(id)));
      p.leaf(p.root, ref(data), '/Rotate 0', page);
      pdf.table(splits);
    }
    return probe(n <= 2 ? 'contiguous-table' : 'split-table-full-coverage', { mainSections: [[0, 6]], updateSections: splits, paddingRepeats: padding, revisions: splits ? 2 : 1 });
  }
  const old = pdf.reserve(), spare = n % 2 === 0 ? pdf.reserve() : null;
  const page = p.simple(id, text('Live baseline', 24, 180)).page;
  if (n >= 9) {
    pdf.set(old, stream(marker(`${id}-obsolete`)));
    p.leaf(p.root, ref(old), '', page);
  } else pdf.release(old, 0);
  if (spare) pdf.release(spare, 0);
  pdf.table();
  if (n >= 9) {
    const fallback = p.content(`${id}-interim`);
    p.leaf(p.root, ref(fallback), '', page);
    pdf.release(old, 1);
    pdf.table();
    pdf.set(old, stream(marker(id)), 1);
    p.leaf(p.root, ref(old, 1), '', page);
    pdf.table();
  }
  return probe('free-generation', { object: old, extraFree: spare, liveGeneration: n >= 9 ? 1 : null, freeGeneration: n <= 8 ? 0 : 1, revisions: n >= 9 ? 3 : 1 });
}

export function XRS(p, m, n, id) {
  const pdf = p.pdf;
  if (n >= 9) {
    const hidden = pdf.reserve(); pdf.release(hidden, 65535);
    const { page } = p.simple(`${id}-prior`);
    pdf.table();
    p.leaf(p.root, ref(p.content(id)), `/Annots [${ref(hidden)}]`, page);
    pdf.set(hidden, `<< /Type /Annot /Subtype /Text /Rect [160 130 180 150] /Contents (${id} supplemental note) /Name /${n === 9 ? 'Note' : 'Help'} >>`);
    pdf.pack([hidden], n === 10);
    pdf.xstream({ index: 'hybrid', supplemental: [hidden], flate: n === 10 });
    return probe('hybrid-update', { supplementalObject: hidden, flate: n === 10, annotationIcon: n === 9 ? 'Note' : 'Help', revisions: 2 });
  }
  const update = [2, 3, 6].includes(n);
  const { data, page } = p.simple(update ? `${id}-prior` : id);
  const widths = [[1, 2, 2], [0, 3, 2], [1, 4, 0]][n - 1] ?? [1, 3, 2];
  const index = n === 5 ? 'explicit' : 'implicit';
  if (update) {
    // The main section includes object zero; only live delta rows use defaults.
    pdf.xstream();
    pdf.set(data, stream(marker(id)));
    p.leaf(p.root, ref(data), '/Rotate 0', page);
    pdf.xstream({ widths, index: 'delta' });
  } else pdf.xstream({ widths, index, flate: n === 8 });
  return probe(n <= 3 ? 'field-widths' : n <= 6 ? 'index-layout' : 'xref-filter', { widths, index: update ? 'delta multi-range' : index, flate: n === 8, revisions: update ? 2 : 1 });
}

export function OBJ(p, m, n, id) {
  const pdf = p.pdf;
  const fonts = ['Courier', 'Times-Roman', 'Helvetica-Bold'].map(name => font(pdf, name));
  const resourceId = pdf.add(`<< /Font << ${[p.font, ...fonts].map((f, i) => `/F${i} ${ref(f)}`).join(' ')} >> >>`);
  const labels = ['Cedar', 'Horizon', 'Beacon'];
  const content = labels.map((label, i) => `BT /F${i + 1} 15 Tf 24 ${190 - i * 25} Td (${label}) Tj ET\n`).join('');
  p.simple(id, content, `/Resources ${ref(resourceId)}`);
  const groups = [[resourceId], [fonts[0], resourceId], [resourceId, fonts[2], fonts[0]], [fonts[2], fonts[1], fonts[0], resourceId], [fonts, [resourceId]], [[fonts[2], resourceId], fonts.slice(0, 2)], [resourceId, ...fonts], [resourceId, ...fonts]][n - 1];
  const containers = n === 5 || n === 6 ? groups : [groups];
  for (const members of containers) pdf.pack(members, n === 8);
  pdf.xstream();
  return probe(n <= 4 ? 'single-container' : n <= 6 ? 'cross-container' : 'container-filter', { containers, flate: n === 8, resourceLabels: labels });
}

export function INC(p, m, n, id) {
  const pdf = p.pdf;
  const initial = n >= 3 && n <= 6 ? ['A', 'B', 'C'].map(x => `${id}-${x}`) : [n <= 2 ? `${id}-prior` : id];
  const data = initial.map(x => p.content(x));
  const kids = data.map(x => p.leaf(p.root, ref(x)));
  p.node(p.root, kids);
  const info = n >= 7 ? pdf.add('<< /Title (Initial harbor) /Subject (Temporary note) >>') : null;
  if (info) pdf.trailer = `/Info ${ref(info)}`;
  const note = n === 10 ? pdf.add('<< /Type /Annot /Subtype /Text /Rect [150 120 168 138] /Contents (Temporary buoy) >>') : null;
  if (note) p.leaf(p.root, ref(data[0]), `/Annots [${ref(note)}]`, kids[0]);
  pdf.table();
  let marks = [...initial], edit;
  if (n <= 2) {
    if (n === 2) { pdf.set(data[0], stream(marker(`${id}-interim`))); pdf.table(); }
    pdf.set(data[0], stream(marker(id))); marks = [id]; edit = 'replace content stream';
  } else if (n <= 6) {
    const order = [[2, 1, 0], [1, 0, 2], [0, 2], [0, 3, 1, 2]][n - 3];
    if (n === 6) kids.push(p.leaf(p.root, ref(p.content(`${id}-D`))));
    if (n === 5) { pdf.release(kids[1], 1); pdf.release(data[1], 1); }
    p.node(p.root, order.map(i => kids[i]));
    marks = order.map(i => initial[i] ?? `${id}-D`); edit = { order };
  } else if (n <= 8) {
    const title = n === 7 ? 'Revised headland' : 'Final inlet';
    pdf.set(info, `<< /Title ${str(title)} ${n === 7 ? '/Subject (Temporary note)' : '/ModDate (D:20261119000000Z)'} >>`);
    edit = { title, subject: n === 7 ? 'Temporary note' : null, modificationDate: n === 8 ? 'D:20261119000000Z' : null };
  } else if (n === 9) {
    pdf.trailer = '/Info null'; pdf.release(info, 1); edit = 'delete Info';
  } else {
    p.leaf(p.root, ref(data[0]), '', kids[0]); pdf.release(note, 1); edit = 'delete annotation and reference';
  }
  pdf.table();
  return { ...probe(n <= 2 ? 'replace-marker' : n <= 6 ? 'change-page-tree' : 'update-optional-objects', { edit, revisions: n === 2 ? 3 : 2, initial }), marks };
}

export function PAG(p, m, n, id) {
  const pdf = p.pdf;
  const layouts = [[1], [2, 1], [1, 1, 1], [2, 2], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]];
  const levels = layouts[n - 1] ?? [1];
  const marks = [], geometry = [];
  let height = 0;
  const top = { media: box, crop: null, rotation: 0, face: 'Helvetica' };
  const alternate = n >= 9 && n <= 12 ? font(pdf, ['Courier', 'Times-Bold', 'Courier-Bold', 'Helvetica-Oblique'][n - 9]) : null;
  const dictionaries = [
    `/Resources ${resources(alternate, '/ProcSet [/PDF /Text]')}`,
    `/Resources ${resources(alternate)}`,
    `/Resources ${ref(n === 11 ? pdf.add(resources(alternate)) : 0)}`,
    `/Resources ${resources(alternate, '/ExtGState << /Local << /Type /ExtGState /CA 0.6 >> >>')}`
  ];
  function walk(idNode, depth, parent, inherited, branch) {
    height = Math.max(height, depth + 1);
    let attrs = depth === 0 ? `/MediaBox ${box} /Resources ${p.base}` : '';
    const here = { ...inherited };
    if (n >= 5 && n <= 8 && depth === n % 2) {
      here.media = `[0 0 ${320 + n * 5} ${290 + n * 7}]`;
      here.crop = `[10 12 310 ${270 + n}]`;
      here.rotation = n === 8 ? 270 : 90;
      attrs += ` /MediaBox ${here.media} /CropBox ${here.crop} /Rotate ${here.rotation}`;
      if (depth === 0) attrs = `/Resources ${p.base} /MediaBox ${here.media} /CropBox ${here.crop} /Rotate ${here.rotation}`;
    }
    if (n >= 9 && n <= 12 && depth === (n === 9 || n === 11 ? 1 : 0)) {
      attrs = `${depth === 0 ? `/MediaBox ${box}` : ''} ${dictionaries[n - 9]}`;
      here.face = ['Courier', 'Times-Bold', 'Courier-Bold', 'Helvetica-Oblique'][n - 9];
    } else if (n >= 9 && n <= 12 && depth === 0) {
      attrs = `/MediaBox ${box} /Resources ${resources(p.font, '/ExtGState << /Ancestor << /Type /ExtGState /CA 0.3 >> >>')}`;
    }
    const kids = []; let count = 0;
    for (let i = 0; i < levels[depth]; i++) {
      if (depth + 1 < levels.length) {
        const child = pdf.reserve(); kids.push(child); count += walk(child, depth + 1, idNode, here, i);
      } else {
        const countLeaves = n <= 4 ? 2 + branch : 2;
        for (let j = 0; j < countLeaves; j++) {
          const mark = `${id}-P${marks.length + 1}`; marks.push(mark);
          const leaf = { ...here }; let own = '';
          if ((n === 6 || n === 7 || n === 8) && j === 1) {
            if (n === 6) { leaf.media = '[0 0 360 330]'; own += ` /MediaBox ${leaf.media}`; }
            if (n === 7) { leaf.crop = '[16 20 285 278]'; own += ` /CropBox ${leaf.crop}`; }
            leaf.rotation = n === 8 ? 0 : 180; own += ` /Rotate ${leaf.rotation}`;
          }
          if (n >= 9 && n <= 12 && j === 1 && n !== 9) { leaf.face = 'Helvetica'; own += ` /Resources ${p.base}`; }
          if (n >= 13) {
            const x = j ? -12 - n : 2 + n, y = j ? -8 : 5;
            leaf.media = `[${x} ${y} ${331 + n * j} ${291 + n * (1 - j)}]`;
            leaf.crop = `[${x + 2} ${y + 4} ${303 + n * j} 280]`;
            leaf.rotation = ((n - 13 + j) % 4) * 90;
            own += ` /MediaBox ${leaf.media} /CropBox ${leaf.crop} /Rotate ${leaf.rotation}`;
          }
          geometry.push({ mediaBox: leaf.media, cropBox: leaf.crop ?? leaf.media, rotation: leaf.rotation, markerFont: leaf.face });
          kids.push(p.leaf(idNode, ref(p.content(mark)), own)); count++;
        }
      }
    }
    p.node(idNode, kids, count, attrs, parent);
    return count;
  }
  walk(p.root, 0, null, top, 0); pdf.table();
  return { ...probe(n <= 4 ? 'tree-depth-fanout' : n <= 8 ? 'box-rotation-overrides' : n <= 12 ? 'resource-inheritance' : 'mixed-geometry', { depth: height, fanoutFactors: levels, geometry }), marks };
}

export function BAD(p, m, n, id) {
  const parent = m.get('SYN-01');
  const sibling = parent.buffer.toString('latin1');
  let output, defect;
  switch (n) {
    case 1: output = sibling.replace(/%%EOF\n$/, ''); defect = 'missing final EOF marker'; break;
    case 2: output = sibling.replace(/(startxref\n)\d+/, (_, start) => `${start}6`); defect = 'stale startxref offset'; break;
    case 3: output = sibling.replace(/\n\d{10}( 00000 n \n)/, (_, suffix) => `\n0000000003${suffix}`); defect = 'stale in-use xref row offset'; break;
    case 4: output = sibling.replace(/startxref\n\d+\n/, ''); defect = 'missing startxref directive'; break;
    case 5: output = sibling.slice(0, sibling.search(/^\d+ 0 obj$/m)); defect = 'header only; cut before any objects'; break;
    case 6: output = sibling.slice(0, sibling.indexOf('1 0 obj') + '1 0 obj\n<< /Type'.length); defect = 'truncated catalog dictionary'; break;
    case 7: p.simple(id); p.pdf.set(p.catalog, '<< /Type /Catalog >>'); p.pdf.table(); defect = 'catalog missing required Pages'; break;
    case 8: p.node(p.root, [p.pdf.reserve()], 1); p.pdf.table(); defect = 'Kids references a free object; no page objects'; break;
    case 9: p.pdf.add('<< /Title (No document catalog) >>'); p.pdf.table(); defect = 'trailer Root resolves to free catalog slot'; break;
    default: output = sibling.slice(0, sibling.indexOf('endstream')); defect = 'truncated inside content object before any page/tree or trailer';
  }
  return { ...probe(n <= 4 ? 'recoverable-defect' : 'no-usable-page-tree', { defect, parent: output ? { id: 'SYN-01', sha256: parent.sample.sha256 } : null, ...(output ? {} : { noParentReason: 'authored directly with one missing required structure' }) }), buffer: output ? bytes(output) : p.pdf.result(), marks: n <= 4 ? ['SYN-01'] : [] };
}
