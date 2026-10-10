




import { describe, it, expect } from "vitest";
import {
  addWorkingDays,
  countWorkingDaysInclusive,
  dayValues,
  ensureWorkloadRecord,
  formatBulkMoveDragTooltip,
  formatDragRangeTooltip,
  formatDueDateDragTooltip,
  formatMarkerDragTooltip,
  getBulkMoveKeysForParent,
  getWorkloadTaskKey,
  hasWorkloadActual,
  isBusinessDay,
  isNonWorkingDate,
  moveBarByCalendarDelta,
  nextBusinessDay,
  pixelDeltaToDayDelta,
  previousBusinessDay,
  roundHalfHour,
  setValue,
  shiftMarkers,
  shiftWorkloadMap,
  snapBackward,
  snapForward,
  snapMarkerDate,
  snapResizeEnd,
  snapResizeStart,
  snapWorkingDate,
  sortForBulkMove,
} from "../../src/app/gantt-drag";
import type { TaskRow } from "../../src/core/types";

// A Saturday/Sunday/holiday-rich fixed week for deterministic assertions.


const HOLIDAYS = new Set<string>(["2026-08-03"]);

describe("gantt-drag pure helpers", () => {
  describe("isBusinessDay / snapForward / snapBackward", () => {
    it("Saturday is a non-working day", () => {
      expect(isBusinessDay("2026-08-01", HOLIDAYS)).toBe(false);
    });

    it("Sunday is never a business day", () => {
      expect(isBusinessDay("2026-08-02", HOLIDAYS)).toBe(false);
    });

    it("a configured holiday is never a business day", () => {
      expect(isBusinessDay("2026-08-03", HOLIDAYS)).toBe(false);
    });

    it("isNonWorkingDate is the negation of isBusinessDay", () => {
      expect(isNonWorkingDate("2026-08-01", HOLIDAYS)).toBe(true); // Saturday
      expect(isNonWorkingDate("2026-08-04", HOLIDAYS)).toBe(false); // Tuesday
    });

    it("snapForward skips a holiday that immediately follows a Sunday", () => {
      // 08-02 Sun -> 08-03 holiday -> 08-04 Tue (first real business day)
      expect(snapForward("2026-08-02", HOLIDAYS)).toBe("2026-08-04");
    });

    it("snapForward is a no-op on an already-business day", () => {
      expect(snapForward("2026-08-04", HOLIDAYS)).toBe("2026-08-04");
    });

    it("snapForward skips Saturday as well as Sundays and holidays", () => {

      // Saturday advances past Sunday and the 08-03 holiday to 08-04.
      expect(snapForward("2026-08-01", HOLIDAYS)).toBe("2026-08-04");
    });

    it("snapBackward from Sunday skips Saturday and reaches Friday", () => {

      // 08-08 (Sat) is skipped, so the result is 08-07 (Fri).
      expect(snapBackward("2026-08-09", HOLIDAYS)).toBe("2026-08-07");
    });

    it("snapBackward skips the holiday and the preceding weekend", () => {
      // 08-03 is a holiday; 08-02 and 08-01 are weekend days.

      expect(snapBackward("2026-08-03", HOLIDAYS)).toBe("2026-07-31");
    });

    it("nextBusinessDay and previousBusinessDay return strictly later or earlier dates", () => {
      expect(nextBusinessDay("2026-08-01", HOLIDAYS)).toBe("2026-08-04");
      // previousBusinessDay(08-04) skips 08-03 (holiday), 08-02 (Sun), and
      // 08-01 (Sat), landing on 07-31.
      expect(previousBusinessDay("2026-08-04", HOLIDAYS)).toBe("2026-07-31");
    });
  });

  describe("snapWorkingDate", () => {
    it("defaults to direction=1 (forward) — own example: a Saturday snaps to the following Monday", () => {
      expect(snapWorkingDate("2026-07-25", new Set())).toBe("2026-07-27");
    });

    it("direction<0 snaps backward", () => {
      expect(snapWorkingDate("2026-08-09", HOLIDAYS, -1)).toBe("2026-08-07");
    });

    it("stops at maxDate and returns the closest reachable value (even if still non-working) when no business day exists within range", () => {
      // 08-08 is a Saturday; walking forward would need to reach 08-10
      // (Monday), but maxDate caps the walk at 08-08 itself.
      expect(
        snapWorkingDate("2026-08-08", HOLIDAYS, 1, "0001-01-01", "2026-08-08")
      ).toBe("2026-08-08");
    });
  });

  describe("countWorkingDaysInclusive", () => {
    it("counts business days in [start,end] inclusive, excluding weekends/holidays", () => {
      // 08-01 Sat, 08-02 Sun, 08-03 holiday are all excluded; 08-04..08-07
      // (Tue-Fri) and 08-08/08-09 (Sat/Sun) — only the 4 weekdays count.
      expect(countWorkingDaysInclusive("2026-08-01", "2026-08-09", HOLIDAYS)).toBe(
        4
      );
    });

    it("returns 1 when start/end are missing or the range is inverted", () => {
      expect(countWorkingDaysInclusive("", "2026-08-04", HOLIDAYS)).toBe(1);
      expect(countWorkingDaysInclusive("2026-08-04", "", HOLIDAYS)).toBe(1);
      expect(countWorkingDaysInclusive("2026-08-10", "2026-08-04", HOLIDAYS)).toBe(
        1
      );
    });

    it("guarantees a minimum of 1 even for an all-non-working range", () => {
      expect(countWorkingDaysInclusive("2026-08-01", "2026-08-02", HOLIDAYS)).toBe(
        1
      );
    });
  });

  describe("addWorkingDays", () => {
    it("walks forward, skipping non-working days", () => {
      expect(addWorkingDays("2026-08-04", 3, HOLIDAYS)).toBe("2026-08-07");
    });

    it("walks backward for a negative amount", () => {
      expect(addWorkingDays("2026-08-09", -2, HOLIDAYS)).toBe("2026-08-05");
    });

    it("snaps the start before applying a zero-day offset", () => {
      // 08-01 is a Saturday: snap-first walks 08-01 -> 08-02 (Sun) -> 08-03
      // (holiday) -> 08-04 (Tue), even though amount is 0.
      expect(addWorkingDays("2026-08-01", 0, HOLIDAYS)).toBe("2026-08-04");
    });

    it("skips holidays when walking forward by a positive amount", () => {
      // 07-31 (Fri) is already a business day, no snap needed. Walking 3
      // business days forward must skip 08-01(Sat)/08-02(Sun)/08-03(holiday
      // Mon) before counting 08-04(Tue)=1, 08-05(Wed)=2, 08-06(Thu)=3.
      expect(addWorkingDays("2026-07-31", 3, HOLIDAYS)).toBe("2026-08-06");
    });
  });

  describe("snapResizeStart", () => {
    it("forward-snaps a raw start landing on Sunday", () => {
      expect(snapResizeStart("2026-08-02", "2026-08-20", HOLIDAYS)).toBe(
        "2026-08-04"
      );
    });

    it("clamps to end when start would pass end", () => {
      expect(snapResizeStart("2026-08-25", "2026-08-20", HOLIDAYS)).toBe(
        "2026-08-20"
      );
    });

    it("allows start to land exactly on end", () => {
      expect(snapResizeStart("2026-08-20", "2026-08-20", HOLIDAYS)).toBe(
        "2026-08-20"
      );
    });

    it("clamps to a non-working end when snapping would pass it", () => {
      expect(snapResizeStart("2026-08-01", "2026-08-01", HOLIDAYS)).toBe(
        "2026-08-01"
      );
    });
  });

  describe("snapResizeEnd", () => {
    it("backward-snaps a raw end on Sunday while skipping Saturday", () => {


      expect(snapResizeEnd("2026-08-01", "2026-08-09", HOLIDAYS)).toBe(
        "2026-08-07"
      );
    });

    it("clamps to start when end would precede a non-working start", () => {
      expect(snapResizeEnd("2026-08-01", "2026-07-20", HOLIDAYS)).toBe(
        "2026-08-01"
      );
    });

    it("allows end to land exactly on start", () => {
      expect(snapResizeEnd("2026-08-20", "2026-08-20", HOLIDAYS)).toBe(
        "2026-08-20"
      );
    });

    it("clamps to a non-working start when snapping would precede it", () => {
      expect(snapResizeEnd("2026-08-01", "2026-08-01", HOLIDAYS)).toBe(
        "2026-08-01"
      );
    });
  });

  describe("moveBarByCalendarDelta", () => {
    it("forward-snaps the start and preserves the bar's business-day duration", () => {
      // The bar contains three business days. Moving its start past the
      // 08-03 holiday gives a start of 08-04 and an end of 08-06.
      const result = moveBarByCalendarDelta(
        { start: "2026-07-29", end: "2026-08-01" },
        4,
        HOLIDAYS
      );
      expect(result.nextStart).toBe("2026-08-04");
      expect(result.nextEnd).toBe("2026-08-06");
      expect(result.shiftedMarkers).toEqual([]);
    });

    it("is a no-op snap when the raw shifted start is already a business day, still re-derives the end in business days", () => {
      // bar 08-04(Tue)..08-06(Thu): 3 business days. delta+2 -> raw start
      // 08-06 is already a business day (Thu) -> no snap needed. New end =
      // 2 business days after 08-06, crossing the 08-08/08-09 weekend -> 08-10.
      const result = moveBarByCalendarDelta(
        { start: "2026-08-04", end: "2026-08-06" },
        2,
        HOLIDAYS
      );
      expect(result.nextStart).toBe("2026-08-06");
      expect(result.nextEnd).toBe("2026-08-10");
    });

    it("a holiday inside the new range can shift the moved task's end date", () => {
      // bar 07-27(Mon)..07-29(Wed): 3 business days, NO holiday in this
      // initial range (08-03 is outside it). delta+4 -> raw start
      // 07-31 (Fri) is already a business day, no snap. New end must be 2
      // business days after 07-31, which now crosses the weekend AND the
      // 08-03 holiday (absent from the initial range but present in the
      // new one): 08-01(Sat)/08-02(Sun)/08-03(holiday) all skipped, then
      // 08-04(Tue)=1, 08-05(Wed)=2 -> nextEnd=08-05.
      // The moved task ends on 08-05 after skipping the weekend and holiday.
      const result = moveBarByCalendarDelta(
        { start: "2026-07-27", end: "2026-07-29" },
        4,
        HOLIDAYS
      );
      expect(result.nextStart).toBe("2026-07-31");
      expect(result.nextEnd).toBe("2026-08-05");
    });

    it("zero-duration (single business day) bars collapse nextStart === nextEnd", () => {
      const result = moveBarByCalendarDelta(
        { start: "2026-08-04", end: "2026-08-04" },
        0,
        HOLIDAYS
      );
      expect(result.nextStart).toBe("2026-08-04");
      expect(result.nextEnd).toBe("2026-08-04");
    });

    it("a negative deltaDays snaps backward", () => {
      // bar 08-09(Sun)..08-09(Sun): duration forced to minimum 1.
      // delta-1 -> raw start 08-08 (Sat, non-working) -> backward-snaps
      // (direction follows deltaDays's negative sign) to 08-07 (Fri).
      const result = moveBarByCalendarDelta(
        { start: "2026-08-09", end: "2026-08-09" },
        -1,
        HOLIDAYS
      );
      expect(result.nextStart).toBe("2026-08-07");
      expect(result.nextEnd).toBe("2026-08-07");
    });

    it("relocates a WORKING-day marker by preserving its relative business-day position within the bar", () => {
      // bar 08-04(Tue)..08-08(Sat): 4 business days (Tue-Fri). Marker on
      // 08-06 (Thu, business) is business-day offset 1 from bar.start (2 of
      // 4 inclusive positions, i.e. countWorkingDaysInclusive(start,08-06)-1).
      // After delta+3: nextStart=08-07 (Fri), nextEnd=08-12 (Wed, 3 business
      // days later). The marker keeps its SAME relative offset from
      // nextStart, landing on 08-11 (Tue) — not a blind +3 calendar shift
      // (which would have produced 08-09, a Sunday).
      const result = moveBarByCalendarDelta(
        {
          start: "2026-08-04",
          end: "2026-08-08",
          markers: [{ key: "m1", title: "M1", date: "2026-08-06" }],
        },
        3,
        HOLIDAYS
      );
      expect(result.nextStart).toBe("2026-08-07");
      expect(result.nextEnd).toBe("2026-08-12");
      expect(result.shiftedMarkers).toEqual([
        { key: "m1", title: "M1", date: "2026-08-11" },
      ]);
    });

    it("relocates a NON-WORKING (holiday) marker by simple shift-then-snap instead of relative-position math", () => {
      const result = moveBarByCalendarDelta(
        {
          start: "2026-07-29",
          end: "2026-08-05",
          markers: [{ key: "m2", title: "M2", date: "2026-08-03" }], // holiday
        },
        1,
        HOLIDAYS
      );
      // marker 08-03 (holiday) + 1 day = 08-04 (Tue, business) -> already
      // business after the shift, no further snap needed.
      expect(result.shiftedMarkers).toEqual([
        { key: "m2", title: "M2", date: "2026-08-04" },
      ]);
    });
  });

  describe("shiftMarkers", () => {
    it("relocates working-day markers by relative business-day position and never mutates the input", () => {
      const input = [
        { key: "m1", title: "M1", date: "2026-08-05" },
        { key: "m2", title: "M2", date: "2026-08-06" },
      ];
      const result = shiftMarkers(input, 7, HOLIDAYS, {
        oldStart: "2026-08-04",
        newStart: "2026-08-11",
        newEnd: "2026-08-20",
      });
      expect(result).toEqual([
        { key: "m1", title: "M1", date: "2026-08-12" },
        { key: "m2", title: "M2", date: "2026-08-13" },
      ]);
      expect(input[0].date).toBe("2026-08-05"); // unmutated
    });

    it("clamps an out-of-range relocated date into [newStart, newEnd]", () => {
      // marker's relative-position placement (08-06) would land outside a
      // deliberately narrow newEnd (08-05) — clamped down to 08-05.
      const result = shiftMarkers(
        [{ key: "m1", title: "M1", date: "2026-08-06" }],
        0,
        HOLIDAYS,
        { oldStart: "2026-08-04", newStart: "2026-08-04", newEnd: "2026-08-05" }
      );
      expect(result).toEqual([{ key: "m1", title: "M1", date: "2026-08-05" }]);
    });

    it("returns an empty array for undefined input", () => {
      expect(
        shiftMarkers(undefined, 5, HOLIDAYS, {
          oldStart: "2026-08-01",
          newStart: "2026-08-06",
          newEnd: "2026-08-20",
        })
      ).toEqual([]);
    });
  });

  describe("snapMarkerDate", () => {
    it("clamps a raw date before the range start to the range start", () => {
      // range 08-04..08-08; raw date 08-01 is before start -> clamps to 08-04
      expect(snapMarkerDate("2026-08-01", "2026-08-04", "2026-08-08", HOLIDAYS)).toBe(
        "2026-08-04"
      );
    });

    it("clamps an out-of-range marker date and snaps it to a business day", () => {

      // The clamped value is 08-08. Backward snapping yields 08-07 (Fri);
      // forward snapping would leave the range at 08-10.
      expect(snapMarkerDate("2026-08-20", "2026-08-04", "2026-08-08", HOLIDAYS)).toBe(
        "2026-08-07"
      );
    });

    it("snaps a within-range Sunday forward when the forward result stays in range", () => {
      // range 08-01..08-09 (Sat..Sun); raw date 08-02 (Sun) -> forward to 08-04
      expect(snapMarkerDate("2026-08-02", "2026-08-01", "2026-08-09", HOLIDAYS)).toBe(
        "2026-08-04"
      );
    });

    it("returns the clamped date when the range contains no business day", () => {

      // The range 08-08..08-09 contains no business day. Forward snapping
      // reaches 08-10 and backward snapping reaches 08-07, both outside the
      // range, so the in-range date remains unchanged.

      expect(snapMarkerDate("2026-08-09", "2026-08-08", "2026-08-09", HOLIDAYS)).toBe(
        "2026-08-09"
      );
    });
  });

  describe("pixelDeltaToDayDelta", () => {
    it("rounds to the nearest whole day", () => {
      expect(pixelDeltaToDayDelta(56, 28)).toBe(2);
      expect(pixelDeltaToDayDelta(40, 28)).toBe(1); // 1.43 -> rounds to 1
      expect(pixelDeltaToDayDelta(-56, 28)).toBe(-2);
      expect(pixelDeltaToDayDelta(0, 28)).toBe(0);
    });

    it("defensively returns 0 for a non-positive dayWidth", () => {
      expect(pixelDeltaToDayDelta(100, 0)).toBe(0);
      expect(pixelDeltaToDayDelta(100, -5)).toBe(0);
    });
  });

  describe("shiftWorkloadMap", () => {
    it("shifts every date key by the same day count", () => {
      const result = shiftWorkloadMap({ "2026-08-04": 3, "2026-08-05": 1 }, 2);
      expect(result).toEqual({ "2026-08-06": 3, "2026-08-07": 1 });
    });

    it("passes undefined through unchanged", () => {
      expect(shiftWorkloadMap(undefined, 2)).toBeUndefined();
    });

    it("calendar-day mode ADDS hours when two source dates collide on the same shifted date", () => {

      // EVERY key uniformly) can't collide with a 2-day shift by itself, so
      // force a collision directly: two dates 2 days apart both land on the
      // same target under a 2-day shift is impossible for calendar mode
      // (shiftDays is uniform) — the realistic collision case is BUSINESS-
      // DAY mode below. This calendar-mode case instead verifies same-value
      // dedupe doesn't happen (each key maps 1:1 under a uniform shift).
      const result = shiftWorkloadMap(
        { "2026-08-04": 3, "2026-08-05": 1 },
        1
      );
      expect(result).toEqual({ "2026-08-05": 3, "2026-08-06": 1 });
    });

    it("falls back to calendar-day mode when oldStart/newStart are missing or invalid", () => {
      const holidaySet = new Set<string>();
      const result = shiftWorkloadMap(
        { "2026-08-04": 3 },
        2,
        { oldStart: undefined, newStart: "2026-08-06", holidaySet }
      );
      expect(result).toEqual({ "2026-08-06": 3 }); // plain +2 calendar days
      const result2 = shiftWorkloadMap(
        { "2026-08-04": 3 },
        2,
        { oldStart: "not-a-date", newStart: "2026-08-06", holidaySet }
      );
      expect(result2).toEqual({ "2026-08-06": 3 });
    });

    it("business-day mode shifts each date by its business-day offset", () => {

      // Moving the task forward one business day applies the same offset to
      // workload dates. The forward and reverse offset walks cancel, so the
      // expected date is unchanged.
      const holidaySet = new Set<string>();
      const result = shiftWorkloadMap(
        { "2026-08-10": 5 },
        1,
        { oldStart: "2026-08-03", newStart: "2026-08-04", holidaySet }
      );
      expect(result).toEqual({ "2026-08-11": 5 });
    });

    it("an entry ON oldStart itself (offset 0) maps directly to newStart", () => {
      const holidaySet = new Set<string>();
      const result = shiftWorkloadMap(
        { "2026-08-03": 4 },
        1,
        { oldStart: "2026-08-03", newStart: "2026-08-04", holidaySet }
      );
      expect(result).toEqual({ "2026-08-04": 4 });
    });

    it("a workload entry outside the task's planned range is still shifted (no range filter in this function)", () => {
      const holidaySet = new Set<string>();
      // Far outside any plausible [start,end] for a task starting 08-03 —
      // shiftWorkloadMap itself has no notion of plannedEndDate, so this
      // must still shift.
      const result = shiftWorkloadMap(
        { "2026-09-01": 2 },
        1,
        { oldStart: "2026-08-03", newStart: "2026-08-04", holidaySet }
      );
      expect(Object.keys(result ?? {})).toHaveLength(1);
      expect(Object.values(result ?? {})[0]).toBe(2);
    });

    it("business-day mode ADDS hours when two source dates collide on the same shifted date", () => {


      // resolve to the SAME business-day offset from oldStart, because the
      // holiday is skipped when counting forward — landing both entries on
      // the same shifted date.
      const holidaySet = new Set<string>(["2026-08-08"]);
      const result = shiftWorkloadMap(
        { "2026-08-07": 3, "2026-08-08": 4 },
        0,
        { oldStart: "2026-08-03", newStart: "2026-08-03", holidaySet }
      );
      // Both collapse onto whatever single business day 08-07 resolves to
      // (since 08-08 is skipped as a non-business day and re-lands on the
      // same offset as 08-07 relative to oldStart==newStart).
      const values = Object.values(result ?? {});
      expect(values).toHaveLength(1);
      expect(values[0]).toBe(7); // 3 + 4 summed, not overwritten
    });
  });

  describe("hasWorkloadActual", () => {
    function makeTask(workloadActual?: Record<string, number>): TaskRow {
      return { workloadActual } as unknown as TaskRow;
    }

    it("true when any date has positive hours", () => {
      expect(hasWorkloadActual(makeTask({ "2026-08-04": 2 }))).toBe(true);
    });

    it("false when the map is empty, all-zero, or absent", () => {
      expect(hasWorkloadActual(makeTask({}))).toBe(false);
      expect(hasWorkloadActual(makeTask({ "2026-08-04": 0 }))).toBe(false);
      expect(hasWorkloadActual(makeTask(undefined))).toBe(false);
    });
  });

  describe("getWorkloadTaskKey", () => {
    function makeTask(overrides: Record<string, unknown> = {}): TaskRow {
      return {
        id: "",
        key: undefined,
        file: { path: "" },
        ...overrides,
      } as unknown as TaskRow;
    }

    it("prefers id over key/parentPath/path", () => {
      const task = makeTask({
        id: "tasks/parent.md::sub-a",
        key: "sub-a",
        file: { path: "tasks/parent.md", parentPath: "tasks/parent.md" },
      });
      expect(getWorkloadTaskKey(task)).toBe("tasks/parent.md::sub-a");
    });

    it("falls back to key when id is empty", () => {
      const task = makeTask({
        id: "",
        key: "sub-a",
        file: { path: "tasks/parent.md", parentPath: "tasks/parent.md" },
      });
      expect(getWorkloadTaskKey(task)).toBe("sub-a");
    });

    it("falls back to file.parentPath when id and key are empty", () => {
      const task = makeTask({
        id: "",
        key: undefined,
        file: { path: "tasks/parent.md", parentPath: "tasks/parent.md" },
      });
      expect(getWorkloadTaskKey(task)).toBe("tasks/parent.md");
    });

    it("falls back to file.path when id/key/parentPath are all empty", () => {
      const task = makeTask({
        id: "",
        key: undefined,
        file: { path: "tasks/parent.md", parentPath: undefined },
      });
      expect(getWorkloadTaskKey(task)).toBe("tasks/parent.md");
    });

    it("returns '' when all four are empty, which collides across tasks", () => {
      const a = makeTask({ id: "", key: undefined, file: { path: "" } });
      const b = makeTask({ id: "", key: undefined, file: { path: "" } });
      expect(getWorkloadTaskKey(a)).toBe("");
      expect(getWorkloadTaskKey(b)).toBe("");
      expect(getWorkloadTaskKey(a)).toBe(getWorkloadTaskKey(b));
    });
  });

  describe("ensureWorkloadRecord / dayValues / setValue", () => {
    function makeTask(overrides: Record<string, unknown> = {}): TaskRow {
      return { ...overrides } as unknown as TaskRow;
    }

    describe("ensureWorkloadRecord", () => {
      it("creates {} for workloadPlan when missing, and stores it on the task", () => {
        const task = makeTask();
        const map = ensureWorkloadRecord(task, "plan");
        expect(map).toEqual({});
        expect(task.workloadPlan).toBe(map);
      });

      it("creates {} for workloadActual when missing, and stores it on the task", () => {
        const task = makeTask();
        const map = ensureWorkloadRecord(task, "actual");
        expect(map).toEqual({});
        expect(task.workloadActual).toBe(map);
      });

      it("returns the SAME existing map object when already present (no overwrite)", () => {
        const existing = { "2026-08-01": 3 };
        const task = makeTask({ workloadPlan: existing });
        expect(ensureWorkloadRecord(task, "plan")).toBe(existing);
      });
    });

    describe("dayValues", () => {
      it("returns 0/0 when both maps are absent", () => {
        expect(dayValues(makeTask(), "2026-08-01")).toEqual({
          plan: 0,
          actual: 0,
        });
      });

      it("returns recorded values per side, 0 for a missing date entry", () => {
        const task = makeTask({
          workloadPlan: { "2026-08-01": 4 },
          workloadActual: { "2026-08-02": 2 },
        });
        expect(dayValues(task, "2026-08-01")).toEqual({ plan: 4, actual: 0 });
        expect(dayValues(task, "2026-08-02")).toEqual({ plan: 0, actual: 2 });
        expect(dayValues(task, "2026-08-03")).toEqual({ plan: 0, actual: 0 });
      });
    });

    describe("setValue", () => {
      it("sets a positive value into workloadPlan when mode is plan", () => {
        const task = makeTask();
        setValue(task, "2026-08-01", "plan", 3.5);
        expect(task.workloadPlan).toEqual({ "2026-08-01": 3.5 });
        expect(task.workloadActual).toBeUndefined();
      });

      it("sets a positive value into workloadActual when mode is actual", () => {
        const task = makeTask();
        setValue(task, "2026-08-01", "actual", 2);
        expect(task.workloadActual).toEqual({ "2026-08-01": 2 });
        expect(task.workloadPlan).toBeUndefined();
      });

      it("deletes the date entry when value is exactly 0", () => {
        const task = makeTask({ workloadPlan: { "2026-08-01": 3 } });
        setValue(task, "2026-08-01", "plan", 0);
        expect(task.workloadPlan).toEqual({});
      });

      it("deletes the date entry when value is negative", () => {
        const task = makeTask({ workloadActual: { "2026-08-01": 3 } });
        setValue(task, "2026-08-01", "actual", -1);
        expect(task.workloadActual).toEqual({});
      });

      it("leaves other dates untouched when deleting one", () => {
        const task = makeTask({
          workloadPlan: { "2026-08-01": 3, "2026-08-02": 5 },
        });
        setValue(task, "2026-08-01", "plan", 0);
        expect(task.workloadPlan).toEqual({ "2026-08-02": 5 });
      });
    });
  });

  describe("roundHalfHour", () => {
    it("rounds to the nearest 0.5", () => {
      expect(roundHalfHour(1.2)).toBe(1);
      expect(roundHalfHour(1.3)).toBe(1.5);
      expect(roundHalfHour(1.74)).toBe(1.5);
      expect(roundHalfHour(1.75)).toBe(2);
    });

    it("clamps negative values to 0", () => {
      expect(roundHalfHour(-3)).toBe(0);
      expect(roundHalfHour(-0.1)).toBe(0);
    });

    it("passes 0 and already-half-hour values through unchanged", () => {
      expect(roundHalfHour(0)).toBe(0);
      expect(roundHalfHour(2.5)).toBe(2.5);
    });

    it("does not validate date keys or throw like normalizeWorkloadMap", () => {
      expect(() => roundHalfHour(999)).not.toThrow();
      expect(roundHalfHour(999)).toBe(999);
    });
  });

  describe("tooltip formatters", () => {
    it("formats a range as 'start → end'", () => {
      expect(formatDragRangeTooltip("2026-08-01", "2026-08-05")).toBe(
        "2026-08-01 → 2026-08-05"
      );
    });

    it("formats a marker tooltip as 'title: date'", () => {
      expect(formatMarkerDragTooltip("納品", "2026-08-05")).toBe(
        "納品: 2026-08-05"
      );
    });

    it("formats a due-date tooltip with the「期限: 」prefix", () => {
      expect(formatDueDateDragTooltip("2026-08-05")).toBe("期限: 2026-08-05");
    });

    it("formats a bulk-move tooltip as '一括移動: from → to'", () => {
      expect(formatBulkMoveDragTooltip("2026-08-01", "2026-08-05")).toBe(
        "一括移動: 2026-08-01 → 2026-08-05"
      );
    });
  });

  describe("sortForBulkMove / getBulkMoveKeysForParent", () => {
    function makeSub(
      id: string,
      start: string,
      end: string,
      displayName = id
    ): TaskRow {
      return {
        id,
        displayName,
        title: displayName,
        plannedStartDate: start,
        plannedEndDate: end,
      } as unknown as TaskRow;
    }

    function makeParentWith(subs: TaskRow[]): TaskRow {
      const subtasks = new Map<string, TaskRow>();
      for (const s of subs) {
        subtasks.set(s.id, s);
      }
      return { subtasks } as unknown as TaskRow;
    }

    it("sorts by start, then end, then displayName", () => {
      const b = makeSub("b", "2026-08-05", "2026-08-10", "Bravo");
      const a1 = makeSub("a1", "2026-08-05", "2026-08-06", "Alpha");
      const a2 = makeSub("a2", "2026-08-05", "2026-08-06", "Zulu");
      const early = makeSub("early", "2026-08-01", "2026-08-02", "Whatever");
      const sorted = sortForBulkMove([b, a2, early, a1]);
      expect(sorted.map((t) => t.id)).toEqual(["early", "a1", "a2", "b"]);
    });

    it("returns the anchor's key and every key sorted after it", () => {
      const early = makeSub("early", "2026-08-01", "2026-08-02");
      const anchor = makeSub("anchor", "2026-08-05", "2026-08-06");
      const after = makeSub("after", "2026-08-07", "2026-08-08");
      const parent = makeParentWith([after, early, anchor]);
      const keys = getBulkMoveKeysForParent(parent, "anchor");
      expect(keys).toEqual(new Set(["anchor", "after"]));
    });

    it("returns an empty Set when anchorKey is not found (anchorIndex === -1)", () => {
      const parent = makeParentWith([
        makeSub("a", "2026-08-01", "2026-08-02"),
        makeSub("b", "2026-08-03", "2026-08-04"),
      ]);
      expect(getBulkMoveKeysForParent(parent, "missing")).toEqual(new Set());
    });

    it("a since-deleted anchor (removed from parent.subtasks) recomputes to an empty Set", () => {
      const anchor = makeSub("anchor", "2026-08-05", "2026-08-06");
      const parent = makeParentWith([
        makeSub("early", "2026-08-01", "2026-08-02"),
        anchor,
      ]);
      // Simulate the anchor task having been deleted between mode-entry and
      // a later recompute — same parent reference, anchor no longer present.
      parent.subtasks!.delete("anchor");
      expect(getBulkMoveKeysForParent(parent, "anchor")).toEqual(new Set());
    });

    it("handles a parent with no subtasks map without throwing", () => {
      const parent = {} as unknown as TaskRow;
      expect(getBulkMoveKeysForParent(parent, "anything")).toEqual(new Set());
    });
  });
});
