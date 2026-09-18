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
