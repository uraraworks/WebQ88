import { codeToRetroKey } from './keyboard';

export type VpadWidget =
  | { kind: 'dpad'; ids: { up: string; down: string; left: string; right: string }; xPct: number; yPct: number; sizePct: number }
  | { kind: 'button'; id: string; label: string; xPct: number; yPct: number; sizePct: number };
export interface VpadRect { x: number; y: number; w: number; h: number }
export interface LaidOutWidget { widget: VpadWidget; rect: VpadRect }
export type VpadPlacement = 'panel' | 'overlay' | 'sides';
export interface VpadSideBoxes { left: VpadRect; right: VpadRect }

const DPAD_IDS = { up: 'up', down: 'down', left: 'left', right: 'right' } as const;
const OVERLAY_DPAD: Extract<VpadWidget, { kind: 'dpad' }> = { kind: 'dpad', ids: DPAD_IDS, xPct: 18, yPct: 76, sizePct: 38 };
const PANEL_DPAD: Extract<VpadWidget, { kind: 'dpad' }> = { kind: 'dpad', ids: DPAD_IDS, xPct: 24, yPct: 55, sizePct: 62 };

interface ButtonSlot { xPct: number; yPct: number; sizePct: number }
export const VPAD_SLANT_PCT_PANEL = 5;
export const VPAD_SLANT_PCT_OVERLAY = 4;

function slantedButtonSlots(xs: readonly [number, number, number], lowerY: number, upperY: number, slant: number, size: number): ButtonSlot[] {
  return [
    { xPct: xs[0], yPct: lowerY, sizePct: size }, { xPct: xs[1], yPct: lowerY - slant, sizePct: size },
    { xPct: xs[2], yPct: lowerY - slant * 2, sizePct: size }, { xPct: xs[0], yPct: upperY, sizePct: size },
    { xPct: xs[1], yPct: upperY - slant, sizePct: size }, { xPct: xs[2], yPct: upperY - slant * 2, sizePct: size },
  ];
}

const OVERLAY_BUTTON_SLOTS = slantedButtonSlots([60, 74, 88], 82, 60, VPAD_SLANT_PCT_OVERLAY, 18);
const PANEL_BUTTON_SLOTS = slantedButtonSlots([58, 74, 90], 72, 30, VPAD_SLANT_PCT_PANEL, 22);
const BUTTON_IDS = ['btn-a', 'btn-b', 'btn-c', 'btn-d', 'btn-e', 'btn-f'] as const;
const BUTTON_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const SIX_BUTTON_MARKERS = new Set(['btn-c', 'btn-d', 'btn-e', 'btn-f']);

export const STICK_DEADZONE_RATIO = 0.18;
// styles.css の .vpad-stick-knob の width/height(47%) と一致させること
export const STICK_KNOB_RATIO = 0.47;
// ノブ外縁が外周に内接するように、中心の可動半径をノブ半径ぶん内側に制限する
export const STICK_MAX_RADIUS_RATIO = (1 - STICK_KNOB_RATIO) / 2;

export function placementForViewport(width: number, height: number): Exclude<VpadPlacement, 'overlay'> {
  return width > height ? 'sides' : 'panel';
}

export function vpadWidgetsFor(placement: VpadPlacement, boundIds: ReadonlySet<string>): VpadWidget[] {
  const widgets: VpadWidget[] = [];
  const dpad = placement === 'panel' ? PANEL_DPAD : OVERLAY_DPAD;
  if (Object.values(dpad.ids).some((id) => boundIds.has(id))) widgets.push(dpad);
  const slots = placement === 'panel' ? PANEL_BUTTON_SLOTS : OVERLAY_BUTTON_SLOTS;
  const sixButton = [...SIX_BUTTON_MARKERS].some((id) => boundIds.has(id));
  const buttonSlots = sixButton
    ? BUTTON_IDS.map((id, index) => ({ id, label: BUTTON_LABELS[index], slot: slots[index] }))
    : [{ id: 'btn-b', label: 'B', slot: slots[1] }, { id: 'btn-a', label: 'A', slot: slots[2] }];
  for (const entry of buttonSlots) {
    if (boundIds.has(entry.id)) widgets.push({ kind: 'button', id: entry.id, label: entry.label, ...entry.slot });
  }
  const optionSlots = placement === 'panel'
    ? [{ xPct: 34, yPct: 12, sizePct: 14 }, { xPct: 47, yPct: 12, sizePct: 14 }]
    : [{ xPct: 78, yPct: 8, sizePct: 10 }, { xPct: 90, yPct: 8, sizePct: 10 }];
  for (const [index, id] of ['btn-opt1', 'btn-opt2'].entries()) {
    if (boundIds.has(id)) widgets.push({ kind: 'button', id, label: String(index + 1), ...optionSlots[index] });
  }
  return widgets;
}

