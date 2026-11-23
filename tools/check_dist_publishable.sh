#!/bin/bash
# 配布物の ROM と禁止ディレクトリを検査する。
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo 'error: node が必要です' >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then
  HASH_COMMAND=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  HASH_COMMAND=sha256sum
else
  echo 'error: sha256 コマンドがありません' >&2
  exit 1
fi
export HASH_COMMAND
node - "$ROOT/compat-rom/manifest.json" "${1:-dist}" <<'NODE'
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [manifestPath, root] = process.argv.slice(2);
let entries;
try {
  entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files;
  if (!Array.isArray(entries) || entries.some(e => typeof e.name !== 'string' || !/^[a-f0-9]{64}$/i.test(e.sha256))) throw Error();
} catch (_) {
  console.error(`error: ${manifestPath} -- manifest を読み取れません`);
  process.exit(1);
}
const expected = new Set(entries.map(e => e.sha256.toLowerCase()));
const found = new Set();
let violations = 0, count = 0;
function violation(p, reason) { console.error(`error: ${p} -- ${reason}`); violations++; }
function walk(p, relative) {
  let stat;
  try { stat = fs.lstatSync(p); } catch (_) { violation(p, '読み取れません'); return; }
  if (stat.isSymbolicLink()) { violation(p, 'シンボリックリンクは検査できません'); return; }
  if (stat.isDirectory()) {
    if (['_local', 'private', 'tmp'].includes(path.basename(p))) violation(p, '禁止ディレクトリ');
    let children;
    try { children = fs.readdirSync(p); } catch (_) { violation(p, 'ディレクトリを読み取れません'); return; }
    for (const child of children) walk(path.join(p, child), true);
  } else if (stat.isFile() && /\.(rom|d88|dsk|t88|cmt|2d|88d)$/i.test(p)) {
    count++;
    const args = process.env.HASH_COMMAND === 'shasum' ? ['-a', '256', p] : [p];
    const result = spawnSync(process.env.HASH_COMMAND, args, { encoding: 'utf8' });
    const match = result.status === 0 && result.stdout.match(/^[\\]?([a-f0-9]{64})/i);
    if (!match) { violation(p, 'sha256 を計算できません'); return; }
    const hash = match[1].toLowerCase();
    found.add(hash);
    if (!expected.has(hash)) violation(p, '互換ROM一覧にない sha256');
  }
}
try {
  if (!fs.statSync(root).isDirectory()) throw Error();
  walk(root, false);
} catch (_) { violation(root, 'ディレクトリを読み取れません'); }
for (const entry of entries) if (/\.(rom|d88|dsk|t88|cmt|2d|88d)$/i.test(entry.name) && !found.has(entry.sha256.toLowerCase())) violation(entry.name, '互換ROMの取り込み漏れ');
if (violations) process.exit(1);
console.log(`OK: ROM/ディスク ${count} 件すべて互換ROM一覧と一致`);
NODE
