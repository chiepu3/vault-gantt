import type { TaskRecord } from '../../application/core-task-api';
import {
  LANE_BASE_HEIGHT,
  BAR_HEIGHT,
  PARENT_COL_WIDTH,
  BAR_RESIZE_HANDLE_WIDTH,
} from './gantt-constants';
import {
  packSubtasksIntoLanes,
  barLeftPx,
  barWidthPx,
  laneTopPx,
} from './gantt-layout-engine';
import {
  dateLabel,
  isWeekend as isWeekendDate,
  isMonthStart,
  monthTitle,
  todayStr,
} from './gantt-date-utils';
import type { GanttViewState } from './gantt-view-state';

/**
 * GanttRenderer is responsible for creating and updating the DOM tree for the Gantt view.
 * It maintains a row map for efficient diff updates.
 */
export class GanttRenderer {
  rootEl: HTMLElement | null = null;
  headerEl: HTMLElement | null = null;
  bodyEl: HTMLElement | null = null;

  private rowMap = new Map<string, { rowEl: HTMLElement; leftEl: HTMLElement; timelineEl: HTMLElement }>();

  constructor(private viewState: GanttViewState) {}

  /**
   * Mount the Gantt view into a container element.
   * Creates the full DOM structure.
   */
  mount(containerEl: HTMLElement): void {
    containerEl.empty();

    const ganttDiv = containerEl.createDiv({ cls: 'vg-gantt' });
    ganttDiv.style.display = 'flex';
    ganttDiv.style.flexDirection = 'column';
    ganttDiv.style.height = '100%';
    ganttDiv.style.overflow = 'hidden';

    const scrollWrap = ganttDiv.createDiv({ cls: 'vg-gantt-scroll-wrap' });
    scrollWrap.style.flex = '1';
    scrollWrap.style.overflow = 'auto';
    this.viewState.scrollEl = scrollWrap;

    const rootDiv = scrollWrap.createDiv({ cls: 'vg-gantt-root' });
    rootDiv.style.display = 'inline-block';
    rootDiv.style.minWidth = '100%';
    rootDiv.style.position = 'relative';
    this.rootEl = rootDiv;

    // Header
    this.headerEl = rootDiv.createDiv({ cls: 'vg-gantt-header' });
    this.headerEl.style.position = 'sticky';
    this.headerEl.style.top = '0';
    this.headerEl.style.zIndex = '10';
    this.headerEl.style.display = 'flex';

    const headerLeft = this.headerEl.createDiv({ cls: 'vg-gantt-header-left' });
    headerLeft.style.width = `${PARENT_COL_WIDTH}px`;
    headerLeft.style.display = 'inline-block';
    headerLeft.style.verticalAlign = 'top';
    headerLeft.createSpan({ text: '親タスク' });

    const headerTimeline = this.headerEl.createDiv({ cls: 'vg-gantt-header-timeline' });
    headerTimeline.style.display = 'inline-block';
    headerTimeline.style.position = 'relative';

    headerTimeline.createDiv({ cls: 'vg-gantt-month-row' });
    headerTimeline.createDiv({ cls: 'vg-gantt-day-row' });
    headerTimeline.createDiv({ cls: 'vg-gantt-dow-row' });

    // Body
    this.bodyEl = rootDiv.createDiv({ cls: 'vg-gantt-body' });
    this.bodyEl.style.position = 'relative';
  }

