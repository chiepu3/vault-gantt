import type { OperationId, OperationInputMap } from "../../contracts/operations";
import type { PreviewEntry } from "../../contracts/preview";
import { normalizeWorkloadMap } from "../../core/task-patch";
import { addGanttEvent, deleteGanttEvent, duplicateGanttEvent, updateGanttEvent, addWeeklyWorkSchedule, updateWeeklyWorkSchedule, deleteWeeklyWorkSchedule } from "../gantt-task-service";
import { hours } from "../preview-projector";
import { fail, canonical, type TaskSnapshot } from "./runtime";
export const EVENT_WEEKLY_OPERATION_IDS = ["E01", "E02", "E03", "E05", "E04", "E06", "E07", "W01", "W02", "W03"] as const;
export function eventWeeklyPlan<K extends OperationId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot) {
  const settings = structuredClone(snapshot.settings);
  const args = input as OperationInputMap["E01"] & OperationInputMap["E02"] & OperationInputMap["E06"] & OperationInputMap["E07"] & OperationInputMap["W01"] & OperationInputMap["W02"];
  if (args.expectedRevision && args.expectedRevision !== snapshot.settingsRevision && args.expectedRevision !== snapshot.revision) fail("REVISION_CONFLICT", "settingsを再取得して再プレビューしてください。");
  const entries: Omit<PreviewEntry, "actionId">[] = [];
  if (id.startsWith("E")) {
    const before = snapshot.settings.ganttEvents.find((event) => event.key === args.eventKey);
    if (id !== "E01" && !before) fail("NOT_FOUND", "実在するeventKeyを取得してください。");
    let key = before?.key;
    if (id === "E01") key = addGanttEvent(settings, args.title, args.date).key;
    if (id === "E02") updateGanttEvent(settings, key!, { title: args.title });
    if (id === "E03") updateGanttEvent(settings, key!, { date: args.date });
    if (id === "E05") deleteGanttEvent(settings, key!);
    if (id === "E04") key = duplicateGanttEvent(settings, key!)!.key;
    if (id === "E06") updateGanttEvent(settings, key!, { workloadPlan: normalizeWorkloadMap(args.plan) });
    if (id === "E07") updateGanttEvent(settings, key!, { workloadActual: normalizeWorkloadMap(args.actual) });
    const after = settings.ganttEvents.find((event) => event.key === key);
    const old = id === "E04" ? undefined : before;
    const effects: PreviewEntry["effects"][number][] = [];
    if (!old || !after) effects.push({ kind: "presence", action: id === "E04" ? "duplicate" : after ? "create" : "delete", before: old ? { ...old } : null, after: after ? { ...after } : null });
    else if (id === "E02" && old.title !== after.title) effects.push({ kind: "fields", fields: [{ field: "title", before: old.title, after: after.title, reason: "requested" }] });
    else if (id === "E03" && old.date !== after.date) effects.push({ kind: "schedule", before: { start: old.date, end: old.date }, after: { start: after.date, end: after.date }, unit: "calendar-day" });
    if (id === "E06" || id === "E07" || id === "E05" || id === "E04") {
      const beforeHours = old ? hours(old) : [], afterHours = after ? hours(after) : [];
      const cells = [...new Set([...beforeHours, ...afterHours].map((cell) => cell.date))].sort().map((date) => ({ date, before: beforeHours.find((cell) => cell.date === date) ?? { date, plan: 0, actual: 0 }, after: afterHours.find((cell) => cell.date === date) ?? { date, plan: 0, actual: 0 } })).filter((cell) => canonical(cell.before) !== canonical(cell.after));
      if (cells.length) effects.push({ kind: "workload", cells });
    }
    entries.push({ entity: { kind: "event", eventKey: key! }, displayName: after?.title ?? old!.title, effects });
    return { settings, entries, keys: ["ganttEvents"] as const };
  }
  const before = snapshot.settings.weeklyWorkSchedules.find((weekly) => weekly.key === args.scheduleKey);
  if (id !== "W01" && !before) fail("NOT_FOUND", "実在するscheduleKeyを取得してください。");
  let key = before?.key;
  if (id === "W01") key = addWeeklyWorkSchedule(settings, args.title, args.dayOfWeek, args.minutesPerWeek).key;
  if (id === "W02") updateWeeklyWorkSchedule(settings, key!, args.patch);
  if (id === "W03") deleteWeeklyWorkSchedule(settings, key!);
  const after = settings.weeklyWorkSchedules.find((weekly) => weekly.key === key);
  entries.push({ entity: { kind: "weekly", scheduleKey: key! }, displayName: after?.title ?? before!.title, effects: canonical(before ?? null) === canonical(after ?? null) ? [] : [{ kind: "weekly", before: before ?? null, after: after ?? null }] });
  return { settings, entries, keys: ["weeklyWorkSchedules"] as const };
}
