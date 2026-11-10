#!/usr/bin/env node
// scripts/smoke-ext-bank.cjs
//
// TEST_SHIM=1 でビルドした試験用コアで、拡張ROMバンク切り替え時に
// CPUから見える 0x6000-0x7FFF に該当バンクが実際に見えることを確認する。
// 試験ビルド専用の webq88_test_window_read() を使う(配布ビルドには存在しない)。
// バイト列の中身は一切出力しない(一致バイト数・不一致オフセットのみ)。
//
// 使い方:
//   node scripts/smoke-ext-bank.cjs <試験coreディレクトリ> <ROMディレクトリ>
//   node scripts/smoke-ext-bank.cjs <試験coreディレクトリ> <ROMディレクトリ> --omit N88_2.ROM
//
// 判定:
//   - bank=0..3 で読んだ8KBが ROMディレクトリ/N88_n.ROM と一致
//   - bank=-1(既定状態)で読んだ8KBが N88.ROM の 0x6000-0x7FFF と一致
//   - バンク切り替え後、もう一度 bank=-1 を読んで misc_ctrl/ext_rom_bank が
//     元に戻っていることを確認(N88.ROM側と再度一致)
//   - 読み終えた後さらに数十フレーム回してクラッシュしないこと
//   --omit <ファイル名> 指定時(陰性対照): 当該ファイルを /sys に置かずに起動し、
//     そのバンクの窓が全 0xFF、他バンクは一致することを期待する。

const path = require('path');
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);
let coreDir = null;
let romDir = null;
let omit = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--omit') {
    omit = args[++i];
  } else if (!coreDir) {
    coreDir = args[i];
  } else if (!romDir) {
    romDir = args[i];
  }
}

if (!coreDir || !romDir) {
  console.error('使い方: node scripts/smoke-ext-bank.cjs <試験coreディレクトリ> <ROMディレクトリ> [--omit <ファイル名>]');
  process.exit(1);
}

const WINDOW_SIZE = 0x2000;
const EXTRA_FRAMES = 300;
const POST_FRAMES = 60;

function compare(a, b) {
  if (a.length !== b.length) return { match: false, offset: 0 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { match: false, offset: i };
  }
  return { match: true, offset: -1 };
}

function allFF(a) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== 0xff) return { match: false, offset: i };
  }
  return { match: true, offset: -1 };
}

