
// tools/e2e/gen-fixtures.mjs

// Generate valid mock task notes with the real buildFullNote serializer from
// src/core/note-format.ts via vite-node. The `obsidian` import resolves to the
// same test stub used by Vitest. Using the serializer keeps fixtures aligned
// with the saved note format.

// Fixture shape (verified against src/app/task-operations.ts and
// src/app/gantt-layout.ts hasPlannedDates):
// - parent: ganttEnabled: true, NO plannedStartDate/plannedEndDate on the
// parent itself (those are never stored on parents)
// - each parent gets one or more subtasks carrying
// plannedStartDate/plannedEndDate — Gantt bars render ONLY from subtask
// dates, so a parent without dated subtasks renders an empty timeline.

// `count` is the number of parent notes. `subtasksPerParent` defaults to 1,
// so callers that omit it receive one subtask per parent. Generation uses no randomness: given the same parent count,
// subtasks-per-parent count, and calendar date, the output is deterministic, so
// there is no seed parameter to maintain.

// Files are written under tasks/YYYY/MM/ (same layout getTaskFolderForDate
// produces) with plain fs — this is fixture setup, not the code under test.

// Requires Node >= 22 (vite/vite-node need crypto.getRandomValues).

// CLI: node tools/e2e/gen-fixtures.mjs --vault <dir> --count <n>
// [--subtasks-per-parent <n>]


import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function assertNode22() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error(
      `Node >= 22 required (found v${process.versions.node}). ` +
        `Dev machine: use ~/.nvm/versions/node/v22.23.2/bin/node. CI: actions/setup-node@v4 node-version 22.`
    );
  }
}

/**
 * Loads src/core/note-format.ts through vite-node's programmatic API with
 * the same `obsidian` alias vitest.config.ts uses. Returns the module.
 */
export async function loadNoteFormatModule() {
  const { createServer } = await import("vite");
  const { ViteNodeServer } = await import("vite-node/server");
  const { ViteNodeRunner } = await import("vite-node/client");

  // configFile:false — we don't want vite.config discovery; the alias below
  // mirrors vitest.config.ts (resolve.alias.obsidian -> tests/stubs/obsidian.ts).
  const server = await createServer({
    configFile: false,
    root: REPO_ROOT,
    logLevel: "error",
    resolve: {
      alias: {
        obsidian: path.resolve(REPO_ROOT, "tests/stubs/obsidian.ts"),
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
    return await runner.executeFile(path.resolve(REPO_ROOT, "src/core/note-format.ts"));
  } finally {
    await server.close();
  }
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDateStr(dt);
}

/**
 * Builds one parent TaskRow plus its dated subtasks (plain objects —
 * buildFullNote only reads properties, no class instances needed).
 */
function buildFixtureTask(buildFullNote, { parentIndex, subtasksPerParent, today }) {
  const name = `E2E Fixture Task ${String(parentIndex + 1).padStart(4, "0")}`;
  const parentPath = `tasks/${today.slice(0, 4)}/${today.slice(5, 7)}/${today} ${name}.md`;
  const subtasks = new Map();

  // Spread planned windows across about 125 days so many parents and subtasks
  // exercise a wide timeline. The shrink-to-fit bug requires the timeline to
  // overflow the viewport, which the default 90-day range at 28px zoom does;
  // realistic dates also ensure that bars render.
  for (let subtaskIndex = 0; subtaskIndex < subtasksPerParent; subtaskIndex++) {
    const globalIndex = parentIndex * subtasksPerParent + subtaskIndex;
    const start = addDays(today, (globalIndex % 60) - 5);
    const end = addDays(start, 2 + (globalIndex % 9));

    // One-subtask-per-parent fixtures use parent-indexed keys. Multi-subtask
    // fixtures use parent-local keys so each parent has subtask-1..subtask-N.
    const subtaskKey = subtasksPerParent === 1
      ? `subtask-${parentIndex + 1}`
      : `subtask-${subtaskIndex + 1}`;
    // Keep the default title byte-for-byte for one-subtask fixtures.
    // Numbered titles make larger fixtures easier to inspect.
    const title = subtasksPerParent === 1
      ? "Planned work"
      : `Planned work ${String(subtaskIndex + 1).padStart(3, "0")}`;
    const subtask = {
      kind: "subtask",
      id: `${parentPath}::${subtaskKey}`,
      key: subtaskKey,
      file: { path: parentPath, parentPath: parentPath, heading: title },
      title,
      displayName: title,
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
      ganttEnabled: false, // subtasks never carry ganttEnabled (note-format.ts)
      plannedStartDate: start,
      plannedEndDate: end,
    };
    subtasks.set(subtaskKey, subtask);
  }

  const parent = {
    kind: "parent",
    id: parentPath,
    file: { path: parentPath },
    title: name,
    displayName: name,
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
    ganttOrder: parentIndex,
    subtasks,
  };

  const content = buildFullNote(parent, parent.subtasks);
  return { parentPath, content, name };
}

/**
 * Generates `count` parent fixture notes inside `<vaultDir>/tasks/YYYY/MM/`.
 * Each parent receives `subtasksPerParent` dated subtasks. The value defaults
 * to one, keeping the standard fixture shape for callers that omit it.
 * Returns the list of vault-relative parent paths written.
 */
export async function generateFixtures({ vaultDir, count, subtasksPerParent = 1 }) {
  assertNode22();
  if (typeof vaultDir !== "string" || vaultDir.length === 0) {
    throw new Error("vaultDir must be a non-empty path string");
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`count must be a positive integer (found ${String(count)})`);
  }
  if (!Number.isInteger(subtasksPerParent) || subtasksPerParent <= 0) {
    throw new Error(
      `subtasksPerParent must be a positive integer (found ${String(subtasksPerParent)})`
    );
  }

  const mod = await loadNoteFormatModule();
  if (typeof mod.buildFullNote !== "function") {
    throw new Error("buildFullNote not found in src/core/note-format.ts — module shape changed?");
  }

  const today = localDateStr(new Date());
  const written = [];

  for (let parentIndex = 0; parentIndex < count; parentIndex++) {
    const { parentPath, content } = buildFixtureTask(mod.buildFullNote, {
      parentIndex,
      subtasksPerParent,
      today,
    });
    const absPath = path.join(vaultDir, parentPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
    written.push(parentPath);
  }

  return written;
}


// CLI


const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const vaultDir = get("--vault");
  const count = Number(get("--count"));
  const subtasksPerParent = Number(get("--subtasks-per-parent") ?? 1);

  if (
    !vaultDir ||
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isInteger(subtasksPerParent) ||
    subtasksPerParent <= 0
  ) {
    console.error(
      "usage: node tools/e2e/gen-fixtures.mjs --vault <dir> --count <n> " +
        "[--subtasks-per-parent <n>]"
    );
    process.exit(2);
  }

  try {
    const written = await generateFixtures({ vaultDir, count, subtasksPerParent });
    if (args.includes("--subtasks-per-parent")) {
      console.log(
        `[gen-fixtures] wrote ${written.length} task notes under ${vaultDir}/tasks/ ` +
          `(${subtasksPerParent} subtasks per parent)`
      );
    } else {
      // Keep the default CLI output for scripts using one subtask per parent.
      console.log(`[gen-fixtures] wrote ${written.length} task notes under ${vaultDir}/tasks/`);
    }
  } catch (err) {
    console.error(`[gen-fixtures] FAILED: ${err.message}`);
    process.exit(1);
  }
}
