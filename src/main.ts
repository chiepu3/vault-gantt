import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import { PLUGIN_ID } from './domain/version';
import PluginBadge from './ui/shared/PluginBadge.svelte';
import { VaultGanttSettingsTab } from './ui/shared/SettingsTab';
import { InputModal } from './ui/shared/InputModal';
import { ObsidianVaultAdapter } from './infra/obsidian-vault-adapter';
import { CoreTaskAPI } from './application/core-task-api';
import { WorkbenchView, WORKBENCH_VIEW_TYPE, setWorkbenchViewApi } from './ui/workbench/WorkbenchView';
import { GanttView, GANTT_VIEW_TYPE, setGanttViewApi } from './ui/gantt/GanttView';
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

    // Register workbench and gantt views (set api before registering view factory)
    setWorkbenchViewApi(this.api);
    this.registerView(WORKBENCH_VIEW_TYPE, (leaf) => new WorkbenchView(leaf));

    setGanttViewApi(this.api);
    this.registerView(GANTT_VIEW_TYPE, (leaf) => new GanttView(leaf));

    // The Core API's ChangeNotifier only fires for this plugin's own mutations.
    // External changes — cloud sync, manual edits, and metadataCache finishing
    // its (async) indexing of freshly created files — must be fed in here, or
    // the table goes permanently stale / misses just-created tasks.
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => {
        if (cache.frontmatter?.type === 'task') {
          this.api.notifyExternalChange({ type: 'updated', path: file.path });
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.api.notifyExternalChange({ type: 'deleted', path: file.path });
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.api.notifyExternalChange({ type: 'deleted', path: oldPath });
        this.api.notifyExternalChange({ type: 'updated', path: file.path });
      })
    );
    // One-shot refresh once the metadata cache finishes initial vault indexing;
    // before that, listTaskFilePaths() sees only partially indexed frontmatter.
    const resolvedRef = this.app.metadataCache.on('resolved', () => {
      this.app.metadataCache.offref(resolvedRef);
      this.api.notifyExternalChange({ type: 'updated', path: '' });
    });
    this.registerEvent(resolvedRef);

    // Status bar badge
    const statusBarEl = this.addStatusBarItem();
    this.statusBarBadge = mount(PluginBadge as Component, { target: statusBarEl });

    // Ribbon icons
    this.addRibbonIcon('table', 'タスク一覧を開く', () => this.openWorkbench());
    this.addRibbonIcon('gantt-chart', 'Ganttビューを開く', () => void this.openGantt());

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

    this.addCommand({
      id: 'open-gantt',
      name: 'Ganttビューを開く',
      callback: () => void this.openGantt(),
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

  private async openGantt(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(GANTT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: GANTT_VIEW_TYPE, active: true });
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
    this.app.workspace.detachLeavesOfType(GANTT_VIEW_TYPE);
    if (this.statusBarBadge) {
      unmount(this.statusBarBadge);
    }
  }
}
