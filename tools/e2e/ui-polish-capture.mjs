// Real Obsidian, fresh synthetic vault and deterministic in-memory provider.
// No endpoint requests, credentials, real notes or saved chat history.
// Usage: TMPDIR=<scratchpad> node tools/e2e/ui-polish-capture.mjs <output-dir>
import fs from "node:fs";
import path from "node:path";
import { startObsidian, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";

// Chromium's Unix socket paths must stay below 108 bytes. A /proc FD alias
// keeps all temporary files inside the supplied scratchpad, with short paths.
const scratchFd = process.env.TMPDIR ? fs.openSync(process.env.TMPDIR, "r") : undefined;
if (scratchFd !== undefined) process.env.TMPDIR = `/proc/${process.pid}/fd/${scratchFd}`;
const out = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || fs.existsSync(path.join(out, "synthetic-vault"))) throw new Error("Specify a fresh output directory; existing vaults are never overwritten");
const vaultDir = path.join(out, "synthetic-vault");
const pluginDir = path.join(vaultDir, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const name of ["main.js", "styles.css", "manifest.json"]) fs.copyFileSync(path.resolve(name), path.join(pluginDir, name));
fs.writeFileSync(path.join(vaultDir, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(vaultDir, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureSyncEnabled: false, ganttFeatureWorkloadEnabled: false, ganttFeatureEventsEnabled: false, ganttFeatureDailyTodoEnabled: false, agentToolsEnabled: false, ganttZoom: 36 }));
const { buildFullNote } = await loadNoteFormatModule();
const notePath = "tasks/合成デザイン確認.md";
const common = { statusLabel: "active", completed: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const child = { ...common, kind: "subtask", id: notePath + "::design", key: "design", file: { path: notePath, parentPath: notePath, heading: "デザイン確認" }, title: "デザイン確認", displayName: "デザイン確認", ganttEnabled: false, plannedStartDate: "2026-10-01", plannedEndDate: "2026-10-03" };
const parent = { ...common, kind: "parent", id: notePath, file: { path: notePath }, title: "合成デザイン確認", displayName: "合成デザイン確認", ganttEnabled: true, ganttOrder: 0, subtasks: new Map([["design", child]]) };
fs.mkdirSync(path.join(vaultDir, "tasks"), { recursive: true });
fs.writeFileSync(path.join(vaultDir, notePath), buildFullNote(parent, parent.subtasks));
fs.writeFileSync(path.join(vaultDir, "合成UIテスト.md"), "# 合成UIテスト\n\n固定のFakeProviderを使用。ライブLLMへの接続なし。\n\n右の会話は合成データです。検索、変更案、確認後の結果を表示しています。\n");
let runtime;
try {
  runtime = await startObsidian({ vaultDir, obsidianBin: process.env.OBSIDIAN_BIN, display: process.env.DISPLAY || undefined });
  const { cdp } = runtime;
  await cdp.waitForExpression("!!app.plugins.manifests['vault-gantt']", { timeoutMs: 60000, intervalMs: 500, label: "Synthetic plugin manifest scanned" });
  await enablePlugin(cdp, "vault-gantt");
  // Dismiss any onboarding/trust dialog using its normal visible button.
  const modals = await cdp.evaluate(`Array.from(document.querySelectorAll('.modal button')).map(b => b.textContent)`);
  if (modals.length) {
    console.log("Startup dialog buttons:", modals);
    await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(b => /trust|信頼|enable|有効|了解|continue|続行/i.test(b.textContent)); if (b) b.click(); })()`);
  }
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "No trust/onboarding modal" });
  await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins['vault-gantt'];
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成UIテスト.md'));
    const session = plugin.chatSession;
    session.provider = {
      connected: config => config.model === 'fake-deterministic',
      stream: async function* () {
        const found = await plugin.operations.invoke('search', { query: 'デザイン確認' });
        yield { type: 'text', text: ${JSON.stringify('**合成テスト / FakeProvider** — ライブLLM未接続。\nデザイン確認を検索しました。開始・終了を3日後ろへ移す変更案です。')} };
        const input = { taskId: '${child.id}', patch: { plannedStartDate: '2026-10-04', plannedEndDate: '2026-10-06' } };
        const plan = await plugin.operations.plan('update', input);
        yield { type: 'plan', operation: 'update', input, plan };
        yield { type: 'context', messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'synthetic-search', toolName: 'search', output: { type: 'json', value: found } }] }] };
      }
    };
    session.configure({ provider: 'openai-compatible', endpoint: 'http://localhost:1/v1', model: 'fake-deterministic', auth: 'none', secretId: '' });
    await plugin.openAIChat('right');
    app.workspace.rightSplit.containerEl.style.width = '300px';
    const input = document.querySelector('.vg-ai-composer textarea');
    input.value = 'デザイン確認を3日後ろへずらして。';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.vg-ai-composer-actions button').click();
  })()`);
  await cdp.waitForExpression("document.querySelector('.vg-ai-diff')", { timeoutMs: 10000, label: "Fake proposal" });
  await cdp.evaluate(`Array.from(document.querySelectorAll('.vg-ai-diff button')).find(b => b.textContent === '確認して実行').click()`);
  await cdp.waitForExpression("document.querySelector('.vg-ai-diff')?.textContent.includes('保存済み')", { timeoutMs: 10000, label: "Synthetic commit result" });
  await cdp.evaluate(`document.activeElement?.blur()`);
  const measure = async () => cdp.evaluate(`(() => {
    const root = document.querySelector('.vg-ai-chat'); const header = root.querySelector('.vg-ai-header'); const composer = root.querySelector('.vg-ai-composer');
    const r = root.getBoundingClientRect(); const c = composer.getBoundingClientRect();
    return { width: r.width, headerHeight: header.getBoundingClientRect().height, composerBottomGap: r.bottom - c.bottom, overflow: root.scrollWidth > root.clientWidth, modal: !!document.querySelector('.modal-container'), text: root.innerText };
  })()`);
  const checks = { sidebarLight: await measure() };
  await cdp.screenshot(path.join(out, "chat-300-light-fake.png"));
  await cdp.evaluate("app.setTheme('obsidian')");
  checks.sidebarDark = await measure();
  await cdp.screenshot(path.join(out, "chat-300-dark-fake.png"));
  await cdp.evaluate(`(async () => {
    const leaf = app.workspace.getLeavesOfType('vault-gantt-ai-chat')[0];
    leaf.detach();
    await app.plugins.plugins['vault-gantt'].openAIChat('tab');
    app.workspace.rightSplit.collapse(); app.workspace.leftSplit.collapse();
    const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(900, 900);
  })()`);
  await cdp.waitForExpression("document.querySelector('.vg-ai-chat').getBoundingClientRect().width > 800", { timeoutMs: 10000, label: "Normal tab width" });
  checks.tabDark = await measure();
  await cdp.screenshot(path.join(out, "chat-tab-dark-fake.png"));
  fs.writeFileSync(path.join(out, "chat-checks.json"), JSON.stringify(checks, null, 2));
  for (const [name, check] of Object.entries(checks)) {
    if (check.overflow || check.modal || check.headerHeight !== 40 || check.composerBottomGap > 12) throw new Error(name + ': UI layout assertion failed: ' + JSON.stringify(check));
  }
  console.log(JSON.stringify(checks, null, 2));
} finally { runtime?.kill(); }
