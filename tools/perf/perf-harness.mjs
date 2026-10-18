// Shared harness for the Gantt perf scripts: builds the web-preview bundle, serves it, seeds a large in-memory vault
// (the preview's localStorage cap is bypassed with an in-memory Storage) and returns a Playwright page.
//   NODE_PATH=/opt/node-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { execFileSync } from "node:child_process"; import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
import { generateFixtures } from "../e2e/gen-fixtures.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const repo = path.resolve(here, "../..");
const { chromium } = createRequire(import.meta.url)("playwright");
export async function start({ before = null, parents = 50, subtasks = 100, minify = true, wait = true, throttle = 1, colorScheme = "light", settings = {} } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vg-h-")); const site = path.join(work, "site"), vault = path.join(work, "vault");
  execFileSync("node", [path.join(repo, "tools/web-preview/build.mjs"), "--app", repo, "--out", site, "--label", "bench", "--sha", "bench", "--minify", String(minify)], { stdio: "ignore" });
  const paths = await generateFixtures({ vaultDir: vault, count: parents, subtasksPerParent: subtasks });
  const files = Object.fromEntries(paths.map((p) => [p, fs.readFileSync(path.join(vault, p), "utf8")]));
  const store = { files, data: { taskFolder: "tasks", ganttZoom: 28, ganttNationalHolidaysUpdatedAt: "2099-01-01", ...settings }, secrets: {} };
  const server = http.createServer((req, res) => { const p = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html")); if (!p.startsWith(site) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css" : "text/html" }); res.end(fs.readFileSync(p)); }).listen(0);
  const browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme });
  await page.addInitScript((s) => { const m = new Map(); m.set("vgp:data:bench:bench", JSON.stringify(s)); Storage.prototype.getItem = function (k) { return m.has(k) ? m.get(k) : null; }; Storage.prototype.setItem = function (k, v) { if (k.startsWith("vgp:data")) return; m.set(k, String(v)); }; Storage.prototype.removeItem = function (k) { m.delete(k); }; }, store);
  const cdp = await page.context().newCDPSession(page);
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  if (before) await before({ page, cdp });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (wait) await page.waitForFunction((n) => document.querySelectorAll(".task-gantt-bar").length >= n, Math.min(parents * subtasks, 200), { timeout: 120000 });
  return { page, cdp, browser, files, paths, vault, close: async () => { await browser.close(); server.close(); fs.rmSync(work, { recursive: true, force: true }); } };
}
