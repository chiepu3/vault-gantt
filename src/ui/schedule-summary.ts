import { diffDays } from "../app/gantt-layout";

/** Dates may be null or "" when unset; either side alone is a valid (one-sided) state. */
export interface SchedulePeriod { readonly start: string | null; readonly end: string | null }
type Schedule = { readonly before: SchedulePeriod; readonly after: SchedulePeriod };

export function isPeriodComplete(period: SchedulePeriod): boolean { return !!period.start && !!period.end; }
export function isPeriodEmpty(period: SchedulePeriod): boolean { return !period.start && !period.end; }
export function periodText(period: SchedulePeriod): string {
  if (period.start && period.end) return `${period.start} ～ ${period.end}`;
  // One-sided periods are shown as such; an empty bar is never invented for them.
  if (period.start) return `${period.start} ～ 終了日未設定`;
  if (period.end) return `開始日未設定 ～ ${period.end}`;
  return "日程未設定";
}

// Presentation only. Reuse the chart's day arithmetic; never modify schedules.
export function scheduleDelta(schedule: Schedule): string {
  const { before, after } = schedule;
  if (isPeriodEmpty(after)) return isPeriodEmpty(before) ? "日程未設定" : "日程解除";
  if (!isPeriodComplete(after) || !isPeriodComplete(before)) {
    if (isPeriodEmpty(before)) return isPeriodComplete(after) ? "日程設定" : "片日のみ設定";
    return isPeriodComplete(after) ? "両日を設定" : "片日のみ設定";
  }
  const movement = diffDays(before.start as string, after.start as string);
  const duration = diffDays(after.start as string, after.end as string) - diffDays(before.start as string, before.end as string);
  const parts: string[] = [];
  if (movement) parts.push(`${Math.abs(movement)}日${movement > 0 ? "後ろ" : "前"}へ`);
  if (duration) parts.push(`期間を${Math.abs(duration)}日${duration > 0 ? "延長" : "短縮"}`);
  return parts.join(" · ") || "日程変更なし";
}
