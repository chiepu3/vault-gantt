import { describe, it, expect } from 'vitest';
import { filterTaskRecords, sortTaskRecords, buildWorkbenchRows } from './workbench-logic';
import type { TaskRecord } from '../../application/core-task-api';
import type { TaskNote, Subtask } from '../../domain/task-note/types';

// Helper to create a minimal TaskRecord for testing
function makeRecord(
  path: string,
  displayName: string,
  statusLabel: string = 'active',
  completed: boolean = false,
  dueDate: string | null = null,
  tags: string[] = [],
  subtasks: Subtask[] = []
): TaskRecord {
  const note: TaskNote = {
    displayName,
    statusLabel,
    createdAt: '2026-07-19',
    updatedAt: '2026-07-19',
    dueDate,
    priority: 0,
    priorityMode: 'auto',
    tags,
    completed,
    ganttEnabled: true,
    ganttOrder: 0,
    subtaskOrder: subtasks.map((s) => s.key),
    subtasks,
    currentStatus: '',
    notes: '',
  };

  return {
    path,
    revision: 'rev1',
    note,
  };
}

// Helper to create a minimal Subtask for testing
function makeSubtask(key: string, title: string, completed: boolean = false): Subtask {
  return {
    key,
    title,
    statusLabel: completed ? 'done' : 'active',
    createdAt: '2026-07-19',
    updatedAt: '2026-07-19',
    dueDate: null,
    plannedStartDate: null,
    plannedEndDate: null,
    workloadPlan: {},
    workloadActual: {},
    priority: 0,
    priorityMode: 'auto',
    tags: [],
    completed,
    markers: [],
    currentStatus: '',
    notes: '',
  };
}

