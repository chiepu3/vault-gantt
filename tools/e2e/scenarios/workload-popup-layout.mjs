// tools/e2e/scenarios/workload-popup-layout.mjs

// Real-browser coverage for the bar-level workload popup layout at 1188x848:
//  1. With a long date range (horizontal scroll) the horizontal scrollbar must
//     not cover the bottom of the graph (zero label/line, 0.5h and 1h fills).
//     A short range (no scroll) is checked as the control.
//  2. Hovering a parent row and then a lower subtask bar opens the rich popup
//     and the workload popup together; they must not overlap and the rich
//     popup's progress textarea and buttons must stay uncovered.

import fs from "node:fs";
import path from "node:path";
import { pickAnchorMonday, toIsoStr, addDaysIso } from "./drag-fixture.mjs";
import { loadNoteFormatModule } from "../gen-fixtures.mjs";
import {
  hoverOnto,
  moveMouse,
  dismissTrustDialogIfPresent,
  scrollBarIntoView,
} from "./cdp-input.mjs";

const COMMAND_ID = "vault-gantt:open-task-gantt";
const FILLER_PARENTS = 4;
const LONG_DAYS = 40;
const SHORT_DAYS = 3;
const GRAPH_HEIGHT_PX = 86;
const EPS = 0.5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function prepare(vaultDir) {
  const { buildFullNote } = await loadNoteFormatModule();
  const today = toIsoStr(new Date());
  const start = toIsoStr(pickAnchorMonday({ minDaysFromToday: 3 }));
  const folder = `tasks/${today.slice(0, 4)}/${today.slice(5, 7)}`;
  fs.mkdirSync(path.join(vaultDir, folder), { recursive: true });

  const makeParent = (name, order, subtaskTitle, days) => {
    const parentPath = `${folder}/${today} ${name}.md`;
    const subtasks = new Map();
    if (subtaskTitle !== undefined) {
      const plan = {};
      const actual = {};
      for (let i = 0; i < days; i++) {
        const d = addDaysIso(start, i);
        plan[d] = i % 2 ? 1 : 0.5;
        actual[d] = i % 2 ? 0.5 : 1;
      }
      subtasks.set("subtask-1", {
        kind: "subtask",
        id: `${parentPath}::subtask-1`,
        key: "subtask-1",
        file: { path: parentPath, parentPath, heading: subtaskTitle },
        title: subtaskTitle,
        displayName: subtaskTitle,
        statusLabel: "active",
        completed: false,
        createdAt: today,
        updatedAt: today,
        priority: 0,
        priorityMode: "auto",
        currentStatus: "",
        notes: "",
        tags: [],
        ganttEnabled: false,
        plannedStartDate: start,
        plannedEndDate: addDaysIso(start, days - 1),
        workloadPlan: plan,
        workloadActual: actual,
      });
    }
    const parent = {
      kind: "parent",
      id: parentPath,
      file: { path: parentPath },
      title: name,
      displayName: name,
      statusLabel: "active",
      completed: false,
      createdAt: today,
      updatedAt: today,
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: true,
      ganttOrder: order,
      subtasks,
    };
    fs.writeFileSync(path.join(vaultDir, parentPath), buildFullNote(parent, subtasks));
    return parentPath;
  };

  // Filler rows push the long bar low enough that the rich popup cannot fit
  // below it (the case where both popups used to land above the bar).
  for (let i = 0; i < FILLER_PARENTS; i++) {
    makeParent(`Filler${i}`, i, undefined, 0);
  }
  const longPath = makeParent("0003", FILLER_PARENTS, "PlannedWork001", LONG_DAYS);
  makeParent("0004", FILLER_PARENTS + 1, "ShortWork", SHORT_DAYS);
  return { longPath };
}

/** Measures the open workload popup's graph/scrollbar geometry. */
const MEASURE_GRAPH = `(() => {
  const pop = document.querySelector(".task-gantt-workload-popover.is-visible");
  if (!pop) return null;
  const sc = pop.querySelector(".task-gantt-workload-popover-graph-scroll");
  const g = pop.querySelector(".task-gantt-workload-graph");
  const labels = [...pop.querySelectorAll(".task-gantt-workload-popover-axis-label")];
  const scR = sc.getBoundingClientRect();
  const gR = g.getBoundingClientRect();
  const zero = labels[labels.length - 1].getBoundingClientRect();
  const cells = [...pop.querySelectorAll(".task-gantt-workload-popover-cell")];
  const fills = cells.slice(0, 2).map((c) => {
    const f = c.querySelector(".task-gantt-workload-fill").getBoundingClientRect();
    return { height: f.height, bottom: f.bottom };
  });
  return {
    clientHeight: sc.clientHeight,
    scrollTop: scR.top,
    graphTop: gR.top,
    graphBottom: gR.bottom,
    graphHeight: gR.height,
    zeroLabelBottom: zero.bottom,
    hasHScroll: sc.scrollWidth > sc.clientWidth,
    scrollbarHeight: sc.offsetHeight - sc.clientHeight,
    popBottom: pop.getBoundingClientRect().bottom,
    popClientH: pop.clientHeight,
    popScrollH: pop.scrollHeight,
    fills,
    cellCount: cells.length,
  };
})()`;

