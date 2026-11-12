# compat-rom/

ここには **PC88Behavior のビルド成果物だけ** を置く。ライセンスは生成元と使用フォントを参照。

**公式ROMは絶対に置かない。**

- PC88Behavior は測定に基づくクリーンルーム実装で、公式 ROM のバイト列を含まない。
  詳細は `../PC88Behavior/CLAUDE.md`（クリーンルーム規律）を参照。
- このディレクトリ配下だけは `.gitignore` の ROM/ディスク拡張子の除外を解除している
  （`!compat-rom/**`）。それ以外の場所に ROM 系ファイルを置いてはならない。

## BLANK2D.D88（空のデータディスク）

「ブランクFDを作成」用の、空の N88-BASIC 2D データディスク（D88 形式）。

- PC88Behavior の `tools/build_blank_data_disk.py` が、公開された規則
  （`docs/spec/l3-disk-format.md` 第4節）だけから生成する。公式媒体を入力にしておらず、
  **公式ディスク由来のバイトを含まない**（全セクタが規則で決まる一様値）。
- **起動用ではないデータディスク**。起動用セクタ (0,0,1) は読めない形にしてあり、
  公式ROM でも起動できない。ドライブ2などのデータ用に使う。
- 生成は決定論的で、SHA-256 は `manifest.json` に記録する。

## 漢字 ROM（KANJI1.ROM・KANJI2.ROM）

PC88Behavior の `tools/make_kanji_rom.py` が東雲フォントから生成する。
東雲はパブリックドメインで、ライセンス原文は
`../PC88Behavior/fonts/shinonome-0.9.11/LICENSE` にある。半角の一部には
既存 FONT.ROM の生成元フォントも使う。配置の出所と詳細は
`../PC88Behavior/docs/notes/kanji-rom-layout.md` を参照。
生成元コミットは manifest の `kanjiSourceCommit` に記録する。
