import type { McpSettings } from "../mcp/server";
import { TFile } from "obsidian";


export type StatusLabel = "active" | "in_progress" | "waiting" | "hold" | "done";

export interface GanttTagDefinition {
  key: string;
  name: string;
  color: string;
  order: number;
}


// Each marker has a date, title, key, and optional tags array.

export interface GanttMarker {
  key: string;
  title: string;
  date: string; // YYYY-MM-DD
  tags?: string[];
}









export interface GanttEvent {
  key: string;
  title: string;
  date: string; // YYYY-MM-DD
  workloadPlan?: WorkloadMap;
  workloadActual?: WorkloadMap;
}



/** A weekly recurring work-time plan, independent of a date. */
export interface WeeklyWorkSchedule {
  key: string;
  title: string;
  dayOfWeek: number; // 0=Sunday..6=Saturday
  minutesPerWeek: number; // multiple of 30
}





// TaskRow.workloadPlan and TaskRow.workloadActual use this map type.
export interface WorkloadMap {
  [date: string]: number; // hours
}





export interface TaskRow {
  // Hierarchy and ID
  kind: "parent" | "subtask";
  id: string; // note format v2: frontmatter `id` (t-xxxxxx / s-xxxxxx), never changes
  key?: string; // subtasks only: same as id (Map key inside parent.subtasks)
  parentId?: string; // subtasks only: id of the parent task
  file: TFile & {
    path: string; // the task's own note
    parentPath?: string; // subtasks: the parent note's path
    heading?: string; // v1 migration parser only: the ### heading of the subtask section
  };

  // Display and naming
  title: string; // canonical name
  displayName: string; // user-editable label

  // Status and completion
  statusLabel: StatusLabel; // default is "active"
  completed: boolean;

  // Time tracking
  createdAt: string; // YYYY-MM-DD
  updatedAt: string; // YYYY-MM-DD
  dueDate?: string; // YYYY-MM-DD or empty/undefined

  // Priority
  priority: number; // constrained to [0,5]
  priorityMode: "auto" | "manual";

  // Content sections
  currentStatus: string; // free-form text
  notes: string; // free-form text

  // Tags
  tags: string[];

  // Gantt fields - parent only
  ganttEnabled: boolean; // default false
  ganttOrder?: number; // in-memory rank from settings.ganttParentOrder ((index+1)*1000); see core/parent-order.ts. Notes' own `ganttOrder:` line is only read for migration.

  // Subtasks (parent only)
  subtasks?: Map<string, TaskRow>;

  // Gantt fields - subtask only
  plannedStartDate?: string; // YYYY-MM-DD
  plannedEndDate?: string; // YYYY-MM-DD
  // plain TaskRow fields, persisted independently of
  // any gantt*Enabled feature flag — disabling/re-enabling a display flag
  // never reads or writes these, so data trivially survives the round trip.
  workloadPlan?: WorkloadMap;
  workloadActual?: WorkloadMap;
  ganttMarkers?: GanttMarker[];
  /** Subtask only: raw `dependsOn` links ("[[note]]"). Kept and written back as is; no feature uses it yet. */
  dependsOn?: string[];
}


export interface TaskPatch {
  displayName?: string;
  title?: string;
  statusLabel?: string;
  createdAt?: string;
  updatedAt?: string;
  dueDate?: string;
  priority?: number;
  priorityMode?: string;
  tags?: string[];
  completed?: boolean;
  ganttEnabled?: boolean;
  ganttOrder?: number;
  currentStatus?: string;
  notes?: string;
  plannedStartDate?: string;
  plannedEndDate?: string;
  workloadPlan?: WorkloadMap;
  workloadActual?: WorkloadMap;
  ganttMarkers?: GanttMarker[];
}


/**
 *
 * A configurable daily-note source. `format` covers the full vault-relative
 * path (including nested folders) without the `.md` extension and is expanded
 * by Obsidian's bundled Moment formatter.
 */
