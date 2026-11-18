// disk-store.ts
//
// ディスクイメージを IndexedDB に永続化する「ディスクライブラリ」。
// 姉妹アプリ WebNP2 (src/storage/db.ts) / WebX68k (src/disk-store.ts) の流儀に合わせる。
//
// DB名は `webq88-` 接頭辞必須(GitHub Pages では WebNP2 / WebX68k 等と同一 origin のため。
// ../CLAUDE.md「ブラウザ保存領域」)。
//
// ストア:
//   disks … イメージ本体。キーは sourceKey。ファイルなら `file:名前:サイズ`、
//           ブランクFDは一意な `blank:...`。
//   meta  … ドライブの割り当て(どのドライブにどの sourceKey が入っているか)。
//           WebNP2/WebX68k は持たないが、このアプリにはライブラリ一覧UIが無く、
//           リロード後にブランクFDへ戻る手段が他に無いので保存する
//           (起動時に自動挿入し、その旨を画面に出す。disks.ts)。

export interface StoredDisk {
  sourceKey: string;
  /** 元のファイル名(拡張子含む)。ダウンロード時のファイル名に使う。 */
  name: string;
  bytes: Uint8Array;
  savedAt: number;
  /** 一覧用の表示名。再保存で上書きしない(putDiskPreservingMeta)。 */
  displayName?: string;
  url?: string;
  archiveEntry?: string;
  sourceOrder?: number;
  lastImages?: [number, number];
  folderId?: string;
}

export interface DiskFolder { id: string; name: string }

export interface DriveAssignment {
  /** 添字0=ドライブ1, 1=ドライブ2。空なら null。 */
  keys: [string | null, string | null];
  images?: [number, number];
}

const DB_NAME = 'webq88-disks';
const DB_VERSION = 1;
const STORE_DISKS = 'disks';
const STORE_META = 'meta';
const META_DRIVES_ID = 'drives';
const META_FOLDERS_ID = 'folders';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DISKS)) {
        db.createObjectStore(STORE_DISKS, { keyPath: 'sourceKey' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'));
    req.onblocked = () => reject(new Error('IndexedDB がブロックされています'));
  });
  // 失敗したら次回やり直せるようにキャッシュしない
  p.catch(() => {
    dbPromise = null;
  });
  dbPromise = p;
  return p;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB の読み出しに失敗しました'));
  });
}

/** トランザクションの完了(oncomplete)を待つ。onerror ではなく oncomplete/onabort で決める。 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB への書き込みが中断されました'));
  });
}

export async function getDisk(sourceKey: string): Promise<StoredDisk | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_DISKS, 'readonly');
  const r = await reqToPromise(tx.objectStore(STORE_DISKS).get(sourceKey));
  return (r as StoredDisk | undefined) ?? undefined;
}

export async function putDisk(disk: StoredDisk): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DISKS, 'readwrite');
  tx.objectStore(STORE_DISKS).put(disk);
  await txDone(tx);
}

/**
 * イメージ本体を書き戻す。表示名は既存レコードのものを常に優先する
 * (put は全置換なので、再保存でユーザーが付けた名前が消えるのを防ぐ)。
 * 読み出しと書き込みを同じ readwrite トランザクション内で行い、間に別の書き込みが
 * 割り込んで表示名を巻き戻すことがないようにする。
 */
export async function putDiskPreservingMeta(disk: StoredDisk): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DISKS, 'readwrite');
  const store = tx.objectStore(STORE_DISKS);
  const done = txDone(tx);
  const existing = (await reqToPromise(store.get(disk.sourceKey))) as StoredDisk | undefined;
  store.put({ ...existing, ...disk, displayName: existing?.displayName ?? disk.displayName, folderId: existing ? existing.folderId : disk.folderId });
  await done;
}

export async function getAssignment(): Promise<DriveAssignment | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  const r = (await reqToPromise(tx.objectStore(STORE_META).get(META_DRIVES_ID))) as
    | ({ id: string } & DriveAssignment)
    | undefined;
  return r ? { keys: r.keys, images: r.images } : undefined;
}

