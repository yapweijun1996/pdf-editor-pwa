import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { errors } from 'playwright';
import { sha256, stages } from './report.mjs';
import { contentSettings, createPageIdentity, rasterStats, rotatedReference } from './content.mjs';

export const viewport = { width: 1280, height: 900 };
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;
export const blocked = reason => ({ status: 'blocked', ms: null, reason });
export const emptyStages = () => Object.fromEntries(stages.map(stage => [stage, blocked('not reached')]));
export const message = error => String(error.message ?? error).split('\n')[0].slice(0, 500);
const fail = (error, start) => ({ status: error instanceof errors.TimeoutError || error.code === 'BASELINE_TIMEOUT'
  ? 'timeout' : 'infrastructure-failure', ms: elapsed(start), reason: message(error) });

export async function within(promise, timeout, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${description} exceeded ${timeout} ms`), { code: 'BASELINE_TIMEOUT' })), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function observe(page, kind, timeout, options = {}) {
  const handle = await page.waitForFunction(({ kind, priorStatus }) => {
    const status = document.querySelector('#status');
    const text = status.textContent.trim();
    if (status.dataset.error === 'true' && text && text !== priorStatus) {
      return { status: 'error', uiMessage: text, errorKind: /password|encrypt/i.test(text) ? 'password-or-encryption'
        : /corrupt or unsupported/i.test(text) ? 'corrupt-or-unsupported' : 'app-error' };
    }
    const count = Number(document.querySelector('#page-count').textContent.match(/\d+/)?.[0]);
    const selected = Number(document.querySelector('#page-number').value);
    if (kind === 'open' && /^Opened .+/s.test(text) && !document.querySelector('#workspace').hidden &&
        !document.querySelector('#save').disabled && count > 0 && selected === 1) {
      return { status: 'success', pages: count, uiMessage: text };
    }
    return false;
  }, { kind, ...options }, { timeout });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

// Observe only public DOM/backing-store changes. An attribute write resets the bitmap,
// even for another page of the same size. Thumbnails are not evidence.
async function armCanvas(page, timeout) {
  return within(page.evaluate(() => {
    window.__baselineCanvasWatch?.stop();
    const initial = document.querySelector('#canvas');
    const watch = { generation: 0, initial };
    const listener = new MutationObserver(records => {
      const current = document.querySelector('#canvas');
      if (current !== watch.initial || records.some(record => record.target === current && record.type === 'attributes')) {
        watch.initial = current;
        watch.generation++;
      }
      if (records.some(record => record.target === document.querySelector('#status') ||
          document.querySelector('#status')?.contains(record.target))) watch.statusChanged = true;
    });
    listener.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['width', 'height', 'data-error'] });
    watch.stop = () => listener.disconnect();
    window.__baselineCanvasWatch = watch;
    return document.querySelector('#status').textContent.trim();
  }), timeout, 'Arm main-canvas observation');
}

async function capture(page, pageNumber, priorStatus, timeout) {
  return within(page.evaluate(({ pageNumber, priorStatus, scale }) => {
    const status = document.querySelector('#status');
    const uiMessage = status.textContent.trim();
    const watch = window.__baselineCanvasWatch;
    if (status.dataset.error === 'true' && uiMessage && (uiMessage !== priorStatus || watch.statusChanged)) {
      return { error: true, uiMessage };
    }
    const selected = Number(document.querySelector('#page-number').value);
    const count = Number(document.querySelector('#page-count').textContent.match(/\d+/)?.[0]);
    const canvas = document.querySelector('#canvas');
    const state = { selected, count, uiMessage, generation: watch.generation };
    if (!watch.generation || selected !== pageNumber || !(count >= selected) || !canvas?.width || !canvas.height ||
        !canvas.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
        canvas.getBoundingClientRect().width <= 0 || canvas.getBoundingClientRect().height <= 0) return state;
    const probe = document.createElement('canvas');
    const factor = scale / Math.max(canvas.width, canvas.height);
    probe.width = Math.max(1, Math.round(canvas.width * factor));
    probe.height = Math.max(1, Math.round(canvas.height * factor));
    const context = probe.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, probe.width, probe.height);
    const bytes = context.getImageData(0, 0, probe.width, probe.height).data;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return { ...state, canvasPixels: [canvas.width, canvas.height], width: probe.width, height: probe.height, base64: btoa(binary) };
  }, { pageNumber, priorStatus, scale: contentSettings.rasterSize }), timeout, 'Read main-canvas evidence');
}

async function observeRender(page, pageNumber, reference, timeout, started, priorStatus, identity, rivals) {
  const deadline = started + timeout;
  let last, stableSince, signature;
  const { stableMs, pollMs, minimumOpacity } = contentSettings;
  while (performance.now() < deadline) {
    try {
      const { base64, width, height, error, ...state } = await capture(page, pageNumber, priorStatus,
        Math.max(1, deadline - performance.now()));
      last = state;
      if (error) return { status: 'error', ms: elapsed(started), ...state };
      if (base64) {
        const raster = rasterStats(Buffer.from(base64, 'base64'), width, height);
        const content = identity.compare(reference, raster, rivals);
        const key = `${state.generation}:${state.canvasPixels.join('x')}:${raster.sha256}`;
        if (signature !== key) stableSince = performance.now();
        signature = key;
        const stable = performance.now() - stableSince >= stableMs;
        last = { ...state, ink: raster.ink, inkFraction: raster.inkFraction, nonwhite: raster.nonwhite, opacity: raster.opacity,
          rasterSha256: raster.sha256, rasterPixels: [width, height], referenceSha256: reference.sha256,
          inputReferenceSha256: reference.inputSha256 ?? reference.sha256, clockwiseReference: reference.clockwise === true,
          expectedBlank: reference.blank, content, stable };
        if (content.match && stable && performance.now() <= deadline) {
          identity.confirm(pageNumber, reference, raster);
          return { status: 'success', ms: elapsed(started), page: pageNumber, ...last };
        }
      } else signature = undefined;
      await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())));
    } catch (error) {
      if (error.code === 'BASELINE_TIMEOUT') break;
      return { ...fail(error, started), lastObservation: last };
    }
  }
  // A stable, opaque wrong image is a mismatch, not a successful paint or an unseen timeout.
  const mismatch = last?.stable && last.opacity >= minimumOpacity && !last.content.match;
  return { status: mismatch ? 'error' : 'timeout', ms: elapsed(started),
    reason: mismatch ? last.content.reason : `No fresh stable content confirmed within ${timeout} ms`, lastObservation: last };
}

async function ready(context, origin, timeout) {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'load', timeout });
  await page.locator('#open').waitFor({ state: 'visible', timeout });
  return page;
}

const missingReference = page => ({ status: 'infrastructure-failure', ms: null,
  reason: `Missing usable independent page reference(s) for measurement of page ${page}` });

export function performancePages(sample) {
  return [...new Set(sample.category === 'performance' && sample.pageCount > 1
    ? [1, Math.ceil(sample.pageCount / 2), sample.pageCount] : [1])];
}

async function openAndRender(page, file, expectedPages, reference, timeout, identity, rivals = []) {
  let started = performance.now();
  try {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout }), page.locator('#open').click({ timeout })]);
    const priorStatus = await armCanvas(page, timeout);
    started = performance.now();
    const [opened] = await within(Promise.all([observe(page, 'open', timeout, { priorStatus }), chooser.setFiles(file, { timeout })]), timeout, 'Open');
    const open = { ...opened, ms: elapsed(started) };
    if (open.status !== 'success') return { open, render: blocked('open rejected') };
    open.checksMatch = expectedPages === null || open.pages === expectedPages;
    const render = reference && rivals.every(([, raster]) => raster)
      ? await observeRender(page, 1, reference, timeout, started, priorStatus, identity, rivals) : missingReference(1);
    return { open, render };
  } catch (error) { return { open: fail(error, started), render: blocked('open not confirmed') }; }
}

async function navigate(page, pageNumber, reference, timeout, identity, rivals, key) {
  if (!reference || rivals.some(([, raster]) => !raster)) return missingReference(pageNumber);
  let started = performance.now();
  try {
    const priorStatus = await armCanvas(page, timeout);
    started = performance.now();
    if (key) await page.locator('#stage').press(key, { timeout });
    else {
      const number = page.locator('#page-number');
      await within((async () => {
        await number.fill(String(pageNumber), { timeout });
        await number.press('Enter', { timeout });
      })(), timeout, 'Page number action');
    }
    return await observeRender(page, pageNumber, reference, timeout, started, priorStatus, identity, rivals);
  } catch (error) { return fail(error, started); }
}

async function save(page, destination, timeout) {
  let started = performance.now();
  try {
    const priorStatus = await page.locator('#status').innerText({ timeout });
    started = performance.now();
    return await within((async () => {
      const [terminal] = await Promise.all([
        Promise.race([
          page.waitForEvent('download', { timeout }).then(download => ({ download })),
          observe(page, 'save-error', timeout, { priorStatus }),
        ]), page.locator('#save').click({ timeout }),
      ]);
      if (!terminal.download) return { ...terminal, ms: elapsed(started) };
      await terminal.download.saveAs(destination);
      const bytes = await readFile(destination);
      if (!bytes.length) return { status: 'error', ms: elapsed(started), reason: 'Empty browser download' };
      return { status: 'success', ms: elapsed(started), bytes: bytes.length, sha256: sha256(bytes) };
    })(), timeout, 'Download');
  } catch (error) { return fail(error, started); }
}

export async function measureUI(browser, server, sample, input, temp, timeout, result, references, control) {
  const context = await within(browser.newContext({ viewport, deviceScaleFactor: 1,
    acceptDownloads: true, serviceWorkers: 'block' }), timeout, 'Browser context creation');
  try {
    result.blockedNetworkRequests = 0;
    await context.route('**/*', route => {
      const request = route.request();
      if (server.allowed.has(request.url()) && ['GET', 'HEAD'].includes(request.method()) && request.postData() === null) {
        return route.continue();
      }
      result.blockedNetworkRequests++;
      return route.abort();
    });
    await context.routeWebSocket('**/*', socket => { result.blockedNetworkRequests++; return socket.close(); });
    const page = await within(ready(context, server.origin, timeout), timeout, 'Fresh app startup');
    const file = { name: basename(sample.path), mimeType: 'application/pdf', buffer: input };
    const first = references.get(1);
    const identity = createPageIdentity();
    const rivalsFor = target => performancePages(sample).filter(number => number !== target)
      .map(number => [number, references.get(number)]);
    const { open, render } = await openAndRender(page, file, sample.pageCount, first, timeout, identity, rivalsFor(1));
    Object.assign(result.actual, { open, render });
    if (open.status !== 'success') {
      result.actual.save = blocked('open did not succeed');
      result.actual.reopen = blocked('no download');
      if (open.status === 'error') {
        result.recovery = control ? { id: control.id,
          ...await openAndRender(page, control.file, control.pages, control.reference, timeout, createPageIdentity()) }
          : blocked('No previously confirmed control specimen');
      }
      return;
    }
    if (sample.expected.alternativeOpen === 'success') {
      const reason = 'Conditional export prerequisites (marker agreement or permissions) not established';
      result.edit = blocked(reason);
      result.actual.save = blocked(reason);
      result.actual.reopen = blocked('no download');
      return;
    }
    if (sample.category === 'performance' && render.status === 'success' && open.checksMatch && open.pages > 1) {
      const middle = Math.ceil(open.pages / 2);
      if (open.pages > 2) result.middlePage = await navigate(page, middle, references.get(middle), timeout, identity, rivalsFor(middle));
      result.lastPage = await navigate(page, open.pages, references.get(open.pages), timeout, identity, rivalsFor(open.pages), 'End');
      result.returnToFirst = await navigate(page, 1, first, timeout, identity, rivalsFor(1), 'Home');
    }
    const destination = join(temp, 'download.pdf');
    const editStarted = performance.now();
    try {
      if (await page.locator('#page-number').inputValue({ timeout }) !== '1') throw new Error('First page unavailable for rotation');
      await page.locator('#rotate').click({ timeout });
      const edited = await within(page.waitForFunction(() =>
        document.querySelector('#dirty').textContent.includes('Unsaved edits') &&
        document.querySelector('#status').textContent.includes('Page rotated clockwise.'), null, { timeout }), timeout, 'Rotation edit');
      await edited.dispose();
      result.edit = { status: 'success', ms: elapsed(editStarted), action: 'Rotate first page clockwise' };
    } catch (error) { result.edit = fail(error, editStarted); }
    result.actual.save = await save(page, destination, timeout);
    if (result.actual.save.status === 'success') {
      try {
        const confirm = page.locator('#confirm-save');
        if (await confirm.isVisible()) await confirm.click({ timeout });
      } catch (error) { result.saveConfirmation = message(error); }
    }
    if (result.actual.save.status !== 'success') {
      result.actual.reopen = blocked('no completed download');
      return;
    }
    // Reopen the downloaded bytes using a fresh editor page, not app state or a URL.
    try {
      const reopened = await within(ready(context, server.origin, timeout), timeout, 'Reopen app startup');
      const reference = first && result.edit.status === 'success' ? rotatedReference(first) : first;
      const rivals = rivalsFor(1);
      if (reference?.clockwise) {
        // The other pages were not edited. Include the original appearance of page 1
        // as a competing hypothesis for performance samples, in addition to replay history.
        if (sample.category === 'performance') rivals.push([1, first]);
      }
      const roundTrip = await openAndRender(reopened, destination, open.pages, reference, timeout, identity, rivals);
      result.reopenOpen = roundTrip.open;
      result.reopenRender = roundTrip.render;
      result.actual.reopen = roundTrip.open.status === 'success'
        ? { ...roundTrip.render, pages: roundTrip.open.pages,
          checksMatch: roundTrip.open.checksMatch && roundTrip.render.status === 'success' }
        : roundTrip.open;
    } catch (error) {
      result.actual.reopen = { status: 'infrastructure-failure', ms: null, reason: message(error) };
    }
  } finally {
    await within(context.close(), timeout, 'Context cleanup');
  }
}
