
// tools/e2e/run-smoke.mjs

// E2E smoke entry point (npm run test:e2e). For each scenario:
// 1. create a fresh throwaway vault under tools/e2e/tmp/
// 2. install the built plugin into it (main.js / manifest.json / styles.css)
// 3. seed scenario-specific fixtures (gen-fixtures.mjs) where needed
// 4. launch a real headless Obsidian against that vault (obsidian-runtime)
// 5. run the scenario's numeric assertions over CDP
// 6. on failure: save a screenshot to tools/e2e/artifacts/<scenario>-failure.png

// Exits non-zero if any scenario fails. Requires Node >= 22.


import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertNode22, generateFixtures } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";
import * as taskCreation from "./scenarios/task-creation.mjs";
import * as ganttRender from "./scenarios/gantt-render.mjs";
import * as dragBarMove from "./scenarios/drag-bar-move.mjs";
import * as dragResize from "./scenarios/drag-resize.mjs";
import * as popoverAndInlineEdit from "./scenarios/popover-and-inline-edit.mjs";
import * as workbenchEditing from "./scenarios/workbench-editing.mjs";
import * as weeklyScheduleAndEventWorkload from "./scenarios/weekly-schedule-and-event-workload.mjs";
import * as workloadPopupLayout from "./scenarios/workload-popup-layout.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "tools", "e2e", "tmp");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "tools", "e2e", "artifacts");
const PLUGIN_ID = "vault-gantt";

