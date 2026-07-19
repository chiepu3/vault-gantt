import { describe, it, expect } from 'vitest';
import { serializeTaskNoteFrontmatter, serializeTaskNoteBody } from './serializer';
import { parseTaskNote } from './parser';
import type { TaskNote } from './types';

describe('serializer', () => {
  describe('serializeTaskNoteFrontmatter', () => {
    it('should serialize a simple task note to frontmatter', () => {
      const note: TaskNote = {
        displayName: 'Test Task',
        statusLabel: 'active',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        dueDate: '2026-07-10',
        priority: 2,
        priorityMode: 'auto',
        tags: ['tag1'],
        completed: false,
        ganttEnabled: true,
        ganttOrder: 1000,
        subtaskOrder: [],
        subtasks: [],
        currentStatus: 'Status text',
        notes: 'Notes text',
      };

      const fm = serializeTaskNoteFrontmatter(note);

      expect(fm.type).toBe('task');
      expect(fm.cssclass).toBe('vault-gantt-task');
      expect(fm.displayName).toBe('Test Task');
      expect(fm.statusLabel).toBe('active');
      expect(fm.dueDate).toBe('2026-07-10');
      expect(fm.priority).toBe(2);
      expect(fm.tags).toEqual(['tag1']);
      // currentStatus and notes should NOT be in frontmatter
      expect(Object.prototype.hasOwnProperty.call(fm, 'currentStatus')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(fm, 'notes')).toBe(false);
    });

    it('should serialize subtasks to nested array', () => {
      const note: TaskNote = {
        displayName: 'Parent',
        statusLabel: 'active',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        dueDate: null,
        priority: 0,
        priorityMode: 'auto',
        tags: [],
        completed: false,
        ganttEnabled: true,
        ganttOrder: 1000,
        subtaskOrder: ['sub1'],
        subtasks: [
          {
            key: 'sub1',
            title: 'Subtask 1',
            statusLabel: 'in_progress',
            createdAt: '2026-07-01',
            updatedAt: '2026-07-02',
            dueDate: '2026-07-10',
            plannedStartDate: '2026-07-01',
            plannedEndDate: '2026-07-05',
            workloadPlan: { '2026-07-01': 4, '2026-07-02': 2 },
            workloadActual: { '2026-07-01': 3 },
            priority: 1,
            priorityMode: 'manual',
            tags: ['urgent'],
            completed: false,
            markers: [
              {
                key: 'm1',
                title: 'Milestone 1',
                date: '2026-07-03',
                tags: [],
              },
            ],
            currentStatus: 'In progress',
            notes: 'Some notes',
          },
        ],
        currentStatus: '',
        notes: '',
      };

      const fm = serializeTaskNoteFrontmatter(note);

      expect(Array.isArray(fm.subtasks)).toBe(true);
      const subtasks = fm.subtasks as unknown[];
      expect(subtasks.length).toBe(1);
      const st = subtasks[0] as Record<string, unknown>;
      expect(st.key).toBe('sub1');
      expect(st.title).toBe('Subtask 1');
      expect(st.workloadPlan).toEqual({ '2026-07-01': 4, '2026-07-02': 2 });
      const markers = st.markers as unknown[];
      expect(markers).toHaveLength(1);
      const marker = markers[0] as Record<string, unknown>;
      expect(marker.title).toBe('Milestone 1');
    });
  });

  describe('serializeTaskNoteBody', () => {
    it('should serialize body with title and sections', () => {
      const note: TaskNote = {
        displayName: 'Test Task',
        statusLabel: 'active',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        dueDate: null,
        priority: 0,
        priorityMode: 'auto',
        tags: [],
        completed: false,
        ganttEnabled: true,
        ganttOrder: 1000,
        subtaskOrder: [],
        subtasks: [],
        currentStatus: 'This is the status',
        notes: 'This is notes',
      };

      const body = serializeTaskNoteBody(note);

      expect(body).toContain('# Test Task');
      expect(body).toContain('## Current Status');
      expect(body).toContain('This is the status');
      expect(body).toContain('## Notes');
      expect(body).toContain('This is notes');
      expect(body).not.toContain('## Subtasks');
    });

    it('should serialize body with subtasks', () => {
      const note: TaskNote = {
        displayName: 'Parent',
        statusLabel: 'active',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        dueDate: null,
        priority: 0,
        priorityMode: 'auto',
        tags: [],
        completed: false,
        ganttEnabled: true,
        ganttOrder: 1000,
        subtaskOrder: ['sub1'],
        subtasks: [
          {
            key: 'sub1',
            title: 'Subtask 1',
            statusLabel: 'in_progress',
            createdAt: '2026-07-01',
            updatedAt: '2026-07-01',
            dueDate: null,
            plannedStartDate: null,
            plannedEndDate: null,
            workloadPlan: {},
            workloadActual: {},
            priority: 0,
            priorityMode: 'auto',
            tags: [],
            completed: false,
            markers: [],
            currentStatus: 'Sub status',
            notes: 'Sub notes',
          },
        ],
        currentStatus: 'Parent status',
        notes: 'Parent notes',
      };

      const body = serializeTaskNoteBody(note);

      expect(body).toContain('# Parent');
      expect(body).toContain('## Subtasks');
      expect(body).toContain('### Subtask 1');
      expect(body).toContain('#### Current Status');
      expect(body).toContain('Sub status');
      expect(body).toContain('Sub notes');
    });

    it('should preserve special characters in content', () => {
      const note: TaskNote = {
        displayName: 'Test with 日本語',
        statusLabel: 'active',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        dueDate: null,
        priority: 0,
        priorityMode: 'auto',
        tags: [],
        completed: false,
        ganttEnabled: true,
        ganttOrder: 1000,
        subtaskOrder: [],
        subtasks: [],
        currentStatus: '日本語のステータス\nWith newline',
        notes: 'Notes with > quote\nAnd ## special chars',
      };

      const body = serializeTaskNoteBody(note);

      expect(body).toContain('日本語のステータス');
      expect(body).toContain('日本語のステータス\nWith newline');
      expect(body).toContain('Notes with > quote');
      expect(body).toContain('## special chars');
    });
  });

  describe('round-trip', () => {
    it('should round-trip a minimal note', () => {
      const originalFm = {
        type: 'task',
        displayName: 'Test Task',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
      };

      const originalBody = `# Test Task
> [!info]- タスク情報

## Current Status
Status text
## Notes
Notes text`;

      // Parse original
      const parseResult = parseTaskNote(originalFm, originalBody);
      expect(parseResult.ok).toBe(true);

      if (parseResult.ok) {
        const note = parseResult.note;

        // Serialize
        const newFm = serializeTaskNoteFrontmatter(note);
        const newBody = serializeTaskNoteBody(note);

        // Parse serialized version
        const reparseResult = parseTaskNote(newFm, newBody);
        expect(reparseResult.ok).toBe(true);

        if (reparseResult.ok) {
          const reparsedNote = reparseResult.note;
          expect(reparsedNote.displayName).toBe(note.displayName);
          expect(reparsedNote.currentStatus).toBe(note.currentStatus);
          expect(reparsedNote.notes).toBe(note.notes);
          expect(reparsedNote.subtasks).toEqual(note.subtasks);
        }
      }
    });

    it('should round-trip a note with subtasks', () => {
      const originalFm = {
        type: 'task',
        displayName: 'Parent',
        createdAt: '2026-07-01',
        updatedAt: '2026-07-01',
        subtaskOrder: ['sub1', 'sub2'],
        subtasks: [
          {
            key: 'sub1',
            title: 'Subtask 1',
            statusLabel: 'active',
            createdAt: '2026-07-01',
            updatedAt: '2026-07-01',
            dueDate: '2026-07-10',
            plannedStartDate: '2026-07-01',
            plannedEndDate: '2026-07-05',
            workloadPlan: { '2026-07-01': 4, '2026-07-02': 2 },
            workloadActual: { '2026-07-01': 3 },
            priority: 2,
            priorityMode: 'manual',
            tags: ['tag1'],
            completed: false,
            markers: [
              {
                key: 'm1',
                title: 'Milestone',
                date: '2026-07-03',
                tags: [],
              },
            ],
          },
          {
            key: 'sub2',
            title: 'Subtask 2',
            statusLabel: 'done',
            createdAt: '2026-07-02',
            updatedAt: '2026-07-03',
            dueDate: null,
            plannedStartDate: null,
            plannedEndDate: null,
            workloadPlan: {},
            workloadActual: {},
            priority: 0,
            priorityMode: 'auto',
            tags: [],
            completed: true,
            markers: [],
          },
        ],
      };

      const originalBody = `# Parent
> [!info]- タスク情報

## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Subtask 1

> [!info]- サブタスク情報

#### Current Status
Sub 1 status
#### Notes
Sub 1 notes

### Subtask 2

> [!info]- サブタスク情報

#### Current Status
Sub 2 status
#### Notes
Sub 2 notes`;

      const parseResult = parseTaskNote(originalFm, originalBody);
      expect(parseResult.ok).toBe(true);

      if (parseResult.ok) {
        const note = parseResult.note;

        // Verify original parse
        expect(note.subtasks).toHaveLength(2);
        expect(note.subtasks[0].workloadPlan).toEqual({
          '2026-07-01': 4,
          '2026-07-02': 2,
        });
        expect(note.subtasks[0].markers).toHaveLength(1);

        // Serialize and re-parse
        const newFm = serializeTaskNoteFrontmatter(note);
        const newBody = serializeTaskNoteBody(note);

        const reparseResult = parseTaskNote(newFm, newBody);
        expect(reparseResult.ok).toBe(true);

        if (reparseResult.ok) {
          const reparsedNote = reparseResult.note;

          // Verify round-trip fidelity
          expect(reparsedNote.displayName).toBe(note.displayName);
          expect(reparsedNote.subtasks).toHaveLength(2);
          expect(reparsedNote.subtasks[0].key).toBe('sub1');
          expect(reparsedNote.subtasks[0].workloadPlan).toEqual({
            '2026-07-01': 4,
            '2026-07-02': 2,
          });
          expect(reparsedNote.subtasks[0].markers).toHaveLength(1);
          expect(reparsedNote.subtasks[0].currentStatus).toBe('Sub 1 status');
          expect(reparsedNote.subtasks[0].notes).toBe('Sub 1 notes');
        }
      }
    });
  });
});
