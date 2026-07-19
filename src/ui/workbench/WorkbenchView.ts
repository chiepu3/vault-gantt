import { ItemView, WorkspaceLeaf } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import type { CoreTaskAPI } from '../../application/core-task-api';
import WorkbenchTable from './WorkbenchTable.svelte';

export const WORKBENCH_VIEW_TYPE = 'vault-gantt-workbench';

// Store api reference for the view factory to use
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

  getViewType(): string {
    return WORKBENCH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'タスク一覧';
  }

  getIcon(): string {
    return 'table';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.component = mount(WorkbenchTable as Component, {
      target: this.contentEl,
      props: {
        api: this.api,
        openFile: (path: string) => {
          this.app.workspace.openLinkText(path, '', false);
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
