// Real-Obsidian timing for a v2 vault (P parents x S subtasks): open view, hover, single-bar drag
// (repaint / note saved / metadataCache wait). Usage: node tools/e2e/perf-v2-real.mjs [parents] [subtasks]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode22, generateFixtures } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";
import { dismissTrustDialogIfPresent, hoverOnto, moveMouse, mouseDown, mouseUp, sleep } from "./scenarios/cdp-input.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const parents = Number(process.argv[2] ?? 50), subs = Number(process.argv[3] ?? 100);
assertNode22();
const vaultDir = path.join(REPO, "tools", "e2e", "tmp", `perfv2-${process.pid}`, "vault");
const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(REPO, f), path.join(pluginDir, f));
fs.writeFileSync(path.join(vaultDir, ".obsidian", "community-plugins.json"), JSON.stringify(["vault-gantt"]));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ ganttNationalHolidays: ["2000-01-01"], ganttNationalHolidaysUpdatedAt: new Date().toISOString() }));
const paths = await generateFixtures({ vaultDir, count: parents, subtasksPerParent: subs });
const rt = await startObsidian({ vaultDir });
const cdp = rt.cdp;
try {
  await cdp.waitForExpression(`!!app.plugins.manifests["vault-gantt"]`, { timeoutMs: 60000, label: "manifest" });
  await enablePlugin(cdp, "vault-gantt");
  const t0 = Date.now();
  if (process.argv[4] === "early") {
    // open the view the moment the plugin loads, while Obsidian is still indexing
    await cdp.evaluate(`app.commands.executeCommandById("vault-gantt:open-task-gantt"), true`);
    for (let i = 0; i < 300; i++) {
      const o = JSON.parse(await cdp.evaluate(`JSON.stringify({rows: document.querySelectorAll(".task-gantt-parent-row").length, idx: app.vault.getMarkdownFiles().filter(f => app.metadataCache.getFileCache(f)).length, empty: !!document.querySelector(".task-gantt-empty, .task-gantt-container .mod-empty")})`));
      if (i % 10 === 0 || o.rows) console.log(`t+${Date.now() - t0}ms rows=${o.rows} indexed=${o.idx} empty=${o.empty}`);
      if (o.rows >= parents) break;
      await sleep(200);
    }
    await dismissTrustDialogIfPresent(cdp);
    await sleep(15000);
    console.log("after 15s extra:", await cdp.evaluate(`JSON.stringify({rows: document.querySelectorAll(".task-gantt-parent-row").length, bars: document.querySelectorAll(".task-gantt-bar").length, indexed: app.vault.getMarkdownFiles().filter(f => app.metadataCache.getFileCache(f)).length})`));
    await cdp.screenshot(path.join(REPO, "tools/e2e/artifacts/perfv2-early.png"));
    rt.kill(); process.exit(0);
  }
  await cdp.waitForExpression(`(() => { const fs = app.vault.getMarkdownFiles().filter(f => f.path.startsWith("tasks/")); return fs.length === ${paths.length} && fs.every(f => app.metadataCache.getFileCache(f)?.frontmatter) })()`, { timeoutMs: 120000, intervalMs: 250, label: "indexed" });
  console.log(`index wait after plugin enable: ${Date.now() - t0}ms (${paths.length} notes)`);
  await cdp.evaluate(`window.__t = { mut: 0, last: performance.now() }; true`);
  const open0 = await cdp.evaluate(`(() => { performance.mark("open"); window.__open = performance.now(); app.commands.executeCommandById("vault-gantt:open-task-gantt"); return performance.now(); })()`);
  let first = null;
  for (let i = 0; i < 600; i++) {
    const s = await cdp.evaluate(`JSON.stringify({c: !!document.querySelector(".task-gantt-container"), rows: document.querySelectorAll(".task-gantt-parent-row").length, bars: document.querySelectorAll(".task-gantt-bar").length, now: performance.now()})`);
    const o = JSON.parse(s);
    if (o.rows > 0 && first === null) { first = o.now - open0; console.log(`first parent rows visible: ${first.toFixed(0)}ms rows=${o.rows} bars=${o.bars}`); }
    if (o.rows >= parents) { console.log(`open-view ready (rows=${o.rows}, bars=${o.bars}): ${(o.now - open0).toFixed(0)}ms`); break; }
    await sleep(100);
    if (i === 599) console.log("never reached rows", s);
  }
  await dismissTrustDialogIfPresent(cdp);
  await sleep(1500);
  console.log("state", await cdp.evaluate(`JSON.stringify({bars: document.querySelectorAll(".task-gantt-bar").length, cls: [...new Set([...document.querySelectorAll(".task-gantt-container *")].map(e=>e.className).filter(c=>typeof c==="string"&&/row|toggle|collapse/.test(c)))].slice(0,30), types: app.workspace.getLeavesOfType ? app.workspace.getLeavesOfType("task-gantt-view").length : 0})`));
  // --- hooks in the page
  await cdp.evaluate(`(() => {
    const L = window.__log = [];
    const now = () => Date.now();
    const fm = app.fileManager.processFrontMatter.bind(app.fileManager);
    app.fileManager.processFrontMatter = async (f, fn, ...r) => { L.push(["pfm-start", f.path, now()]); const out = await fm(f, fn, ...r); L.push(["pfm-resolved", f.path, now()]); return out; };
    app.metadataCache.on("changed", (f) => L.push(["mc-changed", f.path, now()]));
    app.vault.on("modify", (f) => L.push(["vault-modify", f.path, now()]));
    app.metadataCache.on("resolved", () => L.push(["mc-resolved", "", now()]));
    window.__mo = new MutationObserver((muts) => { for (const m of muts) L.push(["dom", m.type + ":" + (m.target.className || m.target.nodeName), now()]); });
    window.__mo.observe(document.querySelector(".task-gantt-container"), { subtree: true, childList: true, attributes: true });
    return true;
  })()`);
  const samples = [];
  for (let n = 0; n < 4; n++) {
    const pick = JSON.parse(await cdp.evaluate(`(() => {
      const bars = [...document.querySelectorAll(".task-gantt-bar")].map((el, i) => ({ el, i, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 100 && r.left > 760 && r.right < 1500 && r.top > 300 && r.bottom < 1000);
      const b = bars[${n} * 7];
      window.__bar = b.el;
      return JSON.stringify({ i: b.i, text: b.el.textContent, cx: b.r.left + b.r.width / 2, cy: b.r.top + b.r.height / 2, left: b.el.style.left });
    })()`));
    await cdp.evaluate(`window.__log.length = 0; true`);
    await moveMouse(cdp, pick.cx, pick.cy); await sleep(30);
    await mouseDown(cdp, pick.cx, pick.cy); await sleep(30);
    for (let i = 1; i <= 5; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pick.cx + (84 * i) / 5, y: pick.cy, buttons: 1, pointerType: "mouse" }); await sleep(15); }
    await sleep(30);
    const tUp = Date.now();
    await cdp.evaluate(`window.__log.push(["mouse-up-sent", "", ${tUp}]); true`);
    await mouseUp(cdp, pick.cx + 84, pick.cy);
    await sleep(3500);
    const log = JSON.parse(await cdp.evaluate(`JSON.stringify(window.__log)`));
    const rel = (e) => e[2] - tUp;
    const first = (k) => log.find((e) => e[0] === k && !e[1].includes("tasks/") || e[0] === k);
    const ev = (k) => log.filter((e) => e[0] === k).map(rel);
    const doms = log.filter((e) => e[0] === "dom").map(rel);
    const stillAttached = await cdp.evaluate(`window.__bar.isConnected`);
    const newLeft = await cdp.evaluate(`window.__bar.isConnected ? window.__bar.style.left : "(detached)"`);
    samples.push({ bar: pick.text, left: pick.left, pfmStart: ev("pfm-start"), vaultModify: ev("vault-modify"), pfmResolved: ev("pfm-resolved"), mcChanged: ev("mc-changed"), mcResolved: ev("mc-resolved"), domFirst: doms[0], domLast: doms.at(-1), domCount: doms.length, barElementReused: stillAttached, newLeft });
    console.log(`drag #${n + 1}`, JSON.stringify(samples.at(-1)));
    await sleep(500);
  }
  // hover
  const hv = JSON.parse(await cdp.evaluate(`(() => { const b = [...document.querySelectorAll(".task-gantt-bar")].map(e => e.getBoundingClientRect()).filter(r => r.width > 100 && r.left > 760 && r.right < 1500 && r.top > 300 && r.bottom < 1000)[3]; return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 }); })()`));
  await moveMouse(cdp, 1700, 120); await sleep(300);
  const h0 = Date.now();
  await cdp.evaluate(`window.__h0 = Date.now(); true`);
  await moveMouse(cdp, hv.x, hv.y);
  let hoverMs = null;
  for (let i = 0; i < 100; i++) { if (await cdp.evaluate(`!!document.querySelector(".task-gantt-rich-popover.is-subtask")`)) { hoverMs = Date.now() - h0; break; } await sleep(10); }
  console.log("hover->popover:", hoverMs, "ms");
  await cdp.screenshot(path.join(REPO, "tools/e2e/artifacts/perfv2.png"));
} finally { rt.kill(); }
