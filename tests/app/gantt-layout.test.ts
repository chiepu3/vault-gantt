import { describe, it, expect } from "vitest";
import type {
  GanttMarker,
  TaskRow,
  TaskWorkbenchSettings,
} from "../../src/core/types";
import {
  addDays,
  diffDays,
  clampDate,
  buildDates,
  isMonthStart,
  dateLabel,
  parseDate,
  isWeekend,
  monthTitle,
  formatDateLabel,
  dateFromClientX,
  estimateTextWidth,
  resolveGanttTagColor,
  getGanttParentRows,
  getGanttEvents,
  getMaxHours,
  getCapacityHours,
  planColor,
  WORKLOAD_ACTUAL_COLOR,
  hoursFromPointer,
  dateFromPointer,
  hasAnySelectedGanttTag,
  hasPlannedDates,
  packSubtasksIntoLanes,
  layoutMarkers,
  layoutFloatingEvents,
  layoutExternalBarLabels,
  computeRowHeight,
  computeLaneOffsets,
  computeHeaderFingerprint,
  computeRowFingerprint,
  collectWorkloadEntriesForDate,
} from "../../src/app/gantt-layout";
import type {
  Bar,
  HeaderFingerprintInput,
} from "../../src/app/gantt-layout";
import {
  PARENT_COL_WIDTH,
  HEADER_HEIGHT,
  BAR_HEIGHT,
  MARKER_ROW_HEIGHT,
  EXTERNAL_LABEL_ROW_HEIGHT,
  LANE_BASE_HEIGHT,
  OVERSCAN_DAYS,
  RANGE_EXTEND_DAYS,
  WORKLOAD_ROW_HEIGHT,
} from "../../src/app/gantt-constants";

let seq = 0;

function makeRow(overrides: Record<string, unknown> = {}): TaskRow {
  seq += 1;
  const path = `tasks/task-${seq}.md`;
  return {
    kind: "parent",
    id: path,
    file: { path },
    title: `Task ${seq}`,
    displayName: `Task ${seq}`,
    statusLabel: "active",
    completed: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    dueDate: "",
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ...overrides,
  } as unknown as TaskRow;
}

function makeSubtask(
  key: string,
  overrides: Record<string, unknown> = {}
): TaskRow {
  return makeRow({ kind: "subtask", key, ...overrides });
}

function withSubtasks(parent: TaskRow, children: TaskRow[]): TaskRow {
  parent.subtasks = new Map(
    children.map((child): [string, TaskRow] => [child.key ?? child.id, child])
  );
  return parent;
}

function makeBar(overrides: Partial<Bar> = {}): Bar {
  return {
    task: makeRow({ kind: "subtask" }),
    start: "2026-01-10",
    end: "2026-01-20",
    lane: 0,
    ...overrides,
  };
}

function makeMarker(
  key: string,
  date: string,
  title = key
): GanttMarker {
  return { key, title, date };
}


// Constants


describe("gantt-constants", () => {
  it("exports the constant values", () => {
    expect(HEADER_HEIGHT).toBe(54);
    expect(BAR_HEIGHT).toBe(24);
    expect(MARKER_ROW_HEIGHT).toBe(16);
    expect(EXTERNAL_LABEL_ROW_HEIGHT).toBe(22);
    expect(LANE_BASE_HEIGHT).toBe(44);
    expect(PARENT_COL_WIDTH).toBe(320);
    expect(RANGE_EXTEND_DAYS).toBe(60);
    expect(WORKLOAD_ROW_HEIGHT).toBe(52);

    expect(OVERSCAN_DAYS).toBe(21);
  });
});


// Date helpers


describe("addDays", () => {
  it("adds days across month and year boundaries in ISO format", () => {
    expect(addDays("2026-01-30", 2)).toBe("2026-02-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("supports negative offsets and leap years", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28"); // 2026 is not leap
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // 2024 is leap
    expect(addDays("2026-01-01", 0)).toBe("2026-01-01");
  });
});

describe("diffDays", () => {
  it("returns whole-day end - start distances", () => {
    expect(diffDays("2026-01-01", "2026-01-01")).toBe(0);
    expect(diffDays("2026-01-01", "2026-01-31")).toBe(30);
    expect(diffDays("2026-01-30", "2026-02-02")).toBe(3);
  });

  it("is negative when end precedes start", () => {
    expect(diffDays("2026-02-01", "2026-01-30")).toBe(-2);
  });

  it("returns 0 (not NaN) when either date is invalid", () => {
    expect(diffDays("not-a-date", "2026-01-01")).toBe(0);
    expect(diffDays("2026-01-01", "not-a-date")).toBe(0);
    expect(diffDays("not-a-date", "also-not-a-date")).toBe(0);
  });
});

describe("clampDate", () => {
  const rangeStart = "2026-01-10";
  const rangeEnd = "2026-01-20";

  it("clamps a date before the range up to rangeStart", () => {
    expect(clampDate("2026-01-05", rangeStart, rangeEnd)).toBe(rangeStart);
  });

  it("clamps a date after the range down to rangeEnd", () => {
    expect(clampDate("2026-02-01", rangeStart, rangeEnd)).toBe(rangeEnd);
  });

  it("leaves in-range dates and both range boundaries unchanged", () => {
    expect(clampDate("2026-01-15", rangeStart, rangeEnd)).toBe("2026-01-15");
    expect(clampDate(rangeStart, rangeStart, rangeEnd)).toBe(rangeStart);
    expect(clampDate(rangeEnd, rangeStart, rangeEnd)).toBe(rangeEnd);
  });

  it("uses rangeStart when the date is undefined", () => {

    // implementation deterministically chooses rangeStart.
    expect(clampDate(undefined, rangeStart, rangeEnd)).toBe(rangeStart);
  });
});

describe("buildDates", () => {
  it("produces rangeDays consecutive ISO dates from rangeStart", () => {
    const dates = buildDates("2026-01-01", 90);
    expect(dates).toHaveLength(90);
    expect(dates[0]).toBe("2026-01-01");
    expect(dates[89]).toBe("2026-03-31"); // 31 Jan + 28 Feb + 31 Mar window
    for (let i = 1; i < dates.length; i += 1) {
      expect(dates[i]).toBe(addDays(dates[i - 1], 1));
    }
  });

  it("returns an empty list for rangeDays = 0", () => {
    expect(buildDates("2026-01-01", 0)).toEqual([]);
  });
});

