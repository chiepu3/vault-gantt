# QA プロセス（Definition of Done）

すべての変更は、以下を通過するまで「完了」と報告しない。

## 1. 自動チェック（必須・毎変更）

```bash
npm run verify   # typecheck (tsc + svelte-check) → lint → vitest
npm run build    # ビルド + vault へ自動デプロイ
```

- vitest は型チェックをしない。テストだけ通っても型が壊れていることがある → tsc 必須。
- ビルド成功＝デプロイ完了（esbuild.plugin.mjs が vault へコピーする）。

## 2. UI 変更時の手動スモークテスト（必須）

ビルド後、Obsidian でプラグインを再読み込みし、変更に関係するシナリオを実施する。
エージェントは完了報告時に「どのシナリオの確認が必要か」をユーザーに明示すること。

### Workbench
- [ ] タスク追加・サブタスク追加（+ ボタン）
- [ ] 各セルのダブルクリック編集（親: 名前/状態/期限、サブ: 名前/状態/予定開始/予定終了）
- [ ] 編集確定後、行が消えたり増えたりしない（ちらつき無し）
- [ ] サブタスク行の字下げはタイトル列のみ
- [ ] 完了チェック・Ganttチェックのトグル
- [ ] 横スクロール・ソート・フィルタ

### Gantt
- [ ] バーのドラッグ移動・両端リサイズ
- [ ] 操作後、親タスク行が消えない
- [ ] 行の右クリック→サブタスク追加
- [ ] 横スクロールで親タスク名列が固定表示
- [ ] ズームイン/アウト・「今日」ボタン

## 3. サブエージェント成果物の検収

- implementer の成果物は必ず main が変更ファイルを読み、reviewer (Sonnet) にかける。
- 事実主張には根拠（コマンド出力 or file:line）必須（Evidence Protocol）。
- 🔴 Critical 未修正のまま「完了」と報告しない。

## 4. 既知の回帰ポイント（過去に踏んだ地雷）

| 地雷 | 内容 |
|------|------|
| 2段階書き込み | writeTaskFile はfrontmatter→bodyの順で書く。ファイルが frontmatter 無しになる瞬間を作ると metadataCache がタスクを見失い UI から行が消える |
| vitest型無視 | テスト変更後も tsc --noEmit 必須 |
| sticky列 | .vg-gantt-header-left / .vg-gantt-row-left の position: sticky を壊さない |
| CSS詰め忘れ | セレクタの適用範囲（td 全体 vs 特定列）を必ず確認 |
| listTasks投影 | listTasks() の note は auto-priority 投影済み。生のディスク値と比較する処理には使えない |