function checkGraph(label, m, expectScroll, failures, details) {
  if (!m) {
    failures.push(`${label}: workload popup not visible`);
    return;
  }
  if (m.hasHScroll !== expectScroll) {
    failures.push(`${label}: hasHScroll=${m.hasHScroll}, expected ${expectScroll} (cells=${m.cellCount})`);
  }
  if (Math.abs(m.graphHeight - GRAPH_HEIGHT_PX) > EPS) {
    failures.push(`${label}: graph height ${m.graphHeight}, expected ${GRAPH_HEIGHT_PX} (scale must not change)`);
  }
  // The scroll box's client area (excluding the scrollbar) must contain the
  // whole graph, otherwise the scrollbar covers the plot's bottom.
  const visibleBottom = m.scrollTop + m.clientHeight;
  if (visibleBottom + EPS < m.graphBottom) {
    failures.push(
      `${label}: scrollbar hides ${(m.graphBottom - visibleBottom).toFixed(1)}px of the graph bottom ` +
        `(clientHeight=${m.clientHeight}, graphBottom=${m.graphBottom}, visibleBottom=${visibleBottom})`
    );
  }
  if (Math.abs(m.zeroLabelBottom - m.graphBottom) > 1) {
    failures.push(`${label}: zero label bottom ${m.zeroLabelBottom} != graph bottom ${m.graphBottom}`);
  }
  // 1h and 0.5h fills (plan mode, first two cells) at the unchanged scale.
  for (const [i, fill] of m.fills.entries()) {
    if (fill.height <= 0) continue;
    if (fill.bottom > visibleBottom + EPS) {
      failures.push(`${label}: fill ${i} bottom ${fill.bottom} is clipped below ${visibleBottom}`);
    }
  }
  const heights = m.fills.map((f) => f.height.toFixed(2)).join("/");
  if (m.popClientH < m.popScrollH) {
    failures.push(`${label}: popover content clipped (client ${m.popClientH} < scroll ${m.popScrollH})`);
  }
  details.push(`${label}: hbar=${m.scrollbarHeight}px clientH=${m.clientHeight} fills=${heights}`);
}

