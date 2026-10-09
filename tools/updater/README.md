# Vault Gantt Windows installer / updater

このフォルダーには、更新元が異なる2つのWindows用ツールがあります。

- `Install-VaultGantt.ps1`: 公開branchを一覧から選び、そのcommitを取得してビルドした後、指定フォルダーへ配置します。
- `Update-VaultGantt.ps1`: GitHub Actionsが検証済みcommitから作成したartifactを検証し、dry-run/apply/rollbackします。

両方式とも `main.js` / `manifest.json` / `styles.css` だけを対象にし、branch-build installerはartifact updaterのartifactを使いません。実行用script、対応する `Lib.ps1` と共通ライブラリ `VaultGanttPathSafety.Lib.ps1` は同じフォルダーに置いてください。

## Branch-build installer

Windows PowerShell 5.1、Git、Node.js/npmが必要です。installerの `.ps1`（共通ライブラリ `VaultGanttPathSafety.Lib.ps1` を含む）は日本語を正しく読み込めるUTF-8 BOM付きです。`-DestinationPath` はVaultのpluginフォルダーそのものを指定してください。フォルダーは事前に作成しておきます。既存の `manifest.json` がある場合は `id` が `vault-gantt` と完全一致することが必須です。manifestがない初回配置は `<Vault>\.obsidian\plugins\vault-gantt` の構造のみ許可します。日本語・空白を含む配置先やOneDrive配下でも使用できます。配置先の親チェーンと既存3ファイルのreparseタグを検査し、クラウドファイル系の `IO_REPARSE_TAG_CLOUD` / `CLOUD_1`〜`CLOUD_F`（`0x9000001A`〜`0x9000F01A`）だけを許可します。シンボリックリンク、ジャンクション／マウントポイント、その他のreparse point、タグを取得できないパスは拒否します。タグ取得には[Unicode版FindFirstFileW](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags)を使用します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VaultGantt.ps1 `
  -DestinationPath "D:\Vault\.obsidian\plugins\vault-gantt"
```

起動するたびにGitHub上の公開branchを番号付きで表示し、branch名とhead SHAを照合して選択します。番号を選ぶ対話実行では `-Branch` を省略します。自動テストや再現実行では公開一覧にある完全一致のbranchを指定できます（一覧も引き続き表示します）。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VaultGantt.ps1 `
  -Branch main -DestinationPath "D:\Vault\.obsidian\plugins\vault-gantt"
```

OneDriveのクラウドのみ（未ダウンロード）の既存ファイルは、manifestの検査やbackupのために内容を読み込む際に自動ダウンロードされます。読み込みに失敗した場合は配置先を書き換えずに停止します。OneDriveでこのフォルダを「このデバイス上に常に保持する」にして、ダウンロード完了後に再実行してください。

branch headの40桁SHAを専用の一時作業フォルダーにfetchし、そのSHAへdetach checkoutしたことを確認してから `npm ci` → `npm run build` を実行します。両方成功し、3成果物とmanifest idを検証できた場合だけ配置します。配置前に既存3ファイルをbackupし、置換を試みる前にrollback対象へ登録します。途中失敗時は例外が発生したファイルも含めて復元し、元のSHA256と存在状態（初回配置では元の不存在）を検証します。元のhashのまま残っているファイルは再置換を省きます。成功時は既存ファイルのbackupを `%TEMP%\vault-gantt-installer-<GUID>\backup-<GUID>` に保持し、場所とmanifest.jsonのversionを表示します。rollbackの復元処理が失敗した場合、または復元後のhash・存在状態を確認できない場合はbackupとWorkRoot全体を保持し、両方のパスと手動復元が必要なことを表示します。表示されたbackupから元のファイルを配置先へ戻し、初回配置で新たにできたファイルは取り除いてください。取得・依存導入・buildの失敗では配置先を変更しません。`data.json`、ノート、その他のファイルは読み書きしません。

backup前から配置後の検証・rollback・stage cleanup完了までnamed mutexを保持します。同じ対象で処理中なら待たずにエラー終了（終了コード1）します。標準配置ではVaultルートを `GetFullPath` → 末尾区切り除去（ルートは維持）→ 小文字化 → UTF-8 → SHA256とし、先頭32桁の大文字hexから `Global\VaultGanttUpdater-<hash>` を作ります。artifact updaterと同じ名前なのでinstall/update/rollback間でも競合を防ぎます。既存manifestで確認した標準構造以外の配置先では、配置先そのものを同様に正規化した `Global\VaultGanttInstaller-<hash>` を使います。ロック取得後にもmanifestと配置先を再検証します。

