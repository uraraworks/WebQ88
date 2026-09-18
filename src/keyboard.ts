// keyboard.ts
//
// KeyboardEvent.code（物理キー・レイアウト非依存）を libretro の RETROK 値へ変換する。
// quasi88-libretro の src/LIBRETRO/libretro.c の handle_input() を
// _local/quasi88-libretro-src で確認し、対応する RETROK だけを載せている。
//
// 大事な点: 英字キーは常に小文字側の RETROK（RETROK_a〜z）を送る。
// Shift の有無はコア側が KEY88_SHIFT の押下状態から解釈するので、
// ブラウザ側で event.key の大文字小文字（Shift適用後の文字）を見てはいけない
// （見ると「入力源は末端の唯一の窓口へ集約する」の原則が崩れ、
// Shift状態を二重に扱うことになる）。

// enum retro_key（libretro.h）から必要な分だけ抜粋。
const RETROK = {
  BACKSPACE: 8,
  TAB: 9,
  RETURN: 13,
  ESCAPE: 27,
  SPACE: 32,
  QUOTE: 39,
  COMMA: 44,
  MINUS: 45,
  PERIOD: 46,
  SLASH: 47,
  DIGIT0: 48,
  SEMICOLON: 59,
  EQUALS: 61,
  LEFTBRACKET: 91,
  BACKSLASH: 92,
  RIGHTBRACKET: 93,
  BACKQUOTE: 96,
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

/** KeyboardEvent.code → RETROK の対応表。 */
const CODE_TO_RETROK: Record<string, number> = {
  Backspace: RETROK.BACKSPACE,
  Tab: RETROK.TAB,
  Enter: RETROK.RETURN,
  NumpadEnter: RETROK.KP_ENTER,
  Escape: RETROK.ESCAPE,
  Space: RETROK.SPACE,
  Quote: RETROK.QUOTE,
  Comma: RETROK.COMMA,
  Minus: RETROK.MINUS,
  Period: RETROK.PERIOD,
  Slash: RETROK.SLASH,
  Semicolon: RETROK.SEMICOLON,
  Equal: RETROK.EQUALS,
  BracketLeft: RETROK.LEFTBRACKET,
  Backslash: RETROK.BACKSLASH,
  BracketRight: RETROK.RIGHTBRACKET,
  Backquote: RETROK.BACKQUOTE,
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

export type KeyStateListener = (retroKey: number, pressed: boolean) => void;

/**
 * キーボード入力の唯一の窓口。
 * window の keydown/keyup をここに集約し、変換した RETROK を1つのコールバックへ渡す。
 * 呼び出し元を増やす場合もここを経由させ、配線を分散させない。
 */
export function attachKeyboard(target: EventTarget, onKeyState: KeyStateListener): () => void {
  const onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const retroKey = codeToRetroKey(e.code);
    if (retroKey === null) return;
    e.preventDefault();
    if (e.repeat) return; // libretro 側はキー押しっぱなし状態を保持するのでリピートは無視してよい
    onKeyState(retroKey, true);
  };
  const onKeyUp = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const retroKey = codeToRetroKey(e.code);
    if (retroKey === null) return;
    e.preventDefault();
    onKeyState(retroKey, false);
  };
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
  };
}
