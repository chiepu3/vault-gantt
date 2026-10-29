// tools/e2e/scenarios/memos.mjs

// Floating speech-bubble memos end to end, with real input against real Obsidian:
// 1. Gantt: right-click a bar → 「メモを追加」 → type + Enter → a note appears in tasks/_memos/ with the
//    documented front matter, and the bubble is drawn over the chart.
// 2. Drag the bubble by its header → its offset is saved to the plugin settings (view state), not to the note.
// 3. Close the bubble to a pin → settings say open:false; the pin stays, the note is untouched.
// 4. Workbench: the 「メモ n」 chip → popover → 「Ganttで表示」 → the Gantt is back with the bubble open again.
// 5. Double-click → edit → Enter saves the body. 6. 「削除」 removes the note. 7. Undo brings it back.

import fs from "node:fs";
import path from "node:path";
import { pickAnchorMonday, toIsoStr, addDaysIso, writeDragFixture } from "./drag-fixture.mjs";
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

  const errors = cdp.capturedErrors();
  if (errors.length) return fail(`console errors: ${JSON.stringify(errors).slice(0, 600)}`);
  return { ok: true, failures, details: details.join(" | ") };
}
