import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { PDFDocument, PDFName } from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';
import { serve } from '../scripts/serve.mjs';
import { pickerFixture } from './fixtures/save-storage.mjs';

const hash = data => createHash('sha256').update(Buffer.from(data)).digest('hex');
const fixtureURL = '/save-test-fixture.mjs';
const inputName = 'fixture.pdf';
const makePDF = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 500]).drawText('Save fixture');
  pdf.addPage([400, 500]);
  pdf.setTitle('Version A');
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
};
const original = await makePDF();
// Same length and xref offsets; only metadata differs. The fixture pins mtime.
const external = Buffer.from(original.toString('latin1').replace('00560065007200730069006F006E00200041', '00560065007200730069006F006E00200042'), 'latin1');
assert.equal(external.length, original.length);
assert.notEqual(hash(external), hash(original));
const fixture = await readFile(new URL('./fixtures/save-storage.mjs', import.meta.url));
let server, origin, chrome, safari;
before(async () => {
  server = serve(0);
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  chrome = await chromium.launch();
  safari = await webkit.launch();
});
after(async () => {
  try { await Promise.all([chrome?.close(), safari?.close()]); }
  finally { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
});
async function until(check, description, timeout = 6000) {
  const end = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < end);
  assert.fail(`Timed out waiting for ${description}`);
}
async function tab(t, engine = chrome) {
  const context = await engine.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route(`**${fixtureURL}`, route => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  return { context, page };
}
const text = (page, selector) => page.locator(selector).textContent();
const see = (page, selector, pattern) => until(async () => {
  const value = await text(page, selector);
  return pattern.test(value) && value;
}, `${selector} to match ${pattern}`);
const status = (page, pattern) => see(page, '#status', pattern);
const dirty = page => see(page, '#dirty', /^Unsaved edits$/);
const button = (page, name) => page.getByRole('button', { name, exact: true });
const save = page => page.locator('#save').click();
const rotate = async page => { await page.locator('#rotate').click(); await dirty(page); };
const fileOptions = page => page.locator('#file-options').click();
const closeOptions = page => page.locator('#file-dialog [data-close]').click();
const input = page => page.locator('#file').setInputFiles({ name: inputName, mimeType: 'application/pdf', buffer: original });
const download = async (page, action) => {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  assert.equal(file.suggestedFilename(), 'fixture-edited.pdf');
  assert.equal(await file.failure(), null);
  return readFile(await file.path());
};
const choose = (page, name) => button(page, name).click();
const observe = (page, store) => page.evaluate(async store => (await import('/save-test-fixture.mjs')).journalBytes(store), store);
const target = (page, which) => page.evaluate(which => saveFixture.read(which), which);
const writes = page => page.evaluate(() => saveFixture.targetWrites);
const fault = (page, mode) => page.evaluate(mode => { saveFixture.fault = mode; }, mode);
const seed = (page, which, bytes) => page.evaluate(async ([which, bytes]) => { await saveFixture.seed(which, bytes); }, [which, [...bytes]]);
async function inspect(bytes, angle = 90) {
  const pdf = await PDFDocument.load(Buffer.from(bytes), { throwOnInvalidObject: true, updateMetadata: false });
  assert.equal(pdf.getPageCount(), 2);
  assert.equal(pdf.getPage(0).getRotation().angle, angle);
  assert.equal(pdf.context.lookup(pdf.context.trailerInfo.Root).get(PDFName.of('Type')), PDFName.of('Catalog'));
}
async function connected(t) {
  const { page, context } = await tab(t);
  await context.addInitScript(pickerFixture, { external: [...external] });
  await page.goto(origin);
  await seed(page, 'alpha', original);
  await page.locator('#start').click();
  await status(page, /^Opened fixture\.pdf\.$/);
  await see(page, '#save-mode', /^Overwrites the original$/);
  return { page, context };
}
function backupBefore(entry, expected) {
  assert.equal(hash(entry.bytes), hash(expected));
  const backup = entry.backups.find(b => b.hash === hash(expected));
  assert.ok(backup, 'Committed backup must exist when target createWritable is invoked');
  assert.ok(backup.documentId && backup.id && backup.payload && backup.time > 0);
  assert.equal(backup.name, inputName);
  assert.equal(backup.size, expected.length);
  assert.equal(backup.original.size, expected.length);
  assert.equal(backup.original.lastModified, 42);
  assert.equal(backup.original.hash, hash(expected));
  assert.equal(hash(backup.bytes), backup.hash);
}

test('S1 native OPFS round trip, backup before writer, xref/catalog and no double rotation', async t => {
  const { page } = await connected(t);
  await rotate(page);
  await save(page);
  await status(page, /Saved and verified the original/);
  const [entry] = await writes(page);
  backupBefore(entry, original);
  const actual = await target(page);
  assert.equal(hash(actual), hash(entry.intended));
  await inspect(actual);
  assert.equal(await text(page, '#dirty'), '');
  await save(page);
  await status(page, /Saved and verified/);
  await until(async () => (await writes(page)).length === 2, 'second target write');
  await inspect(await target(page));
});

// Intercept only the serializer output, not validation, storage or the save action.
for (const mode of ['classic', 'stream', 'truncated', 'no EOF', 'no startxref', 'offset outside',
  'offset to ordinary object', 'no trailer', 'no Root', 'wrong Root', 'bad table entry', 'wrong stream type']) {
  test(`S1 intended export: ${mode}`, async t => {
    const { page } = await connected(t);
    await rotate(page);
    await page.evaluate(async mode => {
      const { PDFDocument } = await import('/vendor/pdf-lib/dist/pdf-lib.esm.min.js');
      const serializer = PDFDocument.prototype.save;
      PDFDocument.prototype.save = async function(options) {
        const stream = mode === 'stream' || mode === 'wrong stream type';
        const bytes = await serializer.call(this, { ...options, useObjectStreams: stream });
        const text = new TextDecoder('latin1').decode(bytes);
        const pointer = /startxref\s+(\d+)\s+%%EOF$/.exec(text);
        const offset = Number(pointer[1]);
        const tail = text.slice(offset);
        if (mode === 'classic' || mode === 'stream') return bytes;
        if (mode === 'truncated') return bytes.slice(0, offset);
        if (mode === 'wrong stream type') {
          const at = text.indexOf('/Type /XRef', offset);
          if (at < 0) throw Error('Invalid stream fixture');
          bytes[at + 7] = 89;
          return bytes;
        }
        const altered = {
          'no EOF': tail.replace('%%EOF', ''), 'no startxref': tail.replace(/startxref\s+\d+/, ''),
          'offset outside': tail.replace(pointer[0], `startxref\n${bytes.length}\n%%EOF`),
          'offset to ordinary object': tail.replace(pointer[0], `startxref\n${text.indexOf('1 0 obj')}\n%%EOF`),
          'no trailer': tail.replace(/trailer[\s\S]*?startxref/, 'startxref'),
          'no Root': tail.replace(/\/Root \d+ \d+ R/, ''), 'wrong Root': tail.replace(/\/Root \d+ \d+ R/, '/Root 1 0 R'),
          'bad table entry': tail.replace(/\d{10} 00000 n/, '0000000001 00000 n'),
        }[mode];
        if (!altered || altered === tail) throw Error('Invalid classic fixture');
        const suffix = new TextEncoder().encode(altered), output = new Uint8Array(offset + suffix.length);
        output.set(bytes.subarray(0, offset)); output.set(suffix, offset);
        return output;
      };
    }, mode);
    await save(page);
    if (mode === 'classic' || mode === 'stream') {
      await status(page, /Saved and verified/);
      const actual = await target(page), [entry] = await writes(page);
      assert.equal(hash(actual), hash(entry.intended));
      await inspect(actual);
      assert.match(Buffer.from(actual).toString('latin1'), mode === 'stream' ? /\/Type \/XRef/ : /\ntrailer\n/);
      return;
    }
    await status(page, /PDF export structure|catalog or page count/);
    await dirty(page);
    assert.equal((await writes(page)).length, 0);
    assert.equal(hash(await target(page)), hash(original));
  });
}

for (const action of ['Save a copy', 'Reload from disk', 'Overwrite anyway']) {
  test(`S1 same-size/mtime external conflict: ${action}`, async t => {
    const { page } = await connected(t);
    await rotate(page);
    await seed(page, 'alpha', external);
    await save(page);
    await see(page, '#choice-title', /Original changed on disk/);
    for (const name of ['Reload from disk', 'Overwrite anyway', 'Save a copy']) assert.ok(await button(page, name).isVisible());
    if (action === 'Save a copy') {
      await inspect(await download(page, () => choose(page, action)));
      await dirty(page);
    } else {
      await choose(page, action);
      if (action === 'Reload from disk') {
        await status(page, /Reloaded from disk/);
        const [draft] = await observe(page, 'drafts');
        await inspect(draft.bytes);
        assert.equal(await text(page, '#dirty'), '');
      } else {
        await status(page, /Saved and verified/);
        const [entry] = await writes(page);
        backupBefore(entry, external);
        assert.equal(hash(await target(page)), hash(entry.intended));
        return;
      }
    }
    assert.equal(hash(await target(page)), hash(external));
    assert.equal((await writes(page)).length, 0);
  });
}

test('S1 second change while conflict is open is not overwritten', async t => {
  const { page } = await connected(t);
  await rotate(page);
  await seed(page, 'alpha', external);
  await save(page);
  await see(page, '#choice-title', /Original changed on disk/);
  await seed(page, 'alpha', original);
  await choose(page, 'Overwrite anyway');
  await status(page, /File changed again/);
  await dirty(page);
  assert.equal((await writes(page)).length, 0);
  assert.equal(hash(await target(page)), hash(original));
});

for (const [mode, message, expected, count, aborts] of [
  ['write', /target write failure/, original, 1, 1],
  ['close', /target close failure.*Pre-write bytes verified/, original, 1, 1],
  ['late-change', /File changed again/, external, 1, 1],
  ['tamper', /hash mismatch.*Pre-write bytes verified/, original, 2, 0],
  ['rollback', /Original state unconfirmed.*Backup.*retained/, external, 2, 0],
  ['quota', /backup quota/, original, 0, 0],
  ['no-storage', /missing OPFS/, original, 0, 0],
]) {
  test(`S1 fails closed or reports verification outcome: ${mode}`, async t => {
    const { page } = await connected(t);
    await rotate(page);
    await fault(page, mode);
    await save(page);
    await status(page, message);
    await dirty(page);
    assert.equal(hash(await target(page)), hash(expected));
    const entries = await writes(page);
    assert.equal(entries.length, count);
    if (count) {
      backupBefore(entries[0], original);
      assert.equal(entries[0].aborts, aborts);
    } else {
      await fileOptions(page);
      await inspect(await download(page, () => choose(page, 'Save a copy')));
    }
    if (count === 2) backupBefore(entries[1], external);
  });
}

// Disk broker is intentionally separate from the native handle and persistence suite.
// Only abort or a successful close removes its real temporary sibling.
for (const mode of ['write', 'close']) {
  test(`S1 disk broker ${mode} rejection removes a real .crswap sibling only via abort`, async t => {
    const { page, context } = await tab(t);
    const dir = await mkdtemp(join(tmpdir(), 'paperplane-save-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, inputName), swap = `${path}.crswap`;
    await writeFile(path, original);
    const events = [];
    await context.exposeBinding('broker', async (_, method, data) => {
      events.push(method);
      if (method === 'read') return [...await readFile(path)];
      if (method === 'open') { await writeFile(swap, Buffer.alloc(0), { flag: 'wx' }); return; }
      if (method === 'write') await writeFile(swap, Buffer.from(data));
      if (method === mode) {
        assert.ok((await readdir(dir)).includes(`${inputName}.crswap`));
        assert.equal(hash(await readFile(path)), hash(original));
        throw new Error(`Broker ${mode} fault`);
      }
      if (method === 'close') await rename(swap, path);
      if (method === 'abort') await rm(swap);
    });
    await page.goto(origin);
    const message = await page.evaluate(async bytes => {
      const vault = await import('/src/save.js');
      const handle = {
        getFile: async () => new File([Uint8Array.from(await broker('read'))], 'fixture.pdf', { lastModified: 42 }),
        createWritable: async () => {
          const { journalBytes } = await import('/save-test-fixture.mjs');
          const backups = await journalBytes('backups');
          if (!backups.some(b => JSON.stringify(b.bytes) === JSON.stringify(bytes))) throw new Error('Missing committed backup');
          await broker('open');
          return { write: data => broker('write', [...data]), abort: () => broker('abort'), close: () => broker('close') };
        },
      };
      const file = await handle.getFile();
      const data = Uint8Array.from(bytes);
      const doc = { id: 'broker-document', name: file.name, handle, baseline: await vault.fingerprint(file, data) };
      try { await vault.replaceOriginal(doc, data, 2, () => { throw new Error('Unexpected conflict'); }); }
      catch (error) { return error.message; }
    }, [...original]);
    assert.match(message, new RegExp(`Broker ${mode} fault`));
    assert.equal(events.filter(event => event === 'abort').length, 1);
    assert.deepEqual(await readdir(dir), [inputName]);
    assert.equal(hash(await readFile(path)), hash(original));
  });
}

test('S3 dirty navigation, autosaved PDF, crash recovery and permission denial/retry on gesture', { timeout: 35000 }, async t => {
  const { context, page } = await connected(t);
  await rotate(page);
  const [prompt] = await Promise.all([
    page.waitForEvent('dialog').then(async dialog => { await dialog.dismiss(); return dialog; }),
    page.close({ runBeforeUnload: true }),
  ]);
  assert.equal(prompt.type(), 'beforeunload');
  await dirty(page);
  const draft = await until(async () => (await observe(page, 'drafts').catch(() => []))[0], 'committed OPFS draft', 15000);
  assert.ok(draft.hasHandle, 'IndexedDB must structured-clone a real handle');
  assert.equal(hash(draft.bytes), draft.hash);
  await inspect(draft.bytes);
  assert.equal(hash(await target(page)), hash(original));
  const cdp = await context.newCDPSession(page);
  const crash = page.waitForEvent('crash');
  const crashCommand = cdp.send('Page.crash').catch(() => {});
  await crash;
  await page.close();
  await crashCommand;
  const recovered = await context.newPage();
  recovered.setDefaultTimeout(5000);
  await recovered.addInitScript(() => { window.addEventListener('DOMContentLoaded', () => { saveFixture.perm = 'prompt'; }, { once: true }); });
  await recovered.goto(origin);
  await see(recovered, '#choice-title', /Recover unsaved work/);
  assert.equal(await recovered.locator('#workspace').isVisible(), false);
  await choose(recovered, 'Recover workspace');
  await status(recovered, /Recovered unsaved edits/);
  await dirty(recovered);
  assert.deepEqual((await recovered.evaluate(() => saveFixture.calls)).map(([kind]) => kind), ['query']);
  await save(recovered);
  await status(recovered, /Permission was not granted/);
  await dirty(recovered);
  assert.equal(hash(await target(recovered)), hash(original));
  assert.equal((await writes(recovered)).length, 0);
  await recovered.evaluate(() => { saveFixture.grant = true; });
  await save(recovered);
  await status(recovered, /Saved and verified/);
  assert.deepEqual((await recovered.evaluate(() => saveFixture.calls)).filter(([kind]) => kind === 'request'), [
    ['request', true, 'readwrite'], ['request', true, 'readwrite'],
  ]);
  await inspect(await target(recovered));
  assert.equal((await observe(recovered, 'drafts')).length, 0);
});

test('S3 restore an older backup from UI; an identically named second handle remains independent', async t => {
  const { page } = await connected(t);
  for (let angle = 90; angle <= 180; angle += 90) {
    await rotate(page);
    await save(page);
    await status(page, /Saved and verified/);
    await inspect(await target(page), angle);
  }
  await fileOptions(page);
  await choose(page, 'Restore previous version');
  await see(page, '#choice-title', /Restore previous version/);
  const older = page.locator('#choices button').filter({ hasText: hash(original) });
  assert.equal(await older.count(), 1);
  await older.click();
  await choose(page, 'Restore original');
  await status(page, /Previous version verified on disk/);
  assert.equal(hash(await target(page)), hash(original));
  assert.equal((await observe(page, 'backups')).length, 3);
  await seed(page, 'beta', external);
  await page.evaluate(() => { saveFixture.which = 'beta'; });
  await page.locator('#open').click();
  await status(page, /^Opened fixture\.pdf\.$/);
  await rotate(page);
  await save(page);
  await status(page, /Saved and verified/);
  assert.equal(hash(await target(page, 'alpha')), hash(original));
  await inspect(await target(page, 'beta'));
  assert.equal(new Set((await observe(page, 'backups')).map(b => b.documentId)).size, 2);
});

for (const [engine, standalone, share] of [
  ['Chromium', false, false], ['Chromium', false, true], ['WebKit', false, false],
  ['WebKit', true, false], ['WebKit', true, true],
]) {
  test(`S2 ${engine} pickers absent, standalone=${standalone}, file share=${share}`, async t => {
    const { page, context } = await tab(t, engine === 'Chromium' ? chrome : safari);
    await context.addInitScript(({ standalone, share }) => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(window, name, { value: undefined });
      Object.defineProperty(navigator, 'standalone', { value: standalone });
      window.shareCalls = [];
      // Inspect the exact Blob given to the non-download link without issuing a CSP-blocked fetch.
      window.copyBlobs = new Map();
      const create = URL.createObjectURL;
      URL.createObjectURL = blob => {
        const url = create.call(URL, blob);
        if (blob instanceof File && blob.type === 'application/pdf') copyBlobs.set(url, blob);
        return url;
      };
      Object.defineProperty(navigator, 'canShare', { value: ({ files }) => share && files.length === 1 && files[0] instanceof File && files[0].type === 'application/pdf' });
      Object.defineProperty(navigator, 'share', { value: async ({ files }) => {
        window.shareCalls.push({ activation: navigator.userActivation.isActive, name: files[0].name, bytes: Array.from(new Uint8Array(await files[0].arrayBuffer())) });
        throw new DOMException('Canceled by chooser', 'AbortError');
      } });
    }, { standalone, share });
    await page.goto(origin);
    await input(page);
    await status(page, /^Opened fixture\.pdf\.$/);
    await see(page, '#save-mode', /^Saves a copy$/);
    await fileOptions(page);
    await see(page, '#file-notice', /^This browser cannot overwrite the original\.$/);
    const copied = await download(page, async () => {
      await closeOptions(page);
      await rotate(page);
      await fileOptions(page);
      await choose(page, 'Save a copy');
    });
    await inspect(copied);
    await dirty(page);
    if (!(standalone || share)) await fileOptions(page);
    const link = page.locator('#view-copy');
    assert.ok(await link.isVisible());
    assert.equal(await link.getAttribute('download'), null);
    assert.equal(await link.getAttribute('target'), '_blank');
    const href = await link.getAttribute('href');
    assert.match(href, /^blob:/);
    const viewed = await page.evaluate(async href => [...new Uint8Array(await copyBlobs.get(href).arrayBuffer())], href);
    assert.equal(hash(viewed), hash(copied));
    assert.equal(await page.locator('#share-copy').isVisible(), share);
    if (share) {
      await choose(page, 'Share copy');
      await see(page, '#file-notice', /Copy not shared.*Canceled by chooser/);
      const [call] = await page.evaluate(() => shareCalls);
      assert.equal(call.activation, true);
      assert.equal(call.name, 'fixture-edited.pdf');
      assert.equal(hash(call.bytes), hash(copied));
      await dirty(page);
    }
    await closeOptions(page);
    await choose(page, 'I saved this copy');
    await status(page, /You confirmed/);
    assert.equal(await text(page, '#dirty'), '');
  });
}
