// core-proxy.ts
//
// メインスレッド側から見た「コアWorker」への薄いラッパー。
// Worker 生成・メッセージの送受信だけを担当し、描画（rgb565.ts）や
// キー入力の変換（keyboard.ts）はここに持ち込まない。

import type { MainToWorkerMessage, WorkerToMainMessage } from './core-protocol';
import { WORKER_SCRIPT_PATH } from './core-protocol';
import type { VerifiedRom } from './compat-rom';

export interface CoreProxyHandlers {
  onReady?: (info: { width: number; height: number; fps: number }) => void;
  onFrame?: (frame: { width: number; height: number; pitch: number; buffer: ArrayBuffer }) => void;
  onError?: (message: string) => void;
}

export class CoreProxy {
  private worker: Worker;

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
          handlers.onReady?.({ width: msg.width, height: msg.height, fps: msg.fps });
          break;
        case 'frame':
          handlers.onFrame?.({
            width: msg.width,
            height: msg.height,
            pitch: msg.pitch,
            buffer: msg.buffer,
          });
          break;
        case 'error':
          handlers.onError?.(msg.message);
          break;
      }
    };
    this.worker.onerror = (ev) => {
      handlers.onError?.(ev.message ?? 'unknown worker error');
    };
  }

  init(roms: VerifiedRom[]): void {
    const payload: MainToWorkerMessage = {
      type: 'init',
      roms: roms.map((r) => ({ name: r.name, bytes: r.bytes })),
    };
    // ROMバイト列は転送（transfer）してコピーを避ける。
    this.worker.postMessage(payload, roms.map((r) => r.bytes));
  }

  sendKey(code: number, pressed: boolean): void {
    const payload: MainToWorkerMessage = { type: 'key', code, pressed };
    this.worker.postMessage(payload);
  }

  reset(): void {
    const payload: MainToWorkerMessage = { type: 'reset' };
    this.worker.postMessage(payload);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
