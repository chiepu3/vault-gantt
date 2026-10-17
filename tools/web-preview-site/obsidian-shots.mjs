// Real-Obsidian screenshot gallery for one preview target.
// Usage: node obsidian-shots.mjs --app <built checkout: main.js/styles.css/manifest.json + node_modules>
//                                --out <dir> --tools <tools checkout (obsidian-runtime.mjs)>
// Launches ONE headless Obsidian against a throwaway Japanese sample vault, enables the plugin and captures the
// Gantt, Workbench, settings tab and AI chat in light + dark at 1280x800 into <out>/*.png (+ index.html gallery).
// A failing view is skipped and noted; the exit code is 0 whenever at least one PNG was written.
// Works as an ordinary user (GitHub runner: E2E_OBSIDIAN_BIN + SUID sandbox helper) and as root (local container:
// Obsidian is started as nobody via setpriv so Chromium's sandbox stays on).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs, escapeHtml as h } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.app || !args.out || !args.tools) { console.error("usage: obsidian-shots.mjs --app dir --out dir --tools dir"); process.exit(2); }
const app = path.resolve(args.app), out = path.resolve(args.out), tools = path.resolve(args.tools);
const label = args.label ? String(args.label) : "";
const W = 1280, H = 800;
const runtime = await import(pathToFileURL(path.join(tools, "tools/e2e/obsidian-runtime.mjs")).href);
const { CdpSession, startObsidian, startXvfb, connectCdp, enablePlugin, ensureObsidianBinary, pollUntil } = runtime;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = []; // skipped / failed shots
const shots = []; // { file, view, theme }
fs.mkdirSync(out, { recursive: true });

// 1. Sample data: dates relative to today, notes written by the TARGET's own buildFullNote.
const ISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ISO(d); };
const range = (a, b, hrs) => { const o = {}; for (let i = a; i <= b; i++) { const d = new Date(); d.setDate(d.getDate() + i); if (d.getDay() % 6) o[ISO(d)] = hrs; } return o; };
const PARENTS = [
  { name: "新機能リリース準備", tags: ["開発"], due: 14, prio: 4, created: -12, current: "仕様はレビュー済み。実装を進めつつ、デザイン確認の日程を調整中。", subs: [
    { key: "spec", title: "仕様書レビュー", from: -8, to: -4, status: "done", plan: 3, actual: [-8, -4, 3] },
    { key: "impl", title: "実装", from: -3, to: 6, status: "in_progress", tags: ["開発"], plan: 5, actual: [-3, 0, 4.5], markers: [["m1", "中間レビュー", 2]] },
    { key: "design", title: "デザイン確認", from: 1, to: 3, status: "active", tags: ["デザイン"], plan: 2 },
    { key: "qa", title: "結合テスト", from: 7, to: 10, status: "active", plan: 4 },
    { key: "judge", title: "リリース判定会議", from: 12, to: 12, status: "active", markers: [["m2", "判定", 12]] } ] },
  { name: "社内ポータル改善", tags: ["開発", "デザイン"], due: 20, prio: 3, created: -20, subs: [
    { key: "survey", title: "利用状況の調査", from: -6, to: -1, status: "done", tags: ["調査"], plan: 2, actual: [-6, -1, 2] },
    { key: "wire", title: "ワイヤーフレーム作成", from: 0, to: 4, status: "in_progress", tags: ["デザイン"], plan: 3, actual: [0, 0, 3] },
    { key: "build", title: "トップページ実装", from: 5, to: 13, status: "active", tags: ["開発"], plan: 5 },
    { key: "feedback", title: "社内フィードバック収集", from: 14, to: 18, status: "waiting", plan: 1 } ] },
  { name: "月次レポート作成", tags: ["運用"], due: 9, prio: 2, created: -5, subs: [
    { key: "data", title: "売上データの集計", from: -2, to: 1, status: "in_progress", plan: 3, actual: [-2, 0, 3] },
    { key: "chart", title: "グラフ・コメント作成", from: 2, to: 5, status: "active", plan: 3 },
    { key: "send", title: "上長レビューと配布", from: 6, to: 8, status: "active", plan: 1 } ] },
  { name: "顧客ヒアリング（Q4）", tags: ["調査"], due: 25, prio: 3, created: -9, subs: [
    { key: "list", title: "対象顧客リストの作成", from: -4, to: -2, status: "done", plan: 2, actual: [-4, -2, 2] },
    { key: "mail", title: "依頼メール送付", from: 0, to: 1, status: "in_progress", plan: 1 },
    { key: "session", title: "ヒアリング実施（5社）", from: 4, to: 12, status: "active", plan: 3 },
    { key: "summary", title: "結果の取りまとめ", from: 13, to: 17, status: "hold", plan: 2 } ] },
  { name: "採用面接の日程調整", tags: [], due: 6, prio: 2, created: -2, gantt: false, subs: [] },
];

