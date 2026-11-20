// Setup on a fresh checkout: npm ci; npx playwright install webkit; npm run test:mobile.
// On Linux, provision Playwright's WebKit system dependencies as well (--with-deps).
// Set MOBILE_EVIDENCE_DIR to an absolute artifact directory to retain screenshots there.
// Taps use WebKit's touchscreen; synthetic PointerEvents exercise drag/scroll/pinch handlers,
// not native iOS scroll physics, pinch recognition, or behavior on a physical iPhone.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { devices, webkit } from 'playwright';
import { serve } from '../scripts/serve.mjs';
import { mobilePage } from './fixtures/mobile-page.mjs';
import { installVisualKeyboard, keyboardMetrics } from './fixtures/visual-keyboard.mjs';

const evidenceDir = resolve(process.env.MOBILE_EVIDENCE_DIR || 'test-results/mobile');
const devicesToTest = [
  ['iPhone 13', { width: 390, height: 664 }],
  ['iPhone 11 Pro', { width: 320, height: 568 }],
  ['iPhone 13', { width: 664, height: 390 }],
  ['iPhone 11 Pro', { width: 375, height: 812 }],
  ['iPhone 13', { width: 390, height: 844 }],
  ['iPhone 13', { width: 430, height: 932 }],
];
const textMode = '#modes button[data-mode="text"]';
const drawMode = '#modes button[data-mode="ink"]';
const viewMode = '#modes button[data-mode="view"]';
const disclosure = '#tool-options .mobile-disclosure input';
const sheet = '#tools-sheet';
const sheetClose = `${sheet} [data-close]`;
const offsetLimit = 8; // CSS px, measured on the rendered SVG after each gesture.
let browser, server, origin, fixture;

before(async () => {
  fixture = await mobilePage();
  await mkdir(evidenceDir, { recursive: true });
  browser = await webkit.launch();
  console.log(`WebKit ${browser.version()}`);
  server = serve(0);
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try { await browser?.close(); }
  finally {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function mobileTest(device, viewport, name, run, timeout = 25_000, initScript) {
  test(`${viewport.width}x${viewport.height} ${name}`, { timeout }, async t => {
    const { defaultBrowserType, ...profile } = devices[device];
    const context = await browser.newContext({ ...profile, viewport, screen: viewport });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      if (initScript) await page.addInitScript(initScript, viewport);
      await openFixture(page, t);
      await run(page, t, viewport);
    } finally {
      await context.close();
    }
  });
}

async function openFixture(page, t) {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  let phase = 'load editor';
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    // A hidden file input alone does not establish that the module attached its handler.
    await page.waitForFunction(() => typeof document.querySelector('#file')?.onchange === 'function');
    phase = 'open and render fixture';
    await page.locator('#file').setInputFiles(fixture);
    const outcome = await page.waitForFunction(() => {
      const status = document.querySelector('#status');
      if (status.dataset.error === 'true') return { error: status.textContent };
      const paper = document.querySelector('#paper');
      return !paper.hidden && !document.querySelector('#zoom-fit').disabled &&
        status.textContent.startsWith('Opened ') && { opened: status.textContent };
    }, null, { timeout: 10_000 });
    assert.deepEqual(await outcome.jsonValue(), { opened: `Opened ${fixture.name}.` });
    assert.equal(await page.locator('#page-count').textContent(), 'of 3');
  } catch (error) {
    const status = await page.locator('#status').textContent({ timeout: 500 }).catch(() => '<unavailable>');
    t.diagnostic(`Setup failed (${phase}); status=${JSON.stringify(status)}; browser failures=${JSON.stringify(failures)}`);
    throw error;
  }
}

async function measureLayout(page) {
  return page.evaluate((modeSelector) => {
    const canvas = document.querySelector('#canvas');
    const context = canvas.getContext('2d');
    const sample = ratio => Array.from(context.getImageData(
      Math.floor(canvas.width / 2), Math.floor(canvas.height * ratio), 1, 1,
    ).data);
    const rect = canvas.getBoundingClientRect();
    const stage = document.querySelector('#stage');
    const stageRect = stage.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, stageRect.top, 0);
    const visibleBottom = Math.min(rect.bottom, stageRect.bottom, innerHeight);
    const visiblePaper = Math.max(0, visibleBottom - visibleTop);
    const artworkHit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * .065);
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    const intersect = (a, b) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
      top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
    const area = box => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
    const paper = intersect(intersect(rect, stageRect), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    const overlays = ['.page-bar', '#tool-options', '#phone-status'].map(selector => intersect(paper, bounds(selector)));
    // Inclusion–exclusion counts overlapped overlay boxes only once.
    const [nav, options, pill] = overlays;
    const occlusion = overlays.reduce((sum, box) => sum + area(box), 0) -
      area(intersect(nav, options)) - area(intersect(nav, pill)) - area(intersect(options, pill)) +
      area(intersect(intersect(nav, options), pill));
    const title = document.querySelector('#filename');
    const titleStyle = getComputedStyle(title);
    const titleText = document.createRange();
    titleText.selectNodeContents(title);
    const sheet = document.querySelector('#tools-sheet');
    const controls = selector => [...document.querySelectorAll(selector)].map(element => {
      const { left, top, width, height } = element.getBoundingClientRect();
      return { id: element.id || element.dataset.mode || element.textContent.trim(), top, width, height,
        hit: element.contains(document.elementFromPoint(left + width / 2, top + height / 2)) };
    });
    const measured = [];
    for (const element of document.querySelectorAll(
      'button,input,select,textarea,summary,a[href],[role=button],[role=tab],[contenteditable=true]',
    )) {
      if (element.matches('input[type=hidden]') ||
          getComputedStyle(element).visibility !== 'visible' || !element.getClientRects().length) continue;
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      // Ignore controls outside the viewport or clipped by an overflow container.
      let x0 = Math.max(0, left), x1 = Math.min(innerWidth, right);
      let y0 = Math.max(0, top), y1 = Math.min(innerHeight, bottom);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
        if (style.overflowX !== 'visible') { x0 = Math.max(x0, box.left); x1 = Math.min(x1, box.right); }
        if (style.overflowY !== 'visible') { y0 = Math.max(y0, box.top); y1 = Math.min(y1, box.bottom); }
      }
      if (x1 <= x0 || y1 <= y0) continue;
      measured.push({ target: element.id || element.getAttribute('aria-label') || element.textContent.trim(),
        width, height, size: Math.min(width, height),
        font: element.matches('input,select,textarea,[contenteditable=true]') ? parseFloat(getComputedStyle(element).fontSize) : null });
    }
    measured.sort((a, b) => a.size - b.size);
    const mode = document.querySelector(modeSelector);
    const modeRect = mode.getBoundingClientRect();
    let anchored = false;
    for (let element = mode; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (['fixed', 'sticky'].includes(style.position) && style.bottom !== 'auto') anchored = true;
    }
    return {
      innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, rootWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth, stageWidth: stage.clientWidth, stageScrollWidth: stage.scrollWidth, paperWidth: rect.width,
      stageHeight: stageRect.height, workspaceShare: stageRect.height / innerHeight, visiblePaper, stageRect: stageRect.toJSON(),
      paperArea: area(paper), occlusion, overlayAreas: overlays.map(area), optionRect: bounds('#tool-options').toJSON(),
      header: bounds('.masthead').height, dockHeight: bounds('.tool-dock').height,
      status: Object.fromEntries(['.info', '#status', '#offline', '#dirty', '#phone-status'].map(selector => [selector, bounds(selector).height])),
      nav: bounds('.page-bar').height, navPosition: getComputedStyle(document.querySelector('.page-bar')).position,
      toolbar: bounds('.toolbar').height,
      title: { width: title.clientWidth, scrollWidth: title.scrollWidth, lines: titleText.getClientRects().length,
        whiteSpace: titleStyle.whiteSpace, overflow: titleStyle.overflowX,
        textOverflow: titleStyle.textOverflow, noOverlap: bounds('#filename').right <= bounds('.header-actions').left },
      dock: controls('.toolbar button'), navControls: controls('.page-bar button, .page-bar input'),
      sheet: { open: sheet.open, modal: sheet.matches(':modal'), bottom: bounds('#tools-sheet').bottom,
        controls: controls('#tools-sheet button'), focused: sheet.contains(document.activeElement) ? document.activeElement.textContent.trim() : null },
      scrollX, scrollY, stageScroll: stage.scrollTop, stageScrollX: stage.scrollLeft,
      pageTop: rect.top, artworkVisible: artworkHit === canvas || artworkHit?.id === 'overlay',
      ink: sample(.065), white: sample(.13),
      anchored, toolTop: modeRect.top, toolBottom: modeRect.bottom,
      overflowingModeLabels: [...document.querySelectorAll('#modes button')]
        .filter(button => button.scrollWidth > button.clientWidth).map(button => button.dataset.mode),
      targetCount: measured.length, smallest: measured[0], undersized: measured.filter(item => item.size < 44),
      minTarget: measured.length ? ['width', 'height'].map(key => Math.min(...measured.map(item => item[key]))) : [],
      fonts: Object.fromEntries(measured.filter(item => item.font !== null).map(item => [item.target, item.font])),
    };
  }, textMode);
}

