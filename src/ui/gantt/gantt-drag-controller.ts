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
  pointerMoveHandler: (e: PointerEvent) => void;
}

/**
 * GanttDragController handles pointer-based drag interactions for bar movement and resizing.
 */
export class GanttDragController {
  private dragState: DragState | null = null;
  private getRecord: ((path: string) => TaskRecord | undefined) | null = null;

  constructor(
    private viewState: GanttViewState,
    private api: CoreTaskAPI,
    private onDragEnd: () => void
  ) {}

  /**
   * Attach drag controller to a container element with event delegation.
   */
  attach(containerEl: HTMLElement, getRecord: (path: string) => TaskRecord | undefined): void {
    this.getRecord = getRecord;

    containerEl.addEventListener('pointerdown', (evt) => this.handlePointerDown(evt));
  }

  /**
   * Detach drag controller and clean up event listeners.
   */
  detach(): void {
    this.getRecord = null;
    if (this.dragState) {
      if (this.dragState.rafId) cancelAnimationFrame(this.dragState.rafId);
      this.dragState.barEl.removeEventListener('pointermove', this.dragState.pointerMoveHandler);
      this.dragState.tooltipEl?.remove();
    }
    this.dragState = null;
  }

  private handlePointerDown(evt: PointerEvent): void {
    if (this.dragState) return; // Already dragging

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

    evt.preventDefault();
    barEl.setPointerCapture((evt as PointerEvent).pointerId);

    const pointerMoveHandler = (evt2: PointerEvent) => this.handlePointerMove(evt2);

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
      tooltipEl: null,
      rafId: null,
      pointerMoveHandler,
    };

    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'vg-gantt-drag-tooltip';
    tooltip.style.position = 'fixed';
    tooltip.style.zIndex = '9999';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.opacity = '0';
    tooltip.style.transition = 'opacity 0.1s';
    document.body.appendChild(tooltip);
    this.dragState.tooltipEl = tooltip;

    barEl.classList.add('is-dragging');

    barEl.addEventListener('pointermove', pointerMoveHandler);
    barEl.addEventListener('pointerup', (evt2) => void this.handlePointerUp(evt2 as PointerEvent), { once: true });
    barEl.addEventListener('pointercancel', (evt2) => void this.handlePointerUp(evt2 as PointerEvent), { once: true });
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
      barEl.style.left = `${startLeft + previewDeltaPx}px`;
    } else if (mode === 'resize-start') {
      previewStart = addDays(startDate, deltaDays);
      barEl.style.left = `${startLeft + previewDeltaPx}px`;
      barEl.style.width = `${Math.max(8, startWidth - previewDeltaPx)}px`;
    } else if (mode === 'resize-end') {
      previewEnd = addDays(endDate, deltaDays);
      barEl.style.width = `${Math.max(8, startWidth + previewDeltaPx)}px`;
    }

    // Update tooltip
    tooltipEl.style.left = `${this.dragState.startClientX + previewDeltaPx}px`;
    tooltipEl.style.top = `${barEl.getBoundingClientRect().top - 30}px`;
    tooltipEl.textContent = `${previewStart} - ${previewEnd}`;
    tooltipEl.classList.add('is-visible');
  }

  private async handlePointerUp(evt: PointerEvent): Promise<void> {
    if (!this.dragState) return;

    const dragState = this.dragState;
    this.dragState = null;

    const {
      barEl, mode, previewDeltaPx, startDate, endDate, originalDuration,
      tooltipEl, parentPath, subtaskKey, parentRevision, pointerMoveHandler,
    } = dragState;

    // Clean up
    barEl.removeEventListener('pointermove', pointerMoveHandler);
    barEl.classList.remove('is-dragging');
    if (tooltipEl) {
      tooltipEl.remove();
    }
    barEl.releasePointerCapture(evt.pointerId);

    // Reset styles
    barEl.style.left = '';
    barEl.style.width = '';

    const deltaDays = Math.round(previewDeltaPx / this.viewState.dayWidth);

    if (deltaDays === 0) {
      return; // No-op
    }

    let newStart = startDate;
    let newEnd = endDate;

    if (mode === 'bar-move') {
      // Snap start to next business day, then preserve original calendar duration
      const rawStart = addDays(startDate, deltaDays);
      newStart = snapForward(rawStart);
      newEnd = addDays(newStart, originalDuration);
    } else if (mode === 'resize-start') {
      newStart = snapForward(addDays(startDate, deltaDays));
    } else if (mode === 'resize-end') {
      newEnd = snapBackward(addDays(endDate, deltaDays));
    }

    // Guard: start must not exceed end (minimum 1-day bar)
    if (newStart > newEnd) return;

    // Update via API
    const result = await this.api.updateTaskItem({
      path: parentPath,
      expectedRevision: parentRevision,
      subtasks: [
        {
          key: subtaskKey,
          fields: {
            plannedStartDate: newStart,
            plannedEndDate: newEnd,
          },
        },
      ],
    });

    if (!result.ok) {
      // Force a reload in all failure cases so the view stays consistent with the vault.
      // REVISION_CONFLICT: another write raced us — reload shows the true current state.
      // Other errors: reset bar position to match the unmodified note.
      this.onDragEnd();
      return;
    }

    this.onDragEnd();
  }
}
