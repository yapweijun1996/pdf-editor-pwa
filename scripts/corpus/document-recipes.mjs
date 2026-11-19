// SPDX-License-Identifier: MIT
import { arr, ref, str, stream, utf16 } from './pdf-bytes.mjs';
import { resources, text } from './pages.mjs';
import { secure } from './security.mjs';

const appearance = (p, width, height, art, res = '<< >>') => p.pdf.add(stream(art,
  `/Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}] /Resources ${res}`));

export function ANN(p, m, n, id) {
  const pdf = p.pdf, marks = [id];
  const rect = n <= 2 ? [140, 135, 164 + n * 4, 160 + n * 5] : [50, 123, 170, 154];
  const annot = pdf.reserve();
  const page = p.leaf(p.root, ref(p.content(id, text('Tidal crossing', 52, 132, 15))), `/Annots [${ref(annot)}]`);
  const kids = [page];
  let dict, parameters = { rect };
  if (n <= 2) {
    const icon = n === 1 ? 'Note' : 'Comment', contents = n === 1 ? 'Count the buoys' : 'South sill (dry)';
    dict = `/Subtype /Text /Name /${icon} /Contents ${str(contents)} /Open ${n === 1} /C [1 .7 .2]`;
    Object.assign(parameters, { icon, contents, initiallyOpen: n === 1 });
  } else if (n <= 4) {
    marks.push(`${id}-Landing`); const target = p.leaf(p.root, ref(p.content(marks[1]))); kids.push(target);
    const destination = n === 3 ? `[${ref(target)} /Fit]` : `[${ref(target)} /XYZ 24 255 1.2]`;
    dict = `/Subtype /Link /Border [0 0 1] ${n === 3 ? `/Dest ${destination}` : `/A << /S /GoTo /D ${destination} >>`}`;
    Object.assign(parameters, { destination, destinationPage: 2, navigation: n === 3 ? 'direct destination' : 'internal GoTo' });
  } else if (n <= 6) {
    const subtype = n === 5 ? 'Highlight' : 'Underline';
    const quad = [52, 129, 158, 129, 158, 148, 52, 148];
    dict = `/Subtype /${subtype} /QuadPoints ${arr(quad)} /C [${n === 5 ? '1 .8 .12' : '.18 .5 .2'}] /Contents (Review tide mark)`;
    Object.assign(parameters, { subtype, quad });
  } else {
    const flags = n === 7 ? 4 : 36;
    const ap = appearance(p, 120, 31, n === 7 ? '.23 .61 .36 rg 3 4 112 23 re f\n' : '.62 .16 .33 RG 4 w 5 5 110 21 re S\n');
    dict = `/Subtype /Square /F ${flags} /AP << /N ${ref(ap)} >> /Contents (Synthetic appearance)`;
    Object.assign(parameters, { subtype: 'Square', flags, appearance: n === 7 ? 'green fill' : 'red outline, no-view flag' });
  }
  pdf.set(annot, `<< /Type /Annot /P ${ref(page)} /Rect ${arr(rect)} ${dict} >>`);
  p.node(p.root, kids); pdf.table();
  return { recipe: ['text-note', 'internal-link', 'text-markup', 'appearance-flags'][Math.floor((n - 1) / 2)], parameters, marks };
}

