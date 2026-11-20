import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
import { serve } from '../scripts/serve.mjs';
import { validatePDF } from '../src/save.js';
import { annotationPage, foreignNote, pageSize } from './fixtures/annotation-page.mjs';

const resultRoot = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(resultRoot, { recursive: true });
const evidence = await mkdtemp(join(resultRoot, 'annotation-'));
console.log(`Evidence: ${evidence}`);
const input = await annotationPage();
const server = serve(0);
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const failures = [];
const click = (page, selector) => page.locator(selector).click();
const snapshot = page => page.evaluate(() => {
  // Playwright serializes typed arrays as plain objects; retain their type tag explicitly.
  return JSON.stringify(window.annotationTestSnapshot(), (_, value) => value instanceof Uint8Array
    ? { $type: 'Uint8Array', bytes: [...value] } : value);
}).then(json => JSON.parse(json, (_, value) => value?.$type === 'Uint8Array' ? Uint8Array.from(value.bytes) : value));
const marks = async page => (await snapshot(page)).pages[0].marks;
const anchor = mark => mark.points?.[0] ?? [mark.x, mark.y];
const point = async (page, x, y) => {
  const box = await page.locator('#overlay').boundingBox();
  return [box.x + box.width * x / pageSize[0], box.y + box.height * y / pageSize[1]];
};
const checkEvidence = (file, data) => writeFile(join(evidence, file), JSON.stringify(data, null, 2));

async function open(page, bytes = input, name = 'annotations.pdf') {
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await page.waitForFunction(name => document.querySelector('#status').textContent.includes(`Opened ${name}.`), name);
  await page.locator('#paper').waitFor({ state: 'visible' });
}

async function run(browserType, name, phone, check, instrument = true) {
  const label = `${browserType.name()}-${name}`;
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 664 } : { width: 1000, height: 1200 },
      ...(phone && { isMobile: true, hasTouch: true }),
      acceptDownloads: true, serviceWorkers: instrument ? 'block' : 'allow',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    if (instrument) {
      // Read-only observer in this loopback response only. No test writes to the model.
      await page.route('**/src/app.js', route => route.fulfill({ contentType: 'text/javascript',
        body: `${app}\nwindow.annotationTestSnapshot = () => structuredClone(session?.current);\n` }));
    }
    await page.goto(origin);
    await check(page, phone, label);
    console.log(`PASS ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}:`, error);
    failures.push(label);
  } finally { await browser.close(); }
}

async function gesture(page, phone, from, to, cancel = false) {
  if (!phone) {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 5 });
    if (cancel) await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    return;
  }
  // WebKit Playwright exposes real touchscreen taps, but not a drag API.
  // Dispatch touch pointer streams on the real hit target and bubble through app listeners.
  await page.evaluate(({ from, to, cancel }) => {
    const target = document.elementFromPoint(...from);
    if (!target?.closest('#overlay')) throw Error(`Touch start hit ${target?.outerHTML.slice(0, 130)}`);
    function send(type, x, y) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch',
        pointerId: 31, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    }
    send('pointerdown', ...from);
    // Handles can be replaced by a preview; deliver subsequent events via the overlay.
    const overlay = document.querySelector('#overlay');
    for (let i = 1; i <= 5; i++) overlay.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerType: 'touch', pointerId: 31, isPrimary: true, buttons: 1,
      clientX: from[0] + (to[0] - from[0]) * i / 5, clientY: from[1] + (to[1] - from[1]) * i / 5,
    }));
    overlay.dispatchEvent(new PointerEvent(cancel ? 'pointercancel' : 'pointerup', {
      bubbles: true, pointerType: 'touch', pointerId: 31, isPrimary: true, clientX: to[0], clientY: to[1],
    }));
  }, { from, to, cancel });
}

async function editHistory(page, before, after) {
  await click(page, '#undo');
  assert.deepEqual(await snapshot(page), before, 'Undo must restore the entire previous model');
  await click(page, '#redo');
  assert.deepEqual(await snapshot(page), after, 'Redo must restore the entire edited model');
}