成功時にはbuild用repositoryを削除し、既存ファイルがあった場合だけbackupとその親WorkRootを保持します。初回成功または検証済みrollbackではWorkRootも削除します。cleanupはPowerShell 5.1の `Remove-Item -Recurse` を使わず、[長いパス対応のUnicode API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfilew) に `\\?\`（UNCでは `\\?\UNC\`）を付けて削除します。OSの長いパス設定に依存せず、深い `node_modules` と読み取り専用ファイルを扱います。削除はこの実行で作成・登録したWorkRoot内と、この実行のbackup/stageに限定し、WorkRoot/backupはクラウドを含む親の全reparse pointを拒否します。OneDrive配下のstageだけはクラウドタグの親を許可し、登録済みstageの既知のファイルだけを削除し、タグ検証済みのstageが読み取り専用になった場合はその属性だけを解除してから空のフォルダーを削除します。内部のjunction/linkは辿らず、リンク自体だけを削除します。cleanup失敗時は元の成功・失敗結果を維持し、残留パス付きの警告を表示します。

**選択branchのコードは信頼できることを確認してください。** installerは選択commitの `npm ci` lifecycle scriptsとbuild scriptを実行します。installerは配置先フォルダーを自動生成せず、既存のpluginフォルダーを対象にします。

## 検証済みartifact updater

### 構成とActions

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/vault-gantt-updater.yml` | check → build → E2E成功後にだけartifactを作成 |
| `package-bundle.mjs` | 3ファイル + `metadata.json` + `SHA256SUMS`を生成 |
| `Update-VaultGantt.ps1` / `VaultGanttUpdater.Lib.ps1` | artifact検証、更新、rollback |
| `Test-VaultGanttUpdater.ps1` | artifact updaterの独立テスト |
| `Test-VaultGanttInstaller.ps1` | branch-build installerの回帰テスト |

- workflowは `main` へのpushと、`main` での `workflow_dispatch` を受け付けます。`pull_request` triggerはなく、権限は `contents: read` のみです。
- exact commit（`github.sha`）をcheckoutし、`npm ci` → `npm run check` → `npm run build` → `npm run test:e2e` を同一job内で順に実行します。どれかが失敗するとartifactは作られません。
- artifact名: `vault-gantt-updater-<full commit SHA>`（保持14日）。内容は3ファイル、commit/run/repository/branch等のmetadata、SHA256SUMSです。
- artifact workflowの実行、実`gh`、実Obsidian CLIは未検証です。PowerShell artifact-updaterテストはfake `gh`とtemp内の疑似Vaultを使います。Obsidian CLIの実動作も未確認です。

### 事前準備

- `gh` CLIを導入し、`gh auth login` を **手動で** 済ませておく（scriptは自動loginせず、token等を表示しません）。
- 実行対象のrun IDと、そのrunのfull commit SHA（40桁）を自分で確認して渡します。最新runの自動選択や古いrunへのfallbackはありません。
- 任意の `-ExpectedWorkflowId <数字>` はworkflow idも照合します。workflow pathは `.github/workflows/vault-gantt-updater.yml` との完全一致、または明示的な `@refs/heads/<ExpectedBranch>` 付きのみ許可します。
- ZIPやscriptをブラウザー等で取得した場合は `Unblock-File` が必要になることがあります。execution policyの変更は不要です。

## dry-run（既定）

```powershell
cd <このrepoのtools\updater>
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
4. 3ファイルを `%TEMP%\vault-gantt-updater\backup-*`（Vault/OneDrive外）へbackup
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
powershell -NoProfile -File .\Test-VaultGanttInstaller.ps1 # exit 0 = 全件成功
```

dry-run、正常bundle、manifest id不一致、commit/run ID/ref/runAttempt/hash不一致、workflow pathの前方一致（prefix collision）拒否、zip traversal・絶対パス・symlink・余分/欠落entry、junction（reparse）・containment、`data.json` 保持、部分失敗（ファイルロック）→rollback、古いrunへのfallback拒否、同期ゲート、プラグイン有効時の安全停止、必須引数、Vault親ジャンクション、rollback経路の検証と時間差（time-of-use）での差し替え注入、2プロセスによるVaultロック競合、data.json基準取得のタイミング、CLI再有効化の確認、child processのタイムアウト・大量出力を検証します。branch-build installerの回帰テストでは、成功時のbackup保持とversion表示に加え、置換中の消失・改変、復元が例外なしに不正内容や欠落を残す場合、初回配置の不存在検証、backup/WorkRoot保持と手動復元案内、3スクリプトのBOM、配置先ID/構造検証、別プロセスのinstaller/updaterとの競合・待機なし拒否・rollback中の排他と解放、500文字超のパスと読み取り専用ファイルの削除、junction先の保護、未所有パスの削除拒否を確認します。実行にはWindowsが必要です。