describe("isMonthStart", () => {
  it("shows the month on the 1st and on the first listed date even mid-month", () => {
    const dates = buildDates("2026-01-30", 4);

    expect(isMonthStart(dates, 0)).toBe(true); // mid-month range start: no previous date to compare
    expect(isMonthStart(dates, 1)).toBe(false);
    expect(isMonthStart(dates, 2)).toBe(true); // month changes 01 → 02
    expect(isMonthStart(dates, 3)).toBe(false);
  });

  it("labels only the 1st when the range starts exactly on a month start", () => {
    const dates = buildDates("2026-02-01", 3);
    expect(isMonthStart(dates, 0)).toBe(true);
    expect(isMonthStart(dates, 1)).toBe(false);
    expect(isMonthStart(dates, 2)).toBe(false);
  });

  it("detects a year boundary as a month change", () => {
    const dates = buildDates("2025-12-31", 2);
    expect(isMonthStart(dates, 1)).toBe(true);
  });
});

describe("dateLabel", () => {
  it("dateLabel returns a zero-padded day and Japanese short weekday", () => {

    expect(dateLabel("2026-01-01")).toEqual({ day: "01", dow: "木" });

    expect(dateLabel("2026-01-04")).toEqual({ day: "04", dow: "日" });

    expect(dateLabel("2026-01-31")).toEqual({ day: "31", dow: "土" });
  });
});



// Date helpers addDays, diffDays, and clampDate are covered above. The tests
// below focus on parseDate, isWeekend, and monthTitle.


// ISO 8601 YYYY-MM-DD, consistent with the rest of this module.


describe("parseDate", () => {
  it("strictly parses a valid YYYY-MM-DD date", () => {
    const parsed = parseDate("2026-07-25");
    expect(parsed).not.toBeNull();
    expect(parsed?.format("YYYY-MM-DD")).toBe("2026-07-25");
  });

  it("returns null for malformed/invalid input under strict parsing", () => {
    expect(parseDate("not-a-date")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull(); // invalid month
    expect(parseDate("2026-02-30")).toBeNull(); // invalid day (Feb has no 30th)
    expect(parseDate("2026/07/25")).toBeNull(); // wrong separator, strict mode
    expect(parseDate("")).toBeNull();
  });

  it("accepts a leap-year Feb 29", () => {
    expect(parseDate("2024-02-29")).not.toBeNull();
    expect(parseDate("2025-02-29")).toBeNull(); // 2025 is not a leap year
  });
});

describe("isWeekend", () => {
  it("true for Saturday and Sunday", () => {
    expect(isWeekend("2026-08-01")).toBe(true); // Saturday
    expect(isWeekend("2026-08-02")).toBe(true); // Sunday
  });

  it("returns false for weekdays regardless of holiday settings", () => {
    expect(isWeekend("2026-08-03")).toBe(false); // Monday
    expect(isWeekend("2026-08-04")).toBe(false); // Tuesday
    expect(isWeekend("2026-08-07")).toBe(false); // Friday
  });
});

describe("monthTitle", () => {
  it("formats the month as '<M>月', no zero-padding", () => {
    expect(monthTitle("2026-07-25")).toBe("7月");
    expect(monthTitle("2026-01-01")).toBe("1月");
    expect(monthTitle("2026-12-31")).toBe("12月");
  });
});

describe("formatDateLabel", () => {
  it("formats a date with an arbitrary moment format string", () => {
    expect(formatDateLabel("2026-07-25", "YYYY/MM/DD")).toBe("2026/07/25");
    expect(formatDateLabel("2026-07-25", "M月D日")).toBe("7月25日");
  });

  it("uses a different date-label shape from dateLabel", () => {
    // dateLabel(dateStr) returns {day, dow}; formatDateLabel(dateStr, format)
    // returns a plain string. They are not interchangeable.
    expect(dateLabel("2026-07-25")).toEqual({ day: "25", dow: "土" });
    expect(formatDateLabel("2026-07-25", "DD")).toBe("25");
  });
});

describe("dateFromClientX", () => {
  const baseDate = "2026-01-01";

  it("maps clientX to the date under the pointer", () => {
    // x = 454 - 100 + 50 - 320 = 84 → floor(84 / 28) = 3 days after base.
    expect(dateFromClientX(454, 100, 50, 28, baseDate)).toBe("2026-01-04");
  });

  it("resolves clicks left of the first day column to baseDate", () => {
    // x = 200 - 100 + 0 - 320 = -220 → max(0, x) → 0 days.
    expect(dateFromClientX(200, 100, 0, 28, baseDate)).toBe(baseDate);
  });
});


// CJK-aware text-width estimation


describe("estimateTextWidth", () => {
  it("sums 8px per half-width (ASCII) character plus the padding", () => {
    // "abcd": 4 × 8 + 18 = 50 (above the 48 floor).
    expect(estimateTextWidth("abcd")).toBe(50);
  });

  it("sums 16px per full-width (CJK) character plus the padding", () => {
    // "あいうえお": 5 × 16 + 18 = 98.
    expect(estimateTextWidth("あいうえお")).toBe(98);
    // Kanji and katakana count as full-width too.
    expect(estimateTextWidth("漢字")).toBe(2 * 16 + 18);
    expect(estimateTextWidth("カタ")).toBe(2 * 16 + 18);
  });

  it("counts fullwidth punctuation (U+FF00 block) as full-width", () => {
    // "！！" (U+FF01 × 2): 2 × 16 + 18 = 50.
    expect(estimateTextWidth("！！")).toBe(50);
  });

  it("a CJK character costs exactly twice an ASCII character", () => {
    // Each full-width character contributes twice the width of an ASCII character.
    const ascii = estimateTextWidth("aaaa"); // 4 × 8 + 18
    const cjk = estimateTextWidth("ああああ"); // 4 × 16 + 18
    expect(cjk).toBeGreaterThan(ascii);
    expect(cjk - 18).toBe(2 * (ascii - 18));
  });

  it("handles mixed ASCII + CJK text", () => {
    // "ab漢字": 2 × 8 + 2 × 16 + 18 = 66.
    expect(estimateTextWidth("ab漢字")).toBe(66);
  });

  it("returns at least 48px", () => {
    expect(estimateTextWidth("")).toBe(48);
    expect(estimateTextWidth("a")).toBe(48); // 8 + 18 = 26 → floored to 48
  });
});


// resolveGanttTagColor (deterministic tag → color)


describe("resolveGanttTagColor", () => {
  it("is deterministic: same tag name → same color", () => {
    expect(resolveGanttTagColor("backend")).toBe(
      resolveGanttTagColor("backend")
    );
    expect(resolveGanttTagColor("フロント")).toBe(
      resolveGanttTagColor("フロント")
    );
  });

  it("returns a valid hsl() color string", () => {
    const color = resolveGanttTagColor("backend");
    expect(color).toMatch(/^hsl\(\d{1,3}, 65%, 55%\)$/);
    const hue = Number(color.match(/^hsl\((\d{1,3}),/)![1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it("usually distinguishes different tag names", () => {
    // Not guaranteed for every pair (hash collisions exist) but a handful of
    // realistic tags should not all collapse onto one hue.
    const colors = new Set(
      ["backend", "frontend", "infra", "docs", "design"].map((tag) =>
        resolveGanttTagColor(tag)
      )
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("handles the empty string without throwing", () => {
    expect(resolveGanttTagColor("")).toBe("hsl(0, 65%, 55%)");
  });

  it("overrides take priority over the hash color when present", () => {
    expect(resolveGanttTagColor("backend", { backend: "#ff0000" })).toBe(
      "#ff0000"
    );
  });

  it("falls back to the hash color when the override map has no entry for this tag", () => {
    expect(resolveGanttTagColor("backend", { frontend: "#ff0000" })).toBe(
      resolveGanttTagColor("backend")
    );
  });

  it("falls back to the hash color when the override entry is empty/whitespace", () => {
    expect(resolveGanttTagColor("backend", { backend: "" })).toBe(
      resolveGanttTagColor("backend")
    );
    expect(resolveGanttTagColor("backend", { backend: "   " })).toBe(
      resolveGanttTagColor("backend")
    );
  });

  it("uses generated tag colors when overrides are omitted", () => {
    expect(resolveGanttTagColor("backend")).toBe(
      resolveGanttTagColor("backend", undefined)
    );
    expect(resolveGanttTagColor("backend", {})).toBe(
      resolveGanttTagColor("backend")
    );
  });
});


// Workload settings helpers.


function makeSettings(
  overrides: Partial<TaskWorkbenchSettings> = {}
): TaskWorkbenchSettings {
  return { ...overrides } as unknown as TaskWorkbenchSettings;
}

describe("getMaxHours", () => {
  it("returns the configured value when within [1, 24]", () => {
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: 10 }))).toBe(10);
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: 1 }))).toBe(1);
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: 24 }))).toBe(24);
  });

  it("clamps values above 24 down to 24", () => {
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: 30 }))).toBe(24);
  });

  it("clamps workload values below one hour up to one", () => {
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: 0 }))).toBe(1);
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: -5 }))).toBe(1);
  });

  it("defaults to 7 when the field is missing or not a finite number", () => {
    expect(getMaxHours(makeSettings({}))).toBe(7);
    expect(getMaxHours(makeSettings({ ganttWorkloadMaxHours: NaN }))).toBe(7);
    expect(
      getMaxHours(
        makeSettings({
          ganttWorkloadMaxHours: undefined as unknown as number,
        })
      )
    ).toBe(7);
  });
});

