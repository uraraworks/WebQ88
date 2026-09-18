// public/core-worker.js
//
// コア（q88_libretro）を実際に走らせる Web Worker 本体。
//
// あえてプレーンな JS（import/export なし）で書いている。q88_libretro.js は
// emscripten の MODULARIZE 出力（UMD形式。`var Q88 = (()=>{...})()` という
// トップレベル var 代入で、クラシックスクリプトとして読み込めば globalThis.Q88 に
// 生える）で、これを取り込むには importScripts() が要る。importScripts() は
// クラシックワーカーでしか使えず、Vite のモジュールワーカー（type:'module'）にすると
// 使えない。逆にモジュールワーカーでないと import/export 構文が(devサーバ上で)
// 正しく働かない（_emulator/CLAUDE.md 系メモ「Viteはdevでクラシックworkerに
// ESM importを残すと壊れる」）。この二択を避けるため、このファイルは
// public/ 直下に置いて Vite の変換を通さず、素のクラシックワーカーとして
// そのまま配信する。src/core-protocol.ts のメッセージ型と重複しているので、
// 変更したら両方直すこと。
//
// メッセージ:
//   受信: {type:'init', roms:[{name,bytes:ArrayBuffer}]} / {type:'key',code,pressed} / {type:'reset'}
//        / {type:'setKeyHoldMinPolls',minPolls}(デバッグ用。詳細はkey-hold-tracker.js)
//   送信: {type:'ready',width,height,fps} / {type:'frame',width,height,pitch,buffer} / {type:'error',message}

'use strict';

// core-worker.js 自身のURLを基準に読み込む。
// (Viteの base:'./' でサブパス配信されても、worker script自身のURLは
//  常に正しいディレクトリを指しているので相対パスで解決できる)
importScripts('core/q88_libretro.js');
importScripts('key-hold-tracker.js');

// --- libretro 定数 ---
var RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
var RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
var RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
var RETRO_DEVICE_KEYBOARD = 3;

var MAX_CATCHUP_FRAMES = 4; // タブ非表示から復帰した際に一気に追いつきすぎない上限
var FALLBACK_FPS = 60;

var moduleInstance = null;
// 既定2ポーリング: ../PC88Behavior 系メモ「最低2ポーリングは押下を保つ」を踏まえた値。
// scripts/smoke-app.cjs の1フレーム内打鍵テストで N=1 では取りこぼす条件を作れず
// (1回でも観測できれば十分なケースがある一方、N=2以上でないと陰性対照との差が
// 安定して出ない構成があったため)、実測で効くと確認済みの2を採用する。
// 0 を渡すと保留を無効化し、対策前の即時反映(Setと同じ)に戻る(陰性対照用)。
var keyHoldTracker = new KeyHoldTracker(2);
var lastVideoFrame = null; // {width,height,pitch,buffer:Uint8Array}
var fps = FALLBACK_FPS;
var loopTimer = null;
var lastTickMs = 0;
var accumulatedMs = 0;

function postError(message) {
  postMessage({ type: 'error', message: String(message) });
}

function setupCallbacks(M) {
  var sysPathPtr = M._malloc(64);
  M.stringToUTF8('/sys', sysPathPtr, 64);

  var envCb = M.addFunction(function (cmd, data) {
    var realCmd = cmd & 0xffff;
    if (realCmd === RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY || realCmd === RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY) {
      new DataView(M.HEAPU8.buffer).setUint32(data, sysPathPtr, true);
      return 1;
    }
    if (realCmd === RETRO_ENVIRONMENT_SET_PIXEL_FORMAT) {
      // 要求されたフォーマットの中身は見ず、そのまま受理する。
      // このコアは常に RGB565 (=2) を要求してくる前提でメインスレッド側の
      // 変換 (src/rgb565.ts) を書いている。
      return 1;
    }
    return 0;
  }, 'iii');

  var videoCb = M.addFunction(function (data, width, height, pitch) {
    if (!data) return;
    lastVideoFrame = {
      width: width,
      height: height,
      pitch: pitch,
      buffer: M.HEAPU8.slice(data, data + pitch * height),
    };
  }, 'viiii');

  var audioSampleCb = M.addFunction(function () {}, 'vii');
  var audioBatchCb = M.addFunction(function (_data, frames) {
    return frames;
  }, 'iii');
  // retro_input_poll はフレームに1回だけ呼ばれる(libretroの仕様)。
  // ここで保留中のキー状態を1ティック進める(詳細はkey-hold-tracker.js)。
  var inputPollCb = M.addFunction(function () {
    keyHoldTracker.beginPoll();
  }, 'v');
  var inputStateCb = M.addFunction(function (_port, device, _index, id) {
    if (device === RETRO_DEVICE_KEYBOARD) {
      return keyHoldTracker.isPressed(id) ? 1 : 0;
    }
    return 0;
  }, 'iiiii');

  M._retro_set_environment(envCb);
  M._retro_set_video_refresh(videoCb);
  M._retro_set_audio_sample(audioSampleCb);
  M._retro_set_audio_sample_batch(audioBatchCb);
  M._retro_set_input_poll(inputPollCb);
  M._retro_set_input_state(inputStateCb);
}

