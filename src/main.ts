import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import { PLUGIN_ID } from './domain/version';
import PluginBadge from './ui/shared/PluginBadge.svelte';
import { VaultGanttSettingsTab } from './ui/shared/SettingsTab';
import { InputModal } from './ui/shared/InputModal';
import { ObsidianVaultAdapter } from './infra/obsidian-vault-adapter';
import { CoreTaskAPI } from './application/core-task-api';
import { WorkbenchView, WORKBENCH_VIEW_TYPE, setWorkbenchViewApi } from './ui/workbench/WorkbenchView';
import { DEFAULT_SETTINGS, type VaultGanttSettings } from './settings';

export default class VaultGanttPlugin extends Plugin {
  private statusBarBadge: ReturnType<typeof mount> | undefined;
  api!: CoreTaskAPI;
  settings!: VaultGanttSettings;

  async onload(): Promise<void> {
    console.log(`Loading plugin: ${PLUGIN_ID}`);

    await this.loadSettings();

    const adapter = new ObsidianVaultAdapter(this.app);
    this.api = new CoreTaskAPI(adapter, { taskFolder: this.settings.taskFolder });

    // Register workbench view (set api before registering view factory)
    setWorkbenchViewApi(this.api);
    this.registerView(WORKBENCH_VIEW_TYPE, (leaf) => new WorkbenchView(leaf));

    // Status bar badge
    const statusBarEl = this.addStatusBarItem();
    this.statusBarBadge = mount(PluginBadge as Component, { target: statusBarEl });

    // Ribbon icon
    this.addRibbonIcon('table', 'タスク一覧を開く', () => this.openWorkbench());

    // Settings tab
    this.addSettingTab(new VaultGanttSettingsTab(this.app, this));

    // Commands
    this.addCommand({
      id: 'open-workbench',
      name: 'タスク一覧を開く',
      callback: () => this.openWorkbench(),
    });

    this.addCommand({
      id: 'create-new-task',
      name: '新しいタスクを作成',
      callback: () => {
        new InputModal(this.app, '新しいタスクを作成', 'タスク名を入力...', async (name) => {
          const result = await this.api.createTask({ displayName: name });
          if (!result.ok) {
            new Notice(`タスクの作成に失敗しました: ${result.error.code}`);
          }
        }).open();
      },
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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    console.log(`Unloading plugin: ${PLUGIN_ID}`);
    this.app.workspace.detachLeavesOfType(WORKBENCH_VIEW_TYPE);
    if (this.statusBarBadge) {
      unmount(this.statusBarBadge);
    }
  }
}
