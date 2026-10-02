import { moment } from "obsidian";
import type {
  GanttEvent,
  GanttMarker,
  TaskRow,
  TaskWorkbenchSettings,
} from "../core/types";
import {
  EXTERNAL_LABEL_ROW_HEIGHT,
  LANE_BASE_HEIGHT,
  MARKER_ROW_HEIGHT,
  PARENT_COL_WIDTH,
} from "./gantt-constants";


















// 1. Date helpers


/**
 *
 * Adds `days` (may be negative) to an ISO date and returns an ISO date.
 */
export function addDays(dateStr: string, days: number): string {
  return moment(dateStr, "YYYY-MM-DD").add(days, "days").format("YYYY-MM-DD");
}














export function diffDays(startStr: string, endStr: string): number {
  const start = moment(startStr, "YYYY-MM-DD").startOf("day");
  const end = moment(endStr, "YYYY-MM-DD").startOf("day");
  if (!start.isValid() || !end.isValid()) {
    return 0;
  }
  return end.diff(start, "days");
}

/**
 *
 * Strict YYYY-MM-DD parse: returns the parsed moment.Moment, or `null` when
 * `value` does not parse as a valid calendar date under that exact format
 * (moment's strict-parsing mode — the 3rd `true` argument — rejects
 * malformed/partial strings that moment's lenient mode would otherwise
 * coerce).
 */
export function parseDate(value: string): moment.Moment | null {
  const parsed = moment(value, "YYYY-MM-DD", true);
  return parsed.isValid() ? parsed : null;
}











export function isWeekend(dateStr: string): boolean {
  const day = moment(dateStr, "YYYY-MM-DD").day();
  return day === 0 || day === 6;
}

/**
 *
 * The date's month formatted as "<M>月" (e.g. "7月"), no zero-padding —
 * distinct from dateLabel's zero-padded day-of-month field below.
 */
export function monthTitle(dateStr: string): string {
  return `${moment(dateStr, "YYYY-MM-DD").month() + 1}月`;
}









export function formatDateLabel(dateStr: string, format: string): string {
  return moment(dateStr, "YYYY-MM-DD").format(format);
}












export function clampDate(
  dateStr: string | undefined,
  rangeStart: string,
  rangeEnd: string
): string {

  if (dateStr === undefined) {
    return rangeStart;
  }
  // ISO dates compare chronologically under plain string comparison.
  if (dateStr < rangeStart) {
    return rangeStart;
  }
  if (dateStr > rangeEnd) {
    return rangeEnd;
  }
  return dateStr;
}

/**
 *
 * `rangeDays` consecutive ISO dates starting at `rangeStart`
 * (rangeDays = 0 → empty list).
 */
export function buildDates(rangeStart: string, rangeDays: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < rangeDays; i += 1) {
    dates.push(addDays(rangeStart, i));
  }
  return dates;
}

/**
 *
 * Whether the month label is shown on `dates[index]`: the label appears on
 * the first date whose month differs from the previous date in the sequence.
 * Index 0 has no previous date inside the displayed range, so it always
 * carries the month label — even when the range starts mid-month.
 */
export function isMonthStart(dates: string[], index: number): boolean {
  if (index <= 0) {
    return true;
  }
  if (index >= dates.length) {
    return false;
  }
  // Compare year-month prefixes ("YYYY-MM"); ISO lexical compare is
  // The result is chronological.
  return dates[index].slice(0, 7) !== dates[index - 1].slice(0, 7);
}

// Japanese one-letter weekday names indexed by moment.day (0 = Sunday).
const WEEKDAY_SHORT_JA = ["日", "月", "火", "水", "木", "金", "土"];

/**
 *
 * Header day-row / dow-row cell labels: zero-padded day of month
 * ("01".."31") and the short Japanese weekday ("月".."日"). The weekday
 * comes from a fixed table so it never depends on moment's active locale.
 */
export function dateLabel(dateStr: string): { day: string; dow: string } {
  const parsed = moment(dateStr, "YYYY-MM-DD");
  return {
    day: parsed.format("DD"),
    dow: WEEKDAY_SHORT_JA[parsed.day()],
  };
}








