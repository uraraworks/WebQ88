// QUASI88 の libretro.c にある RETROK → KEY88 対応に基づく配列。
type Key = { label: string; code: number; width?: number; modifier?: boolean };
const key = (label: string, code: number, width?: number, modifier = false): Key => ({ label, code, width, modifier });
const chars = (text: string): Key[] => [...text].map(c => key(c.toUpperCase(), c.charCodeAt(0)));
const rows: Key[][] = [
  [key('f1',282), key('f2',283), key('f3',284), key('f4',285), key('f5',286), key('STOP',318), key('COPY',316)],
  [key('ESC',27), ...chars('1234567890-^\\'), key('BS/DEL',8,1.5), key('INS',277)],
  [key('TAB',9,1.4), ...chars('qwertyuiop@['), key('RETURN',13,1.6), key('HOME/CLR',278)],
  [key('CTRL',305,1.5,true), ...chars('asdfghjkl;:]'), key('HELP',279)],
  [key('SHIFT',304,1.8,true), ...chars('zxcvbnm,./_'), key('SHIFT',303,1.8,true), key('↑',273)],
  [key('CAPS',301,1,true), key('カナ',311,1,true), key('GRPH',308,1,true), key('SPACE',32,5), key('←',276), key('↓',274), key('→',275), key('ROLL UP',280), key('ROLL DOWN',281)],
];
const keypad: Key[][] = [
  [key('7',263), key('8',264), key('9',265), key('/',267), key('*',268)],
  [key('4',260), key('5',261), key('6',262), key('-',269), key('+',270)],
  [key('1',257), key('2',258), key('3',259), key('=',272)],
  [key('0',256,2), key(',',271), key('.',266)],
];

export function initVirtualKeyboard(send: (code: number, pressed: boolean) => void, update: () => void): void {
  const panel = document.querySelector<HTMLElement>('#virtual-keyboard')!;
  const toggle = document.querySelector<HTMLButtonElement>('#keyboard-toggle')!;
  const active = new Map<number, HTMLButtonElement>();
  const pointers = new Map<number, { code: number; button: HTMLButtonElement }>();
  const counts = new Map<number, number>();
  const change = (code: number, delta: number): void => {
    const before = counts.get(code) ?? 0, after = before + delta;
    if (after) counts.set(code, after); else counts.delete(code);
    if ((before > 0) !== (after > 0)) send(code, after > 0);
  };
  const clearModifiers = (all = false): void => {
    for (const [code, button] of active) {
      if (!all && (code === 301 || code === 311)) continue;
      button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); change(code, -1); active.delete(code);
    }
  };
  const release = (id: number, clear = true): void => {
    const state = pointers.get(id); if (!state) return;
    pointers.delete(id); state.button.classList.remove('pressed'); change(state.code, -1);
    if (clear) clearModifiers();
  };
  const releaseAll = (): void => { for (const id of [...pointers.keys()]) release(id, false); clearModifiers(true); };
  const build = (definitions: Key[][], className: string): HTMLElement => {
    const group = document.createElement('div'); group.className = className;
    for (const row of definitions) {
      const line = document.createElement('div'); line.className = 'kbd-row';
      for (const def of row) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'kbd-key'; button.textContent = def.label;
        if (def.width) button.style.flexGrow = String(def.width);
        if (def.modifier) button.setAttribute('aria-pressed', 'false');
        button.addEventListener('pointerdown', e => {
          e.preventDefault();
          if (def.modifier) {
            if (active.has(def.code)) { active.delete(def.code); button.classList.remove('active'); button.setAttribute('aria-pressed','false'); change(def.code,-1); }
            else { active.set(def.code,button); button.classList.add('active'); button.setAttribute('aria-pressed','true'); change(def.code,1); }
          } else if (!pointers.has(e.pointerId)) {
            pointers.set(e.pointerId, { code: def.code, button }); button.classList.add('pressed'); change(def.code,1);
            try { button.setPointerCapture(e.pointerId); } catch { /* 取得できなくても押下する */ }
          }
        });
        for (const event of ['pointerup','pointercancel','lostpointercapture'] as const) button.addEventListener(event, e => release(e.pointerId));
        line.append(button);
      }
      group.append(line);
    }
    return group;
  };
  panel.append(build(rows, 'kbd-main'));
  const pad = build(keypad, 'kbd-tenkey'); pad.hidden = true; panel.append(pad);
  const padToggle = document.createElement('button'); padToggle.type = 'button'; padToggle.className = 'kbd-key kbd-pad-toggle'; padToggle.textContent = 'テンキー'; padToggle.setAttribute('aria-pressed','false');
  panel.querySelector('.kbd-main .kbd-row:last-child')!.append(padToggle);
  padToggle.addEventListener('click', () => { pad.hidden = !pad.hidden; padToggle.classList.toggle('active', !pad.hidden); padToggle.setAttribute('aria-pressed', String(!pad.hidden)); update(); });
  const setVisible = (visible: boolean): void => {
    panel.hidden = !visible; toggle.classList.toggle('active',visible); toggle.setAttribute('aria-pressed',String(visible));
    if (!visible) releaseAll();
    try { localStorage.setItem('webq88-keyboard-visible',String(visible)); } catch { /* 保存不可 */ }
    update();
  };
  toggle.addEventListener('click', () => setVisible(panel.hidden));
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  let visible = false; try { visible = localStorage.getItem('webq88-keyboard-visible') === 'true'; } catch { /* 既定は非表示 */ }
  setVisible(visible);
}
