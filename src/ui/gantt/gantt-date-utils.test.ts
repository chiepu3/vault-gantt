import { describe, it, expect, beforeAll } from 'vitest';

// gantt-date-utils uses `declare const moment` (Obsidian runtime global).
// Provide it as a global before importing so the module initializes correctly.
import momentLib from 'moment';
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).moment = momentLib;
});

import { snapForward, snapBackward } from './gantt-date-utils';

describe('snapForward', () => {
  it('weekday passes through unchanged', () => {
    expect(snapForward('2026-07-20')).toBe('2026-07-20'); // Monday
  });

  it('Saturday → next Monday', () => {
    expect(snapForward('2026-07-18')).toBe('2026-07-20'); // Sat → Mon
  });

  it('Sunday → Monday', () => {
    expect(snapForward('2026-07-19')).toBe('2026-07-20'); // Sun → Mon
  });

  it('Friday passes through', () => {
    expect(snapForward('2026-07-24')).toBe('2026-07-24'); // Friday
  });
});

describe('snapBackward', () => {
  it('weekday passes through unchanged', () => {
    expect(snapBackward('2026-07-21')).toBe('2026-07-21'); // Tuesday
  });

  it('Saturday → previous Friday', () => {
    expect(snapBackward('2026-07-18')).toBe('2026-07-17'); // Sat → Fri
  });

  it('Sunday → Friday', () => {
    expect(snapBackward('2026-07-19')).toBe('2026-07-17'); // Sun → Fri
  });

  it('Monday passes through', () => {
    expect(snapBackward('2026-07-20')).toBe('2026-07-20'); // Monday
  });
});
