import { describe, it, expect } from 'vitest';
import {
  calculateAutoPriority,
  DEFAULT_PRIORITY_THRESHOLDS,
} from './priority';

describe('priority', () => {
  const today = '2026-07-20'; // Monday reference date

  describe('calculateAutoPriority - basic boundaries', () => {
    it('should return noDueDate (0) when dueDate is null', () => {
      expect(calculateAutoPriority(null, today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.noDueDate
      );
    });

    it('should return overdueOrToday (5) when dueDate equals today', () => {
      expect(calculateAutoPriority('2026-07-20', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.overdueOrToday
      );
    });

    it('should return overdueOrToday (5) when dueDate is in the past (overdue)', () => {
      expect(calculateAutoPriority('2026-07-19', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.overdueOrToday
      );
    });

    it('should return overdueOrToday (5) when dueDate is far in the past', () => {
      expect(calculateAutoPriority('2026-07-01', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.overdueOrToday
      );
    });
  });

  describe('calculateAutoPriority - within3Days band (day-diff 1-3)', () => {
    it('should return within3Days (4) for day-diff of exactly 1 day', () => {
      expect(calculateAutoPriority('2026-07-21', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within3Days
      );
    });

    it('should return within3Days (4) for day-diff of exactly 2 days', () => {
      expect(calculateAutoPriority('2026-07-22', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within3Days
      );
    });

    it('should return within3Days (4) for day-diff of exactly 3 days', () => {
      expect(calculateAutoPriority('2026-07-23', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within3Days
      );
    });
  });

  describe('calculateAutoPriority - within7Days band (day-diff 4-7)', () => {
    it('should return within7Days (3) for day-diff of exactly 4 days', () => {
      expect(calculateAutoPriority('2026-07-24', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within7Days
      );
    });

    it('should return within7Days (3) for day-diff of exactly 5 days', () => {
      expect(calculateAutoPriority('2026-07-25', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within7Days
      );
    });

    it('should return within7Days (3) for day-diff of exactly 7 days', () => {
      expect(calculateAutoPriority('2026-07-27', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within7Days
      );
    });
  });

  describe('calculateAutoPriority - within14Days band (day-diff 8-14)', () => {
    it('should return within14Days (2) for day-diff of exactly 8 days', () => {
      expect(calculateAutoPriority('2026-07-28', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within14Days
      );
    });

    it('should return within14Days (2) for day-diff of exactly 10 days', () => {
      expect(calculateAutoPriority('2026-07-30', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within14Days
      );
    });

    it('should return within14Days (2) for day-diff of exactly 14 days', () => {
      expect(calculateAutoPriority('2026-08-03', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within14Days
      );
    });
  });

  describe('calculateAutoPriority - beyond band (day-diff 15+)', () => {
    it('should return beyond (1) for day-diff of exactly 15 days', () => {
      expect(calculateAutoPriority('2026-08-04', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.beyond
      );
    });

    it('should return beyond (1) for day-diff of 30 days', () => {
      expect(calculateAutoPriority('2026-08-19', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.beyond
      );
    });

    it('should return beyond (1) for day-diff of 100 days', () => {
      expect(calculateAutoPriority('2026-10-28', today)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.beyond
      );
    });
  });

  describe('calculateAutoPriority - custom thresholds', () => {
    it('should use custom thresholds instead of defaults', () => {
      const customThresholds = {
        noDueDate: 1,
        overdueOrToday: 10,
        within3Days: 8,
        within7Days: 6,
        within14Days: 4,
        beyond: 2,
      };

      expect(calculateAutoPriority(null, today, customThresholds)).toBe(1);
      expect(calculateAutoPriority('2026-07-20', today, customThresholds)).toBe(
        10
      );
      expect(calculateAutoPriority('2026-07-21', today, customThresholds)).toBe(
        8
      );
      expect(calculateAutoPriority('2026-07-24', today, customThresholds)).toBe(
        6
      );
      expect(calculateAutoPriority('2026-07-28', today, customThresholds)).toBe(
        4
      );
      expect(calculateAutoPriority('2026-08-04', today, customThresholds)).toBe(
        2
      );
    });

    it('should work with zero-valued thresholds', () => {
      const zeroThresholds = {
        noDueDate: 0,
        overdueOrToday: 0,
        within3Days: 0,
        within7Days: 0,
        within14Days: 0,
        beyond: 0,
      };

      expect(calculateAutoPriority(null, today, zeroThresholds)).toBe(0);
      expect(calculateAutoPriority('2026-07-20', today, zeroThresholds)).toBe(0);
      expect(calculateAutoPriority('2026-08-04', today, zeroThresholds)).toBe(0);
    });
  });

  describe('calculateAutoPriority - edge cases', () => {
    it('should handle dates across month boundaries correctly', () => {
      const july31 = '2026-07-31';
      const aug1 = '2026-08-01';
      expect(calculateAutoPriority(aug1, july31)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within3Days
      );
    });

    it('should handle dates across year boundaries correctly', () => {
      const dec31 = '2026-12-31';
      const jan1 = '2027-01-01';
      expect(calculateAutoPriority(jan1, dec31)).toBe(
        DEFAULT_PRIORITY_THRESHOLDS.within3Days
      );
    });
  });

  describe('DEFAULT_PRIORITY_THRESHOLDS', () => {
    it('should have the correct default values per spec', () => {
      expect(DEFAULT_PRIORITY_THRESHOLDS.overdueOrToday).toBe(5);
      expect(DEFAULT_PRIORITY_THRESHOLDS.within3Days).toBe(4);
      expect(DEFAULT_PRIORITY_THRESHOLDS.within7Days).toBe(3);
      expect(DEFAULT_PRIORITY_THRESHOLDS.within14Days).toBe(2);
      expect(DEFAULT_PRIORITY_THRESHOLDS.beyond).toBe(1);
      expect(DEFAULT_PRIORITY_THRESHOLDS.noDueDate).toBe(0);
    });
  });
});
