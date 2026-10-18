// Real-Obsidian check of the v1 -> v2 conversion: a v1 vault is written with the legacy note builder
// (src/core/note-format.ts), then the command "ノート形式を v2 に変換" is run through its modal, and the
// result is verified on disk and in the Gantt. Usage: node tools/e2e/migration-v2-real.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode22, withRunner } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";
import { dismissTrustDialogIfPresent, dblclickAt, keydownOn, setFieldValue, sleep, scrollBarIntoView, centerOf, hoverOnto, moveMouse, mouseDown, mouseUp } from "./scenarios/cdp-input.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
assertNode22();
const root = path.join(REPO, "tools", "e2e", "tmp", `migv2-${process.pid}`);
const vaultDir = path.join(root, "vault");
const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(REPO, f), path.join(pluginDir, f));
fs.writeFileSync(path.join(vaultDir, ".obsidian", "community-plugins.json"), JSON.stringify(["vault-gantt"]));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ ganttNationalHolidays: ["2000-01-01"], ganttNationalHolidaysUpdatedAt: new Date().toISOString(), taskFolder: "tasks" }));

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = new Date(); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(0, 0, 0, 0);
const day = (n) => { const d = new Date(monday); d.setDate(d.getDate() + n); return iso(d); };
const today = iso(new Date());

// ---- v1 vault with the legacy builder
const base = { completed: false, ganttEnabled: false, tags: [], currentStatus: "", notes: "", priority: 0, priorityMode: "auto", createdAt: today, updatedAt: today, dueDate: undefined, statusLabel: "active" };
const row = (p) => ({ ...base, title: p.displayName, file: { path: "" }, ...p });
const parentsSpec = [
  { name: "アルファ案件", ord: 1, subs: [["設計", day(0), day(2)], ["実装", day(3), day(8)]] },
  { name: "ベータ案件", ord: 2, subs: [["調査", day(1), day(4)], ["報告", day(7), day(9)]] },
  { name: "ガンマ案件", ord: 3, subs: [["準備", day(2), day(3)], ["本番", day(10), day(12)]] },
  // same ganttOrder as ガンマ案件: the v1 gantt put ties in name order (localeCompare), file-path order would put this one first
  { name: "イプシロン案件", tie: true, ord: 3, subs: [["検討", day(4), day(5)], ["決定", day(6), day(7)]] },
];
const v1Files = {};
await withRunner(async (load) => {
  const { buildFullNote } = await load("src/core/note-format.ts");
  parentsSpec.forEach((spec, pi) => {
    const p = `tasks/${spec.tie ? "zz/" : ""}${today} ${spec.name}.md`;
    const subs = new Map(spec.subs.map(([title, s, e], i) => [`k${i}`, row({ kind: "subtask", id: `${p}::k${i}`, key: `k${i}`, displayName: title, statusLabel: i ? "in_progress" : "active", plannedStartDate: s, plannedEndDate: e, workloadPlan: { [s]: 2 }, notes: `${title}のメモ` })]));
    const parent = row({ kind: "parent", id: p, displayName: spec.name, ganttEnabled: true, file: { path: p }, notes: "親のメモ", tags: ["a"], currentStatus: "進行中" });
    parent.subtasks = subs;
    let text = buildFullNote(parent, subs).replace("ganttEnabled: true", `ganttEnabled: true\nganttOrder: ${(spec.tie ? pi : pi + 1) * 1000}`).replace("type: task\n", "type: task\nproject: 顧客A\n");
    // dashboard callouts as they really appear in v1 vaults (`- ` bullets, several pairs joined by " / ", plain values): none may become memo text
    const dash = [
      "> [!info]- サブタスクダッシュボード",
      "> - 優先度: `INPUT[select(option(0), option(1)):subtask__k0__priority]` / モード: `INPUT[select(option(auto), option(manual)):subtask__k0__priorityMode]`",
      "> - 計画開始: `INPUT[datePicker:subtask__k0__plannedStartDate]` / 計画終了: `INPUT[datePicker:subtask__k0__plannedEndDate]` / 期限: `INPUT[datePicker:subtask__k0__dueDate]`",
      "> - 作成日: `VIEW[{subtask__k0__createdAt}]` / 更新日: `VIEW[{subtask__k0__updatedAt}]`",
      "> - タグ: `INPUT[inlineList:subtask__k0__tags]`", "",
      "> [!info]- サブタスク情報", "> - 予定: 2026-08-26 ～ 2026-08-29", "",
      "> [!info]- タスク情報", "> - 状態: active", "",
      "> [!info] タスクダッシュボード", "> - 優先度: `INPUT[select(option(0)):priority]` / モード: `INPUT[select(option(auto)):priorityMode]`", "",
      "> [!note] ダッシュボード", "> **ステータス**: `INPUT[text:subtask__k0__statusLabel]`", "",
    ].join("\n");
    text = text.replace("#### Current Status", `${dash}\n#### Current Status`);
    text += "\n## 参考資料\n[資料](https://example.com)\n";
    v1Files[p] = text;
  });
});
for (const [p, text] of Object.entries(v1Files)) { fs.mkdirSync(path.dirname(path.join(vaultDir, p)), { recursive: true }); fs.writeFileSync(path.join(vaultDir, p), text); }
// data.json left over from earlier runs/views: a partial, path-based parent order that must not decide the converted order
const stalePaths = Object.keys(v1Files).filter((p) => /ガンマ|イプシロン/.test(p));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ ganttNationalHolidays: ["2000-01-01"], ganttNationalHolidaysUpdatedAt: new Date().toISOString(), taskFolder: "tasks", ganttParentOrder: stalePaths.reverse() }));
console.log("v1 vault:", Object.keys(v1Files).join(", "));

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
function snapshot() {
  const out = {};
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else out[path.relative(vaultDir, p)] = sha(fs.readFileSync(p, "utf8")); } };
  walk(path.join(vaultDir, "tasks"));
  return out;
}
const diff = (a, b) => ({ changed: Object.keys(b).filter((k) => a[k] && a[k] !== b[k]), added: Object.keys(b).filter((k) => !a[k]), removed: Object.keys(a).filter((k) => !b[k]) });
const results = [];
const ok = (name, detail = "") => { results.push(["OK", name, detail]); console.log("OK  ", name, detail); };
const fmOf = (rel) => { const t = fs.readFileSync(path.join(vaultDir, rel), "utf8"); const m = t.match(/^---\n([\s\S]*?)\n---/); return m ? m[1] : ""; };

