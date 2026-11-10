#!/usr/bin/env node
// scripts/smoke-core.cjs
//
// ビルドした q88_libretro.js を Node 上で動かし、最低限の動作確認をする。
// 画面の画素・文字は一切出力しない（数値のみ）。
//
// 使い方: node scripts/smoke-core.cjs <coreディレクトリ> <ROMディレクトリ>
//
// 判定:
//   - retro_load_game が真を返すこと
//   - 画面サイズが 640x400 であること
//   - 300フレーム後、RGB565で非ゼロの画素の割合が 0% より大きく 10% 未満であること
//     （フォントが全く読めていないと全セルが白くなり、約80%になる既知の不具合がある）

const path = require('path');

const coreDir = process.argv[2];
const romDir = process.argv[3];

if (!coreDir || !romDir) {
  console.error('使い方: node scripts/smoke-core.cjs <coreディレクトリ> <ROMディレクトリ>');
  process.exit(1);
}

const fs = require('fs');
const Q88 = require(path.join(path.resolve(coreDir), 'q88_libretro.js'));

const EXPECTED_W = 640;
const EXPECTED_H = 400;
const FRAMES = 300;
const MIN_NONZERO_RATIO = 0.0;
const MAX_NONZERO_RATIO = 0.10;

Q88().then((M) => {
  const sysPath = M._malloc(64);
  M.stringToUTF8('/sys', sysPath, 64);
  M.FS.mkdir('/sys');
  for (const f of fs.readdirSync(romDir)) {
    // build_main_rom.py は出力先に作業フォルダ(ext_bank_layout/)も作るので、ファイルだけを渡す。
    if (!fs.statSync(path.join(romDir, f)).isFile()) continue;
    M.FS.writeFile('/sys/' + f, fs.readFileSync(path.join(romDir, f)));
  }

  const env = M.addFunction((cmd, data) => {
    cmd &= 0xffff;
    if (cmd === 9 || cmd === 31) {
      // RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY / GET_SAVE_DIRECTORY
      new DataView(M.HEAPU8.buffer).setUint32(data, sysPath, true);
      return 1;
    }
    return 0;
  }, 'iii');

  let w = 0, h = 0;
  let lastBuf = null;
  let lastPitch = 0;

  const video = M.addFunction((d, W, H, pitch) => {
    if (!d) return;
    w = W;
    h = H;
    lastPitch = pitch;
    lastBuf = M.HEAPU8.slice(d, d + pitch * H);
  }, 'viiii');

  M._retro_set_environment(env);
  M._retro_set_video_refresh(video);
  M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
  M._retro_set_audio_sample_batch(M.addFunction((d, n) => n, 'iii'));
  M._retro_set_input_poll(M.addFunction(() => {}, 'v'));
  M._retro_set_input_state(M.addFunction(() => 0, 'iiiii'));

  M._retro_init();
  const loaded = M._retro_load_game(0);

  for (let i = 0; i < FRAMES; i++) M._retro_run();

  let fail = null;

  if (!loaded) {
    fail = 'retro_load_game が失敗しました';
  } else if (w !== EXPECTED_W || h !== EXPECTED_H) {
    fail = `画面サイズが想定と異なります: ${w}x${h} (期待値 ${EXPECTED_W}x${EXPECTED_H})`;
  } else if (!lastBuf) {
    fail = '映像フレームを受信できませんでした';
  }

  let nonzeroRatio = -1;
  if (!fail) {
    let nonzeroPixels = 0;
    const totalPixels = w * h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const off = y * lastPitch + x * 2;
        const v = lastBuf[off] | (lastBuf[off + 1] << 8);
        if (v !== 0) nonzeroPixels++;
      }
    }
    nonzeroRatio = nonzeroPixels / totalPixels;
    if (!(nonzeroRatio > MIN_NONZERO_RATIO && nonzeroRatio < MAX_NONZERO_RATIO)) {
      fail = `非ゼロ画素の割合が範囲外です: ${(nonzeroRatio * 100).toFixed(2)}% ` +
        `(期待範囲 ${(MIN_NONZERO_RATIO * 100).toFixed(0)}%〜${(MAX_NONZERO_RATIO * 100).toFixed(0)}%)`;
    }
  }

  console.log(`load_game=${!!loaded} size=${w}x${h} nonzeroRatio=${nonzeroRatio >= 0 ? (nonzeroRatio * 100).toFixed(2) + '%' : 'n/a'}`);

  if (fail) {
    console.log('RESULT=FAIL: ' + fail);
    process.exit(1);
  } else {
    console.log('RESULT=PASS');
    process.exit(0);
  }
}).catch((err) => {
  console.log('RESULT=FAIL: 例外: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
