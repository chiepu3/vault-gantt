import { stringifyYaml } from "obsidian";
import {
  TaskRow,
  TaskPatch,
  TaskWorkbenchSettings,
  TaskUpdateCommand,
  TaskUpdateResult,
} from "../core/types";

import {
  todayStr,
  buildFileRevision,
  changedFields,
} from "../core/utils";
import { buildNewNote } from "../core/note-v2";
import { generateTaskId } from "../core/ids";
import { parentFileStem, sanitizeFileStem, uniqueFileStem } from "../core/file-names";
import { applyPatchToRow } from "../core/task-patch";
import { computeParentOrder } from "../core/parent-order";
import type { HistoryManager } from "./history-manager";
import { applyNoteChange, diffRow, flattenApplied, mergeApplied, type AppliedNote } from "./note-changes";
import { linkTextFor } from "./note-vault";
import { isUnderRoot, loadNoteTasks, readNote, taskRoot, type TaskCache } from "./note-store";

export { loadNoteTasks as loadTasks };
export type { TaskCache };


// VAULT ADAPTER INTERFACE - for testability


/**
 * Narrow interface for vault operations, independent of Obsidian App.
 * Enables unit testing with in-memory fake implementations.
 */
export interface VaultAdapter {
  // Create a file with given path and content
  create(path: string, content: string): Promise<VaultFile>;

  // Modify an existing file's content
  modify(file: VaultFile, content: string): Promise<void>;

  // Obsidian provides atomic read/transform/write for revision guards.
  process?(file: VaultFile, transform: (content: string) => string): Promise<string>;

  // Read file content from disk
  read(file: VaultFile): Promise<string>;

  // Read through Obsidian's cache (bodies are shown a lot and change rarely)
  cachedRead(file: VaultFile): Promise<string>;

  // Get all files in vault
  getFiles(): VaultFile[];

  // Get file by path (returns null if not found)
  getFileByPath(path: string): VaultFile | null;

  /** metadataCache frontmatter: undefined = not indexed yet, null = the note has none. */
  getFrontmatter(file: VaultFile): Record<string, unknown> | null | undefined;

