# Vault Gantt MCP

同じPCで、対象VaultをObsidian Desktopで開き、プラグインのMCPを有効にしている間だけ利用できます。HTTPもstdioも起動中プラグインの同じ操作portへ接続します。bridgeはVaultを直接読み書きせず、Obsidianを起動しません。クラウド側のAIから、そのままPCの127.0.0.1へ接続することはできません。

この工程では起動APIと設定記述までを実装しています。`main.ts`、設定画面、秘密ストレージ、承認一覧への配線は統合工程で行います。

## SDK・仕様版

2026-10-09に公式npmレジストリの`latest`を`npm view`で確認し、次を完全固定しました。

| package | version | Node要件 |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.3.1` | >=20 |
| `@modelcontextprotocol/client` | `2.3.1` | >=20 |
| `@modelcontextprotocol/node` | `2.1.1` | >=20 |

公式SDKはv2を安定系列として案内しています。[公式SDK](https://github.com/modelcontextprotocol/typescript-sdk)。lockfileで推移依存も固定しています。検証環境はNode 22.23.2です。Obsidian同梱Nodeの実機確認は統合工程で必要です。

主系統は2026-07-28、互換系統は2025-11-25です。新版のrequest metadata、HTTP version/method/name headerの一致検証、stdioの版判定には公式SDKを使います。HTTPはstateless POST `/mcp`で、応答はJSONまたはrequest単位SSEです。GET/DELETEは405です。[新版HTTP仕様](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。常設subscriptionは初版では提供せず、status pollingを使います。

## 起動APIと設定

```ts
import { startMcpServer, DEFAULT_MCP_SETTINGS, buildMcpSettingsDescription } from "./mcp/server";

const mcp = await startMcpServer({
  operations: operationService, // 凍結済みOperationService
  previews: previewPort,
  context: contextReadPort,
  history: historyPort,
  vaultInstanceId,              // プラグイン起動ごとに固有のinstance ID
  principal: {
    id: registeredPrincipalId,
    label: "登録したクライアント名",
    capabilities: ["read", "propose"],
  },
  isDesktop,
  token: resolvedSecret,        // 省略時はセッション限定tokenを生成
}, { ...DEFAULT_MCP_SETTINGS, enabled: true, port: 8788 });

const rows = buildMcpSettingsDescription(settings); // DOM非依存の設定行
// 人間の操作だけでmcp.sessionTokenをコピー・秘密ストレージへ保存する。
const newToken = await mcp.regenerateToken();
await mcp.stop();              // owner pluginのonunloadから必ず呼ぶ
```

`McpSettings`は`enabled`（既定false）、`port`（8788）、`secretId`（null）、`allowedOrigins`（空配列）です。設定行は有効化・port・token生成/再生成/copy・利用条件を記述します。`McpServerHandle`は`running`、`endpoint`、人間UI向け`sessionToken`、`stop()`、`regenerateToken()`を公開します。生成関数はdesktop限定の`auth.ts`の`generateMcpToken()`です。mobile側は`server.ts`をimportでき、無効時/mobile時はNode builtinを評価しません。port=0は空きportを使うテスト用で、設定UIは1〜65535を示します。

bindは127.0.0.1固定です。port競合時はEADDRINUSEを呼び出し側へ返し、別portや別Vaultへ探索しません。起動エラーは統合側で捕捉し、MCPだけを無効化してください。

tokenは専用の暗号学的乱数32bytesをbase64url化します。Bearerを長さ確認後に定数時間比較します。秘密ストレージがあれば値を保存し、設定にはsecretIdだけを保存してください。APIの利用可否を確認せずにObsidianの秘密ストレージを前提にしません。未対応時はセッションtokenを使い、plugin dataや同期Vaultへ自動保存しません。停止・再生成で古い接続を閉じ、所有するpending提案をrejectします。applyingの保存処理には触れません。

## HTTP接続

URLは`http://127.0.0.1:8788/mcp`、すべてのHTTP要求に`Authorization: Bearer <token>`を付けます。tokenをURL/query/bodyに入れません。Hostは実listen先の`127.0.0.1:port`との完全一致、Origin付き要求は設定allowlistとの完全一致を必要とします。Originなしのnative clientはBearerで接続できます。forwarded headerは認証根拠にしません。

この方式は事前設定Bearerです。OAuth discoveryだけを利用するclientとの互換性は保証しません。clientがHTTP headerを設定できない場合はstdio bridgeを使ってください。

## stdio接続

Node >=20が必要です。`npm run build`で`tools/mcp-bridge/dist/bridge.cjs`も生成します。bridgeだけなら`npm run build:mcp-bridge`です。gitを実行できないビルド環境では`VG_BUILD_COMMIT=unknown npm run build`を使います。

bridgeの起動コマンドは`node /absolute/path/to/bridge.cjs`です。引数にtokenを入れず、MCP hostから次の環境変数を渡します。

