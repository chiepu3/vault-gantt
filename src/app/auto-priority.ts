import { Notice } from "obsidian";
import { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { applyAutoPriorityFields, todayStr } from "../core/utils";
import { buildFullNote } from "../core/note-format";
import { mergeTaskNote, NotePreservationError } from "../core/note-update";

import type { Logger } from "../core/logger";

import { VaultAdapter, loadTasks } from "./task-operations";

/**
 * Shared task parse cache: file path → { revision, parsed row (null = not a
 * managed task file) }.
 */
export type TaskCache = Map<
  string,
  { revision: string; taskRow: TaskRow | null }
>;

/**
 *
 *
 *
 *
 * Recomputes automatic priorities for every managed task and subtask and
 * rewrites only the files whose priority values actually changed.
 */
export class AutoPriorityController {
  /**
 * @param force skip the same-day duplicate-run check
 * @returns true when the update actually ran, false when skipped
 * (disabled or already run today)
 */
  async updateAutoPriorities(
    vault: VaultAdapter,
    settings: TaskWorkbenchSettings,
    cache: TaskCache,

    force = false,
    logger?: Logger

  ): Promise<boolean> {
    // Return immediately when automatic priority updates are disabled.
    if (!settings.autoPriorityEnabled) {
      return false;
    }

    // Avoid duplicate runs on the same day unless forced. The first run
    // proceeds because no previous update date is stored.
    const today = todayStr();
    if (!force && settings.lastAutoPriorityUpdate === today) {
      return false;
    }

    // Let loadTasks failures, including a missing task folder, propagate to
    // the caller. Do not update lastAutoPriorityUpdate when loading fails.

    const tasks = await loadTasks(vault, settings, cache, logger);


    let skippedNotes = 0;
    for (const cachedTask of tasks) {
      // Do not mutate cached rows when preservation rejects this update.
      const task = {
        ...cachedTask,
        subtasks: new Map([...(cachedTask.subtasks ?? [])].map(([key, row]) => [key, { ...row }])),
      };
      let fileChanged = false;

      // Recompute priority from the task's own dueDate. Parent attributes
      // are not considered because applyAutoPriorityFields has no parent
      // parameter; do not infer parent-based behavior in this service.
      // Compare the captured priority and mode because applyAutoPriorityFields
      // returns void; mark the file changed only when either value differs.
      const prevPriority = task.priority;
      const prevMode = task.priorityMode;
      applyAutoPriorityFields(task, settings.autoPriorityEnabled);
      if (task.priority !== prevPriority || task.priorityMode !== prevMode) {
        fileChanged = true;
      }

      // Apply the same calculation to subtasks in automatic mode only.
      if (task.subtasks) {
        for (const subtask of task.subtasks.values()) {
          const prevSubPriority = subtask.priority;
          const prevSubMode = subtask.priorityMode;
          applyAutoPriorityFields(subtask, settings.autoPriorityEnabled);
          if (
            subtask.priority !== prevSubPriority ||
            subtask.priorityMode !== prevSubMode
          ) {
            fileChanged = true;
          }
        }
      }

      if (!fileChanged) {
        // unchanged tasks are not touched at all
        continue;
      }

      const beforeNote = buildFullNote(cachedTask, cachedTask.subtasks);
      // Read only changed files and retain unmanaged YAML and body sections.
      const file = vault.getFileByPath(task.file.path);
      if (!file) {
        throw new Error(`Task file not found: ${task.file.path}`);
      }
      const original = await vault.read(file);
      let content: string;
      try {
        content = mergeTaskNote(original, beforeNote, buildFullNote(task, task.subtasks));
      } catch (error) {
        if (!(error instanceof NotePreservationError)) throw error;
        skippedNotes++;
        console.warn(`Skipping automatic priority update: ${task.file.path}`, error);
        continue;
      }
      // modify failures (e.g. file locks)
      // propagate uncaptured and stop the iteration
      await vault.modify(file, content);
    }

    if (skippedNotes > 0) {
      new Notice(`自動優先度を更新できなかったノートが ${skippedNotes} 件あります（独自の書式を含むため）`);
    }

    // record the run date (YYYY-MM-DD)
    settings.lastAutoPriorityUpdate = today;
    // the caller persists settings afterwards
    // (see TaskWorkbenchPlugin.onload in src/main.ts)
    return true;
  }
}
