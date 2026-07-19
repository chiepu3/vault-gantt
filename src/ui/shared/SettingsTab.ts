import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultGanttPlugin from '../../main';

export class VaultGanttSettingsTab extends PluginSettingTab {
  private readonly plugin: VaultGanttPlugin;

  constructor(app: App, plugin: VaultGanttPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Vault Gantt 設定' });

    new Setting(containerEl)
      .setName('タスクフォルダ')
      .setDesc('新規タスクノートを作成するフォルダのパス（存在しない場合は自動作成されます）')
      .addText((text) =>
        text
          .setPlaceholder('tasks')
          .setValue(this.plugin.settings.taskFolder)
          .onChange(async (value) => {
            this.plugin.settings.taskFolder = value.trim() || 'tasks';
            this.plugin.api.setTaskFolder(this.plugin.settings.taskFolder);
            await this.plugin.saveSettings();
          })
      );
  }
}
