// core-protocol.ts
//
// メインスレッド ⇔ コアWorker 間のメッセージ型を1箇所に集約する。
//
// 注意: Worker 本体（public/core-worker.js）は emscripten の MODULARIZE 出力
// （UMD形式。トップレベル var 代入で globalThis に生える）を importScripts() で
// 読み込む必要があるため、あえて「クラシックワーカー」として書いている
// （Viteのモジュールワーカーだと importScripts が使えない。
// ../../_emulator/CLAUDE.md 系メモ「Vite devはクラシックworkerにESM importを残す」
// を踏まえ、import/export 構文はワーカー側に一切持ち込まない）。
// そのためこのファイルの型・定数はメインスレッド側だけで使い、
// ワーカー側では同じ文字列リテラルを直接書いて重複させている。
// 変更した場合は public/core-worker.js 側も合わせて直すこと。

/** メインスレッド → Worker */
export type MainToWorkerMessage =
  | {
      type: 'init';
      roms: { name: string; bytes: ArrayBuffer }[];
    }
  | { type: 'key'; code: number /* RETROK */; pressed: boolean }
  | { type: 'reset' };

/** Worker → メインスレッド */
export type WorkerToMainMessage =
  | { type: 'ready'; width: number; height: number; fps: number }
  | {
      type: 'frame';
      width: number;
      height: number;
      pitch: number;
      /** RGB565 の生ピクセルバッファ（変換はメインスレッド側で行う） */
      buffer: ArrayBuffer;
    }
  | { type: 'error'; message: string };

export const WORKER_SCRIPT_PATH = 'core-worker.js';
export const CORE_JS_RELATIVE_PATH = 'core/q88_libretro.js';
