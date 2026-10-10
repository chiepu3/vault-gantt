import { operationInputSchemas, type ViewOperationId, type OperationInputMap } from "../contracts/operations";
import type { OperationRequestResultV1 } from "../contracts/preview";
import type { PreviewUiHostPorts } from "../contracts/ports";
import type { ScheduleGhostStore } from "../app/schedule-ghost";
import { renderGhost, renderPointGhosts } from "./ghost-layer";
import type { PreviewPort } from "../contracts/ports";
import { PreviewGanttLayer } from "./preview-gantt-layer";
import { ItemView, Menu, Notice, moment, setIcon } from "obsidian";
import type { MenuItem, WorkspaceLeaf } from "obsidian";

import type { Logger } from "../core/logger";

import type {
  GanttEvent,
  GanttMarker,
  DailyTodoItem,
  DailyTodoSummary,
  GanttTagDefinition,
  StatusLabel,
  TaskPatch,
  TaskRow,
  TaskUpdateCommand,
  TaskWorkbenchSettings,
  WeeklyWorkSchedule,
} from "../core/types";
// Tag rendering uses the GanttTagDefinition[] registry through
// findGanttTagDefinition and getPrimaryGanttTagDefinition.
import {
  DEFAULT_GANTT_TAG_COLORS,
  DEFAULT_STATUSES,
} from "../core/constants";
import { appendTagChips, findGanttTagDefinition, setStyleVar } from "./tag-chip";
import { makeUniqueMarkerKey, todayStr } from "../core/utils";
import { normalizeWorkloadMap } from "../core/task-patch";
import {
  addDays,
  buildDates,
  computeHeaderFingerprint,
  computeLaneOffsets,
  computeRowFingerprint,
  collectWorkloadEntriesForDate,
  computeRowHeight,
  dateFromClientX,
  dateFromPointer,
  dateLabel,
  diffDays,
  estimateTextWidth,
  getCapacityHours,
  getGanttEvents,
  getGanttParentRows,
  getMaxHours,
  hasAnySelectedGanttTag,
  hasPlannedDates,
  hoursFromPointer,
  isMonthStart,
  layoutExternalBarLabels,
  layoutFloatingEvents,
  layoutMarkers,
  monthTitle,
  packSubtasksIntoLanes,
} from "../app/gantt-layout";
import type {
  Bar,
  ExternalLabelPlacement,
  LaidOutMarker,
} from "../app/gantt-layout";
import {
  BAR_HEIGHT,
  EXTERNAL_LABEL_ROW_HEIGHT,
  LANE_BASE_HEIGHT,
  MARKER_ROW_HEIGHT,
  PARENT_COL_WIDTH,
  RANGE_EXTEND_DAYS,
  WORKLOAD_ROW_HEIGHT,
} from "../app/gantt-constants";
import {
  dayValues,
  formatBulkMoveDragTooltip,
  formatDragRangeTooltip,
  formatDueDateDragTooltip,
  formatMarkerDragTooltip,
  getBulkMoveKeysForParent,
  getWorkloadTaskKey,
  hasWorkloadActual,
  moveBarByCalendarDelta,
  pixelDeltaToDayDelta,
  roundHalfHour,
  setValue,
  shiftMarkers,
  shiftWorkloadMap,
  snapForward,
  snapMarkerDate,
  snapResizeEnd,
  snapResizeStart,
  sortForBulkMove,
} from "../app/gantt-drag";

import type { WorkloadHost, WorkloadMode } from "../app/gantt-drag";
import {
  addGanttEvent,
  addWeeklyWorkSchedule,
  deleteGanttEvent,
  deleteWeeklyWorkSchedule,
  duplicateGanttEvent,
  enableParentInGantt,
  updateGanttEvent,
  updateWeeklyWorkSchedule,
} from "../app/gantt-task-service";
import { WeeklyWorkScheduleModal } from "./modals";
import { registerHistoryHotkeys } from "./history-hotkeys";


/**
 * Obsidian 1.13.4 exposes this at runtime, but not in its public TypeScript
 * declarations. Keep the undocumented surface isolated to one narrow type.
 */
type MenuItemWithRuntimeSubmenu = MenuItem & {
  setSubmenu?: () => Menu;
};

/** Icon-only toolbar button: Lucide icon with a Japanese label for assistive tech and tooltip. */
function setToolbarIcon(button: HTMLElement, icon: string, label: string): void {
  button.setAttribute("aria-label", label);
  button.title = label;
  setIcon(button, icon);
}

function formatWorkloadHours(hours: number): string {
  const rounded = Math.round(hours * 2) / 2;
  if (rounded === 0) {
    return "";
  }
  return `${rounded}h`;
}


interface DualWorkloadLabel {
  text: string;

  // 単独の呼び出し側で `value === 0 && otherValue !== 0` を再計算すると
  // このテキスト決定ロジックと分岐条件が二重管理になる。isPlaceholder を
  // ここで一緒に返すことで、CSSの視覚的de-emphasis(is-placeholder)適用が
  // 常にこの関数のテキスト決定と同期する。
  isPlaceholder: boolean;
}

function formatDualWorkloadLabel(
  value: number,
  otherValue: number
): DualWorkloadLabel {
  if (value !== 0) {
    return { text: formatWorkloadHours(value), isPlaceholder: false };
  }
  return otherValue !== 0
    ? { text: "-h", isPlaceholder: true }
    : { text: "", isPlaceholder: false };
}


type WorkloadSummaryTotals = { plan: number; actual: number };

/** Format a graph badge, including an explicit zero-hours value. */
function formatWorkloadBadgeHours(hours: number): string {
  return `${Math.round(hours * 2) / 2}h`;
}

/** Planned-mode fill color from low-hours blue to at-capacity red-orange. */
function workloadPlannedFillColor(hours: number, maxHours: number): string {
  const ratio = Math.max(0, Math.min(1, hours / Math.max(0.5, maxHours)));
  const hue = 205 - ratio * 195;
  const lightness = 74 - ratio * 23;
  return `hsl(${hue} 88% ${lightness}%)`;
}

/** Preserve first-seen tag order while preventing duplicate task references. */
function dedupeTagNames(tags: string[]): string[] {
  return Array.from(new Set(tags));
}

/** Resolve stable tag keys to display names before persisting task references. */
function canonicalizeTagNames(
  tags: string[],
  definitions: GanttTagDefinition[]
): string[] {
  return dedupeTagNames(
    tags.map(
      (tag) =>
        definitions.find(
          (definition) => definition.key === tag || definition.name === tag
        )?.name ?? tag
    )
  );
}

/**
 * `getPrimaryGanttTag` equivalent. Selects the first
 * matching registry entry in registry order. An orphan task tag remains
 * renderable through the fallback synthetic definition
 * `{key,name,color:"",order:999999}`, but deliberately has no color.
 */
function getPrimaryGanttTagDefinition(
  settings: TaskWorkbenchSettings,
  tags: string[]
): GanttTagDefinition | undefined {
  const names = tags.filter((tag) => tag !== "");
  if (names.length === 0) {
    return undefined;
  }

  const nameSet = new Set(names);
  const definitions = (Array.isArray(settings.ganttTags) ? settings.ganttTags : [])
    .slice()
    .sort((a, b) => a.order - b.order);
  const match = definitions.find(
    (definition) => nameSet.has(definition.name) || nameSet.has(definition.key)
  );
  return (
    match ?? {
      key: names[0],
      name: names[0],
      color: "",
      order: 999999,
    }
  );
}
















/** One editable row of the Daily ToDo popover; `item` is null until it is written to a note. */
interface DailyTodoPopoverRow {
  item: DailyTodoItem | null;
  rowEl: HTMLElement;
  checkEl: HTMLInputElement;
  inputEl: HTMLInputElement;
}

interface DailyTodoPopoverState {
  el: HTMLElement;
  anchorEl: HTMLElement;
  date: string;
  listEl: HTMLElement;
  rows: DailyTodoPopoverRow[];
  outsideHandler: (evt: Event) => void;
}

function isDailyTodoRowDirty(row: DailyTodoPopoverRow): boolean {
  const text = row.inputEl.value.trim();
  if (row.item === null) {
    return text !== "";
  }
  return text !== row.item.text.trim() || row.checkEl.checked !== row.item.completed;
}

function isNodeInside(node: Node, root: Node): boolean {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if (current === root) {
      return true;
    }
  }
  return false;
}

/** True for clicks inside an Obsidian menu (e.g. the row's 「…」 menu). */
function isNodeInsideMenu(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if ((current as Element).classList?.contains("menu")) {
      return true;
    }
  }
  return false;
}

export interface TaskGanttViewHost extends Partial<PreviewUiHostPorts> {
  ghosts?: ScheduleGhostStore;
  /** Pending/saved operation previews to project onto the chart. Absent = no preview overlay. */
  previewPort?: PreviewPort;

  logger: Logger;

  settings: TaskWorkbenchSettings;
  loadTasks(): Promise<TaskRow[]>;
  loadDailyTodoSummaries(): Promise<DailyTodoSummary[]>;
  /**
   * Daily ToDo popover persistence. Each call rewrites a single line of the
   * note (and records an undo entry); `false` means the line could not be
   * written (missing file, or the line changed since it was loaded).
   */
  updateDailyTodoItem(
    item: DailyTodoItem,
    patch: { text?: string; completed?: boolean }
  ): Promise<boolean>;
  deleteDailyTodoItem(item: DailyTodoItem): Promise<boolean>;
  /** Appends a ToDo to the date's main note; null when it could not be added. */
  addDailyTodoItem(
    dateStr: string,
    text: string,
    completed: boolean
  ): Promise<DailyTodoItem | null>;
  /** Opens the note holding the ToDo, scrolled to its line. */
  openDailyTodoItem(item: DailyTodoItem): Promise<void>;
  saveSettings(): Promise<void>;









  createGanttParentInteractively?(): Promise<void>;

  /**
 * (single-task drag saves)
 * Persists one drag/edit result via task-operations' updateTaskItem.
 * Mirrors TaskWorkbenchViewHost.updateTaskItem (src/ui/task-workbench-view.ts)
 * exactly — same revision-checked, atomic-per-file write path.
 */
  updateTaskItem(row: TaskRow, patch: TaskPatch): Promise<unknown>;

  /**
 *
 * Opens the task's note (the popover's 「ノートを開く」 button). Mirrors
 * TaskWorkbenchViewHost.openTaskItem (src/ui/task-workbench-view.ts)
 * exactly — main.ts wraps NavigationService.openTaskItem with the
 * identical one-line pattern for both hosts.
 */
  openTaskItem(row: TaskRow): Promise<void>;

  /**
 *
 * Persists a Bulk-Move drag's target group in one batch call.
 * task-operations.updateTaskItemsBatch groups commands by parent file and
 * performs one vault.modify per file, as required for a move confined to
 * one parent's subtasks.
 */
  updateTaskItemsBatch(commands: TaskUpdateCommand[]): Promise<unknown>;

  /**
 *
 * Asks the user to confirm a move/resize/Bulk-Move that would shift dates
 * out from under recorded workload actuals. Resolving `true` proceeds
 * with the save; `false` cancels — nothing is saved and the screen stays
 * exactly as currently rendered.
 */
  confirmWorkloadShift(message: string): Promise<boolean>;





















  openMarkerModal(
    modalTitle: string,
    initialTitle: string,
    initialDate: string
  ): Promise<{ title: string; date: string } | null>;













  openTextPrompt(
    title: string,
    label: string,
    initialValue: string,
    onSubmit: (value: string) => void
  ): void;

  /**
 *
 * 「タスクとして削除」の確定後に呼ばれる、task-operations の
 * deleteSubtaskTaskItem を包む host メソッド（updateTaskItem 同様、
 * vault/settings/cache はプラグイン側にしかないため host 経由）。
 */
  deleteSubtaskTaskItem(row: TaskRow): Promise<void>;

  /**
 *
 * The empty-cell menu's 「新規サブタスクを [date] に作成」 action: wraps
 * task-operations.addSubtaskWithPlan (dateStr becomes both
 * plannedStartDate and plannedEndDate) the same one-line way
 * deleteSubtaskTaskItem above wraps its own task-operations function.
 * `name` has already been trimmed and validated as non-empty by the caller.
 */
  addSubtaskWithPlan(
    parentRow: TaskRow,
    name: string,
    dateStr: string
  ): Promise<TaskRow>;












  openGanttParentPicker(
    items: TaskRow[],
    onChoose: (item: TaskRow) => void | Promise<void>
  ): void;









  addSubtaskInteractively?(
    row: TaskRow,
    onCreated: () => void
  ): Promise<void>;

  /**
 *
 * The toolbar's 「Workbench」 button — opens the Task Workbench view.
 * Mirrors TaskWorkbenchViewHost.activateGanttView's own one-line
 * NavigationService wrap (src/main.ts's workbenchViewHost), just in the
 * opposite direction (Gantt → Workbench instead of Workbench → Gantt).
 */
  activateView(): Promise<void>;








  syncReadonlyGanttNow(): Promise<void>;

  /** Undo/redo toolbar actions are coordinated by the plugin so both views refresh. */
  undoLastAction(): Promise<void>;
  redoLastAction(): Promise<void>;

  /**
 *
 * Plugin manifest fields used by the toolbar's read-only version-info span.
 * `releaseNotes` is optional and may be supplied as a custom field in
 * manifest.json; when absent, the toolbar falls back to `description`, then
 * an empty string.
 */
  manifest: { version: string; releaseNotes?: string; description?: string };
}


















export interface GanttRowCache {
  rootEl: HTMLElement;
  headerFingerprint: string;
  rowEls: Map<string, HTMLElement>;
  rowFingerprints: Map<string, string>;
}


// The toolbar exposes zoom controls from 14 to 72px per day in 6px steps.
// setZoom itself does not clamp values, so callers may still set values
// outside that range directly.
const ZOOM_STEP_PX = 6;
const ZOOM_MIN_PX = 14;
const ZOOM_MAX_PX = 72;


// Keep the tooltip hidden until the pointer moves this far from the drag start.
const DRAG_TOOLTIP_THRESHOLD_PX = 4;

// Width of the resize hit zone at either end of a bar. The center area
// remains available for bar movement; at 6px, the handle is small relative
// to the minimum 8px bar width.
const RESIZE_EDGE_HIT_ZONE_PX = 6;


// After a drag, suppress the rich popover for 450ms. This gives the pointer
// time to settle after release while keeping deliberate hover responsive.
const RICH_POPOVER_SUPPRESS_MS = 450;

// Right-clicking a bar or marker arms the same suppression gate as a drag,
// for longer. Dismissing the menu while the pointer is still over its target
// must not immediately reopen the rich popover. The shared gate is managed by
// armRichPopoverSuppress rather than a second suppression mechanism.
const MENU_POPOVER_SUPPRESS_MS = 1200;
// Gap between a popover and its bar or row anchor.
const RICH_POPOVER_GAP_PX = 12;
// Delay before hiding the rich popover after mouse leave.
const RICH_POPOVER_HIDE_DELAY_MS = 220;
// Delay before autosaving Current Status while the user types.
const RICH_POPOVER_CURRENT_STATUS_DEBOUNCE_MS = 450;
// Popover width bounds and minimum viewport margin.
const RICH_POPOVER_MIN_WIDTH_PX = 260;
const RICH_POPOVER_MAX_WIDTH_PX = 440;
const RICH_POPOVER_VIEWPORT_MARGIN_PX = 24;
// Minimum measured popover height.
const RICH_POPOVER_MIN_HEIGHT_PX = 180;



// Independent hide delay for the bar-level workload popup. Keep it at
// 160ms, distinct from the rich popover's 220ms; both popovers may be visible
// at the same time.
const WORKLOAD_POPOVER_HIDE_DELAY_MS = 160;

// Gap between the workload popup and its anchor; it shares the 12px spacing
// used by the rich popover for visual consistency.
const WORKLOAD_POPOVER_GAP_PX = 12;
// Minimum measured height for the workload popup, whose content is smaller
// than the rich popover's task-detail form.
const WORKLOAD_POPOVER_MIN_HEIGHT_PX = 122;
const WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX = 8;
// Plot height is shared with styles.css so pointer math and rendered fills use
// the same 0..maxHours scale.
const WORKLOAD_POPOVER_GRAPH_HEIGHT_PX = 86;
// Minimum vertical space (px) an axis tick label needs so consecutive labels
// never overlap — used to widen the tick step when a configured maxHours
// (up to 24) would otherwise need more labels than WORKLOAD_POPOVER_GRAPH_
// HEIGHT_PX has room for at a plain 1-hour step.
const WORKLOAD_POPOVER_AXIS_LABEL_PX = 10;

// Axis width used by getVisibleDatesForPopup. It keeps the popup's date
// window from extending over the parent-name column. The 48px guard matches
// the CSS grid's 42px axis column plus 6px gap; final positioning is measured
// from the rendered elements in positionWorkloadPopup.
const WORKLOAD_POPOVER_AXIS_GUARD_PX = 48;

// Horizontal space for the border and padding after the graph. Together with
// WORKLOAD_POPOVER_AXIS_GUARD_PX, this ensures the full popup box fits the
// viewport at the selected date count.
const WORKLOAD_POPOVER_CHROME_TRAILING_PX = 9;

// Account for the CSS minimum width of 200px. A short bar may force the popup
// wider than its graph content, so layout must include that minimum.
const WORKLOAD_POPOVER_MIN_WIDTH_PX = 200;

// Independent hide delay for the day-summary popup. It uses 140ms, slightly
// shorter than the bar-level workload popup's 160ms delay.
const WORKLOAD_DAY_SUMMARY_POPOVER_HIDE_DELAY_MS = 140;

// Gap between the day-summary popup and its anchor.
const WORKLOAD_DAY_SUMMARY_POPOVER_GAP_PX = 12;
// Minimum measured height for the day-summary popup.
const WORKLOAD_DAY_SUMMARY_POPOVER_MIN_HEIGHT_PX = 90;

// Daily ToDo popover — independent lifecycle from the workload popovers,
// with the same body-anchored/fixed positioning pattern.
const DAILY_TODO_POPOVER_GAP_PX = 12;
const DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX = 8;
const DAILY_TODO_POPOVER_MIN_WIDTH_PX = 180;

// Horizontal margin between today and the left edge after initial auto-scroll.
const INITIAL_SCROLL_OFFSET_PX = 220;


// Minimum rendered bar width.
const MIN_BAR_WIDTH_PX = 8;
// Bar tag badges need room for the badge, its edge gap, and the resize
// handles. Width-gating at render time keeps narrow bars uncluttered without
// relying on CSS width-attribute selectors.
const BAR_TAG_BADGE_MIN_WIDTH_PX = 72;

// Compare the bar's inner width with half the estimated title width.
const BAR_INNER_PADDING_PX = 14;
// an external label starts 8px to the right of the bar's right
// edge and its rendered box never exceeds 340px (text + tag badge combined).
const EXTERNAL_LABEL_GAP_PX = 8;
const EXTERNAL_LABEL_MAX_WIDTH_PX = 340;
// gap (px) below the deadline-marker band (mirrors the DEADLINE
// addition inside computeRowHeight).
const DEADLINE_MARKER_GAP_PX = 6;
// at most four tag chips in the LEFT column.
const MAX_TAG_CHIPS = 4;

// Center the 24px bar vertically within the 44px lane band, leaving 10px
// above and below.
const BAR_VERTICAL_INSET_PX = (LANE_BASE_HEIGHT - BAR_HEIGHT) / 2;


// event-row height = Math.max(44, 12 + rows × 24).
const EVENT_ROW_MIN_HEIGHT_PX = 44;
const EVENT_ROW_VERTICAL_SLACK_PX = 12;
const EVENT_ROW_PITCH_PX = 24;
const EVENT_ROW_CHIP_TOP_PX = 8;
// the daily-todo row's fixed height.
const DAILY_TODO_ROW_HEIGHT_PX = 44;

/**
 * One subtask bar's render-time data: geometry (left/width in px), its label
 * text, whether that text needs an external label, and the augmented Bar
 * object handed to layoutExternalBarLabels (retained so the returned
 * placement map can be looked up by object identity).
 */
interface ParentRowBarRender {
  bar: Bar;
  labelledBar: Bar & { needsLabel: boolean; labelText: string };
  left: number;
  width: number;
  labelText: string;
  needsLabel: boolean;
}






export interface RichPopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The resolved popover placement: absolute viewport coordinates + the side chosen. */
export interface RichPopoverPosition {
  top: number;
  left: number;
  side: "below" | "above" | "right" | "left";
}

/**
 * Data carried by a rich-popover show trigger: the task to display, its
 * anchor element, and (for subtasks) the rendered bar's start/end dates for
 * the read-only period field. These dates come from the bar, not task fields.
 */
type RichPopoverAnchor =
  | {
      kind: "subtask";
      task: TaskRow;
      anchorEl: HTMLElement;
      barStart: string;
      barEnd: string;
    }
  | {
      kind: "parent";
      task: TaskRow;
      anchorEl: HTMLElement;
    };































export function computeRichPopoverPosition(
  anchorRect: RichPopoverRect,
  popoverWidth: number,
  popoverHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  gapPx: number,
  workloadPopupRect?: RichPopoverRect | null,
  mouseX?: number
): RichPopoverPosition {
  const overlapsWorkload = (candidate: RichPopoverRect): boolean => {
    if (workloadPopupRect == null) {
      return false;
    }
    return (
      candidate.left < workloadPopupRect.right &&
      workloadPopupRect.left < candidate.right &&
      candidate.top < workloadPopupRect.bottom &&
      workloadPopupRect.top < candidate.bottom
    );
  };


  // Keeps a horizontal position inside the viewport when that is possible
  // (a popover wider than the viewport pins to 0).
  const clampLeft = (left: number): number =>
    Math.max(0, Math.min(left, viewportWidth - popoverWidth));
  const verticalLeft = clampLeft(
    mouseX !== undefined ? mouseX - popoverWidth / 2 : anchorRect.left
  );

  // 1. below
  const belowTop = anchorRect.bottom + gapPx;
  const belowCandidate: RichPopoverRect = {
    left: verticalLeft,
    top: belowTop,
    right: verticalLeft + popoverWidth,
    bottom: belowTop + popoverHeight,
  };
  if (belowTop + popoverHeight <= viewportHeight && !overlapsWorkload(belowCandidate)) {
    return { top: belowTop, left: verticalLeft, side: "below" };
  }

  // 2. above
  const aboveTop = anchorRect.top - gapPx - popoverHeight;
  const aboveCandidate: RichPopoverRect = {
    left: verticalLeft,
    top: aboveTop,
    right: verticalLeft + popoverWidth,
    bottom: aboveTop + popoverHeight,
  };
  if (aboveTop >= 0 && !overlapsWorkload(aboveCandidate)) {
    return { top: aboveTop, left: verticalLeft, side: "above" };
  }

  // Side placements keep the anchor's top but are clamped into the viewport
  // vertically (a tall popover near the bottom or top edge must not spill).
  const sideTop = Math.max(
    0,
    Math.min(anchorRect.top, viewportHeight - popoverHeight)
  );

  // 3. right — only when it fits and does not collide with the workload popup.
  const rightLeft = anchorRect.right + gapPx;
  const rightCandidate: RichPopoverRect = {
    left: rightLeft,
    top: sideTop,
    right: rightLeft + popoverWidth,
    bottom: sideTop + popoverHeight,
  };
  if (
    rightLeft + popoverWidth <= viewportWidth &&
    !overlapsWorkload(rightCandidate)
  ) {
    return { top: sideTop, left: rightLeft, side: "right" };
  }

  // 4. stacked against the workload popup — only when one is present, so the
  // two popups never overlap even when below/above/right are unusable.
  if (workloadPopupRect != null) {
    const stackedAboveTop = workloadPopupRect.top - gapPx - popoverHeight;
    if (stackedAboveTop >= 0) {
      return { top: stackedAboveTop, left: verticalLeft, side: "above" };
    }
    const stackedBelowTop = workloadPopupRect.bottom + gapPx;
    if (stackedBelowTop + popoverHeight <= viewportHeight) {
      return { top: stackedBelowTop, left: verticalLeft, side: "below" };
    }
  }

  // 5. left of the anchor, horizontally and vertically clamped into the
  // viewport. Accepted when it clears the workload popup.
  const leftLeft = clampLeft(anchorRect.left - gapPx - popoverWidth);
  const sideCandidate = (left: number): RichPopoverRect => ({
    left,
    top: sideTop,
    right: left + popoverWidth,
    bottom: sideTop + popoverHeight,
  });
  if (!overlapsWorkload(sideCandidate(leftLeft))) {
    return { top: sideTop, left: leftLeft, side: "left" };
  }

  // 6. beside the workload popup itself: left of it, then right of it —
  // each only when fully inside the viewport.
  if (workloadPopupRect != null) {
    const leftOfWorkload = workloadPopupRect.left - gapPx - popoverWidth;
    if (leftOfWorkload >= 0) {
      return { top: sideTop, left: leftOfWorkload, side: "left" };
    }
    const rightOfWorkload = workloadPopupRect.right + gapPx;
    if (rightOfWorkload + popoverWidth <= viewportWidth) {
      return { top: sideTop, left: rightOfWorkload, side: "right" };
    }
  }

  // 7. Physically impossible: no placement is both inside the viewport and
  // clear of the workload popup. Fall back to the clamped left-of-anchor
  // position. It is a pure function of its inputs, so repeated hovers and
  // re-placements resolve to the same rect instead of oscillating.
  return { top: sideTop, left: leftLeft, side: "left" };
}



























export class TaskGanttView extends ItemView {
  private unregisterHistoryHotkeys?: () => void;
  // --- Data ---
  /** Last loaded task list returned by host.loadTasks. */
  private tasks: TaskRow[] = [];
  /** Last loaded Daily ToDo summaries, kept synchronous for chart rendering. */
  private dailyTodoSummaries: DailyTodoSummary[] = [];

  // --- Viewport and date range state ---
  /** First visible date: today minus 14 days. */
  private rangeStart = addDays(todayStr(), -14);
  /** Number of consecutive days from rangeStart. */
  private rangeDays = 90;
  /** Pixels per day, initialized from settings.ganttZoom. */
  private unregisterState?: () => void;
  private dayWidth: number;
  /**
 * The date list last built by renderChart (buildDates(rangeStart,
 * rangeDays)). Cached on the instance so the viewport helpers
 * (scrollToDate, getVisibleStartDate) stay consistent with what is
 * currently rendered. Empty until the first renderChart.
 */
  private dates: string[] = [];

  /**
 * Incremental-render cache, populated by the full-rebuild path only when
 * incrementalGanttRender is enabled. The incremental-render gate consumes
 * it. Reset when the chart has no Gantt-enabled parents or incremental
 * rendering is disabled.
 */
  private _ganttRowCache: GanttRowCache | undefined = undefined;

  /**
 * Active tag filter. An empty set shows everything; the header menu updates
 * it, and changes trigger a full rebuild through the header fingerprint.
 * Reads are gated by `ganttFeatureTagsEnabled`, so disabling tag features
 * skips filtering and coloring without hiding bars or markers. The set is
 * independent of the feature flag, so a selected filter resumes when tags
 * are re-enabled.
 */
  private activeTagFilter = new Set<string>();

  /** The currently open tag-filter menu, if any (single-instance dedupe). */
  private tagFilterMenuEl: HTMLElement | undefined = undefined;
  // Cleared together with tagFilterMenuEl whenever the menu closes.
  private tagFilterMenuOutsideClickHandler:
    | ((evt: MouseEvent) => void)
    | undefined = undefined;

  /** guards against re-entrant range extension during scroll. */
  private isExtendingRange = false;

  /** last month shown in the floating label (dedupe key). */
  private lastFloatingMonth = "";
  private chartNeedsVisibleRender = false;








  private holidaySet = new Set<string>();
  /** todayStr captured per render so dateClasses stays consistent. */
  private todayForRender = "";
  /** Shared date classifications, invalidated at the start of every render. */
  private dateClassesCache = new Map<
    string,
    { isWeekend: boolean; isHoliday: boolean; isToday: boolean }
  >();

  // --- DOM references ---

  private toolbarEl!: HTMLElement;
  private unsubscribeGhosts?: () => void;
  private readonly ghostNodes = new Map<string, { nodes: HTMLElement[]; current?: HTMLElement }>();
  private ghostLegend?: HTMLElement;
  private previewLayer?: PreviewGanttLayer;
  private unsubscribePreview?: () => void;
  private previewDockHost?: HTMLElement;
  /** Overlay-only nodes (deadline/marker ghosts, delete labels) and the bars we marked. Live rows are untouched. */
  private readonly previewNodes = new Map<string, HTMLElement[]>();
  private readonly previewMarkedBars = new Set<HTMLElement>();
  /** The scrollable element. */
  private wrapEl!: HTMLElement;
  /** Always-visible current-month label, kept in the toolbar so it survives
 * wrapEl.empty rebuilds and remains available across re-renders. */
  private floatingMonthEl!: HTMLElement;
  /** Visible zoom-magnification label. */
  private zoomLabelEl!: HTMLElement;
  /** Shared drag-tooltip element. */
  private dragTooltipEl!: HTMLElement;












  private dragState: Record<string, unknown> | undefined = undefined;

  /**
 *
 * Typed introspection of the most recently started drag's bookkeeping —
 * used by tests instead of an untyped `(view as any).dragState` reach-in.
 */
  getActiveDragStateForTesting(): Record<string, unknown> | undefined {
    return this.dragState;
  }

  /**
 *
 * Bar element per subtask id, refreshed every time a bar renders (never
 * cleared — stale entries for tasks that later vanish are simply never
 * looked up again, since lookups only ever go through CURRENTLY live
 * subtasks). Lets Bulk-Move find/preview every target bar without a DOM
 * query helper.
 */
  private barElsByTaskId = new Map<string, HTMLElement>();












  private workloadModeStore = new Map<string, { mode: WorkloadMode }>();

  /**
 *
 * Typed introspection of `workloadModeStore`, mirroring
 * `getActiveDragStateForTesting` above — used by tests instead of an
 * untyped `(view as any).workloadModeStore` reach-in.
 */
  getWorkloadModeStoreForTesting(): Map<string, { mode: WorkloadMode }> {
    return this.workloadModeStore;
  }

  /**
 *
 * The workload graph's active paint-drag session (undefined = no paint in
 * progress). Only the most recently opened graph has an active paint session;
 * a new `startWorkloadPaint` call overwrites this field. `pointerId`
 * identifies events for this session, and the handlers clear the field only
 * when its chart is still active.
 */

  private workloadPaintState:
    | {
        chartEl: HTMLElement;
        task: WorkloadHost;
        modeKey: string;
        mode: WorkloadMode;
        pointerId: number;
        persist: () => Promise<void>;
      }
    | undefined = undefined;


  /**
 *
 * Typed introspection of `workloadPaintState`, mirroring
 * `getActiveDragStateForTesting` — used by tests instead of an untyped
 * `(view as any).workloadPaintState` reach-in.
 */

  getWorkloadPaintStateForTesting():
    | {
        chartEl: HTMLElement;
        task: WorkloadHost;
        modeKey: string;
        mode: WorkloadMode;
        pointerId: number;
        persist: () => Promise<void>;
      }
    | undefined {
    return this.workloadPaintState;
  }

















  private workloadPopoverState:
    | {
        el: HTMLElement;
        task: WorkloadHost;
        modeKey: string;
        anchorEl: HTMLElement;
        chartEl: HTMLElement;
        dates: string[];
        graphLeft: number;
        cellEls: Map<
          string,
          {
            planFill: HTMLElement;
            activeFill: HTMLElement;
            valueBadge: HTMLElement;
          }
        >;
        persist: () => Promise<void>;
      }
    | undefined = undefined;


  /** pending mouse-leave -> hide debounce timer. */
  private workloadPopoverHideTimer: ReturnType<typeof setTimeout> | undefined =
    undefined;









  private workloadSummaryRowEl: HTMLElement | undefined = undefined;
  /** Fingerprint of the inputs used to compute the current summary values. */
  private workloadSummaryFingerprint: string | undefined = undefined;
  /** Cached per-date totals so full cosmetic rebuilds can reuse aggregation. */
  private workloadSummaryTotals:
    | Map<string, WorkloadSummaryTotals>
    | undefined = undefined;

  /** The fixed event row, retained for incremental event-data refreshes. */
  private eventRowEl: HTMLElement | undefined = undefined;
  /** The fixed Daily ToDo row, retained for incremental summary refreshes. */
  private dailyTodoRowEl: HTMLElement | undefined = undefined;

  /** Anchor per date in the Daily ToDo row: the count chip, or the empty cell when the date has no ToDo. */
  private dailyTodoAnchorEls = new Map<string, HTMLElement>();

  /** The currently open Daily ToDo popover (click to open, editable in place). */
  private dailyTodoPopoverState: DailyTodoPopoverState | undefined = undefined;
  private dailyTodoQueue: Promise<void> | undefined = undefined;
  private dailyTodoOpenGeneration = 0;









