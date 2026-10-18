import {
  TaskRow,
  TaskPatch,
  StatusLabel,
  WorkloadMap,
  GanttMarker,
  TaskWorkbenchSettings,
} from "./types";
import {
  isValidCalendarDate,
  normalizePriority,
  normalizeStatusValue,
  ensureArray,
  todayStr,
  calculateAutoPriority,
  changedFields,
} from "./utils";


export function normalizeWorkloadMap(value?: unknown): WorkloadMap {
  // must be an object
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workload must be an object keyed by YYYY-MM-DD");
  }

  const result: WorkloadMap = {};
  const map = value as Record<string, unknown>;

  for (const [date, hours] of Object.entries(map)) {

    if (!isValidCalendarDate(date)) {
      throw new Error(`invalid workload date: ${date}`);
    }

    // silently skip non-finite hours
    let h = typeof hours === "number" ? hours : parseFloat(String(hours));
    if (!isFinite(h)) {
      continue;
    }

    // hours > 24 throw error
    if (h > 24) {
      throw new Error(`invalid workload hours: ${date}`);
    }

    // round to 0.5 increments
    const rounded = Math.round(h * 2) / 2;

    // drop values <= 0
    if (rounded > 0) {
      result[date] = rounded;
    }
  }

  return result;
}


export function normalizeMarkers(value?: unknown): GanttMarker[] {
  // must be array
  if (!Array.isArray(value)) {
    throw new Error("ganttMarkers must be an array");
  }

  // check for null elements (invalid marker)
  if (value.some((item) => item === null)) {
    throw new Error("invalid marker");
  }

  const result: GanttMarker[] = [];
  const seenKeys = new Set<string>();

  for (const marker of value) {
    // key empty or duplicate (checked FIRST)
    const key = String(marker?.key ?? "");
    if (!key || key.trim() === "") {
      throw new Error(`invalid or duplicate marker key: ${key || ""}`);
    }

    if (seenKeys.has(key)) {
      throw new Error(`invalid or duplicate marker key: ${key}`);
    }

    seenKeys.add(key);

    // title empty (checked SECOND)
    const title = String(marker?.title ?? "");
    if (!title || title.trim() === "") {
      throw new Error(`marker title is required: ${key}`);
    }

    // invalid date (checked THIRD)
    const date = String(marker?.date ?? "");
    if (!date || date.trim() === "" || !isValidCalendarDate(date)) {
      throw new Error(`invalid marker date: ${date || ""}`);
    }

    // tags via ensureArray, never throws
    result.push({
      key,
      title,
      date,
      tags: ensureArray(marker?.tags),
    });
  }

  return result;
}



