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
//   受信: {type:'init', bundled:[{name,bytes:ArrayBuffer}], user:[{name,bytes:ArrayBuffer}]}
//        / {type:'key',code,pressed} / {type:'reset'}
//        / {type:'setKeyHoldMinPolls',minPolls}(デバッグ用。詳細はkey-hold-tracker.js)
//        / {type:'mode'}(デバッグ用。現在のモードを問い合わせる)
//        / {type:'ram_read',requestId,region,offset,len} / {type:'ram_write',requestId,region,offset,bytes}
//          (デバッグ用。制限モードでは常に拒否される。docs/API-DESIGN.md 第3-4節)
//        / {type:'apiExec', requestId, cmd, args}(自動操作API本体。実装は
//          public/api-dispatch.js に集約。ここは ctx を組み立てて渡すだけ)
//        / {type:'disk', requestId, op:'insert'|'eject'|'dump'|'poll', drive(0/1), name?, bytes?}
//          (UIのディスク操作。実体は public/disk-host.js)
//   送信: {type:'ready',width,height,fps,mode} / {type:'frame',width,height,pitch,buffer} / {type:'error',message}
//        / {type:'mode',mode} / {type:'ram_read_result',requestId,data?,error?}
//        / {type:'ram_write_result',requestId,ok,error?}
//        / {type:'apiExecResult', requestId, result}
//        / {type:'diskResult', requestId, ok, error?, gen?, had?, bytes?, drives?}
//   (frame には lamp=アクセスランプのビットマスクが付く)
//
// mode = {restricted, roms:[{role,name,origin}], unresolved:[{name,origin}]}
//
// 出どころ制限(docs/API-DESIGN.md 第3節)の一方向掛け金は二重に持つ:
//   - このファイルの `restricted` 変数(JS側)。true にする代入はここ1箇所のみ
//     (handleInit内)。false に戻す経路は作らない。
//   - コア(wasm)側の webq88_is_restricted()(core/shim/webq88_shim.c)。
//     こちらも webq88_restrict() でしか true にならず、戻す関数は無い。
// ROM の役割判定・出どころマージは public/rom-roles.js (Workerとスモークテスト
// scripts/smoke-mode.cjs で共有、ロジックを二重化しない)。

'use strict';

// core-worker.js 自身のURLを基準に読み込む。
// (Viteの base:'./' でサブパス配信されても、worker script自身のURLは
//  常に正しいディレクトリを指しているので相対パスで解決できる)
importScripts('core/q88_libretro.js');
importScripts('key-hold-tracker.js');
importScripts('rom-roles.js');
importScripts('char-map.js');
importScripts('api-dispatch.js');
importScripts('disk-host.js');

// --- libretro 定数 ---
var RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
var RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
var RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
var RETRO_ENVIRONMENT_GET_VARIABLE = 15;
var RETRO_DEVICE_KEYBOARD = 3;

var MAX_CATCHUP_FRAMES = 4; // タブ非表示から復帰した際に一気に追いつきすぎない上限
var FALLBACK_FPS = 60;

var portMouse = false;
var mouseButtons = [[], []];
var moduleInstance = null;
var coreOptions = { q88_sound_board: 'OPNA' };
var disks = null; // WebQ88DiskHost.create(M)(public/disk-host.js)。コア起動後に作る
var lampAcc = 0; // 直近のframe送信以降に点いたアクセスランプ(bit0=ドライブ1, bit1=ドライブ2)
// 既定2ポーリング: ../PC88Behavior 系メモ「最低2ポーリングは押下を保つ」を踏まえた値。
// scripts/smoke-app.cjs の1フレーム内打鍵テストで N=1 では取りこぼす条件を作れず
// (1回でも観測できれば十分なケースがある一方、N=2以上でないと陰性対照との差が
// 安定して出ない構成があったため)、実測で効くと確認済みの2を採用する。
// 0 を渡すと保留を無効化し、対策前の即時反映(Setと同じ)に戻る(陰性対照用)。
var keyHoldTracker = new KeyHoldTracker(2);
var executedFrames = 0;
var lastVideoFrame = null; // {width,height,pitch,buffer:Uint8Array}
var lastFrameForApi = null; // 画面配信用とは別に保持する最新フレーム(screenshot用。tickでnull化しない)
var fps = FALLBACK_FPS;
var loopTimer = null;
var lastTickMs = 0;
var accumulatedMs = 0;
var paused = false;
var unsupported = null;
var guardEnabled = false;
var guardPollPtr = 0;

