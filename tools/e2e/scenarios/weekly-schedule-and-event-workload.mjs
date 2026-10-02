
// tools/e2e/scenarios/weekly-schedule-and-event-workload.mjs



// This scenario drives the two multi-step flows that need real Obsidian input:
// 1. open 「定例作業設定」, add/edit a live schedule, then verify the
// Wednesday summary and its 「週次定例」 day-summary popover;
// 2. right-click the 「その他」 row to create an event, hover its shared
// workload graph, paint a value with trusted CDP pointer input, then use
// 「複製」 and verify the second chip and copied workload on disk.

// Every pointer interaction uses CDP Input events rather than synthetic
// pointer events because the production handlers use pointer capture.


import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadNoteFormatModule } from "../gen-fixtures.mjs";
import {
  addDaysIso,
  pickAnchorMonday,
  toIsoStr,
} from "./drag-fixture.mjs";
import {
  dismissTrustDialogIfPresent,
  dragGesture,
  hoverOnto,
  mouseDown,
  mouseUp,
  moveMouse,
  selectValue,
  setFieldValue,
  sleep,
} from "./cdp-input.mjs";

const PLUGIN_ID = "vault-gantt";
const COMMAND_ID = `${PLUGIN_ID}:open-task-gantt`;
const SCENARIO_NAME = "weekly-schedule-and-event-workload";
const ARTIFACTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "artifacts"
);
const DISK_POLL_TIMEOUT_MS = 15000;
const DISK_POLL_INTERVAL_MS = 200;

/**
 * Keeps the fixed Daily ToDo row out of this scenario's viewport so the two
 * flows under test occupy the same stable vertical positions as the QA run.
 * The runner has already installed the plugin and seeded this file.
 */
