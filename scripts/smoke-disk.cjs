#!/usr/bin/env node
// scripts/smoke-disk.cjs
//
// ディスク機能(public/disk-host.js + core/shim の webq88_disk_* + 自動操作API)の検査。
// 互換ROMと自作ディスク(compat-rom/BLANK2D.D88)だけを使い、公式ROM・公式ディスクは
// 一切使わない。そのため画面本文(screen_text)を見て判定してよい。
//
// 使い方: node scripts/smoke-disk.cjs [coreディレクトリ] [compat-romディレクトリ]

const path = require('path');
const fs = require('fs');

const coreDir = process.argv[2] || path.join(__dirname, '..', 'public', 'core');
const romDir = process.argv[3] || path.join(__dirname, '..', 'compat-rom');
const pub = path.resolve(__dirname, '..', 'public');

const Q88 = require(path.join(path.resolve(coreDir), 'q88_libretro.js'));
const RomRoles = require(path.join(pub, 'rom-roles.js'));
const KeyHoldTracker = require(path.join(pub, 'key-hold-tracker.js'));
const ApiDispatch = require(path.join(pub, 'api-dispatch.js'));
const DiskHost = require(path.join(pub, 'disk-host.js'));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

const manifest = JSON.parse(fs.readFileSync(path.join(romDir, 'manifest.json'), 'utf8'));
const romFiles = manifest.files
  .filter((f) => !/\.d88$/i.test(f.name))
  .map((f) => ({ name: f.name, bytes: fs.readFileSync(path.join(romDir, f.name)) }));
const BLANK = new Uint8Array(fs.readFileSync(path.join(romDir, 'BLANK2D.D88')));

/**
 * コアを1つ起動する(public/core-worker.js の finishBoot と同じ順序)。
 * opts.saveToDisk=false にすると GET_VARIABLE で q88_save_to_disk_image を返さない
 * (上流は書き込みを .srm 差分ファイルへ回す。陰性対照用)。
 */
async function boot(opts) {
  opts = opts || {};
  const saveToDisk = opts.saveToDisk !== false;
  const plan = RomRoles.planRomPlacement(romFiles, []);
  const M = await Q88();
  const sysPath = M._malloc(64);
  M.stringToUTF8('/sys', sysPath, 64);
  M.FS.mkdir('/sys');
  const enabledPtr = M._malloc(16);
  M.stringToUTF8('enabled', enabledPtr, 16);

  const env = M.addFunction((cmd, data) => {
    const realCmd = cmd & 0xffff;
    if (realCmd === 9 || realCmd === 31) {
      new DataView(M.HEAPU8.buffer).setUint32(data, sysPath, true);
      return 1;
    }
    if (realCmd === 10) return 1;
    if (realCmd === 15 && saveToDisk) {
      const keyPtr = new DataView(M.HEAPU8.buffer).getUint32(data, true);
      if (M.UTF8ToString(keyPtr) === 'q88_save_to_disk_image') {
        new DataView(M.HEAPU8.buffer).setUint32(data + 4, enabledPtr, true);
        return 1;
      }
    }
    return 0;
  }, 'iii');
  const tracker = new KeyHoldTracker(2);
  M._retro_set_environment(env);
  M._retro_set_video_refresh(M.addFunction(() => {}, 'viiii'));
  M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
  M._retro_set_audio_sample_batch(M.addFunction((_d, n) => n, 'iii'));
  M._retro_set_input_poll(M.addFunction(() => tracker.beginPoll(), 'v'));
  M._retro_set_input_state(
    M.addFunction((_p, device, _i, id) => (device === 3 && tracker.isPressed(id) ? 1 : 0), 'iiiii'),
  );
  for (const p of plan.placements) M.FS.writeFile('/sys/' + p.name, new Uint8Array(p.bytes));

  const disks = DiskHost.create(M);
  M._retro_init();
  if (!M._retro_load_game(0)) throw new Error('retro_load_game failed');
  const romMode = { restricted: false, roms: [], unresolved: [] };
  const frames = (n) => {
    for (let i = 0; i < n; i++) M._retro_run();
    return Promise.resolve();
  };
  const ctx = {
    isBooted: () => true,
    getMode: () => romMode,
    reset: () => M._retro_reset(),
    press: (id) => tracker.press(id),
    release: (id) => tracker.release(id),
    driveFrames: frames,
    textCols: () => M._webq88_text_cols(),
    textSnapshot: () => {
      const ptr = M._malloc(2000);
      try {
        const n = M._webq88_text_snapshot(ptr, 2000);
        return n < 0 ? new Uint8Array(0) : M.HEAPU8.slice(ptr, ptr + n);
      } finally {
        M._free(ptr);
      }
    },
    diskInsert: (i, name, bytes) => disks.insert(i, name, bytes),
    diskEject: (i) => disks.eject(i),
    diskList: () => disks.list(),
    diskDump: (i) => disks.dump(i),
  };
  // リセット相当の再起動(core-worker.js の handleInit 再起動と同じ: deinitなしで
  // retro_init をやり直し、load_game が全イジェクトするので reinsertAll で戻す)
  function reboot() {
    M._retro_init();
    if (!M._retro_load_game(0)) throw new Error('retro_load_game failed (reboot)');
    if (disks.reinsertAll() > 0) M._retro_reset(); // core-worker.js finishBoot と同じ
  }
  return { M, disks, ctx, frames, reboot };
}