async function loadBuildFullNote(scratch) {
  // Bundle the target's own note serializer (obsidian import -> the target's test stub) with the target's esbuild.
  const requireFromApp = createRequire(path.join(app, "package.json"));
  const esbuild = requireFromApp("esbuild");
  const stub = path.join(app, "tests/stubs/obsidian.ts");
  const outfile = path.join(scratch, "note-format.cjs");
  await esbuild.build({
    entryPoints: [path.join(app, "src/core/note-format.ts")], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(stub).href) },
    alias: fs.existsSync(stub) ? { obsidian: stub } : {}, nodePaths: [path.join(app, "node_modules")],
  });
  return createRequire(outfile)(outfile).buildFullNote;
}

function seedVault(vault, buildFullNote) {
  const t = ISO(new Date());
  PARENTS.forEach((p, idx) => {
    const created = plus(p.created);
    const file = `tasks/${created.slice(0, 4)}/${created.slice(5, 7)}/${created} ${p.name}.md`;
    const common = { createdAt: created, updatedAt: t, completed: false, priority: 0, priorityMode: "auto", currentStatus: "", notes: "", tags: [] };
    const subtasks = new Map();
    for (const s of p.subs) {
      subtasks.set(s.key, { ...common, kind: "subtask", id: `${file}::${s.key}`, key: s.key, file: { path: file, parentPath: file, heading: s.title }, title: s.title, displayName: s.title,
        statusLabel: s.status ?? "active", completed: s.status === "done", tags: s.tags ?? [], ganttEnabled: false,
        plannedStartDate: plus(s.from), plannedEndDate: plus(s.to), workloadPlan: s.plan ? range(s.from, s.to, s.plan) : undefined,
        workloadActual: s.actual ? range(s.actual[0], s.actual[1], s.actual[2]) : undefined,
        ganttMarkers: s.markers?.map(([key, title, day]) => ({ key, title, date: plus(day), tags: [] })) });
    }
    const parent = { ...common, kind: "parent", id: file, file: { path: file }, title: p.name, displayName: p.name, statusLabel: "in_progress",
      dueDate: plus(p.due), priority: p.prio, priorityMode: "manual", tags: p.tags, ganttEnabled: p.gantt ?? true, ganttOrder: idx, currentStatus: p.current ?? "", subtasks };
    fs.mkdirSync(path.dirname(path.join(vault, file)), { recursive: true });
    fs.writeFileSync(path.join(vault, file), buildFullNote(parent, subtasks));
  });
  fs.mkdirSync(path.join(vault, "メモ"), { recursive: true });
  fs.writeFileSync(path.join(vault, "README.md"), "# Vault Gantt サンプル\n\n実機のObsidianで撮影したスクリーンショット用のサンプルVaultです。\n");
}

// 2. Obsidian launch (user or root)
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const freePort = (start) => new Promise((resolve, reject) => {
  const tryPort = (p) => { if (p > start + 300) return reject(new Error("no free port")); const s = net.createServer(); s.once("error", () => tryPort(p + 1)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(p))); };
  tryPort(start);
});