describe('workbench-logic', () => {
  describe('filterTaskRecords', () => {
    it('should show all records when filter is empty', () => {
      const records = [
        makeRecord('task1.md', 'Task One'),
        makeRecord('task2.md', 'Task Two'),
      ];

      const filtered = filterTaskRecords(records, {
        query: '',
        statusKeys: [],
        showCompleted: true,
        tags: [],
      });

      expect(filtered).toHaveLength(2);
    });

    it('should filter by query (case-insensitive substring)', () => {
      const records = [
        makeRecord('task1.md', 'Buy Groceries'),
        makeRecord('task2.md', 'Write Report'),
        makeRecord('task3.md', 'Buy Books'),
      ];

      const filtered = filterTaskRecords(records, {
        query: 'buy',
        statusKeys: [],
        showCompleted: true,
        tags: [],
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.note.displayName)).toEqual(['Buy Groceries', 'Buy Books']);
    });

    it('should filter by status when statusKeys is non-empty', () => {
      const records = [
        makeRecord('task1.md', 'Task One', 'active'),
        makeRecord('task2.md', 'Task Two', 'in_progress'),
        makeRecord('task3.md', 'Task Three', 'done'),
      ];

      const filtered = filterTaskRecords(records, {
        query: '',
        statusKeys: ['active', 'in_progress'],
        showCompleted: true,
        tags: [],
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.note.statusLabel)).toEqual(['active', 'in_progress']);
    });

    it('should hide completed tasks when showCompleted is false', () => {
      const records = [
        makeRecord('task1.md', 'Task One', 'active', false),
        makeRecord('task2.md', 'Task Two', 'done', true),
        makeRecord('task3.md', 'Task Three', 'active', false),
      ];

      const filtered = filterTaskRecords(records, {
        query: '',
        statusKeys: [],
        showCompleted: false,
        tags: [],
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => !r.note.completed)).toBe(true);
    });

    it('should filter by tags when tags array is non-empty', () => {
      const records = [
        makeRecord('task1.md', 'Task One', 'active', false, null, ['urgent']),
        makeRecord('task2.md', 'Task Two', 'active', false, null, ['work']),
        makeRecord('task3.md', 'Task Three', 'active', false, null, ['urgent', 'work']),
        makeRecord('task4.md', 'Task Four', 'active', false, null, ['personal']),
      ];

      const filtered = filterTaskRecords(records, {
        query: '',
        statusKeys: [],
        showCompleted: true,
        tags: ['urgent'],
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.note.displayName)).toEqual(['Task One', 'Task Three']);
    });

    it('should apply all filters together', () => {
      const records = [
        makeRecord('task1.md', 'Buy urgent stuff', 'active', false, null, ['urgent']),
        makeRecord('task2.md', 'Buy personal stuff', 'active', false, null, ['personal']),
        makeRecord('task3.md', 'Sell urgent car', 'done', true, null, ['urgent']),
      ];

      const filtered = filterTaskRecords(records, {
        query: 'buy',
        statusKeys: ['active'],
        showCompleted: false,
        tags: ['urgent'],
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].note.displayName).toBe('Buy urgent stuff');
    });
  });

  describe('sortTaskRecords', () => {
    it('should sort by displayName ascending', () => {
      const records = [
        makeRecord('task1.md', 'Zebra'),
        makeRecord('task2.md', 'Apple'),
        makeRecord('task3.md', 'Mango'),
      ];

      const sorted = sortTaskRecords(records, {
        field: 'displayName',
        direction: 'asc',
      });

      expect(sorted.map((r) => r.note.displayName)).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('should sort by displayName descending', () => {
      const records = [
        makeRecord('task1.md', 'Zebra'),
        makeRecord('task2.md', 'Apple'),
        makeRecord('task3.md', 'Mango'),
      ];

      const sorted = sortTaskRecords(records, {
        field: 'displayName',
        direction: 'desc',
      });

      expect(sorted.map((r) => r.note.displayName)).toEqual(['Zebra', 'Mango', 'Apple']);
    });

    it('should sort by priority ascending', () => {
      const records = [
        makeRecord('task1.md', 'Task One'),
        makeRecord('task2.md', 'Task Two'),
        makeRecord('task3.md', 'Task Three'),
      ];
      records[0].note.priority = 2;
      records[1].note.priority = 0;
      records[2].note.priority = 1;

      const sorted = sortTaskRecords(records, {
        field: 'priority',
        direction: 'asc',
      });

      expect(sorted.map((r) => r.note.priority)).toEqual([0, 1, 2]);
    });

    it('should sort by dueDate with nulls at end (asc)', () => {
      const records = [
        makeRecord('task1.md', 'Task One', 'active', false, null),
        makeRecord('task2.md', 'Task Two', 'active', false, '2026-07-25'),
        makeRecord('task3.md', 'Task Three', 'active', false, '2026-07-20'),
      ];

      const sorted = sortTaskRecords(records, {
        field: 'dueDate',
        direction: 'asc',
      });

      expect(sorted.map((r) => r.note.dueDate)).toEqual(['2026-07-20', '2026-07-25', null]);
    });

    it('should sort by dueDate with nulls at end (desc)', () => {
      const records = [
        makeRecord('task1.md', 'Task One', 'active', false, null),
        makeRecord('task2.md', 'Task Two', 'active', false, '2026-07-25'),
        makeRecord('task3.md', 'Task Three', 'active', false, '2026-07-20'),
      ];

      const sorted = sortTaskRecords(records, {
        field: 'dueDate',
        direction: 'desc',
      });

      expect(sorted.map((r) => r.note.dueDate)).toEqual(['2026-07-25', '2026-07-20', null]);
    });

    it('should sort by createdAt', () => {
      const records = [
        makeRecord('task1.md', 'Task One'),
        makeRecord('task2.md', 'Task Two'),
      ];
      records[0].note.createdAt = '2026-07-20';
      records[1].note.createdAt = '2026-07-19';

      const sorted = sortTaskRecords(records, {
        field: 'createdAt',
        direction: 'asc',
      });

      expect(sorted.map((r) => r.note.createdAt)).toEqual(['2026-07-19', '2026-07-20']);
    });

    it('should sort by statusLabel', () => {
      const records = [
        makeRecord('task1.md', 'Task One', 'waiting'),
        makeRecord('task2.md', 'Task Two', 'active'),
        makeRecord('task3.md', 'Task Three', 'done'),
      ];

      const sorted = sortTaskRecords(records, {
        field: 'statusLabel',
        direction: 'asc',
      });

      expect(sorted.map((r) => r.note.statusLabel)).toEqual(['active', 'done', 'waiting']);
    });

    it('should not mutate original array', () => {
      const records = [
        makeRecord('task1.md', 'Zebra'),
        makeRecord('task2.md', 'Apple'),
      ];
      const original = [...records];

      sortTaskRecords(records, {
        field: 'displayName',
        direction: 'asc',
      });

      expect(records).toEqual(original);
    });
  });

  describe('buildWorkbenchRows', () => {
    it('should output parent row for each record when all expanded', () => {
      const records = [
        makeRecord('task1.md', 'Task One'),
        makeRecord('task2.md', 'Task Two'),
      ];

      const rows = buildWorkbenchRows(records, new Set());

      expect(rows).toHaveLength(2);
      expect(rows[0].kind).toBe('parent');
      expect(rows[1].kind).toBe('parent');
    });

    it('should show subtasks when parent is expanded', () => {
      const subtasks = [makeSubtask('st1', 'Subtask One'), makeSubtask('st2', 'Subtask Two')];
      const records = [makeRecord('task1.md', 'Task One', 'active', false, null, [], subtasks)];

      const rows = buildWorkbenchRows(records, new Set());

      expect(rows).toHaveLength(3);
      expect(rows[0].kind).toBe('parent');
      expect(rows[1].kind).toBe('subtask');
      expect(rows[2].kind).toBe('subtask');
    });

    it('should hide subtasks when parent is collapsed', () => {
      const subtasks = [makeSubtask('st1', 'Subtask One'), makeSubtask('st2', 'Subtask Two')];
      const records = [makeRecord('task1.md', 'Task One', 'active', false, null, [], subtasks)];

      const rows = buildWorkbenchRows(records, new Set(['task1.md']));

      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('parent');
      expect((rows[0] as any).expanded).toBe(false);
    });

    it('should respect subtaskOrder', () => {
      const subtasks = [
        makeSubtask('st1', 'First'),
        makeSubtask('st2', 'Second'),
        makeSubtask('st3', 'Third'),
      ];
      const record = makeRecord('task1.md', 'Task One', 'active', false, null, [], subtasks);
      record.note.subtaskOrder = ['st3', 'st1', 'st2']; // Custom order

      const rows = buildWorkbenchRows([record], new Set());

      expect(rows).toHaveLength(4);
      expect((rows[1] as any).subtask.key).toBe('st3');
      expect((rows[2] as any).subtask.key).toBe('st1');
      expect((rows[3] as any).subtask.key).toBe('st2');
    });

    it('should set expanded flag correctly', () => {
      const records = [
        makeRecord('task1.md', 'Task One'),
        makeRecord('task2.md', 'Task Two'),
      ];

      const rows = buildWorkbenchRows(records, new Set(['task1.md']));

      const parentRows = rows.filter((r) => r.kind === 'parent');
      expect((parentRows[0] as any).expanded).toBe(false);
      expect((parentRows[1] as any).expanded).toBe(true);
    });

    it('should handle mixed collapsed/expanded records', () => {
      const st1 = makeSubtask('st1', 'Sub One');
      const st2 = makeSubtask('st2', 'Sub Two');
      const records = [
        makeRecord('task1.md', 'Task One', 'active', false, null, [], [st1]),
        makeRecord('task2.md', 'Task Two', 'active', false, null, [], [st2]),
      ];

      const rows = buildWorkbenchRows(records, new Set(['task1.md']));

      expect(rows).toHaveLength(3);
      expect(rows[0].kind).toBe('parent');
      expect((rows[0] as any).expanded).toBe(false);
      expect(rows[1].kind).toBe('parent');
      expect((rows[1] as any).expanded).toBe(true);
      expect(rows[2].kind).toBe('subtask');
    });

    it('should skip subtasks not in subtaskOrder', () => {
      const subtasks = [
        makeSubtask('st1', 'Subtask One'),
        makeSubtask('st2', 'Subtask Two'),
      ];
      const record = makeRecord('task1.md', 'Task One', 'active', false, null, [], subtasks);
      record.note.subtaskOrder = ['st1']; // Only st1 is ordered

      const rows = buildWorkbenchRows([record], new Set());

      expect(rows).toHaveLength(2);
      expect((rows[1] as any).subtask.title).toBe('Subtask One');
    });

    it('should output empty list when given empty records', () => {
      const rows = buildWorkbenchRows([], new Set());

      expect(rows).toHaveLength(0);
    });
  });
});
