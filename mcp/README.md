# webq88-mcp — WebQ88 を AI から操作する MCP サーバー

WebQ88 (PC-8801 エミュレータ Web 版) をブラウザ越しに操作するための MCP サーバーです。
MCP サーバー本体 (stdio transport) と、ブラウザと通信するための WebSocket ブリッジサーバーを
同一の Node.js プロセス内で起動します。構成は姉妹アプリ WebX68k の `mcp/` と同じです。

エミュレータ本体はブラウザ内で動き、この MCP サーバーは常に**あなたのマシン上**で動きます。
ページの JavaScript が `ws://127.0.0.1:<ポート>` へ接続しに来る構成のため、ローカル開発サーバーで
開いても公開ページで開いても同じように使えます。

**このサーバーは可否の判断を一切持ちません。** ツール呼び出しは
`src/bridge.ts` の `{id, cmd, args}` プロトコルへそのまま中継し、
`public/api-dispatch.js` の `exec()` が返した `{ok:true,...}` / `{error:'...'}` を
そのまま結果 / ツールエラーとして返すだけです。制限モード(利用者が公式ROMを
読み込んだセッション)でどのコマンドが拒否されるかは
[docs/API-DESIGN.md](../docs/API-DESIGN.md) 第4節と
[docs/AUTOMATION.md](../docs/AUTOMATION.md) を参照してください
(この README・server.mjs には複製しません)。

## セットアップ(このリポジトリを使う場合)

前提: Node.js 18 以上。

```sh
cd mcp
npm install
```

Claude Code へ MCP サーバーとして登録する場合(**このコマンド自体はこのリポジトリからは
実行しません**。利用者が自分の環境で実行してください):

```sh
claude mcp add webq88 -- node "$PWD/mcp/server.mjs"
```

Claude Code 以外の MCP クライアントの場合は、stdio transport で
`node <このリポジトリ>/mcp/server.mjs` を起動する設定を追加してください。

ブラウザで WebQ88 を `bridge=1` パラメータ付きで開きます:

```sh
npm run dev -- --port 5188 --strictPort
# ブラウザで http://localhost:5188/?bridge=1 を開く
```

ページ側は切断されても3秒間隔で繋ぎ直しに行くので、MCP サーバーを後から起動しても構いません。

ブリッジのポートを変えたい場合は、サーバー側は環境変数 `WEBQ88_BRIDGE_PORT`、
ページ側は `?bridge=<ポート番号>` で指定します(既定 3188。WebX68k の 3099 とは別ポート)。

`find_text` は `text` と任意の `all` を受け、0始まりの `matches`（`row`, `col`）と `count` を返します。`wait_screen` は `contains` と任意の `timeout_ms`（既定10000、最大60000）を受け、`found` と `elapsed_ms` を返します。どちらも行内で大文字小文字を区別し、半角カナに対応します。

## 提供するツール

自動操作APIを使うツールです。