  /** app.fileManager.processFrontMatter: only the keys the callback touches change. */
  processFrontMatter(file: VaultFile, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;

  /** app.fileManager.renameFile (files and folders; missing parent folders are created). */
  rename(path: string, newPath: string): Promise<void>;

  /** app.fileManager.trashFile */
  trash(file: VaultFile): Promise<void>;

  /** Resolves a link such as "[[name]]" the way the metadataCache would from `fromPath`. */
  resolveLink(link: string, fromPath: string): VaultFile | null;

  /** Resolves once the metadataCache has indexed these files (or after the timeout). */
  whenIndexed(files: readonly VaultFile[], timeoutMs?: number): Promise<void>;

  /** After writing: resolves when the metadataCache has caught up with the file (or after a timeout). */
  afterWrite(file: VaultFile, contentChanged: boolean): Promise<void>;
}

/**
 * File interface - minimal subset needed for task operations
 */
export interface VaultFile {
  path: string;
  basename?: string;
  stat?: {
    mtime: number;
    size: number;
  };
}


// IDS AND PATHS


/** Ids already used by task notes under the task folder (read from the metadataCache). */
export function collectTaskIds(vault: VaultAdapter, settings: Pick<TaskWorkbenchSettings, "taskFolder">): Set<string> {
  const root = taskRoot(settings);
  const ids = new Set<string>();
  for (const file of vault.getFiles()) {
    if (!isUnderRoot(file.path, root)) continue;
    const id = vault.getFrontmatter(file)?.id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** Lower-cased file stems of the notes directly inside `folder`. */
function stemsIn(vault: VaultAdapter, folder: string, reserved: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  const prefix = folder ? `${folder}/` : "";
  const add = (path: string) => {
    if (!path.startsWith(prefix) || !path.endsWith(".md")) return;
    const rest = path.slice(prefix.length);
    if (!rest.includes("/")) names.add(rest.slice(0, -3).toLowerCase());
  };
  for (const file of vault.getFiles()) add(file.path);
  for (const path of reserved) add(path);
  return names;
}

/**
 * Path for a new parent note: `<taskFolder>/<[YYYY-MM-DD ]title>.md`, with a numeric suffix on collisions.
 * `reserved` holds paths another part of the same plan is about to create.
 */
export function getAvailableTaskPath(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  name: string,
  dateStr: string,
  reserved: ReadonlySet<string> = new Set()
): string {
  const folder = taskRoot(settings);
  const taken = stemsIn(vault, folder, reserved);
  const stem = uniqueFileStem(parentFileStem(name, dateStr, settings.filenameUsesDatePrefix), (candidate) => taken.has(candidate.toLowerCase()));
  return `${folder}/${stem}.md`;
}

/** The folder holding a parent's subtask notes: next to the parent, named like it. */
export function subtaskFolderOf(parentPath: string): string {
  return parentPath.replace(/\.md$/i, "");
}

/** Path for a new subtask note inside the parent's folder, with a numeric suffix on collisions. */
export function getAvailableSubtaskPath(
  vault: VaultAdapter,
  parentPath: string,
  name: string,
  reserved: ReadonlySet<string> = new Set()
): string {
  const folder = subtaskFolderOf(parentPath);
  const taken = stemsIn(vault, folder, reserved);
  const stem = uniqueFileStem(sanitizeFileStem(name), (candidate) => taken.has(candidate.toLowerCase()));
  return `${folder}/${stem}.md`;
}


// NEW ROWS


export function newParentRow(id: string, path: string, name: string, today = todayStr()): TaskRow {
  return {
    kind: "parent",
    id,
    file: { path } as TaskRow["file"],
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
    ganttEnabled: false,
    subtasks: new Map(),
  };
}

export function newSubtaskRow(id: string, path: string, parent: TaskRow, name: string, patch?: TaskPatch, today = todayStr()): TaskRow {
  const row: TaskRow = {
    kind: "subtask",
    id,
    key: id,
    parentId: parent.id,
    file: { path, parentPath: parent.file.path } as TaskRow["file"],
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
    ganttEnabled: false,
    plannedStartDate: undefined,
    plannedEndDate: undefined,
    workloadPlan: undefined,
    workloadActual: undefined,
    ganttMarkers: undefined,
  };
  // Optional patch expands after defaults (simple merge)
  if (patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key in row) (row as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return row;
}

/** Whole text of a new task note. */
export function newNoteText(vault: VaultAdapter, row: TaskRow, parent?: TaskRow): string {
  const parentFile = parent ? { path: parent.file.path } : undefined;
  return buildNewNote(row, stringifyYaml, parentFile ? { parentLink: linkTextFor(vault, parentFile) } : {});
}


// TASK CREATION


/**
 * Create a new parent task note with default values.
 * Rejects empty or whitespace-only name by throwing.
 * Returns the newly parsed TaskRow.
 */
export async function createTask(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  taskName: string,
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<TaskRow> {
  const trimmedName = taskName.trim();
  if (!trimmedName) {
    throw new Error("Task name cannot be empty");
  }
  const today = todayStr();
  const path = getAvailableTaskPath(vault, settings, trimmedName, today);
  const row = newParentRow(generateTaskId("parent", collectTaskIds(vault, settings)), path, trimmedName, today);
  const content = newNoteText(vault, row);
  const file = await vault.create(path, content);
  await vault.afterWrite(file, true);
  cache?.delete(path);
  historyManager?.push({ label: "タスク作成", files: [{ path, before: null, after: content }] });

  const created = await readNote(vault, file, settings, content);
  if (!created) {
    throw new Error("Failed to parse created task");
  }
  created.row.subtasks = new Map();
  return created.row;
}


// TASK UPDATING


/**
 * Thin wrapper over updateTaskItemsBatch for a single command.
 */
export async function updateTaskItem(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  cache: TaskCache,
  command: TaskUpdateCommand,
  options?: { expectedRevision?: string },
  historyManager?: HistoryManager
): Promise<TaskUpdateResult> {
  const results = await updateTaskItemsBatch(
    vault,
    settings,
    cache,
    [command],
    options,
    historyManager
  );

  if (results.length === 0) {
    throw new Error("Update failed");
  }

  return results[0];
}

/**
 * Revision conflict error object.
 *
 */
export interface RevisionConflictError extends Error {
  code: string;
  expectedRevision: string;
  currentRevision: string;
}

/**
 * Batch update tasks. Every task is its own note, so each note is read, patched and written on
 * its own (only the changed frontmatter keys and body sections); nothing else is touched.
 * Per note: if a command's expectedRevision doesn't match, throw REVISION_CONFLICT for it
 * (notes written before stay written, and the history is cleared as a barrier).
 */
export async function updateTaskItemsBatch(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  cache: TaskCache,
  commands: unknown,
  options?: { expectedRevision?: string; persistParentOrder?: (order: string[]) => Promise<void> },
  historyManager?: HistoryManager
): Promise<TaskUpdateResult[]> {
  // Non-array or empty commands returns []
  if (!Array.isArray(commands) || commands.length === 0) {
    return [];
  }

  const allCommands = commands as TaskUpdateCommand[];

  // ganttOrder goes to settings.ganttParentOrder, never to the note.
  const orderTargets = new Map<string, number>();
  const orderOnly: TaskUpdateCommand[] = [];
  const typedCommands: TaskUpdateCommand[] = [];
  for (const cmd of allCommands) {
    if (cmd.row && cmd.row.kind === "parent" && cmd.patch && cmd.patch.ganttOrder !== undefined) {
      const { ganttOrder, ...rest } = cmd.patch;
      const num = typeof ganttOrder === "number" ? ganttOrder : parseFloat(String(ganttOrder));
      if (!isFinite(num)) throw new Error("ganttOrder must be a finite number");
      orderTargets.set(cmd.row.id, num);
      if (Object.values(rest).every((value) => value === undefined)) {
        orderOnly.push(cmd);
        continue;
      }
      typedCommands.push({ ...cmd, patch: rest });
      continue;
    }
    typedCommands.push(cmd);
  }

  // Group commands by task (= by note)
  const groups = new Map<string, TaskUpdateCommand[]>();
  for (const cmd of typedCommands) {
    if (!cmd.row) {
      throw new Error("Task update command requires row");
    }
    const list = groups.get(cmd.row.id) ?? [];
    list.push(cmd);
    groups.set(cmd.row.id, list);
  }

  const results: TaskUpdateResult[] = [];
  const appliedChanges: AppliedNote[] = [];
  let orderChange: { before: string[]; after: string[] } | undefined;

  try {
    for (const noteCommands of [...groups.values()].sort((a, b) => Number(a[0].row.kind === "parent") - Number(b[0].row.kind === "parent"))) {
      const target = noteCommands[0].row;
      const path = target.file.path;
      const file = vault.getFileByPath(path);
      if (!file) {
        throw new Error("Task file not found");
      }

      const content = await vault.read(file);
      const current = await readNote(vault, file, settings, content);
      if (!current) {
        throw new Error("Managed task not found");
      }

      // Check revision conflicts for the note
      const currentRevision = buildFileRevision(file as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const cmd of noteCommands) {
        const expectedRev = cmd.expectedRevision || options?.expectedRevision;
        if (expectedRev && expectedRev !== "" && expectedRev !== currentRevision) {
          const conflict = new Error(
            `Revision conflict on ${path}`
          ) as RevisionConflictError;
          conflict.code = "REVISION_CONFLICT";
          conflict.expectedRevision = expectedRev;
          conflict.currentRevision = currentRevision;
          throw conflict;
        }
      }

      // Apply each command in order in memory, then write the note once
      const updated = structuredClone(current.row);
      for (const cmd of noteCommands) {
        applyPatchToRow(updated, cmd.patch, settings);
      }
      const change = diffRow(current.row, updated);
      let newPath = path;
      if (change) {
        const applied = await applyNoteChange(vault, change, content);
        appliedChanges.push(...flattenApplied(applied));
        if (applied.afterPath) newPath = applied.afterPath;
      }
      cache.delete(path);

      const newRevision = buildFileRevision(vault.getFileByPath(newPath) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const cmd of noteCommands) {
        const changed = changedFields(
          cmd.row as unknown as Record<string, unknown>,
          { ...updated, file: cmd.row.file, parentId: cmd.row.parentId, subtasks: cmd.row.subtasks } as unknown as Record<string, unknown>
        );
        results.push({
          taskId: cmd.row.id,
          parentPath: cmd.row.file.parentPath ?? path,
          revisionBefore: currentRevision,
          revisionAfter: newRevision,
          changedFields: changed,
        });
      }
    }

    if (orderTargets.size > 0) {
      const before = settings.ganttParentOrder ?? [];
      const after = computeParentOrder(before, orderTargets);
      if (after.join("\n") !== before.join("\n")) {
        await options?.persistParentOrder?.(after);
        settings.ganttParentOrder = after;
        orderChange = { before: [...before], after };
      }
      for (const cmd of orderOnly) {
        const file = vault.getFileByPath(cmd.row.file.path);
        const revision = file ? buildFileRevision(file as any) : ""; // eslint-disable-line @typescript-eslint/no-explicit-any
        results.push({
          taskId: cmd.row.id,
          parentPath: cmd.row.file.path,
          revisionBefore: revision,
          revisionAfter: revision,
          changedFields: ["ganttOrder"],
        });
      }
    }
  } catch (error) {
    // A batch may span several notes. If a later note fails, earlier ones may already be written but
    // the requested operation did not finish as one unit, so it must not become an undo entry:
    // clear the history as a barrier instead.
    if (appliedChanges.length > 0) {
      historyManager?.clear();
    }
    throw error;
  }

  if ((appliedChanges.length > 0 || orderChange) && historyManager) {
    historyManager.push({ label: "タスク更新", files: mergeApplied(appliedChanges), ...(orderChange ? { order: orderChange } : {}) });
  }

  return results;
}


// SUBTASK MANAGEMENT


/**
 * Add a subtask to a parent task: a new note `<parent folder>/<title>.md` whose `parent` links back.
 * The parent note is not touched.
 * Defaults: empty plan dates, workload, markers.
 * Optional patch parameter expands after defaults (can override anything).
 * Rejects empty or whitespace-only name by throwing.
 */
export async function addSubtask(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  parentRow: TaskRow,
  name: string,
  patch?: TaskPatch,
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<TaskRow> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Subtask name cannot be empty");
  }
  const parentFile = vault.getFileByPath(parentRow.file.path);
  if (!parentFile) {
    throw new Error("Task file not found");
  }

  const path = getAvailableSubtaskPath(vault, parentRow.file.path, trimmedName);
  const row = newSubtaskRow(generateTaskId("subtask", collectTaskIds(vault, settings)), path, parentRow, trimmedName, patch);
  const content = newNoteText(vault, row, parentRow);
  const file = await vault.create(path, content);
  await vault.afterWrite(file, true);
  cache?.delete(path);
  historyManager?.push({ label: "サブタスク追加", files: [{ path, before: null, after: content }] });

  const created = await readNote(vault, file, settings, content);
  if (!created) {
    throw new Error("Failed to find newly added subtask");
  }
  created.row.parentId = parentRow.id;
  created.row.file = { ...created.row.file, parentPath: parentRow.file.path } as TaskRow["file"];
  return created.row;
}

/**
 * A concurrent edit must be kept instead of overwritten by subtask creation.
 */
export class SubtaskAddConflictError extends Error {
  constructor() {
    super("ノートが変更されたため、サブタスクを追加できませんでした。もう一度追加してください。");
    this.name = "SubtaskAddConflictError";
  }
}

/**
 * Add a subtask whose planned start and end are both dateStr. The new subtask is its own note,
 * so there is no concurrent edit of the parent to guard against.
 */
export async function addSubtaskWithPlan(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  parentRow: TaskRow,
  name: string,
  dateStr: string,
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<TaskRow> {
  if (!vault.getFileByPath(parentRow.file.path)) {
    throw new Error("親タスクのノートが見つかりません。");
  }
  return addSubtask(vault, settings, parentRow, name, { plannedStartDate: dateStr, plannedEndDate: dateStr }, historyManager, cache);
}

/**
 * Delete a subtask: its note goes to the trash. Recorded for undo.
 */
export async function deleteSubtaskTaskItem(
  vault: VaultAdapter,
  _settings: TaskWorkbenchSettings,
  row: TaskRow,
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<void> {
  void _settings;
  if (row.kind !== "subtask") {
    throw new Error("Subtask not found");
  }
  const file = vault.getFileByPath(row.file.path);
  if (!file) {
    throw new Error("Subtask not found");
  }
  const before = await vault.read(file);
  await vault.trash(file);
  cache?.delete(row.file.path);
  historyManager?.push({ label: "サブタスク削除", files: [{ path: row.file.path, before, after: null }] });
}
