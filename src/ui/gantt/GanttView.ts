import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import { InputModal } from '../shared/InputModal';
import { MarkerModal } from '../shared/MarkerModal';
import { DateInputModal } from '../shared/DateInputModal';
import { GanttViewState } from './gantt-view-state';
import { GanttRenderer } from './gantt-renderer';
import { GanttDragController } from './gantt-drag-controller';
import { GanttPopover } from './gantt-popover';
import { todayStr, addDays, snapForward, diffDays } from './gantt-date-utils';
import {
  RANGE_EXTEND_THRESHOLD_PX,
  RANGE_EXTEND_DAYS,
  PARENT_COL_WIDTH,
} from './gantt-constants';
import type { VaultGanttSettings } from '../../settings';
import './gantt-styles.css';

export const GANTT_VIEW_TYPE = 'vault-gantt-gantt';

let apiInstance: CoreTaskAPI;
let saveZoomFn: ((v: number) => void) | null = null;
let loadZoomFn: (() => number) | null = null;
let getSettingsFn: (() => VaultGanttSettings) | null = null;

export function setGanttViewApi(api: CoreTaskAPI): void {
  apiInstance = api;
}

export function setGanttZoomCallbacks(
  save: (v: number) => void,
  load: () => number,
): void {
  saveZoomFn = save;
  loadZoomFn = load;
}

export function setGanttSettingsGetter(fn: () => VaultGanttSettings): void {
  getSettingsFn = fn;
}

