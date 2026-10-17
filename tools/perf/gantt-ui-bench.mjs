#!/usr/bin/env node
// Browser benchmark for Gantt interactions with a large vault (default 50 parents x 10 subtasks).
// Runs the real plugin through the web-preview shim in headless Chromium, so it needs no Obsidian.
//   NODE_PATH=/opt/node-tools/node_modules node tools/perf/gantt-ui-bench.mjs [--app <checkout>] [--parents 50] [--subtasks 10]
//     [--samples 7] [--throttle <CPU slowdown, e.g. 4>] [--read-latency <ms per vault.read, default 1>] [--phases] [--dom]
//     [--profile <out.cpuprofile> | --trace <out.json>] [--profile-scenario hover|drag|reorder|rerender|full]
// The preview vault lives in memory; --read-latency adds a per-read delay so file reads cost something, as on disk.
// --app defaults to this checkout. Prints median/p90 ms per scenario as JSON.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { generateFixtures } from "../e2e/gen-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const appDir = path.resolve(arg("app", repo));
const parents = Number(arg("parents", 50)), subtasks = Number(arg("subtasks", 10)), samples = Number(arg("samples", 7));
const profileOut = arg("profile"), throttle = Number(arg("throttle", 1)), readLatency = Number(arg("read-latency", 1));
const { chromium } = createRequire(import.meta.url)("playwright");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vg-bench-"));
const site = path.join(work, "site"), vault = path.join(work, "vault");
execFileSync("node", [path.join(repo, "tools/web-preview/build.mjs"), "--app", appDir, "--out", site, "--label", "bench", "--sha", "bench", "--minify", profileOut ? "false" : "true"], { stdio: "inherit" });
const paths = await generateFixtures({ vaultDir: vault, count: parents, subtasksPerParent: subtasks });
const files = Object.fromEntries(paths.map((p) => [p, fs.readFileSync(path.join(vault, p), "utf8")]));
const store = { files, data: { taskFolder: "tasks", ganttZoom: 28, ganttNationalHolidaysUpdatedAt: "2099-01-01" }, secrets: {} };

const server = http.createServer((req, res) => {
  const p = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!p.startsWith(site) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css" : "text/html" });
  res.end(fs.readFileSync(p));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: +s[Math.floor(s.length / 2)].toFixed(1), p90: +s[Math.min(s.length - 1, Math.floor(s.length * 0.9))].toFixed(1), n: s.length }; };
