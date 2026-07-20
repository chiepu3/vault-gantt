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
  headerLeftEl: HTMLElement | null = null;
  headerInnerEl: HTMLElement | null = null;
  bodyEl: HTMLElement | null = null;
  bodyLeftPanelEl: HTMLElement | null = null;
  leftPanelInnerEl: HTMLElement | null = null;
  scrollWrapEl: HTMLElement | null = null;
  todayLineEl: HTMLElement | null = null;

  private rowMap = new Map<string, { rowEl: HTMLElement; leftEl: HTMLElement; timelineEl: HTMLElement }>();

  constructor(private viewState: GanttViewState) {}

  /**
   * Mount the Gantt view into a container element.
   * Creates the full DOM structure with separate left panel and scrollable timeline.
   *
   * Structure:
   * .vg-gantt (flex column, full height)
   *   .vg-gantt-header (flex row, sticky top)
   *     .vg-gantt-header-left (fixed width, position: relative)
   *       [3 rows: month, day, dow]
   *     .vg-gantt-header-scroll-clip (flex: 1, overflow hidden)
   *       .vg-gantt-header-inner (position: absolute, will-change: transform)
   *         [3 rows]
   *   .vg-gantt-body (flex row, flex: 1, overflow hidden)
   *     .vg-gantt-left-panel (fixed width, position: relative, z-index: 10)
   *       .vg-gantt-left-panel-inner (position: relative, will-change: transform)
   *         [one row per task]
   *     .vg-gantt-scroll-wrap (flex: 1, overflow auto) ← THE ONLY SCROLL CONTAINER
   *       .vg-gantt-body-inner (position relative, display block)
   *         [one timeline row per task, stacked]
   */
  mount(containerEl: HTMLElement): void {
    containerEl.empty();

    const ganttDiv = containerEl.createDiv({ cls: 'vg-gantt' });
    ganttDiv.style.display = 'flex';
    ganttDiv.style.flexDirection = 'column';
    ganttDiv.style.height = '100%';
    ganttDiv.style.overflow = 'hidden';

    // ===== Header =====
    this.headerEl = ganttDiv.createDiv({ cls: 'vg-gantt-header' });
    this.headerEl.style.display = 'flex';
    this.headerEl.style.borderBottom = '1px solid var(--background-modifier-border)';
    this.headerEl.style.zIndex = '20';
    this.headerEl.style.position = 'relative';
    this.headerEl.style.flexShrink = '0';

    // Header left panel (fixed width, shows "タスク名")
    this.headerLeftEl = this.headerEl.createDiv({ cls: 'vg-gantt-header-left' });
    this.headerLeftEl.style.width = `${PARENT_COL_WIDTH}px`;
    this.headerLeftEl.style.flexShrink = '0';
    this.headerLeftEl.style.position = 'relative';
    this.headerLeftEl.style.zIndex = '20';
    this.headerLeftEl.style.borderRight = '1px solid var(--background-modifier-border)';
    this.headerLeftEl.style.display = 'flex';
    this.headerLeftEl.style.alignItems = 'stretch';

    // Create 3 rows in header left (stacked vertically, sharing the space)
    this.headerLeftEl.createDiv({ cls: 'vg-gantt-header-left-row vg-gantt-header-left-month' });
    this.headerLeftEl.createDiv({ cls: 'vg-gantt-header-left-row vg-gantt-header-left-day' });
    this.headerLeftEl.createDiv({ cls: 'vg-gantt-header-left-row vg-gantt-header-left-dow' });

    // Header scroll clip (scrollable portion, no scroll itself)
    const headerScrollClip = this.headerEl.createDiv({ cls: 'vg-gantt-header-scroll-clip' });
    headerScrollClip.style.flex = '1';
    headerScrollClip.style.overflow = 'hidden';
    headerScrollClip.style.position = 'relative';

    // Header inner (positioned absolutely, moved via transform on scroll)
    this.headerInnerEl = headerScrollClip.createDiv({ cls: 'vg-gantt-header-inner' });
    this.headerInnerEl.style.position = 'absolute';
    this.headerInnerEl.style.top = '0';
    this.headerInnerEl.style.left = '0';
    this.headerInnerEl.style.willChange = 'transform';
    this.headerInnerEl.style.display = 'flex';
    this.headerInnerEl.style.flexDirection = 'column';

    this.headerInnerEl.createDiv({ cls: 'vg-gantt-month-row' });
    this.headerInnerEl.createDiv({ cls: 'vg-gantt-day-row' });
    this.headerInnerEl.createDiv({ cls: 'vg-gantt-dow-row' });

    // ===== Body =====
    const bodyWrapper = ganttDiv.createDiv({ cls: 'vg-gantt-body-wrapper' });
    bodyWrapper.style.display = 'flex';
    bodyWrapper.style.flex = '1';
    bodyWrapper.style.overflow = 'hidden';
    bodyWrapper.style.position = 'relative';

    // Left panel (fixed width, vertical scrolling synced from main scroll)
    this.bodyLeftPanelEl = bodyWrapper.createDiv({ cls: 'vg-gantt-left-panel' });
    this.bodyLeftPanelEl.style.width = `${PARENT_COL_WIDTH}px`;
    this.bodyLeftPanelEl.style.flexShrink = '0';
    this.bodyLeftPanelEl.style.overflow = 'hidden';
    this.bodyLeftPanelEl.style.position = 'relative';
    this.bodyLeftPanelEl.style.zIndex = '10';
    this.bodyLeftPanelEl.style.borderRight = '1px solid var(--background-modifier-border)';

    this.leftPanelInnerEl = this.bodyLeftPanelEl.createDiv({ cls: 'vg-gantt-left-panel-inner' });
    this.leftPanelInnerEl.style.position = 'relative';
    this.leftPanelInnerEl.style.willChange = 'transform';

    // Scroll container (ONLY scrollable element)
    this.scrollWrapEl = bodyWrapper.createDiv({ cls: 'vg-gantt-scroll-wrap' });
    this.scrollWrapEl.style.flex = '1';
    this.scrollWrapEl.style.overflow = 'auto';
    this.viewState.scrollEl = this.scrollWrapEl;

    const bodyInner = this.scrollWrapEl.createDiv({ cls: 'vg-gantt-body-inner' });
    bodyInner.style.position = 'relative';
    bodyInner.style.display = 'block';
    bodyInner.style.minHeight = '100%';
    this.bodyEl = bodyInner;

    // Today line (absolutely positioned, full height, z-index: 3)
    this.todayLineEl = this.scrollWrapEl.createDiv({ cls: 'vg-gantt-today-line' });
    this.todayLineEl.style.position = 'absolute';
    this.todayLineEl.style.top = '0';
    this.todayLineEl.style.bottom = '0';
    this.todayLineEl.style.width = '2px';
    this.todayLineEl.style.pointerEvents = 'none';
    this.todayLineEl.style.zIndex = '3';

    // rootEl now points to the body inner (for drag controller attachment and context menu)
    this.rootEl = bodyInner;
  }

  /**
   * Render header rows (month, day, day-of-week).
   * Renders into the header-inner (scrollable portion), which gets translated on scroll.
   */
  renderHeader(dates: string[]): void {
    if (!this.headerInnerEl) return;

    const monthRow = this.headerInnerEl.querySelector('.vg-gantt-month-row') as HTMLElement;
    const dayRow = this.headerInnerEl.querySelector('.vg-gantt-day-row') as HTMLElement;
    const dowRow = this.headerInnerEl.querySelector('.vg-gantt-dow-row') as HTMLElement;

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
    if (!this.bodyEl || !this.leftPanelInnerEl) return;

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

    // Re-order DOM only when the order has actually changed.
    const visiblePaths = sortedTasks
      .filter((r) => r.note.ganttEnabled)
      .map((r) => r.path);
    const domPaths = Array.from(this.bodyEl.children)
      .filter((el) => (el as HTMLElement).classList.contains('vg-gantt-timeline'))
      .map((el) => (el as HTMLElement).dataset.path ?? '');
    const needsReorder =
      domPaths.length !== visiblePaths.length ||
      visiblePaths.some((p, i) => p !== domPaths[i]);
    if (needsReorder) {
      for (const record of sortedTasks) {
        if (!record.note.ganttEnabled) continue;
        const row = this.rowMap.get(record.path);
        if (row) this.bodyEl.appendChild(row.rowEl);
      }

      // Also reorder in left panel
      const leftPaths = Array.from(this.leftPanelInnerEl.children)
        .map((el) => (el as HTMLElement).dataset.path ?? '');
      const leftNeedsReorder =
        leftPaths.length !== visiblePaths.length ||
        visiblePaths.some((p, i) => p !== leftPaths[i]);
      if (leftNeedsReorder) {
        for (const record of sortedTasks) {
          if (!record.note.ganttEnabled) continue;
          const row = this.rowMap.get(record.path);
          if (row) this.leftPanelInnerEl.appendChild(row.leftEl);
        }
      }
    }

    // Show/hide empty state
    if (visiblePaths.length === 0) {
      this.showEmptyState();
    } else {
      this.hideEmptyState();
    }
  }

  /**
   * Show empty state message.
   */
  private showEmptyState(): void {
    if (!this.bodyEl) return;

    let emptyEl = this.bodyEl.querySelector('.vg-gantt-empty') as HTMLElement | null;
    if (!emptyEl) {
      emptyEl = this.bodyEl.createDiv({ cls: 'vg-gantt-empty' });
      emptyEl.style.position = 'absolute';
      emptyEl.style.top = '50%';
      emptyEl.style.left = '50%';
      emptyEl.style.transform = 'translate(-50%, -50%)';
      emptyEl.createSpan({ text: 'タスクがありません' });
    }
    emptyEl.style.display = 'block';
  }

  /**
   * Hide empty state message.
   */
  private hideEmptyState(): void {
    if (!this.bodyEl) return;

    const emptyEl = this.bodyEl.querySelector('.vg-gantt-empty') as HTMLElement | null;
    if (emptyEl) {
      emptyEl.style.display = 'none';
    }
  }

  /**
   * Create a new parent row.
   * Creates two separate row elements: one in the left panel, one in the timeline.
   */
  createParentRow(record: TaskRecord, dates: string[]): void {
    if (!this.bodyEl || !this.leftPanelInnerEl) return;

    // Create timeline row in body
    const timelineDiv = this.bodyEl.createDiv({ cls: 'vg-gantt-timeline' });
    timelineDiv.setAttribute('data-path', record.path);
    timelineDiv.style.position = 'relative';
    timelineDiv.style.overflow = 'hidden';
    timelineDiv.style.borderBottom = '1px solid var(--background-modifier-border)';
    timelineDiv.style.display = 'flex';
    timelineDiv.style.alignItems = 'stretch';

    // Create left panel row (positioned absolutely)
    const leftDiv = this.leftPanelInnerEl.createDiv({ cls: 'vg-gantt-row-left' });
    leftDiv.setAttribute('data-path', record.path);
    leftDiv.style.position = 'relative';
    leftDiv.style.borderBottom = '1px solid var(--background-modifier-border)';
    leftDiv.style.padding = '0 0.5rem';
    leftDiv.style.overflow = 'hidden';
    leftDiv.style.display = 'flex';
    leftDiv.style.alignItems = 'center';

    const titleDiv = leftDiv.createDiv({ cls: 'vg-gantt-parent-title' });
    titleDiv.style.fontWeight = '500';
    titleDiv.style.whiteSpace = 'nowrap';
    titleDiv.style.overflow = 'hidden';
    titleDiv.style.textOverflow = 'ellipsis';
    titleDiv.style.fontSize = 'var(--font-ui-small)';
    titleDiv.createSpan({ text: record.note.displayName });

    // Wire up hover state sync between left panel and timeline (both directions)
    const addHover = (): void => { leftDiv.addClass('is-hover'); timelineDiv.addClass('is-hover'); };
    const removeHover = (): void => { leftDiv.removeClass('is-hover'); timelineDiv.removeClass('is-hover'); };
    timelineDiv.addEventListener('mouseenter', addHover);
    timelineDiv.addEventListener('mouseleave', removeHover);
    leftDiv.addEventListener('mouseenter', addHover);
    leftDiv.addEventListener('mouseleave', removeHover);

    this.rowMap.set(record.path, { rowEl: timelineDiv, leftEl: leftDiv, timelineEl: timelineDiv });
    this.renderBars(timelineDiv, record, dates);
    // Sync left panel row height to timeline row height set by renderBars (may vary by laneCount)
    leftDiv.style.height = timelineDiv.style.height;
  }

  /**
   * Update an existing parent row.
   * Updates both the left panel row and the timeline row.
   */
  updateParentRow(record: TaskRecord, dates: string[]): void {
    const row = this.rowMap.get(record.path);
    if (!row) return;

    // Sync the left-column title in case the task was renamed.
    const titleEl = row.leftEl.querySelector('.vg-gantt-parent-title');
    if (titleEl) {
      const span = titleEl.querySelector('span');
      if (span && span.textContent !== record.note.displayName) {
        span.textContent = record.note.displayName;
      }
    }

    // Clear bars and re-render
    const { timelineEl } = row;
    // Remove all bars and background columns, but keep the timeline div
    const barsToRemove = timelineEl.querySelectorAll('.vg-gantt-bar, .vg-gantt-bg-col');
    barsToRemove.forEach((el) => el.remove());

    this.renderBars(timelineEl, record, dates);
    // Sync left panel row height in case laneCount changed
    row.leftEl.style.height = timelineEl.style.height;
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
   * Set the width of all timeline elements and position the today line.
   */
  setTimelineWidth(dates: string[]): void {
    if (!this.headerInnerEl) return;

    const totalWidth = dates.length * this.viewState.dayWidth;

    this.headerInnerEl.style.width = `${totalWidth}px`;

    for (const { timelineEl } of this.rowMap.values()) {
      timelineEl.style.width = `${totalWidth}px`;
    }

    // Position today line
    this.updateTodayLine(dates);
  }

  /**
   * Update the position of the today vertical line.
   */
  private updateTodayLine(dates: string[]): void {
    if (!this.todayLineEl) return;

    const today = todayStr();
    const todayIndex = dates.indexOf(today);

    if (todayIndex >= 0) {
      const todayX = todayIndex * this.viewState.dayWidth;
      this.todayLineEl.style.left = `${todayX}px`;
      this.todayLineEl.style.visibility = 'visible';
    } else {
      this.todayLineEl.style.visibility = 'hidden';
    }
  }

  /**
   * Remove a parent row from the DOM and rowMap.
   */
  removeParentRow(path: string): void {
    const row = this.rowMap.get(path);
    if (!row) return;

    row.rowEl.remove();
    row.leftEl.remove();
    this.rowMap.delete(path);
  }
}

