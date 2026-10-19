import type { McpSettings } from "../mcp/server";
import { getBuildInfo } from "../build-info";
import { Notice, PluginSettingTab, Setting, moment } from "obsidian";

import type { App, Plugin, ColorComponent, TextComponent, DropdownComponent } from "obsidian";

import { AI_PRESET_LABELS, AI_PRESET_URLS, aiKeyOriginError, connectionOrigin, type AiPreset, type AiProfile, type AiSettingsPatch, type ModelListResult } from "../ai/connection-settings";

import type {
  DailyTodoSourceConfig,
  GanttTagDefinition,
  TaskWorkbenchSettings,
} from "../core/types";
import type { HolidayService } from "../app/holiday-service";
import { pickGanttTagColor } from "../core/constants";
import { renderUpdaterSection } from "./updater-section";
import { detectConfiguredDailyNoteSettings } from "../app/daily-note-creation";
import { addDailyTodoSource as appendDailyTodoSource } from "../app/daily-todo-service";






export interface SettingsTabHost {
  getMcpVaultInstanceId?(): string;
  getMcpSettings?(): McpSettings;
  getMcpStatus?(): string;
  configureMcp?(): Promise<void>;
  generateMcpToken?(regenerate?: boolean): Promise<void>;
  copyMcpToken?(): Promise<void>;
  /** AI chat connection. Optional so hosts without AI chat (and tests) skip the section. */
  getAiSettings?(): AiProfile;
  updateAiSettings?(patch: AiSettingsPatch): Promise<void>;
  listAiProfiles?(): { activeId: string; profiles: Array<Pick<AiProfile, "id" | "name" | "preset" | "baseUrl">> };
  addAiProfile?(): Promise<string>;
  selectAiProfile?(id: string): Promise<void>;
  deleteAiProfile?(id: string): Promise<void>;
  hasAiApiKey?(): boolean;
  setAiApiKey?(key: string): Promise<void>;
  clearAiApiKey?(): Promise<void>;
  aiKeyStorage?(): "secret" | "data";
  fetchAiModels?(): Promise<ModelListResult>;
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










type SettingsTabId = "general" | "gantt" | "tags" | "daily" | "ai" | "integration";
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "基本" },
  { id: "gantt", label: "Gantt" },
  { id: "tags", label: "タグ" },
  { id: "daily", label: "Daily ToDo" },
  { id: "ai", label: "AI チャット" },
  { id: "integration", label: "連携" },
];

/** Most rows the available-model list draws at once; the search box narrows the rest. */
const AI_MODEL_LIST_LIMIT = 50;

/** Case-insensitive match of every whitespace-separated word against the model id. */
export function filterAiModels(models: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? models.filter((id) => words.every((word) => id.toLowerCase().includes(word))) : [...models];
}

