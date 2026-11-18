import * as renderer from '../vendor/pdfjs/build/pdf.min.mjs';
import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  StandardFonts, degrees, rgb, LineCapStyle, PDFName,
} from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
import { rotatePoint } from './model.js';

const asset = path => new URL(`../vendor/pdfjs/${path}`, import.meta.url).href;
renderer.GlobalWorkerOptions.workerSrc = asset('build/pdf.worker.min.mjs');
export const annotationMode = renderer.AnnotationMode.ENABLE_STORAGE;

export async function openPDF(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = renderer.getDocument({
    data: bytes.slice(), cMapUrl: asset('cmaps/'), cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'), useSystemFonts: false, isEvalSupported: false,
  });
  try {
    const pdf = await task.promise;
    if (!pdf.numPages) throw new Error('Empty document');
    await pdf.getPage(1);
    return { bytes, pdf, name: file.name, destroy: () => task.destroy() };
  } catch (error) {
    await task.destroy().catch(() => {});
    throw new Error(error.name === 'PasswordException'
      ? 'This PDF is password-protected. Open an unlocked copy instead.'
      : 'This file could not be opened as a PDF. It may be corrupt or unsupported.', { cause: error });
  }
}

const load = bytes => PDFDocument.load(bytes, { updateMetadata: false });

export function checkText(value) {
  // Standard Helvetica uses WinAnsi, not arbitrary Unicode. Reject unsupported text before editing.
  const available = /^[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/u;
  if (!available.test(value)) throw new Error('Use Latin text and standard punctuation for this tool.');
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
  if (mark.kind === 'text') {
    resources.font ??= await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(mark.text, { x: mark.x, y: mark.y, size: mark.size,
      color: color(mark.color), font: resources.font, rotate: degrees(mark.angle) });
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
    const doc = await load(source.bytes);
    fill(doc, state.fields[id] ?? {});
    parsed.set(id, doc);
  }
  const base = parsed.get(baseId);
  const preserve = !extract && parsed.size === 1 && base && pages.length === base.getPageCount();
  let output, targets;
  if (preserve) {
    output = base;
    const originals = base.getPages();
    targets = pages.map(page => originals[page.index]);
    if (targets.some((page, index) => page !== originals[index])) {
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
      const indices = pages.filter(page => page.source === id).map(page => page.index);
      const copied = await output.copyPages(doc, indices);
      indices.forEach((index, i) => copies.set(`${id}:${index}`, copied[i]));
    }
    targets = pages.map(page => output.addPage(copies.get(page.id)));
  }
  const resources = { images: new Map() };
  for (let index = 0; index < pages.length; index++) {
    const entry = pages[index], page = targets[index];
    if (entry.rotation) page.setRotation(degrees((page.getRotation().angle + entry.rotation) % 360));
    for (const mark of entry.marks) await writeMark(output, page, mark, resources);
  }
  return output.save({ updateFieldAppearances: false });
}
