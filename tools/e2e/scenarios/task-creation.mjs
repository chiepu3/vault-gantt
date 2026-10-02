
// tools/e2e/scenarios/task-creation.mjs

// Scenario 1: task creation with real filesystem parent-folder handling.

// Vault state: an EXISTING root tasks/ folder but NO tasks/YYYY/MM subfolder
// yet. This exposes the missing-parent-folder bug: Vault.create does not
// create missing parent folders, and FakeVault (a flat Map) never modeled
// that. With the bug present, the command rejects silently (uncaught
// rejection -> captured console error), no Notice appears, no file is
// written.

// Drives the REAL command through the REAL modal: executeCommandById ->
// type into the modal's text input -> Enter, like a user would.


import fs from "node:fs";
import path from "node:path";

const COMMAND_ID = "vault-gantt:create-new-task-note";
const TASK_NAME = "E2E Smoke Task";
const NOTICE_PREFIX = "タスクを作成しました";

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * @param {{ cdp: import("../obsidian-runtime.mjs").CdpSession, vaultDir: string }} ctx
 * @returns {Promise<{ ok: boolean, failures: string[], details: string }>}
 */
export async function run({ cdp, vaultDir }) {
  const failures = [];
  const details = [];

  // --- Precondition: tasks/ exists, tasks/<year>/ does not --------------
  const tasksRoot = path.join(vaultDir, "tasks");
  if (!fs.existsSync(tasksRoot)) {
    fs.mkdirSync(tasksRoot, { recursive: true });
  }
  const yearNow = String(new Date().getFullYear());
  if (fs.existsSync(path.join(tasksRoot, yearNow))) {
    failures.push(
      `precondition violated: ${path.join(tasksRoot, yearNow)} already exists — ` +
        `the scenario requires a tasks/ root with no year subfolder`
    );
    return { ok: false, failures, details: "" };
  }

  // Command must be registered by the plugin.
  const hasCommand = await cdp.evaluate(
    `!!app.commands.commands[${JSON.stringify(COMMAND_ID)}]`
  );
  if (!hasCommand) {
    failures.push(`command ${COMMAND_ID} not registered — plugin not loaded?`);
    return { ok: false, failures, details: "" };
  }

  cdp.resetCapturedErrors();

  // --- Dispatch the command ---------------------------------------------
  await cdp.evaluate(
    `app.commands.executeCommandById(${JSON.stringify(COMMAND_ID)}), true`
  );
  details.push("command dispatched");

  // --- Wait for the modal text input -------------------------------------
  const INPUT_SEL = ".modal-container .modal input[type='text']";
  try {
    await cdp.waitForExpression(`!!document.querySelector(${JSON.stringify(INPUT_SEL)})`, {
      timeoutMs: 15000,
      label: "create-task modal input",
    });
  } catch (err) {
    failures.push(`modal never appeared: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }

  // --- Type the task name (native setter + input event, like a user) -----
  await cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(INPUT_SEL)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(TASK_NAME)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);


  await cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(INPUT_SEL)});
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
  details.push("typed name + Enter");

  // --- Wait for the success Notice ----------------------------------------
  let noticeText = "";
  try {
    noticeText = await cdp.waitForExpression(
      `(() => {
        const notices = Array.from(document.querySelectorAll(".notice-container .notice"));
        const hit = notices.find((n) => n.textContent.includes(${JSON.stringify(NOTICE_PREFIX)}));
        return hit ? hit.textContent : null;
      })()`,
      { timeoutMs: 20000, label: "success Notice" }
    );
  } catch (err) {
    failures.push(`success Notice never appeared: ${err.message}`);
  }
  if (noticeText) {
    details.push(`notice: "${noticeText}"`);
    if (!noticeText.includes(TASK_NAME)) {
      failures.push(`Notice text does not contain the task name: "${noticeText}"`);
    }
  }

  // --- Assert the file exists at tasks/YYYY/MM/YYYY-MM-DD <name>.md -------
  // Recompute the date after creation so a midnight rollover during the test
  // does not cause a false failure.
  const now = new Date();
  const dateStr = localDateStr(now);
  const expectedPath = path.join(
    vaultDir,
    "tasks",
    dateStr.slice(0, 4),
    dateStr.slice(5, 7),
    `${dateStr} ${TASK_NAME}.md`
  );
  if (fs.existsSync(expectedPath)) {
    details.push(`file exists: tasks/${dateStr.slice(0, 4)}/${dateStr.slice(5, 7)}/${dateStr} ${TASK_NAME}.md`);
  } else {
    const treeDump = dumpTree(path.join(vaultDir, "tasks"), 3);
    failures.push(`expected file missing: ${expectedPath}\n    tasks/ tree:\n${treeDump}`);
  }

  // --- Assert zero console errors / exceptions during the scenario --------
  const errors = cdp.capturedErrors();
  if (errors.length > 0) {
    failures.push(
      `${errors.length} console error(s) during scenario:\n` +
        errors.map((e) => `    [${e.source}] ${e.text}`).join("\n")
    );
  }

  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}

function dumpTree(dir, depth) {
  const lines = [];
  const walk = (d, indent, remaining) => {
    if (remaining < 0 || !fs.existsSync(d)) {
      return;
    }
    for (const entry of fs.readdirSync(d).sort().slice(0, 50)) {
      lines.push(`${indent}${entry}`);
      const full = path.join(d, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full, indent + "  ", remaining - 1);
      }
    }
  };
  walk(dir, "      ", depth);
  return lines.length > 0 ? lines.join("\n") : "      (empty)";
}
