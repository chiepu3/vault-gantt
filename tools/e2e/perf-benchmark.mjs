
// tools/e2e/perf-benchmark.mjs

// Performance baseline harness for the real Obsidian Gantt and Workbench views.
// It creates a throwaway vault with the same fixture generator used by the E2E
// smoke tests, launches real headless Obsidian, and measures DOM-settled action
// times over CDP. Production rendering code is deliberately not instrumented or
// changed by this benchmark.

// Usage:
// node tools/e2e/perf-benchmark.mjs
// node tools/e2e/perf-benchmark.mjs --parents 500 --subtasks-per-parent 1
// node tools/e2e/perf-benchmark.mjs --parents 50 --subtasks-per-parent 10

// Output:
// tools/e2e/artifacts/perf-benchmark-<parents>x<subtasks>-<render-mode>-<timestamp>.json


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertNode22, generateFixtures } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";
import {
  centerOf,
  dismissTrustDialogIfPresent,
  hoverOnto,
  moveMouse,
  scrollBarIntoView,
  selectValue,
  setFieldValue,
  sleep,
} from "./scenarios/cdp-input.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "tools", "e2e", "tmp");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "tools", "e2e", "artifacts");
const PLUGIN_ID = "vault-gantt";
const GANTT_COMMAND_ID = "vault-gantt:open-task-gantt";
const WORKBENCH_COMMAND_ID = "vault-gantt:open-task-workbench";
const WARM_SAMPLES = 5;
const QUIET_MS = 80;
const ACTION_TIMEOUT_MS = 60000;
const GANTT_ROOT_SELECTOR = ".task-gantt-container";
// The table node itself is replaced by every Workbench render, so observe its
// stable view container rather than a stale table node.
const WORKBENCH_ROOT_SELECTOR = ".task-workbench-container";
// Keep the next measured keystroke outside the Workbench's 200ms debounce
// window; this wait is setup time and is not included in the metric.
const WORKBENCH_FILTER_SETTLE_MS = 220;

function parsePositiveInteger(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return fallback;
  }
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseOptionalBoolean(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${flag} must be true or false`);
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: node tools/e2e/perf-benchmark.mjs " +
        "[--parents <n>] [--subtasks-per-parent <n>] " +
        "[--incremental true|false]"
    );
    process.exit(0);
  }
  return {
    parents: parsePositiveInteger(args, "--parents", 5),
    subtasksPerParent: parsePositiveInteger(args, "--subtasks-per-parent", 100),
    incrementalGanttRender: parseOptionalBoolean(args, "--incremental"),
  };
}

function installPlugin(vaultDir, incrementalGanttRender) {
  const pluginDir = path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(pluginDir, file));
  }
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
        ...(incrementalGanttRender !== undefined ? { incrementalGanttRender } : {}),
      },
      null,
      2
    )}\n`
  );
}

