import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateFixtures } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, "tools", "e2e", "artifacts");
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-gantt-marker-position-"));
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

const [fixturePath] = await generateFixtures({ vaultDir, count: 1 });
const fixtureFile = path.join(vaultDir, fixturePath);
const fixtureContent = fs.readFileSync(fixtureFile, "utf8");
const plannedStartDate = fixtureContent.match(
  /^subtask__subtask-1__plannedStartDate:\s*(\d{4}-\d{2}-\d{2})\s*$/m
)?.[1];
const plannedEndDate = fixtureContent.match(
  /^subtask__subtask-1__plannedEndDate:\s*(\d{4}-\d{2}-\d{2})\s*$/m
)?.[1];
if (!plannedStartDate || !plannedEndDate || plannedStartDate > plannedEndDate) {
  throw new Error("fixture is missing a valid planned date range");
}

const emptyMarkerOrder = "subtask__subtask-1__ganttMarkerOrder: []";
if (!fixtureContent.includes(emptyMarkerOrder)) {
  throw new Error("fixture is missing the expected empty marker order");
}
fs.writeFileSync(
  fixtureFile,
  fixtureContent.replace(
    emptyMarkerOrder,
    [
      "subtask__subtask-1__ganttMarkerOrder: [marker-1]",
      'subtask__subtask-1__ganttMarker__marker-1__title: "M"',
      `subtask__subtask-1__ganttMarker__marker-1__date: ${plannedStartDate}`,
      "subtask__subtask-1__ganttMarker__marker-1__tags: ",
    ].join("\n")
  )
);

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
  await runtime.cdp.evaluate("app.commands.executeCommandById('vault-gantt:open-task-gantt'), true");
  await runtime.cdp.waitForExpression("!!document.querySelector('.task-gantt-marker')", {
    timeoutMs: 60000,
    label: "gantt marker",
  });

  const findings = await runtime.cdp.evaluate(`(() => {
    const marker = document.querySelector('.task-gantt-marker');
    const timeline = marker?.closest('.task-gantt-parent-timeline');
    const bar = timeline?.querySelector('.task-gantt-bar');
    const dayCell = timeline?.querySelector('.task-gantt-bg');
    if (!marker || !timeline || !bar || !dayCell) {
      throw new Error('marker geometry elements not found');
    }

    const markerRect = marker.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const markerInlineLeft = Number.parseFloat(marker.style.left);
    const barInlineLeft = Number.parseFloat(bar.style.left);
    const dayWidth = Number.parseFloat(dayCell.style.width);
    if (![markerInlineLeft, barInlineLeft, dayWidth].every(Number.isFinite)) {
      throw new Error('marker geometry inline styles are not numeric');
    }

    const anchorRelativeX = barInlineLeft + dayWidth / 2;
    const timelineViewportOffsetX = barRect.left - barInlineLeft;
    const anchorX = timelineViewportOffsetX + anchorRelativeX;
    return {
      markerRectLeft: markerRect.left,
      markerWidth: markerRect.width,
      markerInlineLeft,
      barInlineLeft,
      dayWidth,
      anchorX,
      anchorRelativeX,
      timelineViewportOffsetX,
      offsetPx: markerRect.left - anchorX,
      inlineOffsetPx: markerInlineLeft - anchorRelativeX,
    };
  })()`);

  console.log("MARKER_RECT_LEFT_PX", findings.markerRectLeft);
  console.log("DAY_CENTER_ANCHOR_X_PX", findings.anchorX);
  console.log("MARKER_ANCHOR_OFFSET_PX", findings.offsetPx);
  console.log("MARKER_RENDERED_WIDTH_PX", findings.markerWidth);
  console.log("MARKER_INLINE_OFFSET_PX", findings.inlineOffsetPx);

  await runtime.cdp.evaluate(`(() => {
    try { app.workspace.leftSplit.collapse(); } catch {}
    try { app.workspace.rightSplit.collapse(); } catch {}
  })()`);
  await runtime.cdp.screenshot(
    path.join(artifactDir, "marker-position-check.png")
  );

  const tolerancePx = 1;
  if (Math.abs(findings.offsetPx) > tolerancePx) {
    throw new Error(
      `marker left edge is ${findings.offsetPx}px from the day-center anchor ` +
        `(tolerance ${tolerancePx}px)`
    );
  }
} finally {
  console.log("CAPTURED_ERRORS", JSON.stringify(runtime.cdp.capturedErrors()));
  runtime.kill();
}
