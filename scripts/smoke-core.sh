#!/bin/bash
# scripts/smoke-core.sh
#
# 互換ROM（PC88Behavior のビルド成果物）を一時ディレクトリに生成し、
# scripts/smoke-core.cjs でコアの動作確認をする。
#
# 使い方:
#   ./scripts/smoke-core.sh [coreディレクトリ]  (省略時は public/core)
#
# 環境変数:
#   PC88BEHAVIOR_DIR  PC88Behavior のパス（既定: ../PC88Behavior）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PC88BEHAVIOR_DIR="${PC88BEHAVIOR_DIR:-$PROJECT_DIR/../PC88Behavior}"
CORE_DIR="${1:-$PROJECT_DIR/public/core}"

if [ ! -d "$PC88BEHAVIOR_DIR" ]; then
  echo "エラー: PC88Behavior が見つかりません: $PC88BEHAVIOR_DIR" >&2
  echo "       PC88BEHAVIOR_DIR で場所を指定してください。" >&2
  exit 1
fi

ROM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webq88_rom.XXXXXX")"
trap 'rm -rf "$ROM_DIR"' EXIT

echo "== 互換ROMをビルド ($ROM_DIR) =="
python3 "$PC88BEHAVIOR_DIR/src/build_main_rom.py" "$ROM_DIR"

echo "== スモークテスト実行 =="
node "$SCRIPT_DIR/smoke-core.cjs" "$CORE_DIR" "$ROM_DIR"
