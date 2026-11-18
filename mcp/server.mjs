#!/usr/bin/env node
// WebQ88 MCP server: ブラウザで動く WebQ88(PC-8801 エミュレータ)を WebSocket 越しに操作し、
// MCP クライアント(Claude Code 等)から画面の取得・キー入力・メモリアクセス等を行えるようにする。
// 移植元は姉妹アプリ WebX68k の mcp/server.mjs。
//
// 重要: stdout は MCP の stdio transport 専用。診断出力は必ず console.error() を使うこと。
//
// このサーバーは docs/API-DESIGN.md の指示どおり「可否の判断を一切持たない」。
// public/api-dispatch.js の exec() が返す {ok:true,...} をそのまま結果として返し、
// {error:'...'} をそのまま isError なツールエラー(本文に理由文字列そのまま)として返す。
// 制限モードの判定・コマンドごとの許可表はここには書かない(二箇所に書くと食い違う)。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const BRIDGE_PORT = Number(process.env.WEBQ88_BRIDGE_PORT) || 3188;
const REQUEST_TIMEOUT_MS = 20000;
// ページ側の再接続間隔(3秒)より長く待つ
const CLIENT_WAIT_MS = 8000;

// --- WebSocket ブリッジ ----------------------------------------------------
//
// 複数ページが同時に ?bridge=1 で接続してきた場合は、WebX68k に倣い
// 「最後に hello してきたタブ」だけをアクティブにする(古い接続は close する)。
// 複数タブを同時操作する用途は想定していない(1操作対象=1タブの前提)。

let activeClient = null;
let nextRequestId = 1;
const pending = new Map();

const wss = new WebSocketServer({ port: BRIDGE_PORT });

wss.on('listening', () => {
  console.error(`WebSocket bridge listening on port ${BRIDGE_PORT}`);
});

wss.on('error', (err) => {
  console.error('WebSocket server error:', err && err.stack ? err.stack : err);
});

wss.on('connection', (ws) => {
  console.error('Browser client connected');

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error('Received non-JSON message from browser:', err.message);
      return;
    }

    // 新しいタブが名乗ってきたら、それを唯一の接続先として扱う。
    if (msg && msg.type === 'hello' && msg.role === 'webq88') {
      if (activeClient && activeClient !== ws && activeClient.readyState === activeClient.OPEN) {
        console.error('Replacing previous active client');
        try {
          activeClient.close();
        } catch {
          // ignore
        }
      }
      activeClient = ws;
      console.error('Active WebQ88 client registered');
      return;
    }

    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      // src/bridge.ts は {id, result} を返す(結果自体が {ok:true,...} か {error:'...'})。
      entry.resolve(msg.result);
    }
  });

  ws.on('close', () => {
    if (activeClient === ws) activeClient = null;
    console.error('Browser client disconnected');
  });

  ws.on('error', (err) => {
    console.error('Browser client error:', err && err.message ? err.message : err);
  });
});

/**
 * ブラウザタブの接続を待つ。ページ側は切断されると3秒間隔で繋ぎ直しに来るので、
 * MCP サーバーを起動した直後や再起動した直後は「まだ繋がっていない」状態が数秒続く。
 * ここで待たないと最初の1回が必ず失敗して使いづらい。
 */
async function waitForClient(timeoutMs = CLIENT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (activeClient && activeClient.readyState === activeClient.OPEN) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return activeClient !== null && activeClient.readyState === activeClient.OPEN;
}

async function sendCommand(cmd, args = {}) {
  const timeoutMs = cmd === 'paste_text' ? Math.max(REQUEST_TIMEOUT_MS, 5000 + Array.from(args.text || '').length * 1000) : cmd === 'wait_screen' ? Math.max(REQUEST_TIMEOUT_MS, (args.timeout_ms ?? 10000) + 5000) : REQUEST_TIMEOUT_MS;
  if (!(await waitForClient())) {
    throw new Error('WebQ88 のブラウザタブが接続されていません');
  }
  return new Promise((resolve, reject) => {
    if (!activeClient || activeClient.readyState !== activeClient.OPEN) {
      reject(new Error('WebQ88 のブラウザタブが接続されていません'));
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`コマンド ${cmd} がタイムアウトしました (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    activeClient.send(JSON.stringify({ id, cmd, args }));
  });
}

/**
 * ブラウザ未接続・タイムアウト時に、手順を添えたエラーを返す。
 * dispatch(public/api-dispatch.js)が返した {error:...} はここでは判定せず、
 * callDispatch() 側でそのまま isError として素通しする(可否判断を持たない)。
 */
async function withBridge(fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${message}\n\n` +
            `WebQ88 のタブが ?bridge=1 付きで開かれているか確認してください。\n` +
            `例: http://localhost:5188/?bridge=1 (ポートを変える場合は ?bridge=<port>)`,
        },
      ],
    };
  }
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const jsonResult = (value) => textResult(JSON.stringify(value, null, 2));

