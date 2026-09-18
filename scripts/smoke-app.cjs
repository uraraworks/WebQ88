#!/usr/bin/env node
// scripts/smoke-app.cjs
//
// ブラウザ(Worker)を使わずに、アプリと同じ初期化手順を Node 上で通す検証。
// 1. compat-rom/manifest.json の SHA-256 照合（陽性対照・陰性対照）
// 2. ROM を /sys に配置してコアを起動、300フレーム後の非ゼロ画素率が 0〜10%
// 3. 'PRINT 1+1' + Enter 相当の打鍵を input_state 経由で流し込み、
//    打鍵前後で画面が変化すること（変化しなければ入力経路が死んでいる）
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

  // --- 2. コア起動 ---
  const M = await Q88();
  const sysPath = M._malloc(64);
  M.stringToUTF8('/sys', sysPath, 64);
  M.FS.mkdir('/sys');
  for (const f of manifest.files) {
    M.FS.writeFile('/sys/' + f.name, fs.readFileSync(path.join(romDir, f.name)));
  }

  const RETRO_DEVICE_KEYBOARD = 3;
  const pressedKeys = new Set();

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
  M._retro_set_input_poll(M.addFunction(() => {}, 'v'));
  M._retro_set_input_state(M.addFunction((_port, device, _index, id) => {
    if (device === RETRO_DEVICE_KEYBOARD) return pressedKeys.has(id) ? 1 : 0;
    return 0;
  }, 'iiiii'));

  M._retro_init();
  const loaded = M._retro_load_game(0);
  check('retro_load_game', !!loaded);
  if (!loaded) {
    console.log('RESULT=FAIL: retro_load_game 失敗');
    process.exit(1);
  }

  const BASELINE_FRAMES = 300;
  for (let i = 0; i < BASELINE_FRAMES; i++) M._retro_run();

  check('画面サイズ', w === 640 && h === 400, `${w}x${h}`);

  function nonzeroRatio() {
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
  }

  const baselineRatio = nonzeroRatio();
  check(
    '非ゼロ画素率(0%より大きく10%未満)',
    baselineRatio > 0 && baselineRatio < 0.1,
    `${(baselineRatio * 100).toFixed(2)}%`,
  );
  const baselineSig = sha256(lastBuf);

  // --- 3. 打鍵で画面が変化するか ---
  // RETROK: P=112 R=114 I=105 N=110 T=116 SPACE=32 '1'=49 KP_PLUS=270 RETURN=13
  const sequence = [112, 114, 105, 110, 116, 32, 49, 270, 49, 13];
  const FRAMES_PER_KEY_DOWN = 6;
  const FRAMES_PER_KEY_GAP = 4;

  for (const code of sequence) {
    pressedKeys.add(code);
    for (let i = 0; i < FRAMES_PER_KEY_DOWN; i++) M._retro_run();
    pressedKeys.delete(code);
    for (let i = 0; i < FRAMES_PER_KEY_GAP; i++) M._retro_run();
  }
  // BASIC の処理・再描画が追いつくよう少し余分に回す
  for (let i = 0; i < 60; i++) M._retro_run();

  const afterRatio = nonzeroRatio();
  const afterSig = sha256(lastBuf);
  check(
    '打鍵後に画面が変化した(signature不一致)',
    afterSig !== baselineSig,
    `前=${baselineSig.slice(0, 8)} 後=${afterSig.slice(0, 8)} 非ゼロ率 前${(baselineRatio * 100).toFixed(2)}%→後${(afterRatio * 100).toFixed(2)}%`,
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
