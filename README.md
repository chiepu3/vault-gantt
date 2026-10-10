# Vault Gantt 修正の見比べ（左＝修正前、右＝修正後）

画像はすべて合成データです。

# A. 採用するか選んでほしい仕様修正（未マージ）

## PR #15：期限を変えると、自分で書き足したプロパティや見出しが消える

- **操作**: Workbenchで期限を2026年10月12日から10月20日に変更した。
- **操作前**: project: 顧客Aと「参考資料」の本文があるノート。

<details><summary>操作前の画面</summary><img src="spec/01/setup.png"></details>

| 修正前: 独自プロパティと「参考資料」の本文が消えた。 | 修正後: 期限が変わり、独自プロパティと「参考資料」の本文は残った。 |
|---|---|
| <img src="spec/01/before.png"> | <img src="spec/01/after.png"> |

## PR #11：見出しを並べ替えると、別のサブタスクの期限・実績が付く

- **操作**: ノートの「設計」と「実装」の見出しを入れ替え、Workbenchを開いた。
- **操作前**: 設計の期限は10月12日、実装の期限は10月20日で、保存済みtitleとsubtaskOrderは変更しない。
- **注記**: 今回の操作では画面上の日本語通知を確認できなかった。コンソールには見出し不一致のエラーが記録された。ノートは一覧から除外されるだけで、対応が自動修復されるわけではない。

<details><summary>操作前の画面</summary><img src="spec/02/setup.png"></details>

| 修正前: 実装に10月12日、設計に10月20日と、別のタスクの期限が表示された。 | 修正後: 対象ノートが一覧から除外され、誤った期限は表示されなかった。 |
|---|---|
| <img src="spec/02/before.png"> | <img src="spec/02/after.png"> |

## PR #12：Daily ToDo 編集中にノートが変わると、関係ない行を上書きする

- **操作**: Daily ToDoを開いたままノート先頭に1行追加し、既存ToDoをチェックして保存した。
- **操作前**: 「今日のToDo」の下に未完了の「見積書を送る」が1件ある。

<details><summary>操作前の画面</summary><img src="spec/03/setup.png"></details>

| 修正前: 見出しがチェック済みToDoに置き換わり、元の未完了ToDoも残った。 | 修正後: ノート変更の通知が出て保存が止まり、見出しと元のToDoが残った。 |
|---|---|
| <img src="spec/03/before.png"> | <img src="spec/03/after.png"> |

## PR #13：Gantt でサブタスクを追加すると、直前のノート編集が消える

- **操作**: Ganttでサブタスクの追加画面を開き、親ノートのメモと期限を更新してから「公開作業」を追加した。
- **操作前**: 親ノートのNotesに顧客との確認結果を書き、期限を2026-10-23に変更した。

| 修正前: サブタスクは追加されたが、直前に書いたメモと期限が消えた。 | 修正後: サブタスクが追加され、直前に書いたメモと期限も残った。 |
|---|---|
| <img src="spec/04/before.png"> | <img src="spec/04/after.png"> |

## PR #16：追加・削除・Daily ToDo 保存で、それより前の Undo 履歴が全部消える

- **操作**: Ganttで親タスクの期限を10月20日に変更し、「公開作業」を追加してから「元に戻す」を2回押した。
- **操作前**: 親タスクの期限は空欄で、サブタスクは「動作確認」だけだった。

| 修正前: Undo履歴が消え、期限の10月20日と追加したサブタスクが残った。 | 修正後: サブタスク追加と期限変更を順に戻せて、期限が空欄に戻った。 |
|---|---|
| <img src="spec/05/before.png"> | <img src="spec/05/after.png"> |

## PR #17：「新規作成可」にした Daily ToDo の取得元に追加できない

- **操作**: Daily ToDoで「経費を精算する」を新規追加して保存した。
- **操作前**: mainを削除し、新規作成可の独自ソースだけを設定した。修正後の追加先もそのソースに設定した。対応するDailyノートは作成済み。
- **注記**: 追加位置はノート末尾で、「今日のToDo」見出しの下には入らなかった。

<details><summary>操作前の画面</summary><img src="spec/06/setup.png"></details>

| 修正前: ノートがないという通知が出て、作成済みの独自ソースに追加できなかった。 | 修正後: 選択した独自ソースのノートに新しいToDoが追加された。 |
|---|---|
| <img src="spec/06/before.png"> | <img src="spec/06/after.png"> |

## PR #18：tags: を YAML リストで書くとタグなし扱いになり、保存で消える

- **操作**: YAMLリストでタグを書いたノートの期限をWorkbenchで10月12日から10月20日に変更した。
- **操作前**: tagsの下にworkとurgentをYAMLリストで記載したノート。

<details><summary>操作前の画面</summary><img src="spec/07/setup.png"></details>

| 修正前: タグが読み込まれず、保存後はtagsが空になった。 | 修正後: workとurgentが読み込まれ、保存後も引用済み配列として残った。 |
|---|---|
| <img src="spec/07/before.png"> | <img src="spec/07/after.png"> |

## PR #19：1日移動: 単独だと休日を飛ばし、一括だと土曜に置かれる

