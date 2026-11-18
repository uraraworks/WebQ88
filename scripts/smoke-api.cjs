#!/usr/bin/env node
// scripts/smoke-api.cjs
//
// 自動操作API(docs/API-DESIGN.md、public/api-dispatch.js)の検査。
// 公式ROMは一切使わない(互換ROMのみ)。scripts/smoke-app.cjs / smoke-mode.cjs と
// 同じ骨格でNode上にコアを起動し、Workerの代わりにNode向けのctxを組み立てて
// public/api-dispatch.js の exec() を直接呼ぶ(ロジックを二重化しない)。
//
// Node環境では実時間ループが無いので、ctx.driveFrames(n) は retro_run() を
// n回直接呼ぶ(Worker側はpollCountが進むのを実時間で待つ。差はctxに閉じ込め、
// public/api-dispatch.js 自体は完全に共通)。
//
// 使い方: node scripts/smoke-api.cjs [coreディレクトリ] [compat-romディレクトリ]

const path = require('path');
const fs = require('fs');

const coreDir = process.argv[2] || path.join(__dirname, '..', 'public', 'core');
const romDir = process.argv[3] || path.join(__dirname, '..', 'compat-rom');

const Q88 = require(path.join(path.resolve(coreDir), 'q88_libretro.js'));
const RomRoles = require(path.join(path.resolve(__dirname, '..', 'public'), 'rom-roles.js'));
const KeyHoldTracker = require(path.join(path.resolve(__dirname, '..', 'public'), 'key-hold-tracker.js'));
const ApiDispatch = require(path.join(path.resolve(__dirname, '..', 'public'), 'api-dispatch.js'));
const DiskHost = require(path.join(path.resolve(__dirname, '..', 'public'), 'disk-host.js'));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

function loadManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function readAsFiles(dir, manifest) {
  // .D88 はROMではなく同梱ディスク(ROMの役割判定に混ぜない)
  return manifest.files.filter((f) => !/\.d88$/i.test(f.name)).map((f) => ({ name: f.name, bytes: fs.readFileSync(path.join(dir, f.name)) }));
}

/**
 * コアを1つ起動する。isUserRoms=true なら、互換ROMを「利用者が読み込んだ
 * ファイル」として渡し(=陽性対照。制限モードになる)、false なら同梱物として
 * 渡す(=陰性対照。互換モードのまま)。
 * scripts/smoke-mode.cjs の bootCore、public/core-worker.js の finishBoot と
 * 同じ手順・同じ呼び出し順序にする。
 */