export class TaskWorkbenchSettingTab extends PluginSettingTab {
  private activeTab: SettingsTabId = "general";
  constructor(
    app: App,
    private readonly hostPlugin: SettingsTabHost & Plugin
  ) {
    super(app, hostPlugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();

    new Setting(containerEl).setName("Task Workbench").setHeading();

    const nav = containerEl.createDiv({ cls: "vg-settings-tabs" });
    nav.setAttribute("role", "tablist");
    const panels = new Map<SettingsTabId, HTMLElement>();
    const buttons = new Map<SettingsTabId, HTMLElement>();
    const showTab = (id: SettingsTabId): void => {
      this.activeTab = id;
      for (const [key, panel] of panels) panel.toggleClass("is-active", key === id);
      for (const [key, button] of buttons) {
        button.toggleClass("is-active", key === id);
        button.setAttribute("aria-selected", String(key === id));
      }
    };
    for (const tab of SETTINGS_TABS) {
      const button = nav.createEl("button", { cls: "vg-settings-tab", text: tab.label });
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => showTab(tab.id));
      buttons.set(tab.id, button);
    }
    const panelFor = (id: SettingsTabId): HTMLElement => {
      const panel = containerEl.createDiv({ cls: "vg-settings-panel" });
      panel.setAttribute("role", "tabpanel");
      panels.set(id, panel);
      return panel;
    };

    // tab 1, 基本
    const general = panelFor("general");
    new Setting(general).setName("基本設定").setHeading();


    new Setting(general)
      .setName("タスクフォルダ")
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


    new Setting(general)
      .setName("ファイル名に日付を付ける")
      .setDesc("tasks/yyyy/mm/yyyy-mm-dd タイトル.md のように作成")
      .addToggle((toggle) =>
        toggle
          .setValue(this.hostPlugin.settings.filenameUsesDatePrefix !== false)
          .onChange(async (value: boolean) => {
            this.hostPlugin.settings.filenameUsesDatePrefix = value;
            await this.hostPlugin.saveSettings();
          })
      );


    new Setting(general)
      .setName("完了を既定で隠す")
      .addToggle((toggle) =>
        toggle
          .setValue(this.hostPlugin.settings.hideCompletedByDefault !== false)
          .onChange(async (value: boolean) => {
            this.hostPlugin.settings.hideCompletedByDefault = value;
            await this.hostPlugin.saveSettings();
          })
      );


    new Setting(general)
      .setName("現在の進捗の行数")
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
    new Setting(general)
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
    new Setting(general).setName("休日").setHeading();


    new Setting(general)
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


    new Setting(general)
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

    // tab 2, Gantt
    const gantt = panelFor("gantt");
    new Setting(gantt)
      .setName("機能の有効化")
      .setHeading();

    this.addImmediateToggle(
      gantt,
      "Daily ToDoを表示",
      "オンの場合、Daily ToDo 行と編集用popover機能を有効にします。OFFにすると関連UIを表示しません。",
      "ganttFeatureDailyTodoEnabled"
    );
    this.addImmediateToggle(
      gantt,
      "作業時間を表示",
      "オンの場合、作業時間集計・実績/想定ラベル・編集popover・日別内訳popover機能を有効にします。OFFにすると関連UIを表示しません。",
      "ganttFeatureWorkloadEnabled"
    );
    this.addImmediateToggle(
      gantt,
      "その他 行を表示",
      "オンの場合、「その他」行の簡易ToDo/イベント追加・移動機能を有効にします。OFFにすると関連UIを表示しません。",
      "ganttFeatureEventsEnabled"
    );
    this.addImmediateToggle(
      gantt,
      "同期機能",
      "OFFにすると、Gantt の同期系ボタンを隠します。既存データは削除しません。",
      "ganttFeatureSyncEnabled"
    );
    this.addImmediateToggle(
      gantt,
      "タグ機能",
      "OFFにすると、タグの右クリックメニュー、タグ色、タグフィルター、タグ表示を無効にします。タグ定義と既存タグは保持します。",
      "ganttFeatureTagsEnabled"
    );
    this.addImmediateToggle(
      gantt,
      "Gantt差分描画を有効化",
      "オンの場合、変更されたタスク行のみを再描画します。大量のタスクがある場合にパフォーマンスが向上します。OFFにすると毎回フル再描画します。",
      "incrementalGanttRender"
    );
    this.addImmediateToggle(
      gantt,
      "親タスクの高さを表示中の期間に合わせて詰める",
      "オンの場合、表示中の期間（前後に余白あり）にあるサブタスクだけで親タスクの高さを決めます。長期間のタスクで、過去や未来に重なりが多くても今見ている範囲が縦に間延びしません。OFFにすると全期間で高さを決めます。",
      "compactRowsToViewport"
    );

    // tab 3, タグ
    const tags = panelFor("tags");
    new Setting(tags).setName("タグ").setHeading();
    this.addImmediateToggle(
      tags,
      "サブタスク上にタグ名を表示",
      "オンの場合、サブタスク bar の中に優先タグ名を小さく表示します。",
      "ganttShowTagsOnBars"
    );
    this.addImmediateToggle(
      tags,
      "親タスクのタグ名を子タスクにも表示",
      "オンの場合、親タスク由来のタグ色で塗った子タスクにも、親タグ名を小さく表示します。OFFでも色の継承は行います。",
      "ganttShowParentTagsOnChildBars",
      true
    );
    this.addImmediateToggle(
      tags,
      "親タスク列にタグ名を表示",
      "オンの場合、親タスク名の下にタグ名を小さく表示します。",
      "ganttShowTagsOnParents"
    );


    // The wrapper is retained so tag operations can redraw only this portion
    // of the settings screen; the other sections keep their existing DOM.
    const tagListContainer = tags.createDiv({
      cls: "task-workbench-gantt-tag-list",
    });
    this.renderTagList(tagListContainer);


    // tab 4, Daily ToDo
    const daily = panelFor("daily");
    // Configure the Daily ToDo sources. Visibility is controlled by the
    // feature toggle above; this list determines which sources are included.
    new Setting(daily).setName("Daily ToDo").setHeading();
    const dailyTodoSourceListContainer = daily.createDiv({
      cls: "task-workbench-daily-todo-source-list",
    });
    this.renderDailyTodoSourceList(dailyTodoSourceListContainer);


    // tab 5, AI チャット
    const ai = panelFor("ai");
    new Setting(ai).setName("AIチャットの表示位置").setHeading();
    new Setting(ai)
      .setName("開く場所")
      .setDesc("ツールバーのAIボタンや起動時の自動オープンで使う場所です。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ right: "右サイドバー", left: "左サイドバー", tab: "タブ" })
          .setValue(this.hostPlugin.settings.aiChatPlacement)
          .onChange(async (value: string) => {
            this.hostPlugin.settings.aiChatPlacement = value === "left" || value === "tab" ? value : "right";
            await this.hostPlugin.saveSettings();
          })
      );
    new Setting(ai)
      .setName("起動時に自動で開く")
      .setDesc("AIチャットが開いていなければ、起動のたびに上の場所へ開きます。")
      .addToggle((toggle) =>
        toggle.setValue(!!this.hostPlugin.settings.aiChatAutoOpen).onChange(async (value: boolean) => {
          this.hostPlugin.settings.aiChatAutoOpen = value;
          await this.hostPlugin.saveSettings();
        })
      );
    this.renderAiSettings(ai.createDiv({ cls: "vg-settings-ai" }));

    const integration = panelFor("integration");
    // tab 6, 連携 (AI is built first so the tab order below stays AI, 連携)
    new Setting(integration).setName("外部同期").setHeading();


    new Setting(integration)
      .setName("Gantt サーバー同期")
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


    new Setting(integration)
      .setName("Gantt サーバー URL")
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


    new Setting(integration)
      .setName("Gantt 同期間隔（分）")
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
    new Setting(integration)
      .setName("今すぐ同期")
      .setDesc("現在のGantt snapshotをすぐにサーバーへ送信します。")
      .addButton((button) =>
        button
          .setButtonText("今すぐ同期")
          .onClick(() => {
            void this.hostPlugin.syncReadonlyGanttNow();
          })
      );

    this.renderMcpSettings(integration);
    renderUpdaterSection(integration, this.app, this.hostPlugin);
    showTab(this.activeTab);
    const { version, commit, builtAt } = getBuildInfo();
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
  /** Models the connection reports (not necessarily added). */
  private aiModels: string[] = [];
  private aiModelNote = "";
  private aiLoading = false;
  private aiKeyVisible = false;
  private aiFetchSeq = 0;
  private aiSearch = "";
  private aiEl: HTMLElement | null = null;
  private aiAddedHost: HTMLElement | null = null;
  private aiAvailHost: HTMLElement | null = null;
  private aiAvailSetting: Setting | null = null;
  private aiRefetch: { setDisabled(disabled: boolean): unknown } | null = null;
  private aiOriginSetting: Setting | null = null;
  private aiUrlHelp = "";

  private renderAiSettings(containerEl: HTMLElement): void {
    const host = this.hostPlugin;
    if (!host.getAiSettings || !host.updateAiSettings) return;
    this.aiEl = containerEl;
    this.aiModels = [];
    this.aiModelNote = "";
    this.aiSearch = "";
    this.aiKeyVisible = false;
    this.drawAiSettings();
    void this.refreshAiModels();
  }

  /** Fetches the model list. A failure leaves the manual model field in place. */
  private async refreshAiModels(): Promise<ModelListResult | null> {
    const host = this.hostPlugin;
    const settings = host.getAiSettings?.();
    if (!settings || !host.fetchAiModels) return null;
    const seq = ++this.aiFetchSeq;
    const originError = aiKeyOriginError(settings);
    if (originError) {
      this.aiModels = [];
      this.aiModelNote = originError;
      this.aiLoading = false;
      this.drawAiAvailable();
      return { ok: false, reason: originError };
    }
    if (settings.useApiKey && !host.hasAiApiKey?.()) {
      this.aiModels = [];
      this.aiModelNote = "APIキーを登録すると、利用できるモデルの一覧を取得できます。";
      this.aiLoading = false;
      this.drawAiAvailable();
      return null;
    }
    this.aiLoading = true;
    this.updateAiAvailStatus();
    const result = await host.fetchAiModels();
    if (seq !== this.aiFetchSeq) return result;
    this.aiLoading = false;
    if (result.ok) {
      this.aiModels = result.models;
      this.aiModelNote = "";
    } else {
      this.aiModels = [];
      this.aiModelNote = `一覧を取得できませんでした。${result.reason}下の欄からモデルIDを直接追加できます。`;
    }
    this.drawAiAvailable();
    return result;
  }

  private aiAvailDesc(): string {
    return this.aiLoading
      ? "モデルの一覧を取得しています…"
      : this.aiModels.length
        ? `接続先から${this.aiModels.length}件取得しました。使いたいモデルを「追加」してください。`
        : this.aiModelNote || "「再取得」で接続先から利用できるモデルの一覧を取得します。";
  }

  private updateAiAvailStatus(): void {
    this.aiAvailSetting?.setDesc(this.aiAvailDesc());
    this.aiRefetch?.setDisabled(this.aiLoading);
  }

  private async changeAiSettings(patch: AiSettingsPatch, refetch: boolean): Promise<boolean> {
    try {
      await this.hostPlugin.updateAiSettings?.(patch);
      const settings = this.hostPlugin.getAiSettings?.();
      const originError = settings ? aiKeyOriginError(settings) : undefined;
      if (settings) this.aiOriginSetting?.setDesc(this.aiUrlDescription(settings));
      if (originError) {
        ++this.aiFetchSeq;
        this.aiLoading = false;
        this.aiModels = [];
        this.aiModelNote = originError;
        this.drawAiAvailable();
      }
    } catch {
      new Notice("AI接続設定を保存できませんでした。");
      return false;
    }
    if (refetch) await this.refreshAiModels();
    return true;
  }

  private aiUrlDescription(settings: AiProfile): string {
    const description = aiKeyOriginError(settings) ?? this.aiUrlHelp;
    const origin = connectionOrigin(settings.baseUrl);
    if (settings.useApiKey && origin) {
      const url = new URL(origin);
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        return description + "\nこの接続先は http のため、APIキーが暗号化されずに送られます。";
      }
    }
    return description;
  }