// Tap without Playwright's automatic scroll-into-view: direct reachability is part of the test.
async function tapControl(page, selector) {
  const point = await page.locator(selector).evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const center = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
    const hit = document.elementFromPoint(center.x, center.y);
    return !element.matches(':disabled,[aria-disabled=true]') && element.contains(hit) ? center : null;
  });
  assert.ok(point, `${selector} must be directly tappable without scrolling or opening a sheet`);
  await page.touchscreen.tap(point.x, point.y);
}

async function arm(page, value) {
  await tapControl(page, textMode);
  const input = page.locator('#mark-text');
  await input.fill(value);
  await input.blur();
  assert.equal(await input.inputValue(), value);
}

// Find a real exposed PDF hit point, leaving room for both fingers in a horizontal gesture.
async function pagePoint(page, offsets = [0]) {
  const point = await page.locator('#overlay').evaluate((overlay, offsets) => {
    const box = overlay.getBoundingClientRect();
    const hit = (x, y) => overlay.contains(document.elementFromPoint(x, y));
    for (let y = Math.max(1, Math.ceil(box.top + 15)); y < Math.min(innerHeight, box.bottom); y += 8) {
      for (const portion of [.35, .5, .65]) {
        const x = Math.round(box.left + box.width * portion);
        if (offsets.every(dx => hit(x + dx, y))) return { x, y };
      }
    }
    return null;
  }, offsets);
  assert.ok(point, 'Text mode must leave a hittable PDF area while text is armed');
  return point;
}

