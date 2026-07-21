import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import { addDays, diffDays, snapForward, snapBackward } from './gantt-date-utils';
import type { GanttViewState } from './gantt-view-state';

interface DragState {
  mode: 'bar-move' | 'resize-start' | 'resize-end';
  parentPath: string;
  subtaskKey: string;
  parentRevision: string;
  barEl: HTMLElement;
  startClientX: number;
  startLeft: number;
  startWidth: number;
  startDate: string;
  endDate: string;
  originalDuration: number;
  previewDeltaPx: number;
  tooltipEl: HTMLElement | null;
  rafId: number | null;
  // Document-level handlers stored for cleanup
  docMoveHandler: (e: PointerEvent) => void;
  docUpHandler: (e: PointerEvent) => void;
}

export class GanttDragController {
  private dragState: DragState | null = null;
  private getRecord: ((path: string) => TaskRecord | undefined) | null = null;

  constructor(
    private viewState: GanttViewState,
    private api: CoreTaskAPI,
    private onDragEnd: () => void,
    private onBarClick?: (parentPath: string, subtaskKey: string, barEl: HTMLElement) => void
  ) {}

  attach(containerEl: HTMLElement, getRecord: (path: string) => TaskRecord | undefined): void {
    this.getRecord = getRecord;
    containerEl.addEventListener('pointerdown', (evt) => this.handlePointerDown(evt));
  }

  detach(): void {
    this.getRecord = null;
    if (this.dragState) {
      const { rafId, tooltipEl, docMoveHandler, docUpHandler } = this.dragState;
      if (rafId) cancelAnimationFrame(rafId);
      tooltipEl?.remove();
      document.removeEventListener('pointermove', docMoveHandler);
      document.removeEventListener('pointerup', docUpHandler);
      document.removeEventListener('pointercancel', docUpHandler);
    }
    this.dragState = null;
  }

  private handlePointerDown(evt: PointerEvent): void {
    if (this.dragState) return;

    const target = evt.target as HTMLElement;
    const barEl = target.closest('.vg-gantt-bar') as HTMLElement | null;
    if (!barEl) return;

    const parentPath = barEl.getAttribute('data-path');
    const subtaskKey = barEl.getAttribute('data-key');
    if (!parentPath || !subtaskKey) return;

    const record = this.getRecord?.(parentPath);
    if (!record) return;

    let mode: 'bar-move' | 'resize-start' | 'resize-end' | null = null;
    if (target.closest('.vg-gantt-bar-handle.is-start')) {
      mode = 'resize-start';
    } else if (target.closest('.vg-gantt-bar-handle.is-end')) {
      mode = 'resize-end';
    } else if (target.closest('.vg-gantt-bar')) {
      mode = 'bar-move';
    }
    if (!mode) return;

    const startDate = barEl.dataset.startDate;
    const endDate = barEl.dataset.endDate;
    if (!startDate || !endDate) return;

    // preventDefault stops text-selection / scroll on drag.
    // Do NOT call setPointerCapture on barEl — Chromium scrolls the element
    // into view when capturing on a partially-off-screen element, which causes
    // the "click jumps timeline to the left" bug. We use document-level
    // listeners instead so we track the pointer regardless of where it moves.
    evt.preventDefault();

    const docMoveHandler = (e: PointerEvent): void => this.handlePointerMove(e);
    const docUpHandler   = (): void => void this.handlePointerUp();

    document.addEventListener('pointermove', docMoveHandler);
    document.addEventListener('pointerup',   docUpHandler);
    document.addEventListener('pointercancel', docUpHandler);

    const tooltip = document.createElement('div');
    tooltip.className = 'vg-gantt-drag-tooltip';
    document.body.appendChild(tooltip);

    barEl.classList.add('is-dragging');

    this.dragState = {
      mode,
      parentPath,
      subtaskKey,
      parentRevision: record.revision,
      barEl,
      startClientX: evt.clientX,
      startLeft: barEl.offsetLeft,
      startWidth: barEl.offsetWidth,
      startDate,
      endDate,
      originalDuration: diffDays(startDate, endDate),
      previewDeltaPx: 0,
      tooltipEl: tooltip,
      rafId: null,
      docMoveHandler,
      docUpHandler,
    };
  }