export function FRM(p, m, n, id) {
  const pdf = p.pdf;
  const field = pdf.reserve();
  const page = p.leaf(p.root, ref(p.content(id, text('Harbor survey', 48, 185, 14))));
  const widgetIds = [], rects = [];
  const shell = (w, h) => `1 g 0 0 ${w} ${h} re f .16 .29 .44 RG 1 w .5 .5 ${w - 1} ${h - 1} re S\n`;
  const label = (value, w, h) => appearance(p, w, h, shell(w, h) + `/Tx BMC\n${text(value, 5, h - 15, 11)}EMC\n`, resources(p.font));
  const widget = (rect, ap, state = '', merged = false) => {
    const w = merged ? field : pdf.reserve(); widgetIds.push(w); rects.push(rect);
    const dict = `/Type /Annot /Subtype /Widget /Rect ${arr(rect)} /P ${ref(page)} /F 4 ${merged ? '' : `/Parent ${ref(field)}`} /AP << /N ${ap} >> ${state ? `/AS /${state}` : ''}`;
    if (!merged) pdf.set(w, `<< ${dict} >>`);
    return dict;
  };
  let value, choice, flags = 0, topology, fieldDict, mergedDict = '';
  if (n <= 2) {
    value = n === 1 ? 'North quay' : '42 buoys'; flags = n === 2 ? 4096 : 0;
    fieldDict = `/FT /Tx /V ${str(value)} /DV ${str(value)} /DA (/F0 11 Tf 0 g) ${n === 1 ? '/MaxLen 24' : ''}`;
    mergedDict = widget([49, 139, 218, 166], ref(label(value, 169, 27)), '', n === 1);
  } else if (n <= 6) {
    const radio = n >= 5;
    const states = radio ? (n === 5 ? ['East', 'West'] : ['High', 'Mid', 'Low']) : [n === 3 ? 'Marked' : 'Yes'];
    flags = radio ? 32768 | (n === 6 ? 16384 : 0) : 0;
    value = n === 3 ? states[0] : n === 4 ? 'Off' : states.at(-1);
    fieldDict = `/FT /Btn /V /${value} /DV /${value}`;
    const off = appearance(p, 25, 25, shell(25, 25));
    const on = appearance(p, 25, 25, shell(25, 25) + (radio ? '.13 .42 .71 rg 7 7 11 11 re f\n' : '.13 .42 .71 RG 2.5 w 5 12 m 10 6 l 20 20 l S\n'));
    states.forEach((state, i) => {
      const x = 50 + i * 61;
      const dict = widget([x, 140, x + 25, 165], `<< /Off ${ref(off)} /${state} ${ref(on)} >>`, state === value ? value : 'Off', n === 3);
      if (n === 3) mergedDict = dict;
    });
    choice = states;
  } else {
    const combo = n === 8; flags = combo ? 131072 : 0;
    choice = combo ? [['S', 'South'], ['N', 'North'], ['W', 'West']] : ['Slack', 'Ebb', 'Flood'];
    value = combo ? 'N' : 'Ebb';
    const opt = choice.map(x => Array.isArray(x) ? arr(x.map(str)) : str(x));
    fieldDict = `/FT /Ch /V ${str(value)} /DV ${str(value)} /Opt ${arr(opt)} /DA (/F0 11 Tf 0 g) ${combo ? '' : '/I [1] /TI 0'}`;
    const height = combo ? 27 : 60;
    const ap = combo ? label('North', 169, height) : appearance(p, 169, height, shell(169, height) + '/Tx BMC\n.70 .80 .92 rg 2 21 165 18 re f 0 g\n' + text('Slack', 5, 45, 11) + text('Ebb', 5, 27, 11) + text('Flood', 5, 8, 11) + 'EMC\n', resources(p.font));
    mergedDict = widget([49, 166 - height, 218, 166], ref(ap), '', combo);
  }
  const merged = widgetIds.includes(field);
  topology = merged ? 'merged field/widget' : 'parent field with widget kids';
  pdf.set(field, `<< /T ${str(`Survey-${id}`)} /TU (Harbor survey response) ${fieldDict} /Ff ${flags} ${merged ? mergedDict : `/Kids ${arr(widgetIds.map(x => ref(x)))}`} >>`);
  // Replace only the leaf dictionary, not the distinct page-content stream.
  const previousLeaf = pdf.pending.get(page).body;
  pdf.set(page, `${previousLeaf.slice(0, -2)} /Annots ${arr(widgetIds.map(x => ref(x)))} >>`);
  p.node(p.root, [page]);
  const acro = pdf.add(`<< /Fields [${ref(field)}] /DR ${resources(p.font)} /DA (/F0 11 Tf 0 g) /NeedAppearances false >>`);
  p.catalogDict(`/AcroForm ${ref(acro)}`); pdf.table();
  return { recipe: ['text-field', 'checkbox', 'radio-group', 'choice-field'][Math.floor((n - 1) / 2)], parameters: { fieldName: `Survey-${id}`, value, flags, topology, rects, optionsOrStates: choice ?? null, widgetCount: widgetIds.length } };
}

