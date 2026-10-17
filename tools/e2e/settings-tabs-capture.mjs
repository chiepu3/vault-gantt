// Real Obsidian/CDP against a fresh /tmp scratchpad only (synthetic vault, independent profile).
// Captures the tabbed settings screen and the AI tab (profiles, added vs available models, search, toast).
// The model list comes from a local mock server; no real API key is used. Seeds the OLD flat `ai` shape to exercise migration.
// Usage: node tools/e2e/settings-tabs-capture.mjs [outDir]   (default /tmp/vg-settings-tabs-shots)
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin, CdpSession, ensureObsidianBinary } from "./obsidian-runtime.mjs";

const source = process.cwd();
const outDir = path.resolve(process.argv[2] ?? "/tmp/vg-settings-tabs-shots");
fs.mkdirSync(outDir, { recursive: true });
const root = fs.mkdtempSync("/tmp/vg-ui-settings-");
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
  define: { __VG_VERSION__: JSON.stringify(manifest.version), __VG_COMMIT__: JSON.stringify("settings-ui"), __VG_BUILT_AT__: JSON.stringify("synthetic-ui-test") },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*", ...builtinModules],
});
for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(pluginDir, file));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({
  taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureDailyTodoEnabled: true, agentToolsEnabled: false,
  ganttTags: [{ key: "t1", name: "設計", color: "#4da3ff", order: 0 }, { key: "t2", name: "レビュー待ち", color: "#f5c542", order: 1000 }],
  ai: { preset: "local", baseUrl: "http://127.0.0.1:__PORT__/v1", model: "gemma-2-9b-it", useApiKey: false },
  dailyTodoSources: [
    { key: "main", label: "デイリー", format: "[デイリー]/YYYY/MM/YYMMDD_[デイリー]", creatableFromGantt: true, templatePath: "templates/daily.md" },
    { key: "meeting", label: "デイリーミーティング", format: "[Journal]/YYYY-MM-DD", creatableFromGantt: false },
  ],
}));
fs.writeFileSync(path.join(vault, "合成.md"), "# 合成\n");
const profileConfig = path.join(profile, "obsidian.json");
fs.writeFileSync(profileConfig, JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));

// Mock OpenAI-compatible server: requires "Bearer sk-mock-not-real" only on /keyed/v1.
const requests = [];
const mock = http.createServer((req, res) => {
  // Same as LM Studio with "Enable CORS" turned on: the renderer origin is app://obsidian.md.
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "authorization, content-type, accept");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  requests.push({ url: req.url, auth: req.headers.authorization ? "present" : "absent" });
  const vendors = ["openai", "anthropic", "google", "meta-llama", "mistralai", "qwen"];
  const many = Array.from({ length: 180 }, (_, i) => `${vendors[i % vendors.length]}/model-${String(i).padStart(3, "0")}${i % 9 === 0 ? "-mini" : ""}`);
  const models = { data: ["qwen2.5-7b-instruct", "llama-3.1-8b-instruct", "gemma-2-9b-it", ...many].map((id) => ({ id, object: "model" })) };
  if (req.url.startsWith("/keyed/") && req.headers.authorization !== "Bearer sk-mock-not-real") { res.writeHead(401).end("{}"); return; }
  if (req.url.endsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(models)); return; }
  res.writeHead(404).end("{}");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;
const dataFile = path.join(pluginDir, "data.json");
fs.writeFileSync(dataFile, fs.readFileSync(dataFile, "utf8").replace("__PORT__", String(mockPort)));