describe("getCapacityHours", () => {
  it("returns the configured value when within [0.5, 24]", () => {
    expect(
      getCapacityHours(makeSettings({ ganttWorkloadDailyCapacityHours: 5 }))
    ).toBe(5);
    expect(
      getCapacityHours(makeSettings({ ganttWorkloadDailyCapacityHours: 0.5 }))
    ).toBe(0.5);
  });

  it("clamps below 0.5 up to 0.5, and above 24 down to 24", () => {
    expect(
      getCapacityHours(makeSettings({ ganttWorkloadDailyCapacityHours: 0 }))
    ).toBe(0.5);
    expect(
      getCapacityHours(makeSettings({ ganttWorkloadDailyCapacityHours: 30 }))
    ).toBe(24);
  });

  it("defaults to the EFFECTIVE getMaxHours(settings), not a hardcoded 7, when missing", () => {
    expect(getCapacityHours(makeSettings({ ganttWorkloadMaxHours: 12 }))).toBe(
      12
    );
    expect(getCapacityHours(makeSettings({}))).toBe(7); // 7 here because getMaxHours also defaults to 7
  });

  it("defaults to the effective getMaxHours(settings) when the field is not a finite number", () => {
    expect(
      getCapacityHours(
        makeSettings({
          ganttWorkloadMaxHours: 9,
          ganttWorkloadDailyCapacityHours: NaN,
        })
      )
    ).toBe(9);
  });

  it("does not validate capacityHours <= maxHours: a larger explicit capacity is accepted as-is", () => {
    expect(
      getCapacityHours(
        makeSettings({
          ganttWorkloadMaxHours: 5,
          ganttWorkloadDailyCapacityHours: 20,
        })
      )
    ).toBe(20);
  });
});


// Workload color helpers.


function parseHsl(color: string): { hue: number; saturation: number; lightness: number } {
  const match = color.match(/^hsl\(([-\d.]+), ([\d.]+)%, ([\d.]+)%\)$/);
  expect(match).not.toBeNull();
  return {
    hue: Number(match![1]),
    saturation: Number(match![2]),
    lightness: Number(match![3]),
  };
}

describe("planColor", () => {
  it("returns the gray color-mix string for 0 hours", () => {
    expect(planColor(0, 7)).toBe(
      "color-mix(in srgb, var(--background-modifier-border) 35%, transparent)"
    );
  });

  it("returns the same gray for negative values", () => {
    expect(planColor(-1, 7)).toBe(
      "color-mix(in srgb, var(--background-modifier-border) 35%, transparent)"
    );
  });

  it("starts near hue 205 (cyan) / lightness 74 as value approaches 0", () => {
    const { hue, saturation, lightness } = parseHsl(planColor(0.001, 7));
    expect(hue).toBeCloseTo(204.972, 2);
    expect(saturation).toBe(70);
    expect(lightness).toBeCloseTo(73.997, 2);
  });

  it("reaches hue 10 (red) / lightness 51 exactly at value === maxHours", () => {
    expect(planColor(7, 7)).toBe("hsl(10, 70%, 51%)");
  });

  it("is a linear midpoint (hue 107.5 / lightness 62.5) at half of maxHours", () => {
    expect(planColor(3.5, 7)).toBe("hsl(107.5, 70%, 62.5%)");
  });

  it("clamps ratio to 1 (identical color) for any value beyond maxHours", () => {
    expect(planColor(7, 7)).toBe(planColor(14, 7));
    expect(planColor(7, 7)).toBe(planColor(1000, 7));
  });

  it("floors maxHours at 0.5 to avoid a divide-by-zero when maxHours is 0", () => {
    // value=0.5, maxHours=0 -> floored to 0.5 -> ratio=1 -> the maxed-out color
    expect(planColor(0.5, 0)).toBe("hsl(10, 70%, 51%)");
    // value below the floored maxHours still lands short of the max color
    const { hue } = parseHsl(planColor(0.25, 0));
    expect(hue).toBeGreaterThan(10);
    expect(hue).toBeLessThan(205);
  });
});

describe("WORKLOAD_ACTUAL_COLOR", () => {
  it("is the fixed --interactive-accent CSS variable, no gradient", () => {
    expect(WORKLOAD_ACTUAL_COLOR).toBe("var(--interactive-accent)");
  });
});