| 変数 | 内容 |
| --- | --- |
| `VAULT_GANTT_MCP_URL` | `http://127.0.0.1:8788/mcp`（省略時もこの値） |
| `VAULT_GANTT_MCP_TOKEN` | Obsidian側の専用token、必須 |
| `VAULT_GANTT_MCP_VAULT_INSTANCE_ID` | 接続先の起動instance ID、必須 |

bridgeはHTTP SDK clientで接続し、`server.identity`のVault IDを照合してからstdioを開始します。旧版stdioと新版HTTPを組み合わせられます。tools/resources/schema/result、並行要求、request進捗、取消をSDK経由で中継します。client申告名は認証済みprincipal名と別のmetadataとして中継します。

未起動ならstderrにAPP_NOT_RUNNINGを出し、stdoutに診断を出さず終了します。誤tokenはMCP_AUTHENTICATION_FAILED、違うVaultはMCP_BRIDGE_VAULT_MISMATCHです。稼働中の切断でもAPP_NOT_RUNNINGを返し、Vault直接操作へfallbackしません。stdin EOF/SIGINT/SIGTERMで終了します。

## クライアント設定例

各例のinstance IDとbridge絶対pathをObsidian側の値に置き換えます。tokenは環境変数またはclientのsecret入力へ渡します。設定fileをVault外のユーザー設定へ置き、秘密をrepositoryに追加しないでください。ここに示すのは設定形式であり、各GUIの実機接続は未検証です。

### Cursor（HTTP）

ユーザー設定`~/.cursor/mcp.json`の例です。Cursorの環境変数補間を使います。[Cursor公式MCP設定](https://cursor.com/docs/mcp)。

```json
{
  "mcpServers": {
    "vault-gantt": {
      "url": "http://127.0.0.1:8788/mcp",
      "headers": { "Authorization": "Bearer ${env:VAULT_GANTT_MCP_TOKEN}" }
    }
  }
}
```

### Cursor（stdio）

同じユーザー設定のserver entryを次に置き換えます。

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/bridge.cjs"],
  "env": {
    "VAULT_GANTT_MCP_URL": "http://127.0.0.1:8788/mcp",
    "VAULT_GANTT_MCP_TOKEN": "${env:VAULT_GANTT_MCP_TOKEN}",
    "VAULT_GANTT_MCP_VAULT_INSTANCE_ID": "COPY_INSTANCE_ID_FROM_OBSIDIAN"
  }
}
```

### VS Code（HTTP）

`MCP: Open User Configuration`で開くユーザー設定に追加します。[VS Code公式MCP設定](https://code.visualstudio.com/docs/agent-customization/mcp-servers)。

```json
{
  "servers": {
    "vault-gantt": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp",
      "headers": { "Authorization": "Bearer ${env:VAULT_GANTT_MCP_TOKEN}" }
    }
  }
}
```

### VS Code（stdio）

同じ`servers` entryに上記Cursor stdioのentryを使えます。`type`は`stdio`です。hostからbridgeの3環境変数を渡します。

### Claude Desktop（stdio）

Developer設定から`claude_desktop_config.json`を編集します。[公式ローカル接続手順](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)。Desktopの設定補間は前提にせず、Desktopプロセスに専用token環境変数を渡して起動してください。bridgeのSDKは既定の安全な環境変数しか継承しないhostでも動くよう、hostの`env`へtokenを明示して渡す必要があります。環境変数継承を制御できないDesktopでは、Vault外の権限制限launcherから専用環境を設定します。

```json
{
  "mcpServers": {
    "vault-gantt": {
      "command": "/absolute/path/to/vault-gantt-mcp-launcher",
      "args": []
    }
  }
}
```

launcherは利用者がVault外に用意します。例としてPOSIXでは、権限制限した環境fileを読み、tokenをargvへ渡さずbridgeをexecします（このbridge自体には任意設定file読取り機能を持たせていません）。

```sh
#!/bin/sh
set -a
. "$HOME/.config/vault-gantt/mcp.env"
set +a
exec /absolute/path/to/node /absolute/path/to/bridge.cjs
```

環境fileには3変数を設定し、利用者だけが読める権限にしてください。Windowsでは同じ役割のlauncherまたはhostの`env`設定を利用します。

### Claude Code（HTTP / stdio）

ユーザー設定の`mcpServers`へ上記のHTTP（`type: "http"`を明示）またはstdio entryを追加できます。Claude Codeの環境変数補間は`${VAULT_GANTT_MCP_TOKEN}`で、Cursor/VS Codeの`${env:...}`とは異なります。[Claude Code公式MCP設定](https://code.claude.com/docs/en/mcp)。tokenを含む`--header`/`--env`引数による登録は避け、ユーザー設定と環境変数を使ってください。

## 操作・承認フロー

`operations.describe`は全123操作の説明、availability、必要capability、拒否理由を返します。`tools/list`には現在利用でき、tokenの権限に合う操作だけを示します。既定はread/proposeで、ui/external/diagnostic/chat-controlは登録principalへ別途付与します。V14はui capabilityを付与しても`operationRequestDenial()`で拒否します。

読み取りは契約のcontext query名（`context.overview`、`tasks.search`等）と`operations.T01.read`等です。書き込みは`operations.T03.propose`等へ次の形式で要求します。

```json
{ "input": { "name": "新しいタスク" }, "callerIntentId": "client-generated-unique-intent-id" }
```

schemaは凍結済み操作入力から生成します。`callerIntentId`は必須で、同じ操作の再送には同じIDと同じ入力を使います。応答の`structuredContent.data`には`status: "pending_approval"`、previewId、expiresAt、summary、descriptorが入ります。提案時点では保存しません。Obsidianの人間UIが承認した後、`previews.status({previewId})`で保存結果を取得します。同じintentの再送は既存提案・receiptを返し、再実行しません。エラーは`isError: true`と`structuredContent.error`です。context queryの契約上のerrorは`data.status: "error"`です。

MCPにapprove/commitはありません。`confirmed: true`やorigin/principal/capabilityを入力へ追加しても拒否します。Q07の`operations.Q07.request`は所有するpending提案について承認画面を要求するだけです。Q08は`operations.Q08.propose`（`input: {previewId}`＋callerIntentId）で再提案します。`previews.reject`は所有するpending提案だけを却下します。

pending→pending_approval、success→committedをwire側だけで変換します。applying/partial/failed/cancelled/rejected/stale/expiredは区別し、descriptorの契約statusを変更しません。実保存outcomeは元previewとの完全なaction対応を検証し、actualProjectionと履歴のundo可否を返します。approvedという独立した承認イベントは現契約に存在せず、保存完了とは扱いません。

resourcesは`vault-gantt://context/overview`、`vault-gantt://tasks/{encoded-id}`、`vault-gantt://previews/{encoded-id}`です。IDは`encodeURIComponent`で符号化します。任意file/URL、絶対path、`..`等は拒否します。previewのVault/principal所有権を確認してからoutcome・却下・投影ページへアクセスします。`previews.projection-page`は固定projectionのcursorをportへ渡します。