export async function putAssignment(a: DriveAssignment): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ id: META_DRIVES_ID, keys: a.keys, images: a.images });
  await txDone(tx);
}

/** ファイルから作る sourceKey。 */
export function fileSourceKey(name: string, size: number): string {
  return `file:${name}:${size}`;
}

/** ブランクFD用の一意な sourceKey。 */
export function newBlankSourceKey(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `blank:${Date.now().toString(36)}-${rand}`;
}

export async function listDisks(): Promise<StoredDisk[]> {
  const db = await openDb();
  return reqToPromise(db.transaction(STORE_DISKS, 'readonly').objectStore(STORE_DISKS).getAll());
}

export async function listFolders(): Promise<DiskFolder[]> {
  const db = await openDb();
  const record = await reqToPromise(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(META_FOLDERS_ID)) as { folders: DiskFolder[] } | undefined;
  return record?.folders ?? [];
}

export async function createFolder(name: string): Promise<DiskFolder> {
  const folder = { id: `webq88-folder-${crypto.randomUUID()}`, name: name.trim() };
  if (!folder.name) throw new Error('フォルダ名を入力してください');
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore(STORE_META);
  const record = await reqToPromise(store.get(META_FOLDERS_ID)) as { folders: DiskFolder[] } | undefined;
  store.put({ id: META_FOLDERS_ID, folders: [...(record?.folders ?? []), folder] });
  await done;
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  name = name.trim();
  if (!name) throw new Error('フォルダ名を入力してください');
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore(STORE_META);
  const record = await reqToPromise(store.get(META_FOLDERS_ID)) as { folders: DiskFolder[] } | undefined;
  store.put({ id: META_FOLDERS_ID, folders: (record?.folders ?? []).map(f => f.id === id ? { ...f, name } : f) });
  await done;
}

export async function deleteFolder(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_META, STORE_DISKS], 'readwrite');
  const done = txDone(tx);
  const meta = tx.objectStore(STORE_META);
  const disks = tx.objectStore(STORE_DISKS);
  const [record, all] = await Promise.all([reqToPromise(meta.get(META_FOLDERS_ID)) as Promise<{ folders: DiskFolder[] } | undefined>, reqToPromise(disks.getAll()) as Promise<StoredDisk[]>]);
  meta.put({ id: META_FOLDERS_ID, folders: (record?.folders ?? []).filter(f => f.id !== id) });
  for (const disk of all) if (disk.folderId === id) { delete disk.folderId; disks.put(disk); }
  await done;
}

export async function moveDisk(key: string, folderId?: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_META, STORE_DISKS], 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore(STORE_DISKS);
  const [disk, record] = await Promise.all([reqToPromise(store.get(key)) as Promise<StoredDisk | undefined>, reqToPromise(tx.objectStore(STORE_META).get(META_FOLDERS_ID)) as Promise<{ folders: DiskFolder[] } | undefined>]);
  if (folderId && !record?.folders.some(f => f.id === folderId)) { await done; throw new Error('フォルダが見つかりません'); }
  if (disk) store.put({ ...disk, folderId });
  await done;
}

export async function renameDisk(key: string, displayName: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DISKS, 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore(STORE_DISKS);
  const disk = await reqToPromise(store.get(key)) as StoredDisk | undefined;
  if (disk) store.put({ ...disk, displayName: displayName.trim() || undefined });
  await done;
}

export async function deleteDisk(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DISKS, 'readwrite');
  tx.objectStore(STORE_DISKS).delete(key);
  await txDone(tx);
}

/** ディスクごと・ドライブごとの前回の選択を保持する。 */
export async function rememberDiskImage(key: string, drive: number, image: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DISKS, 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore(STORE_DISKS);
  const disk = (await reqToPromise(store.get(key))) as StoredDisk | undefined;
  if (disk) {
    const images: [number, number] = disk.lastImages ? [...disk.lastImages] : [0, 0];
    images[drive] = image;
    store.put({ ...disk, lastImages: images });
  }
  await done;
}
