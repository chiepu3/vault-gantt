/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";

const {
  RecordingSetting,
  FakeElement,
  noticeMock,
  detectDailyNoteSettingsMock,
} = vi.hoisted(() => {
  class FakeSpan {
    style: Record<string, string> = {};

    classList = { add: vi.fn(), remove: vi.fn() };

    attributes: Record<string, string> = {};

    setAttribute(name: string, value: string): void {
      this.attributes[name] = value;
    }
  }

  class FakeElement {
    children: FakeElement[] = [];
    cls = "";
    text = "";
    textContent = "";

    replaceChildren(...children: FakeElement[]): void {
      this.children = children;
    }

    createDiv(options?: { cls?: string; text?: string }): FakeElement {
      const child = new FakeElement();
      child.cls = options?.cls ?? "";
      child.text = options?.text ?? "";
      child.textContent = child.text;
      this.children.push(child);
      return child;
    }

    createSpan(): FakeSpan {
      return new FakeSpan();
    }
  }

  class FakeToggle {
    value = false;
    handler: ((value: boolean) => void) | null = null;

    setValue(value: boolean): this {
      this.value = value;
      return this;
    }

    onChange(handler: (value: boolean) => void): this {
      this.handler = handler;
      return this;
    }
  }

  class FakeText {
    value = "";
    placeholder = "";
    inputEl = {
      type: "text",
      min: "",
      rows: 0,
      disabled: false,
    };
    handler: ((value: string) => void) | null = null;

    setValue(value: string): this {
      this.value = value;
      return this;
    }

    setPlaceholder(placeholder: string): this {
      this.placeholder = placeholder;
      return this;
    }

    onChange(handler: (value: string) => void): this {
      this.handler = handler;
      return this;
    }
  }

  class FakeButton {
    text = "";
    cta = false;
    warning = false;
    icon = "";
    tooltip = "";
    disabled = false;
    handler: (() => unknown) | null = null;

    setIcon(icon: string): this {
      this.icon = icon;
      return this;
    }

    setTooltip(tooltip: string): this {
      this.tooltip = tooltip;
      return this;
    }

    setWarning(): this {
      this.warning = true;
      return this;
    }

    setButtonText(text: string): this {
      this.text = text;
      return this;
    }

    setCta(): this {
      this.cta = true;
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.disabled = disabled;
      return this;
    }

    onClick(handler: () => unknown): this {
      this.handler = handler;
      return this;
    }
  }


  class FakeColorPicker {
    value = "#000000";
    handler: ((value: string) => void) | null = null;

    setValue(value: string): this {
      this.value = value;
      return this;
    }

    onChange(handler: (value: string) => void): this {
      this.handler = handler;
      return this;
    }
  }


  class RecordingSetting {
    static all: RecordingSetting[] = [];
    name = "";
    desc = "";
    heading = false;
    toggles: FakeToggle[] = [];
    texts: FakeText[] = [];
    textAreas: FakeText[] = [];
    buttons: FakeButton[] = [];
    colorPickers: FakeColorPicker[] = [];
    controlEl = new FakeElement();

    constructor(public containerEl: unknown) {
      RecordingSetting.all.push(this);
    }

    setName(name: string): this {
      this.name = name;
      return this;
    }

    setDesc(desc: string): this {
      this.desc = desc;
      return this;
    }

    setHeading(): this {
      this.heading = true;
      return this;
    }

    addToggle(callback: (toggle: FakeToggle) => void): this {
      const toggle = new FakeToggle();
      this.toggles.push(toggle);
      callback(toggle);
      return this;
    }

    addText(callback: (text: FakeText) => void): this {
      const text = new FakeText();
      this.texts.push(text);
      callback(text);
      return this;
    }

    addTextArea(callback: (text: FakeText) => void): this {
      const text = new FakeText();
      this.textAreas.push(text);
      callback(text);
      return this;
    }

    addButton(callback: (button: FakeButton) => void): this {
      const button = new FakeButton();
      this.buttons.push(button);
      callback(button);
      return this;
    }

    addColorPicker(callback: (picker: FakeColorPicker) => void): this {
      const picker = new FakeColorPicker();
      this.colorPickers.push(picker);
      callback(picker);
      return this;
    }
  }

  const noticeMock = vi.fn();
  const detectDailyNoteSettingsMock = vi.fn();
  return {
    RecordingSetting,
    FakeElement,
    noticeMock,
    detectDailyNoteSettingsMock,
  };
});

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Setting: RecordingSetting, Notice: noticeMock };
});

