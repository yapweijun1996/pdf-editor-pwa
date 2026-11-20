import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';
import { serve } from '../scripts/serve.mjs';
import { activate, axTarget, boxes, center, copy, download, geometry, idOrder, inspect, keyboardFocus,
  mixedPDF, openFixture, rendered, state, touchPointer, undo } from './fixtures/pages-page.mjs';

const server = serve(0);
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const input = await mixedPDF();
let failures = 0;
const cropped = { ...boxes[1], crop: [47, 65, 155, 225] };
const bare = boxes[1];
const approx = (actual, expected, margin = 0.05) => assert.ok(Math.abs(actual - expected) <= margin, `${actual} ≈ ${expected}`);
const escape = page => page.keyboard.press('Escape');
const labels = record => record.labels.map(l => l.text);
const tools = page => activate(page.locator('#page-tools'));
const named = (page, name) => page.getByRole('button', { name, exact: true });
const dirty = async page => assert.equal(await page.locator('#dirty').textContent(), 'Unsaved edits');
const closeTools = page => named(page, 'Close').press('Enter');
const status = (page, text) => page.waitForFunction(text => document.querySelector('#status').textContent.includes(text), text).then(h => h.dispose());
const text = (page, selector, pattern) => page.locator(selector).textContent().then(value => assert.match(value, pattern));

async function run(type, name, check) {
  const mobile = type === webkit;
  const browser = await type.launch();
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 664 } : { width: 1100, height: 950 },
      hasTouch: mobile, isMobile: mobile, acceptDownloads: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const reader = await context.newPage();
    await reader.route('**/pages-reader', route => route.fulfill({ contentType: 'text/html', body: '<title>PDF.js readback</title>' }));
    await reader.goto(`${origin}/pages-reader`);
    await page.bringToFront();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await openFixture(page, origin, input);
    if (mobile) {
      const stage = await page.locator('#stage').boundingBox();
      assert.ok(stage.width * stage.height / (390 * 664) >= .75);
      console.log(`${type.name()} ${name}: closed workspace ${stage.width}×${stage.height}`);
      await page.locator('label:has(#show-pages)').tap();
    }
    const read = (bytes, count, options) => inspect(reader, bytes, count, options);
    await check(page, read, mobile);
    assert.deepEqual(errors, []);
    console.log(`PASS ${type.name()} ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${type.name()} ${name}:`, e);
  } finally { await browser.close(); }
}

async function choose(page, n) {
  await named(page, `Go to page ${n}`).click();
  await rendered(page);
}
async function controls(page, dialog, selectors) {
  const scope = page.locator(dialog);
  for (const [selector, pattern] of selectors) {
    const item = scope.locator(selector);
    await axTarget(item, pattern);
    await keyboardFocus(item);
  }
}
async function crop(page, draw = true) {
  await tools(page);
  await activate(page.locator('#crop-page'));
  const svg = page.locator('#crop-preview');
  await controls(page, '#crop-dialog', [['#crop-x', /spinbutton "X"/], ['#crop-y', /spinbutton "Y"/],
    ['#crop-w', /spinbutton "Width"/], ['#crop-h', /spinbutton "Height"/], ['[data-close]', /button "Cancel"/], ['#apply-crop', /button "Apply crop"/]]);
  const viewport = async () => svg.locator('rect').evaluate(el => ['x','y','width','height'].map(k => el[k].baseVal.value));
  const full = await viewport();
  if (draw) {
    await svg.scrollIntoViewIfNeeded();
    const points = await svg.evaluate(el => [0.2, 0.75].map(f => {
      const b = el.viewBox.baseVal, p = new DOMPoint(f * b.width, f * b.height).matrixTransform(el.getScreenCTM());
      return [p.x, p.y];
    }));
    // Mouse automation exercises the SVG's real pointer capture on both engines.
    await page.mouse.move(...points[0]); await page.mouse.down();
    await page.mouse.move(...points[1], { steps: 4 }); await page.mouse.up();
    assert.notDeepEqual(await viewport(), full);
    approx(Number(await page.locator('#crop-w').inputValue()), 220, 3);
  }
  await page.locator('#crop-w').fill('-1');
  assert.ok(await page.locator('#apply-crop').isDisabled());
  for (const [axis, value] of Object.entries({ x: 94, y: 130, w: 310, h: 450 })) await page.locator(`#crop-${axis}`).fill(String(value));
  const [x,y,w,h] = await viewport();
  // The 90-degree viewport swaps the two axes. Compare proportions, independent of Fit.
  approx(x / full[2], 15 / 280); approx(y / full[3], 15 / 200);
  approx(w / full[2], 225 / 280); approx(h / full[3], 155 / 200);
  await activate(page.locator('#apply-crop'));
  await rendered(page);
}

