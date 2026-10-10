import { ItemView, moment, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import type { Logger } from "../core/logger";

import type { TaskPatch, TaskRow, TaskWorkbenchSettings } from "../core/types";
import { DEFAULT_STATUSES } from "../core/constants";
import {
  calculateAutoPriority,
  dueDaysFromToday,
  getEffectivePriority,
  normalizePriority,
} from "../core/utils";
import {
  getCollapsedWorkbenchRows,
  getDisplayRows,
  normalizePriorityMode,
  parseTagsInput,
} from "../app/workbench-display";
import type {
  DisplayRowsOptions,
  WorkbenchDisplayRow,
} from "../app/workbench-display";
import { TaskFinderModal } from "./task-finder-modal";
import { appendTagChips } from "./tag-chip";

// 200ms keeps rapid typing from rebuilding the full table on every key while
// still making the filter feel live once the user pauses.
const FILTER_RENDER_DEBOUNCE_MS = 200;


























export interface TaskWorkbenchViewHost {

  logger: Logger;

  settings: TaskWorkbenchSettings;
  loadTasks(): Promise<TaskRow[]>;
  getDisplayRows(tasks: TaskRow[], opts: DisplayRowsOptions): TaskRow[];
  updateTaskItem(row: TaskRow, patch: TaskPatch): Promise<unknown>;
  openTaskItem(row: TaskRow): Promise<void>;
  createTaskInteractively(onCreated: () => void): Promise<void>;
  activateGanttView(): Promise<void>;
  undoLastAction(): Promise<void>;
  redoLastAction(): Promise<void>;
  addSubtaskInteractively?(row: TaskRow, onCreated: () => void): Promise<void>;
}
























export class TaskWorkbenchView extends ItemView {
  // --- Header control state (persists for the view's lifetime) ---

  private filterText = "";

  private statusFilter = "all";
  /** Initialized from settings.hideCompletedByDefault. */
  private showCompleted: boolean;

  private sortKey = "updatedAt";

  private sortDir: "asc" | "desc" = "desc";

  private flatDueSort = false;

  // Inline-edit state, set while a cell is being edited and null otherwise.
  // startEditing, stopEditing, render, and the sort/filter controls update it.

  private editing: { rowId: string; field: string } | null = null;
  /** Leading+trailing filter redraw timer; cleared before any immediate redraw. */
  private filterRenderTimer: ReturnType<typeof setTimeout> | undefined;
  /** Filter value used by the leading render that opened the current burst. */
  private filterRenderLeadingValue: string | undefined;
  /** Filter input composition guard so Japanese IME text is not redrawn mid-composition. */
  private filterComposing = false;

  // --- Data and collapse state ---
  /** last loaded task list (loadTasks shape). */
  private tasks: TaskRow[] = [];
  /**
 * lazily created by ensureCollapseState — the Set is
 * not allocated until hierarchy mode actually needs it. Membership means
 * COLLAPSED; absence means expanded.
 */
  private collapsedParentIds: Set<string> | null = null;

  /** Parent ids present in the first task snapshot, collapsed on first hierarchy render. */
  private initialParentIds: Set<string> | null = null;



  private headerEl!: HTMLElement;

  private tableWrapEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: TaskWorkbenchViewHost
  ) {
    super(leaf);
    // hideCompletedByDefault=true → completed rows hidden first.
    this.showCompleted = !host.settings.hideCompletedByDefault;
  }

  /** matches VIEW_TYPE_TASK_WORKBENCH in src/main.ts. */
  getViewType(): string {
    return "task-workbench-view";
  }


  getDisplayText(): string {
    return "Task Workbench";
  }

  /**
 *
 * View.getIcon is an official obsidian API hook (obsidian.d.ts View,
 * @since 1.1.0; IconName = string). The same icon id is used for the
 * ribbon button in main.ts.
 */
  getIcon(): string {
    return "list-todo";
  }

  /**
 *
 * Resets the container, builds the header + table wrapper elements once,
 * then runs the initial render. A fresh View instance is created per
 * open, so all control/collapse state starts from its defaults.
 */
  async onOpen(): Promise<void> {
    const container = this.containerEl;
    // Obsidian's HTMLElement.empty extension.
    container.empty();

    container.classList.add("task-workbench-container");


    this.headerEl = document.createElement("div");
    this.headerEl.classList.add("task-workbench-header");
    container.appendChild(this.headerEl);


    this.tableWrapEl = document.createElement("div");
    this.tableWrapEl.classList.add("task-workbench-table-wrap");
    container.appendChild(this.tableWrapEl);


    await this.render();
  }

  /** Cancels a pending filter timer and resets the current burst state. */
  private cancelFilterRender(): void {
    if (this.filterRenderTimer !== undefined) {
      clearTimeout(this.filterRenderTimer);
      this.filterRenderTimer = undefined;
    }
    this.filterRenderLeadingValue = undefined;
  }

  /** Pauses a pending burst timer while preserving its leading value. */
  private pauseFilterRender(): void {
    if (this.filterRenderTimer !== undefined) {
      clearTimeout(this.filterRenderTimer);
      this.filterRenderTimer = undefined;
    }
  }

  /**
 * Leading+trailing debounce: the first settled input renders immediately;
 * later inputs only extend the trailing window. A trailing render is emitted
 * only when the final value differs from the leading-rendered value.
 */
  private scheduleFilterRender(): void {
    if (this.filterComposing) {
      return;
    }

    const isBurstActive =
      this.filterRenderTimer !== undefined ||
      this.filterRenderLeadingValue !== undefined;
    if (!isBurstActive) {
      this.renderTable();
      this.filterRenderLeadingValue = this.filterText;
    } else if (this.filterRenderTimer !== undefined) {
      clearTimeout(this.filterRenderTimer);
      this.filterRenderTimer = undefined;
    }

    this.filterRenderTimer = setTimeout(() => {
      this.filterRenderTimer = undefined;
      if (this.filterComposing) {
        return;
      }
      const leadingValue = this.filterRenderLeadingValue;
      this.filterRenderLeadingValue = undefined;
      if (leadingValue !== this.filterText) {
        this.renderTable();
      }
    }, FILTER_RENDER_DEBOUNCE_MS);
  }

  /** Immediately applies a changed trailing value and clears its timer. */
  private flushFilterRender(): void {
    if (this.filterRenderTimer === undefined) {
      return;
    }
    clearTimeout(this.filterRenderTimer);
    this.filterRenderTimer = undefined;
    const leadingValue = this.filterRenderLeadingValue;
    this.filterRenderLeadingValue = undefined;
    if (!this.filterComposing && leadingValue !== this.filterText) {
      this.renderTable();
    }
  }

  /** Renders a mode change without leaving an older filter timer pending. */
  private renderTableImmediately(): void {
    this.cancelFilterRender();
    this.renderTable();
  }

  /**
 * Obsidian calls onClose when the leaf is disposed; no delayed filter redraw
 * may target the detached view.
 */
  onClose(): Promise<void> {
    this.cancelFilterRender();
    return Promise.resolve();
  }

  /**
 *
 * Full reload + rebuild: re-reads tasks from the host, then reconstructs
 * the header and the table from scratch.
 */
  async render(): Promise<void> {

    const startedAt = Date.now();

    // A full render discards an in-progress edit. savePatch relies on this
    // reset after a successful write to clear the editor.
    if (this.editing !== null) {
      this.editing = null;
    }
    await this.refreshTasks();
    this.renderHeader();

    this.renderTable(startedAt);

  }

  /** plugin.loadTasks → this.tasks. */
  async refreshTasks(): Promise<void> {
    const tasks = await this.host.loadTasks();

    // Capture only the first snapshot so parents added after initial load stay expanded.
    if (this.initialParentIds === null) {
      this.initialParentIds = new Set(
        tasks
          .filter((task) => task.kind === "parent")
          .map((task) => task.id)
      );
    }

    this.tasks = tasks;
  }













  renderHeader(): void {
    this.headerEl.replaceChildren();

    // structural toolbar classes
    const left = document.createElement("div");
    left.classList.add("task-workbench-toolbar-left");
    this.headerEl.appendChild(left);


    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "フィルター...";
    filterInput.classList.add("task-workbench-search");
    filterInput.value = this.filterText;
    filterInput.addEventListener("input", () => {
      // the first settled keystroke redraws immediately; later
      // keystrokes in the same burst share one trailing redraw.
      // the raw text is passed through to getDisplayRows.
      this.filterText = filterInput.value;
      // filter changes discard any in-progress edit.
      this.editing = null;
      this.scheduleFilterRender();
    });
    filterInput.addEventListener("compositionstart", () => {
      this.filterComposing = true;
      // Do not lose a leading render already in flight; only pause its timer
      // so the trailing edge cannot fire during Japanese composition.
      this.pauseFilterRender();
    });
    filterInput.addEventListener("compositionend", () => {
      this.filterComposing = false;
      this.scheduleFilterRender();
    });
    filterInput.addEventListener("blur", () => {
      // Applying immediately on blur preserves the latest filter while
      // ensuring no delayed callback survives focus leaving the input.
      this.flushFilterRender();
    });
    left.appendChild(filterInput);


    left.appendChild(
      this.buildSelect(
        [
          ["all", "すべてのステータス"],

          ...Object.entries(DEFAULT_STATUSES),
        ],
        this.statusFilter,
        (value) => {
          this.statusFilter = value;
          // filter changes discard any in-progress edit.
          this.editing = null;
          this.renderTableImmediately();
        }
      )
    );


    left.appendChild(
      this.buildSelect(
        [
          ["dueDate", "期限順"],
          ["updatedAt", "更新日順"],
          ["createdAt", "作成日順"],
          ["title", "タスク名順"],
          ["statusLabel", "ステータス順"],
        ],
        this.sortKey,
        (value) => {
          this.sortKey = value;
          // sort changes discard any in-progress edit.
          this.editing = null;
          this.renderTableImmediately();
        }
      )
    );


    left.appendChild(
      this.buildSelect(
        [
          ["asc", "昇順"],
          ["desc", "降順"],
        ],
        this.sortDir,
        (value) => {
          this.sortDir = value === "asc" ? "asc" : "desc";
          // sort changes discard any in-progress edit.
          this.editing = null;
          this.renderTableImmediately();
        }
      )
    );


    left.appendChild(
      this.buildCheckbox(
        "task-workbench-flat-due-label",
        "サブタスク含めた期限順",
        this.flatDueSort,
        (checked) => {
          // flat due-date sort ignoring hierarchy.
          this.flatDueSort = checked;
          // sort changes discard any in-progress edit.
          this.editing = null;
          this.renderTableImmediately();
        }
      )
    );


    left.appendChild(
      this.buildCheckbox(
        "task-workbench-checkbox-label",
        "完了も表示",
        this.showCompleted,
        (checked) => {

          this.showCompleted = checked;
          // filter changes discard any in-progress edit.
          this.editing = null;
          this.renderTableImmediately();
        }
      )
    );


    const right = document.createElement("div");
    right.classList.add("task-workbench-toolbar-right");
    this.headerEl.appendChild(right);


    right.appendChild(
      this.buildButton("ガント", null, () => {
        void this.host.activateGanttView();
      })
    );


    right.appendChild(
      this.buildButton("新規タスク", "mod-cta", () => {
        void this.host.createTaskInteractively(() => {
          // automatic table redraw after creation.
          void this.render();
        });
      })
    );


    right.appendChild(
      this.buildButton("更新", null, () => {
        // Full reload: discards stale in-memory tasks and re-reads the vault.
        void this.render();
      })
    );

    right.appendChild(
      this.buildIconButton(
        "undo-2",
        "元に戻す",
        ["task-workbench-undo"],
        () => {
          void this.host.undoLastAction();
        }
      )
    );

    right.appendChild(
      this.buildIconButton(
        "redo-2",
        "やり直す",
        ["task-workbench-redo"],
        () => {
          void this.host.redoLastAction();
        }
      )
    );


    right.appendChild(
      this.buildButton("タスク検索", null, () => {
        this.openTaskFinder();
      })
    );
  }

  /**
 * opens the TaskFinderModal over the flattened
 * in-memory task list (parents + subtasks). The modal's 5-field search
 * and rich suggestion render live in src/ui/task-finder-modal.ts.
 */
  private openTaskFinder(): void {
    const items: TaskRow[] = [];
    for (const task of this.tasks) {
      items.push(task);
      if (task.subtasks) {
        for (const subtask of task.subtasks.values()) {
          items.push(subtask);
        }
      }
    }
    // The host satisfies TaskItemOpener structurally (openTaskItem).
    new TaskFinderModal(this.app, this.host, items).open();
  }















  renderTable(startedAt?: number): void {

    // full clear on every call.
    this.tableWrapEl.empty();

    const today = moment().startOf("day");
    const parentDisplayNames = this.flatDueSort
      ? this.buildParentDisplayNames()
      : undefined;
    const displayRows = this.host.getDisplayRows(
      this.tasks,
      this.displayOptions(today)
    );

    // collapsing only applies in hierarchy mode. The
    // lazy collapse Set is not even allocated in flat mode.
    const rows: WorkbenchDisplayRow[] = this.flatDueSort
      ? displayRows
      : getCollapsedWorkbenchRows(
          displayRows,
          false,
          this.ensureCollapseState()
        );

    // a brand-new <table> every call.
    const table = document.createElement("table");
    table.classList.add("task-workbench-table");

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    // fixed 12 columns in this order.
    const headers = [
      "タスク名",
      "優先度",
      "状態",
      "現在のステータス",
      "作成日",
      "更新日",
      "期限",
      "タグ",
      "完了",
      "Ganttで管理",
      "開く",
      "+",
    ];
    for (const text of headers) {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    // zero rows → empty tbody.
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      // listeners are re-attached per row on every rebuild.
      tbody.appendChild(this.buildRow(row, parentDisplayNames, today));
    }
    table.appendChild(tbody);

    this.tableWrapEl.appendChild(table);

    // empty-state message below the table.
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.classList.add("task-workbench-empty");
      empty.textContent = "条件に一致するタスクがありません。";
      this.tableWrapEl.appendChild(empty);
    }


    if (startedAt !== undefined) {
      const rowCount = rows.length;
      this.host.logger.debug?.("TaskWorkbenchView", "render completed", {
        durationMs: Date.now() - startedAt,
        rowCount,
      });
    }

  }


  private displayOptions(today?: moment.Moment): DisplayRowsOptions {
    return {
      filterText: this.filterText,
      statusFilter: this.statusFilter,
      showCompleted: this.showCompleted,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      flatDueSort: this.flatDueSort,
      today,
    };
  }

  /**
 * lazy collapse-state initialization.
 * Initial parent ids are seeded as collapsed; later-added ids remain absent
 * so newly created parents start expanded.
 */
  private ensureCollapseState(): Set<string> {
    if (!this.collapsedParentIds) {

      this.collapsedParentIds = new Set(this.initialParentIds ?? []);

    }
    return this.collapsedParentIds;
  }

  /**
 * Builds the parent-name lookup once for the current table render pass.
 * Flat-mode child rows then resolve their prefix without scanning all tasks.
 */
  private buildParentDisplayNames(): Map<string, string> {
    const parentDisplayNames = new Map<string, string>();
    for (const task of this.tasks) {
      parentDisplayNames.set(task.id, task.displayName || task.title);
    }
    return parentDisplayNames;
  }

  /**
 *
 * Toggles the parent's fold state (Set membership = collapsed) and
 * redraws the table.
 */
  private toggleParentExpanded(row: WorkbenchDisplayRow): void {
    const ids = this.ensureCollapseState();
    if (ids.has(row.id)) {
      ids.delete(row.id);
    } else {
      ids.add(row.id);
    }
    this.renderTable();
  }

  /**
 * Builds one table row with its 12 cells.
 *
 *
 */
  private buildRow(
    row: WorkbenchDisplayRow,
    parentDisplayNames: Map<string, string> | undefined,
    today: moment.Moment
  ): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.classList.add("task-workbench-row");
    if (row.kind === "subtask") {
      // parent rows never get is-subtask.
      tr.classList.add("is-subtask");
    }
    if (row.__twbCollapsedPreview === true) {

      tr.classList.add("twb-collapsed-preview-row");
    }
    // Mark completed rows with a class so their state can be styled.
    if (row.completed === true) {
      tr.classList.add("is-completed");
    }

    // overdue wins over due-soon (if-else).

    // empty/invalid dueDate → dueDaysFromToday = null → no class.
    const days = dueDaysFromToday(row.dueDate, today);
    if (days !== null && days < 0) {
      tr.classList.add("twb-overdue-row");
    } else if (days !== null && days <= 3) {
      tr.classList.add("twb-due-soon-row");
    }

    tr.appendChild(this.buildNameCell(row, parentDisplayNames));
    tr.appendChild(this.buildPriorityCell(row, today));
    tr.appendChild(this.buildStatusCell(row));
    tr.appendChild(this.buildCurrentStatusCell(row));
    tr.appendChild(this.buildPlainDateCell(row.createdAt));
    tr.appendChild(this.buildPlainDateCell(row.updatedAt));
    tr.appendChild(this.buildDueDateCell(row, today));
    tr.appendChild(this.buildTagsCell(row));
    tr.appendChild(this.buildCompletedCell(row));
    tr.appendChild(this.buildGanttCell(row));
    tr.appendChild(this.buildOpenCell(row));
    tr.appendChild(this.buildAddCell(row));
    return tr;
  }

  /**
 * 列1 タスク名.
 *
 *
 *
 *
 */
  private buildNameCell(
    row: WorkbenchDisplayRow,
    parentDisplayNames?: Map<string, string>
  ): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("task-workbench-col-name");

    // while editing, the whole cell becomes the editor
    // (toggle/summary are not rendered in edit mode).
    if (this.isEditing(row, "displayName")) {
      td.appendChild(this.buildNameEditor(row));
      return td;
    }

    const info = row.__twbCollapseInfo;

    // displayName falls back to title.
    const name = row.displayName || row.title;

    const textWrap = document.createElement("div");
    textWrap.classList.add("task-workbench-cell-text");


    // fold toggle on the LEFT of the name, only for
    // parents with surviving children. Flat-mode rows carry no collapse
    // info, so no toggle appears in flat mode.
    if (row.kind === "parent" && info && info.total > 0) {
      const toggle = document.createElement("button");
      toggle.classList.add("twb-collapse-toggle");
      // ▾ expanded / ▸ collapsed.
      toggle.textContent = info.expanded ? "▾" : "▸";
      // aria-label/title wording per fold state.
      const label = info.expanded
        ? `子タスクを折りたたむ（${info.total}件）`
        : `子タスクを展開（${info.total}件中 ${info.visibleCount}件表示）`;
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.toggleParentExpanded(row);
      });
      textWrap.appendChild(toggle);
    }


    if (row.kind === "subtask" && this.flatDueSort) {
      // 「親タスク / 子タスク」 prefix in flat mode.
      const prefix = document.createElement("span");
      prefix.classList.add("task-workbench-parent-prefix");
      prefix.textContent = `${this.parentDisplayName(
        row,
        parentDisplayNames
      )} / `;
      textWrap.appendChild(prefix);
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      textWrap.appendChild(nameSpan);
    } else if (name === "") {
      // Both displayName and title are empty, so render an empty span.
      // CSS controls the minimum row height for empty task names.
      textWrap.appendChild(document.createElement("span"));
    } else if (row.kind === "parent") {
      // parent names are bold via strong-parent span.
      const strong = document.createElement("span");
      strong.classList.add("strong-parent");
      strong.textContent = name;
      textWrap.appendChild(strong);
    } else {
      // subtask names use the normal font.
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      textWrap.appendChild(nameSpan);
    }

    // dblclick on the displayed name starts inline editing.
    textWrap.addEventListener("dblclick", () => {
      this.startEditing(row, "displayName");
    });

    if (row.kind === "subtask" && !this.flatDueSort) {
      // indent subtask names in hierarchy mode.
      const indent = document.createElement("div");
      indent.classList.add("task-indent");
      indent.appendChild(textWrap);
      td.appendChild(indent);
    } else {
      td.appendChild(textWrap);
    }

    // collapsed parents append 「他N件」 after the name;


    if (info && !info.expanded && info.hiddenCount > 0) {
      const summary = document.createElement("span");
      summary.classList.add("twb-collapse-summary");
      summary.textContent = ` 他${info.hiddenCount}件`;
      td.appendChild(summary);
    }

    return td;
  }

  /**
 * Resolves a subtask's parent display name for the flat-mode prefix.
 * Parent lookup matches `row.file.parentPath` against the in-memory task
 * list; unknown parents yield an empty prefix.
 */
  private parentDisplayName(
    row: TaskRow,
    parentDisplayNames?: Map<string, string>
  ): string {
    const parentPath = row.file.parentPath;
    if (!parentPath || !parentDisplayNames) {
      return "";
    }
    return parentDisplayNames.get(parentPath) ?? "";
  }

  /**
 * 列2 優先度 — five star buttons + reset, always live (no editing state).
 *
 *
 *
 */
  private buildPriorityCell(
    row: TaskRow,
    today: moment.Moment
  ): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("task-workbench-priority-cell");

    const starsWrap = document.createElement("div");
    starsWrap.classList.add("task-workbench-priority-stars");
    td.appendChild(starsWrap);

    // invalid stored modes default to "auto".
    const mode = normalizePriorityMode(row.priorityMode);
    const autoPriorityEnabled = this.host.settings.autoPriorityEnabled !== false;
    const isAuto = autoPriorityEnabled && mode !== "manual";
    // effective priority (auto-calc or normalized manual).
    const effective = getEffectivePriority(row, autoPriorityEnabled, today);
    starsWrap.setAttribute(
      "aria-label",
      `優先度 ${effective || "未設定"} ${isAuto ? "自動" : "手動"}`
    );

    for (let position = 1; position <= 5; position += 1) {
      const star = document.createElement("button");
      star.classList.add("task-workbench-priority-star");
      // mode class on every star (auto → blue styling).
      star.classList.add(isAuto ? "priority-auto" : "priority-manual");
      star.setAttribute(
        "title",
        `${position} / 5 ${isAuto ? "(自動設定中)" : "(手動設定)"}`
      );
      // i <= effective fills the star; `effective` is
      // clamped to [0,5] by normalizePriority, so priority=10 → all five ★

      star.textContent = position <= effective ? "★" : "☆";
      star.addEventListener("click", (evt) => {
        evt.stopPropagation();
        void this.applyPriorityStarClick(row, position, isAuto);
      });
      starsWrap.appendChild(star);
    }

    // reset button to the right of all stars.
    const reset = document.createElement("button");
    reset.classList.add("task-workbench-priority-reset");
    reset.setAttribute("title", "手動優先度を解除して自動計算に戻す");
    reset.textContent = "↺";
    reset.addEventListener("click", (evt) => {
      evt.stopPropagation();
      // reset restores the auto-calculated priority.
      void this.savePatch(row, {
        priority: calculateAutoPriority(row.dueDate),
        priorityMode: "auto",
      });
    });
    starsWrap.appendChild(reset);

    return td;
  }









  private async applyPriorityStarClick(
    row: TaskRow,
    position: number,
    isAuto: boolean
  ): Promise<void> {
    let patch: TaskPatch;
    if (!isAuto && normalizePriority(row.priority) === position) {
      // re-clicking the current manual priority returns to
      // auto mode. The patch mirrors the reset button's canonical
      // "back to auto" shape so the stored priority matches the
      // due-date-derived value even when autoPriorityEnabled is off.
      patch = {
        priority: calculateAutoPriority(row.dueDate),
        priorityMode: "auto",
      };
    } else {
      // For a different manual star or auto mode, set the clicked position
      // as a manual priority. Positions are always 1-5; out-of-range stored
      // values are normalized on click.
      patch = { priority: position, priorityMode: "manual" };
    }
    await this.savePatch(row, patch);
  }






  private buildStatusCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    const select = document.createElement("select");
    select.classList.add("task-workbench-inline-select");
    // exactly the five DEFAULT_STATUSES options.
    for (const [value, label] of Object.entries(DEFAULT_STATUSES)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    // a statusLabel outside DEFAULT_STATUSES matches no option
    // — the select silently shows no selection (no error notification).
    select.value = row.statusLabel;
    select.addEventListener("change", () => {
      // save immediately on change, then re-render.
      void this.savePatch(row, { statusLabel: select.value });
    });
    select.addEventListener("click", (evt) => {
      // keep clicks inside the select.
      evt.stopPropagation();
    });
    td.appendChild(select);
    return td;
  }







  private buildCurrentStatusCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("task-workbench-col-status");
    if (this.isEditing(row, "currentStatus")) {
      td.appendChild(this.buildCurrentStatusEditor(row));
      return td;
    }
    const text = document.createElement("div");
    text.classList.add("task-workbench-cell-text");
    // empty currentStatus renders as empty text.
    text.textContent = row.currentStatus ?? "";
    // dblclick on the displayed text starts inline editing.
    text.addEventListener("dblclick", () => {
      this.startEditing(row, "currentStatus");
    });
    td.appendChild(text);
    return td;
  }

  /**
 * Columns 5 (created) and 6 (updated) are plain-text cells.
 *
 *
 */
  private buildPlainDateCell(value: string): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("narrow-col");
    // empty values display as empty text.
    td.textContent = value ?? "";
    return td;
  }









  private buildDueDateCell(
    row: TaskRow,
    today: moment.Moment
  ): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("date-col");

    const input = document.createElement("input");
    input.type = "date";
    input.classList.add("task-workbench-inline-input", "compact-date");
    // input.value is always YYYY-MM-DD regardless of locale.
    // empty dueDate → empty field.
    input.value = row.dueDate ?? "";

    // overdue/today classes only for real dates.
    const days = dueDaysFromToday(row.dueDate, today);
    if (days !== null && days < 0) {
      input.classList.add("is-overdue");
    } else if (days !== null && days === 0) {
      input.classList.add("is-today");
    }

    // invalid dates are rejected by native HTML5
    // validation and never fire change — nothing to do on the view side.
    input.addEventListener("change", () => {
      // save YYYY-MM-DD (or empty string) and re-render.
      void this.savePatch(row, { dueDate: input.value });
    });
    input.addEventListener("click", (evt) => {
      // stop click propagation.
      evt.stopPropagation();
    });
    td.appendChild(input);
    return td;
  }







  private buildTagsCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    if (this.isEditing(row, "tags")) {
      td.appendChild(this.buildTagsEditor(row));
      return td;
    }
    // one chip per tag.
    // (row.tags || []) guards undefined/null at runtime.
    appendTagChips(td, row.tags || [], this.host.settings);
    // dblclick on the cell starts inline editing.
    td.addEventListener("dblclick", () => {
      this.startEditing(row, "tags");
    });
    return td;
  }

  /**
 * 列9 完了 checkbox.
 *
 *
 */
  private buildCompletedCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("tiny-col");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.completed === true;
    checkbox.addEventListener("change", () => {
      // persist the new state, then full re-render.
      void this.savePatch(row, { completed: checkbox.checked });
    });
    checkbox.addEventListener("click", (evt) => {
      // click propagation stopped.
      evt.stopPropagation();
    });
    td.appendChild(checkbox);
    return td;
  }

  /**
 * 列10 Ganttで管理 checkbox — parent rows only.
 *
 *
 */
  private buildGanttCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    if (row.kind !== "parent") {
      // empty cell for subtasks.
      return td;
    }
    td.classList.add("tiny-col");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.ganttEnabled === true;
    checkbox.addEventListener("change", () => {
      // keep a finite stored ganttOrder; stamp the
      // current unix time on first enable (undefined → Number(undefined)
      // is NaN → not finite → Date.now).
      void this.savePatch(row, {
        ganttEnabled: checkbox.checked,
        ganttOrder: Number.isFinite(Number(row.ganttOrder))
          ? row.ganttOrder
          : Date.now(),
      });
    });
    checkbox.addEventListener("click", (evt) => {
      // click propagation stopped.
      evt.stopPropagation();
    });
    td.appendChild(checkbox);
    return td;
  }

  /**
 * 列11 開く button.
 *
 *
 */
  private buildOpenCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    td.classList.add("tiny-col");
    const button = document.createElement("button");
    button.textContent = "開";
    button.classList.add("vg-btn-sm");
    button.addEventListener("click", (evt) => {
      // open the task file, click propagation stopped.
      evt.stopPropagation();
      void this.host.openTaskItem(row);
    });
    td.appendChild(button);
    return td;
  }

  /**
 * 列12 + button — parent rows only.
 *
 *
 */
  private buildAddCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    if (row.kind !== "parent") {
      // empty cell for subtasks.
      return td;
    }
    td.classList.add("tiny-col");
    const button = document.createElement("button");
    button.textContent = "+";
    button.classList.add("vg-btn-sm");
    button.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.addSubtaskForRow(row);
    });
    td.appendChild(button);
    return td;
  }

  /**
 *
 * main.ts's real host always provides addSubtaskInteractively; the method
 * stays optional on the interface defensively, so a host that omits it
 * fails LOUDLY (console warning) rather than silently pretending to
 * succeed.
 *
 * `row` may be a `getCollapsedWorkbenchRows` decoration, a shallow copy that
 * shares its `subtasks` Map with the cached TaskRow. `addSubtask` mutates that
 * map and updates the row in place, so the cache is transiently touched before
 * the write completes. The `onCreated` callback renders and reloads the file;
 * its updated mtime and size invalidate the cache for that render.
 */
  private addSubtaskForRow(row: TaskRow): void {
    if (this.host.addSubtaskInteractively) {
      void this.host.addSubtaskInteractively(row, () => {
        void this.render();
      });
      return;
    }

    this.host.logger.warn(
      "TaskWorkbenchView",
      "host.addSubtaskInteractively(row, onCreated) is not implemented — 「+」 clicked for",
      row.id
    );

  }



  /**
 *
 * Returns true while the given row and field are being edited. `editing`
 * is either `{ rowId, field }` or null. `TaskRow.id` is required by the type
 * system, and all edit, save, and delete operations rely on that invariant.
 * Rows without an id cannot be constructed through the typed interface.
 */
  private isEditing(row: TaskRow, field: string): boolean {
    return (
      this.editing !== null &&
      this.editing.rowId === row.id &&
      this.editing.field === field
    );
  }

  /**
 *
 * Enters edit mode and redraws the table only; a full render would
 * immediately clear the editing state just set.
 */
  private startEditing(row: TaskRow, field: string): void {
    this.editing = { rowId: row.id, field };
    this.renderTable();
  }

  /** leaves edit mode (typed content discarded) and redraws. */
  private stopEditing(): void {
    this.editing = null;
    this.renderTable();
  }















  private async savePatch(row: TaskRow, patch: TaskPatch): Promise<void> {

    const startedAt = Date.now();

    await this.host.updateTaskItem(row, patch);

    this.host.logger.info?.("TaskWorkbenchView", "workbench edit saved", {
      taskId: row.id,
      durationMs: Date.now() - startedAt,
    });

    await this.render();
  }










  private buildNameEditor(row: TaskRow): HTMLElement {
    const isParent = row.kind === "parent";
    // Both editors expose the same API surface this method uses (value,
    // focus, select, dataset, classList); typing the textarea branch as
    // HTMLInputElement keeps the keydown listener strongly typed
    // (KeyboardEvent) without a union that defeats overload resolution.
    const el = (
      isParent
        ? document.createElement("textarea")
        : document.createElement("input")
    ) as HTMLInputElement;
    if (!isParent) {
      el.type = "text";
    }
    // distinct editor classes per kind.
    el.classList.add(
      isParent
        ? "task-workbench-title-textarea"
        : "task-workbench-inline-input"
    );
    // Prefill with the display-mode fallback used by buildNameCell:
    // `row.displayName || row.title`. Otherwise, frontmatter-only rows that
    // use title as their effective name could lose it on an unmodified blur.
    el.value = row.displayName || row.title;

    // keep pointer events inside the editor.
    el.addEventListener("click", (evt) => evt.stopPropagation());
    el.addEventListener("mousedown", (evt) => evt.stopPropagation());
    el.addEventListener("dragstart", (evt) => {
      evt.stopPropagation();
      evt.preventDefault();
    });

    // IME composition state, same policy as buildCurrentStatusEditor.
    let composing = false;
    el.addEventListener("compositionstart", () => {
      composing = true;
    });
    el.addEventListener("compositionend", () => {
      composing = false;
    });

    el.addEventListener("keydown", (evt) => {
      if (composing) {
        return; // Enter/Escape are IME keys while composing
      }
      if (evt.key === "Escape") {
        // cancel without saving.
        el.dataset.cancelled = "1";
        this.stopEditing();
        return;
      }
      if (evt.key !== "Enter") {
        return;
      }
      // the parent textarea needs Ctrl/Cmd+Enter (a plain
      // Enter keeps its default newline insertion); the subtask input saves
      // on plain Enter.
      if (isParent && !(evt.ctrlKey || evt.metaKey)) {
        return;
      }
      el.dataset.saved = "1";
      this.saveNameEdit(row, el.value);
    });

    el.addEventListener("blur", () => {
      // auto-save on focus loss — unless Escape or Enter
      // already settled this edit session. Same flag decision order as

      if (el.dataset.cancelled === "1") {
        return;
      }
      if (el.dataset.saved === "1") {
        return;
      }
      // mid-composition focus loss: never commit a half-composed string.
      if (composing) {
        return;
      }
      this.saveNameEdit(row, el.value);
    });

    // autofocus and select-all on mount.
    el.focus();
    el.select();
    // The editor is not attached yet, so the focus above is a no-op in a
    // live DOM; re-apply once the caller has appended it (renderTable is
    // synchronous, so a microtask runs after attachment).
    queueMicrotask(() => {
      if (el.isConnected && document.activeElement !== el) {
        el.focus();
        el.select();
      }
    });
    return el;
  }








  private saveNameEdit(row: TaskRow, raw: string): void {
    const processed = raw.trim().replace(/\s+/g, " ");
    void this.savePatch(row, { displayName: processed, title: processed });
  }





















  private buildCurrentStatusEditor(row: TaskRow): HTMLTextAreaElement {
    const area = document.createElement("textarea");
    area.classList.add("task-workbench-inline-textarea");
    // row count from settings (DEFAULT_SETTINGS: 5).
    area.rows = this.host.settings.currentStatusRows;
    // empty currentStatus → empty field.
    area.value = row.currentStatus ?? "";

    // per-textarea flag — the user is dragging a text
    // selection inside the editor; the blur handler re-focuses instead of
    // interrupting the selection.
    let isPointerSelectingText = false;
    // IME composition state, mirrors the rich-popover
    // sibling's `composing` flag (task-gantt-view.ts buildCurrentStatusArea).
    let composing = false;
    area.addEventListener("compositionstart", () => {
      composing = true;
    });
    area.addEventListener("compositionend", () => {
      composing = false;
    });

    // All five listeners stop propagation into the table; dragstart is also
    // default-prevented. The pointerdown handler sets isPointerSelectingText,
    // and the blur handler checks that flag before saving. Without resetting
    // it, a routine click inside the textarea would leave the flag true for
    // the rest of the edit session. Later blurs would refocus the editor,
    // preventing the editor's plain-blur auto-save. Reset on pointerup/mouseup
    // without changing the blur-handler branch order.
    area.addEventListener("pointerup", () => {
      isPointerSelectingText = false;
    });
    area.addEventListener("mouseup", () => {
      isPointerSelectingText = false;
    });
    area.addEventListener("pointerdown", (evt) => {
      evt.stopPropagation();
      isPointerSelectingText = true;
    });
    area.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      isPointerSelectingText = true;
    });
    area.addEventListener("click", (evt) => evt.stopPropagation());
    area.addEventListener("dblclick", (evt) => evt.stopPropagation());
    area.addEventListener("dragstart", (evt) => {
      evt.stopPropagation();
      evt.preventDefault();
    });

    area.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
        // an IME composition is in progress — block the
        // commit entirely (no save, no dataset.saved flag, editing stays
        // open) rather than committing a still-being-composed string.
        if (composing) {
          return;
        }
        // Ctrl/Cmd+Enter saves and flags the intentional
        // exit so the ensuing blur does not save again.
        area.dataset.saved = "1";
        void this.savePatch(row, { currentStatus: area.value });
      } else if (evt.key === "Escape") {
        // cancel without saving.
        area.dataset.cancelled = "1";
        this.stopEditing();
      }
    });

    area.addEventListener("blur", () => {
      // EXACT decision order — do not reorder branches 1-4.
      if (area.dataset.cancelled === "1") {
        // (1) Escape already cancelled this session.
        return;
      }
      if (area.dataset.saved === "1") {
        // (2) Ctrl/Cmd+Enter already saved it.
        return;
      }
      if (isPointerSelectingText) {
        // (3) mid text-selection: re-focus after 80ms; do NOT save and do
        // NOT stop editing.
        setTimeout(() => area.focus(), 80);
        return;
      }
      // (3.5) mid-IME-composition focus loss — block the
      // auto-save (a half-composed string should never be committed) but do
      // NOT stop editing, so the user can resume/finish composing.
      if (composing) {
        return;
      }
      // (4) ordinary focus loss → auto-save.
      void this.savePatch(row, { currentStatus: area.value });
    });


    // name/tags), so no el.select here.
    area.focus();
    return area;
  }






  private buildTagsEditor(row: TaskRow): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.classList.add("task-workbench-inline-input");
    // the editing display joins with ", " — intentionally NOT

    input.value = (row.tags ?? []).join(", ");

    // keep pointer events inside the editor.
    input.addEventListener("click", (evt) => evt.stopPropagation());
    input.addEventListener("mousedown", (evt) => evt.stopPropagation());
    input.addEventListener("dragstart", (evt) => {
      evt.stopPropagation();
      evt.preventDefault();
    });

    const saveTags = (): void => {

      const tags = parseTagsInput(input.value);
      void this.savePatch(row, { tags });
    };

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {

        input.dataset.saved = "1";
        saveTags();
      } else if (evt.key === "Escape") {
        // cancel without saving.
        input.dataset.cancelled = "1";
        this.stopEditing();
      }
    });

    input.addEventListener("blur", () => {
      // auto-save on focus loss, guarded by the same flags as

      if (input.dataset.cancelled === "1") {
        return;
      }
      if (input.dataset.saved === "1") {
        return;
      }
      saveTags();
    });

    // autofocus and select-all on mount.
    input.focus();
    input.select();
    return input;
  }

  // --- Small DOM builders -------------------------------------------------

  private buildSelect(
    options: ReadonlyArray<readonly [string, string]>,
    currentValue: string,
    onChange: (value: string) => void
  ): HTMLSelectElement {
    const select = document.createElement("select");
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = currentValue;
    select.addEventListener("change", () => {
      onChange(select.value);
    });
    return select;
  }

  private buildCheckbox(
    labelClass: string,
    labelText: string,
    checked: boolean,
    onChange: (checked: boolean) => void
  ): HTMLLabelElement {
    const label = document.createElement("label");
    label.classList.add(labelClass);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.addEventListener("change", () => {
      onChange(checkbox.checked);
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(labelText));
    return label;
  }

  /** Icon-only toolbar button: Lucide icon with a Japanese label for assistive tech and tooltip. */
  private buildIconButton(
    icon: string,
    label: string,
    cssClasses: string[],
    onClick: () => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.classList.add(...cssClasses, "clickable-icon");
    button.setAttribute("aria-label", label);
    button.title = label;
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  private buildButton(
    text: string,
    cssClass: string | null,
    onClick: () => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = text;
    if (cssClass) {
      button.classList.add(cssClass);
    }
    button.addEventListener("click", onClick);
    return button;
  }
}

// Re-exported for host implementors (src/main.ts) so the wiring can type the
// getDisplayRows delegation without a second import site.
export type { DisplayRowsOptions };

export { getDisplayRows };
