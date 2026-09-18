#!/usr/bin/env node
// scripts/smoke-mode.cjs
//
// 出どころ制限モード(docs/API-DESIGN.md 第3節・第6節)の検査。
// 公式ROMは一切使わない(互換ROMのみ)。
//
// public/rom-roles.js (Workerと共有、判定ロジックを二重化しない) を使って
// 出どころ(bundled/user)からモードを決め、そのうえで実際にコア(wasm)を
// Node上で起動し、JS側の一方向掛け金の模擬と、コア(webq88_shim.c)側の
// 独立した掛け金の両方を確認する。
//
// public/core-worker.js 自体はブラウザ(Worker)専用のグローバルAPI
// (importScripts/self.onmessage)に依存するため Node からは直接動かせない。
// ここでは Worker が内部で行っているのと同じ手順
// (WebQ88RomRoles.planRomPlacement → 一方向restricted判定 → ROM配置 →
//  webq88_restrict()を必要ならROM配置前に呼ぶ)を、scripts/smoke-app.cjs と
// 同様に Node 上で直接コアを起動して再現する。
//
// 使い方: node scripts/smoke-mode.cjs [coreディレクトリ] [compat-romディレクトリ]

const path = require('path');
const fs = require('fs');

const coreDir = process.argv[2] || path.join(__dirname, '..', 'public', 'core');
const romDir = process.argv[3] || path.join(__dirname, '..', 'compat-rom');

const Q88 = require(path.join(path.resolve(coreDir), 'q88_libretro.js'));
const RomRoles = require(path.join(path.resolve(__dirname, '..', 'public'), 'rom-roles.js'));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

function loadManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

/** manifest.files を {name, bytes} 配列(rom-roles.js が期待する形)に読み込む。 */
function readAsFiles(dir, manifest) {
  return manifest.files.map((f) => ({ name: f.name, bytes: fs.readFileSync(path.join(dir, f.name)) }));
}

/**
 * scripts/smoke-app.cjs の bootCore と同じ骨格。
 * ROM を /sys に置く「前」に、restricted なら webq88_restrict() を呼ぶ
 * (Worker(public/core-worker.js) の finishBoot と同じ順序)。
 */
async function bootCore(placements, restricted, existing) {
  const M = existing ? existing.M : await Q88();
  if (!existing) {
    const sysPath = M._malloc(64);
    M.stringToUTF8('/sys', sysPath, 64);
    M.FS.mkdir('/sys');

    const env = M.addFunction((cmd, data) => {
      const realCmd = cmd & 0xffff;
      if (realCmd === 9 || realCmd === 31) {
        new DataView(M.HEAPU8.buffer).setUint32(data, sysPath, true);
        return 1;
      }
      if (realCmd === 10) return 1;
      return 0;
    }, 'iii');
    let w = 0, h = 0, lastBuf = null;
    const video = M.addFunction((d, W, H, pitch) => {
      if (!d) return;
      w = W; h = H;
      lastBuf = M.HEAPU8.slice(d, d + pitch * H);
    }, 'viiii');
    M._retro_set_environment(env);
    M._retro_set_video_refresh(video);
    M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
    M._retro_set_audio_sample_batch(M.addFunction((_d, n) => n, 'iii'));
    M._retro_set_input_poll(M.addFunction(() => {}, 'v'));
    M._retro_set_input_state(M.addFunction(() => 0, 'iiiii'));
    existing = { M, getWH: () => ({ w, h }), getBuf: () => lastBuf };
  }

  // ROMをFSに置く「前」に掛け金を掛ける(WorkerのfinishBootと同じ順序)。
  if (restricted) {
    M._webq88_restrict();
  }

  // 既知の全バリアント名を消してから、勝った組だけ書く。
  for (const name of RomRoles.allKnownFilenames()) {
    try {
      M.FS.unlink('/sys/' + name);
    } catch (e) {
      // 無ければ無視
    }
  }
  for (const p of placements) {
    M.FS.writeFile('/sys/' + p.name, new Uint8Array(p.bytes));
  }

  // 実測により、reboot時に retro_deinit() を挟むと再起動後数フレームで
  // "null function" のRuntimeErrorになることを確認したため呼ばない
  // (public/core-worker.js の finishBoot と同じ判断。詳細はそちらのコメント)。
  M._retro_init();
  const loaded = M._retro_load_game(0);
  existing.booted = true;
  existing.loaded = loaded;

  return existing;
}

