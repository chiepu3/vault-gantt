import {
  OVERSCAN_DAYS,
  RANGE_EXTEND_DAYS,
  DEFAULT_DAY_WIDTH,
  MIN_DAY_WIDTH,
  MAX_DAY_WIDTH,
  PARENT_COL_WIDTH,
} from './gantt-constants';
import { addDays, buildDateRange, diffDays, todayStr } from './gantt-date-utils';

/**
 * GanttViewState manages the viewport state: which date range is displayed,
 * zoom level, and scroll position. It provides conversion utilities between
 * dates and pixel coordinates.
 */
export class GanttViewState {
  rangeStart: string;
  rangeDays: number;
  dayWidth: number;
  scrollEl: HTMLElement | null = null;

  constructor(initialDate: string) {
    this.rangeStart = addDays(initialDate, -OVERSCAN_DAYS);
    this.rangeDays = OVERSCAN_DAYS * 4;
    this.dayWidth = DEFAULT_DAY_WIDTH;
  }

  /**
   * Build the array of all date strings in the current range.
   */
  buildDates(): string[] {
    return buildDateRange(this.rangeStart, this.rangeDays);
  }

  /**
   * If the given date is outside the current range, extend rangeStart/rangeDays
   * by RANGE_EXTEND_DAYS and return true. Otherwise return false.
   */
  ensureDateInRange(date: string): boolean {
    const rangeEnd = addDays(this.rangeStart, this.rangeDays);
    if (date >= this.rangeStart && date < rangeEnd) {
      return false;
    }

    // Date is outside range; extend backward or forward as needed
    if (date < this.rangeStart) {
      this.rangeStart = addDays(this.rangeStart, -RANGE_EXTEND_DAYS);
      this.rangeDays += RANGE_EXTEND_DAYS;
    } else {
      this.rangeDays += RANGE_EXTEND_DAYS;
    }

    return true;
  }

  /**
   * Extend the range to the left by RANGE_EXTEND_DAYS.
   * Returns true if extended, false if already at beginning.
   */
  extendRangeLeft(): boolean {
    this.rangeStart = addDays(this.rangeStart, -RANGE_EXTEND_DAYS);
    this.rangeDays += RANGE_EXTEND_DAYS;
    return true;
  }

  /**
   * Extend the range to the right by RANGE_EXTEND_DAYS.
   * Returns true if extended, false if at end.
   */
  extendRangeRight(): boolean {
    this.rangeDays += RANGE_EXTEND_DAYS;
    return true;
  }

  /**
   * Convert a clientX pixel coordinate to a date string (YYYY-MM-DD).
   * Accounts for PARENT_COL_WIDTH and current scroll position.
   */
  xToDate(clientX: number): string {
    if (!this.scrollEl) return this.rangeStart;
    const scrollLeft = this.scrollEl.scrollLeft;
    const timelineLeftInViewport = PARENT_COL_WIDTH;

    const timelineRelativeX = clientX - timelineLeftInViewport + scrollLeft;
    const dayIndex = Math.floor(timelineRelativeX / this.dayWidth);
    const dates = this.buildDates();
    return dates[Math.max(0, Math.min(dayIndex, dates.length - 1))] || this.rangeStart;
  }

  /**
   * Convert a date string to a pixel offset from the left edge of the timeline
   * (not including the parent column).
   */
  dateToX(date: string): number {
    return diffDays(this.rangeStart, date) * this.dayWidth;
  }

  /**
   * Zoom in (delta > 0) or out (delta < 0).
   * Multiplies dayWidth by 1.2 or divides by 1.2, clamped to MIN/MAX_DAY_WIDTH.
   */
  zoom(delta: number): void {
    const factor = delta > 0 ? 1.2 : 1 / 1.2;
    this.dayWidth = Math.max(MIN_DAY_WIDTH, Math.min(MAX_DAY_WIDTH, this.dayWidth * factor));
  }

  /**
   * Scroll the view so that today's column is centered in the viewport.
   */
  scrollToToday(): void {
    if (!this.scrollEl) return;

    const today = todayStr();
    this.ensureDateInRange(today);
    const x = this.dateToX(today);
    const halfViewWidth = Math.max(0, (this.scrollEl.clientWidth - PARENT_COL_WIDTH) / 2);
    this.scrollEl.scrollLeft = Math.max(0, x - halfViewWidth);
  }
}