const binary = process.env.OBSIDIAN_BIN ?? (await ensureObsidianBinary());
const XPORT = 6097, CDP = 9497;
let xvfb; let obsidian; let cdp;
const stop = async (child) => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await new Promise((r) => setTimeout(r, 1000));
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
};
const cleanup = async () => { try { cdp?.close(); } catch { /* ignore */ } mock.close(); await Promise.all([stop(obsidian), stop(xvfb)]); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const display = `127.0.0.1:${XPORT - 6000}`;
  const xlog = fs.openSync(path.join(root, "xvfb.log"), "a");
  xvfb = spawn("Xvfb", [`:${XPORT - 6000}`, "-screen", "0", "1920x1080x24", "-listen", "tcp", "-nolisten", "unix"], { stdio: ["ignore", xlog, xlog], detached: true });
  await pollUntil(() => new Promise((resolve) => { const s = net.connect(XPORT, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); }), { timeoutMs: 10000, label: "Xvfb" });
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  obsidian = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`, "--disable-gpu", "--no-sandbox"], { cwd: process.cwd(), env: { ...process.env, DISPLAY: display, TMPDIR: temp }, stdio: ["ignore", log, log], detached: true });
  await pollUntil(() => {
    if (obsidian.exitCode !== null) throw new Error("Own Obsidian exited");
    return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes(`DevTools listening on ws://127.0.0.1:${CDP}/`);
  }, { timeoutMs: 45000, label: "CDP endpoint" });
  cdp = await connectCdp(CDP);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "manifest" });
  if ((await cdp.evaluate("app.vault.adapter.getBasePath()")) !== vault) throw new Error("Runtime vault mismatch");
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent))?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "trust dialog" });
  const info = await cdp.evaluate("JSON.stringify({ secret: !!app.secretStorage, version: require('electron').ipcRenderer ? 'ok' : '' })");
  console.log("ENV", info);

  const shot = async (name) => {
    await pop.evaluate("document.activeElement?.blur()");
    await sleep(400);
    const result = await pop.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, "base64"));
    console.log("SHOT", name);
  };
  const setTheme = (dark) => cdp.evaluate(`(async () => { app.setTheme(${dark} ? 'obsidian' : 'moonstone'); app.vault.setConfig('theme', ${dark} ? 'obsidian' : 'moonstone'); app.workspace.trigger('css-change'); await new Promise(r => setTimeout(r, 700)); })()`);
  const resize = (w, h) => cdp.evaluate(`(async () => { const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(${w}, ${h}); await new Promise(r => setTimeout(r, 700)); })()`);
  let pop;
  const connectPopout = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const target = targets.find((t) => t.type === "page" && /^Settings|設定/.test(t.title ?? ""));
      if (target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
        return new CdpSession(ws, target.url);
      }
      await sleep(500);
    }
    throw new Error("Settings popout target not found");
  };
  const reopen = async () => {
    await cdp.evaluate(`(async () => {
      if (!app.setting.activeTab || !document.querySelector('.modal.mod-settings')) { app.setting.open(); }
      await new Promise(r => setTimeout(r, 500));
      app.setting.openTabById('vault-gantt'); await new Promise(r => setTimeout(r, 300));
      app.setting.activeTab.display(); await new Promise(r => setTimeout(r, 600));
    })()`);
    pop ??= await connectPopout();
    await pop.waitForExpression("!!document.querySelector('.vg-settings-ai')", { timeoutMs: 15000, label: "settings AI section" });
  };
  const popResize = async (w, h) => {
    const found = await cdp.evaluate(`(() => {
      const remote = require('electron').remote || require('@electron/remote');
      const win = remote.BrowserWindow.getAllWindows().find(x => /^Settings|設定/.test(x.getTitle()));
      if (!win) return false; win.setSize(${w}, ${h}); return true; })()`);
    if (!found) throw new Error("Settings window not found for resize");
    await sleep(800);
  };
  const scrollTo = (selector, text = "") => pop.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const el = ${JSON.stringify(text)} ? items.find(e => e.textContent.includes(${JSON.stringify(text)})) : items[0];
    if (!el) throw new Error("not found: " + ${JSON.stringify(selector)} + " / " + document.body.innerText.slice(0, 300)); el.scrollIntoView({ block: "start" }); return true; })()`);
  const typeInto = (index, value, selector) => pop.evaluate(`(() => {
    const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const click = (text, scope = ".vg-settings-ai") => pop.evaluate(`(() => { const b = Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")})).find(b => b.textContent === ${JSON.stringify(text)}); if (!b) throw new Error('button ${text}'); b.click(); })()`);
  const choose = (settingName, value) => pop.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.vg-settings-ai .setting-item')).find(r => r.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(settingName)});
    const select = row.querySelector('select'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const aiText = (settingName) => pop.evaluate(`(() => Array.from(document.querySelectorAll('.vg-settings-ai .setting-item')).find(r => r.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(settingName)})?.textContent ?? '')()`);

  const sleep2 = sleep;
  await cdp.evaluate(`app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成.md'))`);
  await setTheme(false);
  await reopen();
  await popResize(1100, 900);
  const clickTab = async (label) => { await pop.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.vg-settings-tab')).find(b => b.textContent === ${JSON.stringify(label)}); if (!b) throw new Error('tab ' + ${JSON.stringify(label)}); b.click(); })()`); await sleep2(500); };
  const visiblePanels = () => pop.evaluate(`document.querySelectorAll('.vg-settings-panel.is-active').length`);
  for (const [label, id] of [["基本", "general"], ["Gantt", "gantt"], ["タグ", "tags"], ["Daily ToDo", "daily"], ["連携", "integration"]]) {
    await clickTab(label);
    console.log("PANELS_VISIBLE", label, await visiblePanels());
    await shot(`tab_${id}_light`);
  }
  await clickTab("AI チャット");
  await sleep2(1200);
  await shot("ai_01_migrated_light");
  console.log("MIGRATED_STORE", JSON.stringify(JSON.parse(fs.readFileSync(dataFile, "utf8")).ai));
  // search
  await pop.evaluate(`document.querySelector('.vg-ai-available-models input[type=search]').scrollIntoView({ block: 'center' })`);
  await typeInto(0, "meta mini", ".vg-ai-available-models input[type=search]");
  await sleep2(400);
  await shot("ai_02_search_light");
  // add two models
  await pop.evaluate(`(() => { const rows = Array.from(document.querySelectorAll('.vg-ai-available-models .vg-ai-model-row')); for (const r of rows.slice(0, 2)) r.querySelector('button').click(); })()`);
  await sleep2(700);
  await pop.evaluate(`document.querySelector('.vg-ai-added-models').scrollIntoView({ block: 'start' })`);
  await shot("ai_03_added_light");
  // add a new profile
  await pop.evaluate(`(() => { const row = Array.from(document.querySelectorAll('.vg-settings-ai .setting-item')).find(r => r.querySelector('.setting-item-name')?.textContent === '使用する接続'); Array.from(row.querySelectorAll('button')).find(b => b.textContent === '追加').click(); })()`);
  await sleep2(1000);
  await pop.evaluate(`document.querySelector('.vg-settings-ai').scrollIntoView({ block: 'start' })`);
  await shot("ai_04_new_profile_light");
  console.log("PROFILES", JSON.stringify(JSON.parse(fs.readFileSync(dataFile, "utf8")).ai.profiles.map((p) => [p.id, p.name, p.addedModels.length])));
  // switch back
  await choose("使用する接続", "default"); await sleep2(1200);
  await pop.evaluate(`document.querySelector('.vg-settings-ai').scrollIntoView({ block: 'start' })`);
  // connection test toast: Notices live in the main window
  await click("接続テスト"); await sleep2(900);
  const main = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, "ai_05_toast_main_window.png"), Buffer.from(main.data, "base64"));
  console.log("NOTICE_TEXT", await cdp.evaluate(`Array.from(document.querySelectorAll('.notice')).map(n => n.textContent).join(' | ')`));
  await shot("ai_05_after_test_light");
  // dark + narrow
  await setTheme(true); await sleep2(500);
  await popResize(640, 900); await sleep2(600);
  await clickTab("AI チャット");
  await pop.evaluate(`document.querySelector('.vg-settings-ai').scrollIntoView({ block: 'start' })`);
  await shot("ai_06_narrow_dark");
  await pop.evaluate(`document.querySelector('.vg-ai-added-models').scrollIntoView({ block: 'start' })`);
  await shot("ai_07_models_narrow_dark");
  await clickTab("基本"); await shot("tab_general_narrow_dark");
} finally {
  await cleanup();
}
