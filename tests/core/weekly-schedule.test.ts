import { describe, it, expect } from "vitest";
import { weeklyScheduleCountsOn } from "../../src/core/weekly-schedule";
import { addWeeklyWorkSchedule, updateWeeklyWorkSchedule } from "../../src/app/gantt-task-service";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

describe("weeklyScheduleCountsOn", () => {
  const schedule = { dayOfWeek: 2, startDate: "2026-11-10", endDate: "2026-11-24" };
  it("counts only on the weekday inside the period (bounds inclusive)", () => {
    expect(weeklyScheduleCountsOn(schedule, "2026-11-10", 2)).toBe(true);
    expect(weeklyScheduleCountsOn(schedule, "2026-11-24", 2)).toBe(true);
    expect(weeklyScheduleCountsOn(schedule, "2026-11-03", 2)).toBe(false);
    expect(weeklyScheduleCountsOn(schedule, "2026-12-01", 2)).toBe(false);
    expect(weeklyScheduleCountsOn(schedule, "2026-11-11", 3)).toBe(false);
  });
  it("is unbounded without dates", () => {
    expect(weeklyScheduleCountsOn({ dayOfWeek: 2 }, "2030-01-01", 2)).toBe(true);
  });
});

describe("weekly schedule period edits", () => {
  it("sets and clears startDate / endDate", () => {
    const settings = { ...DEFAULT_SETTINGS, weeklyWorkSchedules: [] };
    const s = addWeeklyWorkSchedule(settings, "定例", 2, 60, { startDate: "2026-11-10" });
    expect(s.startDate).toBe("2026-11-10");
    expect(s).not.toHaveProperty("endDate");
    updateWeeklyWorkSchedule(settings, s.key, { endDate: "2026-12-01", startDate: "" });
    expect(settings.weeklyWorkSchedules[0]).toMatchObject({ endDate: "2026-12-01" });
    expect(settings.weeklyWorkSchedules[0]).not.toHaveProperty("startDate");
  });
});
