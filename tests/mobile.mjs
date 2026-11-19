// Setup on a fresh checkout: npm ci; npx playwright install webkit; npm run test:mobile.
// On Linux, provision Playwright's WebKit system dependencies as well (--with-deps).
// Set MOBILE_EVIDENCE_DIR to an absolute artifact directory to retain screenshots there.
// Taps use WebKit's touchscreen; synthetic PointerEvents exercise drag/scroll/pinch handlers,
// not native iOS scroll physics, pinch recognition, or behavior on a physical iPhone.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { devices, webkit } from 'playwright';
import { serve } from '../scripts/serve.mjs';
import { mobilePage } from './fixtures/mobile-page.mjs';

const evidenceDir = resolve(process.env.MOBILE_EVIDENCE_DIR || 'test-results/mobile');
const devicesToTest = [
  ['iPhone 11 Pro', { width: 375, height: 812 }],
  ['iPhone 13', { width: 390, height: 844 }],
];
const textMode = '#modes button[data-mode="text"]';
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

function mobileTest(device, viewport, name, run) {
  test(`${viewport.width}x${viewport.height} ${name}`, { timeout: 25_000 }, async t => {
    const { defaultBrowserType, ...profile } = devices[device];
    const context = await browser.newContext({ ...profile, viewport, screen: viewport });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.locator('#file').setInputFiles(fixture);
      // Opening the workspace can schedule one more fit render via ResizeObserver.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('#paper').waitFor({ state: 'visible' });
      await run(page, t, viewport);
    } finally {
      await context.close();
    }
  });
}

async function measureLayout(page) {
  return page.evaluate((modeSelector) => {
    const canvas = document.querySelector('#canvas');
    const context = canvas.getContext('2d');
    const sample = ratio => Array.from(context.getImageData(
      Math.floor(canvas.width / 2), Math.floor(canvas.height * ratio), 1, 1,
    ).data);
    const rect = canvas.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * .065);
    const measured = [];
    for (const element of document.querySelectorAll(
      'button,input,select,textarea,summary,a[href],[role=button],[role=tab],[contenteditable=true]',
    )) {
      if (element.matches(':disabled,[aria-disabled=true],input[type=hidden]') ||
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
        width, height, size: Math.min(width, height) });
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
      innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollY, stageScroll: document.querySelector('#stage').scrollTop,
      pageTop: rect.top, artworkVisible: hit === canvas || hit?.id === 'overlay',
      ink: sample(.065), white: sample(.13),
      anchored, toolTop: modeRect.top, toolBottom: modeRect.bottom,
      overflowingModeLabels: [...document.querySelectorAll('#modes button')]
        .filter(button => button.scrollWidth > button.clientWidth).map(button => button.dataset.mode),
      targetCount: measured.length, smallest: measured[0], undersized: measured.filter(item => item.size < 44),
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

async function expectNotes(page, t, step, expected, pending) {
  const actual = await page.locator('#overlay text').allTextContents();
  const input = await page.locator('#mark-text').inputValue();
  t.diagnostic(`${step}: ${actual.length} note(s); pending=${JSON.stringify(input)}`);
  assert.deepEqual(actual, expected, `${step}: rendered text annotations`);
  if (pending !== undefined) assert.equal(input, pending, `${step}: pending text`);
}

// Events are dispatched on the real overlay and bubble through the stage. Synthetic pointers
// do not establish native capture or perform default actions; scroll is driven separately.
async function pointerSequence(page, point, steps) {
  await page.locator('#overlay').evaluate(async (overlay, { point, steps }) => {
    const stage = document.querySelector('#stage');
    for (const [type, dx = 0, pointerId = 1] of steps) {
      if (type === 'scroll') {
        // Wait for an actual scroll event before releasing the same pointer at its original point.
        await new Promise(resolve => {
          stage.addEventListener('scroll', resolve, { once: true });
          stage.scrollTop += 160;
        });
        continue;
      }
      overlay.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerType: 'touch',
        pointerId, isPrimary: pointerId === 1, clientX: point.x + dx, clientY: point.y,
        button: type === 'pointermove' || type === 'pointercancel' ? -1 : 0,
        buttons: ['pointerdown', 'pointermove'].includes(type) ? 1 : 0,
      }));
    }
  }, { point, steps });
}

for (const [device, viewport] of devicesToTest) {
  mobileTest(device, viewport, 'C1 rendered document and bottom controls', async (page, t, vp) => {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('#stage').scrollTo(0, 0);
    });
    const layout = await measureLayout(page);
    t.diagnostic(JSON.stringify(layout));
    assert.deepEqual([layout.scrollY, layout.stageScroll], [0, 0], 'capture must start at scroll zero');
    assert.ok(layout.ink[0] < 100 && layout.ink[2] > layout.ink[0] + 40 && layout.ink[3] === 255,
      'sample the blue artwork in the rendered PDF, not an empty canvas');
    assert.ok(layout.white.every(channel => channel > 245), 'sample white paper outside the artwork');
    const path = resolve(evidenceDir, `webkit-${vp.width}x${vp.height}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    t.diagnostic(`Screenshot: ${path}`);
    const failures = [];
    if (layout.innerWidth !== vp.width || layout.innerHeight !== vp.height) failures.push('incorrect CSS viewport');
    if (layout.pageTop < 0 || layout.pageTop > .6 * vp.height || !layout.artworkVisible) failures.push('rendered page does not start unobscured in upper 60%');
    if (layout.scrollWidth > layout.innerWidth) failures.push('horizontal document overflow');
    if (!layout.anchored || layout.toolTop < vp.height / 2 || layout.toolBottom > vp.height) failures.push('Text is not in a viewport-anchored bottom editing surface');
    if (!layout.targetCount || layout.undersized.length) failures.push('visible enabled targets below 44×44 CSS px');
    if (layout.overflowingModeLabels.length) failures.push(`mode labels overflow: ${layout.overflowingModeLabels.join(', ')}`);
    assert.deepEqual(failures, []);
    await tapControl(page, textMode);
    await page.locator('#mark-text').waitFor();
    const textLayout = await measureLayout(page);
    t.diagnostic(`Text options: ${JSON.stringify(textLayout)}`);
    assert.equal(textLayout.undersized.length, 0, 'visible text-mode controls must also meet 44×44');
    assert.ok(textLayout.scrollWidth <= textLayout.innerWidth, 'opening text options must not cause horizontal overflow');
  });

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
    const stage = page.locator('#stage');
    const { before, remaining } = await stage.evaluate(element => ({
      before: element.scrollTop,
      remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
    assert.ok(remaining >= 160, 'the tall fixture must allow at least 160 CSS px of further scroll');
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
    const before = await page.locator('#paper').evaluate(element => element.getBoundingClientRect().width);
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

  mobileTest(device, viewport, 'C3 directly tappable Undo and Redo', async (page, t) => {
    const note = 'Mobile history note';
    await arm(page, note);
    const { x, y } = await pagePoint(page);
    await page.touchscreen.tap(x, y);
    await expectNotes(page, t, 'placed', [note]);
    await tapControl(page, '#undo');
    await page.waitForFunction(() => !document.querySelector('#redo').disabled && !document.querySelector('#paper').hidden);
    await expectNotes(page, t, 'one Undo tap', []);
    await tapControl(page, '#redo');
    await page.waitForFunction(() => !document.querySelector('#undo').disabled && !document.querySelector('#paper').hidden);
    await expectNotes(page, t, 'one Redo tap', [note]);
  });
}
