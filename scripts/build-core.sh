#!/bin/bash
# quasi88-libretro コアを emscripten でビルドし、public/core/ に配置するスクリプト。
#
# 上流ソースはこのリポジトリに含めない。core/UPSTREAM に書かれた固定コミットを
# _local/quasi88-libretro-src (.gitignore 済み) に取得し、core/patches/ の
# 配布用パッチを適用してからビルドする。
#
# 使い方:
#   ./scripts/build-core.sh
#   NO_PATCH=1 OUT_DIR=/tmp/q88-no-patch ./scripts/build-core.sh   # 陰性対照用（素の上流）
#   TEST_SHIM=1 OUT_DIR=/tmp/q88-test-shim ./scripts/build-core.sh # 試験ビルド（配布物には入らない）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
REQUIRED_EMSDK_VERSION="${EMSDK_VERSION:-6.0.7}"
JOBS="${JOBS:-8}"

UPSTREAM_FILE="$PROJECT_DIR/core/UPSTREAM"
PATCH_DIR="$PROJECT_DIR/core/patches"
SRC_DIR="$PROJECT_DIR/_local/quasi88-libretro-src"

NO_PATCH="${NO_PATCH:-0}"
TEST_SHIM="${TEST_SHIM:-0}"
if [ "$NO_PATCH" = "1" ]; then
  if [ -z "${OUT_DIR:-}" ]; then
    echo "エラー: NO_PATCH=1 は陰性対照用の素のビルドです。配布用の public/core/ を" >&2
    echo "       上書きしないよう、OUT_DIR にリポジトリ外の一時ディレクトリを明示してください。" >&2
    echo "       例: NO_PATCH=1 OUT_DIR=/tmp/q88-no-patch ./scripts/build-core.sh" >&2
    exit 1
  fi
elif [ "$TEST_SHIM" = "1" ]; then
  if [ -z "${OUT_DIR:-}" ]; then
    echo "エラー: TEST_SHIM=1 は試験ビルド専用シム(webq88_test_shim.c)を含みます。配布用の" >&2
    echo "       public/core/ を上書きしないよう、OUT_DIR にリポジトリ外の一時ディレクトリを" >&2
    echo "       明示してください。" >&2
    echo "       例: TEST_SHIM=1 OUT_DIR=/tmp/q88-test-shim ./scripts/build-core.sh" >&2
    exit 1
  fi
else
  OUT_DIR="${OUT_DIR:-$PROJECT_DIR/public/core}"
fi

UPSTREAM_URL="$(grep -m1 '^上流:' "$UPSTREAM_FILE" | sed 's/^上流: *//')"
UPSTREAM_COMMIT="$(grep -m1 '^固定コミット:' "$UPSTREAM_FILE" | sed 's/^固定コミット: *//')"
if [ -z "$UPSTREAM_URL" ] || [ -z "$UPSTREAM_COMMIT" ]; then
  echo "エラー: $UPSTREAM_FILE から URL / 固定コミットを読み取れません。" >&2
  exit 1
fi

echo "== 作業用クローンを準備 ($UPSTREAM_COMMIT) =="
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch origin "$UPSTREAM_COMMIT" 2>/dev/null || true
  git -C "$SRC_DIR" reset --hard "$UPSTREAM_COMMIT"
  git -C "$SRC_DIR" clean -fdx
else
  rm -rf "$SRC_DIR"
  git clone "$UPSTREAM_URL" "$SRC_DIR"
  git -C "$SRC_DIR" checkout "$UPSTREAM_COMMIT"
fi

ACTUAL_HEAD="$(git -C "$SRC_DIR" rev-parse HEAD)"
if [ "$ACTUAL_HEAD" != "$UPSTREAM_COMMIT" ]; then
  echo "エラー: クローンのHEAD ($ACTUAL_HEAD) が固定コミットと一致しません。" >&2
  exit 1
fi

APPLIED_PATCHES=()
if [ "$NO_PATCH" = "1" ]; then
  echo "== NO_PATCH=1: パッチを適用しない（陰性対照） =="
else
  echo "== 配布用パッチを適用 =="
  for p in "$PATCH_DIR"/*.patch; do
    [ -e "$p" ] || continue
    echo "  適用チェック: $(basename "$p")"
    git -C "$SRC_DIR" apply --check "$p"
  done
  for p in "$PATCH_DIR"/*.patch; do
    [ -e "$p" ] || continue
    echo "  適用: $(basename "$p")"
    git -C "$SRC_DIR" apply "$p"
    APPLIED_PATCHES+=("$p")
  done

  echo "== font.h / pseudo_bios.h を削除（パッチではなくビルドスクリプトで行う） =="
  rm -f "$SRC_DIR/src/font.h" "$SRC_DIR/src/LIBRETRO/pseudo_bios.h"

  echo "== built_in_font_* / pbios_* 参照が残っていないか確認 =="
  # use_built_in_font は単なる設定フラグ名なので対象外。配列本体・疑似BIOS本体のみ検査する。
  REMAINING="$(grep -rl 'built_in_font_ANK\|built_in_font_ANH\|built_in_font_graph\|pbios_n88\|pbios_disk\|"font\.h"\|"pseudo_bios\.h"' "$SRC_DIR/src" 2>/dev/null || true)"
  if [ -n "$REMAINING" ]; then
    echo "エラー: パッチ適用後も built_in_font_* / pbios_* への参照が残っています:" >&2
    echo "$REMAINING" >&2
    exit 1
  fi
fi

echo "== emsdk 環境読み込み =="
source "$EMSDK_DIR/emsdk_env.sh"
EMCC_VERSION="$(emcc --version | head -n 1 | grep -oE '[0-9]+(\.[0-9]+){2}' | head -n 1)"
if [ "$EMCC_VERSION" != "$REQUIRED_EMSDK_VERSION" ]; then
  echo "エラー: emcc $REQUIRED_EMSDK_VERSION が必要です（検出: $EMCC_VERSION）。" >&2
  emcc --version >&2
  exit 1
fi

echo "== quasi88-libretro コアビルド (emscripten) =="
cd "$SRC_DIR"
emmake make platform=emscripten STATIC_LINKING=0 -j"$JOBS"

OBJS="$(find src -name '*.o')"
if [ -z "$OBJS" ]; then
  echo "エラー: オブジェクトファイル (src/**/*.o) が見つかりません。ビルドに失敗しています。" >&2
  exit 1
