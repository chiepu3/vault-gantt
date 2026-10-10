import type { GanttMarker, TaskRow, WorkloadMap } from "../core/types";
import { addDays, clampDate, isWeekend } from "./gantt-layout";
import { isValidCalendarDate } from "../core/utils";














/**
 * A business day is neither a weekend day nor a configured holiday.
 */
export function isBusinessDay(date: string, holidaySet: Set<string>): boolean {
  return !isWeekend(date) && !holidaySet.has(date);
}

/**
 * Returns true for weekend days and configured holidays.
 */
export function isNonWorkingDate(dateStr: string, holidaySet: Set<string>): boolean {
  return !isBusinessDay(dateStr, holidaySet);
}

/**
 * Moves a date to the nearest business day in the chosen direction, stopping
 * at the nearest in-range date when the search reaches a boundary.
 */
export function snapWorkingDate(
  dateStr: string,
  holidaySet: Set<string>,
  direction = 1,
  minDate = "0001-01-01",
  maxDate = "9999-12-31"
): string {
  const step = direction < 0 ? -1 : 1;
  let cursor = dateStr;
  while (!isBusinessDay(cursor, holidaySet)) {
    const next = addDays(cursor, step);
    if (next < minDate || next > maxDate) {
      return cursor;
    }
    cursor = next;
  }
  return cursor;
}

/**
 * Counts business days inclusively and returns at least 1.
 */
export function countWorkingDaysInclusive(
  start: string,
  end: string,
  holidaySet: Set<string>
): number {
  if (!start || !end || end < start) {
    return 1;
  }
  let count = 0;
  let cursor = start;
  while (cursor <= end) {
    if (isBusinessDay(cursor, holidaySet)) {
      count += 1;
    }
    cursor = addDays(cursor, 1);
  }
  return Math.max(1, count);
}

/**
 * Moves a start date by a signed number of business days. The starting date
 * is snapped first, including when the requested amount is zero.
 */
export function addWorkingDays(
  start: string,
  amount: number,
  holidaySet: Set<string>
): string {
  const direction = amount < 0 ? -1 : 1;
  let cursor = snapWorkingDate(start, holidaySet, direction);
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    cursor = addDays(cursor, direction);
    if (isBusinessDay(cursor, holidaySet)) {
      remaining -= 1;
    }
  }
  return cursor; // no upper bound on amount
}









export function snapForward(date: string, holidaySet: Set<string>): string {
  let cursor = date;
  while (!isBusinessDay(cursor, holidaySet)) {
    cursor = addDays(cursor, 1);
  }
  return cursor;
}









