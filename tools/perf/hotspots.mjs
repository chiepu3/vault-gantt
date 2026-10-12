// Reproducible microbenchmarks; no git or production instrumentation.
// node tools/perf/hotspots.mjs before|after
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";
import { ViteNodeServer } from "vite-node/server";
import { ViteNodeRunner } from "vite-node/client";
import { generateFixtures } from "../e2e/gen-fixtures.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const artifactDir = path.join(root, "tools/e2e/artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
const vaultDir = fs.mkdtempSync(path.join(artifactDir, "hotspots-vault-"));
const server = await createServer({
  configFile: false, root, logLevel: "error",
  resolve: { alias: { obsidian: path.join(root, "tests/stubs/obsidian.ts") } },
});
try {
  await server.pluginContainer.buildStart({});
  const node = new ViteNodeServer(server);
  const runner = new ViteNodeRunner({
    root, base: server.config.base,
    fetchModule: id => node.fetchModule(id),
    resolveId: (id, importer) => node.resolveId(id, importer),
  });
  const load = file => runner.executeFile(path.join(root, file));
  const { loadTasks } = await load("src/app/task-operations.ts");
  const { DEFAULT_SETTINGS } = await load("src/core/constants.ts");
  const { getDisplayRows, pickWorkbenchPreviewSubtask } = await load("src/app/workbench-display.ts");
  const { compareBy } = await load("src/core/utils.ts");
  const { packSubtasksIntoLanes } = await load("src/app/gantt-layout.ts");
  const { moment } = await load("tests/stubs/obsidian.ts");
  const paths = await generateFixtures({ vaultDir, count: 500, subtasksPerParent: 10 });
  const files = paths.map(p => {
    const stat = fs.statSync(path.join(vaultDir, p));
    return { path: p, stat: { mtime: stat.mtimeMs, size: stat.size } };
  });
  let reads = 0;
  const vault = {
    getFiles: () => files,
    read: file => { reads++; return fs.promises.readFile(path.join(vaultDir, file.path), "utf8"); },
  };
  const metrics = {};
  async function measure(name, fn, { setup = () => {}, batch = 1 } = {}) {
    for (let i = 0; i < 5; i++) { await setup(); await fn(); }
    const samples = [];
    const readSamples = [];
    for (let i = 0; i < 30; i++) {
      await setup();
      reads = 0;
      const start = performance.now();
      for (let j = 0; j < batch; j++) await fn();
      samples.push((performance.now() - start) / batch);
      readSamples.push(reads / batch);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    metrics[name] = {
      medianMs: (sorted[14] + sorted[15]) / 2,
      p95Ms: sorted[28], samples, readsPerInvocation: readSamples, batch,
    };
    console.log(name, JSON.stringify({ medianMs: metrics[name].medianMs, p95Ms: sorted[28], reads: readSamples[0] }));
  }
  let cache = new Map();
  await measure("load cold index (OS cache warm)", () => loadTasks(vault, DEFAULT_SETTINGS, cache), { setup: () => { cache = new Map(); } });
  await measure("load unchanged", () => loadTasks(vault, DEFAULT_SETTINGS, cache));
  await measure("load one changed revision", () => loadTasks(vault, DEFAULT_SETTINGS, cache), { setup: () => { files[0].stat.mtime++; } });
  const tasks = await loadTasks(vault, DEFAULT_SETTINGS, cache);
  const today = moment("2026-10-10", "YYYY-MM-DD", true).startOf("day");
  // Fixtures intentionally omit due dates. Add a deterministic mixed due-date
  // distribution to exercise actual strict parsing and invalid/empty buckets.
  const dates = ["2026-10-01", "2026-10-10", "2026-10-25", "", "2026-02-30", undefined];
  let index = 0;
  for (const parent of tasks) {
    for (const row of [parent, ...parent.subtasks.values()]) row.dueDate = dates[(index++ * 17) % dates.length];
  }
  const opts = { filterText: "", statusFilter: "all", showCompleted: true, sortKey: "dueDate", sortDir: "asc", flatDueSort: false, today };
  const flat = tasks.flatMap(parent => [parent, ...parent.subtasks.values()]);
  const expected = [...flat].sort((a, b) => compareBy("dueDate", "asc", a, b, today));
  if (getDisplayRows(tasks, opts).some((row, i) => row !== expected[i])) throw new Error("sort differs from compareBy");
  await measure("workbench due sort 5500 rows", () => getDisplayRows(tasks, opts));
  await measure("workbench filter 5500 rows", () => getDisplayRows(tasks, { ...opts, filterText: "planned work", sortKey: "updatedAt" }));
  const children = tasks.flatMap(parent => [...parent.subtasks.values()]);
  await measure("collapsed preview 5000 children", () => pickWorkbenchPreviewSubtask(children), { batch: 20 });
  await measure("gantt lane packing 5000 bars", () => packSubtasksIntoLanes(children));
  const label = process.argv[2] || "sample";
  const output = path.join(artifactDir, `hotspots-${label}-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify({ node: process.version, parents: 500, subtasksPerParent: 10, warmups: 5, samples: 30, metrics }, null, 2));
  console.log(output);
} finally {
  await server.close();
  fs.rmSync(vaultDir, { recursive: true, force: true });
}
