// Keeps the loop clip in the browser (IndexedDB) so it can be reused for the next episodes.

const DB = 'flimio';
const STORE = 'files';
const KEY = 'loop';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const saveLoop = (file: File) => run('readwrite', (s) => s.put(file, KEY)).then(() => undefined);
export const clearLoop = () => run('readwrite', (s) => s.delete(KEY)).then(() => undefined);
export async function loadLoop(): Promise<File | null> {
  try {
    const f = await run<unknown>('readonly', (s) => s.get(KEY));
    return f instanceof File ? f : null;
  } catch {
    return null;
  }
}
