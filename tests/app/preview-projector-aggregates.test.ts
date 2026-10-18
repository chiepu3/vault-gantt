import { describe, expect, it } from "vitest";
import { aggregates } from "../../src/app/preview-projector";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskRow } from "../../src/core/types";

describe("aggregates", () => {
  it("sums child, event and weekly hours per date with business-day capacity", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.ganttEvents = [{ key: "e", title: "e", date: "2026-10-13", workloadPlan: { "2026-10-13": 1.5 }, workloadActual: { "2026-10-13": 1 } }];
    settings.weeklyWorkSchedules = [{ key: "w1", title: "a", dayOfWeek: 2, minutesPerWeek: 60 }, { key: "w2", title: "b", dayOfWeek: 2, minutesPerWeek: 30 }];
    const child = { workloadPlan: { "2026-10-13": 2, "2026-10-14": 3 }, workloadActual: { "2026-10-14": 4 } } as unknown as TaskRow;
    const parent = { subtasks: new Map([["c", child]]) } as unknown as TaskRow;
    const days = aggregates([parent], settings, ["2026-10-13", "2026-10-14", "2026-10-17", "2026-10-20"]);
    // 2026-10-13 and 2026-10-20 are Tuesdays: weekly 1.5h is added to plan.
    expect(days.map(({ date, plan, actual }) => ({ date, plan, actual }))).toEqual([
      { date: "2026-10-13", plan: 2 + 1.5 + 1.5, actual: 1 },
      { date: "2026-10-14", plan: 3, actual: 4 },
      { date: "2026-10-17", plan: 0, actual: 0 },
      { date: "2026-10-20", plan: 1.5, actual: 0 },
    ]);
    expect(days[2].capacity).toBe(0);
    expect(days[0].capacity).toBe(settings.ganttWorkloadDailyCapacityHours);
  });
});
