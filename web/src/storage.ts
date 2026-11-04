/** Durable storage: SQLite/WAL on iOS and IndexedDB on the web. */
let values = new Map<string, string>();
const removed = new Set<string>();
const revisions = new Map<string, number>();
function changed(key: string) { revisions.set(key, (revisions.get(key) ?? 0) + 1); }
let adapterVersion = 0;
let bootstrapped = false;
let booting: Promise<void> | null = null;
let backend: 'native' | 'indexeddb' | 'custom' = 'indexeddb';
let db: IDBDatabase | null = null;
let writeChain = Promise.resolve();
const failures = new Map<string, unknown>();
let onFull: ((key: string) => void) | null = null;
let warned: string | null = null;
export interface StorageAdapter {
  bootstrap(): Promise<Record<string, string>>;
  get?(key: string): string | undefined;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Commit all documents in one transaction. */
  setMany?(entries: Record<string, string>): Promise<void>;
}
let customAdapter: StorageAdapter | null = null;

export function onStorageFull(cb: (key: string) => void) { onFull = cb; if (warned) cb(warned); }
export function storageFull(key: string) { if (!warned) { warned = key; onFull?.(key); } }

/** Install only while no writes are pending; production installs its adapter before bootstrap. */
export function installStorageAdapter(adapter: StorageAdapter) {
  customAdapter = adapter;
  adapterVersion++;
  backend = 'custom';
  bootstrapped = false;
  booting = null;
  values = new Map();
  removed.clear();
  revisions.clear();
  writeChain = Promise.resolve();
  failures.clear();
  warned = null;
}
const VOLATILE_NATIVE_KEYS = new Set(['maia-coach.evals']);

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB error'));
  });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => { /* onabort carries the final transaction failure */ };
  });
}
async function openWebStore(): Promise<Map<string, string>> {
  const opened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('maia-coach', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('documents');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
  try {
    const tx = opened.transaction('documents', 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore('documents');
    // Issue both requests while the transaction is active, before yielding to promises.
    const [keys, data] = await Promise.all([req(store.getAllKeys()), req(store.getAll()), done]);
    db?.close();
    db = opened;
    return new Map(keys.map((key, i) => [String(key), data[i] as string]));
  } catch (error) { opened.close(); throw error; }
}

/** Failure rejects and remains retryable. No default data is written over an unopened database. */
export async function bootstrapStorage(): Promise<void> {
  if (bootstrapped) return;
  if (booting) return booting;
  booting = (async () => {
    let loaded: Map<string, string>;
    if (customAdapter) {
      loaded = new Map(Object.entries(await customAdapter.bootstrap()));
      backend = 'custom';
    } else {
      const { Capacitor } = await import('@capacitor/core');
      if (Capacitor.isNativePlatform()) {
        const { AppStoreNative } = await import('maia-native');
        const result = await AppStoreNative.bootstrap();
        loaded = new Map(Object.entries(result.values));
        backend = 'native';
      } else {
        loaded = await openWebStore();
        backend = 'indexeddb';
      }
    }
    values = loaded;
    bootstrapped = true;
  })();
  try { await booting; } finally { booting = null; }
}
function requireReady() { if (!bootstrapped) throw new Error('本地数据库尚未就绪，请重试初始化'); }

async function writeValues(entries: Record<string, string | null>) {
  requireReady();
  if (backend === 'native') {
    const { AppStoreNative } = await import('maia-native');
    const durable = Object.fromEntries(Object.entries(entries).filter(([key]) => !VOLATILE_NATIVE_KEYS.has(key)));
    if (Object.keys(durable).length) await AppStoreNative.writeBatch({ entries: durable });
  } else if (backend === 'custom' && customAdapter) {
    const pairs = Object.entries(entries);
    if (pairs.length > 1) {
      if (!customAdapter.setMany || pairs.some(([, value]) => value === null)) throw new Error('Adapter does not support atomic batch writes');
      await customAdapter.setMany(entries as Record<string, string>);
    } else for (const [key, value] of pairs) {
      if (value === null) await customAdapter.remove(key);
      else await customAdapter.set(key, value);
    }
  } else if (db) {
    const tx = db.transaction('documents', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('documents');
    try {
      for (const [key, value] of Object.entries(entries)) {
        if (value === null) store.delete(key);
        else store.put(value, key);
      }
    } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    // Request success is insufficient: commit may still fail (e.g. quota / disk errors).
    await done;
  } else throw new Error('本地数据库不可用');
}
function enqueue(entries: Record<string, string | null>, evictCache = false): Promise<void> {
  const keys = Object.keys(entries);
  const version = adapterVersion;
  const task = writeChain.then(async () => {
    if (version !== adapterVersion) throw new Error('Storage adapter replaced with pending writes');
    try { await writeValues(entries); }
    catch (error) {
      const cacheKey = 'maia-coach.evals';
      if (!evictCache || keys.includes(cacheKey) || storageRaw(cacheKey) === undefined) throw error;
      await writeValues({ [cacheKey]: null });
      values.delete(cacheKey);
      await writeValues(entries);
    }
    for (const key of keys) failures.delete(key);
  });
  writeChain = task.catch(error => {
    if (version !== adapterVersion) return;
    for (const key of keys) failures.set(key, error);
    console.warn('保存本机数据失败', keys.join(', '), error);
    storageFull(keys[0]);
  });
  return task;
}

/** Updates memory immediately; true means queued, not committed. Use setStored/flushStorage for acknowledgement. */
export function safeSet(key: string, value: string): boolean {
  if (!bootstrapped) { storageFull(key); return false; }
  values.set(key, value);
  changed(key);
  removed.delete(key);
  if (backend !== 'native' || !VOLATILE_NATIVE_KEYS.has(key)) void enqueue({ [key]: value }, true).catch(() => {});
  return true;
}
/** Atomically commits a group of documents before publishing them to readers. */
export async function setStoredBatch(entries: Record<string, string>): Promise<void> {
  requireReady();
  const versions = new Map(Object.keys(entries).map(key => { changed(key); return [key, revisions.get(key)] as const; }));
  await enqueue(entries);
  for (const [key, value] of Object.entries(entries)) {
    if (revisions.get(key) !== versions.get(key)) continue;
    values.set(key, value); removed.delete(key);
  }
}
export async function setStored(key: string, value: string): Promise<void> { await setStoredBatch({ [key]: value }); }
export function removeStored(key: string) {
  if (!bootstrapped) { storageFull(key); return; }
  values.delete(key);
  removed.add(key);
  changed(key);
  void enqueue({ [key]: null }).catch(() => {});
}
export async function removeStoredAsync(key: string): Promise<void> {
  requireReady();
  changed(key);
  const version = revisions.get(key);
  await enqueue({ [key]: null });
  if (revisions.get(key) !== version) return;
  values.delete(key);
  removed.add(key);
}
export function readJson(key: string): unknown {
  try { const value = storageRaw(key); return value ? JSON.parse(value) : undefined; } catch { return undefined; }
}
export function storageRaw(key: string) { return removed.has(key) ? undefined : values.get(key) ?? customAdapter?.get?.(key); }
export function storageValue(key: string) { return storageRaw(key); }
/** Updates the in-memory current-game slot after loading the separate native checkpoint. */
export function cacheStored(key: string, value: string) { requireReady(); values.set(key, value); removed.delete(key); changed(key); }
export async function flushStorage() {
  await writeChain;
  requireReady();
  if (failures.size) throw new AggregateError([...failures.values()], '部分本机数据未能保存');
}
export const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