export class GanttView extends ItemView {
  private viewState!: GanttViewState;
  private renderer!: GanttRenderer;
  private dragController!: GanttDragController;
  private popover!: GanttPopover;
  private unsubscribe?: () => void;
  private tasks: TaskRecord[] = [];
  private debounceTimer: number | undefined;
  private isExtendingRange = false;
  private ganttTagFilter: string | null = null;
  private tagFilterSelectEl: HTMLSelectElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return GANTT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Ganttビュー';
  }

  getIcon(): string {
    return 'gantt-chart';
  }

  async onOpen(): Promise<void> {
    if (!apiInstance) {
      new Notice('Vault Gantt: API未初期化。プラグインを再起動してください。');
      return;
    }
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    this.viewState = new GanttViewState(todayStr());
    // Restore persisted zoom
    if (loadZoomFn) this.viewState.dayWidth = loadZoomFn();

    this.renderer = new GanttRenderer(this.viewState);
    if (getSettingsFn) {
      this.renderer.enableHolidays = getSettingsFn().enableHolidays;
    }
    this.popover = new GanttPopover(
      apiInstance,
      (path) => this.tasks.find((t) => t.path === path),
      this.app,
      () => getSettingsFn?.()?.currentStatusRows ?? 3,
    );
    this.dragController = new GanttDragController(
      this.viewState,
      apiInstance,
      () => { this.popover.close(); void this.reload(); },
      (parentPath, subtaskKey, barEl) => {
        this.popover.open(parentPath, subtaskKey, barEl);
      }
    );

    this.renderer.mount(container);
    this.renderer.onRowReorder = (orderedPaths) => void this.handleRowReorder(orderedPaths);
    this.addToolbar(this.renderer.ganttEl!);

    this.viewState.scrollEl?.addEventListener('scroll', () => {
      this.onScroll();
      this.renderer.updateFloatingMonth(this.viewState.buildDates());
    });

    this.dragController.attach(
      this.renderer.rootEl!,
      (path) => this.tasks.find((t) => t.path === path)
    );

    this.renderer.rootEl!.addEventListener('contextmenu', (evt) => this.handleContextMenu(evt));
    this.renderer.rootEl!.addEventListener('pointerdown', (evt) => this.handleMarkerOrDueLineDrag(evt));

    this.unsubscribe = apiInstance.subscribe(() => {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => void this.reload(), 250);
    });

    await this.reload();
    this.viewState.scrollToToday();
  }

  private zoomDisplayEl: HTMLElement | null = null;

  private addToolbar(ganttEl: HTMLElement): void {
    const toolbar = ganttEl.createEl('div', { cls: 'vg-gantt-toolbar' });

    // Left group: Workbench link + add button
    const leftGroup = toolbar.createDiv({ cls: 'vg-gantt-toolbar-left' });

    const wbBtn = leftGroup.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: 'Workbench' });
    wbBtn.title = 'Workbenchを開く';
    wbBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.app as any).commands.executeCommandById('vault-gantt:open-workbench');
    });

    const addBtn = leftGroup.createEl('button', { cls: 'vg-gantt-toolbar-btn vg-gantt-toolbar-add', text: '＋ タスク追加' });
    addBtn.title = '新規親タスクを作成';
    addBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.app as any).commands.executeCommandById('vault-gantt:create-new-task');
    });

    // Tag filter dropdown (populated after first load)
    this.tagFilterSelectEl = leftGroup.createEl('select', { cls: 'vg-gantt-toolbar-select' });
    this.tagFilterSelectEl.style.display = 'none'; // hidden until tags exist
    this.tagFilterSelectEl.title = 'タグで絞り込む';
    this.tagFilterSelectEl.addEventListener('change', () => {
      const val = this.tagFilterSelectEl?.value ?? '';
      this.ganttTagFilter = val || null;
      this.renderer.tagFilter = this.ganttTagFilter;
      void this.fullRender();
    });

    // Right group: zoom controls + today
    const rightGroup = toolbar.createDiv({ cls: 'vg-gantt-toolbar-right' });

    const toToday = rightGroup.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: '今日' });
    toToday.title = '今日へスクロール';
    toToday.addEventListener('click', () => this.viewState.scrollToToday());

    const zoomOut = rightGroup.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: '－' });
    zoomOut.title = 'ズームアウト';
    zoomOut.addEventListener('click', () => {
      this.viewState.zoom(-1);
      this.updateZoomDisplay();
      saveZoomFn?.(this.viewState.dayWidth);
      void this.fullRender();
    });

    this.zoomDisplayEl = rightGroup.createEl('span', {
      cls: 'vg-gantt-zoom-display',
      text: `${this.viewState.dayWidth}px/日`,
    });

    const zoomIn = rightGroup.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: '＋' });
    zoomIn.title = 'ズームイン';
    zoomIn.addEventListener('click', () => {
      this.viewState.zoom(1);
      this.updateZoomDisplay();
      saveZoomFn?.(this.viewState.dayWidth);
      void this.fullRender();
    });

    // Prepend toolbar so it appears before wrapEl
    ganttEl.prepend(toolbar);
  }

  private updateTagFilterDropdown(): void {
    if (!this.tagFilterSelectEl) return;

    const allTags = Array.from(
      new Set(this.tasks.flatMap((t) => t.note.subtasks.flatMap((s) => s.tags)))
    ).sort();

    if (allTags.length === 0) {
      this.tagFilterSelectEl.style.display = 'none';
      return;
    }

    this.tagFilterSelectEl.style.display = '';
    const currentVal = this.tagFilterSelectEl.value;
    const tagStillExists = allTags.includes(currentVal);
    this.tagFilterSelectEl.empty();

    // Reset filter when the previously selected tag no longer exists
    if (currentVal && !tagStillExists) {
      this.ganttTagFilter = null;
      this.renderer.tagFilter = null;
    }

    const allOpt = this.tagFilterSelectEl.createEl('option', { value: '', text: '全タグ' });
    allOpt.selected = !currentVal || !tagStillExists;

    for (const tag of allTags) {
      const opt = this.tagFilterSelectEl.createEl('option', { value: tag, text: `# ${tag}` });
      opt.selected = tag === currentVal && tagStillExists;
    }
  }

  private updateZoomDisplay(): void {
    if (this.zoomDisplayEl) {
      this.zoomDisplayEl.textContent = `${this.viewState.dayWidth}px/日`;
    }
  }

  private onScroll(): void {
    if (!this.viewState.scrollEl || this.isExtendingRange) return;

    const wrap = this.viewState.scrollEl;
    const threshold = Math.max(RANGE_EXTEND_THRESHOLD_PX, this.viewState.dayWidth * 10);
    const prevScrollLeft = wrap.scrollLeft;

    if (wrap.scrollLeft < threshold) {
      this.isExtendingRange = true;
      this.viewState.extendRangeLeft();
      void this.fullRender().then(() => {
        wrap.scrollLeft = prevScrollLeft + RANGE_EXTEND_DAYS * this.viewState.dayWidth;
        this.isExtendingRange = false;
      });
    } else if (wrap.scrollLeft + wrap.clientWidth > wrap.scrollWidth - threshold) {
      this.isExtendingRange = true;
      this.viewState.extendRangeRight();
      void this.fullRender().then(() => {
        this.isExtendingRange = false;
      });
    }
  }

  private async reload(): Promise<void> {
    try {
      this.tasks = await apiInstance.listTasks();
      this.updateTagFilterDropdown();
      const dates = this.viewState.buildDates();
      this.renderer.renderHeader(dates);
      this.renderer.renderAll(this.tasks, dates);
      this.renderer.setTimelineWidth(dates);
    } catch (err) {
      console.error('[vault-gantt] Gantt reload error:', err);
      new Notice('Ganttの読み込みに失敗しました');
    }
  }

  private handleContextMenu(evt: MouseEvent): void {
    const target = evt.target as HTMLElement;

    // Bar right-click menu
    const barEl = target.closest('.vg-gantt-bar') as HTMLElement | null;
    if (barEl) {
      this.handleBarContextMenu(evt, barEl);
      return;
    }

    // Empty timeline area: add subtask at clicked date
    const rowEl = target.closest('[data-path]') as HTMLElement | null;
    if (!rowEl) return;
    const parentPath = rowEl.dataset.path;
    if (!parentPath) return;

    const scrollEl = this.viewState.scrollEl;
    if (!scrollEl) return;
    const scrollRect = scrollEl.getBoundingClientRect();
    const xInTimeline = evt.clientX - scrollRect.left + scrollEl.scrollLeft - PARENT_COL_WIDTH;
    if (xInTimeline < 0) {
      evt.preventDefault();
      this.handleParentLeftColumnMenu(evt, parentPath);
      return;
    }
    const dayIndex = Math.floor(xInTimeline / this.viewState.dayWidth);
    const dates = this.viewState.buildDates();
    const clickedDate = dates[Math.max(0, Math.min(dayIndex, dates.length - 1))];
    if (!clickedDate) return;

    evt.preventDefault();

    const record = this.tasks.find((t) => t.path === parentPath);
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle(`「${clickedDate}」にサブタスクを追加`);
      item.setIcon('plus');
      item.onClick(() => {
        new InputModal(this.app, 'サブタスクを追加', 'サブタスク名を入力...', async (title) => {
          const record = this.tasks.find((t) => t.path === parentPath);
          if (!record) return;
          const key = `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const endDate = snapForward(addDays(clickedDate, 4));
          const result = await apiInstance.updateTaskItem({
            path: parentPath,
            expectedRevision: record.revision,
            newSubtasks: [{ key, title }],
            subtasks: [{ key, fields: { plannedStartDate: clickedDate, plannedEndDate: endDate } }],
          });
          if (!result.ok) {
            new Notice(`サブタスクの追加に失敗しました: ${result.error.code}`);
          }
        }).open();
      });
    });

    menu.addSeparator();

    if (record) {
      menu.addItem((item) => {
        item.setTitle(`「${clickedDate}」を親の期限に設定`);
        item.setIcon('calendar');
        item.onClick(async () => {
          const r = this.tasks.find((t) => t.path === parentPath);
          if (!r) return;
          await apiInstance.updateTaskItem({
            path: parentPath,
            expectedRevision: r.revision,
            parent: { dueDate: clickedDate },
          });
        });
      });
    }

    if (record && record.note.dueDate) {
      menu.addItem((item) => {
        item.setTitle('親の期限を削除');
        item.setIcon('calendar-x');
        item.onClick(async () => {
          const r = this.tasks.find((t) => t.path === parentPath);
          if (!r) return;
          await apiInstance.updateTaskItem({
            path: parentPath,
            expectedRevision: r.revision,
            parent: { dueDate: null },
          });
        });
      });
    }

    menu.showAtMouseEvent(evt);
  }

  /** Shift all date keys in a workload record by a delta. */
  private shiftDateKeys(obj: Record<string, number>, delta: number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[addDays(key, delta)] = val;
    }
    return result;
  }

  private handleParentLeftColumnMenu(evt: MouseEvent, parentPath: string): void {
    const record = this.tasks.find((t) => t.path === parentPath);
    if (!record) return;

    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('ノートを開く');
      item.setIcon('file-text');
      item.onClick(() => {
        void this.app.workspace.openLinkText(parentPath, '');
      });
    });

    menu.addItem((item) => {
      const enabled = record.note.ganttEnabled;
      item.setTitle(enabled ? 'ガントから除外する' : 'ガントに表示する');
      item.setIcon(enabled ? 'calendar-x' : 'calendar-check');
      item.onClick(async () => {
        const r = this.tasks.find((t) => t.path === parentPath);
        if (!r) return;
        await apiInstance.updateTaskItem({
          path: parentPath,
          expectedRevision: r.revision,
          parent: { ganttEnabled: !r.note.ganttEnabled },
        });
      });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('タスクを削除');
      item.setIcon('trash-2');
      item.onClick(async () => {
        const confirmed = confirm(`「${record.note.displayName}」を削除しますか？\nこの操作は元に戻せません。`);
        if (!confirmed) return;
        const r = this.tasks.find((t) => t.path === parentPath);
        if (!r) return;
        const result = await apiInstance.deleteTask(r.path, r.revision);
        if (!result.ok) {
          new Notice(`削除に失敗しました: ${result.error.code}`);
        }
      });
    });

    menu.showAtMouseEvent(evt);
  }

  private handleBarContextMenu(evt: MouseEvent, barEl: HTMLElement): void {
    const parentPath = barEl.getAttribute('data-path');
    const subtaskKey = barEl.getAttribute('data-key');
    if (!parentPath || !subtaskKey) return;

    const record = this.tasks.find((t) => t.path === parentPath);
    if (!record) return;
    const subtask = record.note.subtasks.find((s) => s.key === subtaskKey);
    if (!subtask) return;

    evt.preventDefault();
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('ノートを開く');
      item.setIcon('file-text');
      item.onClick(() => {
        void this.app.workspace.openLinkText(parentPath, '');
      });
    });

    if (!subtask.completed) {
      menu.addItem((item) => {
        item.setTitle('完了にする');
        item.setIcon('check-circle-2');
        item.onClick(async () => {
          const r = this.tasks.find((t) => t.path === parentPath);
          if (!r) return;
          await apiInstance.updateTaskItem({
            path: parentPath,
            expectedRevision: r.revision,
            subtasks: [{ key: subtaskKey, fields: { completed: true } }],
          });
        });
      });
    }

    menu.addItem((item) => {
      item.setTitle('ガントから外す');
      item.setIcon('calendar-x');
      item.onClick(async () => {
        const r = this.tasks.find((t) => t.path === parentPath);
        if (!r) return;
        await apiInstance.updateTaskItem({
          path: parentPath,
          expectedRevision: r.revision,
          subtasks: [{ key: subtaskKey, fields: { plannedStartDate: null, plannedEndDate: null } }],
        });
      });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('マーカーを追加 ▲');
      item.setIcon('map-pin');
      item.onClick(() => {
        new MarkerModal(this.app, todayStr(), async ({ date, label }) => {
          const r = this.tasks.find((t) => t.path === parentPath);
          if (!r) return;
          const existing = r.note.subtasks.find((s) => s.key === subtaskKey);
          if (!existing) return;
          const markerKey = `mk_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
          const newMarkers = [
            ...existing.markers,
            { key: markerKey, title: label, date, tags: [] },
          ];
          await apiInstance.updateTaskItem({
            path: parentPath,
            expectedRevision: r.revision,
            subtasks: [{ key: subtaskKey, fields: { markers: newMarkers } }],
          });
        }).open();
      });
    });

    menu.addItem((item) => {
      item.setTitle('サブタスクを削除');
      item.setIcon('trash-2');
      item.onClick(async () => {
        const confirmed = confirm(`「${subtask.title}」を削除しますか？`);
        if (!confirmed) return;
        const r = this.tasks.find((t) => t.path === parentPath);
        if (!r) return;
        const result = await apiInstance.updateTaskItem({
          path: parentPath,
          expectedRevision: r.revision,
          deleteSubtaskKeys: [subtaskKey],
        });
        if (!result.ok) {
          new Notice(`削除に失敗しました: ${result.error.code}`);
        }
      });
    });

    menu.addSeparator();

    // Batch move option: only show if subtask has a planned start date
    if (subtask.plannedStartDate) {
      menu.addItem((item) => {
        item.setTitle('これ以降を纏めて移動');
        item.setIcon('move');
        item.onClick(() => {
          new DateInputModal(
            this.app,
            '移動後の開始日',
            subtask.plannedStartDate!,
            async (newStartDate) => {
              const r = this.tasks.find((t) => t.path === parentPath);
              if (!r) return;

              // Calculate day delta
              const dayDelta = diffDays(subtask.plannedStartDate!, newStartDate);
              if (dayDelta === 0) return; // No change

              // Find all subtasks >= anchor's plannedStartDate
              const affectedSubtasks = r.note.subtasks.filter(
                (s) => s.plannedStartDate && s.plannedStartDate >= subtask.plannedStartDate!
              );

              // Check if any have workloadActual entries
              const hasWorkloadActual = affectedSubtasks.some(
                (s) => Object.keys(s.workloadActual).length > 0
              );

              if (hasWorkloadActual) {
                const confirmed = confirm(
                  '実績時間が入力済みのサブタスクが含まれています。移動しますか？\n（workload実績の日付もシフトされます）'
                );
                if (!confirmed) return;
              }

              // Build patches for all affected subtasks
              const patches = affectedSubtasks.map((s) => {
                const fields: Record<string, unknown> = {};

                if (s.plannedStartDate) {
                  fields.plannedStartDate = addDays(s.plannedStartDate, dayDelta);
                }
                if (s.plannedEndDate) {
                  fields.plannedEndDate = addDays(s.plannedEndDate, dayDelta);
                }
                if (s.dueDate) {
                  fields.dueDate = addDays(s.dueDate, dayDelta);
                }

                // Shift marker dates
                if (s.markers.length > 0) {
                  fields.markers = s.markers.map((m) => ({
                    ...m,
                    date: addDays(m.date, dayDelta),
                  }));
                }

                // Shift workload plan dates
                if (Object.keys(s.workloadPlan).length > 0) {
                  fields.workloadPlan = this.shiftDateKeys(s.workloadPlan, dayDelta);
                }

                // Shift workload actual dates
                if (Object.keys(s.workloadActual).length > 0) {
                  fields.workloadActual = this.shiftDateKeys(s.workloadActual, dayDelta);
                }

                return { key: s.key, fields };
              });

              // Send single batch update
              const result = await apiInstance.updateTaskItem({
                path: parentPath,
                expectedRevision: r.revision,
                subtasks: patches,
              });

              if (!result.ok) {
                new Notice(`一括移動に失敗しました: ${result.error.code}`);
              }
            }
          ).open();
        });
      });
    }

    menu.showAtMouseEvent(evt);
  }

  private async handleRowReorder(orderedPaths: string[]): Promise<void> {
    // Assign new ganttOrder = (index + 1) * 1000, batch update all reordered tasks
    const updates = orderedPaths
      .map((path, i) => ({ path, order: (i + 1) * 1000 }))
      .filter(({ path, order }) => {
        const t = this.tasks.find((r) => r.path === path);
        return t && t.note.ganttOrder !== order;
      });

    await Promise.all(
      updates.map(({ path, order }) => {
        const t = this.tasks.find((r) => r.path === path);
        if (!t) return Promise.resolve();
        return apiInstance.updateTaskItem({
          path,
          expectedRevision: t.revision,
          parent: { ganttOrder: order },
        });
      })
    );
  }

  private async fullRender(): Promise<void> {
    const dates = this.viewState.buildDates();
    this.renderer.renderHeader(dates);
    this.renderer.renderAll(this.tasks, dates);
    this.renderer.setTimelineWidth(dates);
  }

  private handleMarkerOrDueLineDrag(evt: PointerEvent): void {
    const target = evt.target as HTMLElement;

    // Handle marker drag (▲)
    const markerEl = target.closest('.vg-gantt-marker') as HTMLElement | null;
    if (markerEl) {
      this.startMarkerDrag(evt, markerEl);
      return;
    }

    // Handle due date line drag (★)
    const dueLineEl = target.closest('.vg-gantt-due-line') as HTMLElement | null;
    if (dueLineEl) {
      this.startDueLineDrag(evt, dueLineEl);
      return;
    }
  }

  private startMarkerDrag(evt: PointerEvent, markerEl: HTMLElement): void {
    const markerKey = markerEl.dataset.markerKey;
    const subtaskKey = markerEl.dataset.subtaskKey;
    const parentPath = markerEl.dataset.path;

    if (!markerKey || !subtaskKey || !parentPath) return;

    const record = this.tasks.find((t) => t.path === parentPath);
    if (!record) return;

    const subtask = record.note.subtasks.find((s) => s.key === subtaskKey);
    if (!subtask) return;

    const marker = subtask.markers.find((m) => m.key === markerKey);
    if (!marker) return;

    const startX = evt.clientX;
    const originalDate = marker.date;

    markerEl.setPointerCapture(evt.pointerId);

    const moveHandler = (e: PointerEvent): void => {
      const dx = e.clientX - startX;
      const dayDelta = Math.round(dx / this.viewState.dayWidth);
      let newDate = addDays(originalDate, dayDelta);

      // Clamp to subtask start/end if both exist
      if (subtask.plannedStartDate && subtask.plannedEndDate) {
        if (newDate < subtask.plannedStartDate) newDate = subtask.plannedStartDate;
        if (newDate > subtask.plannedEndDate) newDate = subtask.plannedEndDate;
      }

      const daysFromStart = diffDays(this.viewState.rangeStart, newDate);
      const markerLeft = daysFromStart * this.viewState.dayWidth;
      markerEl.style.left = markerLeft + 'px';
    };

    const upHandler = async (e: PointerEvent): Promise<void> => {
      markerEl.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
      document.removeEventListener('pointercancel', upHandler);

      const finalDx = e.clientX - startX;
      const finalDelta = Math.round(finalDx / this.viewState.dayWidth);

      if (finalDelta === 0) {
        // Reset visual position
        const origDaysFromStart = diffDays(this.viewState.rangeStart, originalDate);
        const origMarkerLeft = origDaysFromStart * this.viewState.dayWidth;
        markerEl.style.left = origMarkerLeft + 'px';
        return;
      }

      let finalDate = addDays(originalDate, finalDelta);

      // Clamp to subtask start/end if both exist
      if (subtask.plannedStartDate && subtask.plannedEndDate) {
        if (finalDate < subtask.plannedStartDate) finalDate = subtask.plannedStartDate;
        if (finalDate > subtask.plannedEndDate) finalDate = subtask.plannedEndDate;
      }

      // Update the marker in the subtask
      const updatedMarkers = subtask.markers.map((m) =>
        m.key === markerKey ? { ...m, date: finalDate } : m
      );

      const r = this.tasks.find((t) => t.path === parentPath);
      if (!r) return;

      await apiInstance.updateTaskItem({
        path: parentPath,
        expectedRevision: r.revision,
        subtasks: [{ key: subtaskKey, fields: { markers: updatedMarkers } }],
      });
    };

    markerEl.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
    document.addEventListener('pointercancel', upHandler);
  }

  private startDueLineDrag(evt: PointerEvent, dueLineEl: HTMLElement): void {
    const parentPath = dueLineEl.dataset.path;
    if (!parentPath) return;

    const record = this.tasks.find((t) => t.path === parentPath);
    if (!record || !record.note.dueDate) return;

    const startX = evt.clientX;
    const originalDueDate = record.note.dueDate;

    dueLineEl.setPointerCapture(evt.pointerId);

    const moveHandler = (e: PointerEvent): void => {
      const dx = e.clientX - startX;
      const dayDelta = Math.round(dx / this.viewState.dayWidth);
      let newDate = addDays(originalDueDate, dayDelta);
      newDate = snapForward(newDate);

      const daysFromStart = diffDays(this.viewState.rangeStart, newDate);
      const dueLeft = daysFromStart * this.viewState.dayWidth;
      dueLineEl.style.left = dueLeft + 'px';
    };

    const upHandler = async (e: PointerEvent): Promise<void> => {
      dueLineEl.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
      document.removeEventListener('pointercancel', upHandler);

      const finalDx = e.clientX - startX;
      const finalDelta = Math.round(finalDx / this.viewState.dayWidth);

      if (finalDelta === 0) {
        // Reset visual position
        const origDaysFromStart = diffDays(this.viewState.rangeStart, originalDueDate);
        const origDueLeft = origDaysFromStart * this.viewState.dayWidth;
        dueLineEl.style.left = origDueLeft + 'px';
        return;
      }

      const finalDate = snapForward(addDays(originalDueDate, finalDelta));

      if (finalDate === originalDueDate) {
        // No effective change after snapping
        return;
      }

      const r = this.tasks.find((t) => t.path === parentPath);
      if (!r) return;

      await apiInstance.updateTaskItem({
        path: parentPath,
        expectedRevision: r.revision,
        parent: { dueDate: finalDate },
      });
    };

    dueLineEl.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
    document.addEventListener('pointercancel', upHandler);
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.debounceTimer);
    this.unsubscribe?.();
    this.dragController.detach();
    this.popover.close();
    this.renderer.unmount();
  }
}
