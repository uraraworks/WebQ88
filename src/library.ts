import { getDisk, listDisks, renameDisk, type StoredDisk } from './disk-store';
import type { DiskPanel } from './disks';

export function initLibrary(panel: DiskPanel): void {
  const open = document.querySelector<HTMLButtonElement>('#disk-library')!;
  const backdrop = document.querySelector<HTMLElement>('#library-backdrop')!;
  const list = document.querySelector<HTMLElement>('#library-list')!;
  const close = document.querySelector<HTMLButtonElement>('#library-close')!;
  const dismiss = (): void => { backdrop.hidden = true; open.focus(); };
  const action = (label: string, run: () => Promise<void>, danger = false): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `library-action-btn${danger ? ' danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => {
      button.disabled = true;
      void run().catch(() => { window.alert('操作に失敗しました。'); }).finally(() => { button.disabled = false; });
    });
    return button;
  };
  const refresh = async (): Promise<void> => {
    const disks = (await listDisks()).sort ( (a, b) => b.savedAt - a.savedAt );
    list.replaceChildren();
    if (!disks.length) { list.textContent = '保存されたディスクはありません。'; return; }
    for (const disk of disks) list.appendChild(row(disk));
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
    actions.append(action('ダウンロード', async () => {
      await panel.flushAll();
      const latest = await getDisk(disk.sourceKey);
      if (!latest) throw new Error('missing');
      const url = URL.createObjectURL(new Blob([latest.bytes.slice().buffer], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = latest.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    }));
    actions.append(action('削除', async () => {
      if (!window.confirm(`「${disk.displayName || disk.name}」を削除しますか？ 挿入中の場合は排出します。`)) return;
      await panel.deleteStored(disk.sourceKey); await refresh();
    }, true));
    item.append(badge, name, meta, actions); return item;
  };
  open.addEventListener('click', () => { backdrop.hidden = false; close.focus(); void refresh().catch(() => { list.textContent = 'ライブラリを読み込めませんでした。'; }); });
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) dismiss(); });
  document.addEventListener('keydown', (event) => {
    if (backdrop.hidden) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  }, true);
  document.addEventListener('keyup', (event) => { if (!backdrop.hidden) event.stopImmediatePropagation(); }, true);
}