export function snapBackward(date: string, holidaySet: Set<string>): string {
  let cursor = date;
  while (!isBusinessDay(cursor, holidaySet)) {
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

/** The first business day strictly AFTER `date`. */
export function nextBusinessDay(date: string, holidaySet: Set<string>): string {
  return snapForward(addDays(date, 1), holidaySet);
}

/** The first business day strictly BEFORE `date`. */
export function previousBusinessDay(
  date: string,
  holidaySet: Set<string>
): string {
  return snapBackward(addDays(date, -1), holidaySet);
}








export function snapResizeStart(
  rawNewStart: string,
  end: string,
  holidaySet: Set<string>
): string {
  const snapped = snapForward(rawNewStart, holidaySet);
  if (snapped > end) {
    return end;
  }
  return snapped;
}








export function snapResizeEnd(
  start: string,
  rawNewEnd: string,
  holidaySet: Set<string>
): string {
  const snapped = snapBackward(rawNewEnd, holidaySet);
  if (snapped < start) {
    return start;
  }
  return snapped;
}

/**
 *
 * `moveBarByCalendarDelta`'s bar-shaped input: a bar's own planned
 * start/end plus its markers (optional — a bar with no markers array is
 * treated the same as an empty one).
 */
export interface BarMoveInput {
  start: string;
  end: string;
  markers?: GanttMarker[];
}


export interface BarMoveResult {
  nextStart: string;
  nextEnd: string;
  shiftedMarkers: GanttMarker[];
}


































export function moveBarByCalendarDelta(
  bar: BarMoveInput,
  deltaDays: number,
  holidaySet: Set<string>
): BarMoveResult {
  const duration = countWorkingDaysInclusive(bar.start, bar.end, holidaySet);
  const direction = deltaDays < 0 ? -1 : 1;
  const rawNextStart = addDays(bar.start, deltaDays);
  const nextStart = isBusinessDay(rawNextStart, holidaySet)
    ? rawNextStart
    : snapWorkingDate(rawNextStart, holidaySet, direction);
  const nextEnd = addWorkingDays(nextStart, duration - 1, holidaySet);

  const shiftedMarkers = shiftMarkers(bar.markers, deltaDays, holidaySet, {
    oldStart: bar.start,
    newStart: nextStart,
    newEnd: nextEnd,
  });

  return { nextStart, nextEnd, shiftedMarkers };
}













export function snapMarkerDate(
  rawDate: string,
  rangeStart: string,
  rangeEnd: string,
  holidaySet: Set<string>
): string {
  let clamped = rawDate;
  if (clamped < rangeStart) {
    clamped = rangeStart;
  } else if (clamped > rangeEnd) {
    clamped = rangeEnd;
  }

  const forward = snapForward(clamped, holidaySet);
  if (forward <= rangeEnd) {
    return forward;
  }
  const backward = snapBackward(clamped, holidaySet);
  if (backward >= rangeStart) {
    return backward;
  }
  return clamped;
}





/**
 *
 * Converts a horizontal pixel delta into a whole number of calendar days,
 * rounding to the nearest day. `dayWidth <= 0` is defensive (never reached
 * in practice — the zoom clamp keeps dayWidth >= 4) and returns 0 rather
 * than dividing by zero/negative.
 */
export function pixelDeltaToDayDelta(
  pixelDeltaX: number,
  dayWidth: number
): number {
  if (dayWidth <= 0) {
    return 0;
  }
  return Math.round(pixelDeltaX / dayWidth);
}










































export function shiftMarkers(
  markers: GanttMarker[] | undefined,
  shiftDays: number,
  holidaySet: Set<string>,
  range: { oldStart: string; newStart: string; newEnd: string }
): GanttMarker[] {
  if (!markers) {
    return [];
  }
  return markers.map((marker) => ({
    ...marker,
    date: relocateMovedMarkerDate(marker.date, shiftDays, holidaySet, range),
  }));
}

/** the per-marker half of shiftMarkers's algorithm above. */
function relocateMovedMarkerDate(
  date: string,
  shiftDays: number,
  holidaySet: Set<string>,
  range: { oldStart: string; newStart: string; newEnd: string }
): string {
  let candidate: string;
  if (!isBusinessDay(date, holidaySet)) {
    const shifted = addDays(date, shiftDays);
    const direction = shiftDays < 0 ? -1 : 1;
    candidate = isBusinessDay(shifted, holidaySet)
      ? shifted
      : snapWorkingDate(shifted, holidaySet, direction);
  } else {
    const offset =
      countWorkingDaysInclusive(range.oldStart, date, holidaySet) - 1;
    candidate = addWorkingDays(range.newStart, offset, holidaySet);
  }
  return clampDate(candidate, range.newStart, range.newEnd);
}

/**
 *
 * The signed count of business days (per isBusinessDay) strictly between
 * `from` and `to`: positive when `to` is later, negative when earlier, 0
 * when equal. Walks one calendar day at a time — workload shifts operate
 * over task-duration-sized ranges, so this stays cheap in practice.
 */
function businessDayOffset(
  from: string,
  to: string,
  holidaySet: Set<string>
): number {
  let offset = 0;
  let cursor = from;
  if (to > from) {
    while (cursor < to) {
      cursor = addDays(cursor, 1);
      if (isBusinessDay(cursor, holidaySet)) {
        offset += 1;
      }
    }
  } else if (to < from) {
    while (cursor > to) {
      cursor = addDays(cursor, -1);
      if (isBusinessDay(cursor, holidaySet)) {
        offset -= 1;
      }
    }
  }
  return offset;
}

/**
 *
 * The inverse of businessDayOffset: the date reached by walking `offset`
 * business days forward (positive) or backward (negative) from `from`.
 * `offset === 0` returns `from` unchanged, even when `from` itself is not a
 * business day — this is pure date arithmetic, not a snap.
 */
function businessDayFromOffset(
  from: string,
  offset: number,
  holidaySet: Set<string>
): string {
  let cursor = from;
  let remaining = offset;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(cursor, holidaySet)) {
      remaining -= 1;
    }
  }
  while (remaining < 0) {
    cursor = addDays(cursor, -1);
    if (isBusinessDay(cursor, holidaySet)) {
      remaining += 1;
    }
  }
  return cursor;
}

/** Non-empty AND calendar-valid — isValidCalendarDate alone treats "" as valid. */
function isConcreteCalendarDate(value: string | undefined): value is string {
  return !!value && isValidCalendarDate(value);
}
























export function shiftWorkloadMap(
  map: WorkloadMap | undefined,
  shiftDays: number,
  workingDayCalendar?: {
    oldStart: string | undefined;
    newStart: string | undefined;
    holidaySet: Set<string>;
  }
): WorkloadMap | undefined {
  if (!map) {
    return map;
  }

  if (
    workingDayCalendar &&
    isConcreteCalendarDate(workingDayCalendar.oldStart) &&
    isConcreteCalendarDate(workingDayCalendar.newStart)
  ) {
    const { oldStart, newStart, holidaySet } = workingDayCalendar;
    const shifted: WorkloadMap = {};
    for (const [date, hours] of Object.entries(map)) {
      const offset = businessDayOffset(oldStart, date, holidaySet);
      const newDate = businessDayFromOffset(newStart, offset, holidaySet);
      shifted[newDate] = (shifted[newDate] ?? 0) + hours;
    }
    return shifted;
  }

  if (shiftDays === 0) {
    return { ...map };
  }
  const shifted: WorkloadMap = {};
  for (const [date, hours] of Object.entries(map)) {
    const newDate = addDays(date, shiftDays);
    shifted[newDate] = (shifted[newDate] ?? 0) + hours;
  }
  return shifted;
}





