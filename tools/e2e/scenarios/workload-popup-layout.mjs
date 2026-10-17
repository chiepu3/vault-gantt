// tools/e2e/scenarios/workload-popup-layout.mjs

// Real-browser coverage for the bar-level workload popup layout at 1188x848:
//  1. With a long date range (horizontal scroll) the horizontal scrollbar must
//     not cover the bottom of the graph (zero label/line, 0.5h and 1h fills).
//     A short range (no scroll) is checked as the control.
//  2. Hovering a parent row and then a lower subtask bar opens the rich popup
//     and the workload popup together; they must not overlap and the rich
//     popup's progress textarea and buttons must stay uncovered.
//  3. At a narrow 1188x500 viewport (bar scrolled to ~y=330) both popups stay
//     inside the viewport and still do not overlap. The measured DOM rects are
//     written as JSON plus a PNG of the synthetic fixture to E2E_EVIDENCE_DIR
//     (default tools/e2e/artifacts, gitignored) as narrow-<E2E_EVIDENCE_TAG>.*
//     (tag default "after"; run the same scenario against an older build with
//     tag "before" for before/after evidence).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
// Rows below the bars so the wrap can scroll them up to y~260 at 500px high.
const TAIL_PARENTS = 5;
const LONG_DAYS = 40;
const SHORT_DAYS = 3;
const GRAPH_HEIGHT_PX = 86;
const EPS = 0.5;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NARROW_VIEWPORT = { w: 1188, h: 500 };
// The sticky header covers y < ~300 at this size, so the bar is scrolled to the
// first hoverable row; the exact {top:260} geometry is pinned in the unit tests.
const NARROW_BAR_TOP_PX = 330;

/** In-page expression: DOM/paint ordering of the rich and workload popups. */
const ORDER_PROBE = `(() => {
  const rich = document.querySelector(".task-gantt-rich-popover.is-subtask");
  const wl = document.querySelector(".task-gantt-workload-popover.is-visible");
  if (!rich || !wl) return { rich: !!rich, workload: !!wl };
  const vis = (e) => { const c = getComputedStyle(e); return c.display !== "none" && c.visibility !== "hidden" && Number(c.opacity) > 0; };
  const rr = wl.getBoundingClientRect();
  const topAtWl = document.elementFromPoint((rr.left + rr.right) / 2, (rr.top + rr.bottom) / 2);
  return {
    rich: true,
    workload: true,
    richVisible: vis(rich),
    workloadVisible: vis(wl),
    richBeforeWorkloadInDom: !!(rich.compareDocumentPosition(wl) & Node.DOCUMENT_POSITION_FOLLOWING),
    sameParent: rich.parentNode === wl.parentNode,
    richZ: getComputedStyle(rich).zIndex,
    workloadZ: getComputedStyle(wl).zIndex,
    workloadOnTopAtItsCenter: !!topAtWl && wl.contains(topAtWl),
  };
})()`;