function assertBuildArtifacts() {
  const required = ["main.js", "manifest.json", "styles.css"];
  const missing = required.filter((file) => !fs.existsSync(path.join(REPO_ROOT, file)));
  if (missing.length > 0) {
    throw new Error(
      `missing build artifacts: ${missing.join(", ")}; run npm run build before the benchmark`
    );
  }
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Uses the median after dropping the fastest warm sample when five samples are
 * available. A one-off fast sample is the characteristic false-early failure
 * mode this harness is designed to avoid; retaining the raw samples in JSON
 * still makes the unfiltered distribution available for later analysis.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const robust = sorted.length >= WARM_SAMPLES ? sorted.slice(1) : sorted;
  const middle = Math.floor(robust.length / 2);
  return robust.length % 2 === 0
    ? (robust[middle - 1] + robust[middle]) / 2
    : robust[middle];
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function makeMetric(name) {
  return {
    name,
    coldSamples: [],
    warmSamples: [],
    medianMs: null,
    p95Ms: null,
    medianPolicy: "drop-fastest-warm-sample-when-n=5",
  };
}

function addColdSample(metric, sample) {
  metric.coldSamples.push(sample);
}

function addWarmSample(metric, sample) {
  metric.warmSamples.push(sample);
  const values = metric.warmSamples.map((entry) => entry.durationMs);
  metric.medianMs = median(values);
  metric.p95Ms = p95(values);
}

function sampleValues(metric) {
  return metric.warmSamples.map((entry) => entry.durationMs);
}

function printMetricRow(view, metric) {
  const cold = metric.coldSamples[0]?.durationMs;
  const warm = sampleValues(metric);
  const medianText = metric.medianMs === null ? "-" : metric.medianMs.toFixed(2);
  const p95Text = metric.p95Ms === null ? "-" : metric.p95Ms.toFixed(2);
  console.log(
    `${view.padEnd(10)} ${metric.name.padEnd(30)} ` +
      `${cold === undefined ? "-" : cold.toFixed(2).padStart(10)} ` +
      `${medianText.padStart(10)} ${p95Text.padStart(10)} ` +
      `${warm.length === 0 ? "-" : warm.map((value) => value.toFixed(2)).join(",")}`
  );
}

async function installMutationTracker(cdp) {
  await cdp.evaluate(`(() => {
    window.__vaultGanttPerf?.observer?.disconnect();
    const state = {
      mutationCount: 0,
      lastMutationAt: performance.now(),
      observer: new MutationObserver(() => {
        state.mutationCount += 1;
        state.lastMutationAt = performance.now();
      }),
      renderGenerations: { gantt: 0, workbench: 0 },
      rootSelector: null,
    };
    window.__vaultGanttPerf = state;
    return true;
  })()`);
}

/**
 * Installs a benchmark-only render-generation hook on the already-open view.
 * The production plugin is not changed; the hook supplies a state-transition
 * fingerprint for actions whose final DOM shape is intentionally unchanged.
 */
async function installRenderHooks(cdp, { viewType, key, methods }) {
  await cdp.waitForExpression(
    `(() => {
      const leaves = app.workspace.getLeavesOfType(${JSON.stringify(viewType)});
      return !!(leaves.length && leaves[0].view);
    })()`,
    { timeoutMs: 15000, label: `${viewType} view for benchmark hook` }
  );
  await cdp.evaluate(`(() => {
    const leaves = app.workspace.getLeavesOfType(${JSON.stringify(viewType)});
    const view = leaves[0]?.view;
    const state = window.__vaultGanttPerf;
    if (!view || !state) throw new Error("benchmark render hook target is missing");
    for (const method of ${JSON.stringify(methods)}) {
      const marker = "__vaultGanttPerfHook_" + method;
      if (view[marker]) continue;
      const original = view[method];
      if (typeof original !== "function") {
        throw new Error("benchmark render hook method is missing: " + method);
      }
      view[method] = function(...args) {
        state.renderGenerations[${JSON.stringify(key)}] += 1;
        return original.apply(this, args);
      };
      view[marker] = true;
    }
    return true;
  })()`);
}

async function beginMeasurement(
  cdp,
  { rootSelector = null, fingerprintExpression = null } = {}
) {
  const rootSelectorLiteral = JSON.stringify(rootSelector);
  const fingerprint = fingerprintExpression ?? "null";
  return cdp.evaluate(`(() => {
    const state = window.__vaultGanttPerf;
    if (!state) throw new Error("performance mutation tracker is not installed");
    state.observer.disconnect();
    // Each action starts with a fresh scoped observation window. A global
    // monotonic counter made warm actions vulnerable to unrelated trailing DOM
    // churn from earlier actions.
    state.mutationCount = 0;
    const startedAt = performance.now();
    state.lastMutationAt = startedAt;
    state.rootSelector = ${rootSelectorLiteral};
    const root = state.rootSelector ? document.querySelector(state.rootSelector) : null;
    if (root) {
      state.observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    return {
      startedAt,
      fingerprint: String(${fingerprint}),
      hasRoot: !!root,
    };
  })()`);
}

async function measureAction(
  cdp,
  {
    label,
    action,
    readyExpression,
    rootSelector = null,
    fingerprintExpression = null,
    requireMutation = true,
    timeoutMs = ACTION_TIMEOUT_MS,
  }
) {
  const marker = await beginMeasurement(cdp, { rootSelector, fingerprintExpression });
  if (requireMutation && !marker.hasRoot) {
    throw new Error(`${label}: scoped mutation root not found: ${rootSelector}`);
  }
  const transitionExpression = fingerprintExpression === null
    ? "true"
    : `String(${fingerprintExpression}) !== ${JSON.stringify(marker.fingerprint)}`;
  await action();
  await cdp.waitForExpression(
    `(() => {
      const state = window.__vaultGanttPerf;
      return !!state &&
        (${requireMutation ? "state.mutationCount > 0" : "true"}) &&
        (${readyExpression}) &&
        (${transitionExpression}) &&
        performance.now() - state.lastMutationAt >= ${QUIET_MS};
    })()`,
    { timeoutMs, intervalMs: 25, label: `${label} settled` }
  );
  const durationMs = await cdp.evaluate(
    `performance.now() - ${JSON.stringify(marker.startedAt)}`
  );
  return { durationMs: Number(durationMs) };
}

async function waitForIndexedFixtures(cdp, fixturePaths) {
  await cdp.waitForExpression(
    `(() => {
      const paths = ${JSON.stringify(fixturePaths)};
      return paths.every((fixturePath) => {
        const file = app.vault.getAbstractFileByPath(fixturePath);
        const cache = file ? app.metadataCache.getFileCache(file) : null;
        return !!(cache && cache.frontmatter && cache.frontmatter.type === "task");
      });
    })()`,
    { timeoutMs: 60000, intervalMs: 250, label: "benchmark fixtures indexed" }
  );
}

function ganttReadyExpression(expectedParents, expectedBars) {
  return `document.querySelectorAll(".task-gantt-container").length === 1 &&
    document.querySelectorAll(".task-gantt-parent-row").length === ${expectedParents} &&
    document.querySelectorAll(".task-gantt-bar").length === ${expectedBars}`;
}

function workbenchReadyExpression(expectedParents) {
  return `document.querySelectorAll(".task-workbench-table").length === 1 &&
    document.querySelectorAll(".task-workbench-row").length >= ${expectedParents}`;
}

async function openGantt(cdp, expectedParents, expectedBars, metrics) {
  const readyExpression = ganttReadyExpression(expectedParents, expectedBars);
  const coldInitialRender = makeMetric("cold initial render");
  addColdSample(
    coldInitialRender,
    await measureAction(cdp, {
      label: "Gantt cold initial render",
      action: () =>
        cdp.evaluate(
          `app.commands.executeCommandById(${JSON.stringify(GANTT_COMMAND_ID)}), true`
        ),
      readyExpression,
      requireMutation: false,
    })
  );
  metrics.gantt.coldInitialRender = coldInitialRender;
  // Coordinate-based hover for the task-edit measurement must happen after
  // Obsidian's fresh-vault trust overlay is dismissed. Programmatic toolbar
  // clicks work behind the overlay, but trusted pointer input does not.
  await dismissTrustDialogIfPresent(cdp);
  await sleep(250);
  await installRenderHooks(cdp, {
    viewType: "task-gantt-view",
    key: "gantt",
    methods: ["render", "renderChart"],
  });

  const warmInitialRender = makeMetric("warm initial render");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    addWarmSample(
      warmInitialRender,
      await measureAction(cdp, {
        label: `Gantt warm initial render #${iteration + 1}`,
        action: () =>
          cdp.evaluate(`document.querySelector(".task-gantt-refresh").click(), true`),
        readyExpression,
        rootSelector: GANTT_ROOT_SELECTOR,
        fingerprintExpression: "window.__vaultGanttPerf.renderGenerations.gantt",
      })
    );
  }
  metrics.gantt.warmInitialRender = warmInitialRender;

  const taskEdit = makeMetric("task edit + re-render");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    const barRect = await scrollBarIntoView(cdp, ".task-gantt-bar");
    if (!barRect) {
      throw new Error("Gantt task edit: no bar was available to open the rich popover");
    }
    const { x, y } = centerOf(barRect);
    await hoverOnto(cdp, x, y);
    await cdp.waitForExpression(
      `!!document.querySelector(".task-gantt-rich-popover.is-subtask")`,
      { timeoutMs: 15000, label: "Gantt task edit rich popover" }
    );

    addWarmSample(
      taskEdit,
      await measureAction(cdp, {
        label: `Gantt task edit #${iteration + 1}`,
        action: async () => {
          await cdp.evaluate(
            `document.querySelector(".task-gantt-popover-toggle-completed").click(), true`
          );
          // Move the trusted pointer away from the re-rendered bar so the
          // browser does not reopen the hover popover during the measurement.
          await moveMouse(cdp, 2, 2);
        },
        readyExpression,
        rootSelector: GANTT_ROOT_SELECTOR,
        fingerprintExpression: `JSON.stringify({
          generation: window.__vaultGanttPerf.renderGenerations.gantt,
          completedBars: document.querySelectorAll(".task-gantt-bar.is-completed").length,
        })`,
      })
    );
  }
  metrics.gantt.taskEdit = taskEdit;

  const zoomIn = makeMetric("zoom-in step");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    const oldLabel = await cdp.evaluate(
      `document.querySelector(".task-gantt-zoom-label")?.textContent ?? ""`
    );
    addWarmSample(
      zoomIn,
      await measureAction(cdp, {
        label: `Gantt zoom-in #${iteration + 1}`,
        action: () =>
          cdp.evaluate(`document.querySelector(".task-gantt-zoom-in").click(), true`),
        readyExpression: `(${readyExpression}) &&
          document.querySelector(".task-gantt-zoom-label")?.textContent !== ${JSON.stringify(oldLabel)}`,
        rootSelector: GANTT_ROOT_SELECTOR,
        fingerprintExpression: `document.querySelector(".task-gantt-zoom-label")?.textContent ?? ""`,
      })
    );
  }
  metrics.gantt.zoomIn = zoomIn;

  const holidayToggle = makeMetric("holiday toggle + re-render");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    addWarmSample(
      holidayToggle,
      await measureAction(cdp, {
        label: `Gantt holiday toggle #${iteration + 1}`,
        action: () =>
          cdp.evaluate(`(() => {
            const cell = Array.from(document.querySelectorAll(".task-gantt-dow-cell"))
              .find((candidate) =>
                !candidate.classList.contains("is-weekend") &&
                !candidate.classList.contains("is-holiday")
              );
            if (!cell) throw new Error("no weekday without a holiday class found");
            cell.click();
            return true;
          })()`),
        readyExpression,
        rootSelector: GANTT_ROOT_SELECTOR,
        fingerprintExpression: `JSON.stringify({
          generation: window.__vaultGanttPerf.renderGenerations.gantt,
          holidays: document.querySelectorAll(".task-gantt-dow-cell.is-holiday").length,
        })`,
      })
    );
  }
  metrics.gantt.holidayToggle = holidayToggle;

  const rangeExtension = makeMetric("horizontal range extension");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    addWarmSample(
      rangeExtension,
      await measureAction(cdp, {
        label: `Gantt horizontal range extension #${iteration + 1}`,
        action: () =>
          cdp.evaluate(`(() => {
            const wrap = document.querySelector(".task-gantt-wrap");
            if (!wrap) throw new Error("Gantt wrap not found");
            wrap.scrollTo(Math.max(0, wrap.scrollWidth - wrap.clientWidth - 1), 0);
            return true;
          })()`),
        readyExpression,
        rootSelector: GANTT_ROOT_SELECTOR,
        fingerprintExpression: `JSON.stringify({
          generation: window.__vaultGanttPerf.renderGenerations.gantt,
          scrollWidth: document.querySelector(".task-gantt-wrap")?.scrollWidth ?? 0,
        })`,
      })
    );
  }
  metrics.gantt.horizontalRangeExtension = rangeExtension;
}

