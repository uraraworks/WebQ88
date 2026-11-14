#!/bin/bash
# 正規ファイルと陰性対照で公開物検査を確認する。
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webq88-publishable.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
node - "$ROOT/compat-rom" "$TEST_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [source, dest] = process.argv.slice(2);
for (const entry of JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')).files) {
  fs.copyFileSync(path.join(source, entry.name), path.join(dest, entry.name));
}
NODE
CHECK="$ROOT/tools/check_dist_publishable.sh"
bash "$CHECK" "$TEST_DIR" >/dev/null || { echo 'error: 正規ファイルの検査に失敗'; exit 1; }
dd if=/dev/urandom of="$TEST_DIR/extra.ROM" bs=8192 count=1 2>/dev/null
if bash "$CHECK" "$TEST_DIR" >/dev/null 2>&1; then echo 'error: 偽 ROM を検出できません'; exit 1; fi
rm "$TEST_DIR/extra.ROM"
FIRST="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).files[0].name)' "$ROOT/compat-rom/manifest.json")"
mkdir "$TEST_DIR/holding"
mv "$TEST_DIR/$FIRST" "$TEST_DIR/holding/$FIRST"
rm "$TEST_DIR/holding/$FIRST"
if bash "$CHECK" "$TEST_DIR" >/dev/null 2>&1; then echo 'error: 取り込み漏れを検出できません'; exit 1; fi
cp "$ROOT/compat-rom/$FIRST" "$TEST_DIR/$FIRST"
mkdir "$TEST_DIR/_local"
mv "$TEST_DIR/$FIRST" "$TEST_DIR/_local/$FIRST"
if bash "$CHECK" "$TEST_DIR" >/dev/null 2>&1; then echo 'error: 禁止ディレクトリを検出できません'; exit 1; fi
echo 'OK: 自己検査 4 件に成功'
