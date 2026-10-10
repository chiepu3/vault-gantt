import { diffDays } from "../app/gantt-layout";
import { isPeriodComplete, isPeriodEmpty, periodText, scheduleDelta, type SchedulePeriod } from "./schedule-summary";

type Schedule = { readonly before: SchedulePeriod; readonly after: SchedulePeriod };
export function compactDelta(schedule: Schedule): string {
  const { before, after } = schedule;
  if (isPeriodEmpty(after)) return isPeriodEmpty(before) ? "未設定" : "解除";
  if (!isPeriodComplete(after) || !isPeriodComplete(before)) return isPeriodEmpty(before) && isPeriodComplete(after) ? "設定" : "片日のみ";
  const shift = diffDays(before.start as string, after.start as string);
  const duration = diffDays(after.start as string, after.end as string) - diffDays(before.start as string, before.end as string);
  const signed = (days: number) => (days > 0 ? "+" : "") + days + "d";
  return [shift ? signed(shift) : "", duration ? "期間" + signed(duration) : ""].filter(Boolean).join(" · ") || "変更なし";
}

/** Both rows share one axis; only presentation changes, never the schedules.
 * A one-sided period is a single tick with an explicit "未設定" note, never a zero-day bar. */
export function renderScheduleTimeline(parent: HTMLElement, schedule: Schedule): void {
  const create = (tag: string, className: string, target = parent): HTMLElement => {
    const element = document.createElement(tag); element.className = className; target.appendChild(element); return element;
  };
  const figure = create("div", "vg-ai-mini-timeline");
  const summary = `前: ${periodText(schedule.before)} → 後: ${periodText(schedule.after)} · ${scheduleDelta(schedule)}`;
  figure.setAttribute("role", "img"); figure.setAttribute("aria-label", summary); figure.title = summary;
  const dates = [schedule.before, schedule.after].flatMap(period => [period.start, period.end].filter((date): date is string => !!date)).sort();
  const base = dates[0]; const end = dates[dates.length - 1];
  const days = base && end ? diffDays(base, end) + 1 : 0;
  const axis = create("div", "vg-ai-mini-axis", figure);
  create("span", "", axis).textContent = base?.slice(5).replace("-", "/") ?? "未設定";
  create("span", "vg-ai-mini-delta", axis).textContent = compactDelta(schedule);
  create("span", "", axis).textContent = end?.slice(5).replace("-", "/") ?? "";
  for (const [name, period] of [["before", schedule.before], ["after", schedule.after]] as const) {
    const row = create("div", "vg-ai-mini-row vg-ai-mini-" + name, figure);
    create("span", "vg-ai-mini-label", row).textContent = name === "before" ? "前" : "後";
    const track = create("div", "vg-ai-mini-track", row);
    if (base && days > 0 && period.start && period.end) {
      const bar = create("span", "vg-ai-mini-bar", track);
      bar.style.left = diffDays(base, period.start) / days * 100 + "%";
      bar.style.width = (diffDays(period.start, period.end) + 1) / days * 100 + "%";
    } else if (base && days > 0 && (period.start || period.end)) {
      const date = (period.start ?? period.end) as string;
      const tick = create("span", "vg-ai-mini-tick", track);
      tick.style.left = diffDays(base, date) / days * 100 + "%";
      tick.style.width = 100 / days + "%";
      create("span", "vg-ai-mini-unset", track).textContent = period.start ? "終了日未設定" : "開始日未設定";
    } else create("span", "vg-ai-mini-unset", track).textContent = "未設定";
  }
}
