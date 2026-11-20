import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, decodePDFRawStream, degrees } from '../../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
import { validatePDF } from '../../src/save.js';

const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
const key = PDFName.of;
export const boxes = [
  { media: [0, 0, 320, 400], crop: [0, 0, 320, 400], rotation: 0, unit: 1 },
  { media: [12, 20, 270, 390], crop: [32, 50, 200, 280], rotation: 90, unit: 2 },
  { media: [0, 0, 235, 305], crop: [0, 0, 235, 305], rotation: 180, unit: 1 },
  ...Array.from({ length: 5 }, (_, i) => ({ media: [0, 0, 300 + i, 420], crop: [0, 0, 300 + i, 420], rotation: 0, unit: 1 })),
];
export async function mixedPDF() {
  const pdf = await PDFDocument.create();
  const pages = boxes.map(({ media, crop, rotation, unit }, i) => {
    const p = pdf.addPage();
    p.setMediaBox(...media);
    p.setCropBox(...crop);
    p.setRotation(degrees(rotation));
    if (unit !== 1) p.node.set(key('UserUnit'), pdf.context.obj(unit));
    p.drawText(`Sheet-${i + 1}`, { x: crop[0] + 36, y: crop[1] + 110, size: 13 });
    return p;
  });
  const note = pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [78, 184, 96, 202] });
  note.set(key('Contents'), PDFHexString.fromText('Independent fixture note'));
  pages[1].node.addAnnot(pdf.context.register(note));
  const field = pdf.getForm().createTextField('Fixture field');
  field.setText('Keep form');
  field.addToPage(pages[0], { x: 45, y: 180, width: 90, height: 25 });
  return Buffer.from(await pdf.save());
}

export async function openFixture(page, origin, bytes) {
  // Append a read-only observer in the synthetic response, never in production.
  await page.route('**/src/app.js', route => route.fulfill({ contentType: 'text/javascript', body: `${app}\n
    window.pageProof = {
      state: () => structuredClone(session?.current),
      renderReady: () => !!viewer.view && !$('paper').hidden && !busy,
      draftCommitted: () => !!session && draftState === session.current,
      drafts: () => vault.drafts(),
      readDraft: async record => [...await vault.readVersion(record)],
    };
    void initialization.then(() => { window.pageProof.initialized = true; });
  ` }));
  await page.goto(origin);
  await page.waitForFunction(() => window.pageProof?.initialized);
  await page.locator('#file').setInputFiles({ name: 'mixed-pages.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Opened mixed-pages.pdf.'));
  await rendered(page);
}
export const state = page => page.evaluate(() => window.pageProof.state());
export const rendered = page => page.waitForFunction(() => window.pageProof.renderReady()).then(h => h.dispose());
export const idOrder = value => value.pages.map(p => p.id);
export const activate = locator => locator.press('Enter');
export const undo = async (page, value) => {
  await rendered(page);
  await activate(page.locator('#undo:enabled'));
  assert.deepEqual(await state(page), value, 'One Undo must restore the full previous state');
  await rendered(page);
};
export async function download(page, trigger) {
  const [event] = await Promise.all([page.waitForEvent('download'), trigger()]);
  assert.equal(await event.failure(), null);
  return { bytes: await readFile(await event.path()), name: event.suggestedFilename() };
}
export const copy = async page => {
  const { bytes } = await download(page, () => page.locator('#save').click());
  if (await page.evaluate(() => Boolean(window.pageProof))) await rendered(page);
  const fallback = page.locator('#file-dialog[open]');
  if (await fallback.isVisible()) await fallback.getByRole('button', { name: 'Close', exact: true }).click();
  return bytes;
};

