import { start } from "./scratch-harness.mjs";
const h = await start({ minify: true });
if (process.argv[2]) await h.page.addStyleTag({ content: process.argv[2] });
const { page, cdp } = h;
await page.evaluate(async () => {
  window.vgp.app.commands.executeCommandById("vault-gantt:open-task-workbench");
  await new Promise((r) => setTimeout(r, 2500));
});
const r = await page.evaluate(async () => {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const leaf = window.vgp.app.workspace.getLeavesOfType("task-workbench-view")[0];
  const v = leaf.view;
  const out = {};
  const med = (xs) => { xs = [...xs].sort((a, b) => a - b); return +xs[xs.length >> 1].toFixed(1); };
  out.rowsHierarchy = (v.displayedRows ? v.displayedRows.length : v.tableWrapEl.querySelectorAll("tr").length);
  out.domRowsHierarchy = v.tableWrapEl.querySelectorAll("tr").length; out.nodesHierarchy = v.tableWrapEl.querySelectorAll("*").length;
  const t1 = []; for (let i = 0; i < 4; i++) { const t = performance.now(); v.renderTable(); await frames(); t1.push(performance.now() - t); }
  out.renderTableHierarchyCollapsed = med(t1);
  const t2 = []; for (let i = 0; i < 4; i++) { const t = performance.now(); await v.render(); await frames(); t2.push(performance.now() - t); }
  out.fullRenderHierarchyCollapsed = med(t2);
  // expand everything
  v.collapsedParentIds = new Set();
  const t3 = []; for (let i = 0; i < 4; i++) { const t = performance.now(); v.renderTable(); await frames(); t3.push(performance.now() - t); }
  out.renderTableExpanded = med(t3); out.domRowsExpanded = v.tableWrapEl.querySelectorAll("tr").length; out.rowsExpanded = (v.displayedRows ? v.displayedRows.length : v.tableWrapEl.querySelectorAll("tr").length); out.nodesExpanded = v.tableWrapEl.querySelectorAll("*").length;
  const sync = []; for (let i = 0; i < 4; i++) { const t = performance.now(); v.renderTable(); sync.push(performance.now() - t); await frames(); }
  out.renderTableExpandedJSOnly = med(sync);
  // filter keystroke
  v.filterText = "work 05";
  const t4 = []; for (let i = 0; i < 4; i++) { const t = performance.now(); v.renderTable(); await frames(); t4.push(performance.now() - t); }
  out.renderTableFilteredExpanded = med(t4); out.rowsFiltered = (v.displayedRows ? v.displayedRows.length : v.tableWrapEl.querySelectorAll("tr").length);
  v.filterText = ""; v.flatDueSort = true;
  const t5 = []; for (let i = 0; i < 4; i++) { const t = performance.now(); v.renderTable(); await frames(); t5.push(performance.now() - t); }
  out.renderTableFlat = med(t5); out.rowsFlat = (v.displayedRows ? v.displayedRows.length : v.tableWrapEl.querySelectorAll("tr").length);
  return out;
});
console.log(JSON.stringify(r, null, 1));
await cdp.send("HeapProfiler.enable"); await cdp.send("HeapProfiler.collectGarbage");
console.log("heap MB w/ workbench open", await page.evaluate(() => (performance.memory.usedJSHeapSize / 1e6).toFixed(1)));
console.log(JSON.stringify(await cdp.send("Memory.getDOMCounters")));
await h.close();
