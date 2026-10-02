import { requestUrl } from "obsidian";

import type { Logger } from "../core/logger";

import {
  GanttEvent,
  GanttMarker,
  StatusLabel,
  TaskRow,
  TaskWorkbenchSettings,
  WorkloadMap,
} from "../core/types";
import { isValidCalendarDate } from "../core/utils";
import { getGanttEvents, getGanttParentRows } from "./gantt-layout";
import { getEffectiveHolidays } from "./holiday-service";




















// 1. Endpoint normalization


/**
 *
 * Trims `settings.ganttSyncUrl`; empty -> "". Otherwise strips trailing
 * slashes and appends `/api/snapshot` unless the (slash-stripped) value
 * already ends with it.
 */
export function getGanttSyncEndpoint(settings: TaskWorkbenchSettings): string {
  const trimmed = settings.ganttSyncUrl.trim();
  if (trimmed === "") {
    return "";
  }
  const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
  if (withoutTrailingSlashes.endsWith("/api/snapshot")) {
    return withoutTrailingSlashes;
  }
  return `${withoutTrailingSlashes}/api/snapshot`;
}












export function normalizeWorkloadMapForSnapshot(value?: unknown): WorkloadMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const result: WorkloadMap = {};
  for (const [date, hours] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidCalendarDate(date)) {
      continue; // skip, don't throw
    }
    const raw = typeof hours === "number" ? hours : parseFloat(String(hours));
    if (!isFinite(raw)) {
      continue;
    }
    const rounded = Math.max(0, Math.round(raw * 2) / 2);
    if (rounded > 0) {
      result[date] = rounded;
    }
  }
  return result;
}

/**
 * not a reuse of `ensureArray` (`src/core/utils.ts`), whose
 * null/undefined-element handling (stringifying them to the literal text
 * "null"/"undefined") is wrong for this use case. Array -> each element
 * `String(tag||"").trim`, Boolean-filtered; non-array -> [].
 */
export function snapshotTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((tag) => String(tag || "").trim()).filter((tag) => tag !== "");
}


// 3. Snapshot data structures.


export interface ReadonlyGanttSnapshotTagDefinition {
  key: string;
  name: string;
  color: string;
  order: number;
}

export interface ReadonlyGanttSnapshotSettings {
  ganttFeatureEventsEnabled: boolean;
  ganttFeatureWorkloadEnabled: boolean;
  ganttFeatureTagsEnabled: boolean;
  ganttFeatureDailyTodoEnabled: boolean;
  ganttFeatureSyncEnabled: boolean;
  ganttWorkloadMaxHours: number;
  ganttWorkloadDailyCapacityHours: number;
  ganttShowTagsOnBars: boolean;
  ganttShowTagsOnParents: boolean;
  ganttShowParentTagsOnChildBars: boolean;
  ganttTags: ReadonlyGanttSnapshotTagDefinition[];
  ganttEvents: GanttEvent[];
}

export interface ReadonlyGanttSnapshotSubtask {
  kind: "subtask";
  id: string;
  key: string;
  parentPath: string;
  sourceOrder: number;
  title: string;
  displayName: string;
  statusLabel: StatusLabel;
  completed: boolean;
  dueDate: string;
  priority: number;
  plannedStartDate: string;
  plannedEndDate: string;
  currentStatus: string;
  tags: string[];
  workloadPlan: WorkloadMap;
  workloadActual: WorkloadMap;
  ganttMarkers: GanttMarker[];
}

export interface ReadonlyGanttSnapshotParent {
  kind: "parent";
  id: string;
  path: string;
  title: string;
  displayName: string;
  ganttEnabled: true;
  ganttOrder: number; // effectiveOrder — see buildSnapshotParents
  sourceOrder: number;
  statusLabel: StatusLabel;
  completed: boolean;
  dueDate: string;
  currentStatus: string;
  tags: string[];
  subtasks: ReadonlyGanttSnapshotSubtask[];
}

export interface ReadonlyGanttSnapshot {
  schemaVersion: 2;
  source: "obsidian-task-workbench";
  pluginVersion: string;
  generatedAt: string;
  dayWidth: number;
  holidays: string[];
  tagDefinitions: ReadonlyGanttSnapshotTagDefinition[];
  events: GanttEvent[];
  settings: ReadonlyGanttSnapshotSettings;
  parents: ReadonlyGanttSnapshotParent[];
}





/**
 * `ganttOrder` if it's a finite number (coerced from
 * whatever raw value is present — string/Infinity/NaN all fall through to
 * the fallback, matching the boundary table: "abc"->NaN->fallback,
 * negative->valid, Infinity->fallback, 0->valid), else
 * `(sourceOrder+1)*1000`.
 */