/**
 *
 * Whether a task carries any recorded work-hour actuals at all (any date
 * key with a positive hour value). Drives the pre-save confirmation prompt
 * for bar-move / resize / bulk-move.
 */
export function hasWorkloadActual(task: TaskRow): boolean {
  const map = task.workloadActual;
  if (!map) {
    return false;
  }
  return Object.values(map).some((hours) => hours > 0);
}











export type WorkloadMode = "plan" | "actual";


export interface WorkloadHost {
  workloadPlan?: WorkloadMap;
  workloadActual?: WorkloadMap;
}






















export function getWorkloadTaskKey(task: TaskRow): string {
  return (
    task.id || task.key || task.file?.parentPath || task.file?.path || ""
  );
}


/**
 *
 * Ensures `entity.workloadPlan` / `entity.workloadActual` is a real object
 * (never `undefined`) so callers can read/write it without a null check,
 * creating `{}` in place when the field was missing and returning it either way.
 * Mutates the workload-bearing entity; persistence remains the caller's job.
 */
export function ensureWorkloadRecord(
  entity: WorkloadHost,
  mode: WorkloadMode
): WorkloadMap {
  if (mode === "plan") {
    if (!entity.workloadPlan) {
      entity.workloadPlan = {};
    }
    return entity.workloadPlan;
  }
  if (!entity.workloadActual) {
    entity.workloadActual = {};
  }
  return entity.workloadActual;
}

/**
 *
 * The plan/actual hour values recorded for one date, each defaulting to 0
 * when the map or the date's entry is absent.
 */
export function dayValues(
  entity: WorkloadHost,
  date: string
): { plan: number; actual: number } {
  return {
    plan: entity.workloadPlan?.[date] ?? 0,
    actual: entity.workloadActual?.[date] ?? 0,
  };
}

/**
 *
 * Writes one date's hour value into the correct in-memory map: `value <= 0`
 * deletes the entry (mirroring normalizeWorkloadMap's own "0 or below is
 * dropped" rule, task-patch.ts:50-52), `value > 0` sets it. Pure in-memory
 * mutation only — persistence belongs to the caller that drives the paint
 * interaction.
 */
export function setValue(
  entity: WorkloadHost,
  date: string,
  mode: WorkloadMode,
  value: number
): void {
  const map = ensureWorkloadRecord(entity, mode);
  if (value <= 0) {
    delete map[date];
  } else {
    map[date] = value;
  }
}













export function roundHalfHour(value: number): number {
  return Math.max(0, Math.round(value * 2) / 2);
}






/** "YYYY-MM-DD → YYYY-MM-DD". */
export function formatDragRangeTooltip(start: string, end: string): string {
  return `${start} → ${end}`;
}

/** "<タイトル>: <日付>". */
export function formatMarkerDragTooltip(title: string, date: string): string {
  return `${title}: ${date}`;
}






export function formatDueDateDragTooltip(date: string): string {
  return `期限: ${date}`;
}

/** "一括移動: <日付> → <日付>". */
export function formatBulkMoveDragTooltip(
  fromDate: string,
  toDate: string
): string {
  return `一括移動: ${fromDate} → ${toDate}`;
}





/**
 *
 * Bulk-Move's target sort order: start → end → displayName (falling back to
 * title when displayName is empty — this codebase's usual "name" idiom, e.g.
 * deleteSubtaskInteractively's fallback in task-gantt-view.ts).
 * Exported (not just an internal comparator) so both
 * getBulkMoveKeysForParent below and task-gantt-view.ts's own
 * anchor-selection helper share one sort definition — the two must agree on
 * ordering or an anchor chosen under one order could go missing under the
 * other's index lookup.
 */
export function sortForBulkMove(subtasks: TaskRow[]): TaskRow[] {
  return [...subtasks].sort((a, b) => {
    const aStart = a.plannedStartDate ?? "";
    const bStart = b.plannedStartDate ?? "";
    if (aStart !== bStart) {
      return aStart < bStart ? -1 : 1;
    }
    const aEnd = a.plannedEndDate ?? "";
    const bEnd = b.plannedEndDate ?? "";
    if (aEnd !== bEnd) {
      return aEnd < bEnd ? -1 : 1;
    }
    const aName = a.displayName || a.title;
    const bName = b.displayName || b.title;
    if (aName !== bName) {
      return aName < bName ? -1 : 1;
    }
    return 0;
  });
}














export function getBulkMoveKeysForParent(
  parent: TaskRow,
  anchorKey: string
): Set<string> {
  const subtasks = parent.subtasks
    ? Array.from(parent.subtasks.values())
    : [];
  const sorted = sortForBulkMove(subtasks);
  const anchorIndex = sorted.findIndex((t) => t.id === anchorKey);
  if (anchorIndex === -1) {
    return new Set();
  }
  return new Set(sorted.slice(anchorIndex).map((t) => t.id));
}
