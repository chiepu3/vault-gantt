import fs from "node:fs";
import { start } from "./scratch-harness.mjs";
const h = await start({ minify: false });
const { page, cdp } = h;
await page.evaluate(async () => {
  window.vgp.app.commands.executeCommandById("vault-gantt:open-task-workbench");
  await new Promise((r) => setTimeout(r, 2500));
  const v = window.vgp.app.workspace.getLeavesOfType("task-workbench-view")[0].view; v.collapsedParentIds = new Set(); window.__wb = v;
});
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start");
await page.evaluate(async () => { for (let i = 0; i < 12; i++) { window.__wb.filterText = i % 2 ? "work 05" : "work 051"; window.__wb.renderTable(); void window.__wb.tableWrapEl.offsetHeight; } });
const { profile } = await cdp.send("Profiler.stop");
const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i] / 1000); });
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${v.toFixed(0)}ms ${k}`).join("\n"));
await h.close();
