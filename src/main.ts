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
import { Bridge, resolveBridgeUrl, createBridgeHost } from './bridge';
import { registerUrl } from './disk-source';
import { initStateUi } from './state-ui';
import { saveRoms, loadRoms, clearRoms, listRomNames } from './rom-store';

initPlayerUi();
const urlParams = new URLSearchParams(location.search);
// デバッグ用の上書きだけを渡す。選択肢は libretro_core_options.h に合わせる。
const coreOptionValues: Record<string, readonly string[]> = {
  q88_cpu_clock: ['4', '8', '16', '32', '64', '1', '2'],
  q88_basic_mode: ['N88 V2', 'N88 V1H', 'N88 V1S', 'N'],
  q88_sub_cpu_mode: ['0', '1', '2'],
};
const appliedCoreOptions: Record<string, string> = {};
for (const [key, values] of Object.entries(coreOptionValues)) {
  const value = urlParams.get(key);
  if (value !== null && values.includes(value)) appliedCoreOptions[key] = value;
}
const audio = new AudioEngine();
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const volumeInput = document.querySelector<HTMLInputElement>('#volume')!;
const driveSoundInput = document.querySelector<HTMLInputElement>('#drive-sound')!;
let muted = false;
try {
  muted = localStorage.getItem('webq88-muted') === 'true';
  driveSoundInput.checked = localStorage.getItem('webq88-drive-sound') === 'true';
  const stored = localStorage.getItem('webq88-volume');
  if (stored !== null && Number.isFinite(Number(stored))) volumeInput.value = String(Math.max(0, Math.min(100, Number(stored))));
} catch { /* 保存を使えない環境でも再生する */ }
// URLの設定は今回の起動だけに適用する。
const muteParam = urlParams.get('mute');
if (muteParam === '0' || muteParam === '1') muted = muteParam === '1';
const driveSoundParam = urlParams.get('driveSound');
if (driveSoundParam === '0' || driveSoundParam === '1') driveSoundInput.checked = driveSoundParam === '1';
const volumeParam = urlParams.get('volume');
if (volumeParam !== null && /^(?:100|[0-9]{1,2})$/.test(volumeParam)) volumeInput.value = volumeParam;
function updateAudioSettings(): void {
  audio.setSettings(muted, Number(volumeInput.value) / 100);
  muteButton.title = muted ? 'ミュート解除' : 'ミュート';
  muteButton.setAttribute('aria-label', muteButton.title);
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.classList.toggle('active', muted);
  muteButton.querySelector('path')!.setAttribute('d', muted ? 'M4 9h4l5-4v14l-5-4H4z M16 9l5 6 M21 9l-5 6' : 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M19 6a8 8 0 0 1 0 12');
}
muteButton.addEventListener('click', () => { muted = !muted; updateAudioSettings(); try { localStorage.setItem('webq88-muted', String(muted)); } catch { /* 保存不可 */ } });
volumeInput.addEventListener('input', () => { updateAudioSettings(); try { localStorage.setItem('webq88-volume', volumeInput.value); } catch { /* 保存不可 */ } });
audio.setDriveSound(driveSoundInput.checked);
driveSoundInput.addEventListener('change', () => {
  audio.setDriveSound(driveSoundInput.checked);
  try { localStorage.setItem('webq88-drive-sound', String(driveSoundInput.checked)); } catch { /* 保存不可 */ }
});
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
const perfToggle = document.querySelector<HTMLInputElement>('#perf-toggle')!;
try { perfToggle.checked = localStorage.getItem('webq88-perf') === 'true'; } catch { /* 既定値を使う */ }
if (urlParams.get('perf') === '1') perfToggle.checked = true;
const perfOverlay = document.createElement('div'); perfOverlay.className = 'perf-overlay';
document.querySelector<HTMLElement>('#screen-stage')!.append(perfOverlay);
const updatePerfVisibility = () => { perfOverlay.hidden = !perfToggle.checked; };
perfToggle.addEventListener('change', () => { updatePerfVisibility(); try { localStorage.setItem('webq88-perf', String(perfToggle.checked)); } catch { /* 保存不可 */ } });
updatePerfVisibility();
let perfDrawTotal = 0;
let perfFrames = 0, perfCoreFrames = 0, perfLastCoreFrames = 0, perfHz = 0, perfQueue: number | null = null;
let perfLastTime = performance.now(), perfLastFrameTime = 0;
setInterval(() => {
  const now = performance.now(), elapsed = (now - perfLastTime) / 1000;
  const emuFps = Math.max(0, perfCoreFrames - perfLastCoreFrames) / elapsed;
  const lines = [`描画 ${Math.round(perfFrames / elapsed)} FPS`];
  if (perfHz > 0) lines.push(`実行 ${emuFps.toFixed(1)} / ${perfHz.toFixed(1)} FPS (${(emuFps / perfHz * 100).toFixed(1)}%)`);
  if (perfQueue !== null && now - perfLastFrameTime < 1000) lines.push(`音声キュー ${(perfQueue * 1000).toFixed(0)} ms`);
  perfOverlay.textContent = lines.join('\n');
  perfFrames = 0; perfLastCoreFrames = perfCoreFrames; perfLastTime = now;
}, 1000);
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const pauseOverlay = document.querySelector<HTMLElement>('#pause-overlay')!;
const screenshotButton = document.querySelector<HTMLButtonElement>('#screenshot')!;
pauseButton.disabled = true;
screenshotButton.disabled = true;
const romFilesInput = document.querySelector<HTMLInputElement>('#rom-files')!;
const romBootButton = document.querySelector<HTMLButtonElement>('#rom-boot')!;
const savedRomNames = document.querySelector<HTMLElement>('#saved-rom-names')!;
const savedRomMessage = document.querySelector<HTMLElement>('#saved-rom-message')!;
async function refreshRomNames(): Promise<void> {
  try {
    const names = await listRomNames();
    savedRomNames.textContent = `保存済みROM: ${names.length ? names.join('、') : 'なし'}`;
    // 起動前は、起動ボタンとモード表示を「これから使うROM」に合わせる。
    const overlay = document.querySelector<HTMLElement>('#startup-overlay');
    if (overlay && !overlay.hidden) {
      document.querySelector<HTMLElement>('#startup-button')!.textContent = names.length ? '登録したROMで起動' : '互換ROMで起動';
      document.querySelector<HTMLElement>('#mode-info')!.innerHTML = names.length
        ? '<span class="restricted">制限モード（利用者ROMあり）</span> 起動待ち'
        : '';
    }
  } catch {
    savedRomNames.textContent = '保存済みROM: 取得できませんでした';
    console.warn('ROM一覧を取得できませんでした');
  }
}
void refreshRomNames();
document.querySelector<HTMLButtonElement>('#clear-roms')!.addEventListener('click', () => {
  void (async () => {
    try {
      await clearRoms();
      await refreshRomNames();
      savedRomMessage.textContent = '次回起動から互換モード';
      setStatus('保存済みROMを削除しました（次回起動から互換モード）');
      closeToolbarMenu();
    } catch {
      savedRomMessage.textContent = '保存済みROMを削除できませんでした';
      console.warn('ROMを削除できませんでした');
    }
  })();
});
const modeInfoEl = document.querySelector<HTMLDivElement>('#mode-info')!;
const disksEl = document.querySelector<HTMLDivElement>('#disks')!;
const coreResetButton = document.querySelector<HTMLButtonElement>('#core-reset')!;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/** 「…」メニューが開いていれば閉じる(トグルボタンを押す)。 */
function closeToolbarMenu(): void {
  const more = document.querySelector<HTMLButtonElement>('#toolbar-more');
  if (more?.getAttribute('aria-expanded') === 'true') more.click();
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
  let coreSampleRate: number | null = null;

  const proxy = new CoreProxy({
    onReady: ({ width, height, fps, sampleRate, mode }) => {
      perfHz = fps; coreSampleRate = sampleRate;
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
        if (urlParams.get('pause') === '1') pauseButton.click();
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
    onFrame: ({ width, height, pitch, buffer, lamp, executedFrames }) => {
      perfFrames++; perfDrawTotal++; perfCoreFrames = executedFrames; perfLastFrameTime = performance.now();
      diskPanel?.setLamp(lamp);
      audio.setDriveLamp(lamp);
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
  }, appliedCoreOptions);

  const audioPacing = !new URLSearchParams(location.search).has('bridge');
  const queueListeners = new Set<(ms: number) => void>();
  audio.onQueue = seconds => { perfQueue = seconds; for (const listener of queueListeners) listener(seconds * 1000); proxy.setAudioQueue(seconds, audioPacing); };
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

  const stage = document.querySelector<HTMLElement>('#screen-stage')!;
  stage.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    stage.classList.add('drag-over');
  });
  stage.addEventListener('dragleave', event => {
    if (!stage.contains(event.relatedTarget as Node | null)) stage.classList.remove('drag-over');
  });
  stage.addEventListener('drop', event => {
    event.preventDefault();
    stage.classList.remove('drag-over');
    const files = Array.from(event.dataTransfer?.files ?? []).slice(0, 2);
    void (async () => {
      for (let i = 0; i < files.length; i++) await diskPanel!.insertFile(files.length > 1 ? i : event.shiftKey ? 1 : 0, files[i]);
    })();
  });

  initLibrary(diskPanel);
  initStateUi(proxy, () => diskPanel!.flushAll());

  // 初回は起動操作を待ち、同梱の互換ROMで起動する。
  void startRequested.then(async userRoms => {
    if (userRoms.length === 0) {
      try { userRoms = await loadRoms(); }
      catch { console.warn('保存済みROMを読み込めませんでした'); }
    }
    proxy.init(bundledRoms, userRoms);
  });

  // 利用者ROM読み込みUI: ファイル名・役割だけを扱い、中身は表示・ログ出力しない。
  // 渡したファイルは同梱ROMより優先され、足りない役割は同梱ROMで補う(混成可)。
  romBootButton.addEventListener('click', () => {
    void (async () => {
      const userRoms = await filesToRomFiles(romFilesInput.files);
      if (userRoms.length > 0) {
        await saveRoms(userRoms);
        await refreshRomNames();
        savedRomMessage.textContent = '';
      }
      // 再起動でディスクの状態が変わりうるので、先にゲストの書き込みを保存する。
      await diskPanel?.flushAll();
      setStatus('起動中…');
      closeToolbarMenu();
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
  const portDevice = document.querySelector<HTMLSelectElement>('#port-device')!;
  const mouseHint = document.querySelector<HTMLElement>('#mouse-hint')!;
  const mouseRelease = document.querySelector<HTMLButtonElement>('#mouse-release')!;
  try { if (localStorage.getItem('webq88-port-device') === 'mouse') portDevice.value = 'mouse'; } catch { /* 既定値を使う */ }
  hostMapping = initInputControls(keyboard.createKeySource, () => portDevice.value !== 'mouse');
  let mouseDx = 0, mouseDy = 0;
  const releaseButtons = () => { proxy.mouseButton(false, false); proxy.mouseButton(true, false); mouseDx = mouseDy = 0; };
  const updateDevice = () => {
    releaseButtons();
    if (portDevice.value !== 'mouse' && document.pointerLockElement === canvas) document.exitPointerLock();
    proxy.setPortDevice(portDevice.value === 'mouse');
    try { localStorage.setItem('webq88-port-device', portDevice.value); } catch { /* 保存不可 */ }
  };
  portDevice.addEventListener('change', updateDevice);
  updateDevice();
  canvas.addEventListener('click', () => {
    if (portDevice.value === 'mouse' && document.pointerLockElement !== canvas) void canvas.requestPointerLock();
  });
  canvas.addEventListener('contextmenu', event => { if (portDevice.value === 'mouse') event.preventDefault(); });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    mouseHint.hidden = mouseRelease.hidden = !locked;
    if (!locked) releaseButtons();
  });
  mouseRelease.addEventListener('click', () => document.exitPointerLock());
  window.addEventListener('keydown', event => {
    if (document.pointerLockElement === canvas && event.ctrlKey && event.altKey && event.code === 'KeyM') {
      event.preventDefault(); event.stopImmediatePropagation(); document.exitPointerLock();
    }
  }, true);
  document.addEventListener('mousemove', event => {
    if (document.pointerLockElement === canvas) { mouseDx += event.movementX; mouseDy += event.movementY; }
  });
  for (const type of ['mousedown', 'mouseup'] as const) document.addEventListener(type, event => {
    if (document.pointerLockElement !== canvas || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault(); proxy.mouseButton(event.button === 2, type === 'mousedown');
  });
  window.addEventListener('blur', releaseButtons);
  const flushMouse = () => {
    if (mouseDx || mouseDy) { proxy.moveMouse(Math.trunc(mouseDx), Math.trunc(mouseDy)); mouseDx = mouseDy = 0; }
    requestAnimationFrame(flushMouse);
  };
  requestAnimationFrame(flushMouse);

  initVirtualKeyboard(keyboard.setVirtualKey, display.update);
  initPasteUi((text) => proxy.execApi('paste_text', { text }));

  canvas.addEventListener('click', () => canvas.focus());

  // 自動操作API(docs/API-DESIGN.md)の入口。原則は Worker側(public/api-dispatch.js)へ
  // 転送するだけ(第5節)。例外として、メインスレッドにしか無い IndexedDB を扱う
  // list_states(UIスロット分の合流)・load_state("ui:N")・list_disk_library・persist_disks
  // とブラウザ側の perf は createBridgeHost(src/bridge.ts)が受け持つ。バイト列は外へ返さない。
  const samplePerf = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const seconds = args.seconds === undefined ? 5 : args.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30) throw new Error('secondsは0より大きく30以下の数値です');
    const start = performance.now(), coreStart = perfCoreFrames, drawStart = perfDrawTotal;
    const queues: number[] = [], intervals: number[] = [];
    const listener = (ms: number) => queues.push(ms);
    queueListeners.add(listener);
    let raf = 0, previous: number | null = null;
    const frame = (time: number) => {
      if (previous !== null && time > previous) intervals.push(time - previous);
      previous = time; raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    try { await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000)); }
    finally { cancelAnimationFrame(raf); queueListeners.delete(listener); }
    const wallMs = performance.now() - start;
    const coreFrames = Math.max(0, perfCoreFrames - coreStart), runFps = coreFrames * 1000 / wallMs;
    intervals.sort((a, b) => a - b);
    const middle = Math.floor(intervals.length / 2);
    const median = intervals.length ? (intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2) : null;
    return { ok: true, coreFrames, wallMs, runFps, targetFps: perfHz || null,
      ratio: perfHz ? runFps / perfHz : null, drawFps: (perfDrawTotal - drawStart) * 1000 / wallMs,
      audioQueueMs: { avg: queues.length ? queues.reduce((a, b) => a + b, 0) / queues.length : null,
        min: queues.length ? Math.min(...queues) : null, max: queues.length ? Math.max(...queues) : null },
      audioSampleRate: audio.sampleRate, coreSampleRate, paused, audioPacing,
      devicePixelRatio: window.devicePixelRatio, refreshHz: median ? 1000 / median : null, appliedCoreOptions: { ...appliedCoreOptions } };
  };
  const bridge = new Bridge(createBridgeHost(proxy, diskPanel, samplePerf));
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

function initPasteUi(paste: (text: string) => Promise<Record<string, unknown>>): void {
  const panel = document.querySelector<HTMLElement>('#paste-panel')!;
  const input = document.querySelector<HTMLTextAreaElement>('#paste-text')!;
  const send = document.querySelector<HTMLButtonElement>('#paste-send')!;
  const cancel = document.querySelector<HTMLButtonElement>('#paste-cancel')!;
  const status = document.querySelector<HTMLElement>('#paste-status')!;
  let sending = false, cancelled = false;
  document.querySelector<HTMLButtonElement>('#paste-open')!.addEventListener('click', () => {
    panel.hidden = false; input.focus();
  });
  cancel.addEventListener('click', () => {
    if (sending) { cancelled = true; cancel.disabled = true; }
    else panel.hidden = true;
  });
  send.addEventListener('click', () => {
    if (sending) return;
    void (async () => {
      sending = true; cancelled = false; send.disabled = true; input.disabled = true;
      cancel.textContent = '中止';
      const chars = Array.from(input.value.replace(/\r\n?/g, '\n'));
      const skipped: string[] = [];
      let sent = 0;
      status.textContent = `送信済み ${sent} / ${chars.length}`;
      try {
        for (const ch of chars) {
          if (cancelled) break;
          const result = await paste(ch);
          if (result.error) throw new Error(String(result.error));
          if (Array.isArray(result.skipped)) skipped.push(...result.skipped as string[]);
          sent += Number(result.sent) || 0;
          status.textContent = `送信済み ${sent} / ${chars.length}`;
        }
        status.textContent += cancelled ? '（中止）' : '（完了）';
        if (skipped.length) status.textContent += `\n送れなかった文字: ${skipped.join('、')}`;
      } catch (error) {
        status.textContent += `\n送信に失敗しました: ${String(error)}`;
      } finally {
        sending = false; send.disabled = false; input.disabled = false; cancel.disabled = false; cancel.textContent = 'キャンセル';
      }
    })();
  });
}