async function bootCore(files, isUserRoms) {
  const plan = isUserRoms
    ? RomRoles.planRomPlacement([], files)
    : RomRoles.planRomPlacement(files, []);

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
    if (realCmd === 15) {
      // GET_VARIABLE: q88_save_to_disk_image=enabled(public/core-worker.js と同じ応答)
      const keyPtr = new DataView(M.HEAPU8.buffer).getUint32(data, true);
      if (M.UTF8ToString(keyPtr) === 'q88_save_to_disk_image') {
        new DataView(M.HEAPU8.buffer).setUint32(data + 4, enabledPtr, true);
        return 1;
      }
    }
    return 0;
  }, 'iii');

  let lastFrameForApi = null;
  const video = M.addFunction((d, W, H, pitch) => {
    if (!d) return;
    lastFrameForApi = { width: W, height: H, pitch, buffer: M.HEAPU8.slice(d, d + pitch * H) };
  }, 'viiii');

  const tracker = new KeyHoldTracker(2);
  let pollCount = 0;
  const inputPoll = M.addFunction(() => {
    tracker.beginPoll();
    pollCount++;
  }, 'v');
  const inputState = M.addFunction((_port, device, _index, id) => {
    if (device === 3 /* RETRO_DEVICE_KEYBOARD */) {
      return tracker.isPressed(id) ? 1 : 0;
    }
    return 0;
  }, 'iiiii');

  M._retro_set_environment(env);
  M._retro_set_video_refresh(video);
  M._retro_set_audio_sample(M.addFunction(() => {}, 'vii'));
  M._retro_set_audio_sample_batch(M.addFunction((_d, n) => n, 'iii'));
  M._retro_set_input_poll(inputPoll);
  M._retro_set_input_state(inputState);

  // ROMをFSに置く「前」に掛け金を掛ける(core-worker.js finishBootと同じ順序)。
  if (plan.restricted) {
    M._webq88_restrict();
  }
  for (const p of plan.placements) {
    M.FS.writeFile('/sys/' + p.name, new Uint8Array(p.bytes));
  }

  M._retro_init();
  const loaded = M._retro_load_game(0);

  const romMode = {
    restricted: plan.restricted,
    roms: plan.placements.map((p) => ({ role: p.role, name: p.name, origin: p.origin })),
    unresolved: plan.unresolved,
  };

  const stateSlots = Object.create(null);
  const disks = DiskHost.create(M);

  function driveFrames(n) {
    for (let i = 0; i < n; i++) M._retro_run();
    return Promise.resolve();
  }

  /**
   * Worker (public/core-worker.js buildApiCtx) と対になるNode版ctx。
   * bypassChecks=true のときは、readMemory/writeMemory 自身のJS側チェックを
   * 省いて M._webq88_ram_read/write を直接呼ぶ(コア側の二重化を単独で
   * 検査するための試験専用ctx。本番の public/core-worker.js には存在しない)。
   */
  function makeCtx(opts) {
    opts = opts || {};
    const reportRestricted = opts.reportRestricted !== undefined ? opts.reportRestricted : romMode.restricted;
    const bypassChecks = !!opts.bypassChecks;
    return {
      isBooted: () => !!loaded,
      getMode: () => Object.assign({}, romMode, { restricted: reportRestricted }),
      reset: () => {
        if (loaded) M._retro_reset();
      },
      press: (id) => tracker.press(id),
      release: (id) => tracker.release(id),
      driveFrames,
      textCols: () => M._webq88_text_cols(),
      textSnapshot: () => {
        const maxLen = 80 * 25;
        const ptr = M._malloc(maxLen);
        try {
          const written = M._webq88_text_snapshot(ptr, maxLen);
          if (written < 0) return new Uint8Array(0);
          return M.HEAPU8.slice(ptr, ptr + written);
        } finally {
          M._free(ptr);
        }
      },
      readMemory: (region, offset, length) => {
        if (!bypassChecks && plan.restricted) throw new Error(ApiDispatch.RESTRICTED_ERROR);
        const len = length >>> 0;
        const ptr = M._malloc(len || 1);
        try {
          const rc = M._webq88_ram_read(region | 0, offset >>> 0, len, ptr);
          if (rc !== 0) throw new Error('ram_read failed (invalid region/offset/len)');
          return M.HEAPU8.slice(ptr, ptr + len);
        } finally {
          M._free(ptr);
        }
      },
      writeMemory: (region, offset, bytes) => {
        if (!bypassChecks && plan.restricted) throw new Error(ApiDispatch.RESTRICTED_ERROR);
        const len = bytes.length;
        const ptr = M._malloc(len || 1);
        try {
          M.HEAPU8.set(bytes, ptr);
          const rc = M._webq88_ram_write(region | 0, offset >>> 0, len, ptr);
          if (rc !== 0) throw new Error('ram_write failed (invalid region/offset/len)');
        } finally {
          M._free(ptr);
        }
      },
      screenshotRGBA: () => {
        if (!lastFrameForApi) return null;
        const f = lastFrameForApi;
        return { width: f.width, height: f.height, rgba: ApiDispatch.rgb565ToRgba(f.buffer, f.pitch, f.width, f.height) };
      },
      saveState: (slot) => {
        const size = M._retro_serialize_size();
        const ptr = M._malloc(size || 1);
        try {
          const ok = M._retro_serialize(ptr, size);
          if (!ok) throw new Error('retro_serialize failed');
          stateSlots[slot] = M.HEAPU8.slice(ptr, ptr + size);
          return { size };
        } finally {
          M._free(ptr);
        }
      },
      loadState: (slot) => {
        const saved = stateSlots[slot];
        if (!saved) throw new Error('no saved state in slot: ' + slot);
        const ptr = M._malloc(saved.length || 1);
        try {
          M.HEAPU8.set(saved, ptr);
          const ok = M._retro_unserialize(ptr, saved.length);
          if (!ok) throw new Error('retro_unserialize failed');
        } finally {
          M._free(ptr);
        }
      },
      getStateBlob: (slot) => {
        const saved = stateSlots[slot];
        if (!saved) throw new Error('no saved state in slot: ' + slot);
        return saved;
      },
      diskInsert: (i, name, bytes, image) => disks.insert(i, name, bytes, image),
      diskEject: (i) => disks.eject(i),
      diskList: () => disks.list(),
      diskDump: (i) => disks.dump(i),
    };
  }

  return { M, loaded, romMode, makeCtx, driveFrames };
}