export async function inspect(reader, bytes, count, { pixels = false } = {}) {
  assert.equal(await validatePDF(bytes, count), count);
  const lib = await PDFDocument.load(bytes);
  assert.equal(lib.getPageCount(), count);
  const raw = lib.getPages().map(p => {
    const rect = ({ x, y, width, height }) => [x, y, width, height];
    const streams = p.node.Contents();
    const content = (streams instanceof PDFArray ? streams.asArray().map(r => lib.context.lookup(r)) : [streams])
      .filter(s => s instanceof PDFRawStream).map(s => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n');
    const gs = p.node.Resources()?.lookupMaybe(key('ExtGState'), PDFDict);
    const opacity = Object.fromEntries((gs?.entries() ?? []).map(([name, ref]) => [name.asString(), lib.context.lookup(ref).get(key('ca'))?.asNumber()]));
    const annotations = (p.node.Annots()?.asArray() ?? []).map(ref => {
      const dict = lib.context.lookup(ref);
      return dict ? [dict.get(key('Subtype')).toString(), dict.get(key('Contents'))?.decodeText()] : ['unresolved reference', ref.toString()];
    });
    return { media: rect(p.getMediaBox()), crop: rect(p.getCropBox()), rotation: p.getRotation().angle,
      unit: p.node.get(key('UserUnit'))?.asNumber() ?? 1, annotations, content, opacity };
  });
  const js = await reader.evaluate(async ({ bytes, pixels }) => {
    const pdfjs = await import('/vendor/pdfjs/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' });
    try {
      const pdf = await task.promise, pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const p = await pdf.getPage(n), vp = p.getViewport({ scale: 1 });
        const labels = (await p.getTextContent()).items.filter(t => t.str?.trim()).map(t => {
          const [a, b, , , x, y] = t.transform;
          const [u, v] = vp.convertToViewportPoint(x, y);
          const [r, s] = vp.convertToViewportPoint(x + a, y + b);
          return { text: t.str, x: u, y: v, angle: Math.atan2(v - s, r - u) * 180 / Math.PI };
        });
        const annotations = (await p.getAnnotations()).map(a => [a.subtype, a.contentsObj?.str || null]);
        const result = { view: p.view, width: vp.width, height: vp.height, rotation: p.rotate, labels, annotations };
        if (pixels) {
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          const ctx = canvas.getContext('2d');
          await p.render({ canvas, viewport: vp }).promise;
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          result.pixelHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))];
          let grayInk = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i] >= 159 && data[i] <= 164 && data[i] === data[i+1] && data[i] === data[i+2]) grayInk++;
          result.grayInk = grayInk;
        }
        pages.push(result);
      }
      return pages;
    } finally { await task.destroy(); }
  }, { bytes: [...bytes], pixels });
  assert.equal(js.length, count);
  return { raw, js, field: lib.catalog.get(key('AcroForm')) ? lib.getForm().getFields().map(f => f.getName()) : [] };
}

export function geometry(result, expected) {
  assert.equal(result.raw.length, expected.length);
  for (const [i, { media, crop, rotation, unit }] of expected.entries()) {
    const { raw, js } = result;
    assert.deepEqual([raw[i].media, raw[i].crop, raw[i].rotation, raw[i].unit], [media, crop, rotation, unit], `Raw boxes for page ${i + 1}`);
    const [x, y, w, h] = crop;
    assert.deepEqual(js[i].view, [x, y, x + w, y + h]);
    assert.equal(js[i].rotation, rotation);
    assert.deepEqual([js[i].width, js[i].height], (rotation % 180 ? [h, w] : [w, h]).map(v => v * unit));
  }
}

export async function axTarget(locator, roleName) {
  await locator.scrollIntoViewIfNeeded();
  assert.match(await locator.ariaSnapshot(), roleName);
  const target = await locator.evaluate(el => {
    const b = el.getBoundingClientRect();
    return [b.width, b.height, el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2))];
  });
  assert.ok(target[0] >= 44 && target[1] >= 44 && target[2], `44px and center hit: ${locator} ${target}`);
}

export async function keyboardFocus(locator) {
  await locator.focus();
  const webkit = locator.page().context().browser().browserType().name() === 'webkit';
  await locator.page().keyboard.press(webkit ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await locator.page().keyboard.press(webkit ? 'Alt+Tab' : 'Tab');
  assert.equal(await locator.evaluate(el => {
    const css = getComputedStyle(el);
    return el === document.activeElement && el.matches(':focus-visible') && css.outlineStyle === 'solid' && parseFloat(css.outlineWidth) >= 2;
  }), true, String(locator));
}

export const center = async locator => {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};

export async function touchPointer(target, phase, point, id = 42) {
  await target.dispatchEvent(`pointer${phase}`, {
    pointerType: 'touch', pointerId: id, isPrimary: id === 42,
    clientX: point[0], clientY: point[1], button: 0, buttons: phase === 'down' || phase === 'move' ? 1 : 0,
    bubbles: true,
  });
}
