import type { GanttChildStateV1, GanttProjectionV1, GanttStateV1 } from "../contracts/preview";
import type { Overlay, RowState } from "./preview-gantt-layer";

/** What the real Gantt marks for the focused preview. Pure presentation diff of the projector's snapshots. */
export type HlState = "created" | "changed" | "deleted";
export interface HoursPair { readonly plan: number; readonly actual: number }
export interface CellChange { readonly date: string; readonly before: HoursPair; readonly after: HoursPair }
export interface DailyChange {
  readonly date: string; readonly state: HlState;
  readonly before?: { readonly total: number; readonly completed: number };
  readonly after?: { readonly total: number; readonly completed: number };
  readonly lines: readonly string[];
}
export interface EventChange {
  readonly key: string; readonly state: HlState; readonly title: string;
  readonly before?: { readonly title: string; readonly date: string };
  readonly after?: { readonly title: string; readonly date: string };
  readonly beforeHours: readonly { readonly date: string; readonly plan: number; readonly actual: number }[];
  readonly afterHours: readonly { readonly date: string; readonly plan: number; readonly actual: number }[];
}
export interface TotalsChange { readonly date: string; readonly before: HoursPair; readonly after: HoursPair }
export interface PhantomBar { readonly id: string; readonly name: string; readonly start: string; readonly end: string; readonly state: "created" | "deleted" }
export interface Highlights {
  /** Child task ids and parent ids that change. Unchanged rows are absent. */
  readonly rows: ReadonlyMap<string, HlState>;
  /** Task id, or `event:<key>`, to its changed hour cells by date. */
  readonly workload: ReadonlyMap<string, ReadonlyMap<string, CellChange>>;
  readonly totals: ReadonlyMap<string, TotalsChange>;
  readonly daily: ReadonlyMap<string, DailyChange>;
  readonly events: ReadonlyMap<string, EventChange>;
  readonly phantoms: ReadonlyMap<string, readonly PhantomBar[]>;
  readonly firstTaskId?: string;
  readonly firstDate?: string;
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const ZERO: HoursPair = { plan: 0, actual: 0 };
export const eventWorkloadKey = (key: string): string => `event:${key}`;
const fmtH = (value: number): string => `${Math.round(value * 100) / 100}h`;

/** "計画 2h → 3h / 実績 0h → 1h", only for the side(s) that change. */
export function hoursChangeText(before: HoursPair, after: HoursPair): string {
  const parts: string[] = [];
  if (before.plan !== after.plan) parts.push(`計画 ${fmtH(before.plan)} → ${fmtH(after.plan)}`);
  if (before.actual !== after.actual) parts.push(`実績 ${fmtH(before.actual)} → ${fmtH(after.actual)}`);
  return parts.join(" / ");
}
/** The hours a changed cell shows: the new value, or the old one (marked removed) when nothing is left. */
export function displayedHours(change: CellChange): { hours: HoursPair; removed: boolean } {
  const removed = change.after.plan === 0 && change.after.actual === 0;
  return { hours: removed ? change.before : change.after, removed };
}

function cellMap(cells: readonly { readonly date: string; readonly plan: number; readonly actual: number }[] | undefined): Map<string, HoursPair> {
  const result = new Map<string, HoursPair>();
  for (const cell of cells ?? []) result.set(cell.date, { plan: cell.plan, actual: cell.actual });
  return result;
}
function diffCells(before: readonly { readonly date: string; readonly plan: number; readonly actual: number }[] | undefined, after: typeof before): Map<string, CellChange> {
  const oldCells = cellMap(before); const newCells = cellMap(after); const result = new Map<string, CellChange>();
  for (const date of new Set([...oldCells.keys(), ...newCells.keys()])) {
    const oldValue = oldCells.get(date) ?? ZERO; const newValue = newCells.get(date) ?? ZERO;
    if (oldValue.plan !== newValue.plan || oldValue.actual !== newValue.actual) result.set(date, { date, before: oldValue, after: newValue });
  }
  return result;
}

function dailyLines(before: GanttStateV1["daily"][number] | undefined, after: GanttStateV1["daily"][number] | undefined): string[] {
  const lines: string[] = [];
  const oldItems = before?.items; const newItems = after?.items;
  if (oldItems && newItems) {
    const key = (item: { text: string }): string => item.text;
    for (const item of newItems) {
      const old = oldItems.find((candidate) => key(candidate) === key(item));
      if (!old) lines.push(`＋ ${item.text}`);
      else if (old.completed !== item.completed) lines.push(`${item.completed ? "☑" : "☐"} ${item.text}`);
    }
    for (const item of oldItems) if (!newItems.some((candidate) => key(candidate) === key(item))) lines.push(`－ ${item.text}`);
  }
  return lines;
}

function childWorkload(oldChild: GanttChildStateV1 | undefined, newChild: GanttChildStateV1 | undefined): Map<string, CellChange> {
  return diffCells(oldChild?.hours, newChild?.hours);
}

export function deriveHighlights(projection: GanttProjectionV1, overlay: Overlay): Highlights {
  const rows = new Map<string, HlState>(); const workload = new Map<string, ReadonlyMap<string, CellChange>>();
  const phantoms = new Map<string, PhantomBar[]>();
  const dates: string[] = []; let firstTaskId: string | undefined;
  const asHl = (state: RowState): HlState | undefined => (state === "context" ? undefined : state);
  for (const parent of overlay.parents) {
    const parentState = asHl(parent.state);
    if (parentState) rows.set(parent.id, parentState);
    for (const child of parent.children) {
      const state = asHl(child.state); if (!state) continue;
      rows.set(child.id, state);
      firstTaskId ??= child.id;
      for (const side of [child.before, child.after]) if (side) dates.push(...[side.period.start, side.period.end].filter((date): date is string => !!date));
      const cells = childWorkload(child.before, child.after);
      if (cells.size) { workload.set(child.id, cells); dates.push(...cells.keys()); }
      const shown = state === "deleted" ? child.before : child.after;
      if (state !== "changed" && shown?.period.start && shown.period.end) {
        const list = phantoms.get(parent.id) ?? [];
        list.push({ id: child.id, name: child.name, start: shown.period.start, end: shown.period.end, state });
        phantoms.set(parent.id, list);
      }
    }
  }
  // Events: keyed by event key.
  const events = new Map<string, EventChange>();
  for (const key of new Set([...projection.before.events, ...projection.after.events].map((event) => event.key))) {
    const oldEvent = projection.before.events.find((event) => event.key === key); const newEvent = projection.after.events.find((event) => event.key === key);
    if (same(oldEvent, newEvent)) continue;
    const state: HlState = !oldEvent ? "created" : !newEvent ? "deleted" : "changed";
    events.set(key, {
      key, state, title: (newEvent ?? oldEvent)?.title ?? "",
      before: oldEvent ? { title: oldEvent.title, date: oldEvent.date } : undefined, after: newEvent ? { title: newEvent.title, date: newEvent.date } : undefined,
      beforeHours: oldEvent?.hours ?? [], afterHours: newEvent?.hours ?? [],
    });
    dates.push(...[oldEvent?.date, newEvent?.date].filter((date): date is string => !!date));
    const cells = diffCells(oldEvent?.hours, newEvent?.hours);
    if (cells.size) { workload.set(eventWorkloadKey(key), cells); dates.push(...cells.keys()); }
  }
  // Daily ToDo: per date.
  const daily = new Map<string, DailyChange>();
  for (const date of new Set([...projection.before.daily, ...projection.after.daily].map((day) => day.date))) {
    const oldDay = projection.before.daily.find((day) => day.date === date); const newDay = projection.after.daily.find((day) => day.date === date);
    if (same(oldDay, newDay)) continue;
    const state: HlState = !oldDay || oldDay.totalCount === 0 ? "created" : !newDay || newDay.totalCount === 0 ? "deleted" : "changed";
    daily.set(date, {
      date, state,
      before: oldDay ? { total: oldDay.totalCount, completed: oldDay.completedCount } : undefined,
      after: newDay ? { total: newDay.totalCount, completed: newDay.completedCount } : undefined,
      lines: dailyLines(oldDay, newDay),
    });
    dates.push(date);
  }
  // Daily totals shown in the workload row.
  const totals = new Map<string, TotalsChange>();
  for (const date of new Set([...projection.before.aggregates, ...projection.after.aggregates].map((day) => day.date))) {
    const oldDay = projection.before.aggregates.find((day) => day.date === date); const newDay = projection.after.aggregates.find((day) => day.date === date);
    const before = { plan: oldDay?.plan ?? 0, actual: oldDay?.actual ?? 0 }; const after = { plan: newDay?.plan ?? 0, actual: newDay?.actual ?? 0 };
    if (before.plan !== after.plan || before.actual !== after.actual) totals.set(date, { date, before, after });
  }
  for (const change of overlay.points.values()) for (const point of change) dates.push(...[point.before, point.after].filter((date): date is string => !!date));
  dates.sort();
  return { rows, workload, totals, daily, events, phantoms, firstTaskId, firstDate: dates[0] };
}