const metadata = (pdf, id, value) => pdf.add(stream(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n<rdf:Description rdf:about="" xmlns:fixture="urn:pdf-editor-pwa:phase0:" fixture:id="${id}" fixture:label="${value}"/>\n</rdf:RDF>\n</x:xmpmeta>\n`, 'utf8'), '/Type /Metadata /Subtype /XML'));

export function MET(p, m, n, id) {
  const pdf = p.pdf;
  const values = ['Salt (east)', 'Café on the quay', 'Morning survey', 'Tidal café', 'Leaf observation', 'Tile observation'];
  const value = values[n - 1];
  let scope, fields;
  if (n <= 2) {
    const date = n === 1 ? 'D:20261119104500Z' : "D:20261119133000+02'00";
    const author = n === 1 ? 'Corpus contributors' : 'Synthetic survey team';
    const info = pdf.add(`<< /Title ${n === 1 ? str(value) : utf16(value)} /Author ${str(author)} /CreationDate ${str(date)} /Subject (Fictional coast) >>`);
    pdf.trailer = `/Info ${ref(info)}`; p.simple(id); scope = 'Info'; fields = { title: value, author, date };
  } else {
    const xml = metadata(pdf, id, value);
    if (n <= 4) { p.catalogDict(`/Metadata ${ref(xml)}`); p.simple(id); scope = 'catalog'; }
    else if (n === 5) { p.simple(id, '', `/Metadata ${ref(xml)}`); scope = 'page'; }
    else {
      const tile = appearance(p, 36, 29, '.2 .66 .49 rg 0 0 36 29 re f\n');
      pdf.pending.get(tile).body.dict += ` /Metadata ${ref(xml)}`;
      p.simple(id, 'q 1 0 0 1 58 125 cm /Xm Do Q\n', `/Resources ${resources(p.font, `/XObject << /Xm ${ref(tile)} >>`)}`);
      scope = 'form XObject';
    }
    fields = { id, label: value, encoding: 'UTF-8' };
  }
  pdf.table(); return { recipe: n <= 2 ? 'info-dictionary' : n <= 4 ? 'catalog-xml' : 'component-xml', parameters: { scope, fields } };
}

export function ENC(p, m, n, id) {
  const pdf = p.pdf;
  const config = secure(pdf, id, n);
  const { data } = p.simple(id, text(`Public profile ${n}`, 28, 162));
  if (n % 2 === 0) pdf.pending.get(data).body.flate = true;
  const info = pdf.reserve();
  const title = `Harbor vault ${id}`;
  pdf.set(info, `<< /Title <${pdf.encrypt(Buffer.from(title), info, 0).toString('hex')}> >>`);
  pdf.trailer += ` /Info ${ref(info)}`;
  if (n >= 5 && n !== 9) {
    const xml = metadata(pdf, id, 'Synthetic encrypted document');
    if (!config.encryptMetadata) pdf.pending.get(xml).body.clear = true;
    p.catalogDict(`/Metadata ${ref(xml)}`);
  }
  pdf.table(); return { recipe: n <= 4 ? 'legacy-password' : n <= 8 ? 'aesv2-password' : 'empty-user-password', parameters: { ...config, compressedContent: n % 2 === 0, title, metadataStreamPresent: n >= 5 && n !== 9 } };
}
