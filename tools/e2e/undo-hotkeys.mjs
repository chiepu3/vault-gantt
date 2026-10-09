// View history hotkeys in real Obsidian, using an isolated synthetic vault.
// Run after npm run build: node tools/e2e/undo-hotkeys.mjs.
// The chat provider is deterministic; this test does not contact an LLM.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn } from "node:child_process";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "vg-undo-vault-"));
const pluginDir = path.join(vault, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const name of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(repo, name), path.join(pluginDir, name));
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false,
  ganttFeatureSyncEnabled: false, ganttNationalHolidays: [today], ganttNationalHolidaysUpdatedAt: new Date().toISOString(),
  mcp: { enabled: false } }));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
const taskPath = "tasks/P3確認.md", childId = `${taskPath}::review`;
const common = { statusLabel: "active", completed: false, createdAt: today, updatedAt: today, priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const child = { ...common, kind: "subtask", id: childId, key: "review", file: { path: taskPath, parentPath: taskPath, heading: "変更前" },
  title: "変更前", displayName: "変更前", ganttEnabled: false, plannedStartDate: today, plannedEndDate: today };
const parent = { ...common, kind: "parent", id: taskPath, file: { path: taskPath }, title: "P3確認", displayName: "P3確認", ganttEnabled: true, ganttOrder: 1000, subtasks: new Map([["review", child]]) };
const { buildFullNote } = await loadNoteFormatModule();
fs.mkdirSync(path.join(vault, "tasks")); fs.writeFileSync(path.join(vault, taskPath), buildFullNote(parent, parent.subtasks));
// Match ai-design-capture: own Xvfb, literal /tmp profile and own CDP log.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vg-undo-runtime-")), profile = path.join(root, "independent-profile"), temp = path.join(root, "runtime-temp");
for (const dir of [profile, temp]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ autoUpdate: false, vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));
function assertIsolation() {
  for (const dir of [vault, root, profile, temp]) assert.ok(fs.realpathSync(dir) === dir && dir.startsWith("/tmp/"));
}
assertIsolation();
let runtime, xvfb, obsidian;
async function stopOwnProcess(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await new Promise(resolve => setTimeout(resolve, 1000));
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function launch() {
  const displayNumber = 193, cdpPort = 19479;
  for (const port of [6000 + displayNumber, cdpPort]) await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(resolve)); });
  const spawnOwn = async (binary, args, env, logName) => {
    const log = fs.openSync(path.join(root, logName), "a");
    const child = spawn(binary, args, { cwd: repo, env, detached: true, stdio: ["ignore", log, log] }); fs.closeSync(log);
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); return child;
  };
  xvfb = await spawnOwn("Xvfb", [":193", "-screen", "0", "1920x1080x24", "-listen", "tcp", "-nolisten", "unix"], process.env, "xvfb.log");
  await pollUntil(() => new Promise(resolve => { const socket = net.connect(6193, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => { socket.destroy(); resolve(false); }); }), { timeoutMs: 10000, label: "own Xvfb" });
  assert.equal(xvfb.exitCode, null); assertIsolation();
  obsidian = await spawnOwn(process.env.OBSIDIAN_BIN ?? "/home/ryory/tools/obsidian-headless/squashfs-root/obsidian", [`--user-data-dir=${profile}`, "--remote-debugging-port=19479", "--disable-gpu"], { ...process.env, DISPLAY: "127.0.0.1:193", TMPDIR: temp }, "obsidian.log");
  await pollUntil(() => { assert.equal(obsidian.exitCode, null); return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes("DevTools listening on ws://127.0.0.1:19479/"); }, { timeoutMs: 45000, label: "own Obsidian CDP" });
  const cdp = await connectCdp(cdpPort);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "synthetic vault manifest" });
  assert.equal(await cdp.evaluate("app.vault.adapter.getBasePath()"), vault);
  return { cdp };
}

