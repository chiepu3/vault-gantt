import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import { PLUGIN_ID } from './domain/version';
import PluginBadge from './ui/shared/PluginBadge.svelte';
import { VaultGanttSettingsTab } from './ui/shared/SettingsTab';
import { InputModal } from './ui/shared/InputModal';
import { ObsidianVaultAdapter } from './infra/obsidian-vault-adapter';
import { CoreTaskAPI } from './application/core-task-api';
import { WorkbenchView, WORKBENCH_VIEW_TYPE, setWorkbenchViewApi } from './ui/workbench/WorkbenchView';
import { GanttView, GANTT_VIEW_TYPE, setGanttViewApi, setGanttZoomCallbacks } from './ui/gantt/GanttView';
import { DEFAULT_SETTINGS, type VaultGanttSettings } from './settings';
import { migrateLegacyTaskNote } from './domain/task-note/migrate-legacy';
import { splitFrontmatterBlock } from './infra/frontmatter-split';
import { calculateAutoPriority } from './domain/priority';
import { todayStr } from './ui/gantt/gantt-date-utils';

export default class VaultGanttPlugin extends Plugin {
  private statusBarBadge: ReturnType<typeof mount> | undefined;
  api!: CoreTaskAPI;
  settings!: VaultGanttSettings;
  private lastRefreshDate: string = '';

  async onload(): Promise<void> {
    console.log(`Loading plugin: ${PLUGIN_ID}`);

    await this.loadSettings();

    const adapter = new ObsidianVaultAdapter(this.app);
    this.api = new CoreTaskAPI(adapter, { taskFolder: this.settings.taskFolder });

    // Register workbench and gantt views (set api before registering view factory)
    setWorkbenchViewApi(this.api);
    this.registerView(WORKBENCH_VIEW_TYPE, (leaf) => new WorkbenchView(leaf));

    setGanttViewApi(this.api);
    setGanttZoomCallbacks(
      (v) => { this.settings.ganttZoom = v; void this.saveSettings(); },
      () => this.settings.ganttZoom,
    );
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

    // B5: Priority refresh on load (after vault indexing settles)
    this.lastRefreshDate = todayStr();
    setTimeout(() => {
      void this.refreshAllPriorities();
    }, 2000);

    // B5: Daily priority refresh (hourly check if date changed)
    this.registerInterval(
      window.setInterval(() => {
        const today = todayStr();
        if (today !== this.lastRefreshDate) {
          this.lastRefreshDate = today;
          void this.refreshAllPriorities();
        }
      }, 60 * 60 * 1000)
    );

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

    this.addCommand({
      id: 'migrate-legacy-notes',
      name: '「タスク」フォルダの旧形式ノートを移行',
      callback: () => void this.migrateLegacyNotes(),
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

  /**
   * Refresh priorities for all tasks with priorityMode === 'auto'.
   * For each task, recalculate the priority based on today's date.
   * If the computed priority differs from the stored priority, update it silently.
   * Logs count of refreshed tasks to console only.
   */
  private async refreshAllPriorities(): Promise<void> {
    try {
      const today = todayStr();
      const tasks = await this.api.listTasks();
      let refreshedCount = 0;

      for (const record of tasks) {
        if (record.note.priorityMode === 'auto') {
          // listTasks() returns already-projected notes, so record.note.priority equals
          // calculateAutoPriority() — comparing them would always be equal. Write unconditionally
          // so the on-disk value stays in sync with the auto-computed value.
          const newPriority = calculateAutoPriority(record.note.dueDate, today);
          const result = await this.api.updateTaskItem({
            path: record.path,
            expectedRevision: record.revision,
            parent: { priority: newPriority },
          });
          if (result.ok) {
            refreshedCount++;
          } else {
            console.warn(`[vault-gantt] 優先度更新スキップ(競合): ${record.path}`);
          }
        }
      }

      if (refreshedCount > 0) {
        console.log(`[vault-gantt] 優先度更新完了: ${refreshedCount}件`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[vault-gantt] 優先度更新中にエラーが発生しました:`, message);
    }
  }

  private async migrateLegacyNotes(): Promise<void> {
    const allFiles = this.app.vault.getMarkdownFiles();
    const taskFolderPath = this.settings.taskFolder;

    // Filter files in task folder
    const filesInFolder = allFiles.filter((file) => {
      return file.path.startsWith(taskFolderPath);
    });

    const migrationResults: { success: number; failed: number; warnings: string[] } = {
      success: 0,
      failed: 0,
      warnings: [],
    };

    for (const file of filesInFolder) {
      try {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;

        // Skip non-task files
        if (frontmatter?.type !== 'task') {
          continue;
        }

        // Detect legacy format: check for any key matching /^subtask__/
        const hasLegacyFormat = Object.keys(frontmatter).some((key) => key.startsWith('subtask__'));

        if (!hasLegacyFormat) {
          continue;
        }

        // Read full content
        const content = await this.app.vault.read(file);
        const { body: bodyText } = splitFrontmatterBlock(content);

        // Migrate using domain layer
        const result = migrateLegacyTaskNote(frontmatter, bodyText);

        // Write frontmatter using Obsidian's API
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          // Clear old keys
          for (const key of Object.keys(fm)) {
            delete fm[key];
          }
          // Assign new frontmatter
          Object.assign(fm, result.frontmatter);
        });

        // Write body if it changed — re-read to get the frontmatter block that
        // processFrontMatter just wrote, rather than using the pre-migration snapshot.
        if (result.body !== bodyText) {
          const afterFmWrite = await this.app.vault.read(file);
          const { frontmatterBlock: newFmBlock } = splitFrontmatterBlock(afterFmWrite);
          await this.app.vault.modify(file, newFmBlock + result.body);
        }

        migrationResults.success++;

        // Collect warnings
        if (result.warnings.length > 0) {
          migrationResults.warnings.push(`${file.path}: ${result.warnings.join('; ')}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[vault-gantt] Migration failed for "${file.path}":`, err);
        migrationResults.failed++;
        migrationResults.warnings.push(`${file.path}: エラー - ${message}`);
      }
    }

    // Show summary
    const summary =
      `移行完了: ${migrationResults.success}ファイル成功、${migrationResults.failed}ファイル失敗` +
      (migrationResults.warnings.length > 0 ? `\n\n⚠️ 警告:\n${migrationResults.warnings.join('\n')}` : '');

    new Notice(summary);
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
