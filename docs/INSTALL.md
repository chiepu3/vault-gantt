# Vault Gantt インストール手順（Windows）

## はじめに

この手順書は、Windows で付属のインストーラー（PowerShell スクリプト）を使って、Obsidian プラグイン「Vault Gantt」を導入・更新する方法を説明します。

インストーラーは次のことを行います。

1. GitHub の公開リポジトリ `chiepu3/vault-gantt` からブランチの一覧を取得して表示します。
2. 選んだブランチの最新の内容を取得し、自分の PC 上でビルドします。
3. ビルドに成功したら、`main.js`・`manifest.json`・`styles.css` の3ファイルをプラグインフォルダーに置きます。

`data.json`（プラグインの設定）やノートは読み書きしません。

注意: インストーラーは、選んだブランチのビルド用プログラムを PC 上で実行します。内容を信頼できるブランチだけを選んでください。

## 必要なもの

- Windows PowerShell 5.1
- Git
- Node.js（npm を含みます）
- インターネット接続（GitHub に接続します）
- インストーラーのファイル一式（リポジトリの `tools\updater` フォルダー）

Git と Node.js は、PowerShell から `git`・`node`・`npm` と打って実行できる状態（PATH が通っている状態）にしてください。見つからない場合、インストーラーはエラーで止まります。

`tools\updater` フォルダーの中のファイルは、フォルダーごと同じ場所に置いたまま使ってください（`Install-VaultGantt.ps1` のほかに `VaultGanttInstaller.Lib.ps1` と `VaultGanttPathSafety.Lib.ps1` が必要です）。

## インストール手順

### 1. インストーラーを手に入れる

PowerShell で任意の作業フォルダー（例: `C:\Users\<ユーザー名>\vault-gantt`）を開き、次を実行します。

```powershell
git clone https://github.com/chiepu3/vault-gantt.git "$env:USERPROFILE\vault-gantt"
cd "$env:USERPROFILE\vault-gantt\tools\updater"
```

### 2. プラグインフォルダーを用意する

インストーラーは配置先のフォルダーを自動では作りません。先に作っておきます。

Vault の場所の例:

```
C:\Users\<ユーザー名>\OneDrive\ドキュメント\Obsidian Vault
```

作るフォルダー:

```
<Vault>\.obsidian\plugins\vault-gantt
```

PowerShell で次のように作れます（`<ユーザー名>` と Vault の場所は自分の環境に置き換えてください）。

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\<ユーザー名>\OneDrive\ドキュメント\Obsidian Vault\.obsidian\plugins\vault-gantt"
```

すでに Vault Gantt を入れたことがある場合は、このフォルダーはもうあります。

### 3. インストーラーを実行する

PowerShell を開き、`tools\updater` フォルダーに移動してから実行します。

```powershell
cd "<tools\updater のフォルダー>"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VaultGantt.ps1 `
  -DestinationPath "C:\Users\<ユーザー名>\OneDrive\ドキュメント\Obsidian Vault\.obsidian\plugins\vault-gantt"
```

`-ExecutionPolicy Bypass` は、この1回の実行にだけ効きます。PC の実行ポリシーの設定そのものは変わりません。

### 4. ブランチを選ぶ

実行すると、GitHub 上の公開ブランチが番号付きで表示されます。

```
公開ブランチ一覧:
1. main [xxxxxxxxxxxx]
...
番号を選択:
```

使いたいブランチの番号を入力して Enter を押します。通常の利用では `main` を選びます。

番号を選ばずに最初から指定したい場合は、`-Branch` を付けます。ブランチ名は公開一覧にあるものと完全に同じにしてください（一覧は表示されます）。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VaultGantt.ps1 `
  -Branch main `
  -DestinationPath "C:\Users\<ユーザー名>\OneDrive\ドキュメント\Obsidian Vault\.obsidian\plugins\vault-gantt"
