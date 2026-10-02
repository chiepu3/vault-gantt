import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

import {
  addGanttEvent,
  addWeeklyWorkSchedule,
  deleteGanttEvent,
  deleteWeeklyWorkSchedule,
  duplicateGanttEvent,
  enableParentInGantt,
  updateGanttEvent,
  updateWeeklyWorkSchedule,
} from "../../src/app/gantt-task-service";

import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";

let seq = 0;

function makeParent(overrides: Record<string, unknown> = {}): TaskRow {
  seq += 1;
  const path = `tasks/parent-${seq}.md`;
  return {
    kind: "parent",
    id: path,
    file: { path },
    title: `Parent ${seq}`,
    displayName: `Parent ${seq}`,
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

function makeSettings(overrides: Record<string, unknown> = {}): TaskWorkbenchSettings {
  return { ...DEFAULT_SETTINGS, ...overrides } as TaskWorkbenchSettings;
}





describe("addGanttEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes a {key,title,date} event into settings.ganttEvents and returns it", () => {
    const settings = makeSettings({ ganttEvents: [] });
    const created = addGanttEvent(settings, "誕生日", "2026-09-01");

    expect(created).toEqual({
      key: expect.stringMatching(/^event-\d+/),
      title: "誕生日",
      date: "2026-09-01",
    });
    expect(settings.ganttEvents).toEqual([created]);
  });

  it("base key is event-${Date.now()} when there is no collision", () => {
    const settings = makeSettings({ ganttEvents: [] });
    const created = addGanttEvent(settings, "会議", "2026-09-02");
    expect(created.key).toBe(`event-${Date.now()}`);
  });

  it("appends a random suffix on key collision via a while loop", () => {
    const settings = makeSettings({
      ganttEvents: [{ key: `event-${Date.now()}`, title: "既存", date: "2026-09-01" }],
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // -> 500
    const created = addGanttEvent(settings, "新規", "2026-09-03");

    expect(created.key).toBe(`event-${Date.now()}-500`);
    expect(settings.ganttEvents).toHaveLength(2);
    randomSpy.mockRestore();
  });

  it("empty title is replaced with 「新しいタスク」", () => {
    const settings = makeSettings({ ganttEvents: [] });
    const created = addGanttEvent(settings, "", "2026-09-01");
    expect(created.title).toBe("新しいタスク");
  });

  it("date is used as-is, no validation", () => {
    const settings = makeSettings({ ganttEvents: [] });
    const created = addGanttEvent(settings, "何か", "not-a-real-date");
    expect(created.date).toBe("not-a-real-date");
  });

  it("settings.ganttEvents that is not an array is treated as [] first", () => {
    const settings = makeSettings({
      ganttEvents: "not-an-array" as unknown as TaskWorkbenchSettings["ganttEvents"],
    });
    const created = addGanttEvent(settings, "初回", "2026-09-01");
    expect(settings.ganttEvents).toEqual([created]);
  });
});


// duplicateGanttEvent
describe("duplicateGanttEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies title/date/workload into a fresh event with independent maps", () => {
    const settings = makeSettings({
      ganttEvents: [
        {
          key: "source",
          title: "会議",
          date: "2026-09-01",
          workloadPlan: { "2026-09-01": 3 },
          workloadActual: { "2026-09-01": 1.5 },
        },
      ],
    });

    const source = settings.ganttEvents[0];
    const duplicate = duplicateGanttEvent(settings, "source");

    expect(duplicate).toMatchObject({
      title: "会議",
      date: "2026-09-01",
      workloadPlan: { "2026-09-01": 3 },
      workloadActual: { "2026-09-01": 1.5 },
    });
    expect(duplicate?.key).not.toBe(source.key);
    expect(settings.ganttEvents).toHaveLength(2);
    expect(duplicate).not.toBe(source);
    expect(duplicate?.workloadPlan).not.toBe(source.workloadPlan);
    expect(duplicate?.workloadActual).not.toBe(source.workloadActual);

    duplicate!.workloadPlan!["2026-09-01"] = 4;
    duplicate!.workloadActual!["2026-09-01"] = 2;
    expect(source.workloadPlan?.["2026-09-01"]).toBe(3);
    expect(source.workloadActual?.["2026-09-01"]).toBe(1.5);
  });

  it("returns undefined and leaves settings untouched when the key is missing", () => {
    const settings = makeSettings({
      ganttEvents: [{ key: "source", title: "会議", date: "2026-09-01" }],
    });
    const before = [...settings.ganttEvents];

    expect(duplicateGanttEvent(settings, "missing")).toBeUndefined();
    expect(settings.ganttEvents).toEqual(before);
  });
});



