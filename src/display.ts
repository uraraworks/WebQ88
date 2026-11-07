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
    if (document.body.classList.contains('pseudo-fullscreen')) {
      stage.style.width = '';
      player.style.width = '';
    } else {
      const style = getComputedStyle(app);
      const paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingV = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(style.rowGap) || 0;
      const reserved = chrome.reduce((sum, element) => sum + element.getBoundingClientRect().height, 0) + paddingV + gap + 4;
      const widthFit = Math.max(0, (window.innerWidth - paddingH) / targetW);
      // 高さが不足しても画面を等倍以下に潰さない。狭い画面では幅に収める。
      const fit = Math.min(widthFit, Math.max(Math.min(1, widthFit), (window.innerHeight - reserved) / targetH));
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
      player.style.width = width;
    }
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
  window.addEventListener('player-fullscreen-change', update);
  document.addEventListener('fullscreenchange', update);
  document.addEventListener('webkitfullscreenchange', update);
  update();
  return { update, present };
}
