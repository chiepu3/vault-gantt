
// tools/e2e/scenarios/workbench-editing.mjs



// Unlike task-creation.mjs / gantt-render.mjs, the Workbench table is
// currently exercised ONLY via the fake-DOM unit suite
// (tests/ui/task-workbench-view.test.ts). This scenario drives the same
// interactions in a REAL browser against a REAL vault: priority star click,
// the always-live due-date <input type="date">, the dblclick-to-edit tags
// cell, and the dblclick-to-edit currentStatus cell.

// Fixture reuse: gen-fixtures.mjs's generateFixtures (built for the Gantt
// scenarios) produces parent+subtask pairs via the real buildFullNote
// serializer. task-workbench-view.ts's getDisplayRows flattens BOTH
// parents and subtasks into table rows (src/app/workbench-display.ts
// getDisplayRows: "parents + every parent's subtasks Map values"), so these
// fixtures work as-is for the Workbench — no new fixture generator needed.
// Each edit in this scenario targets the first PARENT row.

// Sequencing: each step re-queries the target row after the previous save has
// replaced the table, then verifies the real file on disk before the next edit.
// This serializes interactions because the UI has no interaction lock.


// The scenario covers a dueDate change event, tag parsing that preserves empty
// elements, and currentStatus editing with a blur-to-save textarea.


import fs from "node:fs";
import path from "node:path";

const COMMAND_ID = "vault-gantt:open-task-workbench";
const TARGET_NAME = "E2E Fixture Task 0001";
const DUE_DATE_VALUE = "2027-03-15";
const TAGS_INPUT_VALUE = "foo, , bar";
// parseTagsInput splits on commas and trims each element:
// "foo,, bar" becomes ["foo", "", "bar"]. buildFrontmatter serializes tags
// with tags.join(","), so the empty element is preserved as "foo,,bar".
// applyPatchToParent previously ran the clean array through ensureArray,
// which dropped the empty string. This scenario verifies that the full edit
// now round-trips the empty element to the saved file.
const EXPECTED_TAGS_LINE = "tags: foo,,bar";
const CURRENT_STATUS_VALUE = "E2E workbench inline status edit";

const SETTLE_MS = 800;
const DISK_POLL_TIMEOUT_MS = 15000;
const DISK_POLL_INTERVAL_MS = 250;

/**
 * @param {{ cdp: import("../obsidian-runtime.mjs").CdpSession, vaultDir: string }} ctx
 * @returns {Promise<{ ok: boolean, failures: string[], details: string }>}
 */