async function main() {
  const Q88 = require(path.join(path.resolve(coreDir), 'q88_libretro.js'));

  // ROMディレクトリをそのまま /sys に使うと --omit で元ファイルを壊しかねないので、
  // 一時ディレクトリへコピーしてから該当ファイルだけ間引く。
  const tmpRomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webq88-ext-bank-'));
  for (const f of fs.readdirSync(romDir)) {
    if (omit && f === omit) continue;
    if (!fs.statSync(path.join(romDir, f)).isFile()) continue;
    fs.copyFileSync(path.join(romDir, f), path.join(tmpRomDir, f));
  }

  const n88Rom = fs.readFileSync(path.join(romDir, 'N88.ROM'));
  const n88RomWindow = n88Rom.subarray(0x6000, 0x8000);
  const bankFiles = [
    path.join(romDir, 'N88_0.ROM'),
    path.join(romDir, 'N88_1.ROM'),
    path.join(romDir, 'N88_2.ROM'),
    path.join(romDir, 'N88_3.ROM'),
  ];

  const M = await Q88();

  const sysPath = M._malloc(64);
  M.stringToUTF8('/sys', sysPath, 64);
  M.FS.mkdir('/sys');
  for (const f of fs.readdirSync(tmpRomDir)) {
    M.FS.writeFile('/sys/' + f, fs.readFileSync(path.join(tmpRomDir, f)));
  }

  const env = M.addFunction((cmd, data) => {
    cmd &= 0xffff;
    if (cmd === 9 || cmd === 31) {
      new DataView(M.HEAPU8.buffer).setUint32(data, sysPath, true);
      return 1;
    }
    return 0;
  }, 'iii');

  M._retro_set_environment(env);
  M._retro_set_video_refresh(M.addFunction(() => {}, 'viiii'));
  M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
  M._retro_set_audio_sample_batch(M.addFunction((d, n) => n, 'iii'));
  M._retro_set_input_poll(M.addFunction(() => {}, 'v'));
  M._retro_set_input_state(M.addFunction(() => 0, 'iiiii'));

  M._retro_init();
  const loaded = M._retro_load_game(0);
  if (!loaded) {
    console.log('RESULT=FAIL: retro_load_game が失敗しました');
    process.exit(1);
  }

  for (let i = 0; i < EXTRA_FRAMES; i++) M._retro_run();

  if (typeof M._webq88_test_window_read !== 'function') {
    console.log('RESULT=FAIL: webq88_test_window_read がエクスポートされていません(TEST_SHIM=1でビルドしたコアか確認)');
    process.exit(1);
  }

  const dstPtr = M._malloc(WINDOW_SIZE);

  function readWindow(bank) {
    const rc = M._webq88_test_window_read(bank, dstPtr);
    if (rc !== 0) {
      throw new Error(`webq88_test_window_read(${bank}) が失敗しました(rc=${rc})`);
    }
    return M.HEAPU8.slice(dstPtr, dstPtr + WINDOW_SIZE);
  }

  let fail = null;
  const details = [];

  // 既定状態(bank=-1): 拡張ROM未選択のはず。N88.ROMの0x6000-0x7FFFと一致すること。
  const defaultWindow = readWindow(-1);
  {
    const r = compare(defaultWindow, n88RomWindow);
    details.push(`bank=-1(既定): match=${r.match} matchedBytes=${r.match ? WINDOW_SIZE : r.offset} firstDiffOffset=${r.offset}`);
    if (!r.match) fail = fail || `bank=-1(既定)がN88.ROMの0x6000-0x7FFFと不一致(offset=${r.offset})`;
  }

  // bank=0..3
  for (let bank = 0; bank < 4; bank++) {
    const w = readWindow(bank);
    const isOmitted = omit === `N88_${bank}.ROM`;
    let r;
    if (isOmitted) {
      r = allFF(w);
      details.push(`bank=${bank}(omit対照): allFF=${r.match} firstDiffOffset=${r.offset}`);
      if (!r.match) fail = fail || `bank=${bank}は--omit指定で全0xFFのはずが不一致(offset=${r.offset})`;
    } else {
      const expected = fs.readFileSync(bankFiles[bank]);
      r = compare(w, expected);
      details.push(`bank=${bank}: match=${r.match} matchedBytes=${r.match ? WINDOW_SIZE : r.offset} firstDiffOffset=${r.offset}`);
      if (!r.match) fail = fail || `bank=${bank}がN88_${bank}.ROMと不一致(offset=${r.offset})`;
    }
  }

  // 切り替え後、misc_ctrl/ext_rom_bankが元に戻っているか(再度bank=-1を読んで確認)
  const defaultWindowAfter = readWindow(-1);
  {
    const r = compare(defaultWindowAfter, n88RomWindow);
    details.push(`bank=-1(復帰確認): match=${r.match} firstDiffOffset=${r.offset}`);
    if (!r.match) fail = fail || `バンク切り替え後にbank=-1へ戻らない(misc_ctrl/ext_rom_bankが復元されていない, offset=${r.offset})`;
  }

  // 読み終えた後もクラッシュしないこと
  let crashed = false;
  try {
    for (let i = 0; i < POST_FRAMES; i++) M._retro_run();
  } catch (e) {
    crashed = true;
    fail = fail || `読み取り後のretro_runで例外: ${e && e.message ? e.message : String(e)}`;
  }
  details.push(`postFramesCrashed=${crashed}`);

  M._free(dstPtr);
  M._free(sysPath);
  fs.rmSync(tmpRomDir, { recursive: true, force: true });

  console.log(`omit=${omit || 'none'} ${details.join(' | ')}`);

  if (fail) {
    console.log('RESULT=FAIL: ' + fail);
    process.exit(1);
  } else {
    console.log('RESULT=PASS');
    process.exit(0);
  }
}

main().catch((err) => {
  console.log('RESULT=FAIL: 例外: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
