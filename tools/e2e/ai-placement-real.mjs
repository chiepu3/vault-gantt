// Real Obsidian/CDP: the AI chat stays in the right sidebar across a plugin update (main.js overwritten + reload) and an app restart; auto-open on start-up; toolbar AI button.
// Usage: OBSIDIAN_BIN=... node tools/e2e/ai-placement-real.mjs
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const source = process.cwd();
const tmp = fs.realpathSync(os.tmpdir());
const displayNumber = process.env.E2E_DISPLAY_NUM ?? "93";
const cdpPort = Number(process.env.E2E_CDP_PORT ?? 9484);
const root = fs.mkdtempSync("/tmp/vg-ui-chat-");
const vault = path.join(root, "synthetic-vault");
const profile = path.join(root, "independent-profile");
const temp = path.join(root, "runtime-temp");
for (const dir of [vault, profile, temp]) fs.mkdirSync(dir);
const pluginsDir = path.join(vault, ".obsidian/plugins");
const pluginDir = path.join(pluginsDir, "vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
await build({
  entryPoints: [path.join(source, "src/main.ts")], bundle: true, format: "cjs", target: "ES2018", minify: true,
  nodePaths: [path.join(process.cwd(), "node_modules")], outfile: path.join(pluginDir, "main.js"),
  define: { __VG_VERSION__: JSON.stringify(manifest.version), __VG_COMMIT__: JSON.stringify("chat-stream-test"), __VG_BUILT_AT__: JSON.stringify("synthetic-ui-test") },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*", ...builtinModules],
});
for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(pluginDir, file));

