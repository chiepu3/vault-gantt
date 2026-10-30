import type { MemoMeta } from "../core/memo";
import type { TaskRow } from "../core/types";
import { addDays, diffDays } from "./gantt-layout";

/** What a memo is attached to, with its date worked out. */
export interface MemoAnchor {
  /** subtask: on a bar; parent: on a parent row; free: on the 「その他」 row. */
  kind: "subtask" | "parent" | "free";
  taskId?: string;
  taskName?: string;
  /** The parent row that carries the memo (the subtask's parent, or the parent itself). */
  parentId?: string;
  date: string;
  /** The memo names a task that no longer exists, so it sits on the 「その他」 row at its last known date. */
  orphan?: boolean;
  /** The task has no planned dates, so there is no bar to attach to. */
  unplaced?: boolean;
}

/** Date a memo was last known to sit on: the stored date, else the day it was created. */
const lastKnownDate = (meta: MemoMeta): string => meta.date || meta.created;

/**
 * Resolves where a memo sits. A subtask memo follows its bar (plannedStartDate + `at`, clamped to the bar's end);
 * a memo whose task is gone falls back to the 「その他」 row.
 */
export function resolveMemoAnchor(meta: MemoMeta, rows: ReadonlyMap<string, TaskRow>): MemoAnchor {
  const row = meta.taskId ? rows.get(meta.taskId) : undefined;
  if (meta.taskId && !row) return { kind: "free", date: lastKnownDate(meta), orphan: true };
  if (!row) return { kind: "free", date: lastKnownDate(meta) };
  const name = row.displayName || row.title;
  if (row.kind === "parent") return { kind: "parent", taskId: row.id, taskName: name, parentId: row.id, date: lastKnownDate(meta) };
  const start = row.plannedStartDate;
  if (!start) return { kind: "subtask", taskId: row.id, taskName: name, parentId: row.parentId, date: lastKnownDate(meta), unplaced: true };
  const end = row.plannedEndDate && row.plannedEndDate >= start ? row.plannedEndDate : start;
  const date = addDays(start, meta.at ?? 0);
  return { kind: "subtask", taskId: row.id, taskName: name, parentId: row.parentId, date: date > end ? end : date };
}

/** `at` for a memo that should sit on `date` of the bar starting at `start`. */
export const dayOffsetFrom = (start: string, date: string): number => Math.max(0, diffDays(start, date));

/** The anchor keys a memo note stores for `date` on `task` (undefined = the 「その他」 row). A subtask needs a bar to count days from. */
export function memoAnchorFields(task: TaskRow | undefined, date: string): Pick<MemoMeta, "taskId" | "at" | "date"> {
  if (!task) return { date };
  if (task.kind === "parent") return { taskId: task.id, date };
  if (!task.plannedStartDate) throw new Error("Subtask has no planned start date");
  return { taskId: task.id, at: dayOffsetFrom(task.plannedStartDate, date), date };
}
