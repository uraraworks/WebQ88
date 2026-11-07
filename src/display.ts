/** 実解像度のキャンバスを保ち、表示だけ整数倍後に補間する。 */
export function initDisplay(source: HTMLCanvasElement): { update: () => void; present: () => void } {
  const stage = document.querySelector<HTMLElement>('#screen-stage')!;
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
  window.addEventListener('resize', update);
  update();
  return { update, present };
}
