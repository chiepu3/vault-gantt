import type { OperationId, OperationInputMap } from "../../contracts/operations";
import type { TaskChange, TaskSnapshot } from "./runtime";
import { checkRevision, findTask, flatten, fail } from "./runtime";
import { calculateAutoPriority } from "../../core/utils";

export const TASK_OPERATION_IDS = ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T26", "T27", "T28", "T29", "T30"] as const;
export function taskChanges<K extends OperationId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot): TaskChange[] {
  if (id === "T27" || id === "T28") return structuredClone((input as OperationInputMap["T27"]).changes) as TaskChange[];
  if (id === "T29") return [structuredClone(input as OperationInputMap["T29"]) as TaskChange];
  if (id === "T30") return flatten(snapshot.parents).filter((row) => row.priorityMode === "auto").map((row) => ({ taskId: row.id, patch: { priority: calculateAutoPriority(row.dueDate), priorityMode: "auto" } }));
  if (id === "T18") {
    const args = input as OperationInputMap["T18"];
    if (args.expectedRevision && args.expectedRevision !== snapshot.revision) fail("REVISION_CONFLICT", "overviewを再取得してください。");
    return args.orderedParentIds.map((taskId, index) => { findTask(snapshot, taskId, "parent"); return { taskId, patch: { ganttOrder: (index + 1) * 1000 } }; });
  }
  if (id === "T17") {
    const args = input as OperationInputMap["T17"], row = findTask(snapshot, args.parentId, "parent");
    checkRevision(snapshot, row, args.expectedRevision);
    const orders = snapshot.parents.filter((parent) => parent.ganttEnabled).map((parent) => parent.ganttOrder ?? 999999);
    return [{ taskId: row.id, patch: { ganttEnabled: args.enabled, ...(args.order !== undefined ? { ganttOrder: args.order } : args.enabled ? { ganttOrder: Math.max(0, ...orders) + 1000 } : {}) } }];
  }
  const args = input as OperationInputMap["T07"] & OperationInputMap["T08"] & OperationInputMap["T09"] & OperationInputMap["T10"] & OperationInputMap["T12"] & OperationInputMap["T13"] & OperationInputMap["T14"] & OperationInputMap["T16"];
  const row = findTask(snapshot, args.taskId);
  checkRevision(snapshot, row, args.expectedRevision);
  const patches = {
    T07: { displayName: args.name }, T08: { statusLabel: args.statusLabel }, T09: { completed: args.completed },
    T10: { currentStatus: args.text }, T11: { notes: args.text }, T12: { createdAt: args.createdAt }, T13: { dueDate: args.dueDate },
    T14: { priority: args.priority, priorityMode: "manual" }, T15: { priority: calculateAutoPriority(row.dueDate), priorityMode: "auto" }, T16: { tags: [...args.tags ?? []] },
  };
  const patch = patches[id as keyof typeof patches];
  if (!patch) fail("INVALID_INPUT", "task handlerに対応する操作を使用してください。");
  return [{ taskId: row.id, patch }];
}
