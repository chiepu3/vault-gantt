import { describe, it, expect } from 'vitest';
import { computeRevision, isRevisionConflict } from './revision';

describe('revision', () => {
  describe('computeRevision', () => {
    it('should generate consistent revision string from mtime and size', () => {
      const rev = computeRevision(1000, 500);
      expect(rev).toBe('1000:500');
    });

    it('should produce different revisions for different inputs', () => {
      const rev1 = computeRevision(1000, 500);
      const rev2 = computeRevision(1001, 500);
      const rev3 = computeRevision(1000, 501);
      expect(rev1).not.toBe(rev2);
      expect(rev1).not.toBe(rev3);
      expect(rev2).not.toBe(rev3);
    });
  });

  describe('isRevisionConflict', () => {
    it('should return false when revisions match', () => {
      const result = isRevisionConflict('1000:500', '1000:500');
      expect(result).toBe(false);
    });

    it('should return true when revisions differ', () => {
      const result = isRevisionConflict('1000:500', '1001:500');
      expect(result).toBe(true);
    });

    it('should detect conflict even with same mtime different size', () => {
      const result = isRevisionConflict('1000:500', '1000:501');
      expect(result).toBe(true);
    });
  });
});