/**
 * public/api-dispatch.js の exec() 呼び出し。戻り値は必ず {ok:true,...} か
 * {error:'...'} のどちらか(dispatch側が例外を投げない設計のため)。
 * ここでは中身を判定せず、error があればそのまま MCP のツールエラーにする
 * (制限モードかどうか・どのコマンドが×かの判断はしない)。
 */
async function callDispatch(cmd, args = {}) {
  return withBridge(async () => {
    const result = await sendCommand(cmd, args);
    if (result && typeof result === 'object' && 'error' in result) {
      return { isError: true, content: [{ type: 'text', text: String(result.error) }] };
    }
    return jsonResult(result);
  });
}

// --- MCP サーバー ----------------------------------------------------------

const server = new McpServer({
  name: 'webq88-mcp',
  version: '0.1.0',
});

server.tool(
  'status',
  'WebQ88 の現在の状態(起動しているか、互換/制限モード、読み込んだROMの役割・出どころ)を取得する。まず最初にこれを呼ぶと状況が分かる。',
  {},
  async () => callDispatch('status')
);

server.tool(
  'reset',
  '同一Workerでコアを再起動する(制限モードの掛け金は保持されたまま)。',
  {},
  async () => callDispatch('reset')
);

server.tool(
  'key',
  'キーを1つ、押す/離す/タップのいずれかで操作する。',
  {
    code: z.number().describe('RETROK のキーコード'),
    action: z.enum(['down', 'up', 'tap']).describe('down=押す, up=離す, tap=押して離す'),
  },
  async ({ code, action }) => callDispatch('key', { code, action })
);

server.tool(
  'key_sequence',
  '複数のキー操作を順番に実行する。各ステップ後に waitFrames(既定4)分だけエミュレーションを進める。',
  {
    steps: z
      .array(
        z.object({
          code: z.number().describe('RETROK のキーコード'),
          action: z.enum(['down', 'up', 'tap']),
          waitFrames: z.number().optional().describe('このステップの後に進めるフレーム数(既定4)'),
        })
      )
      .describe('実行するキー操作の並び'),
  },
  async ({ steps }) => callDispatch('key_sequence', { steps })
);

server.tool(
  'type_text',
  'ASCII英数字・記号・空白・改行(\\n)のみの文字列をキーボード入力として送る。対応外の文字が含まれる場合はどの位置かを示すエラーになる。',
  {
    text: z.string().describe('入力する文字列(ASCII範囲のみ)'),
  },
  async ({ text }) => callDispatch('type_text', { text })
);

server.tool(
  'paste_text',
  'Paste ASCII and half-width kana as keyboard input. Unsupported characters are skipped and returned. Newlines are sent as Return.',
  { text: z.string().describe('Text to paste.') },
  async ({ text }) => callDispatch('paste_text', { text })
);

server.tool(
  'send_keys',
  'Send a single key combination, such as "SHIFT+F1", "CTRL+C", or "RETURN".',
  { keys: z.string().describe('A single key combination.') },
  async ({ keys }) => {
    const names = keys.toUpperCase().split('+').map((name) => name.trim());
    const modifiers = { SHIFT: 304, CTRL: 305, CONTROL: 305, ALT: 308, GRPH: 308 };
    const special = { RETURN: 13, ENTER: 13, ESC: 27, ESCAPE: 27, TAB: 9, SPACE: 32, BACKSPACE: 8, BS: 8, DELETE: 127, INSERT: 277, HOME: 278, UP: 273, DOWN: 274, LEFT: 276, RIGHT: 275, STOP: 318, COPY: 316 };
    const main = names.pop();
    const mods = names.map((name) => modifiers[name]);
    let code = special[main];
    if (code === undefined && /^[A-Z0-9]$/.test(main)) code = main.toLowerCase().charCodeAt(0);
    if (code === undefined && /^F[1-5]$/.test(main)) code = 281 + Number(main.slice(1));
    if (code === undefined || mods.some((value) => value === undefined) || new Set(mods).size !== mods.length) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid key combination: ' + keys }] };
    }
    const steps = [
      ...mods.map((value) => ({ code: value, action: 'down', waitFrames: 2 })),
      { code, action: 'tap', waitFrames: 4 },
      ...mods.reverse().map((value) => ({ code: value, action: 'up', waitFrames: 2 })),
    ];
    return callDispatch('key_sequence', { steps });
  }
);