  private workloadDaySummaryPopoverState:
    | { el: HTMLElement; anchorEl: HTMLElement }
    | undefined = undefined;

  /** pending mouse-leave -> hide debounce timer (140ms). */
  private workloadDaySummaryPopoverHideTimer:
    | ReturnType<typeof setTimeout>
    | undefined = undefined;

  /** Closes the body-anchored day summary on interaction elsewhere. */
  private workloadDaySummaryOutsidePointerDownHandler:
    | ((evt: PointerEvent) => void)
    | undefined = undefined;













  private inlineEditingEls = new Set<HTMLElement>();














  private bulkMoveState:
    | { parentKey: string; anchorKey: string; anchorStart: string }
    | undefined = undefined;

  /**
 *
 * Single-instance dedupe for the real obsidian.Menu context menus this
 * area introduces (bar / marker / empty-cell right-click) — "close the
 * previous one before opening a new one", using Menu's own
 * hide/onHide instead of a raw element remove.
 */
  private activeContextMenu: Menu | undefined = undefined;















  private parentTitleEditingIds = new Set<string>();








  private dragParentId: string | undefined = undefined;


  /**
 *
 * Drag-end suppression window: while Date.now is below this timestamp
 * the rich popover refuses to show (anti-misfire right after a drag).
 * Armed by armRichPopoverSuppress from each of the four drag kinds'
 * pointerup/cleanup paths. 0 = not suppressed.
 */
  private richPopoverSuppressUntil = 0;

  /** The currently open rich popover element (undefined = closed). */
  private richPopoverEl: HTMLElement | undefined = undefined;
  /**
 * Element anchoring the open popover: a subtask bar or parent-row left
 * cell. Its isConnected state is checked before repositioning because an
 * external re-render may have detached it.
 */
  private richPopoverAnchorEl: HTMLElement | undefined = undefined;
  /** The task whose data populates the open popover. */
  private richPopoverTask: TaskRow | undefined = undefined;
  /** Pointer x at open time, reused when the popover is re-placed. */
  private richPopoverMouseX: number | undefined = undefined;
  /** pending mouse-leave → hide debounce timer. */
  private richPopoverHideTimer: ReturnType<typeof setTimeout> | undefined =
    undefined;



