import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import { InputModal } from '../shared/InputModal';
import { GanttViewState } from './gantt-view-state';
import { GanttRenderer } from './gantt-renderer';
import { GanttDragController } from './gantt-drag-controller';
import { GanttPopover } from './gantt-popover';
import { todayStr, addDays, snapForward } from './gantt-date-utils';
import {
  RANGE_EXTEND_THRESHOLD_PX,
  RANGE_EXTEND_DAYS,
  PARENT_COL_WIDTH,
} from './gantt-constants';
import './gantt-styles.css';

export const GANTT_VIEW_TYPE = 'vault-gantt-gantt';

let apiInstance: CoreTaskAPI;
let saveZoomFn: ((v: number) => void) | null = null;
let loadZoomFn: (() => number) | null = null;

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

export class GanttView extends ItemView {
  private viewState!: GanttViewState;
  private renderer!: GanttRenderer;
  private dragController!: GanttDragController;
  private popover!: GanttPopover;
  private unsubscribe?: () => void;
  private tasks: TaskRecord[] = [];
  private debounceTimer: number | undefined;
  private isExtendingRange = false;

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
    this.popover = new GanttPopover(
      apiInstance,
      (path) => this.tasks.find((t) => t.path === path),
      this.app
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
    if (xInTimeline < 0) return;
    const dayIndex = Math.floor(xInTimeline / this.viewState.dayWidth);
    const dates = this.viewState.buildDates();
    const clickedDate = dates[Math.max(0, Math.min(dayIndex, dates.length - 1))];
    if (!clickedDate) return;

    evt.preventDefault();

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

  async onClose(): Promise<void> {
    window.clearTimeout(this.debounceTimer);
    this.unsubscribe?.();
    this.dragController.detach();
    this.popover.close();
    this.renderer.unmount();
  }
}