async function configureGuard(M, entries) {
  guardEnabled = false;
  if (!M._webq88_guard_enable) return; // Older cores remain disabled.
  M._webq88_guard_enable(0);
  if (romMode.restricted || !entries) return;
  try {
    var response = await fetch(entries.url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var bytes = await response.arrayBuffer();
    if (entries.sha256) {
      var digest = await crypto.subtle.digest('SHA-256', bytes);
      var hash = Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      if (hash !== entries.sha256) throw new Error('sha256 mismatch');
    }
    var data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.version !== 1 || typeof data.source !== 'string' ||
        !Array.isArray(data.main) || !data.main.length || data.main.length > 0x8000 ||
        !data.main.every(function (a, i) { return Number.isInteger(a) && a >= 0 && a < 0x8000 && (!i || a > data.main[i - 1]); })) {
      throw new Error('invalid entries');
    }
    var ptr = M._malloc(data.main.length * 2);
    try {
      M.HEAPU16.set(data.main, ptr >>> 1);
      M._webq88_guard_set_entries(ptr, data.main.length);
      var relays = data.relay_sources;
      if (M._webq88_guard_set_relay_sources && Array.isArray(relays) && relays.length <= 32 &&
          relays.every(function (r) { return Array.isArray(r) && r.length === 2 &&
            Number.isInteger(r[0]) && Number.isInteger(r[1]) &&
            r[0] >= 0x8000 && r[0] < r[1] && r[1] <= 0x10000; })) {
        var relayPtr = M._malloc(relays.length * 8);
        try {
          var relayView = new DataView(M.HEAPU8.buffer, relayPtr, relays.length * 8);
          relays.flat().forEach(function (v, i) { relayView.setUint32(i * 4, v, true); });
          M._webq88_guard_set_relay_sources(relayPtr, relays.length);
        } finally { M._free(relayPtr); }
      }
      M._webq88_guard_enable(1);
      guardEnabled = true;
    } finally { M._free(ptr); }
    if (!guardPollPtr) guardPollPtr = M._malloc(8);
  } catch (err) {
    console.warn('公開入口一覧を読み込めないため、ROM内部呼び出しの検知は無効です。', String(err));
  }
}

function clearUnsupported() {
  unsupported = null;
  keyHoldTracker = new KeyHoldTracker(keyHoldTracker.minPolls);
  postMessage({ type: 'guardCleared' });
}

function resetCore() {
  if (!moduleInstance) return;
  moduleInstance._retro_reset();
  clearUnsupported();
  audioChunks = [];
  if (!paused) startLoop();
}

function pollGuard() {
  var M = moduleInstance;
  if (!guardEnabled || !M._webq88_guard_poll(guardPollPtr, guardPollPtr + 4)) return false;
  var view = new DataView(M.HEAPU8.buffer);
  unsupported = { address: view.getUint32(guardPollPtr, true), source: view.getUint32(guardPollPtr + 4, true) };
  audioChunks = [];
  postMessage({ type: 'unsupported', address: unsupported.address, source: unsupported.source });
  return true;
}
var audioChunks = [];
var audioQueueSeconds = null;
var audioQueueAt = 0;
var audioPacing = false;

// --- 自動操作API(docs/API-DESIGN.md)関連の状態 ---
var pollCount = 0; // retro_input_poll が呼ばれた回数の累計(driveFramesの待ち合わせに使う)
var stateMetadata = Object.create(null);
var stateSlots = Object.create(null); // save_state/load_state のスロット(Worker内メモリのみ。永続化しない)

// --- 出どころ制限(docs/API-DESIGN.md 第3節)の状態 ---
// restricted: 一方向の掛け金。true にする代入は handleInit 内の1箇所のみ。
var restricted = false;
var romMode = { restricted: false, roms: [], unresolved: [] };
var stateRomInfo = [];