async function setVisualKeyboard(page, height, top = 0, event = 'resize') {
  await page.evaluate(async dimensions => {
    window.setVisualKeyboard(dimensions);
    // Let the viewport event's frame and any resulting ResizeObserver notification run.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { height, top, event });
}

async function keyboardSample(page, t, vp, name, height, top, baseline) {
  const sample = await page.evaluate(keyboardMetrics);
  t.diagnostic(`Keyboard ${name}: ${JSON.stringify(sample)}`);
  assert.deepEqual(page.viewportSize(), vp);
  assert.deepEqual(sample.layout, [390, 664, 390, 664]);
  assert.deepEqual(sample.visual, { height, width: 390, top, bottom: top + height, scale: 1 });
  assert.deepEqual(sample.root, [0, 0, 390]);
  assert.equal(sample.geometry.body.top, top);
  assert.equal(sample.geometry.body.bottom, top + height);
  assert.equal(sample.geometry['.tool-dock'].bottom, top + height);
  assert.equal(sample.mask, top + height < vp.height ? 'emulated-keyboard' : false);
  for (const [selector, control] of Object.entries(sample.controls)) {
    const options = sample.geometry['#tool-options'];
    assert.ok(control.top >= Math.max(top, options.top) && control.bottom <= Math.min(top + height, options.bottom) &&
      control.left >= 0 && control.right <= vp.width && control.height >= 44 && control.width >= 44 && control.hit,
    `${selector} must be fully visible and hit-testable: ${JSON.stringify(control)}`);
    if (selector !== '#keyboard-place') assert.ok(control.font >= 16, `${selector} font`);
  }
  if (baseline) {
    assert.equal(sample.paper.width, baseline.paper.width);
    assert.equal(sample.paper.left, baseline.paper.left);
    assert.equal(sample.zoom, baseline.zoom);
    assert.equal(sample.paper.top - sample.geometry['#stage'].top + sample.stageScroll[1],
      baseline.paper.top - baseline.geometry['#stage'].top + baseline.stageScroll[1]);
  }
  return sample;
}

const [keyboardDevice, keyboardLayout] = devicesToTest[0];
mobileTest(keyboardDevice, keyboardLayout, 'visual-only keyboard bounds, focus transfer and geometry recovery', async (page, t, vp) => {
  try {
    await tapControl(page, textMode);
    const before = await keyboardSample(page, t, vp, 'before', 664, 0);
    await screenshot(page, t, vp, 'keyboard-before');
    await tapControl(page, '#mark-text');
    await page.waitForFunction(() => document.activeElement.id === 'mark-text');
    await setVisualKeyboard(page, 364);
    const shrunk = await keyboardSample(page, t, vp, 'shrunk', 364, 0, before);
    assert.equal(shrunk.focus, 'mark-text');
    assert.deepEqual(shrunk.stageScroll, before.stageScroll);
    await page.keyboard.type('Synthetic keyboard note');
    await screenshot(page, t, vp, 'keyboard-open');

    await setVisualKeyboard(page, 340, 24);
    await tapControl(page, '#mark-size');
    await page.waitForFunction(() => document.activeElement.id === 'mark-size');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('24');
    assert.equal(await page.locator('#mark-size').inputValue(), '24');
    const offset = await keyboardSample(page, t, vp, 'offset', 340, 24, before);
    assert.equal(offset.focus, 'mark-size');
    assert.deepEqual(offset.stageScroll, before.stageScroll);
    await screenshot(page, t, vp, 'keyboard-offset');
    await setVisualKeyboard(page, 340, 36, 'scroll');
    const shifted = await keyboardSample(page, t, vp, 'scroll-only', 340, 36, before);
    assert.equal(shifted.controls['#keyboard-place'].bottom, offset.controls['#keyboard-place'].bottom + 12);

    const { left, top, width, height } = shifted.controls['#keyboard-place'];
    await page.mouse.move(left + width / 2, top + height / 2);
    await page.mouse.down();
    // Some WebKit configurations leave input focus on mouse down. Force that timing
    // before release so the interleaving is still covered without a native keyboard.
    await page.locator('#mark-size').blur();
    await expectNotes(page, t, 'after down and blur, before release', [], 'Synthetic keyboard note');
    const blurred = await keyboardSample(page, t, vp, 'blur while occluded', 340, 36, before);
    assert.notEqual(blurred.focus, 'mark-size');
    assert.deepEqual(blurred.controls, shifted.controls);
    await page.mouse.up();
    await expectNotes(page, t, 'Place release', ['Synthetic keyboard note'], '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'keyboard-place');
    await tapControl(page, '#keyboard-place');
    await expectNotes(page, t, 'repeat Place', ['Synthetic keyboard note'], '');
    await tapControl(page, '#undo');
    await page.waitForFunction(() => !document.querySelector('#redo').disabled && !document.querySelector('#paper').hidden);
    await expectNotes(page, t, 'keyboard-visible undo', [], '');
    await tapControl(page, '#redo');
    await page.waitForFunction(() => !document.querySelector('#undo').disabled && !document.querySelector('#paper').hidden);
    await expectNotes(page, t, 'keyboard-visible redo', ['Synthetic keyboard note'], '');

    await setVisualKeyboard(page, 664);
    const restored = await keyboardSample(page, t, vp, 'restored', 664, 0, before);
    for (const key of ['geometry', 'paper', 'controls', 'stageScroll']) assert.deepEqual(restored[key], before[key], key);
    await screenshot(page, t, vp, 'keyboard-closed');
    await tapControl(page, viewMode);
    await page.locator('#stage').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('body.immersive').count(), 1);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('body.immersive').count(), 0);
    await arm(page, 'After recovery');
    const point = await pagePoint(page);
    await page.touchscreen.tap(point.x, point.y);
    await expectNotes(page, t, 'normal Text tap after recovery', ['Synthetic keyboard note', 'After recovery'], '');
  } catch (error) {
    t.diagnostic(`Keyboard failure metrics: ${JSON.stringify(await page.evaluate(keyboardMetrics).catch(() => null))}`);
    await screenshot(page, t, vp, 'keyboard-failure').catch(() => {});
    throw error;
  }
// Multiple focus transfers, history actions and four screenshots; actions still have bounded waits.
}, 40_000, installVisualKeyboard);

mobileTest(keyboardDevice, keyboardLayout, 'keyboard-visible Fit paper pans to its end without placing a note', async (page, t, vp) => {
  try {
    await tapControl(page, textMode);
    const before = await keyboardSample(page, t, vp, 'pan baseline', 664, 0);
    await tapControl(page, '#mark-text');
    await setVisualKeyboard(page, 364);
    await page.keyboard.type('Keep this pending');
    const start = await keyboardSample(page, t, vp, 'Fit before pan', 364, 0, before);
    const point = await pagePoint(page);
    await pointerSequence(page, point, [['pointerdown'], ['pointermove', 0, 1, -32], ['pointerup', 0, 1, -32]]);
    const pan = await keyboardSample(page, t, vp, 'Fit after touch drag', 364, 0, before);
    assert.ok(pan.stageScroll[1] > start.stageScroll[1]);
    assert.equal(pan.paper.top - start.paper.top, start.stageScroll[1] - pan.stageScroll[1]);
    await expectNotes(page, t, 'Fit touch drag', [], 'Keep this pending');

    const lowerEdgeHit = () => page.locator('#paper').evaluate(paper => {
      const { left, width, bottom } = paper.getBoundingClientRect();
      return paper.contains(document.elementFromPoint(left + width / 2, bottom - 2));
    });
    // The exposed stripe is short: use successive drags, all with reachable start points.
    for (let drag = 0; drag < 10 && !await lowerEdgeHit(); drag++) {
      const start = await pagePoint(page);
      const dy = 1 - start.y;
      await pointerSequence(page, start, [['pointerdown'], ['pointermove', 0, 1, dy], ['pointerup', 0, 1, dy]]);
    }
    assert.ok(await lowerEdgeHit(), 'the lower edge of the Fit paper must be reachable above the sheet');
    const end = await keyboardSample(page, t, vp, 'Fit lower edge exposed', 364, 0, before);
    assert.ok(end.stageScroll[1] > pan.stageScroll[1]);
    await expectNotes(page, t, 'Fit end of page', [], 'Keep this pending');
    await screenshot(page, t, vp, 'keyboard-pan');
    await page.locator('#mark-text').blur();
    await setVisualKeyboard(page, 664);
    const closed = await keyboardSample(page, t, vp, 'pan recovery', 664, 0, before);
    assert.deepEqual(closed.geometry, before.geometry);
    await expectNotes(page, t, 'pan recovery retains draft', [], 'Keep this pending');

    // At a scrollable zoom the browser need not clamp the user's pan on recovery.
    await zoomIn(page, before.paper.width, 3);
    await tapControl(page, '#mark-text');
    await setVisualKeyboard(page, 364);
    const zoomPoint = await pagePoint(page);
    await pointerSequence(page, zoomPoint, [['pointerdown'], ['pointermove', 0, 1, -32], ['pointerup', 0, 1, -32]]);
    const zoomPan = await page.evaluate(keyboardMetrics);
    assert.ok(zoomPan.stageScroll[1] >= 32);
    await page.locator('#mark-text').blur();
    await setVisualKeyboard(page, 664);
    const zoomClosed = await keyboardSample(page, t, vp, 'zoom pan recovery', 664, 0);
    assert.deepEqual(zoomClosed.stageScroll, zoomPan.stageScroll);
    assert.equal(zoomClosed.paper.width, zoomPan.paper.width);
    await expectNotes(page, t, 'zoomed pan recovery', [], 'Keep this pending');

    // A much shorter visual slice cannot show the entire sheet. The focused input
    // must scroll inside the sheet, without scrolling the root or the zoomed PDF.
    await tapControl(page, '#mark-text');
    await setVisualKeyboard(page, 240);
    const narrow = await page.evaluate(keyboardMetrics);
    const note = narrow.controls['#mark-text'], options = narrow.geometry['#tool-options'];
    assert.equal(narrow.focus, 'mark-text');
    assert.ok(note.hit && note.top >= options.top && note.bottom <= options.bottom);
    assert.ok(await page.locator('#tool-options').evaluate(sheet => sheet.scrollTop > 0));
    assert.deepEqual(narrow.root, zoomClosed.root);
    assert.deepEqual(narrow.stageScroll, zoomClosed.stageScroll);
    await page.locator('#mark-text').blur();
    await setVisualKeyboard(page, 664);
    const final = await keyboardSample(page, t, vp, 'short slice recovery', 664, 0);
    assert.deepEqual(final.geometry, zoomClosed.geometry);
  } catch (error) {
    t.diagnostic(`Keyboard pan failure metrics: ${JSON.stringify(await page.evaluate(keyboardMetrics).catch(() => null))}`);
    await screenshot(page, t, vp, 'keyboard-pan-failure').catch(() => {});
    throw error;
  }
}, 35_000, installVisualKeyboard);

async function expectNotes(page, t, step, expected, pending) {
  const actual = await page.locator('#overlay text').allTextContents();
  const input = await page.locator('#mark-text').inputValue();
  t.diagnostic(`${step}: ${actual.length} note(s); pending=${JSON.stringify(input)}`);
  assert.deepEqual(actual, expected, `${step}: rendered text annotations`);
  if (pending !== undefined) assert.equal(input, pending, `${step}: pending text`);
}

// Synthetic pointers bubble through the real page or stage but do not exercise native
// pointer capture or scroll physics. Only the separate scroll-cancellation step sets scrollTop.
async function pointerSequence(page, point, steps, surface = '#overlay') {
  await page.locator(surface).evaluate(async (target, { point, steps }) => {
    const stage = document.querySelector('#stage');
    for (const [type, dx = 0, pointerId = 1, dy = 0] of steps) {
      if (type === 'scroll') {
        // Wait for an actual scroll event before releasing the same pointer at its original point.
        await new Promise((resolve, reject) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('No stage scroll event after a 160px scroll request'));
          }, 1000);
          stage.addEventListener('scroll', () => { clearTimeout(timeout); resolve(); }, { once: true, signal: controller.signal });
          stage.scrollTop += 160;
        });
        continue;
      }
      const clientX = point.x + dx, clientY = point.y + dy;
      const hit = document.elementFromPoint(clientX, clientY);
      if (type === 'pointerdown' && !target.contains(hit)) {
        throw new Error(`Gesture starts outside the exposed PDF at ${clientX},${clientY}`);
      }
      (target.contains(hit) ? hit : target).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerType: 'touch',
        pointerId, isPrimary: pointerId === 1, clientX, clientY,
        button: type === 'pointermove' || type === 'pointercancel' ? -1 : 0,
        buttons: ['pointerdown', 'pointermove'].includes(type) ? 1 : 0,
      }));
    }
  }, { point, steps });
}

