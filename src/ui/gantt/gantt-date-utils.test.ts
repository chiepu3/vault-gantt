import { describe, it, expect, beforeAll } from 'vitest';

// gantt-date-utils uses `declare const moment` (Obsidian runtime global).
// Provide it as a global before importing so the module initializes correctly.
import momentLib from 'moment';
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).moment = momentLib;
});

import { snapForward, snapBackward } from './gantt-date-utils';

// Use 2026-07-13 (Monday) — not a holiday.
// Note: 2026-07-20 is 海の日 so snapForward/snapBackward skip it.

describe('snapForward', () => {
  it('weekday passes through unchanged', () => {
    expect(snapForward('2026-07-13')).toBe('2026-07-13'); // Monday, not a holiday
  });

  it('Saturday → next Monday', () => {
    expect(snapForward('2026-07-11')).toBe('2026-07-13'); // Sat 7/11 → Mon 7/13
  });

  it('Sunday → Monday', () => {
    expect(snapForward('2026-07-12')).toBe('2026-07-13'); // Sun 7/12 → Mon 7/13
  });

  it('Friday passes through', () => {
    expect(snapForward('2026-07-10')).toBe('2026-07-10'); // Friday
  });

  it('Japanese holiday is skipped forward', () => {
    // 2026-07-20 is 海の日 → advances to Tue 2026-07-21
    expect(snapForward('2026-07-20')).toBe('2026-07-21');
  });

  it('Saturday before holiday → skips Sat+holiday to Tue', () => {
    // 2026-07-18 Sat → 2026-07-19 Sun → 2026-07-20 holiday → 2026-07-21 Tue
    expect(snapForward('2026-07-18')).toBe('2026-07-21');
  });
});

describe('snapBackward', () => {
  it('weekday passes through unchanged', () => {
    expect(snapBackward('2026-07-14')).toBe('2026-07-14'); // Tuesday
  });

  it('Saturday → previous Friday', () => {
    expect(snapBackward('2026-07-11')).toBe('2026-07-10'); // Sat 7/11 → Fri 7/10
  });

  it('Sunday → Friday', () => {
    expect(snapBackward('2026-07-12')).toBe('2026-07-10'); // Sun 7/12 → Fri 7/10
  });

  it('Monday passes through', () => {
    expect(snapBackward('2026-07-13')).toBe('2026-07-13'); // Monday, not a holiday
  });

  it('Japanese holiday is skipped backward', () => {
    // 2026-07-20 is 海の日 → retreats to Fri 2026-07-17
    expect(snapBackward('2026-07-20')).toBe('2026-07-17');
  });
});
