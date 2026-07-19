import { describe, it, expect } from 'vitest';
import {
  resolveCompletedStatusSync,
  DEFAULT_STATUSES,
} from './status';

describe('status', () => {
  describe('resolveCompletedStatusSync - Rule 1: statusLabel=done', () => {
    it('should add completed:true when statusLabel is done', () => {
      const patch = { statusLabel: 'done' };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({
        statusLabel: 'done',
        completed: true,
      });
    });

    it('should keep statusLabel=done and add completed:true', () => {
      const patch = { statusLabel: 'done' };
      const result = resolveCompletedStatusSync(patch);
      expect(result.statusLabel).toBe('done');
      expect(result.completed).toBe(true);
    });

    it('should override completed:false when statusLabel=done (contradictory patch)', () => {
      // Test the edge case: statusLabel='done' should win, overriding completed:false
      const patch = { statusLabel: 'done', completed: false };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({
        statusLabel: 'done',
        completed: true,
      });
    });
  });

  describe('resolveCompletedStatusSync - Rule 2: completed=true', () => {
    it('should add statusLabel=done when completed is true', () => {
      const patch = { completed: true };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({
        statusLabel: 'done',
        completed: true,
      });
    });

    it('should keep completed=true and add statusLabel=done', () => {
      const patch = { completed: true };
      const result = resolveCompletedStatusSync(patch);
      expect(result.completed).toBe(true);
      expect(result.statusLabel).toBe('done');
    });

    it('should not override statusLabel when completed=true and statusLabel is already set', () => {
      // But statusLabel is already set to something else (not via Rule 1)
      // This is a tricky case: completed: true should add statusLabel: 'done',
      // but statusLabel is already present in patch
      const patch = { completed: true, statusLabel: 'in_progress' };
      const result = resolveCompletedStatusSync(patch);
      // Rule 2 says "add statusLabel: 'done'", which means override existing
      expect(result).toEqual({
        completed: true,
        statusLabel: 'done',
      });
    });
  });

  describe('resolveCompletedStatusSync - Rule 3: completed=false and statusLabel undefined', () => {
    it('should add statusLabel=active when completed=false and statusLabel undefined', () => {
      const patch = { completed: false };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({
        completed: false,
        statusLabel: 'active',
      });
    });

    it('should keep completed=false and add statusLabel=active', () => {
      const patch = { completed: false };
      const result = resolveCompletedStatusSync(patch);
      expect(result.completed).toBe(false);
      expect(result.statusLabel).toBe('active');
    });
  });

  describe('resolveCompletedStatusSync - Rule 4: No sync needed', () => {
    it('should return empty patch unchanged', () => {
      const patch: { statusLabel?: string; completed?: boolean } = {};
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({});
    });

    it('should return statusLabel alone without completed modification', () => {
      const patch = { statusLabel: 'in_progress' };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({ statusLabel: 'in_progress' });
    });

    it('should return statusLabel=waiting without completed modification', () => {
      const patch = { statusLabel: 'waiting' };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({ statusLabel: 'waiting' });
    });

    it('should return statusLabel=hold without completed modification', () => {
      const patch = { statusLabel: 'hold' };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({ statusLabel: 'hold' });
    });

    it('should return statusLabel=active without completed modification', () => {
      const patch = { statusLabel: 'active' };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({ statusLabel: 'active' });
    });

    it('should return statusLabel and completed=false unchanged when both set', () => {
      // This is Rule 4: both are set, but statusLabel is not undefined, so Rule 3 doesn't apply
      const patch = { statusLabel: 'waiting', completed: false };
      const result = resolveCompletedStatusSync(patch);
      expect(result).toEqual({
        statusLabel: 'waiting',
        completed: false,
      });
    });
  });

  describe('resolveCompletedStatusSync - Edge cases and special scenarios', () => {
    it('should handle contradictory patch: statusLabel=done AND completed=false (rule 1 wins)', () => {
      const patch = { statusLabel: 'done', completed: false };
      const result = resolveCompletedStatusSync(patch);
      // Rule 1 checks first: statusLabel === 'done'
      // So it adds completed: true, overriding the false
      expect(result).toEqual({
        statusLabel: 'done',
        completed: true,
      });
    });

    it('should handle patch with statusLabel=waiting and completed=true', () => {
      const patch = { statusLabel: 'waiting', completed: true };
      const result = resolveCompletedStatusSync(patch);
      // Rule 1 doesn't apply (statusLabel !== 'done')
      // Rule 2 applies (completed === true), so override statusLabel to 'done'
      expect(result).toEqual({
        statusLabel: 'done',
        completed: true,
      });
    });
  });

  describe('DEFAULT_STATUSES', () => {
    it('should have the correct status definitions', () => {
      expect(DEFAULT_STATUSES).toEqual([
        { key: 'active', label: '未着手' },
        { key: 'in_progress', label: '進行中' },
        { key: 'waiting', label: '待ち' },
        { key: 'hold', label: '保留' },
        { key: 'done', label: '完了' },
      ]);
    });

    it('should have exactly 5 default statuses', () => {
      expect(DEFAULT_STATUSES.length).toBe(5);
    });
  });
});
