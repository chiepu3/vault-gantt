import { addDays, diffDays } from "./gantt-layout";
import { PARENT_COL_WIDTH, RANGE_EXTEND_DAYS } from "./gantt-constants";

export interface InitialViewportInput {
  today: string;
  rangeStart: string;
  rangeDays: number;
  dayWidth: number;
  clientWidth: number;
  /** Where today should sit from the left edge of the scroll viewport. */
  offsetPx: number;
}

export interface InitialViewport {
  rangeStart: string;
  rangeDays: number;
  scrollLeft: number;
}

/**
 * The range and scroll offset a freshly opened chart settles at. Scrolling to today puts the viewport within the
 * auto-extension threshold of the range edge, so the old open path built the chart, scrolled, extended the range and
 * built it again. This applies the same extension rule (`threshold = max(240, 10 days)`, `RANGE_EXTEND_DAYS` steps,
 * left first) to the planned offset until it no longer fires, so the first build is already final.
 */
export function planInitialViewport(input: InitialViewportInput): InitialViewport {
  const { today, dayWidth, clientWidth, offsetPx } = input;
  let { rangeStart, rangeDays } = input;
  const threshold = Math.max(240, dayWidth * 10);
  // scrollToDate clamps at 0; a left extension then shifts the offset by the prepended width, as the live scroll handler does.
  let scrollLeft = Math.max(0, diffDays(rangeStart, today) * dayWidth - offsetPx);
  for (let guard = 0; guard < 8; guard += 1) {
    // The scroll content is as wide as the date header: the name column plus one column per day.
    const scrollWidth = PARENT_COL_WIDTH + rangeDays * dayWidth;
    if (scrollLeft < threshold) {
      rangeStart = addDays(rangeStart, -RANGE_EXTEND_DAYS);
      rangeDays += RANGE_EXTEND_DAYS;
      scrollLeft += RANGE_EXTEND_DAYS * dayWidth;
    } else if (scrollLeft + clientWidth > scrollWidth - threshold) {
      rangeDays += RANGE_EXTEND_DAYS;
    } else {
      break;
    }
  }
  return { rangeStart, rangeDays, scrollLeft };
}
