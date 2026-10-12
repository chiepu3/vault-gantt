import type { ScheduleGhost } from "../app/schedule-ghost";
import { diffDays } from "../app/gantt-layout";
import { periodText, scheduleDelta } from "./schedule-summary";

// Geometry uses exactly the existing Gantt day scale; never affects lane packing.
// "saved": the live bar is the new state and the dashed band is the old one.
// "proposed": the live bar is still the current (old) state and the dashed band is the proposal.
export type GhostMode = "saved" | "proposed";
export function renderGhost(timeline: HTMLElement, ghost: ScheduleGhost, baseDate: string, dayWidth: number, top: number, current?: HTMLElement, mode: GhostMode = "saved"): HTMLElement[] {
  if (current) current.classList.add("vg-ai-target");
  const inlineWidth = (timeline.style.width ?? "").trim();
  const limit = timeline.clientWidth || (inlineWidth.endsWith("px") ? Number.parseFloat(inlineWidth) : 0) || Infinity;
  const delta = scheduleDelta(ghost);
  const afterLeft = ghost.after.start ? diffDays(baseDate, ghost.after.start) * dayWidth : 0;
  const afterRight = ghost.after.end ? (diffDays(baseDate, ghost.after.end) + 1) * dayWidth - 4 : 0;
  const proposed = mode === "proposed";
  // The band shows the proposal in proposed mode, so the live bar's clipping is irrelevant there.
  const afterClipped = !proposed && !!current && (afterLeft < 0 || afterRight > limit);
  const targetNote = ghost.after.start && ghost.after.end ? (afterRight <= 0 || afterLeft >= limit ? "変更後は表示範囲外" : "変更後のバーは非表示") : "変更後: 日程未設定";
  const summary = `${ghost.name}: 変更前 ${periodText(ghost.before)} → 変更後 ${periodText(ghost.after)} · ${delta}` + (afterClipped ? "（変更後は一部範囲外）" : !current ? `（${targetNote}）` : "");
  const label = document.createElement("span"); label.className = "vg-ai-target-label";
  label.textContent = current || proposed ? `→ ${delta}` + (afterClipped ? " · 後は一部範囲外" : "") : `${targetNote} · ${delta}`;
  label.title = summary;
  label.style.top = Math.max(0, top - 8) + "px";
  label.style.left = Math.max(0, Math.min(afterLeft, Math.max(0, limit - 140))) + "px";
  label.style.maxWidth = Math.min(240, limit) + "px";
  timeline.appendChild(label);
  const band = proposed ? ghost.after : ghost.before;
  if (!band.start || !band.end) return [label];

  const oldLeft = diffDays(baseDate, band.start) * dayWidth;
  const oldWidth = Math.max(8, (diffDays(band.start, band.end) + 1) * dayWidth - 4);
  const left = Math.max(0, Math.min(oldLeft, limit));
  const right = Math.max(0, Math.min(oldLeft + oldWidth, limit));
  const old = document.createElement("div"); old.className = "vg-ai-ghost" + (proposed ? " is-proposed" : "");
  old.setAttribute("role", "img"); old.setAttribute("aria-label", summary);
  old.title = summary;
  old.style.top = Math.max(0, top - 8) + "px";
  if (right <= left) {
    // Keep an explicit edge annotation instead of a misleading in-range bar.
    old.classList.add("is-outside");
    const side = proposed ? "案" : "前";
    old.textContent = oldLeft < 0 ? `◀ ${side}は範囲外` : `${side}は範囲外 ▶`;
    old.style.left = oldLeft < 0 ? "0px" : Math.max(0, limit - 92) + "px";
    old.style.width = Math.min(92, limit) + "px";
    old.title += proposed ? "（変更案は表示範囲外）" : "（変更前は表示範囲外）";
  } else {
    old.textContent = right - left >= 28 ? (proposed ? "案" : "前") : "";
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

/** A deadline or marker that moves, appears or disappears. Dates only; no schedule is implied. */
export interface PointGhost { kind: "deadline" | "marker"; key: string; label: string; before: string | null; after: string | null }
const POINT_GLYPH = { deadline: "⚑", marker: "◆" } as const;
const POINT_NOUN = { deadline: "期限", marker: "マーカー" } as const;

/** Same day scale and clipping as renderGhost. Glyph + text carry the meaning, not color. */
export function renderPointGhosts(timeline: HTMLElement, points: readonly PointGhost[], baseDate: string, dayWidth: number, top: number): HTMLElement[] {
  const inlineWidth = (timeline.style.width ?? "").trim();
  const limit = timeline.clientWidth || (inlineWidth.endsWith("px") ? Number.parseFloat(inlineWidth) : 0) || Infinity;
  const nodes: HTMLElement[] = [];
  const add = (className: string, text: string, left: number, title: string): HTMLElement => {
    const node = document.createElement("span"); node.className = className; node.textContent = text; node.title = title;
    node.setAttribute("role", "img"); node.setAttribute("aria-label", title);
    node.style.top = Math.max(0, top - 10) + "px"; node.style.left = left + "px";
    timeline.appendChild(node); nodes.push(node); return node;
  };
  for (const point of points) {
    const noun = POINT_NOUN[point.kind]; const glyph = POINT_GLYPH[point.kind];
    const summary = `${noun}「${point.label}」: 前 ${point.before ?? "未設定"} → 後 ${point.after ?? "未設定"}`;
    const edge = (date: string, side: "前" | "後"): void => {
      const x = diffDays(baseDate, date) * dayWidth + dayWidth / 2 - 6;
      const className = "vg-pv-live-point is-" + (side === "前" ? "before" : "after") + (point.kind === "deadline" ? " is-deadline" : "") + (side === "後" && !point.after ? " is-removed" : "");
      if (x + 12 <= 0 || x >= limit) {
        const left = x < 0 ? 0 : Math.max(0, limit - 110);
        add("vg-pv-live-edge", `${x < 0 ? "◀ " : ""}${noun}${side}は範囲外${x < 0 ? "" : " ▶"}`, left, summary + `（${side}は表示範囲外）`);
      } else add(className, glyph, x, summary + (side === "前" ? "（変更前）" : "（変更後）"));
    };
    if (point.before) edge(point.before, "前");
    if (point.after) edge(point.after, "後");
    else if (point.before) {
      const x = diffDays(baseDate, point.before) * dayWidth + dayWidth / 2 + 8;
      if (x > 0 && x < limit) add("vg-pv-live-note", "削除", x, summary);
    }
    if (!point.before && point.after) {
      const x = diffDays(baseDate, point.after) * dayWidth + dayWidth / 2 + 8;
      if (x > 0 && x < limit) add("vg-pv-live-note", "追加", x, summary);
    }
  }
  return nodes;
}
