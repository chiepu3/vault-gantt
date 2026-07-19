import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import { InputModal } from '../shared/InputModal';
import WorkbenchTable from './WorkbenchTable.svelte';

export const WORKBENCH_VIEW_TYPE = 'vault-gantt-workbench';

// Module-level singleton set before registerView; safe because setWorkbenchViewApi
// is always called in onload() before any leaf is constructed.
let apiInstance: CoreTaskAPI;

export function setWorkbenchViewApi(api: CoreTaskAPI): void {
  apiInstance = api;
}

export class WorkbenchView extends ItemView {
  private component: ReturnType<typeof mount> | undefined;
  private api: CoreTaskAPI;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.api = apiInstance;
  }

  getViewType(): string { return WORKBENCH_VIEW_TYPE; }
  getDisplayText(): string { return 'タスク一覧'; }
  getIcon(): string { return 'table'; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    const api = this.api;
    const app = this.app;

    this.component = mount(WorkbenchTable as Component, {
      target: this.contentEl,
      props: {
        api,
        openFile: (path: string) => {
          app.workspace.openLinkText(path, '', false);
        },
        openCreateTaskModal: () => {
          new InputModal(app, '新しいタスクを作成', 'タスク名を入力...', async (name) => {
            const result = await api.createTask({ displayName: name });
            if (!result.ok) {
              new Notice(`タスクの作成に失敗しました: ${result.error.code}`);
            }
          }).open();
        },
        openCreateSubtaskModal: (record: TaskRecord) => {
          new InputModal(app, 'サブタスクを追加', 'サブタスク名を入力...', async (title) => {
            const key = `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const result = await api.updateTaskItem({
              path: record.path,
              expectedRevision: record.revision,
              newSubtasks: [{ key, title }],
            });
            if (!result.ok) {
              new Notice(`サブタスクの追加に失敗しました: ${result.error.code}`);
            }
          }).open();
        },
      },
    });
  }

  async onClose(): Promise<void> {
    if (this.component) {
      unmount(this.component);
      this.component = undefined;
    }
  }
}