## 上限・取消・統合時の前提

- HTTP body最大1MiB、接続最大32、同時read最大4、提案port呼出し直列、待機提案最大10。上限超過はretryableなPOLICY_DENIEDです。
- Vault全体pending50、principalごとpending10、portが作る提案期限は10分以内。停止・token変更でpendingをrejectし、期限を30秒ごとに掃除します。port自身も承認時に期限・scope・内容revisionを再検証する必要があります。
- intent/receipt対応は起動中256件まで保持し、古いintentを黙って捨てて再実行しません。上限時はRESET_REQUIREDです。再起動後の不明previewはUNKNOWN_AFTER_RESTARTです。Exactly-onceは保証しません。応答消失時は対象を再取得して成否を確認します。
- 新版HTTPの切断は要求取消としてsignalへ伝播します。旧版HTTPでは切断だけで提案生成を取り消さず、明示cancel notificationを扱います。同じprincipalの同時要求でJSON-RPC IDが衝突した場合は曖昧なcancelを無視します。clientは同じtokenで並行使用するときにも要求IDを一意にしてください。承認済み保存はpoll切断で取り消しません。
- managed taskFolder/登録済みsourceの実scope照合、Vault外symlink拒否、承認・保存時の原子的な再検証、preview store自体の保持上限はOperationService/アプリ側portの責務です。MCPも入力の字句検証と所有権照合を行いますが、Vaultへ直接アクセスしてscopeを独自判定しません。
- 初回に全操作の出力schemaを検証するSDK clientでは約10秒、bridgeを通して上流・下流双方が検証すると約20秒を要した環境があります。接続/一覧取得に十分なtimeoutを設定してください。

契約変更要求: `PreviewPort`にはexpired/revokedへ遷移させる認証付きinvalidate APIがないため、現実装はrejectを使用します。`OperationService`には認証付きoutcome取得がないため、`inspect(previewId, context)`＋明示的Vault/principal確認後に`PreviewPort.inspectOutcome`を呼びます。invalidateと認証付きreceipt取得の追加が望まれます。approvedイベントを独立して表示するには、承認イベント参照契約も必要です。契約ファイルは変更していません。

## 検証

`tests/mcp/`と`tests/mcp-bridge/`はfake port、127.0.0.1の空きport、公式SDK clientを使用します。HTTP新版/旧版、stdio新版/旧版とHTTP新版の組合せ、schema/resource/全操作の振り分け、偽承認・権限・Vault境界、再送、部分保存DTO、上限、token再生成、取消、EOF、起動失敗、mobileのNode builtin遅延評価を確認します。GUI clientとObsidian実機での確認は統合工程です。

2026-10-09の最終検証は`npm run typecheck`、`npm run lint`、`VG_BUILD_COMMIT=unknown npm run build`が成功し、`npm test`は47ファイル・2079件すべて成功しました（MCP/bridgeの追加テスト39件）。git操作は実行していません。
