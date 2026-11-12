#!/usr/bin/env node
// 第1水準 JIS 0x3021「亜」を、試験用シムから OUT/IN で読む。
// --omit は KANJI1.ROM を除く陰性対照。配布用コアにはシムを含めない。
const fs = require('fs');
const path = require('path');
const [coreDir, romDir, option] = process.argv.slice(2);
if (!coreDir || !romDir || (option && option !== '--omit')) {
  throw new Error('使い方: node scripts/smoke-cjk-font.cjs <試験core> <ROMディレクトリ> [--omit]');
}
(async () => {
  const M = await require(path.join(path.resolve(coreDir), 'q88_libretro.js'))();
  const sys = M._malloc(64);
  M.stringToUTF8('/sys', sys, 64);
  M.FS.mkdir('/sys');
  for (const f of fs.readdirSync(romDir)) {
    if (option && f === 'KANJI1.ROM') continue;
    if (fs.statSync(path.join(romDir, f)).isFile()) M.FS.writeFile('/sys/' + f, fs.readFileSync(path.join(romDir, f)));
  }
  M._retro_set_environment(M.addFunction((cmd, data) => {
    if ((cmd & 0xffff) === 9 || (cmd & 0xffff) === 31) {
      new DataView(M.HEAPU8.buffer).setUint32(data, sys, true); return 1;
    }
    return 0;
  }, 'iii'));
  M._retro_set_video_refresh(M.addFunction(() => {}, 'viiii'));
  M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
  M._retro_set_audio_sample_batch(M.addFunction((d, n) => n, 'iii'));
  M._retro_set_input_poll(M.addFunction(() => {}, 'v'));
  M._retro_set_input_state(M.addFunction(() => 0, 'iiiii'));
  M._retro_init();
  if (!M._retro_load_game(0)) throw new Error('retro_load_game 失敗');
  if (typeof M._webq88_test_kanji_read !== 'function') throw new Error('試験用シムがありません');
  let nonzero = 0;
  for (let row = 0; row < 16; row++) {
    const value = M._webq88_test_kanji_read(0x6010 + row);
    if (value < 0) throw new Error('ポート読み取り失敗');
    if (value !== 0) nonzero++;
  }
  const ok = option ? nonzero === 0 : nonzero > 0;
  console.log(`漢字 ROM ${option ? '陰性' : '陽性'}: 非ゼロ行数=${nonzero} RESULT=${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