  private handlePointerMove(evt: PointerEvent): void {
    if (!this.dragState) return;

    const deltaPx = evt.clientX - this.dragState.startClientX;
    this.dragState.previewDeltaPx = deltaPx;

    if (this.dragState.rafId !== null) {
      cancelAnimationFrame(this.dragState.rafId);
    }
    this.dragState.rafId = requestAnimationFrame(() => this.applyPreview());
  }

  private applyPreview(): void {
    if (!this.dragState) return;

    const { barEl, mode, previewDeltaPx, startLeft, startWidth, startDate, endDate, tooltipEl } =
      this.dragState;
    if (!tooltipEl) return;

    const deltaDays = Math.round(previewDeltaPx / this.viewState.dayWidth);
    let previewStart = startDate;
    let previewEnd = endDate;

    if (mode === 'bar-move') {
      previewStart = addDays(startDate, deltaDays);
      previewEnd = addDays(endDate, deltaDays);
      barEl.style.transform = `translateX(${previewDeltaPx}px)`;
    } else if (mode === 'resize-start') {
      previewStart = addDays(startDate, deltaDays);
      barEl.style.left = `${startLeft + previewDeltaPx}px`;
      barEl.style.width = `${Math.max(8, startWidth - previewDeltaPx)}px`;
    } else if (mode === 'resize-end') {
      previewEnd = addDays(endDate, deltaDays);
      barEl.style.width = `${Math.max(8, startWidth + previewDeltaPx)}px`;
    }

    tooltipEl.style.left = `${this.dragState.startClientX + previewDeltaPx}px`;
    tooltipEl.style.top  = `${barEl.getBoundingClientRect().top - 30}px`;
    tooltipEl.textContent = `${previewStart} — ${previewEnd}`;
    tooltipEl.classList.add('is-visible');
  }

  private async handlePointerUp(): Promise<void> {
    if (!this.dragState) return;

    const dragState = this.dragState;
    this.dragState = null;

    const {
      barEl, mode, previewDeltaPx, startDate, endDate, originalDuration,
      tooltipEl, parentPath, subtaskKey, parentRevision,
      docMoveHandler, docUpHandler, rafId,
    } = dragState;

    // Clean up document-level handlers and animation frame
    document.removeEventListener('pointermove', docMoveHandler);
    document.removeEventListener('pointerup',   docUpHandler);
    document.removeEventListener('pointercancel', docUpHandler);
    if (rafId !== null) cancelAnimationFrame(rafId);

    barEl.classList.remove('is-dragging');
    tooltipEl?.remove();

    const deltaDays = Math.round(previewDeltaPx / this.viewState.dayWidth);

    if (deltaDays === 0) {
      barEl.style.transform = '';
      barEl.style.left = '';
      barEl.style.width = '';
      // No actual movement = treat as a click on the bar body (not resize handles)
      if (mode === 'bar-move') {
        this.onBarClick?.(parentPath, subtaskKey, barEl);
      }
      return;
    }

    let newStart = startDate;
    let newEnd = endDate;

    if (mode === 'bar-move') {
      const rawStart = addDays(startDate, deltaDays);
      newStart = snapForward(rawStart);
      newEnd = addDays(newStart, originalDuration);
    } else if (mode === 'resize-start') {
      newStart = snapForward(addDays(startDate, deltaDays));
    } else if (mode === 'resize-end') {
      newEnd = snapBackward(addDays(endDate, deltaDays));
    }

    if (newStart > newEnd) {
      barEl.style.transform = '';
      barEl.style.left = '';
      barEl.style.width = '';
      return;
    }

    const result = await this.api.updateTaskItem({
      path: parentPath,
      expectedRevision: parentRevision,
      subtasks: [{ key: subtaskKey, fields: { plannedStartDate: newStart, plannedEndDate: newEnd } }],
    });

    if (!result.ok) {
      // Force reload on failure so the timeline stays consistent with the vault.
      barEl.style.transform = '';
      barEl.style.left = '';
      barEl.style.width = '';
      this.onDragEnd();
    }
    // On success: leave inline preview styles in place.
    // The API write notifies subscribers → debounced reload clears them naturally.
    // Calling onDragEnd() here would cause a double-render.
  }
}
