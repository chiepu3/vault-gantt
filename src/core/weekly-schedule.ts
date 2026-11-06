import type { WeeklyWorkSchedule } from "./types";

/** True when a weekly schedule counts on `date` (YYYY-MM-DD): its weekday matches and the date is inside its optional start/end range. */
export function weeklyScheduleCountsOn(
  schedule: Pick<WeeklyWorkSchedule, "dayOfWeek" | "startDate" | "endDate">,
  date: string,
  dayOfWeek: number
): boolean {
  if (schedule.dayOfWeek !== dayOfWeek) return false;
  if (schedule.startDate && date < schedule.startDate) return false;
  if (schedule.endDate && date > schedule.endDate) return false;
  return true;
}