function ramReadDirect(M, region, offset, len) {
  const ptr = M._malloc(len || 1);
  try {
    const rc = M._webq88_ram_read(region, offset, len, ptr);
    if (rc !== 0) return { rc, data: null };
    return { rc, data: M.HEAPU8.slice(ptr, ptr + len) };
  } finally {
    M._free(ptr);
  }
}

function ramWriteDirect(M, region, offset, bytes) {
  const ptr = M._malloc(bytes.length || 1);
  try {
    M.HEAPU8.set(bytes, ptr);
    return M._webq88_ram_write(region, offset, bytes.length, ptr);
  } finally {
    M._free(ptr);
  }
}

async function main() {
  const manifest = loadManifest(romDir);
  const compatFiles = readAsFiles(romDir, manifest);

  // --- 5. ROM配列を返す口が無いこと(wasmのエクスポート名を列挙) ---
  {
    const M = await Q88();
    const exported = Object.keys(M).filter((k) => k.startsWith('_') && typeof M[k] === 'function');
    const forbidden = exported.filter((name) => /rom|font|kanji|jisho/i.test(name));
    check(
      'ROM/フォント/漢字配列を返す口が無い(exportにrom/font/kanji/jishoを含む関数が無い)',
      forbidden.length === 0,
      forbidden.length > 0 ? '見つかった: ' + forbidden.join(',') : `export数=${exported.length}`,
    );
    const hasShimExports =
      exported.includes('_webq88_restrict') &&
      exported.includes('_webq88_is_restricted') &&
      exported.includes('_webq88_ram_read') &&
      exported.includes('_webq88_ram_write');
    check('shimのexport(webq88_restrict/is_restricted/ram_read/ram_write)が揃っている', hasShimExports);
  }

  // --- 陰性対照: 互換ROMを「同梱」として起動 ---
  {
    const plan = RomRoles.planRomPlacement(compatFiles, []);
    check('陰性対照: planRomPlacement.restricted===false(同梱のみ)', plan.restricted === false);

    const core = await bootCore(plan.placements, plan.restricted, null);
    check('陰性対照: retro_load_game成功', core.loaded);
    check('陰性対照: webq88_is_restricted()===0', core.M._webq88_is_restricted() === 0);

    const { data, rc } = ramReadDirect(core.M, 0, 0, 16);
    check('陰性対照: ram_read(main_ram,0,16)が成功する', rc === 0 && data && data.length === 16);

    const wrc = ramWriteDirect(core.M, 0, 0, new Uint8Array([1, 2, 3, 4]));
    check('陰性対照: ram_write(main_ram,0,4)が成功する', wrc === 0);

    global.__negativeCore = core; // 次のブロックでは使わない(独立インスタンスにするため)
  }

  // --- 陽性対照: 同じ互換ROMを「利用者が読み込んだファイル」として渡す ---
  let latchCore;
  {
    const plan = RomRoles.planRomPlacement([], compatFiles);
    check('陽性対照: planRomPlacement.restricted===true(利用者ファイルのみ)', plan.restricted === true);

    latchCore = await bootCore(plan.placements, plan.restricted, null);
    check('陽性対照: retro_load_game成功', latchCore.loaded);
    check('陽性対照: webq88_is_restricted()===1', latchCore.M._webq88_is_restricted() === 1);

    const { rc: readRc } = ramReadDirect(latchCore.M, 0, 0, 16);
    check('陽性対照: ram_read が -1 を返す(拒否)', readRc === -1);

    const writeRc = ramWriteDirect(latchCore.M, 0, 0, new Uint8Array([9, 9, 9, 9]));
    check('陽性対照: ram_write が -1 を返す(拒否)', writeRc === -1);
  }

  // --- 掛け金: 制限モードに入った後、bundledのみで同一インスタンスを再起動 ---
  {
    // JS側の一方向掛け金を模擬する変数(Worker(public/core-worker.js)の
    // `restricted` 変数と同じ考え方: 一度trueになったらfalseに戻す代入は無い)。
    let restrictedLatch = true; // 直前のブロックで既にtrueになっている想定を引き継ぐ

    const plan = RomRoles.planRomPlacement(compatFiles, []); // bundledのみ = このinit単体ならrestricted=false
    check('掛け金: 今回のinit単体ならplanは非制限(bundledのみ)', plan.restricted === false);

    // ただし一方向掛け金なので、Worker実装はここで restrictedLatch を false に戻さない。
    // (plan.restricted || restrictedLatch のように「一度trueならtrueのまま」で判定する)
    restrictedLatch = restrictedLatch || plan.restricted;

    const rebooted = await bootCore(plan.placements, restrictedLatch, latchCore);
    check('掛け金: 同一インスタンス再起動後もretro_load_game成功', rebooted.loaded);
    check('掛け金: bundledのみで再起動してもwebq88_is_restricted()===1のまま', rebooted.M._webq88_is_restricted() === 1);

    // 実際に retro_run() を回して、再起動後も(クラッシュせず)動作し続けることを確認する
    // (public/core-worker.js finishBoot のコメント参照: retro_deinit を挟むと
    //  数フレームで RuntimeError になる不具合を実測で踏んだため、その回帰検知)。
    let ranWithoutCrash = true;
    try {
      for (let i = 0; i < 60; i++) rebooted.M._retro_run();
    } catch (e) {
      ranWithoutCrash = false;
    }
    check('掛け金: 再起動後もretro_run()が60フレームクラッシュしない', ranWithoutCrash);

    const { rc: readRc } = ramReadDirect(rebooted.M, 0, 0, 16);
    check('掛け金: 再起動後もram_readが-1を返す(拒否のまま)', readRc === -1);
  }

  // --- コア側の二重化: JSの判定を故意に迂回して、コアのexportを直接呼ぶ ---
  {
    const M = await Q88();
    // restrict前: 領域が未確保(retro_init未実行)なので、まずROM無しでも
    // memory_allocateはretro_initの中で行われる。ここでは「JSがrestricted
    // チェックを一切書かなかった」体で、いきなりram_read/writeを直接叩く。
    const sysPath = M._malloc(64);
    M.stringToUTF8('/sys', sysPath, 64);
    M.FS.mkdir('/sys');
    const env = M.addFunction((cmd, data) => {
      const realCmd = cmd & 0xffff;
      if (realCmd === 9 || realCmd === 31) {
        new DataView(M.HEAPU8.buffer).setUint32(data, sysPath, true);
        return 1;
      }
      if (realCmd === 10) return 1;
      return 0;
    }, 'iii');
    M._retro_set_environment(env);
    M._retro_set_video_refresh(M.addFunction(() => {}, 'viiii'));
    M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
    M._retro_set_audio_sample_batch(M.addFunction((_d, n) => n, 'iii'));
    M._retro_set_input_poll(M.addFunction(() => {}, 'v'));
    M._retro_set_input_state(M.addFunction(() => 0, 'iiiii'));
    for (const f of compatFiles) {
      M.FS.writeFile('/sys/' + f.name, new Uint8Array(f.bytes));
    }
    M._retro_init();
    M._retro_load_game(0);

    check('二重化: restrict前はwebq88_is_restricted()===0', M._webq88_is_restricted() === 0);
    const before = ramReadDirect(M, 0, 0, 16);
    check('二重化: restrict前はram_readが0以上(成功)を返す', before.rc >= 0);

    // JSの判定を「故意に迂回」= JS側if文を通さず、コアのexportを直接呼ぶ。
    M._webq88_restrict();
    check('二重化: restrict後はwebq88_is_restricted()===1', M._webq88_is_restricted() === 1);
    const after = ramReadDirect(M, 0, 0, 16);
    check('二重化: restrict後はram_readが-1を返す(コア単独で拒否)', after.rc === -1);
  }

  if (failures > 0) {
    console.log(`RESULT=FAIL: ${failures}件の検証に失敗`);
    process.exit(1);
  }
  console.log('RESULT=PASS');
  process.exit(0);
}

main().catch((err) => {
  console.log('RESULT=FAIL: 例外: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
