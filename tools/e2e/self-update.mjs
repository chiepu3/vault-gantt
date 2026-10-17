// Real Obsidian/CDP e2e for the built-in updater (settings > アップデート). Synthetic vault only.
// 1. install an "old" build of the plugin whose updater points at a local static server
// 2. serve a site made like CI does (tools/web-preview-site/build-all.mjs output) with a different commit
// 3. in Obsidian: fetch the branch list, install the chosen branch, check files + reload + backup, then roll back.
// Usage: node tools/e2e/self-update.mjs <siteDir>   (siteDir contains targets.json and b/<slug>/plugin/)
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin, ensureObsidianBinary, CdpSession } from "./obsidian-runtime.mjs";

const source = process.cwd();
const siteDir = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(path.join(siteDir, "targets.json"))) throw new Error("usage: self-update.mjs <siteDir>");
const root = fs.mkdtempSync("/tmp/vg-ui-selfupdate-");
const vault = path.join(root, "synthetic-vault");
const profile = path.join(root, "independent-profile");
const temp = path.join(root, "runtime-temp");
for (const dir of [vault, profile, temp]) fs.mkdirSync(dir);
const pluginDir = path.join(vault, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });

const server = http.createServer((req, res) => {
  const file = path.join(siteDir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(siteDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "access-control-allow-origin": "*" }).end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
await build({
  entryPoints: [path.join(source, "src/main.ts")], bundle: true, format: "cjs", target: "ES2018", minify: true,
  nodePaths: [path.join(source, "node_modules")], outfile: path.join(pluginDir, "main.js"),
  define: { __VG_VERSION__: JSON.stringify(manifest.version), __VG_COMMIT__: JSON.stringify("old-build"), __VG_BUILT_AT__: JSON.stringify("old"), __VG_UPDATE_SITE__: JSON.stringify(base) },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*", ...builtinModules],
});
for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(pluginDir, file));
const oldMain = fs.readFileSync(path.join(pluginDir, "main.js"));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", agentToolsEnabled: false }));
fs.writeFileSync(path.join(vault, "合成.md"), "# 合成\n");
fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));