async function clearWorkbenchFilter(cdp) {
  await setFieldValue(cdp, ".task-workbench-search", "");
  await sleep(WORKBENCH_FILTER_SETTLE_MS);
}

async function openWorkbench(cdp, expectedParents, metrics) {
  const readyExpression = workbenchReadyExpression(expectedParents);
  const coldInitialRender = makeMetric("cold initial render");
  addColdSample(
    coldInitialRender,
    await measureAction(cdp, {
      label: "Workbench cold initial render",
      action: () =>
        cdp.evaluate(
          `app.commands.executeCommandById(${JSON.stringify(WORKBENCH_COMMAND_ID)}), true`
        ),
      readyExpression,
      requireMutation: false,
    })
  );
  metrics.workbench.coldInitialRender = coldInitialRender;
  await installRenderHooks(cdp, {
    viewType: "task-workbench-view",
    key: "workbench",
    methods: ["render", "renderTable"],
  });

  const warmInitialRender = makeMetric("warm initial render");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    addWarmSample(
      warmInitialRender,
      await measureAction(cdp, {
        label: `Workbench warm initial render #${iteration + 1}`,
        action: () =>
          cdp.evaluate(`(() => {
            const button = Array.from(
              document.querySelectorAll(".task-workbench-toolbar-right button")
            ).find((candidate) => candidate.textContent?.trim() === "更新");
            if (!button) throw new Error("Workbench 更新 button not found");
            button.click();
            return true;
          })()`),
        readyExpression,
        rootSelector: WORKBENCH_ROOT_SELECTOR,
        fingerprintExpression: "window.__vaultGanttPerf.renderGenerations.workbench",
      })
    );
  }
  metrics.workbench.warmInitialRender = warmInitialRender;

  const filterKeystroke = makeMetric("filter-box keystroke + re-render");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    await clearWorkbenchFilter(cdp);
    addWarmSample(
      filterKeystroke,
      await measureAction(cdp, {
        label: `Workbench filter keystroke #${iteration + 1}`,
        action: () => setFieldValue(cdp, ".task-workbench-search", "e"),
        readyExpression,
        rootSelector: WORKBENCH_ROOT_SELECTOR,
        fingerprintExpression: `JSON.stringify({
          generation: window.__vaultGanttPerf.renderGenerations.workbench,
          value: document.querySelector(".task-workbench-search")?.value ?? "",
        })`,
      })
    );
  }
  await clearWorkbenchFilter(cdp);
  metrics.workbench.filterKeystroke = filterKeystroke;

  const inlineEdit = makeMetric("priority-star inline edit + re-render");
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    addWarmSample(
      inlineEdit,
      await measureAction(cdp, {
        label: `Workbench priority-star edit #${iteration + 1}`,
        action: () =>
          cdp.evaluate(`(() => {
            const parentRow = Array.from(document.querySelectorAll(".task-workbench-row"))
              .find((row) => !row.classList.contains("is-subtask"));
            const stars = parentRow
              ? Array.from(parentRow.querySelectorAll(".task-workbench-priority-star"))
              : [];
            const star = stars[${iteration % 5}];
            if (!star) throw new Error("Workbench priority star not found");
            star.click();
            return true;
          })()`),
        readyExpression,
        rootSelector: WORKBENCH_ROOT_SELECTOR,
        fingerprintExpression: `JSON.stringify({
          generation: window.__vaultGanttPerf.renderGenerations.workbench,
          stars: document.querySelector(".task-workbench-row:not(.is-subtask) .task-workbench-priority-stars")?.textContent ?? "",
        })`,
      })
    );
  }
  metrics.workbench.inlineEdit = inlineEdit;

  const sortChange = makeMetric("sort dropdown + re-render");
  const sortValues = ["title", "createdAt", "statusLabel", "updatedAt", "dueDate"];
  for (let iteration = 0; iteration < WARM_SAMPLES; iteration++) {
    addWarmSample(
      sortChange,
      await measureAction(cdp, {
        label: `Workbench sort change #${iteration + 1}`,
        action: () =>
          selectValue(
            cdp,
            ".task-workbench-toolbar-left select:nth-of-type(2)",
            sortValues[iteration]
          ),
        readyExpression,
        rootSelector: WORKBENCH_ROOT_SELECTOR,
        fingerprintExpression: `JSON.stringify({
          generation: window.__vaultGanttPerf.renderGenerations.workbench,
          sort: document.querySelector(".task-workbench-toolbar-left select:nth-of-type(2)")?.value ?? "",
        })`,
      })
    );
  }
  metrics.workbench.sortChange = sortChange;
}

