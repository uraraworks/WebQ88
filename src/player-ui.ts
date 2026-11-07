/** 操作メニューと全画面表示。エミュレータの操作は既存のボタンへ委ねる。 */
export function initPlayerUi(): void {
  const player = document.querySelector<HTMLElement>('#player')!;
  const more = document.querySelector<HTMLButtonElement>('#toolbar-more')!;
  const menu = document.querySelector<HTMLElement>('#toolbar-menu')!;
  const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!;
  const doc = document as Document & {
    webkitFullscreenEnabled?: boolean;
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => void;
  };
  const root = player as HTMLElement & { webkitRequestFullscreen?: () => void };
  let nativeRequested = false;

  function closeMenu(): void {
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
  }
  more.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    more.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (event) => {
    if (!menu.parentElement!.contains(event.target as Node)) closeMenu();
  });

  function setFullscreen(on: boolean): void {
    document.body.classList.toggle('pseudo-fullscreen', on);
    fullscreen.classList.toggle('active', on);
    fullscreen.setAttribute('aria-pressed', String(on));
    fullscreen.title = on ? '全画面表示を終了' : '全画面表示';
    fullscreen.setAttribute('aria-label', fullscreen.title);
    closeMenu();
  }
  function nativeActive(): boolean {
    return Boolean(document.fullscreenElement || doc.webkitFullscreenElement);
  }
  async function exitFullscreen(): Promise<void> {
    setFullscreen(false);
    if (nativeActive()) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else doc.webkitExitFullscreen?.();
      } catch { /* レイアウトは既に元へ戻している */ }
    }
    nativeRequested = false;
  }
  fullscreen.addEventListener('click', () => {
    if (document.body.classList.contains('pseudo-fullscreen')) {
      void exitFullscreen();
      return;
    }
    setFullscreen(true);
    const enabled = document.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
    if (enabled && (root.requestFullscreen || root.webkitRequestFullscreen)) {
      nativeRequested = true;
      try {
        const request = root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen?.();
        if (request) void request.catch(() => { nativeRequested = false; });
      } catch { nativeRequested = false; }
    }
  });
  const sync = (): void => {
    if (nativeRequested && !nativeActive()) {
      nativeRequested = false;
      setFullscreen(false);
    }
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!menu.hidden) {
      closeMenu();
      more.focus();
      event.stopPropagation();
    }
    // 全画面中の Esc はゲスト（PC-88 の ESC キー）へ渡す。抜けるのはボタンかブラウザ標準の操作で。
  }, true);
}