```

### 5. 完了を確認する

取得とビルドに数分かかることがあります。成功すると次のように表示されます。

```
配置が完了しました: <配置先> (version x.y.z)
```

すでにプラグインが入っていた場合は、続けて「既存ファイルbackupを保持しています: …」とバックアップの場所も表示されます（「元に戻す」を参照）。

### 引数の一覧

| 引数 | 内容 |
| --- | --- |
| `-DestinationPath` | プラグインフォルダー（`<Vault>\.obsidian\plugins\vault-gantt`）。省略すると実行中に入力を求められます。 |
| `-Branch` | インストールするブランチ名。省略すると番号で選びます。 |

`-DestinationPath` について:

- 既に `manifest.json` がある場合は、その `id` が `vault-gantt` である必要があります。
- `manifest.json` がない初回は、`<Vault>\.obsidian\plugins\vault-gantt` の形のフォルダーだけ指定できます。
- 日本語や空白を含むパスも使えます。

### OneDrive 上の Vault

OneDrive 内の Vault にもインストールできます（OneDrive のクラウド上のファイルとして扱われる場所は許可されています）。

- OneDrive で「クラウドのみ」になっている既存の3ファイルがある場合、インストーラーが中身を読むときに自動でダウンロードされます。
- 読み込みに失敗すると、配置先を書き換えずに止まります。その場合は、プラグインフォルダーを OneDrive で「このデバイス上に常に保持する」にして、ダウンロードが終わってからやり直してください。
- シンボリックリンクやジャンクションを含むパスは使えません。

## Obsidian 側での有効化

1. Obsidian を開きます（開いたままだった場合は、いったん Vault を開き直すか、Obsidian を再起動します）。
2. 設定 → コミュニティプラグインを開きます。「制限モード」がオンのときは、オフにします。
3. インストール済みプラグインの一覧にある「Vault Gantt」をオンにします。
4. コマンドパレットで「Open task workbench」または「Open task gantt」を実行して、開けることを確認します。

## AI チャットの設定

AI チャットを使うには、設定 → Vault Gantt → 「AI チャット」で接続先を設定します。接続先はすべて OpenAI 互換の API です。メッセージを送ると、会話の内容と必要なタスク情報が接続先へ送られます。

### 接続先の種類

| 種類 | 接続先 URL | API キー |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1`（固定。変更できません） | 使う（初期設定） |
| ローカル（LM Studio など） | 初期値は `http://localhost:1234/v1` | 使わない（初期設定） |
| カスタム | 自分で入力します | 使う（初期設定。接続先に合わせて切り替えます） |

- LM Studio の既定は `http://localhost:1234/v1` です。Ollama を使う場合は `http://localhost:11434/v1` を指定します。
- カスタムでは、末尾が `/v1` の URL を入力します。
- 種類を切り替えると、モデルの選択は空に戻ります。
- キーが要らない接続先（ローカルの LLM など）では、「APIキーを使う」をオフにします。

### API キーの登録

1. 「APIキーを使う」をオンにします。
2. 「APIキー」の入力欄にキーを入力し、「保存」を押します。入力中は伏せ字で表示されます。「表示」で確認できます。
3. 登録済みの場合は「登録済みです」と表示されます。新しいキーを入力して保存すると置き換わります。「削除」で消せます。

キーの保存場所:

- Obsidian の秘密ストレージが使える場合は、そこに保存されます。
- 使えない場合は、Vault の `.obsidian/plugins/vault-gantt/data.json` に保存されます。Vault を OneDrive などで同期していると、このファイルも同期される点に注意してください。

キーは、保存したときの接続先（URL の「https://ホスト名」の部分）にだけ送られます。接続先 URL を別のホストに変えると、保存済みのキーは使われず、キーを入れ直すよう表示されます。

### モデルの選択

APIキーが必要な接続先では、キーを登録すると、設定画面を開いたときや接続先を変えたときにモデルの一覧が自動で取得されます（キーが不要な接続先では、キーなしで取得します）。

- 取得できると「モデル」欄が一覧から選ぶ形になります。「再取得」で取り直せます。
- 取得できないときは、理由が表示されます。その場合もモデル ID を直接入力できます。
- 「接続テスト」を押すと、接続先とキーが使えるかを確認できます（モデル一覧の取得を試します）。
- ローカルの LLM では、モデルを読み込んでから再取得してください。LM Studio では、サーバー設定の「CORSを有効にする」もオンにしてください。

### http と https

接続先 URL には https・http のどちらも使えます。http でキーを使う場合は、通信が暗号化されないという注意が表示されます。キーを使う接続先は、できるだけ https にしてください。

### MCP を使う場合

外部の AI ツールから Vault Gantt を操作する MCP 接続の有効化と接続方法は、[docs/ai/MCP.md](ai/MCP.md) を参照してください。

## 更新

PowerShell でリポジトリを更新し、`tools\updater` フォルダーに移動します。

```powershell
cd "$env:USERPROFILE\vault-gantt"
git pull
cd tools\updater
```

