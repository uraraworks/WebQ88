// public/api-dispatch.js
//
// 自動操作APIのコマンド実装(docs/API-DESIGN.md 第4節)を1箇所に集約する共有モジュール。
// Worker(public/core-worker.js、classicスクリプトなのでimportScripts)と
// Node側のスモークテスト(scripts/smoke-api.cjs、CommonJS)の両方から使う。
// public/rom-roles.js・public/key-hold-tracker.js と同じ流儀(ロジックを二重化しない)。
//
// 可否の判断はこのファイルの exec() 1箇所だけで行う。呼び出し元
// (Worker側のsrc/bridge.ts・window.__webq88Debug)は、ここへ転送して
// 結果を返すだけにし、コマンド一覧や制限判定を複製しない
// (未知コマンドも exec() が 'unknown command' を返す)。
//
// 実行環境(Worker=実時間駆動のretro_runループが裏で回っている / Node smoke
// テスト=ループが無くretro_runを直接呼んで進める)の違いは、呼び出し元が
// 渡す `ctx`(下記)に閉じ込める。ctx が違うだけで exec() のロジックは
// 完全に共通。
//
// ctx インターフェース:
//   isBooted(): boolean
//   getMode(): {restricted, roms:[{role,name,origin}], unresolved:[{name,origin}]}
//   reset(): void                         — retro_reset を呼ぶ
//   press(id): void                       — keyHoldTracker.press(id)
//   release(id): void                     — keyHoldTracker.release(id)
//   driveFrames(n): Promise<void>         — n ポーリング(=フレーム)分進める。
//                                            Workerでは実時間ループの自然な
//                                            進行を待ち、Nodeでは retro_run()
//                                            をn回直接呼ぶ。
//   textCols(): number                    — webq88_text_cols()
//   textSnapshot(): Uint8Array            — webq88_text_snapshot() の結果
//                                            (restrictedでも常に取得可)
//   readMemory(region, offset, length): Uint8Array   — restricted等はthrow
//   writeMemory(region, offset, bytes): void         — 同上
//   screenshotRGBA(): {width, height, rgba:Uint8Array} | null
//   saveState(slot): {size:number}        — スロットへ保存(Worker内メモリ)
//   loadState(slot): void                 — スロットから復元。無ければthrow
//   getStateBlob(slot): Uint8Array        — 直近保存分の中身(get_state_blob用)
//   diskInsert(index, name, bytes): {gen} — index は 0/1(API の drive 1/2 を変換済み)。
//                                            不正イメージ等は throw
//   diskEject(index): {had:boolean}
//   diskList(): [{drive, empty, name?, size?, written?}]  — 中身は含まない
//   diskDump(index): Uint8Array           — flush済みのイメージ全体。空なら throw
//   (実体は public/disk-host.js。Workerとスモークテストで共有)
//
// 戻り値はコマンドの意味に応じて {ok:true, ...} または {error:'...'}。
// 例外は投げず、内部でtry/catchして {error: message} に変換する
// (未知コマンド・不正引数も同様。空文字列や0で成功したふりをしない)。