function clampRect(rect: VpadRect, width: number, height: number): VpadRect {
  return {
    ...rect,
    x: rect.w >= width ? 0 : Math.max(0, Math.min(rect.x, width - rect.w)),
    y: rect.h >= height ? 0 : Math.max(0, Math.min(rect.y, height - rect.h)),
  };
}

export function layoutVpad(width: number, height: number, widgets: readonly VpadWidget[]): LaidOutWidget[] {
  const base = Math.min(width, height);
  return widgets.map((widget) => {
    const size = base * widget.sizePct / 100;
    return { widget, rect: clampRect({ x: width * widget.xPct / 100 - size / 2, y: height * widget.yPct / 100 - size / 2, w: size, h: size }, width, height) };
  });
}

function clampRectToBox(rect: VpadRect, box: VpadRect): VpadRect {
  const local = clampRect({ x: rect.x - box.x, y: rect.y - box.y, w: rect.w, h: rect.h }, box.w, box.h);
  return { x: local.x + box.x, y: local.y + box.y, w: local.w, h: local.h };
}

/**
 * sides配置の充填率。左右のボックスは縦長で細いため、部品の大きさは
 * ほぼ「箱の幅」で決まる。縦向き(panel配置)より小さくなるので、
 * はみ出さず互いに重ならない範囲まで詰めて取る。
 * 値の根拠は隣の中心間距離で、たとえばオプション2個は中心が幅の
 * OPTION_SPREAD ぶん離れるので直径はそれを超えられない。
 */
const STICK_FILL = 0.9;
const OPTION_SPREAD = 0.46;
const OPTION_FILL = 0.92;
const OPTION_BAND_MAX = 0.25;
const BUTTON_FILL = 0.9;