export function normalizeTaskPatch(
  patch: unknown,
  kind: "parent" | "subtask"
): TaskPatch {
  // patch must be an object
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("patch must be an object");
  }

  const p = patch as Record<string, unknown>;
  const result: TaskPatch = {};

  // Define writable fields per kind
  // writability by kind
  const parentWritableFields = new Set([
    "displayName",
    "title",
    "statusLabel",
    "createdAt",
    "updatedAt",
    "dueDate",
    "priority",
    "priorityMode",
    "tags",
    "completed",
    "ganttEnabled",
    "ganttOrder",
    "currentStatus",
    "notes",
  ]);

  const subtaskWritableFields = new Set([
    "displayName",
    "title",
    "statusLabel",
    "createdAt",
    "updatedAt",
    "dueDate",
    "priority",
    "priorityMode",
    "tags",
    "completed",
    "currentStatus",
    "notes",
    "plannedStartDate",
    "plannedEndDate",
    "workloadPlan",
    "workloadActual",
    "ganttMarkers",
  ]);

  const writableFields =
    kind === "parent" ? parentWritableFields : subtaskWritableFields;

  // Process all fields in patch
  for (const [key, value] of Object.entries(p)) {
    // field is not writable for {kind}
    if (!writableFields.has(key)) {
      throw new Error(`field is not writable for ${kind}: ${key}`);
    }

    if (value === undefined) {
      // Skip undefined values
      continue;
    }

    // Handle each field type
    if (key === "displayName" || key === "title") {
      // must not be empty after trimming
      const trimmed = String(value).trim();
      if (trimmed === "") {
        throw new Error(`${key} must not be empty`);
      }
      result[key as "displayName" | "title"] = trimmed;
    } else if (key === "currentStatus" || key === "notes") {
      // stringify, empty is allowed
      result[key as "currentStatus" | "notes"] = String(value);
    } else if (key === "dueDate") {
      // non-empty must be valid calendar date format AND validity
      // Empty string "" is preserved to allow clearing the date (not converted to undefined)
      const strValue = String(value);
      if (strValue !== "") {
        if (!isValidCalendarDate(strValue)) {
          throw new Error(`invalid date for ${key}: ${strValue}`);
        }
      }
      result.dueDate = strValue;
    } else if (key === "createdAt") {
      const strValue = String(value);
      if (strValue !== "") {
        if (!isValidCalendarDate(strValue)) {
          throw new Error(`invalid date for ${key}: ${strValue}`);
        }
      }
      result.createdAt = strValue;
    } else if (key === "updatedAt") {
      const strValue = String(value);
      if (strValue !== "") {
        if (!isValidCalendarDate(strValue)) {
          throw new Error(`invalid date for ${key}: ${strValue}`);
        }
      }
      result.updatedAt = strValue;
    } else if (key === "plannedStartDate") {
      const strValue = String(value);
      if (strValue !== "") {
        if (!isValidCalendarDate(strValue)) {
          throw new Error(`invalid date for ${key}: ${strValue}`);
        }
      }
      result.plannedStartDate = strValue;
    } else if (key === "plannedEndDate") {
      const strValue = String(value);
      if (strValue !== "") {
        if (!isValidCalendarDate(strValue)) {
          throw new Error(`invalid date for ${key}: ${strValue}`);
        }
      }
      result.plannedEndDate = strValue;
    } else if (key === "statusLabel") {
      // normalize via normalizeStatusValue, then must be one of 5 canonical values
      const normalized = normalizeStatusValue(value);
      const validStatuses: StatusLabel[] = [
        "active",
        "in_progress",
        "waiting",
        "hold",
        "done",
      ];
      if (!validStatuses.includes(normalized as StatusLabel)) {
        throw new Error(`invalid status: ${String(value)}`);
      }
      result.statusLabel = normalized as StatusLabel;
    } else if (key === "completed" || key === "ganttEnabled") {
      // coerce via !!
      result[key as "completed" | "ganttEnabled"] = !!value;
    } else if (key === "priority") {
      // normalizePriority, never throws
      result.priority = normalizePriority(
        value === null ? undefined : (value as number | string | undefined)
      );
    } else if (key === "priorityMode") {
      // strictly "manual" -> "manual", otherwise -> "auto", never throws
      result.priorityMode =
        String(value).trim() === "manual" ? "manual" : "auto";
    } else if (key === "ganttOrder") {
      // The value must be a finite number.
      const num = typeof value === "number" ? value : parseFloat(String(value));
      if (!isFinite(num)) {
        throw new Error("ganttOrder must be a finite number");
      }
      result.ganttOrder = num;
    } else if (key === "tags") {
      // Pass the value through as-is; this branch never throws.
      // Do NOT call ensureArray here: TaskPatch.tags is already typed string[]
      // and is expected to arrive pre-normalized by the calling UI layer (e.g.
      // Workbench's parseTagsInput intentionally preserves empty elements:
      // "foo,, bar" -> ["foo", "", "bar"]). ensureArray's array-branch
      // is designed for a different purpose (sanitizing raw frontmatter on load in
      // note-format.ts) and strips empty-string items; re-running it here on an

      // Defensive Array.isArray check only, matching this function's existing
      // defensive style for loosely-typed `unknown` patch input.
      result.tags = Array.isArray(value) ? (value as string[]) : [];
    } else if (key === "workloadPlan" || key === "workloadActual") {
      // normalizeWorkloadMap, may throw
      const mapKey = key as "workloadPlan" | "workloadActual";
      result[mapKey] = normalizeWorkloadMap(value);
    } else if (key === "ganttMarkers") {
      // normalizeMarkers, may throw
      result.ganttMarkers = normalizeMarkers(value);
    }
  }

  // planned date range check
  if (
    result.plannedStartDate &&
    result.plannedEndDate &&
    result.plannedStartDate > result.plannedEndDate
  ) {
    throw new Error("plannedStartDate must not be after plannedEndDate");
  }

  // status/completed consistency
  // Apply consistency rules in order

  // Rule 1: if statusLabel === "done" then completed = true (unconditional, no undefined check)
  // This overrides even if patch explicitly has completed:false
  if (result.statusLabel === "done") {
    result.completed = true;
  }

  // Rules 2-4 fire only if the other field is missing from the patch
  // Rule 2: if completed === true AND statusLabel was not in patch, then statusLabel = "done"
  if (result.completed === true && result.statusLabel === undefined) {
    result.statusLabel = "done";
  }
  // Rule 3: if completed === false AND statusLabel was not in patch, then statusLabel = "active"
  else if (result.completed === false && result.statusLabel === undefined) {
    result.statusLabel = "active";
  }
  // Rule 4: if statusLabel !== undefined AND statusLabel !== "done" AND completed was not in patch, then completed = false
  else if (
    result.statusLabel !== undefined &&
    result.statusLabel !== "done" &&
    p.completed === undefined
  ) {
    result.completed = false;
  }

  return result;
}