function postError(message) {
  postMessage({ type: 'error', message: String(message) });
}

function setupCallbacks(M) {
  var sysPathPtr = M._malloc(64);
  M.stringToUTF8('/sys', sysPathPtr, 64);

  var saveToDiskPtr = M._malloc(16);
  M.stringToUTF8('enabled', saveToDiskPtr, 16);
  // ポインタはコアの寿命中保持する。
  var optionPtrs = Object.create(null);
  Object.keys(coreOptions).forEach(function (key) {
    var value = coreOptions[key];
    var size = value.length * 4 + 1; // 値は ASCII の選択肢だけ
    optionPtrs[key] = M._malloc(size);
    M.stringToUTF8(value, optionPtrs[key], size);
  });

  var envCb = M.addFunction(function (cmd, data) {
    var realCmd = cmd & 0xffff;
    if (realCmd === RETRO_ENVIRONMENT_GET_VARIABLE) {
      // struct retro_variable { const char *key; const char *value; }
      // q88_save_to_disk_image=enabled: ゲストの書き込みをディスクイメージ本体へ直接書かせる。
      // 無効だと上流は save_path の .srm 差分ファイルへ書き、吸い出したイメージに
      // 書き込みが入らない(scripts/smoke-disk.cjs の陰性対照で確認)。
      var keyPtr = new DataView(M.HEAPU8.buffer).getUint32(data, true);
      var key = M.UTF8ToString(keyPtr);
      if (key === 'q88_save_to_disk_image') {
        new DataView(M.HEAPU8.buffer).setUint32(data + 4, saveToDiskPtr, true);
        return 1;
      }
      if (optionPtrs[key]) {
        new DataView(M.HEAPU8.buffer).setUint32(data + 4, optionPtrs[key], true);
        return 1;
      }
      return 0;
    }
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
    var buf = M.HEAPU8.slice(data, data + pitch * height);
    lastVideoFrame = {
      width: width,
      height: height,
      pitch: pitch,
      buffer: buf,
    };
    // screenshot(自動操作API)用に、描画ループのnull化とは独立して保持する。
    lastFrameForApi = { width: width, height: height, pitch: pitch, buffer: buf };
  }, 'viiii');

  var audioSampleCb = M.addFunction(function (left, right) {
    audioChunks.push(new Float32Array([left / 32768, right / 32768]));
  }, 'vii');
  var audioBatchCb = M.addFunction(function (data, frames) {
    if (frames > 0) {
      // HEAP16 はこのビルドでは公開されていないので HEAPU8 の buffer から見る
      var input = new Int16Array(M.HEAPU8.buffer, data, frames * 2);
      var samples = new Float32Array(input.length);
      for (var i = 0; i < input.length; i++) samples[i] = input[i] / 32768;
      audioChunks.push(samples);
    }
    return frames;
  }, 'iii');
  // retro_input_poll はフレームに1回だけ呼ばれる(libretroの仕様)。
  // ここで保留中のキー状態を1ティック進める(詳細はkey-hold-tracker.js)。
  var inputPollCb = M.addFunction(function () {
    keyHoldTracker.beginPoll();
    pollCount++;
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
    var rate = f64[1];
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) rate = 44100;
    return { fps: readFps, width: width, height: height, sampleRate: rate };
  } finally {
    M._free(ptr);
  }
}

