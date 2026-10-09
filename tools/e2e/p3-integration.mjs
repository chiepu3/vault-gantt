// P3: real Obsidian UI + operation runtime + authenticated loopback MCP.
// The chat provider is deterministic; this test does not contact an LLM.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startObsidian, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "vg-p3-vault-"));
const pluginDir = path.join(vault, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const name of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(repo, name), path.join(pluginDir, name));
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false,
  ganttFeatureSyncEnabled: false, ganttNationalHolidays: [today], ganttNationalHolidaysUpdatedAt: new Date().toISOString(),
  mcp: { enabled: true, port: 0, secretId: null, allowedOrigins: [] } }));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
const taskPath = "tasks/P3確認.md", childId = `${taskPath}::review`;
const common = { statusLabel: "active", completed: false, createdAt: today, updatedAt: today, priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const child = { ...common, kind: "subtask", id: childId, key: "review", file: { path: taskPath, parentPath: taskPath, heading: "変更前" },
  title: "変更前", displayName: "変更前", ganttEnabled: false, plannedStartDate: today, plannedEndDate: today };
const parent = { ...common, kind: "parent", id: taskPath, file: { path: taskPath }, title: "P3確認", displayName: "P3確認", ganttEnabled: true, ganttOrder: 1000, subtasks: new Map([["review", child]]) };
const { buildFullNote } = await loadNoteFormatModule();
fs.mkdirSync(path.join(vault, "tasks")); fs.writeFileSync(path.join(vault, taskPath), buildFullNote(parent, parent.subtasks));
let runtime, client;
try {
  runtime = await startObsidian({ vaultDir: vault });
  const { cdp } = runtime;
  await enablePlugin(cdp, "vault-gantt");
  const initial = await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins["vault-gantt"];
    const taskId = ${JSON.stringify(childId)};
    plugin.chatSession.provider = { connected: () => true, async *stream(request) {
      const preview = await plugin.operationService.propose("T07", { taskId, name: "チャット保存" }, {
        vaultInstanceId: plugin.operationService.vaultInstanceId, principalId: "obsidian-chat", origin: { kind: "chat", conversationId: request.conversationId },
        capabilities: ["read", "propose"], requestId: "p3-chat", signal: request.signal
      });
      yield { type: "plan", preview, operationId: "T07", plan: plugin.operationService.legacyPlan(preview), operation: "update", input: { taskId, patch: { displayName: "チャット保存" } } };
    } };
    await plugin.openAIChat("tab");
    await plugin.chatSession.send("子タスクの名前をチャット保存へ変更");
    const preview = plugin.previewPort.list().find(p => p.origin.kind === "chat");
    return { previewId: preview.previewId, status: preview.status, content: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(taskPath)})), endpoint: plugin.getMcpStatus() };
  })()`);
  assert.equal(initial.status, "pending"); assert.ok(initial.content.includes("変更前")); assert.ok(!initial.content.includes("チャット保存"));
  const cardSelector = `[data-preview-id="${initial.previewId}"]`;
  await cdp.waitForExpression(`!!document.querySelector(${JSON.stringify(cardSelector + ' button[data-action="approve"]')})`, { timeoutMs: 10000, label: "chat approval card" });
  await cdp.evaluate(`document.querySelector(${JSON.stringify(cardSelector + ' button[data-action="focus"]')}).click()`);
  await cdp.waitForExpression(`!!document.querySelector(".vg-pv-dockhost:not([hidden])")`, { timeoutMs: 10000, label: "Gantt preview dock" });
  await cdp.evaluate(`app.plugins.plugins["vault-gantt"].openAIChat("tab")`);
  await cdp.evaluate(`document.querySelector(${JSON.stringify(cardSelector + ' button[data-action="approve"]')}).click()`);
  await cdp.waitForExpression(`app.plugins.plugins["vault-gantt"].previewPort.inspectOutcome(${JSON.stringify(initial.previewId)})?.status === "success"`, { timeoutMs: 10000, label: "chat approval save" });
  assert.ok(fs.readFileSync(path.join(vault, taskPath), "utf8").includes("チャット保存"));
  // Keep credentials in memory; never include them in logs/artifacts.
  const connection = await cdp.evaluate(`({ endpoint: app.plugins.plugins["vault-gantt"].mcpServer?.endpoint, token: app.plugins.plugins["vault-gantt"].mcpServer?.sessionToken })`);
  assert.ok(connection.endpoint?.startsWith("http://127.0.0.1:"));
  client = new Client({ name: "p3-real-obsidian", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.endpoint), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
  const proposal = await client.callTool({ name: "operations.T07.propose", arguments: { callerIntentId: "p3-mcp-rename", input: { taskId: childId, name: "MCP保存" } } });
  assert.ok(!proposal.isError, JSON.stringify(proposal));
  const data = proposal.structuredContent.data;
  await cdp.evaluate(`app.plugins.plugins["vault-gantt"].activateApprovalView()`);
  const mcpSelector = `[data-preview-id="${data.previewId}"] button[data-action="approve"]`;
  await cdp.waitForExpression(`!!document.querySelector(${JSON.stringify(mcpSelector)})`, { timeoutMs: 10000, label: "MCP approval list" });
  assert.ok(!fs.readFileSync(path.join(vault, taskPath), "utf8").includes("MCP保存"));
  await cdp.evaluate(`document.querySelector(${JSON.stringify(mcpSelector)}).click()`);
  await cdp.waitForExpression(`app.plugins.plugins["vault-gantt"].previewPort.inspectOutcome(${JSON.stringify(data.previewId)})?.status === "success"`, { timeoutMs: 10000, label: "MCP human approval save" });
  const status = await client.callTool({ name: "previews.status", arguments: { previewId: data.previewId } });
  assert.equal(status.structuredContent.data.status, "committed"); assert.equal(status.structuredContent.data.descriptor.approvedEvent.kind, "approved");
  assert.ok(fs.readFileSync(path.join(vault, taskPath), "utf8").includes("MCP保存"));
  const pending = await client.callTool({ name: "operations.T07.propose", arguments: { callerIntentId: "p3-mcp-pending", input: { taskId: childId, name: "未保存" } } });
  await cdp.evaluate(`app.plugins.plugins["vault-gantt"].generateMcpToken(true)`);
  const revoked = await cdp.evaluate(`app.plugins.plugins["vault-gantt"].previewPort.inspect(${JSON.stringify(pending.structuredContent.data.previewId)}).status`);
  assert.equal(revoked, "revoked"); assert.ok(!fs.readFileSync(path.join(vault, taskPath), "utf8").includes("未保存"));
  console.log(JSON.stringify({ vault, chatProvider: "deterministic (no LLM)", chatCardApproveSave: "passed", ganttPreviewDock: "passed", approvalList: "passed", mcpLoopbackApproveSave: "passed", tokenRotationRevokesPending: "passed" }));
} finally {
  if (client) await client.close().catch(() => {});
  runtime?.kill();
  console.log(`P3 test Vault: ${vault}`);
}
