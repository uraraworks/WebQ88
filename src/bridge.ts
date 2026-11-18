import { encodePC, decodePC } from './basic-disk-fs';
import { getState, listStates } from './state-store';
import { listDisks, listFolders } from './disk-store';
import type { CoreProxy } from './core-proxy';
import type { DiskPanel } from './disks';

// src/bridge.ts
//
// WebSocket ブリッジ: 外部ツール(次ステップのMCPサーバー等)から WebQ88 を
// 遠隔操作するための最小プロトコル。移植元は姉妹アプリ WebX68k の
// ../../X68K/WebX68k/src/bridge.ts と同じ向き。
//
// メッセージ形式は {id, cmd, args} を受け取り、{id, result} を返す
// (docs/API-DESIGN.md の指示どおり、コマンドの実装・可否判定は一切ここに
// 持たない。CoreProxy.execApi 経由で Worker の public/api-dispatch.js へ
// そのまま転送し、返ってきた結果をそのまま返すだけ)。
//
// エミュレータ本体はブラウザ内で動き、ブリッジサーバーはユーザーのマシン上で
// 動く想定。ページ側から ws://127.0.0.1:<port> へ繋ぎに行く。
// 既定ポートは 3188 (WebX68k の 3099 と被らせない)。

export interface BridgeHost {
  exec(cmd: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface IncomingMessage {
  id?: unknown;
  cmd?: string;
  args?: Record<string, unknown>;
}

const RECONNECT_DELAY_MS = 3000;
const DEFAULT_BRIDGE_PORT = 3188;

/** `?bridge=...` の値から接続先 WebSocket URL を決める。未指定なら null。 */
export function resolveBridgeUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get('bridge');
  if (raw === null) return null;
  if (raw === '1' || raw === '') return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
  if (/^\d+$/.test(raw)) return `ws://127.0.0.1:${raw}`;
  return raw;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url = '';

  constructor(private host: BridgeHost) {}

  connect(url: string): void {
    this.url = url;
    this.clearReconnectTimer();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        // 既に閉じている場合は無視
      }
    }
    this.open();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, RECONNECT_DELAY_MS);
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.clearReconnectTimer();
      ws.send(JSON.stringify({ type: 'hello', role: 'webq88' }));
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => this.scheduleReconnect());
    ws.addEventListener('message', (ev: MessageEvent) => void this.handleMessage(ws, ev));
  }

  private async handleMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch (err) {
      console.error('[WebQ88 bridge] 不正なメッセージ', err);
      return;
    }
    const { id, cmd, args } = msg;
    if (typeof cmd !== 'string') return;
    const result = await this.host.exec(cmd, args ?? {});
    ws.send(JSON.stringify({ id, result }));
  }

  /** WebSocket を経由せず、ページ内 JS から直接コマンドを実行するための入口(デバッグ用)。 */
  async exec(cmd: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.host.exec(cmd, args);
  }
}

/** IndexedDB とUI側の操作をWorkerのAPIに合流させる。 */
export function createBridgeHost(proxy: CoreProxy, panel: DiskPanel): BridgeHost {
  return { async exec(cmd, args) {
    try {
      if (['disk_list_files', 'disk_read_file', 'disk_write_file', 'disk_delete_file'].includes(cmd)) {
        if (args.slot !== 'fd1' && args.slot !== 'fd2') throw Error('スロットはfd1またはfd2です');
        const d = args.slot === 'fd1' ? 0 : 1;
        // Worker の掛け金を既存の取得 API で必ず検査する。
        const gate = await proxy.execApi('get_disk_image', { drive: d + 1 });
        if (gate.error) return gate;
        if (cmd === 'disk_list_files') {
          if (args.path !== undefined && args.path !== '') throw Error('ディレクトリは未対応です');
          return { ok: true, ...(await panel.fileOperation(d, fs => fs.list(), false) as object) };
        }
        if (typeof args.path !== 'string' || !args.path) throw Error('ファイル名が必要です');
        const path = args.path;
        if (cmd === 'disk_read_file') {
          if (args.encoding !== undefined && args.encoding !== 'text' && args.encoding !== 'base64') throw Error('encodingが不正です');
          const bytes = await panel.fileOperation(d, fs => fs.read(path), false) as Uint8Array;
          if (args.encoding === 'base64') return { ok: true, base64: btoa(Array.from(bytes, x => String.fromCharCode(x)).join('')), size: bytes.length };
          return { ok: true, text: decodePC(bytes).replace(/\r\n|\r/g, '\n'), size: bytes.length };
        }
        if (cmd === 'disk_delete_file') { await panel.fileOperation(d, fs => fs.delete(path), true); return { ok: true }; }
        if ((typeof args.content === 'string') === (typeof args.base64 === 'string')) throw Error('contentまたはbase64の一方を指定してください');
        const bytes = typeof args.content === 'string' ? encodePC(args.content.replace(/\r\n|\r|\n/g, '\r\n')) : Uint8Array.from(atob(args.base64 as string), c => c.charCodeAt(0));
        await panel.fileOperation(d, fs => fs.write(path, bytes), true); return { ok: true, size: bytes.length };
      }
      if (cmd === 'list_states') {
        const result = await proxy.execApi(cmd, args);
        if (result.error) return result;
        const states = (await listStates()).filter(s => /^webq88-slot-[1-3]$/.test(s.key)).map(s => ({
          slot: `ui:${s.key.slice('webq88-slot-'.length)}`, savedAt: s.savedAt, size: s.bytes.byteLength,
          roms: s.info.roms.map(({ role, name, origin }) => ({ role, name, origin })),
        }));
        return { ok: true, states: [...(result.states as unknown[]), ...states] };
      }
      if (cmd === 'load_state' && typeof args.slot === 'string' && args.slot.startsWith('ui:')) {
        if (!/^ui:[1-3]$/.test(args.slot)) throw new Error('不正なUIスロットです');
        const saved = await getState(Number(args.slot.slice(3)));
        if (!saved) throw new Error('保存データがありません');
        const current = await proxy.stateRequest('info');
        if (!current.ok || !current.info) throw new Error('現在の構成を取得できませんでした');
        if (saved.info.roms.some(rom => rom.origin === 'user') && !current.info.roms.some(rom => rom.origin === 'user'))
          throw new Error('利用者ROMで保存したステートは、利用者ROMで起動したときだけ読み込めます');
        if (JSON.stringify(saved.info) !== JSON.stringify(current.info)) throw new Error('保存時と現在のROM構成またはディスクが異なります。UIから確認して読み込んでください');
        await panel.flushAll();
        const result = await proxy.stateRequest('load', saved.bytes);
        if (!result.ok) throw new Error(result.error ?? 'ステートを復元できませんでした');
        return { ok: true, slot: args.slot };
      }
      if (cmd === 'list_disk_library') {
        const folders = new Map((await listFolders()).map(folder => [folder.id, folder.name]));
        const disks = (await listDisks()).map(({ sourceKey, name, bytes, savedAt, displayName, url, archiveEntry, sourceOrder, lastImages, folderId }) =>
          ({ sourceKey, name, size: bytes.byteLength, savedAt, displayName, url, archiveEntry, sourceOrder, lastImages, folderName: folderId ? folders.get(folderId) ?? null : null }));
        return { ok: true, disks };
      }
      if (cmd === 'persist_disks') { await panel.flushAll(true); return { ok: true }; }
      return await proxy.execApi(cmd, args);
    } catch (err) { return { error: (err as Error).message }; }
  } };
}