  /**
   * Render header rows (month, day, day-of-week).
   */
  renderHeader(dates: string[]): void {
    if (!this.headerEl) return;

    const headerTimeline = this.headerEl.querySelector('.vg-gantt-header-timeline') as HTMLElement;
    if (!headerTimeline) return;

    const monthRow = headerTimeline.querySelector('.vg-gantt-month-row') as HTMLElement;
    const dayRow = headerTimeline.querySelector('.vg-gantt-day-row') as HTMLElement;
    const dowRow = headerTimeline.querySelector('.vg-gantt-dow-row') as HTMLElement;

    if (!monthRow || !dayRow || !dowRow) return;

    monthRow.empty();
    dayRow.empty();
    dowRow.empty();

    const today = todayStr();
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const isWeekendDay = isWeekendDate(date);

      // Month row
      if (isMonthStart(date, i)) {
        const monthCell = monthRow.createDiv({ cls: 'vg-gantt-date-cell' });
        monthCell.style.width = `${this.viewState.dayWidth}px`;
        if (isWeekendDay) monthCell.addClass('is-weekend');
        monthCell.createSpan({ text: monthTitle(date) });
      } else {
        const emptyCell = monthRow.createDiv({ cls: 'vg-gantt-date-cell' });
        emptyCell.style.width = `${this.viewState.dayWidth}px`;
        if (isWeekendDay) emptyCell.addClass('is-weekend');
      }

      // Day row
      const dayCell = dayRow.createDiv({ cls: 'vg-gantt-date-cell' });
      dayCell.style.width = `${this.viewState.dayWidth}px`;
      if (isWeekendDay) dayCell.addClass('is-weekend');
      if (date === today) dayCell.addClass('is-today');
      dayCell.createSpan({ text: dateLabel(date, 'D') });

      // Day-of-week row
      const dowCell = dowRow.createDiv({ cls: 'vg-gantt-date-cell' });
      dowCell.style.width = `${this.viewState.dayWidth}px`;
      if (isWeekendDay) dowCell.addClass('is-weekend');
      dowCell.createSpan({ text: dateLabel(date, 'dd') });
    }
  }

  /**
   * Render or update all task rows.
   */
  renderAll(tasks: TaskRecord[], dates: string[]): void {
    if (!this.bodyEl) return;

    // Mark which paths exist in the task list
    const existingPaths = new Set(tasks.map((t) => t.path));

    // Remove rows for tasks no longer in the list
    for (const path of Array.from(this.rowMap.keys())) {
      if (!existingPaths.has(path)) {
        this.removeParentRow(path);
      }
    }

    // Sort tasks by ganttOrder then displayName
    const sortedTasks = [...tasks].sort((a, b) => {
      const orderCmp = a.note.ganttOrder - b.note.ganttOrder;
      if (orderCmp !== 0) return orderCmp;
      return a.note.displayName.localeCompare(b.note.displayName);
    });

    // Upsert rows
    for (const record of sortedTasks) {
      if (!record.note.ganttEnabled) {
        this.removeParentRow(record.path);
        continue;
      }

      if (this.rowMap.has(record.path)) {
        this.updateParentRow(record, dates);
      } else {
        this.createParentRow(record, dates);
      }
    }

    // Re-order DOM to match sort order (ganttOrder may have changed)
    for (const record of sortedTasks) {
      if (!record.note.ganttEnabled) continue;
      const row = this.rowMap.get(record.path);
      if (row) this.bodyEl.appendChild(row.rowEl);
    }
  }

  /**
   * Create a new parent row.
   */
  createParentRow(record: TaskRecord, dates: string[]): void {
    if (!this.bodyEl) return;

    const rowDiv = this.bodyEl.createDiv({ cls: 'vg-gantt-row' });
    rowDiv.setAttribute('data-path', record.path);
    rowDiv.style.display = 'flex';
    rowDiv.style.borderBottom = '1px solid var(--background-modifier-border)';

    const leftDiv = rowDiv.createDiv({ cls: 'vg-gantt-row-left' });
    leftDiv.style.flexShrink = '0';
    leftDiv.style.width = `${PARENT_COL_WIDTH}px`;
    leftDiv.style.borderRight = '1px solid var(--background-modifier-border)';
    leftDiv.style.padding = '0.25rem 0.5rem';
    leftDiv.style.overflow = 'hidden';

    const titleDiv = leftDiv.createDiv({ cls: 'vg-gantt-parent-title' });
    titleDiv.style.fontWeight = '500';
    titleDiv.style.whiteSpace = 'nowrap';
    titleDiv.style.overflow = 'hidden';
    titleDiv.style.textOverflow = 'ellipsis';
    titleDiv.createSpan({ text: record.note.displayName });

    const timelineDiv = rowDiv.createDiv({ cls: 'vg-gantt-timeline' });
    timelineDiv.style.position = 'relative';
    timelineDiv.style.overflow = 'hidden';
    timelineDiv.style.flex = '1';

    this.rowMap.set(record.path, { rowEl: rowDiv, leftEl: leftDiv, timelineEl: timelineDiv });
    this.renderBars(timelineDiv, record, dates);
  }

  /**
   * Update an existing parent row.
   */
  updateParentRow(record: TaskRecord, dates: string[]): void {
    const row = this.rowMap.get(record.path);
    if (!row) return;

    const { timelineEl } = row;
    timelineEl.empty();
    this.renderBars(timelineEl, record, dates);
  }

  /**
   * Render bars (subtasks) into a timeline element.
   */
  private renderBars(timelineEl: HTMLElement, record: TaskRecord, dates: string[]): void {
    const { bars, laneCount } = packSubtasksIntoLanes(record.note.subtasks);

    // Background highlights for weekends and today only (skip plain weekdays)
    const today = todayStr();
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const weekend = isWeekendDate(date);
      if (!weekend && date !== today) continue;
      const bgCol = timelineEl.createDiv({ cls: 'vg-gantt-bg-col' });
      bgCol.style.position = 'absolute';
      bgCol.style.left = `${i * this.viewState.dayWidth}px`;
      bgCol.style.width = `${this.viewState.dayWidth}px`;
      bgCol.style.top = '0';
      bgCol.style.bottom = '0';
      bgCol.style.pointerEvents = 'none';
      if (weekend) bgCol.addClass('is-weekend');
      if (date === today) bgCol.addClass('is-today');
    }

    // Render bars
    for (const bar of bars) {
      const left = barLeftPx(dates[0], bar.start, this.viewState.dayWidth);
      const width = barWidthPx(bar.start, bar.end, this.viewState.dayWidth);
      const top =
        laneTopPx(bar.lane, LANE_BASE_HEIGHT) + (LANE_BASE_HEIGHT - BAR_HEIGHT) / 2;

      const barEl = timelineEl.createDiv({ cls: 'vg-gantt-bar' });
      barEl.style.position = 'absolute';
      barEl.style.left = `${left}px`;
      barEl.style.width = `${width}px`;
      barEl.style.top = `${top}px`;
      barEl.style.height = `${BAR_HEIGHT}px`;
      barEl.setAttribute('data-path', record.path);
      barEl.setAttribute('data-key', bar.subtask.key);
      barEl.dataset.startDate = bar.start;
      barEl.dataset.endDate = bar.end;

      // Label
      const labelEl = barEl.createDiv({ cls: 'vg-gantt-bar-label' });
      labelEl.style.fontSize = 'var(--font-ui-smaller)';
      labelEl.style.color = 'var(--text-on-accent)';
      labelEl.style.padding = '0 4px';
      labelEl.style.overflow = 'hidden';
      labelEl.style.textOverflow = 'ellipsis';
      labelEl.style.whiteSpace = 'nowrap';
      labelEl.style.flex = '1';
      labelEl.style.pointerEvents = 'none';
      labelEl.createSpan({ text: bar.subtask.title });

      // Left resize handle
      const handleStart = barEl.createDiv({ cls: 'vg-gantt-bar-handle is-start' });
      handleStart.style.position = 'absolute';
      handleStart.style.top = '0';
      handleStart.style.bottom = '0';
      handleStart.style.left = '0';
      handleStart.style.width = `${BAR_RESIZE_HANDLE_WIDTH}px`;
      handleStart.style.cursor = 'ew-resize';
      handleStart.style.zIndex = '1';

      // Right resize handle
      const handleEnd = barEl.createDiv({ cls: 'vg-gantt-bar-handle is-end' });
      handleEnd.style.position = 'absolute';
      handleEnd.style.top = '0';
      handleEnd.style.bottom = '0';
      handleEnd.style.right = '0';
      handleEnd.style.width = `${BAR_RESIZE_HANDLE_WIDTH}px`;
      handleEnd.style.cursor = 'ew-resize';
      handleEnd.style.zIndex = '1';
    }

    // Set timeline height based on lane count
    timelineEl.style.height = `${laneTopPx(laneCount, LANE_BASE_HEIGHT) + 16}px`;
  }

  /**
   * Set the width of all timeline elements.
   */
  setTimelineWidth(dates: string[]): void {
    if (!this.headerEl) return;

    const totalWidth = dates.length * this.viewState.dayWidth;

    const headerTimeline = this.headerEl.querySelector('.vg-gantt-header-timeline') as HTMLElement;
    if (headerTimeline) {
      headerTimeline.style.width = `${totalWidth}px`;
    }

    for (const { timelineEl } of this.rowMap.values()) {
      timelineEl.style.width = `${totalWidth}px`;
    }
  }

  /**
   * Remove a parent row from the DOM and rowMap.
   */
  removeParentRow(path: string): void {
    const row = this.rowMap.get(path);
    if (!row) return;

    row.rowEl.remove();
    this.rowMap.delete(path);
  }
}