function metricEntries(metrics) {
  return [
    ["Gantt", metrics.gantt.coldInitialRender],
    ["Gantt", metrics.gantt.warmInitialRender],
    ["Gantt", metrics.gantt.taskEdit],
    ["Gantt", metrics.gantt.zoomIn],
    ["Gantt", metrics.gantt.holidayToggle],
    ["Gantt", metrics.gantt.horizontalRangeExtension],
    ["Workbench", metrics.workbench.coldInitialRender],
    ["Workbench", metrics.workbench.warmInitialRender],
    ["Workbench", metrics.workbench.filterKeystroke],
    ["Workbench", metrics.workbench.inlineEdit],
    ["Workbench", metrics.workbench.sortChange],
  ];
}

function printTable(metrics) {
  console.log("\nView       Metric                               Cold (ms) Median* (ms)  P95 (ms) Warm samples (ms)");
  console.log("---------------------------------------------------------------------------------------------------");
  for (const [view, metric] of metricEntries(metrics)) {
    printMetricRow(view, metric);
  }
  console.log("* Median excludes the fastest warm sample when n=5; p95 uses all raw samples.");
}

async function runBenchmark({ parents, subtasksPerParent, incrementalGanttRender }) {
  const shape = `${parents}x${subtasksPerParent}`;
  const renderMode =
    incrementalGanttRender === undefined
      ? "default"
      : incrementalGanttRender
        ? "incremental"
        : "full";
  const scenarioTmp = path.join(
    TMP_ROOT,
    `perf-benchmark-${shape}-${renderMode}-${process.pid}-${Date.now()}`
  );
  const vaultDir = path.join(scenarioTmp, "vault");
  const expectedBars = parents * subtasksPerParent;
  const metrics = {
    gantt: {},
    workbench: {},
  };
  let fixturePaths;
  let runtime = null;

  try {
    fs.mkdirSync(vaultDir, { recursive: true });
    installPlugin(vaultDir, incrementalGanttRender);
    fixturePaths = await generateFixtures({
      vaultDir,
      count: parents,
      subtasksPerParent,
    });
    runtime = await startObsidian({ vaultDir });
    console.log(
      `[perf-benchmark:${shape}:${renderMode}] Obsidian up (CDP :${runtime.cdpPort}, ` +
        `${expectedBars} subtasks)`
    );
    await runtime.cdp.waitForExpression(
      `!!app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}]`,
      { timeoutMs: 60000, intervalMs: 500, label: "vault-gantt manifest scanned" }
    );
    await enablePlugin(runtime.cdp, PLUGIN_ID);
    await waitForIndexedFixtures(runtime.cdp, fixturePaths);
    await installMutationTracker(runtime.cdp);

    await openGantt(runtime.cdp, parents, expectedBars, metrics);
    await dismissTrustDialogIfPresent(runtime.cdp);
    await sleep(250);

    await openWorkbench(runtime.cdp, parents, metrics);

    const capturedErrors = runtime.cdp.capturedErrors();
    if (capturedErrors.length > 0) {
      console.log(
        `[perf-benchmark:${shape}:${renderMode}] CDP errors captured: ${JSON.stringify(capturedErrors)}`
      );
    }

    const artifactPath = path.join(
      ARTIFACTS_DIR,
      `perf-benchmark-${shape}-${renderMode}-${timestampForFilename()}.json`
    );
    const result = {
      generatedAt: new Date().toISOString(),
      shape: {
        parents,
        subtasksPerParent,
        totalSubtasks: expectedBars,
      },
      renderMode,
      incrementalGanttRender,
      warmSampleCount: WARM_SAMPLES,
      quietWindowMs: QUIET_MS,
      warmSummaryPolicy: "median excludes the fastest warm sample when n=5; p95 uses all raw samples",
      metrics,
      capturedCdpErrors: capturedErrors,
      fixturePaths,
      artifactPath,
    };
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    console.log(`\n[perf-benchmark:${shape}:${renderMode}] results`);
    printTable(metrics);
    console.log(`[perf-benchmark:${shape}:${renderMode}] JSON artifact: ${artifactPath}`);
    return { result, artifactPath };
  } finally {
    if (runtime) {
      runtime.kill();
      await sleep(500);
    }
    try {
      fs.rmSync(scenarioTmp, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(
        `[perf-benchmark:${shape}:${renderMode}] cleanup failed: ${cleanupError.message}`
      );
    }
  }
}

async function main() {
  assertNode22();
  assertBuildArtifacts();
  const shape = parseArgs(process.argv.slice(2));
  await runBenchmark(shape);
}

main().catch((err) => {
  console.error(`[perf-benchmark] FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
