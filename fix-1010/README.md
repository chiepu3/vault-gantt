# 10/10 指摘への対応（バー文字色・タグ名・Daily ToDo）

## バー文字色とタグ名
バー文字は白に戻し、白が読みにくかった既定色（緑・橙・水色）だけ色相を保って少し暗くしました。保存済みの色は変えていません。バー内のタグ名は従来の白いピルに戻しました。

| 元（デザイン統一前） | PR #25 直後（黒文字） | 今回 |
|---|---|---|
| <img src="before-original-gantt-light.png"> | <img src="before-pr25-gantt-light.png"> | <img src="gantt-light.png"> |

ダーク: <img src="gantt-dark.png">

## Daily ToDo
モーダルをやめ、ポップオーバーで [チェック][入力欄][…]、最後に [＋]。「…」に「開く」「削除」（削除は確認なし、Ctrl+Z で戻せる）。Enter かフォーカスを外すと1行ずつ保存。

| 前（モーダル） | 今回 |
|---|---|
| <img src="before-dailytodo-modal-light.png"> | <img src="gantt-dailytodo-popover-light.png"> |

| 「…」メニュー | ＋で追加 | 削除後 |
|---|---|---|
| <img src="gantt-dailytodo-menu-light.png"> | <img src="gantt-dailytodo-add-light.png"> | <img src="gantt-dailytodo-afterdelete-light.png"> |

ダーク: <img src="gantt-dailytodo-popover-dark.png"> <img src="gantt-dailytodo-menu-dark.png">
