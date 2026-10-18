// Real Obsidian/CDP against a fresh /tmp scratchpad only. No real profiles.
// Usage: node tools/e2e/gantt-highlight.mjs [prefix] [outDir under OS temp] [hoverEditorDir]
// Focuses one preview that changes a subtask period, plan/actual hours, a Daily ToDo day and events on the REAL
// Gantt view and screenshots the highlights (pending proposal + saved outcome), light and dark.
// Root-only containers: set E2E_ALLOW_NO_SANDBOX=1 (Electron refuses to run as root otherwise).
// Optional hoverEditorDir (main.js, manifest.json, styles.css) installs that community plugin and checks for console errors.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule, renderTaskNotes, stableId } from "./gen-fixtures.mjs";

const mode = "highlight";
const source = process.cwd();
const prefix = process.argv[2] ?? "pv";
if (!prefix || /[/\\]/.test(prefix) || prefix.includes("..")) throw new Error("Unsafe screenshot prefix");
const outDir = path.resolve(process.argv[3] ?? "/tmp/vg-gantt-highlight-shots");
const hoverDir = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
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
  define: { __VG_VERSION__: JSON.stringify(manifest.version), __VG_COMMIT__: JSON.stringify("gantt-highlight-test"), __VG_BUILT_AT__: JSON.stringify("synthetic-ui-test") },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*", ...builtinModules],
});
for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(pluginDir, file));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureSyncEnabled: false, ganttFeatureWorkloadEnabled: true, ganttFeatureEventsEnabled: true, ganttFeatureDailyTodoEnabled: true, agentToolsEnabled: false, ganttZoom: 44,
  ganttEvents: [{ key: "e1", title: "定例会議", date: "2026-10-15", workloadPlan: { "2026-10-15": 1 } }, { key: "e2", title: "振り返り", date: "2026-10-22" }] }));