async function hitPoint(locator) {
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    for (const y of [.5, .3, .7, .1, .9]) for (const x of [.5, .3, .7, .1, .9]) {
      const p = [Math.round(r.left + x*r.width), Math.round(r.top + y*r.height)];
      if (document.elementFromPoint(...p) === el) return p;
    }
    throw Error(`Mark is not hit-testable: ${el.outerHTML.slice(0, 100)}`);
  });
}

async function selection(page, phone, label) {
  const rows = [];
  for (const kind of ['text', 'ink', 'highlight', 'image']) {
    await open(page);
    const tap = async p => phone ? page.touchscreen.tap(...p) : page.mouse.click(...p);
    await click(page, `[data-mode=${kind}]`);
    if (kind === 'text') {
      await page.locator('#mark-text').fill('MMMM');
      await page.locator('#mark-text').blur();
      await tap(await point(page, 57, 106));
    } else if (kind === 'image') {
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 8;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#29669b'; ctx.fillRect(0, 0, 16, 8);
        return canvas.toDataURL().split(',')[1];
      });
      await page.locator('#image-file').setInputFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await page.waitForFunction(() => document.querySelector('#tool-hint').textContent.includes('Ready to place'));
      await tap(await point(page, 57, 85));
    } else {
      await gesture(page, phone, await point(page, 57, 85), await point(page, 124, 119), true);
      assert.equal((await marks(page)).length, 0);
      await gesture(page, phone, await point(page, 57, 85), await point(page, 124, 119));
    }
    const placed = await snapshot(page);
    const [original] = placed.pages[0].marks;
    assert.equal(placed.pages[0].marks.length, 1);
    assert.equal(original.kind, kind);
    if (kind === 'image') assert.ok(original.image.bytes instanceof Uint8Array && original.image.bytes.length > 0);
    await tap(await hitPoint(page.locator('#overlay > [data-mark-id]:not([data-handle])')));
    assert.equal(await page.locator('#mark-list').inputValue(), original.markId);
    assert.deepEqual(await snapshot(page), placed, 'Selection is not a model edit');
    async function handle(operation) {
      const target = page.locator(`[data-handle=${operation}]`);
      await target.waitFor({ state: 'visible' });
      const { x, y, width, height } = await target.evaluate(el => el.getBoundingClientRect().toJSON());
      assert.ok(width >= 44 && height >= 44, `${kind} ${operation}: ${width}×${height}`);
      const p = [x + width/2, y + height/2];
      assert.equal(await target.evaluate((el, p) => document.elementFromPoint(...p) === el, p), true);
      return { p, width, height };
    }
    if (phone) await click(page, '.mobile-disclosure input[aria-controls=option-controls]');
    const move = await handle('move');
    const destination = [move.p[0] + 24, move.p[1] + 17];
    await gesture(page, phone, move.p, destination, true);
    assert.deepEqual(await snapshot(page), placed, 'Canceled move must not commit');
    await gesture(page, phone, move.p, destination);
    const moved = await snapshot(page);
    const [translated] = await marks(page);
    const [x, y] = anchor(original);
    assert.ok(anchor(translated)[0] > x && anchor(translated)[1] < y);
    assert.equal((await marks(page)).length, 1);
    assert.equal(translated.markId, original.markId);
    await editHistory(page, placed, moved);
    assert.equal(await page.locator('#mark-list').inputValue(), original.markId);
    if (phone && await page.locator('.mobile-disclosure input[aria-controls=option-controls]').isChecked()) {
      await click(page, '.mobile-disclosure input[aria-controls=option-controls]');
    }
    const resize = await handle('resize');
    await gesture(page, phone, resize.p, [resize.p[0] + 26, resize.p[1] + 22]);
    const resized = await snapshot(page);
    const [scaled] = await marks(page);
    if (kind === 'image') assert.ok(scaled.width > translated.width && Math.abs(scaled.height/scaled.width - .5) < 1e-8);
    else if (kind === 'text') assert.ok(scaled.size > translated.size);
    else assert.ok(scaled.points.at(-1)[0] > translated.points.at(-1)[0]);
    await editHistory(page, moved, resized);
    assert.equal(await page.locator('#mark-list').inputValue(), original.markId);
    if (phone && !await page.locator('.mobile-disclosure input[aria-controls=option-controls]').isChecked()) {
      await click(page, '.mobile-disclosure input[aria-controls=option-controls]');
    }
    await click(page, '[data-nudge=right]');
    const nudged = await snapshot(page);
    assert.ok(Math.abs(anchor(nudged.pages[0].marks[0])[0] - anchor(scaled)[0] - 1) < 1e-8);
    await editHistory(page, resized, nudged);
    if (kind !== 'image') {
      await page.locator('#edit-color-text').fill('#bc3071');
      await page.locator('#edit-color-text').blur();
      const recolored = await snapshot(page);
      assert.equal(recolored.pages[0].marks[0].color, '#bc3071');
      await editHistory(page, nudged, recolored);
      await page.locator('#edit-size').fill('24');
      await page.locator('#edit-size').blur();
      const reweighted = await snapshot(page);
      assert.equal(reweighted.pages[0].marks[0].size, 24);
      await editHistory(page, recolored, reweighted);
    }
    const styled = await snapshot(page);
    await click(page, '#remove-mark');
    const deleted = await snapshot(page);
    assert.equal(deleted.pages[0].marks.length, 0);
    await editHistory(page, styled, deleted);
    rows.push({ kind, counts: [1, 1, resized.pages[0].marks.length, styled.pages[0].marks.length, 0],
      before: anchor(original), after: anchor(translated), handles: [[move.width, move.height], [resize.width, resize.height]], deepEqual: true });
    // Clear the dirty document before the next synthetic input.
    await page.reload();
  }
  await checkEvidence(`${label}.json`, rows);
  console.log(label, JSON.stringify(rows));
}

