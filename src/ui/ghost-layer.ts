import type { ScheduleGhost } from "../app/schedule-ghost";
import { diffDays } from "../app/gantt-layout";

// Geometry uses exactly the existing Gantt day scale; never affects lane packing.
export function renderGhost(timeline: HTMLElement, ghost: ScheduleGhost, baseDate: string, dayWidth: number, top: number, current?: HTMLElement): HTMLElement[] {
  if (current) current.classList.add("vg-ai-target");
  const label = document.createElement("span"); label.className = "vg-ai-target-label";
  label.textContent = current ? "変更後" : "変更後: 日程未設定";
  label.style.top = top + "px";
  label.style.left = (ghost.after.start ? diffDays(baseDate, ghost.after.start) * dayWidth : 0) + "px";
  timeline.appendChild(label);
  if (!ghost.before.start || !ghost.before.end) return [label];
  const old = document.createElement("div"); old.className = "vg-ai-ghost";
  old.setAttribute("role", "img"); old.setAttribute("aria-label", "変更前 " + ghost.name + ": " + ghost.before.start + " → " + ghost.before.end);
  old.title = "変更前: " + ghost.before.start + " → " + ghost.before.end;
  old.textContent = "前";
  old.style.left = diffDays(baseDate, ghost.before.start) * dayWidth + "px";
  old.style.width = Math.max(8, (diffDays(ghost.before.start, ghost.before.end) + 1) * dayWidth - 4) + "px";
  old.style.top = top + 28 + "px";
  timeline.appendChild(old);
  return [label, old];
}