- **操作**: 10月9日の1日タスクを「これ以降を纏めて移動」で右へ1日分動かした。
- **操作前**: 開始日と終了日は2026年10月9日（金）。10月12日は祝日。
- **注記**: 実機が10月12日を祝日として読み込んだため、修正報告の例の10月12日ではなく10月13日になった。対象1件の一括移動を撮影した。

<details><summary>操作前の画面</summary><img src="spec/08/setup.png"></details>

| 修正前: 開始日と終了日が10月10日（土）になった。 | 修正後: 土日と祝日を避け、開始日と終了日が10月13日（火）になった。 |
|---|---|
| <img src="spec/08/before.png"> | <img src="spec/08/after.png"> |

## PR #20：単独移動は計画工数を残し、一括移動は実績まで移す

- **操作**: 計画2時間と実績1時間がある10月5日のタスクを一括で右へ1日分動かし、確認画面で「実行する」を押した。
- **操作前**: 予定日は10月5日。計画2時間と実績1時間を同日に記録。
- **注記**: 一括移動を撮影した。単独移動の画面確認は含まない。confirm-before.pngとconfirm-after.pngに確認文の違いを保存した。

<details><summary>操作前の画面</summary><img src="spec/09/setup.png"></details>

| 修正前の確認ダイアログ | 修正後の確認ダイアログ |
|---|---|
| <img src="spec/09/confirm-before.png"> | <img src="spec/09/confirm-after.png"> |

| 修正前: 予定日と計画時間に加え、実績時間も10月6日へ移った。 | 修正後: 予定日と計画時間は10月6日へ移り、実績時間は10月5日に残った。 |
|---|---|
| <img src="spec/09/before.png"> | <img src="spec/09/after.png"> |

## PR #21：「完了」ステータスと完了フラグが食い違い、非表示にならない

- **操作**: ステータスと完了フラグが食い違うノートをWorkbenchで開き、「完了も表示」をオフにした。
- **操作前**: done・completed:falseの案件とactive・completed:trueの案件、通常の未着手案件を用意した。

<details><summary>操作前の画面</summary><img src="spec/10/setup.png"></details>

| 修正前: 完了の案件が表示に残り、未着手の案件が非表示になった。 | 修正後: 完了の案件が非表示になり、未着手の案件が表示された。 |
|---|---|
| <img src="spec/10/before.png"> | <img src="spec/10/after.png"> |

## PR #22：ドラッグで1日に縮められない

- **操作**: 10月5日から6日のタスクの右端を左へ1日分ドラッグし、終了日を開始日と同じ日にしようとした。
- **操作前**: 開始日は10月5日（月）、終了日は10月6日（火）。
- **注記**: 終了側のリサイズを撮影した。開始側のリサイズは今回の確認に含まない。

<details><summary>操作前の画面</summary><img src="spec/11/setup.png"></details>

| 修正前: 終了日が10月6日のままで、1日に縮まらなかった。 | 修正後: 終了日が10月5日になり、1日タスクに縮まった。 |
|---|---|
| <img src="spec/11/before.png"> | <img src="spec/11/after.png"> |

## PR #23：Daily ToDo の文字を全部消して保存しても元に戻る

- **操作**: 既存ToDo「見積書を送る」の文字を全部消して保存した。
- **操作前**: 未完了の「見積書を送る」が1件ある。

<details><summary>操作前の画面</summary><img src="spec/12/setup.png"></details>

| 修正前: 保存後に開き直すと、消した文字が元に戻った。 | 修正後: 空欄の保存が止まり、文字を入力するか削除ボタンを使うよう通知された。 |
|---|---|
| <img src="spec/12/before.png"> | <img src="spec/12/after.png"> |

# B. main に入れたデザイン改善

## 1回目（PR #14: ワークベンチ等）
### workbench-dark

| 修正前 | 修正後 |
|---|---|
| <img src="design1/before/workbench-dark.png"> | <img src="design1/after/workbench-dark.png"> |

### workbench-light

| 修正前 | 修正後 |
|---|---|
| <img src="design1/before/workbench-light.png"> | <img src="design1/after/workbench-light.png"> |

### narrow

| 修正前 | 修正後 |
|---|---|
| <img src="design1/before/narrow.png"> | <img src="design1/after/narrow.png"> |

## 2回目（PR #24: Gantt）
### gantt-dark

| 修正前 | 修正後 |
|---|---|
| <img src="design2/before/gantt-dark.png"> | <img src="design2/after/gantt-dark.png"> |

### gantt-light

| 修正前 | 修正後 |
|---|---|
| <img src="design2/before/gantt-light.png"> | <img src="design2/after/gantt-light.png"> |

### gantt-click-light

| 修正前 | 修正後 |
|---|---|
| <img src="design2/before/gantt-click-light.png"> | <img src="design2/after/gantt-click-light.png"> |

### settings-light

| 修正前 | 修正後 |
|---|---|
| <img src="design2/before/settings-light.png"> | <img src="design2/after/settings-light.png"> |

# C. パフォーマンス（PR #10、見た目は変わらない）

| 処理（500親・5,000サブタスク） | 前 | 後 |
|---|---:|---:|
| 未変更ファイルの読み込み | 432ms | 0.4ms |
| 1ファイル変更時の再読み込み | 500ms | 1.8ms |
| ワークベンチ期限順の並べ替え | 394ms | 5.7ms |