| ツール | 内容 | 制限モードでの扱い |
| --- | --- | --- |
| `status` | 起動状態・モード(互換/制限)・読み込んだROMの役割と出どころ | ○ |
| `reset` | 同一Workerでコアを再起動(掛け金は保持) | ○ |
| `key` | キー1つを押す/離す/タップ | ○ |
| `key_sequence` | キー操作の並びを順番に実行 | ○ |
| `type_text` | ASCII文字列をキー入力として送る(改行=Enter) | ○ |
| `paste_text` | ASCII・半角カナを送信し、対応外の文字を一覧で返す | ○ |
| `send_keys` | `SHIFT+F1` や `CTRL+C` などのキーの組み合わせを送る | ○ |
| `mouse_move` | マウスを相対移動（端子の機器がマウスのときだけ） | ○ |
| `mouse_button` | マウスの左右ボタンを押す・離す・クリック（同上） | ○ |
| `screen_signature` | 画面の署名(行数・非空白文字数・sha256)。本文は返さない | ○ |
| `find_text` / `wait_screen` | 文字列の位置・件数 / 出現と経過時間。本文は返さない。存在の反復照会で本文を復元できるため拒否 | ×(エラー) |
| `screen_text` | テキスト画面の本文を行配列で取得 | ×(エラー) |
| `screenshot` | 画面をPNG画像で取得 | ×(エラー) |
| `wait_screen_change` | 画面の署名が変化するまで待つ | ○ |
| `wait_screen_signature` | 画面の署名が指定値に一致するまで待つ | ○ |
| `read_memory` / `write_memory` | ゲストのメモリ領域の読み書き | ×(エラー) |
| `save_state` / `load_state` | 実行状態の保存・復元(中身は返さずサイズのみ) | ○ |
| `list_states` | WorkerとUIのステートの日時・サイズ・ROM構成を一覧 | ○ |
| `get_state_blob` | 保存済みステートの中身(base64) | ×(エラー) |
| `insert_disk` | D88イメージを挿入(UIの保存対象外) | ○ |
| `eject_disk` | ディスクを排出(空でも成功、hadDiskで区別) | ○ |
| `list_disks` | ドライブの状態一覧(中身は返さない) | ○ |
| `list_disk_library` | ブラウザのディスクライブラリを一覧 | ○ |
| `persist_disks` | ライブラリディスクの変更を即時保存(API挿入分は対象外) | ○ |
| `export_disk` | `fd1` / `fd2` のイメージをbase64で取得 | ×(エラー) |
| `get_disk_image` | 現在のイメージ全体(base64) | ×(エラー) |

「×(エラー)」は、`isError: true` とともに `public/api-dispatch.js` が返した
理由文字列(例: `restricted: official ROM loaded in this session`)がそのまま本文に入ります。

## ページ未接続・タイムアウト時

ブラウザタブが `?bridge=1` で接続されていない場合、および応答がタイムアウトした場合
(既定20秒)は、`isError: true` とともに接続手順を添えたエラーメッセージを返します。

## 複数ページ接続時の扱い

複数のタブが同時に `?bridge=1` で接続してきた場合、**最後に `hello` してきたタブだけを
アクティブとして扱い、それ以前のアクティブなタブの接続は閉じます**(WebX68k と同じ方針)。
1つの MCP サーバーが同時に操作できる対象は常に1タブです。複数のエミュレータを並行して
自動操作したい場合は、タブごとに `?bridge=<別ポート>` を割り当て、対応する
`WEBQ88_BRIDGE_PORT` で MCP サーバーをそれぞれ別プロセスとして起動してください。

## 検査

```sh
cd mcp && npm install
node test-client.mjs             # 互換モード想定(?bridge=1 のタブを事前に開いておく)
node test-client.mjs --restricted  # 制限モード想定(利用者ROムとして起動したタブ)
```

`test-client.mjs` は MCP SDK の `Client` で `server.mjs` を stdio 起動し、
`docs/AUTOMATION.md` のコマンド一覧と `list_tools` の一致、および主要ツールの
呼び出し結果を検査します。ブラウザタブは事前に手動(またはBrowser pane等)で
開いておく必要があります(このスクリプト自体はブラウザを起動しません)。

`load_state` は `ui:1`〜`ui:3` でUIのスロットも読めます。保存時と現在のROM構成またはディスクが違う場合はUIから確認して読み込んでください。利用者ROMのステートは互換ROMだけのセッションには読み込めません。

WebNP2の `put_file` / `get_file` はDOSの転送フロッピーとCOPYに依存するため実装していません。

ディスク内のファイルは `disk_list_files`、`disk_read_file`、`disk_write_file`、`disk_delete_file` で操作できます。対象は標準 2D D88 の N88-BASIC 形式です。`slot` は `fd1` / `fd2`、`path` は9バイト以内のファイル名です。一覧のサイズは判定できない場合 null です。`disk_read_file` は `encoding` に `text` または `base64`、書き込みは `content` または `base64` を指定します。テキストは ASCII と半角カナに対応し改行を CRLF にします。書き込みは ASCII 形式です。利用者 ROM の制限モードでは利用できません。ゲストがドライブを使用中は操作しないでください。変更時の再挿入後もゲストのキャッシュが残る場合があります。
