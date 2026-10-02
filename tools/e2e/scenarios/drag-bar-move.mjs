
// tools/e2e/scenarios/drag-bar-move.mjs



// Seed one Gantt-enabled parent with one subtask and deterministic planned
// dates. The fixture uses a Monday anchor and a short duration so fixture
// dates remain business days in this holiday-free E2E environment, where
// Saturday and Sunday are non-working.

// Open Gantt, drag the center of the bar by exactly three day widths using
// trusted CDP input, then verify the saved file. Both planned dates must match
// the production moveBarByCalendarDelta function, which preserves business-day
// duration when a move crosses a weekend.



import fs from "node:fs";
import {
  pickAnchorMonday,
  toIsoStr,
  addDaysIso,
  writeDragFixture,
  waitForFrontmatterField,
  readFrontmatterField,
  loadGanttDragModules,
} from "./drag-fixture.mjs";
import {
  centerOf,
  dragGesture,
  dismissTrustDialogIfPresent,
  scrollBarIntoView,
} from "./cdp-input.mjs";

const COMMAND_ID = "vault-gantt:open-task-gantt";
const DAY_WIDTH_PX = 28; // DEFAULT_SETTINGS.ganttZoom (src/core/constants.ts) — a fresh vault has no override.
const DURATION_DAYS = 4; // Mon -> Fri: 5 business days, every fixture date on a business day
const DRAG_DELTA_DAYS = 3;
const EDGE_ZONE_PX = 6; // RESIZE_EDGE_HIT_ZONE_PX (src/ui/task-gantt-view.ts)

/**
 * @param {{ cdp: import("../obsidian-runtime.mjs").CdpSession, vaultDir: string }} ctx
 * @returns {Promise<{ ok: boolean, failures: string[], details: string }>}
 */
