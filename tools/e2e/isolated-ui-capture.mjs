// Real Obsidian/CDP against a fresh /tmp scratchpad only. No real profiles.
// Usage: node tools/e2e/isolated-ui-capture.mjs chat|ghost
// Both modes build the current UI. Chat screenshots never open the Gantt pane.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";

const mode = process.argv[2];
if (!["chat", "ghost"].includes(mode)) throw new Error("Specify chat or ghost");
const root = fs.mkdtempSync(`/tmp/vg-ui-${mode}-`);
const vault = path.join(root, "synthetic-vault");
const profile = path.join(root, "independent-profile");
const temp = path.join(root, "runtime-temp");
for (const dir of [vault, profile, temp]) fs.mkdirSync(dir);
const pluginDir = path.join(vault, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
const source = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
await build({
  entryPoints: [path.join(source, "src/main.ts")], bundle: true, format: "cjs", target: "ES2018", minify: true,
  nodePaths: [path.join(process.cwd(), "node_modules")], outfile: path.join(pluginDir, "main.js"),
  define: { __VG_VERSION__: JSON.stringify(manifest.version), __VG_COMMIT__: JSON.stringify(mode === "chat" ? "d7d7a3d" : "ghost-ui-test"), __VG_BUILT_AT__: JSON.stringify("synthetic-ui-test") },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
});
for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(pluginDir, file));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureSyncEnabled: false, ganttFeatureWorkloadEnabled: false, ganttFeatureEventsEnabled: false, ganttFeatureDailyTodoEnabled: false, agentToolsEnabled: false, ganttZoom: 36 }));
const { buildFullNote } = await loadNoteFormatModule();
const notePath = "tasks/合成デザイン確認.md";
const common = { statusLabel: "active", completed: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const child = { ...common, kind: "subtask", id: notePath + "::design", key: "design", file: { path: notePath, parentPath: notePath, heading: "デザイン確認" }, title: "デザイン確認", displayName: "デザイン確認", ganttEnabled: false, plannedStartDate: "2026-10-01", plannedEndDate: "2026-10-03" };
const parent = { ...common, kind: "parent", id: notePath, file: { path: notePath }, title: "合成デザイン確認", displayName: "合成デザイン確認", ganttEnabled: true, ganttOrder: 0, subtasks: new Map([["design", child]]) };
fs.mkdirSync(path.join(vault, "tasks"));
fs.writeFileSync(path.join(vault, notePath), buildFullNote(parent, parent.subtasks));
fs.writeFileSync(path.join(vault, "合成UIテスト.md"), "# 合成UIテスト\n\n固定FakeProvider / ライブLLM未接続。\n\n新規の合成Vaultと独立プロファイルのみを使用しています。\n");
const profileConfig = path.join(profile, "obsidian.json");
fs.writeFileSync(profileConfig, JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));