// updateGanttEvent


describe("updateGanttEvent", () => {
  it("partial-merges patch into the matching event by key", () => {
    const settings = makeSettings({
      ganttEvents: [
        { key: "event-1", title: "旧タイトル", date: "2026-09-01" },
        { key: "event-2", title: "他", date: "2026-09-02" },
      ],
    });
    updateGanttEvent(settings, "event-1", { title: "新タイトル" });

    expect(settings.ganttEvents).toEqual([
      { key: "event-1", title: "新タイトル", date: "2026-09-01" },
      { key: "event-2", title: "他", date: "2026-09-02" },
    ]);
  });

  it("silent no-op when key is not found", () => {
    const settings = makeSettings({
      ganttEvents: [{ key: "event-1", title: "旧", date: "2026-09-01" }],
    });
    expect(() =>
      updateGanttEvent(settings, "does-not-exist", { title: "x" })
    ).not.toThrow();
    expect(settings.ganttEvents).toEqual([
      { key: "event-1", title: "旧", date: "2026-09-01" },
    ]);
  });

  it("silent no-op when settings.ganttEvents is not an array", () => {
    const settings = makeSettings({
      ganttEvents: undefined as unknown as TaskWorkbenchSettings["ganttEvents"],
    });
    expect(() => updateGanttEvent(settings, "event-1", { title: "x" })).not.toThrow();
  });
});


// deleteGanttEvent


describe("deleteGanttEvent", () => {
  it("removes the matching event by key", () => {
    const settings = makeSettings({
      ganttEvents: [
        { key: "event-1", title: "A", date: "2026-09-01" },
        { key: "event-2", title: "B", date: "2026-09-02" },
      ],
    });
    deleteGanttEvent(settings, "event-1");
    expect(settings.ganttEvents).toEqual([
      { key: "event-2", title: "B", date: "2026-09-02" },
    ]);
  });

  it("silent no-op when key is not found", () => {
    const settings = makeSettings({
      ganttEvents: [{ key: "event-1", title: "A", date: "2026-09-01" }],
    });
    expect(() => deleteGanttEvent(settings, "does-not-exist")).not.toThrow();
    expect(settings.ganttEvents).toHaveLength(1);
  });

  it("silent no-op when settings.ganttEvents is not an array", () => {
    const settings = makeSettings({
      ganttEvents: undefined as unknown as TaskWorkbenchSettings["ganttEvents"],
    });
    expect(() => deleteGanttEvent(settings, "event-1")).not.toThrow();
  });
});


