import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type {
  TaskRow,
  WeeklyWorkSchedule,
} from "../core/types";
import { getStatusLabel } from "../core/utils";

/**
 *
 * Single-line text input modal (Setting-based, same idiom as the
 * PromptModal in src/app/task-file-service.ts): a title, one labeled text
 * field, and 「作成」 (CTA) / 「キャンセル」 buttons. Enter in the field or
 * the 「作成」 button submits the current value verbatim — no validation —
 * and closes the modal. 「キャンセル」 (or Escape) closes without calling
 * onSubmit, so an empty field still submits "".
 */
export class TextInputModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly title: string,
    private readonly label: string,
    initialValue: string,
    private readonly onSubmit: (value: string) => void
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.replaceChildren();

    new Setting(this.contentEl)
      .setName(this.label)
      .addText((text) => {
        text.setValue(this.value);
        text.onChange((value: string) => {
          this.value = value;
        });
        // Enter in the text field submits
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      })
      // 「作成」 CTA (setCta adds the mod-cta class)
      .addButton((button) => {
        button.setButtonText("作成").setCta().onClick(() => this.submit());
      })
      .addButton((button) => {
        button.setButtonText("キャンセル").onClick(() => this.close());
      });
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }

  private submit(): void {
    // no validation — the raw value (even "") submits
    this.onSubmit(this.value);
    // auto-close after submitting
    this.close();
  }
}

/**
 *
 * Parent-task picker used when adding a task to the Gantt view. Same
 * hand-built filtered-list pattern as TaskFinderModal (this repo extends
 * plain Modal instead of Obsidian's FuzzySuggestModal): a search input over
 * a flat list, arrow-key selection, Enter/click to choose. Choosing awaits
 * the onChoose callback and then closes. With zero items the search field
 * still renders but nothing is selectable.
 */
export class GanttParentPickerModal extends Modal {
  private filtered: TaskRow[];
  private selectedIndex = 0;
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly items: TaskRow[],
    private readonly onChoose: (item: TaskRow) => void | Promise<void>,
    private readonly placeholder = "Ganttに追加する親タスクを検索..."
  ) {
    super(app);
    this.filtered = items.slice();
  }

  onOpen(): void {
    const content = this.contentEl;
    content.replaceChildren();

    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = this.placeholder;
    input.addEventListener("input", () => {
      this.setQuery(input.value);
    });
    input.addEventListener("keydown", (event) => {
      this.handleKeydown(event);
    });
    content.appendChild(input);

    this.listEl = document.createElement("div");
    this.listEl.className = "vg-modal-list vg-finder-list";
    content.appendChild(this.listEl);

    this.renderList();
    input.focus();
  }

  onClose(): void {
    this.contentEl.replaceChildren();
    this.listEl = null;
  }

  setQuery(query: string): void {
    this.filtered = this.items.filter((item) => pickerMatches(query, item));
    this.selectedIndex = 0;
    this.renderList();
  }

  moveSelection(delta: number): void {
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    const next = this.selectedIndex + delta;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.filtered.length - 1, next)
    );
    this.renderList();
  }

  confirmSelection(): void {
    const item = this.filtered[this.selectedIndex];
    if (item) {
      void this.chooseItem(item);
    }
  }

  handleKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.confirmSelection();
    }
  }

  /**
 * await the callback first, then close the modal.
 */
  private async chooseItem(item: TaskRow): Promise<void> {
    await this.onChoose(item);
    this.close();
  }

  private renderList(): void {
    const listEl = this.listEl;
    if (!listEl) {
      // Logic-only usage without a rendered DOM (unit tests)
      return;
    }
    listEl.replaceChildren();
    if (this.filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vg-empty";
      empty.textContent = "該当するタスクがありません";
      listEl.appendChild(empty);
      return;
    }
    let selectedRow: HTMLElement | null = null;
    this.filtered.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "vg-list-row";
      // bold task name + "[ステータス] • [ファイルパス]" meta
      const titleEl = document.createElement("div");
      titleEl.className = "task-workbench-finder-title";
      titleEl.textContent =
        item.displayName || item.title || pickerBarePath(item);
      const metaEl = document.createElement("div");
      metaEl.className = "task-workbench-finder-meta";
      metaEl.textContent = `${getStatusLabel(item.statusLabel)} • ${
        item.file?.path || pickerBarePath(item)
      }`;
      row.appendChild(titleEl);
      row.appendChild(metaEl);
      if (index === this.selectedIndex) {
        row.className = "vg-list-row is-selected";
        selectedRow = row;
      }
      row.addEventListener("click", () => {
        void this.chooseItem(item);
      });
      listEl.appendChild(row);
    });
    const target = selectedRow as HTMLElement | null;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  }
}