function expectCompactRow(controls, height, expected) {
  assert.deepEqual(controls.map(control => control.id), expected);
  assert.ok(controls.every(({ width, height }) => width >= 44 && height >= 44), JSON.stringify(controls));
  const centers = controls.map(control => control.top + control.height / 2);
  const rows = centers.every(center => Math.abs(center - Math.min(...centers)) <= 2) ? 1 : 2;
  assert.equal(rows, 1, 'controls must share one row');
  assert.ok(height <= Math.max(...controls.map(control => control.height)) + 8, 'row must be compact');
  return rows;
}

async function checkSheet(page, t, vp, closed) {
  assert.equal(closed.sheet.open, false);
  await tapControl(page, '#more-tools');
  const open = await measureLayout(page);
  t.diagnostic(`Open More tools: ${JSON.stringify(open.sheet)}`);
  await screenshot(page, t, vp, 'more');
  assert.ok(open.sheet.modal && open.sheet.bottom === vp.height, 'More tools must be a bottom overlay');
  assert.deepEqual(open.stageRect, closed.stageRect, 'opening More must not resize or move the viewer');
  assert.equal(open.sheet.focused, 'Close');
  for (const id of ['Close', 'theme', 'open', 'merge', 'extract', 'forms']) {
    assert.equal(closed.sheet.controls.find(control => control.id === id)?.hit, false, `${id} belongs in the sheet`);
    const target = open.sheet.controls.find(control => control.id === id);
    assert.ok(target?.hit && target.width >= 44 && target.height >= 44, `${id}: ${JSON.stringify(target)}`);
  }
  assert.deepEqual(open.undersized, [], 'sheet controls below 44×44 CSS px');
  await tapControl(page, sheetClose);
  await page.waitForFunction(() => document.activeElement.id === 'more-tools');
  const dismissed = await measureLayout(page);
  assert.equal(dismissed.sheet.open, false);
  assert.deepEqual(dismissed.stageRect, closed.stageRect, 'closing More must leave the viewer unchanged');
  assert.equal(dismissed.visiblePaper, closed.visiblePaper);
}

