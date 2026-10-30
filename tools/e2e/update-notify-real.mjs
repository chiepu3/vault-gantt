// Real Obsidian/CDP e2e for the new-version notice. Synthetic vault and a synthetic local update site only.
// 1. install the current build with its updater pointed at a local server that serves a "new" build (v99.0.0)
// 2. version label click while the site is not newer -> "最新です"; startup check (plugin reload) with a newer site -> Notice with 更新する
// 3. click 更新する -> files replaced. Usage: node tools/e2e/update-notify-real.mjs [shotDir]
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { connectCdp, pollUntil, enablePlugin, ensureObsidianBinary, CdpSession } from "./obsidian-runtime.mjs";

const source = process.cwd();
const shotDir = process.argv[2];
const root = fs.mkdtempSync("/tmp/vgu-");
const siteDir = path.join(root, "site");
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
const writeSite = async (version) => {
  const dir = path.join(siteDir, "b/main/plugin");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "main.js"))) {
    await build({
      entryPoints: [path.join(source, "src/main.ts")], bundle: true, format: "cjs", target: "ES2018", minify: true,
      nodePaths: [path.join(source, "node_modules")], outfile: path.join(dir, "main.js"),
      define: { __VG_VERSION__: JSON.stringify("99.0.0"), __VG_COMMIT__: JSON.stringify("new-build"), __VG_BUILT_AT__: JSON.stringify("new"), __VG_UPDATE_SITE__: JSON.stringify(base) },
      external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*", ...builtinModules],
    });
    for (const file of ["styles.css", "manifest.json"]) fs.copyFileSync(path.join(source, file), path.join(dir, file));
  }
  const files = {};
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    const data = fs.readFileSync(path.join(dir, name));
    files[name] = { size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ branch: "main", sha: "newsha1234567", version, builtAt: "now", files }));
  fs.writeFileSync(path.join(siteDir, "targets.json"), JSON.stringify({ targets: [{ branch: "main", slug: "main", sha: "newsha1234567", kind: "main", status: "success", plugin: true, commitTime: "2026-10-22" }] }));
};
await writeSite(manifest.version);
const oldMain = fs.readFileSync(path.join(pluginDir, "main.js"));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), '["vault-gantt"]');
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ taskFolder: "tasks", agentToolsEnabled: false }));
fs.writeFileSync(path.join(vault, "合成.md"), "# 合成\n");
fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));

const binary = process.env.OBSIDIAN_BIN ?? await ensureObsidianBinary();
const XPORT = 6097, CDP = 9497;
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


  await cdp.evaluate("app.commands.executeCommandById('vault-gantt:open-task-gantt')");
  await cdp.waitForExpression("!!document.querySelector('.task-gantt-version-info')", { timeoutMs: 20000, label: "version label" });
  const noticeText = () => cdp.evaluate("Array.from(activeDocument.querySelectorAll('.notice')).map(n => n.textContent).join(' | ')");
  // Notices render into activeDocument, which may be another window than the one cdp is attached to: capture the page that has them.
  const shot = async (name) => {
    if (!shotDir) return;
    fs.mkdirSync(shotDir, { recursive: true });
    const pages = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).filter((t) => t.type === "page");
    let n = 0;
    for (const t of pages) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
      const session = new CdpSession(ws, t.url);
      const hasNotice = await session.evaluate("document.querySelectorAll('.notice').length > 0").catch(() => false);
      if (hasNotice || pages.length === 1) fs.writeFileSync(path.join(shotDir, name.replace(".png", n++ ? `-${n}.png` : ".png")), Buffer.from((await session.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      ws.close();
    }
  };

  check("no notice at start-up when the site is not newer", !(await noticeText()).includes("新しいバージョン"));
  await cdp.evaluate("document.querySelector('.task-gantt-version-info').click()");
  await cdp.waitForExpression("Array.from(activeDocument.querySelectorAll('.notice')).some(n => n.textContent.includes('最新です'))", { timeoutMs: 15000, label: "latest notice" });
  check("label click says up to date", true, await noticeText());
  await shot("latest.png");

  await writeSite("99.0.0");
  await cdp.evaluate("(async () => { await app.plugins.disablePlugin('vault-gantt'); await app.plugins.enablePlugin('vault-gantt'); })()");
  await cdp.waitForExpression("Array.from(activeDocument.querySelectorAll('.notice')).some(n => n.textContent.includes('v99.0.0') && n.querySelector('button'))", { timeoutMs: 30000, label: "startup update notice" });
  check("startup check shows notice with 更新する", true, await noticeText());
  await shot("startup-notice.png");

  await cdp.evaluate("Array.from(activeDocument.querySelectorAll('.notice button')).find(b => b.textContent === '更新する').click()");
  await pollUntil(() => !fs.readFileSync(path.join(pluginDir, "main.js")).equals(oldMain), { timeoutMs: 30000, label: "main.js replaced" });
  check("main.js replaced by the new build", fs.readFileSync(path.join(pluginDir, "main.js")).equals(fs.readFileSync(path.join(siteDir, "b/main/plugin/main.js"))));
  await sleep(3000);
  check("plugin enabled after reload", await cdp.waitForExpression("!!app.plugins.plugins['vault-gantt']", { timeoutMs: 20000, label: "re-enabled" }).then(() => true, () => false));
  await cdp.evaluate("app.commands.executeCommandById('vault-gantt:open-task-gantt')");
  await cdp.waitForExpression("document.querySelector('.task-gantt-version-info')?.textContent.includes('99.0.0')", { timeoutMs: 20000, label: "new version label" });
  check("toolbar shows v99.0.0", true);
  await shot("after-update.png");
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
