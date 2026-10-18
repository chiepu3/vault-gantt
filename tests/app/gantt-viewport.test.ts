import { describe, it, expect } from "vitest";
import { planInitialViewport } from "../../src/app/gantt-viewport";
import { addDays, diffDays } from "../../src/app/gantt-layout";
import { PARENT_COL_WIDTH, RANGE_EXTEND_DAYS } from "../../src/app/gantt-constants";

const today = "2026-10-18";

/** The old open path: scroll to today, then apply the view's scroll-driven extension rule until it stops firing. */
function viaScrollEvents(dayWidth: number, clientWidth: number, offsetPx: number) {
  let rangeStart = addDays(today, -14), rangeDays = 90;
  let scrollLeft = Math.max(0, diffDays(rangeStart, today) * dayWidth - offsetPx);
  const threshold = Math.max(240, dayWidth * 10);
  for (let i = 0; i < 8; i += 1) {
    const scrollWidth = PARENT_COL_WIDTH + rangeDays * dayWidth;
    if (scrollLeft < threshold) {
      rangeStart = addDays(rangeStart, -RANGE_EXTEND_DAYS); rangeDays += RANGE_EXTEND_DAYS; scrollLeft += RANGE_EXTEND_DAYS * dayWidth;
    } else if (scrollLeft + clientWidth > scrollWidth - threshold) {
      rangeDays += RANGE_EXTEND_DAYS;
    } else break;
  }
  return { rangeStart, rangeDays, scrollLeft };
}

describe("planInitialViewport", () => {
  it("opens at the range the left-extension rule would reach after scrolling to today", () => {
    const plan = planInitialViewport({ today, rangeStart: addDays(today, -14), rangeDays: 90, dayWidth: 28, clientWidth: 1600, offsetPx: 220 });
    expect(plan).toEqual({ rangeStart: addDays(today, -74), rangeDays: 150, scrollLeft: 74 * 28 - 220 });
  });

  it.each([14, 20, 28, 36, 48, 72])("matches the scroll-event path at %ipx/day", (dayWidth) => {
    for (const clientWidth of [600, 1200, 1600, 2600]) {
      const plan = planInitialViewport({ today, rangeStart: addDays(today, -14), rangeDays: 90, dayWidth, clientWidth, offsetPx: 220 });
      expect(plan).toEqual(viaScrollEvents(dayWidth, clientWidth, 220));
    }
  });

  it("extends the right edge too when the viewport would otherwise end near it", () => {
    const plan = planInitialViewport({ today, rangeStart: addDays(today, -14), rangeDays: 90, dayWidth: 14, clientWidth: 2600, offsetPx: 220 });
    expect(plan.rangeDays).toBeGreaterThan(150);
    expect(plan.scrollLeft + 2600).toBeLessThanOrEqual(PARENT_COL_WIDTH + plan.rangeDays * 14 - 240);
  });

  it("places today at the requested offset in the final range when the offset is not clamped", () => {
    const plan = planInitialViewport({ today, rangeStart: addDays(today, -14), rangeDays: 90, dayWidth: 28, clientWidth: 1600, offsetPx: 220 });
    expect(diffDays(plan.rangeStart, today) * 28 - plan.scrollLeft).toBe(220);
  });
});
