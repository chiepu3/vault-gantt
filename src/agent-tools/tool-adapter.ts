import type { TaskPatch, TaskRow, TaskUpdateCommand, TaskWorkbenchSettings } from "../core/types";
import type { TaskCache } from "../app/auto-priority";
import type { Logger } from "../core/logger";
import type { VaultAdapter } from "../app/task-operations";
import { HistoryManager } from "../app/history-manager";
import { OperationRegistry, OperationPlan } from "../app/operation-registry";
import { getSubtaskKey } from "../core/utils";

export interface ToolAdapterHost {
  readonly logger: Logger;
  readonly settings: TaskWorkbenchSettings;
  readonly taskCache: TaskCache;
  readonly operations?: OperationRegistry;
}
export interface ToolPreview { previewId: string; kind: string; summary: string; details: Record<string, unknown> }

// Compatibility facade only: all mutations belong to OperationRegistry.
export class ToolAdapter {
  private readonly registry: OperationRegistry;
  constructor(private readonly host: ToolAdapterHost, vaultFactory: () => VaultAdapter) {
    this.registry = host.operations ?? new OperationRegistry({ settings: host.settings, historyManager: new HistoryManager(), invalidate: () => host.taskCache.clear() }, vaultFactory);
  }
  async searchTasks(query?: string): Promise<TaskRow[]> { this.requireEnabled(); return this.registry.rows(query); }
  async getTask(taskId: string): Promise<TaskRow> { this.requireEnabled(); return this.registry.get(taskId); }
  async previewUpdateTask(taskId: string, patch: TaskPatch): Promise<ToolPreview> {
    this.requireEnabled();
    return this.preview(await this.registry.plan("update", { taskId, patch }), "updateTask", { taskId, patch });
  }
  async previewSetTaskSchedule(taskId: string, schedule: { plannedStartDate?: string; plannedEndDate?: string; dueDate?: string }): Promise<ToolPreview> {
    this.requireEnabled();
    return this.preview(await this.registry.plan("schedule-batch", { changes: [{ taskId, patch: schedule }] }), "setTaskSchedule", { taskId, patch: schedule });
  }
  async previewCreateParentTask(name: string): Promise<ToolPreview> {
    this.requireEnabled();
    if (!name.trim()) throw new Error("Task name cannot be empty");
    const plan = await this.registry.plan("create", { name });
    return this.preview(plan, "createParentTask", { name: name.trim(), path: plan.diffs[0].taskId });
  }
  async previewCreateSubtask(parentTaskId: string, name: string): Promise<ToolPreview> {
    this.requireEnabled();
    if (!name.trim()) throw new Error("Task name cannot be empty");
    const parent = await this.registry.get(parentTaskId);
    const plan = await this.registry.plan("create", { name, parentTaskId });
    return this.preview(plan, "createSubtask", { parentPath: parent.file.path, name: name.trim(), key: getSubtaskKey(name.trim(), new Set(parent.subtasks?.keys())) });
  }
  async previewMoveTask(taskId: string, ganttOrder: number): Promise<ToolPreview> {
    this.requireEnabled();
    return this.preview(await this.registry.plan("update", { taskId, patch: { ganttOrder } }), "moveTask", { taskId });
  }
  async previewUpdateTasksBatch(commands: TaskUpdateCommand[]): Promise<ToolPreview> {
    this.requireEnabled();
    if (!commands.length) throw new Error("No commands given");
    const plan = await this.registry.plan("update-batch", { changes: commands.map(({ row, patch, expectedRevision }) => ({ taskId: row.id, patch, expectedRevision })) });
    return this.preview(plan, "updateTasksBatch", { count: commands.length, changedByTask: Object.fromEntries(plan.diffs.map((diff) => [diff.taskId, diff.fields.map((field) => field.field)])) });
  }
  async confirmChange(previewId: string): Promise<unknown> {
    this.requireEnabled();
    const result = await this.registry.commit(previewId);
    if (result.kind !== "success") throw new Error(result.message);
    return result.created ?? result.results;
  }
  private preview(plan: OperationPlan, kind: string, details: Record<string, unknown>): ToolPreview {
    return { previewId: plan.previewId, kind, summary: plan.summary, details: { ...details, changedFields: plan.diffs.flatMap((diff) => diff.fields.map((field) => field.field)) } };
  }
  private requireEnabled(): void {
    if (!this.host.settings.agentToolsEnabled) throw new Error("Agent Tools API は無効です。設定の agentToolsEnabled を有効にしてください。");
  }
}