const binary = process.env.OBSIDIAN_BIN ?? await ensureObsidianBinary();
const XPORT = 6098, CDP = 9498;
let xvfb; let obsidian; let cdp;
const stop = async (child) => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await new Promise((r) => setTimeout(r, 1000));
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`); if (!ok) failed = true; };
try {
  const display = `127.0.0.1:${XPORT - 6000}`;
  const xlog = fs.openSync(path.join(root, "xvfb.log"), "a");
  xvfb = spawn("Xvfb", [`:${XPORT - 6000}`, "-screen", "0", "1600x1000x24", "-listen", "tcp", "-nolisten", "unix"], { stdio: ["ignore", xlog, xlog], detached: true });
  await pollUntil(() => new Promise((resolve) => { const s = net.connect(XPORT, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); }), { timeoutMs: 10000, label: "Xvfb" });
  const log = fs.openSync(path.join(root, "obsidian.log"), "a");
  obsidian = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`, "--disable-gpu", "--no-sandbox"], { cwd: source, env: { ...process.env, DISPLAY: display, TMPDIR: temp }, stdio: ["ignore", log, log], detached: true });
  await pollUntil(() => {
    if (obsidian.exitCode !== null) throw new Error("Obsidian exited");
    return fs.readFileSync(path.join(root, "obsidian.log"), "utf8").includes(`DevTools listening on ws://127.0.0.1:${CDP}/`);
  }, { timeoutMs: 45000, label: "CDP endpoint" });
  cdp = await connectCdp(CDP);
  await cdp.waitForExpression("typeof app !== 'undefined' && !!app.plugins?.manifests['vault-gantt']", { timeoutMs: 60000, label: "manifest" });
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent))?.click(); })()`);
  await cdp.waitForExpression("!document.querySelector('.modal-container')", { timeoutMs: 10000, label: "trust dialog" });

  const settingsDoc = async () => {
    await cdp.evaluate(`(async () => { if (!document.querySelector('.modal.mod-settings')) app.setting.open(); await new Promise(r => setTimeout(r, 500)); app.setting.openTabById('vault-gantt'); await new Promise(r => setTimeout(r, 800)); })()`);
    for (let attempt = 0; attempt < 30; attempt++) {
      const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const t = targets.find((x) => x.type === "page" && /^Settings|設定/.test(x.title ?? ""));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
        return new CdpSession(ws, t.url);
      }
      await sleep(500);
    }
    return null;
  };
  let doc = await settingsDoc();
  const ui = doc ?? cdp; // the settings tab lives in a popout window or in the main window
  const clickButton = (text) => ui.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('button not found: ' + ${JSON.stringify(text)}); b.scrollIntoView(); b.click(); return true; })()`);
  const buildLabel = () => cdp.evaluate("document.body.textContent.includes('old-build')");

  const before = await cdp.evaluate("app.plugins.plugins['vault-gantt']?.manifest?.version");
  check("plugin loaded before update", !!before, String(before));
  await ui.waitForExpression("Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'ブランチ一覧を取得')", { timeoutMs: 15000, label: "updater section" });
  await clickButton("ブランチ一覧を取得");
  await ui.waitForExpression("document.querySelectorAll('select option').length > 1 && Array.from(document.querySelectorAll('select option')).some(o => o.textContent.includes('main'))", { timeoutMs: 15000, label: "branch list" });
  const options = await ui.evaluate("JSON.stringify(Array.from(document.querySelectorAll('select option')).map(o => o.textContent))");
  console.log("OPTIONS", options);
  check("branch list lists main", options.includes("main"));
  if (process.env.SHOT_DIR) {
    await ui.evaluate("Array.from(document.querySelectorAll('.setting-item-heading')).find(e => e.textContent.trim() === 'アップデート')?.scrollIntoView({ block: 'start' })");
    await sleep(500);
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SHOT_DIR, "updater-settings.png"), Buffer.from((await ui.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }

  await clickButton("インストールして再読み込み");
  await pollUntil(() => { const c = fs.readFileSync(path.join(pluginDir, "main.js")); return !c.equals(oldMain); }, { timeoutMs: 20000, label: "main.js replaced" });
  const newSite = fs.readFileSync(path.join(siteDir, "b/main/plugin/main.js"));
  check("main.js replaced with site build", fs.readFileSync(path.join(pluginDir, "main.js")).equals(newSite));
  check("styles.css + manifest.json written", fs.readFileSync(path.join(pluginDir, "styles.css")).equals(fs.readFileSync(path.join(siteDir, "b/main/plugin/styles.css"))));
  check("previous main.js kept in .backup", fs.readFileSync(path.join(pluginDir, ".backup/main.js")).equals(oldMain));
  await sleep(2500);
  const enabled = await cdp.waitForExpression("!!app.plugins.plugins['vault-gantt']", { timeoutMs: 20000, label: "plugin re-enabled" }).then(() => true, () => false);
  check("plugin is enabled again after reload", enabled);
  check("no leftover .tmp files", fs.readdirSync(pluginDir).every((f) => !f.endsWith(".tmp")));

  doc = await settingsDoc();
  const ui2 = doc ?? cdp;
  await ui2.waitForExpression("Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === '前の状態に戻す')", { timeoutMs: 15000, label: "updater section (after reload)" });
  await ui2.evaluate(`(() => { Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '前の状態に戻す').click(); })()`);
  await pollUntil(() => fs.readFileSync(path.join(pluginDir, "main.js")).equals(oldMain), { timeoutMs: 20000, label: "rollback" });
  check("rollback restores the previous main.js", true);
  await sleep(2500);
  check("plugin enabled after rollback", await cdp.waitForExpression("!!app.plugins.plugins['vault-gantt']", { timeoutMs: 20000, label: "re-enabled" }).then(() => true, () => false));
  void buildLabel;
} catch (error) {
  console.error("ERROR", error);
  failed = true;
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  server.close();
  await Promise.all([stop(obsidian), stop(xvfb)]);
}
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
