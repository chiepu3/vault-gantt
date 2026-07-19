import { describe, it, expect } from 'vitest';
import {
  isWeekend,
  isBusinessDay,
  addBusinessDays,
  countBusinessDaysBetween,
} from './business-days';

describe('business-days', () => {
  describe('isWeekend', () => {
    it('should return true for Saturday', () => {
      expect(isWeekend('2026-07-18')).toBe(true); // Saturday
    });

    it('should return true for Sunday', () => {
      expect(isWeekend('2026-07-19')).toBe(true); // Sunday
    });

    it('should return false for Monday', () => {
      expect(isWeekend('2026-07-20')).toBe(false); // Monday
    });

    it('should return false for Friday', () => {
      expect(isWeekend('2026-07-24')).toBe(false); // Friday
    });
  });

  describe('isBusinessDay', () => {
    const emptyHolidays = new Set<string>();

    it('should return true for weekday without holidays', () => {
      expect(isBusinessDay('2026-07-20', emptyHolidays)).toBe(true); // Monday
    });

    it('should return false for Saturday', () => {
      expect(isBusinessDay('2026-07-18', emptyHolidays)).toBe(false);
    });

    it('should return false for Sunday', () => {
      expect(isBusinessDay('2026-07-19', emptyHolidays)).toBe(false);
    });

    it('should return false for holiday on weekday', () => {
      const holidays = new Set(['2026-07-20']);
      expect(isBusinessDay('2026-07-20', holidays)).toBe(false);
    });

    it('should return true for weekday not in holidays', () => {
      const holidays = new Set(['2026-07-21']);
      expect(isBusinessDay('2026-07-20', holidays)).toBe(true);
    });
  });

  describe('addBusinessDays', () => {
    const emptyHolidays = new Set<string>();

    it('should return the same date when days=0', () => {
      expect(addBusinessDays('2026-07-20', 0, emptyHolidays)).toBe('2026-07-20');
    });

    it('should return the same date when days=0 regardless of weekday', () => {
      // Even if the date is a weekend, days=0 returns it unchanged
      expect(addBusinessDays('2026-07-18', 0, emptyHolidays)).toBe('2026-07-18');
    });

    it('should add 1 business day to a Friday', () => {
      // 2026-07-24 is Friday, next business day is Monday 2026-07-27
      expect(addBusinessDays('2026-07-24', 1, emptyHolidays)).toBe('2026-07-27');
    });

    it('should add 1 business day to a Monday', () => {
      // 2026-07-20 is Monday, next business day is Tuesday 2026-07-21
      expect(addBusinessDays('2026-07-20', 1, emptyHolidays)).toBe('2026-07-21');
    });

    it('should skip weekends', () => {
      // From Friday 2026-07-24, add 3 business days
      // Fri 24 -> Mon 27 (1) -> Tue 28 (2) -> Wed 29 (3)
      expect(addBusinessDays('2026-07-24', 3, emptyHolidays)).toBe('2026-07-29');
    });

    it('should skip holidays on weekdays', () => {
      const holidays = new Set(['2026-07-21']); // Tuesday holiday
      // From Monday 2026-07-20, add 2 business days, skipping the holiday on Tuesday
      // Mon 20 -> Wed 22 (1) -> Thu 23 (2)
      expect(addBusinessDays('2026-07-20', 2, holidays)).toBe('2026-07-23');
    });

    it('should skip both weekends and holidays', () => {
      const holidays = new Set(['2026-07-21', '2026-07-28']); // Tuesday holiday on 21st, Tuesday holiday on 28th
      // From Friday 2026-07-24, add 2 business days, skipping weekends and holidays
      // Fri 24 -> Sat 25 (skip) -> Sun 26 (skip) -> Mon 27 (1) -> Tue 28 (skip, holiday) -> Wed 29 (2)
      expect(addBusinessDays('2026-07-24', 2, holidays)).toBe('2026-07-29');
    });

    it('should land exactly on day before a holiday, not on the holiday itself', () => {
      const holidays = new Set(['2026-07-22']); // Wednesday holiday
      // From Monday 2026-07-20, add 1 business day
      // Mon 20 -> Tue 21 (1)
      expect(addBusinessDays('2026-07-20', 1, holidays)).toBe('2026-07-21');

      // From Monday 2026-07-20, add 2 business days
      // Mon 20 -> Tue 21 (1) -> Thu 23 (2, skip Wed 22 as it's a holiday)
      expect(addBusinessDays('2026-07-20', 2, holidays)).toBe('2026-07-23');
    });
  });

  describe('countBusinessDaysBetween', () => {
    const emptyHolidays = new Set<string>();

    it('should return 0 when end is before start', () => {
      expect(
        countBusinessDaysBetween('2026-07-21', '2026-07-20', emptyHolidays)
      ).toBe(0);
    });

    it('should return 1 when start and end are the same business day', () => {
      expect(
        countBusinessDaysBetween('2026-07-20', '2026-07-20', emptyHolidays)
      ).toBe(1); // Monday
    });

    it('should return 0 when start and end are the same weekend day', () => {
      expect(
        countBusinessDaysBetween('2026-07-19', '2026-07-19', emptyHolidays)
      ).toBe(0); // Sunday
    });

    it('should count business days across a single week', () => {
      // Mon 20 - Fri 24
      expect(
        countBusinessDaysBetween('2026-07-20', '2026-07-24', emptyHolidays)
      ).toBe(5);
    });

    it('should skip weekends in the range', () => {
      // Fri 24 - Mon 27 (Sat 25, Sun 26 are not counted)
      expect(
        countBusinessDaysBetween('2026-07-24', '2026-07-27', emptyHolidays)
      ).toBe(2); // Fri 24, Mon 27
    });

    it('should skip holidays in the range', () => {
      const holidays = new Set(['2026-07-21']);
      // Mon 20 - Wed 23 (Tue 21 is a holiday)
      expect(
        countBusinessDaysBetween('2026-07-20', '2026-07-23', holidays)
      ).toBe(3); // Mon 20, Wed 22, Wed 23
    });

    it('should skip both weekends and holidays in range', () => {
      const holidays = new Set(['2026-07-21', '2026-07-22']); // Tue and Wed holidays
      // Mon 20 - Fri 24 (Tue 21, Wed 22 are holidays, Sat 25-Sun 26 are weekends)
      expect(
        countBusinessDaysBetween('2026-07-20', '2026-07-24', holidays)
      ).toBe(3); // Mon 20, Thu 23, Fri 24
    });

    it('should count correctly across two weeks with weekend in between', () => {
      // Thu 23 - Mon 27
      expect(
        countBusinessDaysBetween('2026-07-23', '2026-07-27', emptyHolidays)
      ).toBe(3); // Thu 23, Fri 24, Mon 27
    });
  });
});
