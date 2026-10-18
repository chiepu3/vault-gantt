import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { MigrationPlan, MigrationReport } from "../app/migration-v1";

/**
 * Preview of the v1 -> v2 conversion: what is created and what is rewritten. 「変換する」 runs it;
 * the same dialog then shows the result.
 */
export class MigrationModal extends Modal {
  constructor(app: App, private readonly plan: MigrationPlan, private readonly run: () => Promise<MigrationReport>) {
    super(app);
  }

  onOpen(): void {
    const { plan } = this;
    this.titleEl.setText("ノート形式を v2 に変換");
    this.contentEl.replaceChildren();
    const subtaskCount = plan.items.reduce((sum, item) => sum + item.subtasks.length, 0);
    this.contentEl.createEl("p", { text: `タスク ${plan.items.length} 件を書き換え、サブタスクのノート ${subtaskCount} 件を作成します。変換前に、タスクフォルダ全体を ${plan.backupRoot}/ にコピーします。` });
    const list = this.contentEl.createEl("ul");
    for (const item of plan.items) {
      list.createEl("li", { text: `変更: ${item.path}` });
      for (const sub of item.subtasks) list.createEl("li", { text: `作成: ${sub.path}` });
      for (const warning of item.warnings) list.createEl("li", { text: `注意: ${warning}` });
    }
    for (const skipped of plan.skipped) this.contentEl.createEl("p", { text: `変換しません: ${skipped.path} (${skipped.reason})` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("変換する").setCta().onClick(() => { void this.execute(); }))
      .addButton((button) => button.setButtonText("キャンセル").onClick(() => this.close()));
  }

  private async execute(): Promise<void> {
    this.contentEl.replaceChildren();
    this.contentEl.createEl("p", { text: "変換しています…" });
    let report: MigrationReport | undefined, failure: string | undefined;
    try { report = await this.run(); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    this.contentEl.replaceChildren();
    if (!report) {
      this.contentEl.createEl("p", { text: `変換を中止しました。ノートは変更していません。(${failure})` });
    } else {
      this.contentEl.createEl("p", { text: `${report.converted.length} 件を変換しました。バックアップ: ${report.backupRoot}/` });
      if (report.failed.length) {
        this.contentEl.createEl("p", { text: `${report.failed.length} 件は変換せず、元の内容に戻しました:` });
        const list = this.contentEl.createEl("ul");
        for (const failed of report.failed) list.createEl("li", { text: `${failed.path}: ${failed.reason}` });
      }
      for (const warning of report.warnings) this.contentEl.createEl("p", { text: `注意: ${warning}` });
    }
    new Setting(this.contentEl).addButton((button) => button.setButtonText("閉じる").setCta().onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }
}
