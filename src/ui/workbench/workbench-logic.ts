import type { TaskRecord } from '../../application/core-task-api';
import type { Subtask } from '../../domain/task-note/types';

export interface WorkbenchFilter {
  query: string;           // case-insensitive substring match on displayName
  statusKeys: string[];    // empty array = show all statuses
  showCompleted: boolean;  // false = hide completed tasks
  tags: string[];          // empty array = show all tags
}

export interface WorkbenchSort {
  field: 'displayName' | 'priority' | 'statusLabel' | 'dueDate' | 'createdAt' | 'updatedAt';
  direction: 'asc' | 'desc';
}

export type WorkbenchRow =
  | { kind: 'parent'; record: TaskRecord; expanded: boolean }
  | { kind: 'subtask'; parentPath: string; subtask: Subtask };

/**
 * Filter task records based on query, status, completion, and tags.
 * A task matches if:
 * - displayName contains query (case-insensitive)
 * - statusKeys is empty OR statusLabel is in statusKeys
 * - showCompleted is true OR completed is false
 * - tags is empty OR task has at least one tag in the filter tags
 */
export function filterTaskRecords(records: TaskRecord[], filter: WorkbenchFilter): TaskRecord[] {
  return records.filter((record) => {
    const note = record.note;

    // Query filter: case-insensitive substring across all text fields
    if (filter.query.length > 0) {
      const lowerQuery = filter.query.toLowerCase();
      const haystack = [
        note.displayName,
        note.currentStatus,
        note.notes,
        record.path,
        ...note.tags,
        ...note.subtasks.map((s) => s.title),
        ...note.subtasks.map((s) => s.currentStatus),
        ...note.subtasks.flatMap((s) => s.tags),
      ].join('\n').toLowerCase();
      if (!haystack.includes(lowerQuery)) return false;
    }

    // Status filter: empty means show all
    if (filter.statusKeys.length > 0 && !filter.statusKeys.includes(note.statusLabel)) {
      return false;
    }

    // Completed filter
    if (!filter.showCompleted && note.completed) {
      return false;
    }

    // Tags filter: empty means show all; otherwise must have at least one match
    if (filter.tags.length > 0) {
      const hasMatchingTag = note.tags.some((tag) => filter.tags.includes(tag));
      if (!hasMatchingTag) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Sort task records by the specified field and direction.
 * Null dates sort to the end regardless of direction.
 */
export function sortTaskRecords(records: TaskRecord[], sort: WorkbenchSort): TaskRecord[] {
  const sorted = [...records];

  sorted.sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;
    let aIsNull = false;
    let bIsNull = false;

    switch (sort.field) {
      case 'displayName':
        aVal = a.note.displayName.toLowerCase();
        bVal = b.note.displayName.toLowerCase();
        break;
      case 'priority':
        aVal = a.note.priority;
        bVal = b.note.priority;
        break;
      case 'statusLabel':
        aVal = a.note.statusLabel;
        bVal = b.note.statusLabel;
        break;
      case 'dueDate':
        // Null dates always sort to end, even when descending
        aIsNull = a.note.dueDate === null;
        bIsNull = b.note.dueDate === null;
        if (aIsNull && bIsNull) return 0;
        if (aIsNull) return 1; // a sorts after b
        if (bIsNull) return -1; // b sorts after a
        aVal = a.note.dueDate as string;
        bVal = b.note.dueDate as string;
        break;
      case 'createdAt':
        aVal = a.note.createdAt;
        bVal = b.note.createdAt;
        break;
      case 'updatedAt':
        aVal = a.note.updatedAt;
        bVal = b.note.updatedAt;
        break;
      default:
        return 0;
    }

    if (aVal < bVal) return sort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return sort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  return sorted;
}

/**
 * Build flat row list from filtered/sorted records.
 * For each record, output a 'parent' row; if not collapsed, output its subtasks in subtaskOrder.
 */
export function buildWorkbenchRows(records: TaskRecord[], collapsed: ReadonlySet<string>): WorkbenchRow[] {
  const rows: WorkbenchRow[] = [];

  for (const record of records) {
    const expanded = !collapsed.has(record.path);

    rows.push({
      kind: 'parent',
      record,
      expanded,
    });

    if (expanded) {
      const note = record.note;
      for (const key of note.subtaskOrder) {
        const subtask = note.subtasks.find((s) => s.key === key);
        if (subtask) {
          rows.push({
            kind: 'subtask',
            parentPath: record.path,
            subtask,
          });
        }
      }
    }
  }

  return rows;
}
