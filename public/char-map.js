// public/char-map.js
//
// 「1文字(ASCII)を、PC-8801のどの物理キー(RETROK)をSHIFTあり/なしで押せば
// 出せるか」を解決する共有テーブル。元は public/api-dispatch.js の
// type_text 実装にだけあったが、人間用キーボード入力(src/keyboard.ts)の
// 記号キー変換でも同じ対応が要る(KeyboardEvent.code は物理位置なので
// ホストのキー配列(JIS/US)によってズレる。KeyboardEvent.key(実際に出た文字)
// で引くしかない)。表を2つ持つと必ずズレるので、ここへ1本化して
// public/api-dispatch.js・src/keyboard.ts の両方から参照する
// (public/rom-roles.js・public/key-hold-tracker.js と同じ「ロジックを
// 二重化しない」流儀)。
//
// PC-8801の実キーボードは、多くの記号キーが「1つの物理キーに unshifted/
// shifted の2文字」を持つ(例: ";" キーは無シフトで';'、シフトで'+')。
// quasi88-libretro の src/keyboard.c の keyport[] テーブル(KEY88コード→
// ハードウェアの port/bit)を読むと、この2つの意味は**同じport/bitを共有する
// 別名**に過ぎず、実際に鳴る文字はハードのシフト線(KEY88_SHIFT)の状態だけで
// 決まる(実機で確認済み)。
//
// 判定表(keyport[]の実測。unshifted側の文字はSHIFT不要、shifted側は必要):
//   unshifted: 空白, 0-9, : ; , - . / @ [ \(YEN) ] ^ _ , a-z
//   shifted  : ! " # $ % & ' ( ) * + < = > ? ` { | } ~ , A-Z
//
// Worker(public/core-worker.js、classicスクリプトなのでimportScripts)と
// Node側のスモークテスト(scripts/smoke-api.cjs、CommonJS。api-dispatch.js
// 経由でrequireされる)、ブラウザのメインスレッド(index.htmlの<script>タグ、
// src/keyboard.tsからは window.WebQ88CharMap として参照)の3箇所から使う。

(function (global) {
  'use strict';

  var RETROK_LSHIFT = 304;
  var RETROK_RETURN = 13;

  var SHIFTED_CHARS = '!"#$%&\'()*+<=>?`{|}~';

  function isAsciiLower(c) {
    return c >= 97 && c <= 122;
  }
  function isAsciiUpper(c) {
    return c >= 65 && c <= 90;
  }
  /** 印字可能ASCII(制御文字を除く 32-126)で、handle_input()が直接扱える範囲。 */
  function isDirectAscii(c) {
    return c >= 32 && c <= 126;
  }

  /** 1文字(charCode)を送信可能な打鍵ステップ({code, shift})に変換する。非対応ならnull。 */
  function charToKeySteps(charCode) {
    if (charCode === 10) {
      // \n → RETURN
      return { code: RETROK_RETURN, shift: false };
    }
    if (isAsciiUpper(charCode)) {
      return { code: charCode + 32, shift: true }; // 小文字コード+SHIFT
    }
    if (isAsciiLower(charCode)) {
      return { code: charCode, shift: false };
    }
    if (isDirectAscii(charCode)) {
      var ch = String.fromCharCode(charCode);
      var needsShift = SHIFTED_CHARS.indexOf(ch) !== -1;
      return { code: charCode, shift: needsShift };
    }
    return null;
  }

  // JISかな配列の文字と物理キー。小書き文字と句読点はSHIFTを使う。
  var kanaKeys = {};
  function addKana(chars, keys, shift) {
    for (var i = 0; i < chars.length; i++) kanaKeys[chars[i]] = { code: keys.charCodeAt(i), shift: shift };
  }
  addKana('ﾇﾌｱｳｴｵﾔﾕﾖﾜﾎﾍｰ', '1234567890-^\\', false);
  addKana('ﾀﾃｲｽｶﾝﾅﾆﾗｾﾞﾟ', 'qwertyuiop@[', false);
  addKana('ﾁﾄｼﾊｷｸﾏﾉﾘﾚｹﾑ', 'asdfghjkl;:]', false);
  addKana('ﾂｻｿﾋｺﾐﾓﾈﾙﾒﾛ', 'zxcvbnm,./_', false);
  addKana('ｧｩｪｫｬｭｮｦ', '34567890', true);
  addKana('ｨｯ｡｢｣､･', 'ez.[ ],/'.replace(' ', ''), true);
  function kanaToKeySteps(ch) { return kanaKeys[ch] || null; }

  var api = {
    RETROK_LSHIFT: RETROK_LSHIFT,
    RETROK_RETURN: RETROK_RETURN,
    SHIFTED_CHARS: SHIFTED_CHARS,
    charToKeySteps: charToKeySteps,
    kanaToKeySteps: kanaToKeySteps,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.WebQ88CharMap = api;
  }
})(typeof self !== 'undefined' ? self : this);