async function pageEdits(page, read, mobile) {
  const initial = await state(page);
  const original = await read(input, boxes.length);
  geometry(original, boxes);
  await choose(page, 2);
  for (const [side, index] of [['before', 1], ['after', 2]]) {
    await choose(page, 2);
    await tools(page);
    await activate(page.locator(`#blank-${side}`));
    await rendered(page);
    const applied = await state(page), blank = applied.pages[index];
    assert.equal(blank.blank, true);
    assert.ok(!idOrder(initial).includes(blank.id));
    assert.deepEqual(applied.pages.filter(p => p.id !== blank.id), initial.pages);
    const out = await read(await copy(page), boxes.length + 1);
    const sizes = boxes.slice(); sizes.splice(index, 0, bare);
    geometry(out, sizes);
    assert.deepEqual(out.field, ['Fixture field']);
    assert.deepEqual(out.raw[index].annotations, []);
    assert.deepEqual(labels(out.js[index]), []);
    assert.deepEqual(out.js.filter((_, i) => i !== index).map(labels), original.js.map(labels));
    assert.deepEqual(out.raw.filter((_, i) => i !== index).map(p => p.annotations), original.raw.map(p => p.annotations));
    await undo(page, initial);
    geometry(await read(await copy(page), boxes.length), boxes);
  }
  await choose(page, 2);
  await crop(page);
  const croppedState = await state(page);
  assert.deepEqual(croppedState.pages[1].crop, [47,65,202,290]);
  const afterCrop = boxes.map((b, i) => i === 1 ? cropped : b);
  const out = await read(await copy(page), boxes.length);
  geometry(out, afterCrop);
  assert.deepEqual(out.raw.map(p => p.annotations), original.raw.map(p => p.annotations));
  assert.ok(out.js[1].annotations.some(a => a[0] === 'Text' && a[1] === 'Independent fixture note'));
  assert.deepEqual(out.field, ['Fixture field']);
  assert.equal(out.raw[1].content, original.raw[1].content);
  await undo(page, initial);
  geometry(await read(await copy(page), boxes.length), boxes);
  await activate(page.locator('#redo'));
  assert.deepEqual(await state(page), croppedState);
  await rendered(page);
  await tools(page);
  await page.locator('#split-ranges').fill('1,2; 4-99');
  await activate(page.locator('#plan-split'));
  assert.deepEqual(await state(page), croppedState);
  assert.equal(await page.locator('#split-outputs button').count(), 0);
  await page.locator('#split-ranges').fill('2,1,2; 3-5');
  await activate(page.locator('#plan-split'));
  const planned = await state(page);
  assert.deepEqual(planned.splitPlan, [[...idOrder(initial).slice(0, 2)], [...idOrder(initial).slice(2, 5)]]);
  for (const [i, indices] of [[1, [0,1]], [2, [2,3,4]]]) {
    const button = named(page, `Download part ${i}`);
    await axTarget(button, /button "Download part [12]"/);
    await keyboardFocus(button);
    const part = await download(page, () => activate(button));
    assert.match(part.name, new RegExp(`part-${i}\\.pdf$`));
    const result = await read(part.bytes, indices.length);
    geometry(result, indices.map(n => afterCrop[n]));
    assert.deepEqual(result.js.map(labels), indices.map(n => n === 0 ? ['Sheet-1', 'Keep form'] : [`Sheet-${n+1}`]));
    if (i === 1) {
      assert.ok(result.raw[1].annotations.some(a => a[1] === 'Independent fixture note'));
      assert.ok(result.js[1].annotations.some(a => a[1] === 'Independent fixture note'));
      const unresolved = result.raw[0].annotations.filter(a => a[0] === 'unresolved reference');
      if (unresolved.length) console.log(`Derived flattened form page contains unresolved entries: ${JSON.stringify(unresolved)}`);
    }
    await dirty(page);
    assert.deepEqual(await state(page), planned);
  }
  await closeTools(page);
  await undo(page, croppedState);
  await tools(page);
  assert.equal(await page.locator('#split-outputs button').count(), 0);
  await closeTools(page);
  await dirty(page);
  console.log(`blank before/after 8→9, raw MediaBox 12,20,270,390 → unchanged on crop; CropBox 47,65,155,225, PDF.js view 47,65,202,290; split 2+3; note/form intact, exact undo`);
}