  /** Switches to another profile (or a new one) and redraws the whole AI tab. */
  private async switchAiProfile(action: () => Promise<unknown>, failure: string): Promise<void> {
    try { await action(); } catch { new Notice(failure); return; }
    this.aiModels = [];
    this.aiModelNote = "";
    this.aiSearch = "";
    ++this.aiFetchSeq;
    this.aiLoading = false;
    this.drawAiSettings();
    void this.refreshAiModels();
  }

  private drawAiSettings(): void {
    const el = this.aiEl;
    const host = this.hostPlugin;
    const settings = host.getAiSettings?.();
    if (!el || !settings) return;
    el.replaceChildren();

    new Setting(el).setName("AI チャット").setHeading();
    new Setting(el).setDesc(
      "OpenAI互換のAPIに接続します。メッセージを送ると、会話の内容と必要なタスク情報が接続先へ送られます。"
    );

    // --- 接続プロファイル
    new Setting(el).setName("接続プロファイル").setHeading();
    const profiles = host.listAiProfiles?.();
    if (profiles) {
      const labels: Record<string, string> = {};
      for (const profile of profiles.profiles) labels[profile.id] = profile.name;
      new Setting(el)
        .setName("使用する接続")
        .setDesc("接続先・APIキー・追加したモデルは接続ごとに保存されます。")
        .addDropdown((dropdown) =>
          dropdown.addOptions(labels).setValue(profiles.activeId).onChange((id: string) =>
            this.switchAiProfile(() => host.selectAiProfile!(id), "接続を切り替えられませんでした。"))
        )
        .addButton((button) =>
          button.setButtonText("追加").onClick(() =>
            this.switchAiProfile(() => host.addAiProfile!(), "接続を追加できませんでした。"))
        )
        .addButton((button) =>
          button.setButtonText("削除").setDisabled(profiles.profiles.length <= 1).onClick(() =>
            this.switchAiProfile(() => host.deleteAiProfile!(settings.id), "接続を削除できませんでした。"))
        );
      new Setting(el)
        .setName("接続の名前")
        .addText((text) => {
          text.inputEl.addEventListener("change", () => this.drawAiSettings());
          return text.setValue(settings.name).setPlaceholder("接続の名前").onChange(async (value: string) => {
            if (value.trim()) await this.changeAiSettings({ name: value.trim() }, false);
          });
        });
    }

    // --- 接続先
    new Setting(el).setName("接続先").setHeading();
    new Setting(el)
      .setName("サービス")
      .setDesc("OpenRouter、ローカルで動かしているLLM、その他のOpenAI互換APIから選びます。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(AI_PRESET_LABELS)
          .setValue(settings.preset)
          .onChange(async (value: string) => {
            const preset = value as AiPreset;
            this.aiModels = [];
            this.aiModelNote = "";
            await this.changeAiSettings(
              preset === "custom"
                ? { preset, model: "", addedModels: [] }
                : { preset, baseUrl: AI_PRESET_URLS[preset], useApiKey: preset === "openrouter", model: "", addedModels: [] },
              false
            );
            this.drawAiSettings();
            void this.refreshAiModels();
          })
      );

    const urlHelp: Record<AiPreset, string> = {
      openrouter: "OpenRouterの接続先です。変更できません。",
      local: "LM Studio の既定は http://localhost:1234/v1 です。Ollama は http://localhost:11434/v1 を指定します。",
      custom: "末尾が /v1 のURLを指定します。http:// または https:// が使えます。認証情報・クエリ・ハッシュは含めないでください。",
    };
    this.aiUrlHelp = urlHelp[settings.preset];
    this.aiOriginSetting = new Setting(el)
      .setName("接続先URL")
      .setDesc(this.aiUrlDescription(settings))
      .addText((text) => {
        text.inputEl.disabled = settings.preset === "openrouter";
        text.inputEl.addEventListener("change", () => void this.refreshAiModels());
        return text
          .setValue(settings.baseUrl)
          .setPlaceholder("https://example.com/v1")
          .onChange(async (value: string) => {
            await this.changeAiSettings({ baseUrl: value.trim() }, false);
          });
      });
    this.aiOriginSetting.descEl.style.whiteSpace = "pre-line";

    new Setting(el)
      .setName("APIキーを使う")
      .setDesc("ローカルLLMなど、キーが要らない接続先ではオフにします。")
      .addToggle((toggle) =>
        toggle.setValue(settings.useApiKey).onChange(async (value: boolean) => {
          await this.changeAiSettings({ useApiKey: value }, false);
          this.drawAiSettings();
          void this.refreshAiModels();
        })
      );

    if (settings.useApiKey) this.drawAiKeySetting(el);

    new Setting(el)
      .setName("接続テスト")
      .setDesc("接続先とAPIキーが使えるかを確認します。結果は通知で表示します。")
      .addButton((button) =>
        button.setButtonText("接続テスト").onClick(async () => {
          const result = await this.refreshAiModels();
          const model = host.getAiSettings?.().model ?? "";
          if (!result) new Notice("APIキーを登録してから試してください。", 6000);
          else if (result.ok) new Notice(`接続できました。利用できるモデルは${result.models.length}件です。${model && !result.models.includes(model) ? "\n使用中のモデルは一覧にありません。" : ""}`, 5000);
          else new Notice(`接続できませんでした。${result.reason}`, 10000);
        })
      );

    // --- モデル
    new Setting(el).setName("モデル").setHeading();
    this.aiAddedHost = el.createDiv({ cls: "vg-ai-added-models" });
    this.aiAvailHost = el.createDiv({ cls: "vg-ai-available-models" });
    this.aiAvailSetting = null;
    this.drawAiAdded();
    this.drawAiAvailable();
  }

