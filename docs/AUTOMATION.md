# 自動操作API — 使い方

設計方針は [docs/API-DESIGN.md](API-DESIGN.md) を参照。ここは実装後の
「入口・コマンド一覧・検査の回し方」をまとめる。MCPサーバー化は次ステップで、
このリポジトリにはまだ含まれない。

## 1. 入口

自動操作APIの実装(可否判定を含む)は `public/api-dispatch.js` の
`exec(ctx, cmd, args)` 1箇所に集約されている。呼び出し元は以下の2つで、
どちらも `exec()` へ転送して結果を返すだけで、コマンド一覧や可否判定を
複製しない。

### 1.1 WebSocketブリッジ(`?bridge=1`)

ページのURLに `?bridge=1`(既定ポート **3188**。姉妹アプリ WebX68k の
3099と被らせない)または `?bridge=<port>` を付けると、そのページは
`ws://127.0.0.1:<port>` へ接続するWebSocketクライアントになる
(`src/bridge.ts`)。本番ビルドでは `?bridge` が無ければ一切接続しない
(`src/main.ts` で確認済み)。

プロトコルは `{id, cmd, args}` を送ると `{id, result}` が返る単純な形。

```js
// ws サーバー側の例
ws.send(JSON.stringify({ id: 1, cmd: 'status', args: {} }));
// -> {"id":1,"result":{"ok":true,"booted":true,"mode":{...}}}
```

接続直後にページ側から `{"type":"hello","role":"webq88"}` が届く。

### 1.2 `window.__webq88Debug`(開発ビルドのみ)

`npm run dev` で起動したときだけ、ページ内JSから直接呼べる入口が
`window.__webq88Debug.exec(cmd, args)` として公開される。ブリッジと同じ
経路(`Bridge.exec()` → `CoreProxy.execApi()` → Worker → `api-dispatch.js`)
を通るため、可否判定はブリッジ経由と完全に同じ。本番ビルド(`npm run build`)
には含まれない。

## 2. コマンド一覧と可否

`docs/API-DESIGN.md` 第4節の表のとおり。制限モード(利用者が公式ROMを
1本でも読み込んだセッション)で×のコマンドは
`{"error":"restricted: official ROM loaded in this session"}` を返す。

| コマンド | 引数 | 互換 | 制限 | 備考 |
|---|---|---|---|---|
| `status` | — | ○ | ○ | 起動状態・モード・ROM出どころ |
| `reset` | — | ○ | ○ | 同一Workerで再起動(掛け金は保持) |
| `key` | `{code, action:'down'\|'up'\|'tap'}` | ○ | ○ | `code`はRETROK値 |
| `key_sequence` | `{steps:[{code,action,waitFrames?}]}` | ○ | ○ | 各ステップ後に`waitFrames`(既定4)分進む |
| `type_text` | `{text}` | ○ | ○ | ASCII英数字・記号・空白・`\n`のみ |
| `screen_signature` | — | ○ | ○ | `{rows, nonBlankChars, sha256, columns, screenRows}`。本文は返さない。`columns`/`screenRows`は現在の桁数・行数 |
| `find_text` | `{text, all?}` | ○ | × | 行内の一致位置 `matches`（0始まりの `row`, `col`）と `count`。`all` は既定 false |
| `wait_screen` | `{contains, timeout_ms?}` | ○ | × | 出現の有無 `found` と経過 `elapsed_ms`。既定10000ms、最大60000ms |
| `screen_text` | — | ○ | × | `{lines, columns, rows}`。行ごとの文字列(半角カナ以外の非ASCIIは`\xNN`)。40桁・20行/25行モードに追従(40桁は間の空白バイトを除いた40文字) |
| `screenshot` | — | ○ | × | `{format:'png', width, height, base64}` |
| `wait_screen_change` | `{timeoutFrames}` | ○ | ○ | 署名変化を検出したら返る |
| `wait_screen_signature` | `{sha256, timeoutFrames}` | ○ | ○ | 指定署名に一致したら返る |
| `read_memory` | `{region, offset, length}` | ○ | × | `region`: 0=main_ram 1=main_high_ram 2=サブ側RAM |
| `write_memory` | `{region, offset, bytes}` | ○ | × | `bytes`はbase64 |
| `save_state` | `{slot?}` | ○ | ○ | 中身は返さずサイズのみ。Worker内メモリのみ(永続化しない) |
| `load_state` | `{slot?}` | ○ | ○ | 保存済みでなければエラー |
| `get_state_blob` | `{slot?}` | ○ | × | 保存済みステートの中身(base64) |
| `insert_disk` | `{drive:1\|2, name, base64}` | ○ | ○ | 指定ドライブへD88イメージを挿入。不正イメージはエラー。UIの保存(IndexedDB)の対象外 |
| `eject_disk` | `{drive:1\|2}` | ○ | ○ | 排出。空でも成功(`hadDisk`で区別) |
| `list_disks` | — | ○ | ○ | `{disks:[{drive, empty, name?, size?, written?}]}`。中身は返さない |
| `get_disk_image` | `{drive:1\|2}` | ○ | × | 現在のイメージ全体(base64)。利用者が持ち込んだ公式ディスクの中身を返さないため制限モードでは拒否 |