「インストール手順」の「3. インストーラーを実行する」のコマンドをもう一度実行し、ブランチを選びます。

- 更新前の3ファイルは、自動でバックアップされます。
- 更新前に、Obsidian でプラグインをオフにするか、Obsidian を閉じておくと確実です。ファイルが使用中で置き換えられない場合、インストーラーは元のファイルに戻して止まります。
- 更新後は、Obsidian でプラグインをオフ → オンにするか、Obsidian を再起動します。

## 元に戻す

既存のプラグインを置き換えた場合、置き換え前の3ファイルは次の場所に残ります。

```
%TEMP%\vault-gantt-installer-<ランダムな文字列>\backup-<ランダムな文字列>
```

実際の場所は、インストール完了時の「既存ファイルbackupを保持しています: …」に表示されます。`%TEMP%` は、エクスプローラーのアドレス欄に入力すると開けます。

戻し方:

1. Obsidian でプラグインをオフにします（または Obsidian を閉じます）。
2. バックアップフォルダー内の `main.js`・`manifest.json`・`styles.css` を、プラグインフォルダー（`<Vault>\.obsidian\plugins\vault-gantt`）へ上書きコピーします。
3. Obsidian でプラグインをオンにします。

バックアップは自動では削除されません。不要になったら自分で削除してください。初めてのインストール（置き換える既存ファイルがなかった場合）は、バックアップは作られません。

途中で失敗した場合は、インストーラーが自動で元の状態に戻します。自動で戻せなかったときだけ、エラーにバックアップと作業フォルダーの場所が表示されます。その場合は上の手順で手動で戻し、初回インストールで新しくできたファイルは取り除いてください。

## 困ったとき

エラーは `[vault-gantt-installer] エラー: …` の形で表示されます。

| 表示 | 原因と対処 |
| --- | --- |
| `git が見つかりません` / `npm が見つかりません` | Git または Node.js が未導入か、PATH が通っていません。インストールしたあと、PowerShell を開き直してください。 |
| `公開ブランチを取得できませんでした。ネットワークを確認してください。` | GitHub に接続できていません。ネットワークやプロキシの設定を確認してください。 |
| `選択番号が不正です` | 一覧にない番号が入力されました。やり直して、一覧の番号を入力してください。 |
| `指定されたbranchは公開一覧にありません` | `-Branch` の名前が一覧と一致していません。大文字・小文字も含めて確認してください。 |
| `配置先フォルダーがありません` | 配置先を先に作る必要があります。「2. プラグインフォルダーを用意する」を実行してください。 |
| `初回の配置先は<Vault>\.obsidian\plugins\vault-ganttである必要があります。` | 初回は、この形のフォルダーだけ指定できます。パスを確認してください。 |
| `配置先のmanifest.jsonのidがvault-ganttではありません。` | 別のプラグインのフォルダーを指定しています。パスを確認してください。 |
| `npm ci に失敗しました` / `npm run build に失敗しました` | 取得または依存パッケージの導入、ビルドに失敗しました。表示されたメッセージを確認し、ネットワークと Node.js を確認してください。この場合、配置先は変更されません。 |
| `同じ配置先で別のinstall/update/rollbackが実行中です。` | 同じ Vault に対して、別のインストーラーが動いています。終わってからやり直してください。 |
| `既存ファイルを読み込めません … OneDriveでこのフォルダを『このデバイス上に常に保持する』にしてから再実行してください。` | OneDrive のファイルをダウンロードできていません。上の「OneDrive 上の Vault」を参照してください。 |
| `パスに許可されていないreparse pointがあります` | 配置先のパスにシンボリックリンクやジャンクションが含まれています。実際のフォルダーのパスを指定してください。 |
| `配置に失敗したため既存ファイルを復元しました。` | 置き換えに失敗したため、元のファイルに戻しました。Obsidian を閉じてからやり直してください。 |
| `配置に失敗しrollbackも不完全です。手動復元が必要です。` | 「元に戻す」の手動の手順で、表示された backup から戻してください。 |
| `cleanupに失敗しました。残留パス: …`（警告） | 作業用フォルダーの削除に失敗しました。インストール自体の結果は変わりません。表示されたフォルダーは手動で削除できます。 |

実行ポリシーのエラー（「このシステムではスクリプトの実行が無効になっているため…」）が出る場合は、「インストール手順」のとおり `powershell.exe -NoProfile -ExecutionPolicy Bypass -File …` の形で実行しているか確認してください。