async function main() {
  assertNode22();

  ensureBuildArtifacts();

  const scenarios = [
    {
      name: "task-creation",
      prepare: async (vaultDir) => {
        // The task-creation trigger: a tasks/ root folder exists, but the
        // tasks/YYYY/MM subfolders do not yet.
        fs.mkdirSync(path.join(vaultDir, "tasks"), { recursive: true });
      },
      run: ({ cdp, vaultDir }) => taskCreation.run({ cdp, vaultDir }),
    },
    {
      name: "gantt-render-20",
      prepare: (vaultDir) => generateFixtures({ vaultDir, count: 20 }),
      run: ({ cdp }) => ganttRender.run({ cdp, count: 20 }),
    },
    {
      name: "gantt-render-300",
      // 300 tasks exercise row sizing across a wide scrollable timeline.
      prepare: (vaultDir) => generateFixtures({ vaultDir, count: 300 }),
      run: ({ cdp }) => ganttRender.run({ cdp, count: 300 }),
    },
    {
      name: "workbench-editing",

      // fake-DOM unit suite (tests/ui/task-workbench-view.test.ts) — this is
      // its only real-browser coverage. A small fixture count keeps the
      // target-row lookup by name unambiguous.
      prepare: (vaultDir) => generateFixtures({ vaultDir, count: 3 }),
      run: ({ cdp, vaultDir }) => workbenchEditing.run({ cdp, vaultDir }),
    },
    {
      name: "drag-bar-move",

      // fixture inline (drag-fixture.mjs) rather than gen-fixtures.mjs's
      // bulk N-task generator — no prepare fixture step needed here.
      prepare: async () => {},
      run: ({ cdp, vaultDir }) => dragBarMove.run({ cdp, vaultDir }),
    },
    {
      name: "drag-resize",

      prepare: async () => {},
      run: ({ cdp, vaultDir }) => dragResize.run({ cdp, vaultDir }),
    },
    {
      name: "popover-and-inline-edit",

      prepare: async () => {},
      run: ({ cdp, vaultDir }) => popoverAndInlineEdit.run({ cdp, vaultDir }),
    },
    {
      name: "weekly-schedule-and-event-workload",

      prepare: (vaultDir) => weeklyScheduleAndEventWorkload.prepare(vaultDir),
      run: ({ cdp, vaultDir }) => weeklyScheduleAndEventWorkload.run({ cdp, vaultDir }),
    },
    {
      name: "workload-popup-layout",

      prepare: (vaultDir) => workloadPopupLayout.prepare(vaultDir),
      run: ({ cdp, vaultDir }) => workloadPopupLayout.run({ cdp, vaultDir }),
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  printSummary(results);

  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

/** Verifies (or produces) main.js / manifest.json / styles.css. */
function ensureBuildArtifacts() {
  const required = ["main.js", "manifest.json", "styles.css"];
  const missing = required.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  if (missing.length === 0) {
    console.log("[smoke] build artifacts present (main.js, manifest.json, styles.css)");
    return;
  }
  console.log(`[smoke] missing build artifacts (${missing.join(", ")}) — running production build`);
  const result = spawnSync(process.execPath, ["esbuild.config.mjs", "production"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("production build failed");
  }
  for (const f of required) {
    if (!fs.existsSync(path.join(REPO_ROOT, f))) {
      throw new Error(`build finished but ${f} still missing`);
    }
  }
}

/** Copies the built plugin into a vault's.obsidian/plugins/<id>/. */
function installPlugin(vaultDir) {
  const pluginDir = path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(pluginDir, f));
  }
  // Per-vault enabled list. NOTE: not sufficient on its own — a fresh
  // profile's global community-plugins toggle is OFF; enablePlugin flips
  // it over CDP after launch.
  fs.writeFileSync(
    path.join(vaultDir, ".obsidian", "community-plugins.json"),
    JSON.stringify([PLUGIN_ID], null, 2)
  );
  fs.writeFileSync(
    path.join(pluginDir, "data.json"),
    `${JSON.stringify(
      {
        ganttNationalHolidays: ["2000-01-01"],
        ganttNationalHolidaysUpdatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

async function runScenario(scenario) {
  const started = Date.now();
  console.log(`\n[smoke] === scenario: ${scenario.name} ===`);

  const scenarioTmp = path.join(TMP_ROOT, `${scenario.name}-${process.pid}-${Date.now()}`);
  const vaultDir = path.join(scenarioTmp, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });

  let runtime = null;
  try {
    installPlugin(vaultDir);
    await scenario.prepare(vaultDir);

    runtime = await startObsidian({ vaultDir });
    console.log(
      `[smoke] obsidian up (cdp :${runtime.cdpPort}, display ${runtime.display}, log ${runtime.logFile})`
    );

    // Obsidian must have scanned.obsidian/plugins/ before loadPlugin can
    // resolve the manifest; on a fresh profile that scan happens during
    // vault load, which is async after CDP comes up.
    await runtime.cdp.waitForExpression(
      `!!app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}]`,
      { timeoutMs: 60000, intervalMs: 500, label: "plugin manifest scanned by Obsidian" }
    );
    await enablePlugin(runtime.cdp, PLUGIN_ID);
    console.log(`[smoke] plugin "${PLUGIN_ID}" loaded`);

    const result = await scenario.run({ cdp: runtime.cdp, vaultDir });

    if (result.details) {
      console.log(`[smoke] ${scenario.name}: ${result.details}`);
    }
    if (!result.ok) {
      for (const failure of result.failures) {
        console.error(`[smoke] ${scenario.name} FAILURE:\n${failure}`);
      }
      const shotPath = path.join(ARTIFACTS_DIR, `${scenario.name}-failure.png`);
      try {
        await runtime.cdp.screenshot(shotPath);
        console.error(`[smoke] failure screenshot saved: ${shotPath}`);
      } catch (err) {
        console.error(`[smoke] screenshot failed: ${err.message}`);
      }
    }

    return {
      name: scenario.name,
      ok: result.ok,
      failures: result.failures,
      seconds: (Date.now() - started) / 1000,
      vaultDir,
      logFile: runtime.logFile,
      cleanupDir: scenarioTmp,
    };
  } catch (err) {
    console.error(`[smoke] ${scenario.name} CRASHED: ${err.message}`);
    if (runtime) {
      try {
        const shotPath = path.join(ARTIFACTS_DIR, `${scenario.name}-failure.png`);
        await runtime.cdp.screenshot(shotPath);
        console.error(`[smoke] failure screenshot saved: ${shotPath}`);
      } catch {
        // screenshot best-effort
      }
    }
    return {
      name: scenario.name,
      ok: false,
      failures: [err.message],
      seconds: (Date.now() - started) / 1000,
      vaultDir,
      logFile: runtime ? runtime.logFile : null,
      cleanupDir: scenarioTmp,
    };
  } finally {
    if (runtime) {
      runtime.kill();
      // Give the killed process group a moment to release the vault's files
      // before a later cleanup removes them.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function printSummary(results) {
  console.log("\n=====================================================");
  console.log(" E2E smoke results");
  console.log("-----------------------------------------------------");
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    console.log(` ${status}  ${r.name.padEnd(24)} (${r.seconds.toFixed(1)}s)`);
    if (!r.ok) {
      for (const failure of r.failures) {
        for (const line of failure.split("\n")) {
          console.log(`       ${line}`);
        }
      }
      console.log(`       vault: ${r.vaultDir}`);
      if (r.logFile) {
        console.log(`       obsidian log: ${r.logFile}`);
      }
    }
  }
  const passed = results.filter((r) => r.ok).length;
  console.log("=====================================================");
  console.log(` ${passed}/${results.length} scenarios passed`);

  // Clean up throwaway vaults of PASSED scenarios; keep failures on disk
  // for post-mortem (paths printed above).
  for (const r of results) {
    if (r.ok) {
      try {
        fs.rmSync(r.cleanupDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

main().catch((err) => {
  console.error(`[smoke] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