server.tool(
  'mouse_move',
  'マウスを相対移動する(端子の機器がマウスのときだけ。制限モードでも使える)。',
  { dx: z.number().int().describe('横の移動量(右が正)'), dy: z.number().int().describe('縦の移動量(下が正)') },
  async ({ dx, dy }) => callDispatch('mouse_move', { dx, dy })
);

server.tool(
  'mouse_button',
  'マウスのボタンを押す・離す・クリックする(端子の機器がマウスのときだけ。制限モードでも使える)。',
  { button: z.enum(['left', 'right']).describe('ボタン'), action: z.enum(['down', 'up', 'click']).describe('操作') },
  async ({ button, action }) => callDispatch('mouse_button', { button, action })
);

server.tool(
  'screen_signature',
  '画面の署名({rows, nonBlankChars, sha256})を取得する。本文は返さないため制限モードでも常に使える。',
  {},
  async () => callDispatch('screen_signature')
);

server.tool(
  'screen_text',
  'テキスト画面の内容を行ごとの文字列として取得する。制限モード(利用者ROM使用時)では拒否される。',
  {},
  async () => callDispatch('screen_text')
);

server.tool(
  'find_text',
  '画面の文字列を検索し、0始まりの行・桁と件数を返す。制限モードでは拒否される。',
  { text: z.string().describe('検索する文字列'), all: z.boolean().optional().describe('全件を返す（既定は先頭のみ）') },
  async ({ text, all }) => callDispatch('find_text', { text, all })
);

server.tool(
  'wait_screen',
  '画面に文字列が現れるまで待ち、成否と経過ミリ秒を返す。制限モードでは拒否される。',
  { contains: z.string().describe('待つ文字列'), timeout_ms: z.number().optional().describe('待機ミリ秒（既定10000、最大60000）') },
  async ({ contains, timeout_ms }) => callDispatch('wait_screen', { contains, timeout_ms })
);

server.tool(
  'screenshot',
  '画面をPNG画像として取得する。制限モード(利用者ROM使用時)では拒否される。',
  {},
  async () =>
    withBridge(async () => {
      const result = await sendCommand('screenshot');
      if (result && typeof result === 'object' && 'error' in result) {
        return { isError: true, content: [{ type: 'text', text: String(result.error) }] };
      }
      return { content: [{ type: 'image', data: String(result.base64), mimeType: 'image/png' }] };
    })
);

server.tool(
  'wait_screen_change',
  '画面の署名が変化するまで、最大 timeoutFrames フレーム待つ。',
  {
    timeoutFrames: z.number().describe('最大待機フレーム数'),
  },
  async ({ timeoutFrames }) => callDispatch('wait_screen_change', { timeoutFrames })
);

server.tool(
  'wait_screen_signature',
  '画面の署名(sha256)が指定値に一致するまで、最大 timeoutFrames フレーム待つ。',
  {
    sha256: z.string().describe('待つ対象のsha256署名'),
    timeoutFrames: z.number().describe('最大待機フレーム数'),
  },
  async ({ sha256, timeoutFrames }) => callDispatch('wait_screen_signature', { sha256, timeoutFrames })
);

server.tool(
  'read_memory',
  'ゲストのメモリ領域を読む。region: 0=main_ram, 1=main_high_ram, 2=サブ側RAM。制限モードでは拒否される。',
  {
    region: z.number().describe('0=main_ram, 1=main_high_ram, 2=サブ側RAM'),
    offset: z.number().describe('読み出し開始オフセット'),
    length: z.number().describe('読み出しバイト数'),
  },
  async ({ region, offset, length }) => callDispatch('read_memory', { region, offset, length })
);

server.tool(
  'write_memory',
  'ゲストのメモリ領域へ書き込む(bytesはbase64)。制限モードでは拒否される。',
  {
    region: z.number().describe('0=main_ram, 1=main_high_ram, 2=サブ側RAM'),
    offset: z.number().describe('書き込み開始オフセット'),
    bytes: z.string().describe('書き込む内容(base64)'),
  },
  async ({ region, offset, bytes }) => callDispatch('write_memory', { region, offset, bytes })
);

