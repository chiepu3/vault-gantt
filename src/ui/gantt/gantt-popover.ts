import { App, Notice } from 'obsidian';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import type { Subtask } from '../../domain/task-note/types';
import { DEFAULT_STATUSES } from '../../domain/status';

/**
 * Rich click popover for Gantt bars.
 * Opens when a bar is clicked (no drag movement detected by GanttDragController).
 * Allows editing: statusLabel, plannedStart/End, dueDate, completed, currentStatus.
 */
export class GanttPopover {
  private el: HTMLElement | null = null;
  private currentStatusSaveTimer?: number;
  private outsideClickHandler?: (e: MouseEvent) => void;
  private keydownHandler?: (e: KeyboardEvent) => void;
  private currentPath?: string;
  private currentSubtaskKey?: string;
  private currentStatusDirty = false;
  private currentStatusEl?: HTMLTextAreaElement;

  constructor(
    private api: CoreTaskAPI,
    private getRecord: (path: string) => TaskRecord | undefined,
    private app: App,
    private getRows: () => number = () => 3,
  ) {}

  open(parentPath: string, subtaskKey: string, anchorEl: HTMLElement): void {
    // If clicking the same bar while popover is open, toggle close
    if (this.currentPath === parentPath && this.currentSubtaskKey === subtaskKey && this.el) {
      this.close();
      return;
    }

    this.close();

    const record = this.getRecord(parentPath);
    if (!record) return;
    const subtask = record.note.subtasks.find((s) => s.key === subtaskKey);
    if (!subtask) return;

    this.currentPath = parentPath;
    this.currentSubtaskKey = subtaskKey;
    this.currentStatusDirty = false;

    this.el = document.body.createDiv({ cls: 'vg-popover' });
    this.buildContent(record, subtask);
    this.positionNear(anchorEl);

    // Defer outside-click binding so the opening click doesn't immediately close it
    window.setTimeout(() => {
      this.outsideClickHandler = (e: MouseEvent) => {
        if (this.el && !this.el.contains(e.target as Node)) {
          this.close();
        }
      };
      document.addEventListener('mousedown', this.outsideClickHandler);
    }, 0);

    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.keydownHandler);
  }

  close(): void {
    if (this.currentStatusDirty && this.currentStatusEl && this.currentPath && this.currentSubtaskKey) {
      void this.save({ currentStatus: this.currentStatusEl.value });
    }
    window.clearTimeout(this.currentStatusSaveTimer);

    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = undefined;
    }
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = undefined;
    }

    this.el?.remove();
    this.el = null;
    this.currentPath = undefined;
    this.currentSubtaskKey = undefined;
    this.currentStatusEl = undefined;
    this.currentStatusDirty = false;
  }

  isOpen(): boolean {
    return this.el !== null;
  }

  private async save(fields: Record<string, unknown>): Promise<void> {
    if (!this.currentPath || !this.currentSubtaskKey) return;
    const record = this.getRecord(this.currentPath);
    if (!record) return;
    const result = await this.api.updateTaskItem({
      path: this.currentPath,
      expectedRevision: record.revision,
      subtasks: [{ key: this.currentSubtaskKey, fields }],
    });
    if (!result.ok) {
      new Notice(`更新に失敗しました: ${result.error.code}`);
    }
  }

  private buildContent(record: TaskRecord, subtask: Subtask): void {
    if (!this.el) return;

    // Header: title + close button
    const header = this.el.createDiv({ cls: 'vg-popover-header' });
    header.createDiv({ cls: 'vg-popover-title', text: subtask.title });
    const closeBtn = header.createEl('button', { cls: 'vg-popover-close-btn', text: '×' });
    closeBtn.addEventListener('click', () => this.close());

    // Tags chips (read-only)
    if (subtask.tags.length > 0) {
      const tagsRow = this.el.createDiv({ cls: 'vg-popover-tags' });
      for (const tag of subtask.tags) {
        tagsRow.createSpan({ cls: 'vg-popover-tag', text: tag });
      }
    }

    // Form fields
    const form = this.el.createDiv({ cls: 'vg-popover-form' });

    // statusLabel select
    this.buildRow(form, '状態', (cell) => {
      const sel = cell.createEl('select', { cls: 'vg-popover-select' });
      if (!DEFAULT_STATUSES.some((s) => s.key === subtask.statusLabel)) {
        sel.createEl('option', { value: subtask.statusLabel, text: subtask.statusLabel }).selected = true;
      }
      for (const s of DEFAULT_STATUSES) {
        const opt = sel.createEl('option', { value: s.key, text: s.label });
        if (s.key === subtask.statusLabel) opt.selected = true;
      }
      sel.addEventListener('change', () => {
        const newStatus = sel.value;
        const patch: Record<string, unknown> = { statusLabel: newStatus };
        if (newStatus === 'done') patch.completed = true;
        else patch.completed = false;
        void this.save(patch);
        // Sync completed checkbox visually
        const cbEl = this.el?.querySelector<HTMLInputElement>('.vg-popover-completed-cb');
        if (cbEl) cbEl.checked = newStatus === 'done';
      });
    });

    // plannedStartDate
    this.buildRow(form, '開始', (cell) => {
      const inp = cell.createEl('input', { cls: 'vg-popover-date', type: 'date' });
      inp.value = subtask.plannedStartDate ?? '';
      inp.addEventListener('change', () => {
        void this.save({ plannedStartDate: inp.value || null });
      });
    });

    // plannedEndDate
    this.buildRow(form, '終了', (cell) => {
      const inp = cell.createEl('input', { cls: 'vg-popover-date', type: 'date' });
      inp.value = subtask.plannedEndDate ?? '';
      inp.addEventListener('change', () => {
        void this.save({ plannedEndDate: inp.value || null });
      });
    });

    // dueDate
    this.buildRow(form, '期限', (cell) => {
      const inp = cell.createEl('input', { cls: 'vg-popover-date', type: 'date' });
      inp.value = subtask.dueDate ?? '';
      inp.addEventListener('change', () => {
        void this.save({ dueDate: inp.value || null });
      });
    });

    // completed checkbox
    this.buildRow(form, '', (cell) => {
      const label = cell.createEl('label', { cls: 'vg-popover-check-label' });
      const cb = label.createEl('input', { type: 'checkbox', cls: 'vg-popover-completed-cb' });
      cb.checked = subtask.completed;
      label.createSpan({ text: '完了' });
      cb.addEventListener('change', () => {
        const patch: Record<string, unknown> = { completed: cb.checked };
        if (cb.checked) patch.statusLabel = 'done';
        else patch.statusLabel = 'active';
        void this.save(patch);
        // Sync status select visually
        const selEl = this.el?.querySelector<HTMLSelectElement>('.vg-popover-select');
        if (selEl) selEl.value = cb.checked ? 'done' : 'active';
      });
    });

    // Divider
    this.el.createEl('hr', { cls: 'vg-popover-divider' });

    // currentStatus textarea
    this.el.createDiv({ cls: 'vg-popover-cs-label', text: '現在のステータス' });
    const textarea = this.el.createEl('textarea', { cls: 'vg-popover-textarea' });
    textarea.rows = this.getRows();
    textarea.value = subtask.currentStatus;
    this.currentStatusEl = textarea;

    textarea.addEventListener('input', () => {
      this.currentStatusDirty = true;
      window.clearTimeout(this.currentStatusSaveTimer);
      this.currentStatusSaveTimer = window.setTimeout(() => {
        void this.save({ currentStatus: textarea.value });
        this.currentStatusDirty = false;
      }, 800);
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        window.clearTimeout(this.currentStatusSaveTimer);
        void this.save({ currentStatus: textarea.value });
        this.currentStatusDirty = false;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });

    this.el.createDiv({ cls: 'vg-popover-hint', text: 'Ctrl+Enter で保存' });

    // Footer
    const footer = this.el.createDiv({ cls: 'vg-popover-footer' });
    const openBtn = footer.createEl('button', { cls: 'vg-popover-open-btn', text: 'ノートを開く' });
    openBtn.addEventListener('click', () => {
      void this.app.workspace.openLinkText(record.path, '');
      this.close();
    });
  }

  private buildRow(
    parent: HTMLElement,
    label: string,
    buildCell: (cell: HTMLElement) => void
  ): void {
    const row = parent.createDiv({ cls: 'vg-popover-row' });
    if (label) {
      row.createEl('label', { cls: 'vg-popover-label', text: label });
    }
    const cell = row.createDiv({ cls: 'vg-popover-cell' });
    buildCell(cell);
  }

  private positionNear(anchorEl: HTMLElement): void {
    if (!this.el) return;
    const rect = anchorEl.getBoundingClientRect();
    const POPOVER_W = 290;
    const POPOVER_H = 380; // estimated
    const MARGIN = 8;

    let top = rect.bottom + MARGIN;
    let left = rect.left;

    // Flip up if not enough space below
    if (top + POPOVER_H > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, rect.top - POPOVER_H - MARGIN);
    }

    // Clamp horizontal
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - POPOVER_W - MARGIN));

    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }
}