export function layoutVpadSides(boxes: VpadSideBoxes, boundIds: ReadonlySet<string>): LaidOutWidget[] {
  const { left, right } = boxes;
  const widgets: LaidOutWidget[] = [];
  // オプション(1/2)の帯を先に取り、残りをスティックに割り当てる。
  // スティックを先に最大化して「余った隙間」をオプションに回すと、箱が横広に
  // なったときにオプションだけ極端に潰れる(実測 28.8px)。取り分は先に決める。
  const hasOptions = ['btn-opt1', 'btn-opt2'].some((id) => boundIds.has(id));
  const optionBand = hasOptions ? Math.min(left.w * OPTION_SPREAD, left.h * OPTION_BAND_MAX) : 0;
  const stickAreaY = left.y + optionBand;
  const stickAreaH = Math.max(0, left.h - optionBand);
  const stickDiameter = Math.min(left.w, stickAreaH) * STICK_FILL;
  const stickCenter = { x: left.x + left.w / 2, y: stickAreaY + stickAreaH / 2 };
  if (Object.values(DPAD_IDS).some((id) => boundIds.has(id))) {
    widgets.push({
      widget: { kind: 'dpad', ids: DPAD_IDS, xPct: 0, yPct: 0, sizePct: 0 },
      rect: clampRectToBox({ x: stickCenter.x - stickDiameter / 2, y: stickCenter.y - stickDiameter / 2, w: stickDiameter, h: stickDiameter }, left),
    });
  }
  const optionDiameter = Math.max(0, optionBand * OPTION_FILL);
  const optionRatios = [0.5 - OPTION_SPREAD / 2, 0.5 + OPTION_SPREAD / 2];
  for (const option of [{ id: 'btn-opt1', label: '1', ratio: optionRatios[0] }, { id: 'btn-opt2', label: '2', ratio: optionRatios[1] }]) {
    if (!boundIds.has(option.id)) continue;
    const centerX = left.x + left.w * option.ratio;
    const centerY = left.y + optionBand / 2;
    widgets.push({ widget: { kind: 'button', id: option.id, label: option.label, xPct: 0, yPct: 0, sizePct: 0 }, rect: clampRectToBox({ x: centerX - optionDiameter / 2, y: centerY - optionDiameter / 2, w: optionDiameter, h: optionDiameter }, left) });
  }
  const sixButton = [...SIX_BUTTON_MARKERS].some((id) => boundIds.has(id));
  const grid = sixButton
    ? BUTTON_IDS.map((id, index) => ({ id, label: BUTTON_LABELS[index], row: index < 3 ? 1 : 0, col: index % 3 }))
    : [{ id: 'btn-b', label: 'B', row: 1, col: 1 }, { id: 'btn-a', label: 'A', row: 1, col: 2 }];
  // 段/列は「実際に使う数」で割る。2ボタン構成は col 1,2 の2列しか使わないので、
  // 常に3で割っていると横幅を1列ぶん捨てたままボタンが小さくなる。
  const usedCols = grid.filter((slot) => boundIds.has(slot.id)).map((slot) => slot.col);
  const usedRows = grid.filter((slot) => boundIds.has(slot.id)).map((slot) => slot.row);
  const minCol = usedCols.length > 0 ? Math.min(...usedCols) : 0;
  const colCount = usedCols.length > 0 ? Math.max(...usedCols) - minCol + 1 : 1;
  const rowCount = usedRows.length > 0 ? Math.max(...usedRows) - Math.min(...usedRows) + 1 : 1;
  const colPitch = right.w / colCount;
  const rowPitch = right.h / rowCount;
  const diameter = Math.min(colPitch, rowPitch) * BUTTON_FILL;
  const slant = right.h * 0.045;
  for (const slot of grid) {
    if (!boundIds.has(slot.id)) continue;
    const centerX = right.x + colPitch * (slot.col - minCol + 0.5);
    const centerY = right.y + right.h * (slot.row === 1 ? 0.68 : 0.3) - slant * slot.col;
    widgets.push({ widget: { kind: 'button', id: slot.id, label: slot.label, xPct: 0, yPct: 0, sizePct: 0 }, rect: clampRectToBox({ x: centerX - diameter / 2, y: centerY - diameter / 2, w: diameter, h: diameter }, right) });
  }
  return widgets;
}

export function stickDirsFromPoint(widget: Extract<VpadWidget, { kind: 'dpad' }>, rect: VpadRect, x: number, y: number): string[] {
  const dx = x - (rect.x + rect.w / 2);
  const dy = y - (rect.y + rect.h / 2);
  if (Math.hypot(dx, dy) < Math.min(rect.w, rect.h) * STICK_DEADZONE_RATIO) return [];
  let degrees = Math.atan2(dy, dx) * 180 / Math.PI;
  if (degrees < 0) degrees += 360;
  switch (Math.round(degrees / 45) % 8) {
    case 0: return [widget.ids.right];
    case 1: return [widget.ids.right, widget.ids.down];
    case 2: return [widget.ids.down];
    case 3: return [widget.ids.down, widget.ids.left];
    case 4: return [widget.ids.left];
    case 5: return [widget.ids.left, widget.ids.up];
    case 6: return [widget.ids.up];
    default: return [widget.ids.up, widget.ids.right];
  }
}

export function stickKnobOffset(rect: VpadRect, x: number, y: number): { x: number; y: number } {
  const dx = x - (rect.x + rect.w / 2);
  const dy = y - (rect.y + rect.h / 2);
  const distance = Math.hypot(dx, dy);
  const max = Math.min(rect.w, rect.h) * STICK_MAX_RADIUS_RATIO;
  return distance > max && distance > 0 ? { x: dx / distance * max, y: dy / distance * max } : { x: dx, y: dy };
}


