# WebQ88

[English](README.en.md)

PC-8801 エミュレータ [QUASI88](https://www.eonet.ne.jp/~showtime/quasi88/) を libretro 化した
QUASI88-libretro を emscripten で wasm ビルドし、ブラウザ上で動かす Web プレイヤーです。
公式 ROM の代わりに、クリーンルームで作った互換 ROM
[PC88Behavior](https://github.com/uraraworks/PC88Behavior) を同梱しているため、
URL を開くだけで N88-BASIC 互換の画面まで起動します。

自動操作 API の設計は [docs/API-DESIGN.md](docs/API-DESIGN.md) を参照してください。

## 今すぐ試す

- **公開ページ**: <https://uraraworks.github.io/WebQ88/>（準備中。今は「開発方法」の手順でローカルで動かしてください）

公式 ROM・市販ソフトのディスクイメージは同梱していません。手元の D88 イメージは
ドライブ行へのドラッグ&ドロップで読み込めます。

## 使い方

WebQ88 の特徴を紹介する紹介ページは
<https://uraraworks.github.io/WebQ88/about.html> にあります。

プレイヤー向けの使い方ページは
<https://uraraworks.github.io/WebQ88/help.html> にあります。
どちらもページ右上のボタンで日本語と英語を切り替えられます（`?lang=ja` / `?lang=en`）。
画面下の **「ヘルプ」** からも開けます。

### URL パラメータ

| パラメータ | 内容 |
|---|---|
| `fd1=URL` / `fd2=URL` | ドライブ1・ドライブ2に入れるディスクイメージの URL（パーセントエンコードする） |
| `lib=URL` | 挿入せずディスクライブラリに登録する。複数回指定できる |
| `run=1` | 起動ボタンを押さずに自動で起動する |
| `bridge=1` | AI エージェント用の WebSocket ブリッジにつなぐ（→「MCP対応」） |

- ZIP/LZH は展開し、中の .d88/.88d をすべてライブラリに登録して先頭を挿入します。
- 配布元には CORS 対応が必要です。Dropbox の共有リンクは自動で変換します。
  Google Drive は中継サービス（ビルド時の `VITE_DISK_PROXY`）が必要です。OneDrive には対応していません。
- 2回目以降は保存済みの変更を復元します。ライブラリの「配布元に戻す」で取り直せます。

### ツールバー

| ボタン | 動作 |
|---|---|
| 一時停止 | 動作を止める・再開する |
| ミュート | 音を消す・戻す（音量は「…」メニュー） |
| 全画面表示 | 画面を拡大する |
| ソフトキーボード | 画面上に PC-88 配列のキーボードを出す |
| バーチャルパッド | タッチ用の十字キーとボタンを出す |
| スクリーンショット | 画面を PNG で保存する |
| ディスクライブラリ | 保存済みのディスクを選んで挿入する |
| …（その他の操作） | 共有 URL のコピー、音量、表示比率、補間、ゲームパッド・キー割当、テンキー代替、利用者 ROM |
| リセット | マシンをリセットする |

### ドライブ (FDD1 / FDD2)

- 「＋」で D88/88D/ZIP/LZH を選ぶか、ドライブ行へドラッグ&ドロップします。
- 「⏏」で排出、「↓」で今のディスクをダウンロードします。
- FDD2 の「ブランクFD」で空の N88-BASIC 2D データディスクを作れます（起動用ではありません）。
- 書き込みは数秒おきにブラウザ（IndexedDB）へ自動保存され、次回は自動で挿入されます。
  サイトデータを消すと保存も消えるので、大切なディスクはダウンロードしておいてください。

### キーボード・ゲームパッド

- 英数字・Enter・矢印・Shift・Ctrl・F1〜F10 などは対応するキーで入力します。記号は入力された
  文字に合わせて PC-88 のキーへ変換します。
- 「テンキー代替」をオンにすると、メインの数字キーがテンキーに、矢印キーがテンキーの 8・2・4・6
  になります（テンキーの無いパソコン向け）。
- 「ゲームパッド・キー割当」で、物理ゲームパッドのボタン・軸、デッドゾーン、バーチャルパッドの
  部品、物理キーボードの割当先を変えられます。設定はブラウザに保存されます。

### 利用者 ROM（制限モード）

「…」→ 利用者 ROM で手元の ROM ファイルを選ぶと、そちらで起動し直せます。ROM はブラウザの中だけで
使い、どこにも送信しません。利用者 ROM で起動している間は **制限モード** になり、自動操作 API の
一部が使えなくなります（理由と範囲は [docs/API-DESIGN.md](docs/API-DESIGN.md)）。

## 同梱している互換 ROM

`compat-rom/` には PC88Behavior のビルド成果物だけを置いています。

- PC88Behavior は外部から観測できる振る舞いだけを手がかりに書いたクリーンルーム実装で、
  公式 ROM のバイト列を含みません。
- 起動時の画面には互換 ROM の名前・日付・コミットが表示されます。
- 漢字 ROM は、フリーの東雲フォントから生成した自作のものを同梱しています（字形は実機と異なります）。
- 詳しくは [compat-rom/README.md](compat-rom/README.md) を参照してください。

## MCP対応 (AIエージェントからの遠隔操作)

`mcp/` に、AI エージェントから WebQ88 を操作する MCP サーバーがあります。ブラウザで
`?bridge=1` 付きで開くと、手元の MCP サーバーとつながり、キー入力・文字列入力・画面の状態取得、
ディスクの挿入・排出などを行えます。セットアップは [mcp/README.md](mcp/README.md)、コマンドの一覧と可否は
[docs/AUTOMATION.md](docs/AUTOMATION.md) を参照してください。

## 開発方法

```sh
npm install
npm run dev       # 開発サーバー
npm run build     # 型チェック + 本番ビルド (dist/)
npm run preview   # ビルド成果物のプレビュー
```

使い方ページの画像を撮り直すには、別ターミナルで `npm run dev` を起動し、
`npm run capture-help` を実行します。必要に応じて `CHROME_PATH` に Chrome の実行ファイル、
`WEBQ88_URL` に開発サーバーの URL（既定: `http://localhost:5173`）を指定してください。
プレイヤーの UI は現在日本語のみのため、英語版の画像にも日本語が表示されます。

### clone 後の設定

このリポジトリは公開前提の混入検査（公式 ROM・ディスクイメージ等の誤コミット防止）を
pre-commit フックで行っています。clone 後、以下を実行してください。

```sh
git config core.hooksPath tools/hooks
```

### コアのビルド

上流ソース（quasi88-libretro）はこのリポジトリに含めません。
`scripts/build-core.sh` が `core/UPSTREAM` の固定コミットを取得し、
`core/patches/` の配布用パッチを当ててから emscripten でビルドします。

前提:
- `~/emsdk` に emsdk 導入済み、`emcc` は 6.0.7
- コンパット ROM 生成用に [PC88Behavior](../PC88Behavior) が隣にあること

```sh
./scripts/build-core.sh
# public/core/q88_libretro.{js,wasm} と q88_libretro.build.json が生成される
# （いずれも .gitignore 済みでコミットしない）

# 動作確認（互換ROMを自動生成してスモークテスト）
./scripts/smoke-core.sh

# 陰性対照（パッチなしの素の上流をビルドして、フォントが壊れることを確認）
NO_PATCH=1 OUT_DIR=/tmp/q88-no-patch ./scripts/build-core.sh
./scripts/smoke-core.sh /tmp/q88-no-patch

# 拡張ROMバンク切り替えの確認（試験ビルド専用シムを使う。配布物には入らない）
TEST_SHIM=1 OUT_DIR=/tmp/q88-test-shim ./scripts/build-core.sh
node scripts/smoke-ext-bank.cjs /tmp/q88-test-shim compat-rom
node scripts/smoke-ext-bank.cjs /tmp/q88-test-shim compat-rom --omit N88_2.ROM  # 陰性対照
node scripts/smoke-cjk-font.cjs /tmp/q88-test-shim compat-rom
node scripts/smoke-cjk-font.cjs /tmp/q88-test-shim compat-rom --omit  # 陰性対照
```

`core/patches/` の5本のパッチは、上流 libretro.c / memory.c にある
「フォントROM読み込み成功時にも内蔵フォント・漢字ROMで上書きしてしまう」
「漢字 ROM が無い場合の読み出し値が 0xFF になる」
「N88.ROM/DISK.ROM が無いと出所不明の疑似BIOSにフォールバックする」
「load_system_file の rom_filename が初期化されないまま参照される」
「handle_input() の識別マッピングループが KEY88_AT(='@')を取りこぼし、
'@'キーが一切反応しない」という5つの不具合を修正します。font.h・
pseudo_bios.h の削除は（中身が長大なバイト列のため）パッチではなく
ビルドスクリプトの `rm` で行います。

## ライセンス・同梱物について

- 本リポジトリのコード自体のライセンスは特に定めていません。
- コア（QUASI88-libretro）は BSD 3-Clause ライセンスです。
- `compat-rom/` の互換 ROM（PC88Behavior のビルド成果物）は MIT ライセンスです。
  同梱の漢字 ROM の元になった東雲フォントはパブリックドメインです。
- **PC-8801 の公式 ROM・市販ソフトウェアのディスクイメージは一切同梱していません。**
  pre-commit フック（`tools/check_publishable.sh`）で誤コミットを検査しています。
- 利用者が読み込ませる ROM・ディスクイメージは、各自が適法に入手・使用する責任を負います。

## 実装済みの主な機能

- 互換 ROM による ROM 無し起動（URL を開いてボタン1つで起動、`run=1` で自動起動）
- URL パラメータでのディスク読込・fetch 進捗表示、ドラッグ&ドロップ、ZIP/LZH 展開
- IndexedDB によるディスクの自動保存と、次回起動時の自動挿入
- ディスクライブラリ、ブランクFD作成、ディスクのダウンロード、共有 URL のコピー
- ドライブアクセスランプ
- BGM・効果音の再生（AudioWorklet による音声出力）、ミュート・音量（設定はブラウザに保存）
- 一時停止、リセット、フルスクリーン、スクリーンショット（PNG）
- 表示比率（4:3 / ドット等倍）と補間（シャープ・バイリニア / ニアレスト）の切替
- ソフトキーボード、バーチャルパッド、物理ゲームパッド、キー割当、テンキー代替
- 利用者 ROM での起動（制限モード）
- MCP サーバー・WebSocket ブリッジによる自動操作

## 未対応・既知の注意点

- 同梱の漢字 ROM は東雲フォントから作った自作のもので、字形は実機と異なります。
- 互換 ROM は公式 ROM と完全には同じではありません。動かない市販ソフトもあります。
- 中間言語形式の BASIC プログラム（公式で SAVE したもの）は読めません。プログラムのやり取りは
  ASCII 形式（`SAVE "x",A`）で行ってください。
- ステートセーブ / ロードは未対応です。
- プレイヤー画面（ボタン・メニュー）は日本語のみです。紹介・使い方ページは日英に対応しています。