function startLoop() {
  clearTimeout(loopTimer);
  if (paused || unsupported) return;
  lastTickMs = performance.now();
  accumulatedMs = 0;
  var frameDurationMs = 1000 / fps;

  function tick() {
    if (paused || unsupported) return;
    var now = performance.now();
    accumulatedMs += now - lastTickMs;
    lastTickMs = now;

    // 音声が動作中の通常起動だけキュー深度を利用する。bridge は壁時計のまま。
    if (audioPacing && audioQueueSeconds !== null && now - audioQueueAt < 250) {
      if (audioQueueSeconds > 0.2) accumulatedMs = Math.min(accumulatedMs, frameDurationMs * 0.9);
      else if (audioQueueSeconds < 0.032) accumulatedMs = Math.max(accumulatedMs, frameDurationMs * 2);
    }
    var ran = 0;
    while (accumulatedMs >= frameDurationMs && ran < MAX_CATCHUP_FRAMES) {
      // 短いクリックも最低1フレームは押下を維持する。
      for (var b = 0; b < 2; b++) if (mouseButtons[b].length) moduleInstance._webq88_mouse_button(b, mouseButtons[b].shift() ? 1 : 0);
      moduleInstance._retro_run();
      executedFrames++;
      if (pollGuard()) return;
      lampAcc |= disks.lampMask();
      accumulatedMs -= frameDurationMs;
      ran++;
    }
    // 追いつききれない分は溜め込まず捨てる(実時間からの単純な累積のみにする)
    if (ran === MAX_CATCHUP_FRAMES) {
      accumulatedMs = 0;
    }

    if (audioChunks.length) {
      var length = 0;
      for (var a = 0; a < audioChunks.length; a++) length += audioChunks[a].length;
      var audio = new Float32Array(length), offset = 0;
      for (var b = 0; b < audioChunks.length; b++) { audio.set(audioChunks[b], offset); offset += audioChunks[b].length; }
      audioChunks = [];
      postMessage({ type: 'audio', buffer: audio.buffer }, [audio.buffer]);
    }
    if (lastVideoFrame) {
      var f = lastVideoFrame;
      lastVideoFrame = null;
      var bufferCopy = f.buffer.slice().buffer;
      postMessage(
        { type: 'frame', width: f.width, height: f.height, pitch: f.pitch, buffer: bufferCopy, lamp: lampAcc, executedFrames: executedFrames },
        [bufferCopy],
      );
      lampAcc = 0;
    }

    loopTimer = setTimeout(tick, frameDurationMs);
  }

  loopTimer = setTimeout(tick, frameDurationMs);
}

/** /sys 配下から、役割の全バリアント名を消す(古いROMが紛れ込んで役割判定を狂わせないため)。 */
function clearSysRoms(M) {
  var known = WebQ88RomRoles.allKnownFilenames();
  for (var i = 0; i < known.length; i++) {
    try {
      M.FS.unlink('/sys/' + known[i]);
    } catch (e) {
      // 存在しなければ無視
    }
  }
}

function writeSysRoms(M, placements) {
  for (var i = 0; i < placements.length; i++) {
    var p = placements[i];
    M.FS.writeFile('/sys/' + p.name, new Uint8Array(p.bytes));
  }
}

/**
 * ROM配置後の共通処理(初回起動・再起動どちらからも呼ぶ)。
 * isReboot=true のときは既存インスタンス上で ROM を差し替えて
 * retro_init → retro_load_game をやり直す(同一Workerインスタンス内での
 * 再起動。docs/API-DESIGN.md 第3節)。
 *
 * 実測により、reboot時に retro_deinit() を挟むと(quasi88_stop() が
 * 内部状態を壊すらしく)再起動後 数フレームで
 * "RuntimeError: null function or function signature mismatch" を
 * 起こすことを確認したため、あえて呼ばない。retro_init() 自身が
 * ROMの再読み込み・主要バッファの再確保・状態リセットを行うため、
 * retro_deinit() を省いても機能上は再起動できる
 * (代償として、reboot のたびに古いバッファが1組ぶん解放されずに残る
 * = 軽いメモリリークが起きるが、ページ再読み込みで解消するため許容する)。
 */
async function finishBoot(M, plan, isReboot, entries) {
  clearTimeout(loopTimer);
  if (M._webq88_guard_enable) M._webq88_guard_enable(0);
  clearUnsupported();
  // ROMをFSに置く「前」に掛け金を掛ける(起動後では遅い)。
  if (restricted) {
    M._webq88_restrict();
  }

  clearSysRoms(M);
  writeSysRoms(M, plan.placements);

  M._retro_init();
  var loaded = M._retro_load_game(0);
  if (!loaded) {
    postError('retro_load_game に失敗しました');
    return;
  }
  if (isReboot) {
    // retro_load_game は全ドライブをイジェクトする。MEMFS 上の(書き込み済みの)中身ごと
    // 挿入し直し、起動用ディスクが入っていれば読めるようもう一度リセットする。
    if (disks.reinsertAll() > 0) {
      M._retro_reset();
    }
  }

  await configureGuard(M, entries);
  M._webq88_port_device(portMouse ? 1 : 0);
  var avInfo = readAvInfo(M);
  fps = avInfo.fps;
  postMessage({ type: 'ready', width: avInfo.width, height: avInfo.height, fps: fps, sampleRate: avInfo.sampleRate, mode: romMode });

  startLoop();
}

