import type { TaskRecord } from '../../application/core-task-api';
import type { GanttEvent } from '../../settings';
import {
  LANE_BASE_HEIGHT,
  BAR_HEIGHT,
  PARENT_COL_WIDTH,
  BAR_RESIZE_HANDLE_WIDTH,
  HEADER_HEIGHT,
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
  isHoliday,
  isMonthStart,
  monthTitle,
  todayStr,
  addDays,
} from './gantt-date-utils';
import { tagColor } from './gantt-tag-colors';
import type { GanttViewState } from './gantt-view-state';

const MIN_LABEL_WIDTH = 52; // px — narrower bars get external label
const MARKER_H = 12;        // px — extra height per row when markers are present

/**
 * GanttRenderer renders the Gantt chart using CSS Grid with sticky columns.
 * Architecture:
 * - containerEl (passed to mount) = vg-gantt-container
 *   - toolbar (added by GanttView)
 *   - wrapEl (scroll container, THE ONLY ONE)
 *     - gridEl (CSS Grid: 2 columns)
 *       - header-left (sticky left, top)
 *       - header-timeline (sticky top)
 *         - floating-month
 *         - month-row, day-row, dow-row
 *       - For each task:
 *         - leftEl (sticky left)
 *         - timelineEl (position: relative, contains bars)
 */
export class GanttRenderer {
  ganttEl: HTMLElement | null = null;       // = containerEl (toolbar mounted inside)
  wrapEl: HTMLElement | null = null;        // scroll container
  gridEl: HTMLElement | null = null;        // CSS Grid
  floatingMonthEl: HTMLElement | null = null;
  rootEl: HTMLElement | null = null;        // = gridEl (for drag controller + contextmenu)
  dragTooltipEl: HTMLElement | null = null; // fixed tooltip inside document.body

  /** Called when parent rows are reordered via DnD. Receives new ordered array of paths. */
  onRowReorder?: (orderedPaths: string[]) => void;

  /** When set, only render bars whose subtask.tags includes this tag (others are hidden). */
  tagFilter: string | null = null;

  /** When true, render Japanese holidays like weekends (grey background). */
  enableHolidays = true;

  /** Controls whether the event row is shown even with zero events. Default: false. */
  showEventRow = false;

  private rowMap = new Map<string, {
    leftEl: HTMLElement;
    timelineEl: HTMLElement;
  }>();
  private rowIndex = 0; // for alternating row colors
  private dndDragPath: string | null = null; // path being dragged

  constructor(private viewState: GanttViewState) {}

  mount(containerEl: HTMLElement): void {
    containerEl.empty();
    containerEl.addClass('vg-gantt-container');
    this.ganttEl = containerEl;

    // Scroll container (THE ONLY ONE)
    this.wrapEl = containerEl.createDiv({ cls: 'vg-gantt-wrap' });
    this.viewState.scrollEl = this.wrapEl;

    // CSS Grid container
    this.gridEl = this.wrapEl.createDiv({ cls: 'vg-gantt-grid' });
    this.gridEl.style.setProperty('--vg-left-width', `${PARENT_COL_WIDTH}px`);
    this.gridEl.style.setProperty('--vg-header-height', `${HEADER_HEIGHT}px`);
    this.rootEl = this.gridEl;

    // Drag tooltip (fixed, outside scroll hierarchy)
    this.dragTooltipEl = document.body.createDiv({ cls: 'vg-gantt-drag-tooltip' });
  }

  unmount(): void {
    this.dragTooltipEl?.remove();
    this.dragTooltipEl = null;
  }