async function type(core, text, waitFrames) {
  const r = await ApiDispatch.exec(core.ctx, 'type_text', { text });
  if (!r.ok) throw new Error('type_text: ' + JSON.stringify(r));
  await core.frames(waitFrames === undefined ? 90 : waitFrames);
}
async function screen(core) {
  const r = await ApiDispatch.exec(core.ctx, 'screen_text', {});
  if (!r.ok) throw new Error('screen_text: ' + JSON.stringify(r));
  return r.lines.map((l) => l.replace(/\s+$/, ''));
}
function screenHas(lines, re) {
  return lines.some((l) => re.test(l));
}
const SHOW = process.env.SHOW_SCREEN === '1'; // 期待値決めの確認用(互換ROMのみなので本文を出してよい)
async function dumpScreen(core, label) {
  if (!SHOW) return;
  console.log('--- screen: ' + label);
  for (const l of await screen(core)) if (l) console.log('| ' + l);
}

const PROG = '10 PRINT "HELLO-DISK"';

/** 起動→ドライブ2に blank を挿入→プログラム入力→SAVE まで。以後 core.disks.dump(1) に内容がある。 */
async function bootAndSave(opts, insertImage) {
  const core = await boot(opts);
  await core.frames(240);
  const r = await ApiDispatch.exec(core.ctx, 'insert_disk', {
    drive: 2,
    name: 'work.d88',
    base64: Buffer.from(insertImage || BLANK).toString('base64'),
  });
  if (!r.ok) throw new Error('insert_disk: ' + JSON.stringify(r));
  await type(core, PROG + '\n', 60);
  await type(core, 'SAVE "2:TEST",A\n', 240);
  return core;
}