/**
 * Returns a top-level path when present; otherwise an empty string. TaskRow
 * normally stores its path in `file.path`.
 */
function pickerBarePath(item: TaskRow): string {
  return (item as TaskRow & { path?: string }).path ?? "";
}

/**
 * search text = (displayName || title || path) + currentStatus
 * + (file?.path || path), fuzzy-matched as one joined string.
 */
function pickerMatches(query: string, item: TaskRow): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const fallback = pickerBarePath(item);
  const name = item.displayName || item.title || fallback;
  const filePath = item.file?.path || fallback;
  const searchText = `${name} ${item.currentStatus ?? ""} ${filePath}`.toLowerCase();
  return fuzzyIncludes(searchText, q);
}

/**
 *
 * Yes/no confirmation for a drag that would shift dates out from under
 * recorded workload actuals ("この移動により作業記録がずれます"). Same
 * Setting-based two-button idiom as TextInputModal's 「作成」/「キャンセル」
 * pair. `onResult` is called exactly once, synchronously with whichever
 * button was clicked, before close — matching TextInputModal.submit's
 * own call-then-close ordering.
 */
export class ConfirmDragWorkloadModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly onResult: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("作業実績の変更確認");
    this.contentEl.replaceChildren();

    const desc = document.createElement("p");
    desc.textContent = this.message;
    this.contentEl.appendChild(desc);

    new Setting(this.contentEl)
      .addButton((button) => {
        button
          .setButtonText("実行する")
          .setCta()
          .onClick(() => {
            this.finish(true);
            this.close();
          });
      })
      .addButton((button) => {
        button.setButtonText("キャンセル").onClick(() => {
          this.finish(false);
          this.close();
        });
      });
  }

  onClose(): void {
    // Escape / backdrop / programmatic close without an explicit button
    // click counts as declining the confirmation (same semantics as
    // 「キャンセル」), so the wrapping Promise never hangs forever.
    this.finish(false);
    this.contentEl.replaceChildren();
  }

  private finish(confirmed: boolean): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.onResult(confirmed);
  }
}

/**
 *
 * Promise wrapper around ConfirmDragWorkloadModal — the shape
 * TaskGanttViewHost.confirmWorkloadShift expects.
 */
export function confirmDragWorkloadShift(
  app: App,
  message: string
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmDragWorkloadModal(app, message, resolve).open();
  });
}


















