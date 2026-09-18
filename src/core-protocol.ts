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

/** ROMファイル1本(中身は見ない。名前とバイト列のみ)。 */
export interface RomFile {
  name: string;
  bytes: ArrayBuffer;
}

/** 出どころ判定後、実際に起動へ使われた役割ごとのROM(docs/API-DESIGN.md 第3節)。 */
export interface RomModeEntry {
  role: string;
  name: string;
  origin: 'bundled' | 'user';
}

/** 既知の役割に一致せず、起動に使われなかったファイル。 */
export interface UnresolvedRomFile {
  name: string;
  origin: 'bundled' | 'user';
}

/** そのセッションの現在のモード。一度 restricted=true になったら false には戻らない。 */
export interface RomMode {
  restricted: boolean;
  roms: RomModeEntry[];
  unresolved: UnresolvedRomFile[];
}

/** メインスレッド → Worker */
export type MainToWorkerMessage =
  | {
      // 初回はコアを新規起動、2回目以降(moduleInstance が既にある)は
      // 同一Workerインスタンス内で ROM を差し替えて再起動する
      // (docs/API-DESIGN.md 第3節「一方向の掛け金」)。
      type: 'init';
      bundled: RomFile[];
      user: RomFile[];
    }
  | { type: 'key'; code: number /* RETROK */; pressed: boolean }
  | { type: 'reset' }
  // デバッグ/検証用: 1フレーム内の押下取りこぼし対策(public/key-hold-tracker.js)の
  // 保留ポーリング数を上書きする。0で対策を無効化(陰性対照)。通常のUIからは呼ばない。
  | { type: 'setKeyHoldMinPolls'; minPolls: number }
  // デバッグ用(次ステップの自動操作APIの土台)。現在のモードを問い合わせる。
  | { type: 'mode' }
  // デバッグ用。制限モードでは常に拒否される(docs/API-DESIGN.md 第4節)。
  | { type: 'ram_read'; requestId: number; region: number; offset: number; len: number }
  | { type: 'ram_write'; requestId: number; region: number; offset: number; bytes: ArrayBuffer };

/** Worker → メインスレッド */
export type WorkerToMainMessage =
  | { type: 'ready'; width: number; height: number; fps: number; mode: RomMode }
  | {
      type: 'frame';
      width: number;
      height: number;
      pitch: number;
      /** RGB565 の生ピクセルバッファ（変換はメインスレッド側で行う） */
      buffer: ArrayBuffer;
    }
  | { type: 'error'; message: string }
  | { type: 'mode'; mode: RomMode }
  | { type: 'ram_read_result'; requestId: number; data?: ArrayBuffer; error?: string }
  | { type: 'ram_write_result'; requestId: number; ok: boolean; error?: string };

export const WORKER_SCRIPT_PATH = 'core-worker.js';
export const CORE_JS_RELATIVE_PATH = 'core/q88_libretro.js';
