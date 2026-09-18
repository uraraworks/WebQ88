#!/bin/bash
# check_publishable.sh
#
# 公開前提リポジトリ向けの混入検査。
# ステージされたファイル（または --all で追跡中の全ファイル）を検査し、
# 違反があればパス名と理由だけを出力して exit 1 する。
# ファイルの中身は一切出力しない。
#
# bash 3.2 (macOS 標準) 互換。

set -u

MODE="staged"
if [ "${1:-}" = "--all" ]; then
    MODE="all"
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
    echo "error: not a git repository" >&2
    exit 1
fi
cd "$REPO_ROOT" || exit 1

VIOLATIONS=0

# ROM/ディスク系拡張子（大文字小文字両方）。compat-rom/ 配下は除外。
ROM_EXTS="rom ROM d88 D88 dsk DSK t88 T88 cmt CMT 2d 2D 88d 88D"

# 公式ROMファイル名らしきキーワード（大文字小文字無視）
ROM_NAME_KEYWORDS="N88 DISK.ROM KANJI"

is_under_compat_rom() {
    case "$1" in
        compat-rom/*) return 0 ;;
        *) return 1 ;;
    esac
}

check_path() {
    path="$1"

    if is_under_compat_rom "$path"; then
        return
    fi

    # 1. ROM/ディスク拡張子
    for ext in $ROM_EXTS; do
        case "$path" in
            *."$ext")
                echo "違反: $path -- 公式ROM/ディスク系拡張子 (.$ext) はコミット禁止"
                VIOLATIONS=$((VIOLATIONS + 1))
                ;;
        esac
    done

    # 2. private/ _local/ tmp/ 配下
    case "$path" in
        private/*|_local/*|tmp/*)
            echo "違反: $path -- private/_local/tmp 配下はコミット禁止"
            VIOLATIONS=$((VIOLATIONS + 1))
            ;;
    esac

    # 3. 1MB超のファイル
    if [ -f "$path" ]; then
        size=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path" 2>/dev/null)
        if [ -n "$size" ] && [ "$size" -gt 1048576 ]; then
            echo "違反: $path -- サイズが1MBを超えている (${size} bytes)"
            VIOLATIONS=$((VIOLATIONS + 1))
        fi
    fi

    # 4. 公式ROMファイル名らしきキーワード（大文字小文字無視）
    lower_path=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
    for kw in $ROM_NAME_KEYWORDS; do
        lower_kw=$(printf '%s' "$kw" | tr '[:upper:]' '[:lower:]')
        case "$lower_path" in
            *"$lower_kw"*)
                echo "違反: $path -- 公式ROMファイル名らしきキーワード ($kw) を含む"
                VIOLATIONS=$((VIOLATIONS + 1))
                ;;
        esac
    done
}

if [ "$MODE" = "all" ]; then
    FILE_LIST_CMD="git ls-files -z"
else
    FILE_LIST_CMD="git diff --cached --name-only --diff-filter=ACMR -z"
fi

while IFS= read -r -d '' path; do
    [ -z "$path" ] && continue
    check_path "$path"
done < <($FILE_LIST_CMD)

if [ "$VIOLATIONS" -gt 0 ]; then
    echo ""
    echo "check_publishable: $VIOLATIONS 件の違反が見つかりました。コミットを中止します。" >&2
    exit 1
fi

exit 0
