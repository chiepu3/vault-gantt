import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const headSha = process.env.PERF_HEAD_SHA;
const baseSha = process.env.PERF_BASE_SHA;
const runs = Number(process.env.PERF_RUNS ?? "3");
const shapeArgs = ["--parents", "500", "--subtasks-per-parent", "1"];

if (!/^[0-9a-f]{7,40}$/i.test(headSha ?? "") || !/^[0-9a-f]{7,40}$/i.test(baseSha ?? "")) {
  throw new Error("PERF_HEAD_SHA and PERF_BASE_SHA must be commit SHAs");
}
if (!Number.isInteger(runs) || runs < 2) {
  throw new Error("PERF_RUNS must be an integer >= 2");
}

const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
const tempRoot = fs.mkdtempSync(path.join(runnerTemp, "vault-gantt-perf-"));
const resultDir = path.join(runnerTemp, "vault-gantt-perf-results");
fs.mkdirSync(resultDir, { recursive: true });

function run(command, args, cwd, label) {
  console.log(`[perf-compare] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}: exited with status ${result.status}`);
}

function latestBenchmarkArtifact(worktree) {
  const dir = path.join(worktree, "tools", "e2e", "artifacts");
  const files = fs.readdirSync(dir)
    .filter((name) => /^perf-benchmark-500x1-default-.*\.json$/u.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No benchmark artifact found in ${dir}`);
  return path.join(dir, files[0].name);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function metricSamples(artifacts, view, metric) {
  return artifacts.flatMap((artifact) =>
    artifact.metrics?.[view]?.[metric]?.warmSamples?.map((sample) => sample.durationMs) ?? []
  );
}

const revisions = [
  { key: "head", sha: headSha },
  { key: "base", sha: baseSha },
];
const worktrees = new Map();
const artifacts = new Map(revisions.map(({ key }) => [key, []]));

try {
  run("git", ["fetch", "--no-tags", "origin", headSha, baseSha], repoRoot, "fetch source SHAs");
  for (const revision of revisions) {
    const worktree = path.join(tempRoot, revision.key);
    run("git", ["worktree", "add", "--detach", worktree, revision.sha], repoRoot, `add ${revision.key} worktree`);
    worktrees.set(revision.key, worktree);
    run("npm", ["ci"], worktree, `${revision.key} npm ci`);
    run("npm", ["run", "build"], worktree, `${revision.key} build`);
  }

  // Alternate the first revision to reduce systematic warm-cache/order effects.
  for (let iteration = 0; iteration < runs; iteration++) {
    const order = iteration % 2 === 0 ? ["head", "base"] : ["base", "head"];
    for (const key of order) {
      const worktree = worktrees.get(key);
      run(process.execPath, ["tools/e2e/perf-benchmark.mjs", ...shapeArgs], worktree, `${key} benchmark ${iteration + 1}/${runs}`);
      const source = latestBenchmarkArtifact(worktree);
      const destination = path.join(resultDir, `${key}-run-${String(iteration + 1).padStart(2, "0")}.json`);
      fs.copyFileSync(source, destination);
      artifacts.get(key).push(JSON.parse(fs.readFileSync(source, "utf8")));
    }
  }

  const metrics = {};
  for (const key of ["head", "base"]) {
    metrics[key] = {};
    for (const [view, metricNames] of Object.entries({
      gantt: ["horizontalRangeExtension", "warmInitialRender", "taskEdit", "zoomIn", "holidayToggle"],
      workbench: ["warmInitialRender", "filterKeystroke", "inlineEdit", "sortChange"],
    })) {
      for (const metric of metricNames) {
        const samples = metricSamples(artifacts.get(key), view, metric);
        if (samples.length === 0) continue;
        metrics[key][`${view}.${metric}`] = {
          samples: samples.length,
          medianMs: median(samples),
          p95Ms: p95(samples),
          rawWarmSamplesMs: samples,
        };
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: { headSha, baseSha },
    shape: { parents: 500, subtasksPerParent: 1, totalSubtasks: 500 },
    runsPerRevision: runs,
    order: Array.from({ length: runs }, (_, index) => index % 2 === 0 ? ["head", "base"] : ["base", "head"]),
    metrics,
  };
  const summaryPath = path.join(resultDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[perf-compare] summary: ${summaryPath}`);
  for (const key of ["head", "base"]) {
    const metric = metrics[key]["gantt.horizontalRangeExtension"];
    console.log(`[perf-compare] ${key} horizontalRangeExtension: ${metric.medianMs.toFixed(2)} ms median, ${metric.p95Ms.toFixed(2)} ms p95, n=${metric.samples}`);
  }
} finally {
  for (const worktree of worktrees.values()) {
    try {
      run("git", ["worktree", "remove", "--force", worktree], repoRoot, `remove ${worktree}`);
    } catch (error) {
      console.error(`[perf-compare] worktree cleanup failed: ${error.message}`);
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
