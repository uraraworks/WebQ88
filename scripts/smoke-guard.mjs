// bridge + 同梱互換ROM + 自作機械語のみ。新規プロファイルでゲームを復元しない。
import puppeteer from 'puppeteer-core';
import { strict as assert } from 'node:assert';
import { installGuardFixture } from './guard-fixture.mjs';
const url = process.env.WEBQ88_URL ?? 'http://localhost:5188/?bridge=1';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boot(enabled) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await installGuardFixture(page, enabled);
  await page.goto(url);
  await page.waitForFunction(() => window.__webq88Debug && !document.querySelector('#screenshot').disabled, { timeout: 60000 });
  await delay(2500);
  const ex = (cmd, args = {}) => page.evaluate((cmd, args) => window.__webq88Debug.exec(cmd, args), cmd, args);
  const status = await ex('status');
  assert.equal(status.mode.restricted, false);
  assert.equal(status.unsupported, null);
  return { page, ex, context };
}
async function poke(ex, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const result = await ex('type_text', { text: `POKE &H${(0xe000 + i).toString(16)},${bytes[i]}\n` });
    assert.equal(result.ok, true, result.error);
  }
}
const run = async ex => {
  assert.equal((await ex('type_text', { text: 'POKE &HE101,0\n' })).ok, true);
  return ex('type_text', { text: 'DEF USR=&HE000:A=USR(0):POKE &HE101,1\n' });
};
async function returned(ex) {
  const result = await ex('read_memory', { region: 0, offset: 0xe101, length: 1 });
  assert.equal(result.ok, true, result.error);
  assert.equal(Buffer.from(result.base64, 'base64')[0], 1, 'USRからROMへ戻り次のPOKEを実行する');
  assert.equal((await ex('status')).unsupported, null);
}
try {
  const { page, ex, context } = await boot(true);
  // ROM -> RAM -> RET -> ROM（RAMフックのRET戻りと同じ経路）。
  await poke(ex, [0xc9]);
  assert.equal((await run(ex)).ok, true);
  await returned(ex);
  // 既知の公開入口へのCALLは許可される。
  await poke(ex, [0x3e, 65, 0xcd, 0xc9, 0x37, 0xc9]);
  assert.equal((await run(ex)).ok, true);
  await returned(ex);
  // 非公開入口へのCALLは、そのROM命令を実行する前に停止する。
  await poke(ex, [0xcd, 0x34, 0x12, 0xc9]);
  await run(ex); // 停止によりtype_textのフレーム待ちは中断されうる。
  await page.waitForFunction(async () => (await window.__webq88Debug.exec('status')).unsupported !== null);
  assert.deepEqual((await ex('status')).unsupported, { address: 0x1234, source: 0xe000 });
  assert.equal(await page.$eval('#unsupported-overlay', e => e.hidden), false);
  assert.match(await page.$eval('#unsupported-overlay small', e => e.textContent), /ROM \$1234（RAM \$E000/);
  await page.evaluate(() => [...document.querySelectorAll('#unsupported-overlay button')].find(b => b.textContent === '閉じる').click());
  // 通常の一時停止と再開では検知停止を解除しない。
  await page.evaluate(() => { document.querySelector('#pause').click(); document.querySelector('#pause').click(); });
  assert.equal((await ex('status')).unsupported.address, 0x1234);
  const perf = await ex('perf', { seconds: 1 });
  assert.equal(perf.coreFrames, 0);
  assert.equal((await ex('reset')).ok, true);
  assert.equal((await ex('status')).unsupported, null);
  await delay(2500);
  assert.ok((await ex('perf', { seconds: 1 })).coreFrames > 0);
  await context.close();
  // 一覧を読み込めない場合（shimの既定無効）も実行自体は継続する。
  const off = await boot(false);
  await poke(off.ex, [0xcd, 0x34, 0x12, 0xc9]);
  await run(off.ex);
  assert.equal((await off.ex('status')).unsupported, null);
  assert.ok((await off.ex('perf', { seconds: 1 })).coreFrames > 0);
  await off.context.close();
  console.log('PASS: guard bridge (positive, public entry, ROM/RAM/RET, reset, disabled)');
} finally { await browser.close(); }
