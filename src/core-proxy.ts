// core-proxy.ts
//
// メインスレッド側から見た「コアWorker」への薄いラッパー。
// Worker 生成・メッセージの送受信だけを担当し、描画（rgb565.ts）や
// キー入力の変換（keyboard.ts）はここに持ち込まない。

import type { DiskResult, MainToWorkerMessage, RomFile, RomMode, WorkerToMainMessage } from './core-protocol';
import { WORKER_SCRIPT_PATH } from './core-protocol';
import type { VerifiedRom } from './compat-rom';

export interface CoreProxyHandlers {
  onReady?: (info: { width: number; height: number; fps: number; sampleRate: number; mode: RomMode }) => void;
  onAudio?: (buffer: ArrayBuffer) => void;
  onFrame?: (frame: { width: number; height: number; pitch: number; buffer: ArrayBuffer; lamp: number }) => void;
  onError?: (message: string) => void;
  /** {type:'mode'} への応答(デバッグ用)。 */
  onMode?: (mode: RomMode) => void;
}

let nextRequestId = 1;

export class CoreProxy {
  private worker: Worker;
  setAudioQueue(seconds: number, enabled: boolean): void { this.worker.postMessage({ type: 'audioQueue', seconds, enabled }); }
  private pendingRamReads = new Map<number, { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }>();
  private pendingRamWrites = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  private pendingApiExecs = new Map<number, (result: Record<string, unknown>) => void>();
  private pendingDisks = new Map<number, (result: DiskResult) => void>();

