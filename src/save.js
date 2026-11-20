import { PDFDocument, PDFName } from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';

// IDB publishes completed journal pointers; the corresponding bytes live in OPFS.
const namespace = 'paperplane-save-v1';
let database;
async function table(name, method, ...args) {
  database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(namespace, 1);
    open.onupgradeneeded = () => {
      for (const store of ['documents', 'backups', 'drafts']) open.result.createObjectStore(store, { keyPath: 'id' });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, method.startsWith('get') ? 'readonly' : 'readwrite');
    const req = tx.objectStore(name)[method](...args);
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error || new Error('Local journal was not committed.'));
  });
}
const folder = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(namespace, { create: true });
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
export async function fingerprint(file, bytes) {
  return { size: file.size, lastModified: file.lastModified, hash: await digest(bytes) };
}
async function snapshot(handle) {
  const file = await handle.getFile(), bytes = new Uint8Array(await file.arrayBuffer());
  return { file, bytes, stamp: await fingerprint(file, bytes) };
}
const equal = (a, b) => a.size === b.size && a.lastModified === b.lastModified && a.hash === b.hash;
async function write(handle, bytes, beforeClose) {
  let stream, closed = false;
  try {
    stream = await handle.createWritable();
    await stream.write(bytes);
    if (beforeClose) await beforeClose();
    await stream.close();
    closed = true;
  } finally {
    if (stream && !closed) { try { await stream.abort(); } catch { /* Preserve the primary failure. */ } }
  }
}
export async function validatePDF(bytes, count) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  const root = pdf.context.lookup(pdf.context.trailerInfo.Root);
  const pages = pdf.getPages();
  if (root !== pdf.catalog || root.get(PDFName.of('Type')) !== PDFName.of('Catalog') ||
      !pages.length || pdf.catalog.Pages().Count().asNumber() !== pages.length || (count != null && pages.length !== count)) {
    throw new Error('PDF catalog or page count did not verify.');
  }
  return pages.length;
}
export async function readVersion(record) {
  const h = await (await folder()).getFileHandle(record.payload);
  const { bytes, stamp } = await snapshot(h);
  if (stamp.hash !== record.hash || stamp.size !== record.size) throw new Error('Stored version failed its integrity check.');
  return bytes;
}
async function publish(store, metadata, bytes) {
  const payload = crypto.randomUUID();
  const record = { ...metadata, payload, size: bytes.byteLength, hash: await digest(bytes), time: Date.now() };
  await write(await (await folder()).getFileHandle(payload, { create: true }), bytes);
  await readVersion(record);
  await table(store, 'put', record);
  return record;
}
export const drafts = () => table('drafts', 'getAll');
export async function clearDraft(id) {
  const previous = await table('drafts', 'get', id);
  if (!previous) return;
  await table('drafts', 'delete', id);
  await (await folder()).removeEntry(previous.payload);
}
export async function saveDraft(id, doc, bytes) {
  const previous = await table('drafts', 'get', id);
  await publish('drafts', { id, doc }, bytes);
  if (previous) await (await folder()).removeEntry(previous.payload);
}
export async function connect(handle, file, bytes) {
  return exclusive(async () => {
    await folder();
    const stamp = await fingerprint(file, bytes);
    let id;
    for (const record of await table('documents', 'getAll')) {
      if (await handle.isSameEntry(record.handle)) { id = record.id; break; }
    }
    const doc = { id: id || crypto.randomUUID(), handle, name: file.name, baseline: stamp };
    await table('documents', 'put', doc);
    return doc;
  });
}
export async function permission(handle) {
  const options = { mode: 'readwrite' };
  if (await handle.queryPermission(options) !== 'granted' && await handle.requestPermission(options) !== 'granted') {
    throw new Error('Permission was not granted. Use Save a copy instead.');
  }
}
function exclusive(fn) {
  if (!navigator.locks) throw new Error('Safe original-file locking is unavailable.');
  return navigator.locks.request(namespace, fn);
}
export const backups = async doc => (await table('backups', 'getAll')).filter(b => b.documentId === doc.id).sort((a, b) => b.time - a.time);
const backup = (doc, current) => publish('backups', { id: crypto.randomUUID(), documentId: doc.id, name: doc.name, original: current.stamp }, current.bytes);
async function unchanged(handle, stamp) {
  if (!equal((await snapshot(handle)).stamp, stamp)) throw new Error('File changed again. Retry to review the new version.');
}
export function replaceOriginal(doc, bytes, count, conflict) {
  return exclusive(async () => {
    const { handle } = doc;
    count = await validatePDF(bytes, count);
    const intended = await digest(bytes);
    const current = await snapshot(handle);
    if (!equal(current.stamp, doc.baseline)) {
      const action = await conflict();
      if (action !== 'overwrite') return { action, current };
    }
    const saved = await backup(doc, current);
    await unchanged(handle, current.stamp);
    let closing = false, actual;
    try {
      await write(handle, bytes, async () => { await unchanged(handle, current.stamp); closing = true; });
      actual = await snapshot(handle);
      if (actual.stamp.hash !== intended) throw new Error('Written PDF hash mismatch.');
      await validatePDF(actual.bytes, count);
    } catch (error) {
      if (!closing) throw error; // No close attempted; an external edit is not ours to undo.
      try {
        const observed = await snapshot(handle);
        if (observed.stamp.hash !== saved.hash) {
          await backup(doc, observed);
          const previous = await readVersion(saved);
          await unchanged(handle, observed.stamp);
          await write(handle, previous, () => unchanged(handle, observed.stamp));
          if ((await snapshot(handle)).stamp.hash !== saved.hash) throw new Error('Restored hash mismatch.');
        }
      } catch (rollback) {
        throw new Error(`Original state unconfirmed. Backup ${saved.id} retained in Restore previous version. ${rollback.message}`, { cause: error });
      }
      throw new Error(`${error.message} Pre-write bytes verified on disk; edits remain open.`);
    }
    const baseline = actual.stamp;
    try { await table('documents', 'put', { ...doc, baseline }); }
    catch (error) { throw new Error(`Disk write verified, but local journal update failed. Backup ${saved.id} retained.`, { cause: error }); }
    return { action: 'saved', baseline };
  });
}
