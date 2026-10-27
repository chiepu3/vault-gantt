// tools/e2e/scenarios/milestones.mjs

// Parent milestones end to end, with real input against real Obsidian:
// 1. Gantt: right-click an empty cell → 「マイルストーンを <date> に追加」 → type a name + Enter
//    → the parent note gets `due` and `milestones` on that date.
// 2. Gantt: drag the milestone to the right → its date (and `due`) moves later.
// 3. Workbench: the ＋ chip → name + Enter → a second milestone is saved.
// 4. Workbench: click a milestone chip → popover 削除 → it is removed from the note.

import { pickAnchorMonday, toIsoStr, addDaysIso, writeDragFixture, readFrontmatterField, readNoteText } from "./drag-fixture.mjs";
import { centerOf, dragGesture, setFieldValue, keydownOn, dismissTrustDialogIfPresent, moveMouse, mouseDown, mouseUp, rectOf, sleep } from "./cdp-input.mjs";

const GANTT = "vault-gantt:open-task-gantt";
const WORKBENCH = "vault-gantt:open-task-workbench";

async function clickAt(cdp, x, y, button = "left") {
  await moveMouse(cdp, x, y);
  await sleep(20);
  await mouseDown(cdp, x, y, { button });
  await mouseUp(cdp, x, y, { button });
  await sleep(120);
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

const milestoneTitles = (text) => [...text.matchAll(/^\s+(?:- )?title: (.*)$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ""));

/** Types into the open text prompt and presses Enter, like a user naming a new subtask. */
async function answerPrompt(cdp, value) {
  await cdp.waitForExpression(`!!document.querySelector(".modal-container input[type=text]")`, { timeoutMs: 5000, label: "name prompt" });
  await setFieldValue(cdp, ".modal-container input[type=text]", value);
  await keydownOn(cdp, ".modal-container input[type=text]", "Enter");
}

export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];
  const fail = (message) => { failures.push(message); return { ok: false, failures, details: details.join(" | ") }; };

  const anchor = pickAnchorMonday({ minDaysFromToday: 7 });
  const start = toIsoStr(anchor);
  const { parentPath, parentAbsPath } = await writeDragFixture({ vaultDir, parentName: "E2E Milestones", startDate: start, endDate: addDaysIso(start, 4) });

  try {
    await cdp.waitForExpression(`(() => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(parentPath)}); const c = f && app.metadataCache.getFileCache(f); return !!(c && c.frontmatter && c.frontmatter.gantt === true); })()`, { timeoutMs: 15000, label: "fixture indexed" });
    await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(GANTT)}), true`);
    await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar").length === 1`, { timeoutMs: 30000, label: "gantt rendered" });
  } catch (err) {
    return fail(`gantt did not open: ${err.message}`);
  }
  details.push(`trust dialog: ${await dismissTrustDialogIfPresent(cdp)}`);
  cdp.resetCapturedErrors();

  // 1. Add from the empty-cell menu.
  const hit = await rectOf(cdp, ".task-gantt-parent-row .task-gantt-bg-hit");
  if (!hit) return fail("no empty cell to right-click");
  const bar = await rectOf(cdp, ".task-gantt-bar");
  const cellX = bar.right + 60, cellY = hit.top + 10; // an empty cell right of the only bar
  await clickAt(cdp, cellX, cellY, "right");
  const itemText = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll(".menu-item")].find((e) => /マイルストーンを .* に追加/.test(e.textContent)); if (!el) return null; el.setAttribute("data-e2e", "add-milestone"); return el.textContent; })()`);
  if (!itemText) {
    const seen = await cdp.evaluate(`(() => { const el = document.elementFromPoint(${cellX}, ${cellY}); return JSON.stringify({ hit: ${JSON.stringify(hit)}, at: el && el.className, menu: [...document.querySelectorAll(".menu-item")].map((e) => e.textContent) }); })()`);
    return fail(`menu has no 「マイルストーンを … に追加」: ${seen}`);
  }
  const date = itemText.match(/(\d{4}-\d{2}-\d{2})/)[1];
  const itemRect = await rectOf(cdp, "[data-e2e=add-milestone]");
  await clickAt(cdp, ...Object.values(centerOf(itemRect)));
  await answerPrompt(cdp, "中間レビュー");
  try {
    await waitFor(() => readFrontmatterField(readNoteText(parentAbsPath), "due") === date && milestoneTitles(readNoteText(parentAbsPath)).includes("中間レビュー"), "milestone saved");
  } catch (err) {
    return fail(`gantt add did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
  }
  details.push(`OK gantt add → due ${date}`);

  // 2. Drag it later.
  try {
    await cdp.waitForExpression(`!!document.querySelector(".task-gantt-milestone")`, { timeoutMs: 10000, label: "milestone rendered" });
  } catch (err) {
    return fail(`milestone not rendered: ${err.message}`);
  }
  const ms = centerOf(await rectOf(cdp, ".task-gantt-milestone .task-gantt-deadline-marker-star"));
  const dayWidth = await cdp.evaluate(`(() => { const v = app.workspace.getLeavesOfType("task-gantt-view")[0]?.view; return v ? v.dayWidth : 28; })()`);
  await dragGesture(cdp, { fromX: ms.x, fromY: ms.y, toX: ms.x + dayWidth * 3, toY: ms.y });
  let moved;
  try {
    moved = await waitFor(() => { const due = readFrontmatterField(readNoteText(parentAbsPath), "due"); return due && due > date ? due : null; }, "dragged date");
  } catch (err) {
    return fail(`drag did not move the milestone (${err.message})`);
  }
  details.push(`OK drag → due ${moved}`);

  // 3. Workbench ＋ chip.
  await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(WORKBENCH)}), true`);
  try {
    await cdp.waitForExpression(`!!document.querySelector(".twb-milestone-add")`, { timeoutMs: 15000, label: "workbench milestone strip" });
  } catch (err) {
    return fail(`workbench strip missing: ${err.message}`);
  }
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, ".twb-milestone-add"))));
  await answerPrompt(cdp, "β版");
  try {
    await waitFor(() => { const t = milestoneTitles(readNoteText(parentAbsPath)); return t.includes("β版") && t.includes("中間レビュー"); }, "second milestone");
  } catch (err) {
    return fail(`workbench add did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
  }
  details.push("OK workbench add");

  // 4. Delete one from its popover.
  try {
    await cdp.waitForExpression(`[...document.querySelectorAll(".twb-milestone[data-twb-act=milestone]")].some((e) => e.textContent.includes("β版"))`, { timeoutMs: 10000, label: "β版 chip" });
  } catch (err) {
    return fail(err.message);
  }
  await cdp.evaluate(`[...document.querySelectorAll(".twb-milestone[data-twb-act=milestone]")].find((e) => e.textContent.includes("β版")).setAttribute("data-e2e", "beta"), true`);
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=beta]"))));
  try {
    await cdp.waitForExpression(`!!document.querySelector(".twb-milestone-popover")`, { timeoutMs: 5000, label: "popover" });
  } catch (err) {
    return fail(err.message);
  }
  await cdp.evaluate(`[...document.querySelectorAll(".twb-milestone-popover button")].find((b) => b.textContent === "削除").setAttribute("data-e2e", "delete"), true`);
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=delete]"))));
  try {
    await waitFor(() => { const t = milestoneTitles(readNoteText(parentAbsPath)); return !t.includes("β版") && t.includes("中間レビュー"); }, "β版 removed");
  } catch (err) {
    return fail(`delete did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
  }
  details.push("OK workbench delete");

  // E2E_SHOTS=<dir>: also save light/dark screenshots of both views (for reviewing the look by eye).
  if (process.env.E2E_SHOTS) {
    const { default: fs } = await import("node:fs");
    const shoot = async (name) => {
      await sleep(600);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${process.env.E2E_SHOTS}/${name}.png`, Buffer.from(data, "base64"));
    };
    for (const [theme, mode] of [["light", "moonstone"], ["dark", "obsidian"]]) {
      await cdp.evaluate(`app.changeTheme(${JSON.stringify(mode)}), true`);
      await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(WORKBENCH)}), true`);
      await shoot(`real-${theme}-workbench`);
      await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(GANTT)}), true`);
      await shoot(`real-${theme}-gantt`);
    }
  }

  const errors = cdp.capturedErrors();
  if (errors.length) failures.push(`page errors: ${errors.map((e) => e.text).join(" / ")}`);
  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}
