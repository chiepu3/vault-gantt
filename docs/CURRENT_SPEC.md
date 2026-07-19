# Obsidian Task Workbench 現況仕様書（リバースエンジニアリング版）

- 対象: `/mnt/d/content`（会社PCでM365 Copilotに作らせたObsidianプラグインのエクスポート）
- 作成日: 2026-07-19
- 作成方法: ソースコード全読解（メインエージェント直接確認 + 5系統の並列調査）。引用は `file:line`。
- 目的: OSS化・フルリビルドの前提となる「現状の完全な仕様」の確定

---

## 1. 概要

**Obsidian Task Workbench** は、Obsidian Vault内のMarkdownノートをデータストアとするタスク管理・ガントチャートプラグイン。実運用ではもっぱら**ガントチャートとして使用**されていた。

| 項目 | 値 |
|---|---|
| プラグインID | `obsidian-task-workbench` (`manifest.json`) |
| バージョン | manifest: **0.27.0** / package.json: **0.23.0**（**不一致・要注意**） |
| minAppVersion | 1.5.0 |
| author | "M365 Copilot" |
| モバイル対応 | isDesktopOnly: false |
| ビルド | esbuild（プラグイン: CJS / サーバービューワー: IIFE）、TypeScript `strict: false` |
| 規模 | TS本体 約9,000行 + styles.css 1,445行 |

### 構成要素（4つのサブシステム）

1. **Obsidianプラグイン本体**（`src/`）— Workbenchテーブルビュー + Ganttビュー + 埋め込みブロック + 設定
2. **Core Task API**（`src/application/task-operations.ts`）— AIエージェント前段の安全な更新API（patch検証・revision・batch更新）
3. **読み取り専用Ganttサーバー**（`server/`）— スナップショットを受け取りWebブラウザで閲覧させるNodeサーバー（2世代ある）
4. **サーバービューワー**（`server/viewer/`）— Obsidian APIをshimしてプラグインのGanttViewをブラウザで再利用する仕組み

---

## 2. モジュール構成

```
src/
  main.ts                       # re-exportのみ (1行)
  task-workbench-plugin.ts      # Pluginエントリ。lifecycle/コマンド/サービス合成 (290行)
  core/
    constants.ts                # ビュータイプID・DEFAULT_STATUSES・DEFAULT_SETTINGS
    types.ts                    # TaskRow等の共有型（型があるのはここくらい）
    utils.ts                    # 日付・文字列・ソート等の純粋関数
  task/
    note-format.ts              # タスクノートMarkdownの生成・解析（型注釈なし）
    priority.ts                 # 期限ベース自動優先度（型注釈なし）
  application/
    task-operations.ts          # patch検証・revision・変更検知（Core API）
  plugin/                       # サービス層（Pluginのmixin的に合成される）
    task-file-service.ts        # タスクファイルCRUD・解析キャッシュ・batch更新 (431行)
    daily-todo-service.ts       # デイリーノートToDo連携 (311行)
    gantt-sync-service.ts       # 外部サーバーへのスナップショット同期 (185行)
    gantt-task-service.ts       # Ganttイベント管理・親のGantt有効化
    embed-renderer.ts           # コードブロック埋め込みテーブル
    display-rows-service.ts     # フィルタ・ソート・グループ化（純粋ロジック）
    holiday-service.ts          # 祝日（内閣府CSV取得・手動・特別）
    navigation-service.ts       # ビュー起動・タスクへのジャンプ
    auto-priority-controller.ts # 日次の自動優先度一括更新
  ui/
    task-workbench-view.ts      # テーブルビュー (620行)
    modals.ts                   # TextInput/TaskFinder/GanttParentPicker/DailyTodoモーダル
    settings-tab.ts             # 設定タブ (319行)
    gantt-view.ts               # GanttViewクラス本体・状態保持 (584行)
    gantt/                      # Gantt機能別モジュール (約3,600行)
      gantt-chart-renderer.ts   # 描画パイプライン
      gantt-layout.ts           # レーンパッキング・マーカー配置
      gantt-viewport.ts         # スクロール・範囲遅延拡張
      gantt-calendar.ts         # 営業日計算・祝日
      gantt-date-utils.ts       # moment薄ラッパー
      gantt-constants.ts        # 描画定数
      gantt-fixed-rows.ts       # 固定行（作業時間/イベント/Daily ToDo）
      gantt-toolbar.ts          # ツールバー
      gantt-bar-marker.ts       # バー・マーカー・外部ラベル描画
      gantt-drag-controller.ts  # ドラッグ（移動/リサイズ/マーカー/一括）
      gantt-inline-edit.ts      # ダブルクリックインライン編集（IME対応）
      gantt-popover.ts          # リッチポップオーバー（Current Status自動保存付き）
      gantt-context-menus.ts    # 右クリックメニュー
      gantt-empty-cell-menu.ts  # 空セル右クリック（新規作成/未配置の配置/親期限）
      gantt-bulk-move.ts        # 「これ以降を纏めて移動」モード
      gantt-parent-actions.ts   # 親タスク追加・名前編集・メニュー
      gantt-parent-due.ts       # 親期限マーカー（★）のドラッグ
      gantt-parent-order.ts     # 親行の並べ替え（HTML5 DnD）
      gantt-tags.ts             # タグ定義・付与・絞り込み
      gantt-workload.ts         # 作業時間（計画/実績）入力・集計 (561行)
```

