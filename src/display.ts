/** 実解像度のキャンバスを保ち、表示だけ整数倍後に補間する。 */
export function initDisplay(source: HTMLCanvasElement): { update: () => void; present: () => void } {
  const stage = document.querySelector<HTMLElement>('#screen-stage')!;
  const player = document.querySelector<HTMLElement>('#player')!;
  const app = document.querySelector<HTMLElement>('#app')!;
  const chrome = [document.querySelector<HTMLElement>('.app-header')!, document.querySelector<HTMLElement>('.app-footer')!, document.querySelector<HTMLElement>('.console-footer')!, document.querySelector<HTMLElement>('#virtual-keyboard')!, document.querySelector<HTMLElement>('#status')!];
  const sharp = document.querySelector<HTMLCanvasElement>('#screen-sharp')!;
  const ctx = sharp.getContext('2d')!;
  const aspect = document.querySelector<HTMLSelectElement>('#aspect-mode')!;
  const filter = document.querySelector<HTMLSelectElement>('#filter-mode')!;
  try {
    aspect.value = localStorage.getItem('webq88-aspect') === 'native' ? 'native' : '4:3';
    filter.value = localStorage.getItem('webq88-filter') === 'nearest' ? 'nearest' : 'sharp';
  } catch { /* 保存できない環境では既定値を使う */ }

  // URLの指定は保存せず、表示する回だけ優先する。
  const params = new URLSearchParams(location.search);
  const aspectParam = params.get('aspect');
  if (aspectParam === '4:3' || aspectParam === 'native') aspect.value = aspectParam;
  const filterParam = params.get('filter');
  if (filterParam === 'sharp' || filterParam === 'nearest') filter.value = filterParam;

  function present(): void {
    if (sharp.hidden || !source.width || !source.height) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, sharp.width, sharp.height);
  }
  function update(): void {
    const w = source.width || 1, h = source.height || 1;
    const targetW = aspect.value === '4:3' ? Math.max(w, h * 4 / 3) : w;
    const targetH = aspect.value === '4:3' ? Math.max(h, w * 3 / 4) : h;
    stage.style.aspectRatio = `${targetW} / ${targetH}`;
    const fullscreen = document.body.classList.contains('pseudo-fullscreen');
    const pad = document.querySelector<HTMLElement>('.virtual-pad');
    const padVisible = !!pad && !pad.hidden;
    if (fullscreen && !padVisible) {
      stage.style.width = '';
      player.style.width = '';
    } else {
      const style = getComputedStyle(app);
      const paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingV = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(style.rowGap) || 0;
      const playerStyle = getComputedStyle(player);
      const fullPaddingH = (parseFloat(playerStyle.paddingLeft) || 0) + (parseFloat(playerStyle.paddingRight) || 0);
      const fullPaddingV = (parseFloat(playerStyle.paddingTop) || 0) + (parseFloat(playerStyle.paddingBottom) || 0);
      const sides = padVisible && window.innerWidth > window.innerHeight;
      const padHeight = padVisible && !sides ? Math.min(260, Math.max(160, Math.round(window.innerWidth * .7))) : 0;
      const reserved = (fullscreen ? chrome.slice(2, 4) : chrome).reduce((sum, element) => sum + element.getBoundingClientRect().height, 0) + (fullscreen ? fullPaddingV : paddingV + gap) + padHeight + 4;
      const availableWidth = window.innerWidth - (fullscreen ? fullPaddingH : paddingH);
      // 左右の領域は画面サイズから逆算せず、先にビューポート幅から確保する。
      const maxWidth = sides ? Math.min(availableWidth, Math.max(340, window.innerWidth * .67)) : availableWidth;
      const widthFit = Math.max(0, maxWidth / targetW);
      // 高さが不足しても画面を等倍以下に潰さない。狭い画面では幅に収める。
      const heightFit = (window.innerHeight - reserved) / targetH;
      const fit = Math.min(widthFit, fullscreen ? Math.max(Math.min(340 / targetW, widthFit), heightFit) : Math.max(Math.min(1, widthFit), heightFit));
      let scale = fit;
      if (fit >= 1) {
        const n = Math.floor(fit);
        if ((fit - n) * targetW <= 16 && (fit - n) * targetH <= 16) scale = n;
      } else {
        const dpr = window.devicePixelRatio || 1;
        const snapped = Math.floor(fit * dpr + 1e-6);
        if (snapped >= 1 && (fit * dpr - snapped) / (fit * dpr) <= 0.08) scale = snapped / dpr;
      }
      const width = `${Math.max(1, Math.floor(targetW * scale))}px`;
      stage.style.width = width;
      player.style.width = fullscreen ? '' : width;
    }
    window.dispatchEvent(new Event('vpad-layout'));
    sharp.hidden = filter.value !== 'sharp';
    if (sharp.hidden) return;
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let kx = Math.max(1, Math.ceil(rect.width * dpr / w - 1e-6));
    let ky = Math.max(1, Math.ceil(rect.height * dpr / h - 1e-6));
    while ((w * kx > 8192 || h * ky > 8192 || w * kx * h * ky > 16777216) && (kx > 1 || ky > 1)) {
      if (kx >= ky && kx > 1) kx--; else if (ky > 1) ky--; else kx--;
    }
    if (sharp.width !== w * kx) sharp.width = w * kx;
    if (sharp.height !== h * ky) sharp.height = h * ky;
    present();
  }
  for (const [control, key] of [[aspect, 'webq88-aspect'], [filter, 'webq88-filter']] as const) {
    control.addEventListener('change', () => {
      try { localStorage.setItem(key, control.value); } catch { /* 保存不可でも切替可能 */ }
      update();
    });
  }
  new ResizeObserver(update).observe(stage);
  const chromeObserver = new ResizeObserver(update);
  for (const element of chrome) chromeObserver.observe(element);
  window.addEventListener('resize', update);
  window.addEventListener('vpad-change', update);
  window.addEventListener('player-fullscreen-change', update);
  document.addEventListener('fullscreenchange', update);
  document.addEventListener('webkitfullscreenchange', update);
  update();
  return { update, present };
}
