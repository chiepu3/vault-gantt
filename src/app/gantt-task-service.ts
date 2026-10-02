import type {
  GanttEvent,
  TaskPatch,
  TaskRow,
  TaskWorkbenchSettings,
  WeeklyWorkSchedule,
} from "../core/types";
import { getGanttParentRows } from "./gantt-layout";











// (mirrored from gantt-layout.ts's private
// GANTT_ORDER_FALLBACK — not exported there, so re-declared here to match
// main.ts's createGanttParentInteractively, whose

const GANTT_ORDER_FALLBACK = 999999;












export function addGanttEvent(
  settings: TaskWorkbenchSettings,
  title: string,
  date: string
): GanttEvent {
  if (!Array.isArray(settings.ganttEvents)) {
    settings.ganttEvents = [];
  }

  const existingKeys = new Set(settings.ganttEvents.map((event) => event.key));
  let key = `event-${Date.now()}`;
  while (existingKeys.has(key)) {
    key = `event-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  const event: GanttEvent = {
    key,
    title: String(title || "新しいタスク"),
    date, //  no validation
  };
  settings.ganttEvents.push(event);
  return event;
}

/**
 *
 * Partial-merges `patch` into the `settings.ganttEvents` entry matching
 * `key`. Silent no-op if `key` is not found (or `ganttEvents` is not an
 * array).
 */
export function updateGanttEvent(
  settings: TaskWorkbenchSettings,
  key: string,
  patch: Partial<GanttEvent>
): void {
  if (!Array.isArray(settings.ganttEvents)) {
    return;
  }
  const event = settings.ganttEvents.find((candidate) => candidate.key === key);
  if (!event) {
    return; // silent no-op
  }
  Object.assign(event, patch);
}

/**
 *
 * Removes the `settings.ganttEvents` entry matching `key`. Silent no-op if
 * `key` is not found (or `ganttEvents` is not an array).
 */
export function deleteGanttEvent(settings: TaskWorkbenchSettings, key: string): void {
  if (!Array.isArray(settings.ganttEvents)) {
    return;
  }
  const index = settings.ganttEvents.findIndex((candidate) => candidate.key === key);
  if (index === -1) {
    return; // silent no-op
  }
  settings.ganttEvents.splice(index, 1);
}


function ensureWeeklyWorkSchedules(
  settings: TaskWorkbenchSettings
): WeeklyWorkSchedule[] {
  if (!Array.isArray(settings.weeklyWorkSchedules)) {
    settings.weeklyWorkSchedules = [];
  }
  return settings.weeklyWorkSchedules;
}

function normalizeWeeklyMinutes(value: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.round(numericValue / 30) * 30);
}

/**
 *
 * Adds a weekly recurring work schedule to settings in place. The key uses
 * the same timestamp-plus-collision-suffix convention as Gantt events, while
 * minutes are always normalized to a non-negative 30-minute multiple.
 */
export function addWeeklyWorkSchedule(
  settings: TaskWorkbenchSettings,
  title: string,
  dayOfWeek: number,
  minutesPerWeek: number
): WeeklyWorkSchedule {
  const schedules = ensureWeeklyWorkSchedules(settings);
  const existingKeys = new Set(schedules.map((schedule) => schedule.key));
  let key = `schedule-${Date.now()}`;
  while (existingKeys.has(key)) {
    key = `schedule-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  const schedule: WeeklyWorkSchedule = {
    key,
    title: String(title ?? ""),
    dayOfWeek,
    minutesPerWeek: normalizeWeeklyMinutes(minutesPerWeek),
  };
  schedules.push(schedule);
  return schedule;
}

/**
 *
 * Partially updates a weekly schedule in place. Missing keys are a silent
 * no-op, and minutes are normalized at the persistence boundary.
 */
export function updateWeeklyWorkSchedule(
  settings: TaskWorkbenchSettings,
  key: string,
  patch: Partial<WeeklyWorkSchedule>
): void {
  const schedules = ensureWeeklyWorkSchedules(settings);
  const schedule = schedules.find((candidate) => candidate.key === key);
  if (!schedule) {
    return;
  }

  const normalizedPatch: Partial<WeeklyWorkSchedule> = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "minutesPerWeek")) {
    normalizedPatch.minutesPerWeek = normalizeWeeklyMinutes(
      patch.minutesPerWeek ?? 0
    );
  }
  Object.assign(schedule, normalizedPatch);
}

/**
 *
 * Deletes a weekly schedule in place. Missing keys are a silent no-op.
 */
export function deleteWeeklyWorkSchedule(
  settings: TaskWorkbenchSettings,
  key: string
): void {
  const schedules = ensureWeeklyWorkSchedules(settings);
  const index = schedules.findIndex((candidate) => candidate.key === key);
  if (index === -1) {
    return;
  }
  schedules.splice(index, 1);
}



/**
 *
 * Duplicates an event in place, retaining its title/date and independently
 * copying both workload maps. Missing keys and malformed event arrays are
 * silent no-ops, matching the other event CRUD helpers.
 */
export function duplicateGanttEvent(
  settings: TaskWorkbenchSettings,
  key: string
): GanttEvent | undefined {
  if (!Array.isArray(settings.ganttEvents)) {
    return undefined;
  }
  const source = settings.ganttEvents.find((event) => event.key === key);
  if (!source) {
    return undefined;
  }

  const existingKeys = new Set(settings.ganttEvents.map((event) => event.key));
  let duplicateKey = `event-${Date.now()}`;
  while (existingKeys.has(duplicateKey)) {
    duplicateKey = `event-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  const duplicate: GanttEvent = {
    key: duplicateKey,
    title: source.title,
    date: source.date,
    ...(source.workloadPlan !== undefined
      ? { workloadPlan: { ...source.workloadPlan } }
      : {}),
    ...(source.workloadActual !== undefined
      ? { workloadActual: { ...source.workloadActual } }
      : {}),
  };
  settings.ganttEvents.push(duplicate);
  return duplicate;
}

















export async function enableParentInGantt(
  parent: TaskRow,
  tasks: TaskRow[],
  updateTaskItem: (row: TaskRow, patch: TaskPatch) => Promise<unknown>
): Promise<void> {
  const parents = getGanttParentRows(tasks); // kind:"parent" && ganttEnabled:true
  const orders = parents.map((p) =>
    typeof p.ganttOrder === "number" && isFinite(p.ganttOrder)
      ? p.ganttOrder
      : GANTT_ORDER_FALLBACK
  );
  const nextOrder = orders.length > 0 ? Math.max(...orders) + 1000 : 1000;

  await updateTaskItem(parent, { ganttEnabled: true, ganttOrder: nextOrder });
}