サービス層は独立クラスではなく、**Pluginクラスの`this`に依存する関数群**（`this.app`、`this.settings`、`this.loadTasks()` を直接参照）。ビューも `plugin: any` を受け取り密結合（`gantt-view.ts:27`）。

---

## 3. データモデル

### 3.1 タスクノート形式（最重要仕様）

**親タスク1件 = Markdownファイル1枚**。サブタスクは**同一ファイル内**に格納される。

- 配置: `{taskFolder}/YYYY/MM/` 配下（`task-file-service.ts`）。ファイル名は設定により `YYYY-MM-DD タスク名.md` または `タスク名.md`、衝突時は ` {n}` 付与
- タスク認定条件: frontmatterに `type: task`

#### frontmatter スキーマ（`note-format.ts:55-77, 196-229`）

```yaml
---
type: task
cssclass: twb-task-note
statusLabel: active | in_progress | waiting | hold | done
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
dueDate: YYYY-MM-DD          # 空可
priority: 0-5                 # 0=未設定
priorityMode: auto | manual
tags: [tag1, tag2]
completed: true|false
displayName: "表示名"
ganttEnabled: true|false      # Ganttに表示するか
ganttOrder: number            # Gantt行順（新規はDate.now()、並べ替えで(index+1)*1000）
subtaskOrder: [key1, key2]
# ↓ サブタスクは名前空間付きフラットキーで埋め込み
subtask__<key>__title: "..."
subtask__<key>__statusLabel: ...
subtask__<key>__createdAt / __updatedAt / __dueDate: YYYY-MM-DD
subtask__<key>__plannedStartDate / __plannedEndDate: YYYY-MM-DD   # Ganttバーの期間（終端含む）
subtask__<key>__workloadPlan: "2026-07-01=1,2026-07-02=2.5"        # 日付=時間のCSV、0.5h刻み
subtask__<key>__workloadActual: "..."
subtask__<key>__priority / __priorityMode / __tags / __completed
subtask__<key>__ganttMarkerOrder: [mkey1, mkey2]
subtask__<key>__ganttMarker__<mkey>__title / __date / __tags       # マイルストーンマーカー
---
```

- サブタスクkey: タイトルのslug化（英数40字、衝突時 `-N`、空なら `subtask-{timestamp}`）（`utils.ts:46-64`）
- **YAMLパーサーは自前実装**（行ごとの `key: value` 分割のみ、ネスト・複数行非対応）（`note-format.ts:10-24`）。ネストできないためフラットキー方式になっている