import { dragGesture, scrollBarIntoView } from "./scenarios/cdp-input.mjs";
const results = [];
const source = () => fs.readFileSync(path.join(vault, taskPath), "utf8");
async function key(cdp, letter, shift = false) {
  const modifiers = 2 | (shift ? 8 : 0);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", modifiers: 2, windowsVirtualKeyCode: 17 });
  if (shift) await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", modifiers, windowsVirtualKeyCode: 16 });
  for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: shift ? letter.toUpperCase() : letter, code: "Key" + letter.toUpperCase(), modifiers, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0) });
  if (shift) await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 2, windowsVirtualKeyCode: 16 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", modifiers: 0, windowsVirtualKeyCode: 17 });
}
async function waitSource(expected, label) { await pollUntil(() => source() === expected, { timeoutMs: 10000, label }); results.push(label); }
async function focus(cdp, selector) { await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); }
try {
  runtime = await launch(); const { cdp } = runtime;
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent))?.click()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { label: "trust dismissed" });
  await cdp.evaluate(`(async () => { const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080); await app.plugins.plugins['vault-gantt'].navigation.activateGanttView(); })()`);
  await cdp.waitForExpression("!!document.querySelector('.task-gantt-bar')", { label: "Gantt bar" });
  const original = source();
  const rect = await scrollBarIntoView(cdp, '.task-gantt-bar');
  const dayWidth = await cdp.evaluate("app.workspace.getLeavesOfType('task-gantt-view')[0].view.dayWidth");
  await dragGesture(cdp, { fromX: rect.left + rect.width / 2, fromY: rect.top + rect.height / 2, toX: rect.left + rect.width / 2 + dayWidth * 3, toY: rect.top + rect.height / 2 });
  await pollUntil(() => source() !== original, { timeoutMs: 10000, label: "drag saved" });
  await cdp.waitForExpression("app.plugins.plugins['vault-gantt'].historyManager.canUndo()", { label: "drag history" });
  const moved = source();
  assert.notEqual(moved, original);
  const afterDrag = await cdp.evaluate("({ focus: document.activeElement.className, type: document.activeElement.tagName })");
  await key(cdp, 'z'); await waitSource(original, "Gantt drag -> Ctrl+Z restores exact note");
  await focus(cdp, '.task-gantt-container');
  await key(cdp, 'z', true); await waitSource(moved, "Ctrl+Shift+Z restores dragged note");
  await focus(cdp, '.task-gantt-container'); await key(cdp, 'z'); await waitSource(original, "second Ctrl+Z");
  await focus(cdp, '.task-gantt-container'); await key(cdp, 'y'); await waitSource(moved, "Ctrl+Y restores dragged note");
  await cdp.evaluate("app.plugins.plugins['vault-gantt'].navigation.activateView()");
  await cdp.waitForExpression("!!document.querySelector('.task-workbench-container')", { label: "Workbench" });
  await focus(cdp, '.task-workbench-container'); await key(cdp, 'z'); await waitSource(original, "Workbench Ctrl+Z uses shared history");
  await focus(cdp, '.task-workbench-container'); await key(cdp, 'z', true); await waitSource(moved, "Workbench Ctrl+Shift+Z");
  // Real native input undo must not touch the plugin history.
  await cdp.evaluate("document.querySelector('.task-workbench-cell-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await cdp.waitForExpression("!!document.querySelector('.task-workbench-title-textarea')", { label: "inline editor" });
  await focus(cdp, '.task-workbench-title-textarea');
  const inputBefore = await cdp.evaluate("document.querySelector('.task-workbench-title-textarea').value");
  await cdp.send("Input.insertText", { text: "native input" }); await key(cdp, 'z');
  assert.equal(source(), moved);
  assert.equal(await cdp.evaluate("document.querySelector('.task-workbench-title-textarea').value"), inputBefore);
  await cdp.send("Input.dispatchKeyEvent", { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  results.push("Workbench inline textarea keeps native Ctrl+Z");
  await focus(cdp, '.task-workbench-container'); await key(cdp, 'z'); await waitSource(original, "Workbench undo before Ctrl+Y");
  await focus(cdp, '.task-workbench-container'); await key(cdp, 'y'); await waitSource(moved, "Workbench Ctrl+Y");
  // Chat goes through the same approval and history ports as the normal UI.
  await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins['vault-gantt'];
    plugin.chatSession.provider = { connected: () => true, async *stream(request) {
      const input = { taskId: ${JSON.stringify(childId)}, name: 'AI履歴確認' };
      const preview = await plugin.operationService.propose('T07', input, { vaultInstanceId: plugin.operationService.vaultInstanceId, principalId: 'obsidian-chat', origin: { kind: 'chat', conversationId: request.conversationId }, capabilities: ['read', 'propose'], requestId: 'undo-chat', signal: request.signal });
      yield { type: 'plan', preview, operationId: 'T07', plan: plugin.operationService.legacyPlan(preview), operation: 'update', input };
    } };
    plugin.chatSession.configure({ provider: 'openai-compatible', endpoint: 'http://localhost:1/v1', model: 'fake-model', auth: 'none', secretId: '' });
    await plugin.openAIChat('tab');
    const input = document.querySelector('.vg-ai-composer textarea'); input.value = '名前変更'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.vg-ai-send').click();
  })()`);
  await cdp.waitForExpression("!!document.querySelector('button[data-action=approve]')", { label: "AI proposal" });
  await cdp.evaluate("document.querySelector('button[data-action=approve]').click()");
  await cdp.waitForExpression("app.plugins.plugins['vault-gantt'].previewPort.list().some(p => p.status === 'success')", { label: "AI save" });
  const aiSaved = source(); assert.ok(aiSaved.includes('AI履歴確認'));
  const history = await cdp.evaluate("(() => { const p = app.plugins.plugins['vault-gantt']; const preview = p.previewPort.list().find(p => p.status === 'success'); const outcome = p.previewPort.inspectOutcome(preview.previewId); return { entry: outcome.undoEntryId, top: p.historyManager.peekUndoLabel() }; })()");
  assert.equal(history.entry, history.top);
  await cdp.evaluate("app.plugins.plugins['vault-gantt'].navigation.activateGanttView()");
  await focus(cdp, '.task-gantt-container'); await key(cdp, 'z'); await waitSource(moved, "AI chat save undone by Gantt Ctrl+Z");
  await focus(cdp, '.task-gantt-container'); await key(cdp, 'y'); await waitSource(aiSaved, "AI chat save redone by Ctrl+Y");
  // Keep a real Markdown editor open beside the plugin; native note undo wins.
  await cdp.evaluate(`(async () => { const file = await app.vault.create('editor-undo.md', '# Editor\\n'); const leaf = app.workspace.getLeaf('split'); await leaf.openFile(file); leaf.view.editor.focus(); })()`);
  await cdp.send("Input.insertText", { text: "native markdown edit" });
  await cdp.waitForExpression("app.workspace.activeLeaf.view.editor.getValue().includes('native markdown edit')", { label: "Markdown inserted" });
  await key(cdp, 'z');
  await cdp.waitForExpression("!app.workspace.activeLeaf.view.editor.getValue().includes('native markdown edit')", { label: "Markdown native undo" });
  assert.equal(source(), aiSaved); results.push("Markdown editor Ctrl+Z preserves plugin history");
  const report = { ok: true, afterDrag, history, results, vault, profile, runtimeLog: path.join(root, 'obsidian.log'),
    originalDates: original.split('\n').filter(line => /subtask__review__planned(Start|End)Date:/.test(line)),
    movedDates: moved.split('\n').filter(line => /subtask__review__planned(Start|End)Date:/.test(line)) };
  const artifacts = path.join(repo, 'tools/e2e/artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'undo-hotkeys-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  runtime?.cdp?.close(); await Promise.all([stopOwnProcess(obsidian), stopOwnProcess(xvfb)]);
}
