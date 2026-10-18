#!/usr/bin/env node
// Verifies the class-toggled sticky titles place every bar title exactly where always-sticky titles would.
//   NODE_PATH=/opt/node-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/perf/verify-sticky-titles.mjs [--subtasks 10]
import { start } from "./perf-harness.mjs";
const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const h = await start({ parents: 20, subtasks: Number(arg("subtasks", 10)) });
const { page } = h;
await page.waitForTimeout(2000);
const res = await page.evaluate(async () => {
  const v = window.vgp.app.workspace.getLeavesOfType("task-gantt-view")[0].view; const wrap = v.wrapEl; const raf = () => new Promise((r) => requestAnimationFrame(r));
  const wr = wrap.getBoundingClientRect();
  const snap = () => [...document.querySelectorAll(".task-gantt-bar-title")].filter((t) => { const r = t.getBoundingClientRect(); return r.bottom > wr.top - 250 && r.top < wr.bottom + 250; }).map((t) => { const r = t.getBoundingClientRect(); return [Math.round(r.left * 100) / 100, Math.round(r.width * 100) / 100, t.textContent]; });
  const style = document.createElement("style"); style.textContent = ".task-gantt-bar-title{position:sticky!important;left:326px!important;transform:none!important}";
  let mismatches = 0, checked = 0, stuck = 0; const examples = [];
  const stuckCount = () => [...document.querySelectorAll(".task-gantt-bar-title")].filter((t) => t.style.transform).length;
  const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; const base = v.dates.indexOf(today) * v.dayWidth;
  for (const off of [-100, 0, 100, 337, 560, 700, 811, 1000, 1234, 1500]) { const sl = base + off;
    wrap.scrollLeft = sl; await raf(); await raf(); await new Promise((r) => setTimeout(r, 400));
    const a = snap(); const n = stuckCount(); stuck = Math.max(stuck, n);
    document.head.appendChild(style); await raf(); await raf(); const b = snap(); style.remove(); await raf();
    if (a.length !== b.length || a.some((x, i) => x[2] !== b[i][2])) { mismatches += 1; examples.push(["len", sl, a.length, b.length]); continue; }
    for (let i = 0; i < a.length; i++) { if (a[i][0] + a[i][1] <= 320 && b[i][0] + b[i][1] <= 320) continue; /* fully under the opaque name column */ checked++; if (Math.abs(a[i][0] - b[i][0]) > 0.01 || Math.abs(a[i][1] - b[i][1]) > 0.01) { mismatches++; if (examples.length < 8) examples.push([sl, i, a[i], b[i]]); } }
  }
  return { checked, mismatches, maxStuckBars: stuck, totalBars: document.querySelectorAll(".task-gantt-bar").length, examples };
});
console.log(JSON.stringify(res));
await h.close();
process.exit(res.mismatches ? 1 : 0);