export function dateFromClientX(
  clientX: number,
  wrapLeft: number,
  scrollLeft: number,
  dayWidth: number,
  baseDate: string
): string {
  // viewport-relative x, minus the fixed LEFT column.
  const x = clientX - wrapLeft + scrollLeft - PARENT_COL_WIDTH;
  // clicks left of the first day column resolve to baseDate.
  const days = Math.floor(Math.max(0, x) / dayWidth);

  return addDays(baseDate, days);
}





// Full-width characters: U+3000–U+9FFF (ideographic space, Hiragana,
// Katakana, CJK Unified Ideographs) and U+FF00–U+FFEF (fullwidth forms,
// incl. fullwidth punctuation). Everything else counts as half-width.
const FULLWIDTH_CHAR_PATTERN = /[\u3000-\u9FFF\uFF00-\uFFEF]/;

// Keep the existing floor-and-padding formula, but make the per-character
// widths explicit constants: add 18px of slack and enforce a 48px minimum.
const FULLWIDTH_CHAR_WIDTH = 16;
const HALFWIDTH_CHAR_WIDTH = 8;
const ESTIMATE_PADDING = 18;
const MIN_ESTIMATED_WIDTH = 48;






















export function estimateTextWidth(text: string): number {
  let sum = 0;
  for (const char of text) {
    sum += FULLWIDTH_CHAR_PATTERN.test(char)
      ? FULLWIDTH_CHAR_WIDTH
      : HALFWIDTH_CHAR_WIDTH;
  }
  return Math.max(MIN_ESTIMATED_WIDTH, sum + ESTIMATE_PADDING);
}





// Fixed saturation and lightness for generated tag colors keep every hue
// legible on the light theme as both a 4px left border and chip text/border.
const TAG_COLOR_SATURATION = 65;
const TAG_COLOR_LIGHTNESS = 55;




















