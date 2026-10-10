import type { TaskRow, TaskPatch, TaskWorkbenchSettings } from "../core/types";
import { moveBarByCalendarDelta, snapResizeStart, snapResizeEnd, snapForward, sortForBulkMove, shiftMarkers, shiftWorkloadMap } from "./gantt-drag";
import { addDays } from "./gantt-layout";
import { fail } from "./operations/runtime";

export function holidaySet(settings: TaskWorkbenchSettings): Set<string> {
  return new Set([...settings.ganttManualHolidays, ...settings.ganttSpecialHolidays, ...settings.ganttNationalHolidays]);
}
export function scheduleAction(row: TaskRow, kind: "move" | "start" | "end" | "place" | "remove", value: number | string, holidays: Set<string>): TaskPatch {
  if (row.kind !== "subtask") fail("KIND_MISMATCH", "予定日は子タスクだけに設定できます。");
  if (kind === "remove") return { plannedStartDate: "", plannedEndDate: "" };
  if (kind === "place") {
    if (row.plannedStartDate || row.plannedEndDate) fail("INVALID_INPUT", "配置済みの子は移動か直接日付設定を使用してください。");
    const date = snapForward(String(value), holidays);
    return { plannedStartDate: date, plannedEndDate: date };
  }
  if (!row.plannedStartDate || !row.plannedEndDate) fail("INVALID_INPUT", "開始・終了を設定してから移動・伸縮してください。");
  if (kind === "move") {
    const result = moveBarByCalendarDelta({ start: row.plannedStartDate, end: row.plannedEndDate, markers: row.ganttMarkers }, Number(value), holidays);
    return { plannedStartDate: result.nextStart, plannedEndDate: result.nextEnd, ganttMarkers: result.shiftedMarkers };
  }
  return kind === "start" ? { plannedStartDate: snapResizeStart(String(value), row.plannedEndDate, holidays) }
    : { plannedEndDate: snapResizeEnd(row.plannedStartDate, String(value), holidays) };
}
export function bulkMove(parent: TaskRow, anchorId: string, shiftDays: number, holidays: Set<string>): { taskId: string; patch: TaskPatch }[] {
  const children = sortForBulkMove([...parent.subtasks?.values() ?? []]);
  const index = children.findIndex((child) => child.id === anchorId);
  if (index < 0) fail("NOT_FOUND", "この親に属するアンカー子IDを取得してください。");
  return children.slice(index).filter((child) => child.plannedStartDate && child.plannedEndDate).map((child) => {
    const start = child.plannedStartDate!, end = child.plannedEndDate!;
    const newStart = addDays(start, shiftDays), newEnd = addDays(end, shiftDays);
    const calendar = { oldStart: start, newStart, holidaySet: holidays };
    return { taskId: child.id, patch: { plannedStartDate: newStart, plannedEndDate: newEnd,
      ganttMarkers: shiftMarkers(child.ganttMarkers, shiftDays, holidays, { oldStart: start, newStart, newEnd }),
      workloadPlan: shiftWorkloadMap(child.workloadPlan, shiftDays, calendar) ?? {}, workloadActual: shiftWorkloadMap(child.workloadActual, shiftDays, calendar) ?? {} } };
  });
}
