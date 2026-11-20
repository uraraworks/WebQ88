// 開発サーバーを起動してから実行する。新規プロファイルで同梱の互換ROMだけを起動する。
import puppeteer from 'puppeteer-core';
import { strict as assert } from 'node:assert';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.WEBQ88_URL ?? 'http://localhost:5173/?bridge=1');
  await page.waitForFunction(() => window.__webq88Debug && !document.querySelector('#screenshot').disabled, { timeout: 60000 });
  const result = await page.evaluate(() => window.__webq88Debug.exec('perf', { seconds: 1 }));
  for (const key of ['coreFrames', 'wallMs', 'runFps', 'targetFps', 'ratio', 'drawFps', 'coreSampleRate', 'devicePixelRatio', 'refreshHz']) assert.equal(typeof result[key], 'number', key);
  assert.ok(result.coreFrames > 0 && result.wallMs >= 1000 && result.runFps > 0);
  assert.equal(result.audioPacing, false);
  if (new URL(process.env.WEBQ88_URL ?? 'http://localhost:5173/?bridge=1').searchParams.get('q88_cpu_clock') === '2') {
    assert.equal(result.appliedCoreOptions.q88_cpu_clock, '2');
  }
  assert.equal(typeof result.paused, 'boolean');
  const invalid = await page.evaluate(() => window.__webq88Debug.exec('perf', { seconds: 31 }));
  assert.ok(invalid.error);
  console.log('PASS: perf', JSON.stringify(result));
} finally { await browser.close(); }
