// public/disk-host.js
//
// コア(wasm)側のフロッピードライブ2台を扱う共有ロジック。
// Worker(public/core-worker.js、importScripts)と Node 側スモークテスト
// (scripts/smoke-disk.cjs、CommonJS)の両方から使う
// (public/api-dispatch.js などと同じ流儀。ロジックを二重化しない)。
//
// ■ パスの扱い(上流 src/LIBRETRO/file-op.c の調査結果)
//   上流はディスクのストリームを fclose せず開きっぱなしにし(osd_fclose が
//   FTYPE_DISK では何もしない)、同じパスなら既存ストリームを再利用する。
//   ストリーム枠は MAX_STREAM=16 個で解放されない。したがって
//   - 挿入のたびにパスを使い捨てにすると、16回挿入した時点で枠が尽きる
//   - 同じパスで別の中身にするなら、MEMFS 上の同じファイルを「その場で
//     上書き」する必要がある(unlink→作り直しだと、残ったストリームが
//     古いノードを指したままになる)。FS.writeFile は既存ファイルを
//     その場で切り詰めて書くので後者を満たす
//   そこでドライブごとに固定パス(/disk/drive1.d88, /disk/drive2.d88)を使い、
//   使う枠をドライブ数(2枠)に固定する。
//
// ■ 書き込みの反映
//   core-worker.js(と Node 側ホスト)は環境コールバックの GET_VARIABLE で
//   q88_save_to_disk_image=enabled を返すこと。無効だと上流はゲストの書き込みを
//   イメージ本体ではなく save_path の .srm 差分ファイルへ書く。
//   ゲストの書き込みは上流が1回ごとに osd_fflush するが、吸い出し前には念のため
//   fflush(0)(_fflush のエクスポート)も呼ぶ。
//
// ■ リセットをまたぐ状態
//   retro_load_game は全ドライブをイジェクトする。MEMFS 上のファイルは残るので、
//   reinsertAll() で同じパスから挿入し直せば、書き込み済みの中身ごと復元される。
//
// ドライブ番号は、このモジュールの外向き(API・UI)では 1 / 2、内部と shim では 0 / 1。
// 外向きの関数は引数名に drive1 などは付けず、`index`(0/1)を取るものと
// 呼び出し側で変換するものを明記してある。ここは 0/1 を受け取る。

(function (global) {
  'use strict';

  var DISK_DIR = '/disk';
  var D88_HEADER_SIZE = 0x2b0;

  function diskPath(index) {
    return DISK_DIR + '/drive' + (index + 1) + '.d88';
  }

  function checkIndex(index) {
    if (index !== 0 && index !== 1) {
      throw new Error('invalid args: drive must be 1 or 2');
    }
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** M: Q88() で得たモジュール(FS・_webq88_disk_* が使えること)。 */
  function create(M) {
    var drives = [null, null]; // {name, gen, orig:Uint8Array}
    var gen = 0;

    try {
      M.FS.mkdir(DISK_DIR);
    } catch (e) {
      // 既に存在する場合は無視
    }

    function pathPtr(path) {
      var n = path.length * 4 + 1;
      var ptr = M._malloc(n);
      M.stringToUTF8(path, ptr, n);
      return ptr;
    }

    function coreInsert(index) {
      var p = pathPtr(diskPath(index));
      try {
        return M._webq88_disk_insert(index, p) === 1;
      } finally {
        M._free(p);
      }
    }

    function insert(index, name, bytes) {
      checkIndex(index);
      if (!(bytes instanceof Uint8Array)) throw new Error('invalid args: bytes must be Uint8Array');
      if (bytes.length < D88_HEADER_SIZE) {
        throw new Error('invalid disk image: smaller than a D88 header (' + D88_HEADER_SIZE + ' bytes)');
      }
      // 先に取り出して上流の状態と JS 側の記録を揃える(挿入に失敗しても空にする)
      M._webq88_disk_eject(index);
      drives[index] = null;
      gen++;
      M.FS.writeFile(diskPath(index), bytes);
      if (!coreInsert(index)) {
        throw new Error('insert failed: not a usable D88 image');
      }
      gen++;
      drives[index] = { name: String(name), gen: gen, orig: bytes.slice() };
      var st = stat(index);
      return { gen: gen, size: st.size, mtime: st.mtime };
    }

    function eject(index) {
      checkIndex(index);
      M._webq88_disk_eject(index);
      var had = !!drives[index];
      drives[index] = null;
      gen++;
      return { had: had };
    }

    function requireDisk(index) {
      checkIndex(index);
      if (!drives[index]) throw new Error('drive ' + (index + 1) + ' is empty');
      return drives[index];
    }

    /** 現在のイメージ全体(コピー)。opts.noFlush は検査(陰性対照)専用。 */
    function dump(index, opts) {
      requireDisk(index);
      if (!(opts && opts.noFlush) && typeof M._fflush === 'function') M._fflush(0);
      return new Uint8Array(M.FS.readFile(diskPath(index))); // readFile は内部バッファの別コピーを返す
    }

    function stat(index) {
      var st = M.FS.stat(diskPath(index));
      return { size: st.size, mtime: +st.mtime };
    }

    /** 変更検出用。mtime/size はゲストの書き込みで変わる。 */
    function poll() {
      var out = [];
      for (var i = 0; i < 2; i++) {
        var d = drives[i];
        if (!d) {
          out.push({ present: false });
          continue;
        }
        var st = stat(i);
        out.push({ present: true, name: d.name, gen: d.gen, size: st.size, mtime: st.mtime });
      }
      return out;
    }

    /** list_disks 用。名前・サイズ・書き込みの有無のみ(中身は返さない)。 */
    function list() {
      var out = [];
      for (var i = 0; i < 2; i++) {
        var d = drives[i];
        if (!d) {
          out.push({ drive: i + 1, empty: true });
          continue;
        }
        var now = dump(i);
        out.push({ drive: i + 1, empty: false, name: d.name, size: now.length, written: !bytesEqual(now, d.orig) });
      }
      return out;
    }

    /** retro_load_game(全イジェクト)の後に呼ぶ。MEMFS 上の中身ごと挿入し直す。 */
    function reinsertAll() {
      var n = 0;
      for (var i = 0; i < 2; i++) {
        if (!drives[i]) continue;
        if (coreInsert(i)) {
          n++;
        } else {
          drives[i] = null;
          gen++;
        }
      }
      return n; // 挿入し直せたドライブ数
    }

    /** アクセスランプのビットマスク(bit0=ドライブ1, bit1=ドライブ2)。 */
    function lampMask() {
      return (M._webq88_drive_busy(0) ? 1 : 0) | (M._webq88_drive_busy(1) ? 2 : 0);
    }

    return {
      insert: insert,
      eject: eject,
      dump: dump,
      poll: poll,
      list: list,
      reinsertAll: reinsertAll,
      lampMask: lampMask,
      present: function (index) {
        checkIndex(index);
        return !!drives[index];
      },
      path: diskPath,
    };
  }

  var api = { create: create, diskPath: diskPath, D88_HEADER_SIZE: D88_HEADER_SIZE };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.WebQ88DiskHost = api;
  }
})(typeof self !== 'undefined' ? self : this);
