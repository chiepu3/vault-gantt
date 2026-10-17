// Real Obsidian/CDP against a throwaway /tmp vault and profile, with the plugin's real SdkChatProvider
// pointed at a local fake OpenAI-compatible server (tools/e2e/fake-openai-server.mjs). It drives the chat the way
// a person does (real key events), captures the mid-stream and finished states in light and dark, and reports
// console errors. Optional: HOVER_EDITOR_DIR=<folder with main.js, manifest.json, styles.css> installs Hover Editor too.
// Usage: OBSIDIAN_BIN=... node tools/e2e/ai-chat-stream.mjs [outDir under OS temp]
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin } from "./obsidian-runtime.mjs";
import { loadNoteFormatModule } from "./gen-fixtures.mjs";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const source = process.cwd();
const outDir = path.resolve(process.argv[2] ?? "/tmp/vg-ai-chat-shots");
const tmp = fs.realpathSync(os.tmpdir());
if (!outDir.startsWith(tmp + path.sep) || outDir.startsWith(fs.realpathSync(source))) throw new Error("Screenshot output must be under OS temp and outside the repository: " + outDir);
fs.mkdirSync(outDir, { recursive: true });
const displayNumber = process.env.E2E_DISPLAY_NUM ?? "93";
const cdpPort = Number(process.env.E2E_CDP_PORT ?? 9483);
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
const plugins = ["vault-gantt"];
if (process.env.HOVER_EDITOR_DIR) {
  const hoverDir = path.join(pluginsDir, "obsidian-hover-editor"); fs.mkdirSync(hoverDir);
  for (const file of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(process.env.HOVER_EDITOR_DIR, file), path.join(hoverDir, file));
  plugins.push("obsidian-hover-editor");
}
const fake = await startFakeOpenAI();
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), JSON.stringify(plugins));
fs.writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({
  taskFolder: "tasks", autoPriorityEnabled: false, ganttSyncEnabled: false, ganttFeatureSyncEnabled: false, ganttFeatureWorkloadEnabled: false, ganttFeatureEventsEnabled: false, ganttFeatureDailyTodoEnabled: false, ganttZoom: 36,
  ai: { preset: "custom", baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: "fake-model", useApiKey: false },
}));
const { buildFullNote } = await loadNoteFormatModule();
const notePath = "tasks/合成デザイン確認.md";
const common = { statusLabel: "active", completed: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", priority: 0, priorityMode: "manual", currentStatus: "", notes: "", tags: [] };
const child = { ...common, kind: "subtask", id: notePath + "::design", key: "design", file: { path: notePath, parentPath: notePath, heading: "デザイン確認" }, title: "デザイン確認", displayName: "デザイン確認", ganttEnabled: false, plannedStartDate: "2026-10-10", plannedEndDate: "2026-10-12" };
const parent = { ...common, kind: "parent", id: notePath, file: { path: notePath }, title: "合成デザイン確認", displayName: "合成デザイン確認", ganttEnabled: true, ganttOrder: 0, subtasks: new Map([["design", child]]) };
fs.mkdirSync(path.join(vault, "tasks"));
fs.writeFileSync(path.join(vault, notePath), buildFullNote(parent, parent.subtasks));
fs.writeFileSync(path.join(vault, "合成UIテスト.md"), "# 合成UIテスト\n\n[[tasks/合成デザイン確認]] へのリンクです。\n");
const profileConfig = path.join(profile, "obsidian.json");
fs.writeFileSync(profileConfig, JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));

