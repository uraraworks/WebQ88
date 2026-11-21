import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { strict as assert } from 'node:assert';
// ディスク挿入→排出→リセットで、ROM起動に戻りバナーが出ること（排出後にディスク起動が残って空画面で止まる退行の検査）。
// 開発サーバー起動後に実行。自作の空ディスク(compat-rom/BLANK2D.D88)のみ使用。
const blank = fs.readFileSync('compat-rom/BLANK2D.D88').toString('base64');
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const p = await b.newPage();
await p.goto(process.env.WEBQ88_URL ?? 'http://localhost:5173/?bridge=1');
await p.waitForFunction(()=>window.__webq88Debug && !document.querySelector('#screenshot').disabled,{timeout:60000});
const ex=(c,a)=>p.evaluate((c,a)=>window.__webq88Debug.exec(c,a),c,a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await sleep(3000);
const sig=async t=>{const s=await ex('screen_signature',{});console.log(t,s.rows,s.nonBlankChars);return s;};
const boot=await sig('boot');
console.log('insert',JSON.stringify(await ex('insert_disk',{drive:1,name:'blank.d88',base64:blank})).slice(0,80));
await sleep(500);
console.log('eject',JSON.stringify(await ex('eject_disk',{drive:1})).slice(0,80));
console.log('reset',JSON.stringify(await ex('reset',{})).slice(0,80));
await sleep(8000);
const after=await sig('after-reset');
assert.equal(after.rows, boot.rows);
assert.equal(after.nonBlankChars, boot.nonBlankChars);
console.log('PASS: eject-reset');
await b.close();
