
// tools/e2e/scenarios/popover-and-inline-edit.mjs


// Seeds ONE gantt-enabled parent with ONE subtask (drag-fixture.mjs's
// deterministic-Monday builder — no drag happens in this scenario, but
// reusing it keeps the fixture shape identical to the drag scenarios and
// avoids a second bespoke fixture builder).

// Flow, all against the real DOM in Obsidian:
// 1. Move the mouse over a subtask bar and assert that the rich popover
// appears with the expected title and status chip.
// 2. Change the Status select, then verify the saved file and popover close.
// 3. Double-click the freshly rendered bar, edit its title, and press Enter.
// Verify the saved title. The file format stores one subtask title field
// sourced from displayName, and applyPatchToParent keeps displayName and
// title synchronized.


import fs from "node:fs";
import { pickAnchorMonday, toIsoStr, addDaysIso, writeDragFixture, waitForFrontmatterField, readFrontmatterField } from "./drag-fixture.mjs";
import {
  centerOf,
  hoverOnto,
  dblclickAt,
  selectValue,
  setFieldValue,
  keydownOn,
  dismissTrustDialogIfPresent,
  scrollBarIntoView,
} from "./cdp-input.mjs";

const COMMAND_ID = "vault-gantt:open-task-gantt";
const DURATION_DAYS = 4;
const SUBTASK_TITLE = "Planned work";
const NEW_TITLE = "E2E Renamed Subtask";
const EXPECTED_INITIAL_STATUS_CHIP = "未着手"; // DEFAULT_STATUSES.active
const NEW_STATUS = "in_progress";

/**
 * @param {{ cdp: import("../obsidian-runtime.mjs").CdpSession, vaultDir: string }} ctx
 * @returns {Promise<{ ok: boolean, failures: string[], details: string }>}
 */
