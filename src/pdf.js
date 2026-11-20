import * as renderer from '../vendor/pdfjs/build/pdf.min.mjs';
import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  StandardFonts, degrees, rgb, LineCapStyle, PDFName, PDFPage, PDFPageLeaf, PDFString, PDFDict, PDFArray, PDFRef, PDFStream,
} from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
import { rotatePoint } from './model.js';

import { geometry, isShape, subtypes } from './shapes.js';

const asset = path => new URL(`../vendor/pdfjs/${path}`, import.meta.url).href;
renderer.GlobalWorkerOptions.workerSrc = asset('build/pdf.worker.min.mjs');
export const annotationMode = renderer.AnnotationMode.ENABLE_STORAGE;

export async function openPDF(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { clean, marks, splitIndices } = await unpack(bytes);
  const task = renderer.getDocument({
    data: (clean ?? bytes).slice(), cMapUrl: asset('cmaps/'), cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'), useSystemFonts: false, isEvalSupported: false,
  });
  try {
    const pdf = await task.promise;
    if (!pdf.numPages) throw new Error('Empty document');
    await pdf.getPage(1);
    return { bytes, clean, marks, splitIndices, pdf, name: file.name, destroy: () => task.destroy() };
  } catch (error) {
    await task.destroy().catch(() => {});
    throw new Error(error.name === 'PasswordException'
      ? 'This PDF is password-protected. Open an unlocked copy instead.'
      : 'This file could not be opened as a PDF. It may be corrupt or unsupported.', { cause: error });
  }
}

const load = bytes => PDFDocument.load(bytes, { updateMetadata: false });

// Only detach our versioned annotations from a private working copy. Original
// file bytes remain available for the Save identity, conflict and backup checks.
async function unpack(bytes) {
  let doc;
  try { doc = await load(bytes); } catch { return {}; } // PDF.js may still display the input.
  const marks = [], key = PDFName.of;
  const detached = new Set();
  let changed = false;
  for (const [p, page] of doc.getPages().entries()) {
    const list = page.node.lookup(key('Annots'));
    if (!(list instanceof PDFArray)) continue;
    const kept = [], items = [], seen = new Set();
    for (const ref of list.asArray()) {
      const dict = doc.context.lookup(ref);
      const payload = dict instanceof PDFDict && dict.get(key('PaperplaneShapeV1'));
      let mark;
      if (payload instanceof PDFString && payload.asString().length < 1024) {
        try {
          const [kind, markId, points, angle, color, size] = JSON.parse(payload.asString());
          if (typeof kind === 'string' && isShape(kind) && typeof markId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(markId) && !seen.has(markId) &&
              dict.get(key('Subtype')) === key(subtypes[kind]) && dict.get(key('NM'))?.asString?.() === `paperplane:${markId}` &&
              Array.isArray(points) && points.length === 2 && points.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) &&
              [0,90,180,270].includes(angle) && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) && Number.isFinite(size) && size >= 1 && size <= 288) mark = { kind, markId, points, angle, color, size };
        } catch { /* Unknown metadata is preserved as foreign content. */ }
      }
      if (mark) {
        seen.add(mark.markId); items.push(mark);
        if (ref instanceof PDFRef) detached.add(ref);
        const appearance = dict.get(key('AP'));
        const normal = appearance instanceof PDFDict && appearance.get(key('N'));
        if (normal instanceof PDFRef && doc.context.lookup(normal) instanceof PDFStream) detached.add(normal);
      } else kept.push(ref);
    }
    if (items.length) { page.node.set(key('Annots'), doc.context.obj(kept)); marks[p] = items; changed = true; }
  }
  let splitIndices;
  const plan = doc.catalog.get(key('PaperplaneSplitV1'));
  if (plan instanceof PDFString) {
    try {
      const groups = JSON.parse(plan.asString()), count = doc.getPageCount();
      if (Array.isArray(groups) && groups.length && groups.every(g => Array.isArray(g) && g.length && g.every(i => Number.isInteger(i) && i >= 0 && i < count))) splitIndices = groups;
    } catch { /* Ignore unknown split metadata. */ }
  }
  if (!changed) return { splitIndices };
  // pdf-lib serializes even detached objects. Remove only superseded managed
  // objects, and only when no retained object still references them.
  const stack = Object.values(doc.context.trailerInfo);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) if (!detached.has(ref)) stack.push(obj);
  const visited = new Set();
  while (stack.length) {
    const obj = stack.pop();
    if (!obj || visited.has(obj)) continue;
    visited.add(obj);
    if (obj instanceof PDFRef && detached.delete(obj)) stack.push(doc.context.lookup(obj));
    if (obj instanceof PDFStream) stack.push(obj.dict);
    if (obj instanceof PDFDict) for (const [,value] of obj.entries()) stack.push(value);
    if (obj instanceof PDFArray) for (const value of obj.asArray()) stack.push(value);
  }
  for (const ref of detached) doc.context.delete(ref);
  return { clean: await doc.save({ updateFieldAppearances: false }), marks, splitIndices };
}

