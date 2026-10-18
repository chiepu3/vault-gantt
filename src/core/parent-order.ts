import type { TaskRow, TaskWorkbenchSettings } from "./types";

// Gantt parent order lives in settings.ganttParentOrder (note paths), not in notes.
// Rows get an in-memory ganttOrder of (index + 1) * 1000 so existing consumers keep working.
const STEP = 1000;
const FALLBACK = 999999;

const noteOrder = (row: TaskRow): number => {
  const value = row.ganttOrder;
  return typeof value === "number" && isFinite(value) ? value : FALLBACK;
};

/** Same ordering as getGanttParentRows: note ganttOrder, then name. */
function byNoteOrder(a: TaskRow, b: TaskRow): number {
  return noteOrder(a) - noteOrder(b) || (a.displayName || a.title).localeCompare(b.displayName || b.title);
}

/** Rank-derived value stored in memory on each parent row. */
export const orderValue = (index: number): number => (index + 1) * STEP;

/** Sets row.ganttOrder from the stored order; parents missing from it are left as they are. */
export function applyStoredOrder(settings: Pick<TaskWorkbenchSettings, "ganttParentOrder">, parents: readonly TaskRow[]): void {
  const rank = new Map<string, number>();
  (settings.ganttParentOrder ?? []).forEach((path, index) => { if (!rank.has(path)) rank.set(path, index); });
  for (const row of parents) {
    const index = rank.get(row.file.path);
    if (row.kind === "parent" && index !== undefined) row.ganttOrder = orderValue(index);
  }
}

/**
 * Migrates / completes the stored order from the loaded parents, then applies it to the rows.
 * Returns true when settings.ganttParentOrder was created or extended (caller should persist).
 */
export function reconcileParentOrder(settings: Pick<TaskWorkbenchSettings, "ganttParentOrder">, parents: readonly TaskRow[]): boolean {
  const rows = parents.filter((row) => row.kind === "parent");
  let changed = false;
  if (!settings.ganttParentOrder) {
    settings.ganttParentOrder = [...rows].sort(byNoteOrder).map((row) => row.file.path);
    changed = true;
  } else {
    const known = new Set(settings.ganttParentOrder);
    const missing = rows.filter((row) => !known.has(row.file.path)).sort(byNoteOrder);
    if (missing.length) {
      settings.ganttParentOrder = [...settings.ganttParentOrder, ...missing.map((row) => row.file.path)];
      changed = true;
    }
  }
  applyStoredOrder(settings, rows);
  return changed;
}

/**
 * New stored order after assigning numeric ganttOrder targets (path -> value).
 * Untargeted parents keep their rank-derived value; ties keep the previous rank.
 */
export function computeParentOrder(order: readonly string[], targets: ReadonlyMap<string, number>): string[] {
  const entries = order.map((path, index) => ({ path, value: targets.get(path) ?? orderValue(index), rank: index }));
  for (const [path, value] of targets) {
    if (!order.includes(path)) entries.push({ path, value, rank: entries.length });
  }
  return entries.sort((a, b) => a.value - b.value || a.rank - b.rank).map((entry) => entry.path);
}

/** Path moved in the vault. */
export function renameInParentOrder(order: readonly string[], from: string, to: string): string[] {
  const renamed = order.map((path) => path === from ? to : path);
  return renamed.filter((path, index) => renamed.indexOf(path) === index);
}