async function main() {
  const manifest = loadManifest(romDir);
  const files = readAsFiles(romDir, manifest);

  // === 互換モード(陰性対照: 同梱ROMとして起動) ===
  const compat = await bootCore(files, false);
  check('compat: retro_load_game', compat.loaded);
  check('compat: restricted=false', compat.romMode.restricted === false);
  const compatCtx = compat.makeCtx();

  // 起動直後、BASICのプロンプトが安定するまで少し回す。
  await compat.driveFrames(180);

  // --- status / reset ---
  {
    const r = await ApiDispatch.exec(compatCtx, 'status', {});
    check('compat status: ok', !!r.ok && r.booted === true, JSON.stringify(r).slice(0, 120));
  }
  {
    const r = await ApiDispatch.exec(compatCtx, 'reset', {});
    check('compat reset: ok', !!r.ok);
    await compat.driveFrames(180); // 再起動後、再びプロンプトが安定するまで
  }

  // --- screen_signature: 打鍵前後で変わる ---
  const sigBefore = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
  check('compat screen_signature: ok', !!sigBefore.ok && typeof sigBefore.sha256 === 'string');

  // --- type_text: 'PRINT 1+1' + Enter → 結果行が現れる ---
  const typeResult = await ApiDispatch.exec(compatCtx, 'type_text', { text: 'PRINT 1+1\n' });
  check('compat type_text: ok', !!typeResult.ok, JSON.stringify(typeResult));
  check('compat type_text: 画面本文を返す', Array.isArray(typeResult.lines));
  const pasteResult = await ApiDispatch.exec(compatCtx, 'paste_text', { text: '' });
  check('compat paste_text: 画面本文を返す', !!pasteResult.ok && Array.isArray(pasteResult.lines));
  await compat.driveFrames(60); // BASICの処理・再描画待ち

  const sigAfter = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
  check(
    'compat screen_signature: 打鍵前後で変化',
    sigAfter.ok && sigAfter.sha256 !== sigBefore.sha256,
    `前=${(sigBefore.sha256 || '').slice(0, 8)} 後=${(sigAfter.sha256 || '').slice(0, 8)}`,
  );

  const screenText = await ApiDispatch.exec(compatCtx, 'screen_text', {});
  check('compat screen_text: ok', !!screenText.ok && Array.isArray(screenText.lines));
  const joined = (screenText.lines || []).join('\n');
  check('compat screen_text: 計算結果(2)が現れる', /(^|[^0-9])2([^0-9]|$)/.test(joined), '(本文は出力しない)');

  // --- 文字列検索: 半角カナ、重なり、桁位置と待機結果を検査 ---
  {
    const testCtx = { ...compatCtx, textCols: () => 8, textSnapshot: () => Uint8Array.from([0, 0xa6, 65, 65, 65, 32, 32, 32]) };
    const find = await ApiDispatch.exec(testCtx, 'find_text', { text: 'AA', all: true });
    check('find_text: 重なる一致と行本文', find.count === 2 && find.matches[0].col === 2 && find.matches[1].col === 3 && find.matches.every((match) => match.text === '\\x00ｦAAA   '));
    const kana = await ApiDispatch.exec(testCtx, 'find_text', { text: 'ｦA' });
    check('find_text: 半角カナ', kana.count === 1 && kana.matches[0].col === 1);
    const text = await ApiDispatch.exec(testCtx, 'screen_text', {});
    check('screen_text: 半角カナの共通変換', text.lines[0].includes('ｦA'));
    const found = await ApiDispatch.exec(testCtx, 'wait_screen', { contains: 'ｦA', timeout_ms: 20 });
    const absent = await ApiDispatch.exec(testCtx, 'wait_screen', { contains: '不存在', timeout_ms: 10 });
    let advanced = false;
    const changingCtx = { ...testCtx, textSnapshot: () => Uint8Array.from(advanced ? [65, 32, 32, 32, 32, 32, 32, 32] : [32, 32, 32, 32, 32, 32, 32, 32]), driveFrames: async () => { advanced = true; } };
    const delayed = await ApiDispatch.exec(changingCtx, 'wait_screen', { contains: 'A', timeout_ms: 100 });
    check('wait_screen: 画面変化後に一致', delayed.found === true && advanced);
    check('wait_screen: 一致とタイムアウトで本文を返す', found.found === true && absent.found === false && absent.elapsed_ms >= 10 && JSON.stringify(found.lines) === JSON.stringify(text.lines) && JSON.stringify(absent.lines) === JSON.stringify(text.lines));
  }

  // --- wait_screen_change: 変化を検出できる ---
  {
    const waitPromise = ApiDispatch.exec(compatCtx, 'wait_screen_change', { timeoutFrames: 600 });
    await ApiDispatch.exec(compatCtx, 'type_text', { text: 'A' });
    const waitResult = await waitPromise;
    check('compat wait_screen_change: 変化を検出', !!waitResult.ok && waitResult.changed === true, JSON.stringify(waitResult));
  }

  // --- wait_screen_signature: 既知の署名に即座にマッチ ---
  {
    const cur = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
    const r = await ApiDispatch.exec(compatCtx, 'wait_screen_signature', { sha256: cur.sha256, timeoutFrames: 30 });
    check('compat wait_screen_signature: 既知署名に即マッチ', !!r.ok && r.matched === true);
  }
  {
    const r = await ApiDispatch.exec(compatCtx, 'wait_screen_signature', { sha256: '0'.repeat(64), timeoutFrames: 20 });
    check('compat wait_screen_signature: 存在しない署名はtimeoutエラー', !!r.error && /timeout/.test(r.error));
  }

  // --- save_state → 打鍵 → load_state で署名が戻る ---
  {
    const beforeSave = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
    const save = await ApiDispatch.exec(compatCtx, 'save_state', { slot: 'test' });
    check('compat save_state: ok', !!save.ok && typeof save.size === 'number' && save.size > 0, `size=${save.size}`);

    await ApiDispatch.exec(compatCtx, 'type_text', { text: 'B' });
    await compat.driveFrames(30);
    const afterType = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
    check('compat save_state周辺: 打鍵で画面が変わった', afterType.sha256 !== beforeSave.sha256);

    const load = await ApiDispatch.exec(compatCtx, 'load_state', { slot: 'test' });
    check('compat load_state: ok', !!load.ok);
    const afterLoad = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
    check(
      'compat load_state: 署名が保存時に戻る',
      afterLoad.sha256 === beforeSave.sha256,
      `保存時=${(beforeSave.sha256 || '').slice(0, 8)} 復元後=${(afterLoad.sha256 || '').slice(0, 8)}`,
    );
  }

  // --- 40桁/20行モード: screen_text が桁数・行数に従う ---
  // 判定はハードウェア状態(I/O 0x30 bit0 / CRTC の行数)。打った文字列が
  // 間に空白を挟まず読めること、columns/rows が正しいことを確かめる。
  for (const [wc, wr, tag] of [[40, 20, '40x20'], [80, 20, '80x20'], [40, 25, '40x25'], [80, 25, '80x25']]) {
    await ApiDispatch.exec(compatCtx, 'type_text', { text: `\nwidth ${wc},${wr}\n` });
    await compat.driveFrames(120);
    await ApiDispatch.exec(compatCtx, 'type_text', { text: 'print "WQ88TEST"\n' });
    await compat.driveFrames(90);
    const st = await ApiDispatch.exec(compatCtx, 'screen_text', {});
    check(`compat width ${tag}: columns/rows`, !!st.ok && st.columns === wc && st.rows === wr && st.lines.length === wr && st.lines[0].length === wc,
      `columns=${st.columns} rows=${st.rows}`);
    const hit = (st.lines || []).filter((l) => l.indexOf('WQ88TEST') >= 0).length;
    check(`compat width ${tag}: 打った文字列が連続して読める`, hit >= 1, `hit=${hit}`);
    const sg = await ApiDispatch.exec(compatCtx, 'screen_signature', {});
    check(`compat width ${tag}: screen_signature の columns/screenRows`, !!sg.ok && sg.columns === wc && sg.screenRows === wr);
  }
  await ApiDispatch.exec(compatCtx, 'type_text', { text: 'width 80,20\n' });
  await compat.driveFrames(120);

  // --- read/write memory 往復 ---
  {
    const region = 0; // main_ram
    const offset = 0xc000; // BASIC領域外(ユーザーRAM側)の適当な位置
    const original = await ApiDispatch.exec(compatCtx, 'read_memory', { region, offset, length: 4 });
    check('compat read_memory: ok', !!original.ok && typeof original.base64 === 'string');

    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64');
    const wr = await ApiDispatch.exec(compatCtx, 'write_memory', { region, offset, bytes: payload });
    check('compat write_memory: ok', !!wr.ok);

    const readBack = await ApiDispatch.exec(compatCtx, 'read_memory', { region, offset, length: 4 });
    check(
      'compat read_memory: 書き込んだ値が読み戻せる',
      readBack.ok && readBack.base64 === payload,
      `期待=${payload} 実際=${readBack.base64}`,
    );
  }

  // --- get_state_blob (互換モードでは可) ---
  {
    const r = await ApiDispatch.exec(compatCtx, 'get_state_blob', { slot: 'test' });
    check('compat get_state_blob: ok', !!r.ok && typeof r.base64 === 'string');
  }

  // --- screenshot (互換モードでは可) ---
  {
    const r = await ApiDispatch.exec(compatCtx, 'screenshot', {});
    check(
      'compat screenshot: PNGが返る',
      !!r.ok && r.format === 'png' && typeof r.base64 === 'string' && r.base64.length > 100,
      `width=${r.width} height=${r.height} base64長=${r.base64 ? r.base64.length : 0}`,
    );
    if (r.ok) {
      const png = Buffer.from(r.base64, 'base64');
      const sig = png.subarray(0, 8).toString('hex');
      check('compat screenshot: PNGシグネチャ一致', sig === '89504e470d0a1a0a');
    }
  }

  // --- key / key_sequence ---
  {
    const r = await ApiDispatch.exec(compatCtx, 'key', { code: 32, action: 'tap' });
    check('compat key tap: ok', !!r.ok);
    const r2 = await ApiDispatch.exec(compatCtx, 'key_sequence', {
      steps: [
        { code: 32, action: 'tap', waitFrames: 4 },
        { code: 32, action: 'tap', waitFrames: 4 },
      ],
    });
    check('compat key_sequence: ok', !!r2.ok && r2.sent === 2);
  }

  // --- 未知コマンド・不正引数 ---
  {
    const r = await ApiDispatch.exec(compatCtx, 'no_such_command', {});
    check('compat 未知コマンド: エラー', !!r.error && /unknown command/.test(r.error));
  }
  {
    const r = await ApiDispatch.exec(compatCtx, 'key', { code: 'not-a-number', action: 'tap' });
    check('compat 不正引数(code非数値): エラー', !!r.error);
  }
  {
    const r = await ApiDispatch.exec(compatCtx, 'key', { code: 32, action: 'sideways' });
    check('compat 不正引数(actionが不正): エラー', !!r.error);
  }
  {
    // 日本語文字はASCII外なのでtype_textはエラーにする(黙って捨てない)。
    const r = await ApiDispatch.exec(compatCtx, 'type_text', { text: 'あ' });
    check('compat type_text 非対応文字: エラー', !!r.error && /unsupported character/.test(r.error));
  }

  // --- disk系(詳細な往復検査は scripts/smoke-disk.cjs。ここは可否と引数検査) ---
  {
    const blank = fs.readFileSync(path.join(romDir, 'BLANK2D.D88'));
    const b64 = blank.toString('base64');
    let r = await ApiDispatch.exec(compatCtx, 'list_disks', {});
    check('compat list_disks: 両ドライブ空', !!r.ok && r.disks.length === 2 && r.disks.every((d) => d.empty), JSON.stringify(r).slice(0, 100));
    r = await ApiDispatch.exec(compatCtx, 'insert_disk', { drive: 3, name: 'x.d88', base64: b64 });
    check('compat insert_disk: drive不正はエラー', !!r.error && /drive/.test(r.error), JSON.stringify(r));
    r = await ApiDispatch.exec(compatCtx, 'insert_disk', { drive: 2, name: 'x.d88', base64: '' });
    check('compat insert_disk: 空base64はエラー', !!r.error, JSON.stringify(r));
    r = await ApiDispatch.exec(compatCtx, 'insert_disk', { drive: 2, name: 'x.d88', base64: Buffer.from([1, 2, 3]).toString('base64') });
    check('compat insert_disk: 小さすぎるイメージはエラー', !!r.error, JSON.stringify(r));
    r = await ApiDispatch.exec(compatCtx, 'insert_disk', { drive: 2, name: 'blank.d88', base64: b64 });
    check('compat insert_disk: ok', !!r.ok && r.size === blank.length, JSON.stringify(r).slice(0, 100));
    r = await ApiDispatch.exec(compatCtx, 'list_disks', {});
    check('compat list_disks: ドライブ2に blank.d88・未書き込み', !!r.ok && r.disks[1].name === 'blank.d88' && r.disks[1].written === false && !('base64' in r.disks[1]), JSON.stringify(r).slice(0, 160));
    r = await ApiDispatch.exec(compatCtx, 'get_disk_image', { drive: 2 });
    check('compat get_disk_image: 中身が返る', !!r.ok && r.base64 === b64);
    r = await ApiDispatch.exec(compatCtx, 'get_disk_image', { drive: 1 });
    check('compat get_disk_image: 空ドライブはエラー', !!r.error, JSON.stringify(r));
    r = await ApiDispatch.exec(compatCtx, 'eject_disk', { drive: 2 });
    check('compat eject_disk: ok', !!r.ok && r.hadDisk === true, JSON.stringify(r));
  }

  // === 制限モード(陽性対照: 同じ互換ROMを「利用者が読み込んだファイル」として起動) ===
  const restrictedCore = await bootCore(files, true);
  check('restricted: retro_load_game', restrictedCore.loaded);
  check('restricted: restricted=true', restrictedCore.romMode.restricted === true);
  const restrictedCtx = restrictedCore.makeCtx();
  await restrictedCore.driveFrames(120);

  const restrictedDenied = ['screen_text', 'find_text', 'wait_screen', 'screenshot', 'read_memory', 'write_memory', 'get_state_blob', 'get_disk_image'];
  for (const cmd of restrictedDenied) {
    const args =
      cmd === 'find_text' ? { text: 'A' }
        : cmd === 'wait_screen' ? { contains: 'A', timeout_ms: 10 }
        : cmd === 'read_memory'
        ? { region: 0, offset: 0, length: 1 }
        : cmd === 'write_memory'
          ? { region: 0, offset: 0, bytes: Buffer.from([0]).toString('base64') }
          : cmd === 'get_disk_image'
            ? { drive: 1 }
            : {};
    const r = await ApiDispatch.exec(restrictedCtx, cmd, args);
    check(`restricted ${cmd}: 理由付きエラー`, r.error === ApiDispatch.RESTRICTED_ERROR, JSON.stringify(r));
  }

  for (const cmd of ['type_text', 'paste_text']) {
    const r = await ApiDispatch.exec(restrictedCtx, cmd, { text: 'X' });
    check(`restricted ${cmd}: 入力し本文を返さない`, !!r.ok && (r.typed === 1 || r.sent === 1) && !('lines' in r) && typeof r.note === 'string');
  }

  const restrictedAllowed = ['status', 'type_text', 'screen_signature', 'save_state', 'load_state', 'list_disks'];
  for (const cmd of restrictedAllowed) {
    let args = {};
    if (cmd === 'type_text') args = { text: 'X' };
    if (cmd === 'load_state') {
      await ApiDispatch.exec(restrictedCtx, 'save_state', { slot: 's' });
      args = { slot: 's' };
    }
    if (cmd === 'save_state') args = { slot: 's' };
    const r = await ApiDispatch.exec(restrictedCtx, cmd, args);
    check(`restricted ${cmd}: 成功する`, !!r.ok, JSON.stringify(r).slice(0, 120));
  }
  {
    const r = await ApiDispatch.exec(restrictedCtx, 'wait_screen_signature', {
      sha256: (await ApiDispatch.exec(restrictedCtx, 'screen_signature', {})).sha256,
      timeoutFrames: 10,
    });
    check('restricted wait_screen_signature: 成功する', !!r.ok);
  }

  // --- 掛け金: 制限モードに入った後、互換ROMだけで再起動しても restricted のまま ---
  {
    await ApiDispatch.exec(restrictedCtx, 'reset', {});
    await restrictedCore.driveFrames(60);
    const r = await ApiDispatch.exec(restrictedCtx, 'screen_text', {});
    check('restricted 掛け金: resetしてもrestrictedのまま(screen_textは拒否され続ける)', r.error === ApiDispatch.RESTRICTED_ERROR);
  }

  // --- 陰性対照: dispatchの可否判定(ctx.getMode().restricted)を試験内で
  //     故意に無効化すると、制限モードでもscreen_textが通ってしまうこと。
  //     (dispatch本体は一切変更していない。ctxの返り値を偽らせただけ) ---
  {
    const lyingCtx = restrictedCore.makeCtx({ reportRestricted: false });
    const r = await ApiDispatch.exec(lyingCtx, 'screen_text', {});
    check(
      '陰性対照: getMode()を偽装すると制限モードでもscreen_textが通る(試験がdispatchの可否判定を踏んでいる証拠)',
      !!r.ok,
      JSON.stringify(r).slice(0, 80),
    );
  }

  // --- コア側の二重化: JSの判定(getMode both readMemory自身のガード)を
  //     両方バイパスしても、コア(webq88_shim.c)のwebq88_ram_read/writeが
  //     restricted中は独立に拒否すること。 ---
  {
    const bypassCtx = restrictedCore.makeCtx({ reportRestricted: false, bypassChecks: true });
    const r = await ApiDispatch.exec(bypassCtx, 'read_memory', { region: 0, offset: 0, length: 4 });
    check(
      'コア側二重化: JS側の判定を全て外してもwebq88_ram_readが拒否する',
      !!r.error && /ram_read failed/.test(r.error),
      JSON.stringify(r),
    );
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
