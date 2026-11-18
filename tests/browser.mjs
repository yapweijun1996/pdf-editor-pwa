import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, rgb } from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
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
        result.push({ rotation: item.rotate, text: (await item.getTextContent()).items.map(i => i.str).join(' ') });
      }
      return result;
    } finally { await task.destroy(); }
  }, [...await readFile(path(name))]);
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
  const unload = page.waitForEvent('dialog');
  const reload = page.reload({ timeout: 5000 }).catch(() => null);
  const warning = await unload;
  assert.equal(warning.type(), 'beforeunload');
  await warning.dismiss();
  await reload;
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
  await open('saved.pdf');
  await text('#page-count', 'of 2');
  const edited = await inspect('saved.pdf');
  assert.match(edited[0].text, /Sample 1.*Browser verified text/);
  assert.equal(edited[0].rotation, 90);
  assert.match(edited[1].text, /Sample 3/);
  assert.deepEqual(await readFile(path('sample.pdf')), original);
  await evidence('saved-reopened');
  console.log('PASS UI text, rotation, deletion, undo/redo, unsaved navigation/replacement warning, download and reopen; original unchanged.');

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
  console.log('PASS standalone reorder, merge, range validation and extract output/order.');

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
  await mobile.getByRole('button', { name: 'Go to page 2', exact: true }).tap();
  await render(mobile);
  assert.equal(await mobile.locator('#page-number').inputValue(), '2');
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
