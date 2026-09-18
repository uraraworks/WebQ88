# WebQ88 — Claude Code 設定

QUASI88-libretro を emscripten でビルドする予定の Web 版 PC-8801 エミュレータ。
現在は private だが、**将来 public 化する前提** で運用する。

## 公開前提の規律

- このリポジトリは将来 public 化する。**履歴も含めて全部公開される**ので、
  「最初から公開してよいもの」だけをコミットする。あとで消せば済む、とは考えない。
- 公式 ROM・公式ディスクイメージ・それら由来のバイト列は一切コミットしない。
  公式 ROM は利用者が自分のブラウザで読み込む方式にする（同梱しない）。
- 公式ソフトの画面本文（表示内容）やスクリーンショットもコミットしない。
- コミット前に `pre-commit` フックが `tools/check_publishable.sh` を実行し、
  上記違反があれば止める。すり抜けたと気づいたら隠さず、履歴ごと洗い直す。

## 互換ROM（compat-rom/）の扱い

- 互換 ROM は `../PC88Behavior`（PC88Behavior、クリーンルーム実装）の
  **ビルド成果物のみ** を `compat-rom/` に取り込む。ソースやツールは持ち込まない。
- PC88Behavior のクリーンルーム規律（`../PC88Behavior/CLAUDE.md`）に従う。
  このリポジトリ側から公式 ROM を直接読む経路（環境変数・パス埋め込み等）は作らない。
- 役割分担: ROM の正しさの測定・適合テストは PC88Behavior 側
  （ネイティブの QUASI88 ハーネス）で行う。WebQ88 は測定器にしない。

## ブラウザ保存領域

- localStorage / IndexedDB / OPFS のキー・DB名には `webq88-` 接頭辞を付ける。
  GitHub Pages では WebNP2 / WebX68k 等の他プロジェクトと同一 origin になるため、
  衝突を避ける必要がある。

## 言語

- 回答・作業説明・commit message はすべて日本語で行う。
