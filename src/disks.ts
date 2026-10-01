// disks.ts
//
// フロッピードライブ2台のUIと永続化。メインスレッド側の「持ち主」。
// コア側の操作は CoreProxy.diskRequest(public/disk-host.js)へ転送するだけで、
// ここには D88 の知識を持たない(妥当性の判定は挿入時のコアの応答に任せる)。
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

import type { CoreProxy } from './core-proxy';
import type { DiskPollEntry } from './core-protocol';
import {
  fileSourceKey,
  getAssignment,
  getDisk,
  newBlankSourceKey,
  putAssignment,
  putDisk,
  putDiskPreservingMeta,
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
  seenMtime: number;
  seenSize: number;
  dirty: boolean;
  lastChangeAt: number;
}

function emptySlot(): Slot {
  return { key: null, name: null, gen: -1, seenMtime: 0, seenSize: 0, dirty: false, lastChangeAt: 0 };
}

interface Row {
  lamp: HTMLElement;
  label: HTMLElement;
  fileName: HTMLElement;
  insertBtn: HTMLButtonElement;
  ejectBtn: HTMLButtonElement;
  blankBtn: HTMLButtonElement;
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
  private lastLampOnAt = 0;
  private lampMask = 0;
  private persisting: [Promise<void>, Promise<void>] = [Promise.resolve(), Promise.resolve()];

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
      insertBtn: q<HTMLButtonElement>('.drive-insert'),
      ejectBtn: q<HTMLButtonElement>('.drive-eject'),
      blankBtn: q<HTMLButtonElement>('.drive-blank'),
      downloadBtn: q<HTMLButtonElement>('.drive-download'),
      fileInput: q<HTMLInputElement>('.drive-file-input'),
    };
    row.blankBtn.disabled = !this.opts.blankImage;
    row.insertBtn.addEventListener('click', () => row.fileInput.click());
    row.fileInput.addEventListener('change', () => {
      const f = row.fileInput.files?.[0];
      row.fileInput.value = '';
      if (f) void this.insertFile(d, f);
    });
    row.ejectBtn.addEventListener('click', () => void this.eject(d));
    row.blankBtn.addEventListener('click', () => void this.createBlank(d));
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
    try {
      return await fn();
    } finally {
      this.opDepth--;
    }
  }

  /** 現在のドライブの内容を保存(ドライブごとに直列化)。保存できたら true。 */
  private persist(d: number): Promise<boolean> {
    let result = false;
    const run = async (): Promise<void> => {
      const slot = this.slots[d];
      if (slot.key === null || slot.name === null) return;
      // dirty は吸い出しの「前」に落とす(吸い出し中の書き込みまで消さないため)
      slot.dirty = false;
      const res = await this.proxy.diskRequest('dump', d);
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
    const next = this.persisting[d].then(run, run);
    this.persisting[d] = next.then(
      () => undefined,
      () => undefined,
    );
    return next.then(() => result);
  }

  private async writeAssignment(): Promise<void> {
    try {
      await putAssignment({ keys: [this.slots[0].key, this.slots[1].key] });
    } catch {
      // 保存できなくても動作は続ける(ブラウザ保存はそもそも消えることがある)
    }
  }

  /** ワーカーから見たドライブの状態を slot へ写す(挿入直後)。 */
  private adopt(d: number, key: string | null, name: string, ins: { gen?: number; size?: number; mtime?: number }): void {
    this.slots[d] = {
      key,
      name,
      gen: ins.gen ?? -1,
      // 挿入直後の mtime/size を基準にする(挿入そのものを書き込み扱いしない)
      seenMtime: ins.mtime ?? 0,
      seenSize: ins.size ?? 0,
      dirty: false,
      lastChangeAt: 0,
    };
  }

  /** ファイルを挿入する。同じキーの保存があればそちらを読む(前回の続き)。 */
  async insertFile(d: number, file: File): Promise<void> {
    await this.withOp(async () => {
      try {
        const key = fileSourceKey(file.name, file.size);
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        await this.persist(d); // 差し替え前の中身を保存
        let stored: Awaited<ReturnType<typeof getDisk>>;
        try {
          stored = await getDisk(key);
        } catch {
          stored = undefined;
        }
        const useBytes = stored ? stored.bytes : fileBytes;
        const res = await this.proxy.diskRequest('insert', d, { name: file.name, bytes: useBytes.slice().buffer });
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

  async eject(d: number): Promise<void> {
    await this.withOp(async () => {
      await this.persist(d);
      const res = await this.proxy.diskRequest('eject', d);
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
      const res = await this.proxy.diskRequest('insert', d, { name, bytes: blank.slice().buffer });
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
    const res = await this.proxy.diskRequest('dump', d);
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
    if (this.opDepth > 0) return;
    const res = await this.proxy.diskRequest('poll');
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
        this.slots[d] = { ...emptySlot(), name: e.name ?? '(不明)', gen: e.gen ?? -1, seenMtime: e.mtime ?? 0, seenSize: e.size ?? 0 };
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
    if (this.opDepth === 0) {
      const res = await this.proxy.diskRequest('poll');
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
      let assignment;
      try {
        assignment = await getAssignment();
      } catch {
        return;
      }
      if (!assignment) return;
      for (let d = 0; d < 2; d++) {
        const key = assignment.keys[d];
        if (!key) continue;
        let stored;
        try {
          stored = await getDisk(key);
        } catch {
          continue;
        }
        if (!stored) continue;
        const res = await this.proxy.diskRequest('insert', d, { name: stored.name, bytes: stored.bytes.slice().buffer });
        if (!res.ok) continue;
        this.adopt(d, key, stored.name, res);
        restored.push(d);
      }
      this.render();
      if (restored.length > 0) {
        this.setMessage(
          `前回のディスクを自動で挿入しました: ${restored.map((d) => `ドライブ${d + 1} 「${this.slots[d].name}」`).join('、')}`,
        );
      }
    });
    return restored;
  }
}
