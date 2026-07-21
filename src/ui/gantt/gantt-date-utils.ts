import { isHoliday } from './holiday-service';
export { isHoliday };

// Obsidian bundles moment.js and exposes it as window.moment at runtime.
declare const moment: (
  date?: string | Date,
  format?: string,
  strict?: boolean
) => {
  isValid(): boolean;
  add(n: number, unit: string): ReturnType<typeof moment>;
  startOf(unit: string): ReturnType<typeof moment>;
  diff(other: ReturnType<typeof moment>, unit: string): number;
  format(fmt: string): string;
  date(): number;
  day(): number;
};

export function todayStr(): string {
  return moment().format('YYYY-MM-DD');
}

export function parseDate(value: string): ReturnType<typeof moment> | null {
  const m = moment(value, 'YYYY-MM-DD', true);
  return m.isValid() ? m : null;
}

export function addDays(dateStr: string, days: number): string {
  return moment(dateStr, 'YYYY-MM-DD').add(days, 'days').format('YYYY-MM-DD');
}

export function diffDays(a: string, b: string): number {
  const am = parseDate(a);
  const bm = parseDate(b);
  if (!am || !bm) return 0;
  return bm.startOf('day').diff(am.startOf('day'), 'days');
}

export function dateLabel(dateStr: string, fmt: string): string {
  return moment(dateStr, 'YYYY-MM-DD').format(fmt);
}

export function isWeekend(dateStr: string): boolean {
  const d = moment(dateStr, 'YYYY-MM-DD').day();
  return d === 0 || d === 6;
}

export function isMonthStart(dateStr: string, index: number): boolean {
  return index === 0 || moment(dateStr, 'YYYY-MM-DD').date() === 1;
}

export function monthTitle(dateStr: string): string {
  return dateLabel(dateStr, 'M月');
}

export function clampDate(dateStr: string, minDate: string, maxDate: string): string {
  if (!dateStr) return minDate;
  if (dateStr < minDate) return minDate;
  if (dateStr > maxDate) return maxDate;
  return dateStr;
}

export function buildDateRange(rangeStart: string, rangeDays: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < rangeDays; i++) {
    dates.push(addDays(rangeStart, i));
  }
  return dates;
}

/**
 * Count business days (Mon-Fri) from start to end, inclusive both.
 * Returns 0 if start > end.
 */
export function countBusinessDaysInSpan(start: string, end: string): number {
  const days = diffDays(start, end);
  if (days < 0) return 0;
  let count = 0;
  for (let i = 0; i <= days; i++) {
    if (!isWeekend(addDays(start, i))) count++;
  }
  return count;
}

/**
 * Add `count` business days after dateStr (not counting dateStr itself).
 * count must be >= 0.
 */
export function addBusinessDays(dateStr: string, count: number): string {
  let d = dateStr;
  let remaining = count;
  let guard = 0;
  while (remaining > 0 && guard < 365) {
    d = addDays(d, 1);
    if (!isNonWorkday(d)) remaining--;
    guard++;
  }
  return d;
}

function isNonWorkday(d: string): boolean {
  return isWeekend(d) || isHoliday(d);
}

/** Advance to the nearest workday >= dateStr (skip weekends and Japanese holidays). */
export function snapForward(dateStr: string): string {
  let d = dateStr;
  let iterations = 0;
  while (isNonWorkday(d) && iterations < 14) {
    d = addDays(d, 1);
    iterations++;
  }
  return d;
}

/** Retreat to the nearest workday <= dateStr (skip weekends and Japanese holidays). */
export function snapBackward(dateStr: string): string {
  let d = dateStr;
  let iterations = 0;
  while (isNonWorkday(d) && iterations < 14) {
    d = addDays(d, -1);
    iterations++;
  }
  return d;
}
