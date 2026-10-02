
// tools/e2e/scenarios/drag-fixture.mjs


// scenarios, plus small frontmatter-reading helpers so scenarios can assert
// against the SAVED FILE ON DISK rather than trusting in-memory view.tasks
// state.

// Why deterministic dates, and why this is NOT the same problem
// tests/ui/task-gantt-view.test.ts solved with vi.useFakeTimers:
// that suite fakes the wall clock itself, which is unavailable here — this
// harness drives a REAL headless Obsidian process against the REAL system
// clock (no fake-timer hook exists inside the plugin's real runtime). The
// equivalent guard here is choosing fixture dates whose weekday properties
// are known in advance relative to whatever "today" the harness actually
// runs on, computed fresh at run time from `new Date`.

// Fixture dates follow the production business-day rules: Sunday is
// non-working, Saturday is a business day, and configured holidays are skipped.
// A move across a weekend can extend the end date beyond calendar-day math.
//
// The harness prevents automatic national holidays from affecting these tests
// by seeding the fresh vault with an update timestamp. That placeholder date is
// outside every fixture range, so only weekday rules affect the dates tested.
//
// pickAnchorMonday starts each fixture on the next Monday at least
// minDaysFromToday days ahead. The short Monday-start durations keep
// fixture dates on business days. Post-drag dates are calculated by the real
// production functions loaded below, so expectations cannot drift from them.


import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNoteFormatModule } from "../gen-fixtures.mjs";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toIso(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysToDate(d, days) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** @see module docblock. Returns a real Date object (local time, midnight). */
export function pickAnchorMonday({ minDaysFromToday = 20 } = {}) {
  let d = addDaysToDate(new Date(), minDaysFromToday);
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 1) {
    // 0=Sunday..6=Saturday; 1=Monday
    d = addDaysToDate(d, 1);
  }
  return d;
}

export function toIsoStr(d) {
  return toIso(d);
}

export function addDaysIso(iso, days) {
  const [y, m, dd] = iso.split("-").map(Number);
  return toIso(addDaysToDate(new Date(y, m - 1, dd), days));
}

/** Whole-day difference (end - start), matching src/app/gantt-layout.ts's diffDays convention. */
export function diffDaysIso(startIso, endIso) {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000
  );
}


















export async function loadGanttDragModules() {
  const { createServer } = await import("vite");
  const { ViteNodeServer } = await import("vite-node/server");
  const { ViteNodeRunner } = await import("vite-node/client");

  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".."
  );

  // configFile:false — we don't want vite.config discovery; the alias below
  // mirrors vitest.config.ts (resolve.alias.obsidian -> tests/stubs/obsidian.ts).
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    logLevel: "error",
    resolve: {
      alias: {
        obsidian: path.resolve(repoRoot, "tests/stubs/obsidian.ts"),
      },
    },
  });
  await server.pluginContainer.buildStart({});

  try {
    const node = new ViteNodeServer(server);
    const runner = new ViteNodeRunner({
      root: server.config.root,
      base: server.config.base,
      fetchModule: (id) => node.fetchModule(id),
      resolveId: (id, importer) => node.resolveId(id, importer),
    });
    const ganttDrag = await runner.executeFile(
      path.resolve(repoRoot, "src/app/gantt-drag.ts")
    );
    const ganttLayout = await runner.executeFile(
      path.resolve(repoRoot, "src/app/gantt-layout.ts")
    );
    const required = {
      "gantt-drag.moveBarByCalendarDelta": ganttDrag.moveBarByCalendarDelta,
      "gantt-drag.snapResizeStart": ganttDrag.snapResizeStart,
      "gantt-drag.snapResizeEnd": ganttDrag.snapResizeEnd,
      "gantt-drag.countWorkingDaysInclusive": ganttDrag.countWorkingDaysInclusive,
      "gantt-drag.addWorkingDays": ganttDrag.addWorkingDays,
      "gantt-drag.isBusinessDay": ganttDrag.isBusinessDay,
      "gantt-layout.addDays": ganttLayout.addDays,
    };
    for (const [name, fn] of Object.entries(required)) {
      if (typeof fn !== "function") {
        throw new Error(
          `${name} not found in src/ — module shape changed?`
        );
      }
    }
    return { ganttDrag, ganttLayout };
  } finally {
    await server.close();
  }
}

/**
 * Writes one gantt-enabled parent task with exactly one dated subtask to
 * `vaultDir`, via the REAL buildFullNote serializer (same technique
 * gen-fixtures.mjs uses for its bulk fixtures — see that file's header for
 * why hand-written frontmatter was proven fragile). Deliberately NOT added
 * to gen-fixtures.mjs itself: these scenarios need a single task with
 * caller-chosen exact dates/name/status, which doesn't fit gen-fixtures'
 * bulk "spread N tasks across a wide timeline" shape.
 */
export async function writeDragFixture({
  vaultDir,
  parentName,
  subtaskName = "Planned work",
  startDate,
  endDate,
  statusLabel = "active",
}) {
  const { buildFullNote } = await loadNoteFormatModule();
  const today = toIsoStr(new Date());
  const parentPath = `tasks/${today.slice(0, 4)}/${today.slice(5, 7)}/${today} ${parentName}.md`;
  const subtaskKey = "subtask-1";

  const subtask = {
    kind: "subtask",
    id: `${parentPath}::${subtaskKey}`,
    key: subtaskKey,
    file: { path: parentPath, parentPath, heading: subtaskName },
    title: subtaskName,
    displayName: subtaskName,
    statusLabel,
    completed: false,
    createdAt: today,
    updatedAt: today,
    dueDate: undefined,
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false, // subtasks never carry ganttEnabled (note-format.ts)
    plannedStartDate: startDate,
    plannedEndDate: endDate,
  };

  const parent = {
    kind: "parent",
    id: parentPath,
    file: { path: parentPath },
    title: parentName,
    displayName: parentName,
    statusLabel: "active",
    completed: false,
    createdAt: today,
    updatedAt: today,
    dueDate: undefined,
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: true,
    ganttOrder: 0,
    subtasks: new Map([[subtaskKey, subtask]]),
  };

  const content = buildFullNote(parent, parent.subtasks);
  const absPath = path.join(vaultDir, parentPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");

  return { parentPath, absPath, subtaskKey };
}

/**
 * Reads a single flat `key: value` frontmatter line (buildFrontmatter's
 * format — src/core/note-format.ts), stripping a surrounding quote pair if
 * present. Returns undefined if the key is absent. This is not a general YAML
 * parser; it matches the flat key:value frontmatter format used by this
 * codebase, rather than nested YAML.
 */
export function readFrontmatterField(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escaped}: (.*)$`, "m"));
  if (!match) {
    return undefined;
  }
  let value = match[1].trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Polls the file at `absPath` until frontmatter key `key` equals `expected`,
 * or throws with the last-seen value on timeout. This IS the "settle" point
 * scenarios wait on after a drag/save: only once the write has actually
 * landed on disk is it safe to treat the gesture as fully resolved (and, for
 * multi-drag scenarios, safe to start the next one — see cdp-input.mjs's
 * dragGesture isolation warning).
 */
export async function waitForFrontmatterField(
  absPath,
  key,
  expected,
  { timeoutMs = 15000, intervalMs = 200, label } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const content = fs.readFileSync(absPath, "utf8");
    last = readFrontmatterField(content, key);
    if (last === expected) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for frontmatter ${label ?? key} === ${JSON.stringify(expected)} ` +
          `(last seen: ${JSON.stringify(last)})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
