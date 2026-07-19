import type { TaskNote, Subtask, Marker } from './types';
import { parseTaskBodyContent } from './body-sections';

export type ParseResult =
  | { ok: true; note: TaskNote }
  | { ok: false; errors: string[] };

/**
 * Type coercion helpers for safely extracting and validating frontmatter fields.
 */

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function isWorkloadRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, val] of Object.entries(value)) {
    // Validate date format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    if (typeof val !== 'number') return false;
  }
  return true;
}

function asWorkloadRecord(value: unknown): Record<string, number> {
  // Accept a fully-valid workload record as-is
  if (isWorkloadRecord(value)) return value;

  // If it looks like an object but has invalid entries, preserve the valid ones
  // and skip malformed entries (e.g., non-numeric values, non-date keys)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(value)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof val === 'number') {
        result[key] = val;
      }
      // Skip invalid entries silently (frontmatter editing can introduce them)
    }
    return result;
  }

  // Not an object or not workload-shaped: return empty
  return {};
}

function isMarker(item: unknown): item is Marker {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.key === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.date === 'string' &&
    Array.isArray(obj.tags)
  );
}

function isMarkerArray(value: unknown): value is Marker[] {
  if (!Array.isArray(value)) return false;
  return value.every(isMarker);
}

/**
 * Checks if an object looks like a task note frontmatter.
 */
export function isTaskNoteFrontmatter(frontmatter: unknown): boolean {
  if (typeof frontmatter !== 'object' || frontmatter === null) return false;
  const fm = frontmatter as Record<string, unknown>;
  return fm.type === 'task';
}

/**
 * Parses a task note from frontmatter and body text.
 */
export function parseTaskNote(frontmatter: unknown, body: string): ParseResult {
  // Validate frontmatter structure
  if (typeof frontmatter !== 'object' || frontmatter === null) {
    return { ok: false, errors: ['frontmatter is not an object'] };
  }

  const fm = frontmatter as Record<string, unknown>;

  // Validate type
  if (fm.type !== 'task') {
    return { ok: false, errors: ['frontmatter.type must be "task"'] };
  }

  // Extract required fields with validation
  const displayName = asString(fm.displayName);
  if (!displayName) {
    return { ok: false, errors: ['frontmatter.displayName is required and must be a string'] };
  }

  const statusLabel = asString(fm.statusLabel) || 'active';
  const createdAt = asString(fm.createdAt);
  if (!createdAt) {
    return { ok: false, errors: ['frontmatter.createdAt is required and must be a string'] };
  }

  const updatedAt = asString(fm.updatedAt);
  if (!updatedAt) {
    return { ok: false, errors: ['frontmatter.updatedAt is required and must be a string'] };
  }

  const dueDate = asStringOrNull(fm.dueDate);
  const priority = asNumber(fm.priority) ?? 0;
  const priorityMode = (fm.priorityMode === 'manual' ? 'manual' : 'auto') as 'auto' | 'manual';
  const tags = asStringArray(fm.tags);
  const completed = asBoolean(fm.completed) ?? false;
  const ganttEnabled = asBoolean(fm.ganttEnabled) ?? true;
  const ganttOrder = asNumber(fm.ganttOrder) ?? 0;

  // Parse subtaskOrder
  let subtaskOrder: string[] = [];
  if (Array.isArray(fm.subtaskOrder)) {
    subtaskOrder = fm.subtaskOrder.filter((item): item is string => typeof item === 'string');
  }

  // Parse subtasks array
  let subtasks: Subtask[] = [];
  if (!Array.isArray(fm.subtasks)) {
    if (fm.subtasks !== undefined && fm.subtasks !== null) {
      return { ok: false, errors: ['frontmatter.subtasks must be an array'] };
    }
    // subtasks is optional, defaults to empty array
  } else {
    const parseSubtasksResult = parseSubtasksArray(fm.subtasks);
    if (!parseSubtasksResult.ok) {
      return { ok: false, errors: parseSubtasksResult.errors || ['Failed to parse subtasks'] };
    }
    subtasks = parseSubtasksResult.subtasks || [];
  }

  // Parse body sections
  const subtaskTitles = subtasks.map((s) => s.title);
  const bodyParseResult = parseTaskBodyContent(body, subtaskTitles);
  if (bodyParseResult.errors.length > 0) {
    return { ok: false, errors: bodyParseResult.errors };
  }
  const { currentStatus, notes } = bodyParseResult;

  // Update subtask body content
  for (let i = 0; i < subtasks.length; i++) {
    if (bodyParseResult.subtaskSections[i]) {
      const { currentStatus: subStatus, notes: subNotes } =
        bodyParseResult.subtaskSections[i];
      subtasks[i].currentStatus = subStatus;
      subtasks[i].notes = subNotes;
    }
  }

  const note: TaskNote = {
    displayName,
    statusLabel,
    createdAt,
    updatedAt,
    dueDate,
    priority,
    priorityMode,
    tags,
    completed,
    ganttEnabled,
    ganttOrder,
    subtaskOrder,
    subtasks,
    currentStatus,
    notes,
  };

  return { ok: true, note };
}

interface SubtasksParseResult {
  ok: boolean;
  subtasks?: Subtask[];
  errors?: string[];
}

/**
 * Parses the subtasks array from frontmatter.
 */
function parseSubtasksArray(
  subtasksValue: unknown
): SubtasksParseResult {
  const subtasks: Subtask[] = [];

  if (!Array.isArray(subtasksValue)) {
    return { ok: false, errors: ['subtasks must be an array'] };
  }

  for (let i = 0; i < subtasksValue.length; i++) {
    const item = subtasksValue[i];
    if (typeof item !== 'object' || item === null) {
      return { ok: false, errors: [`subtasks[${i}] is not an object`] };
    }

    const st = item as Record<string, unknown>;

    const key = asString(st.key);
    if (!key) {
      return { ok: false, errors: [`subtasks[${i}].key is required and must be a string`] };
    }

    const title = asString(st.title);
    if (!title) {
      return { ok: false, errors: [`subtasks[${i}].title is required and must be a string`] };
    }

    const subtask: Subtask = {
      key,
      title,
      statusLabel: asString(st.statusLabel) || 'active',
      createdAt: asString(st.createdAt) || '',
      updatedAt: asString(st.updatedAt) || '',
      dueDate: asStringOrNull(st.dueDate),
      plannedStartDate: asStringOrNull(st.plannedStartDate),
      plannedEndDate: asStringOrNull(st.plannedEndDate),
      workloadPlan: asWorkloadRecord(st.workloadPlan),
      workloadActual: asWorkloadRecord(st.workloadActual),
      priority: asNumber(st.priority) ?? 0,
      priorityMode: (st.priorityMode === 'manual' ? 'manual' : 'auto') as 'auto' | 'manual',
      tags: asStringArray(st.tags),
      completed: asBoolean(st.completed) ?? false,
      markers: parseMarkersArray(st.markers),
      currentStatus: '', // Will be filled from body
      notes: '', // Will be filled from body
    };

    subtasks.push(subtask);
  }

  return { ok: true, subtasks };
}

/**
 * Parses the markers array from a subtask.
 */
function parseMarkersArray(markersValue: unknown): Marker[] {
  if (!isMarkerArray(markersValue)) {
    return [];
  }
  return markersValue;
}

