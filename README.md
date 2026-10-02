# Vault Gantt

Vault内のMarkdownタスクノートを正本として、タスクを一覧・編集する「Task Workbench」と、日付軸で予定を確認・編集する「Task Gantt」を提供するObsidianプラグインです。

## 主な機能

- **Task Workbench** — タスクとサブタスクを表で表示し、絞り込み・並べ替え・折りたたみができます。状態、優先度、期限、完了、タグなどの編集や、タスクの作成・検索にも対応します。
- **Task Gantt** — Ganttで管理する親タスクについて、予定期間を設定したサブタスクを日付軸に表示します。バーの移動・期間変更、マーカー、タグによる絞り込み、休日表示に対応します。
- **Ganttの補助機能** — 設定により、作業時間（計画・実績）、イベント行、Daily ToDo行、タグ機能を利用できます。
- **ノート内の一覧** — `task-list` コードブロックで、絞り込みや並べ替えができる読み取り専用のタスク表を埋め込めます。

## インストール

1. リポジトリのルートでビルドします。

   ```sh
   npm ci && npm run build
   ```

2. 生成された3ファイルをVaultのプラグインフォルダーへコピーします。

   ```sh
   mkdir -p "<vault>/.obsidian/plugins/vault-gantt/"
   cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/vault-gantt/"
   ```

   `<vault>` は対象Vaultのルートフォルダーに置き換えてください。

3. Obsidianのコミュニティプラグイン設定から「Vault Gantt」を有効にします。

## 基本的な使い方

Obsidianのコマンドパレットで以下の登録名を検索して実行できます。

| 登録名 | コマンドID | 用途 |
| --- | --- | --- |
| `Open task workbench` | `open-task-workbench` | Workbenchを開く |
| `Open task gantt` | `open-task-gantt` | Ganttを開く |
| `Open task finder` | `open-task-finder` | タスクを検索する |
| `Create new managed task note` | `create-new-task-note` | 管理対象のタスクノートを作成する |
| `Add subtask to current managed task note` | `add-subtask-to-current-note` | 開いている管理対象ノートにサブタスクを追加する |
| `Open daily ToDo` | `open-daily-todo` | 今日のDaily ToDoを開く |
| `元に戻す` | `undo-last-action` | 直前の操作を元に戻す |
| `やり直す` | `redo-last-action` | 元に戻した操作をやり直す |
| `Start log recording` | `start-log-recording` | ログ記録を開始する |
| `Stop log recording` | `stop-log-recording` | ログ記録を停止する |

Workbenchの「Ganttで管理」を有効にした親タスクがGanttの対象になります。設定したタスクフォルダー内にある `type: task` のMarkdownノートが、タスク情報の読み書き対象です。

## 設定

設定画面では、タスクフォルダー、作成ファイル名の日付接頭辞、完了タスクの初期表示、期限にもとづく優先度の自動設定を変更できます。Ganttでは休日、Daily ToDoソース、タグ定義、作業時間・イベント・タグ機能、差分描画、外部同期の有効化・URL・間隔を設定できます。

## ネットワーク通信

### 国民の祝日

祝日一覧が空、更新日時がない・解析できない、または更新から30日を超えて古い場合、起動時に内閣府のCSVを取得します。設定画面から手動で更新することもできます。取得先は `https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv` です。HTTP GETでURL以外のリクエスト本文やVault由来の値は指定せず、ノートやタスクの内容は送信しません。

**祝日CSVの自動取得を無効にする設定はありません。**

### Ganttスナップショット同期

初期状態では同期URLは空で、定期同期も無効です。定期同期は有効化したうえでURLを設定した場合に動作し、手動同期もURL未設定時は送信されません。URLを設定すると、読み取り専用GanttスナップショットをJSONでPOSTします。入力URLには `/api/snapshot` が自動で補われます。タスク情報を含むスナップショットは、ユーザーが設定した同期先にのみ送信されます。

## 開発

```sh
npm ci
npm run build
npm run check
npm run test:e2e
```

`npm run test:e2e` はNode.js 22以上とLinuxのXvfbを使用し、実際のObsidianを起動します。利用可能なキャッシュがない場合は、固定バージョンのObsidian AppImageをダウンロードします。手元のAppImageを使う場合は `E2E_OBSIDIAN_APPIMAGE`、キャッシュ先を変更する場合は `E2E_CACHE_DIR` を設定できます。

## 別PCのVaultへの更新

GitHub Actionsのartifactから別Windows PCのVaultへ3ファイルだけを更新・rollbackする手順は [tools/faroe/README.md](tools/faroe/README.md) を参照してください（実機未テスト）。

## ライセンス

[MIT License](LICENSE)