// Expected types and interior color samples are defined from the input gestures,
// not from the runtime shape generator or its private PDF metadata. Coordinates are top-down.
const shapes = [
  ['underline', 'Underline', 40, 68, '#85223c', [[120, 68]], [[120, 54]]],
  ['strikeout', 'StrikeOut', 95, 123, '#1a6e38', [[120, 109]], [[120, 123]]],
  ['rectangle', 'Square', 150, 178, '#2a47bb', [[120, 150], [120, 178]], [[120, 164]]],
  ['ellipse', 'Circle', 205, 233, '#963f0d', [[120, 205], [120, 233]], [[120, 219], [60, 205]]],
  ['line', 'Line', 260, 260, '#651483', [[120, 260]], [[170, 267]]],
  ['arrow', 'Line/OpenArrow', 315, 315, '#0a6774', [[120, 315], [172, 319]], [[120, 328]]],
];
const buttons = ['Underline', 'Strikethrough', 'Rectangle', 'Ellipse', 'Line', 'Arrow'];
const names = shapes.map(([kind]) => kind);
const expectedTypes = [...shapes.map(([, type]) => type), 'Text'].sort();
const samples = shapes.flatMap(([, , , , hex, hits, misses]) => [
  ...hits.map(p => [p, [...hex.slice(1).match(/../g).map(v => parseInt(v, 16)), 255]]),
  ...misses.map(p => [p, [255, 255, 255, 255]]),
]);

