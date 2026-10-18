// Workbench interaction timings (sync JS + forced layout, so no rAF floor):
//   node tools/perf/wb-interactions.mjs
import { start } from "./scratch-harness.mjs";
const h = await start({ minify: true });
const { page } = h;
await page.evaluate(async () => {
  window.vgp.app.commands.executeCommandById("vault-gantt:open-task-workbench");
  await new Promise((r) => setTimeout(r, 2500));
});
const r = await page.evaluate(async () => {
  const v = window.vgp.app.workspace.getLeavesOfType("task-workbench-view")[0].view;
  const med = (xs) => { xs = [...xs].sort((a, b) => a - b); return +xs[xs.length >> 1].toFixed(1); };
  const timeIt = (fn, n = 5) => { const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); fn(i); void v.tableWrapEl.offsetHeight; xs.push(performance.now() - t); } return { med: med(xs), first: +xs[0].toFixed(1) }; };
  const out = {};
  out.collapsed = timeIt(() => v.renderTable());
  v.collapsedParentIds = new Set();
  out.expanded = timeIt(() => v.renderTable());
  const parents = v.tasks.filter((t) => t.kind === "parent");
  // fold toggle (collapse + expand one parent)
  out.foldToggle = timeIt((i) => { v.toggleParentExpanded(v.displayedRows[0]); });
  v.collapsedParentIds = new Set();
  out.filterKeystroke = timeIt((i) => { v.filterText = i % 2 ? "work 05" : "work 051"; v.resetScrollOnRender = true; v.renderTable(); });
  v.filterText = "";
  out.sortChange = timeIt((i) => { v.sortKey = i % 2 ? "title" : "dueDate"; v.renderTable(); });
  v.sortKey = "updatedAt"; v.flatDueSort = true;
  out.flatDue = timeIt(() => v.renderTable());
  // scroll
  const w = v.tableWrapEl;
  const xs = [];
  for (let y = 0; y < 60000; y += 700) { const t = performance.now(); w.scrollTop = y; await new Promise((r) => requestAnimationFrame(r)); xs.push(performance.now() - t); }
  out.scrollFrameMedian = med(xs); out.scrollFrameMax = +Math.max(...xs).toFixed(1);
  const ys = [];
  for (let y = 30000; y < 33000; y += 100) { const t = performance.now(); w.scrollTop = y; await new Promise((r) => requestAnimationFrame(r)); ys.push(performance.now() - t); }
  out.smoothScrollFrameMedian = med(ys); out.smoothScrollFrameMax = +Math.max(...ys).toFixed(1);
  // single-row edit
  out.editOneRow = timeIt((i) => { const row = v.displayedRows[5]; row.currentStatus = "edit " + i; v.renderTable(); });
  out.domRows = v.tableWrapEl.querySelectorAll("tr").length;
  out.rows = v.displayedRows.length;
  return out;
});
console.log(JSON.stringify(r, null, 1));
await h.close();