function assertNoSymlinks(dir) {
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Symlink rejected: " + dir);
  if (fs.statSync(dir).isDirectory()) for (const entry of fs.readdirSync(dir)) assertNoSymlinks(path.join(dir, entry));
}
function assertIsolation() {
  for (const dir of [root, vault, profile, temp]) {
    if (fs.realpathSync(dir) !== dir || !dir.startsWith("/tmp/")) throw new Error("Not a literal /tmp realpath: " + dir);
  }
  assertNoSymlinks(root);
  if (profile.startsWith(vault + "/") || vault.startsWith(profile + "/") || profile === vault) throw new Error("Profile is not separate");
  const registered = Object.values(JSON.parse(fs.readFileSync(profileConfig, "utf8")).vaults);
  if (registered.length !== 1 || registered[0].path !== vault) throw new Error("Unexpected registered vault");
  if (fs.existsSync(path.join(vault, ".obsidian/plugins/remotely-save"))) throw new Error("RemotelySave must be absent");
  console.log("PRE-LAUNCH ISOLATION", JSON.stringify({ root, vault, profile, registeredVaults: registered.map(v => v.path), noSymlinks: true, remotelySaveAbsent: true }));
}
assertIsolation();
const binary = process.env.OBSIDIAN_BIN ?? "/home/ryory/tools/obsidian-headless/squashfs-root/obsidian";
let xvfb; let obsidian; let cdp;
const checks = {};
try {
  // Dedicated display, no -ac or sandbox-bypass flags. Never reuse a user app.
  const display = process.env.DISPLAY || "127.0.0.1:90";
  if (!process.env.DISPLAY) {
    const xvfbLog = fs.openSync(path.join(root, "xvfb.log"), "a");
    xvfb = spawn("Xvfb", [":90", "-screen", "0", "1920x1080x24", "-listen", "tcp", "-nolisten", "unix"], { stdio: ["ignore", xvfbLog, xvfbLog] });
    fs.closeSync(xvfbLog);
    await pollUntil(() => new Promise(resolve => {
      const socket = net.connect(6090, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    }), { timeoutMs: 10000, label: "Dedicated Xvfb TCP 6090" });
    if (xvfb.exitCode !== null) throw new Error("Dedicated Xvfb exited; refusing to reuse another display");
  }
  // Refuse an occupied CDP port so we can never attach to another instance.
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(9476, "127.0.0.1", () => server.close(resolve));
  });
  // Revalidate immediately before spawning, after all fixture writes.
  assertIsolation();
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  obsidian = spawn(binary, [`--user-data-dir=${profile}`, "--remote-debugging-port=9476", "--disable-gpu"], {
    cwd: process.cwd(), env: { ...process.env, DISPLAY: display, TMPDIR: temp }, stdio: ["ignore", log, log], detached: true,
  });
  fs.closeSync(log);
  await pollUntil(() => {
    if (obsidian.exitCode !== null) throw new Error("Own Obsidian process exited; refusing CDP attach");
    return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes("DevTools listening on ws://127.0.0.1:9476/");
  }, { timeoutMs: 45000, label: "Own Obsidian CDP endpoint in isolated log" });
  cdp = await connectCdp(9476);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "Synthetic manifest loaded" });
  const openedPath = await cdp.evaluate("app.vault.adapter.getBasePath()");
  if (openedPath !== vault) throw new Error("Runtime vault mismatch; refusing any UI interaction");
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent)); button?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "Trust dialog normally dismissed" });
  await cdp.evaluate(`(async () => {
    const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080);
    const plugin = app.plugins.plugins['vault-gantt'];
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成UIテスト.md'));
    const session = plugin.chatSession;
    session.provider = {
      connected: config => config.model === 'fake-deterministic-long-model-name-for-truncation',
      stream: async function* () {
        const found = await plugin.operations.invoke('search', { query: 'デザイン確認' });
        yield { type: 'text', text: ${JSON.stringify("**合成 / FakeProvider** · ライブLLM未接続\n検索1件。3日後ろへ移動する案です。")} };
        const input = { taskId: ${JSON.stringify(child.id)}, patch: { plannedStartDate: '2026-10-04', plannedEndDate: '2026-10-06' } };
        const plan = await plugin.operations.plan('update', input);
        yield { type: 'plan', operation: 'update', input, plan };
        yield { type: 'context', messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'synthetic-search', toolName: 'search', output: { type: 'json', value: found } }] }] };
      }
    };
    session.configure({ provider: 'openai-compatible', endpoint: 'http://localhost:1/v1', model: 'fake-deterministic-long-model-name-for-truncation', auth: 'none', secretId: '' });
    await plugin.openAIChat('right');
    app.workspace.rightSplit.containerEl.style.width = '300px';
    const input = document.querySelector('.vg-ai-composer textarea'); input.value = 'デザイン確認を3日後ろへずらして。';
    input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.vg-ai-send').click();
  })()`);
  await cdp.waitForExpression("document.querySelector('.vg-ai-diff button')", { label: "Synthetic proposal" });
  await cdp.evaluate(`Array.from(document.querySelectorAll('.vg-ai-diff button')).find(b => b.textContent === '確認して実行').click()`);
  await cdp.waitForExpression("document.querySelector('.vg-ai-diff')?.textContent.includes('適用済み')", { label: "Synthetic result" });
  if (mode === "ghost") {
    await cdp.evaluate("app.plugins.plugins['vault-gantt'].navigation.activateGanttView()");
    await cdp.waitForExpression("document.querySelector('.vg-ai-ghost')", { label: "Old ghost alongside current bar" });
  }
  const measure = () => cdp.evaluate(`(() => {
    const root = document.querySelector('.vg-ai-chat'); const r = root.getBoundingClientRect(); const model = root.querySelector('[aria-label="モデルを選択"]');
    const composer = root.querySelector('.vg-ai-composer').getBoundingClientRect();
    const header = root.querySelector('.vg-ai-header-content').getBoundingClientRect();
    const user = root.querySelector('.vg-ai-user').getBoundingClientRect();
    const controls = Array.from(root.querySelectorAll('.vg-ai-icon-button')).map(el => {
      const a = el.getBoundingClientRect(); const b = el.querySelector('svg').getBoundingClientRect();
      return { width: a.width, height: a.height, iconWidth: b.width, iconHeight: b.height, centerX: Math.abs(a.left + a.width / 2 - b.left - b.width / 2), centerY: Math.abs(a.top + a.height / 2 - b.top - b.height / 2) };
    });
    const undo = Array.from(root.querySelectorAll('.vg-ai-diff button')).find(b => b.textContent === '元に戻す');
    const footer = document.querySelector('.status-bar')?.getBoundingClientRect();
    const footerOverlap = !!footer && footer.height > 0 && footer.left < composer.right && footer.right > composer.left && footer.top < composer.bottom;
    const old = document.querySelector('.vg-ai-ghost'); const current = document.querySelector('.vg-ai-target');
    const oldRect = old?.getBoundingClientRect(); const currentRect = current?.getBoundingClientRect();
    const ghost = old ? { oldHeight: oldRect.height, oldBorder: getComputedStyle(old).borderTopStyle, currentHeight: currentRect?.height, laneGap: currentRect ? currentRect.top - oldRect.bottom : null, currentOutline: current ? getComputedStyle(current).outlineStyle : null, oldStartArrow: getComputedStyle(old, '::before').content, oldEndArrow: getComputedStyle(old, '::after').content, currentStartArrow: current ? getComputedStyle(current.querySelector('.task-gantt-resize-start'), '::after').content : null, currentEndArrow: current ? getComputedStyle(current.querySelector('.task-gantt-resize-end'), '::after').content : null, legend: document.querySelector('.vg-ai-legend')?.textContent, label: document.querySelector('.vg-ai-target-label')?.textContent, oldLeft: old.style.left, currentLeft: current?.style.left, rowHeight: old.parentElement.style.height } : null;
    return { vault: app.vault.adapter.getBasePath(), width: r.width, headerHeight: root.querySelector('.vg-ai-header').getBoundingClientRect().height, composerBottomGap: r.bottom - composer.bottom, footerOverlap, theme: document.body.classList.contains('theme-dark') ? 'dark' : 'light', modelTag: model?.tagName, modelVisible: !!model && model.getBoundingClientRect().height > 0, model: model?.dataset.model, modelWidth: model?.getBoundingClientRect().width, modelTruncated: root.querySelector('.vg-ai-model-label').scrollWidth > root.querySelector('.vg-ai-model-label').clientWidth, nativeComposerSelects: root.querySelectorAll('.vg-ai-composer select').length, grid: { headerLeft: header.left, userLeft: user.left, composerLeft: composer.left, headerWidth: header.width, userWidth: user.width, composerWidth: composer.width }, controls, undoDisabled: undo?.disabled, resultTimelineRows: root.querySelectorAll('.vg-ai-mini-row').length, resultStatusCount: root.querySelectorAll('.vg-ai-result-status').length, modal: !!document.querySelector('.modal-container'), overflow: root.scrollWidth > root.clientWidth, ghost, text: root.innerText };
  })()`);
  await cdp.evaluate("document.activeElement?.blur()");
  checks.narrowLight = await measure();
  await cdp.screenshot(path.join(root, `${mode}-300-light-fake.png`));
  fs.writeFileSync(path.join(root, "checks.json"), JSON.stringify(checks, null, 2));
  console.log("LIGHT GANTT MEASUREMENTS", JSON.stringify(checks.narrowLight));
  if (mode === "chat") {
    await cdp.evaluate(`(async () => {
      app.workspace.getLeavesOfType('vault-gantt-ai-chat')[0].detach();
      await app.plugins.plugins['vault-gantt'].openAIChat('tab');
      app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
      const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(960, 900);
    })()`);
    await cdp.waitForExpression("document.querySelector('.vg-ai-chat').getBoundingClientRect().width >= 850", { label: "Wide Chat tab" });
    checks.wideLight = await measure();
    await cdp.screenshot(path.join(root, "chat-wide-light-fake.png"));
  }
  fs.writeFileSync(path.join(root, "checks.json"), JSON.stringify(checks, null, 2));
  console.log("CAPTURE RESULT", root, JSON.stringify(checks, null, 2));
  for (const [name, check] of Object.entries(checks)) {
    if (check.vault !== vault || check.modal || check.overflow || check.modelTag !== "BUTTON" || !check.modelVisible || check.headerHeight !== 40 || check.composerBottomGap > 12 || check.footerOverlap) throw new Error(name + " failed: " + JSON.stringify(check));
    if (check.nativeComposerSelects || check.modelWidth > 150 || !check.modelTruncated || check.resultTimelineRows !== 2 || check.resultStatusCount !== 1 || check.text.includes('updatedAt') || !check.text.includes('+3d')) throw new Error(name + " compact UI failed: " + JSON.stringify(check));
    if (Math.abs(check.grid.headerLeft - check.grid.composerLeft) > 1 || Math.abs(check.grid.userLeft - check.grid.composerLeft) > 1 || Math.abs(check.grid.userWidth - check.grid.composerWidth) > 1 || Math.abs(check.grid.headerWidth - check.grid.composerWidth) > 1) throw new Error(name + " shared grid failed: " + JSON.stringify(check));
    if (check.controls.length !== 3 || check.controls.some(c => c.width !== 32 || c.height !== 32 || c.iconWidth !== 16 || c.iconHeight !== 16 || c.centerX > 1 || c.centerY > 1)) throw new Error(name + " IconButton alignment failed: " + JSON.stringify(check));
    if (mode === "ghost" && (!check.ghost || check.ghost.oldHeight !== 9 || check.ghost.oldBorder !== "dashed" || check.ghost.currentHeight !== 24 || check.ghost.laneGap < 2 || check.ghost.currentOutline !== "none" || !check.ghost.oldStartArrow.includes("‹") || !check.ghost.oldEndArrow.includes("›") || !check.ghost.currentStartArrow?.includes("‹") || !check.ghost.currentEndArrow?.includes("›") || !check.ghost.legend?.includes("上: 前") || !check.ghost.label.includes("3日後ろへ") || check.undoDisabled !== false)) throw new Error(name + " Gantt marks failed: " + JSON.stringify(check));
  }
} finally {
  cdp?.close();
  if (obsidian?.pid) { try { process.kill(-obsidian.pid, "SIGTERM"); } catch { /* already exited */ } }
  xvfb?.kill("SIGTERM");
}
