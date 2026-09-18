#!/bin/bash
# check_publishable_selftest.sh
#
# check_publishable.sh の陽性・陰性対照テスト。
# 一時リポジトリを作り、違反ファイルがステージされたときに検査が
# exit 1 になること（陽性）、普通のファイルと compat-rom/ 配下の
# .rom が通ること（陰性対照）を確認する。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check_publishable.sh"

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

PASS=0
FAIL=0
POS=0
NEG=0

fresh_repo() {
    rm -rf "$TMPDIR_ROOT/repo"
    mkdir -p "$TMPDIR_ROOT/repo"
    (cd "$TMPDIR_ROOT/repo" && git init -q -b main && git config user.email test@example.com && git config user.name test)
}

# 陽性対照: 違反があれば exit 1 になるべき
expect_violation() {
    label="$1"
    (
        cd "$TMPDIR_ROOT/repo" || exit 1
        "$CHECK_SCRIPT" >"$TMPDIR_ROOT/selftest_out.$$" 2>&1
    )
    status=$?
    if [ "$status" -ne 0 ]; then
        echo "OK (陽性): $label -- 期待通り拒否された"
        PASS=$((PASS + 1))
        POS=$((POS + 1))
    else
        echo "NG (陽性): $label -- 拒否されるべきなのに通過した"
        FAIL=$((FAIL + 1))
    fi
}

# 陰性対照: 違反が無ければ exit 0 になるべき
expect_ok() {
    label="$1"
    (
        cd "$TMPDIR_ROOT/repo" || exit 1
        "$CHECK_SCRIPT"
    )
    status=$?
    if [ "$status" -eq 0 ]; then
        echo "OK (陰性): $label -- 期待通り通過した"
        PASS=$((PASS + 1))
        NEG=$((NEG + 1))
    else
        echo "NG (陰性): $label -- 通過すべきなのに拒否された"
        FAIL=$((FAIL + 1))
    fi
}

# --- 陽性対照: fake.rom ---
fresh_repo
echo "dummy" > "$TMPDIR_ROOT/repo/fake.rom"
(cd "$TMPDIR_ROOT/repo" && git add fake.rom)
expect_violation "fake.rom (ROM拡張子)"

# --- 陽性対照: private/x.txt ---
fresh_repo
mkdir -p "$TMPDIR_ROOT/repo/private"
echo "secret" > "$TMPDIR_ROOT/repo/private/x.txt"
(cd "$TMPDIR_ROOT/repo" && git add -f private/x.txt)
expect_violation "private/x.txt (privateディレクトリ)"

# --- 陽性対照: 1MB超のファイル ---
fresh_repo
(cd "$TMPDIR_ROOT/repo" && dd if=/dev/zero of=bigfile.bin bs=1024 count=1025 status=none)
(cd "$TMPDIR_ROOT/repo" && git add bigfile.bin)
expect_violation "bigfile.bin (1MB超)"

# --- 陽性対照: N88.ROM という名前 ---
fresh_repo
echo "dummy" > "$TMPDIR_ROOT/repo/N88.ROM"
(cd "$TMPDIR_ROOT/repo" && git add N88.ROM)
expect_violation "N88.ROM (公式ROMファイル名 かつ 拡張子)"

# --- 陰性対照: 普通のファイル ---
fresh_repo
echo "hello" > "$TMPDIR_ROOT/repo/README.md"
(cd "$TMPDIR_ROOT/repo" && git add README.md)
expect_ok "README.md (普通のファイル)"

# --- 陰性対照: compat-rom/ 配下の .rom ---
fresh_repo
mkdir -p "$TMPDIR_ROOT/repo/compat-rom"
echo "dummy" > "$TMPDIR_ROOT/repo/compat-rom/n88.rom"
(cd "$TMPDIR_ROOT/repo" && git add compat-rom/n88.rom)
expect_ok "compat-rom/n88.rom (除外解除ディレクトリ)"

echo ""
echo "==== selftest 結果: PASS=$PASS FAIL=$FAIL (陽性=$POS 陰性=$NEG) ===="

if [ "$FAIL" -eq 0 ]; then
    echo "OK: 全テスト通過"
    exit 0
else
    echo "NG: 失敗あり" >&2
    exit 1
fi