function effectiveOrderForSnapshot(rawGanttOrder: unknown, sourceOrder: number): number {
  const n = typeof rawGanttOrder === "number" ? rawGanttOrder : Number(rawGanttOrder);
  return isFinite(n) ? n : (sourceOrder + 1) * 1000;
}







function buildTagDefinitions(
  settings: TaskWorkbenchSettings
): ReadonlyGanttSnapshotTagDefinition[] {
  return settings.ganttTags
    .map((definition, index) => {
      const name = String(definition?.name ?? "").trim();
      const rawOrder = Number(definition?.order);
      const order = Number.isFinite(rawOrder) ? rawOrder : index * 1000;
      return { ...definition, name, order };
    })
    .filter((definition) => definition.name !== "");
}





function buildSnapshotEvents(settings: TaskWorkbenchSettings): GanttEvent[] {
  return getGanttEvents(settings).filter((event) => Boolean(event && event.date));
}







function buildSnapshotSettings(
  settings: TaskWorkbenchSettings
): ReadonlyGanttSnapshotSettings {
  return {
    ganttFeatureEventsEnabled: settings.ganttFeatureEventsEnabled,
    ganttFeatureWorkloadEnabled: settings.ganttFeatureWorkloadEnabled,
    ganttFeatureTagsEnabled: settings.ganttFeatureTagsEnabled,
    ganttFeatureDailyTodoEnabled: settings.ganttFeatureDailyTodoEnabled,
    ganttFeatureSyncEnabled: settings.ganttFeatureSyncEnabled,
    ganttWorkloadMaxHours: settings.ganttWorkloadMaxHours,
    ganttWorkloadDailyCapacityHours: settings.ganttWorkloadDailyCapacityHours,
    ganttShowTagsOnBars: settings.ganttShowTagsOnBars,
    ganttShowTagsOnParents: settings.ganttShowTagsOnParents,
    ganttShowParentTagsOnChildBars: settings.ganttShowParentTagsOnChildBars,
    ganttTags: [...settings.ganttTags],
    ganttEvents: [...settings.ganttEvents],
  };
}

/**
 * Builds one subtask entry. `sourceOrder` is the subtask's
 * position in its parent's `subtasks` Map iteration order (JS Maps preserve
 * insertion order, i.e. the order subtasks were added/appear in the file).
 * Empty plan dates stay `""` (not omitted/undefined); workload maps go
 * through a non-throwing normalizer; `tags` and `ganttMarkers` always
 * come back as arrays.
 */
function buildSnapshotSubtasks(parent: TaskRow): ReadonlyGanttSnapshotSubtask[] {
  if (!parent.subtasks) {
    return [];
  }
  return Array.from(parent.subtasks.values()).map((subtask, index) => ({
    kind: "subtask",
    id: subtask.id || subtask.key || "", // ID falls back to key.
    key: subtask.key || "",
    parentPath: subtask.file?.parentPath || parent.file?.path || "",
    sourceOrder: index,
    title: subtask.title,
    displayName: subtask.displayName,
    statusLabel: subtask.statusLabel,
    completed: subtask.completed,
    dueDate: subtask.dueDate ?? "",
    priority: subtask.priority,
    plannedStartDate: subtask.plannedStartDate ?? "",
    plannedEndDate: subtask.plannedEndDate ?? "",
    currentStatus: subtask.currentStatus,
    tags: snapshotTags(subtask.tags),
    workloadPlan: normalizeWorkloadMapForSnapshot(subtask.workloadPlan),
    workloadActual: normalizeWorkloadMapForSnapshot(subtask.workloadActual),
    ganttMarkers: Array.isArray(subtask.ganttMarkers) ? subtask.ganttMarkers : [],
  }));
}

/**
 *
 * Parent selection reuses `getGanttParentRows`'s filter (`kind === "parent"`
 * and `ganttEnabled === true`) but not its returned order. That order already
 * applies a 999999 fallback for `ganttOrder`, which differs from this
 * snapshot's `(sourceOrder + 1) * 1000` fallback. `sourceOrder` is instead
 * each parent's position in
 * the caller-supplied `tasks` array itself (loadTasks's natural,
 * pre-Gantt-sort order), then the final list is (re-)sorted here by
 * effectiveOrder asc, sourceOrder asc.
 */