#### 本文構造（`note-format.ts:180-195`）

```markdown
# 表示名
> [!info] タスクダッシュボード      ← Meta Bindの INPUT[...]/VIEW[...] 群
`BUTTON[twb-open-board]` ...        ← meta-bind-buttonブロック×3
## Current Status
（自由記述）
## Notes
（自由記述）
## Subtasks
### サブタスク名
> [!info]- サブタスクダッシュボード ← Meta Bind INPUT（subtask__key__フィールドにバインド）
#### Current Status
#### Notes
```

**Meta Bindプラグインへの強依存**: ノート上のダッシュボードUI（ステータス選択・期限入力・トグル等）はすべてMeta Bind記法。ボタンは `obsidian-task-workbench:open-task-workbench` 等のコマンドを起動。

### 3.2 ステータス・優先度

- ステータス5値: `active(未着手) / in_progress(進行中) / waiting(待ち) / hold(保留) / done(完了)`（`constants.ts:5-11`）
- **completed↔statusLabelの同期規則**（`task-operations.ts:107-116`）: `done`→`completed:true`、`completed:true`→`done`、`completed:false`→`active`（statusLabel未指定時）
- 自動優先度（`priority.ts:3-12`）: 期限超過/当日=5、3日以内=4、7日以内=3、14日以内=2、それ以外=1、期限なし=0。`priorityMode: manual` なら手動値を優先。日次バッチ（`auto-priority-controller.ts`）が `lastAutoPriorityUpdate` で1日1回全ファイル更新

### 3.3 Core Task API（AIエージェント前段・Phase1-2実装済み）

`docs/AI_AGENT_CORE_API_PLAN.md` のPhase 1-2が実装済み（Phase 3以降=Agent Tool Adapter/dry-run/MCP連携は未着手）。

- **フィールドホワイトリスト**（`task-operations.ts:26-35`): 親に `plannedStartDate` 等を書くとreject。日付形式・優先度範囲・作業時間(0-24h, 0.5h刻み、0hは削除)・マーカー(key一意/title・date必須)を検証
- **楽観ロック**: revision = `"{mtime}:{size}"`。`expectedRevision` 不一致で `REVISION_CONFLICT` エラー
- **解析キャッシュ**: `loadTasks()` はファイルのmtime:sizeが不変なら解析結果を再利用（`task-file-service.ts`）
- **batch更新**: `updateTaskItemsBatch()` が親ファイル単位でグルーピングし、1parse→全patch→1書き込み。単発 `updateTaskItem()` はそのラッパー
- テスト: `tests/phase2.test.ts`（Node実行、49行）が上記の検証規則をカバー

---

## 4. 機能仕様

### 4.1 プラグインlifecycle（`task-workbench-plugin.ts:29-91`）

- onload: 設定ロード→自動優先度更新→祝日更新(fire-and-forget)→2ビュー登録→埋め込みプロセッサ登録→コマンド5種→リボンアイコン2種→設定タブ→Gantt同期タイマー開始
- コマンド: `open-task-workbench` / `open-task-gantt` / `open-task-finder` / `create-new-task-note` / `add-subtask-to-current-note`
- onunload: 同期タイマー解除・リーフdetach

### 4.2 Workbenchビュー（テーブル）（`task-workbench-view.ts`）

- 12列: タスク名 / 優先度 / 状態 / 現在のステータス / 作成日 / 更新日 / 期限 / タグ / 完了 / Ganttで管理 / 開く / +（サブタスク追加）
- テキスト検索（displayName/title/status/currentStatus/notes/tags/path横断の部分一致）、ステータス絞り込み、6キーのソート、完了表示トグル、「サブタスク含めた期限順」フラット表示
- 親の折りたたみ（折りたたみ時は未完了→期限最早→作成最早→名前順で代表サブタスク1件をプレビュー）
- セルダブルクリックでインライン編集（名前/状態/★優先度/期限/タグ/Current Status）。Current Statusは複数行textarea（行数は設定 `currentStatusRows`）

