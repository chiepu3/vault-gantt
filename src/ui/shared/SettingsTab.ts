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

    // ── タスク管理 ──────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'タスク管理' });

    new Setting(containerEl)
      .setName('タスクフォルダ')
      .setDesc('新規タスクノートを作成するフォルダのパス（存在しない場合は自動作成されます）')
      .addText((text) =>
        text
          .setPlaceholder('vault-gantt')
          .setValue(this.plugin.settings.taskFolder)
          .onChange(async (value) => {
            this.plugin.settings.taskFolder = value.trim() || 'vault-gantt';
            this.plugin.api.setTaskFolder(this.plugin.settings.taskFolder);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('完了タスクをデフォルトで非表示')
      .setDesc('Workbenchを開いた際に完了タスクを非表示にします')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideCompletedByDefault)
          .onChange(async (value) => {
            this.plugin.settings.hideCompletedByDefault = value;
            await this.plugin.saveSettings();
          })
      );

    // ── ポップオーバー ──────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'ポップオーバー' });

    new Setting(containerEl)
      .setName('現況テキストエリアの高さ（行数）')
      .setDesc('バークリック時のポップオーバーに表示される現況テキストエリアの行数')
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.currentStatusRows)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.currentStatusRows = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Gantt ───────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Ganttビュー' });

    new Setting(containerEl)
      .setName('祝日を表示')
      .setDesc('日本の祝日をガントチャートでグレーアウト表示し、バー移動時にスキップします')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableHolidays)
          .onChange(async (value) => {
            this.plugin.settings.enableHolidays = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
