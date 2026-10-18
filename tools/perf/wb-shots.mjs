// Workbench screenshots of fixed states: node tools/perf/wb-shots.mjs <outDir> [parents] [subtasks]
import fs from "node:fs";
import { start } from "./scratch-harness.mjs";
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const parents = +(process.argv[3] ?? 50), subtasks = +(process.argv[4] ?? 100);
const h = await start({ minify: true, parents, subtasks });
const { page } = h;
await page.evaluate(async () => {
  window.vgp.app.commands.executeCommandById("vault-gantt:open-task-workbench");
  await new Promise((r) => setTimeout(r, 2500));
});
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150)))));
const setState = (s) => page.evaluate((s) => {
  const v = window.vgp.app.workspace.getLeavesOfType("task-workbench-view")[0].view;
  v.filterText = s.filter ?? ""; v.flatDueSort = !!s.flat; v.sortKey = s.sortKey ?? "updatedAt"; v.sortDir = s.sortDir ?? "desc";
  if (s.expand) v.collapsedParentIds = new Set(); else if (s.collapse) v.collapsedParentIds = new Set(v.tasks.filter((t) => t.kind === "parent").map((t) => t.id));
  v.renderTableImmediately ? v.renderTableImmediately() : v.renderTable();
  v.tableWrapEl.scrollTop = s.scroll ?? 0;
}, s);
const states = {
  collapsed: { collapse: true },
  expanded: { expand: true },
  sorted: { expand: true, sortKey: "title", sortDir: "asc" },
  filtered: { expand: true, filter: "work 05" },
  flat: { flat: true },
  midscroll: { expand: true, scroll: 20000 },
};
for (const theme of ["light", "dark"]) {
  await page.evaluate((t) => { document.body.classList.remove("theme-light", "theme-dark"); document.body.classList.add("theme-" + t); }, theme);
  for (const [name, s] of Object.entries(states)) {
    await setState(s); await frames();
    if (s.scroll) { await page.evaluate((y) => { const w = window.vgp.app.workspace.getLeavesOfType("task-workbench-view")[0].view.tableWrapEl; w.scrollTop = y; }, s.scroll); await frames(); }
    if (s.scroll) console.log(name, theme, await page.evaluate(() => { const w = window.vgp.app.workspace.getLeavesOfType("task-workbench-view")[0].view.tableWrapEl; const tr = [...w.querySelectorAll("tr.task-workbench-row")].find((t) => t.getBoundingClientRect().top > w.getBoundingClientRect().top + 40); return { st: w.scrollTop, y: tr.getBoundingClientRect().top, text: tr.textContent.slice(0, 20) }; }));
    await page.screenshot({ path: `${out}/${name}-${theme}.png` });
  }
}
await h.close();