function handleInit(bundled, user, entries) {
  var plan = WebQ88RomRoles.planRomPlacement(bundled || [], user || []);
  // 使用するROMの内容も識別し、同名の異なるROMを検出する。
  stateRomInfo = plan.placements.map(function (p) {
    var bytes = new Uint8Array(p.bytes);
    var hash = 2166136261;
    for (var i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return { role: p.role, name: p.name, origin: p.origin, id: (hash >>> 0).toString(16) + ':' + bytes.length };
  }).sort(function (a, b) { return a.role.localeCompare(b.role); });
  // 一方向の掛け金: true にする代入はここだけ。false に戻す経路は作らない。
  if (plan.restricted) {
    restricted = true;
  }
  romMode = {
    restricted: restricted,
    roms: plan.placements.map(function (p) {
      return { role: p.role, name: p.name, origin: p.origin };
    }),
    unresolved: plan.unresolved,
  };

  if (moduleInstance) {
    // 同一Workerインスタンス内での再起動(ページ再読み込み・Worker作り直しではない)。
    finishBoot(moduleInstance, plan, true, entries).catch(function (err) { postError(String(err)); });
    return;
  }

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
    disks = WebQ88DiskHost.create(M);
    try {
      M.FS.mkdir('/sys');
    } catch (e) {
      // 既に存在する場合は無視
    }
    setupCallbacks(M);
    return finishBoot(M, plan, false, entries);
  }).catch(function (err) {
    postError('コア初期化中の例外: ' + (err && err.message ? err.message : String(err)));
  });
}

function handleMode() {
  postMessage({ type: 'mode', mode: romMode });
}

function handleRamRead(msg) {
  var requestId = msg.requestId;
  if (!moduleInstance) {
    postMessage({ type: 'ram_read_result', requestId: requestId, error: 'not booted' });
    return;
  }
  if (restricted) {
    postMessage({
      type: 'ram_read_result',
      requestId: requestId,
      error: 'restricted: official ROM loaded in this session',
    });
    return;
  }
  var M = moduleInstance;
  var len = msg.len >>> 0;
  var dstPtr = M._malloc(len || 1);
  try {
    var rc = M._webq88_ram_read(msg.region | 0, msg.offset >>> 0, len, dstPtr);
    if (rc !== 0) {
      postMessage({
        type: 'ram_read_result',
        requestId: requestId,
        error: 'ram_read failed (invalid region/offset/len, or restricted)',
      });
      return;
    }
    var bytes = M.HEAPU8.slice(dstPtr, dstPtr + len);
    postMessage({ type: 'ram_read_result', requestId: requestId, data: bytes.buffer }, [bytes.buffer]);
  } finally {
    M._free(dstPtr);
  }
}

function handleRamWrite(msg) {
  var requestId = msg.requestId;
  if (!moduleInstance) {
    postMessage({ type: 'ram_write_result', requestId: requestId, ok: false, error: 'not booted' });
    return;
  }
  if (restricted) {
    postMessage({
      type: 'ram_write_result',
      requestId: requestId,
      ok: false,
      error: 'restricted: official ROM loaded in this session',
    });
    return;
  }
  var M = moduleInstance;
  var srcBytes = new Uint8Array(msg.bytes);
  var len = srcBytes.length;
  var srcPtr = M._malloc(len || 1);
  try {
    M.HEAPU8.set(srcBytes, srcPtr);
    var rc = M._webq88_ram_write(msg.region | 0, msg.offset >>> 0, len, srcPtr);
    if (rc !== 0) {
      postMessage({
        type: 'ram_write_result',
        requestId: requestId,
        ok: false,
        error: 'ram_write failed (invalid region/offset/len, or restricted)',
      });
      return;
    }
    postMessage({ type: 'ram_write_result', requestId: requestId, ok: true });
  } finally {
    M._free(srcPtr);
  }
}