  /** The models the user picked: only these appear in the chat's model menu. */
  private drawAiAdded(): void {
    const hostEl = this.aiAddedHost;
    const settings = this.hostPlugin.getAiSettings?.();
    if (!hostEl || !settings) return;
    hostEl.replaceChildren();
    new Setting(hostEl)
      .setName("追加したモデル")
      .setDesc(settings.addedModels.length
        ? "チャットで選べるモデルです。「使用」で既定のモデルを切り替えます。"
        : "まだありません。下の「利用できるモデル」から追加するか、モデルIDを直接追加してください。");
    for (const id of settings.addedModels) {
      const current = id === settings.model;
      const row = new Setting(hostEl).setName(id);
      row.settingEl.addClass("vg-ai-model-row");
      if (current) row.settingEl.addClass("is-current");
      row
        .addButton((button) => button.setButtonText(current ? "使用中" : "使用").setCta().setDisabled(current).onClick(async () => {
          if (await this.changeAiSettings({ model: id }, false)) this.drawAiAdded();
        }))
        .addButton((button) => button.setButtonText("削除").onClick(async () => {
          const fresh = this.hostPlugin.getAiSettings?.();
          const next = (fresh?.addedModels ?? []).filter((added) => added !== id);
          const patch: AiSettingsPatch = { addedModels: next };
          if (fresh?.model === id) patch.model = next[0] ?? "";
          if (await this.changeAiSettings(patch, false)) { this.drawAiAdded(); this.drawAiAvailableList(); }
        }));
    }
  }

