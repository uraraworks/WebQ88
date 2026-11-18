// ステートをスロットごとにブラウザへ保存する。
import type { StateInfo } from './core-protocol';

export interface StoredState {
  key: string;
  savedAt: number;
  info: StateInfo;
  bytes: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('webq88-states', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('states', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('保存領域を開けませんでした'));
    req.onblocked = () => reject(new Error('保存領域がブロックされています'));
  });
  p.catch(() => { dbPromise = null; });
  dbPromise = p;
  return p;
}

export async function getState(slot: number): Promise<StoredState | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('states', 'readonly').objectStore('states').get(`webq88-slot-${slot}`);
    req.onsuccess = () => resolve(req.result as StoredState | undefined);
    req.onerror = () => reject(req.error ?? new Error('読込に失敗しました'));
  });
}

export async function putState(slot: number, state: Omit<StoredState, 'key'>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('states', 'readwrite');
  tx.objectStore('states').put({ ...state, key: `webq88-slot-${slot}` });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました'));
  });
}

/** 保存済みUIスロットのメタデータを取得する。 */
export async function listStates(): Promise<StoredState[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('states', 'readonly').objectStore('states').getAll();
    req.onsuccess = () => resolve(req.result as StoredState[]);
    req.onerror = () => reject(req.error ?? new Error('一覧を取得できませんでした'));
  });
}