export async function run({ cdp }) {
  const failures = [];
  const details = [];

  const hasCommand = await cdp.evaluate(`!!app.commands.commands[${JSON.stringify(COMMAND_ID)}]`);
  if (!hasCommand) {
    return { ok: false, failures: [`command ${COMMAND_ID} not registered`], details: "" };
  }
  try {
    await cdp.waitForExpression(
      `(() => app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("tasks/") && app.metadataCache.getFileCache(f)?.frontmatter?.ganttEnabled === true).length === ${FILLER_PARENTS + 2})()`,
      { timeoutMs: 20000, label: "fixtures indexed by metadataCache" }
    );
  } catch (err) {
    return { ok: false, failures: [`fixtures never indexed: ${err.message}`], details: "" };
  }

  cdp.resetCapturedErrors();
  await cdp.evaluate(`(app.commands.executeCommandById(${JSON.stringify(COMMAND_ID)}), true)`);
  try {
    await cdp.waitForExpression(`document.querySelectorAll(".task-gantt-bar").length === 2`, {
      timeoutMs: 30000,
      label: "two gantt bars rendered",
    });
  } catch (err) {
    return { ok: false, failures: [`bars never rendered: ${err.message}`], details: "" };
  }
  await dismissTrustDialogIfPresent(cdp);

  // Native preview size from the report: 1188x848 content area.
  await cdp.evaluate(
    `(() => { const r = require("electron").remote || require("@electron/remote"); const w = r.getCurrentWindow(); w.setContentSize(1188, 848); w.setPosition(0, 0); return true; })()`
  );
  await sleep(800);
  const vp = await cdp.evaluate(`({ w: innerWidth, h: innerHeight })`);
  if (vp.w !== 1188 || vp.h !== 848) {
    failures.push(`viewport is ${vp.w}x${vp.h}, expected 1188x848`);
  }

  const firstBar = await scrollBarIntoView(cdp, ".task-gantt-bar");
  if (!firstBar) {
    failures.push("first bar vanished before hover");
    return { ok: false, failures, details: details.join(" | ") };
  }
  // The long bar is wider than the viewport, so hover a point inside it.
  const barPoint = async (index) =>
    cdp.evaluate(`(() => {
      const r = document.querySelectorAll(".task-gantt-bar")[${index}].getBoundingClientRect();
      return { x: Math.min(r.left + 40, Math.max(r.left + 5, Math.min(r.right - 5, 1000))), y: r.top + r.height / 2 };
    })()`);

  // ---- 1. graph vs horizontal scrollbar: long range (scroll) and short (no scroll)
  const longPt = await barPoint(0);
  await hoverOnto(cdp, longPt.x, longPt.y, { settleMs: 400 });
  checkGraph("long range (plan)", await cdp.evaluate(MEASURE_GRAPH), true, failures, details);
  await cdp.evaluate(`document.querySelector(".task-gantt-workload-popover-mode-toggle").click()`);
  await sleep(150);
  checkGraph("long range (actual)", await cdp.evaluate(MEASURE_GRAPH), true, failures, details);

  await moveMouse(cdp, 2, 2);
  await sleep(500);
  const shortPt = await barPoint(1);
  await hoverOnto(cdp, shortPt.x, shortPt.y, { settleMs: 400 });
  checkGraph("short range (plan)", await cdp.evaluate(MEASURE_GRAPH), false, failures, details);

  // ---- 2. parent hover then lower subtask bar: popups must not overlap
  await moveMouse(cdp, 2, 2);
  await sleep(500);
  const parentPt = await cdp.evaluate(`(() => {
    const e = [...document.querySelectorAll(".task-gantt-parent-left")].find((x) => x.textContent.includes("0003"));
    const r = e.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + Math.min(20, r.height / 2) };
  })()`);
  await hoverOnto(cdp, parentPt.x, parentPt.y, { settleMs: 500 });
  const parentPopup = await cdp.evaluate(`!!document.querySelector(".task-gantt-rich-popover.is-parent")`);
  if (!parentPopup) failures.push("parent rich popup did not open on parent hover");

  const lowPt = await cdp.evaluate(`(() => {
    const r = document.querySelectorAll(".task-gantt-bar")[0].getBoundingClientRect();
    return { x: 1150, y: r.top + r.height / 2 };
  })()`);
  await moveMouse(cdp, lowPt.x, lowPt.y);
  await sleep(500);
  const layout = await cdp.evaluate(`(() => {
    const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
    const rich = document.querySelector(".task-gantt-rich-popover.is-subtask");
    const wl = document.querySelector(".task-gantt-workload-popover.is-visible");
    if (!rich || !wl) return { rich: !!rich, wl: !!wl };
    const rr = rect(rich), wr = rect(wl);
    const hit = (el) => {
      const r = rect(el);
      const top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return !!top && rich.contains(top);
    };
    const ta = rich.querySelector("textarea");
    const btns = [...rich.querySelectorAll("button")];
    return {
      rich: true, wl: true, rr, wr,
      overlap: rr.left < wr.right && wr.left < rr.right && rr.top < wr.bottom && wr.top < rr.bottom,
      textareaReachable: ta ? hit(ta) : null,
      buttons: btns.map((b) => ({ t: b.textContent, reachable: hit(b) })),
      inViewport: rr.top >= 0 && rr.bottom <= innerHeight && wr.top >= 0 && wr.bottom <= innerHeight,
    };
  })()`);
  if (!layout.rich || !layout.wl) {
    failures.push(`both popups must be visible (rich=${layout.rich}, workload=${layout.wl})`);
  } else {
    if (layout.overlap) {
      failures.push(`popups overlap: rich=${JSON.stringify(layout.rr)} workload=${JSON.stringify(layout.wr)}`);
    }
    if (layout.textareaReachable !== true) failures.push("progress textarea is covered");
    for (const b of layout.buttons) {
      if (!b.reachable) failures.push(`button "${b.t}" is covered`);
    }
    if (!layout.inViewport) failures.push(`popup outside viewport: ${JSON.stringify(layout)}`);
    details.push(`popups: rich=${JSON.stringify(layout.rr)} workload=${JSON.stringify(layout.wr)} overlap=${layout.overlap}`);
  }

  // Repeated hover must keep the placement stable.
  await moveMouse(cdp, 2, 2);
  await sleep(500);
  const first = layout.rr;
  await hoverOnto(cdp, 1150, lowPt.y, { settleMs: 500 });
  await sleep(200);
  const again = await cdp.evaluate(`(() => { const e = document.querySelector(".task-gantt-rich-popover.is-subtask"); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top }; })()`);
  if (first && again && (Math.abs(again.top - first.top) > 1 || Math.abs(again.left - first.left) > 1)) {
    failures.push(`rich popup moved on repeated hover: ${JSON.stringify(first)} -> ${JSON.stringify(again)}`);
  }

  const errors = cdp.capturedErrors();
  if (errors.length > 0) {
    failures.push(`${errors.length} console error(s):\n` + errors.map((e) => `    [${e.source}] ${e.text}`).join("\n"));
  }
  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}
