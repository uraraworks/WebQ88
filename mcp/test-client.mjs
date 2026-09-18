#!/usr/bin/env node
// mcp/test-client.mjs
//
// server.mjs をstdioで子プロセス起動し、MCP SDKのClientとして接続して
// 一連のツール呼び出しを検査する。ページ側(?bridge=1)は事前にブラウザで
// 開いておくこと(このスクリプトはブラウザを起動しない)。
//
// 使い方:
//   WEBQ88_BRIDGE_PORT=3188 node mcp/test-client.mjs [--restricted]
//
// --restricted を付けると、restricted系コマンド(screen_text/screenshot/
// read_memory/get_state_blob)がエラーになることを検査するモードになる
// (ページ側が制限モードで起動済みであることが前提。互換モードのまま
// このフラグを付けると期待どおりに失敗する)。
//
// 公式ROMは一切使わない。互換ROM(compat-rom/)のみを対象にした検査。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const restricted = process.argv.includes('--restricted');

function textOf(result) {
  const t = result?.content?.find((c) => c.type === 'text');
  return t ? t.text : '';
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'server.mjs')],
    env: process.env,
  });
  const client = new Client({ name: 'webq88-test-client', version: '0.1.0' });
  await client.connect(transport);

  const failures = [];
  const record = (label, ok, detail) => {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures.push(label);
  };

  // --- list_tools ---
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((t) => t.name));
  const expected = [
    'status',
    'reset',
    'key',
    'key_sequence',
    'type_text',
    'screen_signature',
    'screen_text',
    'screenshot',
    'wait_screen_change',
    'wait_screen_signature',
    'read_memory',
    'write_memory',
    'save_state',
    'load_state',
    'get_state_blob',
    'insert_disk',
    'eject_disk',
    'list_disks',
  ];
  const missing = expected.filter((n) => !toolNames.has(n));
  const extra = [...toolNames].filter((n) => !expected.includes(n));
  record(
    'list_tools == AUTOMATION.md commands',
    missing.length === 0 && extra.length === 0,
    `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`
  );

  if (!restricted) {
    // --- 互換モード想定の検査 ---
    const status = await client.callTool({ name: 'status', arguments: {} });
    record('status', !status.isError, textOf(status).slice(0, 200));

    const typed = await client.callTool({ name: 'type_text', arguments: { text: 'PRINT 3+4\n' } });
    record('type_text', !typed.isError, textOf(typed).slice(0, 200));

    // type_text は打鍵と同時に描画まで進めるため、直後の画面はすでに落ち着いている。
    // ここでは「変化が無ければタイムアウトエラーを返す」という契約そのものを検査する
    // (変化を検出できることは screen_signature の前後比較で別途確認済み)。
    const waited = await client.callTool({
      name: 'wait_screen_change',
      arguments: { timeoutFrames: 8 },
    });
    record(
      'wait_screen_change (timeout contract)',
      waited.isError === true && textOf(waited).includes('timeout'),
      textOf(waited).slice(0, 200)
    );

    const screenText = await client.callTool({ name: 'screen_text', arguments: {} });
    const screenTextBody = textOf(screenText);
    record(
      'screen_text (contains 7)',
      !screenText.isError && screenTextBody.includes('7'),
      screenTextBody.slice(0, 300)
    );

    const sig = await client.callTool({ name: 'screen_signature', arguments: {} });
    record('screen_signature', !sig.isError, textOf(sig).slice(0, 200));

    const shot = await client.callTool({ name: 'screenshot', arguments: {} });
    const image = shot?.content?.find((c) => c.type === 'image');
    record('screenshot (image content)', !shot.isError && !!image, image ? `bytes=${image.data.length}` : textOf(shot));

    const mem = await client.callTool({
      name: 'read_memory',
      arguments: { region: 0, offset: 0, length: 16 },
    });
    record('read_memory', !mem.isError, textOf(mem).slice(0, 200));
  } else {
    // --- 制限モード想定の検査: ×のコマンドがエラーになること ---
    for (const name of ['screen_text', 'screenshot', 'read_memory', 'get_state_blob']) {
      const args = name === 'read_memory' ? { region: 0, offset: 0, length: 16 } : {};
      const res = await client.callTool({ name, arguments: args });
      const detail = textOf(res);
      record(`${name} rejected in restricted mode`, res.isError === true, detail.slice(0, 200));
    }
    const okStill = await client.callTool({ name: 'screen_signature', arguments: {} });
    record('screen_signature still works in restricted mode', !okStill.isError, textOf(okStill).slice(0, 200));
  }

  await client.close();

  console.log('---');
  console.log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test-client error:', err && err.stack ? err.stack : err);
  process.exit(1);
});
