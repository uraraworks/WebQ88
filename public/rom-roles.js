// public/rom-roles.js
//
// ROMファイル名 → 役割(role) の対応表と、「同梱ROM(bundled)」「利用者ROM(user)」を
// 役割ごとに1本へマージする判定ロジック。
//
// QUASI88 の src/LIBRETRO/libretro.c にある bios_filenames 配列と同じ名前群
// (大文字小文字無視)を役割ごとにまとめたもの。ここが正典で、Worker
// (public/core-worker.js、classicスクリプトなので importScripts)と
// Node側のスモークテスト(scripts/smoke-mode.cjs、CommonJS)の両方が
// このファイルを使う。判定ロジックを二重化しない
// (../../CLAUDE.md系メモ、および ../public/key-hold-tracker.js と同じ考え方)。
//
// 出どころ(origin)の判定は「中身ではなく由来」で行う(../docs/API-DESIGN.md 第3節)。
// 役割が1つでも origin='user' で埋まっていれば、そのセッションは制限モードに倒す
// (安全側。利用者が自作ROMを渡した場合も同様に扱う)。

(function (global) {
  'use strict';

  // 役割ごとのファイル名候補。配列の並び順に意味はない(どれが存在してもよい)。
  var ROM_ROLES = [
    { role: 'N88', names: ['N88.ROM'] },
    { role: 'N88EXT0', names: ['N88EXT0.ROM', 'N88_0.ROM'] },
    { role: 'N88EXT1', names: ['N88EXT1.ROM', 'N88_1.ROM'] },
    { role: 'N88EXT2', names: ['N88EXT2.ROM', 'N88_2.ROM'] },
    { role: 'N88EXT3', names: ['N88EXT3.ROM', 'N88_3.ROM'] },
    { role: 'N88N', names: ['N88N.ROM', 'N80.ROM'] },
    { role: 'N88SUB', names: ['N88SUB.ROM', 'DISK.ROM'] },
    { role: 'N88KNJ1', names: ['N88KNJ1.ROM', 'KANJI1.ROM'] },
    { role: 'N88KNJ2', names: ['N88KNJ2.ROM', 'KANJI2.ROM'] },
    { role: 'N88JISHO', names: ['N88JISHO.ROM', 'JISYO.ROM'] },
    { role: 'FONT', names: ['FONT.ROM'] },
    { role: 'FONT2', names: ['FONT2.ROM'] },
    { role: 'FONT3', names: ['FONT3.ROM'] },
  ];

  /** ファイル名から役割を引く(大文字小文字無視)。見つからなければ null。 */
  function resolveRole(filename) {
    var upper = String(filename).toUpperCase();
    for (var i = 0; i < ROM_ROLES.length; i++) {
      var names = ROM_ROLES[i].names;
      for (var j = 0; j < names.length; j++) {
        if (names[j].toUpperCase() === upper) return ROM_ROLES[i].role;
      }
    }
    return null;
  }

  /** 役割の全バリアント名を1本の配列にして返す(/sys 掃除用)。 */
  function allKnownFilenames() {
    var out = [];
    for (var i = 0; i < ROM_ROLES.length; i++) {
      var names = ROM_ROLES[i].names;
      for (var j = 0; j < names.length; j++) {
        out.push(names[j]);
      }
    }
    return out;
  }

  /**
   * bundledFiles / userFiles: [{name, bytes}] (bytesはArrayBuffer等、中身は見ない)
   *
   * 戻り値:
   *   {
   *     restricted: boolean,                                    // 1本でも origin='user' が使われたか
   *     placements: [{role, name, bytes, origin}],               // 役割ごとに1本(利用者優先)
   *     unresolved: [{name, origin}],                             // 既知の役割に一致しなかったファイル(使用しない)
   *   }
   *
   * 役割ごとに: 利用者ファイルがあればそれを優先し、無ければ同梱ファイルで補う(混成可)。
   * 判定は中身ではなく出どころ(呼び出し側がどちらの配列に入れて渡したか)で行う。
   */
  function planRomPlacement(bundledFiles, userFiles) {
    var byRole = {};
    var unresolved = [];

    function ingest(files, origin) {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var role = resolveRole(f.name);
        if (!role) {
          unresolved.push({ name: f.name, origin: origin });
          continue;
        }
        // 同梱を先に積み、利用者を後から積むことで「利用者優先」を単純な上書きで表現する。
        var existing = byRole[role];
        if (!existing || origin === 'user') {
          byRole[role] = { role: role, name: f.name, bytes: f.bytes, origin: origin };
        }
      }
    }

    ingest(bundledFiles || [], 'bundled');
    ingest(userFiles || [], 'user');

    var placements = [];
    var restricted = false;
    Object.keys(byRole).forEach(function (role) {
      var p = byRole[role];
      placements.push(p);
      if (p.origin === 'user') restricted = true;
    });

    return { restricted: restricted, placements: placements, unresolved: unresolved };
  }

  var api = {
    ROM_ROLES: ROM_ROLES,
    resolveRole: resolveRole,
    allKnownFilenames: allKnownFilenames,
    planRomPlacement: planRomPlacement,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.WebQ88RomRoles = api;
  }
})(typeof self !== 'undefined' ? self : this);