  renderHeader(dates: string[]): void {
    if (!this.gridEl) return;

    // Remove existing header cells
    this.gridEl.querySelector('.vg-gantt-header-left')?.remove();
    this.gridEl.querySelector('.vg-gantt-header-timeline')?.remove();

    // Header left (sticky top + left)
    const headerLeft = this.gridEl.createDiv({ cls: 'vg-gantt-left vg-gantt-header-left' });
    headerLeft.createSpan({ text: '親タスク', cls: 'vg-gantt-header-left-label' });
    this.gridEl.prepend(headerLeft); // must be first child

    // Header timeline (sticky top)
    const headerTimeline = this.gridEl.createDiv({ cls: 'vg-gantt-header-timeline' });
    headerTimeline.style.width = `${dates.length * this.viewState.dayWidth}px`;
    this.gridEl.insertBefore(headerTimeline, headerLeft.nextSibling);

    // Floating month (inside header-timeline)
    this.floatingMonthEl = headerTimeline.createDiv({ cls: 'vg-gantt-floating-month' });

    // Create header rows
    const monthRow = headerTimeline.createDiv({ cls: 'vg-gantt-month-row' });
    const dayRow = headerTimeline.createDiv({ cls: 'vg-gantt-day-row' });
    const dowRow = headerTimeline.createDiv({ cls: 'vg-gantt-dow-row' });

    const today = todayStr();
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const weekend = isWeekendDate(date);
      const w = this.viewState.dayWidth;

      const holiday = this.enableHolidays && isHoliday(date);
      const nonwork = weekend || holiday;

      // Month cell
      const monthCell = monthRow.createDiv({ cls: 'vg-gantt-date-cell vg-gantt-month-cell' });
      monthCell.style.width = `${w}px`;
      monthCell.dataset.date = date;
      if (isMonthStart(date, i)) {
        monthCell.createSpan({ text: monthTitle(date) });
      }
      if (nonwork) monthCell.addClass('is-weekend');

      // Day cell
      const dayCell = dayRow.createDiv({ cls: 'vg-gantt-date-cell' });
      dayCell.style.width = `${w}px`;
      dayCell.dataset.date = date;
      dayCell.createSpan({ text: dateLabel(date, 'D') });
      if (nonwork) dayCell.addClass('is-weekend');
      if (date === today) dayCell.addClass('is-today');
      if (holiday) dayCell.addClass('is-holiday');

      // Day-of-week cell
      const dowCell = dowRow.createDiv({ cls: 'vg-gantt-date-cell' });
      dowCell.style.width = `${w}px`;
      dowCell.dataset.date = date;
      dowCell.createSpan({ text: dateLabel(date, 'dd') });
      if (nonwork) dowCell.addClass('is-weekend');
    }