async function expectSafeAreaWiring(page) {
  const wiring = await page.evaluate(() => {
    const mobile = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
      .find(rule => rule instanceof CSSMediaRule && rule.conditionText === '(max-width: 768px)');
    const rules = [...(mobile?.cssRules ?? [])];
    const style = selector => rules.find(rule => rule.selectorText === selector)?.style.cssText ?? '';
    return {
      cover: document.querySelector('meta[name=viewport]').content.includes('viewport-fit=cover'),
      dynamicShell: rules.some(rule => rule.selectorText?.startsWith('body:has(') && /^100[ds]vh$/.test(rule.style?.height)),
      shellHeight: document.body.getBoundingClientRect().height,
      viewportHeight: innerHeight,
      sides: ['top', 'right', 'bottom', 'left'].every(edge => style('body').includes(`env(safe-area-inset-${edge})`)),
      dock: style('.tool-dock').includes('env(safe-area-inset-bottom)'),
      sheet: style('#tools-sheet').includes('env(safe-area-inset-bottom)'),
    };
  });
  assert.equal(wiring.shellHeight, wiring.viewportHeight);
  const { shellHeight, viewportHeight, ...css } = wiring;
  assert.deepEqual(css, { cover: true, dynamicShell: true, sides: true, dock: true, sheet: true });
}

// Sample geometry atomically with render readiness; a resize can hide paper again.
async function waitForPaper(page, expected) {
  const sample = await page.waitForFunction(width => {
    const paper = document.querySelector('#paper');
    const rect = paper.getBoundingClientRect();
    return !paper.hidden && rect.width > 0 && Math.abs(rect.width - width) <= 1 &&
      { top: rect.top, width: rect.width };
  }, expected);
  try { return await sample.jsonValue(); } finally { await sample.dispose(); }
}

async function zoomIn(page, fitWidth, taps) {
  let rendered;
  for (let step = 1; step <= taps; step++) {
    await tapControl(page, '#zoom-in');
    rendered = await waitForPaper(page, fitWidth * 1.25 ** step);
  }
  return rendered;
}

async function stagePosition(page) {
  return page.locator('#stage').evaluate(stage => {
    const { left, top, width } = document.querySelector('#paper').getBoundingClientRect();
    return { scroll: [stage.scrollLeft, stage.scrollTop], root: [window.scrollX, window.scrollY], left, top, width };
  });
}

async function traceInk(page, t, label, point) {
  await tapControl(page, drawMode);
  // Close the options on the short landscape stage to expose the full trace.
  if (await page.evaluate(() => innerWidth > innerHeight)) await tapControl(page, disclosure);
  const trace = [[0, 0], [18, 13], [33, 37], [52, 43]];
  const strokes = page.locator('#overlay polyline');
  const before = await strokes.count();
  await pointerSequence(page, point, [
    ...trace.map(([dx, dy], i) => [i ? 'pointermove' : 'pointerdown', dx, 1, dy]),
    ['pointerup', trace.at(-1)[0], 1, trace.at(-1)[1]],
  ]);
  assert.equal(await strokes.count(), before + 1, `${label}: one committed stroke`);
  const rendered = await strokes.last().evaluate(line => [...line.points].map(point => {
    const { x, y } = point.matrixTransform(line.getScreenCTM());
    return [x, y];
  }));
  assert.equal(rendered.length, trace.length, `${label}: rendered centerline must contain the entire trace`);
  const maxError = Math.max(...rendered.map(([x, y], i) => Math.hypot(x - point.x - trace[i][0], y - point.y - trace[i][1])));
  t.diagnostic(`${label} ink: ${before} -> ${before + 1} strokes; max centerline offset ${maxError.toFixed(4)} CSS px`);
  assert.ok(maxError <= offsetLimit, `${label}: ink offset ${maxError} exceeds ${offsetLimit} CSS px`);
}

async function screenshot(page, t, vp, state) {
  const path = resolve(evidenceDir, `webkit-${vp.width}x${vp.height}-${state}.png`);
  await page.screenshot({ path, animations: 'disabled', timeout: 5000 });
  t.diagnostic(`Screenshot: ${path}`);
}

function expectFitLayout(layout, vp, share) {
  assert.deepEqual([layout.innerWidth, layout.innerHeight], [vp.width, vp.height]);
  assert.ok(layout.workspaceShare >= share, `workspace ${layout.stageHeight}/${vp.height} < ${share * 100}%`);
  assert.deepEqual([layout.scrollX, layout.scrollY, layout.stageScrollX, layout.stageScroll], [0, 0, 0, 0]);
  assert.deepEqual([layout.rootWidth, layout.scrollWidth, layout.bodyScrollWidth, layout.stageScrollWidth,
    layout.stageWidth, layout.paperWidth], Array(6).fill(vp.width), 'Fit without document overflow');
  assert.ok(layout.ink[0] < 100 && layout.ink[2] > layout.ink[0] + 40 && layout.ink[3] === 255,
    'sample blue artwork in the rendered PDF, not an empty canvas');
  assert.ok(layout.white.every(channel => channel > 245), 'sample white paper outside the artwork');
  assert.ok(layout.paperArea > 0);
  assert.ok(layout.occlusion >= 0 && layout.occlusion < layout.paperArea);
  assert.deepEqual(Object.values(layout.status), [0, 0, 0, 0, 0], 'no visible or in-flow status boxes');
}

function expectAnnotateLayout(layout, vp) {
  expectFitLayout(layout, vp, .75);
  const limit = vp.width > vp.height ? 88 : 120;
  assert.ok(layout.header + layout.toolbar <= limit && layout.header + layout.dockHeight <= limit,
    `header ${layout.header} + toolbar ${layout.toolbar} (dock ${layout.dockHeight}) > ${limit}`);
  assert.ok(layout.header > 0 && layout.toolbar > 0, 'annotate must show chrome');
  const { title } = layout;
  assert.ok(title.width > 0 && title.lines === 1 && title.whiteSpace === 'nowrap' && title.overflow === 'hidden' &&
    title.textOverflow === 'ellipsis' && title.noOverlap, `one-line filename: ${JSON.stringify(title)}`);
  expectCompactRow(layout.dock, layout.toolbar, ['view', 'text', 'ink', 'highlight', 'image', 'undo', 'redo']);
  expectCompactRow(layout.navControls, layout.nav, ['prev', 'page-number', 'next', 'zoom-out', 'zoom-fit', 'zoom-in', 'show-pages']);
  assert.ok(['absolute', 'fixed'].includes(layout.navPosition), 'nav/zoom must float over the workspace');
  assert.ok(layout.dock.filter(({ id }) => ['undo', 'redo'].includes(id)).every(control => control.hit), 'history is directly reachable');
  assert.ok(layout.navControls.every(control => control.hit), 'all navigation controls are on screen');
  assert.ok(layout.anchored && layout.toolTop >= vp.height / 2 && layout.toolBottom <= vp.height);
  assert.deepEqual(layout.overflowingModeLabels, []);
  assert.ok(layout.targetCount > 0);
  assert.deepEqual(layout.undersized, [], 'visible controls must be at least 44×44 CSS px');
  assert.ok(Object.values(layout.fonts).every(font => font >= 16), JSON.stringify(layout.fonts));
  assert.ok(layout.fonts['page-number'] >= 16);
}