const result = { app: appDir, parents, subtasks, throttle, readLatency };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript((s) => { localStorage.setItem("vgp:data:bench:bench", JSON.stringify(s)); }, store);
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction((n) => document.querySelectorAll(".task-gantt-bar").length >= n, Math.min(parents * subtasks, 200), { timeout: 120000 });
  result.openMs = Date.now() - t0;
  result.bars = await page.locator(".task-gantt-bar").count();
  result.domNodes = await page.evaluate(() => document.querySelectorAll(".task-gantt-container *").length);
  if (argv.includes("--dom")) result.domByClass = await page.evaluate(() => { const m = {}; for (const el of document.querySelectorAll(".task-gantt-container *")) { const k = el.classList[0] ?? el.tagName; m[k] = (m[k] ?? 0) + 1; } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15)); });

  // Instrument the view: every render() resolves a promise we can await, and the end time is the next frame after it.
  await page.evaluate((ms) => {
    window.__view = window.vgp.app.workspace.getLeavesOfType("task-gantt-view")[0].view;
    const vault = window.vgp.app.vault; const read = vault.read.bind(vault); window.__reads = 0;
    // MessageChannel instead of setTimeout: nested timers clamp to 4ms, which would overstate the delay.
    const ch = new MessageChannel(), queue = []; ch.port1.onmessage = () => { const now = performance.now(); while (queue.length && queue[0].at <= now) queue.shift().resolve(); if (queue.length) ch.port2.postMessage(0); };
    const delay = () => new Promise((resolve) => { queue.push({ at: performance.now() + ms, resolve }); if (queue.length === 1) ch.port2.postMessage(0); });
    vault.read = async (f) => { window.__reads++; if (ms > 0) await delay(); return read(f); };
  }, readLatency);
  const cdp = profileOut || throttle > 1 ? await page.context().newCDPSession(page) : null;
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  // Profiles only the scenario named by --profile-scenario (default: drag).
  const profileScenario = arg("profile-scenario", "drag");
  const traceOut = arg("trace");
  const profiled = async (name, fn) => {
    if (traceOut && name === profileScenario) { await browser.startTracing(page, { path: traceOut, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] }); await fn(); await browser.stopTracing(); result.trace = traceOut; return; }
    const on = profileOut && name === profileScenario;
    if (on) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); await cdp.send("Profiler.start"); }
    await fn();
    if (on) { const { profile } = await cdp.send("Profiler.stop"); fs.writeFileSync(profileOut, JSON.stringify(profile)); result.profile = profileOut; }
  };

  // Drag a mid-chart bar 3 days right and back, timing pointerup -> the render it triggers has painted.
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    const started = performance.now();
    const wait = () => (window.__busy ? setTimeout(wait, 5) : requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started))));
    wait();
  }));
  await page.evaluate(() => {
    const v = window.__view; const orig = v.render.bind(v);
    window.__busy = 0;
    const busy = (fn) => async (...a) => { window.__busy++; try { return await fn(...a); } finally { window.__busy--; } };
    v.render = busy(orig);
    v.host.updateTaskItem = busy(v.host.updateTaskItem.bind(v.host));
  });
  async function dragOnce(dx) {
    const box = await page.evaluate(() => {
      const bars = [...document.querySelectorAll(".task-gantt-bar")].filter((b) => { const r = b.getBoundingClientRect(); return r.top > 300 && r.bottom < 900 && r.left > 300 && r.right < 1500 && r.width > 40; });
      const r = bars[Math.floor(bars.length / 2)].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + (dx * i) / 6, box.y);
    const before = await page.evaluate(() => performance.now());
    await page.mouse.up();
    await settle();
    return (await page.evaluate(() => performance.now())) - before;
  }
  if (argv.includes("--phases")) await page.evaluate(() => {
    // Wrap the async steps a UI save goes through so --phases can report where drag time goes.
    window.__phases = {};
    const wrap = (obj, name, label) => { const orig = obj[name].bind(obj); obj[name] = async (...a) => { const t = performance.now(); try { return await orig(...a); } finally { (window.__phases[label] ??= []).push(performance.now() - t); } }; };
    const { plugin } = window.vgp; const v = window.__view;
    wrap(plugin.operations, "plan", "registry.plan"); wrap(plugin.operations, "commit", "registry.commit");
    wrap(plugin, "refreshOpenViews", "refreshOpenViews"); wrap(v.host, "loadTasks", "view.loadTasks");
    const lt = v.host.loadTasks; v.host.loadTasks = async () => { const r0 = window.__reads; try { return await lt(); } finally { (window.__phases["view.loadTasks reads"] ??= []).push(window.__reads - r0); } };
    const rc = v.renderChart.bind(v); v.renderChart = () => { const t = performance.now(); rc(); (window.__phases.renderChart ??= []).push(performance.now() - t); };
  });
  // Hover: move from one bar onto a neighbouring bar and time until the new bar's popover is in the DOM and painted.
  const hovers = [];
  await profiled("hover", async () => {
    const targets = await page.evaluate((n) => [...document.querySelectorAll(".task-gantt-bar")].map((b) => b.getBoundingClientRect()).filter((r) => r.top > 300 && r.bottom < 900 && r.left > 300 && r.right < 1500 && r.width > 40).slice(0, n).map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), 2 * (samples + 1) + 2);
    for (let i = 0; i + 1 < targets.length && hovers.length < samples + 1; i += 2) {
      await page.mouse.move(targets[i].x, targets[i].y); await page.waitForTimeout(400);
      await page.evaluate(() => { window.__pop = document.querySelector(".task-gantt-rich-popover"); });
      const t = await page.evaluate(() => performance.now());
      await page.mouse.move(targets[i + 1].x, targets[i + 1].y);
      hovers.push(await page.evaluate((t0) => new Promise((resolve) => {
        const check = () => { const p = document.querySelector(".task-gantt-rich-popover"); if (p && p !== window.__pop) requestAnimationFrame(() => resolve(performance.now() - t0)); else requestAnimationFrame(check); };
        check(); setTimeout(() => resolve(-1), 3000);
      }), t));
    }
    await page.mouse.move(5, 5); await page.waitForTimeout(400);
  });
  result.hoverNeighbourMs = stats(hovers.slice(1));
  const dayW = 28;
  const drags = [], dragReads = [];
  await profiled("drag", async () => { for (let i = 0; i < samples + 1; i++) {
    const r0 = await page.evaluate(() => window.__reads);
    drags.push(await dragOnce(i % 2 ? -3 * dayW : 3 * dayW)); await page.waitForTimeout(300);
    dragReads.push((await page.evaluate(() => window.__reads)) - r0);
  } });
  result.dragDropMs = stats(drags.slice(1));
  result.fileReadsPerDrag = stats(dragReads.slice(1)).median;
  if (argv.includes("--phases")) { result.dragPhases = Object.fromEntries(Object.entries(await page.evaluate(() => window.__phases)).map(([k, xs]) => [k, { calls: xs.length, ...stats(xs) }])); await page.evaluate(() => { window.__phases = {}; }); }

  // Reorder parents: move the 3rd parent onto the 20th and back (the same call the row drag-and-drop makes).
  const reorders = [], reorderReads = [];
  await profiled("reorder", async () => { for (let i = 0; i < samples + 1; i++) reorderReads.push(-(await page.evaluate(() => window.__reads))), reorders.push(await page.evaluate(async (flip) => {
    const v = window.__view; const ids = [...v._ganttRowCache.rowEls.keys()];
    const [a, b] = flip ? [ids[19], ids[2]] : [ids[2], ids[19]];
    const t = performance.now(); v.dragParentId = a; await v.handleParentDrop(b);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t;
  }, i % 2 === 1)); });
  result.parentReorderMs = stats(reorders.slice(1));
  await page.waitForTimeout(500);
  reorderReads[reorderReads.length - 1] += await page.evaluate(() => window.__reads);
  result.fileReadsLastReorder = reorderReads.at(-1);
  // A plain re-render with no data change (what every other view refresh costs).
  const renders = [];
  await profiled("rerender", async () => { for (let i = 0; i < samples + 1; i++) renders.push(await page.evaluate(async () => { const t = performance.now(); await window.__view.render(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; })); });
  result.rerenderNoChangeMs = stats(renders.slice(1));

  // Full rebuild (zoom changes, filters, range extension take this path).
  const fulls = [];
  await profiled("full", async () => { for (let i = 0; i < samples + 1; i++) fulls.push(await page.evaluate(async () => { const v = window.__view; const t = performance.now(); v._ganttRowCache = undefined; v.renderChart(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; })); });
  result.fullRebuildMs = stats(fulls.slice(1));

} finally {
  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
