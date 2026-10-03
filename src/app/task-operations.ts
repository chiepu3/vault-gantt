import {
  TaskRow,
  TaskPatch,
  TaskWorkbenchSettings,
  TaskUpdateCommand,
  TaskUpdateResult,
} from "../core/types";

import type { Logger } from "../core/logger";

import {
  todayStr,
  sanitizeFileName,
  buildFileRevision,
  changedFields,
  getSubtaskKey,
} from "../core/utils";
import {
  parseTaskFile,
  buildFullNote,
} from "../core/note-format";
import { applyPatchToParent } from "../core/task-patch";
import type { HistoryFileChange, HistoryManager } from "./history-manager";


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

  // Read file content
  read(file: VaultFile): Promise<string>;

  // Get all files in vault
  getFiles(): VaultFile[];

  // Get file by path (returns null if not found)
  getFileByPath(path: string): VaultFile | null;
}

/**
 * File interface - minimal subset needed for task operations
 */
export interface VaultFile {
  path: string;
  stat?: {
    mtime: number;
    size: number;
  };
}


// TASK FOLDER AND PATH UTILITIES


/**
 *
 * Get the task folder path for a given date.
 * Format: {taskFolder}/YYYY/MM
 */
export function getTaskFolderForDate(
  settings: TaskWorkbenchSettings,
  dateStr: string
): string {
  // dateStr expected to be YYYY-MM-DD
  const [year, month] = dateStr.split("-");
  return `${settings.taskFolder}/${year}/${month}`;
}

/**
 *
 * Get an available task file path, handling sanitization and collisions.
 * With filenameUsesDatePrefix, adds "YYYY-MM-DD " prefix.
 * On collision, appends " 1", " 2",... (no upper bound).
 */
export function getAvailableTaskPath(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  name: string,
  dateStr: string
): string {
  const taskFolder = getTaskFolderForDate(settings, dateStr);

  // Sanitize the name
  let sanitized = sanitizeFileName(name);

  // Add date prefix if enabled
  let baseName = sanitized;
  if (settings.filenameUsesDatePrefix) {
    baseName = `${dateStr} ${sanitized}`;
  }

  // Check for collisions and add suffix if needed
  let candidate = `${taskFolder}/${baseName}.md`;
  let suffix = 1;

  while (vault.getFileByPath(candidate) !== null) {
    const prefix = settings.filenameUsesDatePrefix ? `${dateStr} ` : "";
    candidate = `${taskFolder}/${prefix}${sanitized} ${suffix}.md`;
    suffix++;
  }

  return candidate;
}


// TASK CREATION


/**
 *
 * Create a new task with default values.
 * Rejects empty or whitespace-only name by throwing.
 * Returns the newly parsed TaskRow.
 */