  /** The connection's full model list with a search box; adding copies a model into 追加したモデル. */
  private drawAiAvailable(): void {
    const hostEl = this.aiAvailHost;
    if (!hostEl) return;
    hostEl.replaceChildren();
    const setting = new Setting(hostEl).setName("利用できるモデル").setDesc(this.aiAvailDesc());
    this.aiAvailSetting = setting;
    setting.addText((text) => {
      text.inputEl.type = "search";
      text.inputEl.addEventListener("input", () => { this.aiSearch = text.getValue(); this.drawAiAvailableList(); });
      return text.setValue(this.aiSearch).setPlaceholder("モデルを検索");
    });
    setting.addButton((button) => {
      this.aiRefetch = button;
      return button.setButtonText("再取得").setDisabled(this.aiLoading).onClick(() => void this.refreshAiModels());
    });
    this.aiListEl = hostEl.createDiv({ cls: "vg-ai-model-list" });
    this.drawAiAvailableList();

    let manual = "";
    new Setting(hostEl)
      .setName("モデルIDを直接追加")
      .setDesc("一覧に出ないモデルや、一覧を取得できない接続先で使います。")
      .addText((text) => text.setPlaceholder("例: openai/gpt-4o").onChange((value: string) => { manual = value.trim(); }))
      .addButton((button) => button.setButtonText("追加").onClick(async () => {
        if (!manual) { new Notice("モデルIDを入力してください"); return; }
        if (await this.addAiModel(manual)) this.drawAiAvailable();
      }));
  }