  /** True while a rich-popover control currently has active user focus/input. */
  private richPopoverInteractionActive = false;
  /** True after the pointer leaves the rich-popover trigger/popover area. */
  private richPopoverPointerOutside = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: TaskGanttViewHost
  ) {
    super(leaf);
    // day width comes from the persisted zoom setting.
    this.dayWidth = host.settings.ganttZoom;
  }

  /** matches VIEW_TYPE_TASK_GANTT in src/main.ts. */
  getViewType(): string {
    return "task-gantt-view";
  }

  getDisplayText(): string {
    return "Task Gantt";
  }

  /**
 *
 * Resets the container, builds the toolbar / scrollable wrap / drag tooltip
 * elements, attaches the scroll listener, runs the initial render, then —
 * inside requestAnimationFrame — auto-scrolls so today sits 220px from the
 * left edge.
 */
  async requestViewOperation(id: ViewOperationId, input: unknown): Promise<OperationRequestResultV1> {
    const args = operationInputSchemas[id].parse(input), before = { dayWidth: this.dayWidth, tagNames: [...this.activeTagFilter] };
    if (id === "V13") { this.activeTagFilter = new Set((args as OperationInputMap["V13"]).tagNames); await this.render(); }
    else if (id === "V14") await this.setZoom((args as OperationInputMap["V14"]).dayWidth);
    else if (id === "V15") { const target = args as OperationInputMap["V15"]; if (!this.dates.includes(target.date)) { this.rangeStart = addDays(target.date, -14); this.rangeDays = 90; this.renderChart(); } this.scrollToDate(target.date, target.offset); }
    else if (id === "V16") await this.render();
    else if (id === "V18") {
      const target = args as OperationInputMap["V18"];
      const task = this.tasks.flatMap((parent) => [parent, ...parent.subtasks?.values() ?? []]).find((row) => row.id === target.targetId);
      if (target.targetKind === "task" && (!task || task.kind !== "subtask") || target.targetKind === "event" && !this.host.settings.ganttEvents.some((event) => event.key === target.targetId)) throw new Error("NOT_FOUND");
      this.workloadModeStore.set(target.targetKind === "task" ? getWorkloadTaskKey(task!) : target.targetId, { mode: target.mode });
      this.closeWorkloadPopup();
    } else if (id === "V19") {
      const target = args as OperationInputMap["V19"];
      if (!target.enabled) this.bulkMoveState = undefined;
      else {
        const parent = this.tasks.find((row) => row.kind === "parent" && row.id === target.parentId);
        const anchor = [...parent?.subtasks?.values() ?? []].find((row) => row.id === target.anchorId);
        if (!parent || target.anchorId && !anchor) throw new Error("NOT_FOUND");
        this.bulkMoveState = { parentKey: parent.id, anchorKey: anchor?.id ?? "", anchorStart: anchor?.plannedStartDate ?? todayStr() };
      }
    } else if (id === "V17") {
      const target = args as OperationInputMap["V17"], anchorEl = this.barElsByTaskId.get(target.target) ?? this.wrapEl;
      if (target.kind === "weekly") {
        const button = this.wrapEl.querySelector<HTMLButtonElement>(".task-gantt-workload-settings-button"); if (!button) throw new Error("UI_UNAVAILABLE"); button.click();
      } else if (target.kind === "workload") { if (!this.host.settings.ganttFeatureWorkloadEnabled || !this.dates.includes(target.target)) throw new Error("UI_UNAVAILABLE"); this.showWorkloadDaySummaryPopup(target.target, anchorEl); }
      else if (target.kind === "daily") { const summary = this.dailyTodoSummaries.find((day) => day.date === target.target); if (!summary || !this.host.settings.ganttFeatureDailyTodoEnabled) throw new Error("UI_UNAVAILABLE"); this.openDailyTodoPopover(summary.date, anchorEl); }
      else if (target.kind === "event") { const event = this.host.settings.ganttEvents.find((event) => event.key === target.target); if (!event || !this.host.settings.ganttFeatureEventsEnabled || !this.host.settings.ganttFeatureWorkloadEnabled) throw new Error("UI_UNAVAILABLE"); this.showWorkloadPopupForEvent(event, anchorEl); }
      else {
        const task = this.tasks.flatMap((parent) => [parent, ...parent.subtasks?.values() ?? []]).find((row) => row.id === target.target && (target.kind === "parent" ? row.kind === "parent" : true));
        if (!task) throw new Error("NOT_FOUND");
        this.closeRichPopover(); this.openRichPopover(task.kind === "parent" ? { kind: "parent", task, anchorEl } : { kind: "subtask", task, anchorEl, barStart: task.plannedStartDate ?? "", barEnd: task.plannedEndDate ?? "" }, new MouseEvent("mouseover"));
      }
    } else return { schemaVersion: 1, resultKind: "request", operationId: id, status: "unavailable", effects: [], error: { code: "UI_UNAVAILABLE", retryable: false, nextAction: "Ganttに対応する表示操作を指定してください。" } };
    return { schemaVersion: 1, resultKind: "request", operationId: id, status: "applied", effects: [{ kind: "view", before, after: { dayWidth: this.dayWidth, tagNames: [...this.activeTagFilter], request: args as import("../contracts/context").Json }, affectedIds: [this.host.viewId!] }] };
  }
  async onOpen(): Promise<void> {
    this.unregisterHistoryHotkeys?.();
    this.unregisterHistoryHotkeys = registerHistoryHotkeys(this, this.containerEl, this.host);
    if (this.host.viewId) this.unregisterState = this.host.viewStatePort?.register(this.host.viewId, () => ({ viewId: this.host.viewId!, kind: "gantt", filterText: "", statusFilter: "all", showCompleted: true, tagNames: [...this.activeTagFilter], dayWidth: this.dayWidth }), (id, input) => this.requestViewOperation(id, input));

    this.host.logger.info?.("TaskGanttView", "view opened", {});

    const container = this.containerEl;
    // (Obsidian's HTMLElement.empty extension).
    container.empty();
    container.classList.add("task-gantt-container");


    this.toolbarEl = document.createElement("div");
    this.toolbarEl.classList.add("task-gantt-toolbar");
    container.appendChild(this.toolbarEl);
    this.renderToolbar();

    if (this.host.previewPort) {
      this.previewDockHost = document.createElement("div");
      this.previewDockHost.classList.add("vg-pv-dockhost");
      this.previewDockHost.hidden = true;
      container.appendChild(this.previewDockHost);
      this.previewLayer = new PreviewGanttLayer(this.host.previewPort);
      this.unsubscribePreview = this.previewLayer.subscribe(() => {
        this.clearGhostLayer();
        this.renderPreviewDock();
        this.renderChart();
      });
      this.renderPreviewDock();
    }

    this.wrapEl = document.createElement("div");
    this.wrapEl.classList.add("task-gantt-wrap");
    container.appendChild(this.wrapEl);
    // scroll handler drives range auto-extension + floating month.
    this.wrapEl.addEventListener("scroll", () => {
      this.onScroll();
    });

    // Create the shared drag tooltip element.

    const dragTooltipEl = document.createElement("div");
    dragTooltipEl.classList.add("task-gantt-drag-tooltip");
    container.appendChild(dragTooltipEl);
    this.dragTooltipEl = dragTooltipEl;


    this.unsubscribeGhosts = this.host.ghosts?.subscribe((event) => {
      if (event === "show") this.renderChart();
      else this.clearGhostLayer();
    });
    await this.render();

    // defer the initial scroll to the next animation frame so the
    // freshly built content has layout.
    requestAnimationFrame(() => {
      this.scrollToDate(todayStr(), INITIAL_SCROLL_OFFSET_PX);
    });
  }

  onResize(): void {
    const wrap = this.wrapEl;
    if (!wrap || !this.floatingMonthEl) return;
    // Obsidian can restore a hidden tab's scroll position as it reveals it,
    // without a usable scroll event during the range-extension guard.
    requestAnimationFrame(() => {
      if (this.wrapEl !== wrap || !wrap.isConnected || wrap.offsetParent === null) return;
      if (this.chartNeedsVisibleRender) {
        const initial = !this.dates.length;
        this.renderChart();
        if (initial) this.scrollToDate(todayStr(), INITIAL_SCROLL_OFFSET_PX);
      }
      this.updateFloatingMonth();
    });
  }

  /**
 * The three popover kinds (rich popover, workload popup, workload day
 * summary popover) are appended to document.body rather than containerEl
 * (see each's own appendChild call site for why: Obsidian's
 * `.workspace-leaf.mod-active { contain: strict }` breaks position:fixed's
 * viewport-relative math otherwise). Because of that, closing the view no
 * longer removes them for free as a side effect of the leaf's own DOM
 * detaching — without this override, a popover left open at the moment
 * the view closes (tab closed, navigated away) would leak into
 * document.body permanently. All three close methods are idempotent
 * no-ops when nothing is open.
 */
  onClose(): Promise<void> {
    this.unregisterHistoryHotkeys?.(); this.unregisterHistoryHotkeys = undefined;
    this.unregisterState?.(); this.unregisterState = undefined;
    // The overlay never outlives the view; a pending plan itself stays in the store.
    this.unsubscribePreview?.(); this.unsubscribePreview = undefined;
    if (this.previewLayer?.active) this.previewLayer.close();
    this.previewLayer?.dispose(); this.previewLayer = undefined;
    this.unsubscribeGhosts?.(); this.unsubscribeGhosts = undefined;
    this.host.ghosts?.clear();
    this.clearGhostLayer();
    this.activeContextMenu?.hide();
    this.activeContextMenu = undefined;


    this.tagFilterMenuEl?.remove();
    this.tagFilterMenuEl = undefined;
    if (this.tagFilterMenuOutsideClickHandler) {
      window.removeEventListener("click", this.tagFilterMenuOutsideClickHandler);
      this.tagFilterMenuOutsideClickHandler = undefined;
    }


    this.closeRichPopover();
    this.closeWorkloadPopup();
    this.closeWorkloadDaySummaryPopover();
    this.closeDailyTodoPopover();
    return Promise.resolve();
  }

  private clearGhostLayer(): void {
    for (const [taskId, { nodes, current }] of this.ghostNodes) {
      this._ganttRowCache?.rowFingerprints.delete(taskId.split("::")[0]);
      nodes.forEach((node) => node.remove()); current?.classList.remove("vg-ai-target");
    }
    this.ghostNodes.clear(); this.ghostLegend?.remove(); this.ghostLegend = undefined;
    for (const [taskId, nodes] of this.previewNodes) {
      this._ganttRowCache?.rowFingerprints.delete(taskId.split("::")[0]);
      nodes.forEach((node) => node.remove());
    }
    this.previewNodes.clear();
    for (const bar of this.previewMarkedBars) bar.classList.remove("vg-pv-delete-target");
    this.previewMarkedBars.clear();
  }

  /** Re-draws the separate preview region (after-state rows, panels) for the focused preview. */
  private renderPreviewDock(): void {
    const host = this.previewDockHost; if (!host || !this.previewLayer) return;
    host.empty();
    this.previewLayer.renderDock(host);
    host.hidden = !this.previewLayer.active;
  }

  /** Deadline/marker ghosts and delete labels for one task, in the same lane as the schedule ghost. */
  private paintPreviewExtras(timeline: HTMLElement, taskId: string, baseDate: string, dayWidth: number, top: number, bar?: HTMLElement): void {
    const layer = this.previewLayer; if (!layer?.active) return;
    this.previewNodes.get(taskId)?.forEach((node) => node.remove());
    const nodes: HTMLElement[] = [];
    const points = layer.pointsFor(taskId);
    if (points.length) nodes.push(...renderPointGhosts(timeline, points, baseDate, dayWidth, top));
    if (layer.isDeleted(taskId)) {
      if (bar) { bar.classList.add("vg-pv-delete-target"); this.previewMarkedBars.add(bar); }
      const note = document.createElement("span"); note.className = "vg-pv-live-delete";
      note.textContent = "削除予定"; note.title = "承認すると削除されます（元の行は承認まで変わりません）";
      note.style.top = Math.max(0, top - 10) + "px"; note.style.left = (bar ? Number.parseFloat(bar.style.left || "0") : 0) + "px";
      timeline.appendChild(note); nodes.push(note);
    }
    if (nodes.length) this.previewNodes.set(taskId, nodes);
  }

  /** Opens a context menu after closing any prior menu and its native children. */
  private activateContextMenu(menu: Menu): void {
    this.activeContextMenu?.hide();
    this.activeContextMenu = menu;
    menu.onHide(() => {
      if (this.activeContextMenu === menu) {
        this.activeContextMenu = undefined;
      }
    });
  }

  /**
 * full reload + rebuild. Re-reads tasks from the host, then
 * rebuilds the chart.
 */
  async render(): Promise<void> {

    const renderStartedAt = Date.now();

    await Promise.all([this.refreshTasks(), this.refreshDailyTodoSummaries()]);
    this.renderChart();

    this.host.logger.debug?.("TaskGanttView", "render completed", {
      durationMs: Date.now() - renderStartedAt,
    });

  }

  /** Loads host.loadTasks into this.tasks. */
  private async refreshTasks(): Promise<void> {
    this.tasks = await this.host.loadTasks();
  }

  /** Loads Daily ToDo summaries only while the fixed row is enabled. */
  private async refreshDailyTodoSummaries(): Promise<void> {
    if (!this.host.settings.ganttFeatureDailyTodoEnabled) {
      this.dailyTodoSummaries = [];
      return;
    }
    this.dailyTodoSummaries = await this.host.loadDailyTodoSummaries();
  }

  /**
 *
 * Chart render entry. Computes the current header fingerprint from the
 * live render inputs, then takes either the incremental diff path (all
 * four gate conditions true) or the full-rebuild path. The default enables
 * the incremental gate; setting incrementalGanttRender to false deliberately
 * selects the full-render escape hatch.
 */
  renderChart(): void {
    // Hidden tabs report zero scroll offsets. Rebuilding them would discard
    // the visible date and derive a month from the range's far-left edge.
    if (this.wrapEl.offsetParent === null) { this.chartNeedsVisibleRender = true; return; }
    this.chartNeedsVisibleRender = false;
    this.dateClassesCache.clear();
    if ((this.host.ghosts?.entries.size || this.previewLayer?.active) && !this.ghostLegend) {
      const legend = this.previewLayer?.legend();
      this.ghostLegend = document.createElement("span");
      this.ghostLegend.className = "vg-ai-legend";
      this.ghostLegend.textContent = legend?.text ?? "AI変更 · 上: 前（破線） ／ 下: 後 · 60秒";
      this.ghostLegend.title = legend?.title ?? "変更前は上段の破線帯、変更後は下段の通常バー。◀ ▶は範囲外。詳細は会話の結果カードで確認できます。";
      this.toolbarEl.appendChild(this.ghostLegend);
    }

    // a chart rebuild detaches the current chip, so do not leave
    // its body-anchored detail popover orphaned behind.
    this.closeDailyTodoPopover();

    // dates for the current range, cached for the viewport
    // helpers (scrollToDate, getVisibleStartDate).
    const dates = buildDates(this.rangeStart, this.rangeDays);
    this.dates = dates;

    // Build the shared holiday set once per render so the header and every
    // parent row classify dates consistently.
    this.holidaySet = new Set<string>([
      ...this.host.settings.ganttNationalHolidays,
      ...this.host.settings.ganttManualHolidays,
      ...this.host.settings.ganttSpecialHolidays,
    ]);
    this.todayForRender = todayStr();

    // Get the visible Gantt parents in display order.
    const parents = getGanttParentRows(this.tasks);

    // Build the header fingerprint from the current render inputs so it
    // stays consistent with the header. Parent order is preserved, so changes
    // to ganttOrder or displayName affect the fingerprint; activeTagFilter is
    // sorted into the fingerprint, so filter changes force a full rebuild.
    const headerFingerprint = computeHeaderFingerprint({
      dates,
      dayWidth: this.dayWidth,
      today: this.todayForRender,
      holidays: Array.from(this.holidaySet),
      featureFlags: {
        workload: this.host.settings.ganttFeatureWorkloadEnabled,
        events: this.host.settings.ganttFeatureEventsEnabled,
        dailyTodo: this.host.settings.ganttFeatureDailyTodoEnabled,
        tags: this.host.settings.ganttFeatureTagsEnabled,
      },
      parentPaths: parents.map((parent) => parent.file.path),
      activeTagFilter: this.activeTagFilter,
      tagDefinitions: Array.isArray(this.host.settings.ganttTags)
        ? this.host.settings.ganttTags
        : [],
    });

    // Use incremental rendering only when all four gate conditions hold and
    // the cached root is still connected; otherwise, perform a full rebuild.
    const cache = this._ganttRowCache;
    if (
      this.host.settings.incrementalGanttRender !== false &&
      cache !== undefined &&
      cache.headerFingerprint === headerFingerprint &&
      cache.rootEl.isConnected
    ) {
      this.renderChartIncremental(cache, parents, dates, headerFingerprint);
    } else {
      this.renderChartFull(parents, dates, headerFingerprint);
    }
  }









  private renderChartFull(
    parents: TaskRow[],
    dates: string[],
    headerFingerprint: string
  ): void {
    // Removing live scroll content clamps the browser's offsets to zero.
    // Restore them after rebuilding, before deriving the visible month.
    const scrollLeft = this.wrapEl.scrollLeft, scrollTop = this.wrapEl.scrollTop;
    this.wrapEl.empty();

    // header, then the fixed rows — rendered even when
    // the parent list turns out empty below.
    this.renderHeader(dates);
    this.renderWorkloadSummaryRow(parents, dates);
    this.renderFixedEventRow();
    this.renderDailyTodoRow();

    if (parents.length === 0) {
      // no Gantt-enabled parents → empty
      // message, drop the row cache, and skip the add-row entirely
      // via the early return.
      this._ganttRowCache = undefined;
      const empty = document.createElement("div");
      empty.classList.add("task-gantt-empty");
      empty.textContent =
        "ガント表示対象の親タスクがありません。親タスクの frontmatter / ダッシュボードで ganttEnabled を true にしてください。";
      this.wrapEl.appendChild(empty);
      this.wrapEl.scrollLeft = scrollLeft; this.wrapEl.scrollTop = scrollTop;
      this.updateFloatingMonth();
      return;
    }

    // Render one row per parent in display order, except parents hidden by
    // the active tag filter.

    // Perf: rows are built into a detached DocumentFragment and attached to
    // wrapEl ONCE at the end, instead of one appendChild per row directly
    // on the live (already-connected) wrapEl. A detached fragment has no
    // layout at all, so building hundreds of rows into it is pure DOM
    // construction with no incremental style/layout recalculation; the
    // single final appendChild is the only point where the browser has to
    // lay the new subtree out. Same final DOM order/structure, same rowEls
    // map — this changes nothing observable, only batches attachment.
    const rowEls = new Map<string, HTMLElement>();
    const rowFingerprints = new Map<string, string>();
    const rowFragment = document.createDocumentFragment();
    for (const parent of parents) {
      if (!this.isGanttParentVisible(parent)) {
        continue;
      }
      const rowEl = this.renderParentRow(parent, dates);
      rowFragment.appendChild(rowEl);
      rowEls.set(parent.file.path, rowEl);
      rowFingerprints.set(parent.file.path, computeRowFingerprint(parent) + (this.host.ghosts?.fingerprint(parent.file.path) ?? "") + (this.previewLayer?.fingerprint(parent.file.path) ?? ""));
    }
    this.wrapEl.appendChild(rowFragment);

    // cache population follows the setting; it is enabled
    // by default and disabled only by the explicit false escape hatch.
    if (this.host.settings.incrementalGanttRender !== false) {
      this._ganttRowCache = {
        rootEl: this.wrapEl,
        headerFingerprint,
        rowEls,
        rowFingerprints,
      };
    } else {
      this._ganttRowCache = undefined;
    }

    // the add row is (re)built at the very end.
    this.renderParentAddRow();

    this.wrapEl.scrollLeft = scrollLeft; this.wrapEl.scrollTop = scrollTop;

    // keep the floating month in sync after every chart render.
    this.updateFloatingMonth();
  }

  /**
 *
 * Incremental diff render: reuse the cached root (NO wrapEl.empty),
 * re-render only the parents whose row fingerprint changed, and leave
 * every unchanged row's DOM untouched. Replacements capture the old row's
 * next sibling before removal so insertBefore keeps the new row in the same
 * slot. Rows whose parent vanished are removed from the DOM and from the
 * rebuilt cache maps.
 *
 * Falls back to a full rebuild when a visible parent has no cache entry
 * (`oldEl === undefined`) despite an unchanged header fingerprint. The
 * fingerprint includes every Gantt-enabled parent before tag-filter
 * visibility is applied, so a parent previously hidden by the filter may
 * become visible without changing the fingerprint. Appending it at the end
 * would break display order, so the renderer rebuilds rather than guessing
 * its position.
 */
  private renderChartIncremental(
    cache: GanttRowCache,
    parents: TaskRow[],
    dates: string[],
    headerFingerprint: string
  ): void {
    // Keep the cached root, header, and fixed rows; their inputs are stable
    // within this render epoch.
    // The fixed-row references are part of that cache invariant too: if an
    // external DOM operation detached one, rebuilding is safer than letting a
    // summary helper append it at the chart's end.
    const isCurrentFixedRow = (row: HTMLElement | undefined): boolean =>
      row !== undefined && row.isConnected && row.parentNode === this.wrapEl;
    if (
      (this.host.settings.ganttFeatureWorkloadEnabled &&
        !isCurrentFixedRow(this.workloadSummaryRowEl)) ||
      (this.host.settings.ganttFeatureEventsEnabled &&
        !isCurrentFixedRow(this.eventRowEl)) ||
      (this.host.settings.ganttFeatureDailyTodoEnabled &&
        !isCurrentFixedRow(this.dailyTodoRowEl))
    ) {
      this.renderChartFull(parents, dates, headerFingerprint);
      return;
    }

    const currentPaths = new Set(parents.map((parent) => parent.file.path));

    // Remove rows whose parent no longer exists; their cache entries will
    // also be absent from the maps rebuilt below.
    for (const [path, oldEl] of cache.rowEls) {
      if (!currentPaths.has(path)) {
        oldEl.remove();
      }
    }

    const nextRowEls = new Map<string, HTMLElement>();
    const nextRowFingerprints = new Map<string, string>();

    for (const parent of parents) {
      const path = parent.file.path;
      const oldEl = cache.rowEls.get(path);

      // a tag-filter-hidden parent has no row; any stale row
      // (from before it became hidden) is removed.
      if (!this.isGanttParentVisible(parent)) {
        if (oldEl !== undefined) {
          oldEl.remove();
        }
        continue;
      }

      // A visible parent with no cache entry: reachable when a
      // previously tag-filter-hidden parent becomes visible again without
      // the header fingerprint changing (see this method's docblock) —
      // there is no cached neighbor to anchor insertBefore on, so bail to
      // the always-position-correct full rebuild rather than guess.
      if (oldEl === undefined) {
        this.renderChartFull(parents, dates, headerFingerprint);
        return;
      }


      const fingerprint = computeRowFingerprint(parent) + (this.host.ghosts?.fingerprint(parent.file.path) ?? "") + (this.previewLayer?.fingerprint(parent.file.path) ?? "");
      if (
        oldEl !== undefined &&
        cache.rowFingerprints.get(path) === fingerprint
      ) {
        // unchanged — zero DOM touch.
        nextRowEls.set(path, oldEl);
        nextRowFingerprints.set(path, fingerprint);
        continue;
      }

      // capture the insertion point BEFORE detaching the old
      // row (nextSibling of a removed node is null).
      const insertBeforeRef = oldEl !== undefined ? oldEl.nextSibling : null;

      if (oldEl !== undefined) {
        oldEl.remove();
      }

      const newEl = this.renderParentRow(parent, dates);

      if (insertBeforeRef !== null) {
        this.wrapEl.insertBefore(newEl, insertBeforeRef);
      } else {
        this.wrapEl.appendChild(newEl);
      }
      nextRowEls.set(path, newEl);
      nextRowFingerprints.set(path, fingerprint);
    }

    // (cache half): only current parents' entries survive.
    cache.rowEls = nextRowEls;
    cache.rowFingerprints = nextRowFingerprints;

    // unlike the header,
    // the fixed rows carry real per-date data that can go stale within an
    // incremental epoch (e.g. a workload paint-drag or event CRUD never
    // changes the header fingerprint). Refresh all of them here so an
    // incremental pass has the same fixed-row data and listeners as a full
    // rebuild. The Daily ToDo helper also closes its body-anchored popover
    // before replacing the chip anchor.
    if (!this.refreshFixedEventRowIncremental()) {
      this.renderChartFull(parents, dates, headerFingerprint);
      return;
    }
    this.refreshWorkloadSummaryRowIncremental(parents, dates);
    this.refreshDailyTodoRowIncremental();

    // Finish with the same updates as the full-rebuild path.
    this.renderParentAddRow();
    this.updateFloatingMonth();
  }


  // Toolbar (zoom controls + floating month)












  private renderToolbar(): void {
    this.toolbarEl.empty();


    this.floatingMonthEl = document.createElement("span");
    this.floatingMonthEl.classList.add("task-gantt-floating-month");
    this.toolbarEl.appendChild(this.floatingMonthEl);

    // 「Workbench」 — opens the Task Workbench view.
    const workbenchButton = document.createElement("button");
    workbenchButton.classList.add("task-gantt-workbench");
    workbenchButton.textContent = "Workbench";
    workbenchButton.addEventListener("click", () => {
      void this.host.activateView();
    });
    this.toolbarEl.appendChild(workbenchButton);

    // 「今日へ」 — extends the range to include
    // today, re-renders, then (next frame, so the fresh content has layout)
    // scrolls today into view with the SAME 220px margin / scrollToDate math
    // the same margin and scrollToDate calculation as the initial auto-scroll.
    const todayButton = document.createElement("button");
    todayButton.classList.add("task-gantt-today");
    todayButton.textContent = "今日へ";
    todayButton.addEventListener("click", () => {
      this.ensureDateInRange(todayStr());
      this.renderChart();
      requestAnimationFrame(() => {
        this.scrollToDate(todayStr(), INITIAL_SCROLL_OFFSET_PX);
      });
    });
    this.toolbarEl.appendChild(todayButton);


    // ±6px per click, clamped to [14, 72].
    const zoomOut = document.createElement("button");
    zoomOut.classList.add("task-gantt-zoom-out", "clickable-icon");
    setToolbarIcon(zoomOut, "minus", "縮小");
    zoomOut.addEventListener("click", () => {
      void this.setZoom(this.clampZoom(this.dayWidth - ZOOM_STEP_PX));
    });
    this.toolbarEl.appendChild(zoomOut);

    // read-only zoom-level text, not a button.
    this.zoomLabelEl = document.createElement("span");
    this.zoomLabelEl.classList.add("task-gantt-zoom-label");
    this.zoomLabelEl.textContent = this.zoomLabelText();
    this.toolbarEl.appendChild(this.zoomLabelEl);

    const zoomIn = document.createElement("button");
    zoomIn.classList.add("task-gantt-zoom-in", "clickable-icon");
    setToolbarIcon(zoomIn, "plus", "拡大");
    zoomIn.addEventListener("click", () => {
      void this.setZoom(this.clampZoom(this.dayWidth + ZOOM_STEP_PX));
    });
    this.toolbarEl.appendChild(zoomIn);

    // 「更新」 — manual full reload + rebuild.
    const refreshButton = document.createElement("button");
    refreshButton.classList.add("task-gantt-refresh");
    refreshButton.textContent = "更新";
    refreshButton.addEventListener("click", () => {
      void this.render();
    });
    this.toolbarEl.appendChild(refreshButton);

    const undoButton = document.createElement("button");
    undoButton.classList.add("task-gantt-undo", "clickable-icon");
    setToolbarIcon(undoButton, "undo-2", "元に戻す");
    undoButton.addEventListener("click", () => {
      void this.host.undoLastAction();
    });
    this.toolbarEl.appendChild(undoButton);

    const redoButton = document.createElement("button");
    redoButton.classList.add("task-gantt-redo", "clickable-icon");
    setToolbarIcon(redoButton, "redo-2", "やり直す");
    redoButton.addEventListener("click", () => {
      void this.host.redoLastAction();
    });
    this.toolbarEl.appendChild(redoButton);

    // 「同期」 — manual read-only Gantt sync trigger.
    const syncButton = document.createElement("button");
    syncButton.classList.add("task-gantt-sync");
    syncButton.textContent = "同期";
    syncButton.addEventListener("click", () => {
      void this.host.syncReadonlyGanttNow();
    });
    this.toolbarEl.appendChild(syncButton);

    // read-only version info, right side.
    const versionInfo = document.createElement("span");
    versionInfo.classList.add("task-gantt-version-info");
    const manifest = this.host.manifest;
    const notes = manifest.releaseNotes || manifest.description || "";
    versionInfo.textContent = `※ v${manifest.version}: ${notes}`;
    this.toolbarEl.appendChild(versionInfo);
  }

  private zoomLabelText(): string {
    return `${this.dayWidth}px/日`;
  }

  private clampZoom(value: number): number {
    return Math.max(ZOOM_MIN_PX, Math.min(ZOOM_MAX_PX, value));
  }





  /**
 * Builds the left side of the header and the month, day, and weekday rows.
 * Each date uses one cell of `dayWidth` pixels; date classes stay consistent
 * across all three rows.
 */
  private renderHeader(dates: string[]): void {
    // The header and any open tag-filter menu are about to be torn down and
    // rebuilt from scratch — remove the body-anchored menu and drop the
    // outside-click listener now rather than leaving either dangling.
    this.tagFilterMenuEl?.remove();
    this.tagFilterMenuEl = undefined;
    if (this.tagFilterMenuOutsideClickHandler) {
      window.removeEventListener("click", this.tagFilterMenuOutsideClickHandler);
      this.tagFilterMenuOutsideClickHandler = undefined;
    }

    const header = document.createElement("div");
    header.classList.add("task-gantt-header");

    // The header's left section contains the fixed "親タスク" label and,
    // when tags are enabled, a tag-filter button showing the active filter
    // count. Clicking it opens the filter menu. A full rebuild recreates the
    // button and label to reflect the current filter state.
    const headerLeft = document.createElement("div");
    headerLeft.classList.add("task-gantt-header-left");
    const leftLabel = document.createElement("span");
    leftLabel.textContent = "親タスク";
    headerLeft.appendChild(leftLabel);
    if (this.host.settings.ganttFeatureTagsEnabled) {
      const tagFilterButton = document.createElement("button");
      tagFilterButton.classList.add("task-gantt-tag-filter");
      tagFilterButton.textContent = this.tagFilterButtonLabel();
      tagFilterButton.addEventListener("click", () => {
        this.openTagFilterMenu(tagFilterButton);
      });
      headerLeft.appendChild(tagFilterButton);
    }
    header.appendChild(headerLeft);


    // value both come from the shared dateClasses helper (its inputs are
    // rebuilt once per render in renderChart), so the header cells and the
    // parent-row timeline backgrounds always classify dates identically.
    const monthRow = document.createElement("div");
    monthRow.classList.add("task-gantt-month-row");
    const dayRow = document.createElement("div");
    dayRow.classList.add("task-gantt-day-row");
    const dowRow = document.createElement("div");
    dowRow.classList.add("task-gantt-dow-row");

    const widthStyle = `${this.dayWidth}px`;

    dates.forEach((date, index) => {
      // Apply the same shared per-date classes to all three rows.
      const { isWeekend, isHoliday, isToday } = this.dateClasses(date);
      const applyClasses = (el: HTMLElement): void => {
        if (isWeekend) {
          el.classList.add("is-weekend");
        }
        if (isHoliday) {
          el.classList.add("is-holiday");
        }
        if (isToday) {
          el.classList.add("is-today");
        }
      };

      // Month cell: month label only at a month boundary.
      const monthCell = document.createElement("div");
      monthCell.classList.add("task-gantt-month-cell");
      monthCell.style.width = widthStyle;
      applyClasses(monthCell);
      if (isMonthStart(dates, index)) {
        // Use a narrow-cell date axis: the month boundary carries
        // the compact "M月" title so the label remains legible at one day's
        // column width instead of being clipped to a few characters.
        monthCell.textContent = monthTitle(date);
      }
      monthRow.appendChild(monthCell);

      // Day cell: zero-padded day of month.
      const dayCell = document.createElement("div");
      dayCell.classList.add("task-gantt-day-cell");
      dayCell.style.width = widthStyle;
      applyClasses(dayCell);
      dayCell.textContent = dateLabel(date).day;
      dayRow.appendChild(dayCell);

      // Dow cell: short weekday; clicking toggles the holiday
      // flag.
      const dowCell = document.createElement("div");
      dowCell.classList.add("task-gantt-dow-cell");
      dowCell.style.width = widthStyle;
      applyClasses(dowCell);
      dowCell.textContent = dateLabel(date).dow;
      dowCell.addEventListener("click", () => {
        void this.toggleHoliday(date);
      });
      dowRow.appendChild(dowCell);
    });

    header.appendChild(monthRow);
    header.appendChild(dayRow);
    header.appendChild(dowRow);

    this.wrapEl.appendChild(header);
  }





  /** button label — 「タグ絞込」 or 「タグ絞込(N)」 when filtering. */
  private tagFilterButtonLabel(): string {
    return this.activeTagFilter.size === 0
      ? "タグ絞込"
      : `タグ絞込(${this.activeTagFilter.size})`;
  }

  /** The configured tag names offered by the filter menu, in registry order. */
  private collectGanttFilterTags(): string[] {
    return (Array.isArray(this.host.settings.ganttTags)
      ? this.host.settings.ganttTags
      : []
    )
      .map((definition) => definition.name.trim())
      .filter((name) => name !== "");
  }

  /**
 * Walks up `node`'s parentNode chain looking for `root` — a manual
 * containment check (rather than the native Element.contains, which
 * this codebase's fake-DOM test harness does not implement) used by
 * openTagFilterMenu's outside-click handler.
 */
  private isSelfOrDescendant(root: HTMLElement, node: unknown): boolean {
    let cursor = node as { parentNode?: unknown } | null;
    while (cursor) {
      if ((cursor as unknown) === (root as unknown)) {
        return true;
      }
      cursor = (cursor.parentNode as { parentNode?: unknown } | null) ?? null;
    }
    return false;
  }






























  private openTagFilterMenu(button: HTMLElement): void {
    // Single-instance dedupe: remove a previously opened menu. (After a
    // full rebuild the old reference is detached — remove on a detached
    // element is a no-op.)
    this.tagFilterMenuEl?.remove();
    this.tagFilterMenuEl = undefined;
    if (this.tagFilterMenuOutsideClickHandler) {
      window.removeEventListener("click", this.tagFilterMenuOutsideClickHandler);
      this.tagFilterMenuOutsideClickHandler = undefined;
    }

    const tags = this.collectGanttFilterTags();
    const menu = document.createElement("div");
    menu.classList.add("task-gantt-tag-filter-menu");

    const title = document.createElement("div");
    title.classList.add("task-gantt-tag-filter-title");
    title.textContent = "タグで絞り込み";
    menu.appendChild(title);

    if (tags.length === 0) {
      // Show the same empty-state message used by the context menus.
      const empty = document.createElement("div");
      empty.classList.add("task-gantt-tag-filter-empty");
      empty.textContent = "タグは未作成です";
      menu.appendChild(empty);
    } else {
      for (const tag of tags) {
        const item = document.createElement("label");
        item.classList.add("task-gantt-tag-filter-item");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = this.activeTagFilter.has(tag);
        checkbox.addEventListener("change", () => {
          const scrollLeft = this.wrapEl.scrollLeft;
          // Set.add/Set.delete directly from the checkbox
          // toggle.
          if (checkbox.checked) {
            this.activeTagFilter.add(tag);
          } else {
            this.activeTagFilter.delete(tag);
          }
          // filter change → header fingerprint change → the
          // re-render takes the full-rebuild path.
          this.renderChart();
          this.wrapEl.scrollLeft = scrollLeft;
        });
        item.appendChild(checkbox);

        // color swatch from the matching registry definition.
        const swatch = document.createElement("span");
        swatch.classList.add("task-gantt-tag-filter-swatch");
        const definition = findGanttTagDefinition(this.host.settings, tag);
        if (definition?.color) {
          swatch.style.backgroundColor = definition.color;
        }
        item.appendChild(swatch);

        const name = document.createElement("span");
        name.classList.add("task-gantt-tag-filter-name");
        name.textContent = tag;
        item.appendChild(name);
        menu.appendChild(item);
      }
    }

    // footer 「解除」/「閉じる」.
    const footer = document.createElement("div");
    footer.classList.add("task-gantt-tag-filter-footer");
    const clearButton = document.createElement("button");
    clearButton.classList.add("vg-btn-sm");
    clearButton.textContent = "解除";
    clearButton.addEventListener("click", () => {
      const scrollLeft = this.wrapEl.scrollLeft;
      this.activeTagFilter.clear();
      this.renderChart(); // header fingerprint changes, same as a toggle.
      this.wrapEl.scrollLeft = scrollLeft;
    });
    footer.appendChild(clearButton);
    const closeButton = document.createElement("button");
    closeButton.classList.add("vg-btn-sm");
    closeButton.textContent = "閉じる";
    closeButton.addEventListener("click", () => {
      this.tagFilterMenuEl?.remove();
      this.tagFilterMenuEl = undefined;
      if (this.tagFilterMenuOutsideClickHandler) {
        window.removeEventListener(
          "click",
          this.tagFilterMenuOutsideClickHandler
        );
        this.tagFilterMenuOutsideClickHandler = undefined;
      }
    });
    footer.appendChild(closeButton);
    menu.appendChild(footer);



    const buttonRect = button.getBoundingClientRect();
    menu.style.top = `${buttonRect.bottom}px`;
    menu.style.left = `${buttonRect.left}px`;
    document.body.appendChild(menu);


    this.tagFilterMenuEl = menu;

    // outside click auto-closes; a click landing on the menu
    // itself or on the toggle button (which has its own open/close-by-
    // reopen click handler) is ignored.
    const outsideClickHandler = (evt: MouseEvent): void => {
      const target = evt.target as unknown;
      if (
        this.isSelfOrDescendant(menu, target) ||
        this.isSelfOrDescendant(button, target)
      ) {
        return;
      }
      this.tagFilterMenuEl?.remove();
      this.tagFilterMenuEl = undefined;
      window.removeEventListener("click", outsideClickHandler);
      this.tagFilterMenuOutsideClickHandler = undefined;
    };
    this.tagFilterMenuOutsideClickHandler = outsideClickHandler;
    window.addEventListener("click", outsideClickHandler);
  }

  /**
 *
 * Determines whether a parent row is visible under the active tag filter.
 * With no filter, every row is visible. Otherwise, matching the parent's
 * own tags is sufficient to keep the row, even if it has no visible bars;
 * a row is omitted only when neither the parent nor any subtask matches.
 */
  private isGanttParentVisible(parent: TaskRow): boolean {
    if (this.activeTagFilter.size === 0) {
      return true;
    }
    if (hasAnySelectedGanttTag(parent.tags, this.activeTagFilter)) {
      return true;
    }
    if (parent.subtasks !== undefined) {
      for (const subtask of parent.subtasks.values()) {
        if (hasAnySelectedGanttTag(subtask.tags, this.activeTagFilter)) {
          return true;
        }
      }
    }
    return false;
  }






















  private getBarFilterState(_parent: TaskRow, bar: Bar): { visible: boolean } {
    return {
      visible:
        this.activeTagFilter.size === 0 ||
        hasAnySelectedGanttTag(bar.task.tags, this.activeTagFilter),
    };
  }



















  private getMarkerFilterState(
    parent: TaskRow,
    bar: Bar,
    marker: GanttMarker
  ): { dim: boolean } {
    if (this.activeTagFilter.size === 0) {
      return { dim: false };
    }
    const matches =
      hasAnySelectedGanttTag(parent.tags, this.activeTagFilter) ||
      hasAnySelectedGanttTag(bar.task.tags, this.activeTagFilter) ||
      hasAnySelectedGanttTag(marker.tags ?? [], this.activeTagFilter);
    return { dim: !matches };
  }


























  /**
 * Serializes the semantic workload inputs, intentionally excluding dayWidth:
 * zoom changes only need the existing row's geometry updated, not a new
 * parents × subtasks × dates aggregation.
 */
  private workloadSummaryInputsFingerprint(
    parents: TaskRow[],
    dates: string[]
  ): string {
    const serializeWorkloadMap = (
      values: Record<string, number> | undefined
    ): Array<[string, number]> =>
      Object.entries(values ?? {}).sort(([dateA], [dateB]) =>
        dateA.localeCompare(dateB)
      );

    return JSON.stringify({
      dates,
      capacityHours: getCapacityHours(this.host.settings),
      holidays: Array.from(this.holidaySet).sort(),
      today: this.todayForRender,
      parents: parents.map((parent) => ({
        path: parent.file.path,
        subtasks: Array.from(parent.subtasks?.values() ?? [])
          .map((subtask) => ({
            id: subtask.id,
            plannedStartDate: subtask.plannedStartDate ?? "",
            plannedEndDate: subtask.plannedEndDate ?? "",
            workloadPlan: serializeWorkloadMap(subtask.workloadPlan),
            workloadActual: serializeWorkloadMap(subtask.workloadActual),
          }))
          .sort((subtaskA, subtaskB) => subtaskA.id.localeCompare(subtaskB.id)),
      })),
    });
  }

  /** The only O(visible dates × subtasks) workload aggregation in this view. */
  private computeWorkloadSummaryValues(
    parents: TaskRow[],
    dates: string[]
  ): Map<string, WorkloadSummaryTotals> {
    const totalsByDate = new Map<string, WorkloadSummaryTotals>();
    for (const date of dates) {
      let plan = 0;
      let actual = 0;
      for (const parent of parents) {
        for (const subtask of parent.subtasks?.values() ?? []) {
          if (
            !hasPlannedDates(subtask) ||
            date < subtask.plannedStartDate ||
            date > subtask.plannedEndDate
          ) {
            continue;
          }
          const values = dayValues(subtask, date);
          plan += values.plan;
          actual += values.actual;
        }
      }


      // weekly schedules are plan-only and match indefinitely
      // by calendar weekday, regardless of any subtask date range.
      const schedules: WeeklyWorkSchedule[] = Array.isArray(
        this.host.settings.weeklyWorkSchedules
      )
        ? this.host.settings.weeklyWorkSchedules
        : [];
      const dayOfWeek = moment(date, "YYYY-MM-DD").day();
      for (const schedule of schedules) {
        if (dayOfWeek === schedule.dayOfWeek) {
          plan += schedule.minutesPerWeek / 60;
        }
      }


      totalsByDate.set(date, { plan, actual });
    }
    return totalsByDate;
  }

  /** Returns cached totals when all semantic workload inputs are unchanged. */
  private getWorkloadSummaryValues(
    parents: TaskRow[],
    dates: string[]
  ): Map<string, WorkloadSummaryTotals> {
    const fingerprint = this.workloadSummaryInputsFingerprint(parents, dates);
    if (
      this.workloadSummaryFingerprint === fingerprint &&
      this.workloadSummaryTotals !== undefined
    ) {
      return this.workloadSummaryTotals;
    }

    const totals = this.computeWorkloadSummaryValues(parents, dates);
    this.workloadSummaryFingerprint = fingerprint;
    this.workloadSummaryTotals = totals;
    return totals;
  }

  /** Updates only zoom-dependent geometry while reusing computed cell values. */
  private updateWorkloadSummaryRowGeometry(row: HTMLElement): void {
    const timeline = Array.from(row.children).find((child) =>
      child.classList.contains("task-gantt-workload-row")
    ) as HTMLElement | undefined;
    if (!timeline) {
      return;
    }

    timeline.style.width = `${this.dates.length * this.dayWidth}px`;
    let backgroundIndex = 0;
    for (const child of Array.from(timeline.children)) {
      const element = child as HTMLElement;
      if (element.classList.contains("task-gantt-fixed-bg")) {
        element.style.left = `${backgroundIndex * this.dayWidth}px`;
        element.style.width = `${this.dayWidth}px`;
        backgroundIndex += 1;
      } else if (
        element.classList.contains("task-gantt-workload-summary-cell")
      ) {
        element.style.width = `${this.dayWidth}px`;
      }
    }
  }

  private renderWorkloadSummaryRow(parents: TaskRow[], dates: string[]): void {
    this.workloadSummaryRowEl = undefined;
    if (!this.host.settings.ganttFeatureWorkloadEnabled) {
      return;
    }
    const row = this.buildWorkloadSummaryRow(parents, dates);
    this.wrapEl.appendChild(row);
    this.workloadSummaryRowEl = row;
  }

  /**
 *
 * Incremental counterpart of renderWorkloadSummaryRow: rebuilds the row's
 * content and inserts it at the same DOM position using the
 * capture-nextSibling-before-detach pattern used for parent rows. It does
 * nothing when workload is disabled. Since the feature flag is part of the
 * header fingerprint, it cannot change during an incremental render; when
 * enabled, the existing summary-row reference is guaranteed to be present.
 */
  private refreshWorkloadSummaryRowIncremental(
    parents: TaskRow[],
    dates: string[]
  ): void {
    if (!this.host.settings.ganttFeatureWorkloadEnabled) {
      return;
    }

    const fingerprint = this.workloadSummaryInputsFingerprint(parents, dates);
    const oldEl = this.workloadSummaryRowEl;
    if (
      oldEl &&
      oldEl.isConnected &&
      oldEl.parentNode === this.wrapEl &&
      this.workloadSummaryFingerprint === fingerprint
    ) {
      // Zoom changes the day width but not workload values. Reuse the row and
      // update only its pixel geometry instead of recomputing every cell.
      this.updateWorkloadSummaryRowGeometry(oldEl);
      return;
    }

    const insertBeforeRef = oldEl?.nextSibling ?? null;
    const row = this.buildWorkloadSummaryRow(parents, dates);
    if (insertBeforeRef !== null) {
      this.wrapEl.insertBefore(row, insertBeforeRef);
    } else {
      this.wrapEl.appendChild(row);
    }
    oldEl?.remove();
    this.workloadSummaryRowEl = row;
  }

















  private buildWorkloadSummaryRow(
    parents: TaskRow[],
    dates: string[]
  ): HTMLElement {
    const row = document.createElement("div");
    row.classList.add("task-gantt-fixed-row");

    const left = document.createElement("div");
    left.classList.add(
      "task-gantt-fixed-left",
      "task-gantt-workload-left"
    );
    left.style.width = `${PARENT_COL_WIDTH}px`;
    left.style.height = `${WORKLOAD_ROW_HEIGHT}px`;
    left.style.boxSizing = "border-box";
    const title = document.createElement("div");
    title.classList.add("task-gantt-fixed-title");
    title.textContent = "作業時間 (実績/想定)";
    left.appendChild(title);
    const subtitle = document.createElement("div");
    subtitle.classList.add("task-gantt-fixed-subtitle");
    subtitle.textContent = "左上: 実績 / 右下: 想定";
    left.appendChild(subtitle);


    // the settings action is available only with the workload
    // row, and each mutation saves immediately before refreshing the view.
    if (this.host.settings.ganttFeatureWorkloadEnabled) {
      const schedules: WeeklyWorkSchedule[] = Array.isArray(
        this.host.settings.weeklyWorkSchedules
      )
        ? this.host.settings.weeklyWorkSchedules
        : [];
      this.host.settings.weeklyWorkSchedules = schedules;

      const saveAndRender = async (): Promise<void> => {
        await this.host.saveSettings();
        // The incremental renderer caches workload totals independently of
        // the header fingerprint, so invalidate that cache after schedule CRUD.
        this.workloadSummaryFingerprint = undefined;
        this.workloadSummaryTotals = undefined;
        await this.render();
      };

      const settingsButton = document.createElement("button");
      settingsButton.classList.add("task-gantt-workload-settings-button");
      settingsButton.textContent = "定例作業設定";
      settingsButton.addEventListener("click", () => {
        new WeeklyWorkScheduleModal(this.app, schedules, {
          add: (title, dayOfWeek, minutesPerWeek) => {
            addWeeklyWorkSchedule(
              this.host.settings,
              title,
              dayOfWeek,
              minutesPerWeek
            );
            return saveAndRender();
          },
          update: (key, patch) => {
            updateWeeklyWorkSchedule(this.host.settings, key, patch);
            return saveAndRender();
          },
          delete: (key) => {
            deleteWeeklyWorkSchedule(this.host.settings, key);
            return saveAndRender();
          },
        }).open();
      });
      left.appendChild(settingsButton);
    }


    const timeline = document.createElement("div");
    timeline.classList.add(
      "task-gantt-fixed-timeline",
      "task-gantt-workload-row"
    );
    timeline.style.width = `${dates.length * this.dayWidth}px`;
    timeline.style.height = `${WORKLOAD_ROW_HEIGHT}px`;


    const nonWorkingDates = new Set<string>();
    dates.forEach((date, index) => {
      const bg = document.createElement("div");
      bg.classList.add("task-gantt-fixed-bg");
      bg.style.left = `${index * this.dayWidth}px`;
      bg.style.width = `${this.dayWidth}px`;
      const { isWeekend, isHoliday, isToday } = this.dateClasses(date);
      if (isWeekend) {
        bg.classList.add("is-weekend");
      }
      if (isHoliday) {
        bg.classList.add("is-holiday");
      }
      if (isToday) {
        bg.classList.add("is-today");
      }
      if (isWeekend || isHoliday) {
        nonWorkingDates.add(date);
      }
      timeline.appendChild(bg);
    });


    const totalsByDate = this.getWorkloadSummaryValues(parents, dates);
    const capacityHours = getCapacityHours(this.host.settings);
    for (const date of dates) {
      const cell = document.createElement("div");
      cell.classList.add("task-gantt-workload-summary-cell");
      cell.setAttribute("data-date", date);
      cell.style.width = `${this.dayWidth}px`;


      if (nonWorkingDates.has(date)) {
        cell.classList.add("is-non-working");
        timeline.appendChild(cell);
        continue;
      }


      const { plan: planTotal, actual: actualTotal } =
        totalsByDate.get(date) ?? { plan: 0, actual: 0 };

      if (planTotal > capacityHours) {
        cell.classList.add("is-over-capacity");
      }
      if (actualTotal > planTotal) {
        cell.classList.add("is-actual-over-plan");
      }

      if (planTotal === 0 && actualTotal === 0) {
        cell.classList.add("is-empty");
      }

      // the summary cell's two horizontal bands show
      // each total against the configured daily capacity. Clamp the ratios
      // so an over-capacity value fills its band without overflowing it.
      const planRatio = Math.max(0, Math.min(1, planTotal / capacityHours));
      const actualRatio = Math.max(0, Math.min(1, actualTotal / capacityHours));
      const setRatio = (name: string, value: string): void => {
        setStyleVar(cell, name, value);
      };
      setRatio("--twb-workload-plan-ratio", `${(planRatio * 100).toFixed(1)}%`);
      setRatio(
        "--twb-workload-actual-ratio",
        `${(actualRatio * 100).toFixed(1)}%`
      );


      const actualLabel = document.createElement("span");
      actualLabel.classList.add("task-gantt-workload-summary-actual");
      actualLabel.textContent = formatWorkloadHours(actualTotal);
      cell.appendChild(actualLabel);

      const planLabel = document.createElement("span");
      planLabel.classList.add("task-gantt-workload-summary-plan");
      planLabel.textContent = formatWorkloadHours(planTotal);
      cell.appendChild(planLabel);

      // match the bar-level workload popup's
      // hover trigger and delayed mouse-leave handoff to the popover.
      cell.addEventListener("mouseenter", () => {
        if (this.host.settings.ganttFeatureWorkloadEnabled) {
          this.showWorkloadDaySummaryPopup(date, cell);
        }
      });
      cell.addEventListener("mouseleave", () => {
        this.scheduleHideWorkloadDaySummaryPopover();
      });

      timeline.appendChild(cell);
    }
    row.appendChild(left);
    row.appendChild(timeline);
    return row;
  }











  private showWorkloadDaySummaryPopup(date: string, anchorEl: HTMLElement): void {
    if (!this.host.settings.ganttFeatureWorkloadEnabled) {
      return;
    }
    this.closeWorkloadDaySummaryPopover(); // Close any open day-summary popover.

    const el = document.createElement("div");
    el.classList.add(
      "task-gantt-workload-day-summary-popover",
      "vg-surface",
      "vg-popover"
    );

    // title "作業時間 M/D".
    const title = document.createElement("div");
    title.classList.add("task-gantt-workload-day-summary-popover-title");
    title.textContent = `作業時間 ${moment(date, "YYYY-MM-DD").format("M/D")}`;
    el.appendChild(title);

    // 「実績」then「想定」sections, each independently either
    // a list of entries or a single 「なし」 placeholder when empty.
    const buildSection = (
      label: string,
      mode: "plan" | "actual"
    ): HTMLElement => {
      const section = document.createElement("div");
      section.classList.add("task-gantt-workload-day-summary-popover-section");
      const heading = document.createElement("div");
      heading.classList.add("task-gantt-workload-day-summary-popover-heading");
      heading.textContent = label;
      section.appendChild(heading);

      const entries = collectWorkloadEntriesForDate(date, this.tasks, mode);


      if (mode === "plan") {
        // recurring schedules appear in the plan section only.
        const schedules: WeeklyWorkSchedule[] = Array.isArray(
          this.host.settings.weeklyWorkSchedules
        )
          ? this.host.settings.weeklyWorkSchedules
          : [];
        const dayOfWeek = moment(date, "YYYY-MM-DD").day();
        for (const schedule of schedules) {
          if (dayOfWeek === schedule.dayOfWeek) {
            entries.push({
              parentName: "週次定例",
              subtaskName: schedule.title || "無題",
              hours: schedule.minutesPerWeek / 60,
            });
          }
        }
        entries.sort((a, b) => {
          if (a.hours !== b.hours) {
            return b.hours - a.hours;
          }
          if (a.parentName !== b.parentName) {
            return a.parentName < b.parentName ? -1 : 1;
          }
          if (a.subtaskName !== b.subtaskName) {
            return a.subtaskName < b.subtaskName ? -1 : 1;
          }
          return 0;
        });
      }


      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.classList.add("task-gantt-workload-day-summary-popover-empty");
        empty.textContent = "なし";
        section.appendChild(empty);
      } else {
        for (const entry of entries) {
          const entryEl = document.createElement("div");
          entryEl.classList.add(
            "task-gantt-workload-day-summary-popover-entry"
          );
          entryEl.textContent = `${entry.parentName} / ${entry.subtaskName}: ${entry.hours}h`;
          section.appendChild(entryEl);
        }
      }
      return section;
    };
    el.appendChild(buildSection("実績", "actual"));
    el.appendChild(buildSection("想定", "plan"));

    // hovering the popover cancels the pending hide.
    el.addEventListener("mouseenter", () => {
      this.clearWorkloadDaySummaryPopoverHideTimer();
    });
    el.addEventListener("mouseleave", () => {
      this.scheduleHideWorkloadDaySummaryPopover();
    });

    // Appending to document.body instead of containerEl avoids the
    // `.workspace-leaf.mod-active { contain: strict }` containing block.
    // Fixed-position viewport coordinates would otherwise be offset by the
    // leaf's on-screen position. The popover is closed explicitly on view
    // teardown because it is not removed automatically with containerEl.
    document.body.appendChild(el);
    this.workloadDaySummaryPopoverState = { el, anchorEl };
    const outsidePointerDownHandler = (evt: PointerEvent): void => {
      const state = this.workloadDaySummaryPopoverState;
      let target = evt.target as Node | null;
      while (target !== null) {
        if (target === state?.el || target === state?.anchorEl) {
          return;
        }
        target = target.parentNode;
      }
      this.closeWorkloadDaySummaryPopover();
    };
    this.workloadDaySummaryOutsidePointerDownHandler =
      outsidePointerDownHandler;
    window.addEventListener("pointerdown", outsidePointerDownHandler);
    this.positionWorkloadDaySummaryPopover(anchorEl);
  }








  private positionWorkloadDaySummaryPopover(anchorEl: HTMLElement): void {
    const state = this.workloadDaySummaryPopoverState;
    if (state === undefined) {
      return;
    }
    const el = state.el;
    if (!anchorEl.isConnected) {
      this.closeWorkloadDaySummaryPopover();
      return;
    }
    try {
      const anchorRect = anchorEl.getBoundingClientRect();
      const measured = el.offsetHeight;
      const height = Math.max(
        WORKLOAD_DAY_SUMMARY_POPOVER_MIN_HEIGHT_PX,
        typeof measured === "number" ? measured : 0
      );
      const aboveTop =
        anchorRect.top - WORKLOAD_DAY_SUMMARY_POPOVER_GAP_PX - height;
      if (aboveTop >= 0) {
        el.style.top = `${aboveTop}px`;
        el.setAttribute("data-side", "above");
      } else {
        el.style.top = `${anchorRect.bottom + WORKLOAD_DAY_SUMMARY_POPOVER_GAP_PX}px`;
        el.setAttribute("data-side", "below");
      }
      el.style.left = `${anchorRect.left}px`;
    } catch (err) {

      this.host.logger.warn(
        "TaskGanttView",
        "workload day summary popover positioning failed",
        err
      );

    }
  }

  /** starts (or restarts) the 140ms hide debounce. */
  private scheduleHideWorkloadDaySummaryPopover(): void {
    this.clearWorkloadDaySummaryPopoverHideTimer();
    this.workloadDaySummaryPopoverHideTimer = setTimeout(() => {
      this.workloadDaySummaryPopoverHideTimer = undefined;
      this.closeWorkloadDaySummaryPopover();
    }, WORKLOAD_DAY_SUMMARY_POPOVER_HIDE_DELAY_MS);
  }

  private clearWorkloadDaySummaryPopoverHideTimer(): void {
    if (this.workloadDaySummaryPopoverHideTimer !== undefined) {
      clearTimeout(this.workloadDaySummaryPopoverHideTimer);
      this.workloadDaySummaryPopoverHideTimer = undefined;
    }
  }

  /**
 * Closes the day-summary popover immediately (no debounce): removes the
 * element and drops the stored state. Idempotent, mirrors
 * closeWorkloadPopup's shape.
 */
  private closeWorkloadDaySummaryPopover(): void {
    this.clearWorkloadDaySummaryPopoverHideTimer();
    if (this.workloadDaySummaryOutsidePointerDownHandler !== undefined) {
      window.removeEventListener(
        "pointerdown",
        this.workloadDaySummaryOutsidePointerDownHandler
      );
      this.workloadDaySummaryOutsidePointerDownHandler = undefined;
    }
    if (this.workloadDaySummaryPopoverState !== undefined) {
      this.workloadDaySummaryPopoverState.el.remove();
    }
    this.workloadDaySummaryPopoverState = undefined;
  }












  private renderFixedEventRow(): void {
    this.eventRowEl = undefined;
    if (!this.host.settings.ganttFeatureEventsEnabled) {
      return;
    }
    const row = this.buildFixedEventRow();
    this.wrapEl.appendChild(row);
    this.eventRowEl = row;
  }

  /** Builds the event row so full and incremental paths share one constructor. */
  private buildFixedEventRow(): HTMLElement {
    const events = getGanttEvents(this.host.settings);
    const packedEvents = layoutFloatingEvents(
      events,
      this.rangeStart,
      this.dayWidth
    );
    // rows = 1 minimum (zero events still reserve one
    // row); otherwise use the actual maximum row from the packing result.
    const rows = Math.max(
      1,
      packedEvents.reduce((max, placed) => Math.max(max, placed.row + 1), 0)
    );
    const rowHeight = Math.max(
      EVENT_ROW_MIN_HEIGHT_PX,
      EVENT_ROW_VERTICAL_SLACK_PX + rows * EVENT_ROW_PITCH_PX
    );
    const left = document.createElement("div");
    left.classList.add("task-gantt-fixed-left", "task-gantt-event-left");
    left.style.width = `${PARENT_COL_WIDTH}px`;
    left.style.height = `${rowHeight}px`;
    left.style.boxSizing = "border-box";
    const title = document.createElement("div");
    title.classList.add("task-gantt-fixed-title");
    title.textContent = "その他";
    left.appendChild(title);
    const subtitle = document.createElement("div");
    subtitle.classList.add("task-gantt-fixed-subtitle");
    subtitle.textContent = "右クリックで追加 / ドラッグで移動";
    left.appendChild(subtitle);

    const timeline = document.createElement("div");
    timeline.classList.add("task-gantt-fixed-timeline", "task-gantt-event-row");
    timeline.style.width = `${this.dates.length * this.dayWidth}px`;
    timeline.style.height = `${rowHeight}px`;

    this.dates.forEach((date, index) => {
      const bg = document.createElement("div");
      bg.classList.add("task-gantt-fixed-bg");
      bg.style.left = `${index * this.dayWidth}px`;
      bg.style.width = `${this.dayWidth}px`;
      const { isWeekend, isHoliday, isToday } = this.dateClasses(date);
      if (isWeekend) {
        bg.classList.add("is-weekend");
      }
      if (isHoliday) {
        bg.classList.add("is-holiday");
      }
      if (isToday) {
        bg.classList.add("is-today");
      }
      timeline.appendChild(bg);
    });

    // A right-click on the event timeline is the direct add gesture; event
    // chips stop propagation and use their own delete menu instead.
    timeline.addEventListener("contextmenu", (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      const date = dateFromClientX(
        evt.clientX,
        this.wrapEl.getBoundingClientRect().left,
        this.wrapEl.scrollLeft,
        this.dayWidth,
        this.rangeStart
      );
      addGanttEvent(this.host.settings, "", date);
      void this.host.saveSettings().then(() => this.render());
    });

    for (const placed of packedEvents) {
      const chip = document.createElement("div");
      chip.classList.add("task-gantt-event-chip");
      chip.style.left = `${placed.x}px`;
      const chipTop = EVENT_ROW_CHIP_TOP_PX + placed.row * EVENT_ROW_PITCH_PX;
      chip.style.top = `${chipTop}px`;
      chip.title = placed.event.title || "新しいタスク";

      const pin = document.createElement("span");
      pin.classList.add("task-gantt-event-pin");
      pin.textContent = "◆";
      chip.appendChild(pin);

      const label = document.createElement("span");
      label.classList.add("task-gantt-event-label");
      label.textContent = placed.event.title || "新しいタスク";
      chip.appendChild(label);


      if (this.host.settings.ganttFeatureWorkloadEnabled) {
        const { plan, actual } = dayValues(placed.event, placed.event.date);
        if (plan !== 0 || actual !== 0) {
          const workloadLabel = document.createElement("div");
          workloadLabel.classList.add(
            "task-gantt-workload-day-label",
            "is-dual"
          );
          workloadLabel.style.left = `${
            diffDays(this.rangeStart, placed.event.date) * this.dayWidth
          }px`;
          workloadLabel.style.top = `${Math.max(0, chipTop - 18)}px`;
          workloadLabel.style.width = `${this.dayWidth}px`;

          const actualLabel = document.createElement("span");
          actualLabel.classList.add("task-gantt-workload-day-label-actual");
          const actualDual = formatDualWorkloadLabel(actual, plan);
          actualLabel.textContent = actualDual.text;
          if (actualDual.isPlaceholder) {
            actualLabel.classList.add("is-placeholder");
          }
          workloadLabel.appendChild(actualLabel);

          const planLabel = document.createElement("span");
          planLabel.classList.add("task-gantt-workload-day-label-plan");
          const planDual = formatDualWorkloadLabel(plan, actual);
          planLabel.textContent = planDual.text;
          if (planDual.isPlaceholder) {
            planLabel.classList.add("is-placeholder");
          }
          workloadLabel.appendChild(planLabel);
          timeline.appendChild(workloadLabel);
        }
      }


      chip.addEventListener("pointerdown", (evt: PointerEvent) => {
        this.onGanttEventPointerDown(evt, chip, label, placed.event);
      });

      // The dblclick listener must live on the CHIP, not the label span.
      // onGanttEventPointerDown calls chip.setPointerCapture on the
      // first pointerdown of a double-click, and an active pointer capture
      // retargets the compatibility click/dblclick events to the captured
      // element — so a real double-click's dblclick always targets the chip,
      // never the label. A listener on the label alone was therefore dead
      // code in a real browser (verified via CDP-trusted input in the E2E
      // harness); the bar/marker surfaces work because their dblclick
      // listeners sit on the same element pointerdown is wired to.
      chip.addEventListener("dblclick", () => {
        this.startInlineEdit({
          hostEl: label,
          initialValue: placed.event.title || "新しいタスク",
          onCommit: (value) =>
            this.saveGanttEventTitleEdit(placed.event.key, value),
        });
      });
      chip.addEventListener("contextmenu", (evt: MouseEvent) => {
        this.openGanttEventContextMenu(evt, placed.event);
      });

      chip.addEventListener("mouseenter", () => {
        if (this.host.settings.ganttFeatureWorkloadEnabled) {
          this.showWorkloadPopupForEvent(placed.event, chip);
        }
      });
      chip.addEventListener("mouseleave", () => {
        this.scheduleHideWorkloadPopup();
      });

      timeline.appendChild(chip);
    }

    const row = document.createElement("div");
    row.classList.add("task-gantt-fixed-row");
    row.appendChild(left);
    row.appendChild(timeline);
    return row;
  }

  /** Refreshes the event row without disturbing incremental parent rows. */
  private refreshFixedEventRowIncremental(): boolean {
    if (!this.host.settings.ganttFeatureEventsEnabled) {
      return true;
    }
    const oldRow = this.eventRowEl;
    if (
      oldRow === undefined ||
      !oldRow.isConnected ||
      oldRow.parentNode !== this.wrapEl
    ) {
      return false;
    }

    const insertBeforeRef = oldRow.nextSibling;
    const row = this.buildFixedEventRow();
    if (insertBeforeRef !== null) {
      this.wrapEl.insertBefore(row, insertBeforeRef);
    } else {
      this.wrapEl.appendChild(row);
    }
    oldRow.remove();
    this.eventRowEl = row;
    return true;
  }

  /** renders the fixed Daily ToDo row. */
  private renderDailyTodoRow(): void {
    this.dailyTodoRowEl = undefined;
    if (!this.host.settings.ganttFeatureDailyTodoEnabled) {
      return;
    }
    const row = this.buildDailyTodoRow();
    this.wrapEl.appendChild(row);
    this.dailyTodoRowEl = row;
  }

  /** Builds the fixed-height Daily ToDo row from the cached summaries. */
  private buildDailyTodoRow(): HTMLElement {
    const left = document.createElement("div");
    left.classList.add("task-gantt-fixed-left", "task-gantt-daily-left");
    left.style.width = `${PARENT_COL_WIDTH}px`;
    left.style.height = `${DAILY_TODO_ROW_HEIGHT_PX}px`;
    left.style.boxSizing = "border-box";
    const title = document.createElement("div");
    title.classList.add("task-gantt-fixed-title");
    title.textContent = "Daily ToDo";
    left.appendChild(title);
    const subtitle = document.createElement("div");
    subtitle.classList.add("task-gantt-fixed-subtitle");
    subtitle.textContent = "メインは空セルクリックで追加";
    left.appendChild(subtitle);

    const timeline = document.createElement("div");
    timeline.classList.add("task-gantt-fixed-timeline", "task-gantt-daily-row");
    timeline.style.width = `${this.dates.length * this.dayWidth}px`;
    timeline.style.height = `${DAILY_TODO_ROW_HEIGHT_PX}px`;

    const anchors = new Map<string, HTMLElement>();
    this.dates.forEach((date, index) => {
      const bg = document.createElement("div");
      bg.classList.add("task-gantt-fixed-bg");
      bg.style.left = `${index * this.dayWidth}px`;
      bg.style.width = `${this.dayWidth}px`;
      const { isWeekend, isHoliday, isToday } = this.dateClasses(date);
      if (isWeekend) {
        bg.classList.add("is-weekend");
      }
      if (isHoliday) {
        bg.classList.add("is-holiday");
      }
      if (isToday) {
        bg.classList.add("is-today");
      }
      // An empty cell opens the same popover so a ToDo can be added to any date.
      bg.addEventListener("click", () => {
        this.openDailyTodoPopover(date, bg);
      });
      anchors.set(date, bg);
      timeline.appendChild(bg);
    });

    for (const summary of this.dailyTodoSummaries) {
      if (!this.dates.includes(summary.date)) {
        continue;
      }
      const chip = document.createElement("div");
      chip.classList.add("task-gantt-daily-chip");
      if (
        summary.totalCount > 0 &&
        summary.completedCount >= summary.totalCount
      ) {
        chip.classList.add("is-completed");
      }
      // the chip renders completed/total text,
      // centers on its date column, and marks fully completed summaries.
      chip.textContent = `${summary.completedCount}/${summary.totalCount}`;
      chip.title = `${summary.completedCount}/${summary.totalCount} 完了`;
      chip.style.left = `${
        diffDays(this.dates[0], summary.date) * this.dayWidth +
        this.dayWidth / 2
      }px`;
      // Clicking a chip opens the inline editor popover for that date.
      chip.addEventListener("click", () => {
        this.openDailyTodoPopover(summary.date, chip);
      });
      anchors.set(summary.date, chip);
      timeline.appendChild(chip);
    }

    this.dailyTodoAnchorEls = anchors;
    const row = document.createElement("div");
    row.classList.add("task-gantt-fixed-row");
    row.appendChild(left);
    row.appendChild(timeline);
    return row;
  }

  /**
   * Refreshes the Daily ToDo row without disturbing incremental parent rows.
   * The popover is closed first (its anchor is replaced) unless the caller
   * keeps it open and re-anchors it itself.
   */
  private refreshDailyTodoRowIncremental(keepPopover = false): void {
    if (!this.host.settings.ganttFeatureDailyTodoEnabled) {
      return;
    }
    const oldRow = this.dailyTodoRowEl;
    if (!oldRow) {
      return;
    }
    // replacing the row detaches the chip used as the popover's
    // anchor, so close the body-anchored popover before building its
    // replacement even when this incremental helper is called directly.
    if (!keepPopover) {
      this.closeDailyTodoPopover();
    }
    const insertBeforeRef = oldRow.nextSibling;
    const row = this.buildDailyTodoRow();
    if (insertBeforeRef !== null) {
      this.wrapEl.insertBefore(row, insertBeforeRef);
    } else {
      this.wrapEl.appendChild(row);
    }
    oldRow.remove();
    this.dailyTodoRowEl = row;
  }

  /**
   * Opens the Daily ToDo popover for a date, anchored to its chip / empty
   * cell. Clicking the anchor of the open popover closes it again. The
   * popover is body-anchored so Obsidian view containment and the chart's
   * clipped scroll subtree cannot hide it.
   */
  private openDailyTodoPopover(date: string, anchorEl: HTMLElement): void {
    if (!anchorEl.isConnected) {
      return;
    }
    const wasOpenForDate = this.dailyTodoPopoverState?.date === date;
    this.closeDailyTodoPopover();
    if (wasOpenForDate) {
      return;
    }

    const generation = this.dailyTodoOpenGeneration;
    if (this.dailyTodoQueue !== undefined) {
      void this.enqueueDailyTodoTask(async () => {
        await this.refreshDailyTodoSummaries();
        if (generation !== this.dailyTodoOpenGeneration) {
          return;
        }
        this.rebuildDailyTodoRowKeepingPopover();
        const anchor = this.dailyTodoAnchorEls.get(date);
        if (anchor?.isConnected) {
          this.createDailyTodoPopover(date, anchor);
        }
      });
      return;
    }
    this.createDailyTodoPopover(date, anchorEl);
  }

  private createDailyTodoPopover(date: string, anchorEl: HTMLElement): void {
    const el = document.createElement("div");
    el.classList.add("task-gantt-daily-todo-popover", "vg-surface", "vg-popover");
    el.setAttribute("data-date", date);

    const title = document.createElement("div");
    title.classList.add("task-gantt-daily-todo-popover-title");
    title.textContent = `Daily ToDo ${moment(date, "YYYY-MM-DD").format("M/D")}`;
    el.appendChild(title);

    const listEl = document.createElement("div");
    listEl.classList.add("task-gantt-daily-todo-list");
    el.appendChild(listEl);

    const addButton = document.createElement("button");
    addButton.classList.add("task-gantt-daily-todo-add", "vg-btn-sm");
    addButton.textContent = "+";
    addButton.setAttribute("aria-label", "ToDoを追加");
    addButton.title = "ToDoを追加";
    el.appendChild(addButton);

    const state: DailyTodoPopoverState = {
      el,
      anchorEl,
      date,
      listEl,
      rows: [],
      outsideHandler: (evt: Event): void => {
        const target = evt.target as Node | null;
        if (
          target !== null &&
          !isNodeInside(target, state.el) &&
          !isNodeInside(target, state.anchorEl) &&
          !isNodeInsideMenu(target)
        ) {
          this.closeDailyTodoPopover();
        }
      },
    };
    this.dailyTodoPopoverState = state;

    const summary = this.dailyTodoSummaries.find((s) => s.date === date);
    for (const item of summary?.items ?? []) {
      this.appendDailyTodoRow(state, { ...item }, false);
    }

    addButton.addEventListener("click", () => {
      // One blank row at a time: reuse it instead of stacking empty rows.
      const blank = state.rows.find(
        (row) => row.item === null && row.inputEl.value.trim() === ""
      );
      if (blank !== undefined) {
        blank.inputEl.focus();
        return;
      }
      this.appendDailyTodoRow(state, null, true);
      this.positionDailyTodoPopover(state.anchorEl);
    });
    el.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        this.closeDailyTodoPopover();
      }
    });

    document.body.appendChild(el);
    window.addEventListener("mousedown", state.outsideHandler, true);
    this.positionDailyTodoPopover(anchorEl);
  }

  /**
   * Appends one `[check] [input] […]` row. `item` is null for a new row that
   * has not been written to a note yet (it is saved once text is entered).
   */
  private appendDailyTodoRow(
    state: DailyTodoPopoverState,
    item: DailyTodoItem | null,
    focus: boolean
  ): void {
    const rowEl = document.createElement("div");
    rowEl.classList.add("task-gantt-daily-todo-row");
    if (item !== null && item.sourceLabel !== "") {
      rowEl.title = item.sourceLabel;
    }

    const checkEl = document.createElement("input");
    checkEl.type = "checkbox";
    checkEl.classList.add("task-gantt-daily-todo-check");
    checkEl.setAttribute("aria-label", "完了");
    checkEl.checked = item?.completed ?? false;
    rowEl.appendChild(checkEl);

    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.classList.add("task-gantt-daily-todo-input", "vg-input-sm");
    inputEl.placeholder = "ToDoを入力";
    inputEl.value = item?.text ?? "";
    rowEl.appendChild(inputEl);

    const moreButton = document.createElement("button");
    moreButton.classList.add("task-gantt-daily-todo-more", "vg-btn-sm");
    moreButton.textContent = "…";
    moreButton.setAttribute("aria-label", "その他の操作");
    moreButton.title = "その他の操作";
    rowEl.appendChild(moreButton);

    const row: DailyTodoPopoverRow = { item, rowEl, checkEl, inputEl };
    state.rows.push(row);
    state.listEl.appendChild(rowEl);

    // `change` fires on Enter / blur only, so IME composition is never cut off.
    const save = (): void => {
      void this.enqueueDailyTodoTask(() =>
        this.commitDailyTodoRow(state, row)
      );
    };
    checkEl.addEventListener("change", save);
    inputEl.addEventListener("change", save);
    moreButton.addEventListener("click", (evt: MouseEvent) => {
      this.openDailyTodoRowMenu(state, row, evt);
    });

    if (focus) {
      inputEl.focus();
    }
  }

  /** 「開く」「削除」 menu behind a row's 「…」 button. */
  private openDailyTodoRowMenu(
    state: DailyTodoPopoverState,
    row: DailyTodoPopoverRow,
    evt: MouseEvent
  ): void {
    const menu = new Menu();
    this.activateContextMenu(menu);
    menu.addItem((menuItem) => {
      menuItem.setTitle("開く").setIcon("file-text");
      menuItem.setDisabled(row.item === null);
      menuItem.onClick(() => {
        void this.enqueueDailyTodoTask(async () => {
          // Save pending edits first so the note and the jump target agree.
          await this.commitDailyTodoRow(state, row);
          if (row.item !== null) {
            await this.host.openDailyTodoItem(row.item);
            this.closeDailyTodoPopover();
          }
        });
      });
    });
    menu.addItem((menuItem) => {
      menuItem.setTitle("削除").setIcon("trash").setWarning(true);
      menuItem.onClick(() => {
        // Deleted at once, without confirmation; the write is on the undo history.
        void this.enqueueDailyTodoTask(() =>
          this.deleteDailyTodoRow(state, row)
        );
      });
    });
    menu.showAtMouseEvent(evt);
  }

  /**
   * Runs a popover save after the previous one finished: every write re-reads
   * the note and addresses a line number, so overlapping saves could race.
   */
  private enqueueDailyTodoTask(
    task: () => Promise<void>
  ): Promise<void> {
    const next = (this.dailyTodoQueue ?? Promise.resolve()).then(task).catch((err: unknown) => {
      this.host.logger.warn("TaskGanttView", "Daily ToDo popover save failed", err);
      new Notice("Daily ToDoを保存できませんでした。");
    });
    const queued = next.finally(() => {
      if (this.dailyTodoQueue === queued) {
        this.dailyTodoQueue = undefined;
      }
    });
    this.dailyTodoQueue = queued;
    return queued;
  }

  /** Writes a row's checkbox / text if it differs from what is stored. */
  private async commitDailyTodoRow(
    state: DailyTodoPopoverState,
    row: DailyTodoPopoverRow
  ): Promise<void> {
    const completed = row.checkEl.checked;
    const inputValue = row.inputEl.value;
    let text = inputValue.trim();
    const item = row.item;

    if (item === null) {
      // A new row is only written once it has text.
      if (text === "") {
        return;
      }
      const created = await this.host.addDailyTodoItem(state.date, text, completed);
      if (created === null) {
        return;
      }
      // Lines at/after the insertion point of the same note moved down by one.
      for (const other of state.rows) {
        if (
          other.item !== null &&
          other.item.path === created.path &&
          other.item.line >= created.line
        ) {
          other.item.line += 1;
        }
      }
      row.item = created;
      if (row.inputEl.value === inputValue) {
        row.inputEl.value = text;
      }
      row.rowEl.title = created.sourceLabel;
      await this.applyDailyTodoModel(state);
      return;
    }

    if (text === "") {
      // An empty line is never saved; removing a ToDo is 「…」→「削除」.
      text = item.text;
      row.inputEl.value = text;
      if (this.dailyTodoPopoverState === state) {
        new Notice("空欄にはできません。削除は「…」から行えます。");
      }
    }
    if (text.trim() === item.text.trim() && completed === item.completed) {
      return;
    }
    const ok = await this.host.updateDailyTodoItem(item, { text, completed });
    if (!ok) {
      await this.recoverDailyTodoPopover(state);
      return;
    }
    if (row.inputEl.value === inputValue) {
      row.inputEl.value = text;
    }
    await this.applyDailyTodoModel(state);
  }

  /** Deletes a row's ToDo line right away (a never-saved row is just dropped). */
  private async deleteDailyTodoRow(
    state: DailyTodoPopoverState,
    row: DailyTodoPopoverRow
  ): Promise<void> {
    const item = row.item;
    if (item !== null) {
      const ok = await this.host.deleteDailyTodoItem(item);
      if (!ok) {
        await this.recoverDailyTodoPopover(state);
        return;
      }
      // Lines below the removed one in the same note moved up by one.
      for (const other of state.rows) {
        if (
          other !== row &&
          other.item !== null &&
          other.item.path === item.path &&
          other.item.line > item.line
        ) {
          other.item.line -= 1;
        }
      }
    }
    state.rows.splice(state.rows.indexOf(row), 1);
    row.rowEl.remove();
    await this.applyDailyTodoModel(state);
  }

  /**
   * The note changed under the popover (the stored line no longer matches), so
   * reload from disk instead of risking an overwrite of the wrong line.
   */
  private async recoverDailyTodoPopover(
    state: DailyTodoPopoverState
  ): Promise<void> {
    new Notice("ToDoのファイルが変更されていたため、最新の内容を読み込み直しました。");
    await this.refreshDailyTodoSummaries();
    if (this.dailyTodoPopoverState !== state) {
      this.rebuildDailyTodoRowKeepingPopover();
      return;
    }
    const summary = this.dailyTodoSummaries.find((s) => s.date === state.date);
    state.rows.length = 0;
    state.listEl.replaceChildren();
    for (const item of summary?.items ?? []) {
      this.appendDailyTodoRow(state, { ...item }, false);
    }
    this.rebuildDailyTodoRowKeepingPopover();
  }

  /** Mirrors the popover's saved rows into the cached summary and the row chips. */
  private async applyDailyTodoModel(state: DailyTodoPopoverState): Promise<void> {
    if (this.dailyTodoPopoverState !== state) {
      await this.refreshDailyTodoSummaries();
      this.rebuildDailyTodoRowKeepingPopover();
      return;
    }
    const items = state.rows.flatMap((row) =>
      row.item !== null ? [{ ...row.item }] : []
    );
    const index = this.dailyTodoSummaries.findIndex(
      (summary) => summary.date === state.date
    );
    if (items.length === 0) {
      if (index >= 0) {
        this.dailyTodoSummaries.splice(index, 1);
      }
    } else {
      const summary: DailyTodoSummary = {
        date: state.date,
        items,
        completedCount: items.filter((item) => item.completed).length,
        totalCount: items.length,
      };
      if (index >= 0) {
        this.dailyTodoSummaries[index] = summary;
      } else {
        this.dailyTodoSummaries.push(summary);
        this.dailyTodoSummaries.sort((a, b) =>
          a.date < b.date ? -1 : a.date > b.date ? 1 : 0
        );
      }
    }
    this.rebuildDailyTodoRowKeepingPopover();
    if (this.dailyTodoPopoverState === state) {
      this.positionDailyTodoPopover(state.anchorEl);
    }
  }

  /** Rebuilds the Daily ToDo row (chip counts) and re-anchors the open popover. */
  private rebuildDailyTodoRowKeepingPopover(): void {
    this.refreshDailyTodoRowIncremental(true);
    const state = this.dailyTodoPopoverState;
    if (state === undefined) {
      return;
    }
    const anchor = this.dailyTodoAnchorEls.get(state.date);
    if (anchor === undefined) {
      this.closeDailyTodoPopover();
      return;
    }
    state.anchorEl = anchor;
    this.positionDailyTodoPopover(anchor);
  }

  /**
 * positions the fixed popover above the anchor when possible,
 * otherwise below it, and keeps the box within the viewport horizontally.
 */
  private positionDailyTodoPopover(anchorEl: HTMLElement): void {
    const state = this.dailyTodoPopoverState;
    if (state === undefined) {
      return;
    }
    const el = state.el;
    if (!anchorEl.isConnected) {
      this.closeDailyTodoPopover();
      return;
    }
    try {
      const anchorRect = anchorEl.getBoundingClientRect();
      const measuredHeight =
        typeof el.offsetHeight === "number" ? el.offsetHeight : 0;
      const height = Math.max(1, measuredHeight);
      const aboveTop =
        anchorRect.top - DAILY_TODO_POPOVER_GAP_PX - height;
      if (aboveTop >= DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX) {
        el.style.top = `${aboveTop}px`;
        el.setAttribute("data-side", "above");
      } else {
        const belowTop = anchorRect.bottom + DAILY_TODO_POPOVER_GAP_PX;
        const viewportHeight = Number(window.innerHeight) || 0;
        const maxTop =
          viewportHeight > 0
            ? Math.max(
                DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX,
                viewportHeight -
                  height -
                  DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX
              )
            : belowTop;
        el.style.top = `${Math.max(
          DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX,
          Math.min(belowTop, maxTop)
        )}px`;
        el.setAttribute("data-side", "below");
      }

      const measuredWidth =
        typeof el.offsetWidth === "number"
          ? Math.max(DAILY_TODO_POPOVER_MIN_WIDTH_PX, el.offsetWidth)
          : DAILY_TODO_POPOVER_MIN_WIDTH_PX;
      const viewportWidth = Number(window.innerWidth) || 0;
      const maxLeft =
        viewportWidth > 0
          ? Math.max(
              DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX,
              viewportWidth -
                measuredWidth -
                DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX
            )
          : anchorRect.left;
      el.style.left = `${Math.max(
        DAILY_TODO_POPOVER_VIEWPORT_MARGIN_PX,
        Math.min(anchorRect.left, maxLeft)
      )}px`;
    } catch (err) {

      this.host.logger.warn(
        "TaskGanttView",
        "Daily ToDo popover positioning failed",
        err
      );

    }
  }

  /**
   * Idempotently removes the body-anchored popover. Text typed but not yet
   * committed is saved first (a removed input never fires `change`).
   */
  private closeDailyTodoPopover(): void {
    this.dailyTodoOpenGeneration += 1;
    const state = this.dailyTodoPopoverState;
    if (state === undefined) {
      return;
    }
    this.dailyTodoPopoverState = undefined;
    window.removeEventListener("mousedown", state.outsideHandler, true);
    for (const row of [...state.rows]) {
      if (isDailyTodoRowDirty(row)) {
        void this.enqueueDailyTodoTask(() =>
          this.commitDailyTodoRow(state, row)
        );
      }
    }
    state.el.remove();
  }

















  private renderParentAddRow(): void {
    // remove existing add-row elements before regenerating.
    const stale: Element[] = [];
    for (const child of Array.from(this.wrapEl.children)) {
      if (
        child.classList.contains("task-gantt-parent-add-row") ||
        child.classList.contains("task-gantt-parent-add-cell") ||
        child.classList.contains("task-gantt-parent-add-timeline")
      ) {
        stale.push(child);
      }
    }
    for (const el of stale) {
      el.remove();
    }

    const row = document.createElement("div");
    row.classList.add("task-gantt-parent-add-row");

    // LEFT cell — text + button.
    const cell = document.createElement("div");
    cell.classList.add("task-gantt-parent-add-cell");
    cell.style.width = `${PARENT_COL_WIDTH}px`;
    const label = document.createElement("span");
    label.textContent = "新規親タスク";
    cell.appendChild(label);
    const button = document.createElement("button");
    button.classList.add("task-gantt-parent-add-button");
    button.textContent = "+";
    button.addEventListener("click", (evt: MouseEvent) => {
      this.openAddParentMenu(evt);
    });
    cell.appendChild(button);
    row.appendChild(cell);

    // timeline cell — empty (background only).
    const timeline = document.createElement("div");
    timeline.classList.add("task-gantt-parent-add-timeline");
    timeline.style.width = `${this.dates.length * this.dayWidth}px`;
    row.appendChild(timeline);

    this.wrapEl.appendChild(row);
  }

  /**
 *
 * Opens the parent-task menu with actions to create a new parent or select
 * an existing one.
 */
  private openAddParentMenu(evt: MouseEvent): void {
    const menu = new Menu();
    this.activateContextMenu(menu);

    menu.addItem((item) => {
      item.setTitle("新しく親タスクを作る");
      item.onClick(() => {
        void this.createNewGanttParent();
      });
    });

    menu.addItem((item) => {
      item.setTitle("既存タスクから選ぶ");
      item.onClick(() => {
        this.openExistingParentPicker();
      });
    });

    menu.showAtMouseEvent(evt);
  }

  /**
 *
 * Creates a new parent task by delegating to
 * host.createGanttParentInteractively. The host runs the create-task wizard,
 * enables the new parent for Gantt display, assigns its order, and saves it.
 * This method then re-renders; if no host handler exists, it logs a warning.
 */
  private async createNewGanttParent(): Promise<void> {
    if (this.host.createGanttParentInteractively) {
      await this.host.createGanttParentInteractively();
      await this.render();
      return;
    }

    this.host.logger.warn(
      "TaskGanttView",
      "host.createGanttParentInteractively() is not implemented — 「新しく親タスクを作る」 clicked"
    );

  }















  private openExistingParentPicker(): void {
    const items = this.tasks.filter(
      (t) => t.kind === "parent" && t.ganttEnabled === false
    );
    this.host.openGanttParentPicker(items, async (chosen) => {
      try {
        await enableParentInGantt(
          chosen,
          this.tasks,
          (row, patch) => this.host.updateTaskItem(row, patch)
        );
      } catch (err) {

        this.host.logger.error(
          "TaskGanttView",
          "failed to enable existing parent",
          err
        );

        new Notice(
          "ガント操作の保存に失敗しました。詳細は console を確認してください。"
        );
      }
      await this.render();
    });
  }


  // Shared per-date classification (header + parent-row backgrounds)










  private dateClasses(date: string): {
    isWeekend: boolean;
    isHoliday: boolean;
    isToday: boolean;
  } {
    const cached = this.dateClassesCache.get(date);
    if (cached !== undefined) {
      return cached;
    }
    const dow = moment(date, "YYYY-MM-DD").day();
    const classes = {
      isWeekend: dow === 0 || dow === 6,
      isHoliday: this.holidaySet.has(date),
      isToday: date === this.todayForRender,
    };
    this.dateClassesCache.set(date, classes);
    return classes;
  }










































  private renderParentRow(parent: TaskRow, dates: string[]): HTMLElement {
    const dayWidth = this.dayWidth;

    // the chart's rangeStart — the same base the header dates use.
    const baseDate = this.rangeStart;

    // --- Step 1: pack visible subtasks into lanes ---
    // With a tag filter active, non-matching subtasks are dropped before lane
    // packing, so hidden bars neither
    // render nor consume a lane (filtering after the pack would leave
    // their lanes empty but counted). Visibility is getBarFilterState's
    // verdict, applied per subtask via a provisional Bar (visibility
    // depends only on bar.task.tags — start/end/lane are not consulted).
    const allSubtasks = parent.subtasks
      ? Array.from(parent.subtasks.values())
      : [];
    const visibleSubtasks =
      this.activeTagFilter.size === 0
        ? allSubtasks
        : allSubtasks.filter((subtask) =>
            this.getBarFilterState(parent, {
              task: subtask,
              start: subtask.plannedStartDate ?? "",
              end: subtask.plannedEndDate ?? "",
              lane: 0,
            }).visible
          );
    const { bars, laneCount } = packSubtasksIntoLanes(visibleSubtasks);

    // --- Per-bar geometry and label text ---
    const renders: ParentRowBarRender[] = bars.map((bar) => {
      // Calculate the left edge relative to the range start.
      const left = diffDays(baseDate, bar.start) * dayWidth;
      // Calculate the right edge from the inclusive end day, minus the 4px gutter.
      const right = (diffDays(baseDate, bar.end) + 1) * dayWidth - 4;
      // Width is right minus left, floored at 8px.
      const width = Math.max(MIN_BAR_WIDTH_PX, right - left);
      // Use the subtask's displayName when present, otherwise its title.
      const labelText = bar.task.displayName || bar.task.title;

      // inner width is less than half the estimated title width. Written in
      // the equivalent form below so a title can remain in-bar until it is
      // substantially wider than the readable space, in the narrow layout.
      const readableInsideWidth = Math.max(
        0,
        width - BAR_INNER_PADDING_PX
      );
      const needsLabel =
        labelText.length > 0 &&
        readableInsideWidth < estimateTextWidth(labelText) * 0.5;
      // Include the tag badge in the packed label width. Otherwise,
      // layoutExternalBarLabels would measure a narrower label than the one
      // rendered and could place labels that overlap after the badge is added.
      // The badge represents only a tag directly on the bar; parent tags may
      // color the bar but do not supply a badge name.
      const primaryBadgeTag = getPrimaryGanttTagDefinition(
        this.host.settings,
        bar.task.tags
      );
      const packedLabelText =
        primaryBadgeTag !== undefined
          ? `${labelText} ${primaryBadgeTag.name}`
          : labelText;
      const labelledBar: Bar & { needsLabel: boolean; labelText: string } = {
        ...bar,
        needsLabel,
        labelText: packedLabelText,
      };
      return { bar, labelledBar, left, width, labelText, needsLabel };
    });

    // --- Step 2: place markers and count marker rows per lane ---
    const markerRowCounts = new Array<number>(laneCount).fill(0);
    const markersByBar = new Map<Bar, LaidOutMarker[]>();
    for (const render of renders) {
      const placed = layoutMarkers(
        render.bar.task.ganttMarkers ?? [],
        render.bar,
        baseDate,
        dayWidth
      );
      markersByBar.set(render.bar, placed);
      for (const marker of placed) {
        markerRowCounts[render.bar.lane] = Math.max(
          markerRowCounts[render.bar.lane],
          marker.row + 1
        );
      }
    }

    // --- Step 3: external labels per lane + per-lane top/bottom counts ---
    // Place external labels separately for each lane.
    const topRowCounts = new Array<number>(laneCount).fill(0);
    const bottomRowCounts = new Array<number>(laneCount).fill(0);
    const labelPlacements = new Map<Bar, ExternalLabelPlacement>();
    for (let lane = 0; lane < laneCount; lane += 1) {
      const laneBars = renders
        .filter((render) => render.bar.lane === lane)
        .map((render) => render.labelledBar);
      const placements = layoutExternalBarLabels(
        laneBars,
        baseDate,
        dayWidth
      );
      for (const [bar, placement] of placements) {
        labelPlacements.set(bar, placement);
        if (placement.side === "top") {
          topRowCounts[lane] = Math.max(topRowCounts[lane], placement.row + 1);
        } else {
          bottomRowCounts[lane] = Math.max(
            bottomRowCounts[lane],
            placement.row + 1
          );
        }
      }
    }

    // --- Step 4: per-lane heights, lane offsets, total row height ---

    const laneHeights: number[] = [];
    for (let lane = 0; lane < laneCount; lane += 1) {
      laneHeights[lane] =
        topRowCounts[lane] * EXTERNAL_LABEL_ROW_HEIGHT +
        LANE_BASE_HEIGHT +
        markerRowCounts[lane] * MARKER_ROW_HEIGHT +
        bottomRowCounts[lane] * EXTERNAL_LABEL_ROW_HEIGHT;
    }
    const laneOffsets = computeLaneOffsets(laneHeights);

    const hasDeadlineMarker = Boolean(parent.dueDate);
    const rowHeight = computeRowHeight(
      laneCount,
      topRowCounts,
      bottomRowCounts,
      markerRowCounts,
      hasDeadlineMarker
    );

    // --- Create the row container and set its height ---
    const row = document.createElement("div");
    row.classList.add("task-gantt-parent-row");
    row.style.height = `${rowHeight}px`;

    row.appendChild(this.renderParentLeft(parent));
    row.appendChild(
      this.renderParentTimeline(
        parent,
        dates,
        dayWidth,
        baseDate,
        renders,
        markersByBar,
        labelPlacements,
        topRowCounts,
        markerRowCounts,
        laneOffsets,
        rowHeight,
        hasDeadlineMarker
      )
    );

    return row;
  }

  /**
 * Renders the left column with the parent title, inline title editor,
 * primary-tag color border, optional tag chips, context menu, and native
 * HTML5 drag-and-drop reordering.
 */
  private renderParentLeft(parent: TaskRow): HTMLElement {
    const left = document.createElement("div");
    left.classList.add("task-gantt-parent-left");
    left.style.width = `${PARENT_COL_WIDTH}px`;
    // border-box: the 4px tag-color left border (below) must not add to the
    // fixed 320px width — with the default content-box sizing (and no
    // stylesheet in this repo yet to override it), a tagged parent's row
    // would render 4px wider than the header's date grid and untagged rows,
    // misaligning every bar in that row against the timeline.
    left.style.boxSizing = "border-box";


    // Native HTML5 drag-and-drop reordering uses dragstart, dragover, drop,
    // and dataTransfer. The parentTitleEditingIds guard backs up the
    // `draggable="false"` attribute set during title editing. Real browsers
    // honor that attribute, while the fake-DOM test harness
    // dispatches events directly without consulting it, so the guard here
    // keeps the two mechanisms consistent under both.
    left.setAttribute("draggable", "true");
    left.addEventListener("dragstart", (evt: DragEvent) => {
      if (this.parentTitleEditingIds.has(parent.id)) {
        evt.preventDefault();
        return;
      }
      this.dragParentId = parent.id;
      evt.dataTransfer?.setData("text/plain", parent.id);
      left.classList.add("is-dragging");
    });
    left.addEventListener("dragend", () => {
      left.classList.remove("is-dragging");
      // A cancelled drag (Escape, or dropped outside any valid target) never
      // fires "drop", so dragParentId would otherwise stay stale and let an
      // unrelated later drop silently reorder this row. "drop" always fires

      // (handleParentDrop, which also clears this field) is unaffected.
      this.dragParentId = undefined;
    });
    left.addEventListener("dragover", (evt: DragEvent) => {
      evt.preventDefault(); // required for a subsequent "drop" to fire
      left.classList.add("is-drag-over");
    });
    left.addEventListener("dragleave", () => {
      left.classList.remove("is-drag-over");
    });
    left.addEventListener("drop", (evt: DragEvent) => {
      evt.preventDefault();
      left.classList.remove("is-drag-over");
      void this.handleParentDrop(parent.id);
    });

    // Attach the parent row's right-click menu to the left cell, not the
    // timeline. Timeline background cells have their own separate menu.
    left.addEventListener("contextmenu", (evt: MouseEvent) => {
      this.openParentContextMenu(evt, parent);
    });

    // 4px left border colored by the registry-order primary tag;
    // orphan and explicitly colorless tags intentionally have no color.
    const primaryParentTag = getPrimaryGanttTagDefinition(
      this.host.settings,
      parent.tags
    );
    if (primaryParentTag?.color) {
      left.classList.add("has-tag-accent");
      setStyleVar(left, "--vg-tag-accent", primaryParentTag.color);
    }

    // Render the title; double-clicking it opens the inline editor.
    const title = document.createElement("div");
    title.classList.add("task-gantt-parent-title");
    title.textContent = parent.displayName || parent.title;
    title.addEventListener("dblclick", () => {
      this.startParentTitleEdit(parent, left, title);
    });
    left.appendChild(title);

    // tag chips (max 4), each tinted by its own tag
    // color — only when the tags feature is enabled.
    if (this.host.settings.ganttFeatureTagsEnabled && parent.tags.length > 0) {
      const tags = document.createElement("div");
      tags.classList.add("task-gantt-parent-tags");
      for (const tag of parent.tags.slice(0, MAX_TAG_CHIPS)) {
        const chip = document.createElement("span");
        chip.classList.add("task-gantt-parent-tag", "vg-chip", "is-tag");
        chip.textContent = tag;
        const definition = findGanttTagDefinition(this.host.settings, tag);
        if (definition?.color) {
          setStyleVar(chip, "--vg-chip-color", definition.color);
        }
        tags.appendChild(chip);
      }
      left.appendChild(tags);
    }

    // Show the parent popover on mouseover of the left cell. Attaching this
    // listener to the whole row would also catch events from subtask bars
    // because mouseover bubbles, opening the parent popover over the subtask
    // popover. The left cell contains no bars, keeping the triggers separate
    // in both the real DOM and the non-bubbling fake-DOM tests.
    left.addEventListener("mouseover", (evt: MouseEvent) => {
      this.onRichPopoverTrigger(
        { kind: "parent", task: parent, anchorEl: left },
        evt
      );
    });
    left.addEventListener("mouseleave", () => {
      this.richPopoverPointerOutside = true;
      this.scheduleRichPopoverHide();
    });

    return left;
  }

  /**
 *
 *
 * The timeline half of a parent row: per-date background cells, then bars /
 * markers / external labels positioned from the precomputed layout, then
 * the deadline marker. Bars are never clamped to the visible range
 * — overflow is the CSS layer's job.
 */
  private renderParentTimeline(
    parent: TaskRow,
    dates: string[],
    dayWidth: number,
    baseDate: string,
    renders: ParentRowBarRender[],
    markersByBar: Map<Bar, LaidOutMarker[]>,
    labelPlacements: Map<Bar, ExternalLabelPlacement>,
    topRowCounts: number[],
    markerRowCounts: number[],
    laneOffsets: number[],
    rowHeight: number,
    hasDeadlineMarker: boolean
  ): HTMLElement {
    const timeline = document.createElement("div");
    timeline.classList.add("task-gantt-parent-timeline");
    timeline.style.width = `${dates.length * dayWidth}px`;
    timeline.style.height = `${rowHeight}px`;

    // one background cell per date at index × dayWidth,
    // classified via the shared dateClasses helper.
    dates.forEach((date, index) => {
      const bg = document.createElement("div");
      bg.classList.add("task-gantt-bg");
      bg.style.width = `${dayWidth}px`;
      bg.style.left = `${index * dayWidth}px`;
      const { isWeekend, isHoliday, isToday } = this.dateClasses(date);
      if (isWeekend) {
        bg.classList.add("is-weekend");
      }
      if (isHoliday) {
        bg.classList.add("is-holiday");
      }
      if (isToday) {
        bg.classList.add("is-today");
      }

      // Background cells alone use the empty-cell menu. Bars, markers,
      // resize handles, and deadline markers are sibling elements with their
      // own handlers.

      bg.addEventListener("contextmenu", (evt: MouseEvent) => {
        this.openEmptyCellMenu(evt, parent, date);
      });
      timeline.appendChild(bg);
    });

    const renderedIds = new Set(renders.map((item) => item.bar.task.id));
    for (const subtask of parent.subtasks?.values() ?? []) {
      const savedGhost = this.host.ghosts?.entries.get(subtask.id);
      const ghost = savedGhost ?? this.previewLayer?.scheduleGhost(subtask.id);
      if (ghost && !renderedIds.has(subtask.id)) {
        this.ghostNodes.get(ghost.taskId)?.nodes.forEach((node) => node.remove());
        this.ghostNodes.set(ghost.taskId, { nodes: renderGhost(timeline, ghost, baseDate, dayWidth, BAR_VERTICAL_INSET_PX, undefined, savedGhost ? "saved" : this.previewLayer?.ghostMode) });
      }
      if (!renderedIds.has(subtask.id)) this.paintPreviewExtras(timeline, subtask.id, baseDate, dayWidth, BAR_VERTICAL_INSET_PX);
    }
    // Bars, their markers and their external labels.
    for (const render of renders) {
      const { bar, labelledBar, left, width, labelText, needsLabel } = render;
      const laneOffset = laneOffsets[bar.lane];
      // The bar band starts below this lane's external top-label rows.
      const barBandTop =
        laneOffset + topRowCounts[bar.lane] * EXTERNAL_LABEL_ROW_HEIGHT;

      // Render the bar centered in its base band.
      const barEl = document.createElement("div");
      barEl.classList.add("task-gantt-bar");
      if (bar.task.completed) barEl.classList.add("is-completed");
      const ownTagColor =
        getPrimaryGanttTagDefinition(this.host.settings, bar.task.tags)?.color ||
        "";
      const parentTagColor =
        getPrimaryGanttTagDefinition(this.host.settings, parent.tags)?.color ||
        "";
      const barTagColor = ownTagColor || parentTagColor;
      // Bars that fail getBarFilterState are removed before this render
      // loop. Reuse that same verdict as the color guard so tag coloring does
      // not leak into a filtered-out bar if the render path changes later.
      const barFilterState = this.getBarFilterState(parent, bar);
      if (barTagColor !== "" && barFilterState.visible) {
        barEl.style.backgroundColor = barTagColor;
        barEl.style.borderColor = barTagColor;
        if (bar.task.completed) {
          barEl.classList.add("is-tag-colored-completed");
        }
      }
      barEl.style.left = `${left}px`;
      barEl.style.top = `${barBandTop + BAR_VERTICAL_INSET_PX}px`;
      barEl.style.width = `${width}px`;
      barEl.style.height = `${BAR_HEIGHT}px`;
      // Do not set a native title attribute; browser tooltips would duplicate
      // the label shown inside or beside the bar.
      if (!needsLabel) {
        const title = document.createElement("span");
        title.classList.add("task-gantt-bar-title");
        title.textContent = labelText;
        barEl.appendChild(title);
      }
      const primaryBadgeTag = getPrimaryGanttTagDefinition(
        this.host.settings,
        bar.task.tags
      );
      // Option (b): only add the badge when the measured bar width can fit it
      // beside the title and resize handles; very narrow bars stay readable.
      if (
        width >= BAR_TAG_BADGE_MIN_WIDTH_PX &&
        primaryBadgeTag !== undefined
      ) {
        barEl.classList.add("has-tag-badge");
        const badge = document.createElement("span");
        badge.classList.add("task-gantt-bar-tag-badge", "vg-chip", "is-tag");
        badge.textContent = primaryBadgeTag.name;
        if (primaryBadgeTag.color) {
          setStyleVar(badge, "--vg-chip-color", primaryBadgeTag.color);
        }
        barEl.appendChild(badge);
      }
      const resizeStart = document.createElement("span");
      resizeStart.classList.add("task-gantt-resize-start");
      barEl.appendChild(resizeStart);
      const resizeEnd = document.createElement("span");
      resizeEnd.classList.add("task-gantt-resize-end");
      barEl.appendChild(resizeEnd);
      timeline.appendChild(barEl);
      const savedGhost = this.host.ghosts?.entries.get(bar.task.id);
      const ghost = savedGhost ?? this.previewLayer?.scheduleGhost(bar.task.id);
      if (ghost) {
        this.ghostNodes.get(ghost.taskId)?.nodes.forEach((node) => node.remove());
        this.ghostNodes.set(ghost.taskId, { nodes: renderGhost(timeline, ghost, baseDate, dayWidth, barBandTop + BAR_VERTICAL_INSET_PX, barEl, savedGhost ? "saved" : this.previewLayer?.ghostMode), current: barEl });
      }
      this.paintPreviewExtras(timeline, bar.task.id, baseDate, dayWidth, barBandTop + BAR_VERTICAL_INSET_PX, barEl);
      // Keep a keyed lookup for Bulk-Move previews and drag-state styling.
      this.barElsByTaskId.set(bar.task.id, barEl);


      // Render markers below the bar. The day-center anchor x remains the
      // value assigned to style.left and used by marker dragging. Without a
      // CSS centering transform, the marker's left edge renders at x, matching
      // the [x, x + width] collision interval used by layoutMarkers.

      const markerElsForBar: HTMLElement[] = [];
      for (const marker of markersByBar.get(bar) ?? []) {
        const markerEl = document.createElement("div");
        markerEl.classList.add("task-gantt-marker");
        // Apply the marker's own dim state independently of the bar's filter
        // state; the bar has already passed its visibility check.
        if (this.getMarkerFilterState(parent, bar, marker.marker).dim) {
          markerEl.classList.add("is-tag-filter-dimmed");
        }
        markerEl.style.left = `${marker.x}px`;
        markerEl.style.top = `${
          barBandTop +
          BAR_VERTICAL_INSET_PX +
          BAR_HEIGHT +
          2 +
          marker.row * MARKER_ROW_HEIGHT
        }px`;
        const markerPin = document.createElement("span");
        markerPin.classList.add("task-gantt-marker-pin");
        markerPin.textContent = "▲";
        markerEl.appendChild(markerPin);

        const markerLabel = document.createElement("span");
        markerLabel.classList.add("task-gantt-marker-label");
        markerLabel.textContent = marker.marker.title;
        markerEl.appendChild(markerLabel);
        // the marker's primary
        // tag definition is shown to its right. Registry order determines
        // the primary tag, while an orphan definition is rendered without a
        // color through the synthetic empty-color fallback.
        if (this.host.settings.ganttFeatureTagsEnabled) {
          const primaryMarkerTag = getPrimaryGanttTagDefinition(
            this.host.settings,
            marker.marker.tags ?? []
          );
          if (primaryMarkerTag !== undefined) {
            const markerBadge = document.createElement("span");
            markerBadge.classList.add("task-gantt-marker-tag", "vg-chip", "is-tag");
            markerBadge.textContent = primaryMarkerTag.name;
            if (primaryMarkerTag.color) {
              setStyleVar(markerBadge, "--vg-chip-color", primaryMarkerTag.color);
            }
            markerEl.appendChild(markerBadge);
          }
        }

        timeline.appendChild(markerEl);
        markerElsForBar.push(markerEl);

        // Start marker dragging only from the ▲ element. This pointerdown
        // handler and the context-menu handler below are registered for every
        // rendered marker. The owning bar handles marker hover highlighting.
        markerEl.addEventListener("pointerdown", (evt: PointerEvent) => {
          this.onMarkerPointerDown(evt, markerEl, bar.task, marker.marker);
        });

        // Double-click edits the marker title on markerEl. The label span is
        // presentational and does not affect the edit target.
        markerEl.addEventListener("dblclick", () => {
          this.startInlineEdit({
            hostEl: markerEl,
            initialValue: marker.marker.title || marker.marker.key,
            onCommit: (value) =>
              this.saveMarkerTitleEdit(bar.task, marker.marker.key, value),
          });
        });

        // Right-click opens the marker context menu, which retains the
        // marker editor and includes tag toggles and deletion.
        markerEl.addEventListener("contextmenu", (evt: MouseEvent) => {
          this.openMarkerContextMenu(evt, bar.task, marker.marker);
        });
      }

      // Render one static workload label per planned date with recorded
      // hours, directly above the bar. These labels stay aligned with date
      // columns and use the task's planned range, ignoring entries outside it.
      if (this.host.settings.ganttFeatureWorkloadEnabled) {
        if (hasPlannedDates(bar.task)) {
          for (
            let date = bar.task.plannedStartDate;
            date <= bar.task.plannedEndDate;
            date = addDays(date, 1)
          ) {
            const { plan, actual } = dayValues(bar.task, date);
            if (!plan && !actual) {
              continue;
            }

            const workloadLabel = document.createElement("div");
            workloadLabel.classList.add(
              "task-gantt-workload-day-label",
              "is-dual"
            );
            workloadLabel.style.left = `${
              diffDays(baseDate, date) * dayWidth
            }px`;
            workloadLabel.style.top = `${Math.max(
              0,
              barBandTop + BAR_VERTICAL_INSET_PX - 18
            )}px`;
            workloadLabel.style.width = `${dayWidth}px`;


            const actualLabel = document.createElement("span");
            actualLabel.classList.add("task-gantt-workload-day-label-actual");
            const actualDual = formatDualWorkloadLabel(actual, plan);
            actualLabel.textContent = actualDual.text;
            if (actualDual.isPlaceholder) {
              actualLabel.classList.add("is-placeholder");
            }
            workloadLabel.appendChild(actualLabel);

            const planLabel = document.createElement("span");
            planLabel.classList.add("task-gantt-workload-day-label-plan");
            const planDual = formatDualWorkloadLabel(plan, actual);
            planLabel.textContent = planDual.text;
            if (planDual.isPlaceholder) {
              planLabel.classList.add("is-placeholder");
            }
            workloadLabel.appendChild(planLabel);


            timeline.appendChild(workloadLabel);
          }
        }
      }

      // Moving and resizing share this pointerdown handler. Pointer position
      // selects an edge resize or a bar move.
      barEl.addEventListener("pointerdown", (evt: PointerEvent) => {
        this.onBarPointerDown(evt, barEl, bar.task, left, width, markerElsForBar);
      });

      // Double-click edits the subtask title. The bar element carries the
      // visible title in its native `.title` tooltip, so it is the edit host.
      barEl.addEventListener("dblclick", () => {
        this.startInlineEdit({
          hostEl: barEl,
          initialValue: bar.task.displayName || bar.task.title,
          onCommit: (value) => this.saveSubtaskTitleEdit(bar.task, value),
        });
      });

      // Right-click opens the bar context menu, which can add a marker.
      // Existing markers are edited through the marker menu and MarkerModal.
      barEl.addEventListener("contextmenu", (evt: MouseEvent) => {
        this.openBarContextMenu(evt, bar.task, bar, barEl);
      });

      // Show the subtask popover on mouseover unless drag suppression is
      // active. Its read-only period field uses the bar's dates. Mouseleave
      // starts a 220ms hide debounce and clears is-parent-hover from markers.
      barEl.addEventListener("mouseover", (evt: MouseEvent) => {
        this.onRichPopoverTrigger(
          {
            kind: "subtask",
            task: bar.task,
            anchorEl: barEl,
            barStart: bar.start,
            barEnd: bar.end,
          },
          evt
        );
        for (const markerEl of markerElsForBar) {
          markerEl.classList.add("is-parent-hover");
        }
      });
      barEl.addEventListener("mouseleave", () => {
        this.richPopoverPointerOutside = true;
        this.scheduleRichPopoverHide();
        for (const markerEl of markerElsForBar) {
          markerEl.classList.remove("is-parent-hover");
        }
      });
      // The bar-level workload graph is a separate popover from the rich
      // popover above. Mouseenter shows it when workload is enabled, and
      // mouseleave starts its independent 160ms hide debounce.
      barEl.addEventListener("mouseenter", () => {
        if (this.host.settings.ganttFeatureWorkloadEnabled) {
          this.showWorkloadPopupForBar(bar.task, barEl);
        }
      });
      barEl.addEventListener("mouseleave", () => {
        this.scheduleHideWorkloadPopup();
      });

      // Render an external label when this bar needs one.
      const placement = labelPlacements.get(labelledBar);
      if (placement !== undefined) {
        const [connector, label] = this.renderExternalLabel(
          bar,
          placement,
          baseDate,
          dayWidth,
          labelText,
          left,
          width,
          laneOffset,
          barBandTop,
          topRowCounts[bar.lane],
          markerRowCounts[bar.lane],
          barTagColor
        );
        timeline.appendChild(connector);
        timeline.appendChild(label);
      }
    }

    // Render the due-date marker in the row's bottom band. It is shown only
    // when the due date is within the visible timeline and includes a star,
    // the "期限" label, and the formatted date.
    if (hasDeadlineMarker && parent.dueDate) {
      const deadlineLeft = diffDays(baseDate, parent.dueDate) * dayWidth;
      const timelineWidth = dates.length * dayWidth;
      if (deadlineLeft >= 0 && deadlineLeft <= timelineWidth) {
        // The marker is not rendered when its date is outside the visible range.
        const deadline = document.createElement("div");
        deadline.classList.add("task-gantt-deadline-marker");
        deadline.style.left = `${deadlineLeft}px`;
        deadline.style.top = `${
          rowHeight - MARKER_ROW_HEIGHT - DEADLINE_MARKER_GAP_PX
        }px`;
        // ★ + "期限" label + M/D date.

        const deadlineStar = document.createElement("span");
        deadlineStar.classList.add("task-gantt-deadline-marker-star");
        deadlineStar.textContent = "★";
        deadline.appendChild(deadlineStar);
        // Explicit space text nodes (not just CSS margin) so textContent/
        // copied text still reads "★ 期限 8/25" instead of "★期限8/25".
        deadline.appendChild(document.createTextNode(" "));

        const deadlineLabel = document.createElement("span");
        deadlineLabel.classList.add("task-gantt-deadline-marker-label");
        deadlineLabel.textContent = "期限";
        deadline.appendChild(deadlineLabel);
        deadline.appendChild(document.createTextNode(" "));

        const deadlineDate = document.createElement("span");
        deadlineDate.classList.add("task-gantt-deadline-marker-date");
        deadlineDate.textContent = this.formatMonthDay(parent.dueDate);
        deadline.appendChild(deadlineDate);

        // parent due-date drag starts only on the ★ (deadline
        // marker) element.
        deadline.addEventListener("pointerdown", (evt: PointerEvent) => {
          this.onParentDuePointerDown(evt, deadline, parent);
        });
        // right-click menu — 「期限を削除」/「ノートを
        // 開く」, same real obsidian.Menu + activeContextMenu dedupe idiom
        // as openParentContextMenu/openMarkerContextMenu.
        deadline.addEventListener("contextmenu", (evt: MouseEvent) => {
          this.openDeadlineMarkerContextMenu(evt, parent);
        });
        timeline.appendChild(deadline);
      }
    }

    return timeline;
  }











  private renderExternalLabel(
    bar: Bar,
    placement: ExternalLabelPlacement,
    baseDate: string,
    dayWidth: number,
    labelText: string,
    barLeft: number,
    barWidth: number,
    laneOffset: number,
    barBandTop: number,
    topRows: number,
    markerRows: number,
    barTagColor: string
  ): [HTMLElement | SVGSVGElement, HTMLElement] {
    // labelLeft = bar right edge + 8px — the same value
    // layoutExternalBarLabels used internally.
    const labelLeft =
      (diffDays(baseDate, bar.end) + 1) * dayWidth - 4 + EXTERNAL_LABEL_GAP_PX;

    // Vertical band: top labels stack ABOVE the bar band (row 0 closest to
    // the bar), bottom labels stack BELOW the marker band.
    let labelTop: number;
    if (placement.side === "top") {
      labelTop =
        laneOffset + (topRows - 1 - placement.row) * EXTERNAL_LABEL_ROW_HEIGHT;
    } else {
      const bottomBandTop =
        barBandTop + LANE_BASE_HEIGHT + markerRows * MARKER_ROW_HEIGHT;
      labelTop = bottomBandTop + placement.row * EXTERNAL_LABEL_ROW_HEIGHT;
    }

    // The label is always to the right of the bar, but its top/bottom row can
    // put the other endpoint above or below the bar. The connector uses a
    // two-segment SVG elbow, with both endpoints at the calculated coordinates.
    const barRight = barLeft + barWidth;
    const sourceY =
      placement.side === "top"
        ? barBandTop + BAR_VERTICAL_INSET_PX
        : barBandTop + BAR_VERTICAL_INSET_PX + BAR_HEIGHT;
    const targetY =
      placement.side === "top"
        ? labelTop + EXTERNAL_LABEL_ROW_HEIGHT
        : labelTop;
    const deltaX = labelLeft - barRight;

    const sourceX = barLeft + Math.max(6, Math.min(barWidth - 6, barWidth / 2));
    const targetX = barRight + deltaX;
    const bendX =
      sourceX +
      (targetX >= sourceX ? 1 : -1) *
        Math.min(28, Math.max(10, Math.abs(targetX - sourceX) * 0.55));
    const bendY = targetY;
    const minX = Math.min(sourceX, bendX, targetX) - 3;
    const maxX = Math.max(sourceX, bendX, targetX) + 3;
    const minY = Math.min(sourceY, bendY, targetY) - 3;
    const maxY = Math.max(sourceY, bendY, targetY) + 3;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("task-gantt-external-connector");
    svg.setAttribute("width", String(Math.max(8, maxX - minX)));
    svg.setAttribute("height", String(Math.max(8, maxY - minY)));
    svg.style.left = `${minX}px`;
    svg.style.top = `${minY}px`;
    const polyline = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline"
    );
    polyline.setAttribute(
      "points",
      [
        `${sourceX - minX},${sourceY - minY}`,
        `${bendX - minX},${bendY - minY}`,
        `${targetX - minX},${targetY - minY}`,
      ].join(" ")
    );
    svg.appendChild(polyline);

    const connector = svg;

    const label = document.createElement("div");
    label.classList.add("task-gantt-external-label");
    if (bar.task.completed) label.classList.add("is-completed");
    if (barTagColor !== "") {
      label.classList.add("is-tagged");
      label.style.borderColor = barTagColor;
    }
    label.style.left = `${labelLeft}px`;
    label.style.top = `${labelTop}px`;
    // the rendered box (text + badge) never exceeds 340px;
    // overflow past the viewport is NOT clamped.
    label.style.maxWidth = `${EXTERNAL_LABEL_MAX_WIDTH_PX}px`;

    const text = document.createElement("span");
    text.classList.add("task-gantt-label-text");
    text.textContent = labelText;
    label.appendChild(text);

    const primaryBadgeTag = getPrimaryGanttTagDefinition(
      this.host.settings,
      bar.task.tags
    );
    if (primaryBadgeTag !== undefined) {
      const badge = document.createElement("span");
      badge.classList.add("task-gantt-label-badge", "vg-chip", "is-tag");
      badge.textContent = primaryBadgeTag.name;
      if (primaryBadgeTag.color) {
        setStyleVar(badge, "--vg-chip-color", primaryBadgeTag.color);
      }
      label.appendChild(badge);
    }

    return [connector, label];
  }












  private async toggleHoliday(dateStr: string): Promise<void> {
    const manual = this.host.settings.ganttManualHolidays;
    const index = manual.indexOf(dateStr);
    if (index >= 0) {
      manual.splice(index, 1);
    } else {
      manual.push(dateStr);
    }
    await this.host.saveSettings();

    // preserve the horizontal scroll position across re-render.
    const scrollLeft = this.wrapEl.scrollLeft;
    this.renderChart();
    this.wrapEl.scrollLeft = scrollLeft;
  }





  /**
 *
 * Extends the date range automatically as the user scrolls towards either
 * edge. Left and right triggers are mutually exclusive per event (left is
 * checked first). The double-requestAnimationFrame dance on the left keeps
 * the visible position stable after prepending 60 days.
 */
  private onScroll(): void {



    this.tagFilterMenuEl?.remove();
    this.tagFilterMenuEl = undefined;
    if (this.tagFilterMenuOutsideClickHandler) {
      window.removeEventListener("click", this.tagFilterMenuOutsideClickHandler);
      this.tagFilterMenuOutsideClickHandler = undefined;
    }
    // scrolling the chart closes the rich popover immediately
    // (NO 220ms debounce — unlike the mouse-leave path — because the anchor
    // element's position is stale the instant scrolling starts).
    this.closeRichPopover();
    // Close the workload popup immediately for the same reason. Scrolling
    // makes its anchor position stale, and extending the horizontal range
    // could desynchronize the popup's date snapshot from the live dates and
    // day width used by paintWorkloadCell. Closing it prevents misattribution.
    this.closeWorkloadPopup();
    // The fixed day-summary popover is anchored to a summary-row cell whose
    // viewport position is stale as soon as the chart scrolls.
    this.closeWorkloadDaySummaryPopover();
    // a chip's viewport position is stale as soon as the chart
    // scrolls, so close its fixed detail preview immediately as well.
    this.closeDailyTodoPopover();

    // ignore scroll events fired while an extension is mid-flight.
    if (this.isExtendingRange) {
      return;
    }

    const threshold = Math.max(240, this.dayWidth * 10);
    const wrap = this.wrapEl;

    if (wrap.scrollLeft < threshold) {
      // left extension.
      this.isExtendingRange = true;
      this.rangeStart = addDays(this.rangeStart, -RANGE_EXTEND_DAYS);
      this.rangeDays += RANGE_EXTEND_DAYS;
      requestAnimationFrame(() => {
        this.renderChart();
        requestAnimationFrame(() => {
          // Shift right by the prepended width so the visible content stays
          // put.
          this.wrapEl.scrollLeft += RANGE_EXTEND_DAYS * this.dayWidth;
          this.isExtendingRange = false;
          this.updateFloatingMonth();
        });
      });
    } else if (
      wrap.scrollLeft + wrap.clientWidth >
      wrap.scrollWidth - threshold
    ) {
      // right extension — appending days does not move
      // existing content, so no scroll shift is needed.
      this.isExtendingRange = true;
      this.rangeDays += RANGE_EXTEND_DAYS;
      requestAnimationFrame(() => {
        this.renderChart();
        this.isExtendingRange = false;
        this.updateFloatingMonth();
      });
    }

    this.updateFloatingMonth();
  }







  private updateFloatingMonth(): void {
    const startDate = this.getVisibleStartDate();
    const month = moment(startDate, "YYYY-MM-DD").format("YYYY年M月");
    if (month === this.lastFloatingMonth && this.floatingMonthEl.textContent === month) {
      return;
    }
    this.lastFloatingMonth = month;
    this.floatingMonthEl.textContent = month;
  }

  /**
 *
 * Scrolls so `dateStr` sits `offsetPx` from the left edge, then refreshes
 * the floating month. No-op when the date is outside the current range.
 */
  scrollToDate(dateStr: string, offsetPx = 0): void {
    const dateIndex = this.dates.indexOf(dateStr);
    if (dateIndex < 0) {
      return;
    }
    const scrollLeft = Math.max(0, dateIndex * this.dayWidth - offsetPx);
    this.wrapEl.scrollLeft = scrollLeft;
    this.updateFloatingMonth();
  }

  /**
 *
 * The leftmost visible date (falls back to today when the computed index is
 * out of bounds). Used as the base date for pointer→date mapping and the
 * floating month.
 */
  private getVisibleStartDate(): string {
    const index = Math.floor(this.wrapEl.scrollLeft / this.dayWidth);
    return this.dates[index] ?? todayStr();
  }

  /**
 *
 * Grows the range (in RANGE_EXTEND_DAYS steps) until `dateStr` falls inside
 * [rangeStart, rangeStart + rangeDays - 1]. ISO string comparison is
 * chronological.
 */
  private ensureDateInRange(dateStr: string): void {
    while (dateStr < this.rangeStart) {
      this.rangeStart = addDays(this.rangeStart, -RANGE_EXTEND_DAYS);
      this.rangeDays += RANGE_EXTEND_DAYS;
    }
    while (dateStr > addDays(this.rangeStart, this.rangeDays - 1)) {
      this.rangeDays += RANGE_EXTEND_DAYS;
    }
  }























  async setZoom(newDayWidth: number): Promise<void> {
    const oldScrollLeft = this.wrapEl.scrollLeft;
    const oldDayWidth = this.dayWidth;
    // Captured BEFORE dayWidth changes below — getVisibleStartDate divides
    // scrollLeft by this.dayWidth, so computing it after the reassignment
    // would divide the still-old scrollLeft by the NEW width and resolve to
    // the wrong date (harmless today only because ensureDateInRange is a
    // no-op for every reachable date here — today and every buildDates
    // entry both already sit inside [rangeStart, rangeStart+rangeDays-1] —
    // but that's an accident of the current range invariants, not something
    // this call should rely on).
    const visibleDateBeforeZoom = this.getVisibleStartDate();


    this.dayWidth = newDayWidth;

    this.host.settings.ganttZoom = newDayWidth;
    await this.host.saveSettings();

    // Preserve the visible date in range after zooming.

    this.ensureDateInRange(visibleDateBeforeZoom);


    this.renderChart();

    // restore scroll scaled by the width ratio. Applied AFTER the
    // re-render so the resized content can actually hold the new offset (in a
    // real DOM the browser clamps scrollLeft to scrollWidth).
    if (oldDayWidth !== 0) {
      this.wrapEl.scrollLeft = oldScrollLeft * (newDayWidth / oldDayWidth);
    }

    // refresh the visible zoom label.
    this.zoomLabelEl.textContent = this.zoomLabelText();


    this.updateFloatingMonth();
  }





  /**
 *
 * Bar pointerdown: left-button only (— anything else is a no-op),
 * preventDefault + stopPropagation, then dispatches to
 * bar-move / resize-start / resize-end based on where inside the bar's
 * rendered width the pointer landed (RESIZE_EDGE_HIT_ZONE_PX from either
 * edge starts a resize; the remaining width starts a move.
 */
  private onBarPointerDown(
    evt: PointerEvent,
    barEl: HTMLElement,
    task: TaskRow,
    left: number,
    width: number,
    markerEls: HTMLElement[]
  ): void {
    if (this.inlineEditingEls.has(barEl)) {
      return;
    }
    if (evt.button !== 0) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    // Keep receiving the same pointer's events if it briefly leaves the bar.
    // Window listeners also receive them; capture preserves pointer identity
    // until runBarDrag releases it on pointerup.
    barEl.setPointerCapture(evt.pointerId);

    const barRect = barEl.getBoundingClientRect();
    const offsetX = evt.clientX - barRect.left;
    let kind: "move" | "resize-start" | "resize-end";
    if (offsetX <= RESIZE_EDGE_HIT_ZONE_PX) {
      kind = "resize-start";
    } else if (offsetX >= width - RESIZE_EDGE_HIT_ZONE_PX) {
      kind = "resize-end";
    } else {
      kind = "move";
    }


    this.host.logger.info?.(
      "TaskGanttView",
      kind === "move" ? "bar drag started" : "bar resize started",
      { taskId: task.id }
    );

    this.runBarDrag(
      kind,
      task,
      barEl,
      left,
      width,
      markerEls,
      evt.clientX,
      evt.pointerId
    );
  }

  /**
 *
 * Marker pointerdown — same common left-button + preventDefault/
 * stopPropagation gate as every other drag start.
 */
  private onMarkerPointerDown(
    evt: PointerEvent,
    markerEl: HTMLElement,
    task: TaskRow,
    marker: GanttMarker
  ): void {
    if (this.inlineEditingEls.has(markerEl)) {
      return;
    }
    if (evt.button !== 0) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    markerEl.setPointerCapture(evt.pointerId);

    this.host.logger.info?.("TaskGanttView", "marker drag started", {
      taskId: task.id,
    });

    this.runMarkerDrag(task, marker, markerEl, evt.clientX, evt.pointerId);
  }













  private onParentDuePointerDown(
    evt: PointerEvent,
    deadlineEl: HTMLElement,
    parent: TaskRow
  ): void {
    if (evt.button !== 0) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    deadlineEl.setPointerCapture(evt.pointerId);
    this.runParentDueDrag(parent, deadlineEl, evt.clientX, evt.pointerId);
  }





  /** shows/updates the shared drag tooltip. */
  private showDragTooltip(
    text: string,
    clientX: number,
    clientY: number
  ): void {
    const el = this.dragTooltipEl;
    el.textContent = text;
    el.classList.add("is-visible");
    // Place the tooltip right of the cursor and clamp its top to 8px.
    el.style.left = `${clientX + 8}px`;
    el.style.top = `${Math.max(8, clientY - 8)}px`;
  }

  /** hides the tooltip and clears its content. */
  private hideDragTooltip(): void {
    const el = this.dragTooltipEl;
    el.textContent = "";
    el.classList.remove("is-visible");
  }

  /** searches this.tasks (including subtasks) for a live task by id. */
  private findTaskById(id: string): TaskRow | undefined {
    for (const row of this.tasks) {
      if (row.id === id) {
        return row;
      }
      if (row.subtasks !== undefined) {
        for (const subtask of row.subtasks.values()) {
          if (subtask.id === id) {
            return subtask;
          }
        }
      }
    }
    return undefined;
  }





  /**
 *
 *
 * Runs a bar-drag session from pointerdown through pointerup. It attaches
 * window-level pointermove and pointerup listeners and drives the visual
 * preview during movement before handing off to finishBarDrag. There is no
 * exclusive lock, so a later pointerdown can start another independent drag.
 */
  private runBarDrag(
    kind: "move" | "resize-start" | "resize-end",
    task: TaskRow,
    barEl: HTMLElement,
    originalLeft: number,
    originalWidth: number,
    markerEls: HTMLElement[],
    startClientX: number,
    pointerId: number
  ): void {
    const originalStart = task.plannedStartDate ?? "";
    const originalEnd = task.plannedEndDate ?? "";
    const dayWidth = this.dayWidth;
    const holidaySet = this.holidaySet;
    // captured ONCE up front so repeated pointermove deltas
    // never compound against an already-shifted value.
    const originalMarkerLefts = markerEls.map((el) =>
      parseFloat(el.style.left || "0")
    );
    let movedPastThreshold = false;

    // Keep the latest pointer event and schedule at most one rAF per frame.
    // The callback uses the most recent event, while dragEnded prevents a
    // queued frame from updating the preview after pointerup resets it.
    let pendingMoveEvt: PointerEvent | undefined;
    let rafScheduled = false;
    let dragEnded = false;

    barEl.classList.add("is-dragging");

    const applyMovePreview = (moveEvt: PointerEvent): void => {
      const dxPx = moveEvt.clientX - startClientX;
      if (
        !movedPastThreshold &&
        Math.abs(dxPx) >= DRAG_TOOLTIP_THRESHOLD_PX
      ) {
        movedPastThreshold = true;
      }

      // visual preview.
      if (kind === "move") {
        barEl.style.left = `${originalLeft + dxPx}px`;
        // markers move together with the bar.
        markerEls.forEach((el, i) => {
          el.style.left = `${originalMarkerLefts[i] + dxPx}px`;
        });
      } else if (kind === "resize-start") {
        // width never drops below MIN_BAR_WIDTH_PX (8px).
        const clampedDx = Math.min(dxPx, originalWidth - MIN_BAR_WIDTH_PX);
        barEl.style.left = `${originalLeft + clampedDx}px`;
        barEl.style.width = `${Math.max(
          MIN_BAR_WIDTH_PX,
          originalWidth - clampedDx
        )}px`;
      } else {
        // resize-end. width never drops below MIN_BAR_WIDTH_PX.
        barEl.style.width = `${Math.max(
          MIN_BAR_WIDTH_PX,
          originalWidth + dxPx
        )}px`;
      }

      if (!movedPastThreshold) {
        return;
      }
      // NOT snapped during the drag — the raw
      // (un-snapped) range is shown; only the confirm step snaps.
      const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
      let tooltipText: string;
      if (kind === "move") {
        // duration preserved in the preview.
        tooltipText = formatDragRangeTooltip(
          addDays(originalStart, dayDelta),
          addDays(originalEnd, dayDelta)
        );
      } else if (kind === "resize-start") {
        // end stays fixed in the preview.
        tooltipText = formatDragRangeTooltip(
          addDays(originalStart, dayDelta),
          originalEnd
        );
      } else {
        // start stays fixed in the preview.
        tooltipText = formatDragRangeTooltip(
          originalStart,
          addDays(originalEnd, dayDelta)
        );
      }
      this.showDragTooltip(tooltipText, moveEvt.clientX, moveEvt.clientY);
    };

    const onMove = (moveEvt: PointerEvent): void => {
      // latest event always overwrites; at most one rAF is
      // ever in flight.
      pendingMoveEvt = moveEvt;
      if (rafScheduled) {
        return;
      }
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (dragEnded) {
          return; // onUp already ran — nothing left to preview.
        }
        const evt = pendingMoveEvt;
        if (evt === undefined) {
          return;
        }
        applyMovePreview(evt);
      });
    };

    const onUp = (upEvt: PointerEvent): void => {
      dragEnded = true; // guards a late-firing pending rAF
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      barEl.releasePointerCapture(pointerId);

      // preview resets to its initial (pre-drag) values —
      // done immediately and unconditionally here (not deferred to a
      // post-save render) because a cancelled workload-shift confirm
      // skips render entirely, and the bar/markers must not be
      // left visually stuck at the dragged position in that case.
      barEl.classList.remove("is-dragging");
      barEl.style.left = `${originalLeft}px`;
      barEl.style.width = `${originalWidth}px`;
      markerEls.forEach((el, i) => {
        el.style.left = `${originalMarkerLefts[i]}px`;
      });
      this.hideDragTooltip();
      this.armRichPopoverSuppress();

      const dxPx = upEvt.clientX - startClientX;
      const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
      void this.finishBarDrag(
        kind,
        task,
        dayDelta,
        originalStart,
        originalEnd,
        holidaySet
      );
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    this.dragState = { kind: `bar-${kind}`, taskId: task.id };
  }
















  private async finishBarDrag(
    kind: "move" | "resize-start" | "resize-end",
    task: TaskRow,
    dayDelta: number,
    originalStart: string,
    originalEnd: string,
    holidaySet: Set<string>
  ): Promise<void> {
    if (dayDelta === 0) {
      return;
    }

    let patch: TaskPatch;
    if (kind === "move") {

      const { nextStart, nextEnd, shiftedMarkers } = moveBarByCalendarDelta(
        { start: originalStart, end: originalEnd, markers: task.ganttMarkers },
        dayDelta,
        holidaySet
      );
      if (nextStart === originalStart && nextEnd === originalEnd) {
        return;
      }
      patch = {
        plannedStartDate: nextStart,
        plannedEndDate: nextEnd, //  no inversion check needed for move
        ganttMarkers: shiftedMarkers,
      };
    } else if (kind === "resize-start") {

      const newStart = snapResizeStart(
        addDays(originalStart, dayDelta),
        originalEnd,
        holidaySet
      );
      if (newStart === originalStart) {
        return;
      }
      patch = { plannedStartDate: newStart };
    } else {

      const newEnd = snapResizeEnd(
        originalStart,
        addDays(originalEnd, dayDelta),
        holidaySet
      );
      if (newEnd === originalEnd) {
        return;
      }
      patch = { plannedEndDate: newEnd };
    }

    // only a bar move shifts the whole task relative to its
    // workload actuals. A one-edge resize changes the task boundary without
    // moving any recorded work, so it must not show the workload-shift warning



    this.closeRichPopover();
    this.closeWorkloadPopup();

    await this.saveTaskPatch(task, patch, { checkWorkload: kind === "move" });

    this.host.logger.info?.(
      "TaskGanttView",
      kind === "move" ? "bar drag committed" : "bar resize committed",
      {
        taskId: task.id,
        plannedStartDate: patch.plannedStartDate,
        plannedEndDate: patch.plannedEndDate,
      }
    );

  }


  // Fixed event-row interactions









  private onGanttEventPointerDown(
    evt: PointerEvent,
    chip: HTMLElement,
    label: HTMLElement,
    event: GanttEvent
  ): void {
    if (this.inlineEditingEls.has(chip) || this.inlineEditingEls.has(label)) {
      return;
    }
    if (evt.button !== 0) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    chip.setPointerCapture(evt.pointerId);
    this.runGanttEventDrag(event, chip, evt.clientX, evt.pointerId);
  }

  /** Previews and commits one event's date from the pointer's day-column
 * DELTA (originalDate + dayDelta), the same dxPx→pixelDeltaToDayDelta
 * scheme runMarkerDrag uses — never recomputed from the pointer's raw
 * absolute position, so a plain click (zero delta) is guaranteed to be a
 * no-op regardless of where inside the chip's width the click landed. */
  private runGanttEventDrag(
    event: GanttEvent,
    chip: HTMLElement,
    startClientX: number,
    pointerId: number
  ): void {
    const originalDate = event.date;
    const originalLeft = parseFloat(chip.style.left || "0");
    const dayWidth = this.dayWidth;

    const preview = (dxPx: number): void => {
      chip.style.left = `${originalLeft + dxPx}px`;
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      chip.releasePointerCapture(pointerId);
      chip.classList.remove("is-dragging");
      chip.style.transition = "";
      chip.style.left = `${originalLeft}px`;
      this.armRichPopoverSuppress();
    };
    const onMove = (moveEvt: PointerEvent): void => {
      preview(moveEvt.clientX - startClientX);
    };
    const onUp = (upEvt: PointerEvent): void => {
      cleanup();
      const dayDelta = pixelDeltaToDayDelta(
        upEvt.clientX - startClientX,
        dayWidth
      );
      if (dayDelta === 0) {
        return;
      }
      void this.finishGanttEventDrag(event.key, addDays(originalDate, dayDelta));
    };
    const onCancel = (): void => {
      cleanup(); // no commit — mirrors the workload paint-drag's onCancel.
    };

    chip.classList.add("is-dragging");
    // forbids transition declarations in styles.css; disabling any
    // theme-provided transition inline preserves the drag-state behavior.
    chip.style.transition = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    this.dragState = { kind: "gantt-event", eventKey: event.key };
  }

  private async finishGanttEventDrag(
    eventKey: string,
    newDate: string
  ): Promise<void> {
    updateGanttEvent(this.host.settings, eventKey, { date: newDate });
    await this.host.saveSettings();
    await this.render();
  }

  private async saveGanttEventTitleEdit(
    eventKey: string,
    value: string
  ): Promise<void> {
    updateGanttEvent(this.host.settings, eventKey, { title: value });
    await this.host.saveSettings();
    await this.render();
  }

  /** Shows the event's intentionally minimal context menu: title editing is
 * already provided by label double-click; duplicate and delete are available
 * here. */
  private openGanttEventContextMenu(
    evt: MouseEvent,
    event: GanttEvent
  ): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.armRichPopoverSuppress(MENU_POPOVER_SUPPRESS_MS);
    this.closeRichPopover();

    const menu = new Menu();
    this.activateContextMenu(menu);

    menu.addItem((item) => {
      item.setTitle("複製");
      item.onClick(() => {
        duplicateGanttEvent(this.host.settings, event.key);
        void this.host.saveSettings().then(() => this.render());
      });
    });

    menu.addItem((item) => {
      item.setTitle("削除");
      item.setWarning(true);
      item.onClick(() => {
        void this.deleteGanttEventInteractively(event.key);
      });
    });
    menu.showAtMouseEvent(evt);
  }

  private async deleteGanttEventInteractively(eventKey: string): Promise<void> {
    deleteGanttEvent(this.host.settings, eventKey);
    await this.host.saveSettings();
    await this.render();
  }













  private runMarkerDrag(
    task: TaskRow,
    marker: GanttMarker,
    markerEl: HTMLElement,
    startClientX: number,
    pointerId: number
  ): void {
    const originalDate = marker.date;
    const rangeStart = task.plannedStartDate ?? originalDate;
    const rangeEnd = task.plannedEndDate ?? originalDate;
    const dayWidth = this.dayWidth;
    const holidaySet = this.holidaySet;
    const taskId = task.id;
    const markerKey = marker.key;
    const originalMarkerLeft = parseFloat(markerEl.style.left || "0");
    let movedPastThreshold = false;

    // only the visual style.left write + tooltip are deferred; the
    // "task vanished mid-drag" check stays synchronous per pointermove so a
    // deletion stops the session on the SAME event, not up to a frame late.
    let pendingMoveEvt: PointerEvent | undefined;
    let rafScheduled = false;
    let dragEnded = false;

    markerEl.classList.add("is-dragging");

    const cleanup = (): void => {
      dragEnded = true; // guards a late-firing pending rAF
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      markerEl.releasePointerCapture(pointerId);
      markerEl.classList.remove("is-dragging");
      markerEl.style.left = `${originalMarkerLeft}px`;
      this.hideDragTooltip();
      // cleanup runs from BOTH onUp and onMove's error-catch
      // path, so arming here covers the marker drag ending either way.
      this.armRichPopoverSuppress();
    };

    const applyMarkerMovePreview = (moveEvt: PointerEvent): void => {
      const dxPx = moveEvt.clientX - startClientX;
      if (
        !movedPastThreshold &&
        Math.abs(dxPx) >= DRAG_TOOLTIP_THRESHOLD_PX
      ) {
        movedPastThreshold = true;
      }
      markerEl.style.left = `${originalMarkerLeft + dxPx}px`;

      if (!movedPastThreshold) {
        return;
      }
      const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
      let rawDate = addDays(originalDate, dayDelta);
      // clamped preview, not yet snapped.
      if (rawDate < rangeStart) {
        rawDate = rangeStart;
      } else if (rawDate > rangeEnd) {
        rawDate = rangeEnd;
      }
      this.showDragTooltip(
        formatMarkerDragTooltip(marker.title, rawDate),
        moveEvt.clientX,
        moveEvt.clientY
      );
    };

    const onMove = (moveEvt: PointerEvent): void => {
      try {

        if (this.findTaskById(taskId) === undefined) {
          cleanup();
          return;
        }
        // latest event always overwrites; at most one rAF is
        // ever in flight (classic rAF coalescing).
        pendingMoveEvt = moveEvt;
        if (rafScheduled) {
          return;
        }
        rafScheduled = true;
        requestAnimationFrame(() => {
          rafScheduled = false;
          if (dragEnded) {
            return; // cleanup already ran — nothing left to preview.
          }
          const evt = pendingMoveEvt;
          if (evt === undefined) {
            return;
          }
          try {
            applyMarkerMovePreview(evt);
          } catch (err) {

            // handler, even when it surfaces inside the deferred rAF.

            this.host.logger.warn(
              "TaskGanttView",
              "marker drag preview failed",
              err
            );

            cleanup();
          }
        });
      } catch (err) {


        this.host.logger.warn(
          "TaskGanttView",
          "marker drag preview failed",
          err
        );

        cleanup();
      }
    };

    const onUp = (upEvt: PointerEvent): void => {
      cleanup();
      try {

        const liveTask = this.findTaskById(taskId);
        if (liveTask === undefined) {
          return;
        }
        const dxPx = upEvt.clientX - startClientX;
        const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
        if (dayDelta === 0) {
          return;
        }
        const rawDate = addDays(originalDate, dayDelta);
        const newDate = snapMarkerDate(
          rawDate,
          rangeStart,
          rangeEnd,
          holidaySet
        );
        if (newDate === originalDate) {
          return;
        }
        void this.finishMarkerDrag(liveTask, markerKey, newDate);
      } catch (err) {

        this.host.logger.warn(
          "TaskGanttView",
          "marker drag confirm failed",
          err
        );

      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    this.dragState = { kind: "marker", taskId, markerKey };
  }

  /**
 *
 * Updates only the dragged marker's date; every other marker in the
 * array is passed through unchanged.
 */
  private async finishMarkerDrag(
    task: TaskRow,
    markerKey: string,
    newDate: string
  ): Promise<void> {
    const markers = task.ganttMarkers ?? [];
    const updated = markers.map((m) =>
      m.key === markerKey ? { ...m, date: newDate } : m
    );

    // text names "バー" specifically, and only Bulk-Move gets its own

    await this.saveTaskPatch(
      task,
      { ganttMarkers: updated },
      { checkWorkload: false }
    );

    this.host.logger.info?.("TaskGanttView", "marker drag committed", {
      taskId: task.id,
      date: newDate,
    });

  }



















  private runParentDueDrag(
    parent: TaskRow,
    deadlineEl: HTMLElement,
    startClientX: number,
    pointerId: number
  ): void {
    const originalDue = parent.dueDate ?? "";
    const dayWidth = this.dayWidth;
    const holidaySet = this.holidaySet;
    const originalLeft = parseFloat(deadlineEl.style.left || "0");
    let movedPastThreshold = false;

    let pendingMoveEvt: PointerEvent | undefined;
    let rafScheduled = false;
    let dragEnded = false;

    deadlineEl.classList.add("is-dragging");

    const applyMovePreview = (moveEvt: PointerEvent): void => {
      const dxPx = moveEvt.clientX - startClientX;
      if (
        !movedPastThreshold &&
        Math.abs(dxPx) >= DRAG_TOOLTIP_THRESHOLD_PX
      ) {
        movedPastThreshold = true;
      }
      deadlineEl.style.left = `${originalLeft + dxPx}px`;

      if (!movedPastThreshold) {
        return;
      }
      const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
      this.showDragTooltip(
        formatDueDateDragTooltip(addDays(originalDue, dayDelta)),
        moveEvt.clientX,
        moveEvt.clientY
      );
    };

    const onMove = (moveEvt: PointerEvent): void => {
      // latest event always overwrites; at most one rAF is
      // ever in flight (classic rAF coalescing).
      pendingMoveEvt = moveEvt;
      if (rafScheduled) {
        return;
      }
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (dragEnded) {
          return; // onUp already ran — nothing left to preview.
        }
        const evt = pendingMoveEvt;
        if (evt === undefined) {
          return;
        }
        applyMovePreview(evt);
      });
    };

    const onUp = (upEvt: PointerEvent): void => {
      dragEnded = true; // guards a late-firing pending rAF
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      deadlineEl.releasePointerCapture(pointerId);
      deadlineEl.classList.remove("is-dragging");
      deadlineEl.style.left = `${originalLeft}px`;
      this.hideDragTooltip();
      this.armRichPopoverSuppress();

      const dxPx = upEvt.clientX - startClientX;
      const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
      if (dayDelta === 0) {
        return;
      }

      // Forward snapping is also used by the other date-drag handlers.
      const newDue = snapForward(addDays(originalDue, dayDelta), holidaySet);
      if (newDue === originalDue) {
        return;
      }
      void this.saveTaskPatch(
        parent,
        { dueDate: newDue },
        { checkWorkload: false }
      ); // saveTaskPatch's unconditional render covers this.
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    this.dragState = { kind: "parent-due", taskId: parent.id };
  }














  private openDeadlineMarkerContextMenu(
    evt: MouseEvent,
    parent: TaskRow
  ): void {
    evt.preventDefault();
    evt.stopPropagation();

    const menu = new Menu();
    this.activateContextMenu(menu);

    menu.addItem((item) => {
      item.setTitle("期限を削除");
      item.onClick(() => {
        void this.saveTaskPatch(
          parent,
          { dueDate: "" },
          { checkWorkload: false }
        );
      });
    });

    menu.addItem((item) => {
      item.setTitle("ノートを開く");
      item.onClick(() => {
        void this.host.openTaskItem(parent);
      });
    });

    menu.showAtMouseEvent(evt);
  }




























  private openEmptyCellMenu(
    evt: MouseEvent,
    parent: TaskRow,
    date: string
  ): void {
    evt.preventDefault();
    evt.stopPropagation();

    const clickedDate = snapForward(date, this.holidaySet);

    const menu = new Menu();
    this.activateContextMenu(menu);


    menu.addItem((item) => {
      item.setTitle(`新規サブタスクを ${clickedDate} に作成`);
      item.onClick(() => {
        this.host.openTextPrompt(
          "新規サブタスク",
          "サブタスク名",
          "",
          (value) => {
            void this.createSubtaskAtDate(parent, value, clickedDate);
          }
        );
      });
    });

    menu.addSeparator();


    const unplaced = parent.subtasks
      ? Array.from(parent.subtasks.values()).filter(
          (t) => !t.plannedStartDate && !t.plannedEndDate
        )
      : []; // database order, no sort (Map preserves insertion order)
    if (unplaced.length === 0) {
      menu.addItem((item) => {
        item.setTitle("未配置サブタスクはありません");
        item.setDisabled(true);
      });
    } else {
      const shown = unplaced.slice(0, 20);
      for (const sub of shown) {
        menu.addItem((item) => {
          item.setTitle(`未配置を配置: ${sub.displayName || sub.title}`);
          item.onClick(() => {
            void this.placeUnplacedSubtask(sub, clickedDate);
          });
        });
      }
      if (unplaced.length > 20) {
        menu.addItem((item) => {
          item.setTitle(
            `ほか ${unplaced.length - 20} 件はフィルター等で絞り込んでください`
          );
          item.setDisabled(true);
        });
      }
    }

    menu.addSeparator();


    menu.addItem((item) => {
      item.setTitle(`親タスク期限を ${clickedDate} に設定`);
      item.onClick(() => {
        void this.saveTaskPatch(
          parent,
          { dueDate: clickedDate },
          { checkWorkload: false }
        );
      });
    });
    if (parent.dueDate) {
      // only shown when a due date is already set.
      menu.addItem((item) => {
        item.setTitle("親タスク期限を削除");
        item.onClick(() => {
          void this.saveTaskPatch(
            parent,
            { dueDate: "" },
            { checkWorkload: false }
          );
        });
      });
    }

    menu.addSeparator();


    menu.addItem((item) => {
      item.setTitle("これ以降を纏めて移動");
      item.onClick(() => {
        this.startBulkMoveDrag(parent, clickedDate, evt.clientX);
      });
    });

    menu.showAtMouseEvent(evt); // Show the menu at the pointer position.
  }












  private async createSubtaskAtDate(
    parent: TaskRow,
    rawName: string,
    dateStr: string
  ): Promise<void> {
    const name = rawName.trim();
    if (name === "") {
      return;
    }
    try {
      await this.host.addSubtaskWithPlan(parent, name, dateStr);
    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to create subtask",
        err
      );

      new Notice(
        "ガント操作の保存に失敗しました。詳細は console を確認してください。"
      );
    }
    await this.render();
  }










  private async placeUnplacedSubtask(
    sub: TaskRow,
    dateStr: string
  ): Promise<void> {
    await this.saveTaskPatch(
      sub,
      { plannedStartDate: dateStr, plannedEndDate: dateStr },
      { checkWorkload: false }
    );
  }





  /**
 *
 * Finds the first subtask whose plannedStartDate is on or after the
 * clicked empty-cell date, using Bulk-Move's start, end, and displayName
 * sort order. This provides a concrete anchor key for the bulk-move
 * selection. It returns undefined when no subtask qualifies, which
 * startBulkMoveDrag treats as having no anchor.
 */
  private findBulkMoveAnchor(
    parent: TaskRow,
    pivotDate: string
  ): TaskRow | undefined {
    const subtasks = parent.subtasks
      ? Array.from(parent.subtasks.values())
      : [];
    return sortForBulkMove(subtasks).find(
      (t) =>
        typeof t.plannedStartDate === "string" &&
        t.plannedStartDate !== "" &&
        t.plannedStartDate >= pivotDate
    );
  }




















  private startBulkMoveDrag(
    parent: TaskRow,
    pivotDate: string,
    startClientX: number
  ): void {
    const anchor = this.findBulkMoveAnchor(parent, pivotDate);
    const anchorKey = anchor?.id ?? ""; // "" never matches a real task.id
    const anchorStart = anchor?.plannedStartDate ?? pivotDate;

    this.bulkMoveState = {
      parentKey: parent.id,
      anchorKey,
      anchorStart,
    };

    const targetKeys = getBulkMoveKeysForParent(parent, anchorKey);
    if (targetKeys.size === 0) {
      return; // mode stays active, drag is a no-op
    }
    const subtasks = parent.subtasks
      ? Array.from(parent.subtasks.values())
      : [];
    const targets = subtasks.filter((t) => targetKeys.has(t.id));

    const barEls = targets
      .map((task) => this.barElsByTaskId.get(task.id))
      .filter((el): el is HTMLElement => el !== undefined);
    const originalLefts = barEls.map((el) =>
      parseFloat(el.style.left || "0")
    );

    const dayWidth = this.dayWidth;
    let movedPastThreshold = false;
    const anchorEl = this.barElsByTaskId.get(anchorKey);

    barEls.forEach((el) => {
      el.classList.add("is-dragging");
      el.classList.add(
        el === anchorEl
          ? "is-bulk-move-anchor"
          : "is-bulk-move-follower"
      );
    });

    const onMove = (moveEvt: PointerEvent): void => {
      const dxPx = moveEvt.clientX - startClientX;
      if (
        !movedPastThreshold &&
        Math.abs(dxPx) >= DRAG_TOOLTIP_THRESHOLD_PX
      ) {
        movedPastThreshold = true;
      }
      // Preview every target bar together.
      barEls.forEach((el, i) => {
        el.style.left = `${originalLefts[i] + dxPx}px`;
      });

      if (!movedPastThreshold) {
        return;
      }
      const dayDelta = pixelDeltaToDayDelta(dxPx, dayWidth);
      this.showDragTooltip(
        formatBulkMoveDragTooltip(anchorStart, addDays(anchorStart, dayDelta)),
        moveEvt.clientX,
        moveEvt.clientY
      );
    };

    const onUp = (upEvt: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      barEls.forEach((el, i) => {
        el.classList.remove("is-dragging");
        el.classList.remove("is-bulk-move-anchor", "is-bulk-move-follower");
        el.style.left = `${originalLefts[i]}px`;
      });
      this.hideDragTooltip();
      this.armRichPopoverSuppress();

      const dxPx = upEvt.clientX - startClientX;
      const shiftDays = pixelDeltaToDayDelta(dxPx, dayWidth);
      if (shiftDays === 0) {
        return;
      }
      void this.finishBulkMoveDrag(targets, shiftDays);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    this.dragState = {
      kind: "bulk-move",
      parentId: parent.id,
      targetIds: targets.map((t) => t.id),
    };
  }

  /**
 *
 * Saves the moved tasks through one updateTaskItemsBatch call, grouped by
 * parent file.
 */
  private async finishBulkMoveDrag(
    targets: TaskRow[],
    shiftDays: number
  ): Promise<void> {
    // ONE combined warning for the whole group, not per task.
    if (targets.some(hasWorkloadActual)) {
      const proceed = await this.host.confirmWorkloadShift(
        "この一括移動により作業記録がずれます。移動を実行しますか？"
      );
      if (!proceed) {
        return; // analog: nothing saved, screen unchanged
      }
    }


    // each target's own oldStart/newStart pair drives its own business-day
    // offset re-basing (falls back to the plain calendar-day
    // shiftDays whenever a target's plannedStartDate is missing/invalid).
    const commands: TaskUpdateCommand[] = targets.map((task) => {
      const newStart = addDays(task.plannedStartDate ?? "", shiftDays);
      const newEnd = addDays(task.plannedEndDate ?? "", shiftDays);
      const workingDayCalendar = {
        oldStart: task.plannedStartDate,
        newStart,
        holidaySet: this.holidaySet,
      };
      return {
        row: task,
        patch: {
          plannedStartDate: newStart,
          plannedEndDate: newEnd,

          // every caller — Bulk-Move's own start/end shift stays a uniform

          // markers now relocate via the corrected snap/relative-position/
          // clamp algorithm instead of a blind uniform shift.
          ganttMarkers: shiftMarkers(task.ganttMarkers, shiftDays, this.holidaySet, {
            oldStart: task.plannedStartDate ?? "",
            newStart,
            newEnd,
          }),
          workloadPlan: shiftWorkloadMap(
            task.workloadPlan,
            shiftDays,
            workingDayCalendar
          ),
          workloadActual: shiftWorkloadMap(
            task.workloadActual,
            shiftDays,
            workingDayCalendar
          ),
        },
      };
    });


    this.closeRichPopover();
    this.closeWorkloadPopup();

    try {
      await this.host.updateTaskItemsBatch(commands);
    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to save Bulk-Move",
        err
      );

      new Notice(
        "ガント操作の保存に失敗しました。詳細は console を確認してください。"
      );
    }
    await this.render(); // analog
  }





  /**
 * Arms the popover-suppression window. Defaults to 450ms after a drag;
 * context menus use the longer 1200ms interval.
 */
  private armRichPopoverSuppress(ms: number = RICH_POPOVER_SUPPRESS_MS): void {
    this.richPopoverSuppressUntil = Date.now() + ms;
  }

  /**
 * Shows a popover for a bar or parent cell unless the post-drag suppression
 * window is active. Re-entering a trigger cancels a pending hide, and an
 * already-open popover for the same task stays open.
 */
  private onRichPopoverTrigger(
    anchor: RichPopoverAnchor,
    evt: MouseEvent
  ): void {
    if (Date.now() < this.richPopoverSuppressUntil) {
      return;
    }
    this.richPopoverPointerOutside = false;
    this.clearRichPopoverHideTimer();
    if (
      this.richPopoverEl !== undefined &&
      this.richPopoverTask === anchor.task
    ) {
      return; // already open for this exact task
    }
    if (!anchor.anchorEl.isConnected) {
      return; // never anchor to a detached element
    }
    this.closeRichPopover(); // tear down a different task's popover first
    this.openRichPopover(anchor, evt);
  }

  /** Builds, populates, wires and positions the popover element. */
  private openRichPopover(
    anchor: RichPopoverAnchor,
    evt: MouseEvent
  ): void {
    const el = document.createElement("div");
    el.classList.add("task-gantt-rich-popover", "vg-surface", "vg-popover");
    if (anchor.kind === "subtask") {
      el.classList.add("is-subtask");
      this.buildSubtaskPopoverContent(
        el,
        anchor.task,
        anchor.barStart,
        anchor.barEnd
      );
    } else {
      el.classList.add("is-parent");
      this.buildParentPopoverContent(el, anchor.task);
    }

    // the popover itself is part of the "trigger area"
    // — hovering it cancels a pending hide timer (same effect as re-entering
    // the bar/row).
    el.addEventListener("mouseover", () => {
      this.richPopoverPointerOutside = false;
      this.clearRichPopoverHideTimer();
    });
    el.addEventListener("mouseleave", () => {
      this.richPopoverPointerOutside = true;
      this.scheduleRichPopoverHide();
    });
    // passive:false — onRichPopoverWheel calls preventDefault (its

    el.addEventListener(
      "wheel",
      (wheelEvt: WheelEvent) => {
        this.onRichPopoverWheel(wheelEvt);
      },
      { passive: false }
    );

    // Appended to document.body, NOT containerEl/wrapEl: real-machine
    // testing found `.workspace-leaf.mod-active { contain: strict }`
    // (Obsidian's own base CSS) silently establishes a new containing block
    // for `position: fixed` descendants, offsetting positionRichPopover's
    // viewport-relative math (getBoundingClientRect/window.innerWidth) by
    // the leaf's own on-screen position instead of landing at the true
    // viewport origin — escaping to document.body avoids that ancestor
    // entirely (same idiom Obsidian's own Menu/Tooltip use). Its lifecycle
    // is still owned exclusively by closeRichPopover — wrapEl.empty on
    // re-render must not orphan it, and since it is no longer a descendant
    // of containerEl, onClose below explicitly closes it on view teardown
    // too (a containerEl child would have been removed for free instead).
    document.body.appendChild(el);
    this.richPopoverEl = el;
    this.richPopoverAnchorEl = anchor.anchorEl;
    this.richPopoverTask = anchor.task;
    this.richPopoverMouseX =
      typeof evt.clientX === "number" ? evt.clientX : undefined;
    this.positionRichPopover(this.richPopoverMouseX);
  }











  private onRichPopoverWheel(evt: WheelEvent): void {
    evt.preventDefault();
    this.wrapEl.scrollTop += typeof evt.deltaY === "number" ? evt.deltaY : 0;
    this.wrapEl.scrollLeft +=
      typeof evt.deltaX === "number" ? evt.deltaX : 0;
    this.clearRichPopoverWorkloadPopups();
    this.closeRichPopover();
  }










  private clearRichPopoverWorkloadPopups(): void {
    const el = this.richPopoverEl;
    if (el === undefined) {
      return;
    }
    for (const child of Array.from(el.children)) {
      if (child.classList.contains("task-gantt-workload-popup")) {
        child.remove();
      }
    }
  }

  /**
 *
 * Starts (or restarts, when called again) the 220ms hide debounce. Any
 * re-entry — bar/row mouseover, popover mouseover — cancels it via
 * clearRichPopoverHideTimer before it fires.
 */
  private scheduleRichPopoverHide(): void {
    this.clearRichPopoverHideTimer();
    this.richPopoverHideTimer = setTimeout(() => {
      this.richPopoverHideTimer = undefined;


      if (this.richPopoverInteractionActive) {
        return;
      }
      this.closeRichPopover();
    }, RICH_POPOVER_HIDE_DELAY_MS);
  }

  private clearRichPopoverHideTimer(): void {
    if (this.richPopoverHideTimer !== undefined) {
      clearTimeout(this.richPopoverHideTimer);
      this.richPopoverHideTimer = undefined;
    }
  }



  /**
 * Keeps a pending mouse-leave hide from closing a control while it is
 * focused or receiving input. Once focus ends outside the trigger area,
 * the normal hide debounce is restored.
 */
  private bindRichPopoverInteraction(element: HTMLElement): void {
    const keepOpen = (): void => {
      this.richPopoverInteractionActive = true;
      this.clearRichPopoverHideTimer();
    };
    element.addEventListener("focus", keepOpen);
    element.addEventListener("focusin", keepOpen);
    element.addEventListener("input", keepOpen);
    element.addEventListener("blur", () => {
      this.richPopoverInteractionActive = false;
      if (this.richPopoverPointerOutside) {
        this.scheduleRichPopoverHide();
      }
    });
  }


  /**
 * Closes the popover immediately (no debounce): removes the element and
 * drops every anchor/task reference. Idempotent — safe from the
 * scroll handler, wheel, render-triggering saves and the
 * hide timer alike.
 */
  private closeRichPopover(): void {
    this.clearRichPopoverHideTimer();
    this.richPopoverInteractionActive = false;
    this.richPopoverPointerOutside = false;
    if (this.richPopoverEl !== undefined) {
      this.richPopoverEl.remove();
    }
    this.richPopoverEl = undefined;
    this.richPopoverAnchorEl = undefined;
    this.richPopoverTask = undefined;
    this.richPopoverMouseX = undefined;
  }

  /**
 * Applies computeRichPopoverPosition using the anchor's real bounding
 * rectangle, measured popover size, and window dimensions. A detached anchor
 * closes the popover; positioning failures are logged without crashing the
 * view.
 */
  private positionRichPopover(mouseX?: number): void {
    const el = this.richPopoverEl;
    const anchor = this.richPopoverAnchorEl;
    if (el === undefined || anchor === undefined) {
      return;
    }
    // an external re-render may have removed the anchor from
    // the DOM — close gracefully instead of positioning against a stale rect.
    if (!anchor.isConnected) {
      this.closeRichPopover();
      return;
    }
    try {
      const anchorRect = anchor.getBoundingClientRect();
      const width = this.richPopoverWidth();
      const viewportWidth = Number(window.innerWidth) || 0;
      const viewportHeight = Number(window.innerHeight) || 0;
      // Measure the final layout, including wrapping and the scroll limit.
      el.style.width = `${width}px`;
      el.style.maxHeight = `${Math.max(
        120,
        viewportHeight - RICH_POPOVER_VIEWPORT_MARGIN_PX * 2
      )}px`;
      el.style.overflowY = "auto";
      // offsetHeight rounds to an integer and can undercount the border box.
      const measured = el.getBoundingClientRect().height;
      // Use the measured content height with a minimum of 180px.
      const height = Math.max(
        RICH_POPOVER_MIN_HEIGHT_PX,
        typeof measured === "number" ? measured : 0
      );
      const pos: RichPopoverPosition = el.classList.contains("is-parent")
        ? this.computeParentRichPopoverPosition(
            anchorRect,
            width,
            height,
            viewportWidth,
            viewportHeight,
            mouseX
          )
        : computeRichPopoverPosition(
            anchorRect,
            width,
            height,
            viewportWidth,
            viewportHeight,
            RICH_POPOVER_GAP_PX,
            this.getWorkloadPopupRect(),
            mouseX
          );
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
      el.setAttribute("data-side", pos.side);
    } catch (err) {
      // positioning is best-effort and must never throw.

      this.host.logger.warn(
        "TaskGanttView",
        "rich popover positioning failed",
        err
      );

    }
  }

  /** Prefer the row's right edge, falling back to a viewport-fitting placement. */
  private computeParentRichPopoverPosition(
    anchorRect: RichPopoverRect,
    width: number,
    height: number,
    viewportWidth: number,
    viewportHeight: number,
    mouseX?: number
  ): RichPopoverPosition {
    const margin = RICH_POPOVER_VIEWPORT_MARGIN_PX;
    const clampTop = (top: number): number =>
      Math.max(margin, Math.min(top, viewportHeight - height - margin));
    const rightLeft = anchorRect.right + RICH_POPOVER_GAP_PX;
    if (rightLeft + width <= viewportWidth - margin) {
      return {
        left: rightLeft,
        top: clampTop(anchorRect.top),
        side: "right",
      };
    }

    const fallback = computeRichPopoverPosition(
      anchorRect,
      width,
      height,
      viewportWidth,
      viewportHeight,
      RICH_POPOVER_GAP_PX,
      this.getWorkloadPopupRect(),
      mouseX
    );
    return {
      ...fallback,
      left: Math.max(
        margin,
        Math.min(fallback.left, viewportWidth - width - margin)
      ),
      top: clampTop(fallback.top),
    };
  }

  /**
   * Uses viewport width minus 24px margins, clamped to [260, 440]px.
   * When the viewport is unavailable or zero, returns the 260px floor.
   */
  private richPopoverWidth(): number {
    const available =
      (Number(window.innerWidth) || 0) - RICH_POPOVER_VIEWPORT_MARGIN_PX * 2;
    return Math.max(
      RICH_POPOVER_MIN_WIDTH_PX,
      Math.min(RICH_POPOVER_MAX_WIDTH_PX, available)
    );
  }















  private getWorkloadPopupRect(): RichPopoverRect | undefined {
    const el = this.workloadPopoverState?.el;
    if (el === undefined || !el.isConnected) {
      return undefined;
    }
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }






  /**
 *
 * Builds, populates and positions the bar-level workload popup. The
 * teardown/rebuild and hide-timer lifecycle is shared with event popups so
 * either trigger always owns the same single popup instance.
 */
  private showWorkloadPopupForBar(task: TaskRow, barEl: HTMLElement): void {
    if (!this.host.settings.ganttFeatureWorkloadEnabled) {
      return;
    }
    this.closeWorkloadPopup(); // always rebuild fresh.

    const { dates, graphLeft } = this.computeWorkloadPopupLayout(task, barEl);
    this.buildWorkloadPopup(
      task,
      barEl,
      dates,
      graphLeft,
      getWorkloadTaskKey(task),
      () => this.persistWorkload(task)
    );

  }


  /**
 *
 * Opens the same workload popup system for a fixed-row event. Events have
 * one date only, so their graph always receives exactly one cell and its
 * day-column left edge is derived from the chip's rendered center.
 */
  private showWorkloadPopupForEvent(
    event: GanttEvent,
    chipEl: HTMLElement
  ): void {
    if (!this.host.settings.ganttFeatureWorkloadEnabled) {
      return;
    }
    this.closeWorkloadPopup();
    let graphLeft = 0;
    try {
      const rect = chipEl.getBoundingClientRect();
      graphLeft = rect.left + (rect.width - this.dayWidth) / 2;
    } catch (err) {
      this.host.logger.warn(
        "TaskGanttView",
        "event workload popup anchor measurement failed",
        err
      );
    }
    this.buildWorkloadPopup(
      event,
      chipEl,
      [event.date],
      graphLeft,
      event.key,
      () => this.persistEventWorkload(event)
    );
  }



  /**
 *
 * Builds the shared DOM and interaction lifecycle for a task or event
 * workload popup. `persist` is an explicit strategy because task rows save
 * through note updates while events save through plugin settings.
 */
  private buildWorkloadPopup(
    task: WorkloadHost,
    anchorEl: HTMLElement,
    popupDates: string[],
    graphLeft: number,
    modeKey: string,
    persist: () => Promise<void>
  ): void {
    const el = document.createElement("div");
    el.classList.add("task-gantt-workload-popover", "vg-surface", "vg-popover");
    el.style.boxSizing = "border-box";

    const header = document.createElement("div");
    header.classList.add("task-gantt-workload-popover-header");
    const toggle = document.createElement("button");
    toggle.classList.add("task-gantt-workload-popover-mode-toggle");
    header.appendChild(toggle);
    el.appendChild(header);

    const body = document.createElement("div");
    body.classList.add("task-gantt-workload-popover-body");
    el.appendChild(body);

    // Add Y-axis labels from 0 to maxHours, top to bottom, matching the
    // direction used by hoursFromPointer. Fractional maxHours values still
    // produce integer ticks up to their floor; maxHours itself is not a tick.

    // The fixed WORKLOAD_POPOVER_GRAPH_HEIGHT_PX axis has room for roughly
    // one label per 10px, so a 1-hour step (the norm at the default
    // maxHours=7) only fits up to ~8 labels. getMaxHours allows up to 24,
    // which would need 25 labels and overlap/clip at a fixed 1-hour step —
    // widen the step so the label count always fits, keeping every tick a
    // whole number and always including both 0 and the floor of maxHours.
    const axis = document.createElement("div");
    axis.classList.add("task-gantt-workload-popover-axis");
    const maxHours = getMaxHours(this.host.settings);
    const topTick = Math.floor(maxHours);
    const maxAxisLabels = Math.max(
      1,
      Math.floor(WORKLOAD_POPOVER_GRAPH_HEIGHT_PX / WORKLOAD_POPOVER_AXIS_LABEL_PX)
    );
    // The loop below only emits ticks ABOVE zero (h > 0) — zero itself is
    // always appended separately afterward — so the step must be sized
    // against a budget of (maxAxisLabels - 1) nonzero slots, not
    // maxAxisLabels itself, or the total rendered count (loop + the
    // always-added zero) can exceed the available label budget by one.
    const tickStep = Math.max(
      1,
      Math.ceil(topTick / Math.max(1, maxAxisLabels - 1))
    );
    for (let h = topTick; h > 0; h -= tickStep) {
      const label = document.createElement("div");
      label.classList.add("task-gantt-workload-popover-axis-label");
      label.textContent = String(h);
      axis.appendChild(label);
    }
    const zeroLabel = document.createElement("div");
    zeroLabel.classList.add("task-gantt-workload-popover-axis-label");
    zeroLabel.textContent = "0";
    axis.appendChild(zeroLabel);
    body.appendChild(axis);

    const graphScroll = document.createElement("div");
    graphScroll.classList.add("task-gantt-workload-popover-graph-scroll");
    const graph = document.createElement("div");
    graph.classList.add(
      "task-gantt-workload-graph",
      "task-gantt-workload-popover-graph"
    );
    graph.style.height = `${WORKLOAD_POPOVER_GRAPH_HEIGHT_PX}px`;
    graph.style.width = `${Math.max(
      this.dayWidth,
      popupDates.length * this.dayWidth
    )}px`;
    graphScroll.appendChild(graph);
    body.appendChild(graphScroll);

    const cellEls = new Map<
      string,
      {
        planFill: HTMLElement;
        activeFill: HTMLElement;
        valueBadge: HTMLElement;
      }
    >();
    // Cells use a 0-based local index within the popup's date window, which
    // is the coordinate space consumed by dateFromPointer.
    popupDates.forEach((date, index) => {
      const cell = document.createElement("div");
      cell.classList.add("task-gantt-workload-popover-cell");
      const { isWeekend, isHoliday } = this.dateClasses(date);
      if (isWeekend) {
        cell.classList.add("is-weekend");
      }
      if (isWeekend || isHoliday) {
        cell.classList.add("is-non-working");
      }
      cell.setAttribute("data-date", date);
      cell.style.left = `${index * this.dayWidth}px`;
      cell.style.width = `${this.dayWidth}px`;
      cell.style.height = `${WORKLOAD_POPOVER_GRAPH_HEIGHT_PX}px`;
      cell.style.bottom = "0";

      const planFill = document.createElement("div");
      planFill.classList.add("task-gantt-workload-plan-fill");
      const activeFill = document.createElement("div");
      activeFill.classList.add("task-gantt-workload-fill");
      const valueBadge = document.createElement("div");
      valueBadge.classList.add("task-gantt-workload-value-badge");

      cell.appendChild(planFill);
      cell.appendChild(activeFill);
      cell.appendChild(valueBadge);
      graph.appendChild(cell);
      cellEls.set(date, { planFill, activeFill, valueBadge });
    });

    graph.addEventListener("pointerdown", (evt: PointerEvent) => {
      this.startWorkloadPaint(evt, graph, task, { modeKey, persist });
    });

    el.addEventListener("mouseenter", () => {
      this.clearWorkloadPopoverHideTimer();
    });
    el.addEventListener("mouseleave", () => {
      this.scheduleHideWorkloadPopup();
    });

    document.body.appendChild(el);
    this.workloadPopoverState = {
      el,
      task,
      modeKey,
      anchorEl,
      chartEl: graph,
      dates: popupDates,
      graphLeft,
      cellEls,
      persist,
    };

    const applyMode = (): void => {
      const mode = this.workloadModeStore.get(modeKey)?.mode ?? "plan";
      toggle.textContent = mode === "plan" ? "計画時間" : "実績時間";
      el.classList.toggle("is-actual", mode === "actual");
      for (const date of popupDates) {
        this.refreshWorkloadPopoverCell(date);
      }
    };
    const toggleMode = (): void => {
      const current = this.workloadModeStore.get(modeKey)?.mode ?? "plan";
      this.workloadModeStore.set(modeKey, {
        mode: current === "plan" ? "actual" : "plan",
      });
      applyMode();
    };
    el.classList.add("is-visible");
    applyMode();
    toggle.addEventListener("click", () => {
      toggleMode(); // title button toggles the paint-target mode.
    });
    el.addEventListener("contextmenu", (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      toggleMode();
    });

    this.positionWorkloadPopup(anchorEl);
    // The rich popover opens before this popup exists (mouseover precedes
    // mouseenter), so re-place it now that the workload rect is known.
    if (this.richPopoverEl !== undefined) {
      this.positionRichPopover(this.richPopoverMouseX);
    }
  }
















  private computeWorkloadPopupLayout(
    task: TaskRow,
    barEl: HTMLElement
  ): { dates: string[]; graphLeft: number } {
    const start = task.plannedStartDate;
    const end = task.plannedEndDate ?? start;
    const taskDates = this.dates.filter(
      (date) =>
        (start === undefined || date >= start) &&
        (end === undefined || date <= end)
    );
    if (taskDates.length === 0) {
      // When no task dates are available, use the full chart range without
      // viewport clipping.
      const fallback = this.dates.slice();
      try {
        return { dates: fallback, graphLeft: barEl.getBoundingClientRect().left };
      } catch {
        return { dates: fallback, graphLeft: 0 };
      }
    }

    try {
      const barRect = barEl.getBoundingClientRect();
      const wrapRect = this.wrapEl.getBoundingClientRect();
      if (barRect.width <= 0 || wrapRect.width <= 0 || this.dayWidth <= 0) {
        return { dates: taskDates, graphLeft: barRect.left };
      }
      const graphMinLeft = Math.max(
        WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX,
        wrapRect.left + PARENT_COL_WIDTH + WORKLOAD_POPOVER_AXIS_GUARD_PX
      );
      const viewportWidth = Number(window.innerWidth) || wrapRect.right;
      // Reserve space for the graph axis and popover chrome so the full
      // popover fits without shifting away from graphLeft and misaligning the
      // visible date cells.

      const visibleRight = Math.min(
        viewportWidth -
          WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX -
          WORKLOAD_POPOVER_AXIS_GUARD_PX -
          WORKLOAD_POPOVER_CHROME_TRAILING_PX,
        wrapRect.right,
        barRect.right // long-subtask cap: never past the bar's own right edge
      );
      const rawStartIndex = Math.ceil(
        Math.max(0, graphMinLeft - barRect.left) / this.dayWidth
      );
      const startIndex = Math.max(
        0,
        Math.min(taskDates.length - 1, rawStartIndex)
      );
      let graphLeft = barRect.left + startIndex * this.dayWidth;
      if (graphLeft < graphMinLeft) {
        graphLeft = graphMinLeft;
      }
      // The popup's CSS min-width can make it wider than a short bar's graph
      // needs. Cap graphLeft so the box fits the viewport and remains aligned
      // with its date cells. If even the minimum width cannot fit
      // (graphMaxLeft < graphMinLeft), use the best-effort viewport clamp.
      const minBoxGraphWidth = Math.max(
        this.dayWidth,
        WORKLOAD_POPOVER_MIN_WIDTH_PX -
          WORKLOAD_POPOVER_AXIS_GUARD_PX -
          WORKLOAD_POPOVER_CHROME_TRAILING_PX
      );
      const graphMaxLeft =
        viewportWidth -
        WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX -
        WORKLOAD_POPOVER_AXIS_GUARD_PX -
        WORKLOAD_POPOVER_CHROME_TRAILING_PX -
        minBoxGraphWidth;
      if (graphLeft > graphMaxLeft && graphMaxLeft >= graphMinLeft) {
        graphLeft = graphMaxLeft;
      }
      const visibleDays = Math.max(
        1,
        Math.ceil(
          Math.max(this.dayWidth, visibleRight - graphLeft) / this.dayWidth
        )
      );
      const endIndex = Math.min(
        taskDates.length - 1,
        startIndex + visibleDays - 1
      );
      const dates = taskDates.slice(startIndex, endIndex + 1);
      return {
        dates: dates.length > 0 ? dates : taskDates.slice(startIndex, startIndex + 1),
        graphLeft,
      };
    } catch {
      // Layout reads are best-effort; fall back to the full per-task range
      // anchored at the bar's own (still valid) left edge.
      return { dates: taskDates, graphLeft: barEl.getBoundingClientRect().left };
    }
  }














  private refreshWorkloadPopoverCell(date: string): void {
    const state = this.workloadPopoverState;
    if (state === undefined) {
      return;
    }
    const segs = state.cellEls.get(date);
    if (segs === undefined) {
      return;
    }
    const { plan, actual } = dayValues(state.task, date);
    const maxHours = getMaxHours(this.host.settings);
    const ratioFloor = Math.max(0.5, maxHours);
    const planRatio = Math.max(0, Math.min(1, plan / ratioFloor));
    const actualRatio = Math.max(0, Math.min(1, actual / ratioFloor));

    const mode =
      this.workloadModeStore.get(state.modeKey)?.mode ??
      "plan";

    const activeHours = mode === "actual" ? actual : plan;
    const activeRatio = mode === "actual" ? actualRatio : planRatio;

    segs.planFill.style.height = `${planRatio * 100}%`;
    segs.activeFill.style.height = `${activeRatio * 100}%`;
    segs.activeFill.style.background =
      mode === "actual"
        ? ""
        : workloadPlannedFillColor(plan, maxHours);
    segs.valueBadge.textContent = formatWorkloadBadgeHours(activeHours);
  }

























  private positionWorkloadPopup(anchorEl: HTMLElement): void {
    const state = this.workloadPopoverState;
    if (state === undefined) {
      return;
    }
    const el = state.el;
    if (!anchorEl.isConnected) {
      this.closeWorkloadPopup(); // style graceful close, same principle as positionRichPopover.
      return;
    }
    try {
      const anchorRect = anchorEl.getBoundingClientRect();
      const measured = el.offsetHeight;
      const height = Math.max(
        WORKLOAD_POPOVER_MIN_HEIGHT_PX,
        typeof measured === "number" ? measured : 0
      );
      const width = Math.max(
        200,
        typeof el.offsetWidth === "number" ? el.offsetWidth : 0
      );
      const aboveTop = anchorRect.top - WORKLOAD_POPOVER_GAP_PX - height;
      if (aboveTop >= 0) {
        el.style.top = `${aboveTop}px`;
        el.setAttribute("data-side", "above");
      } else {
        el.style.top = `${anchorRect.bottom + WORKLOAD_POPOVER_GAP_PX}px`;
        el.setAttribute("data-side", "below");
      }
      const viewportWidth = Number(window.innerWidth) || 0;
      const maxLeft =
        viewportWidth > 0
          ? Math.max(
              WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX,
              viewportWidth - width - WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX
            )
          : anchorRect.left;
      // The graph column sits inside `el`, offset by its border and padding
      // plus the axis-label grid column in styles.css
      // (`.task-gantt-workload-popover-body`). Measure the rendered elements
      // rather than using a hardcoded constant, so the offset always
      // tracks that CSS exactly and self-corrects if it changes — the delta
      // between two nested rects is independent of el's own current
      // position, so this is valid even before el.style.left is set.
      // `+ clientLeft` corrects for chartEl's OWN left border: its
      // absolutely-positioned cell children (`left: 0`) sit at chartEl's
      // PADDING edge, one border-width inside where getBoundingClientRect's
      // `left` (the border/outer edge) reports — without this the whole
      // graph rendered 1px right of every date it's meant to overlap

      const graphOffsetFromEl =
        state.chartEl.getBoundingClientRect().left +
        state.chartEl.clientLeft -
        el.getBoundingClientRect().left;
      const targetLeft = state.graphLeft - graphOffsetFromEl;
      el.style.left = `${Math.max(
        WORKLOAD_POPOVER_VIEWPORT_MARGIN_PX,
        Math.min(targetLeft, maxLeft)
      )}px`;
    } catch (err) {
      // Positioning is best-effort and must never throw, mirroring
      // positionRichPopover's own try/catch.

      this.host.logger.warn(
        "TaskGanttView",
        "workload popup positioning failed",
        err
      );

    }
  }

  /**
 *
 * Starts (or restarts) the 160ms hide debounce — independent timer from
 * the rich popover's own `scheduleRichPopoverHide` (220ms), same idiom.
 */
  private scheduleHideWorkloadPopup(): void {
    this.clearWorkloadPopoverHideTimer();
    this.workloadPopoverHideTimer = setTimeout(() => {
      this.workloadPopoverHideTimer = undefined;
      this.closeWorkloadPopup();
    }, WORKLOAD_POPOVER_HIDE_DELAY_MS);
  }

  private clearWorkloadPopoverHideTimer(): void {
    if (this.workloadPopoverHideTimer !== undefined) {
      clearTimeout(this.workloadPopoverHideTimer);
      this.workloadPopoverHideTimer = undefined;
    }
  }

  /**
 * Closes the workload popup immediately (no debounce): removes the
 * element and drops the stored state. Idempotent, mirrors
 * closeRichPopover's shape.
 */
  private closeWorkloadPopup(): void {
    this.clearWorkloadPopoverHideTimer();
    if (this.workloadPopoverState !== undefined) {
      this.workloadPopoverState.el.remove();
    }
    this.workloadPopoverState = undefined;
  }

























  private startWorkloadPaint(
    evt: PointerEvent,
    chartEl: HTMLElement,
    task: WorkloadHost,
    strategy: {
      modeKey: string;
      persist: () => Promise<void>;
    }
  ): void {
    if (evt.button !== 0) {
      return; // left button only.
    }
    evt.preventDefault();
    evt.stopPropagation();
    try {
      chartEl.setPointerCapture(evt.pointerId); // existing helper pattern
    } catch (err) {
      // capture failure is tolerated — window-level
      // pointermove/pointerup/pointercancel still track the gesture either
      // way, this is best-effort only.

      this.host.logger.warn(
        "TaskGanttView",
        "workload paint pointer capture failed",
        err
      );

    }


    const mode =
      this.workloadModeStore.get(strategy.modeKey)?.mode ?? "plan";
    const sessionPointerId = evt.pointerId;
    this.workloadPaintState = {
      chartEl,
      task,
      modeKey: strategy.modeKey,
      mode,
      pointerId: sessionPointerId,
      persist: strategy.persist,
    };

    this.host.logger.info?.("TaskGanttView", "workload paint started", {
      taskId: strategy.modeKey,
    });



    const paintAt = (paintEvt: PointerEvent): void => {
      // only update when BOTH (a) this event's own
      // pointerId matches the pointer THIS session started with — window is
      // a single shared event target, so a second concurrent session on the
      // same chartEl would otherwise have its pointer's moves double-handled
      // by both sessions' closures — and (b) this session's chartEl still
      // matches the CURRENTLY active paint state (guards a stale/superseded
      // session's own late events from touching the map after a newer
      // session has taken over).
      if (paintEvt.pointerId !== sessionPointerId) {
        return;
      }
      if (this.workloadPaintState?.chartEl !== chartEl) {
        return;
      }
      this.paintWorkloadCell(chartEl, task, mode, paintEvt.clientX, paintEvt.clientY);
    };

    const onMove = (moveEvt: PointerEvent): void => {
      paintAt(moveEvt);
    };

    const onUp = (upEvt: PointerEvent): void => {
      if (upEvt.pointerId !== sessionPointerId) {
        return; // not this session's pointer — ignore, do not tear down.
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        chartEl.releasePointerCapture(sessionPointerId);
      } catch {
        // best-effort, mirrors the capture attempt above.
      }
      paintAt(upEvt); // Paint the final pointer position using the same clamp.
      if (this.workloadPaintState?.chartEl === chartEl) {
        this.workloadPaintState = undefined; // don't clobber a newer session.
      }
      void strategy.persist();
    };

    const onCancel = (cancelEvt: PointerEvent): void => {
      if (cancelEvt.pointerId !== sessionPointerId) {
        return; // not this session's pointer — ignore, do not tear down.
      }
      // clears WITHOUT committing — no persistWorkload call.
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        chartEl.releasePointerCapture(sessionPointerId);
      } catch {
        // best-effort
      }
      if (this.workloadPaintState?.chartEl === chartEl) {
        this.workloadPaintState = undefined;
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    paintAt(evt); // paint the cell under the initial pointerdown too.

  }























  private paintWorkloadCell(
    chartEl: HTMLElement,
    task: WorkloadHost,
    mode: WorkloadMode,
    clientX: number,
    clientY: number
  ): void {
    const state = this.workloadPopoverState;
    const dates = state?.chartEl === chartEl ? state.dates : [];
    if (dates.length === 0) {
      return;
    }
    // if pointer capture failed (best-effort, startWorkloadPaint)
    // and the popup has since closed (e.g. the 160ms mouseleave hide timer,
    // or a rebuild from re-triggering on another bar), chartEl is detached
    // and getBoundingClientRect returns an all-zero rect — painting would
    // otherwise silently resolve to dates[0]/0h and delete that entry.
    // Bail out instead so a stray late move/up cannot corrupt an unrelated
    // date.
    if (!chartEl.isConnected) {
      return;
    }
    const rect = chartEl.getBoundingClientRect();
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) {
      return;
    }
    const x = Math.max(0, Math.min(width, clientX - rect.left));
    const y = Math.max(0, Math.min(height, clientY - rect.top));
    const date = dateFromPointer(x, this.dayWidth, dates);
    const { isWeekend, isHoliday } = this.dateClasses(date);
    if (isWeekend || isHoliday) {
      return;
    }
    const maxHours = getMaxHours(this.host.settings);
    const rawHours = hoursFromPointer(y, height, maxHours);
    const clampedHours = Math.max(0, Math.min(maxHours, rawHours));
    const hours = roundHalfHour(clampedHours);
    setValue(task, date, mode, hours);
    this.refreshWorkloadPopoverCell(date);

  }





















  private async persistWorkload(task: TaskRow): Promise<void> {
    // normalizeWorkloadMap itself throws on a non-object input,
    // AND on an invalid calendar-date key or an hours value > 24
    // (task-patch.ts:31-33, 42-43) — this is genuinely reachable here: the
    // lenient LOAD path (parseWorkloadMap, note-format.ts) accepts hand-edited
    // dates/hours that the stricter persist-time normalizeWorkloadMap
    // rejects, so a task loaded with e.g. an invalid date or >24h entry can
    // throw on its very first paint commit. Both calls are inside the try
    // block (not just updateTaskItem) so that throw lands in the same
    // console-only failure path instead of becoming an unhandled rejection
    // that silently drops the whole paint session's edits.
    try {
      const patch: TaskPatch = {
        workloadPlan: normalizeWorkloadMap(task.workloadPlan ?? {}),
        workloadActual: normalizeWorkloadMap(task.workloadActual ?? {}),
      };
      await this.host.updateTaskItem(task, patch);

      this.host.logger.info?.("TaskGanttView", "workload paint committed", {
        taskId: task.id,
      });

    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to save workload paint",
        err
      );

    }

    await this.render();

  }


  /**
 *
 * Validates an event's in-memory workload maps with the same strict
 * persist-time normalizer used by subtasks, saves the settings object, and
 * refreshes the fixed event row. The event object is the live settings entry,
 * but the explicit update call keeps this path aligned with event CRUD.
 */
  private async persistEventWorkload(event: GanttEvent): Promise<void> {
    try {
      const workloadPlan = normalizeWorkloadMap(event.workloadPlan ?? {});
      const workloadActual = normalizeWorkloadMap(event.workloadActual ?? {});
      event.workloadPlan = workloadPlan;
      event.workloadActual = workloadActual;
      updateGanttEvent(this.host.settings, event.key, {
        workloadPlan: event.workloadPlan,
        workloadActual: event.workloadActual,
      });
      await this.host.saveSettings();
      this.host.logger.info?.("TaskGanttView", "event workload committed", {
        eventKey: event.key,
      });
    } catch (err) {
      this.host.logger.error(
        "TaskGanttView",
        "failed to save event workload paint",
        err
      );
    }
    await this.render();
  }






  /** One labelled field row; returns the field element to append values to. */
  private appendPopoverField(
    root: HTMLElement,
    className: string,
    labelText: string
  ): HTMLElement {
    const field = document.createElement("div");
    field.classList.add("task-gantt-popover-field", className);
    const label = document.createElement("span");
    label.classList.add("task-gantt-popover-label");
    label.textContent = labelText;
    field.appendChild(label);
    root.appendChild(field);
    return field;
  }

  /** Japanese chip label for a statusLabel (via DEFAULT_STATUSES). */
  private statusDisplayLabel(statusLabel: string): string {
    return DEFAULT_STATUSES[statusLabel as StatusLabel] ?? statusLabel;
  }

  /** M/D format for the popover's read-only date fields. */
  private formatMonthDay(dateStr: string): string {
    return moment(dateStr, "YYYY-MM-DD").format("M/D");
  }

  /**
 *
 * The Status dropdown shared by both popovers: exactly the five
 * DEFAULT_STATUSES options (value = StatusLabel key, text = Japanese
 * label). Changing it saves immediately through savePopoverPatch —
 * unconditional render, console-only errors, never a Notice.
 */
  private buildStatusSelect(task: TaskRow): HTMLElement {
    const select = document.createElement("select");
    select.classList.add("task-gantt-popover-status-select", "vg-input-sm");
    this.bindRichPopoverInteraction(select);
    for (const key of Object.keys(DEFAULT_STATUSES) as StatusLabel[]) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = DEFAULT_STATUSES[key];
      if (key === task.statusLabel) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.value = task.statusLabel;
    select.addEventListener("change", () => {
      void this.savePopoverPatch(task, { statusLabel: select.value });
    });
    return select;
  }


















  private buildCurrentStatusArea(task: TaskRow): HTMLElement {
    const area = document.createElement("textarea");
    area.classList.add("task-gantt-popover-current-status", "vg-input-sm");
    area.value = task.currentStatus ?? "";
    this.bindRichPopoverInteraction(area);

    let composing = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearDebounce = (): void => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    };

    const flush = (): void => {
      clearDebounce();
      if (composing) {
        return; // blocked mid-composition
      }
      void this.saveRichPopoverCurrentStatus(area, task);
    };

    area.addEventListener("compositionstart", () => {
      composing = true;
    });
    area.addEventListener("compositionend", () => {
      composing = false;
    });

    area.addEventListener("input", () => {
      if (composing) {
        return;
      }
      clearDebounce();
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (!composing) {
          void this.saveRichPopoverCurrentStatus(area, task);
        }
      }, RICH_POPOVER_CURRENT_STATUS_DEBOUNCE_MS);
    });

    area.addEventListener("blur", () => {
      // the flush is deferred via setTimeout(0) — the
      // blur handler itself must not save synchronously.
      setTimeout(() => flush(), 0);
    });

    area.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
        evt.preventDefault();
        flush();
        this.closeRichPopover();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        flush(); // commit, not cancel
        this.closeRichPopover();
      }
    });

    return area;
  }

  /**
 *
 * 「ノートを開く」 — opens the task's note through host.openTaskItem
 * (same NavigationService path as the Workbench view) and closes the
 * popover automatically.
 */
  private buildOpenNoteButton(task: TaskRow): HTMLElement {
    const button = document.createElement("button");
    button.classList.add("task-gantt-popover-open-note");
    button.textContent = "ノートを開く";
    this.bindRichPopoverInteraction(button);
    button.addEventListener("click", () => {
      this.closeRichPopover();
      void this.host.openTaskItem(task);
    });
    return button;
  }









  private buildCompletedToggleButton(task: TaskRow): HTMLElement {
    const button = document.createElement("button");
    button.classList.add("task-gantt-popover-toggle-completed");
    button.textContent = task.completed ? "未完了に戻す" : "完了とする";
    this.bindRichPopoverInteraction(button);
    button.addEventListener("click", () => {
      const patch: TaskPatch = task.completed
        ? { completed: false, statusLabel: "active" }
        : { completed: true, statusLabel: "done" };
      void this.savePopoverPatch(task, patch);
    });
    return button;
  }

  /**
 *
 *
 * Subtask popover: header (title + status chip + conditional priority
 * chip), read-only period (from the rendered bar's start/end) and
 * due-date fields, Status dropdown, read-only tags, Current Status
 * textarea, and the two action buttons.
 */
  private buildSubtaskPopoverContent(
    root: HTMLElement,
    task: TaskRow,
    barStart: string,
    barEnd: string
  ): void {
    // --- Header ---
    const header = document.createElement("div");
    header.classList.add("task-gantt-popover-header");
    const title = document.createElement("div");
    title.classList.add("task-gantt-popover-title");
    title.textContent = task.displayName || task.title;
    header.appendChild(title);

    const chips = document.createElement("div");
    chips.classList.add("task-gantt-popover-chips");
    header.appendChild(chips);

    const statusChip = document.createElement("span");
    statusChip.classList.add("task-gantt-popover-status-chip", "vg-chip");
    // Single source of truth for both the class and the text: `completed`
    // and `statusLabel` are two separate frontmatter fields that CAN
    // disagree on hand-edited/stale data (only save-time normalization
    // keeps them in sync, not load-time) — deriving both from the same
    // `effectiveStatus` here prevents a chip that shows "完了" text in a
    // non-green color (or vice versa) when they disagree.
    const effectiveStatus = task.completed ? "done" : task.statusLabel;
    // Frontmatter's statusLabel is cast to StatusLabel at parse time without
    // runtime validation (note-format.ts), so a hand-edited value can be an
    // arbitrary string — only add the status-{label} modifier when it is one
    // of the five known keys, to avoid classList.add throwing on a token
    // containing whitespace or other invalid characters.
    if (Object.prototype.hasOwnProperty.call(DEFAULT_STATUSES, effectiveStatus)) {
      statusChip.classList.add(`status-${effectiveStatus}`);
    }
    statusChip.textContent = task.completed
      ? "完了"
      : this.statusDisplayLabel(task.statusLabel);
    chips.appendChild(statusChip);

    // priority chip only when the task HAS a priority.

    // and the value auto-priority assigns without a dueDate, so it is this
    // schema's natural "unset" marker. No existing "has priority" gate
    // exists to mirror (the Workbench renders all five stars always).
    if (task.priority > 0) {
      const priorityChip = document.createElement("span");
      priorityChip.classList.add("task-gantt-popover-priority-chip", "vg-chip");
      priorityChip.textContent = `P${task.priority}`;
      chips.appendChild(priorityChip);
    }
    root.appendChild(header);

    const body = document.createElement("div");
    body.classList.add("task-gantt-popover-body");
    root.appendChild(body);

    // read-only planned period, computed from the rendered
    // bar's start/end — NOT re-read from task fields.
    if (barStart !== "" && barEnd !== "") {
      const period = this.appendPopoverField(
        body,
        "task-gantt-popover-period",
        "予定期間"
      );
      const value = document.createElement("span");
      value.classList.add("task-gantt-popover-value");
      value.textContent = `${this.formatMonthDay(barStart)} - ${this.formatMonthDay(barEnd)}`;
      period.appendChild(value);
    }

    // read-only due date, only when present.
    if (task.dueDate) {
      const due = this.appendPopoverField(
        body,
        "task-gantt-popover-due",
        "期限"
      );
      const value = document.createElement("span");
      value.classList.add("task-gantt-popover-value");
      value.textContent = this.formatMonthDay(task.dueDate);
      due.appendChild(value);
    }

    // Status dropdown (immediate save + render).
    const statusField = this.appendPopoverField(
      body,
      "task-gantt-popover-status",
      "ステータス"
    );
    statusField.appendChild(this.buildStatusSelect(task));

    // tags, space-separated, only when the task has any.
    if (task.tags.length > 0) {
      const tagsField = this.appendPopoverField(
        body,
        "task-gantt-popover-tags",
        "タグ"
      );
      const value = document.createElement("span");
      value.classList.add("task-gantt-popover-value", "task-gantt-popover-tag-chips");
      appendTagChips(value, task.tags, this.host.settings);
      tagsField.appendChild(value);
    }

    // Add the Current Status autosave editor.
    const currentField = this.appendPopoverField(
      body,
      "task-gantt-popover-current",
      "現在の進捗"
    );
    const currentValue = document.createElement("div");
    currentValue.classList.add("task-gantt-popover-current-value");
    currentValue.appendChild(this.buildCurrentStatusArea(task));
    currentField.appendChild(currentValue);

    // Add the popover action buttons.
    const actions = document.createElement("div");
    actions.classList.add("task-gantt-popover-actions");
    actions.appendChild(this.buildOpenNoteButton(task));
    actions.appendChild(this.buildCompletedToggleButton(task));
    root.appendChild(actions);
  }









  private buildParentPopoverContent(
    root: HTMLElement,
    parent: TaskRow
  ): void {
    // --- Header ---
    const header = document.createElement("div");
    header.classList.add("task-gantt-popover-header");
    const title = document.createElement("div");
    title.classList.add("task-gantt-popover-title");
    title.textContent = parent.displayName || parent.title;
    header.appendChild(title);

    const chips = document.createElement("div");
    chips.classList.add("task-gantt-popover-chips");
    header.appendChild(chips);

    const statusChip = document.createElement("span");
    statusChip.classList.add("task-gantt-popover-status-chip", "vg-chip");
    // See the subtask popover's identical effectiveStatus comment above:
    // completed/statusLabel can disagree on hand-edited data, so both the
    // class and the text derive from the same value.
    const effectiveStatus = parent.completed ? "done" : parent.statusLabel;
    if (Object.prototype.hasOwnProperty.call(DEFAULT_STATUSES, effectiveStatus)) {
      statusChip.classList.add(`status-${effectiveStatus}`);
    }
    statusChip.textContent = parent.completed
      ? "完了"
      : this.statusDisplayLabel(parent.statusLabel);
    chips.appendChild(statusChip);
    root.appendChild(header);

    const body = document.createElement("div");
    body.classList.add("task-gantt-popover-body");
    root.appendChild(body);

    // editable date input, immediate save + render.
    const dueField = this.appendPopoverField(
      body,
      "task-gantt-popover-due",
      "期限"
    );
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.classList.add("task-gantt-popover-due-input", "vg-input-sm");
    dueInput.value = parent.dueDate ?? "";
    this.bindRichPopoverInteraction(dueInput);
    dueInput.addEventListener("change", () => {
      void this.savePopoverPatch(parent, { dueDate: dueInput.value });
    });
    dueField.appendChild(dueInput);


    const statusField = this.appendPopoverField(
      body,
      "task-gantt-popover-status",
      "ステータス"
    );
    statusField.appendChild(this.buildStatusSelect(parent));

    // identical debounce/IME/blur behavior — same helper.
    const currentField = this.appendPopoverField(
      body,
      "task-gantt-popover-current",
      "現在の進捗"
    );
    const currentValue = document.createElement("div");
    currentValue.classList.add("task-gantt-popover-current-value");
    currentValue.appendChild(this.buildCurrentStatusArea(parent));
    currentField.appendChild(currentValue);


    const actions = document.createElement("div");
    actions.classList.add("task-gantt-popover-actions");
    actions.appendChild(this.buildOpenNoteButton(parent));
    root.appendChild(actions);
  }


  // Popover save flows (siblings of saveTaskPatch — NOT replacements)

















  /**
 *
 * Persists tags through updateTaskItem, then reloads task rows during render.
 */
  private async savePopoverPatch(
    task: TaskRow,
    patch: TaskPatch
  ): Promise<void> {
    try {
      await this.host.updateTaskItem(task, patch);

      this.host.logger.info?.("TaskGanttView", "popover save completed", {
        taskId: task.id,
      });

    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to save popover change",
        err
      );
      // Log the failure without showing a Notice.

    }
    try {
      await this.render();
    } finally {
      // Always tear the popover down, even if render itself throws —
      // finally re-raises afterwards, so the error is NOT swallowed.
      this.closeRichPopover();
    }
  }

  /**
 *
 * Saves Current Status separately from saveTaskPatch and savePopoverPatch.
 * It writes only when the trimmed value changes. On failure, it logs to the
 * console without showing a Notice and restores the in-memory value while
 * leaving the user's text visible in the textarea. It does not render,
 * because a mid-typing render would tear down the popover.
 */
  private async saveRichPopoverCurrentStatus(
    area: HTMLTextAreaElement,
    task: TaskRow
  ): Promise<void> {
    const newValue = area.value.trim();
    const previous = task.currentStatus ?? "";
    if (newValue === previous) {
      return;
    }
    task.currentStatus = newValue; // optimistic in-memory commit
    try {
      await this.host.updateTaskItem(task, { currentStatus: newValue });
    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to save current status",
        err
      );

      task.currentStatus = previous; // Roll back the in-memory value.
      // Leave area.value unchanged so the displayed text stays in place.
    }
  }




























  private async saveTaskPatch(
    task: TaskRow,
    patch: TaskPatch,
    options: { checkWorkload: boolean }
  ): Promise<void> {
    if (options.checkWorkload && hasWorkloadActual(task)) {
      const proceed = await this.host.confirmWorkloadShift(
        "この移動により作業記録がずれます。実行しますか？"
      );
      if (!proceed) {
        return; // no save, no re-render
      }
    }

    try {
      await this.host.updateTaskItem(task, patch);
    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to save drag change",
        err
      );

      new Notice(
        "ガント操作の保存に失敗しました。詳細は console を確認してください。"
      ); // file-write failure surfaces as an in-view warning
    }
    // render either way; the tooltip/is-dragging/
    // listener cleanup already happened synchronously on pointerup, before
    // this async save even started.
    await this.render();
  }













































  private startInlineEdit(options: {
    hostEl: HTMLElement;
    initialValue: string;
    onCommit: (value: string) => Promise<void>;
  }): void {
    const { hostEl, initialValue, onCommit } = options;

    // Re-entrancy guard: a second dblclick on an element whose editor is
    // already open is a no-op (also covers the inlineEditingEls invariant
    // never accumulating duplicate entries for the same element).
    if (this.inlineEditingEls.has(hostEl)) {
      return;
    }
    const parentEl = hostEl.parentNode as HTMLElement | null;
    if (!parentEl) {
      return; // defensive: nothing to append the input into
    }


    // The input must appear exactly where the (now-hidden) host was. The
    // host's inline left/top only exist for positioned hosts such as bars and markers.
    // the event-chip label is a static span inside its chip, so fall back to
    // its offset within the offsetParent. Both must be read BEFORE the hide
    // below — a display:none element reports offsetLeft/offsetTop as 0.
    const hostLeft = hostEl.style.left || `${hostEl.offsetLeft ?? 0}px`;
    const hostTop = hostEl.style.top || `${hostEl.offsetTop ?? 0}px`;

    this.inlineEditingEls.add(hostEl);
    hostEl.hide();

    const input = document.createElement("input");
    input.type = "text";
    input.classList.add("task-gantt-inline-editor");
    input.value = initialValue;
    // The input MUST be absolutely positioned: left/top/width are ignored by
    // a static box, which dropped the editor into the timeline's normal flow
    // at its content origin — off-screen once the chart is scrolled, so the
    // double-click appeared to swallow the label. Position:absolute pins the
    // input over the host's spot, as styled by the matching rule in styles.css.
    input.style.position = "absolute";
    input.style.left = hostLeft;
    input.style.top = hostTop;
    if (hostEl.style.width) {
      input.style.width = hostEl.style.width;
    }
    if (hostEl.style.height) {
      input.style.height = hostEl.style.height;
    }

    parentEl.insertBefore(input, hostEl.nextSibling);

    let finished = false;

    const finish = async (): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;

      // was this editing session torn down already by
      // an unrelated external render (wrapEl.empty+rebuild) before
      // finish got a chance to run? Checked BEFORE our own input.remove
      // below, which would otherwise make this always true.
      const externallyDetached = !input.isConnected;
      const raw = input.value;
      // trim, then collapse embedded newlines (a real
      // <input> cannot contain a literal Enter via the keyboard, but a
      // paste could inject one — defensive).
      const normalized = raw.trim().replace(/\r?\n/g, " ");

      // input removal + hostEl.show happen
      // synchronously, BEFORE the async onCommit below — so onCommit's
      // own side effects (e.g. a render that rebuilds this very subtree)
      // can never affect this line, and the field is never left open while
      // the async commit is in flight. Both calls are safe no-ops even if
      // the elements were already detached.
      input.remove();
      hostEl.show();
      this.inlineEditingEls.delete(hostEl);

      if (externallyDetached) {
        return; // discard silently, nothing saved
      }
      if (normalized === initialValue.trim()) {
        return; // only save when the value actually changed
      }
      // no try/catch here — a rejection from
      // onCommit propagates out of finish (and out of this async
      // function) exactly as-is.
      await onCommit(normalized);
    };

    const cancel = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      input.remove();
      hostEl.show(); // revert to the original value/element
      this.inlineEditingEls.delete(hostEl);
    };

    input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void finish();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        cancel(); // discard, no commit
      }
    });
    input.addEventListener("blur", () => {
      void finish();
    });

    // Use preventScroll because this input is in normal document flow and
    // may be off-screen relative to the current scroll position. A plain focus
    // could auto-scroll `.task-gantt-wrap` past onScroll's range-extension
    // threshold, triggering a full renderChart rebuild that destroys this
    // input immediately after it was created.
    // A live-DOM diagnostic confirmed the sequence: MutationObserver saw the
    // input appear and disappear about 50ms later, between the focus-triggered
    // scroll event and the extension's compensating range shift.
    input.focus({ preventScroll: true });
    input.select();
  }















  private async saveSubtaskTitleEdit(
    task: TaskRow,
    value: string
  ): Promise<void> {
    await this.host.updateTaskItem(task, {
      displayName: value,
      title: value,
    });
    await this.render();
  }









  private async saveMarkerTitleEdit(
    task: TaskRow,
    markerKey: string,
    value: string
  ): Promise<void> {
    const markers = task.ganttMarkers ?? [];
    const updated = markers.map((m) =>
      m.key === markerKey ? { ...m, title: value } : m
    );
    await this.host.updateTaskItem(task, { ganttMarkers: updated });
    await this.render();
  }


































  private startParentTitleEdit(
    parent: TaskRow,
    leftEl: HTMLElement,
    titleEl: HTMLElement
  ): void {
    if (this.parentTitleEditingIds.has(parent.id)) {
      return; // re-entrancy guard, same idiom as startInlineEdit
    }

    this.parentTitleEditingIds.add(parent.id); // (dragstart guard)
    leftEl.setAttribute("draggable", "false");

    // hide LEFT's other children (e.g. the tag-chips block) —
    // titleEl itself is excluded, it uses hide/show below instead.
    for (const child of Array.from(leftEl.children)) {
      if (child !== titleEl) {
        child.classList.add("twb-hidden-during-title-edit");
      }
    }

    const initialValue = parent.displayName || parent.title;
    titleEl.hide();

    const textarea = document.createElement("textarea");
    textarea.classList.add("task-gantt-parent-title-editor");
    textarea.value = initialValue;
    leftEl.insertBefore(textarea, titleEl.nextSibling);

    let composing = false;
    let finished = false;

    const restore = (): void => {
      textarea.remove();
      titleEl.show();
      for (const child of Array.from(leftEl.children)) {
        child.classList.remove("twb-hidden-during-title-edit");
      }
      leftEl.setAttribute("draggable", "true"); // revert
      this.parentTitleEditingIds.delete(parent.id);
    };

    const finish = async (): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;

      // Same ordering guarantee as startInlineEdit's own finish: checked
      // BEFORE restore below (which would otherwise make this always true).
      const externallyDetached = !textarea.isConnected;
      const raw = textarea.value;
      // trim, then collapse embedded newline runs
      // (surrounding whitespace included) into a single space.
      const normalized = raw.trim().replace(/\s*\n+\s*/g, " ");

      restore();

      if (externallyDetached) {
        return; // discarded silently, same as startInlineEdit's own gap
      }
      if (normalized === initialValue.trim()) {
        return; // no-op save when nothing actually changed
      }
      await this.saveParentTitleEdit(parent, normalized);
    };

    const cancel = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      restore(); // discard, no commit
    };

    textarea.addEventListener("compositionstart", () => {
      composing = true;
    });
    textarea.addEventListener("compositionend", () => {
      composing = false;
    });

    textarea.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (composing) {
        return; // Enter/Escape both ignored while composing
      }
      if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
        evt.preventDefault();
        void finish();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        cancel();
      }
      // Plain Enter inserts a newline in the multiline editor.
    });

    textarea.addEventListener("blur", () => {
      void finish(); // blur always commits
    });

    textarea.focus({ preventScroll: true }); // same rAF-scroll-collision
    textarea.select();                       // avoidance as startInlineEdit
  }










  private async saveParentTitleEdit(
    parent: TaskRow,
    value: string
  ): Promise<void> {
    await this.host.updateTaskItem(parent, {
      displayName: value,
      title: value,
    });
    await this.render();
  }











  private async editMarkerInteractively(
    task: TaskRow,
    marker: GanttMarker
  ): Promise<void> {
    const result = await this.host.openMarkerModal(
      "マーカーを編集",
      marker.title,
      marker.date
    );
    if (result === null) {
      return; // cancelled
    }
    const markers = task.ganttMarkers ?? [];
    const updated = markers.map((m) =>
      m.key === marker.key
        ? { ...m, title: result.title, date: result.date }
        : m
    );
    this.closeRichPopover();
    await this.saveTaskPatch(task, { ganttMarkers: updated }, { checkWorkload: false });
  }























  private openBarContextMenu(
    evt: MouseEvent,
    task: TaskRow,
    bar: Bar,
    barEl: HTMLElement
  ): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.armRichPopoverSuppress(MENU_POPOVER_SUPPRESS_MS);
    this.closeRichPopover();

    const menu = new Menu();
    this.activateContextMenu(menu);


    // Reuse savePopoverPatch for the popover's completion toggle. It renders
    // unconditionally and logs failures to the console without showing a Notice.

    menu.addItem((item) => {
      item.setTitle(task.completed ? "未完了に戻す" : "完了とする");
      item.onClick(() => {
        const patch: TaskPatch = task.completed
          ? { completed: false, statusLabel: "active" }
          : { completed: true, statusLabel: "done" };
        void this.savePopoverPatch(task, patch);
      });
    });


    // Adds a marker within the bar's own date range.
    menu.addItem((item) => {
      item.setTitle("マーカーを追加");
      item.onClick(() => {
        void this.addMarkerAtClick(task, bar, evt.clientX, barEl);
      });
    });

    menu.addSeparator();


    this.addTagToggleItems(menu, task.tags, (nextTags) => {
      void this.savePopoverPatch(task, { tags: nextTags });
    });

    menu.addSeparator();


    // mode is actually active for this bar's own parent (see bulkMoveState's

    // item never renders — forward-compatible plumbing, not a false
    // positive).
    if (this.bulkMoveState !== undefined) {
      menu.addItem((item) => {
        item.setTitle("一括移動モードを解除");
        item.onClick(() => {
          this.bulkMoveState = undefined;
          void this.render();
        });
      });
    }


    menu.addItem((item) => {
      item.setTitle("Current Statusを編集");
      item.onClick(() => {
        this.host.openTextPrompt(
          "Current Statusを編集",
          "Current Status",
          task.currentStatus ?? "",
          (value) => {
            void this.savePopoverPatch(task, { currentStatus: value.trim() });
          }
        );
      });
    });


    menu.addItem((item) => {
      item.setTitle("タスクノートを開く");
      item.onClick(() => {
        void this.host.openTaskItem(task);
      });
    });

    menu.addSeparator();


    menu.addItem((item) => {
      item.setTitle("ガントチャートから削除");
      item.onClick(() => {
        void this.removeFromGanttInteractively(task);
      });
    });


    menu.addItem((item) => {
      item.setTitle("タスクとして削除");
      item.setWarning(true);
      item.onClick(() => {
        void this.deleteSubtaskInteractively(task);
      });
    });

    menu.showAtMouseEvent(evt); // Show the menu at the pointer position.
  }



























  private addTagToggleItems(
    menu: Menu,
    currentTags: string[],
    onToggle: (nextTags: string[]) => void
  ): void {
    // Skip the tag menu items entirely when the tags feature is disabled.
    if (!this.host.settings.ganttFeatureTagsEnabled) {
      return;
    }

    menu.addItem((item) => {
      item.setTitle("タグ");

      const runtimeItem = item as MenuItemWithRuntimeSubmenu;
      if (typeof runtimeItem.setSubmenu === "function") {
        const tagMenu = runtimeItem.setSubmenu();
        this.populateTagSubmenu(tagMenu, currentTags, onToggle);
        return;
      }

      // Older Obsidian runtimes have no public or runtime submenu API. Keep a
      // click-only fallback without recreating a parallel hover lifecycle.
      item.onClick((evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const tagMenu = new Menu();
        this.populateTagSubmenu(tagMenu, currentTags, onToggle);
        this.activateContextMenu(tagMenu);
        tagMenu.showAtPosition({
          x: (evt as MouseEvent).clientX ?? 0,
          y: (evt as MouseEvent).clientY ?? 0,
        });
      });
    });
  }

  /** Populates the shared native (or click-only fallback) tag child menu. */
  private populateTagSubmenu(
    tagMenu: Menu,
    currentTags: string[],
    onToggle: (nextTags: string[]) => void
  ): void {
    const definitions = (Array.isArray(this.host.settings.ganttTags)
      ? this.host.settings.ganttTags
      : []
    ).filter((definition) => definition.name.trim() !== "");
    if (definitions.length === 0) {
      tagMenu.addItem((emptyItem) => {
        emptyItem.setTitle("タグは未作成です");
        emptyItem.setDisabled(true);
      });
    } else {
      for (const definition of definitions) {
        const tagName = definition.name;
        const has = currentTags.some(
          (tag) => tag === definition.name || tag === definition.key
        );
        tagMenu.addItem((tagItem) => {
          tagItem.setTitle(tagName);
          tagItem.setChecked(has);
          tagItem.onClick((tagEvt) => {
            tagEvt.preventDefault();
            tagEvt.stopPropagation();
            const next = canonicalizeTagNames(
              has
                ? currentTags.filter(
                    (tag) => tag !== definition.name && tag !== definition.key
                  )
                : [...currentTags, tagName],
              definitions
            );
            onToggle(next);
            this.activeContextMenu?.hide();
          });
        });
      }
    }

    tagMenu.addSeparator();
    tagMenu.addItem((createItem) => {
      createItem.setTitle("新しいタグを作成して付与");
      createItem.onClick((createEvt) => {
        createEvt.preventDefault();
        createEvt.stopPropagation();
        this.activeContextMenu?.hide();
        this.createGanttTagInteractively(currentTags, onToggle);
      });
    });
  }

  /**
 *
 * Opens the existing text-input modal, normalizes the submitted name, and
 * appends a new registry definition before assigning it to the target row.
 * Existing names and keys reuse the existing definition, so repeated use
 * cannot create duplicate registry entries or duplicate task tags.
 */
  private createGanttTagInteractively(
    currentTags: string[],
    onToggle?: (nextTags: string[]) => void
  ): void {
    this.host.openTextPrompt(
      "新しいタグを作成して付与",
      "タグ名",
      "",
      (rawName) => {
        const name = rawName.trim();
        if (name === "") {
          return;
        }

        const definitions = Array.isArray(this.host.settings.ganttTags)
          ? this.host.settings.ganttTags
          : [];
        const existing = definitions.find(
          (definition) => definition.name === name || definition.key === name
        );
        if (existing) {
          // canonicalize key references to the display
          // name and dedupe the complete target array before persistence.
          const canonicalTags = canonicalizeTagNames(
            [...currentTags, existing.name],
            definitions
          );
          if (
            onToggle &&
            (canonicalTags.length !== currentTags.length ||
              canonicalTags.some((tag, index) => tag !== currentTags[index]))
          ) {
            onToggle(canonicalTags);
          }
          // callers may omit onToggle when they only need to
          // create/reuse a registry entry.
          return;
        }

        const nextOrder =
          definitions.reduce(
            (max, definition) =>
              Number.isFinite(definition.order)
                ? Math.max(max, definition.order)
                : max,
            -1000
          ) + 1000;
        const definition = {
          key: name,
          name,
          color:
            DEFAULT_GANTT_TAG_COLORS[
              definitions.length % DEFAULT_GANTT_TAG_COLORS.length
            ],
          order: nextOrder,
        };
        const candidateDefinitions = [...definitions, definition];
        this.host.settings.ganttTags = candidateDefinitions;

        void this.host
          .saveSettings()
          .then(() => {
            // the supplied onToggle is the shared menu
            // persistence path, which performs the task save and render.
            if (onToggle) {
              onToggle(
                canonicalizeTagNames([...currentTags, name], candidateDefinitions)
              );
            } else {
              void this.render();
            }
          })
          .catch((err: unknown) => {

            this.host.logger.error(
              "TaskGanttView",
              "failed to create Gantt tag",
              err
            );

            // Do not erase a newer settings array installed while the save
            // was pending; only the candidate we installed may be rolled back.
            if (this.host.settings.ganttTags === candidateDefinitions) {
              this.host.settings.ganttTags = definitions;
            }
          });
      }
    );
  }

  /**
 *
 * Converts a right-click's screen-space clientX into the calendar date it
 * landed on, clamped to the bar's own [start, end] — pixels into
 * the bar from ITS OWN left edge (barEl.getBoundingClientRect.left),
 * divided by dayWidth, floored to a whole day and added to bar.start. This
 * avoids depending on the timeline container's own screen offset (which
 * would require accounting for horizontal scroll separately) since the
 * bar's own rect already incorporates it.
 */
  private dateFromBarClickX(clientX: number, bar: Bar, barEl: HTMLElement): string {
    const barRect = barEl.getBoundingClientRect();
    const dayOffset = Math.floor((clientX - barRect.left) / this.dayWidth);
    let date = addDays(bar.start, dayOffset);
    if (date < bar.start) {
      date = bar.start;
    } else if (date > bar.end) {
      date = bar.end;
    }
    return date;
  }











  private async addMarkerAtClick(
    task: TaskRow,
    bar: Bar,
    clientX: number,
    barEl: HTMLElement
  ): Promise<void> {
    const date = this.dateFromBarClickX(clientX, bar, barEl);
    const existingKeys = new Set((task.ganttMarkers ?? []).map((m) => m.key));
    const key = makeUniqueMarkerKey("新しいマーカー", existingKeys);
    const marker: GanttMarker = { key, title: "新しいマーカー", date };
    const updated = [...(task.ganttMarkers ?? []), marker];
    await this.saveTaskPatch(
      task,
      { ganttMarkers: updated },
      { checkWorkload: false }
    ); // saveTaskPatch renders either way.
  }













  private async removeFromGanttInteractively(task: TaskRow): Promise<void> {
    try {
      await this.host.updateTaskItem(task, {
        plannedStartDate: "",
        plannedEndDate: "",
      });
      new Notice("ガントチャートから外しました（内部情報は保持しています）");
    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to remove task from gantt",
        err
      );

      new Notice(
        "ガント操作の保存に失敗しました。詳細は console を確認してください。"
      );
    }
    await this.render();
  }











  private async deleteSubtaskInteractively(task: TaskRow): Promise<void> {
    const name = task.displayName || task.title || "サブタスク";
    const confirmed = window.confirm(
      `サブタスク『${name}』をタスクとして削除します。元に戻せません。`
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.host.deleteSubtaskTaskItem(task);
      new Notice(`タスクとして削除しました: ${name}`);
    } catch (err) {

      this.host.logger.error(
        "TaskGanttView",
        "failed to delete subtask",
        err
      );

      new Notice(
        "ガント操作の保存に失敗しました。詳細は console を確認してください。"
      );
    }
    await this.render();
  }













  private openMarkerContextMenu(
    evt: MouseEvent,
    task: TaskRow,
    marker: GanttMarker
  ): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.armRichPopoverSuppress(MENU_POPOVER_SUPPRESS_MS);
    this.closeRichPopover();

    const menu = new Menu();
    this.activateContextMenu(menu);

    menu.addItem((item) => {
      item.setTitle("編集"); // (retained, see docblock above)
      item.onClick(() => {
        void this.editMarkerInteractively(task, marker);
      });
    });

    menu.addSeparator();


    // Updates markers matching the selected key and leaves unmatched entries
    // unchanged.

    this.addTagToggleItems(menu, marker.tags ?? [], (nextTags) => {
      const markers = (task.ganttMarkers ?? []).map((m) =>
        m.key === marker.key ? { ...m, tags: nextTags } : m
      );
      void this.savePopoverPatch(task, { ganttMarkers: markers });
    });

    menu.addSeparator();


    menu.addItem((item) => {
      item.setTitle("削除");
      item.setWarning(true);
      item.onClick(() => {
        void this.deleteMarkerInteractively(task, marker);
      });
    });

    menu.showAtMouseEvent(evt); // Show the menu at the pointer position.
  }








  private async deleteMarkerInteractively(
    task: TaskRow,
    marker: GanttMarker
  ): Promise<void> {
    const updated = (task.ganttMarkers ?? []).filter(
      (m) => m.key !== marker.key
    );
    await this.savePopoverPatch(task, { ganttMarkers: updated });
  }














  private openParentContextMenu(evt: MouseEvent, parent: TaskRow): void {
    evt.preventDefault();
    evt.stopPropagation();

    const menu = new Menu();
    this.activateContextMenu(menu);



    menu.addItem((item) => {
      item.setTitle("親タスク名を編集");
      item.onClick(() => {
        this.host.openTextPrompt(
          "親タスク名を編集",
          "親タスク名",
          parent.displayName || parent.title,
          (value) => {
            void this.saveParentNameFromPrompt(parent, value);
          }
        );
      });
    });

    menu.addSeparator();


    this.addTagToggleItems(menu, parent.tags, (nextTags) => {
      void this.saveTaskPatch(
        parent,
        { tags: nextTags },
        { checkWorkload: false }
      );
    });


    menu.addItem((item) => {
      item.setTitle("サブタスクを追加");
      item.onClick(() => {
        this.addSubtaskToParentInteractively(parent);
      });
    });


    menu.addItem((item) => {
      item.setTitle("ガントでの管理をやめる");
      item.onClick(() => {
        void this.saveTaskPatch(
          parent,
          { ganttEnabled: false },
          { checkWorkload: false }
        ); // saveTaskPatch renders either way.
      });
    });

    menu.addSeparator();


    menu.addItem((item) => {
      item.setTitle("ノートを開く");
      item.onClick(() => {
        void this.host.openTaskItem(parent);
      });
    });

    menu.showAtMouseEvent(evt);
  }











  private async saveParentNameFromPrompt(
    parent: TaskRow,
    rawValue: string
  ): Promise<void> {
    const value = rawValue.trim();
    if (value === "") {
      return;
    }
    await this.host.updateTaskItem(parent, {
      displayName: value,
      title: value,
    });
    await this.render();
  }








  private addSubtaskToParentInteractively(parent: TaskRow): void {
    if (this.host.addSubtaskInteractively) {
      void this.host.addSubtaskInteractively(parent, () => {
        void this.render();
      });
      return;
    }

    this.host.logger.warn(
      "TaskGanttView",
      "host.addSubtaskInteractively() is not implemented — 「サブタスクを追加」 clicked"
    );

  }






















  private async handleParentDrop(targetId: string): Promise<void> {
    const sourceId = this.dragParentId;
    this.dragParentId = undefined;
    if (!sourceId || sourceId === targetId) {
      return;
    }

    const ordered = getGanttParentRows(this.tasks);
    const fromIndex = ordered.findIndex((t) => t.id === sourceId);
    const toIndex = ordered.findIndex((t) => t.id === targetId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }

    const [moved] = ordered.splice(fromIndex, 1);
    ordered.splice(toIndex, 0, moved);

    const commands: TaskUpdateCommand[] = [];
    ordered.forEach((row, i) => {
      const newOrder = (i + 1) * 1000;
      if (row.ganttOrder !== newOrder) {
        commands.push({ row, patch: { ganttOrder: newOrder } });
      }
    });

    if (commands.length === 0) {
      return; // nothing actually changed order
    }
    await this.host.updateTaskItemsBatch(commands);
    await this.render();
  }
}