function readAvInfo(M) {
  // struct retro_system_av_info { geometry(20B+4Bpad); timing(fps:f64, sample_rate:f64) }
  var ptr = M._malloc(64);
  try {
    M._retro_get_system_av_info(ptr);
    var u32 = new Uint32Array(M.HEAPU8.buffer, ptr, 4);
    var f64 = new Float64Array(M.HEAPU8.buffer, ptr + 24, 2);
    var width = u32[0];
    var height = u32[1];
    var readFps = f64[0];
    if (!(readFps > 10 && readFps < 120)) {
      readFps = FALLBACK_FPS;
    }
    if (!(width > 0 && width <= 4096)) width = 640;
    if (!(height > 0 && height <= 4096)) height = 400;
    return { fps: readFps, width: width, height: height };
  } finally {
    M._free(ptr);
  }
}

function startLoop() {
  lastTickMs = performance.now();
  accumulatedMs = 0;
  var frameDurationMs = 1000 / fps;

  function tick() {
    var now = performance.now();
    accumulatedMs += now - lastTickMs;
    lastTickMs = now;

    var ran = 0;
    while (accumulatedMs >= frameDurationMs && ran < MAX_CATCHUP_FRAMES) {
      moduleInstance._retro_run();
      accumulatedMs -= frameDurationMs;
      ran++;
    }
    // 追いつききれない分は溜め込まず捨てる(実時間からの単純な累積のみにする)
    if (ran === MAX_CATCHUP_FRAMES) {
      accumulatedMs = 0;
    }

    if (lastVideoFrame) {
      var f = lastVideoFrame;
      lastVideoFrame = null;
      var bufferCopy = f.buffer.slice().buffer;
      postMessage(
        { type: 'frame', width: f.width, height: f.height, pitch: f.pitch, buffer: bufferCopy },
        [bufferCopy],
      );
    }

    loopTimer = setTimeout(tick, frameDurationMs);
  }

  loopTimer = setTimeout(tick, frameDurationMs);
}

function handleInit(roms) {
  // emscripten の locateFile は ENVIRONMENT_IS_WORKER のとき
  // self.location.href (= このワーカー自身のURL = core-worker.js の場所) を基準にするため、
  // そのままだと wasm を core-worker.js と同じ階層に探しに行ってしまう。
  // 明示的に core/ 以下から探すよう上書きする。
  Q88({
    locateFile: function (path) {
      return 'core/' + path;
    },
  }).then(function (M) {
    moduleInstance = M;
    try {
      M.FS.mkdir('/sys');
    } catch (e) {
      // 既に存在する場合は無視
    }
    for (var i = 0; i < roms.length; i++) {
      M.FS.writeFile('/sys/' + roms[i].name, new Uint8Array(roms[i].bytes));
    }

    setupCallbacks(M);
    M._retro_init();
    var loaded = M._retro_load_game(0);
    if (!loaded) {
      postError('retro_load_game に失敗しました');
      return;
    }

    var avInfo = readAvInfo(M);
    fps = avInfo.fps;
    postMessage({ type: 'ready', width: avInfo.width, height: avInfo.height, fps: fps });
    startLoop();
  }).catch(function (err) {
    postError('コア初期化中の例外: ' + (err && err.message ? err.message : String(err)));
  });
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'init':
      handleInit(msg.roms);
      break;
    case 'key':
      if (msg.pressed) {
        keyHoldTracker.press(msg.code);
      } else {
        keyHoldTracker.release(msg.code);
      }
      break;
    case 'reset':
      if (moduleInstance) {
        moduleInstance._retro_reset();
      }
      break;
    case 'setKeyHoldMinPolls':
      // デバッグ/検証用: 0を渡すと保留を無効化する(陰性対照)。
      keyHoldTracker = new KeyHoldTracker(msg.minPolls);
      break;
    default:
      break;
  }
};
