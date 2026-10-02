import type {
  TaskPatch,
  TaskRow,
  TaskUpdateCommand,
  TaskWorkbenchSettings,
} from "../core/types";
import type { TaskCache } from "../app/auto-priority";

import type { Logger } from "../core/logger";

import { changedFields, getSubtaskKey, todayStr } from "../core/utils";
import {
  VaultAdapter,
  addSubtask,
  createTask,
  getAvailableTaskPath,
  loadTasks,
  updateTaskItemsBatch,
} from "../app/task-operations";





export interface ToolAdapterHost {

  readonly logger: Logger;

  readonly settings: TaskWorkbenchSettings;
  readonly taskCache: TaskCache;
}

/**
 * the dry-run result returned by every preview* method.
 * Nothing is written to disk until confirmChange is called with the
 * returned previewId.
 */
export interface ToolPreview {
  previewId: string;
  kind: string;
  summary: string;
  details: Record<string, unknown>;
}

interface PendingChange {
  kind: string;
  summary: string;
  apply: () => Promise<unknown>;
}

/**
 *
 * Experimental Agent Tools API (REST-equivalent functionality exposed as
 * plugin-internal methods, delegated from the plugin instance).
 *
 * Documented design choices (kept intentionally minimal —):
 * - Gating: while settings.agentToolsEnabled is false every method THROWS
 * (the async methods therefore reject) with a clear message. Silent
 * no-op results were rejected so external callers cannot mistake a
 * disabled adapter for an empty vault.
 * - preview* methods are pure dry runs: they read the vault and compute
 * what WOULD change, but never call vault.create/modify. confirmChange
 * is the only method that writes, applying exactly one previously
 * previewed change (each previewId is single-use).
 * - previewMoveTask is the minimal interpretation of "move": a ganttOrder
 * change. The API surface may change without notice.
 */
export class ToolAdapter {
  private readonly pending = new Map<string, PendingChange>();
  private previewCounter = 0;

  constructor(
    private readonly host: ToolAdapterHost,
    private readonly vaultFactory: () => VaultAdapter
  ) {}

  /**
 * flat search over all parent tasks and subtasks.
 * Empty/omitted query returns everything.
 */
  async searchTasks(query?: string): Promise<TaskRow[]> {
    this.requireEnabled();
    const all = await this.flatTasks();
    const q = (query ?? "").trim().toLowerCase();
    if (!q) {
      return all;
    }
    return all.filter(
      (task) =>
        task.displayName.toLowerCase().includes(q) ||
        task.title.toLowerCase().includes(q)
    );
  }

  /**
 * fetch a single task or subtask by id.
 */
  async getTask(taskId: string): Promise<TaskRow> {
    this.requireEnabled();
    const all = await this.flatTasks();
    const found = all.find((task) => task.id === taskId);
    if (!found) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return found;
  }

  /**
 * dry-run field update. Nothing is written until confirm.
 */
  async previewUpdateTask(
    taskId: string,
    patch: TaskPatch
  ): Promise<ToolPreview> {
    this.requireEnabled();
    const row = await this.findTask(taskId);
    return this.previewPatch(row, patch, "updateTask");
  }

  /**
 * dry-run schedule change (plan dates and/or due date).
 */
  async previewSetTaskSchedule(
    taskId: string,
    schedule: {
      plannedStartDate?: string;
      plannedEndDate?: string;
      dueDate?: string;
    }
  ): Promise<ToolPreview> {
    this.requireEnabled();
    const patch: TaskPatch = {};
    if (schedule.plannedStartDate !== undefined) {
      patch.plannedStartDate = schedule.plannedStartDate;
    }
    if (schedule.plannedEndDate !== undefined) {
      patch.plannedEndDate = schedule.plannedEndDate;
    }
    if (schedule.dueDate !== undefined) {
      patch.dueDate = schedule.dueDate;
    }
    const row = await this.findTask(taskId);
    return this.previewPatch(row, patch, "setTaskSchedule");
  }

