# Vault Gantt パフォーマンス改善

git コマンド・commit は実行していない。PR #4 の対象である
`src/ui/task-gantt-view.ts` と AI チャット関連のソースは変更していない。

## 測定条件

- Node v22.23.2。同じ作業ディレクトリで変更前・変更後を別プロセスで測定。
- `gen-fixtures.mjs` の正規シリアライザによる500親ノート × 10サブタスク。
- 読み込みは実ファイルの `fs.promises.readFile`。Vault API/Obsidian 自体の時間ではない。
- 初回構築も OS のファイルキャッシュは温まった状態。アプリ起動時間ではない。
- 各処理5回ウォームアップ後、30標本。中央値は中央2値の平均、p95は昇順29番目。
- 代表選択は5,000件の子を単一の入力配列にした負荷試験。1標本20回の平均時間。
- 期限ソートは5,500行。期限日は過去・当日・未来・空文字・不正日付・undefined の6種類。
  `today` は2026-10-10に固定。順序をキャッシュなしの `compareBy` と照合している。
- 表示処理の値は DOM を含まない。画面全体の応答時間の改善率としては扱えない。

## 採用した独立改善

単位は ms、各セルは **中央値 / p95**。

| 改善・対象 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 1: `loadTasks` 未変更500ファイル | 431.958 / 509.291 | 0.353 / 0.478 |
| 1: `loadTasks` 1ファイルの revision 変更 | 500.095 / 517.727 | 1.842 / 2.266 |
| 2: Workbench 期限ソート5,500行 | 393.593 / 407.586 | 5.713 / 8.034 |
| 3: 折りたたみ代表選択5,000件 | 5.329 / 5.817 | 0.424 / 0.465 |

### 1: 未変更ファイルの読み込み省略

原因: revision キャッシュ判定より先に全ファイルを直列で読み込んでいた。
修正: stat があるファイルは読み込み前に既存キャッシュを判定する。
未変更時の read 回数は500→0、1ファイル変更時は500→1。
taskRow が null の非タスクノートも対象。stat がないアダプタでは従来通り読み込む。
変更ファイルの読み込み失敗は結果から除外し、次回に再試行する。
同一 mtime/size の変更を検出できない既存の制約は残る。

変更ファイル:
- `src/app/task-operations.ts` (`loadTasks`)
- `tests/app/task-operations.test.ts` (読み込み回数・変更反映・失敗後の再試行)

### 2: Workbench ソート内の期限分類の共有

原因: ソート比較のたびに2行の期限日を Moment で厳密解析していた。
修正: そのソートで使う異なる期限日ごとの bucket を1回求め、`compareBy` に渡す。
キャッシュは1回の呼び出し内で完結し、編集や翌日の再描画へ持ち越さない。
既存の bucket、localeCompare、同順位の安定順序を使う。期限以外のソート経路は従来通り。
Gantt の日付分類・範囲描画キャッシュとは別の処理。

変更ファイル:
- `src/app/workbench-display.ts` (`getDisplayRows` のソート部分・import)
- `src/core/utils.ts` (`compareBy` の任意 bucket 引数)
- `tests/app/workbench-display.test.ts` (`getDisplayRows` の厳密日付・昇降順・編集・翌日検証)

### 3: 折りたたみ代表サブタスクの線形選択

原因: 最小の1件が必要なのに、未完了の全候補をコピーしてソートしていた。
修正: 同じ比較規則で1回走査し、より小さい候補にだけ置き換える。
同順位は先に現れた候補を保持し、入力配列を変更しない。

変更ファイル:
- `src/app/workbench-display.ts` (`pickWorkbenchPreviewSubtask` のみ)
- `tests/app/workbench-display.test.ts` (同順位・入力順・編集後の代表再選択)

改善2と3は同じファイルに独立した変更箇所がある。後でコミットする際は上記関数・テスト単位で分割できる。

## 共通の計測・ビルド補助

- `tools/perf/hotspots.mjs`: 再実行可能な計測スクリプト。
- `tools/perf/RESULTS.md`: この報告。
- `esbuild.config.mjs`: `VG_BUILD_COMMIT` 指定時はその値を採用し、git を呼ばない。
  従来は指定値を無視して `git rev-parse` を実行するため、ユーザー指定のビルドと git 禁止を両立できなかった。
  これはパフォーマンス改善ではなく検証に必要な補助修正。
- `main.js`: 指定コマンドで再生成したビルド成果物（gitignore 対象）。

## 採用しなかった候補

- 初回読み込み・インデックス構築: 696.418 / 744.052 → 698.866 / 744.343 ms。今回の改善は初回には効かず、並列 I/O は採用していない。
- フィルタ処理: 4.211 / 5.475 → 4.948 / 6.482 ms。高速化の根拠がなく検索キャッシュ等は採用していない。
- Gantt レーン配置: 15.579 / 17.036 → 16.874 / 17.818 ms。今回未変更。配置アルゴリズムの変更は採用していない。
- DOM 描画・スクロール・ドラッグ: 実 Obsidian 計測が起動後の sandbox 検査で失敗し、前後比較できないため未変更。
- Gantt 日付分類・浮動月ラベル: draft PR #4 と重複するため対象外。

変更していないフィルタ・レーン配置の値には測定揺らぎがある。

## 実行コマンド・検証結果

```sh
VG_BUILD_COMMIT=dev npm run build
node tools/e2e/perf-benchmark.mjs --parents 50 --subtasks-per-parent 10
node tools/perf/hotspots.mjs before
node tools/perf/hotspots.mjs after
npm run check
VG_BUILD_COMMIT=dev npm run build
```

- 実 Obsidian/Xvfb: 失敗。`chrome-sandbox helper stat failed (ENOENT)`。
  ログは `tools/e2e/cache/logs/obsidian-1791570952239.log`。
  sandbox 検査・起動フラグは変更していない。
- `npm run check`: 最初は追加テストの `replaceAll` が対象ライブラリにないため型検査失敗。
  `split().join()` に修正後、型検査・lint・41テストファイル/1,868テストすべて成功。
- 最終 production build: 成功、main.js 1020.6 kb。

30標本の生データと read 回数:
- `tools/e2e/artifacts/hotspots-before-1791571089665.json`
- `tools/e2e/artifacts/hotspots-after-1791571147077.json`

生データと e2e のキャッシュ・ログは gitignore 対象。測定時に生成した合成 Vault は削除済み。