async function readPDF(page, bytes, offset) {
  assert.equal(await validatePDF(bytes, 1), 1);
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  const ids = [];
  const types = annots.asArray().map(ref => {
    const annot = doc.context.lookup(ref, PDFDict);
    const key = name => PDFName.of(name);
    const type = annot.get(key('Subtype')).decodeText();
    const id = annot.get(key('NM')).decodeText();
    if (type === 'Text') assert.equal(annot.get(key('Contents')).decodeText(), foreignNote);
    else {
      ids.push(id);
      assert.ok(annot.lookup(key('AP'), PDFDict).lookup(key('N'), PDFStream));
      assert.equal(annot.lookup(key('BS'), PDFDict).get(key('W')).asNumber(), 6);
    }
    const ending = annot.get(key('LE'))?.asArray().at(-1).decodeText();
    return ending && ending !== 'None' ? `${type}/${ending}` : type;
  });
  assert.deepEqual(types.sort(), expectedTypes);
  assert.equal(new Set(ids).size, 6);
  const rendered = await page.evaluate(async ({ bytes, samples, offset }) => {
    const reader = await import('/vendor/pdfjs/build/pdf.min.mjs');
    reader.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    const task = reader.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false });
    try {
      const pdf = await task.promise;
      if (pdf.numPages !== 1) throw Error(`Unexpected page count ${pdf.numPages}`);
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 3 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      const canvasContext = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvas, canvasContext, viewport, annotationMode: reader.AnnotationMode.ENABLE }).promise;
      const annotations = await page.getAnnotations({ intent: 'display' });
      return { annotations: annotations.map(a => ({ type: a.subtype, ending: a.lineEndings?.at(-1), text: a.contentsObj?.str, rect: a.rect })),
        colors: samples.map(([[x,y]]) => [...canvasContext.getImageData((x + (y < 80 ? offset : 0))*3, y*3, 1, 1).data]) };
    } finally { await task.destroy(); }
  }, { bytes: [...bytes], samples, offset });
  assert.deepEqual(rendered.annotations.map(a => a.ending && a.ending !== 'None' ? `${a.type}/${a.ending}` : a.type).sort(), expectedTypes);
  assert.equal(rendered.annotations.find(a => a.type === 'Text').text, foreignNote);
  for (const [i, [p, rgba]] of samples.entries()) assert.deepEqual(rendered.colors[i], rgba, `Expected ${rgba} at ${p}`);
  return { pdfLib: types, pdfJs: rendered.annotations, pixels: samples.map(([point], i) => [point, rendered.colors[i]]), ids };
}

async function download(page, label) {
  const [event] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), click(page, '#save')]);
  assert.equal(await event.failure(), null);
  const path = join(evidence, `${label}.pdf`);
  await event.saveAs(path);
  return readFile(path);
}

async function roundTrip(page, phone, label) {
  await open(page);
  for (const [kind, , y0, y1, hex] of shapes) {
    await click(page, '#more-tools');
    await click(page, `[data-shape=${kind}]`);
    await page.locator('#shape-color').fill(hex);
    await page.locator('#shape-color').blur();
    await page.locator('#shape-width').fill('6');
    await page.locator('#shape-width').blur();
    if (phone) await click(page, '.mobile-disclosure input[aria-controls=option-controls]');
    await gesture(page, phone, await point(page, 60, y0), await point(page, 180, y1));
  }
  const initial = await marks(page);
  assert.deepEqual(initial.map(m => m.kind), names);
  for (const [i, mark] of initial.entries()) {
    assert.equal(mark.color, shapes[i][4]); assert.equal(mark.size, 6);
  }
  let expected = initial;
  const outputs = [];
  for (let generation = 0; generation < 3; generation++) {
    const bytes = await download(page, `${label}-${generation}`);
    const parsed = await readPDF(page, bytes, generation ? 1 : 0);
    assert.deepEqual(parsed.ids.sort(), initial.map(m => `paperplane:${m.markId}`).sort());
    outputs.push(parsed);
    await page.reload();
    await open(page, bytes, `round-${generation}.pdf`);
    assert.deepEqual(await marks(page), expected);
    assert.equal(await page.locator('#overlay > [data-mark-id]').count(), 6);
    // The six live overlays must not also appear in the app's base canvas.
    const base = await page.locator('#canvas').evaluate((canvas, { samples, pageSize, generation }) => {
      const ctx = canvas.getContext('2d');
      return samples.map(([[x,y]]) => [...ctx.getImageData(Math.round((x + (y < 80 && generation ? 1 : 0))*canvas.width/pageSize[0]),
        Math.round(y*canvas.height/pageSize[1]), 1, 1).data]);
    }, { samples, pageSize, generation });
    for (const rgba of base) assert.deepEqual(rgba, [255, 255, 255, 255], 'Reopened base canvas must not contain a second copy of a shape');
    if (!generation) {
      if (phone) await click(page, '#more-tools');
      await click(page, '#select-tool');
      await page.locator('#mark-list').selectOption({ index: 1 });
      await click(page, '[data-nudge=right]');
      expected = await marks(page);
      assert.equal(expected[0].points[0][0], initial[0].points[0][0] + 1);
      assert.deepEqual(expected.slice(1), initial.slice(1));
    }
  }
  await checkEvidence(`${label}.json`, outputs);
  console.log(`${label}: 3 generations; each reader found six shapes + foreign note, ${samples.length} pixel checks per PDF`);
}

