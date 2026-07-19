import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Subtask } from '../../domain/task-note/types';

// Mock gantt-date-utils before importing layout-engine, since diffDays uses
// window.moment which is only available in the Obsidian runtime.
vi.mock('./gantt-date-utils', () => ({
  diffDays: (a: string, b: string): number => {
    const msPerDay = 1000 * 60 * 60 * 24;
    return (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / msPerDay;
  },
}));

import { packSubtasksIntoLanes, barLeftPx, barWidthPx, laneTopPx } from './gantt-layout-engine';

function makeSubtask(title: string, start: string, end: string): Subtask {
  return {
    key: title,
    title,
    plannedStartDate: start,
    plannedEndDate: end,
    actualStartDate: null,
    actualEndDate: null,
    statusLabel: 'not-started',
    completed: false,
    priority: 0,
    plannedHours: null,
    actualHours: null,
    dailyHours: {},
    tags: [],
  };
}

describe('packSubtasksIntoLanes', () => {
  it('returns laneCount=1 for empty input', () => {
    expect(packSubtasksIntoLanes([]).laneCount).toBe(1);
  });

  it('returns laneCount=1 for single bar', () => {
    const st = makeSubtask('A', '2026-07-01', '2026-07-05');
    const { bars, laneCount } = packSubtasksIntoLanes([st]);
    expect(laneCount).toBe(1);
    expect(bars).toHaveLength(1);
    expect(bars[0].lane).toBe(0);
  });

  it('non-overlapping bars fit into same lane', () => {
    const a = makeSubtask('A', '2026-07-01', '2026-07-05');
    const b = makeSubtask('B', '2026-07-06', '2026-07-10');
    const { bars, laneCount } = packSubtasksIntoLanes([a, b]);
    expect(laneCount).toBe(1);
    expect(bars[0].lane).toBe(0);
    expect(bars[1].lane).toBe(0);
  });

  it('overlapping bars go into separate lanes', () => {
    const a = makeSubtask('A', '2026-07-01', '2026-07-10');
    const b = makeSubtask('B', '2026-07-05', '2026-07-15');
    const { bars, laneCount } = packSubtasksIntoLanes([a, b]);
    expect(laneCount).toBe(2);
    const lanes = bars.map((bar) => bar.lane);
    expect(lanes).toContain(0);
    expect(lanes).toContain(1);
  });

  it('adjacent bars (end===start) go into separate lanes (inclusive-end)', () => {
    // A ends 07-05, B starts 07-05 — they share a day, so they must not overlap
    const a = makeSubtask('A', '2026-07-01', '2026-07-05');
    const b = makeSubtask('B', '2026-07-05', '2026-07-10');
    const { laneCount } = packSubtasksIntoLanes([a, b]);
    expect(laneCount).toBe(2);
  });

  it('filters out subtasks missing planned dates', () => {
    const valid = makeSubtask('A', '2026-07-01', '2026-07-05');
    const missing = { ...makeSubtask('B', '', ''), plannedStartDate: null, plannedEndDate: null };
    const { bars } = packSubtasksIntoLanes([valid, missing]);
    expect(bars).toHaveLength(1);
    expect(bars[0].subtask.title).toBe('A');
  });

  it('packs 3 bars optimally: A and C in lane 0, B in lane 1', () => {
    const a = makeSubtask('A', '2026-07-01', '2026-07-05');
    const b = makeSubtask('B', '2026-07-03', '2026-07-08');
    const c = makeSubtask('C', '2026-07-09', '2026-07-12');
    const { bars, laneCount } = packSubtasksIntoLanes([a, b, c]);
    expect(laneCount).toBe(2);
    const byTitle = Object.fromEntries(bars.map((bar) => [bar.subtask.title, bar.lane]));
    expect(byTitle['A']).toBe(0);
    expect(byTitle['B']).toBe(1);
    expect(byTitle['C']).toBe(0);
  });
});

describe('barLeftPx', () => {
  it('returns 0 when barStart equals baseDate', () => {
    expect(barLeftPx('2026-07-01', '2026-07-01', 28)).toBe(0);
  });

  it('returns dayWidth for +1 day', () => {
    expect(barLeftPx('2026-07-01', '2026-07-02', 28)).toBe(28);
  });

  it('returns negative for barStart before baseDate', () => {
    expect(barLeftPx('2026-07-05', '2026-07-01', 28)).toBe(-112);
  });
});

describe('barWidthPx', () => {
  it('same-day bar: diffDays=0 → (0+1)*28 - 4 = 24', () => {
    expect(barWidthPx('2026-07-01', '2026-07-01', 28)).toBe(24);
  });

  it('bar ending 4 days later: diffDays=4 → (4+1)*28 - 4 = 136', () => {
    // 07-01 to 07-05 = 4 calendar days diff, inclusive = 5 slots, minus 4px gap
    expect(barWidthPx('2026-07-01', '2026-07-05', 28)).toBe(136);
  });

  it('returns at least 8 for very small dayWidth', () => {
    // dayWidth=1: (0+1)*1 - 4 = -3 → clamped to 8
    expect(barWidthPx('2026-07-01', '2026-07-01', 1)).toBe(8);
  });
});

describe('laneTopPx', () => {
  it('lane 0 returns 8', () => {
    expect(laneTopPx(0, 44)).toBe(8);
  });

  it('lane 1 returns 8 + laneBaseHeight', () => {
    expect(laneTopPx(1, 44)).toBe(52);
  });

  it('lane 2 returns 8 + 2 * laneBaseHeight', () => {
    expect(laneTopPx(2, 44)).toBe(96);
  });
});
