import type { CoreProxy } from './core-proxy';
import { getState, putState } from './state-store';

export function initStateUi(proxy: CoreProxy, flushDisks: () => Promise<void>): void {
  const slots = document.querySelector<HTMLElement>('#state-slots')!;
  const message = document.querySelector<HTMLElement>('#state-message')!;
  let busy = false;
  const buttons: HTMLButtonElement[] = [];
  const labels: HTMLElement[] = [];

  function setBusy(value: boolean): void {
    busy = value;
    buttons.forEach(button => { button.disabled = value; });
  }
  async function refresh(slot: number): Promise<void> {
    const state = await getState(slot);
    labels[slot - 1].textContent = `スロット ${slot}：${state ? new Date(state.savedAt).toLocaleString('ja-JP') : '未保存'}`;
  }
  for (let slot = 1; slot <= 3; slot++) {
    const row = document.createElement('div');
    row.className = 'state-slot';
    const label = document.createElement('span');
    label.textContent = `スロット ${slot}：確認中`;
    labels.push(label);
    row.append(label);
    for (const op of ['save', 'load'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = op === 'save' ? '保存' : '読込';
      button.setAttribute('aria-label', `スロット ${slot} に${button.textContent}`);
      buttons.push(button);
      row.append(button);
      button.addEventListener('click', () => {
        if (busy) return;
        setBusy(true);
        message.textContent = '';
        void (async () => {
          try {
            if (op === 'save') {
              const result = await proxy.stateRequest('save');
              if (!result.ok || !result.bytes || !result.info) throw new Error('ステートを取得できませんでした');
              await putState(slot, { savedAt: Date.now(), bytes: result.bytes, info: result.info });
              await refresh(slot);
              message.textContent = '保存しました';
            } else {
              const saved = await getState(slot);
              if (!saved) throw new Error('保存データがありません');
              const current = await proxy.stateRequest('info');
              if (!current.ok || !current.info) throw new Error('現在の構成を取得できませんでした');
              // 利用者ROMで保存したステートは、制限の掛かっていない(互換ROMだけの)セッションへは入れない。
              // RAMに公式ROM由来の値が残り、自動操作APIのメモリ読み出しから見えてしまうため。
              const usesUserRom = (info: typeof current.info) => info!.roms.some(rom => rom.origin === 'user');
              if (usesUserRom(saved.info) && !usesUserRom(current.info)) throw new Error('利用者ROMで保存したステートは、利用者ROMで起動したときだけ読み込めます');
              if (JSON.stringify(saved.info) !== JSON.stringify(current.info) && !window.confirm('保存時と現在のROM構成またはディスクが異なります。読み込みますか？')) return;
              await flushDisks();
              const result = await proxy.stateRequest('load', saved.bytes);
              if (!result.ok) throw new Error('ステートを復元できませんでした');
              message.textContent = '読み込みました';
            }
          } catch (err) {
            message.textContent = `${op === 'save' ? '保存' : '読込'}に失敗しました：${(err as Error).message}`;
          } finally { setBusy(false); }
        })();
      });
    }
    slots.append(row);
    void refresh(slot).catch(() => { labels[slot - 1].textContent = `スロット ${slot}：確認できません`; message.textContent = '保存領域を読み込めませんでした'; });
  }
}
