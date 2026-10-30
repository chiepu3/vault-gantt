// tools/e2e/scenarios/memos.mjs

// Floating speech-bubble memos end to end, with real input against real Obsidian:
// 1. Gantt: right-click a bar → 「メモを追加」 → type + Enter → a note appears in tasks/_memos/ with the
//    documented front matter, and the bubble is drawn over the chart.
// 2. Drag the bubble by its header → its offset is saved to the plugin settings (view state), not to the note.
// 3. Close the bubble to a pin → settings say open:false; the pin stays, the note is untouched.
// 4. Workbench: the 「メモ n」 chip → popover → 「Ganttで表示」 → the Gantt is back with the bubble open again.
// 5. Double-click → edit → Enter saves the body. 6. 「削除」 removes the note. 7. Undo brings it back.
// 8. Drag the memo's anchor dot (real mouse) onto a subtask bar of another parent, onto the empty timeline of
//    a parent row, and onto the 「その他」 row; the note's front matter on disk follows each drop.
// 9. Right-click the 「その他」 row → 「この日にメモを追加」 → type + Enter → a note with no task on that day.
//    With E2E_DRAG_SHOTS_DIR set, also saves mid-drag screenshots (light and dark) with the drop tooltip showing.

import fs from "node:fs";
import path from "node:path";
import { pickAnchorMonday, toIsoStr, addDaysIso, diffDaysIso, readFrontmatterField, writeDragFixture } from "./drag-fixture.mjs";
import { centerOf, dblclickAt, dragGesture, setFieldValue, keydownOn, dismissTrustDialogIfPresent, moveMouse, mouseDown, mouseUp, rectOf, sleep } from "./cdp-input.mjs";

const GANTT = "vault-gantt:open-task-gantt";
const WORKBENCH = "vault-gantt:open-task-workbench";
const PLUGIN_ID = "vault-gantt";
const MEMO_TEXT = "API仕様を確認する";

async function clickAt(cdp, x, y, button = "left") {
  await moveMouse(cdp, x, y);
  await sleep(20);
  await mouseDown(cdp, x, y, { button });
  await mouseUp(cdp, x, y, { button });
  await sleep(150);
}

async function waitFor(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

const memoFiles = (vaultDir) => {
  const dir = path.join(vaultDir, "tasks", "_memos");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => path.join(dir, name)) : [];
};
const layoutOf = (vaultDir) => {
  const file = path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID, "data.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")).ganttMemoLayout ?? {}; } catch { return {}; }
};

