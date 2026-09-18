#!/usr/bin/env node
// scripts/bridge-test-server.mjs
//
// 自動操作APIのWebSocketブリッジ経路(src/bridge.ts)を検査するための
// 最小サーバー。ページ側(?bridge=1、既定ポート3188)から接続してきたら
// コマンドを送り、結果を標準出力にJSONで1行ずつ出す(公式ROMは使わない
// 検証用ブリッジなので、本文が出ても問題ない互換ROMの範囲でしか叩かない)。
//
// 使い方: node scripts/bridge-test-server.mjs [port]
//   ページを ws://127.0.0.1:<port> へ接続させ(?bridge=<port>)、接続後に
//   標準入力からコマンド名を受け取って送信する(対話用)か、
//   --auto を付けると一連のコマンドを自動で送って結果を出力して終了する。

import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]) || 3188;
const auto = process.argv.includes('--auto');

const wss = new WebSocketServer({ host: '127.0.0.1', port });
console.log(`[bridge-test-server] listening on ws://127.0.0.1:${port}`);

let nextId = 1;
let currentWs = null;

function send(ws, cmd, args = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, cmd, args }));
  });
}

async function runAuto(ws) {
  const results = {};
  results.status = await send(ws, 'status');
  results.screen_signature_before = await send(ws, 'screen_signature');
  results.type_text = await send(ws, 'type_text', { text: 'PRINT 2+2\n' });
  await new Promise((r) => setTimeout(r, 500));
  results.screen_signature_after = await send(ws, 'screen_signature');
  results.screen_text = await send(ws, 'screen_text');
  console.log('RESULT_JSON_START');
  console.log(JSON.stringify(results));
  console.log('RESULT_JSON_END');
  process.exit(0);
}

wss.on('connection', (ws) => {
  console.log('[bridge-test-server] connection established');
  currentWs = ws;
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      console.log('[bridge-test-server] hello: role=' + msg.role);
      if (auto) void runAuto(ws);
    }
  });
  ws.on('close', () => {
    console.log('[bridge-test-server] connection closed');
    if (currentWs === ws) currentWs = null;
  });
});

if (auto) {
  const timeout = setTimeout(() => {
    console.log('RESULT_JSON_START');
    console.log(JSON.stringify({ error: 'timeout: no connection within 30s' }));
    console.log('RESULT_JSON_END');
    process.exit(1);
  }, 30000);
  timeout.unref();
}