export function prepare(vaultDir) {
  const dataPath = path.join(
    vaultDir,
    ".obsidian",
    "plugins",
    PLUGIN_ID,
    "data.json"
  );
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  Object.assign(data, {
    ganttFeatureWorkloadEnabled: true,
    ganttFeatureEventsEnabled: true,
    ganttFeatureDailyTodoEnabled: false,
    incrementalGanttRender: true,
  });
  fs.writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * @param {{ cdp: import("../obsidian-runtime.mjs").CdpSession, vaultDir: string }} ctx
 * @returns {Promise<{ ok: boolean, failures: string[], details: string }>}
 */
export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];
  const fixture = await writeFixture(vaultDir);
  const dataPath = path.join(
    vaultDir,
    ".obsidian",
    "plugins",
    PLUGIN_ID,
    "data.json"
  );
  details.push(`fixture: ${fixture.startDate} -> ${fixture.endDate}`);

  try {
    const hasCommand = await cdp.evaluate(
      `!!app.commands.commands[${JSON.stringify(COMMAND_ID)}]`
    );
    if (!hasCommand) {
      failures.push(`command ${COMMAND_ID} not registered — plugin not loaded?`);
      return result(failures, details);
    }

    // Wait for the real metadata cache before opening the view. The Gantt view
    // loads tasks once during onOpen and has no metadata-cache re-render hook.
    await cdp.waitForExpression(
      `(() => {
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(fixture.parentPath)});
        const cache = file ? app.metadataCache.getFileCache(file) : null;
        return !!(cache && cache.frontmatter && cache.frontmatter.ganttEnabled === true);
      })()`,
      { timeoutMs: 20000, label: "fixture indexed by metadataCache" }
    );

    await cdp.evaluate(
      `app.commands.executeCommandById(${JSON.stringify(COMMAND_ID)}), true`
    );
    await cdp.waitForExpression(
      `!!document.querySelector(".task-gantt-wrap") && document.querySelectorAll(".task-gantt-bar").length === 1`,
      { timeoutMs: 30000, label: "Gantt view and fixture bar" }
    );
    details.push(`trust dialog: ${await dismissTrustDialogIfPresent(cdp)}`);
    cdp.resetCapturedErrors();


    // 1. Weekly schedule button, live modal CRUD, summary and popover.

    const buttonInfo = await visibleButtonInfo(cdp, "定例作業設定");
    assert(buttonInfo, "定例作業設定 button is missing");
    assert(buttonInfo.rect.width > 0 && buttonInfo.rect.height > 0, "定例作業設定 button has no visible rect");
    assert(buttonInfo.hitIsButton, `定例作業設定 button is covered by ${buttonInfo.hitClass}`);
    assert(buttonInfo.parentRect, "workload left cell is missing around 定例作業設定 button");
    assert(
      buttonInfo.rect.left >= buttonInfo.parentRect.left &&
        buttonInfo.rect.right <= buttonInfo.parentRect.right &&
        buttonInfo.rect.top >= buttonInfo.parentRect.top &&
        buttonInfo.rect.bottom <= buttonInfo.parentRect.bottom,
      "定例作業設定 button is outside the workload left cell"
    );
    await capture(cdp, `${SCENARIO_NAME}-button`);
    await clickRect(cdp, buttonInfo.rect);

    await cdp.waitForExpression(
      `Array.from(document.querySelectorAll(".modal-container")).some((modal) => (modal.textContent || "").includes("定例作業設定"))`,
      { timeoutMs: 5000, label: "weekly schedule modal" }
    );
    const initialModal = await cdp.evaluate(`(() => {
      const modal = Array.from(document.querySelectorAll(".modal-container"))
        .find((candidate) => (candidate.textContent || "").includes("定例作業設定"));
      return {
        buttons: Array.from(modal?.querySelectorAll("button") || []).map((button) => button.textContent.trim()),
        rows: modal?.querySelectorAll(".task-gantt-weekly-work-schedule-row").length ?? 0,
      };
    })()`);
    assert(initialModal.buttons.includes("追加"), "weekly schedule modal has no 追加 button");
    assert(initialModal.rows === 0, `weekly schedule modal should start empty, got ${initialModal.rows} rows`);
    await capture(cdp, `${SCENARIO_NAME}-modal-empty`);

    await clickButtonByText(cdp, "追加");
    await cdp.waitForExpression(
      `document.querySelectorAll(".task-gantt-weekly-work-schedule-row").length === 1`,
      { timeoutMs: 5000, label: "new weekly schedule row" }
    );
    await setFieldValue(cdp, '.modal-container input[aria-label="作業名"]', "習字");
    await waitForData(
      dataPath,
      (data) => data.weeklyWorkSchedules?.some((schedule) => schedule.title === "習字"),
      "weekly schedule title save"
    );
    await selectValue(cdp, '.modal-container select[aria-label="曜日"]', "3");
    await waitForData(
      dataPath,
      (data) => data.weeklyWorkSchedules?.some((schedule) => schedule.title === "習字" && schedule.dayOfWeek === 3),
      "weekly schedule weekday save"
    );
    await setFieldValue(cdp, '.modal-container input[aria-label="週の分数"]', "30");
    const savedScheduleData = await waitForData(
      dataPath,
      (data) => data.weeklyWorkSchedules?.some(
        (schedule) =>
          schedule.title === "習字" &&
          schedule.dayOfWeek === 3 &&
          schedule.minutesPerWeek === 30
      ),
      "weekly schedule minutes save"
    );
    const editedModal = await cdp.evaluate(`(() => {
      const modal = Array.from(document.querySelectorAll(".modal-container"))
        .find((candidate) => (candidate.textContent || "").includes("定例作業設定"));
      return {
        title: modal?.querySelector('input[aria-label="作業名"]')?.value ?? null,
        day: modal?.querySelector('select[aria-label="曜日"]')?.value ?? null,
        minutes: modal?.querySelector('input[aria-label="週の分数"]')?.value ?? null,
        rows: modal?.querySelectorAll(".task-gantt-weekly-work-schedule-row").length ?? 0,
      };
    })()`);
    assert(editedModal.title === "習字", `schedule title field shows ${JSON.stringify(editedModal.title)}`);
    assert(editedModal.day === "3", `schedule weekday field shows ${JSON.stringify(editedModal.day)}`);
    assert(editedModal.minutes === "30", `schedule minutes field shows ${JSON.stringify(editedModal.minutes)}`);
    await capture(cdp, `${SCENARIO_NAME}-modal-edited`);

    await clickButtonByText(cdp, "閉じる");
    await cdp.waitForExpression(
      `!Array.from(document.querySelectorAll(".modal-container")).some((modal) => (modal.textContent || "").includes("定例作業設定"))`,
      { timeoutMs: 5000, label: "weekly schedule modal closed" }
    );
    await sleep(500);

    const wednesdayCell = await scrollDateIntoView(cdp, fixture.wednesdayDate);
    assert(wednesdayCell.text.includes("0.5h"), `Wednesday summary does not show 0.5h: ${JSON.stringify(wednesdayCell)}`);
    await hoverOnto(
      cdp,
      wednesdayCell.rect.left + wednesdayCell.rect.width / 2,
      wednesdayCell.rect.top + wednesdayCell.rect.height / 2,
      { settleMs: 300 }
    );
    await cdp.waitForExpression(
      `!!document.querySelector(".task-gantt-workload-day-summary-popover")`,
      { timeoutMs: 5000, label: "weekly Wednesday day-summary popover" }
    );
    const wednesdayPopup = await cdp.evaluate(
      `document.querySelector(".task-gantt-workload-day-summary-popover")?.textContent || ""`
    );
    assert(wednesdayPopup.includes("週次定例"), "Wednesday popover has no 週次定例 entry");
    assert(wednesdayPopup.includes("習字"), "Wednesday popover has no 習字 entry");
    await capture(cdp, `${SCENARIO_NAME}-weekly-popover`);
    details.push(`weekly schedule saved: ${JSON.stringify(savedScheduleData.weeklyWorkSchedules)}`);


    // 2. Event add, shared workload popup, paint, day-label and duplicate.

    await moveMouse(cdp, 2, 2);
    await sleep(300);
    const eventCell = await scrollDateIntoView(cdp, fixture.eventDate);
    const eventRow = await cdp.evaluate(`(() => {
      const row = document.querySelector(".task-gantt-event-row");
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    })()`);
    assert(eventRow && eventRow.width > 0 && eventRow.height > 0, "event row is not visible");
    await rightClickAt(
      cdp,
      eventCell.rect.left + eventCell.rect.width / 2,
      eventRow.top + eventRow.height / 2
    );
    await cdp.waitForExpression(
      `document.querySelectorAll(".task-gantt-event-chip").length === 1`,
      { timeoutMs: 10000, label: "event chip created by right-click" }
    );
    const eventAdded = await waitForData(
      dataPath,
      (data) =>
        Array.isArray(data.ganttEvents) &&
        data.ganttEvents.length === 1 &&
        data.ganttEvents[0].date === fixture.eventDate,
      "event add save"
    );

    const chipRect = await firstRect(cdp, ".task-gantt-event-chip");
    assert(chipRect && chipRect.width > 0 && chipRect.height > 0, "new event chip is not visible");
    await hoverOnto(
      cdp,
      chipRect.left + chipRect.width / 2,
      chipRect.top + chipRect.height / 2,
      { settleMs: 350 }
    );
    await cdp.waitForExpression(
      `!!document.querySelector(".task-gantt-workload-popover.is-visible")`,
      { timeoutMs: 5000, label: "event workload popover" }
    );
    const eventPopup = await cdp.evaluate(`(() => {
      const popup = document.querySelector(".task-gantt-workload-popover.is-visible");
      const graph = popup?.querySelector(".task-gantt-workload-graph");
      const graphRect = graph?.getBoundingClientRect();
      return {
        toggle: popup?.querySelector(".task-gantt-workload-popover-mode-toggle")?.textContent || null,
        axis: Array.from(popup?.querySelectorAll(".task-gantt-workload-popover-axis-label") || []).map((el) => el.textContent),
        dates: Array.from(popup?.querySelectorAll(".task-gantt-workload-popover-cell") || []).map((el) => el.getAttribute("data-date")),
        graphRect: graphRect ? { left: graphRect.left, top: graphRect.top, right: graphRect.right, bottom: graphRect.bottom, width: graphRect.width, height: graphRect.height } : null,
      };
    })()`);
    assert(eventPopup.toggle === "計画時間", `event workload popup toggle is ${JSON.stringify(eventPopup.toggle)}`);
    assert(eventPopup.axis.length > 0, "event workload popup has no visible Y-axis");
    assert(eventPopup.dates.length === 1 && eventPopup.dates[0] === fixture.eventDate, `event workload popup dates are wrong: ${JSON.stringify(eventPopup.dates)}`);
    assert(eventPopup.graphRect?.width > 0 && eventPopup.graphRect?.height > 0, "event workload graph has no visible rect");
    await capture(cdp, `${SCENARIO_NAME}-event-popover`);

    const graph = eventPopup.graphRect;
    await dragGesture(cdp, {
      fromX: graph.left + graph.width / 2,
      fromY: graph.top + graph.height * 0.35,
      toX: graph.left + graph.width / 2 + 3,
      toY: graph.top + graph.height * 0.35 + 2,
      steps: 3,
      settleMs: 200,
    });
    const paintedData = await waitForData(
      dataPath,
      (data) => {
        const event = data.ganttEvents?.find((candidate) => candidate.date === fixture.eventDate);
        return Number(event?.workloadPlan?.[fixture.eventDate]) > 0;
      },
      "event workload paint save"
    );
    const paintedHours = Number(
      paintedData.ganttEvents.find((candidate) => candidate.date === fixture.eventDate).workloadPlan[fixture.eventDate]
    );
    await moveMouse(cdp, 2, 2);
    await sleep(600);
    const paintedLabel = await cdp.evaluate(`(() => {
      const label = document.querySelector(".task-gantt-event-row .task-gantt-workload-day-label");
      if (!label) return null;
      const rect = label.getBoundingClientRect();
      const actual = label.querySelector(".task-gantt-workload-day-label-actual");
      const plan = label.querySelector(".task-gantt-workload-day-label-plan");
      return {
        actual: actual?.textContent ?? null,
        plan: plan?.textContent ?? null,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        actualDisplay: actual ? getComputedStyle(actual).display : null,
        planDisplay: plan ? getComputedStyle(plan).display : null,
      };
    })()`);
    assert(paintedLabel?.actual === "-h", `event actual day-label is ${JSON.stringify(paintedLabel?.actual)}`);
    assert(paintedLabel?.plan === `${paintedHours}h`, `event plan day-label is ${JSON.stringify(paintedLabel?.plan)}, expected ${paintedHours}h`);
    assert(paintedLabel.rect.width > 0 && paintedLabel.rect.height > 0, "event day-label has no visible rect");
    assert(paintedLabel.actualDisplay !== "none" && paintedLabel.planDisplay !== "none", "event day-label text is hidden");
    await capture(cdp, `${SCENARIO_NAME}-event-painted`);

    const paintedChip = await firstRect(cdp, ".task-gantt-event-chip");
    assert(paintedChip, "event chip disappeared before duplicate menu");
    await rightClickAt(
      cdp,
      paintedChip.left + paintedChip.width / 2,
      paintedChip.top + paintedChip.height / 2
    );
    await cdp.waitForExpression(
      `Array.from(document.querySelectorAll(".menu-item-title")).some((el) => el.textContent.trim() === "複製")`,
      { timeoutMs: 5000, label: "event duplicate menu" }
    );
    const menuItems = await cdp.evaluate(`Array.from(document.querySelectorAll(".menu-item"))
      .filter((item) => getComputedStyle(item).display !== "none")
      .map((item) => ({
        text: item.textContent.trim(),
        rect: (() => { const rect = item.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; })(),
      }))`);
    const menuTexts = menuItems.map((item) => item.text);
    const duplicateIndex = menuTexts.indexOf("複製");
    const deleteIndex = menuTexts.indexOf("削除");
    assert(duplicateIndex >= 0, `duplicate menu item missing: ${JSON.stringify(menuItems)}`);
    assert(deleteIndex > duplicateIndex, `duplicate menu item is not above delete: ${JSON.stringify(menuItems)}`);
    await capture(cdp, `${SCENARIO_NAME}-event-menu`);

    const duplicateItem = menuItems[duplicateIndex];
    await clickRect(cdp, duplicateItem.rect);
    const duplicatedData = await waitForData(
      dataPath,
      (data) =>
        Array.isArray(data.ganttEvents) &&
        data.ganttEvents.length === 2 &&
        data.ganttEvents.filter((candidate) => candidate.date === fixture.eventDate).length === 2,
      "event duplicate save"
    );
    await cdp.waitForExpression(
      `document.querySelectorAll(".task-gantt-event-chip").length === 2`,
      { timeoutMs: 10000, label: "two duplicated event chips" }
    );
    await moveMouse(cdp, 2, 2);
    await sleep(500);
    const duplicateChips = await cdp.evaluate(`Array.from(document.querySelectorAll(".task-gantt-event-chip")).map((chip) => {
      const rect = chip.getBoundingClientRect();
      return { text: chip.textContent, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } };
    })`);
    assert(duplicateChips.every((chip) => chip.rect.width > 0 && chip.rect.height > 0), `duplicated chip is not visibly laid out: ${JSON.stringify(duplicateChips)}`);
    assert(duplicatedData.ganttEvents[0].title === duplicatedData.ganttEvents[1].title, "duplicate did not retain title");
    assert(duplicatedData.ganttEvents[0].date === duplicatedData.ganttEvents[1].date, "duplicate did not retain date");
    assert(
      Number(duplicatedData.ganttEvents[0].workloadPlan?.[fixture.eventDate]) === paintedHours &&
        Number(duplicatedData.ganttEvents[1].workloadPlan?.[fixture.eventDate]) === paintedHours,
      "duplicate did not copy event workload"
    );
    await capture(cdp, `${SCENARIO_NAME}-event-duplicate`);
    details.push(`event added: ${JSON.stringify(eventAdded.ganttEvents)}`);
    details.push(`event workload: ${paintedHours}h; duplicate chips: ${duplicateChips.length}`);

    const errors = cdp.capturedErrors();
    if (errors.length > 0) {
      failures.push(
        `${errors.length} console error(s) during scenario:\n` +
          errors.map((error) => `    [${error.source}] ${error.text}`).join("\n")
      );
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return result(failures, details);
}

async function writeFixture(vaultDir) {
  const anchor = pickAnchorMonday({ minDaysFromToday: 10 });
  const startDate = toIsoStr(anchor);
  const endDate = addDaysIso(startDate, 4);
  const eventDate = endDate;
  const wednesdayDate = addDaysIso(startDate, 2);
  const today = toIsoStr(new Date());
  const parentName = "E2E Weekly Event Flow";
  const subtaskName = "QA 作業";
  const parentPath = `tasks/${today.slice(0, 4)}/${today.slice(5, 7)}/${today} ${parentName}.md`;
  const subtaskKey = "subtask-1";
  const { buildFullNote } = await loadNoteFormatModule();
  const subtask = {
    kind: "subtask",
    id: `${parentPath}::${subtaskKey}`,
    key: subtaskKey,
    file: { path: parentPath, parentPath, heading: subtaskName },
    title: subtaskName,
    displayName: subtaskName,
    statusLabel: "active",
    completed: false,
    createdAt: today,
    updatedAt: today,
    dueDate: undefined,
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    plannedStartDate: startDate,
    plannedEndDate: endDate,
    workloadPlan: { [eventDate]: 1 },
    workloadActual: undefined,
  };
  const parent = {
    kind: "parent",
    id: parentPath,
    file: { path: parentPath },
    title: parentName,
    displayName: parentName,
    statusLabel: "active",
    completed: false,
    createdAt: today,
    updatedAt: today,
    dueDate: undefined,
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: true,
    ganttOrder: 0,
    subtasks: new Map([[subtaskKey, subtask]]),
  };
  const absPath = path.join(vaultDir, parentPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buildFullNote(parent, parent.subtasks), "utf8");
  return { parentPath, startDate, endDate, eventDate, wednesdayDate };
}

async function visibleButtonInfo(cdp, text) {
  return cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)} && getComputedStyle(candidate).display !== "none");
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const parent = button.closest(".task-gantt-workload-left");
    const parentRect = parent?.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      parentRect: parentRect ? { left: parentRect.left, top: parentRect.top, right: parentRect.right, bottom: parentRect.bottom, width: parentRect.width, height: parentRect.height } : null,
      hitClass: hit?.className ?? null,
      hitIsButton: hit === button || (hit instanceof Element && button.contains(hit)),
    };
  })()`);
}

async function clickButtonByText(cdp, text) {
  const info = await visibleButtonInfo(cdp, text);
  assert(info, `button ${text} not found`);
  assert(info.rect.width > 0 && info.rect.height > 0, `button ${text} has no visible rect`);
  assert(info.hitIsButton, `button ${text} is covered by ${info.hitClass}`);
  await clickRect(cdp, info.rect);
}

async function clickRect(cdp, rect) {
  await moveMouse(cdp, rect.left + rect.width / 2, rect.top + rect.height / 2);
  await sleep(40);
  await mouseDown(cdp, rect.left + rect.width / 2, rect.top + rect.height / 2);
  await sleep(40);
  await mouseUp(cdp, rect.left + rect.width / 2, rect.top + rect.height / 2);
  await sleep(250);
}

async function rightClickAt(cdp, x, y) {
  await moveMouse(cdp, x, y);
  await sleep(50);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "right",
    buttons: 2,
    clickCount: 1,
    pointerType: "mouse",
  });
  await sleep(50);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "right",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
  await sleep(300);
}

async function firstRect(cdp, selector) {
  return cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  })()`);
}