export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];

  const hasCommand = await cdp.evaluate(
    `!!app.commands.commands[${JSON.stringify(COMMAND_ID)}]`
  );
  if (!hasCommand) {
    failures.push(`command ${COMMAND_ID} not registered — plugin not loaded?`);
    return { ok: false, failures, details: "" };
  }

  cdp.resetCapturedErrors();

  // --- Open the Workbench view --------------------------------------------
  await cdp.evaluate(`app.commands.executeCommandById(${JSON.stringify(COMMAND_ID)}), true`);
  details.push("command dispatched");

  try {
    await cdp.waitForExpression(
      `!!document.querySelector(".task-workbench-table")`,
      { timeoutMs: 20000, label: "workbench table" }
    );
  } catch (err) {
    failures.push(`workbench table never appeared: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }

  try {
    await cdp.waitForExpression(
      `${rowFinderExpr(TARGET_NAME)} !== null`,
      { timeoutMs: 15000, label: `row for "${TARGET_NAME}"` }
    );
  } catch (err) {
    failures.push(`target row never appeared: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }
  details.push(`target row "${TARGET_NAME}" present`);

  // --- Resolve the target file on disk ------------------------------------
  const filePath = findFixtureFilePath(vaultDir, TARGET_NAME);
  if (!filePath) {
    failures.push(
      `could not locate fixture file for "${TARGET_NAME}" under ${path.join(vaultDir, "tasks")}`
    );
    return { ok: false, failures, details: details.join(" | ") };
  }
  details.push(`target file: ${path.relative(vaultDir, filePath)}`);


  // 1. Click a priority star.

  const STAR_POSITION = 4;
  await cdp.evaluate(`(() => {
    const row = ${rowFinderExpr(TARGET_NAME)};
    const stars = Array.from(row.querySelectorAll(".task-workbench-priority-cell .task-workbench-priority-star"));
    if (stars.length !== 5) {
      throw new Error("expected 5 priority stars, found " + stars.length);
    }
    stars[${STAR_POSITION - 1}].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);

  const afterStar = await waitForFileContains(
    filePath,
    "priorityMode: manual",
    "priority star click settled on disk (priorityMode: manual)"
  );
  await sleep(SETTLE_MS); // extra settle margin before the next interaction
  checkFileContains(afterStar, `priority: ${STAR_POSITION}`, "priority star click: priority value", failures, details);
  checkFileContains(afterStar, "priorityMode: manual", "priority star click: priorityMode flips to manual", failures, details);


  // 2. Change dueDate; the input saves on change, not blur.

  await cdp.evaluate(`(() => {
    const row = ${rowFinderExpr(TARGET_NAME)};
    if (!row) { throw new Error("target row missing before dueDate edit"); }
    const input = row.querySelector(".date-col input[type='date']");
    if (!input) { throw new Error("due date input not found"); }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(DUE_DATE_VALUE)});
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value;
  })()`);

  const afterDue = await waitForFileContains(
    filePath,
    `dueDate: ${DUE_DATE_VALUE}`,
    "dueDate change settled on disk"
  );
  await sleep(SETTLE_MS); // extra settle margin before the next interaction
  checkFileContains(afterDue, `dueDate: ${DUE_DATE_VALUE}`, "dueDate change: YYYY-MM-DD round-trip", failures, details);
  // Updating dueDate must preserve the saved priority.
  checkFileContains(afterDue, `priority: ${STAR_POSITION}`, "dueDate change: prior priority edit still intact", failures, details);


  // 3. Edit tags by double-clicking, typing commas and spaces, then blurring.
  // The empty tag element must survive.

  await cdp.evaluate(`(() => {
    const row = ${rowFinderExpr(TARGET_NAME)};
    if (!row) { throw new Error("target row missing before tags edit"); }
    // Column 8 (1-indexed): name, priority, status, currentStatus, createdAt,
    // updatedAt, dueDate, tags (src/ui/task-workbench-view.ts buildRow order).
    const tagsTd = row.querySelector("td:nth-child(8)");
    if (!tagsTd) { throw new Error("tags cell (col 8) not found"); }
    tagsTd.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);

  try {
    await cdp.waitForExpression(
      `(() => {
        const row = ${rowFinderExpr(TARGET_NAME)};
        if (!row) return false;
        const el = row.querySelector("td:nth-child(8) input.task-workbench-inline-input");
        return !!el;
      })()`,
      { timeoutMs: 5000, label: "tags editor input" }
    );
  } catch (err) {
    failures.push(`tags editor never appeared after dblclick: ${err.message}`);
  }

  await cdp.evaluate(`(() => {
    const row = ${rowFinderExpr(TARGET_NAME)};
    const input = row.querySelector("td:nth-child(8) input.task-workbench-inline-input");
    if (!input) { throw new Error("tags editor input not found"); }
    // REAL-BROWSER GOTCHA (found by this scenario): buildTagsEditor() calls
    // input.focus() while the input is still a detached node (it is
    // constructed and focus()'d BEFORE renderTable() appends the rebuilt
    // <table> into the live tableWrapEl — see task-workbench-view.ts
    // renderTable()/buildRow()). A real browser's focus() is a no-op on a
    // disconnected element (unlike some fake-DOM test doubles), so by the
    // time the editor is actually in the document it is NOT the
    // document.activeElement. Re-focus explicitly now that it is connected
    // — this is what a real user's click into the field accomplishes —
    // otherwise the subsequent .blur() call below has nothing to blur FROM
    // and its 'blur' listener (the save trigger) never fires.
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(TAGS_INPUT_VALUE)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    return true;
  })()`);

  const afterTags = await waitForFileContains(
    filePath,
    EXPECTED_TAGS_LINE,
    "tags edit settled on disk"
  );
  await sleep(SETTLE_MS); // extra settle margin before the next interaction
  checkFileContains(
    afterTags,
    EXPECTED_TAGS_LINE,
    `tags edit preserves the empty element (input "${TAGS_INPUT_VALUE}" -> "${EXPECTED_TAGS_LINE}").`,
    failures,
    details
  );
  checkFileContains(afterTags, `dueDate: ${DUE_DATE_VALUE}`, "tags edit: prior dueDate edit still intact", failures, details);


  // 4. Edit currentStatus by double-clicking, typing, and blurring to save.

  await cdp.evaluate(`(() => {
    const row = ${rowFinderExpr(TARGET_NAME)};
    if (!row) { throw new Error("target row missing before currentStatus edit"); }
    const textEl = row.querySelector(".task-workbench-col-status .task-workbench-cell-text");
    if (!textEl) { throw new Error("currentStatus display text not found"); }
    textEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);

  try {
    await cdp.waitForExpression(
      `(() => {
        const row = ${rowFinderExpr(TARGET_NAME)};
        if (!row) return false;
        const el = row.querySelector(".task-workbench-col-status textarea.task-workbench-inline-textarea");
        return !!el;
      })()`,
      { timeoutMs: 5000, label: "currentStatus editor textarea" }
    );
  } catch (err) {
    failures.push(`currentStatus editor never appeared after dblclick: ${err.message}`);
  }

  await cdp.evaluate(`(() => {
    const row = ${rowFinderExpr(TARGET_NAME)};
    const area = row.querySelector(".task-workbench-col-status textarea.task-workbench-inline-textarea");
    if (!area) { throw new Error("currentStatus editor textarea not found"); }
    // Same real-browser focus() gotcha as the tags editor above (buildCurrentStatusEditor
    // calls area.focus() while still detached) — re-focus now that it's live so blur()
    // below actually has something to blur from.
    area.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, ${JSON.stringify(CURRENT_STATUS_VALUE)});
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.blur();
    return true;
  })()`);

  const afterStatus = await waitForFileContains(
    filePath,
    CURRENT_STATUS_VALUE,
    "currentStatus edit settled on disk"
  );
  await sleep(SETTLE_MS); // extra settle margin
  checkFileContains(afterStatus, CURRENT_STATUS_VALUE, "currentStatus edit: blur commits value", failures, details);
  checkFileContains(afterStatus, EXPECTED_TAGS_LINE, "currentStatus edit: prior tags edit still intact", failures, details);


  // 5. Zero console errors / uncaught exceptions throughout

  const errors = cdp.capturedErrors();
  if (errors.length > 0) {
    failures.push(
      `${errors.length} console error(s) during scenario:\n` +
        errors.map((e) => `    [${e.source}] ${e.text}`).join("\n")
    );
  }

  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}

/**
 * Browser-side expression: finds the first PARENT row (not.is-subtask)
 * whose text content includes `name`, or null. Inlined into every
 * cdp.evaluate call site above so each step re-queries fresh DOM after the
 * each edit triggers a full render that rebuilds the table.
 */
function rowFinderExpr(name) {
  return `(() => {
    const rows = Array.from(document.querySelectorAll(".task-workbench-row"));
    return rows.find((r) => !r.classList.contains("is-subtask") && r.textContent.includes(${JSON.stringify(name)})) ?? null;
  })()`;
}

/** Locates the fixture's parent.md file under vaultDir/tasks/ by name. */
function findFixtureFilePath(vaultDir, name) {
  const tasksRoot = path.join(vaultDir, "tasks");
  if (!fs.existsSync(tasksRoot)) {
    return null;
  }
  const stack = [tasksRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith(".md") && entry.includes(name)) {
        return full;
      }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the REAL file on disk until its content contains `substring` (the
 * marker of the just-committed edit) or times out. This is the mechanism
 * that guarantees one interaction's save has FULLY settled before the next
 * interaction starts — a fixed sleep alone cannot prove a write landed, only
 * make it likely. On timeout, returns the last-read content anyway (rather
 * than throwing) so the caller's checkFileContains failure message can
 * show the actual on-disk state for debugging.
 */
async function waitForFileContains(filePath, substring, label) {
  const deadline = Date.now() + DISK_POLL_TIMEOUT_MS;
  let lastContent = "";
  for (;;) {
    try {
      lastContent = fs.readFileSync(filePath, "utf8");
      if (lastContent.includes(substring)) {
        return lastContent;
      }
    } catch {
      // file momentarily unreadable mid-write; keep polling
    }
    if (Date.now() > deadline) {
      console.error(`[workbench-editing] timed out waiting for ${label} (looking for ${JSON.stringify(substring)})`);
      return lastContent;
    }
    await sleep(DISK_POLL_INTERVAL_MS);
  }
}

function checkFileContains(content, substring, label, failures, details) {
  if (content.includes(substring)) {
    details.push(`OK ${label}`);
  } else {
    failures.push(
      `${label}: expected file to contain ${JSON.stringify(substring)} but it did not.\n` +
        `    --- file content ---\n${content
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`
    );
  }
}
