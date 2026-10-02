import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateFixtures } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";

const repoRoot = process.cwd();
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-gantt-log-recording-"));
const vaultDir = path.join(runRoot, "vault");
fs.mkdirSync(vaultDir, { recursive: true });
const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(pluginDir, file));
}
fs.writeFileSync(
  path.join(vaultDir, ".obsidian", "community-plugins.json"),
  JSON.stringify(["vault-gantt"])
);

await generateFixtures({ vaultDir, count: 2 });

const runtime = await startObsidian({
  vaultDir,
  obsidianBin: process.env.E2E_OBSIDIAN_BINARY ?? path.join(os.homedir(), "tools", "obsidian-headless", "squashfs-root", "obsidian"),
});
try {
  await runtime.cdp.waitForExpression("!!app.plugins.manifests['vault-gantt']", {
    timeoutMs: 60000,
    label: "vault-gantt manifest",
  });
  await enablePlugin(runtime.cdp, "vault-gantt");
  let commandDiag;
  for (let attempt = 0; attempt < 10; attempt++) {
    commandDiag = await runtime.cdp.evaluate(`(async () => ({
      hasPlugin: !!app.plugins.plugins['vault-gantt'],
      hasLogger: (() => {
        const p = app.plugins.plugins['vault-gantt'];
        return !!(p && p.logger);
      })(),
      commandsType: typeof app.commands.commands,
      vgCommandKeys:
        typeof app.commands.commands === 'object' && app.commands.commands
          ? Object.keys(app.commands.commands).filter((k) => k.startsWith('vault-gantt'))
          : null,
      startFoundViaExec: (() => {
        try {
          return typeof app.commands.executeCommandById;
        } catch (e) {
          return String(e);
        }
      })(),
      allCommandCount: app.commands.commands
        ? Object.keys(app.commands.commands).length
        : -1,
    }))()`);
    const startCommandFound = commandDiag.vgCommandKeys?.includes(
      "vault-gantt:start-log-recording"
    );
    if (attempt % 3 === 0 || startCommandFound || attempt === 9) {
      console.log("CMD_DIAG", JSON.stringify(commandDiag));
    }
    if (startCommandFound) break;
    if (attempt < 9) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  if (
    !commandDiag.vgCommandKeys?.includes("vault-gantt:start-log-recording")
  ) {
    const fallbackCommands = await runtime.cdp.evaluate(
      "app.commands.listCommands ? app.commands.listCommands().map(c => c.id).filter(id => id.startsWith('vault-gantt')) : 'no listCommands'"
    );
    console.log("CMD_DIAG_FALLBACK", JSON.stringify(fallbackCommands));
  }
  const startResult = await runtime.cdp.evaluate(
    "(async () => await app.commands.executeCommandById('vault-gantt:start-log-recording'))()"
  );
  console.log("START_RESULT", startResult);
  await new Promise((resolve) => setTimeout(resolve, 200));

  await runtime.cdp.evaluate(
    "app.commands.executeCommandById('vault-gantt:open-task-gantt'), true"
  );
  await runtime.cdp.waitForExpression(
    "!!document.querySelector('.task-gantt-container')",
    {
      timeoutMs: 60000,
      label: "task gantt container",
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 500));

  await runtime.cdp.evaluate(
    "(async () => { await app.commands.executeCommandById('vault-gantt:stop-log-recording'); return true; })()"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));

  const logDir = path.join(vaultDir, "_vault-gantt-logs");
  const recordingFiles = fs
    .readdirSync(logDir)
    .filter((file) => /^recording_.+\.log$/.test(file));
  if (recordingFiles.length !== 1) {
    throw new Error(
      `expected exactly one recording_*.log file, found ${recordingFiles.length}`
    );
  }

  const logFile = path.join(logDir, recordingFiles[0]);
  const content = fs.readFileSync(logFile, "utf8");
  const lines = content === "" ? [] : content.split(/\r?\n/);
  const entries = lines.map((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`log line ${index + 1} is not valid JSON`, { cause: error });
    }

    if (typeof entry.data === "string") {
      try {
        entry.data = JSON.parse(entry.data);
      } catch {
        //Keep non-JSON diagnostic data in its serialized form.
      }
    }
    return entry;
  });

  if (entries.length < 5) {
    throw new Error(`expected at least 5 log entries, found ${entries.length}`);
  }

  const levelCounts = Object.groupBy(entries, (entry) => entry.level);
  for (const level of ["info", "debug"]) {
    if (!levelCounts[level]?.length) {
      throw new Error(`expected at least one ${level} log entry`);
    }
  }

  const renderCompleted = entries.find(
    (entry) =>
      entry.scope === "TaskGanttView" &&
      entry.message === "render completed" &&
      typeof entry.data?.durationMs === "number"
  );
  if (!renderCompleted) {
    throw new Error(
      "expected a TaskGanttView render completed entry with numeric data.durationMs"
    );
  }

  const viewOpened = entries.find(
    (entry) =>
      entry.scope === "TaskGanttView" && entry.message === "view opened"
  );
  if (!viewOpened) {
    throw new Error("expected a TaskGanttView view opened entry");
  }

  console.log("RECORDING_FILE_COUNT", recordingFiles.length);
  console.log("LOG_ENTRY_COUNT", entries.length);
  console.log(
    "LOG_LEVEL_COUNTS",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(levelCounts).map(([level, levelEntries]) => [
          level,
          levelEntries.length,
        ])
      )
    )
  );
  console.log("SAMPLE_ENTRIES", JSON.stringify(entries.slice(0, 3), null, 2));
} finally {
  console.log("CAPTURED_ERRORS", JSON.stringify(runtime.cdp.capturedErrors()));
  runtime.kill();
}