async function cellInfo(cdp, date) {
  return cdp.evaluate(`(() => {
    const cell = Array.from(document.querySelectorAll(".task-gantt-workload-summary-cell"))
      .find((candidate) => candidate.getAttribute("data-date") === ${JSON.stringify(date)});
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    return {
      text: cell.textContent,
      className: cell.className,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      visible: rect.width > 0 && rect.height > 0,
    };
  })()`);
}

async function scrollDateIntoView(cdp, date) {
  const state = await cdp.evaluate(`(() => {
    const wrap = document.querySelector(".task-gantt-wrap");
    const cell = Array.from(document.querySelectorAll(".task-gantt-workload-summary-cell"))
      .find((candidate) => candidate.getAttribute("data-date") === ${JSON.stringify(date)});
    const sticky = document.querySelector(".task-gantt-workload-left");
    if (!wrap || !cell || !sticky) return null;
    const cellRect = cell.getBoundingClientRect();
    const stickyRect = sticky.getBoundingClientRect();
    return {
      target: wrap.scrollLeft + cellRect.left - stickyRect.right - 46,
      max: Math.max(0, wrap.scrollWidth - wrap.clientWidth),
    };
  })()`);
  assert(state, `summary cell ${date} not found`);
  const target = Math.max(0, Math.min(state.max, state.target));
  await cdp.evaluate(`(() => {
    const wrap = document.querySelector(".task-gantt-wrap");
    if (wrap) wrap.scrollTo(${JSON.stringify(target)}, 0);
    return true;
  })()`);
  await sleep(500);
  const info = await cellInfo(cdp, date);
  assert(info?.visible, `summary cell ${date} is not visible after scrolling`);
  return info;
}

async function waitForData(dataPath, predicate, label) {
  const deadline = Date.now() + DISK_POLL_TIMEOUT_MS;
  let lastError;
  for (;;) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
      if (predicate(data)) {
        return data;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`
      );
    }
    await sleep(DISK_POLL_INTERVAL_MS);
  }
}

async function capture(cdp, name) {
  await cdp.screenshot(path.join(ARTIFACTS_DIR, `${name}.png`));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function result(failures, details) {
  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}
