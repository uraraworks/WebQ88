// 開発サーバーを別途起動してから npm run capture-help を実行する。
// 日本語のヘルプに実際の UI を掲載する。
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { installGuardFixture } from './guard-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'public/help');
const base = new URL(process.env.WEBQ88_URL ?? 'http://localhost:5173');
// サブパス指定にも対応し、起動用クエリは持ち込まない。
if (!base.pathname.endsWith('/')) base.pathname += '/';
base.search = '';
base.hash = '';
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const blank = await readFile(resolve(root, 'compat-rom/BLANK2D.D88'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'webq88-shots-'));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: chrome, userDataDir: profile, headless: true, args: ['--hide-scrollbars'] });
  {
    // 他の撮影とは独立した互換ROMの環境で、自作機械語から見張りを発動する。
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja' });
      await installGuardFixture(page);
      const url = new URL(base);
      url.searchParams.set('bridge', '1');
      await page.goto(url.href, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => window.__webq88Debug && !document.querySelector('#screenshot').disabled, { timeout: 60000 });
      await new Promise((r) => setTimeout(r, 2500));
      const type = async (text) => {
        const result = await page.evaluate((text) => window.__webq88Debug.exec('type_text', { text }), text);
        if (!result.ok) throw new Error(result.error);
      };
      for (const [i, byte] of [0xcd, 0x34, 0x12, 0xc9].entries()) {
        await type(`POKE &H${(0xe000 + i).toString(16)},${byte}\n`);
      }
      // 停止により type_text のフレーム待ちは中断されうる。
      await page.evaluate(() => window.__webq88Debug.exec('type_text', { text: 'DEF USR=&HE000:A=USR(0)\n' }));
      await page.waitForSelector('#unsupported-overlay', { visible: true, timeout: 60000 });
      await (await page.waitForSelector('#player', { visible: true })).screenshot({ path: join(output, 'unsupported.png') });
      console.log('撮影: unsupported.png');
    } finally {
      await context.close();
    }
  }
  {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja' });
      const shoot = async (selector, name) => {
        const element = await page.waitForSelector(selector, { visible: true });
        await element.screenshot({ path: join(output, `${name}.png`) });
        console.log(`撮影: ${name}.png`);
      };
      await page.goto(base.href, { waitUntil: 'networkidle2' });
      await shoot('#player', 'overlay');
      await page.click('#startup-button');
      // 最初のフレームが描画されたときに有効になるボタンで起動を判定する。
      await page.waitForFunction(() => !document.querySelector('#screenshot').disabled, { timeout: 60000 });
      // 最初のフレームはまだ黒いので、互換 ROM の起動画面(文字)が描かれるまで待つ。
      await page.waitForFunction(() => {
        const c = document.querySelector('#screen');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 96) lit++;
        return lit > 500;
      }, { timeout: 60000, polling: 250 });
      // 起動メッセージの表示が出そろうまで少し待つ。
      await new Promise((r) => setTimeout(r, 2000));
      await shoot('#player', 'overview');
      await shoot('#disks', 'fdd');

      // 互換 ROM に同梱された空ディスクのみを、撮影専用プロファイルへ登録する。
      await page.evaluate(async (data) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('webq88-disks', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('disks')) db.createObjectStore('disks', { keyPath: 'sourceKey' });
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('disks', 'readwrite');
          tx.objectStore('disks').put({ sourceKey: 'sample:1', name: 'SAMPLE1.D88', bytes: new Uint8Array(data), savedAt: Date.UTC(2026, 0, 1) });
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, Array.from(blank));
      await page.click('#disk-library');
      await page.waitForFunction(() => document.querySelector('#library-list .library-item-name')?.textContent === 'SAMPLE1.D88');
      await shoot('#library-backdrop .library-modal', 'library');
      await page.click('#library-close');
      await page.click('.drive-row[data-drive="0"] .drive-library');
      await page.waitForSelector('.library-menu-item', { visible: true });
      await shoot('.library-menu', 'library-insert');
      await page.keyboard.press('Escape');
      await page.click('#keyboard-toggle');
      await shoot('#virtual-keyboard', 'keyboard');
      await page.click('#keyboard-toggle');
      await page.click('#toolbar-more');
      await page.click('[data-menu-group="display"]');
      await shoot('#menu-display', 'menu');
      await page.click('[data-menu-group="state"]');
      await shoot('#menu-state', 'state');
      await page.click('[data-menu-group="input"]');
      await page.click('#paste-open');
      // パネルが開くと高さが増えて下端が画面外へ出るので、メニューを再配置させてから撮る。
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await shoot('#menu-input', 'paste');
      await page.click('#paste-cancel');
      await page.click('#input-settings');
      // タブとキー一覧が収まるよう撮影時だけ高さを広げる。
      await page.setViewport({ width: 900, height: 1100, deviceScaleFactor: 2 });
      await shoot('.input-backdrop .library-modal', 'gamepad');
      // 同梱の自作ROMを保存し、一覧と削除ボタンを撮る。
      const rom = await readFile(resolve(root, 'compat-rom/N88.ROM'));
      await page.evaluate(async (data) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('webq88-roms', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('roms', { keyPath: 'name' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('roms', 'readwrite');
          tx.objectStore('roms').put({ name: 'N88.ROM', bytes: new Uint8Array(data).buffer });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, Array.from(rom));
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => document.querySelector('#saved-rom-names').textContent.includes('N88.ROM'));
      await page.click('#toolbar-more');
      await page.click('[data-menu-group="rom"]');
      await shoot('#menu-rom', 'rom');
    } finally {
      await context.close();
    }
  }
} finally {
  try { if (browser) await browser.close(); } finally { await rm(profile, { recursive: true, force: true }); }
}
