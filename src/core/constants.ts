import { StatusLabel, TaskWorkbenchSettings } from "./types";

/** fixed eight-color palette for interactively-created tags. */
export const DEFAULT_GANTT_TAG_COLORS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4b5563",
] as const;








export const DEFAULT_SETTINGS: TaskWorkbenchSettings = {
  // Task Storage
  taskFolder: "tasks",
  filenameUsesDatePrefix: true,
  hideCompletedByDefault: true,
  currentStatusRows: 5,

  // Auto Priority
  autoPriorityEnabled: true,
  lastAutoPriorityUpdate: "",

  // Holidays
  ganttHolidays: [],
  ganttManualHolidays: [],
  ganttNationalHolidays: [],
  ganttNationalHolidaysUpdatedAt: "",
  ganttSpecialHolidays: [],

  // Gantt Display/Sync
  ganttZoom: 28,
  ganttSyncEnabled: false,
  ganttSyncUrl: "",
  ganttSyncIntervalMinutes: 5,
  ganttEvents: [],
  ganttFeatureEventsEnabled: true,

  // Workload
  ganttFeatureWorkloadEnabled: true,
  ganttWorkloadMaxHours: 7,
  ganttWorkloadDailyCapacityHours: 7,


  // Weekly Work Schedules
  weeklyWorkSchedules: [],


  // Tags
  ganttFeatureTagsEnabled: true,
  ganttTags: [],
  ganttShowTagsOnBars: true,
  ganttShowTagsOnParents: true,
  ganttShowParentTagsOnChildBars: false,

  // Daily Notes
  ganttFeatureDailyTodoEnabled: true,

  // preserve the shipped default daily-note paths.
  dailyTodoSources: [
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
  ],


  // Rendering/Integration
  ganttFeatureSyncEnabled: true,
  incrementalGanttRender: true,
  agentToolsEnabled: false,
};



export const DEFAULT_STATUSES: Record<StatusLabel, string> = {
  active: "未着手",
  in_progress: "進行中",
  waiting: "待ち",
  hold: "保留",
  done: "完了",
};