未知のコマンドは `{"error":"unknown command: ..."}`。引数が不正な場合も
理由付きエラーを返す(空文字列や0で成功したふりをしない)。

### `type_text` の文字対応について

PC-8801の実キーボードは多くの記号キーが「1つの物理キーに unshifted/shifted
の2文字」を持つ(quasi88-libretro の `src/keyboard.c` の `keyport[]` テーブルで
確認: 例えば`;`キーは無シフトで`;`、シフトで`+`。同じport/bitを共有する)。
`type_text`はこれを踏まえ、文字ごとに「どちらの物理キーを、SHIFTありで押すか
なしで押すか」を内部で解決してから打鍵する。この解決表は`public/char-map.js`
に一本化してあり(`SHIFTED_CHARS`・`charToKeySteps`)、`public/api-dispatch.js`
(`type_text`)と人間用キーボード入力`src/keyboard.ts`(記号キーの判定。
KeyboardEvent.code は物理位置でホストのキー配列に依存するため、記号だけは
KeyboardEvent.key の実際の文字で引く)の両方から共有する(表を二重に持たない)。
対応外の文字(日本語や制御文字など)はその位置を明示したエラーを返す
(`type_text`の場合。`keyboard.ts`側は解決できない記号キーを黙って無視する)。

### ディスク(`insert_disk` 等)の実装メモ

実体は `public/disk-host.js`(Worker と Node スモークで共有)。ドライブごとに
固定パス(`/disk/drive1.d88`・`/disk/drive2.d88`)を MEMFS に置き、同じファイルを
その場で上書きして差し替える(上流 `file-op.c` はディスクのストリームを fclose せず
16枠しか無く解放もされないため、挿入のたびにパスを変えると枠が尽きる)。ゲストの書き込みを
イメージ本体へ書かせるため、環境コールバックの GET_VARIABLE で
`q88_save_to_disk_image=enabled` を返している(無効だと .srm 差分ファイルへ書かれ、
吸い出したイメージに書き込みが入らない)。ROM 再起動(`retro_load_game` が全ドライブを
イジェクトする)の後は、MEMFS 上の書き込み済みの中身ごと自動で挿入し直す。
`scripts/smoke-disk.cjs` が一連(SAVE→FILES→NEW→LOAD→LIST、吸い出しの別起動での
再挿入、陰性対照、24回差し替え、ドライブ1ブランク起動)を検査する。

## 3. 検査の回し方

### 3.1 コマンド本体(公式ROM不使用)

```sh
node scripts/smoke-api.cjs                 # 既定: public/core と compat-rom/ を使用
node scripts/smoke-api.cjs <coreディレクトリ> <compat-romディレクトリ>
```

互換モード(同梱ROMとして起動)で全コマンドが成功すること、制限モード
(同じ互換ROMを「利用者が読み込んだファイル」として起動)で×のコマンドが
理由付きエラーになることを検査する。加えて:

- 陰性対照: `ctx.getMode()`が偽の値(`restricted:false`)を返すよう
  差し替えると、制限モードでも`screen_text`が通ってしまうことを確認する
  (試験が実際にdispatchの可否判定を踏んでいる証拠。dispatch本体は
  変更しない)
- コア側の二重化: JS側のチェックを全て外した試験専用ctxでも、
  `core/shim/webq88_shim.c`の`webq88_ram_read`がrestricted中は
  独立に拒否することを確認する

### 3.2 WebSocketブリッジ経路

```sh
npm run dev -- --port 5188 --strictPort &     # 既に起動済みならそれを使う
node scripts/bridge-test-server.mjs 3188 --auto &
# ブラウザで http://localhost:5188/?bridge=1 を開く
```

サーバーは接続後に `status` → `screen_signature` → `type_text` →
`screen_signature` → `screen_text` を送り、結果をJSONで標準出力に出して
終了する。`?bridge` を付けずに開いた場合は接続が来ないことも確認する。

### 3.3 ディスク

```sh
node scripts/smoke-disk.cjs        # 互換ROMと自作ブランクディスクのみ使用(画面本文を見て判定)
```

### 3.4 既存の検査

`scripts/smoke-app.cjs` / `scripts/smoke-mode.cjs` / `scripts/smoke-core.sh`、
`npm run build`、`npm run typecheck`、`bash tools/check_publishable.sh --all`
は自動操作API追加後も変わらずPASSすること。

## 4. 実装メモ(設計との整合)

- 桁数・行数の判定はハードウェア側の状態で行う(ROM内部のワークは読まない)。
  桁数は I/O ポート 0x30 の bit0(1=80桁 / 0=40桁。コアの `sys_ctrl`)、
  行数は CRTC に設定された表示行数(`crtc_sz_lines`)。40桁のときテキスト
  VRAMは1行120バイトのまま文字が2バイトおきに並ぶので、`webq88_text_snapshot()`
  が2バイトおきに拾い、`webq88_text_cols()` は40を返す。この変更はC側
  (シム)なので、反映には `scripts/build-core.sh` でコアの再ビルドが要る。
  `scripts/smoke-api.cjs` が 80/40桁×20/25行の4通りで検査している。

- テキスト画面の取り出しは `core/shim/webq88_shim.c` の
  `webq88_text_snapshot()` / `webq88_text_cols()` で行う。上流の
  `src/crtcdmac.c` の `crtc_make_text_attr()` を読み、文字コードが
  表示モードによらず `main_ram` 上の `text_dma_addr.W`
  (`dmac_address[2].W`)を先頭に `crtc_byte_per_line` バイトごと、
  各行の先頭 `crtc_sz_columns` バイトに属性を挟まず連続して並ぶことを確認して
  実装した。この2関数は掛け金(`webq88_is_restricted()`)を見ない
  (`screen_signature`は制限モードでも必要なため)。本文を返す`screen_text`
  側の制限は`public/api-dispatch.js`(JS層)で行う。
- `save_state`/`load_state`の実体は`retro_serialize`/`retro_unserialize`。
  コア側では中身を検査して拒否できない(利用者の手元保存に必要な機能その
  ものであり、シリアライズ結果の意味をシムが解釈できないため)。したがって
  「制限モードでは中身をAPIで返さない/`get_state_blob`は拒否する」という
  区別はJS層のみで行う(API-DESIGN.md 第4節に既述のとおり)。
- `screenshot`はコア(wasm)側でPNG化する代わりに、依存ゼロの最小PNG
  エンコーダ(`public/api-dispatch.js`内、zlibのstored/非圧縮ブロックのみ
  使用)をWorker・Nodeスモークテストの両方から共有して使う。CompressionStream
  やNodeのzlibモジュールに依存すると、Worker(ブラウザ)とNode(スモーク
  テスト)で別実装が必要になり、ロジックの二重化(このリポジトリで避けたい
  こと)につながるため。
