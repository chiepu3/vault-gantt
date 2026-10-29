// tools/e2e/scenarios/subtask-disable.mjs

// 「一時無効」 subtasks end to end, with real input against real Obsidian:
// 1. Gantt: right-click the subtask bar → 「一時無効にする」 → the note gets `disabled: true`, the bar gets
//    `.is-disabled` and the daily plan total of a date where the subtask had plan hours drops (to 0).
// 2. Gantt: hover the bar → the popover shows the 「無効中」 chip → click 「有効に戻す」 → `disabled` is gone
//    from the note, `.is-disabled` is gone and the plan total is back.

import { pickAnchorMonday, toIsoStr, addDaysIso, writeDragFixture, readFrontmatterField, readNoteText } from "./drag-fixture.mjs";
import { centerOf, hoverOnto, moveMouse, mouseDown, mouseUp, rectOf, scrollBarIntoView, dismissTrustDialogIfPresent, sleep } from "./cdp-input.mjs";

const GANTT = "vault-gantt:open-task-gantt";
const PLAN_HOURS = 2;

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

/** The text of the plan label in the daily summary cell of `date`, e.g. "2h" (empty when 0). */
const planLabel = (cdp, date) => cdp.evaluate(`(() => {
  const cell = [...document.querySelectorAll(".task-gantt-workload-summary-cell")].find((c) => c.getAttribute("data-date") === ${JSON.stringify(date)});
  const label = cell && cell.querySelector(".task-gantt-workload-summary-plan");
  return label ? label.textContent.trim() : null;
})()`);