export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];

  const anchor = pickAnchorMonday({ minDaysFromToday: 30 });
  const startDate = toIsoStr(anchor);
  const endDate = addDaysIso(startDate, DURATION_DAYS);

  const { absPath, parentPath, subtaskKey } = await writeDragFixture({
    vaultDir,
    parentName: "E2E Popover InlineEdit",
    subtaskName: SUBTASK_TITLE,
    startDate,
    endDate,
  });
  details.push(`fixture: ${startDate} -> ${endDate} (subtask ${subtaskKey})`);

  const statusKey = `subtask__${subtaskKey}__statusLabel`;
  const titleKey = `subtask__${subtaskKey}__title`;

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
  // — cleared once, up front, before any real coordinate-based mouse event.
  const trustResult = await dismissTrustDialogIfPresent(cdp);
  details.push(`trust dialog: ${trustResult}`);

  // The fixture anchors 30+ days out (see drag-fixture.mjs), which renders
  // past the default unscrolled viewport — bring the bar into view before
  // computing hover/click coordinates (see scrollBarIntoView's docblock).

  // 1. Move the mouse over the bar and verify the rich popover appears.

  const barRect = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!barRect) {
    failures.push("`.task-gantt-bar` disappeared before hover could start");
    return { ok: false, failures, details: details.join(" | ") };
  }
  const { x: barX, y: barY } = centerOf(barRect);

  await hoverOnto(cdp, barX, barY);

  try {
    await cdp.waitForExpression(
      `!!document.querySelector(".task-gantt-rich-popover.is-subtask")`,
      { timeoutMs: 10000, label: "subtask rich popover" }
    );
  } catch (err) {
    failures.push(`popover never appeared on mouseover: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }
  details.push("popover appeared on real mouseover");

  const popoverHeader = await cdp.evaluate(`(() => {
    const title = document.querySelector(".task-gantt-rich-popover .task-gantt-popover-title");
    const chip = document.querySelector(".task-gantt-rich-popover .task-gantt-popover-status-chip");
    return { title: title ? title.textContent : null, chip: chip ? chip.textContent : null };
  })()`);
  checkPopoverHeader(popoverHeader, failures, details);


  // 2. Status dropdown -> real 'change' -> save round-trips to disk, popover closes


  // Mark the open popover before saving. The save re-renders the chart, and
  // a new popover can reopen while the pointer remains over the newly rendered
  // bar. Wait for this specific node to leave the DOM instead of checking
  // that no popover exists at a polling tick.
  const POPOVER_MARKER_ATTR = "data-e2e-original-popover";
  await cdp.evaluate(`(() => {
    const el = document.querySelector(".task-gantt-rich-popover");
    if (el) el.setAttribute(${JSON.stringify(POPOVER_MARKER_ATTR)}, "1");
    return true;
  })()`);

  const STATUS_SELECT_SEL = ".task-gantt-rich-popover .task-gantt-popover-status-select";
  const hasSelect = await cdp.evaluate(`!!document.querySelector(${JSON.stringify(STATUS_SELECT_SEL)})`);
  if (!hasSelect) {
    failures.push(`status select (${STATUS_SELECT_SEL}) not found in the open popover`);
  } else {
    await selectValue(cdp, STATUS_SELECT_SEL, NEW_STATUS);
    details.push(`dispatched change on status select -> ${NEW_STATUS}`);

    try {
      const onDisk = await waitForFrontmatterField(absPath, statusKey, NEW_STATUS, {
        label: "statusLabel after popover Status change",
      });
      details.push(`statusLabel on disk: ${onDisk} (expected ${NEW_STATUS})`);
    } catch (err) {
      failures.push(err.message);
    }

    try {
      await cdp.waitForExpression(
        `!document.querySelector(${JSON.stringify(`.task-gantt-rich-popover[${POPOVER_MARKER_ATTR}]`)})`,
        { timeoutMs: 10000, label: "popover closed after Status save" }
      );
      details.push("popover closed after Status save");
    } catch (err) {
      failures.push(`popover did not close after Status save: ${err.message}`);
    }
  }


  // 3. Double-click the freshly rendered bar title to open the inline editor.

  try {
    await cdp.waitForExpression(
      `document.querySelectorAll(".task-gantt-bar").length === 1`,
      { timeoutMs: 15000, label: "single gantt bar re-rendered after Status save" }
    );
  } catch (err) {
    failures.push(`re-render after Status save never settled: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }

  // savePopoverPatch's render may fully rebuild the chart (resetting
  // scroll position) — re-confirm the bar is still in view before dblclick.
  const barRect2 = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!barRect2) {
    failures.push("`.task-gantt-bar` disappeared before the title dblclick");
    return { ok: false, failures, details: details.join(" | ") };
  }
  const { x: bar2X, y: bar2Y } = centerOf(barRect2);

  await dblclickAt(cdp, bar2X, bar2Y);

  const INLINE_EDITOR_SEL = ".task-gantt-inline-editor";
  let inlineInitialValue;
  try {
    inlineInitialValue = await cdp.waitForExpression(
      `(() => {
        const el = document.querySelector(${JSON.stringify(INLINE_EDITOR_SEL)});
        return el ? el.value : null;
      })()`,
      { timeoutMs: 10000, label: "inline title editor input" }
    );
  } catch (err) {
    failures.push(`inline title editor never appeared after dblclick: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }
  if (inlineInitialValue !== SUBTASK_TITLE) {
    failures.push(
      `inline editor's initial value=${JSON.stringify(inlineInitialValue)}, expected ${JSON.stringify(SUBTASK_TITLE)}`
    );
  } else {
    details.push(`inline editor opened with initial value "${inlineInitialValue}"`);
  }

  await setFieldValue(cdp, INLINE_EDITOR_SEL, NEW_TITLE);
  await keydownOn(cdp, INLINE_EDITOR_SEL, "Enter");
  details.push(`typed "${NEW_TITLE}" + Enter`);

  try {
    const onDisk = await waitForFrontmatterField(absPath, titleKey, NEW_TITLE, {
      label: "subtask title after inline edit",
    });
    details.push(`subtask title on disk: "${onDisk}" (expected "${NEW_TITLE}")`);
  } catch (err) {
    const content = fs.readFileSync(absPath, "utf8");
    failures.push(
      `${err.message}\n    on-disk statusLabel at time of failure: ${readFrontmatterField(content, statusKey)}`
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

/** popover header title + status chip. */
function checkPopoverHeader(header, failures, details) {
  if (!header || header.title === null) {
    failures.push("popover header title (.task-gantt-popover-title) not found");
  } else if (header.title !== SUBTASK_TITLE) {
    failures.push(`popover title="${header.title}", expected "${SUBTASK_TITLE}"`);
  } else {
    details.push(`popover title correct: "${header.title}"`);
  }

  if (!header || header.chip === null) {
    failures.push("popover status chip (.task-gantt-popover-status-chip) not found");
  } else if (header.chip !== EXPECTED_INITIAL_STATUS_CHIP) {
    failures.push(`popover status chip="${header.chip}", expected "${EXPECTED_INITIAL_STATUS_CHIP}"`);
  } else {
    details.push(`popover status chip correct: "${header.chip}"`);
  }
}
