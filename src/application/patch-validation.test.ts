import { describe, it, expect } from 'vitest';
import { validateParentPatch, validateSubtaskPatch } from './patch-validation';
import type { Marker } from '../domain/task-note/types';

describe('patch-validation', () => {
  describe('validateParentPatch', () => {
    it('should accept valid parent patch with single field', () => {
      const result = validateParentPatch({ displayName: 'New Task' });
      expect(result.ok).toBe(true);
    });

    it('should accept valid parent patch with multiple fields', () => {
      const result = validateParentPatch({
        displayName: 'New Task',
        priority: 3,
        tags: ['urgent'],
        completed: false,
      });
      expect(result.ok).toBe(true);
    });

    it('should reject unknown field on parent', () => {
      const result = validateParentPatch({ unknownField: 'value' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('Unknown field'))).toBe(true);
      }
    });

    it('should reject invalid displayName type', () => {
      const result = validateParentPatch({ displayName: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('displayName must be a string'))).toBe(true);
      }
    });

    it('should reject invalid dueDate format', () => {
      const result = validateParentPatch({ dueDate: 'invalid-date' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('dueDate must be null or YYYY-MM-DD'))).toBe(true);
      }
    });

    it('should accept null dueDate', () => {
      const result = validateParentPatch({ dueDate: null });
      expect(result.ok).toBe(true);
    });

    it('should accept valid dueDate format', () => {
      const result = validateParentPatch({ dueDate: '2026-07-25' });
      expect(result.ok).toBe(true);
    });

    it('should reject invalid priority (out of range)', () => {
      const result = validateParentPatch({ priority: 6 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('priority must be an integer between 0 and 5'))).toBe(true);
      }
    });

    it('should reject invalid priority (float)', () => {
      const result = validateParentPatch({ priority: 2.5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('priority must be an integer between 0 and 5'))).toBe(true);
      }
    });

    it('should accept valid priority range 0-5', () => {
      for (let i = 0; i <= 5; i++) {
        const result = validateParentPatch({ priority: i });
        expect(result.ok).toBe(true);
      }
    });

    it('should reject invalid priorityMode', () => {
      const result = validateParentPatch({ priorityMode: 'invalid' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("priorityMode must be 'auto' or 'manual'"))).toBe(true);
      }
    });

    it('should accept valid priorityMode values', () => {
      const result1 = validateParentPatch({ priorityMode: 'auto' });
      const result2 = validateParentPatch({ priorityMode: 'manual' });
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });

    it('should reject invalid tags type', () => {
      const result = validateParentPatch({ tags: 'not-an-array' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('tags must be a string array'))).toBe(true);
      }
    });

    it('should accept valid tags array', () => {
      const result = validateParentPatch({ tags: ['tag1', 'tag2'] });
      expect(result.ok).toBe(true);
    });

    it('should reject invalid completed type', () => {
      const result = validateParentPatch({ completed: 'yes' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('completed must be a boolean'))).toBe(true);
      }
    });

    it('should collect multiple validation errors', () => {
      const result = validateParentPatch({
        displayName: 123,
        priority: 10,
        tags: 'not-array',
        unknownField: 'value',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(4);
      }
    });

    it('should accept ganttEnabled boolean', () => {
      const result = validateParentPatch({ ganttEnabled: true });
      expect(result.ok).toBe(true);
    });

    it('should reject ganttEnabled non-boolean', () => {
      const result = validateParentPatch({ ganttEnabled: 'true' });
      expect(result.ok).toBe(false);
    });

    it('should accept ganttOrder number', () => {
      const result = validateParentPatch({ ganttOrder: 100 });
      expect(result.ok).toBe(true);
    });

    it('should reject ganttOrder non-number', () => {
      const result = validateParentPatch({ ganttOrder: '100' });
      expect(result.ok).toBe(false);
    });

    it('should accept subtaskOrder string array', () => {
      const result = validateParentPatch({ subtaskOrder: ['key1', 'key2'] });
      expect(result.ok).toBe(true);
    });

    it('should reject subtaskOrder non-string-array', () => {
      const result = validateParentPatch({ subtaskOrder: ['key1', 123] });
      expect(result.ok).toBe(false);
    });
  });

  describe('validateSubtaskPatch', () => {
    it('should accept valid subtask patch', () => {
      const result = validateSubtaskPatch({ title: 'Subtask Title' });
      expect(result.ok).toBe(true);
    });

    it('should reject unknown field on subtask', () => {
      const result = validateSubtaskPatch({ unknownField: 'value' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('Unknown field'))).toBe(true);
      }
    });

    it('should reject invalid title type', () => {
      const result = validateSubtaskPatch({ title: 123 });
      expect(result.ok).toBe(false);
    });

    it('should reject invalid date fields', () => {
      const result = validateSubtaskPatch({
        dueDate: 'bad-date',
        plannedStartDate: 'also-bad',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should accept null workloadPlan', () => {
      const result = validateSubtaskPatch({ workloadPlan: {} });
      expect(result.ok).toBe(true);
    });

    it('should accept valid workloadPlan', () => {
      const result = validateSubtaskPatch({
        workloadPlan: { '2026-07-19': 4, '2026-07-20': 2.5 },
      });
      expect(result.ok).toBe(true);
    });

    it('should accept zero value in workloadPlan (delete marker)', () => {
      const result = validateSubtaskPatch({
        workloadPlan: { '2026-07-19': 0 },
      });
      expect(result.ok).toBe(true);
    });

    it('should reject invalid workloadPlan key (not YYYY-MM-DD)', () => {
      const result = validateSubtaskPatch({
        workloadPlan: { 'bad-date': 4 },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('must be YYYY-MM-DD'))).toBe(true);
      }
    });

    it('should reject workloadPlan value out of range', () => {
      const result = validateSubtaskPatch({
        workloadPlan: { '2026-07-19': 25 },
      });
      expect(result.ok).toBe(false);
    });

    it('should reject workloadPlan non-multiple-of-0.5', () => {
      const result = validateSubtaskPatch({
        workloadPlan: { '2026-07-19': 2.3 },
      });
      expect(result.ok).toBe(false);
    });

    it('should reject invalid workloadPlan structure (not object)', () => {
      const result = validateSubtaskPatch({ workloadPlan: 'invalid' });
      expect(result.ok).toBe(false);
    });

    it('should accept valid markers array', () => {
      const markers: Marker[] = [
        {
          key: 'review',
          title: 'Code Review',
          date: '2026-07-25',
          tags: ['milestone'],
        },
      ];
      const result = validateSubtaskPatch({ markers });
      expect(result.ok).toBe(true);
    });

    it('should reject duplicate marker keys', () => {
      const markers: Marker[] = [
        {
          key: 'review',
          title: 'Code Review',
          date: '2026-07-25',
          tags: [],
        },
        {
          key: 'review',
          title: 'Another Review',
          date: '2026-07-26',
          tags: [],
        },
      ];
      const result = validateSubtaskPatch({ markers });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('Duplicate marker key'))).toBe(true);
      }
    });

    it('should reject marker with empty title', () => {
      const markers: Marker[] = [
        {
          key: 'review',
          title: '',
          date: '2026-07-25',
          tags: [],
        },
      ];
      const result = validateSubtaskPatch({ markers });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('title must be a non-empty string'))).toBe(true);
      }
    });

    it('should reject marker with invalid date', () => {
      const markers: Marker[] = [
        {
          key: 'review',
          title: 'Review',
          date: 'bad-date',
          tags: [],
        },
      ];
      const result = validateSubtaskPatch({ markers });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('date must be YYYY-MM-DD'))).toBe(true);
      }
    });

    it('should reject markers with invalid structure', () => {
      const result = validateSubtaskPatch({ markers: 'not-an-array' });
      expect(result.ok).toBe(false);
    });
  });
});