async function immersive(page) {
  return page.locator('body').evaluate(body => body.classList.contains('immersive'));
}

async function stagePoint(page, inset = 24, margin = 0) {
  const point = await page.locator('#stage').evaluate((stage, { inset, margin }) => {
    const r = stage.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    for (let y = Math.ceil(r.top + inset); y < r.bottom - 70; y += 6) {
      if ([-margin, 0, margin].every(dx => stage.contains(document.elementFromPoint(x + dx, y)))) return { x, y };
    }
    return null;
  }, { inset, margin });
  assert.ok(point, 'there must be a reachable gesture point inside the stage');
  return point;
}

for (const [device, viewport] of devicesToTest) {
  mobileTest(device, viewport, 'R1–R3 Fit, overlays, transient status and immersion', async (page, t, vp) => {
    const pill = page.locator('#phone-status');
    await pill.waitFor();
    const started = performance.now();
    assert.match(await pill.textContent(), /Page 1 of 3.*No unsaved edits/);
    const active = await measureLayout(page);
    assert.ok(active.status['#phone-status'] > 0);
    assert.deepEqual(Object.values(active.status).slice(0, 4), [0, 0, 0, 0]);
    await screenshot(page, t, vp, 'status-visible');
    await delay(Math.max(0, 3000 - (performance.now() - started)));
    const settled = await measureLayout(page);
    assert.deepEqual(Object.values(settled.status), [0, 0, 0, 0, 0], 'status must have zero height at 3s');
    assert.deepEqual(settled.stageRect, active.stageRect, 'status must not consume workspace');
    t.diagnostic(`status at ${Math.round(performance.now() - started)}ms: ${JSON.stringify(settled.status)}`);
    assert.equal(await page.locator('#zoom-fit').textContent(), 'Fit');
    await expectSafeAreaWiring(page);
    await tapControl(page, textMode);
    await tapControl(page, disclosure);
    const layout = await measureLayout(page);
    t.diagnostic(`LAYOUT closed ${JSON.stringify(layout)}`);
    await screenshot(page, t, vp, 'closed');
    expectAnnotateLayout(layout, vp);
    assert.ok(layout.pageTop >= 0 && layout.pageTop <= .6 * vp.height && layout.artworkVisible);
    assert.equal(await page.locator('#mark-text').isVisible(), false);
    await checkSheet(page, t, vp, layout);
    // If a mode is clipped, only a scroll inside the mode strip may be needed to reach it.
    for (const { id, hit } of layout.dock.filter(control => !control.hit)) {
      const selector = `#modes [data-mode="${id}"]`;
      await page.locator(selector).evaluate(button => {
        const strip = button.parentElement;
        strip.scrollLeft = button.offsetLeft - strip.offsetLeft;
      });
      await tapControl(page, selector);
    }
    await page.locator('#modes').evaluate(strip => { strip.scrollLeft = 0; });
    for (const [state, mode, fields] of [
      ['text', textMode, ['mark-text', 'mark-size', 'mark-color']],
      ['draw', drawMode, ['ink-width', 'mark-color']],
    ]) {
      await tapControl(page, mode);
      if (!(await page.locator(disclosure).isChecked())) await tapControl(page, disclosure);
      const open = await measureLayout(page);
      t.diagnostic(`LAYOUT ${state} ${JSON.stringify(open)}`);
      await screenshot(page, t, vp, state);
      expectAnnotateLayout(open, vp);
      const { optionRect: box, stageRect: stage } = open;
      assert.ok(box.width > 0 && box.height > 0 && box.left >= stage.left && box.right <= stage.right &&
        box.top >= stage.top && box.bottom <= stage.bottom, `${state} options must overlay the workspace`);
      assert.deepEqual(open.stageRect, layout.stageRect, `${state} options must not move or resize the workspace`);
      assert.equal(open.paperArea, layout.paperArea);
      for (const field of fields) assert.ok(open.fonts[field] >= 16, `${field} must be visible and at least 16px`);
      if (state === 'text') await pagePoint(page);
    }
    await tapControl(page, viewMode);
    const normal = await measureLayout(page);
    const point = await stagePoint(page, 70);
    await page.touchscreen.tap(point.x, point.y);
    assert.equal(await immersive(page), true);
    const hidden = await measureLayout(page);
    t.diagnostic(`LAYOUT immersive ${JSON.stringify(hidden)}`);
    await screenshot(page, t, vp, 'immersive');
    expectFitLayout(hidden, vp, .92);
    assert.deepEqual([hidden.header, hidden.toolbar, hidden.nav, hidden.dockHeight], [0, 0, 0, 0]);
    await page.touchscreen.tap(point.x, point.y);
    assert.equal(await immersive(page), false);
    assert.deepEqual((await measureLayout(page)).stageRect, normal.stageRect, 'a second tap restores normal View');
    await tapControl(page, '#zoom-fit');
    assert.equal(await immersive(page), false, 'a navigation control tap must not toggle View');
    if (vp.width === 390 && vp.height === 664) {
      await waitForPaper(page, vp.width);
      await page.touchscreen.tap(point.x, point.y);
      assert.equal(await immersive(page), true);
      await page.setViewportSize({ width: 664, height: 390 });
      await waitForPaper(page, 664);
      assert.equal(await immersive(page), false, 'orientation change must restore controls');
    }
  });

  // Each sequential case runs 80 gestures and waits for ten completed pinch renders.
  mobileTest(device, viewport, 'R3 View stress: 50 taps, 20 one-finger scrolls, 10 pinches', async (page, t, vp) => {
    const started = performance.now();
    const note = 'Preserve pending text in View';
    await arm(page, note);
    await tapControl(page, viewMode);
    const verify = async (label, hidden) => {
      const actual = await page.evaluate(() => ({ hidden: document.body.classList.contains('immersive'),
        notes: document.querySelectorAll('#overlay text').length, pending: document.querySelector('#mark-text').value,
        root: [scrollX, scrollY] }));
      assert.deepEqual(actual, { hidden, notes: 0, pending: note, root: [0, 0] }, label);
    };
    await verify('armed in normal View', false);
    const point = await stagePoint(page, 70);
    for (let i = 0; i < 50; i++) {
      await page.touchscreen.tap(point.x, point.y);
      await verify(`View tap ${i + 1}`, i % 2 === 0);
    }
    t.diagnostic('50 touchscreen taps toggled once each; zero notes');
    const zoomed = await zoomIn(page, vp.width, 3);
    await verify('zoom control taps do not toggle View', false);
    const shifts = [];
    for (let i = 0; i < 20; i++) {
      const before = await stagePosition(page);
      const dy = i % 2 ? 72 : -72;
      await pointerSequence(page, await stagePoint(page, 90), [
        ['pointerdown'], ['pointermove', 0, 1, dy], ['pointerup', 0, 1, dy],
      ], '#stage');
      const shift = (await stagePosition(page)).scroll[1] - before.scroll[1];
      assert.ok(shift * dy < 0, `one-finger scroll ${i + 1} must move the stage opposite the finger: ${shift}`);
      shifts.push(shift);
      await verify(`View scroll ${i + 1}`, false);
    }
    t.diagnostic(`20 one-finger scrolls: deltas [${shifts}] CSS px; zero notes`);
    const widths = [zoomed.width];
    for (let i = 0; i < 10; i++) {
      const [a, b] = i % 2 ? [50, 35] : [35, 50];
      await pointerSequence(page, await stagePoint(page, 90, a), [
        ['pointerdown', -a, 1], ['pointerdown', a, 2], ['pointermove', -b, 1], ['pointermove', b, 2],
        ['pointerup', b, 2], ['pointerup', -b, 1],
      ], '#stage');
      const expected = vp.width * 1.25 ** 3 * (i % 2 ? 1 : 50 / 35);
      const { width } = await waitForPaper(page, expected);
      assert.ok((width - widths.at(-1)) * (b - a) > 0, `pinch ${i + 1} must change rendered width`);
      widths.push(width);
      await verify(`View pinch ${i + 1}`, false);
    }
    t.diagnostic(`10 pinches: widths [${widths}] CSS px; zero notes, armed text preserved; ${Math.round(performance.now() - started)}ms`);
  }, 40_000);


  mobileTest(device, viewport, 'C2 deliberate tap and empty repeat', async (page, t) => {
    const note = 'One-shot mobile note';
    await arm(page, note);
    await expectNotes(page, t, 'armed', [], note);
    const { x, y } = await pagePoint(page);
    await page.touchscreen.tap(x, y);
    await expectNotes(page, t, 'first tap', [note], '');
    const again = await pagePoint(page);
    await page.touchscreen.tap(again.x, again.y);
    await expectNotes(page, t, 'repeat tap with empty input', [note], '');
  });

  mobileTest(device, viewport, 'C2 collapsed options preserve text and center placement clears it', async (page, t) => {
    const note = 'Center placement';
    const disclosure = '#tool-options .mobile-disclosure input';
    await arm(page, note);
    await tapControl(page, disclosure);
    assert.equal(await page.locator('#mark-text').isVisible(), false);
    await expectNotes(page, t, 'collapsed while armed', [], note);
    await pagePoint(page);
    await tapControl(page, disclosure);
    await tapControl(page, '#keyboard-place');
    await expectNotes(page, t, 'center placement', [note], '');
    await tapControl(page, '#keyboard-place');
    await expectNotes(page, t, 'repeat center placement', [note], '');
  });

  mobileTest(device, viewport, 'C2 drag and compatibility click', async (page, t) => {
    const note = 'Keep after drag';
    await arm(page, note);
    await expectNotes(page, t, 'armed', [], note);
    const point = await pagePoint(page, [0, 55]);
    await pointerSequence(page, point, [
      ['pointerdown'], ['pointermove', 55], ['pointerup', 55], ['click', 55],
    ]);
    await expectNotes(page, t, 'drag with compatibility click', [], note);
    await pointerSequence(page, point, [
      ['pointerdown'], ['pointermove', 55], ['pointermove'], ['pointerup'], ['click'],
    ]);
    await expectNotes(page, t, 'drag back to start', [], note);
  });

  mobileTest(device, viewport, 'C2 scroll and pointer cancellation', async (page, t) => {
    const note = 'Keep after scroll';
    await arm(page, note);
    await expectNotes(page, t, 'armed', [], note);
    // Three completed render steps leave 160px of scroll range in the larger workspace.
    const fit = await waitForPaper(page, viewport.width);
    const rendered = await zoomIn(page, fit.width, 3);
    t.diagnostic(`Zoom In: rendered width ${rendered.width} CSS px`);
    const stage = page.locator('#stage');
    const { before, remaining } = await stage.evaluate(element => ({
      before: element.scrollTop,
      remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
    assert.ok(remaining >= 160, 'the zoomed fixture must allow at least 160 CSS px of further scroll');
    await pointerSequence(page, await pagePoint(page), [['pointerdown'], ['scroll'], ['pointerup']]);
    const after = await stage.evaluate(element => element.scrollTop);
    t.diagnostic(`stage scrollTop: ${before} -> ${after}`);
    assert.ok(after > before, 'scroll must actually move the viewer');
    await expectNotes(page, t, 'scrolled while touch held', [], note);
    await pointerSequence(page, await pagePoint(page), [['pointerdown'], ['pointercancel']]);
    await expectNotes(page, t, 'touch canceled while still armed', [], note);
  });

  mobileTest(device, viewport, 'C2 two-finger pinch changes PDF zoom without placing', async (page, t) => {
    const note = 'Keep after pinch';
    await arm(page, note);
    await expectNotes(page, t, 'armed', [], note);
    const point = await pagePoint(page, [-60, -25, 25, 60]);
    const { width: before } = await waitForPaper(page, viewport.width);
    await pointerSequence(page, point, [
      ['pointerdown', -25, 1], ['pointerdown', 25, 2],
      ['pointermove', -60, 1], ['pointermove', 60, 2],
      ['pointerup', 60, 2], ['pointerup', -60, 1],
    ]);
    await expectNotes(page, t, 'pinch release', [], note);
    const zoomed = await page.waitForFunction(width => {
      const paper = document.querySelector('#paper');
      const next = paper.getBoundingClientRect().width;
      return !paper.hidden && next > width * 1.1 && next;
    }, before);
    t.diagnostic(`pinch-out paper width: ${before} -> ${await zoomed.jsonValue()} CSS px`);
    await expectNotes(page, t, 'zoomed rerender', [], note);
  });

  mobileTest(device, viewport, 'C2 long hold does not place armed text', async (page, t) => {
    const note = 'Keep after hold';
    await arm(page, note);
    await expectNotes(page, t, 'armed', [], note);
    const point = await pagePoint(page);
    await pointerSequence(page, point, [['pointerdown']]);
    await delay(600); // Longer than the tap window; preserve the armed note on release.
    await pointerSequence(page, point, [['pointerup']]);
    await expectNotes(page, t, 'long hold released', [], note);
  });

  mobileTest(device, viewport, 'M3–M4 two-finger pan, note position and ink offsets', async (page, t, vp) => {
    const fit = await waitForPaper(page, vp.width);
    const point = { x: Math.round(vp.width / 2), y: Math.round(fit.top + 145) };
    await traceInk(page, t, 'Fit', point);
    const note = 'Note after pinch and pan';
    await arm(page, note);
    if (vp.width > vp.height) await tapControl(page, disclosure);
    await expectNotes(page, t, 'armed', [], note);
    await pointerSequence(page, point, [
      ['pointerdown', -25, 1], ['pointerdown', 25, 2],
      ['pointermove', -55, 1], ['pointermove', 55, 2],
      ['pointerup', 55, 2], ['pointerup', -55, 1],
    ]);
    const { width: zoom } = await waitForPaper(page, fit.width * 2.2);
    t.diagnostic(`Pinch width: ${fit.width} -> ${zoom} CSS px`);
    await expectNotes(page, t, 'after pinch', [], note);
    const before = await stagePosition(page);
    // Same separation (70 px) at both ends: translate the centroid, not the zoom.
    await pointerSequence(page, point, [
      ['pointerdown', -40, 1], ['pointerdown', 30, 2],
      ['pointermove', -87, 1, -68], ['pointermove', -17, 2, -68],
      ['pointerup', -17, 2, -68], ['pointerup', -87, 1, -68],
    ]);
    const after = await stagePosition(page);
    const shift = after.scroll.map((value, axis) => value - before.scroll[axis]);
    const displacement = [before.left - after.left, before.top - after.top];
    t.diagnostic(`Pan: stage scroll ${before.scroll} -> ${after.scroll} (delta ${shift}); paper delta ${displacement} CSS px`);
    assert.equal(after.width, before.width, 'pan must not change PDF zoom');
    assert.deepEqual(after.root, [0, 0], 'pan must stay inside the document stage');
    for (const [axis, expected] of [47, 68].entries()) {
      assert.ok(Math.abs(shift[axis] - expected) <= 1 && Math.abs(displacement[axis] - expected) <= 1,
        `axis ${axis}: paper and stage must move with the finger centroid`);
    }
    await expectNotes(page, t, 'after equal-distance pan', [], note);
    // Capture the browser's delivered pointer coordinates rather than assuming tap rounding.
    await page.locator('#overlay').evaluate(overlay => {
      overlay.addEventListener('pointerup', event => {
        window.lastMobileTap = { x: event.clientX, y: event.clientY, type: event.pointerType };
      }, { once: true });
    });
    await page.touchscreen.tap(point.x, point.y);
    await expectNotes(page, t, 'tap after zoom and pan', [note], '');
    const pointer = await page.evaluate(() => window.lastMobileTap);
    assert.equal(pointer?.type, 'touch');
    const rendered = await page.locator('#overlay text').evaluate(text => {
      const { x, y } = new DOMPoint(0, 0).matrixTransform(text.getScreenCTM());
      return { x, y };
    });
    const error = Math.hypot(rendered.x - pointer.x, rendered.y - pointer.y);
    t.diagnostic(`Touch (${pointer.x},${pointer.y}): 0 -> 1 note; baseline offset ${error.toFixed(4)} CSS px`);
    assert.ok(error <= offsetLimit, `note offset ${error} exceeds ${offsetLimit} CSS px`);
    await traceInk(page, t, 'Zoomed and panned', { ...point, y: point.y + 50 });
    await tapControl(page, '#zoom-fit');
    assert.equal((await waitForPaper(page, fit.width)).width, fit.width);
    const widths = await page.locator('#stage').evaluate(stage => [stage.scrollWidth, stage.clientWidth, document.documentElement.scrollWidth, innerWidth]);
    t.diagnostic(`After Fit: stage scrollWidth/clientWidth, root scrollWidth/innerWidth: ${widths}`);
    assert.deepEqual(widths, Array(4).fill(vp.width));
  });

  mobileTest(device, viewport, 'C3 directly tappable Undo and Redo', async (page, t) => {
    const note = 'Mobile history note';
    await arm(page, note);
    const { x, y } = await pagePoint(page);
    await page.touchscreen.tap(x, y);
    await expectNotes(page, t, 'placed', [note], '');
    const pill = page.locator('#phone-status');
    assert.match(await pill.textContent(), /Page 1 of 3.*Unsaved edits/);
    await tapControl(page, '#undo');
    await page.waitForFunction(() => !document.querySelector('#redo').disabled && !document.querySelector('#paper').hidden);
    await expectNotes(page, t, 'one Undo tap', []);
    await tapControl(page, '#redo');
    await page.waitForFunction(() => !document.querySelector('#undo').disabled && !document.querySelector('#paper').hidden);
    await expectNotes(page, t, 'one Redo tap', [note]);
  });
}

mobileTest(...devicesToTest.find(([, vp]) => vp.width === 375), 'M2 More tools can scroll in a short viewport', async (page, t, vp) => {
  // Exercise the same sheet when it cannot show all rows at once.
  await page.setViewportSize({ width: vp.width, height: 180 });
  await tapControl(page, '#more-tools');
  const panel = page.locator(sheet);
  const overflow = await panel.evaluate(element => element.scrollHeight - element.clientHeight);
  assert.ok(overflow > 0, 'short viewport should give the sheet internal scroll range');
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const scroll = await panel.evaluate(element => ({ panel: element.scrollTop, root: window.scrollY }));
  t.diagnostic(`Short viewport: sheet scroll range ${overflow}, scrolled ${scroll.panel}; root scroll ${scroll.root}`);
  assert.ok(scroll.panel > 0 && scroll.root === 0);
  await tapControl(page, '#extract');
  await page.locator('#extract-dialog[open]').waitFor();
  assert.equal(await panel.isVisible(), false);
});
