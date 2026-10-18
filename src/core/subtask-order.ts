import type { TaskRow, TaskWorkbenchSettings } from "./types";

type OrderSettings = Pick<TaskWorkbenchSettings, "subtaskOrder">;

/** Stored order first; subtasks missing from it follow, oldest `created` first, then by title. */
export function sortSubtasks(settings: OrderSettings, parentId: string, children: readonly TaskRow[]): TaskRow[] {
  const rank = new Map<string, number>();
  (settings.subtaskOrder?.[parentId] ?? []).forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  const stored = children.filter((child) => rank.has(child.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const missing = children
    .filter((child) => !rank.has(child.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.displayName || a.title).localeCompare(b.displayName || b.title) || a.id.localeCompare(b.id));
  return [...stored, ...missing];
}

/** New stored order for one parent with `ids` appended (already present ids stay where they are). */
export function appendSubtaskOrder(settings: OrderSettings, parentId: string, ids: readonly string[], children?: readonly TaskRow[]): Record<string, string[]> {
  const current = settings.subtaskOrder?.[parentId] ?? (children ? sortSubtasks(settings, parentId, children).map((row) => row.id) : []);
  return { ...settings.subtaskOrder, [parentId]: [...current, ...ids.filter((id) => !current.includes(id))] };
}

/** Moves one subtask to `index` within its parent's order (the full current order is stored). */
export function moveSubtaskOrder(settings: OrderSettings, parentId: string, children: readonly TaskRow[], id: string, index: number): Record<string, string[]> {
  const ids = sortSubtasks(settings, parentId, children).map((row) => row.id).filter((other) => other !== id);
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
  return { ...settings.subtaskOrder, [parentId]: ids };
}

/** Drops ids that are not subtasks of the parent any more. Returns the same object when nothing changed. */
export function pruneSubtaskOrder(order: Record<string, string[]> | undefined, parentId: string, existing: ReadonlySet<string>): Record<string, string[]> | undefined {
  const current = order?.[parentId];
  if (!order || !current) return order;
  const kept = current.filter((id) => existing.has(id));
  if (kept.length === current.length) return order;
  return { ...order, [parentId]: kept };
}
