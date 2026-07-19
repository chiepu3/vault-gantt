/**
 * Pure calendar arithmetic for business day calculations.
 * All dates are YYYY-MM-DD strings for public API.
 * Uses UTC-safe Date parsing internally to avoid timezone issues.
 */

/**
 * Parse a date string in YYYY-MM-DD format to a Date object (UTC).
 * Uses 'T00:00:00Z' to ensure UTC parsing regardless of local timezone.
 */
function parseUTC(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00Z');
}

/**
 * Format a Date object back to YYYY-MM-DD string.
 */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get the day of week (0=Sunday, 1=Monday, ..., 6=Saturday) in UTC.
 */
function getDayOfWeekUTC(date: Date): number {
  return date.getUTCDay();
}

/**
 * Check if a date falls on a weekend (Saturday or Sunday).
 */
export function isWeekend(date: string): boolean {
  const d = parseUTC(date);
  const dayOfWeek = getDayOfWeekUTC(d);
  return dayOfWeek === 0 || dayOfWeek === 6; // 0=Sunday, 6=Saturday
}

/**
 * Check if a date is a business day (not a weekend and not in holidays).
 */
export function isBusinessDay(
  date: string,
  holidays: ReadonlySet<string>
): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

/**
 * Add a number of business days to a date, skipping weekends and holidays.
 * If days=0, returns the date unchanged.
 * Days must be non-negative.
 */
export function addBusinessDays(
  date: string,
  days: number,
  holidays: ReadonlySet<string>
): string {
  const current = parseUTC(date);
  let remaining = days;

  while (remaining > 0) {
    // Move to the next day
    current.setUTCDate(current.getUTCDate() + 1);

    // Check if it's a business day
    const dateStr = formatDate(current);
    if (isBusinessDay(dateStr, holidays)) {
      remaining--;
    }
  }

  return formatDate(current);
}

/**
 * Count the number of business days in the inclusive range [start, end].
 * If end < start, return 0.
 * If start === end, return 1 if that day is a business day else 0.
 */
export function countBusinessDaysBetween(
  start: string,
  end: string,
  holidays: ReadonlySet<string>
): number {
  const startDate = parseUTC(start);
  const endDate = parseUTC(end);

  // If end is before start, return 0
  if (endDate < startDate) {
    return 0;
  }

  let count = 0;
  const current = new Date(startDate); // Create a copy to avoid mutating startDate

  while (current <= endDate) {
    const dateStr = formatDate(current);
    if (isBusinessDay(dateStr, holidays)) {
      count++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}
