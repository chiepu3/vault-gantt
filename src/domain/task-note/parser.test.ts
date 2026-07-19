import { describe, it, expect } from 'vitest';
import { parseTaskNote, isTaskNoteFrontmatter } from './parser';

describe('parser', () => {
  describe('isTaskNoteFrontmatter', () => {
    it('should return true for valid task frontmatter', () => {
      expect(isTaskNoteFrontmatter({ type: 'task' })).toBe(true);
      expect(
        isTaskNoteFrontmatter({
          type: 'task',
          displayName: 'Test',
        })
      ).toBe(true);
    });

    it('should return false for non-task frontmatter', () => {
      expect(isTaskNoteFrontmatter({})).toBe(false);
      expect(isTaskNoteFrontmatter({ type: 'note' })).toBe(false);
      expect(isTaskNoteFrontmatter(null)).toBe(false);
      expect(isTaskNoteFrontmatter('not an object')).toBe(false);
    });
  });

  describe('parseTaskNote', () => {
    it('should parse a minimal valid task note', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Test Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
      };

      const body = `# Test Task
> [!info]- タスク情報

## Current Status
Initial status
## Notes
Initial notes`;

      const result = parseTaskNote(frontmatter, body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.note.displayName).toBe('Test Task');
        expect(result.note.currentStatus).toBe('Initial status');
        expect(result.note.notes).toBe('Initial notes');
      }
    });

    it('should coerce YAML-mangled scalar types instead of dropping the note', () => {
      // Obsidian's YAML round trip: unquoted "123" becomes a number, unquoted
      // "2026-07-01" may become a Date. A hard reject here silently hides the
      // whole task from every list — coerce instead.
      const frontmatter = {
        type: 'task',
        displayName: 123,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: '2026-07-02',
      };

      const body = `# 123
> [!info]- タスク情報

## Current Status

## Notes
`;

      const result = parseTaskNote(frontmatter, body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.note.displayName).toBe('123');
        expect(result.note.createdAt).toBe('2026-07-01');
        expect(result.note.updatedAt).toBe('2026-07-02');
      }
    });

    it('should coerce a Date-typed dueDate to a YYYY-MM-DD string', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Test',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        dueDate: new Date('2026-07-31T00:00:00Z'),
      };

      const result = parseTaskNote(frontmatter, '# Test\n\n## Current Status\n\n## Notes\n');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.note.dueDate).toBe('2026-07-31');
      }
    });

    it('should reject frontmatter without type', () => {
      const frontmatter = {
        displayName: 'Test Task',
        createdAt: '2026-07-01',
      };

      const result = parseTaskNote(frontmatter, '');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain('type');
      }
    });

    it('should reject frontmatter without displayName', () => {
      const frontmatter = {
        type: 'task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
      };

      const result = parseTaskNote(frontmatter, '');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain('displayName');
      }
    });

    it('should fill in default values for optional fields', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Test Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
      };

      const body = `# Test Task

## Current Status
## Notes`;

      const result = parseTaskNote(frontmatter, body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.note.priority).toBe(0);
        expect(result.note.priorityMode).toBe('auto');
        expect(result.note.tags).toEqual([]);
        expect(result.note.completed).toBe(false);
        expect(result.note.ganttEnabled).toBe(true);
        expect(result.note.subtasks).toEqual([]);
      }
    });

    it('should reject when subtasks is not an array', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Test Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtasks: 'not an array',
      };

      const result = parseTaskNote(frontmatter, '');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain('array');
      }
    });

    it('should parse subtasks from array in frontmatter', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Parent Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtaskOrder: ['sub1'],
        subtasks: [
          {
            key: 'sub1',
            title: 'Subtask 1',
            statusLabel: 'active',
            createdAt: '2026-07-01',
            updatedAt: '2026-07-01',
          },
        ],
      };

      const body = `# Parent Task

## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Subtask 1

#### Current Status
Sub status
#### Notes
Sub notes`;

      const result = parseTaskNote(frontmatter, body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.note.subtasks).toHaveLength(1);
        expect(result.note.subtasks[0].title).toBe('Subtask 1');
        expect(result.note.subtasks[0].currentStatus).toBe('Sub status');
        expect(result.note.subtasks[0].notes).toBe('Sub notes');
      }
    });

    it('should reject malformed subtasks', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Parent Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtasks: [
          {
            // Missing required key and title
            statusLabel: 'active',
          },
        ],
      };

      const result = parseTaskNote(frontmatter, '');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain('key');
      }
    });

    it('should reject when the body subtask heading does not match the frontmatter subtask title (desync)', () => {
      const frontmatter = {
        type: 'task',
        displayName: 'Parent Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtaskOrder: ['sub1'],
        subtasks: [
          {
            key: 'sub1',
            title: 'Subtask 1',
            statusLabel: 'active',
            createdAt: '2026-07-01',
            updatedAt: '2026-07-01',
          },
        ],
      };

      // Body has a mismatched subtask heading ("Wrong Title" instead of "Subtask 1")
      const body = `# Parent Task

## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Wrong Title

#### Current Status
Sub status
#### Notes
Sub notes`;

      const result = parseTaskNote(frontmatter, body);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('Subtask 1'))).toBe(true);
      }
    });

    it('should parse the worked example from the spec', () => {
      // This is the exact example from the specification
      const frontmatter = {
        type: 'task',
        cssclass: 'twb-task-note',
        statusLabel: 'active',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-15',
        dueDate: '2026-07-25',
        priority: 3,
        priorityMode: 'auto',
        tags: ['foo'],
        completed: false,
        displayName: 'サンプル案件',
        ganttEnabled: true,
        ganttOrder: 1000,
        subtaskOrder: ['design', 'impl'],
        subtasks: [
          {
            key: 'design',
            title: '設計',
            statusLabel: 'done',
            createdAt: '2026-07-01',
            updatedAt: '2026-07-05',
            dueDate: '2026-07-05',
            plannedStartDate: '2026-07-01',
            plannedEndDate: '2026-07-03',
            workloadPlan: { '2026-07-01': 4, '2026-07-02': 4 },
            workloadActual: { '2026-07-01': 3.5 },
            priority: 2,
            priorityMode: 'manual',
            tags: ['urgent'],
            completed: true,
            markers: [{ key: 'review', title: 'レビュー', date: '2026-07-03', tags: [] }],
          },
          {
            key: 'impl',
            title: '実装',
            statusLabel: 'in_progress',
            createdAt: '2026-07-04',
            updatedAt: '2026-07-15',
            dueDate: '2026-07-20',
            plannedStartDate: '2026-07-06',
            plannedEndDate: '2026-07-18',
            workloadPlan: {},
            workloadActual: {},
            priority: 0,
            priorityMode: 'auto',
            tags: [],
            completed: false,
            markers: [],
          },
        ],
      };

      const body = `# サンプル案件
> [!info]- タスク情報
> - 状態: active
> - 期限: 2026-07-25
> - 優先度: 3
> - タグ: foo

## Current Status
親の状況メモ
## Notes
親の備考
## Subtasks

### 設計

> [!info]- サブタスク情報

#### Current Status
設計は完了済み
#### Notes
特になし

### 実装

> [!info]- サブタスク情報

#### Current Status
実装中、8割程度
#### Notes
テストはこれから`;

      const result = parseTaskNote(frontmatter, body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const note = result.note;

        expect(note.displayName).toBe('サンプル案件');
        expect(note.statusLabel).toBe('active');
        expect(note.createdAt).toBe('2026-07-01');
        expect(note.updatedAt).toBe('2026-07-15');
        expect(note.dueDate).toBe('2026-07-25');
        expect(note.priority).toBe(3);
        expect(note.priorityMode).toBe('auto');
        expect(note.tags).toEqual(['foo']);
        expect(note.completed).toBe(false);
        expect(note.ganttEnabled).toBe(true);
        expect(note.ganttOrder).toBe(1000);
        expect(note.currentStatus).toBe('親の状況メモ');
        expect(note.notes).toBe('親の備考');

        expect(note.subtasks).toHaveLength(2);

        const designSubtask = note.subtasks[0];
        expect(designSubtask.key).toBe('design');
        expect(designSubtask.title).toBe('設計');
        expect(designSubtask.statusLabel).toBe('done');
        expect(designSubtask.dueDate).toBe('2026-07-05');
        expect(designSubtask.workloadPlan).toEqual({
          '2026-07-01': 4,
          '2026-07-02': 4,
        });
        expect(designSubtask.workloadActual).toEqual({ '2026-07-01': 3.5 });
        expect(designSubtask.priority).toBe(2);
        expect(designSubtask.priorityMode).toBe('manual');
        expect(designSubtask.tags).toEqual(['urgent']);
        expect(designSubtask.completed).toBe(true);
        expect(designSubtask.markers).toHaveLength(1);
        expect(designSubtask.markers[0].key).toBe('review');
        expect(designSubtask.markers[0].title).toBe('レビュー');
        expect(designSubtask.markers[0].date).toBe('2026-07-03');
        expect(designSubtask.currentStatus).toBe('設計は完了済み');
        expect(designSubtask.notes).toBe('特になし');

        const implSubtask = note.subtasks[1];
        expect(implSubtask.key).toBe('impl');
        expect(implSubtask.title).toBe('実装');
        expect(implSubtask.statusLabel).toBe('in_progress');
        expect(implSubtask.currentStatus).toBe('実装中、8割程度');
        expect(implSubtask.notes).toBe('テストはこれから');
      }
    });
  });
});
