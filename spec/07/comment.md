修正前後のスクリーンショット（合成データ）


- **操作**: YAMLリストでタグを書いたノートの期限をWorkbenchで10月12日から10月20日に変更した。
- **操作前**: tagsの下にworkとurgentをYAMLリストで記載したノート。

<details><summary>操作前の画面</summary><img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/07/setup.png"></details>

| 修正前: タグが読み込まれず、保存後はtagsが空になった。 | 修正後: workとurgentが読み込まれ、保存後も引用済み配列として残った。 |
|---|---|
| <img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/07/before.png"> | <img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/07/after.png"> |
