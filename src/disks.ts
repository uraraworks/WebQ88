// disks.ts
//
// フロッピードライブ2台のUIと永続化。メインスレッド側の「持ち主」。
// コア側の操作は CoreProxy.diskRequest(public/disk-host.js)へ転送するだけで、
// D88 の妥当性の判定は起動時のコアの応答に任せる。
//
// 永続化の方針(姉妹アプリ WebNP2 / WebX68k に合わせる):
//   - ゲストの書き込みは平常時の「周期ポーリング」で検出して保存する
//     (本体)。ワーカーの MEMFS 上のイメージの mtime/size が変わったら dirty にし、
//     最後の変化とアクセスランプ消灯から少し待って(書き込みの途中を吸い出さない)保存する。
//   - visibilitychange(hidden)・pagehide・排出・ROM再起動/リセットの前にも保存する
//     (保険。離脱時イベントだけに頼らない)。
//   - ドライブの割り当て(どの sourceKey がどのドライブか)も保存し、起動時に
//     自動挿入する(ライブラリ一覧UIが無いため。画面にその旨を出す)。
//   - API(insert_disk 等)でワーカーに直接入れられたディスクは、IndexedDB には
//     保存しない(sourceKey を持たない一時的なディスク。画面には表示する)。

import { registerSource, originalBytes } from './disk-source';
import type { CoreProxy } from './core-proxy';
import type { DiskPollEntry, DiskResult } from './core-protocol';
import {
  deleteDisk,
  fileSourceKey,
  getAssignment,
  getDisk,
  newBlankSourceKey,
  putAssignment,
  putDisk,
  putDiskPreservingMeta,
  rememberDiskImage,
} from './disk-store';

const POLL_INTERVAL_MS = 1000;
/** 最後の書き込み検出から保存まで待つ時間。 */
const QUIET_AFTER_CHANGE_MS = 2500;
/** アクセスランプ消灯から保存まで待つ時間。 */
const QUIET_AFTER_LAMP_MS = 1500;

interface Slot {
  key: string | null;
  name: string | null;
  gen: number;
  image: number;
  imageCount: number;
  seenMtime: number;
  seenSize: number;
  dirty: boolean;
  lastChangeAt: number;
}

function emptySlot(): Slot {
  return { key: null, name: null, gen: -1, image: 0, imageCount: 0, seenMtime: 0, seenSize: 0, dirty: false, lastChangeAt: 0 };
}

interface Row {
  lamp: HTMLElement;
  label: HTMLElement;
  fileName: HTMLElement;
  imageSelect: HTMLSelectElement;
  insertBtn: HTMLButtonElement;
  ejectBtn: HTMLButtonElement;
  blankBtn: HTMLButtonElement | null;
  downloadBtn: HTMLButtonElement;
  fileInput: HTMLInputElement;
  root: HTMLElement;
}

export interface DiskPanelOptions {
  /** 同梱の空データディスク(BLANK2D.D88)。無ければ「ブランクFDを作成」を無効にする。 */
  blankImage: Uint8Array | null;
}

