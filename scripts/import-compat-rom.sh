#!/bin/bash
# scripts/import-compat-rom.sh
#
# PC88Behavior のビルド成果物（クリーンルーム実装、MIT）から N88.ROM / DISK.ROM /
# FONT.ROM / N88_0.ROM〜N88_3.ROM（拡張ROMバンク、docs/spec/ext-rom-bank.md）
# と空データディスク BLANK2D.D88（docs/spec/l3-disk-format.md 第4節）を生成し、compat-rom/ に取り込む。manifest.json に生成元コミットと
# 各ファイルの SHA-256 を記録する。
#
# 使い方:
#   ./scripts/import-compat-rom.sh
#   PC88BEHAVIOR_DIR=/path/to/PC88Behavior ./scripts/import-compat-rom.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PC88BEHAVIOR_DIR="${PC88BEHAVIOR_DIR:-$PROJECT_DIR/../PC88Behavior}"
PC88BEHAVIOR_DIR="$(cd "$PC88BEHAVIOR_DIR" && pwd)"

OUT_DIR="$PROJECT_DIR/compat-rom"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "== PC88Behavior のビルドスクリプトで N88.ROM / DISK.ROM / FONT.ROM / N88_0.ROM〜N88_3.ROM を生成 =="
python3 "$PC88BEHAVIOR_DIR/src/build_main_rom.py" "$TMP_DIR"

echo "== 空のデータディスク BLANK2D.D88 を公開規則から生成 =="
# docs/spec/l3-disk-format.md 第4節。公式ディスクは入力にしない。起動用ではないデータディスク。
python3 "$PC88BEHAVIOR_DIR/tools/build_blank_data_disk.py" "$TMP_DIR/BLANK2D.D88"

echo "== 漢字 ROM を生成 =="
python3 "$PC88BEHAVIOR_DIR/tools/make_kanji_rom.py" --output-dir "$TMP_DIR"

echo "== 生成元コミットを記録 =="
REV="$(git -C "$PC88BEHAVIOR_DIR" rev-parse HEAD)"
DIRTY=""
if [ -n "$(git -C "$PC88BEHAVIOR_DIR" status --porcelain)" ]; then
  DIRTY=" (作業ツリーに未コミットの変更あり)"
fi

echo "== compat-rom/ へコピー =="
mkdir -p "$OUT_DIR"
FILES="N88.ROM N88N.ROM DISK.ROM FONT.ROM N88_0.ROM N88_1.ROM N88_2.ROM N88_3.ROM BLANK2D.D88"
for f in $FILES KANJI1.ROM KANJI2.ROM; do
  if [ ! -f "$TMP_DIR/$f" ]; then
    echo "エラー: 生成結果に $f がありません。" >&2
    exit 1
  fi
done
for f in $FILES KANJI1.ROM KANJI2.ROM; do cp "$TMP_DIR/$f" "$OUT_DIR/$f"; done

# 全ファイルを生成元コミットから取り込み、manifest を作り直す（既存の他の項目は保持）。
python3 - "$OUT_DIR" "$REV$DIRTY" <<'PYTHON'
import hashlib, json, sys
from pathlib import Path
out, rev = Path(sys.argv[1]), sys.argv[2]
manifest = out / 'manifest.json'
data = json.loads(manifest.read_text())
data['sourceCommit'] = rev
data.pop('kanjiSourceCommit', None)
names = [entry['name'] for entry in data['files']]
for name in ('N88.ROM','N88N.ROM','DISK.ROM','FONT.ROM','N88_0.ROM','N88_1.ROM','N88_2.ROM','N88_3.ROM','BLANK2D.D88','KANJI1.ROM', 'KANJI2.ROM'):
    if name not in names:
        names.append(name)
data['files'] = [dict(name=name, size=(out / name).stat().st_size,
                      sha256=hashlib.sha256((out / name).read_bytes()).hexdigest())
                 for name in names]
manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
PYTHON

echo "== 完了 =="
cat "$OUT_DIR/manifest.json"