// Workload entries grouped by date.


describe("collectWorkloadEntriesForDate", () => {
  it("collects one entry per subtask with hours on the date, sorted hours DESC then parentName then subtaskName", () => {
    const parentA = withSubtasks(
      makeRow({ ganttEnabled: true, displayName: "Alpha" }),
      [
        makeSubtask("s1", {
          displayName: "Low",
          workloadPlan: { "2026-08-10": 1 },
        }),
        makeSubtask("s2", {
          displayName: "High",
          workloadPlan: { "2026-08-10": 5 },
        }),
      ]
    );
    const parentB = withSubtasks(
      makeRow({ ganttEnabled: true, displayName: "Beta" }),
      [
        makeSubtask("s3", {
          displayName: "Mid",
          workloadPlan: { "2026-08-10": 5 },
        }),
      ]
    );
    const entries = collectWorkloadEntriesForDate(
      "2026-08-10",
      [parentA, parentB],
      "plan"
    );
    // Both "High" (Alpha) and "Mid" (Beta) tie at 5h — parentName breaks
    // the tie ("Alpha" < "Beta"), then "Low" (Alpha, 1h) sorts last.
    expect(entries).toEqual([
      { parentName: "Alpha", subtaskName: "High", hours: 5 },
      { parentName: "Beta", subtaskName: "Mid", hours: 5 },
      { parentName: "Alpha", subtaskName: "Low", hours: 1 },
    ]);
  });

  it("plan and actual are collected independently — calling with mode=\"actual\" never sees the plan map's values", () => {
    const parent = withSubtasks(
      makeRow({ ganttEnabled: true, displayName: "P" }),
      [
        makeSubtask("s1", {
          displayName: "S1",
          workloadPlan: { "2026-08-10": 4 },
          workloadActual: { "2026-08-10": 2 },
        }),
      ]
    );
    expect(
      collectWorkloadEntriesForDate("2026-08-10", [parent], "plan")
    ).toEqual([{ parentName: "P", subtaskName: "S1", hours: 4 }]);
    expect(
      collectWorkloadEntriesForDate("2026-08-10", [parent], "actual")
    ).toEqual([{ parentName: "P", subtaskName: "S1", hours: 2 }]);
  });

  it("falls back to 「親タスク」/「サブタスク」 when displayName and title are both empty", () => {
    const parent = withSubtasks(
      makeRow({ ganttEnabled: true, displayName: "", title: "" }),
      [
        makeSubtask("s1", {
          displayName: "",
          title: "",
          workloadPlan: { "2026-08-10": 3 },
        }),
      ]
    );
    expect(
      collectWorkloadEntriesForDate("2026-08-10", [parent], "plan")
    ).toEqual([{ parentName: "親タスク", subtaskName: "サブタスク", hours: 3 }]);
  });

  it("returns an empty array when no subtask has hours on the date, and skips zero/other-date entries", () => {
    const parent = withSubtasks(
      makeRow({ ganttEnabled: true, displayName: "P" }),
      [
        makeSubtask("s1", {
          displayName: "S1",
          workloadPlan: { "2026-08-11": 3, "2026-08-10": 0 },
        }),
      ]
    );
    expect(
      collectWorkloadEntriesForDate("2026-08-10", [parent], "plan")
    ).toEqual([]);
  });

  it("equivalent: a parent with no subtasks contributes nothing", () => {
    const parent = makeRow({ ganttEnabled: true, displayName: "Empty" });
    expect(
      collectWorkloadEntriesForDate("2026-08-10", [parent], "plan")
    ).toEqual([]);
  });
});


// hoursFromPointer / dateFromPointer


describe("hoursFromPointer", () => {
  it("top of the graph (y=0) resolves to maxHours", () => {
    expect(hoursFromPointer(0, 100, 7)).toBe(7);
  });

  it("bottom of the graph (y=height) resolves to 0", () => {
    expect(hoursFromPointer(100, 100, 7)).toBe(0);
  });

  it("the vertical midpoint resolves to half of maxHours", () => {
    expect(hoursFromPointer(50, 100, 7)).toBeCloseTo(3.5, 10);
  });

  it("does NOT clamp internally — a y beyond the graph's own bounds produces a value outside [0, maxHours]", () => {
    expect(hoursFromPointer(-20, 100, 7)).toBeCloseTo(8.4, 10); // above the top
    expect(hoursFromPointer(120, 100, 7)).toBeCloseTo(-1.4, 10); // below the bottom
  });

  it("returns zero when graph height is not positive", () => {
    expect(hoursFromPointer(10, 0, 7)).toBe(0);
    expect(hoursFromPointer(10, -5, 7)).toBe(0);
  });
});

describe("dateFromPointer", () => {
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

  it("resolves the cell index from x / cellWidthPx, floored", () => {
    expect(dateFromPointer(0, 20, dates)).toBe("2026-08-01");
    expect(dateFromPointer(19, 20, dates)).toBe("2026-08-01");
    expect(dateFromPointer(20, 20, dates)).toBe("2026-08-02");
    expect(dateFromPointer(45, 20, dates)).toBe("2026-08-03"); // floor(45/20) = 2
  });

  it("clamps an out-of-range index to the nearest cell instead of overflowing", () => {
    expect(dateFromPointer(-50, 20, dates)).toBe("2026-08-01");
    expect(dateFromPointer(9999, 20, dates)).toBe("2026-08-04");
  });

  it("returns '' when there are no dates to index into", () => {
    expect(dateFromPointer(10, 20, [])).toBe("");
  });

  it("returns the first date when cell width is not positive", () => {
    expect(dateFromPointer(10, 0, dates)).toBe("2026-08-01");
    expect(dateFromPointer(10, -5, dates)).toBe("2026-08-01");
  });
});


// getGanttParentRows