// weekly work schedule CRUD
describe("weekly work schedule CRUD", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a schedule with a collision-safe schedule key", () => {
    const settings = makeSettings({ weeklyWorkSchedules: [] });
    const created = addWeeklyWorkSchedule(settings, "習字", 3, 30);

    expect(created).toEqual({
      key: expect.stringMatching(/^schedule-\d+/),
      title: "習字",
      dayOfWeek: 3,
      minutesPerWeek: 30,
    });
    expect(settings.weeklyWorkSchedules).toEqual([created]);
  });

  it("rounds added minutes to the nearest non-negative 30-minute multiple", () => {
    const settings = makeSettings({ weeklyWorkSchedules: [] });
    const roundedUp = addWeeklyWorkSchedule(settings, "会議", 1, 44);
    const negative = addWeeklyWorkSchedule(settings, "休止", 2, -1);

    expect(roundedUp.minutesPerWeek).toBe(30);
    expect(negative.minutesPerWeek).toBe(0);
  });

  it("partially updates a schedule and normalizes minutes", () => {
    const settings = makeSettings({
      weeklyWorkSchedules: [
        { key: "schedule-1", title: "旧", dayOfWeek: 0, minutesPerWeek: 30 },
      ],
    });
    updateWeeklyWorkSchedule(settings, "schedule-1", {
      title: "新",
      dayOfWeek: 4,
      minutesPerWeek: 76,
    });

    expect(settings.weeklyWorkSchedules).toEqual([
      { key: "schedule-1", title: "新", dayOfWeek: 4, minutesPerWeek: 90 },
    ]);
  });

  it("update/delete are silent no-ops for missing keys", () => {
    const settings = makeSettings({
      weeklyWorkSchedules: [
        { key: "schedule-1", title: "残す", dayOfWeek: 0, minutesPerWeek: 30 },
      ],
    });

    expect(() =>
      updateWeeklyWorkSchedule(settings, "missing", { title: "無視" })
    ).not.toThrow();
    expect(() => deleteWeeklyWorkSchedule(settings, "missing")).not.toThrow();
    expect(settings.weeklyWorkSchedules).toHaveLength(1);
  });

  it("deletes a schedule by key", () => {
    const settings = makeSettings({
      weeklyWorkSchedules: [
        { key: "schedule-1", title: "削除", dayOfWeek: 0, minutesPerWeek: 30 },
        { key: "schedule-2", title: "残す", dayOfWeek: 1, minutesPerWeek: 60 },
      ],
    });
    deleteWeeklyWorkSchedule(settings, "schedule-1");

    expect(settings.weeklyWorkSchedules).toEqual([
      { key: "schedule-2", title: "残す", dayOfWeek: 1, minutesPerWeek: 60 },
    ]);
  });

  it("treats a malformed schedules field as an empty array", () => {
    const settings = makeSettings({
      weeklyWorkSchedules: "壊れた値" as unknown as TaskWorkbenchSettings["weeklyWorkSchedules"],
    });
    expect(() => deleteWeeklyWorkSchedule(settings, "missing")).not.toThrow();
    expect(settings.weeklyWorkSchedules).toEqual([]);
    addWeeklyWorkSchedule(settings, "復旧", 6, 30);
    expect(settings.weeklyWorkSchedules).toHaveLength(1);
  });
});






describe("enableParentInGantt", () => {
  it("patches ganttEnabled:true and ganttOrder:1000 when no parent is currently Gantt-enabled", async () => {
    const target = makeParent({ ganttEnabled: false });
    const updateTaskItem: Mock = vi.fn().mockResolvedValue(undefined);

    await enableParentInGantt(target, [target], updateTaskItem);

    expect(updateTaskItem).toHaveBeenCalledWith(target, {
      ganttEnabled: true,
      ganttOrder: 1000,
    });
  });

  it("patches ganttOrder as max(existing enabled parents' ganttOrder) + 1000", async () => {
    const target = makeParent({ ganttEnabled: false });
    const enabledA = makeParent({ ganttEnabled: true, ganttOrder: 2000 });
    const enabledB = makeParent({ ganttEnabled: true, ganttOrder: 5000 });
    const updateTaskItem: Mock = vi.fn().mockResolvedValue(undefined);

    await enableParentInGantt(target, [target, enabledA, enabledB], updateTaskItem);

    expect(updateTaskItem).toHaveBeenCalledWith(target, {
      ganttEnabled: true,
      ganttOrder: 6000,
    });
  });

  it("non-finite ganttOrder among existing enabled parents falls back to 999999", async () => {
    const target = makeParent({ ganttEnabled: false });
    const enabledNoOrder = makeParent({ ganttEnabled: true }); // no ganttOrder
    const updateTaskItem: Mock = vi.fn().mockResolvedValue(undefined);

    await enableParentInGantt(target, [target, enabledNoOrder], updateTaskItem);

    expect(updateTaskItem).toHaveBeenCalledWith(target, {
      ganttEnabled: true,
      ganttOrder: 1000999,
    });
  });

  it("ganttEnabled:false / non-parent rows do not affect the max computation", async () => {
    const target = makeParent({ ganttEnabled: false });
    const disabledParent = makeParent({ ganttEnabled: false, ganttOrder: 99999 });
    const subtask = makeParent({
      kind: "subtask",
      ganttEnabled: true,
      ganttOrder: 99999,
    });
    const updateTaskItem: Mock = vi.fn().mockResolvedValue(undefined);

    await enableParentInGantt(
      target,
      [target, disabledParent, subtask],
      updateTaskItem
    );

    expect(updateTaskItem).toHaveBeenCalledWith(target, {
      ganttEnabled: true,
      ganttOrder: 1000, // no ganttEnabled:true parent among the inputs
    });
  });
});