const binary = process.env.OBSIDIAN_BIN ?? process.env.E2E_OBSIDIAN_BIN;
if (!binary) throw new Error("Set OBSIDIAN_BIN to the extracted Obsidian binary");
let xvfb; let obsidian; let cdp;
async function stopGroup(childProcess) {
  if (!childProcess?.pid) return;
  try { process.kill(-childProcess.pid, "SIGTERM"); } catch { return; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try { process.kill(-childProcess.pid, "SIGKILL"); } catch { /* already gone */ }
}
const spawned = (childProcess) => new Promise((resolve, reject) => { childProcess.once("error", reject); childProcess.once("spawn", resolve); });
const checks = {};
try {
  const display = process.env.DISPLAY || `127.0.0.1:${displayNumber}`;
  if (!process.env.DISPLAY) {
    const xvfbLog = fs.openSync(path.join(root, "xvfb.log"), "a");
    xvfb = spawn("Xvfb", [`:${displayNumber}`, "-screen", "0", "1920x1080x24", "-listen", "tcp", "-nolisten", "unix"], { stdio: ["ignore", xvfbLog, xvfbLog], detached: true });
    await spawned(xvfb);
    await pollUntil(() => new Promise((resolve) => { const socket = net.connect(6000 + Number(displayNumber), "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); }), { timeoutMs: 10000, label: "Xvfb TCP" });
  }
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(cdpPort, "127.0.0.1", () => server.close(resolve)); });
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  // Chromium refuses to start as root without --no-sandbox, and the sandbox must stay on: run as an unprivileged user instead.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (asRoot) { const owned = spawn("chown", ["-R", "65534:65534", root]); await new Promise((resolve) => owned.once("close", resolve)); }
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"];
  const command = asRoot ? "setpriv" : binary;
  const argv = asRoot ? ["--reuid=65534", "--regid=65534", "--clear-groups", binary, ...args] : args;
  obsidian = spawn(command, argv, { cwd: root, env: { ...process.env, DISPLAY: display, TMPDIR: temp, HOME: root }, stdio: ["ignore", log, log], detached: true });
  await spawned(obsidian);
  await pollUntil(() => { if (obsidian.exitCode !== null) throw new Error("Own Obsidian exited"); return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes(`DevTools listening on ws://127.0.0.1:${cdpPort}/`); }, { timeoutMs: 45000, label: "CDP endpoint" });
  cdp = await connectCdp(cdpPort);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "manifest loaded" });
  if ((await cdp.evaluate("app.vault.adapter.getBasePath()")) !== vault) throw new Error("Runtime vault mismatch");
  await cdp.startErrorCapture();
  for (const id of plugins) await enablePlugin(cdp, id);
  await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent)); button?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "trust dialog" });
  if (process.env.HOVER_EDITOR_DIR) checks.hoverEditorEnabled = await cdp.evaluate("!!app.plugins.plugins['obsidian-hover-editor']");

  const shot = async (name, clipSelector) => {
    await cdp.evaluate("document.activeElement?.blur()");
    await new Promise((r) => setTimeout(r, 500));
    const params = { format: "png" };
    if (clipSelector) {
      const rect = await cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(clipSelector)}).getBoundingClientRect(); return { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24, scale: 2 }; })()`);
      params.clip = rect;
    }
    const result = await cdp.send("Page.captureScreenshot", params);
    fs.writeFileSync(path.join(outDir, name + ".png"), Buffer.from(result.data, "base64"));
    console.log("SHOT", name);
  };
  const setTheme = async (dark) => {
    const theme = await cdp.evaluate(`(async () => { const d = ${dark}; app.setTheme(d ? 'obsidian' : 'moonstone'); app.vault.setConfig('theme', d ? 'obsidian' : 'moonstone'); app.workspace.trigger('css-change'); await new Promise(r => setTimeout(r, 700)); return document.body.classList.contains('theme-dark') ? 'dark' : 'light'; })()`);
    console.log("THEME", theme);
  };
  const key = (params) => cdp.send("Input.dispatchKeyEvent", params);
  const pressEnter = async (modifiers = 0) => {
    await key({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
    await key({ type: "char", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, modifiers });
    await key({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
  };
  const typeIntoComposer = async (text) => {
    await cdp.evaluate("document.querySelector('.vg-ai-composer textarea').focus()");
    await cdp.send("Input.insertText", { text });
  };

  await cdp.evaluate(`(async () => {
    const remote = require('electron').remote || require('@electron/remote'); remote.getCurrentWindow().setSize(1500, 950);
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('合成UIテスト.md'));
    await app.plugins.plugins['vault-gantt'].openAIChat('right');
    app.workspace.rightSplit.containerEl.style.width = '440px';
  })()`);
  await cdp.waitForExpression("document.querySelector('.vg-ai-composer textarea')", { label: "chat view" });
  await cdp.waitForExpression("!document.querySelector('.vg-ai-send')?.disabled", { label: "chat connected to the fake server" });
  checks.connected = true;

  for (const dark of [false, true]) {
    const t = dark ? "dark" : "light";
    await setTheme(dark);
    fake.state.dates = dark ? ["2026-10-16", "2026-10-18"] : ["2026-10-13", "2026-10-15"];
    await cdp.evaluate(`app.plugins.plugins['vault-gantt'].chatSession.newConversation()`);
    await cdp.waitForExpression("document.querySelector('.vg-ai-empty')", { label: "empty state" });
    await shot(`${t}_1_empty`);
    // Enter / Shift+Enter with real key events.
    await typeIntoComposer("一行目");
    await pressEnter(8);
    await typeIntoComposer("二行目");
    checks[t + "_shiftEnterNewline"] = (await cdp.evaluate("document.querySelector('.vg-ai-composer textarea').value")) === "一行目\n二行目";
    checks[t + "_noSendOnShiftEnter"] = (await cdp.evaluate("document.querySelectorAll('.vg-ai-message').length")) === 0;
    await shot(`${t}_2_composer_multiline`, ".vg-ai-composer");
    await cdp.evaluate(`(() => { const input = document.querySelector('.vg-ai-composer textarea'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    fake.hold("reasoning");
    await typeIntoComposer("デザイン確認を3日後ろへずらして");
    await pressEnter();
    checks[t + "_enterSends"] = await cdp.waitForExpression("document.querySelectorAll('.vg-ai-user').length === 1", { label: "Enter sent the message" });
    await cdp.waitForExpression("document.querySelector('.vg-ai-reasoning')", { label: "reasoning streaming" });
    await shot(`${t}_3_thinking`);
    fake.release(); fake.hold("tool-args");
    await cdp.waitForExpression("document.querySelector('.vg-ai-tool[data-state=running]')", { label: "running tool" });
    await shot(`${t}_4_tool_running`);
    fake.release();
    await cdp.waitForExpression("document.querySelector('.vg-pv-card')", { timeoutMs: 30000, label: "inline card" });
    fake.hold("text");
    await cdp.waitForExpression("document.querySelector('.vg-ai-assistant .vg-ai-text')", { timeoutMs: 30000, label: "explanation streaming" });
    await shot(`${t}_5_explaining`);
    fake.release();
    await cdp.waitForExpression("!document.querySelector('.vg-ai-message[data-streaming=true]') && document.querySelector('.vg-ai-send') && !document.querySelector('.vg-ai-send').hidden", { timeoutMs: 30000, label: "turn finished" });
    await shot(`${t}_6_finished`);
    checks[t + "_cardInsideAssistant"] = await cdp.evaluate("!!document.querySelector('.vg-ai-assistant .vg-pv-card') && !document.querySelector('.vg-pv-chat-previews')");
    checks[t + "_noCountsOrOrigin"] = await cdp.evaluate("!/要求元|対象 \\d+件|操作 \\d+件|期限/.test(document.querySelector('.vg-pv-card').textContent)");
    checks[t + "_explanationNotFixedSentence"] = await cdp.evaluate("!document.querySelector('.vg-ai-chat').textContent.includes('変更案を作成しました')");
    // Expanded tool row.
    await cdp.evaluate(`document.querySelector('.vg-ai-tool > summary').click(); document.querySelector('.vg-ai-messages').scrollTop = 0;`);
    await new Promise((r) => setTimeout(r, 400));
    await shot(`${t}_7_tool_expanded`);
    await cdp.evaluate(`document.querySelector('.vg-ai-reasoning > summary')?.click()`);
    // Follow-up message flows below the card.
    await typeIntoComposer("ありがとう");
    await pressEnter();
    await cdp.waitForExpression("document.querySelectorAll('.vg-ai-assistant').length === 2 && document.querySelectorAll('.vg-ai-assistant')[1].textContent.includes('どういたしまして')", { timeoutMs: 30000, label: "follow-up reply" });
    await new Promise((r) => setTimeout(r, 600));
    await shot(`${t}_8_followup`);
    checks[t + "_followupBelowCard"] = await cdp.evaluate(`(() => { const card = document.querySelector('.vg-pv-card').getBoundingClientRect(); const next = document.querySelectorAll('.vg-ai-assistant')[1].getBoundingClientRect(); return next.top > card.bottom; })()`);
    if (!dark) {
      await cdp.evaluate(`document.querySelector('.vg-pv-card [data-action=approve]').click()`);
      await cdp.waitForExpression("document.querySelector('.vg-pv-card')?.dataset.state === 'success'", { timeoutMs: 15000, label: "saved" });
      await cdp.evaluate(`document.querySelector('.vg-ai-messages').scrollTop = document.querySelector('.vg-ai-messages').scrollHeight`);
      await shot(`${t}_9_saved`);
    }
  }
  // Wide tab layout, dark.
  await cdp.evaluate(`(async () => {
    app.workspace.getLeavesOfType('vault-gantt-ai-chat')[0].detach();
    await app.plugins.plugins['vault-gantt'].openAIChat('tab');
    app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  await shot("dark_10_wide_tab");
  // Hover Editor: a page-preview popover over a link must not raise errors.
  if (process.env.HOVER_EDITOR_DIR) {
    await cdp.evaluate(`(async () => { const leaf = app.workspace.getLeaf('tab'); await leaf.openFile(app.vault.getAbstractFileByPath('合成UIテスト.md')); })()`);
    await new Promise((r) => setTimeout(r, 800));
    await cdp.evaluate(`(() => { const link = document.querySelector('.markdown-reading-view a.internal-link, .markdown-source-view a.cm-hmd-internal-link, .cm-hmd-internal-link'); if (link) link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 300, clientY: 200, metaKey: true, ctrlKey: true })); })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await shot("dark_11_hover_editor");
  }
  const errors = cdp.capturedErrors();
  checks.consoleErrors = errors;
  console.log("CHECKS", JSON.stringify(checks, null, 2));
  const failed = Object.entries(checks).filter(([name, value]) => name !== "consoleErrors" && value !== true);
  if (failed.length || errors.length) { console.error("FAILED", JSON.stringify({ failed, errors })); process.exitCode = 1; }
} catch (error) {
  // Show what the chat looked like when a step failed.
  try { console.error("CHAT TEXT AT FAILURE:", await cdp.evaluate("document.querySelector('.vg-ai-chat')?.innerText")); console.error("CAPTURED ERRORS:", JSON.stringify(cdp.capturedErrors())); } catch { /* ignore */ }
  try { const result = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(outDir, "failure.png"), Buffer.from(result.data, "base64")); } catch { /* ignore */ }
  console.error("FAKE SERVER REQUESTS:", fake.requests.length);
  throw error;
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  await Promise.all([stopGroup(obsidian), stopGroup(xvfb), fake.close()]);
}