(function (global) {
  'use strict';

  var RESTRICTED_ERROR = 'restricted: official ROM loaded in this session';

  // type_text で受理する文字と、「どのPC-88物理キーをSHIFTあり/なしで押すか」の
  // 対応表は public/char-map.js に一本化してある(src/keyboard.ts の人間用
  // 記号キー入力と共有。表を二重に持たない)。
  var CharMap =
    typeof module !== 'undefined' && module.exports
      ? require('./char-map.js')
      : global.WebQ88CharMap;

  var RETROK_LSHIFT = CharMap.RETROK_LSHIFT;
  var charToKeySteps = CharMap.charToKeySteps;

  var HOLD_FRAMES = 6; // scripts/smoke-app.cjsで実測済みの値をそのまま採用
  var GAP_FRAMES = 4;
  var SHIFT_SETTLE_FRAMES = 2;

  async function pressAndRelease(ctx, code, shift) {
    if (shift) {
      ctx.press(RETROK_LSHIFT);
      await ctx.driveFrames(SHIFT_SETTLE_FRAMES);
    }
    ctx.press(code);
    await ctx.driveFrames(HOLD_FRAMES);
    ctx.release(code);
    await ctx.driveFrames(GAP_FRAMES);
    if (shift) {
      ctx.release(RETROK_LSHIFT);
      await ctx.driveFrames(SHIFT_SETTLE_FRAMES);
    }
  }

  function sha256Hex(bytesPromiseOrBytes) {
    // Node(crypto)とブラウザ/Worker(crypto.subtle)の両対応。
    var bytes = bytesPromiseOrBytes;
    if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) {
      return self.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
        return Array.prototype.map
          .call(new Uint8Array(digest), function (b) {
            return b.toString(16).padStart(2, '0');
          })
          .join('');
      });
    }
    // Node
    // eslint-disable-next-line global-require
    var crypto = require('crypto');
    return Promise.resolve(
      crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    );
  }

  /** テキスト画面の署名 {rows, nonBlankChars, sha256} を計算する。 */
  async function computeScreenSignature(ctx) {
    var snapshot = ctx.textSnapshot();
    var cols = ctx.textCols();
    var rows = cols > 0 ? Math.floor(snapshot.length / cols) : 0;
    var nonBlankRows = 0;
    var nonBlankChars = 0;
    for (var r = 0; r < rows; r++) {
      var rowHasContent = false;
      for (var c = 0; c < cols; c++) {
        var ch = snapshot[r * cols + c];
        if (ch !== 0 && ch !== 0x20) {
          rowHasContent = true;
          nonBlankChars++;
        }
      }
      if (rowHasContent) nonBlankRows++;
    }
    var hex = await sha256Hex(snapshot.buffer ? snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength) : snapshot);
    return { rows: nonBlankRows, nonBlankChars: nonBlankChars, sha256: hex };
  }

  // --- PNG エンコード(依存ゼロ。deflateは"格納(非圧縮)"ブロックのみを使う) ---
  // Node(zlib)にもブラウザ(CompressionStream)にも依存せず、Worker/Node両方で
  // 同じコードが動くようにするため、圧縮率を犠牲にしてzlib形式のstoredブロック
  // (RFC1950/1951)を自前で組み立てる。screenshotは検証用途で頻度が低いため、
  // ファイルサイズより移植性を優先する。

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    var a = 1;
    var b = 0;
    var MOD = 65521;
    for (var i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % MOD;
      b = (b + a) % MOD;
    }
    return ((b << 16) | a) >>> 0;
  }

  /** zlib形式(2byteヘッダ+storedブロック列+adler32)にラップする。 */
  function zlibStore(data) {
    var blocks = [];
    var CHUNK = 65535;
    for (var offset = 0; offset < data.length || offset === 0; offset += CHUNK) {
      var len = Math.min(CHUNK, data.length - offset);
      var isLast = offset + len >= data.length;
      var header = new Uint8Array(5);
      header[0] = isLast ? 1 : 0;
      header[1] = len & 0xff;
      header[2] = (len >> 8) & 0xff;
      header[3] = (~len) & 0xff;
      header[4] = ((~len) >> 8) & 0xff;
      blocks.push(header);
      blocks.push(data.subarray(offset, offset + len));
      if (data.length === 0) break;
    }
    var zHeader = new Uint8Array([0x78, 0x01]);
    var adler = adler32(data);
    var adlerBytes = new Uint8Array([
      (adler >>> 24) & 0xff,
      (adler >>> 16) & 0xff,
      (adler >>> 8) & 0xff,
      adler & 0xff,
    ]);
    var totalLen = zHeader.length + adlerBytes.length;
    for (var i = 0; i < blocks.length; i++) totalLen += blocks[i].length;
    var out = new Uint8Array(totalLen);
    var pos = 0;
    out.set(zHeader, pos);
    pos += zHeader.length;
    for (var j = 0; j < blocks.length; j++) {
      out.set(blocks[j], pos);
      pos += blocks[j].length;
    }
    out.set(adlerBytes, pos);
    return out;
  }

  function pngChunk(type, data) {
    var typeBytes = new Uint8Array(type.length);
    for (var i = 0; i < type.length; i++) typeBytes[i] = type.charCodeAt(i);
    var body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0);
    body.set(data, typeBytes.length);
    var crc = crc32(body);
    var out = new Uint8Array(4 + body.length + 4);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, false);
    out.set(body, 4);
    dv.setUint32(4 + body.length, crc, false);
    return out;
  }

  /** width x height の RGBA(Uint8Array, 4byte/px) を PNG バイト列にする。 */
  function encodePng(width, height, rgba) {
    var ihdr = new Uint8Array(13);
    var dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width, false);
    dv.setUint32(4, height, false);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    var raw = new Uint8Array((width * 4 + 1) * height);
    var rowBytes = width * 4;
    for (var y = 0; y < height; y++) {
      raw[y * (rowBytes + 1)] = 0; // filter: None
      raw.set(rgba.subarray(y * rowBytes, y * rowBytes + rowBytes), y * (rowBytes + 1) + 1);
    }
    var idatData = zlibStore(raw);

    var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    var ihdrChunk = pngChunk('IHDR', ihdr);
    var idatChunk = pngChunk('IDAT', idatData);
    var iendChunk = pngChunk('IEND', new Uint8Array(0));

    var total = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
    var out = new Uint8Array(total);
    var pos = 0;
    out.set(sig, pos); pos += sig.length;
    out.set(ihdrChunk, pos); pos += ihdrChunk.length;
    out.set(idatChunk, pos); pos += idatChunk.length;
    out.set(iendChunk, pos);
    return out;
  }

  /** API の drive 引数(1 または 2)を内部の 0/1 へ。不正なら null。 */
  function parseDrive(v) {
    var n = Number(v);
    if (n === 1) return 0;
    if (n === 2) return 1;
    return null;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /** RGB565(pitch考慮の生バッファ)をRGBAへ変換する(src/rgb565.tsと同じ計算)。 */
  function rgb565ToRgba(src, pitch, width, height) {
    var out = new Uint8Array(width * height * 4);
    for (var y = 0; y < height; y++) {
      var rowOffset = y * pitch;
      for (var x = 0; x < width; x++) {
        var off = rowOffset + x * 2;
        var px = src[off] | (src[off + 1] << 8);
        var r5 = (px >> 11) & 0x1f;
        var g6 = (px >> 5) & 0x3f;
        var b5 = px & 0x1f;
        var r = (r5 << 3) | (r5 >> 2);
        var g = (g6 << 2) | (g6 >> 4);
        var b = (b5 << 3) | (b5 >> 2);
        var dst = (y * width + x) * 4;
        out[dst] = r;
        out[dst + 1] = g;
        out[dst + 2] = b;
        out[dst + 3] = 255;
      }
    }
    return out;
  }

  function textSnapshotToString(snapshot, cols) {
    var rows = cols > 0 ? Math.floor(snapshot.length / cols) : 0;
    var lines = [];
    for (var r = 0; r < rows; r++) {
      var line = '';
      for (var c = 0; c < cols; c++) {
        var ch = snapshot[r * cols + c];
        if (ch >= 0x20 && ch <= 0x7e) {
          line += String.fromCharCode(ch);
        } else {
          line += '\\x' + ch.toString(16).padStart(2, '0');
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /**
   * コマンドを実行する。ctx は上記インターフェース。
   * 戻り値は常に {ok:true,...} または {error:'...'} (例外を投げない)。
   */
  async function exec(ctx, cmd, args) {
    args = args || {};
    try {
      switch (cmd) {
        case 'status': {
          var mode = ctx.getMode();
          return { ok: true, booted: ctx.isBooted(), mode: mode };
        }

        case 'reset': {
          ctx.reset();
          return { ok: true };
        }

        case 'key': {
          var code = Number(args.code);
          var action = String(args.action || '');
          if (!Number.isFinite(code)) return { error: 'invalid args: code must be a number' };
          if (action === 'down') {
            ctx.press(code);
          } else if (action === 'up') {
            ctx.release(code);
          } else if (action === 'tap') {
            ctx.press(code);
            await ctx.driveFrames(HOLD_FRAMES);
            ctx.release(code);
            await ctx.driveFrames(GAP_FRAMES);
          } else {
            return { error: "invalid args: action must be 'down'|'up'|'tap'" };
          }
          return { ok: true };
        }

        case 'key_sequence': {
          var steps = Array.isArray(args.steps) ? args.steps : null;
          if (!steps) return { error: 'invalid args: steps must be an array' };
          for (var i = 0; i < steps.length; i++) {
            var step = steps[i];
            var sCode = Number(step.code);
            var sAction = String(step.action || '');
            if (!Number.isFinite(sCode)) return { error: 'invalid args: steps[].code must be a number' };
            var waitFrames = step.waitFrames !== undefined ? Number(step.waitFrames) : GAP_FRAMES;
            if (sAction === 'down') {
              ctx.press(sCode);
            } else if (sAction === 'up') {
              ctx.release(sCode);
            } else if (sAction === 'tap') {
              ctx.press(sCode);
              await ctx.driveFrames(HOLD_FRAMES);
              ctx.release(sCode);
            } else {
              return { error: "invalid args: steps[].action must be 'down'|'up'|'tap'" };
            }
            if (waitFrames > 0) await ctx.driveFrames(waitFrames);
          }
          return { ok: true, sent: steps.length };
        }

        case 'type_text': {
          var text = args.text;
          if (typeof text !== 'string') return { error: 'invalid args: text must be a string' };
          for (var ti = 0; ti < text.length; ti++) {
            var charCode = text.charCodeAt(ti);
            var stepInfo = charToKeySteps(charCode);
            if (!stepInfo) {
              return {
                error:
                  'unsupported character at index ' +
                  ti +
                  ' (code ' +
                  charCode +
                  '): type_text はASCII英数字・記号・空白・改行のみ対応',
              };
            }
            await pressAndRelease(ctx, stepInfo.code, stepInfo.shift);
          }
          return { ok: true, typed: text.length };
        }

        case 'screen_signature': {
          var sig = await computeScreenSignature(ctx);
          return { ok: true, rows: sig.rows, nonBlankChars: sig.nonBlankChars, sha256: sig.sha256 };
        }

        case 'screen_text': {
          if (ctx.getMode().restricted) return { error: RESTRICTED_ERROR };
          var snap = ctx.textSnapshot();
          var cols = ctx.textCols();
          return { ok: true, lines: textSnapshotToString(snap, cols) };
        }

        case 'screenshot': {
          if (ctx.getMode().restricted) return { error: RESTRICTED_ERROR };
          var frame = ctx.screenshotRGBA();
          if (!frame) return { error: 'no frame available yet' };
          var png = encodePng(frame.width, frame.height, frame.rgba);
          return { ok: true, format: 'png', width: frame.width, height: frame.height, base64: bytesToBase64(png) };
        }

        case 'wait_screen_change': {
          var timeoutFrames = Number(args.timeoutFrames);
          if (!Number.isFinite(timeoutFrames) || timeoutFrames <= 0) {
            return { error: 'invalid args: timeoutFrames must be a positive number' };
          }
          var before = await computeScreenSignature(ctx);
          var elapsed = 0;
          var STEP = 2;
          while (elapsed < timeoutFrames) {
            var thisStep = Math.min(STEP, timeoutFrames - elapsed);
            await ctx.driveFrames(thisStep);
            elapsed += thisStep;
            var current = await computeScreenSignature(ctx);
            if (current.sha256 !== before.sha256) {
              return { ok: true, changed: true, framesWaited: elapsed, sha256: current.sha256 };
            }
          }
          return { error: 'timeout: screen did not change within ' + timeoutFrames + ' frames' };
        }

        case 'wait_screen_signature': {
          var targetSha = args.sha256;
          var timeoutFrames2 = Number(args.timeoutFrames);
          if (typeof targetSha !== 'string' || !targetSha) {
            return { error: 'invalid args: sha256 must be a non-empty string' };
          }
          if (!Number.isFinite(timeoutFrames2) || timeoutFrames2 <= 0) {
            return { error: 'invalid args: timeoutFrames must be a positive number' };
          }
          var elapsed2 = 0;
          var STEP2 = 2;
          while (true) {
            var cur2 = await computeScreenSignature(ctx);
            if (cur2.sha256 === targetSha) {
              return { ok: true, matched: true, framesWaited: elapsed2 };
            }
            if (elapsed2 >= timeoutFrames2) {
              return { error: 'timeout: screen signature did not match ' + targetSha + ' within ' + timeoutFrames2 + ' frames' };
            }
            var step2 = Math.min(STEP2, timeoutFrames2 - elapsed2);
            await ctx.driveFrames(step2);
            elapsed2 += step2;
          }
        }

        case 'read_memory': {
          if (ctx.getMode().restricted) return { error: RESTRICTED_ERROR };
          var region = Number(args.region);
          var offset = Number(args.offset);
          var length = Number(args.length);
          if (!Number.isFinite(region) || !Number.isFinite(offset) || !Number.isFinite(length)) {
            return { error: 'invalid args: region/offset/length must be numbers' };
          }
          var data = ctx.readMemory(region, offset, length);
          return { ok: true, base64: bytesToBase64(data) };
        }

        case 'write_memory': {
          if (ctx.getMode().restricted) return { error: RESTRICTED_ERROR };
          var wRegion = Number(args.region);
          var wOffset = Number(args.offset);
          var wBytes = args.bytes;
          if (!Number.isFinite(wRegion) || !Number.isFinite(wOffset) || typeof wBytes !== 'string') {
            return { error: 'invalid args: region/offset must be numbers, bytes must be base64 string' };
          }
          var bin = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(wBytes, 'base64')) : base64ToBytesBrowser(wBytes);
          ctx.writeMemory(wRegion, wOffset, bin);
          return { ok: true };
        }

        case 'save_state': {
          var saveSlot = args.slot !== undefined ? String(args.slot) : 'default';
          var result = ctx.saveState(saveSlot);
          return { ok: true, slot: saveSlot, size: result.size };
        }

        case 'load_state': {
          var loadSlot = args.slot !== undefined ? String(args.slot) : 'default';
          ctx.loadState(loadSlot);
          return { ok: true, slot: loadSlot };
        }

        case 'get_state_blob': {
          if (ctx.getMode().restricted) return { error: RESTRICTED_ERROR };
          var blobSlot = args.slot !== undefined ? String(args.slot) : 'default';
          var blob = ctx.getStateBlob(blobSlot);
          return { ok: true, slot: blobSlot, base64: bytesToBase64(blob) };
        }

        case 'insert_disk': {
          var inDrive = parseDrive(args.drive);
          if (inDrive === null) return { error: 'invalid args: drive must be 1 or 2' };
          if (typeof args.name !== 'string' || args.name === '') {
            return { error: 'invalid args: name must be a non-empty string' };
          }
          if (typeof args.base64 !== 'string' || args.base64 === '') {
            return { error: 'invalid args: base64 must be a non-empty base64 string' };
          }
          var imgBytes =
            typeof Buffer !== 'undefined'
              ? new Uint8Array(Buffer.from(args.base64, 'base64'))
              : base64ToBytesBrowser(args.base64);
          var inRes = ctx.diskInsert(inDrive, args.name, imgBytes);
          return { ok: true, drive: inDrive + 1, name: args.name, size: imgBytes.length, gen: inRes.gen };
        }

        case 'eject_disk': {
          var ejDrive = parseDrive(args.drive);
          if (ejDrive === null) return { error: 'invalid args: drive must be 1 or 2' };
          var ejRes = ctx.diskEject(ejDrive);
          return { ok: true, drive: ejDrive + 1, hadDisk: !!ejRes.had };
        }

        case 'list_disks': {
          // 名前・サイズ・書き込みの有無のみ。中身は返さない(制限モードでも可)。
          return { ok: true, disks: ctx.diskList() };
        }

        case 'get_disk_image': {
          // 中身を返すので制限モードでは×(利用者が持ち込んだ公式ディスクの
          // 中身をAPIから取り出させない。API-DESIGN.md 第2節の表と同じ考え方)。
          if (ctx.getMode().restricted) return { error: RESTRICTED_ERROR };
          var gdDrive = parseDrive(args.drive);
          if (gdDrive === null) return { error: 'invalid args: drive must be 1 or 2' };
          var img = ctx.diskDump(gdDrive);
          return { ok: true, drive: gdDrive + 1, size: img.length, base64: bytesToBase64(img) };
        }

        default:
          return { error: 'unknown command: ' + cmd };
      }
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }

  function base64ToBytesBrowser(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var api = { exec: exec, RESTRICTED_ERROR: RESTRICTED_ERROR, encodePng: encodePng, rgb565ToRgba: rgb565ToRgba };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.WebQ88ApiDispatch = api;
  }
})(typeof self !== 'undefined' ? self : this);