async function groupEdits(page, read, mobile) {
  const initial = await state(page), ids = idOrder(initial);
  const expectOrder = async sequence => assert.deepEqual(idOrder(await state(page)), sequence.map(i => ids[i-1]));
  const check = n => page.getByRole('checkbox', { name: `Select page ${n}`, exact: true });
  const grip = n => named(page, `Move page ${n}`);
  const tapped = locator => mobile ? locator.tap() : locator.click();
  for (const [locator, pattern] of [[check(1), /checkbox "Select page 1"/], [grip(1), /button "Move page 1"/],
    [named(page, 'Go to page 1'), /button "Go to page 1"/], [page.locator('#page-tools'), /button "Page tools"/],
    [page.locator('#later'), /button "Move later"/],
    [page.locator('#rotate'), /button "Rotate/], [page.locator('#delete'), /button "Delete page"/]]) {
    await axTarget(locator, pattern); await keyboardFocus(locator);
  }
  await tools(page);
  await controls(page, '#pages-dialog', [['#select-all-pages', /button "Select all pages"/], ['#clear-pages', /button "Clear selection"/],
    ['#move-position', /spinbutton "First position of moved group \(1-based\)"/], ['#move-group', /button "Move to position"/],
    ['#extract-group', /button "Extract selection"/], ['#blank-before', /button "Insert blank before"/], ['#blank-after', /button "Insert blank after"/],
    ['#crop-page', /button "Crop current page"/], ['#open-stamps', /button "Add stamps"/], ['#split-ranges', /textbox "Output ranges"/],
    ['#plan-split', /button "Prepare split"/], ['[data-close]', /button "Close"/]]);
  await activate(page.locator('#select-all-pages'));
  await closeTools(page);
  assert.equal(await page.locator('#thumbs input:checked').count(), 8);
  await activate(page.locator('#delete'));
  assert.deepEqual(await state(page), initial);
  await tools(page);
  await activate(page.locator('#clear-pages'));
  await closeTools(page);
  assert.equal(await page.locator('#thumbs input:checked').count(), 0);
  await tapped(check(1)); await tapped(check(3));
  assert.match(await check(3).ariaSnapshot(), /\[checked\]/);
  const row = page.locator('.thumb-row').nth(2);
  assert.notEqual(await row.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.deepEqual(await state(page), initial);
  await activate(grip(1));
  assert.equal(await page.locator('#move-position').evaluate(el => el === document.activeElement), true);
  await page.locator('#move-position').fill('8'); await activate(page.locator('#move-group'));
  assert.deepEqual(await state(page), initial);
  await page.locator('#move-position').fill('4'); await activate(page.locator('#move-group'));
  await expectOrder([2,4,5,1,3,6,7,8]);
  const moved = await state(page);
  await rendered(page);
  await axTarget(page.locator('#earlier'), /button "Move earlier"/);
  await keyboardFocus(page.locator('#earlier'));
  await activate(page.locator('#earlier')); await expectOrder([2,4,1,3,5,6,7,8]);
  await undo(page, moved);
  await activate(page.locator('#later')); await expectOrder([2,4,5,6,1,3,7,8]);
  await undo(page, moved);
  await activate(page.locator('#rotate'));
  const rotated = await state(page);
  assert.deepEqual(rotated.pages.map(p => p.rotation), [0,0,0,90,90,0,0,0]);
  await rendered(page);
  await tools(page);
  const extracted = await download(page, () => activate(page.locator('#extract-group')));
  const parsed = await read(extracted.bytes, 2);
  geometry(parsed, [{ ...boxes[0], rotation: 90 }, { ...boxes[2], rotation: 270 }]);
  assert.deepEqual(parsed.js.map(labels), [['Sheet-1', 'Keep form'], ['Sheet-3']]);
  await dirty(page);
  assert.deepEqual(await state(page), rotated);
  await closeTools(page);
  await undo(page, moved);
  await activate(page.locator('#delete')); await expectOrder([2,4,5,6,7,8]);
  await undo(page, moved);
  await undo(page, initial);
  await tapped(check(1)); await tapped(check(3));
  const from = grip(1), body = named(page, 'Go to page 1');
  await page.locator('#thumbs').evaluate(el => el.scrollTo(0,0));
  const start = await center(from), to = await center(named(page, 'Go to page 2'));
  assert.notEqual(start[0] + start[1], to[0] + to[1]);
  if (mobile) {
    const b = await center(body);
    assert.equal(await body.evaluate(el => getComputedStyle(el).touchAction), 'auto');
    assert.equal(await from.evaluate(el => getComputedStyle(el).touchAction), 'none');
    // Playwright WebKit exposes native tap, not swipe. Pair the touch pointer
    // sequence with actual strip movement and test touch-action separately.
    await touchPointer(body, 'down', b); await touchPointer(body, 'move', to);
    assert.equal(await page.locator('#thumbs').evaluate(el => { el.scrollLeft = 120; return el.scrollLeft; }), 120);
    await touchPointer(body, 'up', to);
    console.log(`WebKit strip horizontal scroll ${await page.locator('#thumbs').evaluate(el => el.scrollLeft)}px before handle drag`);
    assert.deepEqual(await state(page), initial);
    await page.locator('#thumbs').evaluate(el => el.scrollTo(0,0));
    for (const cancel of ['cancel', 'Escape', 'blur', 'second finger']) {
      await touchPointer(from, 'down', start);
      if (cancel === 'cancel') await touchPointer(from, 'cancel', to);
      if (cancel === 'Escape') await escape(page);
      if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (cancel === 'second finger') await touchPointer(body, 'down', start, 43);
      await touchPointer(from, 'up', to);
      assert.deepEqual(await state(page), initial, cancel);
    }
    await touchPointer(from, 'down', start); await touchPointer(from, 'move', to); await touchPointer(from, 'up', to);
  } else {
    const b = await center(body);
    await page.mouse.move(...b); await page.mouse.down(); await page.mouse.move(...to, { steps: 5 }); await page.mouse.up();
    assert.deepEqual(await state(page), initial);
    await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(...to, { steps: 5 }); await escape(page); await page.mouse.up();
    assert.deepEqual(await state(page), initial);
    await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(...to, { steps: 5 }); await page.mouse.up();
  }
  await expectOrder([2,1,3,4,5,6,7,8]);
  await rendered(page);
  const dragged = await read(await copy(page), boxes.length);
  assert.deepEqual(dragged.js.map(l => labels(l)[0]), [2,1,3,4,5,6,7,8].map(n => `Sheet-${n}`));
  geometry(dragged, [boxes[1], boxes[0], ...boxes.slice(2)]);
  await undo(page, initial);
  console.log('Group 1+3 moved to position 4, earlier/later, rotated/extracted/deleted; handle reordered 2,1,3,4,5,6,7,8; body/cancel no reorder');
}

async function stamps(page, read, mobile) {
  await choose(page, 2);
  await crop(page, false);
  await tools(page); await activate(page.locator('#blank-after')); await rendered(page);
  const initial = await state(page);
  const dims = [boxes[0], cropped, cropped, ...boxes.slice(2)];
  const before = await read(await copy(page), dims.length, { pixels: true });
  geometry(before, dims);
  await tools(page); await activate(page.locator('#open-stamps'));
  const stampControls = [['range', /textbox "Stamp page range"/], ['header', /textbox "Header text"/], ['footer', /textbox "Footer text"/],
    ['format', /textbox "Page number format"/], ['start', /spinbutton "Start number"/], ['watermark', /textbox "Watermark text"/],
    ['opacity', /spinbutton "Watermark opacity \(%\)"/], ['angle', /spinbutton "Watermark angle \(degrees\)"/], ['position', /combobox "Watermark position"/]];
  const field = name => page.locator(`#stamp-${name}`);
  await controls(page, '#stamps-dialog', [...stampControls.map(([name, pat]) => [`#stamp-${name}`, pat]),
    ['[data-close]', /button "Cancel"/], ['#apply-stamps', /button "Apply stamps"/]]);
  // Verify our role/name check can detect a missing name in a disposable probe.
  await field('header').evaluate(el => { el.setAttribute('aria-label', 'Wrong probe name'); });
  await assert.rejects(axTarget(field('header'), /textbox "Header text"/), /regular expression/);
  await field('header').evaluate(el => el.removeAttribute('aria-label'));
  await escape(page);
  assert.deepEqual(await state(page), initial);
  await tools(page); await activate(page.locator('#open-stamps'));
  for (const [name, value] of Object.entries({ range: '5,2-3,3', header: 'TopProof', footer: 'BottomProof',
    format: 'N{n}-P{page}-T{total}', start: '11', watermark: 'WaterProof', opacity: '37', angle: '29' })) await field(name).fill(value);
  await field('position').selectOption('bottom');
  await field('range').fill('2,90');
  await activate(page.locator('#apply-stamps'));
  await text(page, '#stamp-message', /range|page/i);
  assert.deepEqual(await state(page), initial);
  await field('range').fill('5,2-3,3');
  await activate(page.locator('#apply-stamps'));
  await status(page, 'Stamps applied to 3 page(s).');
  const applied = await state(page);
  await rendered(page);
  const out = await read(await copy(page), dims.length, { pixels: true });
  geometry(out, dims);
  assert.deepEqual(out.field, ['Fixture field']);
  const expectedPages = [2,3,5], gray = [];
  for (let i = 0; i < dims.length; i++) {
    const sequence = expectedPages.indexOf(i+1), content = out.raw[i].content;
    if (sequence < 0) {
      assert.deepEqual(out.js[i], before.js[i]);
      assert.deepEqual(out.raw[i], before.raw[i]);
      assert.deepEqual(applied.pages[i], initial.pages[i]);
      continue;
    }
    const number = `N${11 + sequence}-P${i + 1}-T9`;
    const texts = ['TopProof', 'BottomProof', number, 'WaterProof'];
    for (const text of texts) {
      assert.equal(labels(out.js[i]).filter(s => s === text).length, 1);
      const hex = Buffer.from(text).toString('hex');
      assert.match(content, new RegExp(`<${hex}>\\s*Tj`, 'i'));
    }
    assert.ok([...content.matchAll(/(\/\S+) gs\b/g)].some(([, k]) => out.raw[i].opacity[k] === .37));
    assert.deepEqual(out.raw[i].annotations, before.raw[i].annotations, 'Stamp is content, not a PDF annotation');
    const { labels: items, height, grayInk } = out.js[i];
    const [header, footer, pageNo, water] = texts.map(t => items.find(label => label.text === t));
    for (const upright of [header, footer, pageNo]) approx(upright.angle, 0);
    approx(water.angle, 29);
    assert.ok(header.y < height * .25 && footer.y > height * .75 && pageNo.x > footer.x);
    assert.ok(water.y > height * .6);
    assert.ok(grayInk >= before.js[i].grayInk + 8, `37% opacity gray ink: ${grayInk} versus baseline ${before.js[i].grayInk}`);
    gray.push(grayInk);
  }
  await undo(page, initial);
  const undone = await read(await copy(page), dims.length, { pixels: true });
  assert.deepEqual(undone, before);
  await activate(page.locator('#redo'));
  assert.deepEqual(await state(page), applied);
  await rendered(page);
  if (!mobile) await recoverCombined(page, read, dims, out);
  console.log(`12 BT/Tj labels on pages 2,3,5 of 9; 29° watermark and ca=.37; gray pixels ${gray}; 6 untouched pages; exact undo/redo`);
}

async function recoverCombined(page, read, dims, stamped) {
  await tools(page);
  await page.locator('#split-ranges').fill('2-3;5');
  await activate(page.locator('#plan-split'));
  await closeTools(page);
  const commit = await page.waitForFunction(() => window.pageProof.draftCommitted(), null, { timeout: 30000 });
  await commit.dispose();
  const bytes = await page.evaluate(async () => {
    const records = await window.pageProof.drafts();
    if (records.length !== 1 || records[0].doc.name !== 'mixed-pages.pdf' || records[0].doc.handle) throw Error('Unexpected recovery journal');
    return window.pageProof.readDraft(records[0]);
  });
  const draft = await read(Buffer.from(bytes), dims.length, { pixels: true });
  geometry(draft, dims);
  assert.deepEqual(draft.js, stamped.js);
  // Close the original realm so its tab lock is gone before normal UI recovery.
  const context = page.context();
  const recovered = await context.newPage();
  await page.close();
  await recovered.goto(origin);
  const dialog = recovered.getByRole('dialog', { name: 'Recover unsaved work?' });
  assert.match(await dialog.locator('#choice-description').textContent(), /^mixed-pages\.pdf · /);
  await dialog.getByRole('button', { name: 'Recover workspace' }).click();
  await status(recovered, 'Recovered unsaved edits.');
  await dirty(recovered);
  const restored = await read(await copy(recovered), dims.length, { pixels: true });
  geometry(restored, dims);
  assert.deepEqual(restored.js, stamped.js, 'No lost or duplicated text, annotations or pixels on recovery');
  assert.deepEqual(restored.field, ['Fixture field']);
  await tools(recovered);
  const part = await download(recovered, () => activate(named(recovered, 'Download part 1')));
  const split = await read(part.bytes, 2);
  geometry(split, dims.slice(1, 3));
  assert.deepEqual(split.js.map(labels), stamped.js.slice(1, 3).map(labels));
  await dirty(recovered);
  console.log('Chromium native OPFS combined blank/crop/stamps/split plan restored by real UI; identical text/pixels and usable recovered split');
}

try {
  for (const type of [chromium, webkit]) {
    for (const [name, check] of [['P1 blank/crop/split', pageEdits], ['P2 selection/group/drag and P4 controls', groupEdits], ['P3 stamps and P4 controls', stamps]]) {
      await run(type, name, check);
    }
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
if (failures) process.exitCode = 1;