export class MarkerModal extends Modal {
  private titleValue: string;
  private dateValue: string;
  private settled = false;
  private confirmButtonEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly modalTitle: string,
    initialTitle: string,
    initialDate: string,
    private readonly onSubmit: (
      result: { title: string; date: string } | null
    ) => void
  ) {
    super(app);
    this.titleValue = initialTitle;
    this.dateValue = initialDate;
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    const content = this.contentEl;
    content.replaceChildren();

    // title text input — empty for a new marker, pre-filled
    // with the existing title when editing.
    const titleField = document.createElement("div");
    titleField.className = "task-gantt-marker-modal-field";
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "タイトル";
    titleField.appendChild(titleLabel);
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = this.titleValue;
    titleInput.addEventListener("input", () => {
      this.titleValue = titleInput.value;
    });
    titleField.appendChild(titleInput);
    content.appendChild(titleField);

    // date input — defaults to today (the caller passes
    // todayStr for the "new marker" case) / pre-filled when editing.
    const dateField = document.createElement("div");
    dateField.className = "task-gantt-marker-modal-field";
    const dateLabel = document.createElement("label");
    dateLabel.textContent = "日付";
    dateField.appendChild(dateLabel);
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = this.dateValue;
    dateInput.addEventListener("input", () => {
      this.dateValue = dateInput.value;
      this.updateConfirmDisabled();
    });
    dateField.appendChild(dateInput);
    content.appendChild(dateField);

    const buttons = document.createElement("div");
    buttons.className = "task-gantt-modal-buttons";

    const confirmButton = document.createElement("button");
    confirmButton.textContent = "保存";
    confirmButton.className = "mod-cta";
    confirmButton.addEventListener("click", () => {
      this.submit();
    });
    this.confirmButtonEl = confirmButton;
    this.updateConfirmDisabled(); // disabled while date is empty
    buttons.appendChild(confirmButton);

    const cancelButton = document.createElement("button");
    cancelButton.textContent = "キャンセル";
    cancelButton.addEventListener("click", () => {
      // Explicit finish(null) here (not just close), same idiom as
      // ConfirmDragWorkloadModal's two button handlers above — close's
      // real-Obsidian-lifecycle call into onClose is a backstop for
      // Escape/backdrop dismissal, not the primary path for an explicit
      // button click.
      this.finish(null);
      this.close();
    });
    buttons.appendChild(cancelButton);

    content.appendChild(buttons);
  }

  onClose(): void {
    // Escape / backdrop / programmatic close without an explicit button
    // click counts as cancelling (same as ConfirmDragWorkloadModal's
    // onClose fix — the settled guard makes this idempotent alongside an
    // earlier explicit submit/close).
    this.finish(null);
    this.contentEl.replaceChildren();
  }

  /** 保存 stays disabled for as long as the date field is empty. */
  private updateConfirmDisabled(): void {
    if (this.confirmButtonEl) {
      this.confirmButtonEl.disabled = this.dateValue === "";
    }
  }

  private submit(): void {
    if (this.dateValue === "") {
      return; // defensive: the button is disabled, but guard anyway
    }
    this.finish({ title: this.titleValue.trim(), date: this.dateValue });
    this.close();
  }

  private finish(result: { title: string; date: string } | null): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.onSubmit(result);
  }
}

/**
 *
 * Promise wrapper around MarkerModal — the shape
 * TaskGanttViewHost.openMarkerModal expects. Resolves with the submitted
 * {title, date}, or null when the user cancelled.
 */
export function openMarkerModal(
  app: App,
  modalTitle: string,
  initialTitle: string,
  initialDate: string
): Promise<{ title: string; date: string } | null> {
  return new Promise((resolve) => {
    new MarkerModal(app, modalTitle, initialTitle, initialDate, resolve).open();
  });
}


export interface WeeklyWorkScheduleModalCallbacks {
  add(
    title: string,
    dayOfWeek: number,
    minutesPerWeek: number
  ): void | Promise<void>;
  update(
    key: string,
    patch: Partial<WeeklyWorkSchedule>
  ): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/**
 *
 * Live editor for the weekly recurring work-time schedule list. Every field
 * edit is sent to the injected callback immediately; there is no separate
 * save or cancel operation. The callbacks may return a Promise so the caller
 * can persist settings and refresh the Gantt after each mutation.
 */
export class WeeklyWorkScheduleModal extends Modal {
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly schedules: WeeklyWorkSchedule[],
    private readonly callbacks: WeeklyWorkScheduleModalCallbacks
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("定例作業設定");
    const content = this.contentEl;
    content.replaceChildren();

    const list = document.createElement("div");
    list.className = "task-gantt-weekly-work-schedule-list";
    this.listEl = list;
    content.appendChild(list);
    this.renderRows();

    const buttons = document.createElement("div");
    buttons.className = "task-gantt-weekly-work-schedule-buttons";

