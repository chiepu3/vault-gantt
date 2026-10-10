import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATUSES } from "../../src/core/constants";

describe("Core Constants - DEFAULT_SETTINGS", () => {
  it("DEFAULT_SETTINGS.taskFolder = 'tasks'", () => {
    expect(DEFAULT_SETTINGS.taskFolder).toBe("tasks");
  });

  it("DEFAULT_SETTINGS.filenameUsesDatePrefix = true", () => {
    expect(DEFAULT_SETTINGS.filenameUsesDatePrefix).toBe(true);
  });

  it("DEFAULT_SETTINGS.hideCompletedByDefault = true", () => {
    expect(DEFAULT_SETTINGS.hideCompletedByDefault).toBe(true);
  });

  it("DEFAULT_SETTINGS.currentStatusRows = 5", () => {
    expect(DEFAULT_SETTINGS.currentStatusRows).toBe(5);
  });

  it("DEFAULT_SETTINGS.autoPriorityEnabled = true", () => {
    expect(DEFAULT_SETTINGS.autoPriorityEnabled).toBe(true);
  });

  it("DEFAULT_SETTINGS.lastAutoPriorityUpdate = ''", () => {
    expect(DEFAULT_SETTINGS.lastAutoPriorityUpdate).toBe("");
  });

  it("DEFAULT_SETTINGS.ganttHolidays = []", () => {
    expect(DEFAULT_SETTINGS.ganttHolidays).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.ganttHolidays)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttManualHolidays = []", () => {
    expect(DEFAULT_SETTINGS.ganttManualHolidays).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.ganttManualHolidays)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttNationalHolidays = []", () => {
    expect(DEFAULT_SETTINGS.ganttNationalHolidays).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.ganttNationalHolidays)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttNationalHolidaysUpdatedAt = ''", () => {
    expect(DEFAULT_SETTINGS.ganttNationalHolidaysUpdatedAt).toBe("");
  });

  it("DEFAULT_SETTINGS.ganttSpecialHolidays = []", () => {
    expect(DEFAULT_SETTINGS.ganttSpecialHolidays).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.ganttSpecialHolidays)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttZoom = 28", () => {
    expect(DEFAULT_SETTINGS.ganttZoom).toBe(28);
  });

  it("DEFAULT_SETTINGS.ganttSyncEnabled = false", () => {
    expect(DEFAULT_SETTINGS.ganttSyncEnabled).toBe(false);
  });

  it("DEFAULT_SETTINGS.ganttSyncUrl = ''", () => {
    expect(DEFAULT_SETTINGS.ganttSyncUrl).toBe("");
  });

  it("DEFAULT_SETTINGS.ganttSyncIntervalMinutes = 5", () => {
    expect(DEFAULT_SETTINGS.ganttSyncIntervalMinutes).toBe(5);
  });

  it("DEFAULT_SETTINGS.ganttEvents = []", () => {
    expect(DEFAULT_SETTINGS.ganttEvents).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.ganttEvents)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttFeatureEventsEnabled = true", () => {
    expect(DEFAULT_SETTINGS.ganttFeatureEventsEnabled).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttFeatureWorkloadEnabled = true", () => {
    expect(DEFAULT_SETTINGS.ganttFeatureWorkloadEnabled).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttWorkloadMaxHours = 7", () => {
    expect(DEFAULT_SETTINGS.ganttWorkloadMaxHours).toBe(7);
  });

  it("DEFAULT_SETTINGS.ganttWorkloadDailyCapacityHours = 7", () => {
    expect(DEFAULT_SETTINGS.ganttWorkloadDailyCapacityHours).toBe(7);
  });

  it("DEFAULT_SETTINGS.weeklyWorkSchedules = []", () => {
    expect(DEFAULT_SETTINGS.weeklyWorkSchedules).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.weeklyWorkSchedules)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttFeatureTagsEnabled = true", () => {
    expect(DEFAULT_SETTINGS.ganttFeatureTagsEnabled).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttTags = []", () => {
    expect(DEFAULT_SETTINGS.ganttTags).toEqual([]);
    expect(Array.isArray(DEFAULT_SETTINGS.ganttTags)).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttShowTagsOnBars = true", () => {
    expect(DEFAULT_SETTINGS.ganttShowTagsOnBars).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttShowTagsOnParents = true", () => {
    expect(DEFAULT_SETTINGS.ganttShowTagsOnParents).toBe(true);
  });

  it("DEFAULT_SETTINGS.ganttShowParentTagsOnChildBars = false", () => {
    expect(DEFAULT_SETTINGS.ganttShowParentTagsOnChildBars).toBe(false);
  });

  it("DEFAULT_SETTINGS.ganttFeatureDailyTodoEnabled = true", () => {
    expect(DEFAULT_SETTINGS.ganttFeatureDailyTodoEnabled).toBe(true);
  });

  it("keeps main as the default new ToDo target", () => {
    expect(DEFAULT_SETTINGS.dailyTodoTargetSourceKey).toBe("main");
  });


  it("DEFAULT_SETTINGS.dailyTodoSources keeps the default source formats", () => {
    expect(DEFAULT_SETTINGS.dailyTodoSources).toEqual([
      {
        key: "main",
        label: "デイリー",
        format: "[デイリー]/YYYY/MM/YYMMDD_[デイリー]",
        creatableFromGantt: true,
      },
      {
        key: "meeting",
        label: "デイリーミーティング",
        format: "[デイリーミーティング]/YYYY/MM/MMDD_[デイリーミーティング]",
        creatableFromGantt: false,
      },
    ]);
  });


  it("DEFAULT_SETTINGS.ganttFeatureSyncEnabled = true", () => {
    expect(DEFAULT_SETTINGS.ganttFeatureSyncEnabled).toBe(true);
  });

  it("DEFAULT_SETTINGS.incrementalGanttRender = true", () => {
    expect(DEFAULT_SETTINGS.incrementalGanttRender).toBe(true);
  });

  it("DEFAULT_SETTINGS.agentToolsEnabled = false", () => {
    expect(DEFAULT_SETTINGS.agentToolsEnabled).toBe(false);
  });

  it("DEFAULT_SETTINGS has exactly 32 keys", () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    expect(keys.length).toBe(32);
  });

  it("DEFAULT_SETTINGS has all 32 required keys", () => {
    const required = [
      // Task storage settings.
      "taskFolder",
      "filenameUsesDatePrefix",
      "hideCompletedByDefault",
      "currentStatusRows",
      // Automatic-priority settings.
      "autoPriorityEnabled",
      "lastAutoPriorityUpdate",
      // Holiday settings.
      "ganttHolidays",
      "ganttManualHolidays",
      "ganttNationalHolidays",
      "ganttNationalHolidaysUpdatedAt",
      "ganttSpecialHolidays",
      // Gantt display and synchronization settings.
      "ganttZoom",
      "ganttSyncEnabled",
      "ganttSyncUrl",
      "ganttSyncIntervalMinutes",
      "ganttEvents",
      "ganttFeatureEventsEnabled",
      // Workload settings.
      "ganttFeatureWorkloadEnabled",
      "ganttWorkloadMaxHours",
      "ganttWorkloadDailyCapacityHours",
      // Weekly Work Schedules (1):
      "weeklyWorkSchedules",
      // Tag settings.
      "ganttFeatureTagsEnabled",
      "ganttTags",
      "ganttShowTagsOnBars",
      "ganttShowTagsOnParents",
      "ganttShowParentTagsOnChildBars",
      // Daily-note settings.
      "ganttFeatureDailyTodoEnabled",
      "dailyTodoSources",
      "dailyTodoTargetSourceKey",
      // Rendering and integration settings.
      "ganttFeatureSyncEnabled",
      "incrementalGanttRender",
      "agentToolsEnabled",
    ];

    // Verify we have exactly 32 required keys
    expect(required.length).toBe(32);

    for (const key of required) {
      expect(key in DEFAULT_SETTINGS).toBe(true);
    }
  });
});

describe("Core Constants - DEFAULT_STATUSES", () => {
  it("DEFAULT_STATUSES has 'active' label", () => {
    expect(DEFAULT_STATUSES.active).toBe("未着手");
  });

  it("DEFAULT_STATUSES has 'in_progress' label", () => {
    expect(DEFAULT_STATUSES.in_progress).toBe("進行中");
  });

  it("DEFAULT_STATUSES has 'waiting' label", () => {
    expect(DEFAULT_STATUSES.waiting).toBe("待ち");
  });

  it("DEFAULT_STATUSES has 'hold' label", () => {
    expect(DEFAULT_STATUSES.hold).toBe("保留");
  });

  it("DEFAULT_STATUSES has 'done' label", () => {
    expect(DEFAULT_STATUSES.done).toBe("完了");
  });

  it("DEFAULT_STATUSES has exactly 5 entries", () => {
    expect(Object.keys(DEFAULT_STATUSES).length).toBe(5);
  });
});