  /**
 * dry-run parent task creation. The destination path is
 * computed (collision check is read-only) but no file is created until
 * confirm.
 */
  async previewCreateParentTask(name: string): Promise<ToolPreview> {
    this.requireEnabled();
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Task name cannot be empty");
    }
    const path = getAvailableTaskPath(
      this.vaultFactory(),
      this.host.settings,
      trimmed,
      todayStr()
    );
    const summary = `Create ${path}`;
    const previewId = this.registerChange({
      kind: "createParentTask",
      summary,
      apply: () =>
        createTask(this.vaultFactory(), this.host.settings, trimmed),
    });
    return {
      previewId,
      kind: "createParentTask",
      summary,
      details: { name: trimmed, path },
    };
  }

  /**
 * dry-run subtask creation. The subtask key is computed but
 * the parent file is not touched until confirm.
 */
  async previewCreateSubtask(
    parentTaskId: string,
    name: string
  ): Promise<ToolPreview> {
    this.requireEnabled();
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Subtask name cannot be empty");
    }
    const parent = await this.findTask(parentTaskId);
    if (parent.kind !== "parent") {
      throw new Error(`Not a parent task: ${parentTaskId}`);
    }
    const key = getSubtaskKey(
      trimmed,
      new Set(parent.subtasks ? parent.subtasks.keys() : [])
    );
    const summary = `Add subtask "${trimmed}" to ${parent.file.path}`;
    const previewId = this.registerChange({
      kind: "createSubtask",
      summary,
      apply: () =>
        addSubtask(this.vaultFactory(), this.host.settings, parent, trimmed),
    });
    return {
      previewId,
      kind: "createSubtask",
      summary,
      details: { parentPath: parent.file.path, key, name: trimmed },
    };
  }

  /**
 * minimal "move" — a dry-run ganttOrder change.
 */
  async previewMoveTask(
    taskId: string,
    ganttOrder: number
  ): Promise<ToolPreview> {
    this.requireEnabled();
    const row = await this.findTask(taskId);
    return this.previewPatch(row, { ganttOrder }, "moveTask");
  }

  /**
 * dry-run batch update. Computes the per-task field diffs
 * without writing; confirm applies the whole batch through
 * updateTaskItemsBatch (per-file atomicity comes from that layer).
 */
  async previewUpdateTasksBatch(
    commands: TaskUpdateCommand[]
  ): Promise<ToolPreview> {
    this.requireEnabled();
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error("No commands given");
    }
    const changedByTask: Record<string, string[]> = {};
    for (const command of commands) {
      if (!command.row) {
        throw new Error("Task update command requires row");
      }
      changedByTask[command.row.id] = diffFields(command.row, command.patch);
    }
    const summary = `Update ${commands.length} item(s)`;
    const previewId = this.registerChange({
      kind: "updateTasksBatch",
      summary,
      apply: () =>
        updateTaskItemsBatch(
          this.vaultFactory(),
          this.host.settings,
          this.host.taskCache,
          commands
        ),
    });
    return {
      previewId,
      kind: "updateTasksBatch",
      summary,
      details: { count: commands.length, changedByTask },
    };
  }

  /**
 * applies a previously previewed change for real. Each
 * previewId is single-use; confirming an unknown or already-consumed id
 * throws.
 */
  async confirmChange(previewId: string): Promise<unknown> {
    this.requireEnabled();
    const change = this.pending.get(previewId);
    if (!change) {
      throw new Error(`Unknown or already confirmed preview: ${previewId}`);
    }
    this.pending.delete(previewId);
    return change.apply();
  }


  // internals


  private requireEnabled(): void {
    // the whole surface is only usable when the setting is on
    if (!this.host.settings.agentToolsEnabled) {
      throw new Error(
        "Agent Tools API は無効です。設定の agentToolsEnabled を有効にしてください。"
      );
    }
  }

  /** loadTasks + flatten (parents followed by their subtasks). */
  private async flatTasks(): Promise<TaskRow[]> {
    const tasks = await loadTasks(
      this.vaultFactory(),
      this.host.settings,

      this.host.taskCache,
      this.host.logger

    );
    const flat: TaskRow[] = [];
    for (const task of tasks) {
      flat.push(task);
      if (task.subtasks) {
        for (const subtask of task.subtasks.values()) {
          flat.push(subtask);
        }
      }
    }
    return flat;
  }

  private async findTask(taskId: string): Promise<TaskRow> {
    const all = await this.flatTasks();
    const found = all.find((task) => task.id === taskId);
    if (!found) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return found;
  }

  private previewPatch(
    row: TaskRow,
    patch: TaskPatch,
    kind: string
  ): ToolPreview {
    const changed = diffFields(row, patch);
    const summary = `${row.id}: ${
      changed.length > 0 ? changed.join(", ") : "no changes"
    }`;
    const previewId = this.registerChange({
      kind,
      summary,
      apply: () =>
        updateTaskItemsBatch(
          this.vaultFactory(),
          this.host.settings,
          this.host.taskCache,
          [{ row, patch }]
        ),
    });
    return {
      previewId,
      kind,
      summary,
      details: { taskId: row.id, changedFields: changed, patch },
    };
  }

  private registerChange(change: PendingChange): string {
    this.previewCounter += 1;
    const previewId = `preview-${this.previewCounter}`;
    this.pending.set(previewId, change);
    return previewId;
  }
}





function diffFields(row: TaskRow, patch: TaskPatch): string[] {
  const merged = { ...row, ...stripUndefined(patch) };
  return changedFields(
    row as unknown as Record<string, unknown>,
    merged as unknown as Record<string, unknown>
  );
}

function stripUndefined(patch: TaskPatch): TaskPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as TaskPatch;
}