export interface ApplyPatchResult {
  parent: TaskRow;
  changed: string[];
  taskId: string;
}

/**
 * Applies a patch to one row in place: normalize and merge, sync displayName/title, bump updatedAt,
 * recompute the auto priority (if enabled and mode=auto) and re-check the planned date range.
 * Returns the changed field names.
 * @throws If patch validation fails or date ranges are invalid
 */
export function applyPatchToRow(
  target: TaskRow,
  patch: TaskPatch,
  settings: Pick<TaskWorkbenchSettings, "autoPriorityEnabled">
): string[] {
  const { subtasks, ...rest } = target;
  // Subtasks are other notes: compare and clone only this row's own fields.
  const before = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  void subtasks;

  const normalizedPatch = normalizeTaskPatch(patch, target.kind);

  for (const [key, value] of Object.entries(normalizedPatch)) {
    if (value !== undefined) {
      (target as unknown as Record<string, unknown>)[key] = value;
    }
  }

  // displayName/title sync (if either provided, set both to same value)
  if (
    normalizedPatch.displayName !== undefined ||
    normalizedPatch.title !== undefined
  ) {
    const newValue =
      normalizedPatch.displayName !== undefined
        ? normalizedPatch.displayName
        : normalizedPatch.title!;
    target.displayName = newValue;
    target.title = newValue;
  }

  // updatedAt = today (ALWAYS, even for empty patch {})
  target.updatedAt = todayStr();

  // auto-priority only when patch.priority === undefined, and settings.autoPriorityEnabled === true
  if (patch.priority === undefined) {
    // Use merged dueDate after patch application
    if (settings.autoPriorityEnabled && target.priorityMode === "auto") {
      target.priority = calculateAutoPriority(target.dueDate);
    }
  }

  // re-check planned date range for subtasks only
  if (target.kind === "subtask") {
    if (
      target.plannedStartDate &&
      target.plannedEndDate &&
      target.plannedStartDate > target.plannedEndDate
    ) {
      throw new Error("plannedStartDate must not be after plannedEndDate");
    }
  }

  const { subtasks: afterSubtasks, ...afterRest } = target;
  void afterSubtasks;
  const after = JSON.parse(JSON.stringify(afterRest)) as Record<string, unknown>;
  return changedFields(before, after);
}

/** The subtask row a task id refers to inside `parent`, or the parent itself. */
function targetOf(parent: TaskRow, taskId: string): TaskRow {
  if (taskId === parent.id && !parent.subtasks?.has(taskId)) return parent;
  const direct = parent.subtasks?.get(taskId);
  if (direct) return direct;
  if (taskId.includes("::")) {
    // Ids of the old note format: {parentPath}::{key}
    const subtask = parent.subtasks?.get(taskId.split("::").pop()!);
    if (!subtask) throw new Error("Subtask not found");
    return subtask;
  }
  if (taskId !== parent.id && parent.subtasks?.size) {
    const byId = [...parent.subtasks.values()].find((row) => row.id === taskId);
    if (byId) return byId;
  }
  return parent;
}

/**
 * Apply a normalized task patch to a parent or one of its subtasks.
 * @param parent The parent TaskRow containing the target (parent or subtask)
 * @param patch The unnormalized patch object
 * @param taskId The id of the parent or of one of its subtasks
 * @param settings The task workbench settings, used to gate auto-priority recalculation
 * @throws If patch validation fails or date ranges are invalid
 */
export function applyPatchToParent(
  parent: TaskRow,
  patch: TaskPatch,
  taskId: string,
  settings: TaskWorkbenchSettings
): ApplyPatchResult {
  const changed = applyPatchToRow(targetOf(parent, taskId), patch, settings);
  return { parent, changed, taskId };
}
