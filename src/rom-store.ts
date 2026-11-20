// 利用者ROMをブラウザに保存する。
import type { RomFile } from './core-protocol';

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('webq88-roms', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('roms', { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('保存領域を開けませんでした'));
    req.onblocked = () => reject(new Error('保存領域がブロックされています'));
  });
  p.catch(() => { dbPromise = null; });
  dbPromise = p;
  return p;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました'));
  });
}

export async function saveRoms(roms: RomFile[]): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction('roms', 'readwrite');
    const done = txDone(tx);
    const store = tx.objectStore('roms');
    store.clear();
    for (const rom of roms) store.put(rom);
    await done;
  } catch {
    console.warn('ROMを保存できませんでした');
  }
}

export async function loadRoms(): Promise<RomFile[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('roms', 'readonly').objectStore('roms').getAll();
    req.onsuccess = () => resolve(req.result as RomFile[]);
    req.onerror = () => reject(req.error ?? new Error('ROMを読み込めませんでした'));
  });
}

export async function clearRoms(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('roms', 'readwrite');
  tx.objectStore('roms').clear();
  await txDone(tx);
}

export async function listRomNames(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('roms', 'readonly').objectStore('roms').getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error ?? new Error('ROM一覧を取得できませんでした'));
  });
}
