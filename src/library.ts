import { createFolder, deleteFolder, getDisk, listDisks, listFolders, moveDisk, renameDisk, renameFolder, type DiskFolder, type StoredDisk } from './disk-store';
import type { DiskPanel } from './disks';

export function initLibrary(panel: DiskPanel): void {
  const open = document.querySelector<HTMLButtonElement>('#disk-library')!;
  const backdrop = document.querySelector<HTMLElement>('#library-backdrop')!;
  const list = document.querySelector<HTMLElement>('#library-list')!;
  const close = document.querySelector<HTMLButtonElement>('#library-close')!;
  const expanded = new Set<string>();
  let folders: DiskFolder[] = [];
  const dismiss = (): void => { backdrop.hidden = true; open.focus(); };
  const action = (label: string, run: () => Promise<void>, danger = false): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `library-action-btn${danger ? ' danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => {
      button.disabled = true;
      void run().catch((err: unknown) => { window.alert(`操作に失敗しました: ${(err as Error).message}`); }).finally(() => { button.disabled = false; });
    });
    return button;
  };
  const refresh = async (): Promise<void> => {
    const collator = new Intl.Collator('ja', { numeric: true });
    const disks = (await listDisks()).sort((a, b) => collator.compare(a.displayName || a.name, b.displayName || b.name));
    folders = (await listFolders()).sort((a, b) => collator.compare(a.name, b.name));
    list.replaceChildren();
    if (!disks.length && !folders.length) { list.textContent = '保存されたディスクはありません。'; return; }
    for (const folder of folders) {
      const children = disks.filter(disk => disk.folderId === folder.id);
      const group = document.createElement('div');
      const header = document.createElement('div'); header.className = 'library-folder';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'library-folder-toggle';
      toggle.textContent = `${expanded.has(folder.id) ? '▼' : '▶'} 📁 ${folder.name}（${children.length}枚）`;
      toggle.setAttribute('aria-expanded', String(expanded.has(folder.id)));
      toggle.addEventListener('click', () => { if (expanded.has(folder.id)) expanded.delete(folder.id); else expanded.add(folder.id); void refresh(); });
      const actions = document.createElement('div'); actions.className = 'library-item-actions';
      actions.append(action('名前変更', async () => { const name = window.prompt('フォルダ名を入力してください', folder.name); if (name !== null) { await renameFolder(folder.id, name); await refresh(); } }));
      actions.append(action('削除', async () => { if (window.confirm(`「${folder.name}」を削除しますか？ 中のディスクはフォルダ無しに戻ります。`)) { await deleteFolder(folder.id); expanded.delete(folder.id); await refresh(); } }, true));
      header.append(toggle, actions); group.append(header);
      if (expanded.has(folder.id)) for (const disk of children) { const child = row(disk); child.classList.add('library-folder-child'); group.append(child); }
      list.append(group);
    }
    const ids = new Set(folders.map(folder => folder.id));
    for (const disk of disks) if (!disk.folderId || !ids.has(disk.folderId)) list.appendChild(row(disk));
  };
  const row = (disk: StoredDisk): HTMLElement => {
    const item = document.createElement('div'); item.className = 'library-list-item';
    const badge = document.createElement('span'); badge.className = 'library-item-badge'; badge.textContent = 'FD';
    const name = document.createElement('span'); name.className = 'library-item-name'; name.textContent = disk.displayName || disk.name; name.title = disk.name;
    const meta = document.createElement('span'); meta.className = 'library-item-meta';
    meta.textContent = `${(disk.bytes.byteLength / 1024).toFixed(0)} KB / ${new Date(disk.savedAt).toLocaleString()}`;
    const actions = document.createElement('div'); actions.className = 'library-item-actions';
    for (let d = 0; d < 2; d++) actions.append(action(`FDD${d + 1}へ挿入`, async () => { await panel.insertStored(d, disk.sourceKey); dismiss(); }));
    actions.append(action('名前変更', async () => {
      const value = window.prompt(`表示名を入力してください（元のファイル名: ${disk.name}）`, disk.displayName || disk.name);
      if (value !== null) { await renameDisk(disk.sourceKey, value); await refresh(); }
    }));
    const destination = document.createElement('select'); destination.className = 'library-folder-select'; destination.setAttribute('aria-label', '移動先フォルダ');
    for (const folder of [{ id: '', name: 'フォルダ無し' }, ...folders]) {
      const option = document.createElement('option'); option.value = folder.id; option.textContent = folder.name; destination.append(option);
    }
    destination.value = disk.folderId || '';
    destination.addEventListener('change', () => { destination.disabled = true; void moveDisk(disk.sourceKey, destination.value || undefined).then(refresh).catch((err: Error) => { window.alert(`移動に失敗しました: ${err.message}`); destination.disabled = false; }); });
    actions.append(destination);
    actions.append(action('ダウンロード', async () => {
      await panel.flushAll();
      const latest = await getDisk(disk.sourceKey);
      if (!latest) throw new Error('missing');
      const url = URL.createObjectURL(new Blob([latest.bytes.slice().buffer], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = latest.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    }));
    if (disk.url) actions.append(action('配布元に戻す', async () => {
      if (!window.confirm(`「${disk.displayName || disk.name}」の保存済みの変更を破棄し、配布元から再取得しますか？ 挿入中の場合は排出します。`)) return;
      await panel.resetStored(disk.sourceKey); await refresh();
    }, true));
    actions.append(action('削除', async () => {
      if (!window.confirm(`「${disk.displayName || disk.name}」を削除しますか？ 挿入中の場合は排出します。`)) return;
      await panel.deleteStored(disk.sourceKey); await refresh();
    }, true));
    item.append(badge, name, meta, actions); return item;
  };
  const create = action('フォルダ作成', async () => { const name = window.prompt('フォルダ名を入力してください'); if (name !== null) { const folder = await createFolder(name); expanded.add(folder.id); await refresh(); } });
  list.before(create);
  document.querySelector<HTMLButtonElement>('#share-disks')!.addEventListener('click', () => { void panel.shareUrl().catch((err: Error) => window.alert(err.message)); });
  open.addEventListener('click', () => { backdrop.hidden = false; close.focus(); void refresh().catch(() => { list.textContent = 'ライブラリを読み込めませんでした。'; }); });
  initDriveLibraryMenu(panel);
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) dismiss(); });
  document.addEventListener('keydown', (event) => {
    if (backdrop.hidden) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  }, true);
  document.addEventListener('keyup', (event) => { if (!backdrop.hidden) event.stopImmediatePropagation(); }, true);
}

function initDriveLibraryMenu(panel: DiskPanel): void {
  const menu = document.createElement('div');
  menu.className = 'library-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  document.querySelector<HTMLElement>('#player')!.append(menu);
  let anchor: HTMLButtonElement | null = null;
  let generation = 0;

  const dismiss = (): void => { generation++; anchor = null; menu.hidden = true; menu.replaceChildren(); };
  const position = (): void => {
    if (!anchor) return;
    menu.style.left = '0px'; menu.style.top = '0px';
    const rect = anchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.round(Math.max(4, Math.min(rect.left, window.innerWidth - size.width - 4)))}px`;
    menu.style.top = `${Math.round(Math.max(4, rect.top - size.height - 4))}px`;
  };
  const heading = (text: string, className: string): HTMLElement => {
    const element = document.createElement('div'); element.className = className; element.textContent = text; return element;
  };
  const row = (label: string, run: () => void, extra?: string): HTMLButtonElement => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'library-menu-item';
    button.setAttribute('role', 'menuitem');
    button.append(heading(label, 'library-menu-label'));
    if (extra) button.append(heading(extra, 'library-menu-extra'));
    button.addEventListener('click', run);
    return button;
  };
  const show = async (button: HTMLButtonElement, drive: number): Promise<void> => {
    anchor = button;
    const request = ++generation;
    menu.replaceChildren(heading('読み込み中…', 'library-menu-empty'));
    menu.hidden = false; position();
    try {
      const [disks, folders] = await Promise.all([listDisks(), listFolders()]);
      if (request !== generation) return;
      const collator = new Intl.Collator('ja', { numeric: true });
      disks.sort((a, b) => collator.compare(a.displayName || a.name, b.displayName || b.name));
      folders.sort((a, b) => collator.compare(a.name, b.name));
      const diskRow = (disk: StoredDisk): HTMLButtonElement => row(disk.displayName || disk.name, () => {
        dismiss(); void panel.insertStored(drive, disk.sourceKey);
      });
      const render = (folder?: DiskFolder): void => {
        menu.replaceChildren();
        if (folder) menu.append(row('← 戻る', () => render()));
        menu.append(heading(folder ? folder.name : `FDD${drive + 1}へ挿入`, 'library-menu-title'));
        if (folder) {
          const children = disks.filter(disk => disk.folderId === folder.id);
          for (const disk of children) menu.append(diskRow(disk));
          if (!children.length) menu.append(heading('保存されたディスクはありません。', 'library-menu-empty'));
        } else {
          const ids = new Set(folders.map(item => item.id));
          for (const item of folders) menu.append(row(item.name, () => render(item), `${disks.filter(disk => disk.folderId === item.id).length}枚`));
          for (const disk of disks) if (!disk.folderId || !ids.has(disk.folderId)) menu.append(diskRow(disk));
          if (!folders.length && !disks.length) menu.append(heading('保存されたディスクはありません。', 'library-menu-empty'));
        }
        position();
      };
      render();
    } catch {
      if (request === generation) { menu.replaceChildren(heading('ライブラリを読み込めませんでした。', 'library-menu-empty')); position(); }
    }
  };
  menu.addEventListener('click', event => event.stopPropagation());
  document.querySelectorAll<HTMLButtonElement>('.drive-library').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (anchor === button) { dismiss(); return; }
      void show(button, Number(button.closest<HTMLElement>('.drive-row')!.dataset.drive));
    });
  });
  document.addEventListener('click', dismiss);
  document.addEventListener('keydown', event => {
    if (!menu.hidden && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); const button = anchor; dismiss(); button?.focus(); }
  }, true);
}
