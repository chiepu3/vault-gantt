// usage: verify-resize-edges.mjs -- the bar edge zones (::before/::after) give the resize cursor, and dragging an edge resizes the bar.
import { start } from "./perf-harness.mjs";
const h = await start({ subtasks: 10 });
const { page } = h;
await page.waitForTimeout(1000);
const info = await page.evaluate(() => {
  const bar = [...document.querySelectorAll(".task-gantt-bar")].find((b) => { const r = b.getBoundingClientRect(); return r.top > 300 && r.bottom < 900 && r.left > 400 && r.right < 1400 && r.width > 60; });
  const r = bar.getBoundingClientRect();
  const cs = (p) => { const c = getComputedStyle(bar, p); return { cursor: c.cursor, width: c.width, height: c.height, content: c.content, position: c.position }; };
  return { x: r.left, y: r.top + r.height / 2, w: r.width, before: cs("::before"), after: cs("::after"), children: [...bar.children].map((c) => c.className), id: bar.dataset.taskId ?? null };
});
console.log(JSON.stringify(info));
const bars = () => page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x + 5, y); const b = el.closest(".task-gantt-bar"); const r = b.getBoundingClientRect(); return { left: r.left, width: r.width }; }, { x: info.x, y: info.y });
const before = await bars();
await page.mouse.move(info.x + info.w - 2, info.y); await page.mouse.down(); await page.mouse.move(info.x + info.w - 2 + 56, info.y, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(800);
const afterRight = await bars();
console.log(JSON.stringify({ before, afterRight }));
await h.close();