describe("getGanttParentRows", () => {
  it("keeps only kind=parent with ganttEnabled=true", () => {
    const enabled = makeRow({ ganttEnabled: true });
    const disabled = makeRow({ ganttEnabled: false });
    const child = makeSubtask("s1", { ganttEnabled: true });

    const rows = getGanttParentRows([enabled, disabled, child]);

    expect(rows).toEqual([enabled]);
  });

  it("sorts by ganttOrder ascending", () => {
    const c = makeRow({ ganttEnabled: true, ganttOrder: 30 });
    const a = makeRow({ ganttEnabled: true, ganttOrder: 10 });
    const b = makeRow({ ganttEnabled: true, ganttOrder: 20 });

    const rows = getGanttParentRows([c, a, b]);

    expect(rows).toEqual([a, b, c]);
  });

  it("sorts missing and non-finite ganttOrder values last", () => {
    const missing = makeRow({ ganttEnabled: true, displayName: "A" });
    const nan = makeRow({
      ganttEnabled: true,
      ganttOrder: NaN,
      displayName: "B",
    });
    const infinite = makeRow({
      ganttEnabled: true,
      ganttOrder: Infinity,
      displayName: "C",
    });
    const ordered = makeRow({ ganttEnabled: true, ganttOrder: 999998 });

    const rows = getGanttParentRows([missing, nan, infinite, ordered]);

    expect(rows[0]).toBe(ordered);
    // The three fallback rows come after, name-sorted.
    expect(rows.slice(1)).toEqual([missing, nan, infinite]);
  });

  it("breaks ganttOrder ties by displayName || title via localeCompare", () => {
    const beta = makeRow({
      ganttEnabled: true,
      ganttOrder: 5,
      displayName: "Beta",
      title: "zzz",
    });
    const alpha = makeRow({
      ganttEnabled: true,
      ganttOrder: 5,
      displayName: "Alpha",
      title: "yyy",
    });
    const rows = getGanttParentRows([beta, alpha]);
    expect(rows).toEqual([alpha, beta]);
  });

  it("falls back to title when displayName is empty", () => {
    const titledB = makeRow({
      ganttEnabled: true,
      ganttOrder: 5,
      displayName: "",
      title: "Bravo",
    });
    const titledA = makeRow({
      ganttEnabled: true,
      ganttOrder: 5,
      displayName: "",
      title: "Alfa",
    });
    const rows = getGanttParentRows([titledB, titledA]);
    expect(rows).toEqual([titledA, titledB]);
  });

  it("does not mutate the input array order", () => {
    const b = makeRow({ ganttEnabled: true, ganttOrder: 2 });
    const a = makeRow({ ganttEnabled: true, ganttOrder: 1 });
    const input = [b, a];
    getGanttParentRows(input);
    expect(input).toEqual([b, a]);
  });
});






describe("getGanttEvents", () => {
  it("returns [] when settings.ganttEvents is empty", () => {
    expect(getGanttEvents({ ganttEvents: [] })).toEqual([]);
  });

  it("returns configured Gantt events without modification", () => {
    const events = [
      { key: "event-1", title: "忘年会", date: "2026-01-01" },
      { key: "event-2", title: "raw-entry", date: "2026-02-14" },
    ];
    expect(getGanttEvents({ ganttEvents: events })).toEqual(events);
  });

  it("defensively returns [] when settings.ganttEvents is not an array", () => {
    expect(
      getGanttEvents({
        ganttEvents: "not-an-array" as unknown as { key: string; title: string; date: string }[],
      })
    ).toEqual([]);
  });
});





describe("hasAnySelectedGanttTag", () => {
  it("an empty filter Set passes every tag list", () => {
    expect(hasAnySelectedGanttTag([], new Set<string>())).toBe(true);
    expect(hasAnySelectedGanttTag(["work"], new Set<string>())).toBe(true);
  });

  it("passes when at least one tag is in the filter", () => {
    const filter = new Set(["work", "urgent"]);
    expect(hasAnySelectedGanttTag(["work"], filter)).toBe(true);
    expect(hasAnySelectedGanttTag(["home", "urgent"], filter)).toBe(true);
  });

  it("rejects when no tag intersects the filter", () => {
    const filter = new Set(["work"]);
    expect(hasAnySelectedGanttTag([], filter)).toBe(false);
    expect(hasAnySelectedGanttTag(["home", "private"], filter)).toBe(false);
  });

  it("does not mutate either input", () => {
    const tags = ["a", "b"];
    const filter = new Set(["b"]);
    hasAnySelectedGanttTag(tags, filter);
    expect(tags).toEqual(["a", "b"]);
    expect(Array.from(filter)).toEqual(["b"]);
  });
});


// packSubtasksIntoLanes


describe("packSubtasksIntoLanes", () => {
  it("drops subtasks missing either planned date entirely", () => {
    const both = makeSubtask("both", {
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-05",
    });
    const startOnly = makeSubtask("startOnly", {
      plannedStartDate: "2026-01-01",
    });
    const endOnly = makeSubtask("endOnly", { plannedEndDate: "2026-01-05" });
    const neither = makeSubtask("neither");
    const emptyStrings = makeSubtask("empty", {
      plannedStartDate: "",
      plannedEndDate: "",
    });

    const { bars, laneCount } = packSubtasksIntoLanes([
      both,
      startOnly,
      endOnly,
      neither,
      emptyStrings,
    ]);

    expect(bars.map((bar) => bar.task)).toEqual([both]);
    expect(laneCount).toBe(1);
  });

  it("hasPlannedDates requires both dates as non-empty strings", () => {
    expect(
      hasPlannedDates(
        makeSubtask("ok", {
          plannedStartDate: "2026-01-01",
          plannedEndDate: "2026-01-02",
        })
      )
    ).toBe(true);
    expect(hasPlannedDates(makeSubtask("none"))).toBe(false);
    expect(
      hasPlannedDates(makeSubtask("half", { plannedStartDate: "2026-01-01" }))
    ).toBe(false);
  });

  it("returns laneCount 1 with no bars for date-less input", () => {
    const result = packSubtasksIntoLanes([makeSubtask("noDates")]);
    expect(result.bars).toEqual([]);
    expect(result.laneCount).toBe(1);

    const empty = packSubtasksIntoLanes([]);
    expect(empty.bars).toEqual([]);
    expect(empty.laneCount).toBe(1);
  });

  it("sorts bars by start, then end, then title", () => {
    const later = makeSubtask("later", {
      plannedStartDate: "2026-01-10",
      plannedEndDate: "2026-01-12",
    });
    const sameStartLaterEnd = makeSubtask("sameStartLaterEnd", {
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-09",
    });
    const sameStartEndB = makeSubtask("b", {
      title: "Beta",
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-05",
    });
    const sameStartEndA = makeSubtask("a", {
      title: "Alpha",
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-05",
    });

    const { bars } = packSubtasksIntoLanes([
      later,
      sameStartLaterEnd,
      sameStartEndB,
      sameStartEndA,
    ]);

    expect(bars.map((bar) => bar.task)).toEqual([
      sameStartEndA,
      sameStartEndB,
      sameStartLaterEnd,
      later,
    ]);
  });

  it("boundary-adjacent bars (last.end === bar.start) do NOT share a lane", () => {
    const first = makeSubtask("first", {
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-10",
    });
    const adjacent = makeSubtask("adjacent", {
      plannedStartDate: "2026-01-10", // === first's end → overlap
      plannedEndDate: "2026-01-15",
    });
    const strictAfter = makeSubtask("strictAfter", {
      plannedStartDate: "2026-01-11", // > lane 0's last end → fits lane 0
      plannedEndDate: "2026-01-12",
    });

    const { bars, laneCount } = packSubtasksIntoLanes([
      first,
      adjacent,
      strictAfter,
    ]);

    const laneOf = (task: TaskRow): number =>
      bars.find((bar) => bar.task === task)?.lane ?? -1;
    expect(laneOf(first)).toBe(0);
    expect(laneOf(adjacent)).toBe(1);
    expect(laneOf(strictAfter)).toBe(0);
    expect(laneCount).toBe(2);
  });

  it("three mutually overlapping bars open three lanes", () => {
    const a = makeSubtask("a", {
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-20",
    });
    const b = makeSubtask("b", {
      plannedStartDate: "2026-01-05",
      plannedEndDate: "2026-01-25",
    });
    const c = makeSubtask("c", {
      plannedStartDate: "2026-01-10",
      plannedEndDate: "2026-01-30",
    });

    const { bars, laneCount } = packSubtasksIntoLanes([a, b, c]);

    expect(bars.map((bar) => bar.lane)).toEqual([0, 1, 2]);
    expect(laneCount).toBe(3);
  });

  it("a freed lane is reused by a later non-overlapping bar", () => {
    const a = makeSubtask("a", {
      plannedStartDate: "2026-01-01",
      plannedEndDate: "2026-01-05",
    });
    const b = makeSubtask("b", {
      plannedStartDate: "2026-01-03",
      plannedEndDate: "2026-01-08",
    });
    const c = makeSubtask("c", {
      plannedStartDate: "2026-01-06", // after a.end (01-05) → lane 0
      plannedEndDate: "2026-01-09",
    });

    const { bars } = packSubtasksIntoLanes([a, b, c]);

    expect(bars.map((bar) => bar.lane)).toEqual([0, 1, 0]);
  });
});


