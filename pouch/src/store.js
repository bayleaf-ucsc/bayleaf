// IndexedDB, no library. One database, five stores:
//   sessions  agent conversations (id -> { id, title, updated, messages, ... })
//   settings  small key/value pairs (key, model, cache secret)
//   mounts    FileSystemDirectoryHandles from showDirectoryPicker (name -> handle)
//   shared    the /pouch file tree, kept apart from OPFS and picked folders
//             (path -> { kind: 'file'|'dir', data?: Uint8Array, mtime })
//   changes   what each agent run changed, for review and undo (review.js)
//             (seq -> { seq, run, session, path, op, ts, before, after? })
const DB = 'bayleaf-pouch';
const STORES = ['sessions', 'settings', 'mounts', 'shared'];
const MAX_CHANGES = 500;

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      if (!req.result.objectStoreNames.contains('changes')) {
        req.result.createObjectStore('changes', { keyPath: 'seq', autoIncrement: true }).createIndex('session', 'session');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

export async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const get = (store, k) => tx(store, 'readonly', (s) => s.get(k));
export const put = (store, k, v) => tx(store, 'readwrite', (s) => (v === undefined ? s.delete(k) : s.put(v, k)));
export const del = (store, k) => tx(store, 'readwrite', (s) => s.delete(k));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const keys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());

// Change records carry their own key (seq), assigned in insertion order.
export const addChange = (rec) => tx('changes', 'readwrite', (s) => s.add(rec)); // resolves to seq
export const putChange = (rec) => tx('changes', 'readwrite', (s) => s.put(rec));
export const changesFor = (session) => tx('changes', 'readonly', (s) => s.index('session').getAll(String(session)));
export const deleteChanges = (session) => tx('changes', 'readwrite', (s) => {
  s.index('session').openKeyCursor(String(session)).onsuccess = (e) => { const c = e.target.result; if (c) { s.delete(c.primaryKey); c.continue(); } };
});
// Keep only the newest MAX_CHANGES records; they hold whole file copies.
export const pruneChanges = () => tx('changes', 'readwrite', (s) => {
  s.count().onsuccess = (e) => {
    let extra = e.target.result - MAX_CHANGES;
    if (extra <= 0) return;
    s.openKeyCursor().onsuccess = (ev) => { const c = ev.target.result; if (c && extra-- > 0) { s.delete(c.primaryKey); c.continue(); } };
  };
});

export const getSetting = (k) => get('settings', k);
export const setSetting = (k, v) => put('settings', k, v);

// The red button. Removes everything this origin stored: every IndexedDB
// database, all of OPFS, local/session storage and Cache Storage. Folders
// picked with showDirectoryPicker are real folders on the device and are
// not touched; only Pouch's handles to them are forgotten.
export async function eraseEverything() {
  if (dbp) { (await dbp).close(); dbp = null; }
  const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [DB];
  await Promise.all(names.map((n) => new Promise((res) => {
    const r = indexedDB.deleteDatabase(n);
    r.onsuccess = r.onerror = r.onblocked = () => res();
  })));
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  } catch { /* no OPFS in this browser */ }
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
}