function buildSnapshotParents(tasks: TaskRow[]): ReadonlyGanttSnapshotParent[] {
  const sourceOrderById = new Map<string, number>();
  tasks.forEach((task, index) => {
    sourceOrderById.set(task.id, index);
  });

  const parents: ReadonlyGanttSnapshotParent[] = getGanttParentRows(tasks).map((parent) => {
    const sourceOrder = sourceOrderById.get(parent.id) ?? 0;
    const ganttOrder = effectiveOrderForSnapshot(parent.ganttOrder, sourceOrder);
    return {
      kind: "parent",
      id: parent.id || parent.file?.path || "", // ID falls back to path.
      path: parent.file?.path || "",
      title: parent.title,
      displayName: parent.displayName,
      ganttEnabled: true, // Always true in the snapshot.
      ganttOrder,
      sourceOrder,
      statusLabel: parent.statusLabel,
      completed: parent.completed,
      dueDate: parent.dueDate ?? "",
      currentStatus: parent.currentStatus,
      tags: snapshotTags(parent.tags),
      subtasks: buildSnapshotSubtasks(parent),
    };
  });

  return parents.sort((a, b) => {
    const orderDiff = a.ganttOrder - b.ganttOrder;
    return orderDiff !== 0 ? orderDiff : a.sourceOrder - b.sourceOrder;
  });
}

/**
 * Builds the full read-only Gantt snapshot from an already-loaded task list.
 * `hash` is intentionally not part of this function's output; the caller
 * (`syncReadonlyGanttSnapshot` below) computes it from the serialized result.
 */
export function buildReadonlyGanttSnapshotFromTasks(
  tasks: TaskRow[],
  settings: TaskWorkbenchSettings,
  pluginVersion: string
): ReadonlyGanttSnapshot {
  return {
    schemaVersion: 2,
    source: "obsidian-task-workbench",
    pluginVersion,
    generatedAt: new Date().toISOString(),
    dayWidth: settings.ganttZoom,
    holidays: getEffectiveHolidays(settings),
    tagDefinitions: buildTagDefinitions(settings),
    events: buildSnapshotEvents(settings),
    settings: buildSnapshotSettings(settings),
    parents: buildSnapshotParents(tasks),
  };
}


// 5. FNV-1a hashing


const FNV_OFFSET_BASIS = 2166136261; // 0x811c9dc5
const FNV_PRIME = 16777619; // 0x01000193

/**
 * FNV-1a 32-bit hash of `String(value ?? "")`'s char
 * codes, returned as an 8-digit lowercase hex string. `Math.imul` performs
 * the 32-bit modular multiplication exactly (no float-precision loss from
 * `hash * FNV_PRIME` on intermediate values that exceed 2^53).
 */
export function hashString(value: unknown): string {
  const text = String(value ?? "");
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}





/**
 * Mutable sync bookkeeping. `main.ts`'s plugin instance satisfies this
 * structurally through its `lastGanttSyncHash` and `lastGanttSyncAt` fields.
 * The state is mutated in place, matching the pattern used by
 * `addGanttEvent` in `gantt-task-service.ts`.
 */
export interface GanttSyncState {
  lastGanttSyncHash: string;
  lastGanttSyncAt: string;
}

















export async function syncReadonlyGanttSnapshot(
  tasks: TaskRow[],
  settings: TaskWorkbenchSettings,
  pluginVersion: string,
  state: GanttSyncState,

  force: boolean,
  logger?: Logger

): Promise<boolean> {
  const endpoint = getGanttSyncEndpoint(settings);
  if (endpoint === "") {
    return false; // caller decides Notice vs silent skip
  }

  const snapshot = buildReadonlyGanttSnapshotFromTasks(tasks, settings, pluginVersion);
  const hashInput = JSON.stringify({ ...snapshot, generatedAt: "" });
  const hash = hashString(hashInput);

  if (!force && hash === state.lastGanttSyncHash) {
    return false; // unchanged content, skip
  }


  const startedAt = Date.now();

  const response = await requestUrl({
    url: endpoint,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...snapshot, hash }),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    // Obsidian's requestUrl response has no `statusText`
    // field (unlike a browser fetch Response) — status code alone.
    throw new Error(`Gantt sync failed: ${response.status}`);
  }

  state.lastGanttSyncHash = hash;
  state.lastGanttSyncAt = new Date().toISOString();

  const syncData = {
    durationMs: Date.now() - startedAt,
    taskCount: tasks.length,
  };
  if (force) {
    logger?.info("syncReadonlyGanttSnapshot", "sync completed", syncData);
  } else {
    logger?.debug("syncReadonlyGanttSnapshot", "sync completed", syncData);
  }

  return true;
}
