// 開発サーバーを起動してから実行する。新規プロファイルで同梱の互換ROMだけを起動する。
import puppeteer from 'puppeteer-core';
import { strict as assert } from 'node:assert';
import { installGuardFixture } from './guard-fixture.mjs';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  await installGuardFixture(page, false);
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
  // 同一コア・同一互換ROMで、検知有無の実行FPS/目標FPSを比較する。
  const context = await browser.createBrowserContext();
  const guardedPage = await context.newPage();
  await installGuardFixture(guardedPage, true);
  await page.close(); // 比較相手を同時に実行してCPUを奪い合わない。
  await guardedPage.goto(process.env.WEBQ88_URL ?? 'http://localhost:5173/?bridge=1');
  await guardedPage.waitForFunction(() => window.__webq88Debug && !document.querySelector('#screenshot').disabled, { timeout: 60000 });
  const guarded = await guardedPage.evaluate(() => window.__webq88Debug.exec('perf', { seconds: 1 }));
  const status = await guardedPage.evaluate(() => window.__webq88Debug.exec('status'));
  assert.equal(status.unsupported, null);
  assert.ok(guarded.ratio >= result.ratio - 0.1, `guard ratio ${guarded.ratio} vs disabled ${result.ratio}`);
  await context.close();
  console.log('PASS: perf', JSON.stringify(result));
  console.log('PASS: guard perf', JSON.stringify({ disabledRatio: result.ratio, enabledRatio: guarded.ratio }));
} finally { await browser.close(); }
