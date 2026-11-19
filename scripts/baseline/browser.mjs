import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { errors } from 'playwright';
import { sha256, stages } from './report.mjs';

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
  const handle = await page.waitForFunction(({ kind, pageNumber, priorStatus, requireResize }) => {
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
    if (kind === 'render' && selected === pageNumber && count >= selected) {
      const canvas = document.querySelector('#canvas');
      const rect = canvas.getBoundingClientRect();
      if (requireResize && !window.__baselineCanvasResized?.()) return false;
      if (rect.width > 0 && rect.height > 0 && canvas.width > 0 && canvas.height > 0) {
        const context = canvas.getContext('2d');
        if (context && [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75]].some(([x, y]) =>
          context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data[3] > 0)) {
          return { status: 'success', page: selected, canvasPixels: [canvas.width, canvas.height] };
        }
      }
    }
    return false;
  }, { kind, ...options }, { timeout });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

async function ready(context, origin, timeout) {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'load', timeout });
  await page.locator('#open').waitFor({ state: 'visible', timeout });
  return page;
}

async function openAndRender(page, file, expectedPages, timeout, priorStatus) {
  let started = performance.now();
  try {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout }), page.locator('#open').click({ timeout })]);
    started = performance.now();
    const [opened] = await within(Promise.all([observe(page, 'open', timeout, { priorStatus }), chooser.setFiles(file, { timeout })]), timeout, 'Open');
    const open = { ...opened, ms: elapsed(started) };
    if (open.status !== 'success') return { open, render: blocked('open rejected') };
    open.checksMatch = expectedPages === null || open.pages === expectedPages;
    try {
      const painted = await within(observe(page, 'render', timeout, { pageNumber: 1 }), timeout, 'First render');
      return { open, render: { ...painted, ms: elapsed(started) } };
    } catch (error) { return { open, render: fail(error, started) }; }
  } catch (error) { return { open: fail(error, started), render: blocked('open not confirmed') }; }
}

async function navigate(page, pageNumber, timeout, key) {
  let started = performance.now();
  try {
    const priorStatus = await page.locator('#status').innerText({ timeout });
    await within(page.evaluate(() => {
      let resized = false;
      const canvas = document.querySelector('#canvas');
      const listener = new MutationObserver(() => { resized = true; listener.disconnect(); });
      listener.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
      window.__baselineCanvasResized = () => resized;
    }), timeout, 'Navigation observer');
    started = performance.now();
    const [paint] = await within(Promise.all([
      observe(page, 'render', timeout, { pageNumber, requireResize: true, priorStatus }),
      key ? page.locator('#stage').press(key, { timeout }) : (async () => {
        const number = page.locator('#page-number');
        await number.fill(String(pageNumber), { timeout });
        await number.press('Enter', { timeout });
      })(),
    ]), timeout, `Page ${pageNumber} render`);
    return { ...paint, ms: elapsed(started) };
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

export async function measureUI(browser, server, sample, input, temp, timeout, result, control) {
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
    const { open, render } = await openAndRender(page, file, sample.pageCount, timeout);
    Object.assign(result.actual, { open, render });
    if (open.status !== 'success') {
      result.actual.save = blocked('open did not succeed');
      result.actual.reopen = blocked('no download');
      if (open.status === 'error') {
        result.recovery = control ? { id: control.id,
          ...await openAndRender(page, control.file, control.pages, timeout, open.uiMessage) }
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
    if (sample.category === 'performance' && render.status === 'success' && open.pages > 1) {
      if (open.pages > 2) result.middlePage = await navigate(page, Math.ceil(open.pages / 2), timeout);
      result.lastPage = await navigate(page, open.pages, timeout, 'End');
      if (result.lastPage.status === 'success') result.returnToFirst = await navigate(page, 1, timeout, 'Home');
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
      const roundTrip = await openAndRender(reopened, destination, open.pages, timeout);
      result.reopenOpen = roundTrip.open;
      result.reopenRender = roundTrip.render;
      result.actual.reopen = roundTrip.open.status === 'success'
        ? { ...roundTrip.render, pages: roundTrip.open.pages, checksMatch: roundTrip.open.checksMatch }
        : roundTrip.open;
    } catch (error) {
      result.actual.reopen = { status: 'infrastructure-failure', ms: null, reason: message(error) };
    }
  } finally {
    await within(context.close(), timeout, 'Context cleanup');
  }
}
