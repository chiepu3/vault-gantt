// P3: real Obsidian UI + operation runtime + authenticated loopback MCP.
// The chat provider is deterministic; this test does not contact an LLM.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import net from "node:net";
import { spawn } from "node:child_process";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
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
// Match ai-design-capture: own Xvfb, literal /tmp profile and own CDP log.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vg-p3-runtime-")), profile = path.join(root, "independent-profile"), temp = path.join(root, "runtime-temp");
for (const dir of [profile, temp]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));
const reviewFixes = process.env.VG_REVIEW_FIXES === "1";
const outDir = reviewFixes ? "/mnt/d/vault-gantt-ai-design/v7-fix" : "/mnt/d/vault-gantt-ai-design/v5-integration";
function assertIsolation() {
  for (const dir of [vault, root, profile, temp]) assert.ok(fs.realpathSync(dir) === dir && dir.startsWith("/tmp/"));
  for (let dir = outDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) { const stat = fs.lstatSync(dir); assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); assert.ok(!fs.existsSync(path.join(dir, ".obsidian"))); }
    if (dir === path.dirname(dir)) break;
  }
}
assertIsolation(); fs.mkdirSync(outDir, { recursive: true }); assertIsolation();
let runtime, client, stdioClient, xvfb, obsidian;
const measurements = [], monthChecks = [];
async function stopOwnProcess(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await new Promise(resolve => setTimeout(resolve, 1000));
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function launch() {
  const displayNumber = 91, cdpPort = 9477;
  for (const port of [6000 + displayNumber, cdpPort]) await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(resolve)); });
  const spawnOwn = async (binary, args, env, logName) => {
    const log = fs.openSync(path.join(root, logName), "a");
    const child = spawn(binary, args, { cwd: repo, env, detached: true, stdio: ["ignore", log, log] }); fs.closeSync(log);
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); return child;
  };
  xvfb = await spawnOwn("Xvfb", [":91", "-screen", "0", "1920x1080x24", "-listen", "tcp", "-nolisten", "unix"], process.env, "xvfb.log");
  await pollUntil(() => new Promise(resolve => { const socket = net.connect(6091, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => { socket.destroy(); resolve(false); }); }), { timeoutMs: 10000, label: "own Xvfb" });
  assert.equal(xvfb.exitCode, null); assertIsolation();
  obsidian = await spawnOwn(process.env.OBSIDIAN_BIN ?? "/home/ryory/tools/obsidian-headless/squashfs-root/obsidian", [`--user-data-dir=${profile}`, "--remote-debugging-port=9477", "--disable-gpu"], { ...process.env, DISPLAY: "127.0.0.1:91", TMPDIR: temp }, "obsidian.log");
  await pollUntil(() => { assert.equal(obsidian.exitCode, null); return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes("DevTools listening on ws://127.0.0.1:9477/"); }, { timeoutMs: 45000, label: "own Obsidian CDP" });
  const cdp = await connectCdp(cdpPort);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "synthetic vault manifest" });
  assert.equal(await cdp.evaluate("app.vault.adapter.getBasePath()"), vault);
  return { cdp };
}
const screenshots = [], runId = new Date().toISOString().replace(/[:.]/g, "-");
async function shot(cdp, name) {
  await cdp.evaluate("document.activeElement?.blur()"); await new Promise(resolve => setTimeout(resolve, 400)); assertIsolation();
  const file = path.join(outDir, `${runId}-${name}.png`), image = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(image.data, "base64"), { flag: "wx" }); screenshots.push(file);
}
async function setTheme(cdp, theme) {
  await cdp.evaluate(`(() => { app.setTheme(${JSON.stringify(theme)}); app.vault.setConfig('theme', ${JSON.stringify(theme)}); app.workspace.trigger('css-change'); })()`);
  const bodyClass = theme === "obsidian" ? "theme-dark" : "theme-light";
  await cdp.waitForExpression(`document.body.classList.contains(${JSON.stringify(bodyClass)})`, { timeoutMs: 10000, label: bodyClass });
}

