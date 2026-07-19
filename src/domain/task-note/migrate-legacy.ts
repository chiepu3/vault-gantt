import type { TaskNote, Subtask } from './types';
import { parseTaskBodyContent } from './body-sections';
import { serializeTaskNoteFrontmatter, serializeTaskNoteBody } from './serializer';

export interface LegacyMigrationResult {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Non-fatal issues found while extracting currentStatus/notes from the legacy body (e.g. a missing or mismatched heading). Migration still produces output; the caller should surface these per-file rather than treat them as fatal. */
  warnings: string[];
}

/**
 * Migrates a task note from the old flat-key format to the new nested format.
 *
 * Legacy format uses keys like:
 *   subtask__<key>__title
 *   subtask__<key>__statusLabel
 *   subtask__<key>__workloadPlan = "2026-07-01=4,2026-07-02=2.5" (CSV string)
 *   subtask__<key>__ganttMarker__<mkey>__title
 *   etc.
 *
 * New format uses:
 *   subtasks: [{ key, title, ..., markers: [...], workloadPlan: {...}, ... }]
 *
 * @returns An object with the new frontmatter and body ready to write to the file
 */
export function migrateLegacyTaskNote(
  legacyFrontmatter: Record<string, unknown>,
  legacyBody: string
): LegacyMigrationResult {
  if (typeof legacyFrontmatter !== 'object' || legacyFrontmatter === null || Array.isArray(legacyFrontmatter)) {
    return {
      frontmatter: {},
      body: '',
      warnings: ['legacyFrontmatter is not a valid object'],
    };
  }

  // Step 1: Extract top-level fields
  const displayName = typeof legacyFrontmatter.displayName === 'string'
    ? legacyFrontmatter.displayName
    : 'Untitled';
  const statusLabel = typeof legacyFrontmatter.statusLabel === 'string'
    ? legacyFrontmatter.statusLabel
    : 'active';
  const createdAt = typeof legacyFrontmatter.createdAt === 'string'
    ? legacyFrontmatter.createdAt
    : new Date().toISOString().split('T')[0];
  const updatedAt = typeof legacyFrontmatter.updatedAt === 'string'
    ? legacyFrontmatter.updatedAt
    : new Date().toISOString().split('T')[0];
  const dueDate = legacyFrontmatter.dueDate === '' || !legacyFrontmatter.dueDate
    ? null
    : (typeof legacyFrontmatter.dueDate === 'string'
      ? legacyFrontmatter.dueDate
      : null);
  const priority = typeof legacyFrontmatter.priority === 'number'
    ? legacyFrontmatter.priority
    : 0;
  const priorityMode = legacyFrontmatter.priorityMode === 'manual' ? 'manual' : 'auto';
  const tags = Array.isArray(legacyFrontmatter.tags)
    ? legacyFrontmatter.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const completed = legacyFrontmatter.completed === true;
  const ganttEnabled = legacyFrontmatter.ganttEnabled !== false;
  const ganttOrder = typeof legacyFrontmatter.ganttOrder === 'number'
    ? legacyFrontmatter.ganttOrder
    : 0;

  // Step 2: Extract subtaskOrder
  const subtaskOrder = Array.isArray(legacyFrontmatter.subtaskOrder)
    ? legacyFrontmatter.subtaskOrder.filter((k): k is string => typeof k === 'string')
    : [];

  // Step 3: Reconstruct subtasks from flat keys
  const { subtasks, warnings: reconstructWarnings } = reconstructSubtasksFromLegacy(legacyFrontmatter, subtaskOrder);

  // Step 4: Parse body sections (same heading vocabulary as the new format)
  const subtaskTitles = subtasks.map((s) => s.title);
  const bodyParseResult = parseTaskBodyContent(legacyBody, subtaskTitles);
  const { currentStatus, notes, subtaskSections: subtaskBodies, errors: bodyWarnings } = bodyParseResult;
  const warnings = [...reconstructWarnings, ...bodyWarnings];

  // Step 5: Update subtask body content
  for (let i = 0; i < subtasks.length; i++) {
    if (subtaskBodies[i]) {
      subtasks[i].currentStatus = subtaskBodies[i].currentStatus;
      subtasks[i].notes = subtaskBodies[i].notes;
    }
  }

  // Step 6: Assemble the new TaskNote
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

  // Step 7: Serialize to new format
  const newFrontmatter = serializeTaskNoteFrontmatter(note);
  const newBody = serializeTaskNoteBody(note);

  return {
    frontmatter: newFrontmatter,
    body: newBody,
    warnings,
  };
}

/**
 * Reconstructs subtask objects from the flat-key legacy format.
 */