server.tool(
  'save_state',
  '現在の実行状態をWorker内メモリに保存する(永続化はしない)。中身は返さずサイズのみ。',
  {
    slot: z.string().optional().describe('保存枠の名前(既定 "default")'),
  },
  async ({ slot }) => callDispatch('save_state', { slot })
);

server.tool(
  'load_state',
  '保存済みのステートを復元する。UIのスロットは ui:1〜ui:3 で指定する。構成が異なるUIスロットはUIでの確認が必要。',
  {
    slot: z.string().optional().describe('復元する保存枠の名前(既定 "default")'),
  },
  async ({ slot }) => callDispatch('load_state', { slot })
);

server.tool(
  'list_states',
  'Worker内とUIの保存済みステートの名前、日時、サイズ、ROM構成を一覧する。',
  {},
  async () => callDispatch('list_states')
);

server.tool(
  'get_state_blob',
  '保存済みステートの中身をbase64で取得する。制限モードでは拒否される。',
  {
    slot: z.string().optional().describe('取得する保存枠の名前(既定 "default")'),
  },
  async ({ slot }) => callDispatch('get_state_blob', { slot })
);

server.tool(
  'insert_disk',
  '指定ドライブへD88イメージを挿入する。不正イメージはエラー。UIの保存(IndexedDB)の対象外。',
  {
    drive: z.number().describe('ドライブ番号(1または2)'),
    name: z.string().describe('ディスク名'),
    base64: z.string().describe('D88イメージ(base64)'),
  },
  async ({ drive, name, base64 }) => callDispatch('insert_disk', { drive, name, base64 })
);

server.tool(
  'eject_disk',
  'ドライブからディスクを排出する。空でも成功し、hadDiskで区別する。',
  { drive: z.number().describe('ドライブ番号(1または2)') },
  async ({ drive }) => callDispatch('eject_disk', { drive })
);

server.tool(
  'list_disks',
  'ドライブの状態を一覧する。ディスクの中身は返さない。',
  {},
  async () => callDispatch('list_disks')
);

server.tool(
  'list_disk_library',
  'ブラウザに保存されたディスクの名前、サイズ、保存日時などを一覧する。',
  {},
  async () => callDispatch('list_disk_library')
);

server.tool(
  'persist_disks',
  '挿入中のライブラリディスクの変更をブラウザへ直ちに保存する。',
  {},
  async () => callDispatch('persist_disks')
);

server.tool(
  'export_disk',
  '指定スロットのディスクイメージ全体をbase64で取得する。制限モードでは拒否される。',
  { slot: z.enum(['fd1', 'fd2']).describe('対象スロット') },
  async ({ slot }) => callDispatch('get_disk_image', { drive: slot === 'fd1' ? 1 : 2 })
);

server.tool(
  'get_disk_image',
  '現在のディスクイメージ全体をbase64で取得する。制限モードでは拒否される。',
  { drive: z.number().describe('ドライブ番号(1または2)') },
  async ({ drive }) => callDispatch('get_disk_image', { drive })
);

const diskSlot = z.enum(['fd1', 'fd2']).describe('対象ドライブ');
const diskPath = z.string().describe('9バイト以内のファイル名');
server.tool('disk_list_files', 'N88-BASICディスクのファイルと空き容量を一覧する。制限モードでは拒否。', { slot: diskSlot, path: z.string().optional() }, async ({slot, path}) => callDispatch('disk_list_files', {slot, path}));
server.tool('disk_read_file', 'N88-BASICディスクのファイルを読む。textはASCIIと半角カナ、base64は生データ。制限モードでは拒否。', {slot: diskSlot, path: diskPath, encoding: z.enum(['text','base64']).optional()}, async ({slot,path,encoding}) => callDispatch('disk_read_file',{slot,path,encoding}));
server.tool('disk_write_file', 'ASCII形式で新規作成または上書きする。変更後は再挿入するがゲストのキャッシュが残る場合がある。ゲストがドライブを読み書きしていない時に実行する。制限モードでは拒否。', {slot: diskSlot, path: diskPath, content: z.string().optional(), base64: z.string().optional()}, async ({slot,path,content,base64}) => callDispatch('disk_write_file',{slot,path,content,base64}));
server.tool('disk_delete_file', 'ファイルを削除する。変更後は再挿入するがゲストのキャッシュが残る場合がある。ゲストがドライブを読み書きしていない時に実行する。制限モードでは拒否。', {slot: diskSlot, path: diskPath}, async ({slot,path}) => callDispatch('disk_delete_file',{slot,path}));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('WebQ88 MCP server ready (stdio)');