    this.updateFloatingMonth(dates);
  }

  renderAll(tasks: TaskRecord[], dates: string[]): void {
    if (!this.gridEl) return;

    const existingPaths = new Set(tasks.map((t) => t.path));

    // Remove rows for tasks no longer in the list
    for (const path of Array.from(this.rowMap.keys())) {
      if (!existingPaths.has(path)) this.removeRow(path);
    }

    // Sort tasks
    const sorted = [...tasks]
      .filter((t) => t.note.ganttEnabled)
      .sort((a, b) => {
        const o = a.note.ganttOrder - b.note.ganttOrder;
        return o !== 0 ? o : a.note.displayName.localeCompare(b.note.displayName);
      });

    // Remove disabled tasks
    for (const t of tasks) {
      if (!t.note.ganttEnabled) this.removeRow(t.path);
    }

    this.rowIndex = 0;
    for (const record of sorted) {
      if (this.rowMap.has(record.path)) {
        this.updateRow(record, dates);
      } else {
        this.createRow(record, dates);
      }
      this.rowIndex++;
    }

    // Re-order DOM rows to match sorted order
    const headerLeft = this.gridEl.querySelector('.vg-gantt-header-left');
    const headerTimeline = this.gridEl.querySelector('.vg-gantt-header-timeline');
    for (const record of sorted) {
      const row = this.rowMap.get(record.path);
      if (!row) continue;
      this.gridEl.appendChild(row.leftEl);
      this.gridEl.appendChild(row.timelineEl);
    }
    // Keep headers first
    if (headerLeft) this.gridEl.prepend(headerLeft);
    if (headerTimeline && headerLeft) {
      headerLeft.after(headerTimeline);
    }

    // Show/hide empty state
    if (sorted.length === 0) {
      if (!this.gridEl.querySelector('.vg-gantt-empty')) {
        this.gridEl.createDiv({ cls: 'vg-gantt-empty', text: 'タスクがありません' });
      }
    } else {
      this.gridEl.querySelector('.vg-gantt-empty')?.remove();
    }
  }

  setTimelineWidth(dates: string[]): void {
    const w = dates.length * this.viewState.dayWidth;
    const headerTimeline = this.gridEl?.querySelector('.vg-gantt-header-timeline') as HTMLElement | null;
    if (headerTimeline) headerTimeline.style.width = `${w}px`;
    for (const { timelineEl } of this.rowMap.values()) {
      timelineEl.style.width = `${w}px`;
    }
  }

  private createRow(record: TaskRecord, dates: string[]): void {
    if (!this.gridEl) return;
    const even = this.rowIndex % 2 === 1;

    // Left column (sticky)
    const leftEl = this.gridEl.createDiv({ cls: `vg-gantt-left vg-gantt-parent-left${even ? ' is-even' : ''}` });
    leftEl.setAttribute('data-path', record.path);

    // Drag handle + title
    const dragHandle = leftEl.createDiv({ cls: 'vg-gantt-drag-handle', attr: { title: 'ドラッグで並べ替え' } });
    dragHandle.textContent = '⠿';
    leftEl.createDiv({ cls: 'vg-gantt-parent-title', text: record.note.displayName });

    // Timeline column
    const timelineEl = this.gridEl.createDiv({ cls: `vg-gantt-timeline${even ? ' is-even' : ''}` });
    timelineEl.setAttribute('data-path', record.path);

    // Hover sync
    const addHover = () => {
      leftEl.addClass('is-hover');
      timelineEl.addClass('is-hover');
    };
    const removeHover = () => {
      leftEl.removeClass('is-hover');
      timelineEl.removeClass('is-hover');
    };
    leftEl.addEventListener('mouseenter', addHover);
    leftEl.addEventListener('mouseleave', removeHover);
    timelineEl.addEventListener('mouseenter', addHover);
    timelineEl.addEventListener('mouseleave', removeHover);

    // Row DnD reorder
    leftEl.setAttribute('draggable', 'true');
    leftEl.addEventListener('dragstart', (e) => {
      this.dndDragPath = record.path;
      leftEl.addClass('is-dnd-dragging');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    leftEl.addEventListener('dragend', () => {
      this.dndDragPath = null;
      this.clearDndOver();
      leftEl.removeClass('is-dnd-dragging');
    });
    leftEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.dndDragPath && this.dndDragPath !== record.path) {
        this.clearDndOver();
        leftEl.addClass('is-dnd-over');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      }
    });
    leftEl.addEventListener('dragleave', () => leftEl.removeClass('is-dnd-over'));
    leftEl.addEventListener('drop', (e) => {
      e.preventDefault();
      leftEl.removeClass('is-dnd-over');
      if (!this.dndDragPath || this.dndDragPath === record.path) return;
      this.fireReorder(this.dndDragPath, record.path);
      this.dndDragPath = null;
    });

    this.rowMap.set(record.path, { leftEl, timelineEl });
    this.renderBarsAndCache(timelineEl, leftEl, record, dates);
  }

  private clearDndOver(): void {
    this.gridEl?.querySelectorAll('.is-dnd-over').forEach((el) => el.classList.remove('is-dnd-over'));
  }

  private fireReorder(draggedPath: string, targetPath: string): void {
    if (!this.onRowReorder) return;
    // Build current order from DOM child order
    const orderedPaths: string[] = [];
    for (const [path] of this.rowMap) {
      orderedPaths.push(path);
    }
    // Move draggedPath to before targetPath in the array
    const fromIdx = orderedPaths.indexOf(draggedPath);
    const toIdx = orderedPaths.indexOf(targetPath);
    if (fromIdx === -1 || toIdx === -1) return;
    orderedPaths.splice(fromIdx, 1);
    orderedPaths.splice(toIdx, 0, draggedPath);
    this.onRowReorder(orderedPaths);
  }

  private updateRow(record: TaskRecord, dates: string[]): void {
    const row = this.rowMap.get(record.path);
    if (!row) return;
    const { leftEl, timelineEl } = row;

    // Update even/odd class
    const even = this.rowIndex % 2 === 1;
    leftEl.toggleClass('is-even', even);
    timelineEl.toggleClass('is-even', even);

    // Title sync (cheap)
    const titleEl = leftEl.querySelector('.vg-gantt-parent-title') as HTMLElement | null;
    if (titleEl && titleEl.textContent !== record.note.displayName) {
      titleEl.textContent = record.note.displayName;
    }

    // Skip bar re-render when nothing visual changed
    const cachedRev = timelineEl.dataset.revision;
    const cachedBase = timelineEl.dataset.baseDate;
    const cachedZoom = timelineEl.dataset.dayWidth;
    const cachedTag = timelineEl.dataset.tagFilter ?? '';
    if (
      cachedRev === record.revision &&
      cachedBase === dates[0] &&
      cachedZoom === String(this.viewState.dayWidth) &&
      cachedTag === (this.tagFilter ?? '')
    ) {
      return;
    }

    timelineEl.querySelectorAll(
      '.vg-gantt-bar, .vg-gantt-bg-col, .vg-gantt-bar-ext-label, .vg-gantt-marker, .vg-gantt-due-line'
    ).forEach((el) => el.remove());
    this.renderBarsAndCache(timelineEl, leftEl, record, dates);
  }

  private renderBarsAndCache(
    timelineEl: HTMLElement,
    leftEl: HTMLElement,
    record: TaskRecord,
    dates: string[],
  ): void {
    this.renderBars(timelineEl, record, dates);
    leftEl.style.height = timelineEl.style.height;
    timelineEl.dataset.revision = record.revision;
    timelineEl.dataset.baseDate = dates[0];
    timelineEl.dataset.dayWidth = String(this.viewState.dayWidth);
    timelineEl.dataset.tagFilter = this.tagFilter ?? '';
  }

  private renderBars(timelineEl: HTMLElement, record: TaskRecord, dates: string[]): void {
    const { bars, laneCount } = packSubtasksIntoLanes(record.note.subtasks);
    const today = todayStr();
    const lastDate = dates[dates.length - 1] ?? dates[0];

    // Background columns (weekends, holidays, today)
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const weekend = isWeekendDate(date);
      const holiday = this.enableHolidays && isHoliday(date);
      const isToday = date === today;
      if (!weekend && !holiday && !isToday) continue;
      const cls = [
        'vg-gantt-bg-col',
        (weekend || holiday) ? 'is-weekend' : '',
        isToday ? 'is-today' : '',
      ].filter(Boolean).join(' ');
      const col = timelineEl.createDiv({ cls });
      col.style.left = `${i * this.viewState.dayWidth}px`;
      col.style.width = `${this.viewState.dayWidth}px`;
    }

    // Parent due date ★ vertical line
    if (record.note.dueDate && record.note.dueDate >= dates[0] && record.note.dueDate <= lastDate) {
      const dueLeft = barLeftPx(dates[0], record.note.dueDate, this.viewState.dayWidth);
      const dueLine = timelineEl.createDiv({ cls: 'vg-gantt-due-line' });
      dueLine.style.left = `${dueLeft}px`;
      dueLine.title = `期限: ${record.note.dueDate}`;
      dueLine.createSpan({ cls: 'vg-gantt-due-star', text: '★' });
    }

    const hasMarkers = bars.some(
      (b) => b.subtask.markers.length > 0 &&
             (!this.tagFilter || b.subtask.tags.includes(this.tagFilter))
    );

    // Render bars (subtasks)
    for (const bar of bars) {
      // Tag filter: skip bars that don't match
      if (this.tagFilter && !bar.subtask.tags.includes(this.tagFilter)) continue;

      const left = barLeftPx(dates[0], bar.start, this.viewState.dayWidth);
      const width = barWidthPx(bar.start, bar.end, this.viewState.dayWidth);
      const top = laneTopPx(bar.lane, LANE_BASE_HEIGHT) + (LANE_BASE_HEIGHT - BAR_HEIGHT) / 2;
      const isNarrow = width < MIN_LABEL_WIDTH;

      const barEl = timelineEl.createDiv({ cls: 'vg-gantt-bar' });
      barEl.style.left = `${left}px`;
      barEl.style.width = `${width}px`;
      barEl.style.top = `${top}px`;
      barEl.style.height = `${BAR_HEIGHT}px`;
      barEl.setAttribute('data-path', record.path);
      barEl.setAttribute('data-key', bar.subtask.key);
      barEl.dataset.startDate = bar.start;
      barEl.dataset.endDate = bar.end;

      // Tag color
      if (!bar.subtask.completed && bar.subtask.tags.length > 0) {
        barEl.style.background = tagColor(bar.subtask.tags[0]);
      }
      if (bar.subtask.completed) barEl.addClass('is-completed');

      // Hover date labels
      barEl.createDiv({ cls: 'vg-gantt-bar-date-start', text: bar.start });
      barEl.createDiv({ cls: 'vg-gantt-bar-date-end', text: bar.end });

      if (!isNarrow) {
        // Label inside bar
        barEl.createDiv({ cls: 'vg-gantt-bar-label', text: bar.subtask.title });
        // Additional tag dots (for tags beyond first)
        if (!bar.subtask.completed && bar.subtask.tags.length > 1 && width >= 100) {
          const dots = barEl.createDiv({ cls: 'vg-gantt-bar-dots' });
          bar.subtask.tags.slice(1, 3).forEach((tag) => {
            const dot = dots.createDiv({ cls: 'vg-gantt-bar-dot' });
            dot.style.background = tagColor(tag);
            dot.title = tag;
          });
        }
      } else {
        // Narrow bar: external label (not inside barEl, so it's always visible)
        const extLabel = timelineEl.createDiv({ cls: 'vg-gantt-bar-ext-label' });
        extLabel.textContent = bar.subtask.title;
        extLabel.style.left = `${left + width + 3}px`;
        extLabel.style.top = `${top + (BAR_HEIGHT - 12) / 2}px`;
      }

      // Resize handles
      const hs = barEl.createDiv({ cls: 'vg-gantt-bar-handle is-start' });
      hs.style.width = `${BAR_RESIZE_HANDLE_WIDTH}px`;
      const he = barEl.createDiv({ cls: 'vg-gantt-bar-handle is-end' });
      he.style.width = `${BAR_RESIZE_HANDLE_WIDTH}px`;

      // Milestone markers (▲) below this bar
      for (const marker of bar.subtask.markers) {
        if (!marker.date || marker.date < dates[0] || marker.date > lastDate) continue;
        const ml = barLeftPx(dates[0], marker.date, this.viewState.dayWidth) + this.viewState.dayWidth / 2 - 6;
        const mt = top + BAR_HEIGHT + 3;
        const markerEl = timelineEl.createDiv({ cls: 'vg-gantt-marker' });
        markerEl.textContent = '▲';
        markerEl.style.left = `${ml}px`;
        markerEl.style.top = `${mt}px`;
        markerEl.setAttribute('data-path', record.path);
        markerEl.setAttribute('data-key', bar.subtask.key);
        markerEl.setAttribute('data-marker-key', marker.key);
        markerEl.title = marker.title ? `${marker.title} (${marker.date})` : marker.date;
      }
    }

    // Set timeline row height (add space for markers if needed)
    const extraH = hasMarkers ? MARKER_H + 4 : 0;
    timelineEl.style.height = `${laneTopPx(laneCount, LANE_BASE_HEIGHT) + 16 + extraH}px`;
  }

  removeRow(path: string): void {
    const row = this.rowMap.get(path);
    if (!row) return;
    row.leftEl.remove();
    row.timelineEl.remove();
    this.rowMap.delete(path);
  }

  renderEventRow(dates: string[], events: GanttEvent[]): void {
    if (!this.gridEl) return;

    // Remove existing event row
    this.gridEl.querySelector('.vg-gantt-event-row-left')?.remove();
    this.gridEl.querySelector('.vg-gantt-event-row-timeline')?.remove();

    if (events.length === 0 && !this.showEventRow) return; // always show if explicitly enabled

    const w = this.viewState.dayWidth;

    // Left label cell (sticky)
    const leftEl = this.gridEl.createDiv({ cls: 'vg-gantt-left vg-gantt-event-row-left' });
    leftEl.createSpan({ text: 'イベント', cls: 'vg-gantt-event-row-label' });

    // Timeline cell
    const timelineEl = this.gridEl.createDiv({ cls: 'vg-gantt-event-row-timeline' });
    timelineEl.style.width = `${dates.length * w}px`;
    timelineEl.style.position = 'relative';
    timelineEl.style.height = '28px';

    // Store date range for click-to-add
    timelineEl.dataset.startDate = dates[0];
    timelineEl.dataset.endDate = dates[dates.length - 1];

    // Render each event as a ◆ chip
    for (const event of events) {
      const idx = dates.indexOf(event.date);
      if (idx < 0) continue; // outside visible range

      const chip = timelineEl.createDiv({ cls: 'vg-gantt-event-chip' });
      chip.style.left = `${idx * w}px`;
      chip.dataset.eventKey = event.key;
      chip.title = `${event.date} ${event.title}`;
      if (event.color) chip.style.color = event.color;

      // ◆ diamond + label
      chip.createSpan({ text: '◆', cls: 'vg-gantt-event-diamond' });
      chip.createSpan({ text: event.title, cls: 'vg-gantt-event-label' });
    }

    // Insert event row right after the header (before task rows)
    const headerTimeline = this.gridEl.querySelector('.vg-gantt-header-timeline');
    const headerLeft = this.gridEl.querySelector('.vg-gantt-header-left');
    if (headerTimeline && headerLeft) {
      headerTimeline.after(leftEl);
      leftEl.after(timelineEl);
    } else {
      this.gridEl.prepend(timelineEl);
      this.gridEl.prepend(leftEl);
    }
  }

  renderWorkloadRow(dates: string[], tasks: TaskRecord[]): void {
    if (!this.gridEl) return;

    // Remove existing workload row
    this.gridEl.querySelector('.vg-gantt-workload-row-left')?.remove();
    this.gridEl.querySelector('.vg-gantt-workload-row-timeline')?.remove();

    // Compute daily plan totals (only for gantt-enabled tasks)
    const enabledTasks = tasks.filter((t) => t.note.ganttEnabled);
    if (enabledTasks.length === 0) return;

    // Check if any task has workload data at all
    const hasAnyWorkload = enabledTasks.some((t) =>
      t.note.subtasks.some((s) => Object.keys(s.workloadPlan).length > 0)
    );
    if (!hasAnyWorkload) return; // Don't show row if no data

    const totals = new Map<string, number>();
    for (const date of dates) {
      let sum = 0;
      for (const t of enabledTasks) {
        for (const s of t.note.subtasks) {
          sum += s.workloadPlan[date] ?? 0;
        }
      }
      if (sum > 0) totals.set(date, sum);
    }

    const w = this.viewState.dayWidth;

    // Left label
    const leftEl = this.gridEl.createDiv({ cls: 'vg-gantt-left vg-gantt-workload-row-left' });
    leftEl.createSpan({ text: '計画時間', cls: 'vg-gantt-workload-row-label' });

    // Timeline
    const timelineEl = this.gridEl.createDiv({ cls: 'vg-gantt-workload-row-timeline' });
    timelineEl.style.width = `${dates.length * w}px`;
    timelineEl.style.position = 'relative';
    timelineEl.style.height = '24px';

    // Render each day's total as a colored chip
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const total = totals.get(date);
      if (!total) continue;

      const chip = timelineEl.createDiv({ cls: 'vg-gantt-workload-chip' });
      chip.style.left = `${i * w}px`;
      chip.style.width = `${w}px`;
      chip.title = `${date}: ${total}h`;
      chip.createSpan({ text: String(total) });

      // Color based on load
      if (total >= 8) chip.addClass('is-overload');
      else if (total >= 6) chip.addClass('is-heavy');
      else chip.addClass('is-normal');
    }

    // Insert after event row (or after header if no event row)
    const eventTimeline = this.gridEl.querySelector('.vg-gantt-event-row-timeline');
    const eventLeft = this.gridEl.querySelector('.vg-gantt-event-row-left');
    const headerTimeline = this.gridEl.querySelector('.vg-gantt-header-timeline');

    if (eventTimeline && eventLeft) {
      eventTimeline.after(leftEl);
      leftEl.after(timelineEl);
    } else if (headerTimeline) {
      headerTimeline.after(leftEl);
      leftEl.after(timelineEl);
    } else {
      this.gridEl.prepend(timelineEl);
      this.gridEl.prepend(leftEl);
    }
  }

  updateFloatingMonth(dates: string[]): void {
    if (!this.floatingMonthEl || !this.wrapEl) return;
    const idx = Math.max(0, Math.min(dates.length - 1, Math.floor(this.wrapEl.scrollLeft / this.viewState.dayWidth)));
    const title = monthTitle(dates[idx]);
    if (this.floatingMonthEl.textContent !== title) this.floatingMonthEl.textContent = title;
  }
}