const noteModule = await loadNoteFormatModule();
const notePath = "tasks/合成リリース.md";
const common = { statusLabel: "active", completed: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const sub = (key, title, start, end, plan = {}, actual = {}) => ({ ...common, kind: "subtask", id: notePath + "::" + key, key, file: { path: notePath, parentPath: notePath, heading: title }, title, displayName: title, ganttEnabled: false, plannedStartDate: start, plannedEndDate: end, workloadPlan: plan, workloadActual: actual });
const subs = [
  sub("design", "デザイン確認", "2026-10-13", "2026-10-15", { "2026-10-13": 2, "2026-10-14": 3 }, { "2026-10-13": 1 }),
  sub("review", "レビュー", "2026-10-16", "2026-10-19", { "2026-10-16": 4 }),
  sub("old", "旧い作業", "2026-10-20", "2026-10-21", { "2026-10-20": 1 }),
];
const mkParent = (children) => ({ ...common, kind: "parent", id: notePath, file: { path: notePath }, title: "合成リリース", displayName: "合成リリース", ganttEnabled: true, ganttOrder: 0, subtasks: new Map(children.map((c) => [c.key, c])) });
const parent = mkParent(subs);
// What the vault holds once the proposal has been saved.
const afterSubs = [
  sub("design", "デザイン確認", "2026-10-13", "2026-10-17", { "2026-10-14": 5, "2026-10-15": 2, "2026-10-13": 2 }, { "2026-10-13": 2 }),
  subs[1],
  sub("new", "追加タスク", "2026-10-19", "2026-10-21", { "2026-10-19": 2 }),
];
// v2: the parent and every subtask are notes of their own. "Saved" changes design, drops "old" and adds "new".
const originalNotes = renderTaskNotes(noteModule, parent, parent.subtasks);
const savedNotes = renderTaskNotes(noteModule, mkParent(afterSubs), mkParent(afterSubs).subtasks);
for (const [rel, text] of Object.entries(originalNotes.files)) {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
}
const noteIds = { parent: originalNotes.parentId, children: Object.fromEntries(["design", "review", "old", "new"].map((key) => [key, stableId("s", `${notePath}::${key}`)])) };
const everyNotePath = [...new Set([...Object.keys(originalNotes.files), ...Object.keys(savedNotes.files)])];
// Expression that makes the vault hold exactly these notes (modify, create or delete as needed).
const applyNotes = (files) => `(async () => { const files = ${JSON.stringify(files)}; for (const p of ${JSON.stringify(everyNotePath)}) { const f = app.vault.getAbstractFileByPath(p); if (p in files) { if (f) await app.vault.modify(f, files[p]); else await app.vault.create(p, files[p]); } else if (f) await app.vault.delete(f); } })()`;
fs.mkdirSync(path.join(vault, "デイリー/2026/10"), { recursive: true });
fs.writeFileSync(path.join(vault, "デイリー/2026/10/261014_デイリー.md"), "# 2026-10-14\n\n- [ ] 資料を確認する\n");
const savedDaily = { "デイリー/2026/10/261014_デイリー.md": "# 2026-10-14\n\n- [ ] 資料を確認する\n- [ ] 追加のToDo\n", "デイリー/2026/10/261015_デイリー.md": "# 2026-10-15\n\n- [ ] 新しい日のToDo\n" };
fs.writeFileSync(path.join(vault, "合成UIテスト.md"), "# 合成UIテスト\n");
if (hoverDir) {
  const hoverPlugin = path.join(vault, ".obsidian/plugins/obsidian-hover-editor");
  fs.mkdirSync(hoverPlugin, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(hoverDir, file), path.join(hoverPlugin, file));
  fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt","obsidian-hover-editor"]');
}
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
    server.listen(9478, "127.0.0.1", () => server.close(resolve));
  });
  // Revalidate immediately before spawning, after all fixture writes.
  assertIsolation();
  assertRunning();
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  obsidian = spawn(binary, [`--user-data-dir=${profile}`, "--remote-debugging-port=9478", "--disable-gpu", ...(process.env.E2E_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])], {
    cwd: process.cwd(), env: { ...process.env, DISPLAY: display, TMPDIR: temp }, stdio: ["ignore", log, log], detached: true,
  });
  fs.closeSync(log);
  await waitForSpawn(obsidian);
  await pollUntil(() => {
    if (obsidian.exitCode !== null) throw new Error("Own Obsidian process exited; refusing CDP attach");
    return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes("DevTools listening on ws://127.0.0.1:9478/");
  }, { timeoutMs: 45000, label: "Own Obsidian CDP endpoint in isolated log" });
  cdp = await connectCdp(9478);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "Synthetic manifest loaded" });
  const openedPath = await cdp.evaluate("app.vault.adapter.getBasePath()");
  if (openedPath !== vault) throw new Error("Runtime vault mismatch; refusing any UI interaction");
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent)); button?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "Trust dialog normally dismissed" });
    await cdp.startErrorCapture(); cdp.resetCapturedErrors();
  if (hoverDir) {
    await cdp.evaluate(`(async () => { await app.plugins.loadManifests(); await app.plugins.enablePluginAndSave('obsidian-hover-editor'); })()`);
    await new Promise(r => setTimeout(r, 1500));
    await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent)); button?.click(); })()`);
    console.log("HOVER EDITOR enabled", await cdp.evaluate(`!!app.plugins.plugins['obsidian-hover-editor']`));
  }
  const harness = await build({
    entryPoints: [path.join(source, "tools/e2e/gantt-highlight-harness.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "ES2020",
    nodePaths: [path.join(source, "node_modules")],
  });
  await cdp.evaluate(harness.outputFiles[0].text);
  await cdp.waitForExpression("typeof window.__vgh?.makePort === 'function'", { label: "highlight harness" });
  const shot = async (name, selector = "document.querySelector('.task-gantt-container')") => {
    await cdp.evaluate("document.activeElement?.blur()");
    await new Promise(r => setTimeout(r, 700));
    const r = await cdp.evaluate(`(() => { const r = (${selector}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    assertOutputIsolation();
    const output = fs.openSync(path.join(outDir, `${prefix}_${name}.png`), "wx", 0o600);
    try {
      const result = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 1 } });
      fs.writeFileSync(output, Buffer.from(result.data, "base64"));
    } finally { fs.closeSync(output); }
    console.log("SHOT", name, JSON.stringify(r));
  };
  const setTheme = async (dark) => {
    const theme = await cdp.evaluate(`(async () => { const d = ${dark}; app.setTheme(d ? 'obsidian' : 'moonstone'); app.vault.setConfig('theme', d ? 'obsidian' : 'moonstone'); app.workspace.trigger('css-change'); await new Promise(r => setTimeout(r, 500)); return document.body.classList.contains('theme-dark') ? 'dark' : 'light'; })()`);
    if (theme !== (dark ? "dark" : "light")) throw new Error("Theme did not switch");
  };
  await cdp.evaluate(`(async () => {
    const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1600, 800);
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成UIテスト.md'));
    const plugin = app.plugins.plugins['vault-gantt'];
    await plugin.navigation.activateGanttView();
    app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
  })()`);
  await new Promise(r => setTimeout(r, 1500));
  // Swap in a fake preview port (empty at first) and reopen the real Gantt view.
  await cdp.evaluate(`(async () => {
    const view = app.workspace.getLeavesOfType('task-gantt-view')[0].view;
    window.__port = window.__vgh.makePort(${JSON.stringify(noteIds)});
    const all = [...window.__port.previews.values()]; window.__previews = all; window.__outcomes = new Map(window.__port.outcomes);
    window.__port.previews.clear(); window.__port.outcomes.clear();
    view.host.previewPort = window.__port; await view.onClose(); await view.onOpen();
    window.__view = view;
  })()`);
  await new Promise(r => setTimeout(r, 800));
  const state = () => cdp.evaluate(`JSON.stringify({ hl: ['vg-hl-bar','vg-hl-row','vg-hl-cell','vg-hl-chip','vg-hl-event','vg-hl-phantom','vg-hl-point'].map(c => c + ':' + document.querySelectorAll('.' + c).length), legend: document.querySelector('.vg-ai-legend')?.textContent, dock: document.querySelectorAll('.vg-pv-dock,.vg-pv-dockhost').length, scrollLeft: document.querySelector('.task-gantt-wrap').scrollLeft })`);
  for (const dark of [false, true]) {
    const t = dark ? "dark" : "light";
    await setTheme(dark);
    await cdp.evaluate(`window.__port.focus(null)`);
    await new Promise(r => setTimeout(r, 400));
    if (!dark) await shot(`none_${t}`);
    // A chat proposal created while the Gantt is open is focused by itself.
    await cdp.evaluate(`(() => { const [pending] = window.__previews; window.__port.set(pending); })()`);
    await new Promise(r => setTimeout(r, 900));
    console.log("AUTOFOCUS", t, await cdp.evaluate(`window.__port.focusedPreviewId()`), await state());
    // Ids already seen are not auto-focused again (second theme pass): focus explicitly.
    if (dark) { await cdp.evaluate(`window.__port.focus('combo')`); await new Promise(r => setTimeout(r, 900)); }
    await shot(`pending_${t}`);
    // Saved outcome: the vault now holds the after state.
    await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins['vault-gantt'];
      await ${applyNotes(savedNotes.files)};
      plugin.settings.ganttEvents = [{ key: 'e1', title: '定例会議', date: '2026-10-16', workloadPlan: { '2026-10-16': 2 } }, { key: 'e3', title: '新しい予定', date: '2026-10-21' }];
      await plugin.saveSettings();
      for (const [p, text] of Object.entries(${JSON.stringify(savedDaily)})) { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.modify(f, text); else await app.vault.create(p, text); }
      const [, saved] = window.__previews; window.__port.set(saved, window.__outcomes.get(saved.previewId)); window.__port.focus(saved.previewId);
      await new Promise(r => setTimeout(r, 1200)); await window.__view.render();
    })()`);
    await new Promise(r => setTimeout(r, 900));
    console.log("SAVED", t, await state());
    await shot(`saved_${t}`);
    // Back to the before state for the next theme.
    await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins['vault-gantt'];
      await ${applyNotes(originalNotes.files)};
      plugin.settings.ganttEvents = [{ key: 'e1', title: '定例会議', date: '2026-10-15', workloadPlan: { '2026-10-15': 1 } }, { key: 'e2', title: '振り返り', date: '2026-10-22' }];
      await plugin.saveSettings();
      await app.vault.modify(app.vault.getAbstractFileByPath('デイリー/2026/10/261014_デイリー.md'), '# 2026-10-14\\n\\n- [ ] 資料を確認する\\n');
      const d = app.vault.getAbstractFileByPath('デイリー/2026/10/261015_デイリー.md'); if (d) await app.vault.delete(d);
      window.__port.focus(null); window.__port.previews.clear(); window.__port.outcomes.clear();
      await new Promise(r => setTimeout(r, 2500)); await window.__view.render();
    })()`);
    await new Promise(r => setTimeout(r, 800));
  }
  console.log("CONSOLE ERRORS", JSON.stringify(cdp.capturedErrors()));
} finally {
  await cleanup();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
