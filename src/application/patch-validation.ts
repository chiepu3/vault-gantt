/**
 * Validation for parent and subtask patches.
 * Collects ALL validation errors before returning, does not short-circuit.
 */

import type { Marker } from '../domain/task-note/types';

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Whitelisted fields for parent (TaskNote) patches.
 * Excludes system-managed fields: createdAt, updatedAt, subtasks.
 */
const PARENT_PATCHABLE_FIELDS = new Set([
  'displayName',
  'statusLabel',
  'dueDate',
  'priority',
  'priorityMode',
  'tags',
  'completed',
  'ganttEnabled',
  'ganttOrder',
  'currentStatus',
  'notes',
  'subtaskOrder',
]);

/**
 * Whitelisted fields for subtask patches.
 * Excludes system-managed fields: key, createdAt, updatedAt.
 */
const SUBTASK_PATCHABLE_FIELDS = new Set([
  'title',
  'statusLabel',
  'dueDate',
  'plannedStartDate',
  'plannedEndDate',
  'workloadPlan',
  'workloadActual',
  'priority',
  'priorityMode',
  'tags',
  'completed',
  'markers',
  'currentStatus',
  'notes',
]);

/**
 * Type guards for field validation.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNullOrDateString(value: unknown): value is string | null {
  return value === null || isDateString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMarkerArray(value: unknown): value is Marker[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!isRecord(item)) return false;
    const m = item as Record<string, unknown>;
    return (
      isString(m.key) &&
      isString(m.title) &&
      isString(m.date) &&
      isStringArray(m.tags)
    );
  });
}

/**
 * Validate a workload record (Record<string, number> where each key is YYYY-MM-DD).
 * Each value must be a multiple of 0.5 between 0 and 24 (inclusive).
 */
