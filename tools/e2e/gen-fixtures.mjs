
// tools/e2e/gen-fixtures.mjs

// Generate valid mock task notes (note format v2: one note per task) with the real
// serializer from src/core/note-v2.ts via vite-node. The `obsidian` import resolves to the
// same test stub used by Vitest. Using the serializer keeps fixtures aligned
// with the saved note format.

// Fixture shape (verified against src/app/note-store.ts and
// src/app/gantt-layout.ts hasPlannedDates):
// - parent note: gantt: true, NO start/end on the parent itself
// - each parent gets one or more subtask NOTES (in a folder named like the parent) carrying
// start/end — Gantt bars render ONLY from subtask dates, so a parent without dated
// subtasks renders an empty timeline.
// - ids are stable (derived from the path), so fixtures are reproducible.

// `count` is the number of parent notes. `subtasksPerParent` defaults to 1,
// so callers that omit it receive one subtask per parent. Generation uses no randomness: given the same parent count,
// subtasks-per-parent count, and calendar date, the output is deterministic, so
// there is no seed parameter to maintain.

// Files are written under tasks/ (parent: tasks/<date> <title>.md, subtasks:
// tasks/<date> <title>/<subtask title>.md) with plain fs — this is fixture setup, not the code under test.
// generateFixtures returns every written path (each parent first, then its subtasks) and
// attaches the settings the order stores need as `.settings` ({ ganttParentOrder, subtaskOrder }).

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

/** Runs a TypeScript source file through vite-node with the same `obsidian` alias vitest.config.ts uses. */
async function withRunner(run) {
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
    return await run((file) => runner.executeFile(path.resolve(REPO_ROOT, file)));
  } finally {
    await server.close();
  }
}

/** The v2 note module (src/core/note-v2.ts) plus the stub's YAML writer. */
export async function loadNoteFormatModule() {
  return withRunner(async (load) => ({ ...(await load("src/core/note-v2.ts")), stringifyYaml: (await load("tests/stubs/obsidian.ts")).stringifyYaml }));
}

const hash = (text) => {
  let h = 5381;
  for (const ch of text) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36).padStart(6, "0").slice(-6);
};
/** Stable task id derived from a seed string: t-xxxxxx / s-xxxxxx. */
export const stableId = (kind, seed) => `${kind}-${hash(seed)}`;
const stemOf = (p) => p.split("/").pop().replace(/\.md$/, "");

/**
 * Renders one parent note and one note per subtask (v2) without writing them. `parent` and its
 * `subtasks` Map are TaskRow-shaped objects with file.path set for the parent; ids are derived from the
 * parent path and the subtask key (so they can be computed ahead of time with stableId).
 * Returns { files: { path: text }, parentId, parentPath, subs: Map(key -> { id, path }), subIds }.
 */
export function renderTaskNotes(mod, parent, subtasks = parent.subtasks ?? new Map()) {
  const parentPath = parent.file.path;
  const stem = stemOf(parentPath);
  const dir = parentPath.includes("/") ? parentPath.slice(0, parentPath.lastIndexOf("/") + 1) : "";
  const parentId = parent.id && /^t-[0-9a-z]{6}$/.test(parent.id) ? parent.id : stableId("t", parentPath);
  const files = {};
  const subs = new Map(), taken = new Set();
  for (const [key, sub] of subtasks) {
    const id = stableId("s", `${parentPath}::${key}`);
    let name = (sub.displayName || sub.title).replace(/[\\/:*?"<>|#^[\]]/g, "_"), n = 2;
    for (const base = name; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    const subPath = `${dir}${stem}/${name}.md`;
    const row = { ...sub, id, key: id, parentId, file: { path: subPath, parentPath } };
    files[subPath] = mod.buildNewNote(row, mod.stringifyYaml, { parentLink: `[[${stem}]]` });
    subs.set(key, { id, path: subPath });
  }
  files[parentPath] = mod.buildNewNote({ ...parent, id: parentId, subtasks: new Map() }, mod.stringifyYaml);
  return { files, parentId, parentPath, subs, subIds: [...subs.values()].map((sub) => sub.id) };
}

/** renderTaskNotes, then writes the notes under vaultDir (parent last). */
export function writeTaskNotes(mod, vaultDir, parent, subtasks = parent.subtasks ?? new Map()) {
  const notes = renderTaskNotes(mod, parent, subtasks);
  for (const [rel, text] of Object.entries(notes.files)) {
    const abs = path.join(vaultDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }
  return notes;
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
 * the serializer only reads properties, no class instances needed).
 */
function buildFixtureTask({ parentIndex, subtasksPerParent, today }) {
  const name = `E2E Fixture Task ${String(parentIndex + 1).padStart(4, "0")}`;
  const parentPath = `tasks/${today} ${name}.md`;
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
    subtasks.set(subtaskKey, {
      kind: "subtask",
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
      ganttEnabled: false,
      plannedStartDate: start,
      plannedEndDate: end,
    });
  }

  const parent = {
    kind: "parent",
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
    subtasks,
  };
  return { parent, subtasks };
}

/**
 * Generates `count` parent fixture notes inside `<vaultDir>/tasks/`.
 * Each parent receives `subtasksPerParent` dated subtask notes. The value defaults
 * to one, keeping the standard fixture shape for callers that omit it.
 * Returns the vault-relative paths written (each parent first, then its subtasks);
 * `.settings` holds { ganttParentOrder, subtaskOrder } for the plugin settings.
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
  if (typeof mod.buildNewNote !== "function") {
    throw new Error("buildNewNote not found in src/core/note-v2.ts — module shape changed?");
  }

  const today = localDateStr(new Date());
  const written = [];
  const settings = { ganttParentOrder: [], subtaskOrder: {} };

  for (let parentIndex = 0; parentIndex < count; parentIndex++) {
    const { parent, subtasks } = buildFixtureTask({ parentIndex, subtasksPerParent, today });
    const notes = writeTaskNotes(mod, vaultDir, parent, subtasks);
    written.push(notes.parentPath, ...[...notes.subs.values()].map((sub) => sub.path));
    settings.ganttParentOrder.push(notes.parentId);
    settings.subtaskOrder[notes.parentId] = notes.subIds;
  }
  written.settings = settings;

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
        `[gen-fixtures] wrote ${written.length} notes (${count} parents) under ${vaultDir}/tasks/ ` +
          `(${subtasksPerParent} subtasks per parent)`
      );
    } else {
      // Keep the default CLI output for scripts using one subtask per parent.
      console.log(`[gen-fixtures] wrote ${written.length} notes (${count} parents) under ${vaultDir}/tasks/`);
    }
  } catch (err) {
    console.error(`[gen-fixtures] FAILED: ${err.message}`);
    process.exit(1);
  }
}