function writeShape(doc, page, mark) {
  const { kind, points, markId, size, angle, color } = mark;
  const { rect, path, quad } = geometry(mark), ctx = doc.context;
  const channels = color.slice(1).match(/../g).map(s => parseInt(s,16)/255);
  const ops = path.map(([op,...args]) => [...args.map(n => n.toFixed(6)), ({M:'m',L:'l',C:'c',Z:'h'})[op]].join(' '));
  const stream = ctx.flateStream(`${channels.map(n => n.toFixed(6)).join(' ')} RG ${size.toFixed(6)} w 1 J 1 j\n${ops.join('\n')} S`, { Type:'XObject', Subtype:'Form', BBox:rect, Resources:{} });
  const dict = ctx.obj({ Type:'Annot', Subtype:subtypes[kind], Rect:rect, C:channels, BS:{ W:size, S:'S' }, F:4,
    AP:{ N:ctx.register(stream) }, NM:PDFString.of(`paperplane:${markId}`), PaperplaneShapeV1:PDFString.of(JSON.stringify([kind,markId,points,angle,color,size])),
    ...(['underline','strikeout'].includes(kind) ? { QuadPoints:quad } : {}),
    ...(subtypes[kind] === 'Line' ? { L:points.flat(), LE:['None',kind === 'arrow' ? 'OpenArrow':'None'] } : {}) });
  page.node.addAnnot(ctx.register(dict));
}

export function checkText(value) {
  // Standard Helvetica uses WinAnsi, not arbitrary Unicode. Reject unsupported text before editing.
  const available = /^[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/u;
  if (!available.test(value)) throw new Error('Use Latin text and standard punctuation for this tool.');
}

let stampFont;
export async function measureStampText(text) {
  checkText(text);
  stampFont ??= PDFDocument.create().then(doc => doc.embedFont(StandardFonts.Helvetica));
  const font = await stampFont;
  font.encodeText(text);
  // drawText emits a single text run without pair kerning.
  const advance = [...text].reduce((sum, char) => sum + font.widthOfTextAtSize(char, 1), 0);
  const rise = font.heightAtSize(1, { descender: false });
  return { advance, rise, depth: font.heightAtSize(1) - rise };
}

export async function describeFields(source) {
  const doc = await load(source.bytes);
  const form = doc.getForm();
  const fields = [];
  for (const field of form.getFields()) {
    if (field.isReadOnly()) continue;
    const base = { name: field.getName() };
    if (field instanceof PDFTextField && !field.isRichFormatted() && !field.isFileSelector() && !field.isPassword()) {
      fields.push({ ...base, kind: 'text', value: field.getText() ?? '', max: field.getMaxLength(), multiline: field.isMultiline() });
    } else if (field instanceof PDFCheckBox) {
      fields.push({ ...base, kind: 'checkbox', value: field.isChecked() });
    } else if (field instanceof PDFRadioGroup) {
      fields.push({ ...base, kind: 'radio', value: field.getSelected() ?? '', options: field.getOptions() });
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      fields.push({ ...base, kind: 'select', value: field.getSelected(), options: field.getOptions(),
        multi: field.isMultiselect(), editable: field instanceof PDFDropdown && field.isEditable() && !field.isMultiselect() });
    }
  }
  return fields;
}

function fill(doc, values) {
  if (!Object.keys(values).length) return;
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const field = form.getField(name);
    if (field instanceof PDFTextField) {
      checkText(value.replace(/\r?\n/g, ''));
      field.setText(value);
    } else if (field instanceof PDFCheckBox) {
      value ? field.check() : field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      value ? field.select(value) : field.clear();
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      value.length ? field.select(value) : field.clear();
    }
  }
  form.updateFieldAppearances();
}

export async function validateFields(source, values) {
  fill(await load(source.bytes), values);
}

export async function previewFields(source, descriptors, values) {
  const widgets = await source.pdf.getFieldObjects();
  const storage = source.pdf.annotationStorage;
  for (const field of descriptors) {
    const value = values?.[field.name];
    for (const item of widgets?.[field.name] ?? []) {
      if (value === undefined) storage.remove(item.id);
      else if (field.kind === 'radio') storage.setValue(item.id, { value: item.exportValues === value || item.exportValues?.[0] === value });
      else storage.setValue(item.id, { value: field.kind === 'select' && !field.multi ? value[0] ?? '' : value });
    }
  }
}

const color = hex => rgb(...hex.match(/\w\w/g).map(part => parseInt(part, 16) / 255));

