#!/usr/bin/env node
// scripts/smoke-app.cjs
//
// ブラウザ(Worker)を使わずに、アプリと同じ初期化手順を Node 上で通す検証。
// 1. compat-rom/manifest.json の SHA-256 照合（陽性対照・陰性対照）
// 2. ROM を /sys に配置してコアを起動、300フレーム後の非ゼロ画素率が 0〜10%
// 3. 'PRINT 1+1' + Enter 相当の打鍵を input_state 経由で流し込み、
//    打鍵前後で画面が変化すること（変化しなければ入力経路が死んでいる）
// 4. 1フレーム内(retro_runを挟まず)で押して離した打鍵が取りこぼされないこと
//    (public/key-hold-tracker.js の保留ロジックの陽性・陰性対照)
// 5. 同じキーを1フレーム内押し離し×2で、行バッファに2文字入ること(連打対応)
//
// 画面の文字は一切出力しない（数値・ハッシュのみ）。
//
// 使い方: node scripts/smoke-app.cjs <coreディレクトリ> <compat-romディレクトリ>

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const coreDir = process.argv[2];
const romDir = process.argv[3];

if (!coreDir || !romDir) {
  console.error('使い方: node scripts/smoke-app.cjs <coreディレクトリ> <compat-romディレクトリ>');
  process.exit(1);
}

const Q88 = require(path.join(path.resolve(coreDir), 'q88_libretro.js'));
// Worker(public/core-worker.js)と同じ保留ロジックを共有する。二重化しない。
const KeyHoldTracker = require(path.join(path.resolve(__dirname, '..', 'public'), 'key-hold-tracker.js'));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

/** manifest とディレクトリの中身を照合する。全ファイル一致なら true。 */
function verifyAgainstManifest(dir, manifest) {
  for (const f of manifest.files) {
    const p = path.join(dir, f.name);
    if (!fs.existsSync(p)) return { ok: false, reason: `${f.name} が無い` };
    const bytes = fs.readFileSync(p);
    if (bytes.length !== f.size) {
      return { ok: false, reason: `${f.name} のサイズ不一致 (実測${bytes.length} manifest${f.size})` };
    }
    const hex = sha256(bytes);
    if (hex !== f.sha256) {
      return { ok: false, reason: `${f.name} のSHA-256不一致` };
    }
  }
  return { ok: true };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

const RETRO_DEVICE_KEYBOARD = 3;

/**
 * コアを1つ起動し、300フレーム分回して安定させた状態を返す。
 * キー入力は trackerRef.t (差し替え可能な参照) 経由で input_state に渡す。
 * trackerRef.t が null の間は常に「何も押されていない」。
 */
async function bootCore(manifest, trackerRef) {
  const M = await Q88();
  const sysPath = M._malloc(64);
  M.stringToUTF8('/sys', sysPath, 64);
  M.FS.mkdir('/sys');
  for (const f of manifest.files) {
    M.FS.writeFile('/sys/' + f.name, fs.readFileSync(path.join(romDir, f.name)));
  }

  const env = M.addFunction((cmd, data) => {
    const realCmd = cmd & 0xffff;
    if (realCmd === 9 || realCmd === 31) {
      new DataView(M.HEAPU8.buffer).setUint32(data, sysPath, true);
      return 1;
    }
    if (realCmd === 10) return 1; // SET_PIXEL_FORMAT を受理
    return 0;
  }, 'iii');

  let w = 0, h = 0, lastBuf = null, lastPitch = 0;
  const video = M.addFunction((d, W, H, pitch) => {
    if (!d) return;
    w = W; h = H; lastPitch = pitch;
    lastBuf = M.HEAPU8.slice(d, d + pitch * H);
  }, 'viiii');

  M._retro_set_environment(env);
  M._retro_set_video_refresh(video);
  M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
  M._retro_set_audio_sample_batch(M.addFunction((_d, n) => n, 'iii'));
  // retro_input_poll はフレームに1回だけ呼ばれる(libretroの仕様)。
  // Workerと同じくここでtrackerを1ティック進める。
  M._retro_set_input_poll(M.addFunction(() => {
    if (trackerRef.t) trackerRef.t.beginPoll();
  }, 'v'));
  M._retro_set_input_state(M.addFunction((_port, device, _index, id) => {
    if (device === RETRO_DEVICE_KEYBOARD && trackerRef.t) {
      return trackerRef.t.isPressed(id) ? 1 : 0;
    }
    return 0;
  }, 'iiiii'));

  M._retro_init();
  const loaded = M._retro_load_game(0);
  if (!loaded) return { M: null, loaded: false };

  const BASELINE_FRAMES = 300;
  for (let i = 0; i < BASELINE_FRAMES; i++) M._retro_run();

  return {
    M,
    loaded: true,
    getWH: () => ({ w, h }),
    sig: () => sha256(lastBuf),
    nonzeroRatio: () => {
      let nz = 0;
      const total = w * h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const off = y * lastPitch + x * 2;
          const v = lastBuf[off] | (lastBuf[off + 1] << 8);
          if (v !== 0) nz++;
        }
      }
      return nz / total;
    },
  };
}