export class DiskPanel {
  private slots: [Slot, Slot] = [emptySlot(), emptySlot()];
  private rows: Row[] = [];
  private msgEl: HTMLElement;
  /** 操作中は poll による外部変更の判定をしない(挿入の途中で gen がずれて見えるため)。 */
  private opDepth = 0;
  private operations: Promise<void> = Promise.resolve();
  private coreReady = false;
  private staged: [ArrayBuffer | null, ArrayBuffer | null] = [null, null];
  private stagedPrevious: [boolean, boolean] = [false, false];
  private lastLampOnAt = 0;
  private lampMask = 0;
  private persisting: [Promise<void>, Promise<void>] = [Promise.resolve(), Promise.resolve()];
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private proxy: CoreProxy,
    private container: HTMLElement,
    private opts: DiskPanelOptions,
  ) {
    this.msgEl = container.querySelector<HTMLElement>('#disk-msg')!;
    for (let d = 0; d < 2; d++) {
      this.rows.push(this.buildRow(d));
    }
    this.render();
    void this.withOp(async () => {
      try {
        const assignment = await getAssignment();
        for (let d = 0; d < 2; d++) {
          const key = assignment?.keys[d];
          if (!key) continue;
          const disk = await getDisk(key);
          if (!disk) continue;
          const res = await this.diskRequest('insert', d, { bytes: disk.bytes.slice().buffer, image: assignment?.images?.[d] ?? 0 });
          if (!res.ok) continue;
          this.adopt(d, key, disk.name, res);
          this.stagedPrevious[d] = true;
        }
      } catch {
        // 保存された割り当てを読めなくても操作は続ける。
      }
      this.render();
    });
    window.setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flushAll();
    });
    window.addEventListener('pagehide', () => void this.flushAll());
  }

  private buildRow(d: number): Row {
    const root = this.container.querySelector<HTMLElement>(`[data-drive="${d}"]`)!;
    const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
    const row: Row = {
      root,
      lamp: q('.drive-lamp'),
      label: q('.drive-label'),
      fileName: q('.drive-file'),
      imageSelect: q<HTMLSelectElement>('.drive-image'),
      insertBtn: q<HTMLButtonElement>('.drive-insert'),
      ejectBtn: q<HTMLButtonElement>('.drive-eject'),
      blankBtn: root.querySelector<HTMLButtonElement>('.drive-blank'),
      downloadBtn: q<HTMLButtonElement>('.drive-download'),
      fileInput: q<HTMLInputElement>('.drive-file-input'),
    };
    if (row.blankBtn) row.blankBtn.disabled = !this.opts.blankImage;
    row.insertBtn.addEventListener('click', () => row.fileInput.click());
    row.fileInput.addEventListener('change', () => {
      const f = row.fileInput.files?.[0];
      row.fileInput.value = '';
      if (f) void this.insertFile(d, f);
    });
    row.imageSelect.addEventListener('change', () => void this.selectImage(d, Number(row.imageSelect.value)));
    row.ejectBtn.addEventListener('click', () => void this.eject(d));
    row.blankBtn?.addEventListener('click', () => void this.createBlank(d));
    row.downloadBtn.addEventListener('click', () => void this.download(d));
    root.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer?.types.includes('Files')) {
        ev.preventDefault();
        root.classList.add('drag-over');
      }
    });
    root.addEventListener('dragleave', () => root.classList.remove('drag-over'));
    root.addEventListener('drop', (ev) => {
      ev.preventDefault();
      root.classList.remove('drag-over');
      const f = ev.dataTransfer?.files?.[0];
      if (f) void this.insertFile(d, f);
    });
    return row;
  }

  private setMessage(text: string): void {
    this.msgEl.textContent = text;
  }

  private render(): void {
    for (let d = 0; d < 2; d++) {
      const slot = this.slots[d];
      const row = this.rows[d];
      row.fileName.textContent = slot.name ?? '(空)';
      row.fileName.title = slot.key === null && slot.name !== null ? 'API から挿入されたディスク(ブラウザ保存の対象外)' : '';
      row.imageSelect.hidden = slot.imageCount < 2;
      row.imageSelect.replaceChildren(...Array.from({ length: slot.imageCount }, (_, i) => {
        const option = document.createElement('option');
        option.value = String(i); option.textContent = `${i + 1}/${slot.imageCount}`;
        return option;
      }));
      row.imageSelect.value = String(slot.image);
      row.ejectBtn.disabled = slot.name === null;
      row.downloadBtn.disabled = slot.name === null;
      row.lamp.classList.toggle('on', (this.lampMask & (1 << d)) !== 0);
    }
  }

  /** frame メッセージのランプ情報を反映する(main.ts の onFrame から呼ぶ)。 */
  setLamp(mask: number): void {
    if (mask !== 0) this.lastLampOnAt = performance.now();
    if (mask === this.lampMask) return;
    this.lampMask = mask;
    for (let d = 0; d < 2; d++) {
      this.rows[d].lamp.classList.toggle('on', (mask & (1 << d)) !== 0);
    }
  }

  // ---- 操作 ----

  private async withOp<T>(fn: () => Promise<T>): Promise<T> {
    this.opDepth++;
    const operation = this.operations.then(fn, fn);
    this.operations = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      this.opDepth--;
    }
  }

  private diskRequest(op: 'insert' | 'eject' | 'dump' | 'poll', d?: number, extra: { name?: string; bytes?: ArrayBuffer; image?: number; key?: string } = {}): Promise<DiskResult> {
    if (this.coreReady) return this.proxy.diskRequest(op, d, extra);
    if (op === 'poll') return Promise.resolve({ ok: true });
    const drive = d!;
    if (op === 'insert') {
      if (!extra.bytes || extra.bytes.byteLength < 0x2b0) return Promise.resolve({ ok: false, error: 'ディスクイメージが小さすぎます' });
      this.staged[drive] = extra.bytes;
      this.stagedPrevious[drive] = false;
      const view = new DataView(extra.bytes);
      let offset = 0, count = 0;
      while (offset + 0x2b0 <= view.byteLength) {
        const size = view.getUint32(offset + 0x1c, true);
        if (size < 0x2b0 || offset + size > view.byteLength) break;
        count++;
        offset += size;
      }
      return Promise.resolve({ ok: true, size: extra.bytes.byteLength, image: extra.image ?? 0, imageCount: count });
    }
    if (op === 'eject') {
      this.staged[drive] = null;
      this.stagedPrevious[drive] = false;
      return Promise.resolve({ ok: true });
    }
    const bytes = this.staged[drive];
    return Promise.resolve(bytes ? { ok: true, bytes: bytes.slice(0) } : { ok: false, error: 'ドライブは空です' });
  }


  private persist(d: number): Promise<boolean> {
    let result = false;
    const run = async (): Promise<void> => {
      const slot = this.slots[d];
      if (slot.key === null || slot.name === null) return;
      // dirty は吸い出しの「前」に落とす(吸い出し中の書き込みまで消さないため)
      slot.dirty = false;
      const res = await this.diskRequest('dump', d);
      if (!res.ok || !res.bytes) {
        slot.dirty = true;
        return;
      }
      try {
        await putDiskPreservingMeta({
          sourceKey: slot.key,
          name: slot.name,
          bytes: new Uint8Array(res.bytes),
          savedAt: Date.now(),
        });
        result = true;
      } catch (err) {
        slot.dirty = true;
        this.setMessage(`ブラウザ保存に失敗しました: ${(err as Error).message}。ダウンロードで退避してください`);
      }
    };
    const next = this.persistenceQueue.then(run, run);
    this.persistenceQueue = next.then(() => undefined, () => undefined);
    this.persisting[d] = next.then(
      () => undefined,
      () => undefined,
    );
    return next.then(() => result);
  }

  private async writeAssignment(): Promise<void> {
    try {
      await putAssignment({ keys: [this.slots[0].key, this.slots[1].key], images: [this.slots[0].image, this.slots[1].image] });
    } catch {
      // 保存できなくても動作は続ける(ブラウザ保存はそもそも消えることがある)
    }
  }

  /** ワーカーから見たドライブの状態を slot へ写す(挿入直後)。 */
  private adopt(d: number, key: string | null, name: string, ins: { gen?: number; size?: number; mtime?: number; image?: number; imageCount?: number }): void {
    this.slots[d] = {
      key,
      name,
      gen: ins.gen ?? -1,
      image: ins.image ?? 0,
      imageCount: ins.imageCount ?? 0,
      // 挿入直後の mtime/size を基準にする(挿入そのものを書き込み扱いしない)
      seenMtime: ins.mtime ?? 0,
      seenSize: ins.size ?? 0,
      dirty: false,
      lastChangeAt: 0,
    };
  }

  /** ファイルを挿入する。同じキーの保存があればそちらを読む(前回の続き)。 */
  async insertFile(d: number, file: File): Promise<void> {
    if (/\.(zip|lzh)$/i.test(file.name)) {
      try {
        const disks = await registerSource(file.name, new Uint8Array(await file.arrayBuffer()), `archive:${file.name}:${file.size}`);
        await this.insertStored(d, disks[0].sourceKey);
        this.setMessage(`${disks.length}枚をライブラリに登録しました`);
      } catch (err) { this.setMessage(`展開に失敗しました: ${(err as Error).message}`); }
      return;
    }
    await this.withOp(async () => {
      try {
        const key = fileSourceKey(file.name, file.size);
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        await this.persist(d); // 差し替え前の中身を保存
        const other = 1 - d;
        if (this.slots[other].key === key && this.slots[other].imageCount < 2) {
          await this.persist(other);
          const ejected = await this.diskRequest('eject', other);
          if (!ejected.ok) throw new Error('ドライブを排出できませんでした');
          this.slots[other] = emptySlot();
          this.render();
          await this.writeAssignment();
        }
        let stored: Awaited<ReturnType<typeof getDisk>>;
        try {
          stored = await getDisk(key);
        } catch {
          stored = undefined;
        }
        const useBytes = stored ? stored.bytes : fileBytes;
        const res = await this.diskRequest('insert', d, { name: file.name, bytes: useBytes.slice().buffer, key, image: this.slots[other].key === key ? (this.slots[other].image === 0 ? 1 : 0) : 0 });
        if (!res.ok) {
          this.slots[d] = emptySlot();
          this.render();
          this.setMessage(`挿入できませんでした(${file.name}): ${res.error}`);
          return;
        }
        this.adopt(d, key, file.name, res);
        if (!stored) {
          try {
            await putDisk({ sourceKey: key, name: file.name, bytes: fileBytes, savedAt: Date.now() });
          } catch (err) {
            this.setMessage(`挿入しましたが、ブラウザ保存に失敗しました: ${(err as Error).message}`);
            this.render();
            await this.writeAssignment();
            return;
          }
        }
        this.setMessage(
          stored
            ? `ドライブ${d + 1}に「${file.name}」を挿入しました(ブラウザに保存された前回の続きを読み込みました)`
            : `ドライブ${d + 1}に「${file.name}」を挿入しました`,
        );
        this.render();
        await this.writeAssignment();
      } catch (err) {
        this.setMessage(`挿入に失敗しました: ${(err as Error).message}`);
      }
    });
  }

  /** ライブラリの保存済みイメージを挿入する。 */
  async insertStored(d: number, key: string): Promise<void> {
    await this.withOp(async () => {
      try {
        await this.persist(d);
        // 同一イメージを両ドライブで別々に書き戻さない。
        const other = 1 - d;
        if (this.slots[other].key === key && this.slots[other].imageCount < 2) {
          await this.persist(other);
          const ejected = await this.diskRequest('eject', other);
          if (!ejected.ok) throw new Error('ドライブを排出できませんでした');
          this.slots[other] = emptySlot();
          await this.writeAssignment();
        }
        const disk = await getDisk(key);
        if (!disk) throw new Error('ディスクが見つかりません');
        const res = await this.diskRequest('insert', d, { name: disk.name, bytes: disk.bytes.slice().buffer, key, image: this.slots[other].key === key && (disk.lastImages?.[d] ?? 0) === this.slots[other].image ? (this.slots[other].image === 0 ? 1 : 0) : (disk.lastImages?.[d] ?? 0) });
        if (!res.ok) throw new Error('ディスクを挿入できませんでした');
        this.adopt(d, key, disk.name, res);
        this.render();
        await this.writeAssignment();
        this.setMessage(`ドライブ${d + 1}に挿入しました`);
      } catch { this.render(); this.setMessage('ライブラリから挿入できませんでした'); }
    });
  }

  private async selectImage(d: number, image: number): Promise<void> {
    await this.withOp(async () => {
      const slot = this.slots[d];
      if (!slot.name || image === slot.image) return;
      const other = 1 - d;
      let ejectedOther = false;
      if (slot.key && this.slots[other].key === slot.key && this.slots[other].image === image) {
        await this.persist(other);
        const ejected = await this.diskRequest('eject', other);
        if (!ejected.ok) { this.render(); this.setMessage(`排出できませんでした: ${ejected.error}`); return; }
        this.slots[other] = emptySlot();
        ejectedOther = true;
      }
      await this.persist(d);
      const dump = await this.diskRequest('dump', d);
      if (!dump.ok || !dump.bytes) {
        this.render();
        if (ejectedOther) await this.writeAssignment();
        this.setMessage(ejectedOther ? `ドライブ${other + 1}を取り出しましたが、切り替えに失敗しました` : '切り替えに失敗しました');
        return;
      }
      const res = await this.diskRequest('insert', d, { name: slot.name, bytes: dump.bytes, key: slot.key ?? undefined, image });
      if (res.ok) {
        this.adopt(d, slot.key, slot.name, res);
        if (slot.key) await rememberDiskImage(slot.key, d, image).catch(() => {});
        if (ejectedOther) this.setMessage(`ドライブ${other + 1}の同じディスクを取り出して、ドライブ${d + 1}を${image + 1}枚目に切り替えました`);
      }
      else { this.slots[d] = emptySlot(); this.setMessage(`切り替えに失敗しました: ${res.error}`); }
      this.render();
      await this.writeAssignment();
    });
  }

  showMessage(message: string): void { this.setMessage(message); }

  async resetStored(key: string): Promise<void> {
    const disk = await getDisk(key);
    if (!disk?.url) throw new Error('配布元URLがありません');
    const bytes = await originalBytes(disk, message => this.setMessage(message));
    await this.withOp(async () => {
      for (let d = 0; d < 2; d++) {
        if (this.slots[d].key !== key) continue;
        await this.persisting[d];
        const res = await this.diskRequest('eject', d);
        if (!res.ok) throw new Error('ドライブを排出できませんでした');
        this.slots[d] = emptySlot();
      }
      await putDisk({ ...disk, bytes, savedAt: Date.now() });
      this.render(); await this.writeAssignment();
      this.setMessage('配布元の状態に戻しました');
    });
  }

  async shareUrl(): Promise<void> {
    const url = new URL(location.href); url.search = ''; url.hash = '';
    let count = 0;
    for (let d = 0; d < 2; d++) {
      const key = this.slots[d].key; const disk = key ? await getDisk(key) : undefined;
      if (disk?.url) { url.searchParams.set(`fd${d + 1}`, disk.url); count++; }
    }
    if (!count) throw new Error('URL由来のディスクが挿入されていません');
    await navigator.clipboard.writeText(url.href);
    this.setMessage('共有URLをコピーしました');
  }

  async deleteStored(key: string): Promise<void> {
    await this.withOp(async () => {
      for (let d = 0; d < 2; d++) {
        if (this.slots[d].key !== key) continue;
        await this.persist(d);
        const res = await this.diskRequest('eject', d);
        if (!res.ok) throw new Error('ドライブを排出できませんでした');
        this.slots[d] = emptySlot();
        this.render();
        await this.writeAssignment();
      }
      await deleteDisk(key);
    });
  }

  async eject(d: number): Promise<void> {
    await this.withOp(async () => {
      await this.persist(d);
      const res = await this.diskRequest('eject', d);
      if (!res.ok) {
        this.setMessage(`排出できませんでした: ${res.error}`);
        return;
      }
      this.slots[d] = emptySlot();
      this.render();
      this.setMessage(`ドライブ${d + 1}を排出しました`);
      await this.writeAssignment();
    });
  }

  async createBlank(d: number): Promise<void> {
    const blank = this.opts.blankImage;
    if (!blank) {
      this.setMessage('ブランクFDの元になる同梱イメージを読み込めていません');
      return;
    }
    await this.withOp(async () => {
      await this.persist(d);
      const key = newBlankSourceKey();
      const stamp = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `BLANK-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.d88`;
      const res = await this.diskRequest('insert', d, { name, bytes: blank.slice().buffer });
      if (!res.ok) {
        this.slots[d] = emptySlot();
        this.render();
        this.setMessage(`ブランクFDを挿入できませんでした: ${res.error}`);
        return;
      }
      this.adopt(d, key, name, res);
      let saved = true;
      try {
        await putDisk({
          sourceKey: key,
          name,
          bytes: blank.slice(),
          savedAt: Date.now(),
          displayName: `ブランクFD ${stamp.toLocaleString()}`,
        });
      } catch (err) {
        saved = false;
        this.setMessage(`ブランクFDを挿入しましたが、ブラウザ保存に失敗しました: ${(err as Error).message}`);
      }
      if (saved) this.setMessage(`ドライブ${d + 1}にブランクFD「${name}」を作成して挿入しました`);
      this.render();
      await this.writeAssignment();
    });
  }

  async download(d: number): Promise<void> {
    const slot = this.slots[d];
    if (slot.name === null) return;
    const res = await this.diskRequest('dump', d);
    if (!res.ok || !res.bytes) {
      this.setMessage(`ダウンロードできませんでした: ${res.error ?? '不明なエラー'}`);
      return;
    }
    const name = /\.(d88|88d)$/i.test(slot.name) ? slot.name : `${slot.name}.d88`;
    const blob = new Blob([res.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.setMessage(`「${name}」をダウンロードしました`);
  }

  // ---- 周期ポーリングと保存 ----

  /** ワーカーの状態を取り込み、書き込みの検出と(静かになっていれば)保存を行う。 */
  async pollOnce(): Promise<void> {
    if (!this.coreReady || this.opDepth > 0) return;
    const res = await this.diskRequest('poll');
    if (!res.ok || !res.drives || this.opDepth > 0) return;
    const now = performance.now();
    let assignmentChanged = false;
    for (let d = 0; d < 2; d++) {
      const e: DiskPollEntry = res.drives[d];
      const slot = this.slots[d];
      if (!e.present) {
        if (slot.name !== null) {
          this.slots[d] = emptySlot(); // API の eject_disk など、UI を通さずに空になった
          assignmentChanged = true;
        }
        continue;
      }
      if (e.gen !== slot.gen) {
        // UI を通さずに入った(API の insert_disk)。sourceKey を持たない一時的なディスク扱い。
        this.slots[d] = { ...emptySlot(), name: e.name ?? '(不明)', gen: e.gen ?? -1, image: e.image ?? 0, imageCount: e.imageCount ?? 0, seenMtime: e.mtime ?? 0, seenSize: e.size ?? 0 };
        assignmentChanged = true;
        continue;
      }
      if (e.mtime !== slot.seenMtime || e.size !== slot.seenSize) {
        slot.seenMtime = e.mtime ?? 0;
        slot.seenSize = e.size ?? 0;
        slot.dirty = true;
        slot.lastChangeAt = now;
      }
    }
    this.render();
    if (assignmentChanged) void this.writeAssignment();
    const lampQuiet = this.lampMask === 0 && now - this.lastLampOnAt >= QUIET_AFTER_LAMP_MS;
    for (let d = 0; d < 2; d++) {
      const slot = this.slots[d];
      if (slot.dirty && slot.key !== null && lampQuiet && now - slot.lastChangeAt >= QUIET_AFTER_CHANGE_MS) {
        void this.persist(d);
      }
    }
  }

  /**
   * 変更のあるドライブを今すぐ保存する(隠れる・離脱・ROM再起動/リセットの前の保険)。
   * 直前に poll して、まだ周期で検出していない書き込みも拾う。
   */
  async flushAll(): Promise<void> {
    if (!this.coreReady) return;
    if (this.opDepth === 0) {
      const res = await this.diskRequest('poll');
      if (res.ok && res.drives) {
        for (let d = 0; d < 2; d++) {
          const e = res.drives[d];
          const slot = this.slots[d];
          if (e.present && e.gen === slot.gen && (e.mtime !== slot.seenMtime || e.size !== slot.seenSize)) {
            slot.seenMtime = e.mtime ?? 0;
            slot.seenSize = e.size ?? 0;
            slot.dirty = true;
          }
        }
      }
    }
    await Promise.all([0, 1].map((d) => (this.slots[d].dirty && this.slots[d].key !== null ? this.persist(d) : Promise.resolve(false))));
  }

  // ---- 起動時の復元 ----

  /** 前回のドライブ割り当てを自動挿入する。挿入したドライブ番号(0/1)の配列を返す。 */
  async restore(): Promise<number[]> {
    const restored: number[] = [];
    await this.withOp(async () => {
      this.coreReady = true;
      const attempted: number[] = [];
      const previous: number[] = [];
      for (let d = 0; d < 2; d++) {
        const bytes = this.staged[d];
        const slot = this.slots[d];
        if (!bytes || !slot.name) continue;
        attempted.push(d);
        if (this.stagedPrevious[d]) previous.push(d);
        const res = await this.diskRequest('insert', d, { name: slot.name, bytes, key: slot.key ?? undefined, image: slot.image });
        this.staged[d] = null;
        this.stagedPrevious[d] = false;
        if (res.ok) {
          this.adopt(d, slot.key, slot.name, res);
          restored.push(d);
        } else {
          this.slots[d] = emptySlot();
          this.setMessage(`挿入できませんでした(${slot.name}): ${res.error}`);
        }
      }
      this.render();
      if (attempted.length !== restored.length) await this.writeAssignment();
      if (restored.length > 0) {
        this.setMessage(
          `${restored.every((d) => previous.includes(d)) ? '前回のディスクを自動で挿入しました' : restored.every((d) => !previous.includes(d)) ? '起動前に入れたディスクを挿入しました' : 'ディスクを挿入しました'}: ${restored.map((d) => `ドライブ${d + 1} 「${this.slots[d].name}」`).join('、')}`,
        );
      }
    });
    return restored;
  }
}