    const addButton = document.createElement("button");
    addButton.textContent = "追加";
    addButton.className = "mod-cta";
    addButton.addEventListener("click", () => {
      // a new row starts blank on Sunday for 30 minutes.
      this.invokeCallback(() => this.callbacks.add("", 0, 30));
      this.renderRows();
    });
    buttons.appendChild(addButton);

    const closeButton = document.createElement("button");
    closeButton.textContent = "閉じる";
    closeButton.addEventListener("click", () => {
      this.close();
    });
    buttons.appendChild(closeButton);
    content.appendChild(buttons);
  }

  onClose(): void {
    this.contentEl.replaceChildren();
    this.listEl = null;
  }

  private renderRows(): void {
    const list = this.listEl;
    if (!list) {
      return;
    }
    list.replaceChildren();
    for (const schedule of this.schedules) {
      this.appendRow(list, schedule);
    }
  }

  private appendRow(
    list: HTMLElement,
    schedule: WeeklyWorkSchedule
  ): void {
    const row = document.createElement("div");
    row.className = "task-gantt-weekly-work-schedule-row";

    const titleLabel = document.createElement("label");
    titleLabel.textContent = "作業名";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = schedule.title;
    titleInput.setAttribute("aria-label", "作業名");
    titleInput.addEventListener("input", () => {
      this.invokeCallback(() =>
        this.callbacks.update(schedule.key, { title: titleInput.value })
      );
    });
    titleLabel.appendChild(titleInput);
    row.appendChild(titleLabel);

    const dayLabel = document.createElement("label");
    dayLabel.textContent = "曜日";
    const daySelect = document.createElement("select");
    daySelect.setAttribute("aria-label", "曜日");
    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    dayNames.forEach((dayName, dayOfWeek) => {
      const option = document.createElement("option");
      option.value = String(dayOfWeek);
      option.textContent = dayName;
      daySelect.appendChild(option);
    });
    daySelect.value = String(schedule.dayOfWeek);
    daySelect.addEventListener("change", () => {
      this.invokeCallback(() =>
        this.callbacks.update(schedule.key, {
          dayOfWeek: Number(daySelect.value),
        })
      );
    });
    dayLabel.appendChild(daySelect);
    row.appendChild(dayLabel);

    const minutesLabel = document.createElement("label");
    minutesLabel.textContent = "週の分数";
    const minutesInput = document.createElement("input");
    minutesInput.type = "number";
    minutesInput.setAttribute("step", "30");
    minutesInput.setAttribute("min", "0");
    minutesInput.value = String(schedule.minutesPerWeek);
    minutesInput.setAttribute("aria-label", "週の分数");
    minutesInput.addEventListener("input", () => {
      this.invokeCallback(() =>
        this.callbacks.update(schedule.key, {
          minutesPerWeek: Number(minutesInput.value),
        })
      );
    });
    minutesLabel.appendChild(minutesInput);
    row.appendChild(minutesLabel);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "削除";
    deleteButton.className = "mod-warning";
    deleteButton.addEventListener("click", () => {
      this.invokeCallback(() => this.callbacks.delete(schedule.key));
      this.renderRows();
    });
    row.appendChild(deleteButton);

    list.appendChild(row);
  }

  private invokeCallback(callback: () => void | Promise<void>): void {
    try {
      const result = callback();
      if (result !== undefined) {
        void result.catch((error: unknown) => {
          console.error("定例作業設定の保存に失敗しました", error);
        });
      }
    } catch (error: unknown) {
      console.error("定例作業設定の更新に失敗しました", error);
    }
  }
}


/**
 * Substring match first, then a subsequence fallback (same minimal fuzzy
 * matching as TaskFinderModal).
 */
function fuzzyIncludes(text: string, query: string): boolean {
  const target = text.toLowerCase();
  if (target.includes(query)) {
    return true;
  }
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti += 1) {
    if (target[ti] === query[qi]) {
      qi += 1;
    }
  }
  return qi === query.length;
}
