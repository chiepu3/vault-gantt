import type { OperationId, OperationInputMap } from "../../contracts/operations";
import { bulkMove, holidaySet, scheduleAction } from "../gantt-actions";
import { checkRevision, findTask, type TaskChange, type TaskSnapshot } from "./runtime";
export const SCHEDULE_OPERATION_IDS = ["T19", "T20", "T21", "T22", "T23", "T24", "T25"] as const;
export function scheduleChanges<K extends OperationId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot): TaskChange[] {
  if (id === "T25") {
    const args = input as OperationInputMap["T25"], parent = findTask(snapshot, args.parentId, "parent");
    checkRevision(snapshot, parent, args.expectedRevision);
    return bulkMove(parent, args.anchorId, args.shiftDays, holidaySet(snapshot.settings));
  }
  const args = input as OperationInputMap["T19"] & OperationInputMap["T20"] & OperationInputMap["T21"];
  const row = findTask(snapshot, args.subtaskId, "subtask");
  checkRevision(snapshot, row, args.expectedRevision);
  const patch = id === "T19" ? { ...(args.start !== undefined ? { plannedStartDate: args.start } : {}), ...(args.end !== undefined ? { plannedEndDate: args.end } : {}) }
    : scheduleAction(row, ({ T20: "move", T21: "start", T22: "end", T23: "place", T24: "remove" } as const)[id as "T20"], id === "T20" ? args.calendarDelta : args.date, holidaySet(snapshot.settings));
  return [{ taskId: row.id, patch }];
}