export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];

  // This E2E environment has no holidays (see drag-fixture.mjs's header) —
  // the same empty holidaySet production's finishBarDrag receives here.
  const holidaySet = new Set();
  const { ganttDrag } = await loadGanttDragModules();

  const anchor = pickAnchorMonday({ minDaysFromToday: 20 });
  const startDate = toIsoStr(anchor);
  const endDate = addDaysIso(startDate, DURATION_DAYS);
  // Expected post-drag dates from the REAL production move-confirm function
  // — task-gantt-view.ts's finishBarDrag "move" branch calls this very

  // math: this move crosses a weekend, so business-day duration
  // preservation shifts the end date further than a naive +3-day addition
  // would predict.
  const { nextStart: expectedStart, nextEnd: expectedEnd } =
    ganttDrag.moveBarByCalendarDelta(
      { start: startDate, end: endDate },
      DRAG_DELTA_DAYS,
      holidaySet
    );

  const { absPath, parentPath, subtaskKey } = await writeDragFixture({
    vaultDir,
    parentName: "E2E Drag BarMove",
    startDate,
    endDate,
  });
  details.push(`fixture: ${startDate} -> ${endDate} (subtask ${subtaskKey})`);

  const hasCommand = await cdp.evaluate(
    `!!app.commands.commands[${JSON.stringify(COMMAND_ID)}]`
  );
  if (!hasCommand) {
    failures.push(`command ${COMMAND_ID} not registered — plugin not loaded?`);
    return { ok: false, failures, details: details.join(" | ") };
  }

  // task-gantt-view.ts's render has no reactive listener for Obsidian's
  // own metadataCache indexing — it reads host.loadTasks exactly once at
  // onOpen time. Executing the open-gantt command before Obsidian has
  // finished indexing the fixture file JUST written above (a real async
  // race against the real vault, not simulated) makes the view come up
  // with zero tasks and NOTHING ever re-renders it afterward (confirmed via
  // a live diagnostic: view.tasks stayed 0 for 28+ real seconds under load,
  // while a manual `view.render` call fixed it instantly, proving the
  // data was there all along — only the timing of opening the view was
  // off). Waiting for the metadataCache to actually reflect this fixture's
  // frontmatter first removes the race outright.
  try {
    await cdp.waitForExpression(
      `(() => {
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(parentPath)});
        if (!f) return false;
        const cache = app.metadataCache.getFileCache(f);
        return !!(cache && cache.frontmatter && cache.frontmatter.ganttEnabled === true);
      })()`,
      { timeoutMs: 15000, label: "fixture file indexed by metadataCache" }
    );
  } catch (err) {
    failures.push(`fixture file never got indexed: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }

  cdp.resetCapturedErrors();
  await cdp.evaluate(
    `app.commands.executeCommandById(${JSON.stringify(COMMAND_ID)}), true`
  );

  try {
    await cdp.waitForExpression(
      `document.querySelectorAll(".task-gantt-bar").length === 1`,
      { timeoutMs: 30000, label: "single gantt bar rendered" }
    );
  } catch (err) {
    failures.push(`bar never rendered: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }

  // Obsidian shows a "trust the author of this vault?" overlay on every
  // fresh vault (see cdp-input.mjs's dismissTrustDialogIfPresent docblock)
  // — it must be cleared BEFORE any real coordinate-based mouse dispatch or
  // every click below lands on the modal backdrop instead of the bar.
  const trustResult = await dismissTrustDialogIfPresent(cdp);
  details.push(`trust dialog: ${trustResult}`);

  // The fixture anchors 20+ days out (see drag-fixture.mjs), which renders
  // past the default unscrolled viewport — bring the bar into view before
  // computing click coordinates (see scrollBarIntoView's docblock).
  const rect = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!rect) {
    failures.push("`.task-gantt-bar` disappeared before the drag could start");
    return { ok: false, failures, details: details.join(" | ") };
  }
  checkMoveZoneSafe(rect, failures);
  const { x, y } = centerOf(rect);
  details.push(`bar rect: left=${rect.left.toFixed(1)} width=${rect.width.toFixed(1)}`);

  await dragGesture(cdp, {
    fromX: x,
    fromY: y,
    toX: x + DRAG_DELTA_DAYS * DAY_WIDTH_PX,
    toY: y,
  });
  details.push(`dragged +${DRAG_DELTA_DAYS} day-widths (${DRAG_DELTA_DAYS * DAY_WIDTH_PX}px)`);

  const startKey = `subtask__${subtaskKey}__plannedStartDate`;
  const endKey = `subtask__${subtaskKey}__plannedEndDate`;

  let actualStart;
  try {
    actualStart = await waitForFrontmatterField(absPath, startKey, expectedStart, {
      label: "plannedStartDate after bar-move drag",
    });
    details.push(`plannedStartDate on disk: ${actualStart} (expected ${expectedStart})`);
  } catch (err) {
    const content = fs.readFileSync(absPath, "utf8");
    failures.push(
      `${err.message}\n    on-disk plannedEndDate at time of failure: ${readFrontmatterField(content, endKey)}`
    );
  }

  let actualEnd;
  try {
    // The start/end write together in one vault.modify call, so once
    // plannedStartDate above has landed, plannedEndDate should already be
    // correct — short timeout, this is a confirming re-check, not a second
    // independent wait for a separate async operation.
    actualEnd = await waitForFrontmatterField(absPath, endKey, expectedEnd, {
      timeoutMs: 5000,
      label: "plannedEndDate after bar-move drag",
    });
    details.push(`plannedEndDate on disk: ${actualEnd} (expected ${expectedEnd})`);
  } catch (err) {
    failures.push(err.message);
  }

  if (actualStart !== undefined && actualEnd !== undefined) {
    checkDurationPreserved(
      ganttDrag,
      holidaySet,
      actualStart,
      actualEnd,
      ganttDrag.countWorkingDaysInclusive(startDate, endDate, holidaySet),
      failures,
      details
    );
  }

  const errors = cdp.capturedErrors();
  if (errors.length > 0) {
    failures.push(
      `${errors.length} console error(s) during scenario:\n` +
        errors.map((e) => `    [${e.source}] ${e.text}`).join("\n")
    );
  }

  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}

function checkMoveZoneSafe(rect, failures) {
  const centerOffsetX = rect.width / 2;
  if (centerOffsetX <= EDGE_ZONE_PX || centerOffsetX >= rect.width - EDGE_ZONE_PX) {
    failures.push(
      `bar too narrow (width=${rect.width}px) for its center to land safely inside the ` +
        `move zone (> ${EDGE_ZONE_PX}px from either edge) — widen the fixture's duration`
    );
  }
}

function checkDurationPreserved(
  ganttDrag,
  holidaySet,
  start,
  end,
  expectedBusinessDays,
  failures,
  details
) {

  // BUSINESS-day duration (countWorkingDaysInclusive), not its calendar-day
  // span — a move crossing a weekend legitimately widens the calendar span
  // while keeping the business-day count, so that count is what is asserted.
  const days = ganttDrag.countWorkingDaysInclusive(start, end, holidaySet);
  if (days !== expectedBusinessDays) {
    failures.push(
      `business-day duration not preserved: countWorkingDaysInclusive=${days}, ` +
        `expected ${expectedBusinessDays} (start=${start} end=${end})`
    );
  } else {
    details.push(`business-day duration preserved (${days} business days)`);
  }
}