function checkOrder(label, o, failures) {
  if (!o.rich || !o.workload) {
    failures.push(`${label}: both popups must be present (rich=${o.rich}, workload=${o.workload})`);
    return;
  }
  if (!o.richVisible) failures.push(`${label}: rich popup is not displayed`);
  if (!o.workloadVisible) failures.push(`${label}: workload popup is not displayed`);
  if (!o.richBeforeWorkloadInDom) failures.push(`${label}: DOM order is not rich-then-workload`);
  if (!o.sameParent) failures.push(`${label}: popups do not share a parent`);
  if (o.richZ !== o.workloadZ) failures.push(`${label}: z-index differs (rich=${o.richZ}, workload=${o.workloadZ}); order would not follow the DOM`);
  if (!o.workloadOnTopAtItsCenter) failures.push(`${label}: workload popup is not on top at its own center`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Set by prepare() (same process as run()); lets run() derive the hours the
// fixture stored for any date.
let fixtureStart;

/** Planned/actual hours the fixture stores for `date` (see prepare()). */
function fixtureHours(date) {
  const idx = Math.round(
    (Date.UTC(...date.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) -
      Date.UTC(...fixtureStart.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))) /
      86400000
  );
  return { plan: idx % 2 ? 1 : 0.5, actual: idx % 2 ? 0.5 : 1 };
}

export async function prepare(vaultDir) {
  const { buildFullNote } = await loadNoteFormatModule();
  const today = toIsoStr(new Date());
  const start = toIsoStr(pickAnchorMonday({ minDaysFromToday: 3 }));
  fixtureStart = start;
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
  for (let i = 0; i < TAIL_PARENTS; i++) {
    makeParent(`Tail${i}`, FILLER_PARENTS + 2 + i, undefined, 0);
  }
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
  const fills = cells.map((c) => {
    const f = c.querySelector(".task-gantt-workload-fill").getBoundingClientRect();
    return { date: c.getAttribute("data-date"), height: f.height, bottom: f.bottom };
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
    mode: pop.classList.contains("is-actual") ? "actual" : "plan",
    maxHours: (app.plugins.plugins["vault-gantt"].settings || {}).ganttWorkloadMaxHours,
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
  // Every cell's fill must be positive (0.5h and 1h included), visible above
  // the scrollbar, and match the unchanged scale: hours / max(0.5, maxHours)
  // of the 86px plot.
  const maxHours = typeof m.maxHours === "number" ? m.maxHours : 7;
  const seen = new Set();
  for (const fill of m.fills) {
    const hours = fixtureHours(fill.date)[m.mode];
    seen.add(hours);
    const expected = (hours / Math.max(0.5, maxHours)) * GRAPH_HEIGHT_PX;
    if (!(fill.height > 0)) {
      failures.push(`${label}: ${fill.date} (${hours}h) fill height ${fill.height} is not positive`);
    } else if (Math.abs(fill.height - expected) > EPS) {
      failures.push(`${label}: ${fill.date} (${hours}h) fill height ${fill.height.toFixed(2)} != expected ${expected.toFixed(2)}`);
    }
    if (fill.bottom > visibleBottom + EPS) {
      failures.push(`${label}: ${fill.date} fill bottom ${fill.bottom} is clipped below ${visibleBottom}`);
    }
  }
  if (!seen.has(0.5) || !seen.has(1)) {
    failures.push(`${label}: expected both 0.5h and 1h cells, saw hours ${[...seen].join(",")}`);
  }
  const heights = m.fills.slice(0, 2).map((f) => f.height.toFixed(2)).join("/");
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
      `(() => app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("tasks/") && app.metadataCache.getFileCache(f)?.frontmatter?.ganttEnabled === true).length === ${FILLER_PARENTS + 2 + TAIL_PARENTS})()`,
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

  checkOrder("1188x848", await cdp.evaluate(ORDER_PROBE), failures);

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

  // ---- 3. narrow 1188x500 viewport
  await moveMouse(cdp, 2, 2);
  await sleep(500);
  await cdp.evaluate(
    `(() => { const r = require("electron").remote || require("@electron/remote"); const w = r.getCurrentWindow(); w.setContentSize(${NARROW_VIEWPORT.w}, ${NARROW_VIEWPORT.h}); w.setPosition(0, 0); return true; })()`
  );
  await sleep(800);
  // Scroll the wrap vertically so the long bar sits near y=330.
  await cdp.evaluate(`(() => {
    const wrap = document.querySelector(".task-gantt-wrap");
    const bar = document.querySelectorAll(".task-gantt-bar")[0];
    wrap.scrollTop += bar.getBoundingClientRect().top - ${NARROW_BAR_TOP_PX};
    return true;
  })()`);
  await sleep(400);
  const narrowPt = await cdp.evaluate(`(() => {
    const r = document.querySelectorAll(".task-gantt-bar")[0].getBoundingClientRect();
    return { x: 1000, y: r.top + r.height / 2, bar: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
  })()`);
  await moveMouse(cdp, 2, 2);
  await sleep(300);
  await hoverOnto(cdp, narrowPt.x, narrowPt.y, { settleMs: 600 });
  const narrow = await cdp.evaluate(`(() => {
    const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
    const rich = document.querySelector(".task-gantt-rich-popover.is-subtask");
    const wl = document.querySelector(".task-gantt-workload-popover.is-visible");
    const rr = rect(rich), wr = rect(wl);
    const vw = innerWidth, vh = innerHeight;
    const inside = (r) => !!r && r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
    const hit = (el) => {
      const r = rect(el);
      const top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return !!top && rich.contains(top);
    };
    const ta = rich && rich.querySelector("textarea");
    return {
      viewport: { w: vw, h: vh },
      richSide: rich ? rich.dataset.side : null,
      workloadSide: wl ? wl.dataset.side : null,
      rich: rr,
      workload: wr,
      overlap: !!(rr && wr && rr.left < wr.right && wr.left < rr.right && rr.top < wr.bottom && wr.top < rr.bottom),
      richInViewport: inside(rr),
      workloadInViewport: inside(wr),
      textareaReachable: ta ? hit(ta) : null,
      buttonsReachable: rich ? [...rich.querySelectorAll("button")].map((b) => ({ text: b.textContent, reachable: hit(b) })) : [],
    };
  })()`);
  narrow.order = await cdp.evaluate(ORDER_PROBE);
  checkOrder("narrow", narrow.order, failures);
  narrow.bar = narrowPt.bar;
  narrow.tag = process.env.E2E_EVIDENCE_TAG || "after";
  const evidenceDir = process.env.E2E_EVIDENCE_DIR
    ? path.resolve(process.env.E2E_EVIDENCE_DIR)
    : path.join(REPO_ROOT, "tools", "e2e", "artifacts");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, `narrow-${narrow.tag}.json`), `${JSON.stringify(narrow, null, 2)}\n`);
  await cdp.screenshot(path.join(evidenceDir, `narrow-${narrow.tag}.png`));
  if (narrow.viewport.w !== NARROW_VIEWPORT.w || narrow.viewport.h !== NARROW_VIEWPORT.h) {
    failures.push(`narrow viewport is ${narrow.viewport.w}x${narrow.viewport.h}, expected ${NARROW_VIEWPORT.w}x${NARROW_VIEWPORT.h}`);
  }
  if (!narrow.rich || !narrow.workload) {
    failures.push(`narrow: both popups must be visible (rich=${!!narrow.rich}, workload=${!!narrow.workload})`);
  } else {
    if (narrow.overlap) failures.push(`narrow: popups overlap: rich=${JSON.stringify(narrow.rich)} workload=${JSON.stringify(narrow.workload)}`);
    if (!narrow.richInViewport) failures.push(`narrow: rich popup outside viewport: ${JSON.stringify(narrow.rich)}`);
    if (!narrow.workloadInViewport) failures.push(`narrow: workload popup outside viewport: ${JSON.stringify(narrow.workload)}`);
    if (narrow.textareaReachable !== true) failures.push("narrow: progress textarea is covered");
    for (const b of narrow.buttonsReachable) {
      if (!b.reachable) failures.push(`narrow: button "${b.text}" is covered`);
    }
    details.push(`narrow ${narrow.viewport.w}x${narrow.viewport.h}: side=${narrow.richSide} rich=${JSON.stringify(narrow.rich)} workload=${JSON.stringify(narrow.workload)} overlap=${narrow.overlap}`);
  }

  const errors = cdp.capturedErrors();
  if (errors.length > 0) {
    failures.push(`${errors.length} console error(s):\n` + errors.map((e) => `    [${e.source}] ${e.text}`).join("\n"));
  }
  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}
