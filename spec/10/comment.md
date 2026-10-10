修正前後のスクリーンショット（合成データ）


- **操作**: ステータスと完了フラグが食い違うノートをWorkbenchで開き、「完了も表示」をオフにした。
- **操作前**: done・completed:falseの案件とactive・completed:trueの案件、通常の未着手案件を用意した。

<details><summary>操作前の画面</summary><img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/10/setup.png"></details>

| 修正前: 完了の案件が表示に残り、未着手の案件が非表示になった。 | 修正後: 完了の案件が非表示になり、未着手の案件が表示された。 |
|---|---|
| <img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/10/before.png"> | <img src="https://raw.githubusercontent.com/chiepu3/vault-gantt/pr-screenshots/spec/10/after.png"> |