async function writeMark(doc, page, mark, resources) {
  if (isShape(mark.kind)) return writeShape(doc, page, mark);
  if (mark.kind === 'text' || mark.kind === 'stamp') {
    resources.font ??= await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(mark.text, { x: mark.x, y: mark.y, size: mark.size,
      color: color(mark.color), font: resources.font, rotate: degrees(mark.angle),
      ...(mark.kind === 'stamp' ? { opacity: mark.opacity } : {}) });
  } else if (mark.kind === 'image') {
    if (!resources.images.has(mark.image)) {
      const { type, bytes } = mark.image;
      resources.images.set(mark.image, await (type === 'image/png' ? doc.embedPng(bytes) : doc.embedJpg(bytes)));
    }
    const [dx, dy] = rotatePoint(0, -mark.height, mark.angle);
    page.drawImage(resources.images.get(mark.image), { x: mark.x + dx, y: mark.y + dy,
      width: mark.width, height: mark.height, rotate: degrees(mark.angle) });
  } else {
    const path = mark.points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(3)} ${(-y).toFixed(3)}`).join(' ');
    // A single stroked path keeps the translucency uniform along a highlight.
    page.drawSvgPath(path, { x: 0, y: 0, borderColor: color(mark.color),
      borderWidth: mark.size, borderOpacity: mark.kind === 'highlight' ? 0.38 : 1, borderLineCap: LineCapStyle.Round });
  }
}

export async function createPDF(sources, state, pages, baseId, extract = false) {
  const parsed = new Map();
  for (const id of new Set(pages.map(page => page.source))) {
    const source = sources.get(id);
    const doc = await load(source.clean ?? source.bytes);
    fill(doc, state.fields[id] ?? {});
    parsed.set(id, doc);
  }
  const base = parsed.get(baseId);
  const preserve = !extract && parsed.size === 1 && base && pages.filter(p => !p.blank).length === base.getPageCount();
  function makeBlank(output, entry) {
    const source = parsed.get(entry.source).getPage(entry.index);
    const page = PDFPage.create(output);
    const media = source.getMediaBox(), crop = source.getCropBox();
    page.setMediaBox(media.x, media.y, media.width, media.height);
    page.setCropBox(crop.x, crop.y, crop.width, crop.height);
    page.setRotation(source.getRotation());
    const unit = source.node.lookup(PDFName.of('UserUnit'));
    if (unit) page.node.set(PDFName.of('UserUnit'), unit.clone());
    return page;
  }
  let output, targets;
  if (preserve) {
    output = base;
    const originals = base.getPages();
    targets = pages.map(page => page.blank ? makeBlank(output,page) : originals[page.index]);
    if (targets.some((page, index) => page !== originals[index])) {
      // Reinsertion changes page parents. Keep each page's effective inherited entries
      // without cloning the pages or breaking references from the catalog and form widgets.
      const keys = PDFPageLeaf.InheritableEntries.map(name => PDFName.of(name));
      for (const { node } of originals) {
        for (const key of keys) {
          if (node.has(key)) continue;
          const value = node.getInheritableAttribute(key);
          if (value !== undefined) node.set(key, value);
        }
      }
      for (let index = originals.length - 1; index >= 0; index--) output.removePage(index);
      targets.forEach((page, index) => output.insertPage(index, page));
    }
  } else {
    output = await PDFDocument.create();
    for (const doc of parsed.values()) {
      if (doc.catalog.has(PDFName.of('AcroForm'))) doc.getForm().flatten({ updateFieldAppearances: false });
    }
    const copies = new Map();
    for (const [id, doc] of parsed) {
      const indices = pages.filter(page => page.source === id && !page.blank).map(page => page.index);
      const copied = await output.copyPages(doc, indices);
      indices.forEach((index, i) => copies.set(`${id}:${index}`, copied[i]));
    }
    targets = pages.map(page => output.addPage(page.blank ? makeBlank(output,page) : copies.get(page.id)));
  }
  const resources = { images: new Map() };
  for (let index = 0; index < pages.length; index++) {
    const entry = pages[index], page = targets[index];
    if (entry.crop) {
      const [x,y,r,t] = entry.crop;
      page.setCropBox(x,y,r-x,t-y);
    }
    if (entry.rotation) page.setRotation(degrees((page.getRotation().angle + entry.rotation) % 360));
    for (const mark of entry.marks) await writeMark(output, page, mark, resources);
  }
  const planKey = PDFName.of('PaperplaneSplitV1');
  if (!extract && state.splitPlan) {
    const indices = new Map(pages.map((p,i) => [p.id,i]));
    output.catalog.set(planKey, PDFString.of(JSON.stringify(state.splitPlan.map(g => g.map(id => indices.get(id))))));
  } else output.catalog.delete(planKey);
  return output.save({ updateFieldAppearances: false, useObjectStreams: false });
}
