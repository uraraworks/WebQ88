// main.ts — 最小の起動配線。
//
// メインスレッドの役割は「ROM検証→Worker初期化」「描画」「キー入力の集約」の3つだけ。
// エミュレーション本体（コアの実行・入力の反映）は core-worker.js（Worker側）が持つ。

import './style.css';
import { loadVerifiedCompatRoms } from './compat-rom';
import { CoreProxy } from './core-proxy';
import { attachKeyboard } from './keyboard';
import { convertRgb565ToImageData } from './rgb565';

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const ctx = canvas.getContext('2d')!;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function main(): Promise<void> {
  setStatus('互換ROMを検証中…');
  let roms;
  try {
    roms = await loadVerifiedCompatRoms();
  } catch (err) {
    setStatus(`ROM検証エラー: ${(err as Error).message}`);
    return;
  }

  setStatus('コアを起動中…');

  let imageData: ImageData | null = null;
  let pixelBuf32: Uint32Array | null = null;

  const proxy = new CoreProxy({
    onReady: ({ width, height, fps }) => {
      canvas.width = width;
      canvas.height = height;
      imageData = ctx.createImageData(width, height);
      pixelBuf32 = new Uint32Array(imageData.data.buffer);
      setStatus(`起動しました (${width}x${height} @ ${fps.toFixed(1)}fps) — クリックしてキー入力を有効化`);
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

  proxy.init(roms);

  // 入力は1つの窓口（attachKeyboard）に集約し、そこから先は
  // CoreProxy.sendKey 経由でしか Worker に伝えない。
  attachKeyboard(window, (retroKey, pressed) => {
    proxy.sendKey(retroKey, pressed);
  });

  canvas.addEventListener('click', () => canvas.focus());
}

main();
