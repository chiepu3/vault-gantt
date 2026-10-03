import type { ScheduleGhost } from "../app/schedule-ghost";
import { diffDays } from "../app/gantt-layout";
import { periodText, scheduleDelta } from "./schedule-summary";

// Geometry uses exactly the existing Gantt day scale; never affects lane packing.
export function renderGhost(timeline: HTMLElement, ghost: ScheduleGhost, baseDate: string, dayWidth: number, top: number, current?: HTMLElement): HTMLElement[] {
  if (current) current.classList.add("vg-ai-target");
  const inlineWidth = (timeline.style.width ?? "").trim();
  const limit = timeline.clientWidth || (inlineWidth.endsWith("px") ? Number.parseFloat(inlineWidth) : 0) || Infinity;
  const delta = scheduleDelta(ghost);
  const afterLeft = ghost.after.start ? diffDays(baseDate, ghost.after.start) * dayWidth : 0;
  const afterRight = ghost.after.end ? (diffDays(baseDate, ghost.after.end) + 1) * dayWidth - 4 : 0;
  const afterClipped = !!current && (afterLeft < 0 || afterRight > limit);
  const targetNote = ghost.after.start && ghost.after.end ? (afterRight <= 0 || afterLeft >= limit ? "変更後は表示範囲外" : "変更後のバーは非表示") : "変更後: 日程未設定";
  const summary = `${ghost.name}: 変更前 ${periodText(ghost.before)} → 変更後 ${periodText(ghost.after)} · ${delta}` + (afterClipped ? "（変更後は一部範囲外）" : !current ? `（${targetNote}）` : "");
  const label = document.createElement("span"); label.className = "vg-ai-target-label";
  label.textContent = current ? `→ ${delta}` + (afterClipped ? " · 後は一部範囲外" : "") : `${targetNote} · ${delta}`;
  label.title = summary;
  label.style.top = Math.max(0, top - 8) + "px";
  label.style.left = Math.max(0, Math.min(afterLeft, Math.max(0, limit - 140))) + "px";
  label.style.maxWidth = Math.min(240, limit) + "px";
  timeline.appendChild(label);
  if (!ghost.before.start || !ghost.before.end) return [label];

  const oldLeft = diffDays(baseDate, ghost.before.start) * dayWidth;
  const oldWidth = Math.max(8, (diffDays(ghost.before.start, ghost.before.end) + 1) * dayWidth - 4);
  const left = Math.max(0, Math.min(oldLeft, limit));
  const right = Math.max(0, Math.min(oldLeft + oldWidth, limit));
  const old = document.createElement("div"); old.className = "vg-ai-ghost";
  old.setAttribute("role", "img"); old.setAttribute("aria-label", summary);
  old.title = summary;
  old.style.top = Math.max(0, top - 8) + "px";
  if (right <= left) {
    // Keep an explicit edge annotation instead of a misleading in-range bar.
    old.classList.add("is-outside");
    old.textContent = oldLeft < 0 ? "◀ 前は範囲外" : "前は範囲外 ▶";
    old.style.left = oldLeft < 0 ? "0px" : Math.max(0, limit - 92) + "px";
    old.style.width = Math.min(92, limit) + "px";
    old.title += "（変更前は表示範囲外）";
  } else {
    old.textContent = right - left >= 28 ? "前" : "";
    old.style.left = left + "px";
    old.style.width = right - left + "px";
    if (oldLeft < 0) old.classList.add("is-clipped-start");
    if (oldLeft + oldWidth > limit) old.classList.add("is-clipped-end");
    if (oldLeft < 0 || oldLeft + oldWidth > limit) old.title += "（表示範囲で切り取り）";
  }
  timeline.appendChild(old);
  const bandLeft = Number.parseFloat(old.style.left);
  const bandRight = bandLeft + Number.parseFloat(old.style.width);
  const preferred = Math.min(240, label.textContent.length * 11 + 8);
  if (limit - bandRight - 6 >= preferred) {
    label.style.left = bandRight + 6 + "px";
    label.style.maxWidth = limit - bandRight - 6 + "px";
  } else if (bandLeft - 6 >= preferred) {
    label.style.left = bandLeft - 6 - preferred + "px";
    label.style.maxWidth = preferred + "px";
  } else {
    // No label space: the compact mark and full hover/card summary remain.
    label.classList.add("is-compact");
    const noteFits = !current && bandRight - bandLeft >= 64;
    label.textContent = noteFits ? (ghost.after.start && ghost.after.end ? (targetNote.includes("範囲外") ? "後:範囲外" : "後:非表示") : "後:未設定") : "↔";
    label.style.left = Math.max(0, noteFits ? bandLeft + 8 : bandLeft + (bandRight - bandLeft) / 2 - 6) + "px";
    label.style.maxWidth = Math.max(0, bandRight - bandLeft - (noteFits ? 16 : 0)) + "px";
    old.textContent = old.classList.contains("is-outside") ? old.textContent : "";
    if (old.classList.contains("is-outside") || bandRight - bandLeft < 28) label.hidden = true;
  }
  return [label, old];
}