fi

echo "== WebQ88 シム(core/shim/webq88_shim.c)をコンパイル =="
# 上流ソースへのパッチではなく、WebQ88 側の追加ファイルとしてリンクに加える。
# 出どころ制限(docs/API-DESIGN.md 第3節)の掛け金と、RAMだけを読み書きする口を提供する。
SHIM_SRC="$PROJECT_DIR/core/shim/webq88_shim.c"
SHIM_OBJ="$SRC_DIR/webq88_shim.o"
if [ ! -f "$SHIM_SRC" ]; then
  echo "エラー: $SHIM_SRC が見つかりません。" >&2
  exit 1
fi
emcc -c "$SHIM_SRC" -O2 -o "$SHIM_OBJ"

TEST_SHIM_OBJS=()
EXPORTED_FUNCTIONS="_retro_set_environment,_retro_set_video_refresh,_retro_set_audio_sample,_retro_set_audio_sample_batch,_retro_set_input_poll,_retro_set_input_state,_retro_init,_retro_deinit,_retro_api_version,_retro_get_system_av_info,_retro_run,_retro_load_game,_retro_reset,_retro_serialize_size,_retro_serialize,_retro_unserialize,_malloc,_free,_webq88_restrict,_webq88_is_restricted,_webq88_ram_read,_webq88_ram_write,_webq88_text_cols,_webq88_text_snapshot"

if [ "$TEST_SHIM" = "1" ]; then
  echo "== 試験ビルド専用シム(core/shim/webq88_test_shim.c)をコンパイル =="
  # 配布ビルドには含めない。拡張ROMバンク切り替えの確認専用(scripts/smoke-ext-bank.cjs)。
  TEST_SHIM_SRC="$PROJECT_DIR/core/shim/webq88_test_shim.c"
  TEST_SHIM_OBJ="$SRC_DIR/webq88_test_shim.o"
  if [ ! -f "$TEST_SHIM_SRC" ]; then
    echo "エラー: $TEST_SHIM_SRC が見つかりません。" >&2
    exit 1
  fi
  emcc -c "$TEST_SHIM_SRC" -O2 -o "$TEST_SHIM_OBJ"
  TEST_SHIM_OBJS=("$TEST_SHIM_OBJ")
  EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS,_webq88_test_window_read"
fi

echo "== emcc でリンクし wasm/js を生成 =="
mkdir -p "$OUT_DIR"

# shellcheck disable=SC2086
emcc $OBJS "$SHIM_OBJ" "${TEST_SHIM_OBJS[@]}" -O2 -o "$OUT_DIR/q88_libretro.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=Q88 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sDEFAULT_TO_CXX=1 \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -sEXPORTED_RUNTIME_METHODS=addFunction,FS,HEAPU8,HEAPU16,UTF8ToString,stringToUTF8

PATCH_JSON="[]"
if [ "${#APPLIED_PATCHES[@]}" -gt 0 ]; then
  PATCH_JSON="["
  first=1
  for p in "${APPLIED_PATCHES[@]}"; do
    name="$(basename "$p")"
    sha="$(shasum -a 256 "$p" | awk '{print $1}')"
    if [ "$first" = "1" ]; then first=0; else PATCH_JSON+=","; fi
    PATCH_JSON+="{\"name\":\"$name\",\"sha256\":\"$sha\"}"
  done
  PATCH_JSON+="]"
fi

SHIM_SHA="$(shasum -a 256 "$SHIM_SRC" | awk '{print $1}')"

TEST_SHIM_JSON="null"
if [ "$TEST_SHIM" = "1" ]; then
  TEST_SHIM_SHA="$(shasum -a 256 "$TEST_SHIM_SRC" | awk '{print $1}')"
  TEST_SHIM_JSON="{\"file\": \"core/shim/webq88_test_shim.c\", \"sha256\": \"$TEST_SHIM_SHA\"}"
fi

cat > "$OUT_DIR/q88_libretro.build.json" <<EOF
{
  "upstreamUrl": "$UPSTREAM_URL",
  "upstreamCommit": "$UPSTREAM_COMMIT",
  "noPatch": $( [ "$NO_PATCH" = "1" ] && echo true || echo false ),
  "appliedPatches": $PATCH_JSON,
  "emscriptenVersion": "$EMCC_VERSION",
  "webq88Shim": {"file": "core/shim/webq88_shim.c", "sha256": "$SHIM_SHA"},
  "testShim": $TEST_SHIM_JSON
}
EOF

echo "== 完了 =="
ls -la "$OUT_DIR"
