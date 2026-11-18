declare const __BUILD_TIME__: string;
// main.ts — 最小の起動配線。
//
// メインスレッドの役割は「ROM検証→Worker初期化」「描画」「キー入力の集約」の3つだけ。
// エミュレーション本体（コアの実行・入力の反映）は core-worker.js（Worker側）が持つ。

import './style.css';
import { AudioEngine } from './audio';
import { initDisplay } from './display';
import { initPlayerUi } from './player-ui';
import { loadVerifiedBundledDisks, loadVerifiedCompatRoms, type VerifiedRom } from './compat-rom';
import { DiskPanel } from './disks';
import { initLibrary } from './library';
import { CoreProxy } from './core-proxy';
import type { RomFile, RomMode } from './core-protocol';
import { attachKeyboard } from './keyboard';
import { initVirtualKeyboard } from './virtual-keyboard';
import { initInputControls } from './input-controls';
import { convertRgb565ToImageData } from './rgb565';
import { Bridge, resolveBridgeUrl } from './bridge';
import { registerUrl } from './disk-source';
import { initStateUi } from './state-ui';

initPlayerUi();
const audio = new AudioEngine();
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const volumeInput = document.querySelector<HTMLInputElement>('#volume')!;
let muted = false;
try {
  muted = localStorage.getItem('webq88-muted') === 'true';
  const stored = localStorage.getItem('webq88-volume');
  if (stored !== null && Number.isFinite(Number(stored))) volumeInput.value = String(Math.max(0, Math.min(100, Number(stored))));
} catch { /* 保存を使えない環境でも再生する */ }
function updateAudioSettings(): void {
  audio.setSettings(muted, Number(volumeInput.value) / 100);
  muteButton.title = muted ? 'ミュート解除' : 'ミュート';
  muteButton.setAttribute('aria-label', muteButton.title);
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.classList.toggle('active', muted);
  muteButton.querySelector('path')!.setAttribute('d', muted ? 'M4 9h4l5-4v14l-5-4H4z M16 9l5 6 M21 9l-5 6' : 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M19 6a8 8 0 0 1 0 12');
  try { localStorage.setItem('webq88-muted', String(muted)); localStorage.setItem('webq88-volume', volumeInput.value); } catch { /* 保存不可 */ }
}
muteButton.addEventListener('click', () => { muted = !muted; updateAudioSettings(); });
volumeInput.addEventListener('input', updateAudioSettings);
updateAudioSettings();
// 自動起動時も最初のユーザー操作から AudioContext を開始する。
for (const event of ['pointerdown', 'keydown'] as const) window.addEventListener(event, () => audio.start(), { capture: true });

const numpadAlt = document.querySelector<HTMLInputElement>('#numpad-alt')!;
try { numpadAlt.checked = localStorage.getItem('webq88-numpad-alt') === 'true'; } catch { /* 既定OFF */ }
numpadAlt.addEventListener('change', () => {
  try { localStorage.setItem('webq88-numpad-alt', String(numpadAlt.checked)); } catch { /* 保存できなくても切替可能 */ }
});

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const ctx = canvas.getContext('2d')!;
const display = initDisplay(canvas);
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const pauseOverlay = document.querySelector<HTMLElement>('#pause-overlay')!;
const screenshotButton = document.querySelector<HTMLButtonElement>('#screenshot')!;
pauseButton.disabled = true;
screenshotButton.disabled = true;
const romFilesInput = document.querySelector<HTMLInputElement>('#rom-files')!;
const romBootButton = document.querySelector<HTMLButtonElement>('#rom-boot')!;
const modeInfoEl = document.querySelector<HTMLDivElement>('#mode-info')!;
const disksEl = document.querySelector<HTMLDivElement>('#disks')!;
const coreResetButton = document.querySelector<HTMLButtonElement>('#core-reset')!;

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

async function main(startRequested: Promise<RomFile[]>): Promise<void> {
  setStatus('互換ROMを検証中…');
  let bundledRoms: VerifiedRom[];
  let bundledDisks: VerifiedRom[] = [];
  try {
    bundledRoms = await loadVerifiedCompatRoms();
  } catch (err) {
    setStatus(`ROM検証エラー: ${(err as Error).message}`);
    return;
  }
  try {
    // 同梱の空データディスク(ブランクFD作成用)。取れなくてもエミュレータ自体は動かす
    // (その場合は「ブランクFDを作成」だけ無効になる)。
    bundledDisks = await loadVerifiedBundledDisks();
  } catch (err) {
    console.error('同梱ディスクの検証に失敗しました', err);
  }
  const blank2d = bundledDisks.find((d) => /^BLANK2D\.D88$/i.test(d.name));

  setStatus('起動待ち');

  let imageData: ImageData | null = null;
  let pixelBuf32: Uint32Array | null = null;
  let diskPanel: DiskPanel | null = null;
  let firstReady = true;

  const proxy = new CoreProxy({
    onReady: ({ width, height, fps, sampleRate, mode }) => {
      audio.setRate(sampleRate);
      canvas.width = width;
      canvas.height = height;
      display.update();
      pauseButton.disabled = false;
      imageData = ctx.createImageData(width, height);
      pixelBuf32 = new Uint32Array(imageData.data.buffer);
      setStatus(`起動しました (${width}x${height} @ ${fps.toFixed(1)}fps) — クリックしてキー入力を有効化`);
      renderMode(mode);
      if (firstReady) {
        firstReady = false;
        // 前回のドライブ割り当てを自動で挿入する。ドライブ1に入れたときは、
        // 起動用ディスクとして読まれるようもう一度リセットする。
        void (async () => {
          if (!diskPanel) return;
          const restored = await diskPanel.restore();
          const params = new URLSearchParams(location.search);
          let bootChanged = restored.includes(0);
          for (let d = 0; d < 2; d++) {
            const url = params.get(`fd${d + 1}`);
            if (!url) continue;
            try {
              const disks = await registerUrl(url, message => diskPanel!.showMessage(`FD${d + 1}: ${message}`));
              await diskPanel.insertStored(d, disks[0].sourceKey);
              if (d === 0) bootChanged = true;
            } catch (err) { diskPanel.showMessage(`FD${d + 1}: ${(err as Error).message}`); }
          }
          for (const url of params.getAll('lib').filter(Boolean)) {
            try { await registerUrl(url, message => diskPanel!.showMessage(`ライブラリ: ${message}`)); }
            catch (err) { diskPanel.showMessage(`ライブラリ: ${(err as Error).message}`); }
          }
          if (params.getAll('lib').some(Boolean)) document.querySelector<HTMLButtonElement>('#disk-library')!.click();
          if (bootChanged) proxy.reset();
        })();
      }
    },
    onAudio: buffer => audio.push(buffer),
    onFrame: ({ width, height, pitch, buffer, lamp }) => {
      diskPanel?.setLamp(lamp);
      if (!imageData || width !== imageData.width || height !== imageData.height) {
        canvas.width = width;
        canvas.height = height;
        imageData = ctx.createImageData(width, height);
        pixelBuf32 = new Uint32Array(imageData.data.buffer);
        display.update();
      }
      if (!pixelBuf32) return;
      convertRgb565ToImageData(new Uint8Array(buffer), pitch, width, height, pixelBuf32);
      ctx.putImageData(imageData, 0, 0);
      display.present();
      screenshotButton.disabled = false;
    },
    onError: (message) => {
      setStatus(`エラー: ${message}`);
    },
  });

  const audioPacing = !new URLSearchParams(location.search).has('bridge');
  audio.onQueue = seconds => proxy.setAudioQueue(seconds, audioPacing);
  let paused = false;
  pauseButton.addEventListener('click', () => {
    paused = !paused;
    audio.setPaused(paused);
    proxy.setPaused(paused);
    pauseOverlay.hidden = !paused;
    pauseButton.classList.toggle('active', paused);
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.title = paused ? '再開' : '一時停止';
    pauseButton.setAttribute('aria-label', pauseButton.title);
    pauseButton.querySelector('path')!.setAttribute('d', paused ? 'M8 5l11 7-11 7z' : 'M8 5v14 M16 5v14');
  });
  screenshotButton.addEventListener('click', () => {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const filename = `webq88-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  });

  diskPanel = new DiskPanel(proxy, disksEl, { blankImage: blank2d ? new Uint8Array(blank2d.bytes) : null });

  initLibrary(diskPanel);
  initStateUi(proxy, () => diskPanel!.flushAll());

  // 初回は起動操作を待ち、同梱の互換ROMで起動する。
  void startRequested.then(userRoms => proxy.init(bundledRoms, userRoms));

  // 利用者ROM読み込みUI: ファイル名・役割だけを扱い、中身は表示・ログ出力しない。
  // 渡したファイルは同梱ROMより優先され、足りない役割は同梱ROMで補う(混成可)。
  romBootButton.addEventListener('click', () => {
    void (async () => {
      const userRoms = await filesToRomFiles(romFilesInput.files);
      // 再起動でディスクの状態が変わりうるので、先にゲストの書き込みを保存する。
      await diskPanel?.flushAll();
      setStatus('起動中…');
      if (!startupRequested) start(userRoms);
      else proxy.init(bundledRoms, userRoms);
    })();
  });

  coreResetButton.addEventListener('click', () => {
    void (async () => {
      await diskPanel?.flushAll();
      proxy.reset();
    })();
  });

  // 入力は1つの窓口（attachKeyboard）に集約し、そこから先は
  // CoreProxy.sendKey 経由でしか Worker に伝えない。
  let hostMapping: () => Record<string, number> = () => ({});
  const keyboard = attachKeyboard(window, (retroKey, pressed) => {
    proxy.sendKey(retroKey, pressed);
  }, () => numpadAlt.checked, () => hostMapping());
  hostMapping = initInputControls(keyboard.createKeySource);

  initVirtualKeyboard(keyboard.setVirtualKey, display.update);

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

const startupOverlay = document.querySelector<HTMLElement>('#startup-overlay')!;
let requestStart!: (roms: RomFile[]) => void;
let startupRequested = false;
const startRequested = new Promise<RomFile[]>(resolve => { requestStart = resolve; });
void main(startRequested);
const start = (roms: RomFile[] = []): void => {
  if (startupRequested) return;
  startupRequested = true;
  startupOverlay.hidden = true;
  requestStart(roms);
};
if (new URLSearchParams(window.location.search).has('bridge') || (new URLSearchParams(window.location.search).get('run') === '1' && !new URLSearchParams(window.location.search).has('lib'))) {
  start();
} else {
  document.querySelector<HTMLButtonElement>('#startup-button')!.addEventListener('click', () => start(), { once: true });
}
document.querySelector<HTMLElement>('#build-time')!.textContent = `Build: ${__BUILD_TIME__}`;
