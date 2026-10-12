// Real Obsidian/CDP against a fresh /tmp scratchpad only. No real profiles.
// Usage: node tools/e2e/ai-preview.mjs [prefix] [outDir under OS temp]
// Renders the operation-preview UI (cards for every effect, approval list, Gantt overlay) from the shared
// contract fixtures with fake ports, in light and dark. The plugin under test is built from the working tree.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";

const mode = "preview";
const source = process.cwd();
const prefix = process.argv[2] ?? "pv";
if (!prefix || /[/\\]/.test(prefix) || prefix.includes("..")) throw new Error("Unsafe screenshot prefix");
const outDir = path.resolve(process.argv[3] ?? "/tmp/vg-ai-preview-shots");
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
  define: { __VG_VERSION__: JSON.stringify(manifest.version), __VG_COMMIT__: JSON.stringify("preview-ui-test"), __VG_BUILT_AT__: JSON.stringify("synthetic-ui-test") },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
});
for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(pluginDir, file));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureSyncEnabled: false, ganttFeatureWorkloadEnabled: false, ganttFeatureEventsEnabled: false, ganttFeatureDailyTodoEnabled: false, agentToolsEnabled: false, ganttZoom: 36 }));
const { buildFullNote } = await loadNoteFormatModule();
const notePath = "tasks/合成デザイン確認.md";
const common = { statusLabel: "active", completed: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const child = { ...common, kind: "subtask", id: notePath + "::design", key: "design", file: { path: notePath, parentPath: notePath, heading: "デザイン確認" }, title: "デザイン確認", displayName: "デザイン確認", ganttEnabled: false, plannedStartDate: "2026-10-13", plannedEndDate: "2026-10-15" };
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
    server.listen(9477, "127.0.0.1", () => server.close(resolve));
  });
  // Revalidate immediately before spawning, after all fixture writes.
  assertIsolation();
  assertRunning();
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  obsidian = spawn(binary, [`--user-data-dir=${profile}`, "--remote-debugging-port=9477", "--disable-gpu"], {
    cwd: process.cwd(), env: { ...process.env, DISPLAY: display, TMPDIR: temp }, stdio: ["ignore", log, log], detached: true,
  });
  fs.closeSync(log);
  await waitForSpawn(obsidian);
  await pollUntil(() => {
    if (obsidian.exitCode !== null) throw new Error("Own Obsidian process exited; refusing CDP attach");
    return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes("DevTools listening on ws://127.0.0.1:9477/");
  }, { timeoutMs: 45000, label: "Own Obsidian CDP endpoint in isolated log" });
  cdp = await connectCdp(9477);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "Synthetic manifest loaded" });
  const openedPath = await cdp.evaluate("app.vault.adapter.getBasePath()");
  if (openedPath !== vault) throw new Error("Runtime vault mismatch; refusing any UI interaction");
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent)); button?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "Trust dialog normally dismissed" });
  // Browser-side harness: fixtures + fake ports + the real UI modules, bundled for the page.
  const shim = path.join(root, "obsidian-shim.js");
  fs.writeFileSync(shim, "export class ItemView { constructor(leaf) { this.leaf = leaf; this.containerEl = leaf.containerEl; } }\nexport const setIcon = () => {};\nexport class Menu {}\nexport { default as moment } from 'moment';\n");
  const harness = await build({
    entryPoints: [path.join(source, "tools/e2e/ai-preview-harness.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "ES2020",
    nodePaths: [path.join(source, "node_modules")], alias: { obsidian: shim },
  });
  await cdp.evaluate(harness.outputFiles[0].text);
  await cdp.waitForExpression("typeof window.__vgp?.caseNames === 'function'", { label: "preview harness" });
  const NOW = "Date.parse('2026-10-09T03:05:00Z')";
  const shotClip = async (name, selector, { padding = 8 } = {}) => {
    await cdp.evaluate("document.activeElement?.blur()");
    const rect = await cdp.evaluate(`(() => { const el = ${selector}; if (!el) return null; el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (!rect) throw new Error("No element for " + name);
    await new Promise(r => setTimeout(r, 250));
    const fresh = await cdp.evaluate(`(() => { const r = (${selector}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, vh: innerHeight, vw: innerWidth }; })()`);
    const clip = { x: Math.max(0, fresh.x - padding), y: Math.max(0, fresh.y - padding), width: Math.min(fresh.vw, fresh.width + padding * 2), height: Math.min(fresh.vh - Math.max(0, fresh.y - padding), fresh.height + padding * 2), scale: 1.5 };
    assertOutputIsolation();
    const output = fs.openSync(path.join(outDir, `${prefix}_${name}.png`), "wx", 0o600);
    try {
      const result = await cdp.send("Page.captureScreenshot", { format: "png", clip });
      fs.writeFileSync(output, Buffer.from(result.data, "base64"));
    } finally { fs.closeSync(output); }
    console.log("SHOT", name, JSON.stringify({ w: Math.round(fresh.width), h: Math.round(fresh.height) }));
  };
  const setTheme = async (dark) => {
    const theme = await cdp.evaluate(`(async () => { const d = ${dark}; app.setTheme(d ? 'obsidian' : 'moonstone'); app.vault.setConfig('theme', d ? 'obsidian' : 'moonstone'); app.workspace.trigger('css-change'); await new Promise(r => setTimeout(r, 500)); return document.body.classList.contains('theme-dark') ? 'dark' : 'light'; })()`);
    console.log("THEME", dark ? "want dark" : "want light", "got", theme);
    if (theme !== (dark ? "dark" : "light")) throw new Error("Theme did not switch");
  };
  await cdp.evaluate(`(async () => {
    const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080);
    const plugin = app.plugins.plugins['vault-gantt'];
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成UIテスト.md'));
    window.__realNow = Date.now; Date.now = () => ${NOW};
    await plugin.openAIChat('right');
    app.workspace.rightSplit.containerEl.style.width = '420px';
  })()`);
  await new Promise(r => setTimeout(r, 800));
  const caseNames = await cdp.evaluate("window.__vgp.caseNames()");
  const notePathJson = JSON.stringify(notePath);
  for (const dark of [false, true]) {
    const t = dark ? "dark" : "light";
    await setTheme(dark);
    // 1) Cards in the real chat sidebar (420px wide), one image per case.
    for (const name of caseNames) {
      await cdp.evaluate(`window.__vgp.rerender(document.querySelector('.vg-ai-messages'), ${JSON.stringify(name)})`);
      await shotClip(`card_${name}_${t}`, "document.querySelector('.vg-pv-card')");
    }
    await cdp.evaluate(`window.__vgp.readCard(document.querySelector('.vg-ai-messages'))`);
    await shotClip(`card_read_result_${t}`, "document.querySelector('.vg-pv-card')");
    // 2) Approval list: wide tab and narrow sidebar.
    await cdp.evaluate(`(async () => {
      app.workspace.rightSplit.collapse();
      const leaf = app.workspace.getLeaf('tab'); await leaf.setViewState({ type: 'empty' }); window.__approvalLeaf = leaf;
      window.__approval = await window.__vgp.openApproval(leaf.view.containerEl);
      const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1100, 1000);
    })()`);
    await new Promise(r => setTimeout(r, 600));
    await shotClip(`approval_wide_${t}`, "document.querySelector('.vg-pv-approval')", { padding: 0 });
    await cdp.evaluate(`(async () => { await window.__approval.onClose(); window.__approvalLeaf.detach(); const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1920, 1080); })()`);
    await cdp.evaluate(`(async () => {
      app.workspace.rightSplit.expand();
      const leaf = app.workspace.getRightLeaf(false); await leaf.setViewState({ type: 'empty' }); window.__approvalLeaf = leaf; await app.workspace.revealLeaf(leaf);
      app.workspace.rightSplit.containerEl.style.width = '380px';
      window.__approval = await window.__vgp.openApproval(leaf.view.containerEl);
    })()`);
    await new Promise(r => setTimeout(r, 600));
    await shotClip(`approval_sidebar_${t}`, "document.querySelector('.vg-pv-approval')", { padding: 0 });
    await cdp.evaluate(`(async () => { await window.__approval.onClose(); window.__approvalLeaf.detach(); app.workspace.rightSplit.collapse(); })()`);
    // 3) Gantt overlay on the real Gantt view: patch the host with a fake preview port and reopen the view.
    await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins['vault-gantt'];
      if (!window.__ganttPort) {
        await plugin.navigation.activateGanttView();
        const view = app.workspace.getLeavesOfType('task-gantt-view')[0].view;
        window.__ganttPort = window.__vgp.makeGanttPort(${notePathJson}); window.__ganttView = view;
        view.host.previewPort = window.__ganttPort;
        await view.onClose(); await view.onOpen();
      }
      app.workspace.leftSplit.collapse();
    })()`);
    await new Promise(r => setTimeout(r, 800));
    await shotClip(`gantt_none_${t}`, "document.querySelector('.task-gantt-container')", { padding: 0 });
    for (const [name, id] of await cdp.evaluate(`window.__vgp.ganttNames(${notePathJson})`)) {
      await cdp.evaluate(`window.__ganttPort.focus(${JSON.stringify(id)})`);
      await new Promise(r => setTimeout(r, 500));
      await shotClip(`gantt_${name}_${t}`, "document.querySelector('.task-gantt-container')", { padding: 0 });
    }
    await cdp.evaluate(`window.__ganttPort.focus(null)`);
    await cdp.evaluate(`(async () => { app.workspace.rightSplit.expand(); app.workspace.leftSplit.expand(); })()`);
    await new Promise(r => setTimeout(r, 400));
  }
  await cdp.evaluate(`Date.now = window.__realNow`);
} finally {
  await cleanup();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