/**
 * n ポーリング分進むまで待つ(自動操作APIのdriveFrames)。
 * このWorkerは実時間駆動のstartLoop()が裏で回っているので、ここでは
 * retro_run()を直接呼ばず、pollCountが目標に達するのを待つだけにする
 * (Node側のscripts/smoke-api.cjsはループが無いのでretro_run()を直接呼ぶ。
 * 実行環境の違いはctxに閉じ込め、public/api-dispatch.jsのロジックは共通)。
 */
function driveFrames(n) {
  return new Promise(function (resolve, reject) {
    if (n <= 0) {
      resolve();
      return;
    }
    if (!moduleInstance) {
      reject(new Error('not booted'));
      return;
    }
    var target = pollCount + n;
    var deadline = Date.now() + Math.max(3000, n * 500);
    (function check() {
      if (pollCount >= target) {
        resolve();
        return;
      }
      if (unsupported) {
        reject(new Error('unsupported ROM entry'));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('drive frames timeout (core loop not advancing?)'));
        return;
      }
      setTimeout(check, 4);
    })();
  });
}

/** public/api-dispatch.js の exec() へ渡す ctx を組み立てる。 */
function buildApiCtx() {
  return {
    isBooted: function () {
      return !!moduleInstance;
    },
    getMode: function () {
      return romMode;
    },
    getUnsupported: function () { return unsupported; },
    reset: resetCore,
    press: function (id) {
      keyHoldTracker.press(id);
    },
    release: function (id) {
      keyHoldTracker.release(id);
    },
    driveFrames: driveFrames,
    // マウス(端子の機器がマウスのときだけ効く)。UI と同じ経路でコアへ渡す。
    portIsMouse: function () { return portMouse; },
    mouseMove: function (dx, dy) {
      if (moduleInstance && portMouse) moduleInstance._webq88_mouse_move(dx | 0, dy | 0);
    },
    mouseButton: function (right, down) {
      if (moduleInstance && portMouse) mouseButtons[right ? 1 : 0].push(!!down);
    },
    textCols: function () {
      if (!moduleInstance) return 0;
      return moduleInstance._webq88_text_cols();
    },
    textSnapshot: function () {
      if (!moduleInstance) return new Uint8Array(0);
      var M = moduleInstance;
      var maxLen = 80 * 25;
      var ptr = M._malloc(maxLen);
      try {
        var written = M._webq88_text_snapshot(ptr, maxLen);
        if (written < 0) return new Uint8Array(0);
        return M.HEAPU8.slice(ptr, ptr + written);
      } finally {
        M._free(ptr);
      }
    },
    readMemory: function (region, offset, length) {
      if (!moduleInstance) throw new Error('not booted');
      if (restricted) throw new Error(WebQ88ApiDispatch.RESTRICTED_ERROR);
      var M = moduleInstance;
      var len = length >>> 0;
      var ptr = M._malloc(len || 1);
      try {
        var rc = M._webq88_ram_read(region | 0, offset >>> 0, len, ptr);
        if (rc !== 0) throw new Error('ram_read failed (invalid region/offset/len)');
        return M.HEAPU8.slice(ptr, ptr + len);
      } finally {
        M._free(ptr);
      }
    },
    writeMemory: function (region, offset, bytes) {
      if (!moduleInstance) throw new Error('not booted');
      if (restricted) throw new Error(WebQ88ApiDispatch.RESTRICTED_ERROR);
      var M = moduleInstance;
      var len = bytes.length;
      var ptr = M._malloc(len || 1);
      try {
        M.HEAPU8.set(bytes, ptr);
        var rc = M._webq88_ram_write(region | 0, offset >>> 0, len, ptr);
        if (rc !== 0) throw new Error('ram_write failed (invalid region/offset/len)');
      } finally {
        M._free(ptr);
      }
    },
    screenshotRGBA: function () {
      if (!lastFrameForApi) return null;
      var f = lastFrameForApi;
      return {
        width: f.width,
        height: f.height,
        rgba: WebQ88ApiDispatch.rgb565ToRgba(f.buffer, f.pitch, f.width, f.height),
      };
    },
    saveState: function (slot) {
      if (!moduleInstance) throw new Error('not booted');
      var M = moduleInstance;
      var size = M._retro_serialize_size();
      var ptr = M._malloc(size || 1);
      try {
        var ok = M._retro_serialize(ptr, size);
        if (!ok) throw new Error('retro_serialize failed');
        stateSlots[slot] = M.HEAPU8.slice(ptr, ptr + size);
        stateMetadata[slot] = { slot: slot, savedAt: Date.now(), size: size, roms: stateRomInfo.map(function (rom) { return { role: rom.role, name: rom.name, origin: rom.origin }; }) };
        return { size: size };
      } finally {
        M._free(ptr);
      }
    },
    listStates: function () { return Object.keys(stateMetadata).map(function (slot) { return stateMetadata[slot]; }); },
    loadState: function (slot) {
      if (unsupported) throw new Error('非公開ROM入口で停止中です。先にリセットしてください');
      if (!moduleInstance) throw new Error('not booted');
      var saved = stateSlots[slot];
      if (!saved) throw new Error('no saved state in slot: ' + slot);
      var M = moduleInstance;
      var ptr = M._malloc(saved.length || 1);
      try {
        M.HEAPU8.set(saved, ptr);
        var ok = M._retro_unserialize(ptr, saved.length);
        if (!ok) throw new Error('retro_unserialize failed');
        if (M._webq88_guard_enable) M._webq88_guard_enable(guardEnabled ? 1 : 0);
        M._webq88_port_device(portMouse ? 1 : 0);
      } finally {
        M._free(ptr);
      }
    },
    getStateBlob: function (slot) {
      var saved = stateSlots[slot];
      if (!saved) throw new Error('no saved state in slot: ' + slot);
      return saved;
    },
    diskInsert: function (index, name, bytes, image) {
      if (!disks) throw new Error('not booted');
      return disks.insert(index, name, bytes, image);
    },
    diskEject: function (index) {
      if (!disks) throw new Error('not booted');
      return disks.eject(index);
    },
    diskList: function () {
      if (!disks) throw new Error('not booted');
      return disks.list();
    },
    diskDump: function (index) {
      if (!disks) throw new Error('not booted');
      return disks.dump(index);
    },
  };
}

