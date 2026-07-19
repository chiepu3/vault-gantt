import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import { PLUGIN_ID } from './domain/version';
import PluginBadge from './ui/shared/PluginBadge.svelte';
import { ObsidianVaultAdapter } from './infra/obsidian-vault-adapter';
import { CoreTaskAPI } from './application/core-task-api';
import { WorkbenchView, WORKBENCH_VIEW_TYPE, setWorkbenchViewApi } from './ui/workbench/WorkbenchView';

export default class VaultGanttPlugin extends Plugin {
  private statusBarBadge: ReturnType<typeof mount> | undefined;
  private api!: CoreTaskAPI;

  onload(): void {
    console.log(`Loading plugin: ${PLUGIN_ID}`);

    // Initialize DI: adapter -> api
    const adapter = new ObsidianVaultAdapter(this.app);
    this.api = new CoreTaskAPI(adapter);

    // Register workbench view (set api before registering view factory)
    setWorkbenchViewApi(this.api);
    this.registerView(WORKBENCH_VIEW_TYPE, (leaf) => new WorkbenchView(leaf));

    // Status bar badge
    const statusBarEl = this.addStatusBarItem();
    this.statusBarBadge = mount(PluginBadge as Component, { target: statusBarEl });

    // Ribbon icon to open workbench
    this.addRibbonIcon('table', 'タスク一覧を開く', () => this.openWorkbench());

    // Commands
    this.addCommand({
      id: 'open-workbench',
      name: 'タスク一覧を開く',
      callback: () => this.openWorkbench(),
    });

    this.addCommand({
      id: 'undo-last-action',
      name: '最後の操作を元に戻す',
      hotkeys: [],
      callback: async () => {
        const result = await this.api.undo();
        if (!result.ok) {
          new Notice('元に戻す操作がありません');
        }
      },
    });

    this.addCommand({
      id: 'create-new-task',
      name: '新しいタスクを作成',
      callback: async () => {
        const name = window.prompt('タスク名を入力してください');
        if (!name?.trim()) return;
        const result = await this.api.createTask({ displayName: name.trim() });
        if (!result.ok) {
          new Notice(`タスクの作成に失敗しました: ${result.error.code}`);
        }
      },
    });
  }

  private async openWorkbench(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(WORKBENCH_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: WORKBENCH_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  onunload(): void {
    console.log(`Unloading plugin: ${PLUGIN_ID}`);
    this.app.workspace.detachLeavesOfType(WORKBENCH_VIEW_TYPE);
    if (this.statusBarBadge) {
      unmount(this.statusBarBadge);
    }
  }
}
