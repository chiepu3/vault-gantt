// Real Obsidian/CDP against a fresh /tmp scratchpad only. No real profiles.
// Usage: node tools/e2e/ai-design-capture.mjs chat|ghost [prefix] [outDir under OS temp]
// Both modes build the current UI. Chat screenshots never open the Gantt pane.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";

const mode = process.argv[2];
if (!["chat", "ghost"].includes(mode)) throw new Error("Specify chat or ghost");
const source = process.cwd();
const prefix = process.argv[3] ?? "shot";
if (!prefix || /[/\\]/.test(prefix) || prefix.includes("..")) throw new Error("Unsafe screenshot prefix");
const outDir = path.resolve(process.argv[4] ?? "/tmp/vg-ai-design-shots");
const outputTemp = fs.realpathSync(os.tmpdir());
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function assertOutputIsolation() {
  if (outDir === outputTemp || !isWithin(outputTemp, outDir) || isWithin(fs.realpathSync(source), outDir)) {
    throw new Error("Screenshot output must be outside the repository and under OS temp: " + outDir);
  }
  for (let dir = outDir; ; dir = path.dirname(dir)) {
    let stat;
    try { stat = fs.lstatSync(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe output directory: " + dir);
      // Check every ancestor so even a nested output folder in a user Vault is rejected.
      try {
        fs.lstatSync(path.join(dir, ".obsidian"));
        throw new Error("Screenshot output inside a Vault is forbidden: " + dir);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (dir === path.dirname(dir)) break;
  }
}
assertOutputIsolation();
fs.mkdirSync(outDir, { recursive: true });
assertOutputIsolation();
const root = fs.mkdtempSync(`/tmp/vg-ui-${mode}-`);
const vault = path.join(root, "synthetic-vault");
const profile = path.join(root, "independent-profile");
const temp = path.join(root, "runtime-temp");
for (const dir of [vault, profile, temp]) fs.mkdirSync(dir);
const pluginDir = path.join(vault, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
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
const child = { ...common, kind: "subtask", id: notePath + "::design", key: "design", file: { path: notePath, parentPath: notePath, heading: "デザイン確認" }, title: "デザイン確認", displayName: "デザイン確認", ganttEnabled: false, plannedStartDate: "2026-10-10", plannedEndDate: "2026-10-12" };
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
  assertOutputIsolation();
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
let cleanupPromise;
let shuttingDown = false;
function waitForSpawn(childProcess) {
  return new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("spawn", resolve);
  });
}
function assertRunning() {
  if (shuttingDown) throw new Error("Capture is shutting down");
}
async function stopProcessGroup(childProcess) {
  if (!childProcess?.pid) return;
  const kill = (signal) => {
    try { process.kill(-childProcess.pid, signal); return true; }
    catch (error) {
      if (error.code !== "ESRCH") console.error("Process group cleanup failed", error);
      return false;
    }
  };
  if (kill("SIGTERM")) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    kill("SIGKILL");
  }
}
function cleanup() {
  shuttingDown = true;
  cleanupPromise ??= (async () => {
    try { cdp?.close(); } catch (error) { console.error("CDP cleanup failed", error); }
    await Promise.all([stopProcessGroup(obsidian), stopProcessGroup(xvfb)]);
  })();
  return cleanupPromise;
}
function onSignal(signal) {
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  void cleanup().finally(() => process.exit(process.exitCode));
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const checks = {};
try {
  // Dedicated display, no -ac or sandbox-bypass flags. Never reuse a user app.
  const display = process.env.DISPLAY || "127.0.0.1:90";
  if (!process.env.DISPLAY) {
    assertRunning();
    const xvfbLog = fs.openSync(path.join(root, "xvfb.log"), "a");
    xvfb = spawn("Xvfb", [":90", "-screen", "0", "1920x1080x24", "-listen", "tcp", "-nolisten", "unix"], { stdio: ["ignore", xvfbLog, xvfbLog], detached: true });
    fs.closeSync(xvfbLog);
    await waitForSpawn(xvfb);
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
  assertRunning();
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  obsidian = spawn(binary, [`--user-data-dir=${profile}`, "--remote-debugging-port=9476", "--disable-gpu"], {
    cwd: process.cwd(), env: { ...process.env, DISPLAY: display, TMPDIR: temp }, stdio: ["ignore", log, log], detached: true,
  });
  fs.closeSync(log);
  await waitForSpawn(obsidian);
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
  // Capture chat in both modes, plus Gantt ghosts in ghost mode, light + dark.
  const shot = async (name) => {
    await cdp.evaluate("document.activeElement?.blur()");
    await new Promise(r => setTimeout(r, 400));
    assertOutputIsolation();
    const output = fs.openSync(path.join(outDir, `${prefix}_${mode === "ghost" && name.startsWith("chat_") ? "ghostmode_" : ""}${name}.png`), "wx", 0o600);
    try {
      const result = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(output, Buffer.from(result.data, "base64"));
    } finally { fs.closeSync(output); }
    console.log("SHOT", name);
  };
  const setTheme = async (dark) => {
    const theme = await cdp.evaluate(`(async () => { const d = ${dark}; app.setTheme(d ? 'obsidian' : 'moonstone'); app.vault.setConfig('theme', d ? 'obsidian' : 'moonstone'); app.workspace.trigger('css-change'); await new Promise(r => setTimeout(r, 700)); return document.body.classList.contains('theme-dark') ? 'dark' : 'light'; })()`);
    console.log("THEME", dark ? "want dark" : "want light", "got", theme);
  };
  await cdp.evaluate(`(async () => {
    const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080);
    const plugin = app.plugins.plugins['vault-gantt'];
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成UIテスト.md'));
    const session = plugin.chatSession;
    window.__hold = null; window.__patch = { plannedStartDate: '2026-10-13', plannedEndDate: '2026-10-15' };
    session.provider = {
      connected: () => true,
      stream: async function* (...args) {
        const found = await plugin.operations.invoke('search', { query: 'デザイン確認' });
        const current = found.find(task => task.id === ${JSON.stringify(child.id)});
        if (!current) throw new Error('Synthetic task not found');
        const shortDate = date => date.split('-').slice(1).map(Number).join('/');
        yield { type: 'text', text: '**デザイン確認** を検索しました。\\n- 現在は ' + shortDate(current.plannedStartDate) + '〜' + shortDate(current.plannedEndDate) + ' です\\n- 3日後ろへ移動する案を作成します' };
        if (window.__hold) await window.__hold;
        const input = { taskId: ${JSON.stringify(child.id)}, patch: window.__patch };
        const plan = await plugin.operations.plan('update', input);
        yield { type: 'plan', operation: 'update', input, plan };
        yield { type: 'context', messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'synthetic-search', toolName: 'search', output: { type: 'json', value: found } }] }] };
      }
    };
    session.configure({ provider: 'openai-compatible', endpoint: 'http://localhost:1/v1', model: 'fake-model', auth: 'none', secretId: '' });
    await plugin.openAIChat('right');
    app.workspace.rightSplit.containerEl.style.width = '380px';
  })()`);
  await new Promise(r => setTimeout(r, 800));
  for (const dark of [false, true]) {
    const t = dark ? "dark" : "light";
    await setTheme(dark);
    if (dark) { await cdp.evaluate(`window.__patch = { plannedStartDate: '2026-10-16', plannedEndDate: '2026-10-18' }; app.plugins.plugins['vault-gantt'].chatSession.newConversation()`); }
    await shot(`chat_empty_${t}`);
    // streaming: hold the provider after first text
    await cdp.evaluate(`(() => { window.__hold = new Promise(r => { window.__release = r; });
      const input = document.querySelector('.vg-ai-composer textarea'); input.value = 'デザイン確認を3日後ろへずらして。';
      input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.vg-ai-send').click(); })()`);
    await cdp.waitForExpression("document.querySelector('.vg-ai-assistant')?.textContent.includes('検索しました')", { label: "streaming text" });
    await shot(`chat_streaming_${t}`);
    await cdp.evaluate(`window.__hold = null; window.__release()`);
    await cdp.waitForExpression("document.querySelector('.vg-ai-diff button')", { label: "Synthetic proposal" });
    await shot(`chat_proposal_${t}`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('.vg-ai-diff button')).find(b => b.textContent === '確認して実行').click()`);
    await cdp.waitForExpression("document.querySelector('.vg-ai-diff')?.textContent.includes('適用済み')", { label: "Synthetic result" });
    await shot(`chat_result_${t}`);
    if (mode === "ghost") {
      await cdp.evaluate("app.plugins.plugins['vault-gantt'].navigation.activateGanttView()");
      await cdp.waitForExpression("document.querySelector('.vg-ai-ghost')", { label: "ghost" });
      await shot(`ghost_${t}`);
    }
    // wide tab chat
    await cdp.evaluate(`(async () => {
      app.workspace.getLeavesOfType('vault-gantt-ai-chat')[0].detach();
      await app.plugins.plugins['vault-gantt'].openAIChat('tab');
      app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
      const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1100, 900);
    })()`);
    await cdp.waitForExpression("document.querySelector('.vg-ai-chat')?.getBoundingClientRect().width >= 700", { label: "Wide Chat tab" });
    await shot(`chat_wide_${t}`);
    // restore the sidebar layout for the next theme
    await cdp.evaluate(`(async () => {
      app.workspace.getLeavesOfType('vault-gantt-ai-chat')[0].detach();
      const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080);
      app.workspace.rightSplit.expand();
      await app.plugins.plugins['vault-gantt'].openAIChat('right');
      app.workspace.rightSplit.containerEl.style.width = '380px';
    })()`);
    await new Promise(r => setTimeout(r, 600));
  }
} finally {
  await cleanup();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