### 4.3 Ganttビュー

#### 描画（`gantt-chart-renderer.ts`, `gantt-layout.ts`）

- 表示範囲: 初期は今日の14日前から90日分 + 前後21日オーバースキャン。端までスクロールすると60日ずつ遅延拡張（**仮想スクロールなし・毎回全DOM再構築**）
- 構造: 左固定列（親タスク名320px）+ タイムライン。ヘッダー3段（月/日/曜日）+ フローティング月表示。土日祝は背景色、今日は赤線
- ズーム: 14〜72px/日（既定28、設定 `ganttZoom` に永続化）、6px刻み
- サブタスクバー: `plannedStartDate`〜`plannedEndDate`。期間重複はレーンパッキングで多段化。バーが狭い場合はタイトルを外部ラベル化しSVG折れ線コネクタで接続
- マーカー: バー配下に ▲+ラベル+日付。重なりは行送り。幅推定 `max(42, len*9+20)`
- 行高: レーン数・マーカー行数・外部ラベル行数から動的計算
- 曜日セルクリックで手動祝日トグル（国民祝日・特別休暇は保護され解除不可）

#### 固定行（`gantt-fixed-rows.ts`）— 各機能トグルでON/OFF

1. **作業時間サマリー行**: 全タスクの日毎 実績/想定 時間集計。容量比で色分け。ホバーでタスク別内訳ポップアップ
2. **その他（イベント）行**: settings保存のイベントチップ（◆）。右クリック追加・ドラッグ移動・ダブルクリック編集・右クリック削除
3. **Daily ToDo行**: デイリーノートのToDo達成数チップ（N/M）。ホバーで編集ポップオーバー（チェック・テキスト編集・追加・削除・ノートを開く）、ダブルクリックで当日ノートに項目追加

#### 操作系

- **バードラッグ**: 本体=移動（**営業日基準で期間保存**：土日祝スキップ、マーカーも営業日オフセット追従）、左右端=リサイズ、日単位スナップ、rAFスロットリング+ツールチップ
- **マーカードラッグ**: バー期間内にクランプ
- **一括移動**: 右クリック「これ以降のタスクを纏めて移動」→アンカー以降のバー・マーカーが一体で追従。実績時間が記録されたタスクを動かすときは確認ダイアログ、workloadの日付も差分シフト
- **インライン編集**: ダブルクリック、Enter確定/Escape取消、IME composition対応（`GANTT_DESIGN.md` の禁止事項: `window.prompt`・HTML `title` ツールチップ不使用）
- **リッチポップオーバー**（ホバー）: サブタスク=予定/期限/ステータス選択/タグ/Current Status(450ms debounce自動保存・Ctrl+Enterフラッシュ・失敗時ロールバック)/ノートを開く/完了トグル。親=期限入力/ステータス/Current Status。配置は下→上→横のフォールバック
- **右クリックメニュー（バー）**: 完了トグル/マーカー追加(クリック位置日付・初期名「新しいマーカー」)/タグ/一括移動モード/Current Status編集(こちらはモーダル)/ノートを開く/ガントから外す(planned日付クリア・内部情報保持)/タスク完全削除(confirm付き)
- **空セル右クリック**: 新規サブタスクをその日に作成/未配置サブタスクの配置(最大20件表示)/親期限の設定・削除
- **親行**: ドラッグで並べ替え（HTML5 DnD、全行を(index+1)*1000で再採番しbatch更新）、「＋親タスク追加」（新規作成 or 既存タスクから選択）、ダブルクリックで名前編集、右クリックメニュー
- **親期限マーカー（★期限）**: タイムライン上でドラッグ移動、右クリックで削除
- **タグ**: 設定でキー/名前/色/順序を定義。バー・親・マーカーに付与（右クリック→タグサブメニュー、新規作成も可）。色は8色パレットの巡回自動割当。ツールバー横の「タグ絞込」でフィルタ（マーカーのみ一致時はバーを減光表示）。フィルタ状態は**非永続**
- **作業時間入力**: ポップアップ内グラフを縦ドラッグして日毎の時間を0.5h刻みで入力（土日祝はスキップ）。計画/実績モード切替。pointerupで保存

