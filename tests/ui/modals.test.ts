/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Recording fakes for the obsidian Setting controls used by TextInputModal
// (same pattern as tests/ui/settings-tab.test.ts). Hoisted so the vi.mock
// factory below can reference them.
const { RecordingSetting } = vi.hoisted(() => {
  class FakeText {
    value = "";
    handler: ((value: string) => void) | null = null;
    inputEl: any = null;
    setValue(value: string): this {
      this.value = value;
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
    handler: (() => unknown) | null = null;
    setButtonText(text: string): this {
      this.text = text;
      return this;
    }
    setCta(): this {
      this.cta = true;
      return this;
    }
    onClick(handler: () => unknown): this {
      this.handler = handler;
      return this;
    }
  }

  class RecordingSetting {
    static all: RecordingSetting[] = [];
    name = "";
    texts: FakeText[] = [];
    buttons: FakeButton[] = [];
    constructor(public containerEl: unknown) {
      RecordingSetting.all.push(this);
    }
    setName(name: string): this {
      this.name = name;
      return this;
    }
    addText(callback: (text: FakeText) => void): this {
      const text = new FakeText();
      // makeFakeEl is imported below; this closure only executes during
      // onOpen, long after module initialization, so the binding is live.
      text.inputEl = makeFakeEl("input");
      this.texts.push(text);
      callback(text);
      return this;
    }
    addButton(callback: (button: FakeButton) => void): this {
      const button = new FakeButton();
      this.buttons.push(button);
      callback(button);
      return this;
    }
  }

  return { RecordingSetting };
});

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Setting: RecordingSetting };
});

import {
  TextInputModal,
  GanttParentPickerModal,
  ConfirmDragWorkloadModal,
  MarkerModal,
  WeeklyWorkScheduleModal,
} from "../../src/ui/modals";
import {
  createFakeDocument,
  makeFakeEl,
  byClass,
  byTag,
  dispatch,
} from "../stubs/fake-dom";
import type { FakeEl } from "../stubs/fake-dom";
import type {
  TaskRow,
  WeeklyWorkSchedule,
} from "../../src/core/types";