  constructor(handlers: CoreProxyHandlers) {
    // ワーカー本体は importScripts() で emscripten の UMD 出力を読み込む必要があり
    // モジュールワーカーにできないため、public/ 直下の素の .js をクラシックワーカーとして使う
    // （core-protocol.ts 冒頭のコメント参照）。
    const workerUrl = new URL(WORKER_SCRIPT_PATH, document.baseURI);
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (ev: MessageEvent<WorkerToMainMessage>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'ready':
          handlers.onReady?.({ width: msg.width, height: msg.height, fps: msg.fps, sampleRate: msg.sampleRate, mode: msg.mode });
          break;
        case 'audio':
          handlers.onAudio?.(msg.buffer);
          break;
        case 'frame':
          handlers.onFrame?.({
            width: msg.width,
            height: msg.height,
            pitch: msg.pitch,
            buffer: msg.buffer,
            lamp: msg.lamp ?? 0,
          });
          break;
        case 'error':
          handlers.onError?.(msg.message);
          break;
        case 'mode':
          handlers.onMode?.(msg.mode);
          break;
        case 'ram_read_result': {
          const pending = this.pendingRamReads.get(msg.requestId);
          if (!pending) break;
          this.pendingRamReads.delete(msg.requestId);
          if (msg.error || !msg.data) {
            pending.reject(new Error(msg.error ?? 'ram_read: 不明なエラー'));
          } else {
            pending.resolve(msg.data);
          }
          break;
        }
        case 'ram_write_result': {
          const pending = this.pendingRamWrites.get(msg.requestId);
          if (!pending) break;
          this.pendingRamWrites.delete(msg.requestId);
          if (!msg.ok) {
            pending.reject(new Error(msg.error ?? 'ram_write: 不明なエラー'));
          } else {
            pending.resolve();
          }
          break;
        }
        case 'diskResult': {
          const pending = this.pendingDisks.get(msg.requestId);
          if (!pending) break;
          this.pendingDisks.delete(msg.requestId);
          pending(msg);
          break;
        }
        case 'apiExecResult': {
          const pending = this.pendingApiExecs.get(msg.requestId);
          if (!pending) break;
          this.pendingApiExecs.delete(msg.requestId);
          pending(msg.result);
          break;
        }
      }
    };
    this.worker.onerror = (ev) => {
      handlers.onError?.(ev.message ?? 'unknown worker error');
    };
  }

  /**
   * 起動 / 再起動する。bundled は同梱互換ROM(検証済み)、user は利用者が
   * 選んだファイル。初回はコアを新規起動し、既に起動済みなら同一Worker
   * インスタンス内で ROM を差し替えて再起動する(docs/API-DESIGN.md 第3節)。
   */
  init(bundled: VerifiedRom[], user: RomFile[] = []): void {
    const payload: MainToWorkerMessage = {
      type: 'init',
      bundled: bundled.map((r) => ({ name: r.name, bytes: r.bytes })),
      user: user.map((r) => ({ name: r.name, bytes: r.bytes })),
    };
    // bundled(同梱ROM)は再起動のたびに同じ ArrayBuffer を使い回す可能性があるため
    // 転送(transfer)せずコピーする(転送すると呼び出し元の ArrayBuffer が detached になり、
    // 2回目の init() で DataCloneError になる)。user 側は毎回ファイルから新しく
    // 読み込んだバイト列なので転送してコピーを避ける。
    const transfer = user.map((r) => r.bytes);
    this.worker.postMessage(payload, transfer);
  }

  /** デバッグ用(次ステップの自動操作APIの土台)。現在のモードを問い合わせる。 */
  requestMode(): void {
    const payload: MainToWorkerMessage = { type: 'mode' };
    this.worker.postMessage(payload);
  }

  /** デバッグ用。制限モードでは reject される(docs/API-DESIGN.md 第4節)。 */
  readRam(region: number, offset: number, len: number): Promise<ArrayBuffer> {
    const requestId = nextRequestId++;
    const promise = new Promise<ArrayBuffer>((resolve, reject) => {
      this.pendingRamReads.set(requestId, { resolve, reject });
    });
    const payload: MainToWorkerMessage = { type: 'ram_read', requestId, region, offset, len };
    this.worker.postMessage(payload);
    return promise;
  }

  /** デバッグ用。制限モードでは reject される(docs/API-DESIGN.md 第4節)。 */
  writeRam(region: number, offset: number, bytes: ArrayBuffer): Promise<void> {
    const requestId = nextRequestId++;
    const promise = new Promise<void>((resolve, reject) => {
      this.pendingRamWrites.set(requestId, { resolve, reject });
    });
    const payload: MainToWorkerMessage = { type: 'ram_write', requestId, region, offset, bytes };
    this.worker.postMessage(payload, [bytes]);
    return promise;
  }

  /**
   * 自動操作API本体(docs/API-DESIGN.md)。実装・可否判定はWorker側
   * (public/api-dispatch.js)に集約されており、ここは往復するだけ。
   * 戻り値は常に {ok:true,...} か {error:'...'}(reject しない)。
   */
  execApi(cmd: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const requestId = nextRequestId++;
    const promise = new Promise<Record<string, unknown>>((resolve) => {
      this.pendingApiExecs.set(requestId, resolve);
    });
    const payload: MainToWorkerMessage = { type: 'apiExec', requestId, cmd, args };
    this.worker.postMessage(payload);
    return promise;
  }

  /**
   * ディスク操作(UI用)。drive は 0=ドライブ1 / 1=ドライブ2。
   * 戻り値は常に {ok:true,...} か {ok:false,error}(reject しない)。
   * insert の bytes は転送される(呼び出し元のバッファは使えなくなる)ので、
   * 手元に残したいときはコピーを渡すこと。
   */
  diskRequest(
    op: 'insert' | 'eject' | 'dump' | 'poll',
    drive?: number,
    extra: { name?: string; bytes?: ArrayBuffer; image?: number; key?: string } = {},
  ): Promise<DiskResult> {
    const requestId = nextRequestId++;
    const promise = new Promise<DiskResult>((resolve) => {
      this.pendingDisks.set(requestId, resolve);
    });
    const payload: MainToWorkerMessage = { type: 'disk', requestId, op, drive, name: extra.name, bytes: extra.bytes, image: extra.image, key: extra.key };
    this.worker.postMessage(payload, extra.bytes ? [extra.bytes] : []);
    return promise;
  }

  sendKey(code: number, pressed: boolean): void {
    const payload: MainToWorkerMessage = { type: 'key', code, pressed };
    this.worker.postMessage(payload);
  }

  setPaused(paused: boolean): void {
    const payload: MainToWorkerMessage = { type: paused ? 'pause' : 'resume' };
    this.worker.postMessage(payload);
  }

  reset(): void {
    const payload: MainToWorkerMessage = { type: 'reset' };
    this.worker.postMessage(payload);
  }

  /** デバッグ/検証用。通常のUIからは呼ばない(core-protocol.tsの型定義コメント参照)。 */
  setKeyHoldMinPolls(minPolls: number): void {
    const payload: MainToWorkerMessage = { type: 'setKeyHoldMinPolls', minPolls };
    this.worker.postMessage(payload);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