async function launch(vault, root) {
  if (!isRoot) return startObsidian({ vaultDir: vault });
  const binary = await ensureObsidianBinary();
  spawnSync("chmod", ["-R", "a+rX", path.dirname(binary)]); // the AppImage extracts 0700; nobody must be able to read it
  const profile = path.join(root, "profile"), temp = path.join(root, "tmp");
  fs.mkdirSync(profile); fs.mkdirSync(temp);
  fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));
  spawnSync("chown", ["-R", "65534:65534", root]);
  const xvfb = await startXvfb();
  const cdpPort = await freePort(9400);
  const logFile = path.join(root, "obsidian.log");
  const log = fs.openSync(logFile, "a");
  const proc = spawn("setpriv", ["--reuid=65534", "--regid=65534", "--clear-groups", binary, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"],
    { cwd: path.dirname(binary), env: { ...process.env, DISPLAY: xvfb.display, TMPDIR: temp, HOME: root }, detached: true, stdio: ["ignore", log, log] });
  const kill = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } xvfb.kill(); };
  try {
    const cdp = await connectCdp(cdpPort);
    await cdp.waitForExpression("typeof app !== 'undefined' && !!app && !!app.plugins", { timeoutMs: 60000, label: "app.plugins" });
    return { cdp, cdpPort, kill: () => { cdp.close(); kill(); }, logFile };
  } catch (e) { kill(); throw e; }
}

// 3. Main
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vg-shots-"));
const vault = path.join(root, "vault");
const pluginDir = path.join(vault, ".obsidian/plugins/vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "styles.css", "manifest.json"]) fs.copyFileSync(path.join(app, f), path.join(pluginDir, f));
seedVault(vault, await loadBuildFullNote(root));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["vault-gantt"]));
fs.writeFileSync(path.join(vault, ".obsidian/app.json"), JSON.stringify({ promptDelete: false }));
const holidays = []; // offline: no holiday fetch
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({
  taskFolder: "tasks", autoPriorityEnabled: true, ganttZoom: 28, ganttNationalHolidays: holidays, ganttNationalHolidaysUpdatedAt: ISO(new Date()),
  ganttTags: [["dev", "開発", "#2563eb"], ["design", "デザイン", "#7c3aed"], ["ops", "運用", "#12883e"], ["research", "調査", "#b16105"]].map(([key, name, color], order) => ({ key, name, color, order })),
  ai: { preset: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "sample-model", useApiKey: false },
}));