  private aiListEl: HTMLElement | null = null;

  /** Redraws only the rows, so the search box keeps focus while typing. */
  private drawAiAvailableList(): void {
    const listEl = this.aiListEl;
    const settings = this.hostPlugin.getAiSettings?.();
    if (!listEl || !settings) return;
    listEl.replaceChildren();
    if (!this.aiModels.length) return;
    const matches = filterAiModels(this.aiModels, this.aiSearch);
    if (!matches.length) {
      listEl.createDiv({ cls: "setting-item-description vg-ai-model-empty", text: "一致するモデルがありません。" });
      return;
    }
    for (const id of matches.slice(0, AI_MODEL_LIST_LIMIT)) {
      const added = settings.addedModels.includes(id);
      const row = new Setting(listEl).setName(id);
      row.settingEl.addClass("vg-ai-model-row");
      row.addButton((button) => button.setButtonText(added ? "追加済み" : "追加").setDisabled(added).onClick(async () => {
        if (await this.addAiModel(id)) this.drawAiAvailableList();
      }));
    }
    if (matches.length > AI_MODEL_LIST_LIMIT) {
      listEl.createDiv({ cls: "setting-item-description vg-ai-model-empty", text: `ほか${matches.length - AI_MODEL_LIST_LIMIT}件あります。検索で絞り込んでください。` });
    }
  }