// layoutMarkers


describe("layoutMarkers", () => {
  const bar = makeBar({ start: "2026-01-10", end: "2026-01-20" });
  const baseDate = "2026-01-01";

  it("positions x = (date - baseDate) × dayWidth + dayWidth/2", () => {
    const [placed] = layoutMarkers(
      [makeMarker("m", "2026-01-11")],
      bar,
      baseDate,
      20
    );
    // diffDays = 10 → 10 × 20 + 10 = 210.
    expect(placed.x).toBe(210);
    expect(placed.row).toBe(0);
  });

  it("clamps marker dates outside the bar to its boundaries", () => {
    const before = layoutMarkers(
      [makeMarker("before", "2026-01-05")],
      bar,
      baseDate,
      20
    );

    expect(before[0].x).toBe(190);

    const after = layoutMarkers(
      [makeMarker("after", "2026-02-01")],
      bar,
      baseDate,
      20
    );

    expect(after[0].x).toBe(390);
  });

  it("uses bar.start when the marker date is undefined", () => {
    const marker = {
      key: "noDate",
      title: "noDate",
      date: undefined as unknown as string,
    };
    const [placed] = layoutMarkers([marker], bar, baseDate, 20);
    // clampDate(undefined,...) → bar.start → x = 190 (same as bar.start).
    expect(placed.x).toBe(190);
  });

  it("overlapping markers go to separate rows; a 4px gap may share a row", () => {

    // dayWidth 26 and 2-char titles → every marker is 48px wide
    // (estimateTextWidth floor), i.e. intervals [x, x+48].
    // x = diff × 26 + 13.

    const near = layoutMarkers(
      [

        makeMarker("m1", "2026-01-11"), // diff 10 → x 273, [273, 321]
        makeMarker("m2", "2026-01-12"), // diff 11 → x 299, [299, 347]: overlaps m1

      ],
      bar,
      baseDate,
      26
    );
    expect(near.map((placed) => placed.row)).toEqual([0, 1]);


    // Two days apart: [273, 321] vs [325, 373] — exactly the 4px minimum
    // gap, which is allowed on the same row.

    const gapped = layoutMarkers(
      [
        makeMarker("m1", "2026-01-11"),

        makeMarker("m3", "2026-01-13"), // diff 12 → x 325, [325, 373]

      ],
      bar,
      baseDate,
      26
    );
    expect(gapped.map((placed) => placed.row)).toEqual([0, 0]);
  });

  it("packs a later marker back into the lowest free row", () => {
    const placed = layoutMarkers(
      [

        makeMarker("m1", "2026-01-11"), // row 0, [273, 321]
        makeMarker("m2", "2026-01-12"), // row 1, [299, 347]
        makeMarker("m3", "2026-01-13"), // fits row 0 (gap 4px from m1)

      ],
      bar,
      baseDate,
      26
    );
    expect(placed.map((p) => p.row)).toEqual([0, 1, 0]);
  });
});


// layoutFloatingEvents


describe("layoutFloatingEvents", () => {
  const baseDate = "2026-01-01";
  const event = (key: string, date: string, title = "予定") => ({
    key,
    date,
    title,
  });

  it("packs events on the same day into separate rows", () => {
    const placed = layoutFloatingEvents(
      [event("e1", "2026-01-03"), event("e2", "2026-01-03")],
      baseDate,
      28
    );

    expect(placed.map((item) => item.row)).toEqual([0, 1]);
    expect(placed[0].x).toBe(2 * 28 + 14);
  });

  it("lets events far apart in time share the first row", () => {
    const placed = layoutFloatingEvents(
      [event("e1", "2026-01-03"), event("e2", "2026-01-10")],
      baseDate,
      28
    );

    expect(placed.map((item) => item.row)).toEqual([0, 0]);
  });

  it("returns deterministic first-fit rows for a later event", () => {
    const placed = layoutFloatingEvents(
      [
        event("e1", "2026-01-03"),
        event("e2", "2026-01-04"),
        event("e3", "2026-01-05"),
      ],
      baseDate,
      28
    );

    expect(placed.map((item) => item.row)).toEqual([0, 1, 0]);
  });
});


// layoutExternalBarLabels


