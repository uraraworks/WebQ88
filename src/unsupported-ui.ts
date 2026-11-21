/** アドレスだけを表示する。閉じてもコアの停止状態は解除しない。 */
export function createUnsupportedUi(
  stage: HTMLElement,
  romFiles: HTMLInputElement,
  romBoot: HTMLButtonElement,
): { show: (position: { address: number; source: number }) => void; clear: () => void } {
  const overlay = document.createElement('div');
  overlay.id = 'unsupported-overlay';
  overlay.className = 'overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-labelledby', 'unsupported-message');
  // 案内内のEnter/Spaceを、エミュレータのキーボード処理へ渡さない。
  overlay.addEventListener('keydown', event => event.stopPropagation());
  overlay.addEventListener('keyup', event => event.stopPropagation());
  const message = document.createElement('strong');
  message.id = 'unsupported-message';
  message.textContent = 'このソフトは公式ROMの内部機能を使うため、互換ROMでは動きません。公式ROMを登録画面で選んで起動してください。';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '詳細';
  const position = document.createElement('small');
  details.append(summary, position);
  const boot = document.createElement('button');
  boot.type = 'button';
  boot.textContent = '公式ROMを選んで起動';
  let choosing = false;
  boot.addEventListener('click', () => { choosing = true; romFiles.click(); });
  romFiles.addEventListener('cancel', () => { choosing = false; });
  romFiles.addEventListener('change', () => {
    if (!choosing) return;
    choosing = false;
    if (romFiles.files?.length) romBoot.click();
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '閉じる';
  close.addEventListener('click', () => { overlay.hidden = true; stage.focus(); });
  overlay.append(message, details, boot, close);
  stage.append(overlay);
  return {
    show: ({ address, source }) => {
      const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
      position.textContent = `停止位置: ROM $${hex(address)}（RAM $${hex(source)} から呼び出し）`;
      details.open = false;
      overlay.hidden = false;
      boot.focus();
    },
    clear: () => { overlay.hidden = true; },
  };
}