export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];
  const fail = (message) => { failures.push(message); return { ok: false, failures, details: details.join(" | ") }; };

  const anchor = pickAnchorMonday({ minDaysFromToday: 7 });
  const start = toIsoStr(anchor);
  const { parentPath } = await writeDragFixture({ vaultDir, parentName: "E2E Memos", startDate: start, endDate: addDaysIso(start, 4) });

  try {
    await cdp.waitForExpression(`(() => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(parentPath)}); const c = f && app.metadataCache.getFileCache(f); return !!(c && c.frontmatter && c.frontmatter.gantt === true); })()`, { timeoutMs: 15000, label: "fixture indexed" });
    await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(GANTT)}), true`);
    await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar").length === 1`, { timeoutMs: 30000, label: "gantt rendered" });
  } catch (err) {
    return fail(`gantt did not open: ${err.message}`);
  }
  details.push(`trust dialog: ${await dismissTrustDialogIfPresent(cdp)}`);
  await cdp.startErrorCapture();
  cdp.resetCapturedErrors();

  // 1. Add from the bar's menu.
  const bar = await rectOf(cdp, ".task-gantt-bar");
  if (!bar) return fail("no bar to right-click");
  await clickAt(cdp, bar.left + 12, bar.top + bar.height / 2, "right");
  const itemShown = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll(".menu-item")].find((e) => e.textContent.includes("メモを追加")); if (!el) return false; el.setAttribute("data-e2e", "add-memo"); return true; })()`);
  if (!itemShown) return fail("the bar menu has no 「メモを追加」");
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=add-memo]"))));
  try {
    await cdp.waitForExpression(`!!document.querySelector(".vg-memo-edit")`, { timeoutMs: 5000, label: "draft textarea" });
  } catch (err) {
    return fail(`no draft bubble after 「メモを追加」: ${err.message}`);
  }
  await setFieldValue(cdp, ".vg-memo-edit", MEMO_TEXT, { multiline: true });
  await keydownOn(cdp, ".vg-memo-edit", "Enter");
  let notePath;
  try {
    notePath = await waitFor(() => memoFiles(vaultDir)[0], "memo note");
  } catch (err) {
    return fail(`the memo note was not created: ${err.message}`);
  }
  const note = fs.readFileSync(notePath, "utf8");
  const stem = path.basename(notePath, ".md");
  if (!/^\d{4}-\d{2}-\d{2} API仕様を確認する$/.test(stem)) failures.push(`unexpected note name: ${stem}`);
  for (const expected of [/^type: gantt-memo$/m, /^id: m-[0-9a-z]{6}$/m, /^task: s-/m, /^at: \d+$/m, /^date: \d{4}-\d{2}-\d{2}$/m, /^created: /m, /^updated: /m]) {
    if (!expected.test(note)) failures.push(`front matter lacks ${expected}:\n${note}`);
  }
  if (!note.trimEnd().endsWith(MEMO_TEXT)) failures.push(`the body is not the typed text:\n${note}`);
  if (failures.length) return { ok: false, failures, details: details.join(" | ") };
  const memoId = note.match(/^id: (m-[0-9a-z]{6})$/m)[1];
  try {
    await cdp.waitForExpression(`!!document.querySelector(".vg-memo[data-memo-id='${memoId}']")`, { timeoutMs: 10000, label: "bubble drawn" });
  } catch (err) {
    return fail(`the bubble is not drawn: ${err.message}`);
  }
  const shownText = await cdp.evaluate(`document.querySelector(".vg-memo .vg-memo-text")?.textContent ?? null`);
  if (shownText !== MEMO_TEXT) return fail(`the bubble shows ${JSON.stringify(shownText)}`);
  details.push(`OK add → ${stem}`);

  // 2. Drag the bubble by its header.
  const head = await rectOf(cdp, ".vg-memo .vg-memo-head");
  const before = await rectOf(cdp, ".vg-memo");
  const grab = { x: head.left + 14, y: head.top + head.height / 2 };
  await dragGesture(cdp, { fromX: grab.x, fromY: grab.y, toX: grab.x + 60, toY: grab.y + 40 });
  const after = await rectOf(cdp, ".vg-memo");
  if (after.left - before.left < 40 || after.top - before.top < 25) return fail(`the bubble moved by (${after.left - before.left}, ${after.top - before.top}) for a (60, 40) drag`);
  try {
    await waitFor(() => layoutOf(vaultDir)[memoId]?.open === true && typeof layoutOf(vaultDir)[memoId]?.dx === "number", "layout saved");
  } catch (err) {
    return fail(`the bubble offset was not saved to the settings: ${err.message}`);
  }
  if (fs.readFileSync(notePath, "utf8") !== note) return fail("dragging the bubble changed the memo note");
  details.push(`OK drag → ${JSON.stringify(layoutOf(vaultDir)[memoId])}`);

  // 2b. The bubble move is on the undo history: undo puts the bubble back, redo moves it again.
  const dragged = layoutOf(vaultDir)[memoId];
  const plugin = `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]`;
  await cdp.evaluate(`${plugin}.undoLastAction(), true`);
  try {
    await waitFor(() => layoutOf(vaultDir)[memoId]?.dx !== dragged.dx || layoutOf(vaultDir)[memoId]?.dy !== dragged.dy, "layout restored by undo");
  } catch (err) {
    return fail(`undo did not move the bubble back: ${err.message}`);
  }
  await cdp.evaluate(`${plugin}.redoLastAction(), true`);
  try {
    await waitFor(() => layoutOf(vaultDir)[memoId]?.dx === dragged.dx && layoutOf(vaultDir)[memoId]?.dy === dragged.dy, "layout restored by redo");
  } catch (err) {
    return fail(`redo did not move the bubble again: ${err.message}`);
  }
  // The undo/redo toasts sit over the toolbar and would catch the clicks of the next steps.
  await cdp.evaluate(`document.querySelectorAll(".notice").forEach((notice) => notice.remove()), true`);
  details.push("OK bubble move undo/redo");

  // 3. Close to a pin.
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, ".vg-memo .vg-memo-btn"))));
  try {
    await waitFor(() => layoutOf(vaultDir)[memoId]?.open === false, "closed state saved");
    await cdp.waitForExpression(`!document.querySelector(".vg-memo") && !!document.querySelector(".vg-memo-pin")`, { timeoutMs: 5000, label: "pin only" });
  } catch (err) {
    return fail(`closing did not leave a pin: ${err.message}`);
  }
  if (fs.readFileSync(notePath, "utf8") !== note) return fail("closing the bubble changed the memo note");
  details.push("OK close → pin");

  // 4. Workbench chip → popover → 「Ganttで表示」.
  await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(WORKBENCH)}), true`);
  try {
    await cdp.waitForExpression(`!!document.querySelector(".task-workbench-memos")`, { timeoutMs: 15000, label: "workbench memo chip" });
  } catch (err) {
    return fail(`the workbench has no memo chip: ${err.message}`);
  }
  const chipText = await cdp.evaluate(`document.querySelector(".task-workbench-memos").textContent`);
  if (chipText !== "メモ 1") return fail(`the chip says ${JSON.stringify(chipText)}`);
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, ".task-workbench-memos"))));
  try {
    await cdp.waitForExpression(`!!document.querySelector(".twb-memo-popover .twb-memo-popover-reveal")`, { timeoutMs: 5000, label: "memo popover" });
  } catch (err) {
    return fail(`the chip opened no popover: ${err.message}`);
  }
  const editable = await cdp.evaluate(`document.querySelectorAll(".twb-memo-popover textarea, .twb-memo-popover input").length`);
  if (editable) return fail("the popover offers editing");
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, ".twb-memo-popover .twb-memo-popover-reveal"))));
  try {
    await waitFor(() => layoutOf(vaultDir)[memoId]?.open === true, "reopened state saved");
    await cdp.waitForExpression(`!!document.querySelector(".vg-memo[data-memo-id='${memoId}']")`, { timeoutMs: 15000, label: "bubble open again on the gantt" });
  } catch (err) {
    return fail(`「Ganttで表示」 did not bring the bubble back: ${err.message}`);
  }
  details.push("OK workbench chip → Gantt");

  // 5. Edit the text: double-click, type, Enter → the note body changes.
  const edited = `${MEMO_TEXT}（木曜の定例で）`;
  await dblclickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, `.vg-memo[data-memo-id='${memoId}'] .vg-memo-text`))));
  try {
    await cdp.waitForExpression(`!!document.querySelector(".vg-memo-edit")`, { timeoutMs: 5000, label: "edit textarea" });
    await setFieldValue(cdp, ".vg-memo-edit", edited, { multiline: true });
    await keydownOn(cdp, ".vg-memo-edit", "Enter");
    await waitFor(() => fs.existsSync(notePath) && fs.readFileSync(notePath, "utf8").trimEnd().endsWith(edited), "edited body saved");
  } catch (err) {
    return fail(`editing the text did not save it: ${err.message}`);
  }
  details.push("OK edit");

  // 6. Delete from the memo's own menu → the note is gone.
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, `.vg-memo[data-memo-id='${memoId}'] .vg-memo-head`))), "right");
  const deleteShown = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll(".menu-item")].find((e) => e.textContent.trim() === "削除"); if (!el) return false; el.setAttribute("data-e2e", "delete-memo"); return true; })()`);
  if (!deleteShown) return fail("the memo menu has no 「削除」");
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=delete-memo]"))));
  try {
    await waitFor(() => memoFiles(vaultDir).length === 0, "note deleted");
    await cdp.waitForExpression(`!document.querySelector(".vg-memo, .vg-memo-pin")`, { timeoutMs: 5000, label: "bubble removed" });
  } catch (err) {
    return fail(`「削除」 did not remove the memo: ${err.message}`);
  }
  details.push("OK delete");

  // 7. Undo brings the deleted memo back with its edited text.
  await cdp.evaluate(`app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].undoLastAction(), true`);
  try {
    await waitFor(() => memoFiles(vaultDir).some((file) => fs.readFileSync(file, "utf8").trimEnd().endsWith(edited)), "note restored by undo");
  } catch (err) {
    return fail(`undo did not restore the deleted memo: ${err.message}`);
  }
  details.push("OK undo");

  // 8. Drag the anchor dot onto other targets.
  const { subtaskId: otherSubId, parentId: otherParentId } = await writeDragFixture({ vaultDir, parentName: "E2E Memos Other", subtaskName: "Other work", startDate: addDaysIso(start, 7), endDate: addDaysIso(start, 11) });
  const barRects = async () => cdp.evaluate(`(() => Object.fromEntries([...document.querySelectorAll(".task-gantt-bar[data-task-id]")].map((el) => { const r = el.getBoundingClientRect(); return [el.dataset.taskId, { left: r.left, top: r.top, width: r.width, height: r.height }]; })))()`);
  try {
    await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar[data-task-id]").length === 2`, { timeoutMs: 20000, label: "second parent's bar" });
  } catch (err) {
    return fail(`the second fixture did not appear on the gantt: ${err.message}`);
  }
  const memoNote = () => {
    const file = memoFiles(vaultDir).find((candidate) => fs.readFileSync(candidate, "utf8").includes(`id: ${memoId}`));
    return file ? fs.readFileSync(file, "utf8") : "";
  };
  const dotCenter = async () => centerOf(await rectOf(cdp, `.vg-memo-dot`));
  const waitNote = async (label, check) => {
    try {
      await waitFor(() => check(memoNote()), label);
      return null;
    } catch (err) {
      return `${label}: ${err.message}\n${memoNote()}`;
    }
  };
  const subs = await barRects();
  const ownBar = Object.entries(subs).find(([id]) => id !== otherSubId);
  const otherBar = subs[otherSubId];
  if (!ownBar || !otherBar) return fail(`bars by task id: ${JSON.stringify(subs)}`);
  const [ownId, own] = ownBar;
  const dayWidth = otherBar.width / 5;
  const dot0 = await dotCenter();

  // (a) onto the other parent's subtask bar, three days in.
  await dragGesture(cdp, { fromX: dot0.x, fromY: dot0.y, toX: otherBar.left + dayWidth * 3.5, toY: otherBar.top + otherBar.height / 2 });
  let problem = await waitNote("drop on another parent's subtask", (text) => readFrontmatterField(text, "task") === otherSubId);
  if (problem) return fail(problem);
  let text = memoNote();
  if (readFrontmatterField(text, "at") !== "3" || readFrontmatterField(text, "date") !== addDaysIso(start, 10)) return fail(`bar drop saved the wrong anchor:\n${text}`);
  details.push("OK drop on another parent's bar");

  // (b) onto the empty timeline of the first parent's row, three days after its bar.
  const dot1 = await dotCenter();
  await dragGesture(cdp, { fromX: dot1.x, fromY: dot1.y, toX: own.left + dayWidth * 8.5, toY: own.top + own.height / 2 });
  problem = await waitNote("drop on a parent row's empty timeline", (text2) => !!readFrontmatterField(text2, "task") && readFrontmatterField(text2, "task") !== otherSubId);
  if (problem) return fail(problem);
  text = memoNote();
  if (readFrontmatterField(text, "task") === ownId || /^at: /m.test(text) || readFrontmatterField(text, "date") !== addDaysIso(start, 8)) return fail(`parent-row drop saved the wrong anchor (a parent id, no at, ${addDaysIso(start, 8)} expected):\n${text}`);
  const savedParent = readFrontmatterField(text, "task");
  details.push(`OK drop on a parent row → ${savedParent}`);

  // (c) onto the その他 row.
  const eventRow = await rectOf(cdp, ".task-gantt-event-row");
  if (!eventRow) return fail("no その他 row to drop on");
  const dot2 = await dotCenter();
  await dragGesture(cdp, { fromX: dot2.x, fromY: dot2.y, toX: own.left + dayWidth * 1.5, toY: eventRow.top + eventRow.height / 2 });
  problem = await waitNote("drop on the その他 row", (text2) => !/^task: /m.test(text2));
  if (problem) return fail(problem);
  text = memoNote();
  if (/^at: /m.test(text) || readFrontmatterField(text, "date") !== addDaysIso(start, 1)) return fail(`その他 drop saved the wrong anchor (no task, no at, ${addDaysIso(start, 1)} expected):\n${text}`);
  details.push("OK drop on the その他 row");

  // A drop on the header leaves the note as it was.
  const noteBefore = memoNote();
  const dot3 = await dotCenter();
  await dragGesture(cdp, { fromX: dot3.x, fromY: dot3.y, toX: dot3.x, toY: 6 });
  await sleep(800);
  if (memoNote() !== noteBefore) return fail("a drop outside the chart changed the note");
  details.push("OK drop outside the chart saves nothing");

  // 9. Right-click the その他 row → 「この日にメモを追加」.
  const freeText = "その他の日のメモ";
  await clickAt(cdp, own.left + dayWidth * 2.5, eventRow.top + eventRow.height / 2, "right");
  const addShown = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll(".menu-item")].find((e) => e.textContent.trim() === "この日にメモを追加"); if (!el) return false; el.setAttribute("data-e2e", "add-free-memo"); return true; })()`);
  if (!addShown) return fail("the その他 row menu has no 「この日にメモを追加」");
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=add-free-memo]"))));
  try {
    await cdp.waitForExpression(`!!document.querySelector(".vg-memo-edit")`, { timeoutMs: 5000, label: "draft textarea" });
    await setFieldValue(cdp, ".vg-memo-edit", freeText, { multiline: true });
    await keydownOn(cdp, ".vg-memo-edit", "Enter");
    await waitFor(() => memoFiles(vaultDir).length === 2, "second memo note");
  } catch (err) {
    return fail(`the free memo was not created: ${err.message}`);
  }
  const freeNote = fs.readFileSync(memoFiles(vaultDir).find((file) => !fs.readFileSync(file, "utf8").includes(`id: ${memoId}`)), "utf8");
  if (/^task: /m.test(freeNote) || readFrontmatterField(freeNote, "date") !== addDaysIso(start, 2) || !freeNote.trimEnd().endsWith(freeText)) return fail(`the free memo is wrong:\n${freeNote}`);
  details.push("OK その他 row → 「この日にメモを追加」");

  // Screenshots, mid-drag over another task's bar so the drop tooltip shows (only when asked for).
  const shotsDir = process.env.E2E_DRAG_SHOTS_DIR;
  if (shotsDir) {
    const shoot = async (theme, file) => {
      await cdp.evaluate(`app.changeTheme(${JSON.stringify(theme)}), true`);
      await sleep(800);
      const dot = await dotCenter();
      const bars = await barRects();
      const target = bars[otherSubId];
      await moveMouse(cdp, dot.x, dot.y);
      await sleep(30);
      await mouseDown(cdp, dot.x, dot.y);
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dot.x + ((target.left + dayWidth * 2.5 - dot.x) * i) / 8, y: dot.y + ((target.top + target.height / 2 - dot.y) * i) / 8, buttons: 1, pointerType: "mouse" });
        await sleep(30);
      }
      await sleep(300);
      await cdp.screenshot(path.join(shotsDir, file));
      await mouseUp(cdp, target.left + dayWidth * 2.5, target.top + target.height / 2);
      await sleep(600);
    };
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      await shoot("moonstone", "real-drag-light.png");
      await shoot("obsidian", "real-drag-dark.png");
      await cdp.evaluate(`app.changeTheme("moonstone"), true`);
    } catch (err) {
      return fail(`screenshots failed: ${err.message}`);
    }
    details.push(`screenshots in ${shotsDir}`);
  }

  const errors = cdp.capturedErrors();
  if (errors.length) return fail(`console errors: ${JSON.stringify(errors).slice(0, 600)}`);
  return { ok: true, failures, details: details.join(" | ") };
}
