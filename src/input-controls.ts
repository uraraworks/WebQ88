import { codeToRetroKey } from './keyboard';

type Bindings = Record<string, number>;
type Settings = { version: 1; gamepad: Bindings; virtual: Bindings; host: Bindings; deadzone: number; visible: boolean };
const tenkey: Bindings = { up: 264, down: 258, left: 260, right: 262, a: 32, b: 13, x: 27, y: 122, start: 13, select: 27, 'axis0-': 260, 'axis0+': 262, 'axis1-': 264, 'axis1+': 258 };
const cursor: Bindings = { ...tenkey, up: 273, down: 274, left: 276, right: 275, a: 122, b: 120, 'axis0-': 276, 'axis0+': 275, 'axis1-': 273, 'axis1+': 274 };
const parts: Record<string, string> = { up: '上', down: '下', left: '左', right: '右', a: 'A', b: 'B', x: 'X', y: 'Y', start: 'START', select: 'SELECT' };
const buttons = ['a', 'b', 'x', 'y', 'l', 'r', 'l2', 'r2', 'select', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right'];
const keys: Array<[string, number]> = [['割当なし', -1], ['SPACE', 32], ['RETURN', 13], ['ESC', 27], ['TAB', 9], ['SHIFT', 304], ['CTRL', 306], ['BS/DEL', 8], ['INS', 277], ['HOME/CLR', 278], ['HELP', 279], ['ROLL UP', 280], ['ROLL DOWN', 281], ['CAPS', 301], ['カナ', 311], ['GRPH', 308], ['STOP', 318], ['COPY', 316], ...[...'@[-^\\;:],./_'].map((c): [string, number] => [c, c.charCodeAt(0)]), ...[['テンキー /', 267], ['テンキー *', 268], ['テンキー -', 269], ['テンキー +', 270], ['テンキー ,', 271], ['テンキー .', 266], ['テンキー =', 272]] as Array<[string, number]>, ['↑', 273], ['↓', 274], ['←', 276], ['→', 275], ...Array.from({length: 10}, (_, i): [string, number] => [`テンキー ${i}`, 256 + i]), ...Array.from({length: 26}, (_, i): [string, number] => [String.fromCharCode(65 + i), 97 + i]), ...Array.from({length: 10}, (_, i): [string, number] => [String(i), 48 + i]), ...Array.from({length: 10}, (_, i): [string, number] => [`F${i + 1}`, 282 + i])];
const initial = (): Settings => ({ version: 1, gamepad: {...tenkey}, virtual: {...tenkey}, host: {}, deadzone: .3, visible: false });
function load(): Settings {
  const def = initial();
  try {
    const s = JSON.parse(localStorage.getItem('webq88-input-settings') || 'null') as Settings | null;
    if (!s || s.version !== 1) return def;
    const clean = (v: unknown): Bindings => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([k, n]) => k.length < 80 && Number.isInteger(n) && keys.some(([, c]) => c === n && c >= 0))) as Bindings;
    return { version: 1, gamepad: clean(s.gamepad), virtual: clean(s.virtual), host: clean(s.host), deadzone: Number.isFinite(s.deadzone) ? Math.max(.05, Math.min(.95, s.deadzone)) : .3, visible: !!s.visible };
  } catch { return def; }
}
export function initInputControls(createSource: () => (code: number, pressed: boolean) => void): () => Bindings {
  const settings = load();
  const save = () => { try { localStorage.setItem('webq88-input-settings', JSON.stringify(settings)); } catch { /* 保存不可 */ } };
  const send = createSource();
  let active = new Map<string, number>();
  const reconcile = (next: Map<string, number>) => {
    const before = new Set(active.values()), after = new Set(next.values());
    for (const k of before) if (!after.has(k)) send(k, false);
    for (const k of after) if (!before.has(k)) send(k, true);
    active = next;
  };
  const pointers = new Map<number, string>();
  let gamepadSources = new Set<string>();
  const refresh = () => {
    const next = new Map<string, number>();
    for (const source of gamepadSources) { const k = settings.gamepad[source]; if (k !== undefined) next.set(`g:${source}`, k); }
    for (const [id, source] of pointers) { const k = settings.virtual[source]; if (k !== undefined) next.set(`v:${id}`, k); }
    reconcile(next);
  };
  const player = document.querySelector<HTMLElement>('#player')!;
  const panel = document.createElement('div'); panel.className = 'virtual-pad'; panel.setAttribute('aria-label', 'バーチャルパッド');
  const dpad = document.createElement('div'); dpad.className = 'vpad-directions';
  const actions = document.createElement('div'); actions.className = 'vpad-actions';
  for (const [id, label] of Object.entries(parts)) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = `vpad-${id}`;
    b.addEventListener('pointerdown', e => { e.preventDefault(); pointers.set(e.pointerId, id); b.classList.add('pressed'); try { b.setPointerCapture(e.pointerId); } catch { /* capture 不可 */ } refresh(); });
    const release = (e: PointerEvent) => { if (pointers.get(e.pointerId) !== id) return; pointers.delete(e.pointerId); b.classList.remove('pressed'); refresh(); };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(event, release);
    (['up','down','left','right'].includes(id) ? dpad : actions).append(b);
  }
  panel.append(dpad, actions); player.querySelector('#screen-stage')!.append(panel);
  const toggle = document.querySelector<HTMLButtonElement>('#vpad-toggle')!;
  const renderVisible = () => { panel.hidden = !settings.visible; toggle.classList.toggle('active', settings.visible); toggle.setAttribute('aria-pressed', String(settings.visible)); if (!settings.visible) { pointers.clear(); panel.querySelectorAll('.pressed').forEach(b => b.classList.remove('pressed')); refresh(); } };
  toggle.addEventListener('click', () => { settings.visible = !settings.visible; save(); renderVisible(); }); renderVisible();
  const backdrop = document.createElement('div'); backdrop.className = 'library-backdrop input-backdrop'; backdrop.hidden = true;
  const dialog = document.createElement('section'); dialog.className = 'library-modal'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-label','入力設定'); backdrop.append(dialog); player.append(backdrop);
  const title = document.createElement('h2'); title.textContent = '入力設定'; dialog.append(title);
  const status = document.createElement('p'); status.textContent = 'ゲームパッド: 未接続'; dialog.append(status);
  const zoneLabel = document.createElement('label'); zoneLabel.textContent = 'スティックのデッドゾーン '; const zone = document.createElement('input'); zone.type = 'range'; zone.min = '0.05'; zone.max = '0.95'; zone.step = '0.05'; zone.value = String(settings.deadzone); const zoneValue = document.createElement('span'); zoneValue.textContent = zone.value; zone.addEventListener('input', () => { settings.deadzone = Number(zone.value); zoneValue.textContent = zone.value; save(); }); zoneLabel.append(zone, zoneValue); dialog.append(zoneLabel);
  const selectKey = (value: number | undefined, changed: (n: number) => void) => {
    const select = document.createElement('select'); for (const [label, code] of keys) { const o = document.createElement('option'); o.value = String(code); o.textContent = label; select.append(o); } select.value = String(value ?? -1); select.addEventListener('change', () => changed(Number(select.value))); return select;
  };
  const sections = document.createElement('div'); dialog.append(sections);
  const render = () => {
    sections.replaceChildren();
    for (const kind of ['gamepad','virtual'] as const) {
      const section = document.createElement('section'); const h = document.createElement('h3'); h.textContent = kind === 'gamepad' ? 'ゲームパッド割当' : 'バーチャルパッド割当'; section.append(h);
      const preset = document.createElement('select'); preset.innerHTML = '<option value="">プリセットを選択</option><option value="tenkey">テンキー移動＋SPACE/RETURN</option><option value="cursor">カーソル＋Z/X</option>'; preset.addEventListener('change', () => { if (!preset.value) return; settings[kind] = {...(preset.value === 'tenkey' ? tenkey : cursor)}; save(); refresh(); render(); }); section.append(preset);
      const ids = kind === 'gamepad' ? [...buttons, 'axis0-', 'axis0+', 'axis1-', 'axis1+', 'axis2-', 'axis2+', 'axis3-', 'axis3+'] : Object.keys(parts);
      const grid = document.createElement('div'); grid.className = 'input-grid';
      for (const id of ids) { const row = document.createElement('label'); row.textContent = `${parts[id] ?? (id.startsWith('axis') ? `軸 ${id.slice(4)}` : id.toUpperCase())} `; row.append(selectKey(settings[kind][id], n => { if (n < 0) delete settings[kind][id]; else settings[kind][id] = n; save(); refresh(); })); grid.append(row); } section.append(grid); sections.append(section);
    }
    const section = document.createElement('section'); const h = document.createElement('h3'); h.textContent = 'キーボード割当'; section.append(h); const note = document.createElement('p'); note.textContent = '入力欄で割り当て元のキーを押し、変換先を選択します。'; section.append(note);
    for (const code of Object.keys(settings.host).sort()) { const row = document.createElement('div'); row.className = 'host-row'; const label = document.createElement('span'); label.textContent = code; const del = document.createElement('button'); del.textContent = '削除'; del.type = 'button'; del.onclick = () => { delete settings.host[code]; save(); render(); }; row.append(label, selectKey(settings.host[code], n => { if (n < 0) delete settings.host[code]; else settings.host[code] = n; save(); render(); }), del); section.append(row); }
    const capture = document.createElement('input'); capture.placeholder = 'ここを選び、キーを押して追加'; capture.readOnly = true; capture.addEventListener('keydown', e => { e.preventDefault(); e.stopPropagation(); const k = codeToRetroKey(e.code); settings.host[e.code] = keys.some(([, n]) => n === k) ? k! : 32; save(); render(); }); section.append(capture); sections.append(section);
  };
  render(); const close = document.createElement('button'); close.type = 'button'; close.textContent = '閉じる'; close.onclick = () => { backdrop.hidden = true; }; dialog.append(close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.hidden = true; });
  document.querySelector<HTMLButtonElement>('#input-settings')!.addEventListener('click', () => { backdrop.hidden = false; render(); });
  let lastStatus = '';
  const poll = () => {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter((p): p is Gamepad => !!p && p.connected) : [];
    const text = pads.length ? `ゲームパッド: ${pads.map(p => p.id).join(', ')}` : 'ゲームパッド: 未接続'; if (text !== lastStatus) { status.textContent = text; lastStatus = text; }
    const next = new Set<string>();
    if (!document.hidden && document.hasFocus()) for (const pad of pads) {
      pad.buttons.forEach((b, i) => { if (b.pressed && buttons[i]) next.add(buttons[i]); });
      pad.axes.slice(0, 4).forEach((v, i) => { if (v < -settings.deadzone) next.add(`axis${i}-`); if (v > settings.deadzone) next.add(`axis${i}+`); });
    }
    gamepadSources = next; refresh(); requestAnimationFrame(poll);
  }; requestAnimationFrame(poll);
  const release = () => { pointers.clear(); gamepadSources.clear(); panel.querySelectorAll('.pressed').forEach(b => b.classList.remove('pressed')); refresh(); };
  window.addEventListener('blur', release); document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  return () => settings.host;
}