/** Clicks the visible element (menu item or popover button) whose text is exactly `text`. */
async function clickByText(cdp, selector, text) {
  const found = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.setAttribute("data-e2e", "target"); return true; })()`);
  if (!found) return false;
  await clickAt(cdp, ...Object.values(centerOf(await rectOf(cdp, "[data-e2e=target]"))));
  await cdp.evaluate(`document.querySelector("[data-e2e=target]")?.removeAttribute("data-e2e"), true`);
  return true;
}

export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];
  const fail = (message) => { failures.push(message); return { ok: false, failures, details: details.join(" | ") }; };

  const anchor = pickAnchorMonday({ minDaysFromToday: 7 });
  const start = toIsoStr(anchor);
  const planDate = addDaysIso(start, 1); // a Tuesday inside the subtask's range
  const { parentPath, absPath } = await writeDragFixture({
    vaultDir, parentName: "E2E Disable", subtaskName: "Disable target", startDate: start, endDate: addDaysIso(start, 4), workloadPlan: { [planDate]: PLAN_HOURS },
  });

  try {
    await cdp.waitForExpression(`(() => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(parentPath)}); const c = f && app.metadataCache.getFileCache(f); return !!(c && c.frontmatter && c.frontmatter.gantt === true); })()`, { timeoutMs: 15000, label: "fixture indexed" });
    await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(GANTT)}), true`);
    await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar").length === 1`, { timeoutMs: 30000, label: "gantt rendered" });
  } catch (err) {
    return fail(`gantt did not open: ${err.message}`);
  }
  details.push(`trust dialog: ${await dismissTrustDialogIfPresent(cdp)}`);
  cdp.resetCapturedErrors();

  // The summary cell of planDate must be rendered (and show the plan) before anything is toggled.
  let before;
  try {
    await cdp.waitForExpression(`(() => { const c = [...document.querySelectorAll(".task-gantt-workload-summary-cell")].find((e) => e.getAttribute("data-date") === ${JSON.stringify(planDate)}); const l = c && c.querySelector(".task-gantt-workload-summary-plan"); return !!(l && l.textContent.trim() !== "" && l.textContent.trim() !== "0h"); })()`, { timeoutMs: 15000, label: "initial plan total" });
    before = await planLabel(cdp, planDate);
  } catch (err) {
    return fail(`no initial plan total on ${planDate}: ${err.message}`);
  }
  details.push(`plan total ${planDate} before: ${before}`);

  // 1. Right-click the bar → 一時無効にする.
  const barRect = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!barRect) return fail("bar not found");
  const bar = centerOf(barRect);
  await clickAt(cdp, bar.x, bar.y, "right");
  if (!(await clickByText(cdp, ".menu-item", "一時無効にする"))) {
    const seen = await cdp.evaluate(`JSON.stringify([...document.querySelectorAll(".menu-item")].map((e) => e.textContent))`);
    return fail(`context menu has no 「一時無効にする」: ${seen}`);
  }
  try {
    await waitFor(() => readFrontmatterField(readNoteText(absPath), "disabled") === "true", "disabled: true in the note");
    await cdp.waitForExpression(`!!document.querySelector(".task-gantt-bar.is-disabled")`, { timeoutMs: 10000, label: ".is-disabled bar" });
  } catch (err) {
    return fail(`disable did not apply (${err.message}); note:\n${readNoteText(absPath)}`);
  }
  const statusAfter = readFrontmatterField(readNoteText(absPath), "status");
  if (statusAfter !== "active") failures.push(`status changed by disabling: ${statusAfter}`);
  try {
    await cdp.waitForExpression(`(() => { const c = [...document.querySelectorAll(".task-gantt-workload-summary-cell")].find((e) => e.getAttribute("data-date") === ${JSON.stringify(planDate)}); const l = c && c.querySelector(".task-gantt-workload-summary-plan"); return !l || l.textContent.trim() === "" || l.textContent.trim() === "0h" || l.textContent.trim() === "0"; })()`, { timeoutMs: 10000, label: "plan total dropped" });
  } catch (err) {
    return fail(`plan total did not drop on ${planDate}: ${err.message} (now ${await planLabel(cdp, planDate)})`);
  }
  details.push(`OK disabled → plan total ${planDate}: ${await planLabel(cdp, planDate)}`);

  // 2. Hover → popover → 有効に戻す.
  // Closing a context menu arms a 1200ms hover-popover suppression window; hovering sooner shows nothing.
  await sleep(1500);
  const rect2 = await scrollBarIntoView(cdp, ".task-gantt-bar");
  const bar2 = centerOf(rect2);
  await hoverOnto(cdp, bar2.x, bar2.y);
  try {
    await cdp.waitForExpression(`!!document.querySelector(".task-gantt-rich-popover.is-subtask .task-gantt-popover-disabled-chip")`, { timeoutMs: 10000, label: "popover with 無効中 chip" });
  } catch (err) {
    const dbg = await cdp.evaluate(`JSON.stringify({pt: (() => { const e = document.elementFromPoint(${bar2.x}, ${bar2.y}); return e && e.className; })(), pops: [...document.querySelectorAll("[class*=popover],[class*=popup]")].map((e) => e.className)})`);
    return fail(`popover missing the 無効中 chip: ${err.message} ${dbg} bar ${JSON.stringify(bar2)}`);
  }
  const chipText = await cdp.evaluate(`document.querySelector(".task-gantt-popover-disabled-chip").textContent`);
  if (chipText !== "無効中") failures.push(`chip text ${chipText}`);
  if (!(await clickByText(cdp, ".task-gantt-rich-popover button", "有効に戻す"))) return fail("popover has no 「有効に戻す」 button");
  try {
    await waitFor(() => readFrontmatterField(readNoteText(absPath), "disabled") === undefined, "disabled removed from the note");
    await cdp.waitForExpression(`!document.querySelector(".task-gantt-bar.is-disabled")`, { timeoutMs: 10000, label: ".is-disabled gone" });
    await cdp.waitForExpression(`(() => { const c = [...document.querySelectorAll(".task-gantt-workload-summary-cell")].find((e) => e.getAttribute("data-date") === ${JSON.stringify(planDate)}); const l = c && c.querySelector(".task-gantt-workload-summary-plan"); return !!l && l.textContent.trim() === ${JSON.stringify(before)}; })()`, { timeoutMs: 10000, label: "plan total restored" });
  } catch (err) {
    return fail(`re-enable did not apply (${err.message}); note:\n${readNoteText(absPath)}`);
  }
  details.push(`OK re-enabled → plan total back to ${before}`);

  const errors = cdp.capturedErrors();
  if (errors.length) failures.push(`page errors: ${errors.map((e) => e.text).join(" / ")}`);
  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}
