import type { TaskRecord } from '../../application/core-task-api';
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
  isMonthStart,
  monthTitle,
  todayStr,
} from './gantt-date-utils';
import type { GanttViewState } from './gantt-view-state';

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

      // Month cell
      const monthCell = monthRow.createDiv({ cls: 'vg-gantt-date-cell vg-gantt-month-cell' });
      monthCell.style.width = `${w}px`;
      if (isMonthStart(date, i)) {
        monthCell.createSpan({ text: monthTitle(date) });
      }
      if (weekend) monthCell.addClass('is-weekend');

      // Day cell
      const dayCell = dayRow.createDiv({ cls: 'vg-gantt-date-cell' });
      dayCell.style.width = `${w}px`;
      dayCell.createSpan({ text: dateLabel(date, 'D') });
      if (weekend) dayCell.addClass('is-weekend');
      if (date === today) dayCell.addClass('is-today');

      // Day-of-week cell
      const dowCell = dowRow.createDiv({ cls: 'vg-gantt-date-cell' });
      dowCell.style.width = `${w}px`;
      dowCell.createSpan({ text: dateLabel(date, 'dd') });
      if (weekend) dowCell.addClass('is-weekend');
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
    if (
      cachedRev === record.revision &&
      cachedBase === dates[0] &&
      cachedZoom === String(this.viewState.dayWidth)
    ) {
      return;
    }

    timelineEl.querySelectorAll('.vg-gantt-bar, .vg-gantt-bg-col').forEach((el) => el.remove());
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
  }

  private renderBars(timelineEl: HTMLElement, record: TaskRecord, dates: string[]): void {
    const { bars, laneCount } = packSubtasksIntoLanes(record.note.subtasks);
    const today = todayStr();

    // Background columns (weekends and today)
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const weekend = isWeekendDate(date);
      if (!weekend && date !== today) continue;
      const col = timelineEl.createDiv({ cls: `vg-gantt-bg-col${weekend ? ' is-weekend' : ''}${date === today ? ' is-today' : ''}` });
      col.style.left = `${i * this.viewState.dayWidth}px`;
      col.style.width = `${this.viewState.dayWidth}px`;
    }

    // Render bars (subtasks)
    for (const bar of bars) {
      const left = barLeftPx(dates[0], bar.start, this.viewState.dayWidth);
      const width = barWidthPx(bar.start, bar.end, this.viewState.dayWidth);
      const top = laneTopPx(bar.lane, LANE_BASE_HEIGHT) + (LANE_BASE_HEIGHT - BAR_HEIGHT) / 2;

      const barEl = timelineEl.createDiv({ cls: 'vg-gantt-bar' });
      barEl.style.left = `${left}px`;
      barEl.style.width = `${width}px`;
      barEl.style.top = `${top}px`;
      barEl.style.height = `${BAR_HEIGHT}px`;
      barEl.setAttribute('data-path', record.path);
      barEl.setAttribute('data-key', bar.subtask.key);
      barEl.dataset.startDate = bar.start;
      barEl.dataset.endDate = bar.end;

      // Hover date labels
      const dateStart = barEl.createDiv({ cls: 'vg-gantt-bar-date-start', text: bar.start });
      dateStart.style.left = '0';
      const dateEnd = barEl.createDiv({ cls: 'vg-gantt-bar-date-end', text: bar.end });
      dateEnd.style.right = '0';

      // Label
      barEl.createDiv({ cls: 'vg-gantt-bar-label', text: bar.subtask.title });

      // Resize handles
      const hs = barEl.createDiv({ cls: 'vg-gantt-bar-handle is-start' });
      hs.style.width = `${BAR_RESIZE_HANDLE_WIDTH}px`;
      const he = barEl.createDiv({ cls: 'vg-gantt-bar-handle is-end' });
      he.style.width = `${BAR_RESIZE_HANDLE_WIDTH}px`;
    }

    // Set timeline row height
    timelineEl.style.height = `${laneTopPx(laneCount, LANE_BASE_HEIGHT) + 16}px`;
  }

  removeRow(path: string): void {
    const row = this.rowMap.get(path);
    if (!row) return;
    row.leftEl.remove();
    row.timelineEl.remove();
    this.rowMap.delete(path);
  }

  updateFloatingMonth(dates: string[]): void {
    if (!this.floatingMonthEl || !this.wrapEl) return;
    const idx = Math.max(0, Math.min(dates.length - 1, Math.floor(this.wrapEl.scrollLeft / this.viewState.dayWidth)));
    const title = monthTitle(dates[idx]);
    if (this.floatingMonthEl.textContent !== title) this.floatingMonthEl.textContent = title;
  }
}
