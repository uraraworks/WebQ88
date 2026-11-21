// 試験専用。配布用entries.jsonやROM本体は変更しない。
export const guardEntries = {
  version: 1,
  source: 'WebQ88 AH smoke fixture (not a ROM build)',
  main: [0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038,
    0x0066, 0x3080, 0x35d9, 0x369a, 0x37c9, 0x37cc, 0x37d2, 0x3847,
    0x4047, 0x6f6b, 0x7071, 0x71d9],
};

// Workerのinitで入口一覧の取得先だけを試験応答へ差し替える。
// エミュレータのモード・ROM・shimの有効化処理は本番と共通。
export async function installGuardFixture(page, enabled = true) {
  await page.evaluateOnNewDocument((entries, enabled) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        if (message?.type === 'init') {
          message = { ...message, entries: { url: enabled
            ? 'data:application/json,' + encodeURIComponent(JSON.stringify(entries))
            : 'data:application/json,invalid' } };
        }
        return super.postMessage(message, ...args);
      }
    };
  }, guardEntries, enabled);
}