export function resolveGanttTagColor(
  tagName: string,
  overrides?: Record<string, string>
): string {
  const override = overrides?.[tagName];
  if (override !== undefined && override.trim() !== "") {
    return override;
  }

  let hash = 0;
  for (let i = 0; i < tagName.length; i += 1) {
    // (hash << 5) - hash === hash * 31; `| 0` keeps it a 32-bit signed int.
    hash = ((hash << 5) - hash + tagName.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, ${TAG_COLOR_SATURATION}%, ${TAG_COLOR_LIGHTNESS}%)`;
}





const WORKLOAD_MAX_HOURS_DEFAULT = 7;
const WORKLOAD_MAX_HOURS_MIN = 1;
const WORKLOAD_MAX_HOURS_MAX = 24;
const WORKLOAD_CAPACITY_HOURS_MIN = 0.5;
const WORKLOAD_CAPACITY_HOURS_MAX = 24;










export function getMaxHours(settings: TaskWorkbenchSettings): number {
  const raw = settings?.ganttWorkloadMaxHours;
  const value =
    typeof raw === "number" && isFinite(raw)
      ? raw
      : WORKLOAD_MAX_HOURS_DEFAULT;
  return Math.min(WORKLOAD_MAX_HOURS_MAX, Math.max(WORKLOAD_MAX_HOURS_MIN, value));
}













export function getCapacityHours(settings: TaskWorkbenchSettings): number {
  const raw = settings?.ganttWorkloadDailyCapacityHours;
  const value =
    typeof raw === "number" && isFinite(raw) ? raw : getMaxHours(settings);
  return Math.min(
    WORKLOAD_CAPACITY_HOURS_MAX,
    Math.max(WORKLOAD_CAPACITY_HOURS_MIN, value)
  );
}






// The plan-hours gradient varies lightness from 74% to 51% while keeping
// saturation fixed at 70%, so every hue remains legible against both themes.

const PLAN_COLOR_SATURATION = 70;
const PLAN_COLOR_HUE_START = 205; // cyan, 0 hours-toward-max
const PLAN_COLOR_HUE_END = 10; // red, at/above maxHours
const PLAN_COLOR_LIGHTNESS_START = 74;
const PLAN_COLOR_LIGHTNESS_END = 51;
// Zero-division guard for value/maxHours: a maxHours of 0 (or any
// value below 0.5) is floored to 0.5 before dividing.
const PLAN_COLOR_RATIO_FLOOR = 0.5;

/**
 *
 * Deterministic plan-hours value -> CSS color for the workload graph's
 * plan bars. `value <= 0` -> a neutral gray built from this codebase's
 * existing border-color variable (same `--background-modifier-border`
 * token used throughout styles.css) at 35% opacity via `color-mix`.
 * A positive value maps onto an HSL gradient from 205deg (cyan) at 0 hours
 * to 10deg (red) as value approaches `maxHours`, with lightness easing
 * from 74% down to 51% over the same range. `ratio = value / maxHours` is
 * clamped to [0, 1] to handle values above the maximum; it cannot fall below
 * 0 because this branch only runs for `value > 0`. `maxHours` is floored to
 * 0.5 before division so a misconfigured `maxHours=0` cannot divide by zero.
 */
export function planColor(value: number, maxHours: number): string {
  if (value <= 0) {
    return "color-mix(in srgb, var(--background-modifier-border) 35%, transparent)";
  }
  const ratio = Math.min(1, value / Math.max(PLAN_COLOR_RATIO_FLOOR, maxHours));
  const hue = PLAN_COLOR_HUE_START - ratio * (PLAN_COLOR_HUE_START - PLAN_COLOR_HUE_END);
  const lightness =
    PLAN_COLOR_LIGHTNESS_START -
    ratio * (PLAN_COLOR_LIGHTNESS_START - PLAN_COLOR_LIGHTNESS_END);
  return `hsl(${hue}, ${PLAN_COLOR_SATURATION}%, ${lightness}%)`;
}

/**
 * Actual-hours bars use this fixed CSS variable directly, regardless of
 * value. Exported as a named constant so renderers share one canonical color
 * value.
 */
export const WORKLOAD_ACTUAL_COLOR = "var(--interactive-accent)";






export interface WorkloadDaySummaryEntry {
  parentName: string;
  subtaskName: string;
  hours: number;
}

/**
 *
 * For a calendar date and mode ("plan" or "actual"), collects Gantt-visible
 * subtasks with positive hour values as `{parentName, subtaskName, hours}`
 * entries. Plan and actual values are collected separately. A subtask or
 * parent without a name uses its fallback label.
 *
 * Sort order: hours DESCENDING first, then parentName ascending,
 * then subtaskName ascending — all three applied together as one stable
 * comparator (not "sort by hours, then re-sort ties by name" as two passes,
 * which would not be equivalent once more than two entries share an hours
 * value).
 */
export function collectWorkloadEntriesForDate(
  date: string,
  tasks: TaskRow[],
  mode: "plan" | "actual"
): WorkloadDaySummaryEntry[] {
  const entries: WorkloadDaySummaryEntry[] = [];
  for (const parent of getGanttParentRows(tasks)) {
    if (!parent.subtasks) {
      continue;
    }
    const parentName = parent.displayName || parent.title || "親タスク";
    for (const subtask of parent.subtasks.values()) {
      const map = mode === "plan" ? subtask.workloadPlan : subtask.workloadActual;
      const hours = map?.[date] ?? 0;
      if (hours <= 0) {
        continue;
      }
      const subtaskName = subtask.displayName || subtask.title || "サブタスク";
      entries.push({ parentName, subtaskName, hours });
    }
  }
  entries.sort((a, b) => {
    if (a.hours !== b.hours) {
      return b.hours - a.hours; // hours DESCENDING.
    }
    if (a.parentName !== b.parentName) {
      return a.parentName < b.parentName ? -1 : 1;
    }
    if (a.subtaskName !== b.subtaskName) {
      return a.subtaskName < b.subtaskName ? -1 : 1;
    }
    return 0;
  });
  return entries;
}

























export function hoursFromPointer(
  y: number,
  graphHeightPx: number,
  maxHours: number
): number {
  if (graphHeightPx <= 0) {
    return 0;
  }
  return (1 - y / graphHeightPx) * maxHours;
}





















export function dateFromPointer(
  x: number,
  cellWidthPx: number,
  dates: string[]
): string {
  if (dates.length === 0) {
    return "";
  }
  if (cellWidthPx <= 0) {
    return dates[0];
  }
  const rawIndex = Math.floor(x / cellWidthPx);
  const index = Math.max(0, Math.min(dates.length - 1, rawIndex));
  return dates[index];
}


// 3. Parent row filtering / sorting


// absent / non-finite ganttOrder sorts as 999999 (end).
const GANTT_ORDER_FALLBACK = 999999;

function effectiveGanttOrder(row: TaskRow): number {
  return typeof row.ganttOrder === "number" && isFinite(row.ganttOrder)
    ? row.ganttOrder
    : GANTT_ORDER_FALLBACK;
}

/**
 *
 * Extracts the Gantt-visible parents (kind === "parent" and
 * ganttEnabled === true) and orders them for rendering: ganttOrder
 * ascending (finite values only; missing / non-finite treated as 999999),
 * ties broken by displayName (or title when displayName is empty) via
 * localeCompare. The input array is not mutated.
 */
export function getGanttParentRows(tasks: TaskRow[]): TaskRow[] {
  return tasks
    .filter((task) => task.kind === "parent" && task.ganttEnabled === true)
    .sort((a, b) => {
      const orderDiff = effectiveGanttOrder(a) - effectiveGanttOrder(b);
      if (orderDiff !== 0) {
        return orderDiff;
      }

      return (a.displayName || a.title).localeCompare(
        b.displayName || b.title
      );
    });
}











export type { GanttEvent };




















export function getGanttEvents(settings: {
  ganttEvents: GanttEvent[];
}): GanttEvent[] {
  return Array.isArray(settings.ganttEvents) ? settings.ganttEvents : [];
}





/**
 * Returns whether tags pass the active Gantt tag filter. An empty filter
 * allows every tag; otherwise, at least one tag must be selected. Matching is
 * case-sensitive. `tags` is already a normalized string array, as used by
 * TaskRow.tags and GanttMarker.tags. The filter is an explicit parameter so
 * the view can pass its active set without the helper closing over view state.
 */
export function hasAnySelectedGanttTag(
  tags: string[],
  activeTagFilter: Set<string>
): boolean {
  if (activeTagFilter.size === 0) {
    return true;
  }
  return tags.some((tag) => activeTagFilter.has(tag));
}





/**
 *
 * One subtask's timeline representation.
 */
export interface Bar {
  task: TaskRow;
  start: string; // YYYY-MM-DD (plannedStartDate)
  end: string; // YYYY-MM-DD (plannedEndDate)
  lane: number; // 0 = topmost lane
}

/**
 *
 * Whether a subtask carries both planned dates (non-empty strings) and can
 * therefore produce a bar.
 */
export function hasPlannedDates(
  task: TaskRow
): task is TaskRow & { plannedStartDate: string; plannedEndDate: string } {
  return (
    typeof task.plannedStartDate === "string" &&
    task.plannedStartDate !== "" &&
    typeof task.plannedEndDate === "string" &&
    task.plannedEndDate !== ""
  );
}

/**
 *
 * Assigns every date-complete subtask a horizontal lane (0 = top) using
 * greedy interval partitioning and reports the lane count (min 1).
 * Subtasks missing either planned date are dropped entirely — no bar.
 */
export function packSubtasksIntoLanes(subtasks: TaskRow[]): {
  bars: Bar[];
  laneCount: number;
} {
  // A child lacking either date never becomes a bar.
  const candidates = subtasks.filter(hasPlannedDates);

  // Sort by start date, then end date, then title. ISO lexical comparison
  // is chronological. The filter returned a fresh array, so this sort does
  // not mutate the caller's input.
  candidates.sort(
    (a, b) =>
      a.plannedStartDate.localeCompare(b.plannedStartDate) ||
      a.plannedEndDate.localeCompare(b.plannedEndDate) ||
      a.title.localeCompare(b.title)
  );

  // End date of each lane's last-placed bar.
  const laneEnds: string[] = [];
  const bars: Bar[] = [];

  for (const task of candidates) {
    const start = task.plannedStartDate;
    const end = task.plannedEndDate;

    // non-overlap requires last.end < start, STRICTLY.
    // Boundary-adjacent bars (last.end === start) count as overlapping and
    // force a new lane.
    let lane = laneEnds.findIndex((lastEnd) => lastEnd < start);
    if (lane === -1) {
      // no fitting lane → open a new one.
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }

    bars.push({ task, start, end, lane });
  }

  // a parent row always reserves at least one lane.
  return { bars, laneCount: Math.max(1, laneEnds.length) };
}





/**
 *
 * One marker's placement: horizontal anchor x (px from the timeline's left
 * edge, baseDate-relative) and its row index inside the marker band under
 * the bar (0 = topmost marker row).
 */
export interface LaidOutMarker {
  marker: GanttMarker;
  x: number;
  row: number;
}

// minimum horizontal gap (px) between markers sharing a row.
const MARKER_MIN_GAP = 4;
































export function layoutMarkers(
  markers: GanttMarker[],
  bar: Bar,
  baseDate: string,
  dayWidth: number
): LaidOutMarker[] {
  // Placed [left, right] intervals per row.
  const rowIntervals: Array<Array<[number, number]>> = [];
  const placed: LaidOutMarker[] = [];

  for (const marker of markers) {
    // clamp into [bar.start, bar.end] silently

    // clampDate's documented implementation choice).
    const clampedDate = clampDate(marker.date, bar.start, bar.end);


    const x = diffDays(baseDate, clampedDate) * dayWidth + dayWidth / 2;


    const width = estimateTextWidth(marker.title);

    const left = x;
    const right = x + width;


    // the lowest row where every placed marker keeps the
    // 4px minimum gap; open a new row when none fits.
    let row = 0;
    while (row < rowIntervals.length) {
      const conflicts = rowIntervals[row].some(
        ([existingLeft, existingRight]) =>
          left < existingRight + MARKER_MIN_GAP &&
          existingLeft < right + MARKER_MIN_GAP
      );
      if (!conflicts) {
        break;
      }
      row += 1;
    }
    if (row === rowIntervals.length) {
      rowIntervals.push([]);
    }
    rowIntervals[row].push([left, right]);

    placed.push({ marker, x, row });
  }

  return placed;
}

/**
 * One floating event's placement inside the fixed event row. The x anchor is
 * centered on the event's day column, while row is the first collision-free
 * row assigned by layoutFloatingEvents.
 */
export interface LaidOutFloatingEvent {
  event: GanttEvent;
  x: number;
  row: number;
}

// A small breathing space keeps adjacent event chips from touching.
const FLOATING_EVENT_MIN_GAP = 6;

/**
 * Positions fixed-row events and greedily packs overlapping chips into rows.
 *
 * Each event is anchored at the center of its day column and uses the shared
 * text-width estimate for its collision interval. Events are considered in
 * their persisted order and placed in the first row whose existing intervals
 * do not overlap; this keeps the result deterministic while allowing events
 * on distant dates to share a row.
 */
export function layoutFloatingEvents(
  events: GanttEvent[],
  baseDate: string,
  dayWidth: number
): LaidOutFloatingEvent[] {
  const rowIntervals: Array<Array<[number, number]>> = [];
  const placed: LaidOutFloatingEvent[] = [];

  for (const event of events) {
    const x = diffDays(baseDate, event.date) * dayWidth + dayWidth / 2;
    const width = estimateTextWidth(event.title);
    const left = x - width / 2;
    const right = x + width / 2;

    let row = 0;
    while (row < rowIntervals.length) {
      const conflicts = rowIntervals[row].some(
        ([existingLeft, existingRight]) =>
          left < existingRight + FLOATING_EVENT_MIN_GAP &&
          existingLeft < right + FLOATING_EVENT_MIN_GAP
      );
      if (!conflicts) {
        break;
      }
      row += 1;
    }
    if (row === rowIntervals.length) {
      rowIntervals.push([]);
    }
    rowIntervals[row].push([left, right]);
    placed.push({ event, x, row });
  }

  return placed;
}





/**
 *
 * Placement of one bar's external label: which side of the bar's band and
 * which row index inside that side's row stack (0 = closest to the bar).
 */
export interface ExternalLabelPlacement {
  side: "top" | "bottom";
  row: number;
}

// the label starts 8px to the right of the bar's right edge.
const EXTERNAL_LABEL_GAP = 8;












export function layoutExternalBarLabels(
  bars: Array<Bar & { needsLabel: boolean; labelText: string }>,
  baseDate: string,
  dayWidth: number
): Map<Bar, ExternalLabelPlacement> {
  const placements = new Map<Bar, ExternalLabelPlacement>();

  // only label-needing bars, processed in start-date order.
  const targets = bars
    .filter((bar) => bar.needsLabel)
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start));

  // independent top / bottom row lists; each entry tracks the
  // rightmost pixel occupied in that row.
  const topRows: number[] = [];
  const bottomRows: number[] = [];

  // the first row whose occupied extent ends at or before
  // labelLeft (labels may touch but never overlap); rows.length means
  // "no free row — a new one would be appended".
  const findFreeRow = (rows: number[], labelLeft: number): number => {
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] <= labelLeft) {
        return i;
      }
    }
    return rows.length;
  };

  for (const bar of targets) {
    // Bar right edge per (end - baseDate + 1) × dayWidth - 4.
    const barRight = (diffDays(baseDate, bar.end) + 1) * dayWidth - 4;
    // labelLeft = bar right edge + 8px.
    const labelLeft = barRight + EXTERNAL_LABEL_GAP;
    const labelRight = labelLeft + estimateTextWidth(bar.labelText);

    const topRow = findFreeRow(topRows, labelLeft);
    const bottomRow = findFreeRow(bottomRows, labelLeft);


    // "lower is better"): the side with STRICTLY fewer total rows wins;
    // ties go to top. Row counts are compared BEFORE placing this label.
    if (bottomRows.length < topRows.length) {
      if (bottomRow === bottomRows.length) {
        bottomRows.push(labelRight);
      } else {
        // findFreeRow guarantees bottomRows[bottomRow] <= labelLeft <
        // labelRight, so this always advances the row's extent.
        bottomRows[bottomRow] = labelRight;
      }
      placements.set(bar, { side: "bottom", row: bottomRow });
    } else {
      if (topRow === topRows.length) {
        topRows.push(labelRight);
      } else {
        topRows[topRow] = labelRight;
      }
      placements.set(bar, { side: "top", row: topRow });
    }
  }

  return placements;
}





// vertical padding (px) above the first lane and below the
// last lane's contribution.
const ROW_VERTICAL_PADDING = 8;
// gap (px) added below the row content for the deadline-marker
// band (on top of MARKER_ROW_HEIGHT itself).
const DEADLINE_MARKER_GAP = 6;

/**
 *
 * Total parent-row height: 8px top padding + per-lane contributions
 * (top external rows × 22 + 44 base + marker rows × 16 + bottom external
 * rows × 22, in that order) + 8px bottom padding, plus MARKER_ROW_HEIGHT +
 * 6 more when the parent has a deadline marker. Array entries missing for a
 * lane count as 0.
 */
export function computeRowHeight(
  laneCount: number,
  laneExternalTopRows: number[],
  laneExternalBottomRows: number[],
  markerRowCounts: number[],
  hasDeadlineMarker: boolean
): number {
  let height = ROW_VERTICAL_PADDING;
  for (let lane = 0; lane < laneCount; lane += 1) {

    height += (laneExternalTopRows[lane] ?? 0) * EXTERNAL_LABEL_ROW_HEIGHT;
    height += LANE_BASE_HEIGHT;
    height += (markerRowCounts[lane] ?? 0) * MARKER_ROW_HEIGHT;
    height +=
      (laneExternalBottomRows[lane] ?? 0) * EXTERNAL_LABEL_ROW_HEIGHT;
  }
  height += ROW_VERTICAL_PADDING;
  if (hasDeadlineMarker) {

    height += MARKER_ROW_HEIGHT + DEADLINE_MARKER_GAP;
  }
  return height;
}

/**
 *
 * Cumulative vertical offset per lane: offsets[0] = 8 (the row's top
 * padding) and offsets[i] = offsets[i-1] + laneHeights[i-1]. These offsets
 * are the basis for bar / marker `top` styles in the renderer.
 */
export function computeLaneOffsets(laneHeights: number[]): number[] {
  const offsets: number[] = [];
  let offset = ROW_VERTICAL_PADDING;
  for (const laneHeight of laneHeights) {
    offsets.push(offset);

    offset += laneHeight;
  }
  return offsets;
}





/**
 *
 * Inputs of the header fingerprint.
 */
export interface HeaderFingerprintInput {
  dates: string[];
  dayWidth: number;
  today: string;
  holidays: string[];
  featureFlags: {
    workload: boolean;
    events: boolean;
    dailyTodo: boolean;
    tags: boolean;
  };
  parentPaths: string[];
  activeTagFilter?: Set<string>;
  tagDefinitions?: Array<{
    key: string;
    name: string;
    color: string;
    order: number;
  }>;
}

/**
 *
 * Deterministic change-detection string for the chart header. Not
 * cryptographic — a normalized JSON serialization that changes whenever
 * any header-visible input changes (date range, dayWidth, today, holidays,
 * feature flags, parent order, active tag filter, tag definitions).
 */
export function computeHeaderFingerprint(
  input: HeaderFingerprintInput
): string {
  // the tag filter is included SORTED so Set insertion order
  // never matters; an absent / empty filter serializes identically.
  const tagFilter =
    input.activeTagFilter !== undefined && input.activeTagFilter.size > 0
      ? Array.from(input.activeTagFilter).sort()
      : [];
  const tagDefinitions = (input.tagDefinitions ?? []).map((definition) => ({
    key: definition.key,
    name: definition.name,
    color: definition.color,
    order: definition.order,
  }));
  return JSON.stringify([
    input.dates.length,
    input.dates[0] ?? "",
    input.dates[input.dates.length - 1] ?? "",
    input.dayWidth,
    input.today,
    input.holidays,
    // Normalize key order regardless of how the caller built the object.
    {
      workload: input.featureFlags.workload,
      events: input.featureFlags.events,
      dailyTodo: input.featureFlags.dailyTodo,
      tags: input.featureFlags.tags,
    },
    input.parentPaths,
    tagFilter,
    tagDefinitions,
  ]);
}

/**
 *
 * Deterministic change-detection string covering everything a parent row
 * visibly renders: the parent's own display fields plus every subtask's
 * bar / workload / marker inputs. Subtasks serialize in Map insertion
 * order, which is deterministic for a given load order.
 */
export function computeRowFingerprint(parent: TaskRow): string {

  const subtasks: unknown[] = [];
  if (parent.subtasks) {
    for (const subtask of parent.subtasks.values()) {
      subtasks.push({
        key: subtask.key ?? "",
        title: subtask.title,

        // "title"), but renderParentRow's bar label uses
        // displayName || title (task-gantt-view.ts) — today they're always
        // equal (note-format.ts always sets subtask displayName from its
        // title), so this is currently a no-op safety net, not a behavior
        // change. Included so a future per-subtask displayName edit
        // feature can't silently go stale under incremental rendering.
        displayName: subtask.displayName,
        plannedStartDate: subtask.plannedStartDate ?? "",
        plannedEndDate: subtask.plannedEndDate ?? "",
        priority: subtask.priority,
        tags: subtask.tags,
        statusLabel: subtask.statusLabel,
        completed: subtask.completed,
        workloadPlan: subtask.workloadPlan ?? {},
        workloadActual: subtask.workloadActual ?? {},
        ganttMarkers: subtask.ganttMarkers ?? [],
      });
    }
  }


  return JSON.stringify({
    title: parent.title,
    displayName: parent.displayName,
    dueDate: parent.dueDate ?? "",
    ganttOrder: parent.ganttOrder ?? null,
    tags: parent.tags,
    completed: parent.completed,
    statusLabel: parent.statusLabel,
    subtasks,
  });
}
