// keyboard.ts
//
// ブラウザの KeyboardEvent を libretro の RETROK 値へ変換する、人間用キーボード
// 入力の唯一の窓口。
//
// 英字・数字・制御キー（Enter, BS, 矢印, ESC, TAB, F キー, SHIFT/CTRL 単独等）は
// 従来どおり KeyboardEvent.code（物理位置・レイアウト非依存）で変換する
// （quasi88-libretro の src/LIBRETRO/libretro.c の handle_input() を
// _local/quasi88-libretro-src で確認し、対応する RETROK だけを載せている）。
//
// 大事な点: 英字キーは常に小文字側の RETROK（RETROK_a〜z）を送る。Shift の
// 有無はコア側が KEY88_SHIFT の押下状態から解釈するので、英字については
// event.key の大文字小文字（Shift適用後の文字）を見てはいけない
// （見ると「入力源は末端の唯一の窓口へ集約する」の原則が崩れ、
// Shift状態を二重に扱うことになる）。
//
// 記号（印字可能な非英数字）は事情が違う。KeyboardEvent.code は物理位置
// でしかないため、ホストのキー配列（JIS/US 等）によって同じ code から出る
// 文字が変わる（例: US 配列の Backquote は '`' だが、JIS 配列の同じ物理位置は
// '@' を出す）。そこで記号だけは KeyboardEvent.key（実際に出た文字）で判定し、
// 「PC-88 のどのキーを SHIFT あり/なしで押せば同じ文字が出せるか」に変換する。
// この変換表は自動操作API の type_text と共有する
// （public/char-map.js、public/api-dispatch.js 参照。表を2つ持たない）。
// ホスト側で SHIFT を押していても、PC-88 側に必要な SHIFT 状態は表（＝実際に
// 出た文字）だけで決める。押下中の記号キーの keyup は、keydown 時に決めた
// PC-88 キー・SHIFT要否をそのまま使う（keyup 時の e.key は SHIFT の離し順で
// 変わりうるため、keydown 時の対応を覚えておく）。

// enum retro_key（libretro.h）から必要な分だけ抜粋。
const RETROK = {
  BACKSPACE: 8,
  TAB: 9,
  RETURN: 13,
  ESCAPE: 27,
  SPACE: 32,
  DIGIT0: 48,
  A: 97,
  DELETE: 127,
  KP0: 256,
  KP_PERIOD: 266,
  KP_DIVIDE: 267,
  KP_MULTIPLY: 268,
  KP_MINUS: 269,
  KP_PLUS: 270,
  KP_ENTER: 271,
  KP_EQUALS: 272,
  UP: 273,
  DOWN: 274,
  RIGHT: 275,
  LEFT: 276,
  INSERT: 277,
  HOME: 278,
  END: 279,
  PAGEUP: 280,
  PAGEDOWN: 281,
  F1: 282,
  CAPSLOCK: 301,
  RSHIFT: 303,
  LSHIFT: 304,
  RCTRL: 305,
  LCTRL: 306,
  RALT: 307,
  LALT: 308,
} as const;

/**
 * KeyboardEvent.code → RETROK の対応表。
 *
 * 記号キー（Quote/Comma/Minus/Period/Slash/Semicolon/Equal/BracketLeft/
 * Backslash/BracketRight/Backquote 等）はここに載せない。物理位置だけでは
 * ホストのキー配列違いを吸収できないため、resolveSymbolKey() で
 * KeyboardEvent.key から解決する。
 */
const CODE_TO_RETROK: Record<string, number> = {
  Backspace: RETROK.BACKSPACE,
  Tab: RETROK.TAB,
  Enter: RETROK.RETURN,
  NumpadEnter: RETROK.KP_ENTER,
  Escape: RETROK.ESCAPE,
  Space: RETROK.SPACE,
  Delete: RETROK.DELETE,
  ArrowUp: RETROK.UP,
  ArrowDown: RETROK.DOWN,
  ArrowRight: RETROK.RIGHT,
  ArrowLeft: RETROK.LEFT,
  Insert: RETROK.INSERT,
  Home: RETROK.HOME,
  End: RETROK.END,
  PageUp: RETROK.PAGEUP,
  PageDown: RETROK.PAGEDOWN,
  CapsLock: RETROK.CAPSLOCK,
  ShiftRight: RETROK.RSHIFT,
  ShiftLeft: RETROK.LSHIFT,
  ControlRight: RETROK.RCTRL,
  ControlLeft: RETROK.LCTRL,
  AltRight: RETROK.RALT,
  AltLeft: RETROK.LALT,
  NumpadDecimal: RETROK.KP_PERIOD,
  NumpadDivide: RETROK.KP_DIVIDE,
  NumpadMultiply: RETROK.KP_MULTIPLY,
  NumpadSubtract: RETROK.KP_MINUS,
  NumpadAdd: RETROK.KP_PLUS,
  NumpadEqual: RETROK.KP_EQUALS,
};

// 数字 (Digit0-9 → RETROK 48-57)
for (let i = 0; i <= 9; i++) {
  CODE_TO_RETROK[`Digit${i}`] = RETROK.DIGIT0 + i;
  CODE_TO_RETROK[`Numpad${i}`] = RETROK.KP0 + i;
}
// 英字 (KeyA-Z → RETROK_a-z、常に小文字側)
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode('A'.charCodeAt(0) + i);
  CODE_TO_RETROK[`Key${letter}`] = RETROK.A + i;
}
// ファンクションキー F1-F10（コア側が listen しているのはこの範囲まで）
for (let i = 1; i <= 10; i++) {
  CODE_TO_RETROK[`F${i}`] = RETROK.F1 + (i - 1);
}

