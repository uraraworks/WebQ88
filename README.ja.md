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

## ライセンス

未定。コア（QUASI88-libretro）は BSD 3-Clause です。