function isValidWorkloadRecord(value: unknown): {
  ok: boolean;
  errors: { key?: string; message: string }[];
} {
  const errors: { key?: string; message: string }[] = [];

  if (!isRecord(value)) {
    errors.push({ message: 'must be an object' });
    return { ok: errors.length === 0, errors };
  }

  for (const [key, val] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      errors.push({ key, message: `key "${key}" must be YYYY-MM-DD` });
      continue;
    }

    if (!isNumber(val)) {
      errors.push({ key, message: `entry "${key}" must be a number` });
      continue;
    }

    // Check if multiple of 0.5 using epsilon-safe check
    const isMultipleOfHalf = Math.round(val * 2) === val * 2;
    if (!isMultipleOfHalf || val < 0 || val > 24) {
      errors.push({ key, message: `entry "${key}" must be a multiple of 0.5 between 0 and 24` });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a parent (TaskNote) patch.
 * Collects ALL violations and returns them together.
 */
export function validateParentPatch(fields: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  // Check for unknown fields
  for (const key of Object.keys(fields)) {
    if (!PARENT_PATCHABLE_FIELDS.has(key)) {
      errors.push(`Unknown field "${key}" is not patchable on parent`);
    }
  }

  // Validate individual field types and constraints
  if ('displayName' in fields && !isString(fields.displayName)) {
    errors.push('displayName must be a string');
  }

  if ('statusLabel' in fields && !isString(fields.statusLabel)) {
    errors.push('statusLabel must be a string');
  }

  if ('dueDate' in fields && !isNullOrDateString(fields.dueDate)) {
    errors.push('dueDate must be null or YYYY-MM-DD');
  }

  if ('priority' in fields) {
    if (!isNumber(fields.priority) || !Number.isInteger(fields.priority) || fields.priority < 0 || fields.priority > 5) {
      errors.push('priority must be an integer between 0 and 5');
    }
  }

  if ('priorityMode' in fields) {
    const mode = fields.priorityMode;
    if (mode !== 'auto' && mode !== 'manual') {
      errors.push("priorityMode must be 'auto' or 'manual'");
    }
  }

  if ('tags' in fields && !isStringArray(fields.tags)) {
    errors.push('tags must be a string array');
  }

  if ('completed' in fields && !isBoolean(fields.completed)) {
    errors.push('completed must be a boolean');
  }

  if ('ganttEnabled' in fields && !isBoolean(fields.ganttEnabled)) {
    errors.push('ganttEnabled must be a boolean');
  }

  if ('ganttOrder' in fields && !isNumber(fields.ganttOrder)) {
    errors.push('ganttOrder must be a number');
  }

  if ('currentStatus' in fields && !isString(fields.currentStatus)) {
    errors.push('currentStatus must be a string');
  }

  if ('notes' in fields && !isString(fields.notes)) {
    errors.push('notes must be a string');
  }

  if ('subtaskOrder' in fields && !isStringArray(fields.subtaskOrder)) {
    errors.push('subtaskOrder must be a string array');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validate a subtask patch.
 * Collects ALL violations and returns them together.
 */
export function validateSubtaskPatch(fields: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  // Check for unknown fields
  for (const key of Object.keys(fields)) {
    if (!SUBTASK_PATCHABLE_FIELDS.has(key)) {
      errors.push(`Unknown field "${key}" is not patchable on subtask`);
    }
  }

  // Validate individual field types and constraints
  if ('title' in fields && !isString(fields.title)) {
    errors.push('title must be a string');
  }

  if ('statusLabel' in fields && !isString(fields.statusLabel)) {
    errors.push('statusLabel must be a string');
  }

  if ('dueDate' in fields && !isNullOrDateString(fields.dueDate)) {
    errors.push('dueDate must be null or YYYY-MM-DD');
  }

  if ('plannedStartDate' in fields && !isNullOrDateString(fields.plannedStartDate)) {
    errors.push('plannedStartDate must be null or YYYY-MM-DD');
  }

  if ('plannedEndDate' in fields && !isNullOrDateString(fields.plannedEndDate)) {
    errors.push('plannedEndDate must be null or YYYY-MM-DD');
  }

  if ('priority' in fields) {
    if (!isNumber(fields.priority) || !Number.isInteger(fields.priority) || fields.priority < 0 || fields.priority > 5) {
      errors.push('priority must be an integer between 0 and 5');
    }
  }

  if ('priorityMode' in fields) {
    const mode = fields.priorityMode;
    if (mode !== 'auto' && mode !== 'manual') {
      errors.push("priorityMode must be 'auto' or 'manual'");
    }
  }

  if ('tags' in fields && !isStringArray(fields.tags)) {
    errors.push('tags must be a string array');
  }

  if ('completed' in fields && !isBoolean(fields.completed)) {
    errors.push('completed must be a boolean');
  }

  if ('currentStatus' in fields && !isString(fields.currentStatus)) {
    errors.push('currentStatus must be a string');
  }

  if ('notes' in fields && !isString(fields.notes)) {
    errors.push('notes must be a string');
  }

  // Validate workload records
  if ('workloadPlan' in fields) {
    const wlResult = isValidWorkloadRecord(fields.workloadPlan);
    if (!wlResult.ok) {
      for (const err of wlResult.errors) {
        if (err.key) {
          errors.push(`workloadPlan ${err.message}`);
        } else {
          errors.push(`workloadPlan ${err.message}`);
        }
      }
    }
  }

  if ('workloadActual' in fields) {
    const wlResult = isValidWorkloadRecord(fields.workloadActual);
    if (!wlResult.ok) {
      for (const err of wlResult.errors) {
        if (err.key) {
          errors.push(`workloadActual ${err.message}`);
        } else {
          errors.push(`workloadActual ${err.message}`);
        }
      }
    }
  }

  // Validate markers
  if ('markers' in fields) {
    if (!isMarkerArray(fields.markers)) {
      errors.push('markers must be an array of Marker objects');
    } else {
      const markerArray = fields.markers as Marker[];
      const seenKeys = new Set<string>();
      for (const marker of markerArray) {
        if (seenKeys.has(marker.key)) {
          errors.push(`Duplicate marker key "${marker.key}"`);
        }
        seenKeys.add(marker.key);

        if (!marker.title || marker.title.length === 0) {
          errors.push(`marker "${marker.key}" title must be a non-empty string`);
        }

        if (!isDateString(marker.date)) {
          errors.push(`marker "${marker.key}" date must be YYYY-MM-DD`);
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
