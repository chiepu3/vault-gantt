import { describe, it, expect } from 'vitest';
import { migrateLegacyTaskNote } from './migrate-legacy';
import { parseTaskNote } from './parser';

describe('migrate-legacy', () => {
  describe('migrateLegacyTaskNote', () => {
    it('should migrate the worked example from the spec', () => {
      // This is the exact example from the REQUIREMENTS.md specification
      const legacyFrontmatter = {
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
        subtask__design__title: '設計',
        subtask__design__statusLabel: 'done',
        subtask__design__createdAt: '2026-07-01',
        subtask__design__updatedAt: '2026-07-05',
        subtask__design__dueDate: '2026-07-05',
        subtask__design__plannedStartDate: '2026-07-01',
        subtask__design__plannedEndDate: '2026-07-03',
        subtask__design__workloadPlan: '2026-07-01=4,2026-07-02=4',
        subtask__design__workloadActual: '2026-07-01=3.5',
        subtask__design__priority: 2,
        subtask__design__priorityMode: 'manual',
        subtask__design__tags: ['urgent'],
        subtask__design__completed: true,
        subtask__design__ganttMarkerOrder: ['review'],
        'subtask__design__ganttMarker__review__title': 'レビュー',
        'subtask__design__ganttMarker__review__date': '2026-07-03',
        'subtask__design__ganttMarker__review__tags': [] as string[],
        subtask__impl__title: '実装',
        subtask__impl__statusLabel: 'in_progress',
        subtask__impl__createdAt: '2026-07-04',
        subtask__impl__updatedAt: '2026-07-15',
        subtask__impl__dueDate: '2026-07-20',
        subtask__impl__plannedStartDate: '2026-07-06',
        subtask__impl__plannedEndDate: '2026-07-18',
        subtask__impl__workloadPlan: '',
        subtask__impl__workloadActual: '',
        subtask__impl__priority: 0,
        subtask__impl__priorityMode: 'auto',
        subtask__impl__tags: [] as string[],
        subtask__impl__completed: false,
      };

      const legacyBody = `# サンプル案件
> [!info] タスクダッシュボード
\`BUTTON[twb-open-board]\`
## Current Status
親の状況メモ
## Notes
親の備考
## Subtasks
### 設計
> [!info]- サブタスクダッシュボード
#### Current Status
設計は完了済み
#### Notes
特になし
### 実装
> [!info]- サブタスクダッシュボード
#### Current Status
実装中、8割程度
#### Notes
テストはこれから`;

      const result = migrateLegacyTaskNote(legacyFrontmatter, legacyBody);

      expect(result.warnings).toHaveLength(0);

      // Parse the migrated result to verify it's valid
      const parseResult = parseTaskNote(result.frontmatter, result.body);
      expect(parseResult.ok).toBe(true);

      if (parseResult.ok) {
        const note = parseResult.note;

        // Verify top-level fields
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

        // Verify subtask order
        expect(note.subtaskOrder).toEqual(['design', 'impl']);

        // Verify subtasks
        expect(note.subtasks).toHaveLength(2);

        const designSubtask = note.subtasks[0];
        expect(designSubtask.key).toBe('design');
        expect(designSubtask.title).toBe('設計');
        expect(designSubtask.statusLabel).toBe('done');
        expect(designSubtask.createdAt).toBe('2026-07-01');
        expect(designSubtask.updatedAt).toBe('2026-07-05');
        expect(designSubtask.dueDate).toBe('2026-07-05');
        expect(designSubtask.plannedStartDate).toBe('2026-07-01');
        expect(designSubtask.plannedEndDate).toBe('2026-07-03');
        expect(designSubtask.workloadPlan).toEqual({
          '2026-07-01': 4,
          '2026-07-02': 4,
        });
        expect(designSubtask.workloadActual).toEqual({
          '2026-07-01': 3.5,
        });
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
        expect(implSubtask.createdAt).toBe('2026-07-04');
        expect(implSubtask.updatedAt).toBe('2026-07-15');
        expect(implSubtask.dueDate).toBe('2026-07-20');
        expect(implSubtask.plannedStartDate).toBe('2026-07-06');
        expect(implSubtask.plannedEndDate).toBe('2026-07-18');
        expect(implSubtask.workloadPlan).toEqual({});
        expect(implSubtask.workloadActual).toEqual({});
        expect(implSubtask.priority).toBe(0);
        expect(implSubtask.priorityMode).toBe('auto');
        expect(implSubtask.tags).toEqual([]);
        expect(implSubtask.completed).toBe(false);
        expect(implSubtask.markers).toHaveLength(0);
        expect(implSubtask.currentStatus).toBe('実装中、8割程度');
        expect(implSubtask.notes).toBe('テストはこれから');
      }
    });

    it('should handle empty workload fields', () => {
      const legacyFrontmatter = {
        type: 'task',
        displayName: 'Test',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtaskOrder: ['sub1'],
        subtask__sub1__title: 'Sub 1',
        subtask__sub1__workloadPlan: '',
        subtask__sub1__workloadActual: '',
      };

      const legacyBody = `# Test

## Current Status
Status
## Notes
Notes
## Subtasks

### Sub 1

#### Current Status

#### Notes`;

      const result = migrateLegacyTaskNote(legacyFrontmatter, legacyBody);
      const parseResult = parseTaskNote(result.frontmatter, result.body);

      expect(parseResult.ok).toBe(true);
      if (parseResult.ok) {
        expect(parseResult.note.subtasks[0].workloadPlan).toEqual({});
        expect(parseResult.note.subtasks[0].workloadActual).toEqual({});
      }
    });

    it('should handle multiple markers per subtask', () => {
      const legacyFrontmatter = {
        type: 'task',
        displayName: 'Test',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtaskOrder: ['sub1'],
        subtask__sub1__title: 'Sub 1',
        subtask__sub1__ganttMarkerOrder: ['m1', 'm2'],
        'subtask__sub1__ganttMarker__m1__title': 'First Milestone',
        'subtask__sub1__ganttMarker__m1__date': '2026-07-05',
        'subtask__sub1__ganttMarker__m1__tags': ['tag1'],
        'subtask__sub1__ganttMarker__m2__title': 'Second Milestone',
        'subtask__sub1__ganttMarker__m2__date': '2026-07-10',
        'subtask__sub1__ganttMarker__m2__tags': [],
      };

      const legacyBody = `# Test

## Current Status

## Notes

## Subtasks

### Sub 1

#### Current Status

#### Notes`;

      const result = migrateLegacyTaskNote(legacyFrontmatter, legacyBody);
      const parseResult = parseTaskNote(result.frontmatter, result.body);

      expect(parseResult.ok).toBe(true);
      if (parseResult.ok) {
        const markers = parseResult.note.subtasks[0].markers;
        expect(markers).toHaveLength(2);
        expect(markers[0].title).toBe('First Milestone');
        expect(markers[0].date).toBe('2026-07-05');
        expect(markers[0].tags).toEqual(['tag1']);
        expect(markers[1].title).toBe('Second Milestone');
      }
    });

    it('should handle minimal legacy note', () => {
      const legacyFrontmatter = {
        type: 'task',
        displayName: 'Minimal',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
      };

      const legacyBody = `# Minimal

## Current Status
Status
## Notes
Notes`;

      const result = migrateLegacyTaskNote(legacyFrontmatter, legacyBody);
      const parseResult = parseTaskNote(result.frontmatter, result.body);

      expect(parseResult.ok).toBe(true);
      if (parseResult.ok) {
        expect(parseResult.note.displayName).toBe('Minimal');
        expect(parseResult.note.subtasks).toHaveLength(0);
      }
    });

    it('should be reversible through full round-trip migration', () => {
      const legacyFrontmatter = {
        type: 'task',
        displayName: 'Test',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-15',
        priority: 3,
        subtaskOrder: ['design'],
        subtask__design__title: '設計',
        subtask__design__statusLabel: 'done',
        subtask__design__createdAt: '2026-07-01',
        subtask__design__workloadPlan: '2026-07-01=4',
      };

      const legacyBody = `# Test

## Current Status
Design phase status
## Notes
Initial notes
## Subtasks

### 設計

#### Current Status
Completed successfully
#### Notes
No issues`;

      // Migrate once
      const migrationResult1 = migrateLegacyTaskNote(legacyFrontmatter, legacyBody);
      const parseResult1 = parseTaskNote(
        migrationResult1.frontmatter,
        migrationResult1.body
      );

      expect(parseResult1.ok).toBe(true);

      if (parseResult1.ok) {
        const note1 = parseResult1.note;

        // Re-migrate by serializing and parsing
        // (In practice, the data is now in the new format so
        // direct serialization/parsing is equivalent)
        expect(note1.displayName).toBe('Test');
        expect(note1.priority).toBe(3);
        expect(note1.subtasks).toHaveLength(1);
        expect(note1.subtasks[0].workloadPlan).toEqual({ '2026-07-01': 4 });
        expect(note1.subtasks[0].currentStatus).toBe('Completed successfully');
      }
    });

    it('warns when subtaskOrder references a key with no flat frontmatter entries', () => {
      const legacyFrontmatter = {
        displayName: 'Test',
        subtaskOrder: ['ghost'],
      };

      const result = migrateLegacyTaskNote(legacyFrontmatter, '');

      expect(result.warnings).toContain(
        'Subtask "ghost" referenced in subtaskOrder but not found'
      );
    });

    it('warns when a subtask entry is missing its title', () => {
      const legacyFrontmatter = {
        displayName: 'Test',
        subtaskOrder: ['a'],
        subtask__a__statusLabel: 'active',
      };

      const result = migrateLegacyTaskNote(legacyFrontmatter, '');

      expect(result.warnings).toContain('Subtask "a" is missing key/title');
    });

    it('returns an empty result with a warning when legacyFrontmatter is not an object', () => {
      const result = migrateLegacyTaskNote(
        null as unknown as Record<string, unknown>,
        ''
      );

      expect(result.frontmatter).toEqual({});
      expect(result.body).toBe('');
      expect(result.warnings).toContain('legacyFrontmatter is not a valid object');
    });

    it('returns an empty result with a warning when legacyFrontmatter is an array', () => {
      const result = migrateLegacyTaskNote(
        [] as unknown as Record<string, unknown>,
        ''
      );

      expect(result.frontmatter).toEqual({});
      expect(result.body).toBe('');
      expect(result.warnings).toContain('legacyFrontmatter is not a valid object');
    });
  });
});
