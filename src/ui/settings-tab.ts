/* global __VG_VERSION__, __VG_COMMIT__, __VG_BUILT_AT__ */
import { Notice, PluginSettingTab, Setting, moment } from "obsidian";

import type { App, Plugin, ColorComponent, TextComponent, DropdownComponent } from "obsidian";

import type {
  DailyTodoSourceConfig,
  GanttTagDefinition,
  TaskWorkbenchSettings,
} from "../core/types";
import type { HolidayService } from "../app/holiday-service";
import { detectConfiguredDailyNoteSettings } from "../app/daily-note-creation";
import { addDailyTodoSource as appendDailyTodoSource } from "../app/daily-todo-service";






export interface SettingsTabHost {
  settings: TaskWorkbenchSettings;
  holidays: HolidayService;
  saveSettings(): Promise<void>;
  startGanttSyncTimer(): void;
  updateAutoPriorities(): Promise<void>;
  syncReadonlyGanttNow(): Promise<void>;
}

function normalizeTaskFolder(value: string): string {
  const folder = value.trim();
  // taskFolder becomes a literal filesystem prefix. This
  // narrow security guard rejects only exact '..' path segments; all other

  if (folder === "" || folder.split("/").some((segment) => segment === "..")) {
    return "tasks";
  }
  return folder;
}

/**
 * format-only special-holiday normalization. It
 * intentionally does not validate whether the resulting calendar date exists.
 */
