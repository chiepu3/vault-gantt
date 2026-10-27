import type { GanttMarker, TaskRow } from "./types";
import { makeUniqueMarkerKey } from "./utils";

/** Key and title of the milestone that a parent's legacy single `dueDate` stands for. */
export const LEGACY_MILESTONE_KEY = "due";
export const LEGACY_MILESTONE_TITLE = "期限";

const byDate = (a: GanttMarker, b: GanttMarker): number => a.date.localeCompare(b.date);

/** A parent's milestones, oldest first. A parent without any falls back to its single `dueDate`. */
export function getMilestones(row: Pick<TaskRow, "milestones" | "dueDate">): GanttMarker[] {
  if (row.milestones) return [...row.milestones].sort(byDate);
  return row.dueDate ? [{ key: LEGACY_MILESTONE_KEY, title: LEGACY_MILESTONE_TITLE, date: row.dueDate }] : [];
}

export function earliestMilestoneDate(milestones: readonly GanttMarker[]): string | undefined {
  let earliest: string | undefined;
  for (const milestone of milestones) if (!earliest || milestone.date < earliest) earliest = milestone.date;
  return earliest;
}

/** Only the plain "期限" that the legacy `due` already carries; nothing to store under `milestones`. */
export function isLegacyOnlyMilestones(milestones: readonly GanttMarker[]): boolean {
  return milestones.length === 1 && milestones[0].title === LEGACY_MILESTONE_TITLE && !milestones[0].tags?.length;
}

/**
 * Sets (or, with "", removes) the earliest milestone's date: what a plain `dueDate` write means once a
 * parent can hold several milestones. Creates the legacy "期限" milestone when there is none.
 */
export function withDueDate(current: readonly GanttMarker[], due: string): GanttMarker[] {
  const sorted = [...current].sort(byDate);
  if (sorted.length === 0) {
    return due ? [{ key: LEGACY_MILESTONE_KEY, title: LEGACY_MILESTONE_TITLE, date: due }] : [];
  }
  return due ? [{ ...sorted[0], date: due }, ...sorted.slice(1)] : sorted.slice(1);
}

/** A key for a milestone added to `current`, derived from its title like marker keys are. */
export function newMilestoneKey(title: string, current: readonly GanttMarker[]): string {
  return makeUniqueMarkerKey(title, new Set(current.map((milestone) => milestone.key)));
}
