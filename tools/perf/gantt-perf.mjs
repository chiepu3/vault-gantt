#!/usr/bin/env node
// Gantt perf suite: open, hover, scroll frame, zoom, single edit, full rebuild, heap. Prints medians as JSON.
//   NODE_PATH=/opt/node-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/perf/gantt-perf.mjs [--subtasks 10|100] [--parents 50] [--samples 8]
import { start } from "./perf-harness.mjs";
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const parents = Number(arg("parents", 50)), subtasks = Number(arg("subtasks", 10)), samples = Number(arg("samples", 8));
const med = (xs) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? +s[s.length >> 1].toFixed(1) : -1; };
const p90 = (xs) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * 0.9))].toFixed(1) : -1; };
const h = await start({ parents, subtasks, before: async ({ page }) => {
  await page.addInitScript(() => {
    window.__builds = [];
    new MutationObserver((muts) => { let rows = 0, bars = 0; for (const m of muts) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.classList?.contains("task-gantt-parent-row")) rows++; else if (n.classList?.contains("task-gantt-bar")) bars++; else if (n.querySelectorAll) { rows += n.querySelectorAll(".task-gantt-parent-row").length; bars += n.querySelectorAll(".task-gantt-bar").length; } } if (rows || bars) window.__builds.push({ at: Math.round(performance.now()), rows, bars }); }).observe(document, { childList: true, subtree: true });
  });
} });
const { page, cdp } = h; const out = { parents, subtasks };
if (arg("css", "")) { await page.addStyleTag({ content: arg("css", "") }); out.css = arg("css", ""); }
await page.waitForTimeout(2500);
out.open = await page.evaluate(() => { const b = window.__builds; return { firstBarMs: b[0]?.at, lastBuildMs: b.at(-1)?.at, rowInserts: b.reduce((a, x) => a + x.rows, 0) }; });
out.dom = await page.evaluate(() => ({ nodes: document.querySelectorAll(".task-gantt-container *").length, bars: document.querySelectorAll(".task-gantt-bar").length, stickyTitles: [...document.querySelectorAll(".task-gantt-bar-title")].filter((t) => getComputedStyle(t).position === "sticky").length }));
await page.evaluate(() => { window.__v = window.vgp.app.workspace.getLeavesOfType("task-gantt-view")[0].view; });
// hover: real mouse onto a bar -> popover in DOM and painted
const hovers = [];
const targets = await page.evaluate(() => [...document.querySelectorAll(".task-gantt-bar")].map((b) => b.getBoundingClientRect()).filter((r) => r.top > 300 && r.bottom < 900 && r.left > 400 && r.right < 1500 && r.width > 40).map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })));
for (let i = 0; i < samples + 1 && i * 3 < targets.length; i++) {
  const t = targets[i * 3];
  await page.mouse.move(5, 5); await page.waitForTimeout(450);
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.move(t.x, t.y);
  hovers.push(await page.evaluate((s) => new Promise((resolve) => { const check = () => { if (document.querySelector(".task-gantt-rich-popover")) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - s))); else requestAnimationFrame(check); }; check(); setTimeout(() => resolve(-1), 3000); }), t0));
}
out.hoverMs = med(hovers.slice(1));
// mouse move inside the popover (covered-bar check path)
const mm = await page.evaluate(async () => {
  const pop = document.querySelector(".task-gantt-rich-popover"); if (!pop) return -1; const r = pop.getBoundingClientRect(); const ts = [];
  for (let i = 0; i < 20; i++) { const s = performance.now(); pop.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 20 + i, clientY: r.top + r.height - 10 })); ts.push(performance.now() - s); }
  return ts.sort((a, b) => a - b)[10];
});
out.popoverMouseMoveMs = +mm.toFixed(2);
await page.mouse.move(5, 5); await page.waitForTimeout(500);
// neighbour (covered) hover: includes the deliberate rest timer
const nb = [];
for (let i = 0; i + 1 < Math.min(targets.length, 2 * samples + 2); i += 2) {
  await page.mouse.move(targets[i].x, targets[i].y); await page.waitForTimeout(400);
  await page.evaluate(() => { window.__pop = document.querySelector(".task-gantt-rich-popover"); });
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.move(targets[i + 1].x, targets[i + 1].y);
  nb.push(await page.evaluate((s) => new Promise((resolve) => { const check = () => { const p = document.querySelector(".task-gantt-rich-popover"); if (p && p !== window.__pop) requestAnimationFrame(() => resolve(performance.now() - s)); else requestAnimationFrame(check); }; check(); setTimeout(() => resolve(-1), 3000); }), t0));
}
out.hoverNeighbourMs = med(nb.slice(1));
await page.mouse.move(5, 5); await page.waitForTimeout(500);
// scroll frames (small steps; includes relayouts)
const sc = await page.evaluate(async () => {
  const wrap = window.__v.wrapEl; const raf = () => new Promise((r) => requestAnimationFrame(r)); await raf();
  const run = async (prop, step, n) => { const fr = []; let last = performance.now(); for (let i = 0; i < n; i++) { wrap[prop] += step; await raf(); const t = performance.now(); fr.push(t - last); last = t; } await new Promise((r) => setTimeout(r, 400)); fr.sort((a, b) => a - b); return { med: +fr[fr.length >> 1].toFixed(1), p90: +fr[Math.floor(fr.length * 0.9)].toFixed(1), max: +fr.at(-1).toFixed(1) }; };
  const x = await run("scrollLeft", 12, 40); const y = await run("scrollTop", 40, 40); return { x, y };
});
out.scrollXFrame = sc.x; out.scrollYFrame = sc.y;
// lane-window crossing + right-edge extension
out.windowCrossMs = await page.evaluate(async () => {
  const wrap = window.__v.wrapEl; const raf = () => new Promise((r) => requestAnimationFrame(r)); const r = [];
  for (let i = 0; i < 4; i++) { wrap.scrollLeft += 28 * 12; const t = performance.now(); await new Promise((rr) => setTimeout(rr, 200)); await raf(); r.push(performance.now() - t - 200); }
  return r.map((x) => +x.toFixed(0));
});
out.rangeExtendMs = await page.evaluate(async () => {
  const wrap = window.__v.wrapEl; const raf = () => new Promise((r) => requestAnimationFrame(r)); const r = [];
  for (let i = 0; i < 3; i++) { const t = performance.now(); wrap.scrollLeft = wrap.scrollWidth; await new Promise((rr) => setTimeout(rr, 50)); await raf(); await raf(); await raf(); r.push(performance.now() - t - 50); await new Promise((rr) => setTimeout(rr, 300)); }
  return r.map((x) => +x.toFixed(0));
});
// zoom: time until painted (2 frames) after the call, and time until setZoom resolves
out.zoomMs = await page.evaluate(async () => {
  const v = window.__v; const raf = () => new Promise((r) => requestAnimationFrame(r)); const z = [], p = [];
  for (const w of [20, 40, 28, 14, 28, 36, 28]) { const t = performance.now(); const pr = v.setZoom(w); let shown = -1; const check = () => { if (shown < 0 && Math.abs(parseFloat(v.wrapEl.querySelector(".task-gantt-parent-timeline")?.style.width ?? "0") - w * v.dates.length) < 1) shown = performance.now() - t; }; check(); const poll = setInterval(check, 0); await pr; clearInterval(poll); check(); await raf(); await raf(); z.push(performance.now() - t); p.push(shown); }
  const m = (xs) => +xs.slice(1).sort((a, b) => a - b)[xs.length >> 1].toFixed(0);
  return { totalMs: m(z), domUpdatedMs: m(p) };
});
// single edit: drag a mid-chart bar 3 days and back
await page.evaluate(() => {
  const v = window.__v; const orig = v.render.bind(v); window.__busy = 0;
  const busy = (fn) => async (...a) => { window.__busy++; try { return await fn(...a); } finally { window.__busy--; } };
  v.render = busy(orig); v.host.updateTaskItem = busy(v.host.updateTaskItem.bind(v.host));
});
const settle = () => page.evaluate(() => new Promise((resolve) => { const started = performance.now(); const wait = () => (window.__busy ? setTimeout(wait, 5) : requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))); wait(); }));
const drags = [];
for (let i = 0; i < samples + 1; i++) {
  await page.evaluate(() => { const d = new Date(); const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; window.__v.scrollToDate(s, 400); }); await page.waitForTimeout(500);
  const box = await page.evaluate(() => { const bars = [...document.querySelectorAll(".task-gantt-bar")].filter((b) => { const r = b.getBoundingClientRect(); return r.top > 300 && r.bottom < 900 && r.left > 300 && r.right < 1500 && r.width > 40; }); const r = bars[Math.floor(bars.length / 2)].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y); await page.mouse.down();
  const dx = (i % 2 ? -3 : 3) * 28; for (let k = 1; k <= 6; k++) await page.mouse.move(box.x + (dx * k) / 6, box.y);
  const before = await page.evaluate(() => performance.now()); await page.mouse.up(); await settle(); drags.push((await page.evaluate(() => performance.now())) - before);
  await page.waitForTimeout(300);
}
out.singleEditMs = med(drags.slice(1)); out.singleEditP90 = p90(drags.slice(1));
out.rerenderMs = med(await page.evaluate(async () => { const r = []; for (let i = 0; i < 6; i++) { const t = performance.now(); await window.__v.render(); await new Promise((x) => requestAnimationFrame(() => requestAnimationFrame(x))); r.push(performance.now() - t); } return r.slice(1); }));
out.fullRebuildMs = med(await page.evaluate(async () => { const v = window.__v; const r = []; for (let i = 0; i < 6; i++) { const t = performance.now(); v._ganttRowCache = undefined; v.renderChart(); await new Promise((x) => requestAnimationFrame(() => requestAnimationFrame(x))); r.push(performance.now() - t); } return r.slice(1); }));
await cdp.send("HeapProfiler.enable"); await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
out.heapMB = await page.evaluate(() => +(performance.memory.usedJSHeapSize / 1e6).toFixed(1));
const dc = await cdp.send("Memory.getDOMCounters"); out.domCounters = { nodes: dc.nodes, listeners: dc.jsEventListeners };
console.log(JSON.stringify(out));
await h.close();