const rt = await startObsidian({ vaultDir });
const cdp = rt.cdp;
try {
  // Without a focused window Obsidian opens modals in a different document than the one the CDP page sees.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.waitForExpression(`!!app.plugins.manifests["vault-gantt"]`, { timeoutMs: 60000, label: "manifest" });
  await enablePlugin(cdp, "vault-gantt");
  await cdp.waitForExpression(`app.vault.getMarkdownFiles().length === ${parentsSpec.length} && app.vault.getMarkdownFiles().every(f => app.metadataCache.getFileCache(f))`, { timeoutMs: 30000, label: "v1 indexed" });
  await dismissTrustDialogIfPresent(cdp);
  // legacy notice
  await cdp.waitForExpression(`[...document.querySelectorAll(".notice")].some(n => /旧形式\\(v1\\)/.test(n.textContent))`, { timeoutMs: 15000, label: "v1 notice" });
  ok("v1 notice shown at startup", await cdp.evaluate(`[...document.querySelectorAll(".notice")].map(n => n.textContent).join("|")`));
  // Gantt shows nothing for v1
  await cdp.evaluate(`app.commands.executeCommandById("vault-gantt:open-task-gantt"), true`);
  await sleep(1500);
  const v1bars = await cdp.evaluate(`document.querySelectorAll(".task-gantt-bar").length`);
  ok("gantt before conversion shows no bars (v1 notes hidden)", `bars=${v1bars}`);
  await cdp.evaluate(`app.workspace.detachLeavesOfType("task-gantt-view"), true`).catch(() => {});

  // ---- run the command
  const before = snapshot();
  await cdp.evaluate(`app.commands.executeCommandById("vault-gantt:convert-note-format-v2"), true`);
  await cdp.evaluate(`(window.focus(), window.dispatchEvent(new Event("focus")), true)`);
  await cdp.waitForExpression(`!!document.querySelector(".modal-container") && [...document.querySelectorAll(".modal-container button")].some(b => b.textContent === "変換する")`, { timeoutMs: 15000, label: "migration modal" });
  const preview = await cdp.evaluate(`document.querySelector(".modal-container .modal-content").textContent`);
  console.log("modal preview:", preview.slice(0, 300));
  await cdp.evaluate(`[...document.querySelectorAll(".modal-container button")].find(b => b.textContent === "変換する").click(), true`);
  await cdp.waitForExpression(`/件を変換しました|中止/.test(document.querySelector(".modal-container .modal-content")?.textContent ?? "")`, { timeoutMs: 60000, label: "migration result" });
  const resultText = await cdp.evaluate(`document.querySelector(".modal-container .modal-content").textContent`);
  console.log("modal result:", resultText);
  assert.match(resultText, new RegExp(`${parentsSpec.length} 件を変換しました`));
  await cdp.evaluate(`[...document.querySelectorAll(".modal-container button")].find(b => b.textContent === "閉じる")?.click(), true`);

  assert.ok(!(await cdp.evaluate(`[...document.querySelectorAll(".notice")].some(n => /旧形式\\(v1\\)/.test(n.textContent))`)), "start-up v1 notice is taken down after conversion");
  ok("start-up v1 notice dismissed after conversion");
  // ---- backup
  const stampDirs = fs.existsSync(path.join(vaultDir, ".vault-gantt-backup")) ? fs.readdirSync(path.join(vaultDir, ".vault-gantt-backup")) : [];
  assert.equal(stampDirs.length, 1, "backup stamp folder");
  const backupRoot = path.join(vaultDir, ".vault-gantt-backup", stampDirs[0]);
  for (const [p, text] of Object.entries(v1Files)) {
    const found = (function find(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) { const r = find(q); if (r) return r; } else if (e.name === path.basename(p)) return q; } })(backupRoot);
    assert.ok(found, `backup of ${p}`);
    assert.equal(fs.readFileSync(found, "utf8"), text, `backup of ${p} is byte-identical to the original v1 note`);
  }
  ok("backup folder created with byte-identical v1 originals", `.vault-gantt-backup/${stampDirs[0]}`);

  // ---- converted notes
  const after = snapshot();
  const d = diff(before, after);
  console.log("diff after conversion:", JSON.stringify(d));
  assert.equal(d.changed.length, parentsSpec.length);
  assert.equal(d.added.length, parentsSpec.reduce((n, s) => n + s.subs.length, 0));
  for (const spec of parentsSpec) {
    const pRel = `tasks/${spec.tie ? "zz/" : ""}${today} ${spec.name}.md`;
    const fm = fmOf(pRel);
    assert.match(fm, /formatVersion: 2/); assert.ok(!/ganttEnabled|ganttOrder/.test(fm), "no v1 keys in parent"); assert.match(fm, /gantt: true/); assert.match(fm, /project: 顧客A/);
    const body = fs.readFileSync(path.join(vaultDir, pRel), "utf8");
    assert.ok(body.includes("## 参考資料") && body.includes("https://example.com"), "user section kept");
    for (const [title, s, e] of spec.subs) {
      const sRel = `tasks/${spec.tie ? "zz/" : ""}${today} ${spec.name}/${title}.md`;
      assert.ok(fs.existsSync(path.join(vaultDir, sRel)), sRel);
      const sf = fmOf(sRel);
      assert.match(sf, new RegExp(`start: ${s}`)); assert.match(sf, new RegExp(`end: ${e}`)); assert.match(sf, /type: subtask/); assert.ok(!/INPUT\[|VIEW\[|\[!info\]|サブタスク情報/.test(fs.readFileSync(path.join(vaultDir, sRel), "utf8")), "no dashboard text in subtask note"); assert.match(sf, new RegExp(`parent: .*\\[\\[${today} ${spec.name}\\]\\]`));
    }
  }
  ok("conversion verified on disk", "parents rewritten (formatVersion 2, gantt: true, no v1 keys, user key/section kept), subtask notes carry start/end/parent");

  // ---- gantt shows the same data
  await cdp.evaluate(`app.commands.executeCommandById("vault-gantt:open-task-gantt"), true`);
  await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar").length === ${parentsSpec.length * 2}`, { timeoutMs: 30000, label: "gantt bars after conversion" });
  const titles = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll(".task-gantt-bar")].map(b => b.textContent.trim()).sort())`));
  const expectedTitles = parentsSpec.flatMap((s) => s.subs.map((x) => x[0])).sort();
  assert.deepEqual(titles, expectedTitles);
  const parentTitles = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll(".task-gantt-parent-title")].map(b => b.textContent.trim()))`));
  assert.deepEqual(parentTitles, [...parentsSpec].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || a.name.localeCompare(b.name)).map((s) => s.name), "parents in the v1 order (ganttOrder, then name)");
  ok("gantt shows the same data", `bars=${titles.join(",")} parents=${parentTitles.join(",")}`);
  const trust = await dismissTrustDialogIfPresent(cdp);

  // ---- an edit (drag) touches only one note
  const snap1 = snapshot();
  const rect = await scrollBarIntoView(cdp, ".task-gantt-bar");
  const { x, y } = centerOf(rect);
  await moveMouse(cdp, x, y); await sleep(30); await mouseDown(cdp, x, y); await sleep(30);
  for (let i = 1; i <= 5; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (56 * i) / 5, y, buttons: 1, pointerType: "mouse" }); await sleep(15); }
  await mouseUp(cdp, x + 56, y);
  await sleep(2500);
  const d2 = diff(snap1, snapshot());
  console.log("diff after drag:", JSON.stringify(d2));
  assert.equal(d2.changed.length, 1); assert.equal(d2.added.length, 0); assert.equal(d2.removed.length, 0);
  assert.match(d2.changed[0], /\/[^/]+\.md$/); assert.ok(d2.changed[0].includes("/"), "a subtask note");
  ok("a drag edit changed exactly one note", d2.changed[0]);

  // ---- subtask title rename via inline editor: file renamed
  const snap2 = snapshot();
  const subRel = `tasks/${today} アルファ案件/設計.md`;
  await cdp.evaluate(`window.scrollTo(0,0), true`);
  const barRect = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll(".task-gantt-bar")].find(e => e.textContent.trim() === "設計"); b.scrollIntoView({ block: "center", inline: "center" }); const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  await sleep(300);
  const br = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll(".task-gantt-bar")].find(e => e.textContent.trim() === "設計"); const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  await dblclickAt(cdp, br.left + br.width / 2, br.top + br.height / 2);
  await cdp.waitForExpression(`!!document.querySelector(".task-gantt-inline-editor")`, { timeoutMs: 10000, label: "inline editor" });
  await setFieldValue(cdp, ".task-gantt-inline-editor", "基本設計");
  await keydownOn(cdp, ".task-gantt-inline-editor", "Enter");
  const newSub = `tasks/${today} アルファ案件/基本設計.md`;
  for (let i = 0; i < 60 && !fs.existsSync(path.join(vaultDir, newSub)); i++) await sleep(100);
  assert.ok(fs.existsSync(path.join(vaultDir, newSub)), "subtask note renamed");
  assert.ok(!fs.existsSync(path.join(vaultDir, subRel)), "old subtask file gone");
  await sleep(1500);
  const d3 = diff(snap2, snapshot());
  console.log("diff after subtask rename:", JSON.stringify(d3));
  assert.match(fmOf(newSub), /title: 基本設計/);
  const parentAfterSubRename = fs.readFileSync(path.join(vaultDir, `tasks/${today} アルファ案件.md`), "utf8");
  ok("subtask title rename renamed the file", `${subRel} -> ${newSub}; other files changed: ${JSON.stringify(d3.changed)}`);
  await cdp.waitForExpression(`[...document.querySelectorAll(".task-gantt-bar")].some(b => b.textContent.trim() === "基本設計") && document.querySelectorAll(".task-gantt-bar").length === ${parentsSpec.length * 2}`, { timeoutMs: 10000, label: "gantt shows renamed subtask" });
  ok("gantt shows the renamed subtask, still 6 bars");

  // ---- parent rename: file renamed, folder moved, subtask parent links updated
  const snap3 = snapshot();
  await cdp.evaluate(`(() => { const t = [...document.querySelectorAll(".task-gantt-parent-title")].find(e => e.textContent.trim() === "アルファ案件"); t.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window })); return true; })()`);
  await cdp.waitForExpression(`!!document.querySelector(".task-gantt-parent-title-editor")`, { timeoutMs: 10000, label: "parent title editor" });
  await setFieldValue(cdp, ".task-gantt-parent-title-editor", "アルファ新案件", { multiline: true });
  await cdp.evaluate(`document.querySelector(".task-gantt-parent-title-editor").blur(), true`); // blur commits
  // Obsidian's own "Update links" prompt (alwaysUpdateLinks is off by default) appears for a note that others link to.
  // "Do not update" is the hard case: the plugin itself must repoint the subtasks' parent links.
  await cdp.waitForExpression(`[...document.querySelectorAll(".modal-container button")].some(b => b.textContent === "Do not update")`, { timeoutMs: 10000, label: "update-links prompt" });
  ok("Obsidian shows its own 'Update links' prompt for the parent rename (native behaviour; chose Do not update)");
  await cdp.evaluate(`[...document.querySelectorAll(".modal-container button")].find(b => b.textContent === "Do not update").click(), true`);
  const newParent = `tasks/${today} アルファ新案件.md`;
  for (let i = 0; i < 80 && !fs.existsSync(path.join(vaultDir, newParent)); i++) await sleep(100);
  assert.ok(fs.existsSync(path.join(vaultDir, newParent)), "parent note renamed");
  await sleep(2500);
  assert.ok(!fs.existsSync(path.join(vaultDir, `tasks/${today} アルファ案件.md`)));
  assert.ok(fs.existsSync(path.join(vaultDir, `tasks/${today} アルファ新案件`)), "folder moved");
  assert.ok(!fs.existsSync(path.join(vaultDir, `tasks/${today} アルファ案件`)), "old folder gone");
  for (const t of ["基本設計", "実装"]) {
    const rel = `tasks/${today} アルファ新案件/${t}.md`;
    assert.ok(fs.existsSync(path.join(vaultDir, rel)), rel);
    assert.match(fmOf(rel), new RegExp(`parent: .*\\[\\[${today} アルファ新案件\\]\\]`), `parent link of ${t}`);
  }
  const d4 = diff(snap3, snapshot());
  console.log("diff after parent rename:", JSON.stringify(d4));
  ok("parent rename renamed the file, moved the folder and updated subtask parent links", JSON.stringify(d4));
  await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar").length === ${parentsSpec.length * 2} && [...document.querySelectorAll(".task-gantt-parent-title")].some(e => e.textContent.trim() === "アルファ新案件")`, { timeoutMs: 10000, label: "gantt after parent rename" });
  ok("gantt shows the renamed parent with all 6 bars");
  const errs = cdp.capturedErrors();
  console.log("captured console errors:", JSON.stringify(errs));
  await cdp.screenshot(path.join(REPO, "tools/e2e/artifacts/migv2-final.png"));
} catch (e) {
  console.error("FAIL", e.stack ?? e);
  try { await cdp.screenshot(path.join(REPO, "tools/e2e/artifacts/migv2-fail.png")); console.log("diff now", JSON.stringify(Object.keys(snapshot()))); } catch {}
  process.exitCode = 1;
} finally { rt.kill(); }
