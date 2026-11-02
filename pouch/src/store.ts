// IndexedDB, no library. One database, four stores:
//   sessions  agent conversations (id -> { id, title, updated, messages, ... })
//   settings  small key/value pairs (key, model, cache secret)
//   mounts    FileSystemDirectoryHandles from showDirectoryPicker (name -> handle)
//   shared    the /pouch file tree, kept apart from OPFS and picked folders
//             (path -> { kind: 'file'|'dir', data?: Uint8Array, mtime })
// Version 4 deleted the `changes` store (change review, dropped 2026-10-29):
// it held whole before-copies of files the agent changed.
const DB = 'bayleaf-pouch';
export type StoreName = 'sessions' | 'settings' | 'mounts' | 'shared';
const STORES: StoreName[] = ['sessions', 'settings', 'mounts', 'shared'];

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 4);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      if (req.result.objectStoreNames.contains('changes')) req.result.deleteObjectStore('changes');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

// What comes back is whatever was stored: callers name the type they wrote (T).
export async function tx<T = unknown>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | undefined): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const get = <T = unknown>(store: StoreName, k: IDBValidKey) => tx<T | undefined>(store, 'readonly', (s) => s.get(k));
export const put = (store: StoreName, k: IDBValidKey, v: unknown) => tx<unknown>(store, 'readwrite', (s) => (v === undefined ? s.delete(k) : s.put(v, k)));
export const del = (store: StoreName, k: IDBValidKey) => tx<undefined>(store, 'readwrite', (s) => s.delete(k));
export const all = <T = unknown>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll());
export const keys = (store: StoreName) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());

export const getSetting = <T = unknown>(k: string) => get<T>('settings', k);
export const setSetting = (k: string, v: unknown) => put('settings', k, v);

// The red button. Removes everything this origin stored: every IndexedDB
// database, all of OPFS, local/session storage and Cache Storage. Folders
// picked with showDirectoryPicker are real folders on the device and are
// not touched; only Pouch's handles to them are forgotten.
export async function eraseEverything() {
  if (dbp) { (await dbp).close(); dbp = null; }
  const names = indexedDB.databases ? (await indexedDB.databases()).flatMap((d) => d.name ?? []) : [DB];
  await Promise.all(names.map((n) => new Promise<void>((res) => {
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
