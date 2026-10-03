import { diffDays } from "../app/gantt-layout";
import type { ScheduleGhost } from "../app/schedule-ghost";

type Period = ScheduleGhost["before"];
export function periodText(period: Period): string {
  return period.start && period.end ? `${period.start} ～ ${period.end}` : "日程未設定";
}

// Presentation only. Reuse the chart's day arithmetic; never modify schedules.
export function scheduleDelta(schedule: Pick<ScheduleGhost, "before" | "after">): string {
  const { before, after } = schedule;
  if (!after.start || !after.end) return before.start && before.end ? "日程解除" : "日程未設定";
  if (!before.start || !before.end) return "日程設定";
  const movement = diffDays(before.start, after.start);
  const duration = diffDays(after.start, after.end) - diffDays(before.start, before.end);
  const parts: string[] = [];
  if (movement) parts.push(`${Math.abs(movement)}日${movement > 0 ? "後ろ" : "前"}へ`);
  if (duration) parts.push(`期間を${Math.abs(duration)}日${duration > 0 ? "延長" : "短縮"}`);
  return parts.join(" · ") || "日程変更なし";
}
