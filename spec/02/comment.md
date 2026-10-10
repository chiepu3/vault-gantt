修正前後のスクリーンショット（合成データ）


- **操作**: ノートの「設計」と「実装」の見出しを入れ替え、Workbenchを開いた。
- **操作前**: 設計の期限は10月12日、実装の期限は10月20日で、保存済みtitleとsubtaskOrderは変更しない。
- **注記**: 今回の操作では画面上の日本語通知を確認できなかった。コンソールには見出し不一致のエラーが記録された。ノートは一覧から除外されるだけで、対応が自動修復されるわけではない。

<details><summary>操作前の画面</summary><img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/02/setup.png"></details>

| 修正前: 実装に10月12日、設計に10月20日と、別のタスクの期限が表示された。 | 修正後: 対象ノートが一覧から除外され、誤った期限は表示されなかった。 |
|---|---|
| <img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/02/before.png"> | <img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/02/after.png"> |
