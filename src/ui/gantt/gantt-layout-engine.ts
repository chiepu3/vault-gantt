import type { Subtask } from '../../domain/task-note/types';
import { diffDays } from './gantt-date-utils';

export interface BarLayout {
  subtask: Subtask;
  start: string;
  end: string;
  lane: number;
}

export interface PackResult {
  bars: BarLayout[];
  laneCount: number;
}

export function packSubtasksIntoLanes(subtasks: Subtask[]): PackResult {
  const bars: BarLayout[] = (subtasks ?? [])
    .filter((st) => st.plannedStartDate && st.plannedEndDate)
    .map((st) => ({
      subtask: st,
      start: st.plannedStartDate as string,
      end: st.plannedEndDate as string,
      lane: 0,
    }))
    .sort(
      (a, b) =>
        a.start.localeCompare(b.start) ||
        a.end.localeCompare(b.end) ||
        a.subtask.title.localeCompare(b.subtask.title),
    );

  const laneEnds: string[] = [];

  for (const bar of bars) {
    let placed = false;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] < bar.start) {
        bar.lane = i;
        laneEnds[i] = bar.end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bar.lane = laneEnds.length;
      laneEnds.push(bar.end);
    }
  }

  return { bars, laneCount: Math.max(1, laneEnds.length) };
}

export function barLeftPx(baseDate: string, barStart: string, dayWidth: number): number {
  return diffDays(baseDate, barStart) * dayWidth;
}

export function barWidthPx(barStart: string, barEnd: string, dayWidth: number): number {
  return Math.max(8, (diffDays(barStart, barEnd) + 1) * dayWidth - 4);
}

export function laneTopPx(laneIndex: number, laneBaseHeight: number): number {
  return 8 + laneIndex * laneBaseHeight;
}
