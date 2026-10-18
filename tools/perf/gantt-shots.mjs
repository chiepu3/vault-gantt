#!/usr/bin/env node
// Deterministic Gantt screenshots (light + dark) for before/after visual comparison.
//   NODE_PATH=/opt/node-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/perf/gantt-shots.mjs --out <dir> [--subtasks 10] [--parents 50]
// States: base, hover popover, bars crossing the left name column (sticky titles), zoom out/in, vertical scroll.
import fs from "node:fs"; import path from "node:path";
import { start } from "./perf-harness.mjs";
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const out = path.resolve(arg("out", "shots")); fs.mkdirSync(out, { recursive: true });
const parents = Number(arg("parents", 50)), subtasks = Number(arg("subtasks", 10));
for (const scheme of (arg("schemes", "light,dark")).split(",")) {
  const h = await start({ parents, subtasks, colorScheme: scheme });
  const { page } = h;
  if (arg("css", "")) await page.addStyleTag({ content: arg("css", "") });
  await page.waitForTimeout(2500);
  const shot = async (name) => { await page.mouse.move(2, 2); await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, `${scheme}-${name}.png`) }); };
  const settle = (ms = 800) => page.waitForTimeout(ms);
  await page.evaluate(() => { window.__v = window.vgp.app.workspace.getLeavesOfType("task-gantt-view")[0].view; });
  await shot("1-base");
  // bars crossing the left column: scroll so today's column sits just past the name column
  await page.evaluate(() => { const v = window.__v; const d = new Date(); const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; v.wrapEl.scrollLeft = v.dates.indexOf(s) * v.dayWidth + 90; });
  await settle(); await shot("2-left-edge");
  await page.evaluate(() => { window.__v.wrapEl.scrollLeft += 37; }); await settle(); await shot("3-left-edge-b");
  // hover popover on a bar in the middle of the viewport (popover stays; mouse not moved away)
  const pt = await page.evaluate(() => { const bars = [...document.querySelectorAll(".task-gantt-bar")].filter((b) => { const r = b.getBoundingClientRect(); return r.top > 250 && r.bottom < 900 && r.left > 450 && r.right < 1500 && r.width > 30; }); const r = bars[Math.floor(bars.length / 2)].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(900); await page.screenshot({ path: path.join(out, `${scheme}-4-hover.png`) });
  // hover on a bar crossing the left edge (title stuck)
  const pt2 = await page.evaluate(() => { const bars = [...document.querySelectorAll(".task-gantt-bar")].filter((b) => { const r = b.getBoundingClientRect(); return r.top > 300 && r.bottom < 800 && r.left < 400 && r.right > 560; }); if (!bars.length) return null; const r = bars[0].getBoundingClientRect(); return { x: Math.min(r.right - 5, 560), y: r.top + r.height / 2 }; });
  if (pt2) { await page.mouse.move(5, 5); await page.waitForTimeout(500); await page.mouse.move(pt2.x, pt2.y); await page.waitForTimeout(900); await page.screenshot({ path: path.join(out, `${scheme}-5-hover-edge.png`) }); }
  await page.mouse.move(5, 5); await page.waitForTimeout(500);
  // zoom
  await page.evaluate(() => window.__v.setZoom(14)); await settle(); await shot("6-zoom-14");
  await page.evaluate(() => window.__v.setZoom(48)); await settle(); await shot("7-zoom-48");
  await page.evaluate(() => window.__v.setZoom(28)); await settle();
  await page.evaluate(() => { window.__v.wrapEl.scrollTop = 400; }); await settle(); await shot("8-scroll-y");
  await h.close();
}
console.log("shots in", out);