try {
  runtime = await launch();
  const { cdp } = runtime;
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { Array.from(document.querySelectorAll('.modal button')).find(button => /Trust author|信頼/.test(button.textContent))?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "trust author" });
  await cdp.evaluate(`(() => { const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080); app.setTheme('moonstone'); })()`);
  const initial = await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins["vault-gantt"];
    try { await plugin.configureMcp(); } catch (error) { throw new Error("MCP startup: " + error.message + "; Node=" + process.versions.node); }
    const taskId = ${JSON.stringify(childId)};
    plugin.chatSession.provider = { connected: () => true, async *stream(request) {
      const preview = await plugin.operationService.propose("T07", { taskId, name: "チャット保存" }, {
        vaultInstanceId: plugin.operationService.vaultInstanceId, principalId: "obsidian-chat", origin: { kind: "chat", conversationId: request.conversationId },
        capabilities: ["read", "propose"], requestId: "p3-chat", signal: request.signal
      });
      yield { type: "plan", preview, operationId: "T07", plan: plugin.operationService.legacyPlan(preview), operation: "update", input: { taskId, patch: { displayName: "チャット保存" } } };
    } };
    plugin.chatSession.configure({ provider: "openai-compatible", endpoint: "http://localhost:1/v1", model: "fake-model", auth: "none", secretId: "" });
    await plugin.openAIChat("tab");
    const input = document.querySelector(".vg-ai-composer textarea"); input.value = "子タスクの名前をチャット保存へ変更"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".vg-ai-send").click();
    await new Promise(resolve => { const unsubscribe = plugin.chatSession.subscribe(() => { if (plugin.chatSession.active.status !== "running") { unsubscribe(); resolve(); } }); });
    const preview = plugin.previewPort.list().find(p => p.origin.kind === "chat");
    return { previewId: preview.previewId, status: preview.status, content: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(taskPath)})), endpoint: plugin.getMcpStatus() };
  })()`);
  assert.equal(initial.status, "pending"); assert.ok(initial.content.includes("変更前")); assert.ok(!initial.content.includes("チャット保存"));
  const cardSelector = `[data-preview-id="${initial.previewId}"]`;
  await cdp.waitForExpression(`!!document.querySelector(${JSON.stringify(cardSelector + ' button[data-action="approve"]')})`, { timeoutMs: 10000, label: "chat approval card" });
  await shot(cdp, "01-chat-proposal");
  await cdp.evaluate(`document.querySelector(${JSON.stringify(cardSelector + ' button[data-action="focus"]')}).click()`);
  await cdp.waitForExpression(`!!document.querySelector(".vg-pv-dockhost:not([hidden])")`, { timeoutMs: 10000, label: "Gantt preview dock" });
  await cdp.evaluate(`app.plugins.plugins["vault-gantt"].openAIChat("tab")`);
  await cdp.evaluate(`document.querySelector(${JSON.stringify(cardSelector + ' button[data-action="approve"]')}).click()`);
  await cdp.waitForExpression(`app.plugins.plugins["vault-gantt"].previewPort.inspectOutcome(${JSON.stringify(initial.previewId)})?.status === "success"`, { timeoutMs: 10000, label: "chat approval save" });
  assert.ok(fs.readFileSync(path.join(vault, taskPath), "utf8").includes("チャット保存"));
  await shot(cdp, "02-chat-saved");
  if (reviewFixes) {
    await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins["vault-gantt"];
      await plugin.uiPort.request("V02", { position: "tab" });
      const view = app.workspace.getLeavesOfType("task-gantt-view")[0].view;
      view.scrollToDate(${JSON.stringify(today)}, 140);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const created = await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins["vault-gantt"];
      plugin.chatSession.provider = { connected: () => true, async *stream(request) {
        const input = { parentId: ${JSON.stringify(taskPath)}, name: "作成案の確認", date: ${JSON.stringify(today)} };
        const preview = await plugin.operationService.propose("T06", input, {
          vaultInstanceId: plugin.operationService.vaultInstanceId, principalId: "obsidian-chat", origin: { kind: "chat", conversationId: request.conversationId },
          capabilities: ["read", "propose"], requestId: "v7-create", signal: request.signal
        });
        yield { type: "plan", preview, operationId: "T06", plan: plugin.operationService.legacyPlan(preview), operation: "update", input };
      } };
      await plugin.openAIChat("tab");
      const input = document.querySelector(".vg-ai-composer textarea"); input.value = "今日の子タスクを作成して"; input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".vg-ai-send").click();
      await new Promise(resolve => { const unsubscribe = plugin.chatSession.subscribe(() => { if (plugin.chatSession.active.status !== "running") { unsubscribe(); resolve(); } }); });
      return plugin.previewPort.list().find(p => p.operationId === "T06").previewId;
    })()`);
    const createCard = `[data-preview-id="${created}"]`;
    await cdp.waitForExpression(`!!document.querySelector(${JSON.stringify(createCard + ' button[data-action="focus"]')})`, { timeoutMs: 10000, label: "creation card" });
    await cdp.evaluate(`document.querySelector(${JSON.stringify(createCard + ' button[data-action="focus"]')}).click()`);
    await cdp.waitForExpression(`!!document.querySelector(".vg-pv-dockhost:not([hidden])")`, { timeoutMs: 10000, label: "creation Gantt preview" });
    await cdp.waitForExpression(`app.workspace.getActiveViewOfType ? app.workspace.activeLeaf?.view?.getViewType() === 'task-gantt-view' : false`, { timeoutMs: 10000, label: "visible Gantt tab" });
    for (const theme of ["moonstone", "obsidian"]) {
      await setTheme(cdp, theme);
      await new Promise(resolve => setTimeout(resolve, 500));
      const month = await cdp.evaluate(`(() => {
        const view = app.workspace.getLeavesOfType("task-gantt-view")[0].view;
        const date = view.getVisibleStartDate(), parts = date.split('-');
        return { date, text: view.floatingMonthEl.textContent, expected: parts[0] + '年' + Number(parts[1]) + '月', rangeStart: view.rangeStart, scrollLeft: view.wrapEl.scrollLeft, extending: view.isExtendingRange, cached: view.lastFloatingMonth, connected: view.floatingMonthEl.isConnected, domText: document.querySelector('.task-gantt-floating-month')?.textContent, bodyTheme: document.body.classList.contains('theme-dark') ? 'dark' : 'light' };
      })()`);
      console.log(JSON.stringify({ monthDiagnostic: month }));
      await shot(cdp, `05-create-gantt-${theme}`);
      assert.equal(month.text, month.expected); monthChecks.push({ theme, ...month });
      assert.equal(month.date.slice(0, 7), today.slice(0, 7));
      assert.equal(month.bodyTheme, theme === "obsidian" ? "dark" : "light");
    }
    await setTheme(cdp, "moonstone"); await cdp.evaluate(`app.plugins.plugins["vault-gantt"].openAIChat("tab")`);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(createCard + ' button[data-action="approve"]')}).click()`);
    await cdp.waitForExpression(`app.plugins.plugins["vault-gantt"].previewPort.inspectOutcome(${JSON.stringify(created)})?.status === "success"`, { timeoutMs: 10000, label: "creation saved" });
    assert.ok(fs.readFileSync(path.join(vault, taskPath), "utf8").includes("作成案の確認"));
  }
  // Keep credentials in memory; never include them in logs/artifacts.
  const connection = await cdp.evaluate(`({ endpoint: app.plugins.plugins["vault-gantt"].mcpServer?.endpoint, token: app.plugins.plugins["vault-gantt"].mcpServer?.sessionToken, vaultInstanceId: app.plugins.plugins["vault-gantt"].operationService.vaultInstanceId })`);
  assert.ok(connection.endpoint?.startsWith("http://127.0.0.1:"));
  client = new Client({ name: "p3-real-obsidian", version: "1" });
  const httpStart = performance.now();
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.endpoint), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
  if (reviewFixes) {
    const connected = performance.now(); const tools = await client.listTools(); const listed = performance.now();
    const read = await client.callTool({ name: "context.overview", arguments: {} }); assert.ok(!read.isError); const end = performance.now();
    measurements.push({ transport: "HTTP", connectMs: connected - httpStart, schemaListMs: listed - connected, firstReadMs: end - listed, totalMs: end - httpStart, tools: tools.tools.length });
    stdioClient = new Client({ name: "v7-real-stdio", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, "tools/mcp-bridge/dist/bridge.cjs")], env: { VAULT_GANTT_MCP_URL: connection.endpoint, VAULT_GANTT_MCP_TOKEN: connection.token, VAULT_GANTT_MCP_VAULT_INSTANCE_ID: connection.vaultInstanceId }, stderr: "pipe" });
    const start = performance.now(); await stdioClient.connect(transport, { timeout: 15000 }); const stdioConnected = performance.now();
    const stdioTools = await stdioClient.listTools(); const stdioListed = performance.now();
    const result = await stdioClient.callTool({ name: "context.overview", arguments: {} }); assert.ok(!result.isError); const stdioEnd = performance.now();
    measurements.push({ transport: "stdio", connectMs: stdioConnected - start, schemaListMs: stdioListed - stdioConnected, firstReadMs: stdioEnd - stdioListed, totalMs: stdioEnd - start, tools: stdioTools.tools.length });
    await stdioClient.close(); stdioClient = undefined;
  }
  const proposal = await client.callTool({ name: "operations.T07.propose", arguments: { callerIntentId: "p3-mcp-rename", input: { taskId: childId, name: "MCP保存" } } });
  assert.ok(!proposal.isError, JSON.stringify(proposal));
  const data = proposal.structuredContent.data;
  await cdp.evaluate(`app.plugins.plugins["vault-gantt"].activateApprovalView()`);
  const mcpSelector = `[data-preview-id="${data.previewId}"] button[data-action="approve"]`;
  await cdp.waitForExpression(`!!document.querySelector(${JSON.stringify(mcpSelector)})`, { timeoutMs: 10000, label: "MCP approval list" });
  assert.ok(!fs.readFileSync(path.join(vault, taskPath), "utf8").includes("MCP保存"));
  await shot(cdp, "03-mcp-approval-list");
  await cdp.evaluate(`document.querySelector(${JSON.stringify(mcpSelector)}).click()`);
  await cdp.waitForExpression(`app.plugins.plugins["vault-gantt"].previewPort.inspectOutcome(${JSON.stringify(data.previewId)})?.status === "success"`, { timeoutMs: 10000, label: "MCP human approval save" });
  const status = await client.callTool({ name: "previews.status", arguments: { previewId: data.previewId } });
  assert.equal(status.structuredContent.data.status, "committed"); assert.equal(status.structuredContent.data.descriptor.approvedEvent.kind, "approved");
  assert.ok(fs.readFileSync(path.join(vault, taskPath), "utf8").includes("MCP保存"));
  await shot(cdp, "04-mcp-saved");
  const pending = await client.callTool({ name: "operations.T07.propose", arguments: { callerIntentId: "p3-mcp-pending", input: { taskId: childId, name: "未保存" } } });
  await cdp.evaluate(`app.plugins.plugins["vault-gantt"].generateMcpToken(true)`);
  const revoked = await cdp.evaluate(`app.plugins.plugins["vault-gantt"].previewPort.inspect(${JSON.stringify(pending.structuredContent.data.previewId)}).status`);
  assert.equal(revoked, "revoked"); assert.ok(!fs.readFileSync(path.join(vault, taskPath), "utf8").includes("未保存"));
  console.log(JSON.stringify({ vault, root, screenshots, measurements, monthChecks, chatProvider: "deterministic (no LLM)", chatCardApproveSave: "passed", ganttPreviewDock: "passed", approvalList: "passed", mcpLoopbackApproveSave: "passed", tokenRotationRevokesPending: "passed" }));
} finally {
  if (client) await client.close().catch(() => {});
  if (stdioClient) await stdioClient.close().catch(() => {});
  runtime?.cdp.close();
  await Promise.all([stopOwnProcess(obsidian), stopOwnProcess(xvfb)]);
  console.log(`P3 test Vault: ${vault}`);
}