describe("layoutExternalBarLabels", () => {
  const baseDate = "2026-01-01";
  const dayWidth = 20;

  function labelBar(
    start: string,
    end: string,
    labelText = "AB",
    needsLabel = true
  ): Bar & { needsLabel: boolean; labelText: string } {
    return { ...makeBar({ start, end }), needsLabel, labelText };
  }

  it("places the first label on top when neither side has an occupied row", () => {
    const a = labelBar("2026-01-01", "2026-01-02");
    const placements = layoutExternalBarLabels([a], baseDate, dayWidth);
    expect(placements.get(a)).toEqual({ side: "top", row: 0 });
  });

  it("places a label on bottom only when bottom has strictly fewer rows", () => {
    const a = labelBar("2026-01-01", "2026-01-02");
    const b = labelBar("2026-02-01", "2026-02-02");
    const placements = layoutExternalBarLabels([a, b], baseDate, dayWidth);
    // a → top row 0 (tie); b → bottom (0 rows < 1 row).
    expect(placements.get(a)).toEqual({ side: "top", row: 0 });
    expect(placements.get(b)).toEqual({ side: "bottom", row: 0 });
  });

  it("a tie after both sides have rows goes back to top, reusing a free row", () => {
    const a = labelBar("2026-01-01", "2026-01-02"); // top row 0, right = 92
    const b = labelBar("2026-02-01", "2026-02-02"); // bottom row 0
    const c = labelBar("2026-03-01", "2026-03-02"); // tie 1-1 → top; fits row 0
    const placements = layoutExternalBarLabels(
      [a, b, c],
      baseDate,
      dayWidth
    );
    expect(placements.get(c)).toEqual({ side: "top", row: 0 });
  });

  it("opens a new row when the label overlaps every existing row on the chosen side", () => {

    // (labelLeft 44, right 92): every side row conflicts.
    const d = labelBar("2026-01-01", "2026-01-02");
    const e = labelBar("2026-01-02", "2026-01-02");
    const f = labelBar("2026-01-02", "2026-01-02", "CD");
    const placements = layoutExternalBarLabels(
      [d, e, f],
      baseDate,
      dayWidth
    );
    expect(placements.get(d)).toEqual({ side: "top", row: 0 });
    expect(placements.get(e)).toEqual({ side: "bottom", row: 0 });
    // f: tie (1-1) → top; top row 0 occupied → new top row 1.
    expect(placements.get(f)).toEqual({ side: "top", row: 1 });
  });

  it("ignores bars without needsLabel and processes in start-date order", () => {
    const hidden = labelBar("2026-01-01", "2026-01-02", "X", false);
    const b = labelBar("2026-02-01", "2026-02-02");
    const a = labelBar("2026-01-05", "2026-01-06");
    // Passed out of order; a (earlier start) must be processed first.
    const placements = layoutExternalBarLabels(
      [hidden, b, a],
      baseDate,
      dayWidth
    );
    expect(placements.has(hidden)).toBe(false);
    // a processed first → top; b second → bottom. Reversed processing
    // order would have made b top and a bottom.
    expect(placements.get(a)).toEqual({ side: "top", row: 0 });
    expect(placements.get(b)).toEqual({ side: "bottom", row: 0 });
  });

  it("places labels 8px after the bar's right edge", () => {

    // barRight = (1 + 1) × 20 - 4 = 36; the label must not collide with a
    // second label starting at labelLeft 44 + width. Verified indirectly:
    // two bars whose second label starts past the first label's right edge
    // can share a side's row only if the 8px gap + width math holds.
    const a = labelBar("2026-01-01", "2026-01-01"); // barRight 16, left 24, right 72
    const b = labelBar("2026-01-01", "2026-01-04"); // barRight 76, left 84 > 72
    const placements = layoutExternalBarLabels([a, b], baseDate, dayWidth);
    // a → top row 0; b: bottom (0 < 1) wins on side choice first...
    expect(placements.get(a)).toEqual({ side: "top", row: 0 });
    expect(placements.get(b)).toEqual({ side: "bottom", row: 0 });
    //...but a third label far to the right reuses top row 0 (no overlap),
    // proving rows track rightmost extents (24+48=72 ≤ 84-style spacing).
    const c = labelBar("2026-01-01", "2026-01-05"); // barRight 96, left 104
    const placements3 = layoutExternalBarLabels(
      [a, b, c],
      baseDate,
      dayWidth
    );
    // c: tie 1-1 → top; a's right = 72 ≤ 104 → top row 0 reused.
    expect(placements3.get(c)).toEqual({ side: "top", row: 0 });
  });
});


// computeRowHeight / computeLaneOffsets


describe("computeRowHeight", () => {
  it("one bare lane = 8 + 44 + 8", () => {
    expect(computeRowHeight(1, [0], [0], [0], false)).toBe(60);
  });

  it("sums per-lane contributions in the fixed order", () => {
    // Lane 0: 2 top rows × 22 + 44 + 3 marker rows × 16 + 1 bottom row × 22
    // = 44 + 44 + 48 + 22 = 158; total 8 + 158 + 8 = 174.
    expect(computeRowHeight(1, [2], [1], [3], false)).toBe(174);
  });

  it("sums multiple lanes", () => {
    expect(computeRowHeight(2, [0, 0], [0, 0], [0, 0], false)).toBe(
      8 + 44 + 44 + 8
    );
  });

  it("adds MARKER_ROW_HEIGHT + 6 for a deadline marker", () => {
    expect(computeRowHeight(1, [0], [0], [0], true)).toBe(60 + 16 + 6);
  });

  it("treats missing per-lane array entries as 0", () => {
    expect(computeRowHeight(2, [], [], [], false)).toBe(8 + 44 + 44 + 8);
  });
});

describe("computeLaneOffsets", () => {
  it("starts at 8px and accumulates lane heights", () => {
    expect(computeLaneOffsets([44, 60, 30])).toEqual([8, 52, 112]);
  });

  it("returns an empty offset list for no lanes", () => {
    expect(computeLaneOffsets([])).toEqual([]);
  });
});


// Fingerprints


function baseHeaderInput(): HeaderFingerprintInput {
  return {
    dates: buildDates("2026-01-01", 90),
    dayWidth: 28,
    today: "2026-01-15",
    holidays: ["2026-01-12"],
    featureFlags: {
      workload: true,
      events: true,
      dailyTodo: true,
      tags: true,
    },
    parentPaths: ["tasks/p1.md", "tasks/p2.md"],
  };
}

