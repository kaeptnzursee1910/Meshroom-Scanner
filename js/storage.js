// Fotos dauerhaft im Browser (IndexedDB) speichern – überlebt Neuladen und App-Wechsel.

const DB_NAME = 'meshroom-scanner';
const STORE = 'photos';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
const db = () => (dbPromise ||= open());

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen (Speicher voll?)'));
  }));
}

export const storage = {
  add: (photo) => tx('readwrite', (s) => s.add(photo)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
  all: () => tx('readonly', (s) => s.getAll()),
  /** Nur Metadaten (ohne große Blobs) – für Abdeckung/Zähler */
  meta: async () => (await storage.all()).map(({ blob, ...rest }) => rest),
  async estimate() {
    if (!navigator.storage?.estimate) return null;
    return navigator.storage.estimate();
  },
  async persist() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  },
};
