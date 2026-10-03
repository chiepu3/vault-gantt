# Faroe向け Vault Gantt 更新ツール

GitHub Actionsで検証済みのartifactから、別Windows PC（Faroe）のVaultへ **Vault Ganttの3ファイル（`main.js` / `manifest.json` / `styles.css`）だけ** を安全に更新・rollbackするための仕組みです。

> [!warning] 実機未テスト
> - **GitHub Actions workflow（`faroe-artifact.yml`）はまだ一度も実行されていません。** 成功実績はありません。
> - **FaroeのVault・実gh・実Obsidian CLIでは未テストです。** PowerShell scriptの自動テストは、gh を偽物に差し替え、temp配下の疑似Vaultだけを使って開発機のWindows PowerShell 5.1で実行したものです。
> - **Faroe固有の挙動（実機のOneDrive・Obsidian・同期構成）は、Faroe実機では未テストです。**
> - Obsidian CLIのコマンドは公式ドキュメントに記載されています。ただしこのscriptは出力形式の細部に依存せず、実行前に `obsidian help` と対象Vaultの一致を検証し、検証できなければ書き換えずに停止する設計です。実CLIでの動作は未確認です。

## 構成

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/faroe-artifact.yml` | check → build → E2E が全て成功した後にだけartifactを作成 |
| `package-bundle.mjs` | artifact内容（3ファイル + `metadata.json` + `SHA256SUMS`）の生成 |
| `Update-VaultGantt.ps1` / `VaultGanttUpdater.Lib.ps1` | Windows用の更新・rollback script（標準PowerShellのみ） |
| `Test-VaultGanttUpdater.ps1` | scriptの独立テスト（依存なし） |

## Actions（artifact生成）

- 対象: このrepositoryの `main` / `codex/faroe-updater` へのpush、または同branchでの `workflow_dispatch` のみ。`pull_request` トリガーは持たず、任意PRのコードは実行しません。権限は `contents: read` のみです。
- exact commit（`github.sha`）をcheckoutし、`npm ci` → `npm run check` → `npm run build` → `npm run test:e2e` を同一job内で順に実行します。どれかが失敗するとartifactは作られません。既存の `ci.yml` / `e2e.yml` とは独立に（重複して）実行します。
- artifact名: `vault-gantt-faroe-<full commit SHA>`（保持14日）
- 使用するactions（checkout / setup-node / cache / upload-artifact）は、公式 `actions/*` リポジトリの `v4` タグが指していたcommit SHAに固定しています（GitHub APIで解決。既存の `ci.yml` / `e2e.yml` は変更していません）。
- 中身（これ以外は実体として含みません）:
  - `main.js`, `manifest.json`, `styles.css`
  - `metadata.json`: full commit SHA、run ID、run attempt、repository、branch、manifest id/version、各ファイルのSHA256とサイズ
  - `SHA256SUMS`: `sha256sum -c` 互換の3行

## 事前準備（Faroe）

- `gh` CLIを導入し、`gh auth login` を **手動で** 済ませておく（scriptは自動loginせず、トークン等を表示しません）。
- 実行対象のrun ID（ActionsのURL末尾の数字）と、そのrunのfull commit SHA（40桁）を自分で確認して渡します。**最新runの自動選択や古いrunへのfallbackはありません。**
- 任意: `-ExpectedWorkflowId <数字>` を指定すると、runの `workflow_id` も照合します。IDは推測せず、自分で `gh api repos/<owner/repo>/actions/workflows/faroe-artifact.yml --jq .id` 等で確認した値を使ってください。workflow pathは `.github/workflows/faroe-artifact.yml` との完全一致（または明示的な `@refs/heads/<ExpectedBranch>` 付き）のみ許可します。
- ZIPやscriptをブラウザ等でダウンロードした場合は `Unblock-File` が必要になることがあります。execution policyの変更は不要です。

## dry-run（既定）

```powershell
cd <このrepoのtools\faroe>
.\Update-VaultGantt.ps1 -Repository <owner/repo> -RunId <RunId> -ExpectedCommit <40桁SHA> `
  -ExpectedBranch main -VaultPath "<VaultのルートPath>"
```

run（success / head SHA / repository / branch / event / workflow path[完全一致] / run_attempt）とartifact（名前・件数・期限）を検証し、zipをVault外のtempへ取得して展開前にallowlist検証、展開後にmetadata（commit / run ID / repository / ref[=runのbranch] / runAttempt[=runのrun_attempt] / manifest id）・SHA256・サイズを検証します。**Vaultは一切書き換えず**、現在と新しいhashの差分だけを表示します。

## apply

```powershell
.\Update-VaultGantt.ps1 -Repository <owner/repo> -RunId <RunId> -ExpectedCommit <40桁SHA> `
  -VaultPath "<VaultのルートPath>" -Apply
```

1. 事前検証（dry-runと同じ）
2. 同期リスクのゲート確認（下記）
3. プラグインが有効なら無効化（下記）
4. 3ファイルを `%TEMP%\vault-gantt-faroe\backup-*`（Vault/OneDrive外）へbackup
5. 3ファイルをプラグインフォルダー内のtempへ複製・hash検証してから置換（`manifest.json` は最後）
6. 置換後に3ファイルのhashと `data.json` の不変を検証。失敗時は自動でrollback

触るのは `<Vault>\.obsidian\plugins\vault-gantt\` の3ファイルだけです。`data.json` などの設定は変更・削除しません。プラグインフォルダーが未作成の場合は停止します（初回のみ手動で作成してください）。シンボリックリンク／ジャンクション、WorkRootがVault内・OneDrive配下の場合も拒否します。WorkRootは親ディレクトリを含めドライブ直下までリンク（reparse point）を検査し、対象3ファイルはOneDriveのクラウドプレースホルダー以外のreparse pointを拒否します。

終了コード: `0` 成功 / `1` 失敗（rollback済み、またはchild processのタイムアウト） / `2` 検証で拒否 / `3` 手動操作が必要（無効化前の停止は未変更。CLI再有効化を確認できない場合は3ファイルは更新・検証済み） / `4` 安全ゲートで拒否 / `5` 失敗かつrollback不完全（backupから手動復元） / `6` 同じVaultで別のupdate/rollbackが実行中

### 排他制御・パス検証・child process

- apply/rollbackの全工程（プラグイン無効化→backup→3ファイル書き込み→検証→有効化）は、正規化したVaultパスごとのnamed mutex（`Global\VaultGanttUpdater-<hash>`）で排他されます。実行中は別のtransactionは待たずに終了コード6で拒否されます（他のプロセスは停止しません）。dry-runは排他しません。
- Vault・WorkRoot・BackupDirは、ドライブ直下まで全ての親ディレクトリを検査し、リンク/reparse pointがあれば拒否します。rollbackはBackupDirの中身（`backup.json` / `files` と3ファイル）・WorkRoot・Vault・プラグインフォルダーを、検証時と各ファイル復元の直前の両方で再検証します。
- `gh` / Obsidian CLIは標準出力・標準エラーを非同期に読み出し、実際のタイムアウト（gh 120〜300秒、CLI 30〜60秒）を持ちます。タイムアウト時はこのscriptが起動したプロセス（とその子孫）だけを終了します。
- `data.json` の比較基準は、プラグインの無効化が完了した後に取得します（Obsidianがunload時に行う設定書き込みを改変と誤認しないため）。
- CLIで再有効化した後は、`community-plugins.json` で有効状態を確認します。確認できない場合は成功扱いにせず、手動対応を表示して終了コード3で終了します。

### プラグインの再有効化は検証後のみ

CLI利用時、プラグインを再有効化するのは「新bundle」または「rollbackで戻した旧bundle」の3ファイル全て（hash・サイズ・manifest id）の検証に通った場合だけです。rollback失敗（終了コード5）・復元不完全・復元後の検証失敗では無効のまま止まり、backupの `files` から手動復元する案内を表示します。元から無効だったプラグインを有効化することはありません。

### プラグインの無効化（GUI手順 / Obsidian CLI）

Vault Ganttが有効（`community-plugins.json` に `vault-gantt`）のままだと、**書き換えずに停止（終了コード3）** します。

- **GUI（既定）**: 設定 → コミュニティプラグイン → 「Vault Gantt」をオフ → 同じコマンドで再実行 → 完了後に再度オン
- **Obsidian CLI（任意）**: `-UseObsidianCli -ObsidianCliVaultName "<Vault名>"` を付けると、`obsidian help` に必要なコマンドが表示され、かつ指定Vault名がVaultPathと完全一致すると確認できた場合に限り、無効化→置換→再有効化を自動で行います。CLIが未有効・コマンド形式不明・Vault不一致なら何も変更せずGUI手順を表示して停止します。

## rollback

applyの完了時に表示される `-Rollback` コマンドを使います。

```powershell
.\Update-VaultGantt.ps1 -Rollback -BackupDir "<表示されたbackupフォルダー>" -VaultPath "<VaultのルートPath>"          # dry-run
.\Update-VaultGantt.ps1 -Rollback -BackupDir "<表示されたbackupフォルダー>" -VaultPath "<VaultのルートPath>" -Apply   # 実行
```

BackupDirがWorkRoot配下であること（実パス・リンク検証）、`backup.json` のVault/プラグインフォルダーが現在の対象と一致すること、backupファイルのhashを検証してから復元します。同期ゲートとプラグイン無効化はapplyと同じです。backupは自動削除されません。

## 同期されるVaultについて（unsynced preview推奨）

Remotely Save等が `.obsidian` を同期するVaultでは、3ファイルの置換が他端末へ伝播したり、部分的な状態が同期されたりする恐れがあります。

- **推奨**: 同期されない専用の **unsynced preview Vault**（OneDrive外、同期プラグインなし）で先に検証し、問題なければlive Vaultへ反映する。
- **live Vault（同期対象）への適用は既定で拒否**（終了コード4）されます。検出条件: VaultがOneDrive配下、`remotely-save` / `obsidian-livesync` / `obsidian-git` の導入、Obsidian Syncの有効化。
- どうしてもlive Vaultへ適用する場合は、**同期を停止し、同期が止まっていることを確認した上で** `-AllowSyncedVault -SyncPausedConfirmed` を両方指定します（scriptは同期停止を検証できません）。適用後に同期を再開する前に、3ファイルの内容を確認してください。
- OneDriveのFiles On-Demandによるクラウドのみのファイルは、通常のファイルとして扱います（リンクは拒否）。

## テスト

```powershell
powershell -NoProfile -File .\Test-VaultGanttUpdater.ps1   # exit 0 = 全件成功
```

dry-run、正常bundle、manifest id不一致、commit/run ID/ref/runAttempt/hash不一致、workflow pathの前方一致（prefix collision）拒否、zip traversal・絶対パス・symlink・余分/欠落entry、junction（reparse）・containment、`data.json` 保持、部分失敗（ファイルロック）→rollback、古いrunへのfallback拒否、同期ゲート、プラグイン有効時の安全停止、必須引数、Vault親ジャンクション、rollback経路の検証と時間差（time-of-use）での差し替え注入、2プロセスによるVaultロック競合、data.json基準取得のタイミング、CLI再有効化の確認、child processのタイムアウト・大量出力を検証します。
