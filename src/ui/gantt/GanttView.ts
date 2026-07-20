import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import { InputModal } from '../shared/InputModal';
import { GanttViewState } from './gantt-view-state';
import { GanttRenderer } from './gantt-renderer';
import { GanttDragController } from './gantt-drag-controller';
import { todayStr, addDays, snapForward } from './gantt-date-utils';
import {
  RANGE_EXTEND_THRESHOLD_PX,
  RANGE_EXTEND_DAYS,
  PARENT_COL_WIDTH,
} from './gantt-constants';
import './gantt-styles.css';

export const GANTT_VIEW_TYPE = 'vault-gantt-gantt';

let apiInstance: CoreTaskAPI;

export function setGanttViewApi(api: CoreTaskAPI): void {
  apiInstance = api;
}

export class GanttView extends ItemView {
  private viewState!: GanttViewState;
  private renderer!: GanttRenderer;
  private dragController!: GanttDragController;
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
    this.renderer = new GanttRenderer(this.viewState);
    this.dragController = new GanttDragController(
      this.viewState,
      apiInstance,
      () => void this.reload()
    );

    this.renderer.mount(container);
    this.addToolbar(container);

    this.viewState.scrollEl?.addEventListener('scroll', () => this.onScroll());

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

  private addToolbar(container: HTMLElement): void {
    const toolbar = container.createEl('div', { cls: 'vg-gantt-toolbar' });
    toolbar.style.display = 'flex';
    toolbar.style.gap = '0.5rem';
    toolbar.style.alignItems = 'center';
    toolbar.style.padding = '0.5rem';
    toolbar.style.borderBottom = '1px solid var(--background-modifier-border)';

    const title = toolbar.createEl('span', { cls: 'vg-gantt-title', text: 'Ganttビュー' });
    title.style.fontWeight = '600';
    title.style.flex = '1';

    const zoomIn = toolbar.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: '＋' });
    zoomIn.title = 'ズームイン';
    zoomIn.addEventListener('click', () => {
      this.viewState.zoom(1);
      void this.fullRender();
    });

    const zoomOut = toolbar.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: '－' });
    zoomOut.title = 'ズームアウト';
    zoomOut.addEventListener('click', () => {
      this.viewState.zoom(-1);
      void this.fullRender();
    });

    const toToday = toolbar.createEl('button', { cls: 'vg-gantt-toolbar-btn', text: '今日' });
    toToday.title = '今日へスクロール';
    toToday.addEventListener('click', () => this.viewState.scrollToToday());

    // createEl already appended toolbar; move it before the gantt scroll wrap
    container.prepend(toolbar);
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
    // Bars get their own future right-click menu; skip here.
    if (target.closest('.vg-gantt-bar')) return;
    // Find the row and its parent task path
    const rowEl = target.closest('[data-path]') as HTMLElement | null;
    if (!rowEl) return;
    const parentPath = rowEl.dataset.path;
    if (!parentPath) return;

    // Compute the clicked date from mouse x position relative to the scroll container
    const scrollEl = this.viewState.scrollEl;
    if (!scrollEl) return;
    const scrollRect = scrollEl.getBoundingClientRect();
    const xInTimeline = evt.clientX - scrollRect.left - PARENT_COL_WIDTH + scrollEl.scrollLeft;
    if (xInTimeline < 0) return; // clicked on the left column, not the timeline
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
  }
}