export async function createTask(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  taskName: string,
  historyManager?: HistoryManager
): Promise<TaskRow> {
  // Reject empty or whitespace-only name
  const trimmedName = taskName.trim();
  if (!trimmedName) {
    throw new Error("Task name cannot be empty");
  }

  // Use today's date
  const today = todayStr();

  // Get available path
  const taskPath = getAvailableTaskPath(vault, settings, trimmedName, today);

  // Build the default parent task row.
  const defaultRow: TaskRow = {
    kind: "parent",
    id: taskPath,
    file: {
      path: taskPath,
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    title: trimmedName,
    displayName: trimmedName,
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
    ganttOrder: Date.now(),
    subtasks: new Map(),
  };

  // Write via vault.create + buildFullNote
  const content = buildFullNote(defaultRow, new Map());
  await vault.create(taskPath, content);
  // Creation bypasses batch before/after capture, so it is a history barrier.
  historyManager?.clear();

  // Re-parse and return the task row
  const file = vault.getFileByPath(taskPath);
  if (!file) {
    throw new Error("Task file not found");
  }

  const fileContent = await vault.read(file);
  const parsed = parseTaskFile(
    { path: file.path },
    fileContent,
    settings
  );
  if (!parsed) {
    throw new Error("Failed to parse created task");
  }

  return parsed;
}


// TASK LOADING WITH CACHING


/**
 *
 * Load all tasks from vault with caching.
 * Cache key: ${mtime}:${size}
 * Parse errors are logged and file is filtered from results.
 * Old cache entries are deleted before load.
 * Same mtime+size but different content uses old cache (known limitation).
 */
export async function loadTasks(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,

  cache: Map<string, { revision: string; taskRow: TaskRow | null }>,
  logger?: Logger

): Promise<TaskRow[]> {

  const startedAt = Date.now();
  let fileCount = 0;

  const result: TaskRow[] = [];

  // Root folder with trailing slash removed
  const root = settings.taskFolder.replace(/\/$/, "");

  const files = vault.getFiles();

  // Delete old cache entries for files that no longer exist
  const currentFilePaths = new Set<string>();
  for (const file of files) {
    currentFilePaths.add(file.path);
  }

  for (const cachedPath of cache.keys()) {
    if (!currentFilePaths.has(cachedPath)) {
      cache.delete(cachedPath);
    }
  }

  // Process all files
  for (const file of files) {

    fileCount += 1;

    // File match: path.startsWith(root+"/") OR path === root
    if (!file.path.startsWith(root + "/") && file.path !== root) {
      continue;
    }

    // Read file content
    let content: string;
    try {
      content = await vault.read(file);
    } catch {
      // Parse errors are logged and file is filtered

      if (logger) {
        logger.error("loadTasks", `Failed to read file: ${file.path}`);
      } else {
        console.error(`Failed to read file: ${file.path}`);
      }

      continue;
    }

    // Build revision key
    const revision = buildFileRevision(file as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Check cache hit
    const cachedEntry = cache.get(file.path);
    if (cachedEntry && cachedEntry.revision === revision) {
      // Cache hit - skip parsing
      if (cachedEntry.taskRow) {
        result.push(cachedEntry.taskRow);
      }
      continue;
    }

    // Parse file
    let taskRow: TaskRow | null = null;
    try {
      taskRow = parseTaskFile(
        { path: file.path },
        content,
        settings
      );
    } catch (err) {
      // Parse errors are logged and file is filtered

      if (logger) {
        logger.error("loadTasks", `Failed to parse task file ${file.path}:`, err);
      } else {
        console.error(`Failed to parse task file ${file.path}:`, err);
      }

      cache.set(file.path, { revision, taskRow: null });
      continue;
    }

    // Only process task files
    if (taskRow) {
      result.push(taskRow);
    }

    // Update cache
    cache.set(file.path, { revision, taskRow });
  }


  logger?.debug("loadTasks", "load completed", {
    durationMs: Date.now() - startedAt,
    fileCount,
    taskCount: result.length,
  });

  return result;
}


// TASK UPDATING


/**
 *
 * Thin wrapper over updateTaskItemsBatch for a single command.
 */
export async function updateTaskItem(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  cache: Map<string, { revision: string; taskRow: TaskRow | null }>,
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
 *
 * Batch update tasks, grouped by parent file path.
 * Per file: all-or-nothing atomicity. If any command's expectedRevision doesn't match,
 * throw REVISION_CONFLICT for entire file (other files unaffected).
 * Single vault.modify per file.
 */
export async function updateTaskItemsBatch(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  cache: Map<string, { revision: string; taskRow: TaskRow | null }>,
  commands: unknown,
  options?: { expectedRevision?: string },
  historyManager?: HistoryManager
): Promise<TaskUpdateResult[]> {
  // Non-array or empty commands returns []
  if (!Array.isArray(commands) || commands.length === 0) {
    return [];
  }

  // Type guard
  const typedCommands = commands as TaskUpdateCommand[];

  // Group commands by parent file path
  const groupedByPath = new Map<string, TaskUpdateCommand[]>();
  for (const cmd of typedCommands) {
    // Task update command requires row
    if (!cmd.row) {
      throw new Error("Task update command requires row");
    }

    const parentPath = cmd.row.file.path;
    if (!groupedByPath.has(parentPath)) {
      groupedByPath.set(parentPath, []);
    }
    groupedByPath.get(parentPath)!.push(cmd);
  }

  const results: TaskUpdateResult[] = [];
  const appliedChanges: HistoryFileChange[] = [];

  // Process each file
  try {
    for (const [parentPath, fileCommands] of groupedByPath.entries()) {
      // Load the current parent task
      const parentFile = vault.getFileByPath(parentPath);
      if (!parentFile) {
        throw new Error("Task file not found");
      }

      const parentContent = await vault.read(parentFile);
      const parent = parseTaskFile(
        { path: parentFile.path },
        parentContent,
        settings
      );
      if (!parent) {
        throw new Error("Managed task not found");
      }

      // Check revision conflicts for entire file
      const currentRevision = buildFileRevision(parentFile as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const cmd of fileCommands) {
        const expectedRev = cmd.expectedRevision || options?.expectedRevision;
        if (expectedRev && expectedRev !== "" && expectedRev !== currentRevision) {
          // Throw REVISION_CONFLICT with.code,.expectedRevision,.currentRevision
          const conflict = new Error(
            `Revision conflict on ${parentPath}`
          ) as RevisionConflictError;
          conflict.code = "REVISION_CONFLICT";
          conflict.expectedRevision = expectedRev;
          conflict.currentRevision = currentRevision;
          throw conflict;
        }
      }

      // Apply each command in order via applyPatchToParent in memory
      for (const cmd of fileCommands) {
        const taskId = cmd.row.id;
        applyPatchToParent(parent, cmd.patch, taskId, settings);
      }

      // Single vault.modify per file for the whole batch
      const newContent = buildFullNote(parent, parent.subtasks);
      await vault.modify(parentFile, newContent);
      appliedChanges.push({
        path: parentPath,
        before: parentContent,
        after: newContent,
      });

      // Update cache with new revision
      const newRevision = buildFileRevision(parentFile as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      cache.set(parentPath, { revision: newRevision, taskRow: parent });

      // Return result per command
      for (const cmd of fileCommands) {
        const changed = changedFields(
          cmd.row as unknown as Record<string, unknown>,
          parent as unknown as Record<string, unknown>
        );
        results.push({
          taskId: cmd.row.id,
          parentPath,
          revisionBefore: currentRevision,
          revisionAfter: newRevision,
          changedFields: changed,
        });
      }
    }
  } catch (error) {
    // A batch may span multiple parent files. If a later file fails, earlier
    // files may already be written but the requested operation did not finish
    // as one unit. Do not expose that partial mutation as an undo entry: the
    // next undo could otherwise silently cross an incomplete operation. The
    // history barrier is safer than attempting to overwrite a file that may
    // have changed externally while the failing batch was unwinding.
    if (appliedChanges.length > 0) {
      historyManager?.clear();
    }
    throw error;
  }

  if (appliedChanges.length > 0 && historyManager) {
    historyManager.push({ label: "タスク更新", files: appliedChanges });
  }

  return results;
}


// SUBTASK MANAGEMENT


/**
 *
 * Add a subtask to a parent task.
 * Unique key via getSubtaskKey.
 * Defaults: empty plan dates, workload, markers.
 * Optional patch parameter expands after defaults (can override anything).
 * Rejects empty or whitespace-only name by throwing.
 * Writes and re-parses.
 */
export async function addSubtask(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  parentRow: TaskRow,
  name: string,
  patch?: TaskPatch,
  historyManager?: HistoryManager
): Promise<TaskRow> {
  // Reject empty or whitespace-only name
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Subtask name cannot be empty");
  }

  // Generate unique key
  const existingKeys = parentRow.subtasks
    ? new Set(parentRow.subtasks.keys())
    : new Set<string>();
  const subtaskKey = getSubtaskKey(trimmedName, existingKeys);

  // Build default subtask
  const today = todayStr();
  const defaultSubtask: TaskRow = {
    kind: "subtask",
    id: `${parentRow.id}::${subtaskKey}`,
    key: subtaskKey,
    file: {
      path: parentRow.file.path,
      parentPath: parentRow.file.path,
      heading: trimmedName,
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    title: trimmedName,
    displayName: trimmedName,
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
      if (value !== undefined && key in defaultSubtask) {
        (defaultSubtask as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  // Add to parent's subtasks and bump updatedAt
  if (!parentRow.subtasks) {
    parentRow.subtasks = new Map();
  }
  parentRow.subtasks.set(subtaskKey, defaultSubtask);
  parentRow.updatedAt = todayStr();

  // Write and re-parse
  const parentFile = vault.getFileByPath(parentRow.file.path);
  if (!parentFile) {
    throw new Error("Task file not found");
  }

  const content = buildFullNote(parentRow, parentRow.subtasks);
  await vault.modify(parentFile, content);
  historyManager?.clear();

  // Re-parse to get fresh state
  const fileContent = await vault.read(parentFile);
  const parsed = parseTaskFile(
    { path: parentFile.path },
    fileContent,
    settings
  );
  if (!parsed || !parsed.subtasks) {
    throw new Error("Failed to re-parse parent task after adding subtask");
  }

  const subtask = parsed.subtasks.get(subtaskKey);
  if (!subtask) {
    throw new Error("Failed to find newly added subtask");
  }

  return subtask;
}

/**
 *
 * Convenience wrapper: set both plannedStartDate and plannedEndDate to dateStr.
 */
export async function addSubtaskWithPlan(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  parentRow: TaskRow,
  name: string,
  dateStr: string,
  historyManager?: HistoryManager
): Promise<TaskRow> {
  const patch: TaskPatch = {
    plannedStartDate: dateStr,
    plannedEndDate: dateStr,
  };

  return addSubtask(vault, settings, parentRow, name, patch, historyManager);
}

/**
 *
 * Delete a subtask from a parent task.
 * Filters by id/key match.
 * Throws "Subtask not found" if count unchanged.
 * Writes updated parent.
 */
export async function deleteSubtaskTaskItem(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  row: TaskRow,
  historyManager?: HistoryManager
): Promise<void> {
  // row should be a subtask with id format: {parentPath}::{key}
  if (row.kind !== "subtask" || !row.key) {
    throw new Error("Subtask not found");
  }

  const parentPath = row.file.parentPath;
  if (!parentPath) {
    throw new Error("Subtask not found");
  }

  // Load the parent task
  const parentFile = vault.getFileByPath(parentPath);
  if (!parentFile) {
    throw new Error("Task file not found");
  }

  const parentContent = await vault.read(parentFile);
  const parent = parseTaskFile(
    { path: parentFile.path },
    parentContent,
    settings
  );
  if (!parent || !parent.subtasks) {
    throw new Error("Managed task not found");
  }

  // Filter by key
  const countBefore = parent.subtasks.size;
  parent.subtasks.delete(row.key);
  const countAfter = parent.subtasks.size;

  // Throw if count unchanged
  if (countBefore === countAfter) {
    throw new Error("Subtask not found");
  }

  // Write updated parent
  const content = buildFullNote(parent, parent.subtasks);
  await vault.modify(parentFile, content);
  historyManager?.clear();
}
