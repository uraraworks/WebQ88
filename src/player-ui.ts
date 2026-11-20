import { closedMenu, rootMenu, toggleMenu, selectGroup, isWideMenu, type OverflowGroup, type OverflowState } from './overflow-menu';

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

  const groups = menu.querySelectorAll<HTMLButtonElement>('[data-menu-group]');
  const submenus = menu.parentElement!.querySelectorAll<HTMLElement>('[data-submenu]');
  let menuState: OverflowState = closedMenu;

  function renderMenu(): void {
    const wide = isWideMenu(window.innerWidth);
    menu.hidden = menuState.level === 'closed' || (menuState.level === 'group' && !wide);
    more.setAttribute('aria-expanded', String(menuState.level !== 'closed'));
    groups.forEach((button) => button.setAttribute('aria-expanded', String(menuState.level === 'group' && menuState.group === button.dataset.menuGroup)));
    submenus.forEach((submenu) => { submenu.hidden = menuState.level !== 'group' || menuState.group !== submenu.dataset.submenu; });
    const anchor = more.getBoundingClientRect();
    const position = (element: HTMLElement, left: number, top: number): void => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(4, Math.min(left, window.innerWidth - rect.width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(top, window.innerHeight - rect.height - 4))}px`;
    };
    if (!menu.hidden) {
      position(menu, anchor.right - menu.offsetWidth, anchor.top - menu.offsetHeight - 6);
    }
    const active = Array.from(submenus).find((submenu) => !submenu.hidden);
    if (active) {
      if (wide) {
        const parent = menu.getBoundingClientRect();
        const left = parent.left >= active.offsetWidth + 4 ? parent.left - active.offsetWidth - 4 : parent.right + 4;
        position(active, left, parent.bottom - active.offsetHeight);
      } else {
        position(active, anchor.right - active.offsetWidth, anchor.top - active.offsetHeight - 6);
      }
    }
  }
  function closeMenu(): void {
    menuState = closedMenu;
    renderMenu();
  }
  document.querySelector<HTMLButtonElement>('#file-transfer')!.addEventListener('click', closeMenu, true);
  more.addEventListener('click', () => {
    menuState = toggleMenu(menuState);
    renderMenu();
  });
  groups.forEach((button) => button.addEventListener('click', () => {
    menuState = selectGroup(menuState, button.dataset.menuGroup as OverflowGroup);
    renderMenu();
  }));
  submenus.forEach((submenu) => submenu.querySelector<HTMLButtonElement>('[data-menu-back]')!.addEventListener('click', () => {
    menuState = rootMenu;
    renderMenu();
    groups.forEach((button) => { if (button.dataset.menuGroup === submenu.dataset.submenu) button.focus(); });
  }));
  window.addEventListener('resize', renderMenu);
  window.addEventListener('scroll', () => { if (menuState.level !== 'closed') renderMenu(); }, { passive: true });
  document.addEventListener('click', (event) => {
    if (!menu.parentElement!.contains(event.target as Node)) closeMenu();
  });

  function setFullscreen(on: boolean): void {
    document.body.classList.toggle('pseudo-fullscreen', on);
    window.dispatchEvent(new Event('player-fullscreen-change'));
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
    if (menuState.level !== 'closed') {
      closeMenu();
      more.focus();
      event.stopPropagation();
    }
    // 全画面中の Esc はゲスト（PC-88 の ESC キー）へ渡す。抜けるのはボタンかブラウザ標準の操作で。
  }, true);
}
