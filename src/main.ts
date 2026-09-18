// main.ts — 最小の起動配線。
//
// メインスレッドの役割は「ROM検証→Worker初期化」「描画」「キー入力の集約」の3つだけ。
// エミュレーション本体（コアの実行・入力の反映）は core-worker.js（Worker側）が持つ。

import './style.css';
import { loadVerifiedCompatRoms, type VerifiedRom } from './compat-rom';
import { CoreProxy } from './core-proxy';
import type { RomFile, RomMode } from './core-protocol';
import { attachKeyboard } from './keyboard';
import { convertRgb565ToImageData } from './rgb565';
import { Bridge, resolveBridgeUrl } from './bridge';

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const ctx = canvas.getContext('2d')!;
const romFilesInput = document.querySelector<HTMLInputElement>('#rom-files')!;
const romBootButton = document.querySelector<HTMLButtonElement>('#rom-boot')!;
const modeInfoEl = document.querySelector<HTMLDivElement>('#mode-info')!;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/**
 * モード表示。中身は一切出さず、役割・ファイル名・出どころ(bundled/user)だけを示す
 * (docs/API-DESIGN.md 第3節、および利用者ROM読み込みUIの要件)。
 */
function renderMode(mode: RomMode): void {
  const lines: string[] = [];
  const modeLabel = mode.restricted
    ? '<span class="restricted">制限モード（利用者ROMあり）</span>'
    : '<span class="compat">互換モード</span>';
  lines.push(`モード: ${modeLabel}`);
  for (const rom of mode.roms) {
    lines.push(`  役割 ${rom.role}: ${rom.name} (${rom.origin === 'user' ? '利用者' : '同梱'})`);
  }
  if (mode.unresolved.length > 0) {
    lines.push('認識できないファイル名のため使用しませんでした:');
    for (const u of mode.unresolved) {
      lines.push(`  ${u.name} (${u.origin === 'user' ? '利用者' : '同梱'})`);
    }
  }
  modeInfoEl.innerHTML = lines.join('\n');
}

/** File[] を {name, bytes}[] に変換する。中身はログに出さない。 */
async function filesToRomFiles(files: FileList | null): Promise<RomFile[]> {
  if (!files || files.length === 0) return [];
  const out: RomFile[] = [];
  for (const file of Array.from(files)) {
    const bytes = await file.arrayBuffer();
    out.push({ name: file.name, bytes });
  }
  return out;
}

async function main(): Promise<void> {
  setStatus('互換ROMを検証中…');
  let bundledRoms: VerifiedRom[];
  try {
    bundledRoms = await loadVerifiedCompatRoms();
  } catch (err) {
    setStatus(`ROM検証エラー: ${(err as Error).message}`);
    return;
  }

  setStatus('コアを起動中…');

  let imageData: ImageData | null = null;
  let pixelBuf32: Uint32Array | null = null;

  const proxy = new CoreProxy({
    onReady: ({ width, height, fps, mode }) => {
      canvas.width = width;
      canvas.height = height;
      imageData = ctx.createImageData(width, height);
      pixelBuf32 = new Uint32Array(imageData.data.buffer);
      setStatus(`起動しました (${width}x${height} @ ${fps.toFixed(1)}fps) — クリックしてキー入力を有効化`);
      renderMode(mode);
    },
    onFrame: ({ width, height, pitch, buffer }) => {
      if (!imageData || !pixelBuf32) return;
      if (width !== imageData.width || height !== imageData.height) return;
      convertRgb565ToImageData(new Uint8Array(buffer), pitch, width, height, pixelBuf32);
      ctx.putImageData(imageData, 0, 0);
    },
    onError: (message) => {
      setStatus(`エラー: ${message}`);
    },
  });

  // 初回は同梱の互換ROMだけで起動する。
  proxy.init(bundledRoms, []);

  // 利用者ROM読み込みUI: ファイル名・役割だけを扱い、中身は表示・ログ出力しない。
  // 渡したファイルは同梱ROMより優先され、足りない役割は同梱ROMで補う(混成可)。
  romBootButton.addEventListener('click', () => {
    void (async () => {
      const userRoms = await filesToRomFiles(romFilesInput.files);
      setStatus('起動中…');
      proxy.init(bundledRoms, userRoms);
    })();
  });

  // 入力は1つの窓口（attachKeyboard）に集約し、そこから先は
  // CoreProxy.sendKey 経由でしか Worker に伝えない。
  attachKeyboard(window, (retroKey, pressed) => {
    proxy.sendKey(retroKey, pressed);
  });

  canvas.addEventListener('click', () => canvas.focus());

  // 自動操作API(docs/API-DESIGN.md)の入口。可否判定・コマンド実装は一切ここに
  // 持たず、Worker側(public/api-dispatch.js)へ転送するだけにする
  // (第5節: メインスレッド側はコマンド一覧の複製を持たない)。
  const bridge = new Bridge({ exec: (cmd, args) => proxy.execApi(cmd, args) });
  const bridgeUrl = resolveBridgeUrl(window.location.search);
  if (bridgeUrl) {
    bridge.connect(bridgeUrl);
  }

  // 開発ビルドのみ、ページ内JSから直接叩ける入口を公開する(同じ掛け金を通す。
  // docs/API-DESIGN.md 第5節: 開発用の入口だけ制限をすり抜ける形にしない)。
  if (import.meta.env.DEV) {
    (window as unknown as { __webq88Debug: unknown }).__webq88Debug = {
      exec: (cmd: string, args: Record<string, unknown> = {}) => bridge.exec(cmd, args),
    };
  }
}

main();
