# 変更履歴

バージョンは自動で更新されます（[CONTRIBUTING.md](CONTRIBUTING.md) 参照）。

## v0.11.0 (2026-10-27)

### 新機能

- 親タスクに名前付きマイルストーンを複数設定できるようにする ([#75](https://github.com/chiepu3/vault-gantt/pull/75))

## v0.10.1 (2026-10-20)

### 修正

- Daily ToDoの長い文字を折り返して全文表示 ([#72](https://github.com/chiepu3/vault-gantt/pull/72))

## v0.10.0 (2026-10-19)

### 新機能

- AIチャットを更新後も右サイドバーに残し、起動時自動オープンとガントのAIボタンを追加 ([#71](https://github.com/chiepu3/vault-gantt/pull/71))

## v0.9.1 (2026-10-19)

### 修正

- AIチャットの会話履歴を更新・再起動後も残す／タイトルを最初のメッセージにする ([#70](https://github.com/chiepu3/vault-gantt/pull/70))

## v0.9.0 (2026-10-19)

### 新機能

- 毎日の作業時間（実績/想定）を7hに近づくほど赤くなる色で表示 ([#68](https://github.com/chiepu3/vault-gantt/pull/68))

### 修正

- OpenRouter経由のOpenAI系モデルが即座に打ち切られる問題 ([#64](https://github.com/chiepu3/vault-gantt/pull/64))
- AIチャットの思考表示のリセットと、同じ日の複数イベント案の表示・連続適用 ([#67](https://github.com/chiepu3/vault-gantt/pull/67))
- 定例作業を実績にも入れ、定例作業設定の入力を軽くする ([#66](https://github.com/chiepu3/vault-gantt/pull/66))
- 「ガントを開く」向けに足した語を戻す(不要になった) ([#65](https://github.com/chiepu3/vault-gantt/pull/65))

## v0.8.1 (2026-10-18)

### 修正

- AIチャットの実機確認で見つかった不具合（日報の親候補・状態表示など） ([#63](https://github.com/chiepu3/vault-gantt/pull/63))

## v0.8.0 (2026-10-18)

### 新機能

- ノート形式 v2（サブタスク1件1ノート）と全体の性能改善 ([#59](https://github.com/chiepu3/vault-gantt/pull/59))

## v0.7.3 (2026-10-18)

### 修正

- 横スクロール後に見ていたタスクが大きくずれないようにする ([#61](https://github.com/chiepu3/vault-gantt/pull/61))

## v0.7.2 (2026-10-18)

### 修正

- Daily ToDoをホバーで編集ポップオーバー表示にする ([#60](https://github.com/chiepu3/vault-gantt/pull/60))

## v0.7.1 (2026-10-17)

### 高速化

- 保存後のガント二重再描画をやめる ([#58](https://github.com/chiepu3/vault-gantt/pull/58))

## v0.7.0 (2026-10-17)

### 新機能

- 設定画面のタブ化、AI接続の複数管理、モデルの追加と検索 ([#54](https://github.com/chiepu3/vault-gantt/pull/54))

## v0.6.0 (2026-10-17)

### 新機能

- AIエージェントのタスク検索あいまい一致と日報の一括実績登録 ([#56](https://github.com/chiepu3/vault-gantt/pull/56))
- AIチャット画面の改善（思考とツールの折りたたみ、Gantt確認の移動、やり直し ほか） ([#57](https://github.com/chiepu3/vault-gantt/pull/57))

## v0.5.1 (2026-10-17)

### 高速化

- ガントの描画ノード削減とAI適用時の再読込を省略 ([#55](https://github.com/chiepu3/vault-gantt/pull/55))

## v0.5.0 (2026-10-17)

### 新機能

- プラグイン内蔵のアップデーター（ブランチ選択・バックアップ付き） ([#53](https://github.com/chiepu3/vault-gantt/pull/53))

## v0.4.0 (2026-10-17)

### 新機能

- Daily ToDoのホバー表示とサブタスク名のテキストカーソル ([#52](https://github.com/chiepu3/vault-gantt/pull/52))

## v0.3.2 (2026-10-17)

### その他の変更

- ツールバー項目の右寄せを元に戻す ([#46](https://github.com/chiepu3/vault-gantt/pull/46))

## v0.3.1 (2026-10-17)

### その他の変更

- バーのポップオーバーと作業時間グラフを、片方にカーソルがある間は両方表示する ([#50](https://github.com/chiepu3/vault-gantt/pull/50))