vi.mock("../../src/app/daily-note-creation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/app/daily-note-creation")>();
  return {
    ...actual,
    detectConfiguredDailyNoteSettings: detectDailyNoteSettingsMock,
  };
});

import {
  ensureGanttTagDefinitions,
  TaskWorkbenchSettingTab,
  normalizeSpecialHolidays,
} from "../../src/ui/settings-tab";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { moment } from "obsidian";
import type { TaskWorkbenchSettings } from "../../src/core/types";

describe("TaskWorkbenchSettingTab", () => {
  let settings: TaskWorkbenchSettings;
  let saveSettings: Mock;
  let refresh: Mock;
  let updateAutoPriorities: Mock;
  let syncReadonlyGanttNow: Mock;
  let hostPlugin: any;
  let tab: TaskWorkbenchSettingTab;

  beforeEach(() => {
    RecordingSetting.all.length = 0;
    noticeMock.mockClear();
    detectDailyNoteSettingsMock.mockReset();
    settings = { ...DEFAULT_SETTINGS };
    saveSettings = vi.fn().mockResolvedValue(undefined);
    refresh = vi.fn().mockResolvedValue(undefined);
    updateAutoPriorities = vi.fn().mockResolvedValue(undefined);
    syncReadonlyGanttNow = vi.fn().mockResolvedValue(undefined);
    hostPlugin = {
      settings,
      saveSettings,
      startGanttSyncTimer: vi.fn(),
      updateAutoPriorities,
      syncReadonlyGanttNow,
      holidays: { refreshNationalHolidays: refresh },
    };
    tab = new TaskWorkbenchSettingTab({} as any, hostPlugin);
    (tab as any).containerEl = new FakeElement();
  });

  function settingByName(name: string): InstanceType<typeof RecordingSetting> {
    const found = RecordingSetting.all.find((setting) => setting.name === name);
    if (!found) throw new Error(`setting not found: ${name}`);
    return found;
  }

  function dailySourceRows(): InstanceType<typeof RecordingSetting>[] {
    return RecordingSetting.all.filter(
      (setting) =>
        setting.texts.length === 3 &&
        setting.toggles.length === 1 &&
        setting.buttons.length === 3
    );
  }

  function dailySourceActions(): InstanceType<typeof RecordingSetting> {
    const found = RecordingSetting.all.find(
      (setting) =>
        setting.name === "ソース操作" &&
        setting.buttons.some((button) => button.text === "追加")
    );
    if (!found) throw new Error("Daily ToDo source actions not found");
    return found;
  }

  it("renders all sections and controls in order", () => {
    tab.display();

    expect(RecordingSetting.all.map((setting) => setting.name)).toEqual([
      "Task Workbench",
      "基本設定",
      "タスクフォルダ",
      "ファイル名に日付を付ける",
      "完了を既定で隠す",
      "現在の進捗の行数",
      "期限にもとづく優先度の自動設定",
      "休日",
      "内閣府の祝日",
      "今年度の特別休暇",
      "機能の有効化",
      "Daily ToDoを表示",
      "作業時間を表示",
      "その他 行を表示",
      "同期機能",
      "タグ機能",
      "Gantt差分描画を有効化",
      "タグ",
      "サブタスク上にタグ名を表示",
      "親タスクのタグ名を子タスクにも表示",
      "親タスク列にタグ名を表示",
      "",
      "タグを追加",
      "Daily ToDo",
      "デイリー",
      "デイリーミーティング",
      "ソース操作",
      "外部同期",
      "Gantt サーバー同期",
      "Gantt サーバー URL",
      "Gantt 同期間隔（分）",
      "今すぐ同期",
    ]);

    const names = RecordingSetting.all.map((setting) => setting.name);
    expect(names).not.toContain("変更の適用");
    expect(names).not.toContain("国民祝日を考慮する");
  });

  it("renders the build footer with unknown fallbacks outside esbuild", () => {
    tab.display();

    const footer = (tab as any).containerEl.children.find(
      (child: InstanceType<typeof FakeElement>) =>
        child.cls === "setting-item-description"
    );
    expect(footer?.text).toBe(
      "Vault Gantt vunknown (unknown; built unknown)"
    );
  });

  it("changes representative controls on the live object and saves immediately", async () => {
    tab.display();

    const folder = settingByName("タスクフォルダ").texts[0];
    const filename = settingByName("ファイル名に日付を付ける").toggles[0];
    const feature = settingByName("Daily ToDoを表示").toggles[0];

    const folderSave = folder.handler!("project/tasks");
    expect(settings.taskFolder).toBe("project/tasks");
    await folderSave;
    filename.handler!(false);
    feature.handler!(false);
    await Promise.resolve();

    expect(settings.filenameUsesDatePrefix).toBe(false);
    expect(settings.ganttFeatureDailyTodoEnabled).toBe(false);
    expect(saveSettings).toHaveBeenCalledTimes(3);
  });

  it("trims folders, defaults empty input, and rejects exact .. segments", async () => {
    tab.display();
    const folder = settingByName("タスクフォルダ").texts[0];

    await folder.handler!("  ../outside  ");
    expect(settings.taskFolder).toBe("tasks");
    await folder.handler!("projects/tasks");
    expect(settings.taskFolder).toBe("projects/tasks");
    await folder.handler!("   ");
    expect(settings.taskFolder).toBe("tasks");
  });

  it("preserves float values and applies the exact numeric fallbacks", async () => {
    tab.display();
    const rows = settingByName("現在の進捗の行数").texts[0];
    const interval = settingByName("Gantt 同期間隔（分）").texts[0];

    await rows.handler!("");
    expect(settings.currentStatusRows).toBe(5);
    await rows.handler!("5.5");
    expect(settings.currentStatusRows).toBe(5.5);
    await rows.handler!("0");
    expect(settings.currentStatusRows).toBe(3);
    await rows.handler!("-2");
    expect(settings.currentStatusRows).toBe(3);

    await interval.handler!("");
    expect(settings.ganttSyncIntervalMinutes).toBe(5);
    await interval.handler!("1.5");
    expect(settings.ganttSyncIntervalMinutes).toBe(1.5);
    await interval.handler!("0");
    expect(settings.ganttSyncIntervalMinutes).toBe(1);
    await interval.handler!("0.5");
    expect(settings.ganttSyncIntervalMinutes).toBe(1);
    await interval.handler!("-2");
    expect(settings.ganttSyncIntervalMinutes).toBe(1);
  });

  it("normalizes special holidays by format only", async () => {
    expect(
      normalizeSpecialHolidays(
        "2026/8/10; 2026-02-30, invalid\n2026-08-10\n2026-13-45\n202-01-01\n2026-08-10 09:30"
      )
    ).toEqual(["2026-02-30", "2026-08-10", "2026-13-45"]);

    tab.display();
    const holidays = settingByName("今年度の特別休暇").textAreas[0];
    await holidays.handler!("2026/8/10; 2026-02-30, 2026-08-10\n2026-13-45");

    expect(settings.ganttSpecialHolidays).toEqual([
      "2026-02-30",
      "2026-08-10",
      "2026-13-45",
    ]);
    expect(settings.ganttHolidays).toEqual([]);
  });

  it("uses the one strict-true tag toggle exception", () => {
    (settings as any).ganttFeatureDailyTodoEnabled = undefined;
    (settings as any).ganttShowTagsOnBars = undefined;
    (settings as any).ganttShowParentTagsOnChildBars = undefined;
    (settings as any).ganttShowTagsOnParents = undefined;
    tab.display();

    expect(settingByName("Daily ToDoを表示").toggles[0].value).toBe(true);
    expect(settingByName("サブタスク上にタグ名を表示").toggles[0].value).toBe(true);
    expect(
      settingByName("親タスクのタグ名を子タスクにも表示").toggles[0].value
    ).toBe(false);
    expect(settingByName("親タスク列にタグ名を表示").toggles[0].value).toBe(true);
  });

  it("renders holiday status and refreshes national holidays", async () => {
    settings.ganttNationalHolidaysUpdatedAt = "2026-08-12T00:00:00.000Z";
    tab.display();

    expect(settingByName("内閣府の祝日").desc).toContain(
      "最終更新: 2026-08-12T00:00:00.000Z"
    );

    await settingByName("内閣府の祝日").buttons[0].handler!();
    expect(refresh).toHaveBeenCalledWith(true, true);
  });


  it("renders one row per configured source with controls", () => {
    settings.dailyTodoSources = [
      {
        key: "main",
        label: "日記",
        format: "[Journal]/YYYY-MM-DD",
        templatePath: "Templates/daily.md",
        creatableFromGantt: true,
      },
      {
        key: "meeting",
        label: "会議",
        format: "[Meetings]/YYYY/MM/DD",
        creatableFromGantt: false,
      },
    ];
    tab.display();

    const rows = dailySourceRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].texts.map((text) => text.value)).toEqual([
      "日記",
      "[Journal]/YYYY-MM-DD",
      "Templates/daily.md",
    ]);
    expect(rows[0].toggles[0].value).toBe(true);
    expect(rows[0].buttons.map((button) => button.icon || button.text)).toEqual([
      "arrow-up",
      "arrow-down",
      "削除",
    ]);
    expect(rows[0].buttons.map((button) => button.tooltip)).toEqual([
      "上へ移動",
      "下へ移動",
      "",
    ]);
    expect(rows[0].buttons[2].warning).toBe(true);
    expect(rows[0].buttons[0].disabled).toBe(true);
    expect(rows[1].texts.map((text) => text.value)).toEqual([
      "会議",
      "[Meetings]/YYYY/MM/DD",
      "",
    ]);
    expect(rows[1].toggles[0].value).toBe(false);
    expect(rows[1].buttons[1].disabled).toBe(true);
    expect(dailySourceActions().buttons.map((button) => button.text)).toEqual([
      "追加",
      "Daily Notes設定から取り込む",
    ]);
  });

  it("edits label, format, template, and creation toggle in place", async () => {
    settings.dailyTodoSources = [
      {
        key: "source",
        label: "元のラベル",
        format: "[Journal]/YYYY-MM-DD",
        templatePath: "Templates/old.md",
        creatableFromGantt: false,
      },
    ];
    tab.display();
    const row = dailySourceRows()[0];

    await row.texts[0].handler!("  新しいラベル  ");
    await row.texts[1].handler!("[Journal]/YYYY/MM/DD");
    await row.texts[2].handler!(" Templates/new.md ");
    await row.toggles[0].handler!(true);

    expect(settings.dailyTodoSources[0]).toEqual({
      key: "source",
      label: "新しいラベル",
      format: "[Journal]/YYYY/MM/DD",
      templatePath: "Templates/new.md",
      creatableFromGantt: true,
    });
    expect(saveSettings).toHaveBeenCalledTimes(4);
  });

  it("deletes a source without confirmation and saves the list", async () => {
    settings.dailyTodoSources = [
      {
        key: "first",
        label: "最初",
        format: "[First]/YYYY-MM-DD",
        creatableFromGantt: true,
      },
      {
        key: "second",
        label: "二番目",
        format: "[Second]/YYYY-MM-DD",
        creatableFromGantt: false,
      },
    ];
    tab.display();

    await dailySourceRows()[1].buttons[2].handler!();

    expect(settings.dailyTodoSources).toEqual([
      {
        key: "first",
        label: "最初",
        format: "[First]/YYYY-MM-DD",
        creatableFromGantt: true,
      },
    ]);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("adds a blank source with a non-colliding key", async () => {
    settings.dailyTodoSources = [
      {
        key: "source-12345",
        label: "既存",
        format: "[Existing]/YYYY-MM-DD",
        creatableFromGantt: true,
      },
    ];
    tab.display();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(12345);
    try {
      await dailySourceActions().buttons[0].handler!();
    } finally {
      nowSpy.mockRestore();
    }

    expect(settings.dailyTodoSources).toHaveLength(2);
    const added = settings.dailyTodoSources[1];
    expect(added.key).not.toBe("source-12345");
    expect(added.key).toMatch(/^source-12345-/);
    expect(added).toMatchObject({
      label: "",
      format: "",
      creatableFromGantt: false,
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("imports Daily Notes settings as a new source", async () => {
    settings.dailyTodoSources = [
      {
        key: "existing",
        label: "既存",
        format: "[Existing]/YYYY-MM-DD",
        creatableFromGantt: false,
      },
    ];
    detectDailyNoteSettingsMock.mockReturnValue({
      folder: "10_Daily",
      format: "YYYY/MM/YYYY-MM-DD",
      templatePath: "Templates/daily.md",
    });
    tab.display();

    await dailySourceActions().buttons[1].handler!();

    expect(settings.dailyTodoSources).toHaveLength(2);
    expect(settings.dailyTodoSources[1]).toMatchObject({
      label: "10_Daily",
      format: "[10_Daily]/YYYY/MM/YYYY-MM-DD",
      templatePath: "Templates/daily.md",
      creatableFromGantt: true,
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("shows a Notice and leaves sources unchanged when import is unavailable", async () => {
    settings.dailyTodoSources = [
      {
        key: "existing",
        label: "既存",
        format: "[Existing]/YYYY-MM-DD",
        creatableFromGantt: false,
      },
    ];
    detectDailyNoteSettingsMock.mockReturnValue(null);
    tab.display();

    await dailySourceActions().buttons[1].handler!();

    expect(settings.dailyTodoSources).toHaveLength(1);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(noticeMock).toHaveBeenCalledWith(
      "Daily NotesまたはPeriodic Notesの設定が見つかりませんでした"
    );
  });

  it("updates the live preview from the current format", async () => {
    const initialFormat = "[Journal]/YYYY-MM-DD";
    settings.dailyTodoSources = [
      {
        key: "source",
        label: "日記",
        format: initialFormat,
        creatableFromGantt: true,
      },
    ];
    tab.display();
    const row = dailySourceRows()[0];
    const preview = row.controlEl.children.find(
      (child: InstanceType<typeof FakeElement>) =>
        child.cls === "task-workbench-daily-todo-source-preview"
    );

    expect(preview?.textContent).toBe(
      `プレビュー: ${moment().format(initialFormat)}.md`
    );

    const nextFormat = "[Journal]/YYYY/MM/DD";
    await row.texts[1].handler!(nextFormat);
    expect(preview?.textContent).toBe(
      `プレビュー: ${moment().format(nextFormat)}.md`
    );
  });


  it("starts the force auto-priority path after saving the toggle", async () => {
    tab.display();
    const toggle = settingByName("期限にもとづく優先度の自動設定").toggles[0];

    await toggle.handler!(false);

    expect(settings.autoPriorityEnabled).toBe(false);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(updateAutoPriorities).toHaveBeenCalledTimes(1);
  });

  it("saves sync fields, rearms the timer, and fires manual sync without awaiting", async () => {
    tab.display();
    const enabled = settingByName("Gantt サーバー同期").toggles[0];
    const url = settingByName("Gantt サーバー URL").texts[0];
    const now = settingByName("今すぐ同期").buttons[0];

    enabled.handler!(true);
    url.handler!("  http://localhost:8787/anything?x=1#fragment  ");
    now.handler!();
    await Promise.resolve();

    expect(settings.ganttSyncEnabled).toBe(true);
    expect(settings.ganttSyncUrl).toBe(
      "http://localhost:8787/anything?x=1#fragment"
    );
    expect(hostPlugin.startGanttSyncTimer).toHaveBeenCalledTimes(2);
    expect(syncReadonlyGanttNow).toHaveBeenCalledTimes(1);
  });

  it("renders the exact empty-state message and add button", () => {
    tab.display();

    expect(
      RecordingSetting.all.find(
        (setting) =>
          setting.desc ===
          "タグはまだありません。右クリックメニュー、または下のボタンから作成できます。"
      )
    ).toBeDefined();
    expect(settingByName("タグを追加").buttons[0].text).toBe("タグを追加");
  });

  it("renders one row per normalized definition with name/color controls and actions", () => {
    settings.ganttTags = [
      { key: "first-key", name: "First", color: "#111111", order: 0 },
      { key: "second-key", name: "Second", color: "", order: 1000 },
    ];
    tab.display();

    const rows = RecordingSetting.all.filter((setting) =>
      ["First", "Second"].includes(setting.name)
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].texts.map((text) => text.value)).toEqual(["First", "#111111"]);
    expect(rows[1].texts.map((text) => text.value)).toEqual(["Second", ""]);
    expect(rows[0].buttons.map((button) => button.icon || button.text)).toEqual([
      "arrow-up",
      "arrow-down",
      "削除",
    ]);
    expect(rows[1].buttons.map((button) => button.icon || button.text)).toEqual([
      "arrow-up",
      "arrow-down",
      "削除",
    ]);
    expect(rows[0].buttons[0].disabled).toBe(true);
    expect(rows[1].buttons[1].disabled).toBe(true);
  });

  it("trims names, falls back on empty input, and never changes key", async () => {
    settings.ganttTags = [
      { key: "stable-key", name: "Original", color: "", order: 0 },
    ];
    tab.display();

    const name = RecordingSetting.all.find((setting) => setting.name === "Original")!
      .texts[0];
    await name.handler!("  Renamed  ");
    expect(settings.ganttTags[0]).toEqual({
      key: "stable-key",
      name: "Renamed",
      color: "",
      order: 0,
    });

    await name.handler!("   ");
    expect(settings.ganttTags[0].name).toBe("Renamed");
    expect(settings.ganttTags[0].key).toBe("stable-key");
  });

  it("accepts an empty color and persists the no-color state", async () => {
    settings.ganttTags = [
      { key: "stable-key", name: "Colored", color: "#abcdef", order: 0 },
    ];
    tab.display();

    const color = RecordingSetting.all.find((setting) => setting.name === "Colored")!
      .texts[1];
    await color.handler!("   ");

    expect(settings.ganttTags[0].color).toBe("");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });


  it("keeps the hex color input node stable while typing", async () => {
    settings.ganttTags = [{ key: "k", name: "Tag", color: "", order: 0 }];
    tab.display();

    const row = RecordingSetting.all.find((setting) => setting.name === "Tag")!;
    const hex = row.texts[1];
    const settingCount = RecordingSetting.all.length;

    await hex.handler!("#");
    await hex.handler!("#a1");
    await hex.handler!("#a1b2c3");

    // Object-identity guard for the focus-loss bug: a re-render on every
    // keystroke would have replaced the focused <input> with a brand-new node,
    // so the input could never be the same object twice. No new Setting rows
    // or input nodes may exist after the keystrokes.
    expect(RecordingSetting.all.length).toBe(settingCount);
    expect(RecordingSetting.all.filter((s) => s.name === "Tag")).toHaveLength(1);
    expect(row.texts[1]).toBe(hex);
    expect(settings.ganttTags[0].color).toBe("#a1b2c3");
    expect(saveSettings).toHaveBeenCalledTimes(3);
  });

  it("two-way syncs the hex text field and the native color picker", async () => {
    settings.ganttTags = [{ key: "k", name: "Tag", color: "", order: 0 }];
    tab.display();

    const row = RecordingSetting.all.find((setting) => setting.name === "Tag")!;
    const hex = row.texts[1];
    const picker = row.colorPickers[0];

    expect(picker).toBeDefined();
    // An empty persisted color falls back to the native picker's default value.
    expect(picker!.value).toBe("#000000");

    // Picking a color via the picker updates the hex text field.
    await picker!.handler!("#12ab34");
    expect(settings.ganttTags[0].color).toBe("#12ab34");
    expect(hex.value).toBe("#12ab34");
    expect(saveSettings).toHaveBeenCalledTimes(1);

    // Typing a valid 6-digit hex updates the picker.
    await hex.handler!("#c0ffee");
    expect(settings.ganttTags[0].color).toBe("#c0ffee");
    expect(picker!.value).toBe("#c0ffee");

    // Typing an unrepresentable value persists it raw and leaves the picker untouched.
    await hex.handler!("red");
    expect(settings.ganttTags[0].color).toBe("red");
    expect(picker!.value).toBe("#c0ffee");
  });


  it("normalizes definitions and resets a non-array without throwing", () => {
    const malformed: any = {
      ganttTags: [
        { key: "keep-key", name: "  Keep  ", color: 123, order: Number.NaN },
        { name: "   ", color: "ignored", order: 2000 },
        { name: "Later", color: "  blue  ", order: 100 },
      ],
    };
    expect(ensureGanttTagDefinitions(malformed)).toEqual([
      { key: "keep-key", name: "Keep", color: "123", order: 0 },
      { key: "Later", name: "Later", color: "blue", order: 100 },
    ]);

    const corrupted: any = { ganttTags: "old serialized tags" };
    expect(() => ensureGanttTagDefinitions(corrupted)).not.toThrow();
    expect(corrupted.ganttTags).toEqual([]);
  });

  it("moves adjacent definitions and renumbers the entire list", async () => {
    settings.ganttTags = [
      { key: "a", name: "A", color: "", order: 100 },
      { key: "b", name: "B", color: "", order: 400 },
      { key: "c", name: "C", color: "", order: 900 },
    ];
    tab.display();

    const firstRow = RecordingSetting.all.find((setting) => setting.name === "A")!;
    await firstRow.buttons[1].handler!();

    expect(settings.ganttTags).toEqual([
      { key: "b", name: "B", color: "", order: 0 },
      { key: "a", name: "A", color: "", order: 1000 },
      { key: "c", name: "C", color: "", order: 2000 },
    ]);
  });

  it("deletes a definition and renumbers the remainder", async () => {
    settings.ganttTags = [
      { key: "a", name: "A", color: "", order: 0 },
      { key: "b", name: "B", color: "", order: 1000 },
      { key: "c", name: "C", color: "", order: 2000 },
    ];
    tab.display();

    const middleRow = RecordingSetting.all.find((setting) => setting.name === "B")!;
    await middleRow.buttons[2].handler!();

    expect(settings.ganttTags).toEqual([
      { key: "a", name: "A", color: "", order: 0 },
      { key: "c", name: "C", color: "", order: 1000 },
    ]);
  });

  it("creates the exact count-based definition without a prompt", async () => {
    settings.ganttTags = [
      { key: "existing-key", name: "Existing", color: "#123456", order: 0 },
      { key: "other-key", name: "Other", color: "", order: 1000 },
    ];
    tab.display();

    const prompt = vi.fn();
    const previousPrompt = (globalThis as any).prompt;
    (globalThis as any).prompt = prompt;
    try {
      await settingByName("タグを追加").buttons[0].handler!();
    } finally {
      (globalThis as any).prompt = previousPrompt;
    }

    expect(prompt).not.toHaveBeenCalled();
    expect(settings.ganttTags).toContainEqual({
      key: "タグ3",
      name: "タグ3",
      color: "",
      order: 2000,
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });
});