#### ツールバー（`gantt-toolbar.ts`）

Workbench / 今日へ / −・＋ズーム（`{n}px/日` 表示） / 更新 / 同期 / バージョン表示

### 4.4 埋め込みブロック（` ```task-workbench-embed `）

設定行（`showCompleted/status/sort/dir/flatDueSort/maxRows`）をパースし、読み取り専用のタスクテーブル（フィルタUI付き）をノート内に描画（`embed-renderer.ts`）。

### 4.5 デイリーノート連携（`daily-todo-service.ts`）

- ソース2種を**ハードコード**: `デイリー/YYYY/MM/YYMMDD_デイリー.md`（Ganttから追加可）、`デイリーミーティング/YYYY/MM/MMDD_デイリーミーティング.md`（閲覧のみ）
- `- [ ]` チェックボックスを見出し付きで解析、`## ToDoリスト` 見出し直後に挿入。ノート自体は作成しない（Templater等で先に作る前提、`daily-todo-service.ts:192`）
- 設定 `dailyNoteFolders` は存在するが実質表示専用（ソース定義側が優先）

### 4.6 祝日（`holiday-service.ts`）

- 国民の祝日: 内閣府CSV `https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv` を30日毎に自動更新（BOM対応、`requestUrl` 使用）
- 3層構造: national（自動）/ manual（曜日セルクリック）/ special（設定テキストエリア）。実効値は3者の和集合。旧 `ganttHolidays` からのマイグレーションあり

### 4.7 外部同期・Webビューワー（`gantt-sync-service.ts`, `server/`）

- `{ganttSyncUrl}/api/snapshot` へJSONをPOST。schemaVersion 2。FNV-1aハッシュ（generatedAt除外）で差分なしならスキップ。タイマーは分単位（既定5分）
- スナップショット内容: 祝日・タグ定義・イベント・設定・親/サブタスク全データ（workload・マーカー含む）。dailyTodoSummariesは**常に空配列**（`gantt-sync-service.ts:145`）
- サーバーv1（`task-gantt-server.mjs`）: ポート8787、HTML内蔵の簡易ビューワー
- サーバーv2（`task-gantt-server-v2.mjs`）: `server/viewer/public/` のビルド成果物を配信。ビューワーはObsidian APIのDOMシム+ミニmoment実装+no-opモックで**プラグインのGanttViewクラスをそのままブラウザで動かす**（読み取り専用、書き込み系は全て `false` を返すモックplugin）

### 4.8 設定一覧

`TaskWorkbenchSettings`（`types.ts:39-69`、既定値 `constants.ts:13-42`）: taskFolder("tasks") / filenameUsesDatePrefix(true) / hideCompletedByDefault(true) / currentStatusRows(5) / autoPriorityEnabled(true) / lastAutoPriorityUpdate / 祝日4系統+更新時刻 / ganttZoom(28) / 同期enabled(false)+URL+間隔(5分) / ganttEvents / workload上限・容量(7h/7h) / 機能トグル5種(DailyTodo/Workload/Events/Sync/Tags) / dailyNoteFolders / ganttTags / タグ表示3トグル

---

## 5. 外部依存

| 依存 | 種類 | 影響 |
|---|---|---|
| **Meta Bind** プラグイン | 実行時（ノート内ダッシュボード全部） | 未導入だとノートのUI要素が全て生テキスト表示 |
| **Templater等**（暗黙） | 運用前提 | デイリーノートを事前作成しておく前提 |
| moment（`window.moment`） | Obsidian同梱 | ビューワーはミニ実装で代替 |
| 内閣府祝日CSV | ネットワーク | 日本専用 |
| esbuild / TypeScript | 開発 | strict: false |

---

## 6. 既知の問題・技術的負債（リビルド動機）