  /** Adds a model to the profile; the first one added also becomes the model in use. */
  private async addAiModel(id: string): Promise<boolean> {
    const settings = this.hostPlugin.getAiSettings?.();
    if (!settings || settings.addedModels.includes(id)) return true;
    const patch: AiSettingsPatch = { addedModels: [...settings.addedModels, id] };
    if (!settings.model) patch.model = id;
    const ok = await this.changeAiSettings(patch, false);
    if (ok) this.drawAiAdded();
    return ok;
  }

  private drawAiKeySetting(el: HTMLElement): void {
    const host = this.hostPlugin;
    const registered = host.hasAiApiKey?.() === true;
    const configDir = this.app?.vault?.configDir ?? ".obsidian";
    const where =
      host.aiKeyStorage?.() === "secret"
        ? "APIキーはObsidianの秘密ストレージに保存されます。"
        : `APIキーはこのVaultの ${configDir}/plugins/${host.manifest?.id ?? "vault-gantt"}/data.json に保存されます。`;
    let input: TextComponent | null = null;
    let reveal: { setButtonText(text: string): unknown } | null = null;
    new Setting(el)
      .setName("APIキー")
      .setDesc(`${registered ? "登録済みです。入力して保存すると置き換えます。" : "未登録です。"}${where}`)
      .addText((text) => {
        input = text;
        text.inputEl.type = this.aiKeyVisible ? "text" : "password";
        text.inputEl.autocomplete = "off";
        return text.setPlaceholder(registered ? "登録済み" : "APIキーを入力");
      })
      .addButton((button) => {
        reveal = button;
        return button.setButtonText(this.aiKeyVisible ? "隠す" : "表示").onClick(() => {
          this.aiKeyVisible = !this.aiKeyVisible;
          if (input) input.inputEl.type = this.aiKeyVisible ? "text" : "password";
          reveal?.setButtonText(this.aiKeyVisible ? "隠す" : "表示");
        });
      })
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(async () => {
          const value = input?.getValue().trim() ?? "";
          if (!value) { new Notice("APIキーを入力してください"); return; }
          try {
            await host.setAiApiKey?.(value);
          } catch {
            new Notice("APIキーを保存できませんでした。");
            return;
          }
          new Notice("APIキーを保存しました");
          this.drawAiSettings();
          await this.refreshAiModels();
        })
      )
      .addButton((button) =>
        button.setButtonText("削除").setDisabled(!registered).onClick(async () => {
          try {
            await host.clearAiApiKey?.();
          } catch {
            new Notice("APIキーを削除できませんでした。");
            return;
          }
          new Notice("APIキーを削除しました");
          this.drawAiSettings();
          await this.refreshAiModels();
        })
      );
  }

  private renderMcpSettings(containerEl: HTMLElement): void {
    const settings = this.hostPlugin.getMcpSettings?.(); if (!settings) return;
    new Setting(containerEl).setName("MCP接続").setHeading();
    const run = async (action: () => Promise<void>) => { try { await action(); this.display(); } catch { new Notice("MCPの設定を適用できませんでした。ポートと秘密ストレージを確認してください。"); } };
    new Setting(containerEl).setName("MCPを有効にする").setDesc("このPCのAIから接続します。変更は承認一覧で承認すると保存されます。")
      .addToggle((toggle) => toggle.setValue(settings.enabled).onChange(async (enabled: boolean) => { this.hostPlugin.settings.mcp = { ...this.hostPlugin.getMcpSettings!(), enabled }; await run(async () => { await this.hostPlugin.saveSettings(); await this.hostPlugin.configureMcp?.(); }); }));
    let portInput = String(settings.port);
    new Setting(containerEl).setName("ポート").setDesc("1〜65535。既定値は8788です。変更すると既存接続と保留提案が失効します。")
      .addText((text) => text.setValue(portInput).onChange((value: string) => { portInput = value; }))
      .addButton((button) => button.setButtonText("適用").onClick(async () => {
        const port = Number(portInput); if (!Number.isInteger(port) || port < 1 || port > 65535) { new Notice("ポートは1〜65535の整数で指定してください"); return; }
        this.hostPlugin.settings.mcp = { ...this.hostPlugin.getMcpSettings!(), port };
        await run(async () => { await this.hostPlugin.saveSettings(); await this.hostPlugin.configureMcp?.(); });
      }));
    new Setting(containerEl).setName("接続トークン").setDesc("トークンは秘密ストレージに保存します。非対応の場合はこの起動中だけ有効です。再生成すると既存接続と保留提案が失効します。")
      .addButton((button) => button.setButtonText("生成").onClick(() => run(async () => { await this.hostPlugin.generateMcpToken?.(); })))
      .addButton((button) => button.setButtonText("再生成").onClick(() => run(async () => { await this.hostPlugin.generateMcpToken?.(true); })))
      .addButton((button) => button.setButtonText("コピー").onClick(() => run(async () => { await this.hostPlugin.copyMcpToken?.(); })));
    new Setting(containerEl).setName("接続方法").setDesc(`接続先: http://127.0.0.1:${settings.port}/mcp。AI側でBearerトークンを設定します。stdio接続はMCP.mdのbridge手順を使います。Obsidianの起動中のみ利用できます。Vault instance ID: ${this.hostPlugin.getMcpVaultInstanceId?.() ?? ""}。状態: ${this.hostPlugin.getMcpStatus?.() ?? "未接続"}`);
  }
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
      row.settingEl.classList.add("vg-settings-card");
      const swatch = row.controlEl.createSpan({
        cls: "task-workbench-gantt-tag-color-swatch",
      });


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
            .setIcon("arrow-up")
            .setTooltip("上へ移動")
            .setDisabled(index === 0)
            .onClick(() => this.moveGanttTag(containerEl, index, -1))
        )
        .addButton((button) =>
          button
            .setIcon("arrow-down")
            .setTooltip("下へ移動")
            .setDisabled(index === definitions.length - 1)
            .onClick(() => this.moveGanttTag(containerEl, index, 1))
        )
        .addButton((button) => {
          button
            .setButtonText("削除")
            .onClick(() => this.deleteGanttTag(containerEl, index));
          button.buttonEl.addClass("vg-btn-danger-text");
        });
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
      color: pickGanttTagColor(definitions),
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
        .setDesc("名前・書式・テンプレートを編集できます。");
      let previewEl: HTMLElement | null = null;
      row.settingEl.classList.add("vg-settings-card", "vg-settings-card-stack");

      const fieldLabel = (text: string) =>
        row.controlEl.createDiv({ cls: "vg-settings-field-label", text });
      fieldLabel("名前");
      row
        .addText((text) =>
          text
            .setValue(source.label)
            .setPlaceholder("名前")
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
        );
      fieldLabel("書式");
      row
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
        );
      fieldLabel("テンプレート");
      row
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
        text: "Gantt から新規作成可",
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
            .setIcon("arrow-up")
            .setTooltip("上へ移動")
            .setDisabled(index === 0)
            .onClick(() => this.moveDailyTodoSource(containerEl, index, -1))
        )
        .addButton((button) =>
          button
            .setIcon("arrow-down")
            .setTooltip("下へ移動")
            .setDisabled(index === sources.length - 1)
            .onClick(() => this.moveDailyTodoSource(containerEl, index, 1))
        )
        .addButton((button) => {
          button
            .setButtonText("削除")
            .onClick(() => this.deleteDailyTodoSource(containerEl, index));
          button.buttonEl.addClass("vg-btn-danger-text");
        });
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
