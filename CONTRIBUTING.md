# バージョン管理ルール

Vault Gantt は [セマンティックバージョニング](https://semver.org/lang/ja/)（`MAJOR.MINOR.PATCH`）に従います。

| 種類 | 上げる条件 |
| --- | --- |
| MAJOR | 保存形式やノート書式の互換性が壊れる変更 |
| MINOR | 後方互換のある機能追加 |
| PATCH | バグ修正・見た目の調整など機能追加を伴わない変更 |

0.x の間は、互換性を壊す変更も MINOR で上げます。

## 更新手順

バージョンは `package.json` / `manifest.json` / `versions.json` の3ファイルで必ず一致させます。手で編集せず、次のコマンドで同時に更新します。

```
npm version patch   # または minor / major
```

`version-bump.mjs` が `manifest.json` と `versions.json`（`バージョン: minAppVersion`）を同期し、コミットとタグ `vX.Y.Z` を作ります。`minAppVersion` を変えるときは先に `manifest.json` を直してから実行してください。

- バージョンを上げるのは、リリースしたい変更が main に入った後、専用のコミットで行います（機能PRの中では上げません）。
- `npm run check` が通ることを確認してからタグを push します。

## 画面表示

Gantt 画面上部のツールバー右端と設定画面に `vX.Y.Z (コミット短縮ハッシュ)` を表示します。バージョンは `manifest.json`、コミットは `git rev-parse --short HEAD` から、ビルド時に esbuild の `define` で埋め込まれます。Git が使えない環境ではコミットは表示されません（`VG_BUILD_COMMIT` 環境変数で上書き可能）。