### 6.1 型・構造

- `tsconfig` **strict: false**。`priority.ts`・`note-format.ts` は型注釈ゼロの実質JS。`plugin: any`、`dragState: any`、タスクオブジェクトも大半 `any`（`gantt-view.ts:27,60` 等）
- サービス層がPluginクラスの`this`に寄生する疑似mixin。依存が暗黙的でテスト困難
- `renderBar()` の第6引数が「文字列(bulkRole) or オブジェクト(labelInfo)」の実行時分岐（`gantt-bar-marker.ts:106-114`）— リファクタ痕
- YAML自前パーサー（ネスト不可）→ `subtask__key__field` フラットキー方式の根本原因

### 6.2 性能

- **全再描画**: あらゆる操作確定で `render()` → チャートDOM全再構築（`gantt-view.ts:95,426,431,498`）。差分更新なし
- **仮想スクロールなし**: 表示範囲全日×全行のDOMを常時保持。範囲は縮まず拡張のみ
- 外部ラベル配置がO(N²)、マーカーレイアウトの再計算に memoizationなし
- 埋め込みテーブルはフィルタ変更のたび `loadTasks()` 再実行

### 6.3 ハードコード・マジックナンバー

- デイリーノートのフォルダ名・ファイル名規則が日本語でハードコード（`daily-todo-service.ts:8-20`）
- ポップオーバー抑制1200ms（4ファイルに散在）、自動保存450ms、非表示遅延220ms、ドラッグ閾値4px、ganttOrder間隔1000、未配置表示上限20件（`gantt-empty-cell-menu.ts:63`）等、定数化なし
- UI文字列は全て日本語直書き（i18n機構なし）

### 6.4 UX不整合

- Current Status編集がポップオーバー(自動保存)と右クリックメニュー(モーダル)の2系統
- 親期限ドラッグに範囲クランプなし、日付入力にレンジ検証なし
- タグ削除UIなし（設定の手動編集のみ）、タグフィルタ非永続
- Undo/Redoなし（設計上の意図的除外、`AI_AGENT_CORE_API_PLAN.md` 受け入れ基準）

### 6.5 その他

- バージョン不一致: manifest 0.27.0 vs package.json 0.23.0
- `openDailyTodoEditor()` がスタブ（`daily-todo-service.ts:308-310`）
- README記載の `renderEmbed()` `flatDueCb` 未生成参照の補正歴あり
- スタイルは1445行の単一CSS + インラインstyle操作の混在

---

## 7. 会社固有情報の混入箇所（OSS公開前に必ず除去）

| 箇所 | 内容 |
|---|---|
| `tools/copy-dist.mjs:8` | 会社PCの個人OneDriveパスに**社員番号と会社名がそのまま含まれる**ハードコード（具体的な文字列は本ドキュメントにも記載しない） |
| `server/data/latest-snapshot.json` | **実業務データ**: 実在の同僚名・取引先名を含むタスクコメント、実タスク内容 |
| `開発指示書(最初に読むこと).md` | Copilot統制用の私的指示書（合言葉等） |
| `docs/PHASE2_IMPLEMENTATION_EVALUATION.md` 等 | 社内運用前提の記述が一部 |

デイリーノート規則（`デイリー`/`デイリーミーティング`）も社内運用の反映であり、汎用化が必要。

---

## 8. 設計ドキュメントとの関係

- `docs/GANTT_DESIGN.md`（702行）: v0.14.10時点のGantt詳細仕様+v0.18〜0.21のworkload仕様。**Copilot統制のための検証文字列リスト**（`dateFromClientX` 等の存在チェック）を含む — AI開発の管理手法として特徴的
- `docs/AI_AGENT_CORE_API_PLAN.md`: Phase1-7ロードマップ。Phase3以降（Agent Tool Adapter・dry-run・確認フロー・MCP/Dify連携・保存形式見直し）は**未着手**
- 実装済み機能はGANTT_DESIGN.mdの記載とほぼ一致することをコードで確認済み