/** Flush pending microtasks so async click handlers can settle. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function makeTitleEl(): FakeEl {
  const el = makeFakeEl("div");
  (el as any).setText = (text: string): void => {
    el.textContent = text;
  };
  return el;
}

function makeRow(overrides: Record<string, unknown>): TaskRow {
  return {
    kind: "parent",
    id: "tasks/x.md",
    file: { path: "tasks/x.md" },
    title: "X",
    displayName: "X",
    statusLabel: "active",
    completed: false,
    currentStatus: "",
    tags: [],
    ...overrides,
  } as unknown as TaskRow;
}

beforeEach(() => {
  RecordingSetting.all.length = 0;
  vi.stubGlobal("document", createFakeDocument());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


// TextInputModal


describe("TextInputModal", () => {
  function openModal(
    initialValue = "",
    onSubmit = vi.fn()
  ): {
    modal: TextInputModal;
    onSubmit: ReturnType<typeof vi.fn>;
    closeSpy: ReturnType<typeof vi.spyOn>;
    setting: InstanceType<typeof RecordingSetting>;
  } {
    const modal = new TextInputModal(
      {} as any,
      "新規タスク",
      "タスク名",
      initialValue,
      onSubmit
    );
    (modal as any).titleEl = makeTitleEl();
    (modal as any).contentEl = makeFakeEl();
    const closeSpy = vi
      .spyOn(modal, "close")
      .mockImplementation(() => undefined);
    modal.onOpen();
    return { modal, onSubmit, closeSpy, setting: RecordingSetting.all[0] };
  }

  it("renders the title, a labeled Setting text field and 作成 (CTA) / キャンセル buttons", () => {
    const { modal, setting } = openModal("初期値");

    expect((modal as any).titleEl.textContent).toBe("新規タスク");
    expect(setting.name).toBe("タスク名");
    expect(setting.texts).toHaveLength(1);
    expect(setting.texts[0].value).toBe("初期値");
    expect(setting.buttons.map((b) => b.text)).toEqual(["作成", "キャンセル"]);
    expect(setting.buttons[0].cta).toBe(true);
    expect(setting.buttons[1].cta).toBe(false);
  });

  it("Enter in the text field submits the current value and closes", () => {
    const { onSubmit, closeSpy, setting } = openModal("");
    const text = setting.texts[0];

    text.handler?.("Enter で入力");
    const evt = dispatch(text.inputEl, "keydown", { key: "Enter" });

    expect(evt.__defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Enter で入力");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("clicking 作成 submits the current value and closes", () => {
    const { onSubmit, closeSpy, setting } = openModal("元値");

    setting.texts[0].handler?.("変更後");
    setting.buttons[0].handler?.();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("変更後");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("an untouched empty field submits \"\" without validation", () => {
    const { onSubmit, closeSpy, setting } = openModal("");

    setting.buttons[0].handler?.();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("キャンセル closes without calling onSubmit", () => {
    const { onSubmit, closeSpy, setting } = openModal("消える値");

    setting.texts[0].handler?.("編集中");
    setting.buttons[1].handler?.();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});


// GanttParentPickerModal


describe("GanttParentPickerModal", () => {
  let items: TaskRow[];
  let onChoose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChoose = vi.fn();
    items = [
      makeRow({ id: "p1", title: "Design review", displayName: "Design review" }),
      makeRow({
        id: "projects/alpha.md",
        file: { path: "projects/alpha.md" },
        title: "Alpha release",
        displayName: "Alpha release",
        statusLabel: "in_progress",
        currentStatus: "waiting for QA signoff",
      }),
    ];
  });

  function openModal(target?: TaskRow[]): {
    modal: GanttParentPickerModal;
    contentEl: FakeEl;
    closeSpy: ReturnType<typeof vi.spyOn>;
  } {
    const modal = new GanttParentPickerModal({} as any, target ?? items, onChoose);
    (modal as any).contentEl = makeFakeEl();
    const closeSpy = vi
      .spyOn(modal, "close")
      .mockImplementation(() => undefined);
    modal.onOpen();
    return { modal, contentEl: (modal as any).contentEl, closeSpy };
  }

  it("renders the search field with the default placeholder and bold name / status • path suggestions", () => {
    const { contentEl } = openModal();

    const input = contentEl.children[0];
    expect(input.type).toBe("search");
    expect(input.placeholder).toBe("Ganttに追加する親タスクを検索...");
    expect(input.focused).toBe(true);

    const list = contentEl.children[1];
    expect(list.children).toHaveLength(2);
    const row = list.children[1];
    expect(row.children[0].className).toBe("task-workbench-finder-title");
    expect(row.children[0].textContent).toBe("Alpha release");
    expect(row.children[1].className).toBe("task-workbench-finder-meta");
    expect(row.children[1].textContent).toBe("進行中 • projects/alpha.md");
    // first row is selected initially
    expect(list.children[0].className).toBe("vg-list-row is-selected");
  });

  it("matches an item when its name, current status, or file path contains the query", () => {
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    input.value = "design";
    dispatch(input, "input");
    expect(list.children.map((r: FakeEl) => r.children[0].textContent)).toEqual([
      "Design review",
    ]);

    input.value = "qa signoff";
    dispatch(input, "input");
    expect(list.children.map((r: FakeEl) => r.children[0].textContent)).toEqual([
      "Alpha release",
    ]);

    input.value = "projects/alpha";
    dispatch(input, "input");
    expect(list.children.map((r: FakeEl) => r.children[0].textContent)).toEqual([
      "Alpha release",
    ]);

    input.value = "";
    dispatch(input, "input");
    expect(list.children).toHaveLength(2);
  });

  it("falls back through the literal chain to the bare path when name and file.path are empty", () => {
    const legacy = makeRow({
      id: "legacy",
      title: "",
      displayName: "",
      file: { path: "" },
      currentStatus: "",
      path: "legacy/old-note.md",
    });
    const { contentEl } = openModal([legacy]);
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    // searchable through the bare-path fallback
    input.value = "old-note";
    dispatch(input, "input");
    expect(list.children).toHaveLength(1);
    // displayed name falls back to the bare path too
    expect(list.children[0].children[0].textContent).toBe("legacy/old-note.md");
    expect(list.children[0].children[1].textContent).toBe("未着手 • legacy/old-note.md");
  });

  it("clicking a row awaits onChoose(item) and then closes", async () => {
    const { contentEl, closeSpy } = openModal();
    const list = contentEl.children[1];

    dispatch(list.children[1], "click");
    await flush();

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(items[1]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(onChoose.mock.invocationCallOrder[0]).toBeLessThan(
      closeSpy.mock.invocationCallOrder[0]
    );
  });

  it("Enter confirms the highlighted row after arrow-key selection", async () => {
    const { contentEl, closeSpy } = openModal();
    const input = contentEl.children[0];

    dispatch(input, "keydown", { key: "ArrowDown" });
    dispatch(input, "keydown", { key: "Enter" });
    await flush();

    expect(onChoose).toHaveBeenCalledWith(items[1]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("with empty items only the search field renders and nothing is selectable", async () => {
    const { contentEl } = openModal([]);

    expect(contentEl.children).toHaveLength(2);
    expect(contentEl.children[0].type).toBe("search");
    // no rows, only the empty-state message
    expect(contentEl.children[1].children).toHaveLength(1);
    expect(contentEl.children[1].children[0].className).toBe("vg-empty");
    expect(contentEl.children[1].children[0].textContent).toBe(
      "該当するタスクがありません"
    );

    dispatch(contentEl.children[0], "keydown", { key: "Enter" });
    await flush();
    expect(onChoose).not.toHaveBeenCalled();
  });
});


// ConfirmDragWorkloadModal


// Escape and backdrop closes must settle the returned Promise, just like the
// explicit buttons. onClose uses the same guarded finish handler.

describe("ConfirmDragWorkloadModal", () => {
  function openModal(onResult = vi.fn()): {
    modal: ConfirmDragWorkloadModal;
    contentEl: FakeEl;
    onResult: ReturnType<typeof vi.fn>;
  } {
    const modal = new ConfirmDragWorkloadModal(
      {} as any,
      "実績を移動しますか？",
      onResult
    );
    (modal as any).titleEl = makeTitleEl();
    (modal as any).contentEl = makeFakeEl();
    // The obsidian Modal stub's close is already a no-op that does not
    // itself invoke onClose — tests below call onClose explicitly to
    // simulate Obsidian's real close -> onClose lifecycle.
    modal.onOpen();
    return { modal, contentEl: (modal as any).contentEl, onResult };
  }

  it("実行する resolves true and closes", () => {
    const { onResult } = openModal();
    const setting = RecordingSetting.all[0];

    setting.buttons[0].handler?.();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it("dismissing via onClose() resolves false exactly once for Escape or backdrop close", () => {
    const { modal, onResult } = openModal();

    modal.onClose();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(false);
  });

  it("clicking 実行する, then a later onClose() from Obsidian's own close() lifecycle, does not call onResult a second time", () => {
    const { modal, onResult } = openModal();
    const setting = RecordingSetting.all[0];

    setting.buttons[0].handler?.();
    // Obsidian always runs onClose as part of close, even for a
    // programmatic close a button handler already triggered.
    modal.onClose();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it("clicking キャンセル, then a later onClose(), does not call onResult a second time", () => {
    const { modal, onResult } = openModal();
    const setting = RecordingSetting.all[0];

    setting.buttons[1].handler?.();
    modal.onClose();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(false);
  });
});





// This modal is built from raw DOM and uses the fake document directly.
// Escape and backdrop close must resolve the Promise with null exactly once.

describe("MarkerModal", () => {
  function openModal(
    modalTitle: string,
    initialTitle: string,
    initialDate: string,
    onSubmit = vi.fn()
  ): {
    modal: MarkerModal;
    contentEl: FakeEl;
    onSubmit: ReturnType<typeof vi.fn>;
  } {
    const modal = new MarkerModal(
      {} as any,
      modalTitle,
      initialTitle,
      initialDate,
      onSubmit
    );
    (modal as any).titleEl = makeTitleEl();
    (modal as any).contentEl = makeFakeEl();
    modal.onOpen();
    return { modal, contentEl: (modal as any).contentEl, onSubmit };
  }

  function inputs(contentEl: FakeEl): FakeEl[] {
    return byTag(contentEl, "input");
  }

  function buttons(contentEl: FakeEl): FakeEl[] {
    return byTag(contentEl, "button");
  }

  it("a new marker starts with an empty title and the caller-supplied (today's) date", () => {
    const { modal, contentEl } = openModal(
      "マーカーを追加",
      "",
      "2026-08-10"
    );
    expect((modal as any).titleEl.textContent).toBe("マーカーを追加");
    const [titleInput, dateInput] = inputs(contentEl);
    expect(titleInput.value).toBe("");
    expect(titleInput.type).toBe("text");
    expect(dateInput.value).toBe("2026-08-10");
    expect(dateInput.type).toBe("date");
  });

  it("editing an existing marker pre-fills both the title and date fields", () => {
    const { contentEl } = openModal(
      "マーカーを編集",
      "既存タイトル",
      "2026-08-05"
    );
    const [titleInput, dateInput] = inputs(contentEl);
    expect(titleInput.value).toBe("既存タイトル");
    expect(dateInput.value).toBe("2026-08-05");
  });

  it("the confirm button is disabled while the date field is empty, and re-enables once a date is entered", () => {
    const { contentEl } = openModal("マーカーを追加", "", "");
    const [confirmButton] = buttons(contentEl);
    expect(confirmButton.disabled).toBe(true);

    const [, dateInput] = inputs(contentEl);
    dateInput.value = "2026-08-11";
    dispatch(dateInput, "input");
    expect(confirmButton.disabled).toBe(false);
  });

  it("confirming a new marker resolves the trimmed {title, date} and closes", () => {
    const { contentEl, onSubmit } = openModal(
      "マーカーを追加",
      "",
      "2026-08-10"
    );
    const [titleInput] = inputs(contentEl);
    titleInput.value = "  新マーカー  ";
    dispatch(titleInput, "input");

    const [confirmButton] = buttons(contentEl);
    dispatch(confirmButton, "click");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      title: "新マーカー",
      date: "2026-08-10",
    });
  });

  it("キャンセル resolves null without submitting", () => {
    const { contentEl, onSubmit } = openModal(
      "マーカーを追加",
      "",
      "2026-08-10"
    );
    const [, cancelButton] = buttons(contentEl);
    dispatch(cancelButton, "click");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("dismissing via onClose() resolves null exactly once for Escape or backdrop close", () => {
    const { modal, onSubmit } = openModal(
      "マーカーを追加",
      "",
      "2026-08-10"
    );
    modal.onClose();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("confirming, then a later onClose() from Obsidian's own close() lifecycle, does not resolve a second time", () => {
    const { modal, contentEl, onSubmit } = openModal(
      "マーカーを追加",
      "",
      "2026-08-10"
    );
    const [confirmButton] = buttons(contentEl);
    dispatch(confirmButton, "click");
    modal.onClose();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ title: "", date: "2026-08-10" });
  });
});


describe("WeeklyWorkScheduleModal", () => {
  function openModal(
    schedules: WeeklyWorkSchedule[],
    callbacks = {
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }
  ): { modal: WeeklyWorkScheduleModal; contentEl: FakeEl } {
    const modal = new WeeklyWorkScheduleModal({} as any, schedules, callbacks);
    (modal as any).titleEl = makeTitleEl();
    (modal as any).contentEl = makeFakeEl();
    modal.onOpen();
    return { modal, contentEl: (modal as any).contentEl };
  }

  function buttons(contentEl: FakeEl): FakeEl[] {
    return byTag(contentEl, "button");
  }

  it("opens with existing schedules as editable rows", () => {
    const schedules: WeeklyWorkSchedule[] = [
      { key: "schedule-1", title: "習字", dayOfWeek: 3, minutesPerWeek: 30 },
    ];
    const { modal, contentEl } = openModal(schedules);

    expect((modal as any).titleEl.textContent).toBe("定例作業設定");
    expect(byClass(contentEl, "task-gantt-weekly-work-schedule-row")).toHaveLength(1);
    const row = byClass(contentEl, "task-gantt-weekly-work-schedule-row")[0];
    const rowInputs = byTag(row, "input");
    expect(rowInputs[0].value).toBe("習字");
    expect(rowInputs[0].type).toBe("text");
    expect(rowInputs[1].value).toBe("30");
    expect(rowInputs[1].type).toBe("number");
    expect(byTag(row, "select")[0].value).toBe("3");
    expect(byTag(row, "option")).toHaveLength(7);
  });

  it("clicking 追加 calls add with the blank Sunday default", () => {
    const schedules: WeeklyWorkSchedule[] = [];
    const add = vi.fn();
    const { contentEl } = openModal(schedules, {
      add,
      update: vi.fn(),
      delete: vi.fn(),
    });

    const addButton = buttons(contentEl).find((button) => button.textContent === "追加");
    if (!addButton) {
      throw new Error("追加ボタンが見つかりません");
    }
    dispatch(addButton, "click");
    expect(add).toHaveBeenCalledWith("", 0, 30);
  });

  it("editing fields calls update immediately with the schedule key and patch", () => {
    const schedules: WeeklyWorkSchedule[] = [
      { key: "schedule-1", title: "習字", dayOfWeek: 3, minutesPerWeek: 30 },
    ];
    const update = vi.fn();
    const { contentEl } = openModal(schedules, {
      add: vi.fn(),
      update,
      delete: vi.fn(),
    });
    const row = byClass(contentEl, "task-gantt-weekly-work-schedule-row")[0];
    const rowInputs = byTag(row, "input");
    const daySelect = byTag(row, "select")[0];

    rowInputs[0].value = "新しい作業";
    dispatch(rowInputs[0], "input");
    daySelect.value = "5";
    dispatch(daySelect, "change");
    rowInputs[1].value = "60";
    dispatch(rowInputs[1], "input");

    expect(update).toHaveBeenNthCalledWith(1, "schedule-1", {
      title: "新しい作業",
    });
    expect(update).toHaveBeenNthCalledWith(2, "schedule-1", {
      dayOfWeek: 5,
    });
    expect(update).toHaveBeenNthCalledWith(3, "schedule-1", {
      minutesPerWeek: 60,
    });
  });

  it("clicking 削除 calls delete with the schedule key", () => {
    const schedules: WeeklyWorkSchedule[] = [
      { key: "schedule-1", title: "習字", dayOfWeek: 3, minutesPerWeek: 30 },
    ];
    const remove = vi.fn();
    const { contentEl } = openModal(schedules, {
      add: vi.fn(),
      update: vi.fn(),
      delete: remove,
    });
    const deleteButton = buttons(contentEl).find((button) => button.textContent === "削除");
    if (!deleteButton) {
      throw new Error("削除ボタンが見つかりません");
    }
    dispatch(deleteButton, "click");

    expect(remove).toHaveBeenCalledWith("schedule-1");
  });
});
