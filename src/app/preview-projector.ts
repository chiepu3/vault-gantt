import { publicSettingsSchema, type PublicSettingsV1, type HoursCell, type DailyAggregateV1 } from "../contracts/context";
import { ganttProjectionSchema, type GanttStateV1, type GanttProjectionV1, type PreviewEntry, type PreviewEffect, type FieldChange, type EntityRef, entityRefKey } from "../contracts/preview";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { getEffectivePriority } from "../core/utils";
import { addDays } from "./gantt-layout";
import { isBusinessDay } from "./gantt-drag";
import { holidaySet } from "./gantt-actions";
import { canonical, type TaskSnapshot } from "./operations/runtime";
import { taskPatchInputSchema } from "../contracts/operations";

export function publicSettings(settings: TaskWorkbenchSettings): PublicSettingsV1 {
  return publicSettingsSchema.parse(Object.fromEntries(Object.keys(publicSettingsSchema.shape).filter((key) => key in settings).map((key) => [key, settings[key as keyof TaskWorkbenchSettings]])));
}
export function hours(entity: { workloadPlan?: Record<string, number>; workloadActual?: Record<string, number> }): HoursCell[] {
  return [...new Set([...Object.keys(entity.workloadPlan ?? {}), ...Object.keys(entity.workloadActual ?? {})])].sort().map((date) => ({ date, plan: entity.workloadPlan?.[date] ?? 0, actual: entity.workloadActual?.[date] ?? 0 }));
}
export function period(parent: TaskRow) {
  const children = [...parent.subtasks?.values() ?? []];
  const starts = children.map((row) => row.plannedStartDate).filter((date): date is string => !!date).sort();
  const ends = children.map((row) => row.plannedEndDate).filter((date): date is string => !!date).sort();
  return { start: starts[0] ?? null, end: ends.at(-1) ?? null };
}
export function progress(parent: TaskRow): number { const children = [...parent.subtasks?.values() ?? []]; return children.length ? children.filter((child) => child.completed).length / children.length : 0; }
export function aggregates(parents: readonly TaskRow[], settings: TaskWorkbenchSettings, dates: readonly string[]): DailyAggregateV1[] {
  const children = parents.flatMap((parent) => [...parent.subtasks?.values() ?? []]);
  const holidays = holidaySet(settings);
  return dates.map((date) => {
    const all = [...children, ...settings.ganttEvents];
    let plan = all.reduce((total, entity) => total + (entity.workloadPlan?.[date] ?? 0), 0);
    const actual = all.reduce((total, entity) => total + (entity.workloadActual?.[date] ?? 0), 0);
    plan += settings.weeklyWorkSchedules.filter((weekly) => weekly.dayOfWeek === new Date(date + "T00:00:00Z").getUTCDay()).reduce((total, weekly) => total + weekly.minutesPerWeek / 60, 0);
    const capacity = isBusinessDay(date, holidays) ? settings.ganttWorkloadDailyCapacityHours : 0;
    return { date, plan, actual, capacity, overCapacity: plan > capacity || actual > capacity };
  });
}
function appearance(tags: readonly string[], parentTags: readonly string[], settings: TaskWorkbenchSettings, isParent: boolean) {
  if (!settings.ganttFeatureTagsEnabled) return { color: null, tags: [] };
  const defs = settings.ganttTags.slice().sort((a, b) => a.order - b.order);
  const definition = (name: string) => defs.find((tag) => tag.name === name || tag.key === name);
  const orderTags = (names: readonly string[]) => [...names].filter(Boolean).sort((a, b) => (definition(a)?.order ?? 999999) - (definition(b)?.order ?? 999999));
  const color = (name: string) => definition(name)?.color || null;
  const own = orderTags(tags), parent = orderTags(parentTags);
  const inherited = settings.ganttShowParentTagsOnChildBars ? parent.filter((name) => !own.includes(name)) : [];
  const show = isParent ? settings.ganttShowTagsOnParents : settings.ganttShowTagsOnBars;
  return { color: (own[0] ? color(own[0]) : null) || (parent[0] ? color(parent[0]) : null),
    tags: show ? [...own.map((name) => ({ name: definition(name)?.name ?? name, color: color(name), origin: "own" as const })), ...inherited.map((name) => ({ name: definition(name)?.name ?? name, color: color(name), origin: "parent" as const }))] : [] };
}
export function ganttState(parents: readonly TaskRow[], settings: TaskWorkbenchSettings, dates: readonly string[]): GanttStateV1 {
  return {
    parents: parents.map((parent) => ({ id: parent.id, name: parent.displayName, enabled: parent.ganttEnabled, order: parent.ganttOrder ?? 999999, tags: [...parent.tags], period: period(parent), progress: progress(parent), effectivePriority: getEffectivePriority(parent, settings.autoPriorityEnabled), appearance: appearance(parent.tags, [], settings, true),
      children: [...parent.subtasks?.values() ?? []].map((child) => ({ id: child.id, parentId: parent.id, name: child.displayName, status: child.statusLabel, completed: child.completed, tags: [...child.tags], period: { start: child.plannedStartDate || null, end: child.plannedEndDate || null }, due: child.dueDate || null,
        markers: (child.ganttMarkers ?? []).map((marker) => ({ ...marker, tags: [...marker.tags ?? []] })), hours: hours(child), effectivePriority: getEffectivePriority(child, settings.autoPriorityEnabled), appearance: appearance(child.tags, parent.tags, settings, false) })) })),
    serviceState: { lastAutoPriorityUpdate: settings.lastAutoPriorityUpdate, ganttNationalHolidaysUpdatedAt: settings.ganttNationalHolidaysUpdatedAt, ganttNationalHolidays: [...settings.ganttNationalHolidays], ganttHolidays: [...settings.ganttHolidays] },
    events: settings.ganttEvents.map((event) => ({ key: event.key, title: event.title, date: event.date, hours: hours(event) })), weekly: structuredClone(settings.weeklyWorkSchedules), daily: [], tagDefinitions: structuredClone(settings.ganttTags), settings: publicSettings(settings),
    calendar: { weekends: [0, 6], manual: [...settings.ganttManualHolidays], special: [...settings.ganttSpecialHolidays], national: [...settings.ganttNationalHolidays] }, aggregates: aggregates(parents, settings, dates),
  };
}
export function taskEffects(before: TaskRow | undefined, after: TaskRow | undefined, requested: Record<string, unknown> = {}, businessDays = false): PreviewEffect[] {
  if (!before || !after) return [{ kind: "presence", action: after ? "create" : "delete", before: before ? taskPublicState(before) : null, after: after ? taskPublicState(after) : null }];
  const oldState = taskPublicState(before), newState = taskPublicState(after);
  const fields: FieldChange[] = Object.keys(taskPatchInputSchema.shape).filter((key) => canonical(oldState[key]) !== canonical(newState[key])).map((key) => ({ field: key as FieldChange["field"], before: taskPublicState(before)[key] ?? "", after: taskPublicState(after)[key] ?? "", reason: !(key in requested) || key === "updatedAt" ? "derived" : canonical(requested[key]) === canonical(newState[key]) ? "requested" : "normalized" }));
  const effects: PreviewEffect[] = fields.length ? [{ kind: "fields", fields }] : [];
  const changed = (key: string) => fields.some((field) => field.field === key);
  if (changed("plannedStartDate") || changed("plannedEndDate")) effects.push({ kind: "schedule", before: { start: before.plannedStartDate || null, end: before.plannedEndDate || null }, after: { start: after.plannedStartDate || null, end: after.plannedEndDate || null }, unit: businessDays ? "business-day" : "calendar-day" });
  if (changed("dueDate")) effects.push({ kind: "deadline", before: before.dueDate || null, after: after.dueDate || null });
  if (changed("ganttEnabled")) effects.push({ kind: "membership", before: before.ganttEnabled, after: after.ganttEnabled, retained: ["schedule", "workload", "markers"] });
  if (changed("ganttMarkers")) for (const key of new Set([...(before.ganttMarkers ?? []), ...(after.ganttMarkers ?? [])].map((marker) => marker.key))) {
    const oldMarker = before.ganttMarkers?.find((marker) => marker.key === key), newMarker = after.ganttMarkers?.find((marker) => marker.key === key);
    const oldState = oldMarker ? { ...oldMarker, tags: oldMarker.tags ?? [] } : null, newState = newMarker ? { ...newMarker, tags: newMarker.tags ?? [] } : null;
    if (canonical(oldState) !== canonical(newState)) effects.push({ kind: "marker", before: oldState, after: newState });
  }
  if (changed("workloadPlan") || changed("workloadActual")) {
    const oldCells = hours(before), newCells = hours(after);
    effects.push({ kind: "workload", cells: [...new Set([...oldCells, ...newCells].map((cell) => cell.date))].sort().map((date) => ({ date, before: oldCells.find((cell) => cell.date === date) ?? { date, plan: 0, actual: 0 }, after: newCells.find((cell) => cell.date === date) ?? { date, plan: 0, actual: 0 } })).filter((cell) => canonical(cell.before) !== canonical(cell.after)) });
  }
  return effects;
}
export function taskPublicState(row: TaskRow): Record<string, import("../contracts/context").Json> {
  return Object.fromEntries(Object.keys(taskPatchInputSchema.shape).map((key) => [key,
    key === "ganttMarkers" ? (row.ganttMarkers ?? []).map((marker) => ({ key: marker.key, title: marker.title, date: marker.date, tags: marker.tags ?? [] }))
      : key === "workloadPlan" || key === "workloadActual" ? { ...row[key] ?? {} } : structuredClone(row[key as keyof TaskRow] ?? "")])) as Record<string, import("../contracts/context").Json>;
}
export function project(snapshot: TaskSnapshot, afterParents: readonly TaskRow[], afterSettings: TaskWorkbenchSettings, entries: readonly PreviewEntry[]): GanttProjectionV1 | null {
  if (!entries.length) return null;
  const targets = [...new Map(entries.map((entry) => [entityRefKey(entry.entity), entry.entity])).values()];
  const dates = new Set<string>();
  const scan = (rows: readonly TaskRow[], settings: TaskWorkbenchSettings) => {
    for (const parent of rows) for (const child of parent.subtasks?.values() ?? []) {
      for (const date of [child.plannedStartDate, child.plannedEndDate, child.dueDate, ...hours(child).map((cell) => cell.date), ...child.ganttMarkers?.map((marker) => marker.date) ?? []]) if (date) dates.add(date);
    }
    for (const event of settings.ganttEvents) { dates.add(event.date); for (const cell of hours(event)) dates.add(cell.date); }
    for (let offset = 0; offset < 7; offset++) dates.add(addDays(snapshot.today, offset));
  };
  scan(snapshot.parents, snapshot.settings); scan(afterParents, afterSettings);
  const affectedDates = [...dates].sort();
  const before = ganttState(snapshot.parents, snapshot.settings, affectedDates), after = ganttState(afterParents, afterSettings, affectedDates);
  const parentIds = new Set(targets.flatMap((entity) => entity.kind === "task" ? [entity.taskId.split("::")[0]] : entity.kind === "marker" ? [entity.taskId.split("::")[0]] : []));
  const visibility = (entity: EntityRef): GanttProjectionV1["visibility"][number] => {
    if (entity.kind === "task") {
      const parent = after.parents.find((parent) => parent.id === entity.taskId.split("::")[0]) ?? before.parents.find((parent) => parent.id === entity.taskId.split("::")[0]);
      const child = parent?.children.find((child) => child.id === entity.taskId);
      if (!parent?.enabled) return { entity, state: "feature-disabled", reason: "親のGantt管理が無効です。" };
      if (child && (!child.period.start || !child.period.end)) return { entity, state: "unscheduled", reason: "予定日の両端が未設定です。" };
    }
    return { entity, state: "visible", reason: "投影に含まれます。実際の表示範囲とフィルターはビューで適用します。" };
  };
  return ganttProjectionSchema.parse({ schemaVersion: 1, baseRevision: snapshot.revision, settingsRevision: snapshot.settingsRevision, calendarRevision: snapshot.calendarRevision, evaluatedDate: snapshot.today, timezone: snapshot.timezone,
    before, after, targets, visibility: targets.map(visibility), affectedParentIds: [...parentIds], affectedDates,
    coverage: { targetCount: targets.length, offset: 0, includedCount: targets.length, truncated: false, nextCursor: null } });
}
