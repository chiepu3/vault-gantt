
// tools/e2e/scenarios/drag-resize.mjs



// Two sub-checks in ONE page load: a left-edge (resize-start) drag, THEN a
// right-edge (resize-end) drag. Per the isolation trap documented in
// cdp-input.mjs / run-smoke.mjs: the second drag does NOT start until the
// first drag's save has been verified to have actually landed on the SAVED
// FILE ON DISK and the resulting re-render has settled (re-confirmed via
// waiting for exactly one `.task-gantt-bar` again) — this is what makes two
// sequential gestures in the same page load safe despite this codebase's
// drag design having no exclusive lock.

// Expected dates come from the production resize functions loaded by
// drag-fixture.mjs. The right-edge drag lands on Saturday to exercise the
// backward snap; fixture dates remain business days due to the
// Monday anchor, so assertions compare exact date strings.

// The same gesture checks the 8px minimum-width preview clamp: drag far past
// the bar's start, then return to the target before releasing. The target date
// is Saturday, so production's backward snap determines the expected value.


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
  dragGesture,
  moveMouse,
  mouseDown,
  mouseUp,
  sleep,
  dismissTrustDialogIfPresent,
  scrollBarIntoView,
} from "./cdp-input.mjs";

const COMMAND_ID = "vault-gantt:open-task-gantt";
const DAY_WIDTH_PX = 28; // DEFAULT_SETTINGS.ganttZoom
const DURATION_DAYS = 4; // Mon -> Fri: every fixture date on a business day
const EDGE_CLICK_INSET_PX = 2; // well inside RESIZE_EDGE_HIT_ZONE_PX=6
const MIN_BAR_WIDTH_PX = 8; // MIN_BAR_WIDTH_PX (src/ui/task-gantt-view.ts)
const RESIZE_START_DELTA_DAYS = 1;
const RESIZE_END_DELTA_DAYS = 3;

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
  const { ganttDrag, ganttLayout } = await loadGanttDragModules();

  const anchor = pickAnchorMonday({ minDaysFromToday: 25 });
  const originalStart = toIsoStr(anchor);
  const originalEnd = addDaysIso(originalStart, DURATION_DAYS);

  const { absPath, parentPath, subtaskKey } = await writeDragFixture({
    vaultDir,
    parentName: "E2E Drag Resize",
    startDate: originalStart,
    endDate: originalEnd,
  });
  details.push(`fixture: ${originalStart} -> ${originalEnd} (subtask ${subtaskKey})`);

  const startKey = `subtask__${subtaskKey}__plannedStartDate`;
  const endKey = `subtask__${subtaskKey}__plannedEndDate`;

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
  // — cleared once, up front, before any real coordinate-based mouse click.
  const trustResult = await dismissTrustDialogIfPresent(cdp);
  details.push(`trust dialog: ${trustResult}`);

  // The fixture anchors 25+ days out (see drag-fixture.mjs), which renders
  // past the default unscrolled viewport — bring the bar into view before
  // computing click coordinates (see scrollBarIntoView's docblock).

  // Sub-check 1: drag the left edge to resize the bar's start.

  const rect1 = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!rect1) {
    failures.push("`.task-gantt-bar` disappeared before the resize-start drag");
    return { ok: false, failures, details: details.join(" | ") };
  }
  const leftEdgeX = rect1.left + EDGE_CLICK_INSET_PX;
  const leftEdgeY = rect1.top + rect1.height / 2;
  // Match production's resize-start calculation: add the day delta to
  // originalStart, clamp before the original end, then snap to a business day.
  const expectedStartAfterResize1 = ganttDrag.snapResizeStart(
    ganttLayout.addDays(originalStart, RESIZE_START_DELTA_DAYS),
    originalEnd,
    holidaySet
  );

  await dragGesture(cdp, {
    fromX: leftEdgeX,
    fromY: leftEdgeY,
    toX: leftEdgeX + RESIZE_START_DELTA_DAYS * DAY_WIDTH_PX,
    toY: leftEdgeY,
  });
  details.push(`resize-start: dragged +${RESIZE_START_DELTA_DAYS} day-width from the left edge`);

  let start1;
  try {
    start1 = await waitForFrontmatterField(absPath, startKey, expectedStartAfterResize1, {
      label: "plannedStartDate after resize-start drag",
    });
    details.push(`(1) plannedStartDate on disk: ${start1} (expected ${expectedStartAfterResize1})`);
  } catch (err) {
    const content = fs.readFileSync(absPath, "utf8");
    failures.push(
      `${err.message}\n    on-disk plannedEndDate at time of failure: ${readFrontmatterField(content, endKey)}`
    );
    // Fatal for this scenario: the second sub-check needs a known-good
    // starting point — proceeding would just produce a confusing secondary
    // failure on top of this one.
    return { ok: false, failures, details: details.join(" | ") };
  }

  const endUnchangedAfter1 = readFrontmatterField(fs.readFileSync(absPath, "utf8"), endKey);
  if (endUnchangedAfter1 !== originalEnd) {
    failures.push(
      `(1) resize-start drag changed plannedEndDate: on-disk=${endUnchangedAfter1}, expected unchanged ${originalEnd}`
    );
  } else {
    details.push(`(1) plannedEndDate unchanged: ${endUnchangedAfter1}`);
  }

  // Settle point before the second gesture: wait for the re-render to
  // finish (exactly one bar again) — see header + cdp-input.mjs's
  // dragGesture isolation warning for why this matters.
  try {
    await cdp.waitForExpression(
      `document.querySelectorAll(".task-gantt-bar").length === 1`,
      { timeoutMs: 15000, label: "single gantt bar re-rendered after resize-start save" }
    );
  } catch (err) {
    failures.push(`re-render after resize-start drag never settled: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }


  // Sub-check 2: drag the right edge to resize the end, while also probing
  // the minimum-width clamp during the same pointerdown-to-pointerup gesture.

  // The resize-start drag shifted the bar's content-left by one day-width;
  // re-confirm it's still comfortably in view before the second gesture.
  const rect2 = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!rect2) {
    failures.push("`.task-gantt-bar` disappeared before the resize-end drag");
    return { ok: false, failures, details: details.join(" | ") };
  }
  const rightEdgeX = rect2.right - EDGE_CLICK_INSET_PX;
  const rightEdgeY = rect2.top + rect2.height / 2;
  // Mirror finishBarDrag's "resize-end" branch exactly: raw date =
  // gantt-layout's addDays(originalEnd, dayDelta), then the REAL

  // This second drag starts AFTER resize-start's save landed, so
  // production's `originalStart` input for it is the post-resize-1 start.
  // For this fixture the raw target (Fri+1 = Sat) backward-snaps onto the
  // UNCHANGED end date, which production then treats as a no-op save
  // (finishBarDrag early-returns on newEnd === originalEnd) — the on-disk
  // value the wait below asserts is the one resize-start left in place.
  const expectedEndAfterResize2 = ganttDrag.snapResizeEnd(
    expectedStartAfterResize1,
    ganttLayout.addDays(originalEnd, RESIZE_END_DELTA_DAYS),
    holidaySet
  );

  await moveMouse(cdp, rightEdgeX, rightEdgeY);
  await sleep(30);
  await mouseDown(cdp, rightEdgeX, rightEdgeY);
  await sleep(30);

  // Probe: drag far past the bar's own start — the preview width must clamp
  // to MIN_BAR_WIDTH_PX (8px), never go lower or negative, checked
  // WHILE the pointer is still down (mid-gesture), before returning to the
  // real target below.

  // The 300px offset exceeds the distance needed to reach the 8px minimum.
  const PROBE_OFFSET_PX = 300;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.max(0, rightEdgeX - PROBE_OFFSET_PX),
    y: rightEdgeY,
    buttons: 1,
    pointerType: "mouse",
  });
  await sleep(80);
  const clampedWidth = await cdp.evaluate(
    `parseFloat(document.querySelector(".task-gantt-bar").style.width)`
  );
  if (!(clampedWidth === MIN_BAR_WIDTH_PX)) {
    failures.push(
      `(2) min-width clamp violated mid-drag: preview width=${clampedWidth}px, expected exactly ${MIN_BAR_WIDTH_PX}px`
    );
  } else {
    details.push(`(2) min-width preview clamp holds at ${clampedWidth}px`);
  }

  // Now bring the pointer back to the real target and release — completing
  // the SAME gesture (still no second pointerdown). The raw landing date is

  // expected value computed above already account for that.
  const finalX = rightEdgeX + RESIZE_END_DELTA_DAYS * DAY_WIDTH_PX;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: finalX,
    y: rightEdgeY,
    buttons: 1,
    pointerType: "mouse",
  });
  await sleep(30);
  await mouseUp(cdp, finalX, rightEdgeY);
  await sleep(150);
  details.push(`resize-end: dragged +${RESIZE_END_DELTA_DAYS} day-width from the right edge`);

  let end2;
  try {
    end2 = await waitForFrontmatterField(absPath, endKey, expectedEndAfterResize2, {
      label: "plannedEndDate after resize-end drag",
    });
    details.push(`(2) plannedEndDate on disk: ${end2} (expected ${expectedEndAfterResize2})`);
  } catch (err) {
    const content = fs.readFileSync(absPath, "utf8");
    failures.push(
      `${err.message}\n    on-disk plannedStartDate at time of failure: ${readFrontmatterField(content, startKey)}`
    );
  }

  const startUnchangedAfter2 = readFrontmatterField(fs.readFileSync(absPath, "utf8"), startKey);
  if (startUnchangedAfter2 !== expectedStartAfterResize1) {
    failures.push(
      `(2) resize-end drag changed plannedStartDate: on-disk=${startUnchangedAfter2}, expected unchanged ${expectedStartAfterResize1}`
    );
  } else {
    details.push(`(2) plannedStartDate unchanged: ${startUnchangedAfter2}`);
  }

  if (end2 !== undefined) {
    checkNoInversion(startUnchangedAfter2, end2, failures, details);
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

/** sanity that neither resize inverted start/end order. */
function checkNoInversion(start, end, failures, details) {
  if (!(start < end)) {
    failures.push(
      `date-inversion guard violated: final plannedStartDate=${start} is not before plannedEndDate=${end}`
    );
  } else {
    details.push(`no inversion: ${start} < ${end}`);
  }
}
