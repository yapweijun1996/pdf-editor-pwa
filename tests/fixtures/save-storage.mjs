// Runs in the browser; inspection never calls the application's storage helpers.
export async function journal(store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('paperplane-save-v1', 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store);
      const result = tx.objectStore(store).getAll();
      tx.oncomplete = () => { db.close(); resolve(result.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

// Read the committed record and its corresponding raw OPFS payload independently.
export async function journalBytes(store) {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle('paperplane-save-v1');
  return Promise.all((await journal(store)).map(async ({ doc, ...item }) => ({
    ...item, hasHandle: doc ? doc.handle instanceof FileSystemFileHandle : undefined,
    bytes: Array.from(new Uint8Array(await (await (await folder.getFileHandle(item.payload)).getFile()).arrayBuffer())),
  })));
}

export function pickerFixture({ external }) {
  const proto = FileSystemFileHandle.prototype;
  const create = proto.createWritable;
  const get = proto.getFile;
  const rawDirectory = navigator.storage.getDirectory.bind(navigator.storage);
  window.saveFixture = {
    calls: [], targetWrites: [], perm: 'granted', fault: '',
    async seed(which, data) {
      const root = await rawDirectory();
      const dir = await root.getDirectoryHandle(which, { create: true });
      const handle = await dir.getFileHandle('fixture.pdf', { create: true });
      const writer = await create.call(handle);
      await writer.write(new Uint8Array(data)); await writer.close();
      return handle;
    },
    async target() {
      return (await (await rawDirectory()).getDirectoryHandle(this.which || 'alpha')).getFileHandle('fixture.pdf');
    },
    async read(which = this.which || 'alpha') {
      const handle = await (await (await rawDirectory()).getDirectoryHandle(which)).getFileHandle('fixture.pdf');
      return Array.from(new Uint8Array(await (await get.call(handle)).arrayBuffer()));
    },
  };
  const f = window.saveFixture;
  Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: async () => [await f.target()] });
  proto.queryPermission = async function (options) {
    f.calls.push(['query', navigator.userActivation.isActive, options.mode]);
    return f.perm;
  };
  proto.requestPermission = async function (options) {
    f.calls.push(['request', navigator.userActivation.isActive, options.mode]);
    return f.grant ? 'granted' : 'denied';
  };
  // Return a stable lastModified value so same-size changes require the digest.
  proto.getFile = async function () {
    const file = await get.call(this);
    return this.name === 'fixture.pdf' ? new File([file], file.name, { lastModified: 42, type: 'application/pdf' }) : file;
  };
  navigator.storage.getDirectory = async () => {
    if (f.fault === 'no-storage') throw new DOMException('Injected missing OPFS', 'NotSupportedError');
    return rawDirectory();
  };
  proto.createWritable = async function (...args) {
    if (this.name !== 'fixture.pdf') {
      if (f.fault === 'quota') throw new DOMException('Injected backup quota', 'QuotaExceededError');
      return create.apply(this, args);
    }
    const { journalBytes } = await import('/save-test-fixture.mjs');
    const entry = { backups: await journalBytes('backups'), bytes: await f.read(), aborts: 0 };
    f.targetWrites.push(entry);
    if (f.fault === 'rollback' && f.targetWrites.length === 2) throw new Error('Injected rollback failure');
    const writer = await create.apply(this, args);
    return {
      async write(data) {
        entry.intended = Array.from(data);
        await writer.write(data);
        if (f.fault === 'write') throw new Error('Injected target write failure');
        if (f.fault === 'late-change') await f.seed(f.which || 'alpha', external);
      },
      async close() {
        if (f.fault === 'close') throw new Error('Injected target close failure');
        if (f.fault === 'tamper' || f.fault === 'rollback') {
          if (f.targetWrites.length === 1) {
            await writer.seek(0); await writer.write(new Uint8Array(external)); await writer.truncate(external.length);
          }
        }
        await writer.close();
      },
      async abort() { entry.aborts++; await writer.abort(); },
    };
  };
}