export interface DailyTodoSourceConfig {
  key: string;
  label: string;
  format: string;
  creatableFromGantt: boolean;
  templatePath?: string;
  todoHeading?: string; // Heading text (optionally with Markdown # prefix).
}



export interface TaskWorkbenchSettings {
  /** MCP credentials are references only; token values stay in secret storage or memory. */
  mcp?: McpSettings;
  /** Gantt parent order as task ids (older versions stored note paths; migrated on load). undefined = not created yet. */
  ganttParentOrder?: string[];
  /** Subtask order per parent: parent id -> subtask ids. Subtasks missing here are appended (created, then title). */
  subtaskOrder?: Record<string, string[]>;
  // Task Storage
  taskFolder: string;
  filenameUsesDatePrefix: boolean;
  hideCompletedByDefault: boolean;
  currentStatusRows: number;

  // Auto Priority
  autoPriorityEnabled: boolean;
  lastAutoPriorityUpdate: string;

  // Holidays
  ganttHolidays: string[];
  ganttManualHolidays: string[];
  ganttNationalHolidays: string[];
  ganttNationalHolidaysUpdatedAt: string;
  ganttSpecialHolidays: string[];

  // Gantt Display/Sync
  ganttZoom: number;
  /** Where the AI chat opens, and whether it opens by itself at start-up when it is not already open. */
  aiChatPlacement: "right" | "left" | "tab";
  aiChatAutoOpen: boolean;
  /** Look for a newer release once at start-up and offer to install it. */
  checkUpdateOnStartup: boolean;
  ganttSyncEnabled: boolean;
  ganttSyncUrl: string;
  ganttSyncIntervalMinutes: number;
  ganttEvents: GanttEvent[];
  ganttFeatureEventsEnabled: boolean;

  // Workload
  ganttFeatureWorkloadEnabled: boolean;
  ganttWorkloadMaxHours: number;
  ganttWorkloadDailyCapacityHours: number;


  // Weekly Work Schedules
  weeklyWorkSchedules: WeeklyWorkSchedule[];


  // Tags



  ganttFeatureTagsEnabled: boolean;
  ganttTags: GanttTagDefinition[];
  ganttShowTagsOnBars: boolean;
  ganttShowTagsOnParents: boolean;
  ganttShowParentTagsOnChildBars: boolean;

  // Daily Notes
  ganttFeatureDailyTodoEnabled: boolean;

  dailyTodoSources: DailyTodoSourceConfig[];
  dailyTodoTargetSourceKey: string;


  // Rendering/Integration
  ganttFeatureSyncEnabled: boolean;
  incrementalGanttRender: boolean;
  /** Pack parent-row lanes using only subtasks near the visible dates. */
  compactRowsToViewport: boolean;
  agentToolsEnabled: boolean;
}


export interface TaskUpdateCommand {
  row: TaskRow;
  patch: TaskPatch;
  expectedRevision?: string;
}


export interface TaskUpdateResult {
  taskId: string;
  parentPath: string;
  revisionBefore: string;
  revisionAfter: string;
  changedFields: string[];
}



// One ToDo item with its source location, or an unsaved new item.
export interface DailyTodoItem {
  sourceKey: string;
  sourceLabel: string;
  path: string;
  line: number;
  text: string;
  completed: boolean;
  isNew: boolean;
}


export interface DailyTodoSummary {
  date: string;
  items: DailyTodoItem[];
  completedCount: number;
  totalCount: number;
}

// GanttSnapshot* family
export interface GanttSnapshot {
  date: string;
  tasks: GanttSnapshotTask[];
  markers: GanttSnapshotMarker[];
}

export interface GanttSnapshotTask {
  taskId: string;
  title: string;
  startDate: string;
  endDate: string;
  progress: number;
  priority: number;
  statusLabel: StatusLabel;
  workloadPlan: WorkloadMap;
  workloadActual: WorkloadMap;
}

export interface GanttSnapshotMarker {
  key: string;
  title: string;
  date: string;
  tags?: string[];
}

export interface GanttSnapshotExport {
  exportDate: string;
  snapshots: GanttSnapshot[];
}
