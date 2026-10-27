// tools/e2e/scenarios/milestones.mjs

// Parent milestones end to end, with real input against real Obsidian:
// 1. Gantt: right-click an empty cell → 「マイルストーンを <date> に追加」 → type a name + Enter
//    → the parent note gets `due` and `milestones` on that date.
// 2. Gantt: drag the milestone to the right → its date (and `due`) moves later.
// 3. Workbench: the ＋ chip → name + Enter → a second milestone is saved.
// 3b. Workbench: click a chip → popover → rename + Enter.
// 4. Workbench: click a milestone chip → popover 削除 → it is removed from the note.
// 5. AI chat path: read milestones via tasks.search, propose T29 (rename + add), approve; both views show it.

import { pickAnchorMonday, toIsoStr, addDaysIso, writeDragFixture, readFrontmatterField, readNoteText } from "./drag-fixture.mjs";
import { centerOf, dblclickAt, dragGesture, setFieldValue, keydownOn, dismissTrustDialogIfPresent, moveMouse, mouseDown, mouseUp, rectOf, sleep } from "./cdp-input.mjs";

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

  // 2b. Rename by double-click (inline editor + Enter), then from the right-click menu (prompt + Enter).
  {
    const at = centerOf(await rectOf(cdp, ".task-gantt-milestone"));
    await dblclickAt(cdp, at.x, at.y);
    try {
      await cdp.waitForExpression(`!!document.querySelector(".task-gantt-inline-editor")`, { timeoutMs: 5000, label: "inline editor" });
    } catch (err) {
      return fail(`double-click opened no editor: ${err.message}`);
    }
    await setFieldValue(cdp, ".task-gantt-inline-editor", "設計レビュー");
    await keydownOn(cdp, ".task-gantt-inline-editor", "Enter");
    try {
      await waitFor(() => milestoneTitles(readNoteText(parentAbsPath)).includes("設計レビュー"), "dblclick rename");
    } catch (err) {
      return fail(`double-click rename did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
    }
    try {
      await cdp.waitForExpression(`[...document.querySelectorAll(".task-gantt-milestone")].some((e) => e.textContent.includes("設計レビュー"))`, { timeoutMs: 5000, label: "renamed label shown" });
    } catch (err) {
      return fail(`double-click rename saved but the chart still shows the old name: ${err.message}`);
    }
    details.push("OK dblclick rename");

    await sleep(500);
    const at2 = centerOf(await rectOf(cdp, ".task-gantt-milestone"));
    await clickAt(cdp, at2.x, at2.y, "right");
    const found = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll(".menu-item")].find((e) => e.textContent.includes("名前を変更")); if (!el) return false; el.setAttribute("data-e2e", "rename"); return true; })()`);
    if (!found) return fail("milestone menu has no 名前を変更");
    await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=rename]"))));
    await answerPrompt(cdp, "最終レビュー");
    try {
      await waitFor(() => milestoneTitles(readNoteText(parentAbsPath)).includes("最終レビュー"), "menu rename");
    } catch (err) {
      return fail(`menu rename did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
    }
    try {
      await cdp.waitForExpression(`[...document.querySelectorAll(".task-gantt-milestone")].some((e) => e.textContent.includes("最終レビュー"))`, { timeoutMs: 5000, label: "renamed label shown" });
    } catch (err) {
      return fail(`menu rename saved but the chart still shows the old name: ${err.message}`);
    }
    details.push("OK menu rename");
  }

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
    await waitFor(() => { const t = milestoneTitles(readNoteText(parentAbsPath)); return t.includes("β版") && t.includes("最終レビュー"); }, "second milestone");
  } catch (err) {
    return fail(`workbench add did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
  }
  details.push("OK workbench add");

  // 3b. Rename from the workbench popover (name + Enter); the chip must show the new name.
  {
    try {
      await cdp.waitForExpression(`[...document.querySelectorAll(".twb-milestone[data-twb-act=milestone]")].some((e) => e.textContent.includes("β版"))`, { timeoutMs: 10000, label: "β版 chip shown" });
    } catch (err) {
      return fail(`added chip not shown (${err.message})`);
    }
    await cdp.evaluate(`[...document.querySelectorAll(".twb-milestone[data-twb-act=milestone]")].find((e) => e.textContent.includes("β版")).setAttribute("data-e2e", "beta0"), true`);
    await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=beta0]"))));
    try {
      await cdp.waitForExpression(`!!document.querySelector(".twb-milestone-popover input")`, { timeoutMs: 5000, label: "popover" });
    } catch (err) {
      return fail(err.message);
    }
    await setFieldValue(cdp, ".twb-milestone-popover input", "β版リリース");
    await keydownOn(cdp, ".twb-milestone-popover input", "Enter");
    try {
      await waitFor(() => milestoneTitles(readNoteText(parentAbsPath)).includes("β版リリース"), "popover rename");
      await cdp.waitForExpression(`[...document.querySelectorAll(".twb-milestone")].some((e) => e.textContent.includes("β版リリース"))`, { timeoutMs: 5000, label: "renamed chip shown" });
    } catch (err) {
      return fail(`workbench rename failed (${err.message})`);
    }
    details.push("OK workbench rename");
  }

  // 4. Delete one from its popover.
  try {
    await cdp.waitForExpression(`[...document.querySelectorAll(".twb-milestone[data-twb-act=milestone]")].some((e) => e.textContent.includes("β版リリース"))`, { timeoutMs: 10000, label: "β版 chip" });
  } catch (err) {
    return fail(err.message);
  }
  await cdp.evaluate(`[...document.querySelectorAll(".twb-milestone[data-twb-act=milestone]")].find((e) => e.textContent.includes("β版リリース")).setAttribute("data-e2e", "beta"), true`);
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=beta]"))));
  try {
    await cdp.waitForExpression(`!!document.querySelector(".twb-milestone-popover")`, { timeoutMs: 5000, label: "popover" });
  } catch (err) {
    return fail(err.message);
  }
  await cdp.evaluate(`[...document.querySelectorAll(".twb-milestone-popover button")].find((b) => b.textContent === "削除").setAttribute("data-e2e", "delete"), true`);
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=delete]"))));
  try {
    await waitFor(() => { const t = milestoneTitles(readNoteText(parentAbsPath)); return !t.includes("β版") && t.includes("最終レビュー"); }, "β版 removed");
  } catch (err) {
    return fail(`delete did not save (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
  }
  details.push("OK workbench delete");

  // 5. The AI chat path: read the parent's milestones the way the chat tools do, then propose + approve an update
  //    (operation T29 with patch.milestones). Only the language model is left out.
  {
    const result = await cdp.evaluate(`(async () => {
      const service = app.plugins.plugins["vault-gantt"].operationService;
      const context = { ...service.legacyContext(), principalId: "e2e", origin: { kind: "chat", conversationId: "e2e" } };
      // The delete above is on disk but Obsidian may not have re-indexed it yet; a read from before that would make
      // the approval stale (correctly), so wait until the read matches the note.
      let found, item;
      for (let i = 0; i < 50; i++) {
        found = await service.contextPort.query("tasks.search", { name: "E2E Milestones", kind: "parent", fields: ["schedule"] }, context);
        if (found.status !== "success") return { error: JSON.stringify(found) };
        item = found.result.data.items[0];
        if (item && Array.isArray(item.milestones) && !item.milestones.some((m) => m.title.startsWith("β版"))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!item || !Array.isArray(item.milestones)) return { error: "no milestones in read: " + JSON.stringify(item) };
      const next = [...item.milestones.map((m) => (m.title === "最終レビュー" ? { ...m, title: "AIで改名" } : m)), { key: "ai", title: "AI追加", date: ${JSON.stringify(addDaysIso(start, 40))}, tags: [] }];
      const preview = await service.propose("T29", { taskId: item.id, patch: { milestones: next } }, context);
      const approved = await service.humanApprovalPort.approve(preview.previewId);
      return { read: item.milestones.map((m) => m.title), status: approved.status };
    })()`);
    if (!result || result.error || result.status !== "success") return fail(`AI path failed: ${JSON.stringify(result)}`);
    try {
      await waitFor(() => { const t = milestoneTitles(readNoteText(parentAbsPath)); return t.includes("AIで改名") && t.includes("AI追加") && !t.includes("最終レビュー"); }, "AI update saved");
      await cdp.waitForExpression(`["AIで改名", "AI追加"].every((name) => [...document.querySelectorAll(".twb-milestone")].some((e) => e.textContent.includes(name)))`, { timeoutMs: 10000, label: "AI chips shown" });
      await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(GANTT)}), true`);
      await cdp.waitForExpression(`[...document.querySelectorAll(".task-gantt-milestone")].some((e) => e.textContent.includes("AIで改名"))`, { timeoutMs: 10000, label: "AI rename on gantt" });
    } catch (err) {
      return fail(`AI update not reflected (${err.message}); note:\n${readNoteText(parentAbsPath)}`);
    }
    details.push(`OK AI read (${result.read.join(",")}) + update`);
  }

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
