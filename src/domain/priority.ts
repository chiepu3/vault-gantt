/**
 * Auto-priority calculation based on due date.
 * Pure function — takes today explicitly, never reads system clock.
 */

/**
 * Configuration thresholds for auto-priority calculation.
 */
export interface PriorityThresholds {
  within3Days: number;
  within7Days: number;
  within14Days: number;
  overdueOrToday: number;
  beyond: number;
  noDueDate: number;
}

/**
 * Default priority thresholds per CURRENT_SPEC.md §3.2:
 * - 期限超過/当日 = 5
 * - 3日以内 = 4
 * - 7日以内 = 3
 * - 14日以内 = 2
 * - それ以外 = 1
 * - 期限なし = 0
 */
export const DEFAULT_PRIORITY_THRESHOLDS: PriorityThresholds = {
  overdueOrToday: 5,
  within3Days: 4,
  within7Days: 3,
  within14Days: 2,
  beyond: 1,
  noDueDate: 0,
};

/**
 * Parse a date string in YYYY-MM-DD format to a Date object (UTC).
 */
function parseUTC(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00Z');
}

/**
 * Calculate the number of days between two dates (dueDate - today).
 * Positive means due date is in the future.
 * Zero or negative means due date is today or in the past.
 */
function calculateDayDifference(dueDate: string, today: string): number {
  const due = parseUTC(dueDate);
  const todayDate = parseUTC(today);
  const diffMillis = due.getTime() - todayDate.getTime();
  return Math.floor(diffMillis / (1000 * 60 * 60 * 24));
}

/**
 * Calculate auto-priority based on due date.
 *
 * Rules (in precedence order):
 * 1. If no dueDate → return noDueDate
 * 2. If dueDate <= today (overdue or today) → return overdueOrToday
 * 3. Otherwise, compute day difference and apply bands:
 *    - day-diff <= 3 → within3Days
 *    - day-diff <= 7 → within7Days
 *    - day-diff <= 14 → within14Days
 *    - else → beyond
 *
 * @param dueDate - Due date as YYYY-MM-DD string, or null if no due date
 * @param today - Today's date as YYYY-MM-DD string (passed explicitly for purity)
 * @param thresholds - Optional custom thresholds; defaults to DEFAULT_PRIORITY_THRESHOLDS
 * @returns Priority number according to the thresholds
 */
export function calculateAutoPriority(
  dueDate: string | null,
  today: string,
  thresholds?: PriorityThresholds
): number {
  const t = thresholds ?? DEFAULT_PRIORITY_THRESHOLDS;

  // Rule 1: No due date
  if (dueDate === null) {
    return t.noDueDate;
  }

  // Rule 2: Overdue or today
  const dayDiff = calculateDayDifference(dueDate, today);
  if (dayDiff <= 0) {
    return t.overdueOrToday;
  }

  // Rule 3: Apply day-diff bands
  if (dayDiff <= 3) {
    return t.within3Days;
  }
  if (dayDiff <= 7) {
    return t.within7Days;
  }
  if (dayDiff <= 14) {
    return t.within14Days;
  }
  return t.beyond;
}