async function main() {
  // ---- 1. ドライブ2に blank → SAVE → FILES → NEW → LOAD → LIST ----
  const a = await bootAndSave({});
  await dumpScreen(a, 'SAVE後');
  check('SAVE後: Disk Error 等が出ていない', !screenHas(await screen(a), /error/i));
  await type(a, 'FILES 2\n', 240);
  await dumpScreen(a, 'FILES 2');
  check('FILES 2 に TEST が出る', screenHas(await screen(a), /TEST/i));
  await type(a, 'NEW\n', 60);
  await type(a, 'CLS\n', 60);
  await type(a, 'LIST\n', 60);
  check('NEW 後は LIST に HELLO-DISK が出ない', !screenHas(await screen(a), /HELLO-DISK/));
  await type(a, 'CLS\n', 60);
  await type(a, 'LOAD "2:TEST"\n', 240);
  await type(a, 'LIST\n', 90);
  await dumpScreen(a, 'LOAD→LIST');
  check('LOAD "2:TEST" → LIST で元のプログラムが戻る', screenHas(await screen(a), /10 PRINT "HELLO-DISK"/i));
  const written = a.disks.list();
  check('list: ドライブ2は書き込みあり', written[1].written === true);

  // ---- 2. 吸い出し(flush済み)に SAVE 内容が入っている ----
  const dumped = a.disks.dump(1);
  check('吸い出し: サイズ不変・内容は blank と異なる', dumped.length === BLANK.length && !Buffer.from(dumped).equals(Buffer.from(BLANK)));

  // ---- 3. 吸い出しを別起動で挿入して LOAD できる(永続化経路の再現) ----
  const b = await boot({});
  await b.frames(240);
  let r = await ApiDispatch.exec(b.ctx, 'insert_disk', { drive: 2, name: 'work.d88', base64: Buffer.from(dumped).toString('base64') });
  check('別起動: 吸い出しの挿入 ok', !!r.ok, JSON.stringify(r));
  await type(b, 'LOAD "2:TEST"\n', 240);
  await type(b, 'LIST\n', 90);
  await dumpScreen(b, '別起動LOAD→LIST');
  check('別起動: LOAD → LIST で戻る', screenHas(await screen(b), /10 PRINT "HELLO-DISK"/i));

  // ---- 4. 陰性対照: save_to_disk_image 無効 → 吸い出しから SAVE 内容が消える ----
  const n1 = await bootAndSave({ saveToDisk: false });
  const dumpedNo = n1.disks.dump(1);
  check('陰性対照(save_to_disk_image無効): 吸い出しは blank と同一(SAVEがイメージに入らない)', Buffer.from(dumpedNo).equals(Buffer.from(BLANK)));
  await type(n1, 'FILES 2\n', 240);
  console.log('INFO: 陰性対照のゲスト上では FILES 2 に TEST が見える=' + screenHas(await screen(n1), /TEST/i) + '(差分ファイル経由。イメージ本体には入っていない)');
  const c = await boot({});
  await c.frames(240);
  await ApiDispatch.exec(c.ctx, 'insert_disk', { drive: 2, name: 'work.d88', base64: Buffer.from(dumpedNo).toString('base64') });
  await type(c, 'LOAD "2:TEST"\n', 240);
  await type(c, 'LIST\n', 90);
  check('陰性対照: そのイメージでは LOAD できない', !screenHas(await screen(c), /10 PRINT "HELLO-DISK"/i));

  // ---- 5. flush 省略(陰性対照): 上流が書き込みごとに flush するかの確認 ----
  const f = await bootAndSave({});
  const noFlush = f.disks.dump(1, { noFlush: true });
  const withFlush = f.disks.dump(1);
  check('flush有無の比較(情報): flushなし吸い出し==flushあり', Buffer.from(noFlush).equals(Buffer.from(withFlush)),
    'noFlush==flush: ' + Buffer.from(noFlush).equals(Buffer.from(withFlush)));

  // ---- 6. リセットをまたいでドライブの中身が残る ----
  a.reboot();
  await a.frames(240);
  await type(a, 'CLS\n', 60);
  await type(a, 'FILES 2\n', 240);
  check('再起動(retro_init やり直し)後も ドライブ2 の中身(書き込み済み)が残る', screenHas(await screen(a), /TEST/i));
  const lst = await ApiDispatch.exec(a.ctx, 'list_disks', {});
  check('再起動後の list_disks: ドライブ2 は work.d88', lst.disks[1].name === 'work.d88' && lst.disks[1].written === true);
  r = await ApiDispatch.exec(a.ctx, 'reset', {});
  await a.frames(240);
  await type(a, 'CLS\n', 60);
  await type(a, 'FILES 2\n', 240);
  check('retro_reset 後も ドライブ2 の中身が残る', screenHas(await screen(a), /TEST/i));

  // ---- 7. 同じドライブへの差し替えを繰り返しても枠が尽きない・古い中身が残らない ----
  const swap = await boot({});
  await swap.frames(240);
  let okAll = true;
  for (let i = 0; i < 24; i++) {
    const img = i % 2 === 0 ? BLANK : dumped;
    const res = await ApiDispatch.exec(swap.ctx, 'insert_disk', { drive: 2, name: 'swap' + i + '.d88', base64: Buffer.from(img).toString('base64') });
    if (!res.ok) { okAll = false; console.log('  insert失敗 i=' + i + ' ' + JSON.stringify(res)); break; }
    await swap.frames(5);
  }
  check('同一ドライブへ24回差し替え(MAX_STREAM=16超)でも挿入できる', okAll);
  // 最後(i=23, 奇数)は dumped=TESTあり。i=22(blank)の後に23(dumped)なので TEST が見えるはず
  await type(swap, 'CLS\n', 60);
  await type(swap, 'FILES 2\n', 240);
  check('差し替え後の中身が反映される(最後の挿入=TESTあり)', screenHas(await screen(swap), /TEST/i));
  await ApiDispatch.exec(swap.ctx, 'insert_disk', { drive: 2, name: 'again.d88', base64: Buffer.from(BLANK).toString('base64') });
  await swap.frames(10);
  await type(swap, 'CLS\n', 60);
  await type(swap, 'FILES 2\n', 240);
  check('blank を入れ直すと TEST が消える(古い中身が残らない)', !screenHas(await screen(swap), /TEST/i));

  // ---- 8. ドライブ1にブランクを入れて起動 ----
  const d1 = await boot({});
  // 起動前(リセット前)に挿入してからリセット相当の再起動
  r = await ApiDispatch.exec(d1.ctx, 'insert_disk', { drive: 1, name: 'blank1.d88', base64: Buffer.from(BLANK).toString('base64') });
  check('ドライブ1へ blank を挿入 ok', !!r.ok);
  d1.reboot();
  await d1.frames(900);
  await dumpScreen(d1, 'ドライブ1ブランク起動');
  await type(d1, 'PRINT 1+1\n', 60);
  check('ドライブ1ブランクでも BASIC まで立ち上がる(PRINT 1+1 → 2)', screenHas(await screen(d1), /^\s*2\s*$/));

  // ---- 9. 引数・異常系 ----
  const e1 = await ApiDispatch.exec(d1.ctx, 'insert_disk', { drive: 1, name: 'garbage.d88', base64: Buffer.alloc(400000, 7).toString('base64') });
  check('不正イメージ(全バイト同値)の挿入は成功したふりをしない', !!e1.error, JSON.stringify(e1).slice(0, 100));
  const ej = await ApiDispatch.exec(d1.ctx, 'eject_disk', { drive: 1 });
  check('eject_disk ok', !!ej.ok);
  const l2 = await ApiDispatch.exec(d1.ctx, 'list_disks', {});
  check('eject後は空', l2.disks[0].empty === true);

  if (failures > 0) {
    console.log(`RESULT=FAIL: ${failures}件`);
    process.exit(1);
  }
  console.log('RESULT=PASS');
  process.exit(0);
}

main().catch((err) => {
  console.log('RESULT=FAIL: 例外: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