/** KeyboardEvent.code を RETROK 値に変換する。対応表に無ければ null。 */
export function codeToRetroKey(code: string): number | null {
  return CODE_TO_RETROK[code] ?? null;
}

/** public/char-map.js の WebQ88CharMap が持つ形（依存を注入できるようにした最小インターフェース）。 */
export interface CharMapLike {
  charToKeySteps(charCode: number): { code: number; shift: boolean } | null;
}

/**
 * 記号（印字可能な非英数字）を KeyboardEvent.key から PC-88 の物理キー
 * （RETROK値。type_text と同じ値域＝多くはASCIIコードそのもの）と
 * SHIFT要否へ解決する。英数字・複数文字のキー名（"Enter" 等）は
 * 対象外として null を返す（それらは codeToRetroKey() 側で扱う）。
 *
 * charMap を引数で受け取る純関数にしてあるのは、window に依存せず
 * Node から直接単体試験できるようにするため（public/char-map.js を
 * require して渡せばよい）。
 */
export function resolveSymbolKey(key: string, charMap: CharMapLike): { code: number; shift: boolean } | null {
  if (key.length !== 1) return null;
  const charCode = key.charCodeAt(0);
  // 数字・英字は codeToRetroKey() 側（KeyboardEvent.code）で扱うので対象外。
  if (charCode >= 48 && charCode <= 57) return null;
  if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) return null;
  return charMap.charToKeySteps(charCode);
}

/** ブラウザの window.WebQ88CharMap（index.html が public/char-map.js を読み込んで生やす）。 */
function getGlobalCharMap(): CharMapLike | null {
  const g = globalThis as unknown as { WebQ88CharMap?: CharMapLike };
  return g.WebQ88CharMap ?? null;
}

export type KeyStateListener = (retroKey: number, pressed: boolean) => void;

/**
 * キーボード入力の唯一の窓口。
 * window の keydown/keyup をここに集約し、変換した RETROK を1つのコールバックへ渡す。
 * 呼び出し元を増やす場合もここを経由させ、配線を分散させない。
 */
export function attachKeyboard(target: EventTarget, onKeyState: KeyStateListener, numpadAlt: () => boolean = () => false): () => void {
  const activeKeys = new Map<string, number>();
  const keyDemand = new Map<number, number>();
  const altArrows: Record<string, number> = { ArrowUp: 8, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 6 };
  const resolveKey = (code: string): number | null => {
    if (numpadAlt()) {
      if (/^Digit[0-9]$/.test(code)) return RETROK.KP0 + Number(code.slice(5));
      if (code in altArrows) return RETROK.KP0 + altArrows[code];
    }
    return codeToRetroKey(code);
  };
  // 記号キー: 物理キー(e.code)ごとに「keydown 時に実際に送った PC-88 キーと、
  // 併せて仮想 SHIFT を押したか」を覚えておく。keyup 時の e.key は SHIFT の
  // 離し順で変わりうるため、keydown 時の対応をそのまま使って離す。
  const activeSymbolKeys = new Map<string, { retroKey: number; shift: boolean }>();

  // LSHIFT は「実キーボードの ShiftLeft」と「記号キー用の仮想SHIFT」の
  // 両方から要求されうる共有リソースなので、要求元の数を数えて 0→1 / 1→0 の
  // 遷移でだけ実際に PC-88 へ送る（どちらか片方を離しても、もう片方がまだ
  // 要求していれば離さない）。これにより、SHIFT を押したまま記号→英字を
  // 続けて打っても英字の大文字化が壊れない。
  let lshiftDemand = 0;
  const setLShiftDemand = (delta: number) => {
    const before = lshiftDemand > 0;
    lshiftDemand += delta;
    const after = lshiftDemand > 0;
    if (before !== after) onKeyState(RETROK.LSHIFT, after);
  };

  const onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea')) return;

    const controlRetroKey = resolveKey(e.code);
    if (controlRetroKey !== null) {
      e.preventDefault();
      if (e.repeat || activeKeys.has(e.code)) return; // libretro 側はキー押しっぱなし状態を保持するのでリピートは無視してよい
      activeKeys.set(e.code, controlRetroKey);
      if (controlRetroKey === RETROK.LSHIFT) {
        setLShiftDemand(1);
      } else {
        const count = keyDemand.get(controlRetroKey) ?? 0;
        keyDemand.set(controlRetroKey, count + 1);
        if (count === 0) onKeyState(controlRetroKey, true);
      }
      return;
    }

    const charMap = getGlobalCharMap();
    const resolved = charMap ? resolveSymbolKey(e.key, charMap) : null;
    if (resolved === null) return;
    e.preventDefault();
    if (activeSymbolKeys.has(e.code)) return; // 押しっぱなし(auto-repeat)は無視
    activeSymbolKeys.set(e.code, { retroKey: resolved.code, shift: resolved.shift });
    if (resolved.shift) setLShiftDemand(1);
    onKeyState(resolved.code, true);
  };

  const onKeyUp = (ev: Event) => {
    const e = ev as KeyboardEvent;

    const controlRetroKey = activeKeys.get(e.code);
    if (controlRetroKey !== undefined) {
      e.preventDefault();
      activeKeys.delete(e.code);
      if (controlRetroKey === RETROK.LSHIFT) {
        setLShiftDemand(-1);
      } else {
        const count = (keyDemand.get(controlRetroKey) ?? 1) - 1;
        if (count === 0) {
          keyDemand.delete(controlRetroKey);
          onKeyState(controlRetroKey, false);
        } else keyDemand.set(controlRetroKey, count);
      }
      return;
    }

    const active = activeSymbolKeys.get(e.code);
    if (!active) return;
    e.preventDefault();
    activeSymbolKeys.delete(e.code);
    onKeyState(active.retroKey, false);
    if (active.shift) setLShiftDemand(-1);
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
  };
}
