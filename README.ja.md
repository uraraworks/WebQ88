# WebQ88

QUASI88-libretro を emscripten でビルドした Web 版 PC-8801 エミュレータです。
将来的に [PC88Behavior](../PC88Behavior)（クリーンルーム実装の互換 ROM）を
`compat-rom/` に内蔵する予定です。現在開発中・非公開です。

## clone 後の設定

このリポジトリは公開前提の混入検査（公式 ROM・ディスクイメージ等の誤コミット防止）を
pre-commit フックで行っています。clone 後、以下を実行してください。

```sh
git config core.hooksPath tools/hooks
```

## コアのビルド

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

## ライセンス

未定。コア（QUASI88-libretro）は BSD 3-Clause です。