const fake = await startFakeOpenAI();
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["vault-gantt"]));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({
  taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureSyncEnabled: false, ganttFeatureWorkloadEnabled: false, ganttFeatureEventsEnabled: false, ganttFeatureDailyTodoEnabled: false,
  ai: { preset: "custom", baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: "fake-model", useApiKey: false },
}));
fs.mkdirSync(path.join(vault, "tasks"));
fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));
const binary = process.env.OBSIDIAN_BIN;
if (!binary) throw new Error("Set OBSIDIAN_BIN");
const displayNumber2 = displayNumber;
let xvfb, obsidian, cdp;
const spawned = (p) => new Promise((resolve, reject) => { p.once("error", reject); p.once("spawn", resolve); });
async function stopGroup(p) { if (!p?.pid) return; try { process.kill(-p.pid, "SIGTERM"); } catch { return; } await new Promise((r) => setTimeout(r, 1500)); try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
const checks = {};
async function launch() {
  const display = `127.0.0.1:${displayNumber2}`;
  const logPath = path.join(root, "obsidian-" + Date.now() + ".log");
  const log = fs.openSync(logPath, "a");
  const asRoot = process.getuid() === 0;
  if (asRoot) { const owned = spawn("chown", ["-R", "65534:65534", root]); await new Promise((r) => owned.once("close", r)); }
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"];
  obsidian = spawn(asRoot ? "setpriv" : binary, asRoot ? ["--reuid=65534", "--regid=65534", "--clear-groups", binary, ...args] : args, { cwd: root, env: { ...process.env, DISPLAY: display, TMPDIR: temp, HOME: root }, stdio: ["ignore", log, log], detached: true });
  await spawned(obsidian);
  await pollUntil(() => fs.readFileSync(logPath, "utf8").includes(`DevTools listening on ws://127.0.0.1:${cdpPort}/`), { timeoutMs: 45000, label: "CDP" });
  cdp = await connectCdp(cdpPort);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "manifest" });
  await cdp.startErrorCapture();
  if (!(await cdp.evaluate("!!app.plugins.plugins['vault-gantt']"))) await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent)); b?.click(); })()`);
  await cdp.waitForExpression("!!app.plugins.plugins['vault-gantt']?.chatSession", { timeoutMs: 20000, label: "plugin" });
  await cdp.evaluate("new Promise(r => app.workspace.onLayoutReady(r))");
}
const summary = () => cdp.evaluate(`(() => { const s = app.plugins.plugins['vault-gantt'].chatSession; return JSON.stringify({ n: s.conversations.length, active: s.active.id, titles: s.conversations.map(c => c.title), msgs: s.active.messages.map(m => m.role + ':' + m.text) }); })()`).then(JSON.parse);
const outDir = process.env.SHOT_DIR ?? path.join(root, "shots");
fs.mkdirSync(outDir, { recursive: true });
const shot = async (name) => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(outDir, name + ".png"), Buffer.from(r.data, "base64")); };
const state = () => cdp.evaluate(`(() => { const ls = app.workspace.getLeavesOfType('vault-gantt-ai-chat'); return JSON.stringify({ n: ls.length, right: ls.filter(l => l.getRoot() === app.workspace.rightSplit).length, btn: !!document.querySelector('.task-gantt-ai') }); })()`).then(JSON.parse);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(cdpPort, "127.0.0.1", () => server.close(resolve)); });
  xvfb = spawn("Xvfb", [`:${displayNumber2}`, "-screen", "0", "1600x1000x24", "-listen", "tcp", "-nolisten", "unix"], { stdio: "ignore", detached: true });
  await spawned(xvfb);
  await pollUntil(() => new Promise((resolve) => { const s = net.connect(6000 + Number(displayNumber2), "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); }), { timeoutMs: 10000, label: "Xvfb" });
  await launch();
  await wait(1500);
  checks.autoOpenedRight = (await state()).right === 1 && (await state()).n === 1;
  await cdp.evaluate(`app.plugins.plugins['vault-gantt'].navigation.activateGanttView()`);
  await cdp.waitForExpression("!!document.querySelector('.task-gantt-ai')", { label: "ai button" });
  await wait(800);
  await shot("light-gantt-ai-sidebar");
  checks.toolbarButton = (await state()).btn;
  // Button with the chat closed: reopens in the right sidebar.
  await cdp.evaluate(`app.workspace.detachLeavesOfType('vault-gantt-ai-chat')`);
  await wait(300);
  checks.closedFirst = (await state()).n === 0;
  await cdp.evaluate(`document.querySelector('.task-gantt-ai').click()`);
  await wait(1000);
  checks.buttonOpensRight = (await state()).right === 1;
  await cdp.evaluate(`document.body.classList.remove('theme-light'); document.body.classList.add('theme-dark')`);
  await wait(500);
  await shot("dark-gantt-ai-sidebar");
  await cdp.evaluate(`document.body.classList.remove('theme-dark'); document.body.classList.add('theme-light')`);
  // Update with auto-open OFF: only the layout itself can keep the pane.
  await cdp.evaluate(`(async () => { const p = app.plugins.plugins['vault-gantt']; p.settings.aiChatAutoOpen = false; await p.saveSettings(); })()`);
  await wait(500);
  fs.appendFileSync(path.join(pluginDir, "main.js"), "\n/* updated */\n");
  await cdp.evaluate(`(async () => { await app.plugins.disablePlugin('vault-gantt'); await app.plugins.enablePlugin('vault-gantt'); })()`);
  await cdp.waitForExpression("!!app.plugins.plugins['vault-gantt']?.chatSession", { timeoutMs: 20000, label: "reloaded" });
  await wait(1500);
  const afterUpdate = await state();
  checks.survivesUpdate = afterUpdate.n === 1 && afterUpdate.right === 1;
  await shot("after-update");
  // Full restart with auto-open still off.
  await cdp.evaluate(`app.workspace.requestSaveLayout()`);
  await wait(2500);
  cdp.close(); await stopGroup(obsidian);
  fs.rmSync(path.join(profile, "SingletonLock"), { force: true });
  await launch();
  await wait(1500);
  const afterRestart = await state();
  checks.survivesRestart = afterRestart.n === 1 && afterRestart.right === 1;
  checks.consoleErrors = cdp.capturedErrors();
  console.log("CHECKS", JSON.stringify(checks, null, 2), "shots:", outDir);
  const failed = Object.entries(checks).filter(([k, v]) => k !== "consoleErrors" && v !== true);
  if (failed.length || checks.consoleErrors.length) { console.error("FAILED", JSON.stringify(failed)); process.exitCode = 1; }
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  await Promise.all([stopGroup(obsidian), stopGroup(xvfb), fake.close()]);
}