function reconstructSubtasksFromLegacy(
  legacyFrontmatter: Record<string, unknown>,
  subtaskOrder: string[]
): { subtasks: Subtask[]; warnings: string[] } {
  const subtasks: Subtask[] = [];
  const warnings: string[] = [];
  const subtaskMap = new Map<string, Partial<Subtask>>();

  // Group all flat keys by subtask key
  for (const [fmKey, fmValue] of Object.entries(legacyFrontmatter)) {
    if (fmKey.startsWith('subtask__')) {
      const parts = fmKey.split('__');
      if (parts.length >= 3) {
        const subtaskKey = parts[1];

        if (!subtaskMap.has(subtaskKey)) {
          subtaskMap.set(subtaskKey, { key: subtaskKey });
        }

        const subtask = subtaskMap.get(subtaskKey)!;

        if (parts[2] === 'title') {
          subtask.title = typeof fmValue === 'string' ? fmValue : '';
        } else if (parts[2] === 'statusLabel') {
          subtask.statusLabel = typeof fmValue === 'string' ? fmValue : 'active';
        } else if (parts[2] === 'createdAt') {
          subtask.createdAt = typeof fmValue === 'string' ? fmValue : '';
        } else if (parts[2] === 'updatedAt') {
          subtask.updatedAt = typeof fmValue === 'string' ? fmValue : '';
        } else if (parts[2] === 'dueDate') {
          subtask.dueDate =
            !fmValue || fmValue === '' ? null : typeof fmValue === 'string' ? fmValue : null;
        } else if (parts[2] === 'plannedStartDate') {
          subtask.plannedStartDate =
            !fmValue || fmValue === '' ? null : typeof fmValue === 'string' ? fmValue : null;
        } else if (parts[2] === 'plannedEndDate') {
          subtask.plannedEndDate =
            !fmValue || fmValue === '' ? null : typeof fmValue === 'string' ? fmValue : null;
        } else if (parts[2] === 'workloadPlan') {
          subtask.workloadPlan = parseWorkloadCsv(
            typeof fmValue === 'string' ? fmValue : ''
          );
        } else if (parts[2] === 'workloadActual') {
          subtask.workloadActual = parseWorkloadCsv(
            typeof fmValue === 'string' ? fmValue : ''
          );
        } else if (parts[2] === 'priority') {
          subtask.priority = typeof fmValue === 'number' ? fmValue : 0;
        } else if (parts[2] === 'priorityMode') {
          subtask.priorityMode =
            fmValue === 'manual' ? 'manual' : 'auto';
        } else if (parts[2] === 'tags') {
          subtask.tags = Array.isArray(fmValue)
            ? fmValue.filter((t): t is string => typeof t === 'string')
            : [];
        } else if (parts[2] === 'completed') {
          subtask.completed = fmValue === true;
        } else if (parts[2] === 'ganttMarkerOrder') {
          subtask.markers = [];
          // Will be populated below
        }
      }
    }
  }

  // Now reconstruct markers for each subtask
  for (const [fmKey, fmValue] of Object.entries(legacyFrontmatter)) {
    if (fmKey.startsWith('subtask__') && fmKey.includes('__ganttMarker__')) {
      const parts = fmKey.split('__');
      if (parts.length >= 5) {
        const subtaskKey = parts[1];
        const markerKey = parts[3];

        const subtask = subtaskMap.get(subtaskKey);
        if (subtask && !subtask.markers) {
          subtask.markers = [];
        }
        if (subtask && Array.isArray(subtask.markers)) {
          // Find or create marker
          let marker = subtask.markers.find((m) => m.key === markerKey);
          if (!marker) {
            marker = { key: markerKey, title: '', date: '', tags: [] };
            subtask.markers.push(marker);
          }

          // Set marker field
          if (parts[4] === 'title') {
            marker.title = typeof fmValue === 'string' ? fmValue : '';
          } else if (parts[4] === 'date') {
            marker.date = typeof fmValue === 'string' ? fmValue : '';
          } else if (parts[4] === 'tags') {
            marker.tags = Array.isArray(fmValue)
              ? fmValue.filter((t): t is string => typeof t === 'string')
              : [];
          }
        }
      }
    }
  }

  // Convert map to array in subtaskOrder
  for (const key of subtaskOrder) {
    const partial = subtaskMap.get(key);
    if (!partial) {
      warnings.push(`Subtask "${key}" referenced in subtaskOrder but not found`);
      continue;
    }
    if (!partial.key || !partial.title) {
      warnings.push(`Subtask "${key}" is missing key/title`);
      continue;
    }
    const subtask: Subtask = {
      key: partial.key,
      title: partial.title,
      statusLabel: partial.statusLabel || 'active',
      createdAt: partial.createdAt || '',
      updatedAt: partial.updatedAt || '',
      dueDate: partial.dueDate || null,
      plannedStartDate: partial.plannedStartDate || null,
      plannedEndDate: partial.plannedEndDate || null,
      workloadPlan: partial.workloadPlan || {},
      workloadActual: partial.workloadActual || {},
      priority: partial.priority || 0,
      priorityMode: partial.priorityMode || 'auto',
      tags: partial.tags || [],
      completed: partial.completed || false,
      markers: partial.markers || [],
      currentStatus: '',
      notes: '',
    };
    subtasks.push(subtask);
  }

  return { subtasks, warnings };
}

/**
 * Parses a CSV workload string like "2026-07-01=4,2026-07-02=2.5" into a Record.
 */
function parseWorkloadCsv(csvString: string): Record<string, number> {
  const result: Record<string, number> = {};

  if (!csvString || typeof csvString !== 'string') {
    return result;
  }

  const pairs = csvString.split(',');
  for (const pair of pairs) {
    const [date, hoursStr] = pair.split('=');
    if (date && hoursStr) {
      const hours = parseFloat(hoursStr);
      if (!Number.isNaN(hours)) {
        result[date.trim()] = hours;
      }
    }
  }

  return result;
}