type Bindings = Record<string, number>;
type Settings = { version: 1; gamepad: Bindings; virtual: Bindings; host: Bindings; deadzone: number; visible: boolean };
const tenkey: Bindings = { up: 264, down: 258, left: 260, right: 262, a: 32, b: 13, x: 27, y: 122, start: 13, select: 27, 'axis0-': 260, 'axis0+': 262, 'axis1-': 264, 'axis1+': 258 };
const cursor: Bindings = { ...tenkey, up: 273, down: 274, left: 276, right: 275, a: 122, b: 120, 'axis0-': 276, 'axis0+': 275, 'axis1-': 273, 'axis1+': 274 };
const parts: Record<string, string> = { up: '上', down: '下', left: '左', right: '右', 'btn-a': 'A', 'btn-b': 'B', 'btn-c': 'C', 'btn-d': 'D', 'btn-e': 'E', 'btn-f': 'F', 'btn-opt1': '1', 'btn-opt2': '2' };
const migrateVirtual = (bindings: Bindings): Bindings => { const result = {...bindings}; for (const [oldId, id] of Object.entries({a: 'btn-a', b: 'btn-b', x: 'btn-c', y: 'btn-d', start: 'btn-opt1', select: 'btn-opt2'})) { if (result[id] === undefined && result[oldId] !== undefined) result[id] = result[oldId]; delete result[oldId]; } return result; };
const buttons = ['a', 'b', 'x', 'y', 'l', 'r', 'l2', 'r2', 'select', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right'];
const keys: Array<[string, number]> = [['割当なし', -1], ['SPACE', 32], ['RETURN', 13], ['ESC', 27], ['TAB', 9], ['SHIFT', 304], ['CTRL', 306], ['BS/DEL', 8], ['INS', 277], ['HOME/CLR', 278], ['HELP', 279], ['ROLL UP', 280], ['ROLL DOWN', 281], ['CAPS', 301], ['カナ', 311], ['GRPH', 308], ['STOP', 318], ['COPY', 316], ...[...'@[-^\\;:],./_'].map((c): [string, number] => [c, c.charCodeAt(0)]), ...[['テンキー /', 267], ['テンキー *', 268], ['テンキー -', 269], ['テンキー +', 270], ['テンキー ,', 271], ['テンキー .', 266], ['テンキー =', 272]] as Array<[string, number]>, ['↑', 273], ['↓', 274], ['←', 276], ['→', 275], ...Array.from({length: 10}, (_, i): [string, number] => [`テンキー ${i}`, 256 + i]), ...Array.from({length: 26}, (_, i): [string, number] => [String.fromCharCode(65 + i), 97 + i]), ...Array.from({length: 10}, (_, i): [string, number] => [String(i), 48 + i]), ...Array.from({length: 10}, (_, i): [string, number] => [`F${i + 1}`, 282 + i])];
const initial = (): Settings => ({ version: 1, gamepad: {...tenkey}, virtual: migrateVirtual(Object.fromEntries(Object.entries(tenkey).filter(([id]) => !['x', 'y'].includes(id)))), host: {}, deadzone: .3, visible: false });
function cleanSettings(s: Settings | null): Settings {
  const def = initial();
  try {
    if (!s || s.version !== 1) return def;
    const clean = (v: unknown): Bindings => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([k, n]) => k.length < 80 && Number.isInteger(n) && keys.some(([, c]) => c === n && c >= 0))) as Bindings;
    return { version: 1, gamepad: clean(s.gamepad), virtual: migrateVirtual(clean(s.virtual)), host: clean(s.host), deadzone: Number.isFinite(s.deadzone) ? Math.max(.05, Math.min(.95, s.deadzone)) : .3, visible: !!s.visible };
  } catch { return def; }
}
type Profile = { id: string; name: string; settings: Settings };
type ProfileStore = { version: 1; activeId: string; profiles: Profile[] };
function loadProfiles(): ProfileStore {
  try {
    const raw = JSON.parse(localStorage.getItem('webq88-input-profiles') || 'null');
    if (raw?.version === 1 && Array.isArray(raw.profiles)) {
      const seen = new Set<string>();
      const profiles: Profile[] = raw.profiles.filter((p: Profile) => p && typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name.trim() && p.settings && !seen.has(p.id) && seen.add(p.id)).map((p: Profile) => ({ id: p.id, name: p.name, settings: cleanSettings(p.settings) }));
      if (profiles.length) return { version: 1, profiles, activeId: profiles.some(p => p.id === raw.activeId) ? raw.activeId : profiles[0].id };
    }
  } catch { /* 旧設定または既定値を使う */ }
  let old: Settings | null = null;
  try { old = JSON.parse(localStorage.getItem('webq88-input-settings') || 'null'); } catch { /* 既定値を使う */ }
  return { version: 1, activeId: 'standard', profiles: [{ id: 'standard', name: '標準', settings: cleanSettings(old) }] };
}
export function initInputControls(createSource: () => (code: number, pressed: boolean) => void, gamepadEnabled: () => boolean = () => true): () => Bindings {
  const store = loadProfiles();
  const settings = structuredClone(store.profiles.find(p => p.id === store.activeId)!.settings);
  const save = () => { store.profiles.find(p => p.id === store.activeId)!.settings = structuredClone(settings); try { localStorage.setItem('webq88-input-profiles', JSON.stringify(store)); } catch { /* 保存不可 */ } };
  save();
  const send = createSource();
  let active = new Map<string, number>();
  const reconcile = (next: Map<string, number>) => {
    const before = new Set(active.values()), after = new Set(next.values());
    for (const k of before) if (!after.has(k)) send(k, false);
    for (const k of after) if (!before.has(k)) send(k, true);
    active = next;
  };
  const pointers = new Map<number, string[]>();
  let gamepadSources = new Set<string>();
  const refresh = () => {
    const next = new Map<string, number>();
    for (const source of gamepadSources) { const k = settings.gamepad[source]; if (k !== undefined) next.set(`g:${source}`, k); }
    for (const [id, sources] of pointers) for (const source of sources) { const k = settings.virtual[source]; if (k !== undefined) next.set(`v:${id}:${source}`, k); }
    reconcile(next);
  };
  const player = document.querySelector<HTMLElement>('#player')!;
  const panel = document.createElement('div'); panel.className = 'virtual-pad'; panel.setAttribute('aria-label', 'バーチャルパッド');
  const stick = document.createElement('div'); stick.className = 'vpad-stick'; stick.setAttribute('aria-label', '方向スティック');
  const knob = document.createElement('div'); knob.className = 'vpad-stick-knob'; stick.append(knob); panel.append(stick);
  const elements = new Map<string, HTMLElement>();
  for (const id of [...BUTTON_IDS, 'btn-opt1', 'btn-opt2']) {
    const button = document.createElement('div'); button.className = 'vpad-button'; button.textContent = parts[id]; button.setAttribute('role', 'button'); button.setAttribute('aria-label', parts[id]); panel.append(button); elements.set(id, button);
  }
  const updateAppearance = () => { for (const [id, element] of elements) element.classList.toggle('active', [...pointers.values()].some(ids => ids.includes(id))); };
  const bindPointer = (element: HTMLElement, id: string | null) => {
    const update = (e: PointerEvent) => {
      if (id) pointers.set(e.pointerId, [id]);
      else {
        const r = stick.getBoundingClientRect(), rect = { x: r.left, y: r.top, w: r.width, h: r.height };
        const ids = stickDirsFromPoint(PANEL_DPAD, rect, e.clientX, e.clientY); pointers.set(e.pointerId, ids);
        const offset = stickKnobOffset(rect, e.clientX, e.clientY); knob.style.transform = `translate(${offset.x}px, ${offset.y}px)`; knob.classList.toggle('active', ids.length > 0);
      }
      updateAppearance(); refresh();
    };
    element.addEventListener('pointerdown', e => { e.preventDefault(); try { element.setPointerCapture(e.pointerId); } catch { /* capture 不可 */ } update(e); });
    element.addEventListener('pointermove', e => { if (pointers.has(e.pointerId) && !id) { e.preventDefault(); update(e); } });
    const end = (e: PointerEvent) => { if (!pointers.has(e.pointerId)) return; pointers.delete(e.pointerId); if (!id) { knob.style.transform = 'translate(0px, 0px)'; knob.classList.remove('active'); } updateAppearance(); refresh(); };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) element.addEventListener(event, end);
    element.addEventListener('contextmenu', e => e.preventDefault());
  };
  bindPointer(stick, null); for (const [id, element] of elements) bindPointer(element, id);
  const boundIds = new Set<string>();
  const applyLayout = (items: LaidOutWidget[]) => { stick.style.display = 'none'; for (const element of elements.values()) element.style.display = 'none'; for (const {widget, rect} of items) { const element = widget.kind === 'dpad' ? stick : elements.get(widget.id); if (element) Object.assign(element.style, {display: '', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`}); } };
  const stage = document.querySelector<HTMLElement>('#screen-stage')!;
  const keyboard = document.querySelector<HTMLElement>('#virtual-keyboard')!;
  const probe = document.createElement('div'); probe.className = 'safe-area-probe'; document.body.append(probe);
  const layout = () => {
    boundIds.clear(); for (const id of Object.keys(parts)) if (settings.virtual[id] !== undefined) boundIds.add(id);
    const sides = window.innerWidth > window.innerHeight;
    panel.classList.toggle('vpad-sides', sides); panel.classList.toggle('vpad-panel', !sides);
    if (!sides) {
      if (panel.nextElementSibling !== keyboard) player.insertBefore(panel, keyboard);
      panel.style.height = `${Math.min(260, Math.max(160, Math.round(window.innerWidth * .7)))}px`;
      const bounds = panel.getBoundingClientRect(); applyLayout(layoutVpad(bounds.width, bounds.height, vpadWidgetsFor('panel', boundIds)));
    } else {
      if (panel.parentElement !== document.body) document.body.append(panel);
      panel.style.height = '';
      const rect = stage.getBoundingClientRect(), safe = getComputedStyle(probe);
      let left = parseFloat(safe.paddingLeft) || 0, right = parseFloat(safe.paddingRight) || 0;
      const angle = screen.orientation?.angle;
      if (left > 0 && left === right) { if (angle === 90) right = 0; else if (angle === 270) left = 0; }
      const top = Math.max(rect.top, parseFloat(safe.paddingTop) || 0);
      const bottom = Math.min(rect.bottom, window.innerHeight - (parseFloat(safe.paddingBottom) || 0));
      const height = Math.max(0, bottom - top);
      applyLayout(layoutVpadSides({ left: {x: left, y: top, w: Math.max(0, rect.left - left), h: height}, right: {x: rect.right, y: top, w: Math.max(0, window.innerWidth - right - rect.right), h: height} }, boundIds));
    }
  };
  window.addEventListener('vpad-layout', layout);
  layout();
  const toggle = document.querySelector<HTMLButtonElement>('#vpad-toggle')!;
  const renderVisible = () => { panel.hidden = !settings.visible; document.body.classList.toggle('vpad-shown', settings.visible); window.dispatchEvent(new Event('vpad-change')); toggle.classList.toggle('active', settings.visible); toggle.setAttribute('aria-pressed', String(settings.visible)); if (!settings.visible) { pointers.clear(); panel.querySelectorAll('.active').forEach(b => b.classList.remove('active')); knob.style.transform = 'translate(0px, 0px)'; refresh(); } };
  toggle.addEventListener('click', () => { settings.visible = !settings.visible; save(); renderVisible(); }); renderVisible();
  const backdrop = document.createElement('div'); backdrop.className = 'library-backdrop input-backdrop'; backdrop.hidden = true;
  const dialog = document.createElement('section'); dialog.className = 'library-modal'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-label','入力設定'); backdrop.append(dialog); player.append(backdrop);
  const title = document.createElement('h2'); title.textContent = '入力設定'; dialog.append(title);
  const profiles = document.createElement('div'); profiles.className = 'input-profiles';
  const profileLabel = document.createElement('label'); profileLabel.textContent = 'プロファイル ';
  const profileSelect = document.createElement('select'); profileLabel.append(profileSelect); profiles.append(profileLabel);
  const profileActions = document.createElement('div'); profiles.append(profileActions);
  const nameForm = document.createElement('form'); nameForm.hidden = true;
  const nameLabel = document.createElement('label'); const nameText = document.createElement('span'); nameLabel.append(nameText); const nameInput = document.createElement('input'); nameInput.maxLength = 100; nameInput.required = true; nameLabel.append(nameInput);
  const confirmName = document.createElement('button'); confirmName.type = 'submit'; confirmName.textContent = '決定';
  const cancelName = document.createElement('button'); cancelName.type = 'button'; cancelName.textContent = 'キャンセル'; cancelName.onclick = () => { nameForm.hidden = true; };
  nameForm.append(nameLabel, confirmName, cancelName); profiles.append(nameForm); dialog.append(profiles);
  let acceptName: (name: string) => void = () => {};
  nameForm.onsubmit = e => { e.preventDefault(); const name = nameInput.value.trim(); if (!name) { nameInput.setCustomValidity('名前を入力してください'); nameInput.reportValidity(); return; } nameForm.hidden = true; acceptName(name); };
  nameInput.oninput = () => nameInput.setCustomValidity('');
  const askName = (label: string, value: string, accept: (name: string) => void) => { nameText.textContent = label; nameInput.value = value; nameInput.setCustomValidity(''); acceptName = accept; nameForm.hidden = false; nameInput.focus(); nameInput.select(); };
  const renderProfiles = () => { profileSelect.replaceChildren(...store.profiles.map(p => new Option(p.name, p.id))); profileSelect.value = store.activeId; };
  const applyProfile = (id: string) => { store.activeId = id; Object.assign(settings, structuredClone(store.profiles.find(p => p.id === id)!.settings)); pointers.clear(); gamepadSources.clear(); updateAppearance(); knob.style.transform = 'translate(0px, 0px)'; knob.classList.remove('active'); refresh(); renderVisible(); zone.value = String(settings.deadzone); zoneValue.textContent = zone.value; layout(); render(); renderProfiles(); save(); };
  profileSelect.onchange = () => { nameForm.hidden = true; applyProfile(profileSelect.value); };
  const button = (label: string, action: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = action; profileActions.append(b); };
  const addProfile = (name: string, value: Settings) => { const id = `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; store.profiles.push({ id, name, settings: structuredClone(value) }); applyProfile(id); };
  button('作成', () => askName('新しい名前 ', '', name => addProfile(name, initial())));
  button('複製', () => askName('複製の名前 ', `${store.profiles.find(p => p.id === store.activeId)!.name} のコピー`, name => addProfile(name, settings)));
  button('名前変更', () => askName('新しい名前 ', store.profiles.find(p => p.id === store.activeId)!.name, name => { store.profiles.find(p => p.id === store.activeId)!.name = name; save(); renderProfiles(); }));
  button('削除', () => { if (store.profiles.length === 1) { alert('最後のプロファイルは削除できません。'); return; } const profile = store.profiles.find(p => p.id === store.activeId)!; if (!confirm(`「${profile.name}」を削除しますか？`)) return; store.profiles = store.profiles.filter(p => p.id !== profile.id); applyProfile(store.profiles[0].id); });
  renderProfiles();
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
      const preset = document.createElement('select'); preset.innerHTML = '<option value="">プリセットを選択</option><option value="tenkey">テンキー移動＋SPACE/RETURN</option><option value="cursor">カーソル＋Z/X</option>'; preset.addEventListener('change', () => { if (!preset.value) return; settings[kind] = kind === 'virtual' ? migrateVirtual(Object.fromEntries(Object.entries(preset.value === 'tenkey' ? tenkey : cursor).filter(([id]) => !['x', 'y'].includes(id)))) : {...(preset.value === 'tenkey' ? tenkey : cursor)}; save(); refresh(); layout(); render(); }); section.append(preset);
      const ids = kind === 'gamepad' ? [...buttons, 'axis0-', 'axis0+', 'axis1-', 'axis1+', 'axis2-', 'axis2+', 'axis3-', 'axis3+'] : Object.keys(parts);
      const grid = document.createElement('div'); grid.className = 'input-grid';
      for (const id of ids) { const row = document.createElement('label'); row.textContent = `${parts[id] ?? (id.startsWith('axis') ? `軸 ${id.slice(4)}` : id.toUpperCase())} `; row.append(selectKey(settings[kind][id], n => { if (n < 0) delete settings[kind][id]; else settings[kind][id] = n; save(); refresh(); if (kind === 'virtual') layout(); })); grid.append(row); } section.append(grid); sections.append(section);
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
    if (gamepadEnabled() && !document.hidden && document.hasFocus()) for (const pad of pads) {
      pad.buttons.forEach((b, i) => { if (b.pressed && buttons[i]) next.add(buttons[i]); });
      pad.axes.slice(0, 4).forEach((v, i) => { if (v < -settings.deadzone) next.add(`axis${i}-`); if (v > settings.deadzone) next.add(`axis${i}+`); });
    }
    gamepadSources = next; refresh(); requestAnimationFrame(poll);
  }; requestAnimationFrame(poll);
  const release = () => { pointers.clear(); gamepadSources.clear(); panel.querySelectorAll('.active').forEach(b => b.classList.remove('active')); knob.style.transform = 'translate(0px, 0px)'; refresh(); };
  window.addEventListener('blur', release); document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  return () => settings.host;
}