let rt;
const finish = async (code) => { try { rt?.kill(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(code); };
const hardStop = setTimeout(() => { console.error("[shots] overall timeout"); notes.push("全体のタイムアウト"); writeGallery(); finish(shots.length ? 0 : 1); }, Number(args.timeout || 170) * 1000);
hardStop.unref?.();

function writeGallery() {
  const themes = { light: "ライト", dark: "ダーク" };
  const views = [...new Set(shots.map((s) => s.view))];
  const sections = views.map((v) => `<section><h2>${h(v)}</h2><div class="row">${["light", "dark"].map((th) => {
    const s = shots.find((x) => x.view === v && x.theme === th);
    return s ? `<a href="${h(s.file)}" class="shot"><img loading="lazy" src="${h(s.file)}" alt="${h(v)} ${themes[th]}"><span>${themes[th]}</span></a>` : `<div class="shot none"><span>${themes[th]}: 撮影なし</span></div>`;
  }).join("")}</div></section>`).join("\n");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>実機スクショ${label ? " - " + h(label) : ""}</title>
<style>:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f24;--line:#d9dde3;--mut:#5b6572}@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--line:#33383f;--mut:#98a2af}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}main{max-width:72rem;margin:0 auto;padding:16px}
h1{font-size:1.3rem;margin:8px 0}h2{font-size:1.05rem;margin:20px 0 8px}.sub{color:var(--mut);font-size:.9rem;margin:0}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:12px}.shot{display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden;text-decoration:none;color:inherit}
.shot img{display:block;width:100%;height:auto}.shot span{display:block;padding:4px 10px;font-size:.85rem;color:var(--mut)}.none{padding:20px 10px}
.note{border:1px solid var(--line);border-radius:10px;padding:8px 14px;margin-top:16px;color:var(--mut);font-size:.9rem}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;overflow:auto;z-index:9;-webkit-overflow-scrolling:touch}#lb.on{display:block}#lb img{display:block;width:max(100%,1280px);height:auto}
#lb button{position:fixed;top:8px;right:8px;z-index:10;font-size:1rem;padding:8px 14px;border-radius:8px;border:0}
a.back{display:inline-block;margin-top:8px}</style></head><body><main>
<a class="back" href="../">&larr; プレビューに戻る</a>
<h1>実機Obsidianのスクリーンショット</h1><p class="sub">${label ? h(label) + " · " : ""}Obsidian 実機(ヘッドレス) · ${W}x${H} · タップで拡大</p>
${sections || "<p>撮影できた画面がありません。</p>"}
${notes.length ? `<div class="note"><b>スキップ・注意</b><ul>${notes.map((n) => `<li>${h(n)}</li>`).join("")}</ul></div>` : ""}
</main><div id="lb"><button type="button">閉じる</button><img alt=""></div>
<script>(function(){var lb=document.getElementById("lb"),im=lb.querySelector("img");document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a.shot");if(a){e.preventDefault();im.src=a.href;lb.classList.add("on");lb.scrollTop=0}else if(e.target.closest&&e.target.closest("#lb")){lb.classList.remove("on")}});})();</script>
</body></html>`;
  fs.writeFileSync(path.join(out, "index.html"), html);
}

try {
  rt = await launch(vault, root);
  const cdp = rt.cdp;
  await cdp.waitForExpression("!!app.plugins.manifests['vault-gantt']", { timeoutMs: 30000, label: "manifest" });
  await enablePlugin(cdp, "vault-gantt");
  await cdp.evaluate(`(() => { Array.from(document.querySelectorAll('.modal button')).find(b => /Trust author|信頼/.test(b.textContent))?.click(); })()`).catch(() => {});
  await sleep(500);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }).catch((e) => notes.push("ビューポート固定に失敗: " + e.message));

  const closeAll = () => cdp.evaluate(`(async () => {
    try { app.setting?.close?.(); } catch {}
    app.workspace.iterateAllLeaves((l) => { try { l.detach(); } catch {} });
    try { app.workspace.rightSplit.collapse(); app.workspace.leftSplit.collapse(); } catch {}
    document.querySelectorAll('.modal-container .modal-close-button').forEach((b) => b.click());
    return true; })()`).catch(() => {});
  const setTheme = async (dark) => {
    await cdp.evaluate(`(async () => { const d = ${dark}; app.setTheme(d ? 'obsidian' : 'moonstone'); app.vault.setConfig('theme', d ? 'obsidian' : 'moonstone'); app.workspace.trigger('css-change'); await new Promise(r => setTimeout(r, 600)); })()`);
    const got = await cdp.evaluate("document.body.classList.contains('theme-dark') ? 'dark' : 'light'");
    if (got !== (dark ? "dark" : "light")) throw new Error(`theme switch failed (got ${got})`);
  };
  const VIEWS = [
    { id: "gantt", name: "ガントチャート", open: `app.plugins.plugins['vault-gantt'].navigation.activateGanttView()`, ready: `app.workspace.getLeavesOfType('task-gantt-view').length > 0 && document.querySelectorAll('.workspace-leaf-content[data-type="task-gantt-view"] *').length > 20`, wait: 1500 },
    { id: "workbench", name: "ワークベンチ", open: `app.plugins.plugins['vault-gantt'].navigation.activateView()`, ready: `app.workspace.getLeavesOfType('task-workbench-view').length > 0 && document.querySelectorAll('.workspace-leaf-content[data-type="task-workbench-view"] *').length > 20`, wait: 1500 },
    { id: "settings", name: "設定タブ", open: `(async () => { app.setting.open(); await new Promise(r => setTimeout(r, 400));  app.setting.openTabById('vault-gantt'); await new Promise(r => setTimeout(r, 300)); app.setting.activeTab?.display?.(); return [typeof app.setting, !!document.querySelector('.modal-container'), document.body.className].join('|'); })()`, popout: /^Settings|設定/, ready: `!!document.querySelector('.vertical-tab-content .setting-item')`, wait: 800 },
    { id: "ai-chat", name: "AIチャット", open: `(async () => { await app.plugins.plugins['vault-gantt'].openAIChat('tab'); await new Promise(r => setTimeout(r, 500)); const i = document.querySelector('.vg-ai-composer textarea'); if (i) { i.value = 'デザイン確認を3日後ろへずらして。'; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`, ready: `app.workspace.getLeavesOfType('vault-gantt-ai-chat').length > 0 && !!document.querySelector('.vg-ai-chat')`, wait: 800 },
  ];
  for (const theme of ["light", "dark"]) {
    try { await closeAll(); await setTheme(theme === "dark"); } catch (e) { notes.push(`${theme}: テーマ切替に失敗 (${e.message})`); continue; }
    for (const v of VIEWS) {
      const file = `${v.id}-${theme}.png`;
      try {
        await closeAll(); await sleep(300);
        const opened = await Promise.race([cdp.evaluate(v.open), sleep(20000).then(() => { throw new Error("open timeout"); })]);
        if (process.env.VG_SHOTS_DEBUG) console.error('open ->', opened);
        let target = cdp, popup = null;
        if (v.popout) {
          // Obsidian 1.13 opens settings in its own window = a separate CDP page target.
          const info = await pollUntil(async () => (await (await fetch(`http://127.0.0.1:${rt.cdpPort}/json/list`)).json()).find((t) => t.type === "page" && v.popout.test(t.title ?? "")), { timeoutMs: 15000, label: "settings window" });
          const ws = new WebSocket(info.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error("popout ws")), { once: true }); });
          target = popup = new CdpSession(ws, info.url);
          await popup.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }).catch(() => {});
        }
        try {
          await target.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W / 2, y: H / 2 }).catch(() => {}); // drop stale hover tooltips
          await target.waitForExpression(v.ready, { timeoutMs: 15000, label: v.id });
          await sleep(v.wait);
          await target.evaluate("document.activeElement?.blur?.(); document.querySelectorAll('.tooltip').forEach((e) => e.remove())");
          await target.screenshot(path.join(out, file));
        } finally { popup?.close(); }
        shots.push({ file, view: v.name, theme });
        console.log(`[shots] ${file}`);
      } catch (e) {
        notes.push(`${v.name} (${theme}) をスキップ: ${String(e.message).split("\n")[0].slice(0, 160)}`);
        console.error(`[shots] ${v.id}/${theme} skipped: ${e.message}`);
        if (process.env.VG_SHOTS_DEBUG) console.error(await cdp.evaluate("(document.querySelector('.modal-container')?.outerHTML ?? 'no modal').slice(0, 1500)").catch(() => "?"));
      }
    }
  }
} catch (e) {
  notes.push("Obsidian の起動または準備に失敗: " + String(e.message).split("\n")[0].slice(0, 200));
  console.error("[shots] fatal:", e.message);
  try { console.error(fs.readFileSync(path.join(root, "obsidian.log"), "utf8").split("\n").slice(-15).join("\n")); } catch { /* no log */ }
}
clearTimeout(hardStop);
writeGallery();
await finish(shots.length ? 0 : 1);