export function normalizeSpecialHolidays(value: string): string[] {
  const normalized = value
    .split(/[\r\n,;]+/)
    .map((item) => item.trim().replace(/\//g, "-"))
    .map((item) => item.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);

  return Array.from(new Set(normalized)).sort();
}


/** resolve the current date for the live format preview. */
function formatDailyTodoPreview(format: string): string {
  return `${moment().format(format)}.md`;
}










function toPickerHex(value: string): string | null {
  const match = value.trim().match(/^#([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toLowerCase()}` : null;
}

/**
 * Syncs the tag-color preview swatch to a definition color without rebuilding
 * the settings DOM. Empty color intentionally leaves a neutral bordered
 * swatch, matching the initial render.
 */
function updateTagColorSwatch(swatch: HTMLElement, color: string): void {
  if (color === "") {
    swatch.classList.add("is-empty");
    swatch.style.backgroundColor = "";
    swatch.setAttribute("aria-label", "タグ色なし");
  } else {
    swatch.classList.remove("is-empty");
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-label", `タグ色: ${color}`);
  }
}


/**
 * Normalizes the tag-definition registry whenever the settings UI reads it.
 * A malformed non-array is reset to an empty registry. When a tag has no key,
 * the key is derived from its trimmed, non-empty name instead of a timestamp,
 * keeping the fallback deterministic and testable.
 */
export function ensureGanttTagDefinitions(
  settings: Pick<TaskWorkbenchSettings, "ganttTags">
): GanttTagDefinition[] {
  const rawTags: unknown = settings.ganttTags;
  if (!Array.isArray(rawTags)) {
    settings.ganttTags = [];
    return settings.ganttTags;
  }

  const normalized = rawTags
    .map((rawTag: unknown, index) => {
      const tag =
        typeof rawTag === "object" && rawTag !== null
          ? (rawTag as Record<string, unknown>)
          : {};
      const name = String(tag.name ?? "").trim();
      if (name === "") {
        return null;
      }

      const rawKey = tag.key;
      const key =
        typeof rawKey === "string" && rawKey.trim() !== "" ? rawKey : name;
      const color = String(tag.color ?? "").trim();
      const order =
        typeof tag.order === "number" && Number.isFinite(tag.order)
          ? tag.order
          : index * 1000;

      return { definition: { key, name, color, order }, index };
    })
    .filter(
      (entry): entry is { definition: GanttTagDefinition; index: number } =>
        entry !== null
    )
    .sort(
      (left, right) =>
        left.definition.order - right.definition.order || left.index - right.index
    )
    .map((entry) => entry.definition);

  settings.ganttTags = normalized;
  return normalized;
}










export class TaskWorkbenchSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly hostPlugin: SettingsTabHost & Plugin
  ) {
    super(app, hostPlugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();

    new Setting(containerEl).setName("Task Workbench 設定").setHeading();

    // section 1, 基本設定
    new Setting(containerEl).setName("基本設定").setHeading();


    new Setting(containerEl)
      .setName("Task folder")
      .setDesc("例: tasks")
      .addText((text) =>
        text
          .setValue(this.hostPlugin.settings.taskFolder || "tasks")
          .setPlaceholder("例: tasks")
          .onChange(async (value: string) => {
            this.hostPlugin.settings.taskFolder = normalizeTaskFolder(value);
            await this.hostPlugin.saveSettings();
          })
      );


    new Setting(containerEl)
      .setName("Filename uses date prefix")
      .setDesc("tasks/yyyy/mm/yyyy-mm-dd タイトル.md のように作成")
      .addToggle((toggle) =>
        toggle
          .setValue(this.hostPlugin.settings.filenameUsesDatePrefix !== false)
          .onChange(async (value: boolean) => {
            this.hostPlugin.settings.filenameUsesDatePrefix = value;
            await this.hostPlugin.saveSettings();
          })
      );


    new Setting(containerEl)
      .setName("Hide completed by default")
      .addToggle((toggle) =>
        toggle
          .setValue(this.hostPlugin.settings.hideCompletedByDefault !== false)
          .onChange(async (value: boolean) => {
            this.hostPlugin.settings.hideCompletedByDefault = value;
            await this.hostPlugin.saveSettings();
          })
      );


    new Setting(containerEl)
      .setName("Current Status rows")
      .addText((text) => {
        text.inputEl.type = "number";
        return text
          .setValue(String(this.hostPlugin.settings.currentStatusRows ?? 5))
          .onChange(async (value: string) => {
            // Apply the `|| 5` fallback to the raw string before conversion.
            // Otherwise, `Number(value) || 5` would treat a valid "0" like an
            // empty or invalid value.

            const parsed = Number(value || 5);
            this.hostPlugin.settings.currentStatusRows = Math.max(
              3,
              Number.isNaN(parsed) ? 5 : parsed
            );
            await this.hostPlugin.saveSettings();
          });
      });

    // save first, then launch the existing force-update path.
    new Setting(containerEl)
      .setName("期限にもとづく優先度の自動設定")
      .setDesc(
        "オンの場合、期限切れ・当日を★★★★★、3日以内を★★★★、7日以内を★★★、14日以内を★★、それ以降を★として、起動時などに1日単位で更新します。手動設定は上書きしません。"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.hostPlugin.settings.autoPriorityEnabled !== false)
          .onChange(async (value: boolean) => {
            this.hostPlugin.settings.autoPriorityEnabled = value;
            await this.hostPlugin.saveSettings();
            await this.hostPlugin.updateAutoPriorities();
          })
      );

    // section 2, Task Gantt 休日
    new Setting(containerEl).setName("Task Gantt 休日").setHeading();


    new Setting(containerEl)
      .setName("内閣府の祝日")
      .setDesc(
        `内閣府のCSVを最大30日ごとに取得します。最終更新: ${this.hostPlugin.settings.ganttNationalHolidaysUpdatedAt || "未取得"}`
      )
      .addButton((button) =>
        button.setButtonText("今すぐ更新").onClick(() => {
          // No lock is intentional; concurrent refreshes follow the service's
          // existing behavior.
          void this.refreshNationalHolidays();
        })
      );


    new Setting(containerEl)
      .setName("今年度の特別休暇")
      .setDesc(
        "1行に1日、YYYY-MM-DD または YYYY/M/D で入力します。公式祝日と特別休暇は曜日クリックでは解除できません。"
      )
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        return text
          .setValue((this.hostPlugin.settings.ganttSpecialHolidays ?? []).join("\n"))
          .setPlaceholder("2026-08-10\n2026-12-29")
          .onChange(async (value: string) => {
            this.hostPlugin.settings.ganttSpecialHolidays =
              normalizeSpecialHolidays(value);
            // Keep the holiday sources separate; Gantt combines their lists
            // when rendering.

            await this.hostPlugin.saveSettings();
          });
      });

    // section 3, Task Gantt 機能の有効化
    new Setting(containerEl)
      .setName("Task Gantt 機能の有効化")
      .setHeading();

    this.addImmediateToggle(
      containerEl,
      "Daily ToDoを表示",
      "オンの場合、Daily ToDo 行と編集用popover機能を有効にします。OFFにすると関連UIを表示しません。",
      "ganttFeatureDailyTodoEnabled"
    );
    this.addImmediateToggle(
      containerEl,
      "作業時間を表示",
      "オンの場合、作業時間集計・実績/想定ラベル・編集popover・日別内訳popover機能を有効にします。OFFにすると関連UIを表示しません。",
      "ganttFeatureWorkloadEnabled"
    );
    this.addImmediateToggle(
      containerEl,
      "その他 行を表示",
      "オンの場合、「その他」行の簡易ToDo/イベント追加・移動機能を有効にします。OFFにすると関連UIを表示しません。",
      "ganttFeatureEventsEnabled"
    );
    this.addImmediateToggle(
      containerEl,
      "同期機能",
      "OFFにすると、Gantt の同期系ボタンを隠します。既存データは削除しません。",
      "ganttFeatureSyncEnabled"
    );
    this.addImmediateToggle(
      containerEl,
      "タグ機能",
      "OFFにすると、タグの右クリックメニュー、タグ色、タグフィルター、タグ表示を無効にします。タグ定義と既存タグは保持します。",
      "ganttFeatureTagsEnabled"
    );
    this.addImmediateToggle(
      containerEl,
      "Gantt差分描画を有効化",
      "オンの場合、変更されたタスク行のみを再描画します。大量のタスクがある場合にパフォーマンスが向上します。OFFにすると毎回フル再描画します。",
      "incrementalGanttRender"
    );

    // section 4, Task Gantt タグ (display toggles only).
    new Setting(containerEl).setName("Task Gantt タグ").setHeading();
    this.addImmediateToggle(
      containerEl,
      "サブタスク上にタグ名を表示",
      "オンの場合、サブタスク bar の中に優先タグ名を小さく表示します。",
      "ganttShowTagsOnBars"
    );
    this.addImmediateToggle(
      containerEl,
      "親タスクのタグ名を子タスクにも表示",
      "オンの場合、親タスク由来のタグ色で塗った子タスクにも、親タグ名を小さく表示します。OFFでも色の継承は行います。",
      "ganttShowParentTagsOnChildBars",
      true
    );
    this.addImmediateToggle(
      containerEl,
      "親タスク列にタグ名を表示",
      "オンの場合、親タスク名の下にタグ名を小さく表示します。",
      "ganttShowTagsOnParents"
    );


    // The wrapper is retained so tag operations can redraw only this portion
    // of the settings screen; the other sections keep their existing DOM.
    const tagListContainer = containerEl.createDiv({
      cls: "task-workbench-gantt-tag-list",
    });
    this.renderTagList(tagListContainer);


    // Configure the Daily ToDo sources. Visibility is controlled by the
    // feature toggle above; this list determines which sources are included.
    new Setting(containerEl).setName("Task Gantt Daily ToDo").setHeading();
    const dailyTodoSourceListContainer = containerEl.createDiv({
      cls: "task-workbench-daily-todo-source-list",
    });
    this.renderDailyTodoSourceList(dailyTodoSourceListContainer);


    // section 6, Task Gantt 外部同期
    new Setting(containerEl).setName("Task Gantt 外部同期").setHeading();


    new Setting(containerEl)
      .setName("Gantt server sync")
      .setDesc("オンにすると、設定したサーバーURLへ読み取り専用Gantt snapshotを定期同期します。")
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.hostPlugin.settings.ganttSyncEnabled)
          .onChange(async (value: boolean) => {
            this.hostPlugin.settings.ganttSyncEnabled = value;
            await this.hostPlugin.saveSettings();
            this.hostPlugin.startGanttSyncTimer();
          })
      );


    new Setting(containerEl)
      .setName("Gantt server URL")
      .setDesc("例: http://localhost:8787 。/api/snapshot は自動で補います。")
      .addText((text) =>
        text
          .setValue(this.hostPlugin.settings.ganttSyncUrl || "")
          .setPlaceholder("http://localhost:8787")
          .onChange(async (value: string) => {
            this.hostPlugin.settings.ganttSyncUrl = value.trim();
            await this.hostPlugin.saveSettings();
            this.hostPlugin.startGanttSyncTimer();
          })
      );


    new Setting(containerEl)
      .setName("Gantt sync interval minutes")
      .setDesc("変更がない場合は送信を省略します。最小値は1です。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        return text
          .setValue(String(this.hostPlugin.settings.ganttSyncIntervalMinutes ?? 5))
          .onChange(async (value: string) => {
            // Use 5 for empty or non-numeric input and clamp to at least 1.

            const parsed = Number(value || 5);
            this.hostPlugin.settings.ganttSyncIntervalMinutes = Math.max(
              1,
              Number.isNaN(parsed) ? 5 : parsed
            );
            await this.hostPlugin.saveSettings();
            this.hostPlugin.startGanttSyncTimer();
          });
      });

    // intentionally fire-and-forget, so timer/manual sync can
    // overlap exactly as the existing Gantt sync path permits.
    new Setting(containerEl)
      .setName("Gantt sync now")
      .setDesc("現在のGantt snapshotをすぐにサーバーへ送信します。")
      .addButton((button) =>
        button
          .setButtonText("今すぐ同期")
          .setCta()
          .onClick(() => {
            void this.hostPlugin.syncReadonlyGanttNow();
          })
      );

    const version =
      typeof __VG_VERSION__ === "undefined" ? "unknown" : __VG_VERSION__;
    const commit =
      typeof __VG_COMMIT__ === "undefined" ? "unknown" : __VG_COMMIT__;
    const builtAt =
      typeof __VG_BUILT_AT__ === "undefined" ? "unknown" : __VG_BUILT_AT__;
    containerEl.createDiv({
      cls: "setting-item-description",
      text: `Vault Gantt v${version} (${commit}; built ${builtAt})`,
    });
  }


  private addImmediateToggle(
    containerEl: HTMLElement,
    name: string,
    description: string,
    field: keyof TaskWorkbenchSettings,
    strictTrue = false
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) =>
        toggle
          .setValue(
            strictTrue
              ? this.hostPlugin.settings[field] === true
              : this.hostPlugin.settings[field] !== false
          )
          .onChange(async (value: boolean) => {
            (this.hostPlugin.settings[field] as boolean) = value;
            await this.hostPlugin.saveSettings();
          })
      );
  }

  /**
 *
 * Render only the tag-definition portion of the settings tab.
 */
  private renderTagList(containerEl: HTMLElement): void {
    const definitions = ensureGanttTagDefinitions(this.hostPlugin.settings);
    containerEl.replaceChildren();

    if (definitions.length === 0) {
      new Setting(containerEl).setDesc(
        "タグはまだありません。右クリックメニュー、または下のボタンから作成できます。"
      );
    }

    definitions.forEach((definition, index) => {
      const row = new Setting(containerEl).setName(definition.name);
      const swatch = row.controlEl.createSpan({
        cls: "task-workbench-gantt-tag-color-swatch",
      });
      swatch.style.display = "inline-block";
      swatch.style.width = "1em";
      swatch.style.height = "1em";
      swatch.style.border = "1px solid var(--background-modifier-border)";
      swatch.style.marginRight = "0.5em";


      // Color edits must not rebuild the tag-list DOM subtree. The text
      // field's onChange fires on every keystroke; a full re-render would
      // replace the focused input. Update the swatch and color picker in place.
      updateTagColorSwatch(swatch, definition.color);

      let colorTextInput: TextComponent | null = null;
      let colorPickerInput: ColorComponent | null = null;

      row
        .addText((text) =>
          text
            .setValue(definition.name)
            .onChange(async (value: string) => {
              // only name changes; key remains stable forever.
              definition.name = value.trim() || definition.name || definition.key;
              await this.hostPlugin.saveSettings();
            })
        )
        .addText((text) => {
          colorTextInput = text;
          return text
            .setValue(definition.color)
            .onChange(async (value: string) => {
              definition.color = value.trim();
              await this.hostPlugin.saveSettings();
              updateTagColorSwatch(swatch, definition.color);
              const pickerHex = toPickerHex(definition.color);
              if (pickerHex !== null && colorPickerInput) {
                colorPickerInput.setValue(pickerHex);
              }
            });
        })
        .addColorPicker((picker) => {
          colorPickerInput = picker;
          return picker
            .setValue(toPickerHex(definition.color) ?? "#000000")
            .onChange(async (value: string) => {
              definition.color = value;
              await this.hostPlugin.saveSettings();
              updateTagColorSwatch(swatch, definition.color);
              if (colorTextInput) {
                colorTextInput.setValue(definition.color);
              }
            });
        })

        .addButton((button) =>
          button
            .setButtonText("↑")
            .setDisabled(index === 0)
            .onClick(() => this.moveGanttTag(containerEl, index, -1))
        )
        .addButton((button) =>
          button
            .setButtonText("↓")
            .setDisabled(index === definitions.length - 1)
            .onClick(() => this.moveGanttTag(containerEl, index, 1))
        )
        .addButton((button) =>
          button
            .setButtonText("削除")
            .onClick(() => this.deleteGanttTag(containerEl, index))
        );
    });

    new Setting(containerEl)
      .setName("タグを追加")
      .setDesc(
        "色を空欄にすると、そのタグ自体は表示色を持たず、次の色付きタグが優先されます。"
      )
      .addButton((button) =>
        button
          .setButtonText("タグを追加")
          .setCta()
          .onClick(() => this.addGanttTag(containerEl))
      );
  }


  private async moveGanttTag(
    containerEl: HTMLElement,
    index: number,
    offset: -1 | 1
  ): Promise<void> {
    const definitions = ensureGanttTagDefinitions(this.hostPlugin.settings);
    const targetIndex = index + offset;
    if (
      index < 0 ||
      index >= definitions.length ||
      targetIndex < 0 ||
      targetIndex >= definitions.length
    ) {
      return;
    }

    const [definition] = definitions.splice(index, 1);
    definitions.splice(targetIndex, 0, definition);
    definitions.forEach((tag, order) => {
      tag.order = order * 1000;
    });
    await this.hostPlugin.saveSettings();
    this.renderTagList(containerEl);
  }


  private async deleteGanttTag(
    containerEl: HTMLElement,
    index: number
  ): Promise<void> {
    const definitions = ensureGanttTagDefinitions(this.hostPlugin.settings);
    if (index < 0 || index >= definitions.length) {
      return;
    }

    definitions.splice(index, 1);
    definitions.forEach((tag, order) => {
      tag.order = order * 1000;
    });
    await this.hostPlugin.saveSettings();
    this.renderTagList(containerEl);
  }


  private async addGanttTag(containerEl: HTMLElement): Promise<void> {
    const definitions = ensureGanttTagDefinitions(this.hostPlugin.settings);
    const currentCount = definitions.length;
    const name = `タグ${currentCount + 1}`;
    definitions.push({
      key: name,
      name,
      color: "",
      order: currentCount * 1000,
    });
    await this.hostPlugin.saveSettings();
    this.renderTagList(containerEl);
  }


  /**
 *
 * Returns the mutable source array used by the list editor, normalizing a
 * malformed persisted value before any UI operation touches it.
 */
  private getEditableDailyTodoSources(): DailyTodoSourceConfig[] {
    if (!Array.isArray(this.hostPlugin.settings.dailyTodoSources)) {
      this.hostPlugin.settings.dailyTodoSources = [];
    }
    return this.hostPlugin.settings.dailyTodoSources;
  }

  /**
 *
 * Render only the Daily ToDo source-definition portion of the settings tab.
 * Text edits deliberately save in place without rebuilding the row so the
 * focused input survives keystrokes while its preview updates immediately.
 */
  private renderDailyTodoSourceList(containerEl: HTMLElement): void {
    const sources = this.getEditableDailyTodoSources();
    containerEl.replaceChildren();
    let targetDropdown: DropdownComponent | undefined;

    new Setting(containerEl)
      .setName("新規ToDoの追加先")
      .setDesc(
        "新規ToDoを追加するソースです。ノートがない場合は「Ganttから新規作成可」をオンにしてください。"
      )
      .addDropdown((dropdown) => {
        targetDropdown = dropdown;
        const targetKey = this.hostPlugin.settings.dailyTodoTargetSourceKey ?? "main";
        if (!sources.some((source) => source.key === targetKey)) {
          dropdown.addOption(targetKey, "追加先を選んでください");
        }
        sources.forEach((source, index) => {
          dropdown.addOption(source.key, source.label || `ソース ${index + 1}`);
        });
        dropdown.setValue(targetKey).onChange(async (value) => {
          this.hostPlugin.settings.dailyTodoTargetSourceKey = value;
          await this.hostPlugin.saveSettings();
        });
      });

    if (sources.length === 0) {
      new Setting(containerEl).setDesc(
        "Daily ToDoソースはまだありません。「追加」から作成できます。"
      );
    }

    sources.forEach((source, index) => {
      const row = new Setting(containerEl)
        .setName(source.label || `ソース ${index + 1}`)
        .setDesc("ラベル・書式・テンプレートを編集できます。");
      let previewEl: HTMLElement | null = null;

      row
        .addText((text) =>
          text
            .setValue(source.label)
            .setPlaceholder("ラベル")
            .onChange(async (value: string) => {
              // labels are editable in place and save immediately.
              source.label = value.trim();
              row.setName(source.label || `ソース ${index + 1}`);
              const targetOption = targetDropdown && Array.from(targetDropdown.selectEl.options)
                .find((option) => option.value === source.key);
              if (targetOption) {
                targetOption.text = source.label || `ソース ${index + 1}`;
              }
              await this.hostPlugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setValue(source.format)
            .setPlaceholder("書式（例: [Journal]/YYYY-MM-DD）")
            .onChange(async (value: string) => {
              // preserve the raw Moment format and update
              // the preview without replacing the active text input.
              source.format = value;
              if (previewEl) {
                previewEl.textContent = `プレビュー: ${formatDailyTodoPreview(
                  source.format
                )}`;
              }
              await this.hostPlugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setValue(source.templatePath ?? "")
            .setPlaceholder("テンプレート（任意）")
            .onChange(async (value: string) => {
              // an empty template input means no template.
              const templatePath = value.trim();
              source.templatePath = templatePath || undefined;
              await this.hostPlugin.saveSettings();
            })
        );

      previewEl = row.controlEl.createDiv({
        cls: "task-workbench-daily-todo-source-preview",
        text: `プレビュー: ${formatDailyTodoPreview(source.format)}`,
      });
      row.controlEl.createDiv({
        cls: "task-workbench-daily-todo-source-format-help",
        text:
          "日付以外の文字は [ ] で囲んでください（例: [Journal]/YYYY-MM-DD）",
      });
      row.controlEl.createDiv({
        cls: "task-workbench-daily-todo-source-creatable-label",
        text: "Ganttから新規作成可",
      });

      row
        .addToggle((toggle) =>
          toggle
            .setValue(source.creatableFromGantt)
            .onChange(async (value: boolean) => {
              // persist the creation permission in place.
              source.creatableFromGantt = value;
              await this.hostPlugin.saveSettings();
            })
        )
        .addButton((button) =>
          button
            .setButtonText("↑")
            .setDisabled(index === 0)
            .onClick(() => this.moveDailyTodoSource(containerEl, index, -1))
        )
        .addButton((button) =>
          button
            .setButtonText("↓")
            .setDisabled(index === sources.length - 1)
            .onClick(() => this.moveDailyTodoSource(containerEl, index, 1))
        )
        .addButton((button) =>
          button
            .setButtonText("削除")
            .onClick(() => this.deleteDailyTodoSource(containerEl, index))
        );
    });

    new Setting(containerEl)
      .setName("ソース操作")
      .addButton((button) =>
        button
          .setButtonText("追加")
          .setCta()
          .onClick(() => this.addDailyTodoSource(containerEl))
      )
      .addButton((button) =>
        button
          .setButtonText("Daily Notes設定から取り込む")
          .onClick(() => this.importDailyTodoSource(containerEl))
      );
  }


  private async moveDailyTodoSource(
    containerEl: HTMLElement,
    index: number,
    offset: -1 | 1
  ): Promise<void> {
    const sources = this.getEditableDailyTodoSources();
    const targetIndex = index + offset;
    if (
      index < 0 ||
      index >= sources.length ||
      targetIndex < 0 ||
      targetIndex >= sources.length
    ) {
      return;
    }

    const [source] = sources.splice(index, 1);
    sources.splice(targetIndex, 0, source);
    await this.hostPlugin.saveSettings();
    this.renderDailyTodoSourceList(containerEl);
  }


  private async deleteDailyTodoSource(
    containerEl: HTMLElement,
    index: number
  ): Promise<void> {
    const sources = this.getEditableDailyTodoSources();
    if (index < 0 || index >= sources.length) {
      return;
    }

    sources.splice(index, 1);
    await this.hostPlugin.saveSettings();
    this.renderDailyTodoSourceList(containerEl);
  }


  private async addDailyTodoSource(containerEl: HTMLElement): Promise<void> {
    appendDailyTodoSource(this.hostPlugin.settings);
    await this.hostPlugin.saveSettings();
    this.renderDailyTodoSourceList(containerEl);
  }


  private async importDailyTodoSource(containerEl: HTMLElement): Promise<void> {
    const detected = detectConfiguredDailyNoteSettings(this.app);
    if (!detected) {
      new Notice("Daily NotesまたはPeriodic Notesの設定が見つかりませんでした");
      return;
    }

    // The detected folder is a literal path from Obsidian's own settings, so
    // wrapping the complete value is intentional. Imported Daily Notes are

    // fixes the format/template but leaves these two UI defaults unspecified.
    appendDailyTodoSource(this.hostPlugin.settings, {
      label: detected.folder,
      format: `[${detected.folder}]/${detected.format}`,
      creatableFromGantt: true,
      ...(detected.templatePath
        ? { templatePath: detected.templatePath }
        : {}),
    });
    await this.hostPlugin.saveSettings();
    this.renderDailyTodoSourceList(containerEl);
  }



  async refreshNationalHolidays(): Promise<void> {
    await this.hostPlugin.holidays.refreshNationalHolidays(true, true);
    this.display();
  }
}