async function main() {
  // --- 1. manifest 照合 ---
  const manifest = loadManifest(romDir);

  const positive = verifyAgainstManifest(romDir, manifest);
  check('manifest 陽性対照(正規ファイルは一致)', positive.ok, positive.reason);

  const tamperedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webq88-tamper-'));
  try {
    for (const f of manifest.files) {
      fs.copyFileSync(path.join(romDir, f.name), path.join(tamperedDir, f.name));
    }
    // 1ファイルの1バイトを書き換える（リポジトリのファイルはコピーなので無傷）
    const targetName = manifest.files[0].name;
    const targetPath = path.join(tamperedDir, targetName);
    const bytes = fs.readFileSync(targetPath);
    bytes[0] = bytes[0] ^ 0xff;
    fs.writeFileSync(targetPath, bytes);

    const negative = verifyAgainstManifest(tamperedDir, manifest);
    check('manifest 陰性対照(改ざんは拒否される)', !negative.ok);
  } finally {
    fs.rmSync(tamperedDir, { recursive: true, force: true });
  }

  if (!positive.ok) {
    console.log('RESULT=FAIL: manifest照合に失敗したためコア起動を中止');
    process.exit(1);
  }

  // --- 2〜3. コア起動・通常の打鍵(複数フレーム保持)で画面が変化するか ---
  const mainTrackerRef = { t: new KeyHoldTracker(2) };
  const core = await bootCore(manifest, mainTrackerRef);
  check('retro_load_game', core.loaded);
  if (!core.loaded) {
    console.log('RESULT=FAIL: retro_load_game 失敗');
    process.exit(1);
  }

  const { w, h } = core.getWH();
  check('画面サイズ', w === 640 && h === 400, `${w}x${h}`);

  const baselineRatio = core.nonzeroRatio();
  check(
    '非ゼロ画素率(0%より大きく10%未満)',
    baselineRatio > 0 && baselineRatio < 0.1,
    `${(baselineRatio * 100).toFixed(2)}%`,
  );
  const baselineSig = core.sig();

  // RETROK: P=112 R=114 I=105 N=110 T=116 SPACE=32 '1'=49 KP_PLUS=270 RETURN=13
  const sequence = [112, 114, 105, 110, 116, 32, 49, 270, 49, 13];
  const FRAMES_PER_KEY_DOWN = 6;
  const FRAMES_PER_KEY_GAP = 4;

  for (const code of sequence) {
    mainTrackerRef.t.press(code);
    for (let i = 0; i < FRAMES_PER_KEY_DOWN; i++) core.M._retro_run();
    mainTrackerRef.t.release(code);
    for (let i = 0; i < FRAMES_PER_KEY_GAP; i++) core.M._retro_run();
  }
  // BASIC の処理・再描画が追いつくよう少し余分に回す
  for (let i = 0; i < 60; i++) core.M._retro_run();

  const afterRatio = core.nonzeroRatio();
  const afterSig = core.sig();
  check(
    '打鍵後に画面が変化した(signature不一致)',
    afterSig !== baselineSig,
    `前=${baselineSig.slice(0, 8)} 後=${afterSig.slice(0, 8)} 非ゼロ率 前${(baselineRatio * 100).toFixed(2)}%→後${(afterRatio * 100).toFixed(2)}%`,
  );

  // --- 4〜5. 1フレーム内(押してすぐ離す)打鍵の取りこぼし対策 ---
  //
  // 画面には点滅カーソルがあり、無入力でも数十フレームおきに署名が変わる。
  // 「1回の前後比較」では点滅のタイミング差を取りこぼしと誤認しうるため、
  // 「無入力のまま同じフレーム数だけ回した対照ラン」と「入力ありで同じ
  // フレーム数だけ回したラン」を、新しく起動したコアどうしで比較する
  // (同一入力列なら決定論的に同じ署名になる前提)。
  const SETTLE_FRAMES = 60;
  const TAP_CODE = 97; // RETROK 'a'

  async function runControl() {
    const ref = { t: null };
    const c = await bootCore(manifest, ref);
    for (let i = 0; i < SETTLE_FRAMES; i++) c.M._retro_run();
    return c.sig();
  }

  async function runTap(minPolls, doubleTap) {
    const ref = { t: new KeyHoldTracker(minPolls) };
    const c = await bootCore(manifest, ref);
    ref.t.press(TAP_CODE);
    ref.t.release(TAP_CODE); // ここまでretro_runを挟まない = 1フレーム内の押して離す
    if (doubleTap) {
      ref.t.press(TAP_CODE);
      ref.t.release(TAP_CODE);
    }
    for (let i = 0; i < SETTLE_FRAMES; i++) c.M._retro_run();
    return c.sig();
  }

  const controlSig = await runControl();

  // 陰性対照: 保留を無効化(minPolls=0)すると、対策前と同じく取りこぼされ、
  // 無入力の対照ランと画面が一致してしまうはず。
  const negativeSig = await runTap(0, false);
  check(
    '陰性対照: 保留無効化(N=0)だと1フレーム内タップは取りこぼされる',
    negativeSig === controlSig,
    negativeSig === controlSig ? '対照と一致(想定通り取りこぼし再現)' : '対照と不一致(取りこぼしを再現できていない=試験が壊れている)',
  );

  // 陽性対照: 保留を有効化(minPolls=2)すると、1フレーム内タップでも
  // 押下が最低2ポーリング観測されるので取りこぼされない。
  // N=2はscripts外の実測(experiment-n2.cjs相当)でN=0,1では取りこぼされ
  // N=2から確実に取りこぼされなくなることを確認した最小値。
  const positiveSig = await runTap(2, false);
  check(
    '陽性対照: 保留有効化(N=2)なら1フレーム内タップが反映される',
    positiveSig !== controlSig,
    positiveSig !== controlSig ? '対照と不一致(反映された)' : '対照と一致(取りこぼされたまま=NG)',
  );

  // 連打: 同じキーを1フレーム内で押し離し×2 →
  // 1回押しと2回押しで行バッファの内容が変わり、画面署名も変わるはず。
  const doubleSig = await runTap(2, true);
  check(
    '連打: 1フレーム内押し離し×2は1回押しと異なる結果になる(2文字入る)',
    doubleSig !== positiveSig && doubleSig !== controlSig,
    `1回=${positiveSig.slice(0, 8)} 2回=${doubleSig.slice(0, 8)} 対照=${controlSig.slice(0, 8)}`,
  );

  if (failures > 0) {
    console.log(`RESULT=FAIL: ${failures}件の検証に失敗`);
    process.exit(1);
  }
  console.log('RESULT=PASS');
  process.exit(0);
}

main().catch((err) => {
  console.log('RESULT=FAIL: 例外: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
