# バージョン管理ルール

Vault Gantt は [セマンティックバージョニング](https://semver.org/lang/ja/)（`MAJOR.MINOR.PATCH`）に従います。

| 種類 | 上げる条件 |
| --- | --- |
| MAJOR | 保存形式やノート書式の互換性が壊れる変更 |
| MINOR | 後方互換のある機能追加 |
| PATCH | バグ修正・見た目の調整など機能追加を伴わない変更 |

0.x の間は、互換性を壊す変更も MINOR で上げます。

## 自動更新（通常はこれだけ）

main に PR をマージすると、GitHub Actions（`.github/workflows/release.yml`）が次を自動で行います。人がバージョンを触る必要はありません。

1. 前回のリリース以降にマージされた PR のタイトルから、上げ方を決めます。
2. `package.json` / `package-lock.json` / `manifest.json` / `versions.json` を同時に更新し、`CHANGELOG.md` に追記して `chore(release): vX.Y.Z` コミットで main に push します。
3. タグ `vX.Y.Z` を打ち、同じ内容のリリースノートで GitHub Release を作ります。

PR タイトルは [Conventional Commits](https://www.conventionalcommits.org/ja/) の接頭辞で書きます。

| タイトルの接頭辞 | 上がるもの | リリースノートの見出し |
| --- | --- | --- |
| `feat:` / `feat(範囲):` | MINOR | 新機能 |
| `fix:` `perf:` `refactor:` `revert:` | PATCH | 修正・高速化・内部改善・取り消し |
| 接頭辞なし | PATCH | その他の変更 |
| `docs:` `ci:` `chore:` `test:` `build:` `style:` だけ | 上げない（リリースなし） | - |
| `feat!:` のように `!` 付き | MINOR（0.x の間） | 各見出し |

- 1回の push に複数の PR が含まれるときは、一番大きい上げ方を採用し、リリースノートにはすべて載せます。
- MAJOR は自動では上がりません。1.0.0 にするときなどは、手元で `npm version major` を実行して push します（`version-bump.mjs` が `manifest.json` と `versions.json` を同期し、`minAppVersion` を変えるときは先に `manifest.json` を直します）。
- リリースコミットは GITHUB_TOKEN で push するため、CI は再実行されず、ループしません。コミットメッセージが `chore(release):` で始まる場合、ワークフローは何もしません。
- リリースコミットは main に入るので、`install.cmd`（`git pull` → `npm run build`）はそのまま動きます。`package-lock.json` の依存関係は変わらないため、`npm ci` も走りません。
- 確認だけしたいときは `node tools/release/release.mjs --dry-run` で、次のバージョンとリリースノートを表示できます。

## 画面表示

Gantt 画面上部のツールバー右端と設定画面に `vX.Y.Z (コミット短縮ハッシュ)` を表示します。バージョンは `manifest.json`、コミットは `git rev-parse --short HEAD` から、ビルド時に esbuild の `define` で埋め込まれます。Git が使えない環境ではコミットは表示されません（`VG_BUILD_COMMIT` 環境変数で上書き可能）。