function handleApiExec(msg) {
  var requestId = msg.requestId;
  WebQ88ApiDispatch.exec(buildApiCtx(), msg.cmd, msg.args)
    .then(function (result) {
      postMessage({ type: 'apiExecResult', requestId: requestId, result: result });
    })
    .catch(function (err) {
      postMessage({
        type: 'apiExecResult',
        requestId: requestId,
        result: { error: String((err && err.message) || err) },
      });
    });
}

/**
 * UI(メインスレッド)からのディスク操作。API(insert_disk 等)と同じ disks を使う。
 * 応答は {type:'diskResult', requestId, ...} で、失敗は error に理由を入れる。
 * 転送(transferable)したバッファは送り元で使えなくなるため、dump の結果は
 * ここで別コピーを作って転送する(Worker側の MEMFS には影響しない)。
 */
function handleDisk(msg) {
  var requestId = msg.requestId;
  try {
    if (!disks) throw new Error('not booted');
    switch (msg.op) {
      case 'insert': {
        var res = disks.insert(msg.drive, msg.name, new Uint8Array(msg.bytes), msg.image, msg.key);
        postMessage({ type: 'diskResult', requestId: requestId, ok: true, gen: res.gen, size: res.size, mtime: res.mtime, image: res.image, imageCount: res.imageCount });
        break;
      }
      case 'eject': {
        var ej = disks.eject(msg.drive);
        postMessage({ type: 'diskResult', requestId: requestId, ok: true, had: ej.had });
        break;
      }
      case 'dump': {
        var img = disks.dump(msg.drive);
        postMessage({ type: 'diskResult', requestId: requestId, ok: true, bytes: img.buffer }, [img.buffer]);
        break;
      }
      case 'poll': {
        postMessage({ type: 'diskResult', requestId: requestId, ok: true, drives: disks.poll() });
        break;
      }
      default:
        throw new Error('unknown disk op: ' + msg.op);
    }
  } catch (err) {
    postMessage({ type: 'diskResult', requestId: requestId, ok: false, error: String((err && err.message) || err) });
  }
}

