import { PDFContext, PDFDict, PDFDocument, PDFName, PDFObjectParser, PDFRawStream, PDFRef, decodePDFRawStream } from '../vendor/pdf-lib/dist/pdf-lib.esm.min.js';

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
// Validate a standalone export, not arbitrary incremental or hybrid revisions.
// PDFDocument.load can reconstruct a catalog even when no trailer exists on disk.
const latin = new TextDecoder('latin1'); // one code unit per byte, including stream data
function requireStructure(ok) {
  if (!ok) throw new Error('Incomplete or unsupported PDF export structure.');
}
function exportIndex(bytes) {
  const text = latin.decode(bytes);
  requireStructure(/^%PDF-\d\.\d[\r\n]/.test(text));
  const footer = /[\r\n]startxref[\t \r\n]+(\d+)[\t \r\n]+%%EOF[\t \r\n]*$/.exec(text);
  const at = Number(footer?.[1]);
  requireStructure(footer && at > 0 && at < footer.index);
  const section = text.slice(at, footer.index);
  const rows = new Map();
  function row(id, type, field, gen) {
    requireStructure(Number.isSafeInteger(id) && !rows.has(id) && type <= 2);
    if (type === 1) {
      const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(field, field + 64));
      requireStructure(field <= at && header && +header[1] === id && +header[2] === gen);
    }
    rows.set(id, { type, field, gen });
  }
  const get = (dict, key) => dict.get(PDFName.of(key));
  const parse = start => PDFObjectParser.forBytes(bytes.subarray(at + start, footer.index), PDFContext.create());
  let dict;
  if (/^xref[\r\n]/.test(section)) {
    const lines = section.split(/\r\n|[\r\n]/);
    let i = 1;
    while (lines[i] !== 'trailer') {
      const group = /^(\d+) (\d+) *$/.exec(lines[i++]);
      requireStructure(group && +group[2] > 0 && +group[2] <= lines.length - i);
      for (let j = 0; j < +group[2]; j++) {
        const entry = /^(\d{10}) (\d{5}) ([nf]) ?$/.exec(lines[i++]);
        requireStructure(entry);
        row(+group[1] + j, Number(entry[3] === 'n'), +entry[1], +entry[2]);
      }
      while (lines[i] === '') i++;
    }
    const start = section.indexOf('trailer') + 7, parser = parse(start);
    dict = parser.parseObject();
    requireStructure(dict instanceof PDFDict && !section.slice(start + parser.bytes.offset()).trim());
  } else {
    const header = /^(\d+) (\d+) obj\s+/.exec(section);
    requireStructure(header);
    const start = header[0].length, parser = parse(start), stream = parser.parseObject();
    requireStructure(stream instanceof PDFRawStream && section.slice(start + parser.bytes.offset()).trim() === 'endobj');
    dict = stream.dict;
    requireStructure(get(dict, 'Type') === PDFName.of('XRef') && get(dict, 'Length')?.asNumber() === stream.getContentsSize());
    const numbers = array => array.asArray().map(n => n.asNumber());
    const widths = numbers(get(dict, 'W'));
    requireStructure(widths.length === 3 && widths.every(w => Number.isInteger(w) && w >= 0 && w <= 6));
    const stride = widths.reduce((a, b) => a + b);
    const data = decodePDFRawStream(stream).decode();
    const index = get(dict, 'Index');
    const ranges = index ? numbers(index) : [0, get(dict, 'Size').asNumber()];
    requireStructure(stride && ranges.length % 2 === 0 && ranges.every(n => Number.isSafeInteger(n) && n >= 0));
    let pos = 0;
    function field(width, fallback) {
      let n = 0;
      for (let i = 0; i < width; i++) n = n * 256 + data[pos++];
      return width ? n : fallback;
    }
    for (let i = 0; i < ranges.length; i += 2) {
      const count = ranges[i + 1];
      requireStructure(count <= (data.length - pos) / stride);
      for (let j = 0; j < count; j++) row(ranges[i] + j, field(widths[0], 1), field(widths[1], 0), field(widths[2], 0));
    }
    requireStructure(pos === data.length && rows.get(+header[1])?.field === at && rows.get(+header[1]).type === 1);
  }
  const size = get(dict, 'Size')?.asNumber(), root = get(dict, 'Root');
  requireStructure(Number.isSafeInteger(size) && rows.get(0)?.type === 0 && root instanceof PDFRef &&
    !get(dict, 'Prev') && !get(dict, 'XRefStm'));
  const containers = new Map();
  for (const [id, entry] of rows) {
    requireStructure(id < size);
    if (entry.type !== 2) continue;
    // A compressed entry points to an object stream and a slot, not a byte offset.
    if (!containers.has(entry.field)) {
      const parent = rows.get(entry.field);
      requireStructure(parent?.type === 1);
      const head = /^\d+\s+\d+\s+obj\s+/.exec(text.slice(parent.field, parent.field + 64));
      requireStructure(head);
      const stream = PDFObjectParser.forBytes(bytes.subarray(parent.field + head[0].length), PDFContext.create()).parseObject();
      requireStructure(stream instanceof PDFRawStream && get(stream.dict, 'Type') === PDFName.of('ObjStm'));
      const first = get(stream.dict, 'First').asNumber();
      const ids = latin.decode(decodePDFRawStream(stream).decode().subarray(0, first)).trim().split(/\s+/);
      requireStructure(ids.length === 2 * get(stream.dict, 'N').asNumber());
      containers.set(entry.field, ids);
    }
    requireStructure(Number(containers.get(entry.field)[2 * entry.gen]) === id);
  }
  return { root, rows };
}
export async function validatePDF(bytes, count) {
  const index = exportIndex(bytes);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  for (const [ref] of pdf.context.enumerateIndirectObjects()) {
    const row = index.rows.get(ref.objectNumber);
    requireStructure(row && (row.type === 2 ? ref.generationNumber === 0 : row.type === 1 && row.gen === ref.generationNumber));
  }
  requireStructure(pdf.context.trailerInfo.Root === index.root);
  const root = pdf.context.lookup(index.root);
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