describe("computeHeaderFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeHeaderFingerprint(baseHeaderInput())).toBe(
      computeHeaderFingerprint(baseHeaderInput())
    );
  });

  const mutations: Array<[string, () => HeaderFingerprintInput]> = [
    [
      "dates length",
      () => ({ ...baseHeaderInput(), dates: buildDates("2026-01-01", 91) }),
    ],
    [
      "first date",
      () => ({ ...baseHeaderInput(), dates: buildDates("2026-01-02", 90) }),
    ],
    ["day width", () => ({ ...baseHeaderInput(), dayWidth: 29 })],
    [
      "incremental today",
      () => ({ ...baseHeaderInput(), today: "2026-01-16" }),
    ],
    [
      "holidays",
      () => ({ ...baseHeaderInput(), holidays: ["2026-01-13"] }),
    ],
    [
      "parent path order",
      () => ({
        ...baseHeaderInput(),
        parentPaths: ["tasks/p2.md", "tasks/p1.md"],
      }),
    ],
    [
      "workload feature flag",
      () => ({
        ...baseHeaderInput(),
        featureFlags: {
          workload: false,
          events: true,
          dailyTodo: true,
          tags: true,
        },
      }),
    ],
    [
      "events feature flag",
      () => ({
        ...baseHeaderInput(),
        featureFlags: {
          workload: true,
          events: false,
          dailyTodo: true,
          tags: true,
        },
      }),
    ],
    [
      "daily ToDo feature flag",
      () => ({
        ...baseHeaderInput(),
        featureFlags: {
          workload: true,
          events: true,
          dailyTodo: false,
          tags: true,
        },
      }),
    ],
    [
      "tags feature flag",
      () => ({
        ...baseHeaderInput(),
        featureFlags: {
          workload: true,
          events: true,
          dailyTodo: true,
          tags: false,
        },
      }),
    ],
    [
      "active tag filter present",
      () => ({ ...baseHeaderInput(), activeTagFilter: new Set(["work"]) }),
    ],
    [
      "incremental tag definition changes",
      () => ({
        ...baseHeaderInput(),
        tagDefinitions: [
          { key: "work", name: "work", color: "#123456", order: 0 },
        ],
      }),
    ],
  ];

  const baseline = computeHeaderFingerprint(baseHeaderInput());
  for (const [label, mutate] of mutations) {
    it(`${label} changes the fingerprint`, () => {
      expect(computeHeaderFingerprint(mutate())).not.toBe(baseline);
    });
  }

  it("is robust to featureFlags object key insertion order", () => {
    const reordered: HeaderFingerprintInput = {
      ...baseHeaderInput(),
      featureFlags: {
        tags: true,
        dailyTodo: true,
        events: true,
        workload: true,
      },
    };
    expect(computeHeaderFingerprint(reordered)).toBe(baseline);
  });

  it("is invariant under tag filter Set insertion order", () => {
    const ab = computeHeaderFingerprint({
      ...baseHeaderInput(),
      activeTagFilter: new Set(["a", "b"]),
    });
    const ba = computeHeaderFingerprint({
      ...baseHeaderInput(),
      activeTagFilter: new Set(["b", "a"]),
    });
    expect(ab).toBe(ba);
  });

  it("distinguishes different tag filter contents", () => {
    const ab = computeHeaderFingerprint({
      ...baseHeaderInput(),
      activeTagFilter: new Set(["a", "b"]),
    });
    const a = computeHeaderFingerprint({
      ...baseHeaderInput(),
      activeTagFilter: new Set(["a"]),
    });
    expect(ab).not.toBe(a);
  });

  it("treats an empty tag filter the same as an absent one", () => {
    const empty = computeHeaderFingerprint({
      ...baseHeaderInput(),
      activeTagFilter: new Set(),
    });
    expect(empty).toBe(baseline);
  });
});

function fingerprintParent(): TaskRow {
  const subtask = makeSubtask("sub-a", {
    title: "Sub A",
    displayName: "Sub A",
    plannedStartDate: "2026-01-01",
    plannedEndDate: "2026-01-05",
    priority: 2,
    tags: ["t1"],
    statusLabel: "in_progress",
    completed: false,
    workloadPlan: { "2026-01-01": 3 },
    workloadActual: { "2026-01-01": 2 },
    ganttMarkers: [makeMarker("m1", "2026-01-03")],
  });
  return withSubtasks(
    makeRow({
      title: "Parent",
      displayName: "Parent Display",
      dueDate: "2026-02-01",
      ganttOrder: 42,
      tags: ["ptag"],
      completed: false,
      statusLabel: "active",
      ganttEnabled: true,
    }),
    [subtask]
  );
}

describe("computeRowFingerprint", () => {
  it("is deterministic for identical rows", () => {
    expect(computeRowFingerprint(fingerprintParent())).toBe(
      computeRowFingerprint(fingerprintParent())
    );
  });

  const parentMutations: Array<[string, (row: TaskRow) => void]> = [
    ["parent title", (row) => void (row.title = "Other")],
    ["parent displayName", (row) => void (row.displayName = "Other")],
    ["parent dueDate", (row) => void (row.dueDate = "2026-02-02")],
    ["parent Gantt order", (row) => void (row.ganttOrder = 43)],
    ["parent tags", (row) => void (row.tags = ["other"])],
    ["parent completion", (row) => void (row.completed = true)],
    ["parent status label", (row) => void (row.statusLabel = "done")],
  ];

  const baselineRow = computeRowFingerprint(fingerprintParent());
  for (const [label, mutate] of parentMutations) {
    it(`${label} changes the fingerprint`, () => {
      const row = fingerprintParent();
      mutate(row);
      expect(computeRowFingerprint(row)).not.toBe(baselineRow);
    });
  }

  const subtaskMutations: Array<[string, (sub: TaskRow) => void]> = [
    ["subtask key", (sub) => void (sub.key = "sub-b")],
    ["subtask title", (sub) => void (sub.title = "Other")],
    // displayName is tracked defensively even though it is not part of the
    // serialized subtask fields; verify that the fingerprint changes for it.
    ["displayName (defensive)", (sub) => void (sub.displayName = "Other")],
    [
      "subtask planned start date",
      (sub) => void (sub.plannedStartDate = "2026-01-02"),
    ],
    [
      "subtask planned end date",
      (sub) => void (sub.plannedEndDate = "2026-01-06"),
    ],
    ["subtask priority", (sub) => void (sub.priority = 3)],
    ["subtask tags", (sub) => void (sub.tags = ["t2"])],
    ["subtask status label", (sub) => void (sub.statusLabel = "done")],
    ["subtask completion", (sub) => void (sub.completed = true)],
    [
      "subtask planned workload",
      (sub) => void (sub.workloadPlan = { "2026-01-02": 3 }),
    ],
    [
      "subtask actual workload",
      (sub) => void (sub.workloadActual = { "2026-01-02": 2 }),
    ],
    [
      "subtask markers",
      (sub) => void (sub.ganttMarkers = [makeMarker("m1", "2026-01-04")]),
    ],
  ];

  for (const [label, mutate] of subtaskMutations) {
    it(`${label} changes the fingerprint`, () => {
      const row = fingerprintParent();
      const sub = row.subtasks?.get("sub-a");
      expect(sub).toBeDefined();
      mutate(sub as TaskRow);
      expect(computeRowFingerprint(row)).not.toBe(baselineRow);
    });
  }

  it("adding a subtask changes the fingerprint", () => {
    const row = fingerprintParent();
    withSubtasks(row, [
      ...(row.subtasks ? Array.from(row.subtasks.values()) : []),
      makeSubtask("sub-b", { title: "Sub B" }),
    ]);
    expect(computeRowFingerprint(row)).not.toBe(baselineRow);
  });
});
