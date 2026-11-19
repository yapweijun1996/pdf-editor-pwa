import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFPageTree, rgb } from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
import { serve } from '../scripts/serve.mjs';

const dir = new URL('../test-results/', import.meta.url);
const path = name => new URL(name, dir).pathname;
await mkdir(dir, { recursive: true });
async function fixture(name, count, prefix, withForm = false) {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([400, 520]);
    page.drawText(`${prefix} ${i}`, { x: 35, y: 475, size: 22 });
    page.drawRectangle({ x: 32, y: 450, width: 330, height: 5, color: rgb(.15, .3, .6) });
  }
  if (withForm) {
    const form = doc.getForm(), page = doc.getPage(0);
    form.createTextField('Name').addToPage(page, { x: 60, y: 360, width: 200, height: 28 });
    form.createCheckBox('Agree').addToPage(page, { x: 60, y: 310, width: 20, height: 20 });
    const choice = form.createDropdown('Department');
    choice.addOptions(['Design', 'Engineering']);
    choice.addToPage(page, { x: 60, y: 260, width: 200, height: 28 });
    const radio = form.createRadioGroup('Delivery');
    radio.addOptionToPage('Email', page, { x: 60, y: 220, width: 20, height: 20 });
    radio.addOptionToPage('Mail', page, { x: 90, y: 220, width: 20, height: 20 });
    const list = form.createOptionList('Topics');
    list.addOptions(['Print', 'Web']);
    list.enableMultiselect();
    list.addToPage(page, { x: 60, y: 120, width: 200, height: 60 });
  }
  await writeFile(path(name), await doc.save());
}
await fixture('sample.pdf', 3, 'Sample');
await fixture('merge.pdf', 2, 'Merge');
await fixture('large.pdf', 50, 'Large');
await fixture('form.pdf', 1, 'Form', true);
const original = await readFile(path('sample.pdf'));

async function inheritedFixture() {
  const doc = await PDFDocument.create();
  const first = doc.addPage([360, 300]), second = doc.addPage([380, 320]);
  first.drawText('Inherited first', { x: 35, y: 240, size: 22 });
  second.drawText('Inherited second', { x: 35, y: 240, size: 22 });
  doc.getForm().createTextField('Nested field').addToPage(first, { x: 40, y: 100, width: 200, height: 28 });
  second.setCropBox(20, 30, 350, 280);
  second.node.set(PDFName.of('Rotate'), doc.context.obj(0));

  const root = doc.catalog.Pages(), rootRef = doc.catalog.get(PDFName.of('Pages'));
  const branch = PDFPageTree.withContext(doc.context, rootRef);
  const branchRef = doc.context.register(branch);
  branch.set(PDFName.of('Rotate'), doc.context.obj(90));
  for (const name of ['MediaBox', 'Resources']) {
    const key = PDFName.of(name);
    branch.set(key, doc.context.register(first.node.get(key)));
    first.node.delete(key);
  }
  branch.set(PDFName.of('CropBox'), doc.context.obj([10, 20, 350, 280]));
  root.Kids().remove(1);
  root.Kids().remove(0);
  root.set(PDFName.of('Count'), doc.context.obj(0));
  root.pushTreeNode(branchRef);
  for (const [index, leaf] of [first, second].entries()) {
    branch.insertLeafNode(leaf.ref, index);
    leaf.node.setParent(branchRef);
  }
  const bytes = Buffer.from(await doc.save());
  await writeFile(path('inherited-input.pdf'), bytes);
  return bytes;
}
const inheritedInput = await inheritedFixture();
const server = serve(0);
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const foreignRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
context.on('request', request => {
  if (/^https?:/.test(request.url()) && !request.url().startsWith(`${origin}/`)) foreignRequests.push(request.url());
});
const text = (selector, value, target = page) => target.waitForFunction(([selector, value]) => document.querySelector(selector)?.textContent.includes(value), [selector, value]);
const status = value => text('#status', value);
const render = target => (target ?? page).locator('#paper').waitFor({ state: 'visible' });
const click = name => page.getByRole('button', { name, exact: true }).click();
const tool = name => click(name);
const evidence = (name, target = page) => target.screenshot({ path: path(`${name}.png`), fullPage: true });
async function open(name) {
  await page.locator('#file').setInputFiles(path(name));
  await status(`Opened ${name}.`);
  await render();
}
async function capture(name, action, target = page) {
  const [download] = await Promise.all([target.waitForEvent('download'), action()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(path(name));
  return download.suggestedFilename();
}
async function confirmSaved() {
  assert.equal(await page.locator('#dirty').textContent(), 'Unsaved edits');
  await click('I saved this copy');
  await status('You confirmed that you saved this version');
  assert.equal(await page.locator('#dirty').textContent(), '');
}
async function dismissUnloadWarning(target) {
  const unload = target.waitForEvent('dialog', { timeout: 5000 });
  const reload = target.reload({ timeout: 5000 }).catch(() => null);
  const warning = await unload;
  assert.equal(warning.type(), 'beforeunload');
  await warning.dismiss();
  await reload;
}
async function inspect(name) {
  return page.evaluate(async input => {
    const { getDocument, GlobalWorkerOptions } = await import('/vendor/pdfjs/build/pdf.min.mjs');
    GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    const task = getDocument({ data: Uint8Array.from(input), isEvalSupported: false });
    const pdf = await task.promise;
    try {
      const result = [];
      for (let index = 1; index <= pdf.numPages; index++) {
        const item = await pdf.getPage(index);
        result.push({ view: item.view, rotation: item.rotate, text: (await item.getTextContent()).items.map(i => i.str).join(' ').trim() });
      }
      return result;
    } finally { await task.destroy(); }
  }, [...await readFile(path(name))]);
}
async function inspectBoxes(name) {
  const doc = await PDFDocument.load(await readFile(path(name)));
  return doc.getPages().map(p => [p.getMediaBox(), p.getCropBox()]);
}
async function dragMark(start, end) {
  const overlay = page.locator('#overlay');
  await overlay.scrollIntoViewIfNeeded();
  const b = await overlay.boundingBox();
  await page.mouse.move(b.x + b.width * start[0], b.y + b.height * start[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * end[0], b.y + b.height * end[1], { steps: 12 });
  await page.mouse.up();
}
async function pixel(rx, ry) {
  return page.locator('#canvas').evaluate((canvas, [rx, ry]) =>
    Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width * rx), Math.floor(canvas.height * ry), 1, 1).data), [rx, ry]);
}

