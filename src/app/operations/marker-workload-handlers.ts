import type { OperationId, OperationInputMap } from "../../contracts/operations";
import { makeUniqueMarkerKey } from "../../core/utils";
import { checkRevision, findTask, fail, type TaskChange, type TaskSnapshot } from "./runtime";
export const MARKER_WORKLOAD_OPERATION_IDS = ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08"] as const;
export function markerWorkloadChanges<K extends OperationId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot): TaskChange[] {
  const args = input as OperationInputMap["M01"] & OperationInputMap["M02"] & OperationInputMap["M05"] & OperationInputMap["M06"] & OperationInputMap["M07"] & OperationInputMap["M08"];
  const row = findTask(snapshot, args.subtaskId, "subtask");
  checkRevision(snapshot, row, args.expectedRevision);
  if (id === "M07") return [{ taskId: row.id, patch: { workloadPlan: { ...args.workloadPlan } } }];
  if (id === "M08") return [{ taskId: row.id, patch: { workloadActual: { ...args.workloadActual } } }];
  if (id === "M06") return [{ taskId: row.id, patch: { ganttMarkers: structuredClone(args.markers) as import("../../core/types").GanttMarker[] } }];
  const markers = structuredClone(row.ganttMarkers ?? []);
  if (id === "M01") markers.push({ key: makeUniqueMarkerKey(args.title, new Set(markers.map((marker) => marker.key))), title: args.title, date: args.date, tags: [...args.tags ?? []] });
  else {
    const index = markers.findIndex((marker) => marker.key === args.markerKey);
    if (index < 0) fail("NOT_FOUND", "markers groupを再取得し、実在するmarkerKeyを指定してください。");
    if (id === "M04") markers.splice(index, 1);
    else if (id === "M05") markers[index].tags = [...args.tags];
    else Object.assign(markers[index], id === "M03" ? { date: args.date } : args.patch);
  }
  return [{ taskId: row.id, patch: { ganttMarkers: markers } }];
}