// UI用はMCPのスロットを変更せず、バイト列を直接受け渡す。
function handleState(msg) {
  var response = { type: 'stateResult', requestId: msg.requestId, ok: true };
  try {
    if (!moduleInstance || !disks) throw new Error('未起動です');
    var M = moduleInstance;
    response.info = { roms: stateRomInfo, disks: disks.poll().map(function (d) {
      return { name: d.present ? d.name : null, image: d.present ? d.image : null };
    }) };
    if (msg.op === 'save') {
      var size = M._retro_serialize_size();
      if (!size) throw new Error('保存できません');
      var ptr = M._malloc(size);
      if (!ptr) throw new Error('メモリを確保できません');
      try {
        if (!M._retro_serialize(ptr, size)) throw new Error('保存できません');
        response.bytes = M.HEAPU8.slice(ptr, ptr + size).buffer;
      } finally { M._free(ptr); }
    } else if (msg.op === 'load') {
      if (unsupported) throw new Error('非公開ROM入口で停止中です。先にリセットしてください');
      var bytes = new Uint8Array(msg.bytes);
      if (!bytes.length) throw new Error('データが空です');
      var loadPtr = M._malloc(bytes.length);
      if (!loadPtr) throw new Error('メモリを確保できません');
      try {
        M.HEAPU8.set(bytes, loadPtr);
        if (!M._retro_unserialize(loadPtr, bytes.length)) throw new Error('復元できません');
        if (M._webq88_guard_enable) M._webq88_guard_enable(guardEnabled ? 1 : 0);
        M._webq88_port_device(portMouse ? 1 : 0);
      } finally { M._free(loadPtr); }
    }
    postMessage(response, response.bytes ? [response.bytes] : []);
  } catch (err) {
    postMessage({ type: 'stateResult', requestId: msg.requestId, ok: false, error: String((err && err.message) || err) });
  }
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'init':
      if (!moduleInstance) coreOptions = Object.assign({ q88_sound_board: 'OPNA' }, msg.coreOptions || {});
      handleInit(msg.bundled, msg.user, msg.entries);
      break;
    case 'portDevice':
      mouseButtons = [[], []];
      portMouse = !!msg.mouse;
      if (moduleInstance) moduleInstance._webq88_port_device(portMouse ? 1 : 0);
      break;
    case 'mouseMove':
      if (moduleInstance && portMouse) moduleInstance._webq88_mouse_move(msg.dx | 0, msg.dy | 0);
      break;
    case 'mouseButton':
      if (moduleInstance && portMouse) mouseButtons[msg.right ? 1 : 0].push(!!msg.down);
      break;
    case 'key':
      if (msg.pressed) {
        keyHoldTracker.press(msg.code);
      } else {
        keyHoldTracker.release(msg.code);
      }
      break;
    case 'audioQueue':
      audioPacing = !!msg.enabled;
      audioQueueSeconds = msg.seconds;
      audioQueueAt = performance.now();
      break;
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      accumulatedMs = 0;
      lastTickMs = performance.now();
      startLoop();
      break;
    case 'reset':
      resetCore();
      break;
    case 'setKeyHoldMinPolls':
      // デバッグ/検証用: 0を渡すと保留を無効化する(陰性対照)。
      keyHoldTracker = new KeyHoldTracker(msg.minPolls);
      break;
    case 'mode':
      handleMode();
      break;
    case 'ram_read':
      handleRamRead(msg);
      break;
    case 'ram_write':
      handleRamWrite(msg);
      break;
    case 'apiExec':
      handleApiExec(msg);
      break;
    case 'state':
      handleState(msg);
      break;
    case 'disk':
      handleDisk(msg);
      break;
    default:
      break;
  }
};