try {
  await page.goto(origin);
  await text('#offline', 'Offline ready');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await evidence('welcome');
  await open('sample.pdf');
  await tool('Text');
  await page.locator('#mark-text').fill('Browser verified text');
  await page.locator('#overlay').click({ position: { x: 75, y: 150 } });
  await status('Text added');
  await text('#dirty', 'Unsaved edits');
  await dismissUnloadWarning(page);
  await page.locator('#file').setInputFiles(path('merge.pdf'));
  await page.getByRole('dialog', { name: 'Discard unsaved edits?' }).waitFor();
  await click('Keep editing');
  await status('Kept the current document');
  assert.equal(await page.locator('#overlay text').textContent(), 'Browser verified text');
  await click('Rotate ↻');
  await render();
  await page.locator('#stage').focus();
  await page.keyboard.press('ArrowRight');
  await render();
  await click('Delete page');
  await text('#page-count', 'of 2');
  await click('Undo');
  await text('#page-count', 'of 3');
  await click('Redo');
  await text('#page-count', 'of 2');
  assert.equal(await capture('saved.pdf', () => click('Download PDF')), 'sample-edited.pdf');
  await dismissUnloadWarning(page);
  await click('Rotate ↻');
  await page.locator('#confirm-save').waitFor({ state: 'hidden' });
  await click('Undo');
  await confirmSaved();
  await click('Undo');
  await text('#dirty', 'Unsaved edits');
  await click('Redo');
  await status('Edit redone');
  assert.equal(await page.locator('#dirty').textContent(), '');
  await open('saved.pdf');
  await text('#page-count', 'of 2');
  const edited = await inspect('saved.pdf');
  assert.match(edited[0].text, /Sample 1.*Browser verified text/);
  assert.equal(edited[0].rotation, 90);
  assert.match(edited[1].text, /Sample 3/);
  assert.deepEqual(await readFile(path('sample.pdf')), original);
  await evidence('saved-reopened');
  console.log('PASS UI text, rotation, deletion, undo/redo, unsaved navigation/replacement warning, download and reopen; original unchanged.');

  const deniedContext = await browser.newContext();
  try {
    const denied = await deniedContext.newPage();
    const cdp = await deniedContext.newCDPSession(denied);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
    await denied.goto(origin);
    await denied.locator('#file').setInputFiles(path('sample.pdf'));
    await render(denied);
    await denied.locator('#rotate').click();
    await text('#dirty', 'Unsaved edits', denied);
    const [download] = await Promise.all([denied.waitForEvent('download'), denied.locator('#save').click()]);
    assert.equal(await download.failure(), 'canceled');
    await text('#status', 'Download requested', denied);
    assert.equal(await denied.locator('#dirty').textContent(), 'Unsaved edits');
    await dismissUnloadWarning(denied);
    await denied.locator('#file').setInputFiles(path('merge.pdf'));
    await denied.getByRole('dialog', { name: 'Discard unsaved edits?' }).waitFor();
    await denied.getByRole('button', { name: 'Keep editing' }).click();
    await text('#status', 'Kept the current document', denied);
    assert.equal(await denied.locator('#filename').textContent(), 'sample.pdf');
    await denied.locator('#undo').click();
    await text('#status', 'Edit undone', denied);
    assert.equal(await denied.locator('#dirty').textContent(), '');
    await denied.locator('#redo').click();
    await text('#dirty', 'Unsaved edits', denied);
  } finally { await deniedContext.close(); }
  console.log('PASS denied download canceled by Chromium; navigation and replacement warnings remain, undo/redo keeps the correct dirty state.');

  await open('sample.pdf');
  await click('Next page');
  await click('Move earlier');
  await capture('reordered.pdf', () => click('Download PDF'));
  assert.deepEqual((await inspect('reordered.pdf')).map(p => p.text.trim()), ['Sample 2', 'Sample 1', 'Sample 3']);
  await page.locator('#merge-file').setInputFiles(path('merge.pdf'));
  await status('Appended 2 page(s)');
  await text('#page-count', 'of 5');
  await click('Extract pages');
  await page.getByLabel('Pages or ranges').fill('6');
  await click('Download selection');
  await text('#extract-error', 'Enter page numbers');
  await page.getByLabel('Pages or ranges').fill('2, 4-5');
  await capture('extracted.pdf', () => click('Download selection'));
  assert.deepEqual((await inspect('extracted.pdf')).map(p => p.text.trim()), ['Sample 1', 'Merge 1', 'Merge 2']);
  await text('#page-count', 'of 5');
  await text('#dirty', 'Unsaved edits');
  await capture('merged.pdf', () => click('Download PDF'));
  assert.deepEqual((await inspect('merged.pdf')).map(p => p.text.trim()), ['Sample 2', 'Sample 1', 'Sample 3', 'Merge 1', 'Merge 2']);
  await confirmSaved();
  console.log('PASS standalone reorder, merge, range validation and extract output/order.');

  await open('inherited-input.pdf');
  const inherited = await inspect('inherited-input.pdf');
  assert.deepEqual(inherited, [
    { view: [10, 20, 350, 280], rotation: 90, text: 'Inherited first' },
    { view: [20, 30, 370, 310], rotation: 0, text: 'Inherited second' },
  ]);
  const boxes = await inspectBoxes('inherited-input.pdf');
  assert.deepEqual(boxes.map(([media]) => [media.width, media.height]), [[360, 300], [380, 320]]);
  await click('Move later');
  await capture('inherited-reordered.pdf', () => click('Download PDF'));
  assert.deepEqual(await inspect('inherited-reordered.pdf'), [inherited[1], inherited[0]]);
  assert.deepEqual(await inspectBoxes('inherited-reordered.pdf'), [boxes[1], boxes[0]]);
  const reordered = await PDFDocument.load(await readFile(path('inherited-reordered.pdf')));
  const field = reordered.getForm().getTextField('Nested field');
  const widget = field.acroField.getWidgets()[0];
  const widgetRef = reordered.context.getObjectRef(widget.dict);
  assert.equal(field.isReadOnly(), false);
  assert.equal(widget.P(), reordered.getPage(1).ref);
  assert.ok(widgetRef && reordered.getPage(1).node.Annots().asArray().includes(widgetRef));

  await click('Extract pages');
  await page.getByLabel('Pages or ranges').fill('1-2');
  await capture('inherited-extracted.pdf', () => click('Download selection'));
  assert.deepEqual(await inspect('inherited-extracted.pdf'), [inherited[1], inherited[0]]);
  assert.deepEqual(await inspectBoxes('inherited-extracted.pdf'), [boxes[1], boxes[0]]);
  await click('Previous page');
  await click('Delete page');
  await capture('inherited-deleted.pdf', () => click('Download PDF'));
  assert.deepEqual(await inspect('inherited-deleted.pdf'), [inherited[0]]);
  assert.deepEqual(await inspectBoxes('inherited-deleted.pdf'), [boxes[0]]);
  await click('Undo');
  await page.locator('#merge-file').setInputFiles(path('merge.pdf'));
  await status('Appended 2 page(s)');
  await capture('inherited-merged.pdf', () => click('Download PDF'));
  const merged = await inspect('inherited-merged.pdf');
  assert.deepEqual(merged.slice(0, 2), [inherited[1], inherited[0]]);
  assert.deepEqual(merged.slice(2).map(p => p.text), ['Merge 1', 'Merge 2']);
  assert.deepEqual((await inspectBoxes('inherited-merged.pdf')).slice(0, 2), [boxes[1], boxes[0]]);
  assert.deepEqual(await readFile(path('inherited-input.pdf')), inheritedInput);
  await confirmSaved();
  console.log('PASS inherited MediaBox, CropBox, Rotate and font resources in reordered, extracted, deleted and merged exports; reordered widget stays on its page.');

  await open('form.pdf');
  await click('Fill forms');
  const form = page.getByRole('dialog', { name: 'Fill PDF form' });
  await form.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await form.getByLabel('Agree', { exact: true }).check();
  await form.getByLabel('Department', { exact: true }).selectOption('Engineering');
  await form.getByLabel('Delivery', { exact: true }).selectOption('Email');
  await form.getByLabel('Topics', { exact: true }).selectOption(['Print', 'Web']);
  await click('Apply fields');
  await status('Form fields applied');
  await render();
  await click('Undo');
  await click('Fill forms');
  assert.equal(await form.getByLabel('Name', { exact: true }).inputValue(), '');
  await click('Cancel');
  await click('Redo');
  await capture('filled.pdf', () => click('Download PDF'));
  const savedFields = (await PDFDocument.load(await readFile(path('filled.pdf')))).getForm();
  assert.equal(savedFields.getTextField('Name').getText(), 'Ada Lovelace');
  assert.equal(savedFields.getCheckBox('Agree').isChecked(), true);
  assert.deepEqual(savedFields.getDropdown('Department').getSelected(), ['Engineering']);
  assert.equal(savedFields.getRadioGroup('Delivery').getSelected(), 'Email');
  assert.deepEqual(savedFields.getOptionList('Topics').getSelected(), ['Print', 'Web']);
  await confirmSaved();
  await open('filled.pdf');
  await click('Fill forms');
  assert.equal(await form.getByLabel('Name', { exact: true }).inputValue(), 'Ada Lovelace');
  await evidence('form-reopened');
  await click('Cancel');
  console.log('PASS text, checkbox, radio, dropdown and multi-select AcroForms; undo/redo and reopened values.');

  await open('sample.pdf');
  await tool('Draw');
  await dragMark([.10,.23], [.33,.23]);
  await status('Drawing added');
  await tool('Highlight');
  await dragMark([.10,.34], [.33,.34]);
  await status('Highlight added');
  await tool('Image / Signature');
  await page.locator('#image-file').setInputFiles(new URL('../icons/icon-192.png', import.meta.url).pathname);
  await text('#tool-hint', 'Ready to place');
  await click('Place at page center');
  await status('Image added');
  await evidence('annotation-preview');
  await capture('annotated.pdf', () => click('Download PDF'));
  await confirmSaved();
  await open('annotated.pdf');
  const ink = await pixel(.2, .23), highlight = await pixel(.2, .34), image = await pixel(.53, .53);
  assert.ok(ink[0] < 100 && ink[2] > ink[0], JSON.stringify(ink));
  assert.ok(highlight[0] > 245 && highlight[2] < 220, JSON.stringify(highlight));
  assert.ok(image[2] < 170 && image[2] > image[0], JSON.stringify(image));
  await evidence('annotation-reopened');
  console.log('PASS ink, highlight and PNG placed through UI; sampled rendered pixels after reopening.');

  await page.locator('#file').setInputFiles({ name: 'corrupt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await status('may be corrupt or unsupported');
  await page.locator('#file').setInputFiles(new URL('./fixtures/locked.pdf', import.meta.url).pathname);
  await status('password-protected');
  assert.equal(await page.locator('#filename').textContent(), 'annotated.pdf');
  await open('large.pdf');
  await text('#page-count', 'of 50');
  await page.waitForFunction(() => document.querySelectorAll('#thumbs canvas').length > 0);
  assert.equal(await page.locator('#thumbs button').count(), 50);
  assert.equal(await page.locator('#thumbs button').last().locator('canvas').count(), 0);
  const firstThumbCount = await page.locator('#thumbs canvas').count();
  assert.ok(firstThumbCount < 12, `Initial canvases: ${firstThumbCount}`);
  await page.locator('#stage').focus();
  await page.keyboard.press('End');
  await render();
  await page.getByRole('button', { name: 'Go to page 50' }).locator('canvas').waitFor();
  assert.equal(await page.locator('#page-number').inputValue(), '50');
  assert.equal(await page.locator('#thumbs button').first().locator('canvas').count(), 0);
  await evidence('large-page-50');
  console.log(`PASS corrupt and locked errors, 50-page navigation and lazy thumbnails (${firstThumbCount} initially).`);

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
  const mobile = await mobileContext.newPage();
  await mobile.goto(origin);
  await mobile.locator('#file').setInputFiles(path('sample.pdf'));
  await render(mobile);
  assert.equal(await mobile.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
  const pages = mobile.locator('input[aria-controls~="page-thumbnails"]');
  assert.equal(await pages.isChecked(), false);
  await pages.tap();
  await mobile.getByRole('button', { name: 'Go to page 2', exact: true }).tap();
  await render(mobile);
  assert.equal(await mobile.locator('#page-number').inputValue(), '2');
  await pages.tap();
  assert.equal(await mobile.locator('#page-thumbnails').isVisible(), false);
  await mobile.getByRole('button', { name: 'Zoom in' }).tap();
  await render(mobile);
  await text('#zoom-fit', '125%', mobile);
  await evidence('mobile-dark', mobile);
  await mobileContext.close();
  console.log('PASS touch-emulated 390 px layout, dark palette, thumbnail tap and zoom.');

  const cacheCheck = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys.find(key => key.startsWith('paperplane:')));
    const keysInCache = (await cache.keys()).map(request => new URL(request.url).pathname);
    return { count: keysInCache.length, fonts: keysInCache.some(key => key.includes('/standard_fonts/')),
      cmaps: keysInCache.some(key => key.includes('/cmaps/')), wasm: keysInCache.some(key => key.endsWith('/openjpeg.wasm')) };
  });
  assert.ok(cacheCheck.count > 200 && cacheCheck.fonts && cacheCheck.cmaps && cacheCheck.wasm);
  await context.setOffline(true);
  await new Promise(resolve => server.close(resolve));
  const response = await page.reload({ waitUntil: 'load' });
  assert.ok(response.fromServiceWorker());
  await text('#offline', 'Offline');
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  const base64 = original.toString('base64');
  await page.evaluate(encoded => {
    const file = new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'dropped-offline.pdf', { type: 'application/pdf' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
  }, base64);
  await status('Opened dropped-offline.pdf');
  await render();
  await tool('Text');
  await page.locator('#mark-text').fill('Offline text');
  await click('Place at page center');
  await status('Text added');
  await capture('offline-edited.pdf', () => click('Download PDF'));
  assert.match((await inspect('offline-edited.pdf'))[0].text, /Offline text/);
  await evidence('offline-edit');
  assert.deepEqual(foreignRequests, []);
  assert.deepEqual(errors, []);
  console.log(`PASS offline reload with server stopped, local drop/render/edit/download; ${cacheCheck.count} cached assets; no external requests or page errors in desktop run.`);
} catch (error) {
  await evidence('failure').catch(() => {});
  console.error({ errors, foreignRequests, status: await page.locator('#status').textContent().catch(() => '') });
  throw error;
} finally {
  await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