// Inventory from the DOM, verify each control against Playwright's actual AX
// tree (not its DOM attributes). Native hidden file inputs are triggered by named
// buttons. A modal's outside controls are inert and checked in the non-modal view.
async function axInventory(page, label, state) {
  const scope = await page.locator('dialog[open]').count() ? page.locator('dialog[open]') : page.locator('body');
  const candidates = scope.locator('button, input:not([type=hidden]), select, textarea, a[href], summary, [role=button], [tabindex], [contenteditable]');
  const controls = [];
  for (const item of await candidates.all()) {
    if (!await item.isVisible()) continue;
    const html = await item.evaluate(el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`);
    const tree = await item.ariaSnapshot({ timeout: 3500 });
    requireNamedControl(tree, html);
    controls.push({ html, tree });
  }
  assert.ok(controls.length > 0);
  await writeFile(join(evidence, `${label}-${state}.ax.yml`), await scope.ariaSnapshot());
  await checkEvidence(`${label}-${state}-controls.json`, controls);
  return controls.length;
}

function requireNamedControl(tree, html) {
  const exposed = /^- (button|combobox|listbox|textbox|checkbox|spinbutton|slider|radio|link|region|switch|searchbox) "((?:[^"\\]|\\.)+)"/.exec(tree);
  assert.ok(exposed && exposed[2].trim(), `Missing AX role or name for ${html}: ${tree}`);
}

async function keyboard(page, phone, label) {
  const tab = phone ? 'Alt+Tab' : 'Tab';
  const back = phone ? 'Alt+Shift+Tab' : 'Shift+Tab';
  const key = name => page.keyboard.press(name);
  const focused = selector => page.locator(selector).evaluate(el => el === document.activeElement);
  const focusChecks = [];
  const inventories = {};
  async function reach(selector) {
    for (let i = 0; i < 65 && !await focused(selector); i++) await key(tab);
    assert.ok(await focused(selector), `Not reachable via Tab: ${selector}`);
    const style = await page.locator(selector).evaluate(el => {
      const parent = el.closest('.mobile-disclosure') ?? el;
      const css = getComputedStyle(parent);
      const r = parent.getBoundingClientRect();
      // Phone panels overlay the viewer's center; check its exposed top edge.
      const y = el.id === 'stage' ? r.top + 8 : r.y + r.height/2;
      return { visible: el.matches(':focus-visible'), style: css.outlineStyle, width: parseFloat(css.outlineWidth),
        color: css.outlineColor, hit: parent.contains(document.elementFromPoint(r.x + r.width/2, y)) };
    });
    assert.ok(style.visible && style.style === 'solid' && style.width >= 2 && style.hit,
      `Visible keyboard focus for ${selector}: ${JSON.stringify(style)}`);
    focusChecks.push({ selector, ...style });
    if (focusChecks.filter(check => check.selector === selector).length === 1) {
      await page.screenshot({ path: join(evidence, `${label}-focus-${focusChecks.length}.png`) });
    }
  }
  async function activate(selector, keyName = 'Enter') { await reach(selector); await key(keyName); }
  async function enter(selector, text) {
    await reach(selector);
    await key(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type(text);
    await key(tab);
  }
  const options = '.mobile-disclosure input[aria-controls=option-controls]';
  inventories.empty = await axInventory(page, label, 'empty');
  await open(page);
  inventories.loaded = await axInventory(page, label, 'loaded');
  // Gather legacy views too: the inventory must not hide controls just because
  // their behavior predates this feature. Keyboard actions below are for S3a.
  for (const mode of ['text', 'ink', 'highlight', 'image']) {
    await activate(`[data-mode=${mode}]`);
    inventories[mode] = await axInventory(page, label, mode);
  }
  await activate('[data-mode=view]');
  for (const [name, selector] of [['file', '#file-options'], ['extract', '#extract']]) {
    if (phone) await activate('#more-tools');
    await activate(selector);
    inventories[name] = await axInventory(page, label, name);
    await key('Escape');
  }
  await activate('#more-tools');
  inventories.more = await axInventory(page, label, 'more');
  await activate('#tools-sheet [data-close]', 'Space');
  assert.equal(await page.locator('#tools-sheet').isVisible(), false);
  assert.ok(await focused('#more-tools'));
  await key(back);
  assert.ok(!await focused('#more-tools'), 'Shift+Tab moves keyboard focus backward');
  await key(tab);
  assert.ok(await focused('#more-tools'));
  for (const [index, [kind, , , , hex]] of shapes.entries()) {
    await activate('#more-tools');
    const control = page.getByRole('button', { name: buttons[index], exact: true });
    assert.equal(await control.count(), 1);
    await activate(`[data-shape=${kind}]`, index % 2 ? 'Space' : 'Enter');
    assert.equal(await page.locator('#paper').getAttribute('data-mode'), kind);
    assert.equal(await page.locator(`[data-shape=${kind}]`).getAttribute('aria-pressed'), 'true');
    assert.ok(await focused('#shape-width'));
    if (phone && !index) {
      await activate(options, 'Space');
      assert.equal(await page.locator('#option-controls').isVisible(), false);
      await activate(options, 'Space');
      assert.equal(await page.locator('#option-controls').isVisible(), true);
    }
    inventories[kind] = await axInventory(page, label, kind);
    await enter('#shape-color', hex);
    await enter('#shape-width', '6');
    await activate('#keyboard-place', 'Space');
    const current = await marks(page);
    assert.deepEqual(current.map(m => m.kind), names.slice(0, index + 1));
    assert.equal(current.at(-1).color, hex);
    assert.equal(current.at(-1).size, 6);
    await key('Escape');
    assert.equal(await page.locator('#paper').getAttribute('data-mode'), 'view');
  }
  if (phone) await activate('#more-tools');
  await activate('#select-tool');
  assert.ok(await focused('#mark-list'));
  await reach('#mark-list');
  await key('1');
  if (await focused('#mark-list')) await key(tab);
  assert.equal(await page.locator('#mark-list').inputValue(), (await marks(page))[0].markId);
  assert.ok(await focused('#stage'));
  inventories.selection = await axInventory(page, label, 'selection');
  const preMove = await snapshot(page);
  const [x, y] = anchor((await marks(page))[0]);
  await reach('#stage');
  await key('ArrowRight');
  assert.deepEqual(anchor((await marks(page))[0]), [x + 1, y]);
  let p = [x + 1, y];
  for (const [direction, dx, dy] of [['up', 0, 1], ['left', -1, 0], ['down', 0, -1], ['right', 1, 0]]) {
    await activate(`[data-nudge=${direction}]`, 'Space');
    p = [p[0] + dx, p[1] + dy];
    assert.deepEqual(anchor((await marks(page))[0]), p);
  }
  assert.deepEqual((await marks(page)).slice(1), preMove.pages[0].marks.slice(1));
  const length = m => Math.hypot(m.points[1][0] - m.points[0][0], m.points[1][1] - m.points[0][1]);
  const firstLength = length((await marks(page))[0]);
  await activate('#grow-mark');
  const grown = length((await marks(page))[0]);
  assert.ok(grown > firstLength);
  await activate('#shrink-mark');
  assert.ok(length((await marks(page))[0]) < grown);
  await enter('#edit-color-text', '#b03c8d');
  assert.equal((await marks(page))[0].color, '#b03c8d');
  assert.equal(await page.locator('#edit-color').inputValue(), '#b03c8d');
  await enter('#edit-size', '7');
  assert.equal((await marks(page))[0].size, 7);
  const preInputs = await snapshot(page);
  await reach('#edit-color-text');
  await key('ArrowLeft');
  await key('Delete');
  assert.deepEqual(await snapshot(page), preInputs, 'Editing keys in a field do not move/delete the mark');
  const preDelete = await snapshot(page);
  await activate('#remove-mark', 'Space');
  const deleted = await snapshot(page);
  assert.equal(deleted.pages[0].marks.length, 5);
  await activate('#undo');
  assert.deepEqual(await snapshot(page), preDelete);
  await activate('#redo');
  assert.deepEqual(await snapshot(page), deleted);
  await activate('#undo');
  await reach('#mark-list');
  await key('1');
  if (await focused('#mark-list')) await key(tab);
  await reach('#stage');
  await key('Delete');
  assert.deepEqual(await snapshot(page), deleted);
  await key('Escape');
  assert.equal(await page.locator('#paper').getAttribute('data-mode'), 'view');

  // Scratch state only: fail the exact same naming predicate on an unnamed
  // real AX node, and fail the keyboard assertion after removing an app handler.
  await page.evaluate(() => {
    const b = document.createElement('button'); b.id = 'nameless-test'; document.body.append(b);
  });
  const badTree = await page.locator('#nameless-test').ariaSnapshot();
  assert.throws(() => requireNamedControl(badTree, '#nameless-test'), /Missing AX role or name/);
  await page.locator('#nameless-test').evaluate(el => el.remove());
  async function assertMoreOpens() {
    await activate('#more-tools');
    assert.ok(await page.locator('#tools-sheet').isVisible(), 'More must open after keyboard activation');
  }
  await assertMoreOpens();
  await key('Escape');
  await page.locator('#more-tools').evaluate(el => el.onclick = null);
  await assert.rejects(assertMoreOpens, /More must open after keyboard activation/);
  await checkEvidence(`${label}-keyboard.json`, { inventories, focusChecks, negative: { badTree, removedHandlerDetected: true },
    nativeColorPicker: 'AX name and synchronized value; keyboard changes use the hex field, not the OS picker.' });
  console.log(`${label}: ${Object.values(inventories).reduce((a, b) => a+b)} named controls, ${focusChecks.length} visible focus checks, 2 negative controls`);
}

async function offline(page, _phone, label) {
  await page.waitForFunction(() => navigator.serviceWorker.controller && document.querySelector('#offline').textContent.includes('Offline ready'));
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await page.context().setOffline(true);
  await page.reload();
  await open(page);
  await click(page, '#more-tools');
  await click(page, '[data-shape=rectangle]');
  await click(page, '#keyboard-place');
  const bytes = await download(page, label);
  assert.equal(await validatePDF(bytes, 1), 1);
  const doc = await PDFDocument.load(bytes);
  const refs = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  assert.deepEqual(refs.asArray().map(ref => doc.context.lookup(ref, PDFDict).get(PDFName.of('Subtype')).decodeText()).sort(), ['Square', 'Text']);
}

try {
  for (const [browserType, phone] of [[chromium, false], [webkit, true]]) {
    await run(browserType, 'selection', phone, selection);
    await run(browserType, 'round-trip', phone, roundTrip);
    await run(browserType, 'keyboard', phone, keyboard);
  }
  await run(chromium, 'offline-shape', false, offline, false);
} finally {
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
assert.deepEqual(failures, [], 'Annotation browser checks');
