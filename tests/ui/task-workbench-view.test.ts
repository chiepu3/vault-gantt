/* eslint-disable @typescript-eslint/no-explicit-any */









import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ViewStateService } from "../../src/app/view-state-service";
import { PreviewStore } from "../../src/app/preview-store";
import moment from "moment";
import { TaskWorkbenchView } from "../../src/ui/task-workbench-view";
import type { TaskWorkbenchViewHost } from "../../src/ui/task-workbench-view";
import { TaskFinderModal } from "../../src/ui/task-finder-modal";
import { getDisplayRows } from "../../src/app/workbench-display";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

import type { Logger } from "../../src/core/logger";

import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import {
  byClass,
  byTag,
  createFakeDocument,
  deepText,
  dispatch,
  makeFakeEl,
} from "../stubs/fake-dom";
import type { FakeEl } from "../stubs/fake-dom";


// Helpers


/** YYYY-MM-DD offset from today (keeps overdue/due-soon tests time-safe). */
function dateOffset(days: number): string {
  return moment().startOf("day").add(days, "days").format("YYYY-MM-DD");
}

function makeParent(overrides: Record<string, unknown> = {}): TaskRow {
  return {
    kind: "parent",
    id: "tasks/parent-1.md",
    file: { path: "tasks/parent-1.md" },
    title: "Parent One",
    displayName: "Parent One",
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-01 10:00:00",
    updatedAt: "2026-07-02 11:00:00",
    dueDate: "",
    priority: 2,
    priorityMode: "manual",
    currentStatus: "working on it",
    notes: "",
    tags: ["backend", "urgent"],
    ganttEnabled: false,
    subtasks: new Map<string, TaskRow>(),
    ...overrides,
  } as unknown as TaskRow;
}

/** Creates a subtask and registers it in parent.subtasks (the hierarchy正). */
function makeSubtask(
  parent: TaskRow,
  key: string,
  overrides: Record<string, unknown> = {}
): TaskRow {
  const sub = {
    kind: "subtask",
    id: `${parent.file.path}::${key}`,
    key,
    file: {
      path: `${parent.file.path}::${key}`,
      parentPath: parent.file.path,
      heading: key,
    },
    title: key,
    displayName: key,
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-03 09:00:00",
    updatedAt: "2026-07-04 09:00:00",
    dueDate: "",
    priority: 1,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ...overrides,
  } as unknown as TaskRow;
  (parent.subtasks as Map<string, TaskRow>).set(key, sub);
  return sub;
}

interface HostHarness {
  host: TaskWorkbenchViewHost;
  loadTasks: any;
  getDisplayRowsSpy: any;
  updateTaskItem: any;
  openTaskItem: any;
  createTaskInteractively: any;
  activateGanttView: any;
  undoLastAction: any;
  redoLastAction: any;
  settings: TaskWorkbenchSettings;
}

function makeHostHarness(
  tasks: TaskRow[],
  settingsOverrides: Record<string, unknown> = {}
): HostHarness {
  const settings = { ...DEFAULT_SETTINGS, ...settingsOverrides };
  const loadTasks = vi.fn(async () => tasks);
  const getDisplayRowsSpy = vi.fn((t: TaskRow[], opts: any) =>
    getDisplayRows(t, opts)
  );
  const updateTaskItem = vi.fn(async () => ({}));
  const openTaskItem = vi.fn(async () => undefined);
  const createTaskInteractively = vi.fn(async (onCreated: () => void) => {
    onCreated();
  });
  const activateGanttView = vi.fn(async () => undefined);
  const undoLastAction = vi.fn(async () => undefined);
  const redoLastAction = vi.fn(async () => undefined);
  const host: TaskWorkbenchViewHost = {

    logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,

    settings,
    loadTasks,
    getDisplayRows: getDisplayRowsSpy,
    updateTaskItem,
    openTaskItem,
    createTaskInteractively,
    activateGanttView,
    undoLastAction,
    redoLastAction,
  };
  return {
    host,
    loadTasks,
    getDisplayRowsSpy,
    updateTaskItem,
    openTaskItem,
    createTaskInteractively,
    activateGanttView,
    undoLastAction,
    redoLastAction,
    settings,
  };
}

/** Flushes microtasks so fire-and-forget async handlers settle. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function openView(
  tasks: TaskRow[],
  settingsOverrides: Record<string, unknown> = {},
  hostExtras: Record<string, unknown> = {}
): Promise<{ view: TaskWorkbenchView; container: FakeEl; h: HostHarness }> {
  const h = makeHostHarness(tasks, settingsOverrides);
  Object.assign(h.host, hostExtras);
  const view = new TaskWorkbenchView({} as any, h.host);
  const container = (view as any).containerEl as FakeEl;
  await view.onOpen();
  return { view, container, h };
}

function headerOf(container: FakeEl): FakeEl {
  return byClass(container, "task-workbench-header")[0];
}

function tableWrapOf(container: FakeEl): FakeEl {
  return byClass(container, "task-workbench-table-wrap")[0];
}

/** All <tr> rows in the table body (excludes the thead row). */
function bodyRows(container: FakeEl): FakeEl[] {
  const tbody = byTag(container, "tbody")[0];
  return tbody ? tbody.children.filter((c) => c.tagName === "TR") : [];
}

/** The 12 cells (<td>) of a body row, in column order. */
function cells(row: FakeEl): FakeEl[] {
  return row.children.filter((c) => c.tagName === "TD");
}

/** The header toolbar's three selects: [statusFilter, sortKey, sortDir]. */
function headerSelects(container: FakeEl): FakeEl[] {
  return byTag(headerOf(container), "select");
}

function optionsOf(select: FakeEl): FakeEl[] {
  return select.children.filter((c) => c.tagName === "OPTION");
}

function buttonByText(root: FakeEl, text: string): FakeEl {
  return byTag(root, "button").find((b) => b.textContent === text) as FakeEl;
}



describe("TaskWorkbenchView", () => {
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("window", makeFakeEl("window"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });





  it("registered view requests change real filters and unregister on close without saving", async () => {
    const previews = new PreviewStore({ reject: () => {}, repreview: async () => { throw new Error("unused"); } }), ui = new ViewStateService(previews);
    const { view, container, h } = await openView([makeParent({ id: "tasks/a.md", displayName: "Alpha" }), makeParent({ id: "tasks/b.md", displayName: "Beta" })], {}, { viewId: "workbench-live", viewStatePort: ui });
    expect(bodyRows(container)).toHaveLength(2);
    expect(await ui.request("V07", { viewId: "workbench-live", text: "Beta" })).toMatchObject({ status: "applied" });
    expect(bodyRows(container)).toHaveLength(1); expect(deepText(bodyRows(container)[0])).toContain("Beta"); expect(ui.inspectView("workbench-live")?.filterText).toBe("Beta"); expect(h.updateTaskItem).not.toHaveBeenCalled();
    await view.onClose(); expect(ui.inspectView("workbench-live")).toBeUndefined(); expect(await ui.request("V07", { viewId: "workbench-live", text: "Alpha" })).toMatchObject({ status: "unavailable" }); previews.dispose();
  });

  describe("identity and onOpen", () => {
    it("exposes view type, title and icon", () => {
      const h = makeHostHarness([]);
      const view = new TaskWorkbenchView({} as any, h.host);
      expect(view.getViewType()).toBe("task-workbench-view");
      expect(view.getDisplayText()).toBe("Task Workbench");
      expect(view.getIcon()).toBe("list-todo");
    });

    it("resets the container, builds header + table wrap and runs the initial render", async () => {
      const h = makeHostHarness([makeParent()]);
      const view = new TaskWorkbenchView({} as any, h.host);
      const container = (view as any).containerEl as FakeEl;
      // Existing container content must be cleared by onOpen.
      container.appendChild(makeFakeEl("section"));

      await view.onOpen();

      expect(container.classList.contains("task-workbench-container")).toBe(true);
      expect(container.children).toHaveLength(2);
      expect(container.children[0].classList.contains("task-workbench-header")).toBe(true);
      expect(container.children[1].classList.contains("task-workbench-table-wrap")).toBe(true);
      // The initial render happened.
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
      expect(byTag(container, "table")).toHaveLength(1);
    });

    it("initializes control state to defaults", async () => {
      // DEFAULT_SETTINGS.hideCompletedByDefault = true → completed hidden
      const { container } = await openView([]);

      const search = byClass(headerOf(container), "task-workbench-search")[0];
      expect(search.value).toBe("");

      const [statusSelect, sortKeySelect, sortDirSelect] = headerSelects(container);
      expect(statusSelect.value).toBe("all");
      expect(sortKeySelect.value).toBe("updatedAt");
      expect(sortDirSelect.value).toBe("desc");

      const flatLabel = byClass(headerOf(container), "task-workbench-flat-due-label")[0];
      expect(flatLabel.children[0].checked).toBe(false);
      const completedLabel = byClass(headerOf(container), "task-workbench-checkbox-label")[0];
      expect(completedLabel.children[0].checked).toBe(false);
    });

    it("shows completed rows by default when hideCompletedByDefault=false", async () => {
      const { container } = await openView([], { hideCompletedByDefault: false });
      const completedLabel = byClass(headerOf(container), "task-workbench-checkbox-label")[0];
      expect(completedLabel.children[0].checked).toBe(true);
    });

    it("starts with editing = null", async () => {
      const { view } = await openView([]);
      expect((view as any).editing).toBeNull();
    });
  });





  describe("header controls", () => {
    it("isolated filter input renders once synchronously", async () => {
      vi.useFakeTimers();
      const alpha = makeParent({ id: "tasks/a.md", displayName: "Alpha Task", updatedAt: "2026-07-10" });
      const beta = makeParent({ id: "tasks/b.md", displayName: "Beta Task", updatedAt: "2026-07-11" });
      const { container, view, h } = await openView([alpha, beta]);
      const renderTableSpy = vi.spyOn(view as any, "renderTable");

      const search = byClass(headerOf(container), "task-workbench-search")[0];
      expect(search.placeholder).toBe("フィルター...");

      search.value = "alpha";
      dispatch(search, "input");

      expect(renderTableSpy).toHaveBeenCalledTimes(1);
      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ filterText: "alpha" })
      );
      expect(bodyRows(container)).toHaveLength(1);
      expect(deepText(cells(bodyRows(container)[0])[0])).toContain("Alpha Task");

      vi.advanceTimersByTime(200);
      expect(renderTableSpy).toHaveBeenCalledTimes(1);
    });

    it("rapid filter input renders leading and trailing edges only", async () => {
      vi.useFakeTimers();
      const alpha = makeParent({ id: "tasks/a.md", displayName: "Alpha Task", updatedAt: "2026-07-10" });
      const beta = makeParent({ id: "tasks/b.md", displayName: "Beta Task", updatedAt: "2026-07-11" });
      const { container, view, h } = await openView([alpha, beta]);
      const renderTableSpy = vi.spyOn(view as any, "renderTable");
      const search = byClass(headerOf(container), "task-workbench-search")[0];

      for (const value of ["a", "al", "alp", "alph", "alpha"]) {
        search.value = value;
        dispatch(search, "input");
      }

      expect(renderTableSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(199);
      expect(renderTableSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);

      expect(renderTableSpy).toHaveBeenCalledTimes(2);
      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ filterText: "alpha" })
      );
      expect(bodyRows(container)).toHaveLength(1);
      expect(deepText(cells(bodyRows(container)[0])[0])).toContain("Alpha Task");
    });

    it("does not lead-render during IME composition", async () => {
      vi.useFakeTimers();
      const { container, view } = await openView([makeParent()]);
      const renderTableSpy = vi.spyOn(view as any, "renderTable");
      const search = byClass(headerOf(container), "task-workbench-search")[0];

      dispatch(search, "compositionstart");
      search.value = "親";
      dispatch(search, "input");
      expect(renderTableSpy).not.toHaveBeenCalled();

      dispatch(search, "compositionend");
      expect(renderTableSpy).toHaveBeenCalledTimes(1);
    });

    it("flushes a changed trailing filter render on blur", async () => {
      vi.useFakeTimers();
      const { container, view } = await openView([makeParent()]);
      const renderTableSpy = vi.spyOn(view as any, "renderTable");
      const search = byClass(headerOf(container), "task-workbench-search")[0];

      search.value = "P";
      dispatch(search, "input");
      search.value = "Parent";
      dispatch(search, "input");
      dispatch(search, "blur");

      expect(renderTableSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(200);
      expect(renderTableSpy).toHaveBeenCalledTimes(2);
    });

    it("cancels the pending trailing filter render when the view closes", async () => {
      vi.useFakeTimers();
      const { container, view } = await openView([makeParent()]);
      const renderTableSpy = vi.spyOn(view as any, "renderTable");
      const search = byClass(headerOf(container), "task-workbench-search")[0];

      search.value = "P";
      dispatch(search, "input");
      search.value = "Parent";
      dispatch(search, "input");
      await view.onClose();
      vi.advanceTimersByTime(200);

      expect(renderTableSpy).toHaveBeenCalledTimes(1);
    });

    it("status filter has the 6 options and re-renders on change", async () => {
      const active = makeParent({ id: "tasks/a.md", displayName: "Active Task", statusLabel: "active" });
      const inProgress = makeParent({ id: "tasks/b.md", displayName: "Running Task", statusLabel: "in_progress" });
      const { container, h } = await openView([active, inProgress]);

      const statusSelect = headerSelects(container)[0];
      const options = optionsOf(statusSelect);
      expect(options.map((o) => o.value)).toEqual([
        "all",
        "active",
        "in_progress",
        "waiting",
        "hold",
        "done",
      ]);
      expect(options.map((o) => o.textContent)).toEqual([
        "すべてのステータス",
        "未着手",
        "進行中",
        "待ち",
        "保留",
        "完了",
      ]);

      statusSelect.value = "in_progress";
      dispatch(statusSelect, "change");

      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ statusFilter: "in_progress" })
      );
      const rows = bodyRows(container);
      expect(rows).toHaveLength(1);
      expect(deepText(cells(rows[0])[0])).toContain("Running Task");
    });

    it("sort key dropdown has the 5 options and sorts immediately", async () => {
      const alpha = makeParent({ id: "tasks/a.md", title: "Alpha", displayName: "Alpha", updatedAt: "2026-07-10" });
      const beta = makeParent({ id: "tasks/b.md", title: "Beta", displayName: "Beta", updatedAt: "2026-07-11" });
      const { container, h } = await openView([alpha, beta]);

      const sortKeySelect = headerSelects(container)[1];
      expect(optionsOf(sortKeySelect).map((o) => o.value)).toEqual([
        "dueDate",
        "updatedAt",
        "createdAt",
        "title",
        "statusLabel",
      ]);
      expect(optionsOf(sortKeySelect).map((o) => o.textContent)).toEqual([
        "期限順",
        "更新日順",
        "作成日順",
        "タスク名順",
        "ステータス順",
      ]);

      // default state is passed through to getDisplayRows unchanged
      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ sortKey: "updatedAt", sortDir: "desc" })
      );

      sortKeySelect.value = "title";
      dispatch(sortKeySelect, "change");

      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ sortKey: "title", sortDir: "desc" })
      );
      // title desc (reverse locale order) → Beta first
      expect(deepText(cells(bodyRows(container)[0])[0])).toContain("Beta");
    });

    it("sort direction dropdown flips the order", async () => {
      const alpha = makeParent({ id: "tasks/a.md", title: "Alpha", displayName: "Alpha" });
      const beta = makeParent({ id: "tasks/b.md", title: "Beta", displayName: "Beta" });
      const { container, h } = await openView([alpha, beta]);

      const sortDirSelect = headerSelects(container)[2];
      expect(optionsOf(sortDirSelect).map((o) => o.value)).toEqual(["asc", "desc"]);
      expect(optionsOf(sortDirSelect).map((o) => o.textContent)).toEqual(["昇順", "降順"]);

      // switch to title ascending for a deterministic check
      headerSelects(container)[1].value = "title";
      dispatch(headerSelects(container)[1], "change");
      sortDirSelect.value = "asc";
      dispatch(sortDirSelect, "change");

      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ sortDir: "asc" })
      );
      const rows = bodyRows(container);
      expect(deepText(cells(rows[0])[0])).toContain("Alpha");
      expect(deepText(cells(rows[1])[0])).toContain("Beta");
    });

    it("flat due-sort checkbox flattens the hierarchy", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child-task");
      const { container, h } = await openView([parent]);

      const flatLabel = byClass(headerOf(container), "task-workbench-flat-due-label")[0];
      expect(deepText(flatLabel)).toBe("サブタスク含めた期限順");
      const checkbox = flatLabel.children[0];
      expect(checkbox.checked).toBe(false);

      // hierarchy mode: subtask indented, collapse toggle present
      expect(byClass(container, "task-indent")).toHaveLength(1);
      expect(byClass(container, "twb-collapse-toggle")).toHaveLength(1);

      const findSpy = vi.spyOn(Array.prototype, "find");
      checkbox.checked = true;
      dispatch(checkbox, "change");
      // The flat-mode prefix uses the render-pass Map, so it must not scan
      // the task array once per subtask row.
      expect(findSpy).not.toHaveBeenCalled();


      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ flatDueSort: true })
      );
      // Flat mode shows neither a collapse toggle nor indentation.
      expect(byClass(container, "twb-collapse-toggle")).toHaveLength(0);
      expect(byClass(container, "task-indent")).toHaveLength(0);
      // Subtask rows include the parent prefix.
      const prefix = byClass(container, "task-workbench-parent-prefix")[0];
      expect(prefix.textContent).toBe("Parent One / ");
    });

    it("show-completed checkbox toggles completed tasks", async () => {
      const open = makeParent({ id: "tasks/open.md", displayName: "Open" });
      const done = makeParent({ id: "tasks/done.md", displayName: "Done", completed: true });
      const { container, h } = await openView([open, done]);

      // hidden by default (hideCompletedByDefault=true)
      expect(bodyRows(container)).toHaveLength(1);

      const completedLabel = byClass(headerOf(container), "task-workbench-checkbox-label")[0];
      expect(deepText(completedLabel)).toBe("完了も表示");
      completedLabel.children[0].checked = true;
      dispatch(completedLabel.children[0], "change");

      expect(h.getDisplayRowsSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ showCompleted: true })
      );
      expect(bodyRows(container)).toHaveLength(2);
    });

    it("「ガント」 button activates the gantt view", async () => {
      const { container, h } = await openView([]);
      dispatch(buttonByText(container, "ガント"), "click");
      expect(h.activateGanttView).toHaveBeenCalledTimes(1);
    });

    it("「新規タスク」 is CTA-styled and re-renders after creation", async () => {
      const { container, h } = await openView([makeParent()]);

      const button = buttonByText(container, "新規タスク");
      expect(button.classList.contains("mod-cta")).toBe(true);

      expect(h.loadTasks).toHaveBeenCalledTimes(1);
      dispatch(button, "click");
      await flush();

      expect(h.createTaskInteractively).toHaveBeenCalledTimes(1);
      // the onCreated callback passed to the host triggers a full reload
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });

    it("「更新」 fully reloads the task list", async () => {
      const { container, h } = await openView([makeParent()]);
      expect(h.loadTasks).toHaveBeenCalledTimes(1);

      dispatch(buttonByText(container, "更新"), "click");
      await flush();

      expect(h.loadTasks).toHaveBeenCalledTimes(2);
      expect(bodyRows(container)).toHaveLength(1);
    });

    it("routes history keys only while focused in the view and removes listeners on close", async () => {
      const { view, container, h } = await openView([]);
      const stopImmediatePropagation = vi.fn();
      dispatch(container, "keydown", { target: container, key: "z", ctrlKey: true, stopImmediatePropagation });
      dispatch(container, "keydown", { target: container, key: "Z", ctrlKey: true, shiftKey: true, stopImmediatePropagation });
      dispatch(container, "keydown", { target: container, key: "y", ctrlKey: true, stopImmediatePropagation });
      expect(h.undoLastAction).toHaveBeenCalledTimes(1);
      expect(h.redoLastAction).toHaveBeenCalledTimes(2);
      expect(stopImmediatePropagation).toHaveBeenCalledTimes(3);
      const input = makeFakeEl("input"); container.appendChild(input);
      for (const shortcut of [{ key: "z" }, { key: "Z", shiftKey: true }, { key: "y" }]) {
        const event = dispatch(container, "keydown", { target: input, ctrlKey: true, stopImmediatePropagation, ...shortcut });
        expect(event.__defaultPrevented).toBeUndefined();
      }
      expect(h.undoLastAction).toHaveBeenCalledTimes(1);
      expect(h.redoLastAction).toHaveBeenCalledTimes(2);
      expect(stopImmediatePropagation).toHaveBeenCalledTimes(3);
      await view.onClose();
      dispatch(container, "keydown", { target: container, key: "z", ctrlKey: true, stopImmediatePropagation });
      expect(h.undoLastAction).toHaveBeenCalledTimes(1);
    });

    it("Undo/Redo buttons delegate to their host actions", async () => {
      const { container, h } = await openView([]);

      dispatch(byClass(container, "task-workbench-undo")[0], "click");
      dispatch(byClass(container, "task-workbench-redo")[0], "click");

      expect(h.undoLastAction).toHaveBeenCalledTimes(1);
      expect(h.redoLastAction).toHaveBeenCalledTimes(1);
    });

    it("「タスク検索」 opens the TaskFinderModal over flattened items", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child-a");
      makeSubtask(parent, "child-b");
      const { container } = await openView([parent]);

      const openSpy = vi
        .spyOn(TaskFinderModal.prototype, "open")
        .mockImplementation(() => undefined);

      dispatch(buttonByText(container, "タスク検索"), "click");

      expect(openSpy.mock.instances).toHaveLength(1);
      const openedModal = openSpy.mock.instances[0] as any;
      // 1 parent + 2 subtasks flattened
      expect(openedModal.filtered).toHaveLength(3);
    });
  });





  describe("render flow", () => {
    it("render() loads tasks, stores them and rebuilds header + table", async () => {
      const tasks = [makeParent()];
      const { view, container, h } = await openView(tasks);

      expect(h.loadTasks).toHaveBeenCalledTimes(1);
      expect((view as any).tasks).toEqual(tasks);
      expect(byClass(container, "task-workbench-header")).toHaveLength(1);
      expect(byTag(container, "table")).toHaveLength(1);
    });

    it("each renderTable empties the wrapper and builds a fresh table", async () => {
      const { view, container } = await openView([makeParent()]);
      const wrap = tableWrapOf(container);
      const firstTable = byTag(wrap, "table")[0];

      await view.render();

      const tables = byTag(wrap, "table");
      expect(tables).toHaveLength(1);
      expect(tables[0]).not.toBe(firstTable); // brand-new element
    });

    it("preserves control state across 「更新」 re-renders", async () => {
      vi.useFakeTimers();
      const alpha = makeParent({ id: "tasks/a.md", displayName: "Alpha" });
      makeParent({ id: "tasks/b.md", displayName: "Beta" });
      const { container } = await openView([alpha]);

      const search = byClass(headerOf(container), "task-workbench-search")[0];
      search.value = "alpha";
      dispatch(search, "input");
      vi.advanceTimersByTime(200);
      expect(bodyRows(container)).toHaveLength(1);

      dispatch(buttonByText(container, "更新"), "click");
      await flush();

      // header rebuilt from state: filter text kept
      const rebuilt = byClass(headerOf(container), "task-workbench-search")[0];
      expect(rebuilt.value).toBe("alpha");
      expect(bodyRows(container)).toHaveLength(1);
    });
  });





  describe("table structure", () => {
    it("renders a task-workbench-table with the fixed 12-column header", async () => {
      const { container } = await openView([makeParent()]);
      const table = byTag(container, "table")[0];
      expect(table.classList.contains("task-workbench-table")).toBe(true);

      const ths = byTag(container, "thead")[0].children[0].children;
      expect(ths.map((th: FakeEl) => th.textContent)).toEqual([
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
      ]);
    });

    it("parent rows are bold with gantt checkbox and + button", async () => {
      const { container } = await openView([makeParent()]);
      const row = bodyRows(container)[0];

      expect(row.classList.contains("task-workbench-row")).toBe(true);
      expect(row.classList.contains("is-subtask")).toBe(false);

      const tds = cells(row);
      expect(tds).toHaveLength(12);
      // The parent name is rendered in a strong-parent span.
      expect(byClass(tds[0], "strong-parent")[0].textContent).toBe("Parent One");
      // The Gantt checkbox is present.
      expect(byTag(tds[9], "input")).toHaveLength(1);
      // The add button is present.
      expect(byTag(tds[11], "button")[0].textContent).toBe("+");
      // tags column
      expect(tds[7].textContent).toBe("backend, urgent");
    });

    it("subtask rows are marked, indented under the parent, with empty gantt/+ cells", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child-task");
      const { container } = await openView([parent]);

      const rows = bodyRows(container);
      expect(rows).toHaveLength(2);
      // The child row appears directly below its parent.
      expect(rows[1].classList.contains("is-subtask")).toBe(true);

      const nameCell = cells(rows[1])[0];
      // The child row is indented in hierarchy mode.
      expect(byClass(nameCell, "task-indent")).toHaveLength(1);
      // Subtask names do not use the bold parent-name style.
      expect(byClass(nameCell, "strong-parent")).toHaveLength(0);
      expect(deepText(nameCell)).toContain("child-task");

      // The Gantt and add-action cells are empty for subtasks.
      const tds = cells(rows[1]);
      expect(tds[9].children).toHaveLength(0);
      expect(tds[11].children).toHaveLength(0);
    });

    it("marks completed rows with the is-completed class", async () => {
      const done = makeParent({ id: "tasks/done.md", completed: true });
      const open = makeParent({ id: "tasks/open.md", completed: false });
      // showCompleted starts as !hideCompletedByDefault — set it false so
      // the completed row isn't filtered out of the table before we can
      // check its class.
      const { container } = await openView([done, open], {
        hideCompletedByDefault: false,
      });
      const rows = bodyRows(container);
      expect(rows[0].classList.contains("is-completed")).toBe(true);
      expect(rows[1].classList.contains("is-completed")).toBe(false);
    });

    it("marks overdue rows as overdue rather than due soon", async () => {
      const overdue = makeParent({ id: "tasks/old.md", dueDate: dateOffset(-1) });
      const { container } = await openView([overdue]);
      const row = bodyRows(container)[0];
      expect(row.classList.contains("twb-overdue-row")).toBe(true);
      expect(row.classList.contains("twb-due-soon-row")).toBe(false);
    });

    it("due-soon rows cover today through today+3, but not today+4", async () => {
      const today = makeParent({ id: "tasks/t0.md", dueDate: dateOffset(0) });
      const plus3 = makeParent({ id: "tasks/t3.md", dueDate: dateOffset(3) });
      const plus4 = makeParent({ id: "tasks/t4.md", dueDate: dateOffset(4) });
      const { container } = await openView([today, plus3, plus4]);

      // rows share display settings — identify each by its date input value
      const dueValues = bodyRows(container).map(
        (r) => byTag(cells(r)[6], "input")[0].value
      );
      expect(dueValues.sort()).toEqual(
        [dateOffset(0), dateOffset(3), dateOffset(4)].sort()
      );

      for (const row of bodyRows(container)) {
        const due = byTag(cells(row)[6], "input")[0].value;
        if (due === dateOffset(0) || due === dateOffset(3)) {
          expect(row.classList.contains("twb-due-soon-row")).toBe(true);
          expect(row.classList.contains("twb-overdue-row")).toBe(false);
        } else {
          expect(row.classList.contains("twb-due-soon-row")).toBe(false);
          expect(row.classList.contains("twb-overdue-row")).toBe(false);
        }
      }
    });

    it("zero rows show the empty message under an empty tbody", async () => {
      const { container } = await openView([]);
      expect(bodyRows(container)).toHaveLength(0);
      const empty = byClass(container, "task-workbench-empty")[0];
      expect(empty.textContent).toBe("条件に一致するタスクがありません。");
      // the message lives in the table wrap, outside the table itself
      expect(empty.parentNode).toBe(tableWrapOf(container));
    });
  });





  describe("empty and missing data", () => {

    it("empty displayName+title inserts an empty span", async () => {
      const nameless = makeParent({ displayName: "", title: "" });
      const { container } = await openView([nameless]);
      const nameCell = cells(bodyRows(container)[0])[0];
      const spans = byTag(nameCell, "span");
      expect(spans.some((s) => s.textContent === "")).toBe(true);
      expect(deepText(nameCell)).toBe("");
    });

    it("empty createdAt/updatedAt render as empty text", async () => {
      const row = makeParent({ createdAt: "", updatedAt: "" });
      const { container } = await openView([row]);
      const tds = cells(bodyRows(container)[0]);
      expect(tds[4].textContent).toBe(""); // 作成日
      expect(tds[5].textContent).toBe(""); // 更新日
    });

    it("empty dueDate leaves the date input blank with no state classes", async () => {
      const { container } = await openView([makeParent({ dueDate: "" })]);
      const input = byTag(cells(bodyRows(container)[0])[6], "input")[0];
      expect(input.value).toBe("");
      expect(input.classList.contains("is-overdue")).toBe(false);
      expect(input.classList.contains("is-today")).toBe(false);
    });

    it("undefined tags fall back to empty text", async () => {
      const { container } = await openView([makeParent({ tags: undefined })]);
      expect(cells(bodyRows(container)[0])[7].textContent).toBe("");
    });

    it("empty currentStatus renders as empty text", async () => {
      const { container } = await openView([makeParent({ currentStatus: "" })]);
      const tds = cells(bodyRows(container)[0]);
      expect(tds[3].classList.contains("task-workbench-col-status")).toBe(true);
      expect(deepText(tds[3])).toBe("");
    });
  });





  describe("priority stars", () => {
    function starButtons(container: FakeEl): FakeEl[] {
      const wrap = byClass(container, "task-workbench-priority-stars")[0];
      return wrap.children.filter(
        (c) => c.tagName === "BUTTON" && c.classList.contains("task-workbench-priority-star")
      );
    }

    it("builds the priority cell with 5 stars and a ↺ reset", async () => {
      const { container } = await openView([makeParent()]);
      const cell = cells(bodyRows(container)[0])[1];
      expect(cell.classList.contains("task-workbench-priority-cell")).toBe(true);
      const stars = starButtons(container);
      expect(stars).toHaveLength(5);
      const wrap = byClass(container, "task-workbench-priority-stars")[0];
      expect(wrap.getAttribute("aria-label")).toBe("優先度 2 手動");
      expect(stars[0].getAttribute("title")).toBe("1 / 5 (手動設定)");
      expect(stars[4].getAttribute("title")).toBe("5 / 5 (手動設定)");
      const reset = byClass(container, "task-workbench-priority-reset")[0];
      expect(reset.textContent).toBe("↺");
      expect(reset.getAttribute("title")).toBe(
        "手動優先度を解除して自動計算に戻す"
      );
    });

    it("manual mode fills 1..N stars and tags them priority-manual", async () => {
      const { container } = await openView([
        makeParent({ priority: 3, priorityMode: "manual" }),
      ]);
      const stars = starButtons(container);
      expect(stars.map((s) => s.textContent)).toEqual(["★", "★", "★", "☆", "☆"]);
      for (const star of stars) {
        expect(star.classList.contains("priority-manual")).toBe(true);
        expect(star.classList.contains("priority-auto")).toBe(false);
      }
    });

    it("invalid priorityMode values normalize to auto", async () => {
      const { container } = await openView([
        makeParent({ priority: 1, priorityMode: "bogus", dueDate: "" }),
      ]);
      const stars = starButtons(container);
      // auto mode + empty dueDate → calculateAutoPriority = 0 → all empty
      expect(stars.map((s) => s.textContent)).toEqual(["☆", "☆", "☆", "☆", "☆"]);
      for (const star of stars) {
        expect(star.classList.contains("priority-auto")).toBe(true);
      }
    });

    it("out-of-range priorities clamp to all stars or no stars", async () => {
      const high = makeParent({ id: "tasks/h.md", priority: 10, priorityMode: "manual" });
      const low = makeParent({ id: "tasks/l.md", priority: -1, priorityMode: "manual" });
      const { container } = await openView([high, low]);

      const [rowHigh, rowLow] = bodyRows(container);
      const starsOf = (row: FakeEl) =>
        byClass(cells(row)[1], "task-workbench-priority-star").map((s) => s.textContent);
      expect(starsOf(rowHigh)).toEqual(["★", "★", "★", "★", "★"]);
      expect(starsOf(rowLow)).toEqual(["☆", "☆", "☆", "☆", "☆"]);
    });

    it("clicking a different star in manual mode saves a manual priority and fully re-renders", async () => {
      const { container, h } = await openView([
        makeParent({ priority: 2, priorityMode: "manual" }),
      ]);
      expect(h.loadTasks).toHaveBeenCalledTimes(1);

      const evt = dispatch(starButtons(container)[3], "click"); // star 4
      await flush();

      expect(evt.__propagationStopped).toBe(true);
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        priority: 4,
        priorityMode: "manual",
      });
      // Saving triggers a full render.
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });

    it("re-clicking the current manual star returns to auto mode", async () => {
      // empty dueDate → calculateAutoPriority("") = 0
      const { container, h } = await openView([
        makeParent({ priority: 2, priorityMode: "manual", dueDate: "" }),
      ]);

      dispatch(starButtons(container)[1], "click"); // star 2 == current
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        priority: 0,
        priorityMode: "auto",
      });
    });

    it("clicking any star in auto mode sets a manual priority", async () => {
      const { container, h } = await openView([
        makeParent({ priority: 0, priorityMode: "auto" }),
      ]);

      dispatch(starButtons(container)[4], "click"); // star 5
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        priority: 5,
        priorityMode: "manual",
      });
    });

    it("uses manual styling and returns to auto when auto priority is disabled", async () => {
      const { container, h } = await openView(
        [makeParent({ priority: 2, priorityMode: "auto", dueDate: "" })],
        { autoPriorityEnabled: false }
      );
      const stars = starButtons(container);
      const wrap = byClass(container, "task-workbench-priority-stars")[0];

      expect(wrap.getAttribute("aria-label")).toBe("優先度 2 手動");
      for (const star of stars) {
        expect(star.classList.contains("priority-manual")).toBe(true);
        expect(star.classList.contains("priority-auto")).toBe(false);
      }

      dispatch(stars[1], "click"); // star 2 == current effective priority
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        priority: 0,
        priorityMode: "auto",
      });
    });

    it("reset restores the auto-calculated priority", async () => {
      const { container, h } = await openView([
        makeParent({ priority: 4, priorityMode: "manual", dueDate: dateOffset(-1) }),
      ]);

      dispatch(byClass(container, "task-workbench-priority-reset")[0], "click");
      await flush();

      // overdue → calculateAutoPriority = 5
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        priority: 5,
        priorityMode: "auto",
      });
    });
  });





  describe("status select cell", () => {
    it("saves statusLabel on change and stops click propagation", async () => {
      const { container, h } = await openView([makeParent({ statusLabel: "active" })]);
      const select = byClass(container, "task-workbench-inline-select")[0];

      expect(optionsOf(select).map((o) => o.textContent)).toEqual([
        "未着手",
        "進行中",
        "待ち",
        "保留",
        "完了",
      ]);
      expect(select.value).toBe("active");

      const clickEvt = dispatch(select, "click");
      expect(clickEvt.__propagationStopped).toBe(true);
      expect(h.updateTaskItem).not.toHaveBeenCalled();

      select.value = "hold";
      dispatch(select, "change");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ statusLabel: "hold" });
      expect(h.loadTasks).toHaveBeenCalledTimes(2); // re-render
    });

    it("unsupported status values leave the select unmatched and silent", async () => {
      const { container } = await openView([makeParent({ statusLabel: "weird" })]);
      const select = byClass(container, "task-workbench-inline-select")[0];
      // fake DOM stores the raw value; no option carries it
      expect(select.value).toBe("weird");
      expect(optionsOf(select).map((o) => o.value)).not.toContain("weird");
    });
  });





  describe("due date cell", () => {
    it("renders a compact date input with overdue/today classes", async () => {
      const overdue = makeParent({ id: "tasks/a.md", dueDate: dateOffset(-2) });
      const today = makeParent({ id: "tasks/b.md", dueDate: dateOffset(0) });
      const { container } = await openView([overdue, today]);

      const inputs = byTag(container, "input").filter((i) => i.type === "date");
      expect(inputs).toHaveLength(2);
      for (const input of inputs) {
        expect(input.classList.contains("task-workbench-inline-input")).toBe(true);
        expect(input.classList.contains("compact-date")).toBe(true);
      }
      const byValue = (v: string) => inputs.find((i) => i.value === v) as FakeEl;
      expect(byValue(dateOffset(-2)).classList.contains("is-overdue")).toBe(true);
      expect(byValue(dateOffset(0)).classList.contains("is-today")).toBe(true);
    });

    it("saves dueDate on change and stops click propagation", async () => {
      const { container, h } = await openView([makeParent({ dueDate: "" })]);
      const input = byTag(cells(bodyRows(container)[0])[6], "input")[0];

      const clickEvt = dispatch(input, "click");
      expect(clickEvt.__propagationStopped).toBe(true);

      input.value = dateOffset(5);
      dispatch(input, "change");
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ dueDate: dateOffset(5) });
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });
  });





  describe("completed and gantt checkboxes", () => {
    it("completed checkbox persists state and stops propagation", async () => {
      const { container, h } = await openView([makeParent({ completed: false })]);
      const tds = cells(bodyRows(container)[0]);
      expect(tds[8].classList.contains("tiny-col")).toBe(true);
      const checkbox = byTag(tds[8], "input")[0];
      expect(checkbox.type).toBe("checkbox");
      expect(checkbox.checked).toBe(false);

      const clickEvt = dispatch(checkbox, "click");
      expect(clickEvt.__propagationStopped).toBe(true);
      expect(h.updateTaskItem).not.toHaveBeenCalled();

      checkbox.checked = true;
      dispatch(checkbox, "change");
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ completed: true });
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });

    it("gantt checkbox keeps a finite stored ganttOrder", async () => {
      const { container, h } = await openView([
        makeParent({ ganttEnabled: true, ganttOrder: 12345 }),
      ]);
      const checkbox = byTag(cells(bodyRows(container)[0])[9], "input")[0];
      expect(checkbox.checked).toBe(true);

      checkbox.checked = false;
      dispatch(checkbox, "change");
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        ganttEnabled: false,
        ganttOrder: 12345,
      });
    });

    it("first enable stamps the current unix time when ganttOrder is missing", async () => {
      const before = Date.now();
      const { container, h } = await openView([
        makeParent({ ganttEnabled: false, ganttOrder: undefined }),
      ]);
      const checkbox = byTag(cells(bodyRows(container)[0])[9], "input")[0];

      checkbox.checked = true;
      dispatch(checkbox, "change");
      await flush();

      const patch = h.updateTaskItem.mock.calls[0][1];
      expect(patch.ganttEnabled).toBe(true);
      expect(Number.isFinite(patch.ganttOrder)).toBe(true);
      expect(patch.ganttOrder).toBeGreaterThanOrEqual(before);
    });

    it("subtask rows have empty completed-gantt and + cells", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child");
      const { container } = await openView([parent]);
      const subtaskRow = bodyRows(container)[1];
      const tds = cells(subtaskRow);
      expect(tds[9].children).toHaveLength(0); // Ganttで管理
      expect(tds[11].children).toHaveLength(0);
    });
  });





  describe("open and add buttons", () => {
    it("「開」 opens the task through the host and stops propagation", async () => {
      const parent = makeParent();
      const { container, h } = await openView([parent]);
      const tds = cells(bodyRows(container)[0]);
      expect(tds[10].classList.contains("tiny-col")).toBe(true);
      const button = byTag(tds[10], "button")[0];
      expect(button.textContent).toBe("開");

      const evt = dispatch(button, "click");
      await flush();

      expect(evt.__propagationStopped).toBe(true);
      expect(h.openTaskItem).toHaveBeenCalledTimes(1);
      // hierarchy mode passes the collapse-decorated shallow copy, not the
      // original reference — identify by task id
      expect(h.openTaskItem.mock.calls[0][0].id).toBe(parent.id);
    });

    it("「+」 exists only on parent rows", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child");
      const { container } = await openView([parent]);
      const [parentRow, subtaskRow] = bodyRows(container);
      expect(byTag(cells(parentRow)[11], "button")[0].textContent).toBe("+");
      expect(cells(subtaskRow)[11].children).toHaveLength(0);
    });

    it("「+」 delegates to host.addSubtaskInteractively and re-renders via its callback", async () => {
      const parent = makeParent();
      const addSubtaskInteractively = vi.fn<
        (row: TaskRow, onCreated: () => void) => Promise<void>
      >();
      const { container, h } = await openView([parent], {}, { addSubtaskInteractively });

      const button = byTag(cells(bodyRows(container)[0])[11], "button")[0];
      dispatch(button, "click");
      await flush();

      expect(addSubtaskInteractively).toHaveBeenCalledTimes(1);
      // collapse-decorated copy — identify by task id
      expect(addSubtaskInteractively.mock.calls[0][0].id).toBe(parent.id);
      expect(typeof addSubtaskInteractively.mock.calls[0][1]).toBe("function");

      expect(h.loadTasks).toHaveBeenCalledTimes(1);
      addSubtaskInteractively.mock.calls[0][1](); // onCreated
      await flush();
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });

    it("GAP: without host support the 「+」 button warns instead of faking success", async () => {
      const parent = makeParent();
      const { container, h } = await openView([parent]);

      dispatch(byTag(cells(bodyRows(container)[0])[11], "button")[0], "click");
      await flush();

      expect(h.host.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.host.logger.warn).toHaveBeenCalledWith(
        "TaskWorkbenchView",
        expect.stringContaining("addSubtaskInteractively"),
        parent.id
      );
    });
  });





  describe("parent/child collapsing", () => {
  // edge-case net coverage for collapse state combinations
    /** Parent with three incomplete children; "mid" has the nearest due date. */
    function collapseFixture(): { parent: TaskRow } {
      const parent = makeParent({ displayName: "ProjA" });
      makeSubtask(parent, "far", { dueDate: dateOffset(9) });
      makeSubtask(parent, "mid", { dueDate: dateOffset(2) });
      makeSubtask(parent, "later", { dueDate: dateOffset(5) });
      return { parent };
    }

    it("initial parents with children show a collapsed ▸ toggle with aria-label", async () => {
      const { container } = await openView([collapseFixture().parent]);
      const toggle = byClass(container, "twb-collapse-toggle")[0];

      const nameWrap = byClass(cells(bodyRows(container)[0])[0], "task-workbench-cell-text")[0];
      expect(toggle.parentNode).toBe(nameWrap);
      expect(nameWrap.children[0]).toBe(toggle);

      expect(toggle.textContent).toBe("▸");
      expect(toggle.getAttribute("aria-label")).toBe("子タスクを展開（3件中 1件表示）");
      expect(toggle.title).toBe("子タスクを展開（3件中 1件表示）");
    });

    it("childless parents get no toggle", async () => {
      const { container } = await openView([makeParent()]);
      expect(byClass(container, "twb-collapse-toggle")).toHaveLength(0);
    });

    it("initial parents show a preview, then explicit toggles expand and collapse", async () => {
      const { container } = await openView([collapseFixture().parent]);
      expect(bodyRows(container)).toHaveLength(2); // parent + 1 preview
      expect(deepText(cells(bodyRows(container)[1])[0])).toContain("mid");

      // The first explicit toggle expands the initial preview.
      dispatch(byClass(container, "twb-collapse-toggle")[0], "click");

      let rows = bodyRows(container);
      expect(rows).toHaveLength(4); // parent + 3 children
      expect(byClass(container, "twb-collapse-summary")).toHaveLength(0);
      let toggle = byClass(container, "twb-collapse-toggle")[0];
      expect(toggle.textContent).toBe("▾");
      expect(toggle.getAttribute("aria-label")).toBe("子タスクを折りたたむ（3件）");

      // The second explicit toggle collapses back to the preview child.
      dispatch(toggle, "click");

      rows = bodyRows(container);
      expect(rows).toHaveLength(2); // parent + 1 preview
      // The preview is the nearest-due incomplete child ("mid").
      expect(deepText(cells(rows[1])[0])).toContain("mid");
      expect(rows[1].classList.contains("twb-collapsed-preview-row")).toBe(true);

      // The collapsed state uses the expected glyph and aria label.
      toggle = byClass(container, "twb-collapse-toggle")[0];
      expect(toggle.textContent).toBe("▸");
      expect(toggle.getAttribute("aria-label")).toBe("子タスクを展開（3件中 1件表示）");


      const summary = byClass(container, "twb-collapse-summary")[0];
      expect(summary.textContent).toBe(" 他2件");
      // cell text includes the ▸ toggle glyph before the name
      expect(deepText(cells(rows[0])[0])).toContain("ProjA 他2件");
    });

    it("fold state survives filter changes within the same view instance", async () => {
      vi.useFakeTimers();
      const { parent } = collapseFixture();
      const { container } = await openView([parent]);

      // Initial parents are collapsed; explicit toggles still change the state.
      dispatch(byClass(container, "twb-collapse-toggle")[0], "click");
      dispatch(byClass(container, "twb-collapse-toggle")[0], "click");
      expect(bodyRows(container)).toHaveLength(2);

      // Filtering does not reset the collapsed state.
      const search = byClass(headerOf(container), "task-workbench-search")[0];
      search.value = "r"; // faR, mid(no)... keeps "far" and "later"
      dispatch(search, "input");
      vi.advanceTimersByTime(200);

      // still collapsed: toggle shows ▸ and at most one preview child
      expect(byClass(container, "twb-collapse-toggle")[0].textContent).toBe("▸");
      const childRows = bodyRows(container).filter((r) =>
        r.classList.contains("is-subtask")
      );
      expect(childRows.length).toBeLessThanOrEqual(1);
    });

    it("with all preview candidates filtered out only 「他N件」 remains", async () => {
      vi.useFakeTimers();
      const parent = makeParent({ displayName: "ap-project" });
      makeSubtask(parent, "apple", { completed: true, dueDate: dateOffset(1) });
      makeSubtask(parent, "apricot", { completed: true, dueDate: dateOffset(2) });
      makeSubtask(parent, "banana", { completed: false, dueDate: dateOffset(3) });
      const { container } = await openView([parent]);

      // Reveal completed rows while the initial parent remains collapsed;
      // "banana" stays the preview because it is the only incomplete child.
      const completedLabel = byClass(headerOf(container), "task-workbench-checkbox-label")[0];
      completedLabel.children[0].checked = true;
      dispatch(completedLabel.children[0], "change");
      expect(bodyRows(container)).toHaveLength(2); // parent + banana preview

      // filter out "banana" (only "ap*" rows survive)
      const search = byClass(headerOf(container), "task-workbench-search")[0];
      search.value = "ap";
      dispatch(search, "input");
      vi.advanceTimersByTime(200);

      const rows = bodyRows(container);
      // no preview row at all — only the parent with the summary
      expect(rows).toHaveLength(1);
      expect(byClass(container, "twb-collapsed-preview-row")).toHaveLength(0);
      expect(byClass(container, "twb-collapse-summary")[0].textContent).toBe(" 他2件");
    });

    it("the collapse Set is lazy and never allocated in flat mode", async () => {
      const { parent } = collapseFixture();
      const h = makeHostHarness([parent]);
      const view = new TaskWorkbenchView({} as any, h.host);
      (view as any).flatDueSort = true;
      await view.onOpen();
      expect((view as any).collapsedParentIds).toBeNull();

      // hierarchy mode allocates it on first table render and seeds the
      // first snapshot's parent ids as collapsed.
      const parent2 = collapseFixture().parent;
      const h2 = makeHostHarness([parent2]);
      const view2 = new TaskWorkbenchView({} as any, h2.host);
      await view2.onOpen();
      expect((view2 as any).collapsedParentIds).toBeInstanceOf(Set);
      expect((view2 as any).collapsedParentIds).toEqual(new Set([parent2.id]));
    });

    it("a fresh view instance starts collapsed until explicitly expanded", async () => {
      const { parent } = collapseFixture();
      const first = await openView([parent]);
      expect(bodyRows(first.container)).toHaveLength(2);
      dispatch(byClass(first.container, "twb-collapse-toggle")[0], "click");
      expect(bodyRows(first.container)).toHaveLength(4);

      const second = await openView([parent]);
      expect(bodyRows(second.container)).toHaveLength(2);
    });

    it("parents added after the initial load start expanded", async () => {
      const initialParent = collapseFixture().parent;
      const addedParent = makeParent({
        id: "tasks/added-parent.md",
        file: { path: "tasks/added-parent.md" },
        displayName: "Added Project",
      });
      makeSubtask(addedParent, "added-child-a");
      makeSubtask(addedParent, "added-child-b");
      const tasks = [initialParent];
      const { view, container } = await openView(tasks);

      tasks.push(addedParent);
      await view.render();

      expect((view as any).collapsedParentIds).toEqual(
        new Set([initialParent.id])
      );
      expect(bodyRows(container)).toHaveLength(5);
      expect(byClass(container, "twb-collapsed-preview-row")).toHaveLength(1);
      expect(deepText(container)).toContain("added-child-a");
      expect(deepText(container)).toContain("added-child-b");
    });
  });





  describe("inline editing state machine", () => {
    it("isEditing matches only the exact { rowId, field } pair", async () => {
      const parent = makeParent();
      const { view } = await openView([parent]);
      const v = view as any;

      expect(v.isEditing(parent, "displayName")).toBe(false);
      v.editing = { rowId: parent.id, field: "displayName" };
      expect(v.isEditing(parent, "displayName")).toBe(true);
      expect(v.isEditing(parent, "tags")).toBe(false);
      expect(
        v.isEditing(makeParent({ id: "tasks/other.md" }), "displayName")
      ).toBe(false);
    });

    it("startEditing and stopEditing redraw the table without reloading tasks", async () => {
      const parent = makeParent();
      const { view, container, h } = await openView([parent]);
      const v = view as any;
      const tableSpy = vi.spyOn(v, "renderTable");

      v.startEditing(parent, "displayName");
      expect(v.editing).toEqual({ rowId: parent.id, field: "displayName" });
      expect(tableSpy).toHaveBeenCalledTimes(1);
      // renderTable, not render: no task reload
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
      expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(1);

      v.stopEditing();
      expect(v.editing).toBeNull();
      expect(tableSpy).toHaveBeenCalledTimes(2);
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
      expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(0);
    });

    it("a full render() discards an in-progress edit without saving", async () => {
      const parent = makeParent();
      const { view, container, h } = await openView([parent]);
      dispatch(
        byClass(cells(bodyRows(container)[0])[3], "task-workbench-cell-text")[0],
        "dblclick"
      );
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(1);

      await view.render();

      expect((view as any).editing).toBeNull();
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(0);
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });
  });





  describe("inline editing: task name", () => {
    async function startNameEdit(
      tasks: TaskRow[],
      rowIndex = 0,
      settingsOverrides: Record<string, unknown> = {}
    ) {
      const ctx = await openView(tasks, settingsOverrides);
      const row = bodyRows(ctx.container)[rowIndex];
      dispatch(
        byClass(cells(row)[0], "task-workbench-cell-text")[0],
        "dblclick"
      );
      return ctx;
    }

    it("parent: dblclick opens the title textarea with autofocus + select-all", async () => {
      const { container } = await startNameEdit([
        makeParent({ displayName: "Parent One" }),
      ]);
      const editors = byClass(container, "task-workbench-title-textarea");
      expect(editors).toHaveLength(1);
      const area = editors[0];
      expect(area.tagName).toBe("TEXTAREA");
      expect(area.value).toBe("Parent One");
      expect(area.focused).toBe(true);
      expect(area.selected).toBe(true);
      // the display text is replaced by the editor
      expect(
        byClass(cells(bodyRows(container)[0])[0], "strong-parent")
      ).toHaveLength(0);
    });

    it("parent: focus is re-applied after the editor is attached (live DOMs ignore focus on detached nodes)", async () => {
      const connectedAtFocus: boolean[] = [];
      const realCreate = document.createElement.bind(document);
      const createSpy = vi
        .spyOn(document, "createElement")
        .mockImplementation(((tag: string) => {
          const el = realCreate(tag) as any;
          if (tag === "textarea") {
            const realFocus = el.focus.bind(el);
            el.focus = () => {
              connectedAtFocus.push(el.isConnected);
              realFocus();
            };
          }
          return el;
        }) as any);
      try {
        const { container } = await startNameEdit([
          makeParent({ displayName: "Parent One" }),
        ]);
        await flush();
        const area = byClass(container, "task-workbench-title-textarea")[0];
        expect(area.selected).toBe(true);
        expect(connectedAtFocus[0]).toBe(false);
        expect(connectedAtFocus[connectedAtFocus.length - 1]).toBe(true);
      } finally {
        createSpy.mockRestore();
      }
    });

    describe("IME composition", () => {
      it("parent: Ctrl+Enter and Escape during composition neither save nor cancel", async () => {
        const { container, view, h } = await startNameEdit([
          makeParent({ displayName: "Parent One" }),
        ]);
        const area = byClass(container, "task-workbench-title-textarea")[0];
        dispatch(area, "compositionstart");
        area.value = "へんかんちゅう";
        dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
        dispatch(area, "keydown", { key: "Enter", metaKey: true });
        dispatch(area, "keydown", { key: "Escape" });
        await flush();

        expect(h.updateTaskItem).not.toHaveBeenCalled();
        expect(area.dataset.saved).toBeUndefined();
        expect(area.dataset.cancelled).toBeUndefined();
        expect((view as any).editing).not.toBeNull();
        expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(1);
      });

      it("subtask: plain Enter during composition does not save", async () => {
        const parent = makeParent();
        makeSubtask(parent, "child-task");
        const { container, h } = await startNameEdit([parent], 1);
        const input = byClass(
          cells(bodyRows(container)[1])[0],
          "task-workbench-inline-input"
        )[0];
        dispatch(input, "compositionstart");
        input.value = "へんかん";
        dispatch(input, "keydown", { key: "Enter" });
        await flush();
        expect(h.updateTaskItem).not.toHaveBeenCalled();

        dispatch(input, "compositionend");
        input.value = "確定";
        dispatch(input, "keydown", { key: "Enter" });
        await flush();
        expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
        expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ displayName: "確定", title: "確定" });
      });

      it("blur mid-composition does not auto-save; a normal blur after compositionend saves the committed value", async () => {
        const { container, view, h } = await startNameEdit([
          makeParent({ displayName: "Parent One" }),
        ]);
        const area = byClass(container, "task-workbench-title-textarea")[0];
        dispatch(area, "compositionstart");
        area.value = "変換中";
        dispatch(area, "blur");
        await flush();
        expect(h.updateTaskItem).not.toHaveBeenCalled();
        expect((view as any).editing).not.toBeNull();

        dispatch(area, "compositionend");
        area.value = "確定済み";
        dispatch(area, "blur");
        await flush();
        expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
        expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
          displayName: "確定済み",
          title: "確定済み",
        });
      });

      it("parent: plain Enter, Ctrl+Enter and Escape still work outside composition", async () => {
        const { container, h } = await startNameEdit([
          makeParent({ displayName: "Parent One" }),
        ]);
        const area = byClass(container, "task-workbench-title-textarea")[0];
        dispatch(area, "compositionstart");
        dispatch(area, "compositionend");
        dispatch(area, "keydown", { key: "Enter" });
        expect(h.updateTaskItem).not.toHaveBeenCalled();
        area.value = "Saved";
        dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
        await flush();
        expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      });
    });

    it("subtask: dblclick opens a single-line text input", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child-task");
      const { container } = await startNameEdit([parent], 1);

      const input = byClass(
        cells(bodyRows(container)[1])[0],
        "task-workbench-inline-input"
      )[0];
      expect(input.tagName).toBe("INPUT");
      expect(input.type).toBe("text");
      expect(input.value).toBe("child-task");
      expect(input.focused).toBe(true);
      expect(input.selected).toBe(true);
    });

    it("prefill matches the display fallback (displayName:\"\" uses title) so a no-op blur cannot wipe title", async () => {
      const { container, h } = await startNameEdit([
        makeParent({ displayName: "", title: "Legacy Title" }),
      ]);
      const area = byClass(container, "task-workbench-title-textarea")[0];
      // Prefill with the display cell's fallback (`row.displayName || row.title`).
      // Otherwise, blurring without typing could erase the row's only name.
      expect(area.value).toBe("Legacy Title");

      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(
        expect.anything(),
        { displayName: "Legacy Title", title: "Legacy Title" }
      );
    });

    it("parent: Ctrl+Enter saves with whitespace collapse and title sync", async () => {
      const { container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      area.value = "foo  \n\n  bar";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "foo bar",
        title: "foo bar",
      });
      // The write triggers a full re-render.
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });

    it("parent: Cmd+Enter saves too", async () => {
      const { container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      area.value = "meta saved";
      dispatch(area, "keydown", { key: "Enter", metaKey: true });
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "meta saved",
        title: "meta saved",
      });
    });

    it("plain Enter inserts a newline in the parent title editor", async () => {
      const { container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      area.value = "line one";
      dispatch(area, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
      // still in edit mode — the editor remains rendered
      expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(1);
    });

    it("subtask: plain Enter saves", async () => {
      const parent = makeParent();
      makeSubtask(parent, "child-task");
      const { container, h } = await startNameEdit([parent], 1);
      const input = byClass(
        cells(bodyRows(container)[1])[0],
        "task-workbench-inline-input"
      )[0];

      input.value = "renamed child";
      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "renamed child",
        title: "renamed child",
      });
      // hierarchy mode passes the collapse-decorated copy — identify by id
      expect(h.updateTaskItem.mock.calls[0][0].id).toBe(
        "tasks/parent-1.md::child-task"
      );
    });

    it("Escape cancels without saving and disarms the following blur", async () => {
      const { view, container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];
      area.value = "never saved";

      dispatch(area, "keydown", { key: "Escape" });
      expect(area.dataset.cancelled).toBe("1");
      expect((view as any).editing).toBeNull();
      // display mode restored
      expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(0);
      expect(
        byClass(cells(bodyRows(container)[0])[0], "task-workbench-cell-text")
      ).toHaveLength(1);

      // a late blur on the detached editor must not save either
      dispatch(area, "blur");
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });

    it("blur auto-saves with the same whitespace processing", async () => {
      const { container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      area.value = "  spaced   name\t here ";
      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "spaced name here",
        title: "spaced name here",
      });
    });

    it("blur after an Enter save does not double-save", async () => {
      const { container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      area.value = "once";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
      expect(area.dataset.saved).toBe("1");
      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    });

    it("whitespace-only name saves as empty string in both fields", async () => {
      const { container, h } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      area.value = "   \n\n  ";
      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "",
        title: "",
      });
    });

    it("name editor stops click/mousedown propagation and prevents dragstart", async () => {
      const { container } = await startNameEdit([makeParent()]);
      const area = byClass(container, "task-workbench-title-textarea")[0];

      expect(dispatch(area, "click").__propagationStopped).toBe(true);
      expect(dispatch(area, "mousedown").__propagationStopped).toBe(true);
      const drag = dispatch(area, "dragstart");
      expect(drag.__propagationStopped).toBe(true);
      expect(drag.__defaultPrevented).toBe(true);
    });
  });





  describe("inline editing: current status", () => {
    async function startStatusEdit(
      tasks: TaskRow[],
      settingsOverrides: Record<string, unknown> = {}
    ) {
      const ctx = await openView(tasks, settingsOverrides);
      dispatch(
        byClass(cells(bodyRows(ctx.container)[0])[3], "task-workbench-cell-text")[0],
        "dblclick"
      );
      return ctx;
    }

    function editorOf(container: FakeEl): FakeEl {
      return byClass(container, "task-workbench-inline-textarea")[0];
    }

    it("dblclick opens the textarea: rows from settings, autofocus, NO select-all, empty stays empty", async () => {
      const { container } = await startStatusEdit([
        makeParent({ currentStatus: "" }),
      ]);
      const area = editorOf(container);
      expect(area.tagName).toBe("TEXTAREA");
      expect(area.rows).toBe(5); // DEFAULT_SETTINGS.currentStatusRows
      expect(area.value).toBe("");
      expect(area.focused).toBe(true);
      expect(area.selected).toBe(false);
    });

    it("textarea rows reflects settings.currentStatusRows", async () => {
      const { container } = await startStatusEdit(
        [makeParent({ currentStatus: "working on it" })],
        { currentStatusRows: 8 }
      );
      const area = editorOf(container);
      expect(area.rows).toBe(8);
      expect(area.value).toBe("working on it");
    });

    it("the five pointer listeners stop propagation; dragstart also prevents default", async () => {
      const { container } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);

      for (const type of [
        "pointerdown",
        "mousedown",
        "click",
        "dblclick",
        "dragstart",
      ]) {
        expect(dispatch(area, type).__propagationStopped).toBe(true);
      }
      expect(dispatch(area, "dragstart").__defaultPrevented).toBe(true);
    });

    it("Ctrl/Cmd+Enter saves currentStatus and sets dataset.saved; plain Enter does not save", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);

      area.value = "plain enter text";
      dispatch(area, "keydown", { key: "Enter" });
      expect(h.updateTaskItem).not.toHaveBeenCalled();

      area.value = "progress update";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
      await flush();

      expect(area.dataset.saved).toBe("1");
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "progress update",
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(2); // full re-render
    });

    it("Escape cancels without saving, restores display and sets dataset.cancelled", async () => {
      const { view, container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      area.value = "discarded";

      dispatch(area, "keydown", { key: "Escape" });

      expect(area.dataset.cancelled).toBe("1");
      expect((view as any).editing).toBeNull();
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(0);
      expect(deepText(cells(bodyRows(container)[0])[3])).toBe("working on it");
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });

    it("blur branch 1: dataset.cancelled skips the save", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      area.dataset.cancelled = "1";
      area.value = "should not save";

      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });

    it("blur branch 2: dataset.saved skips the second save", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      area.value = "saved once";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });

      // blur fires on the same editor element right after the save
      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "saved once",
      });
    });

    it("blur branch 3: pointerdown selection → no save, re-focus after exactly 80ms", async () => {
      vi.useFakeTimers();
      try {
        const { view, container, h } = await startStatusEdit([makeParent()]);
        const area = editorOf(container);
        dispatch(area, "pointerdown"); // sets isPointerSelectingText
        const focusSpy = vi.spyOn(area, "focus");

        dispatch(area, "blur");

        expect(h.updateTaskItem).not.toHaveBeenCalled();
        expect(focusSpy).not.toHaveBeenCalled();
        expect((view as any).editing).not.toBeNull(); // still editing

        vi.advanceTimersByTime(79);
        expect(focusSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(focusSpy).toHaveBeenCalledTimes(1);
        expect(h.updateTaskItem).not.toHaveBeenCalled();
        // the editor is still rendered
        expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("mousedown also marks the text-selection state", async () => {
      vi.useFakeTimers();
      try {
        const { container, h } = await startStatusEdit([makeParent()]);
        const area = editorOf(container);
        dispatch(area, "mousedown");
        const focusSpy = vi.spyOn(area, "focus");

        dispatch(area, "blur");
        vi.advanceTimersByTime(80);

        expect(focusSpy).toHaveBeenCalledTimes(1);
        expect(h.updateTaskItem).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears text-selection state on pointerup so a later blur saves", async () => {
      // Without a reset, a single click to reposition the caret (pointerdown
      // then pointerup, no actual drag) would leave the editor permanently
      // stuck behind blur branch 3 for the rest of the edit session — a real
      // click-drag-select gesture always ends with pointerup/mouseup, so
      // that's the natural reset signal.
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      dispatch(area, "pointerdown"); // sets isPointerSelectingText
      dispatch(area, "pointerup"); // ends the gesture — flag must clear

      area.value = "typed after repositioning caret";
      dispatch(area, "blur");
      await flush();

      // Branch 4 (ordinary blur → auto-save), not branch 3 (re-focus).
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "typed after repositioning caret",
      });
    });

    it("blur branch 4: ordinary focus loss auto-saves", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      area.value = "blurred note";

      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "blurred note",
      });
    });

    it("Cmd+Enter (metaKey, no ctrlKey) commits identically to Ctrl+Enter", async () => {
      // Mac uses Cmd instead of Ctrl for the multi-line confirm modifier;
      // the handler's `evt.ctrlKey || evt.metaKey` check (same pattern as
      // the rich-popover Current Status editor, task-gantt-view.ts) must
      // accept metaKey alone.
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      area.value = "mac commit";
      dispatch(area, "keydown", { key: "Enter", metaKey: true });
      await flush();

      expect(area.dataset.saved).toBe("1");
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "mac commit",
      });
    });



    // editor previously had no composition awareness at all, unlike its
    // rich-popover sibling buildCurrentStatusArea).


    it("Ctrl+Enter while an IME composition is in progress does not commit", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      dispatch(area, "compositionstart");
      area.value = "まだ変換中";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
      await flush();

      expect(area.dataset.saved).toBeUndefined();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      // still editing — the field was not closed.
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(1);
    });

    it("Ctrl+Enter after compositionend commits normally", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      dispatch(area, "compositionstart");
      area.value = "変換中";
      dispatch(area, "compositionend");
      area.value = "確定済みテキスト";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "確定済みテキスト",
      });
    });

    it("a blur that fires mid-composition does not auto-save; the field stays open", async () => {
      const { view, container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      dispatch(area, "compositionstart");
      area.value = "入力中";

      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
      expect((view as any).editing).not.toBeNull();
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(1);
    });

    it("saves on blur after IME composition has ended", async () => {
      const { container, h } = await startStatusEdit([makeParent()]);
      const area = editorOf(container);
      dispatch(area, "compositionstart");
      dispatch(area, "compositionend");
      area.value = "done composing";

      dispatch(area, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "done composing",
      });
    });


    // Inline-edit save errors are silent and leave the editor open for retry.
    // savePatch awaits host.updateTaskItem before rendering; that render clears
    // edit state and removes the textarea. A rejection stops before rendering,
    // preserving the unsaved text, unlike Gantt-canvas title editors that close
    // synchronously before awaiting onCommit.


    it("a rejected save is silent (no Notice — this file never imports Notice) and leaves the currentStatus editor open for retry", async () => {
      const parent = makeParent();
      const { view, container, h } = await startStatusEdit([parent]);
      const area = editorOf(container);
      area.value = "will fail to save";
      h.updateTaskItem.mockRejectedValueOnce(new Error("network down"));

      // Exercise savePatch directly (the shared save path every dblclick
      // editor's blur/Enter/change handler calls with `void`) rather than
      // dispatching the blur DOM event, so the rejection can be safely
      // awaited/asserted here instead of surfacing as a real unhandled
      // promise rejection in the test process — same pattern as the
      // existing "host failures escape savePatch uncaptured" test.
      await expect(
        (view as any).savePatch(parent, { currentStatus: area.value })
      ).rejects.toThrow("network down");

      // Save failures are silent: savePatch has no try/catch and this view
      // does not construct a Notice. The rejection occurs before the re-render,
      // so the editing state remains and the user can retry the unsaved text.
      expect((view as any).editing).not.toBeNull();
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(1);
      expect(editorOf(container).value).toBe("will fail to save");
      expect(h.loadTasks).toHaveBeenCalledTimes(1); // only the initial load
    });
  });





  describe("inline editing: tags", () => {
    async function startTagsEdit(tasks: TaskRow[]) {
      const ctx = await openView(tasks);
      dispatch(cells(bodyRows(ctx.container)[0])[7], "dblclick");
      return ctx;
    }

    function inputOf(container: FakeEl): FakeEl {
      return byTag(cells(bodyRows(container)[0])[7], "input")[0];
    }

    it("dblclick opens a text input prefilled with the ', '-joined tags, autofocus + select-all", async () => {
      const { container } = await startTagsEdit([
        makeParent({ tags: ["bug", "urgent", "backend"] }),
      ]);
      const input = inputOf(container);
      expect(input.tagName).toBe("INPUT");
      expect(input.type).toBe("text");
      expect(input.classList.contains("task-workbench-inline-input")).toBe(true);
      expect(input.value).toBe("bug, urgent, backend");
      expect(input.focused).toBe(true);
      expect(input.selected).toBe(true);
    });

    it("undefined tags prefill an empty editor", async () => {
      const { container } = await startTagsEdit([makeParent({ tags: undefined })]);
      expect(inputOf(container).value).toBe("");
    });

    it("Enter saves through parseTagsInput — the decisive ',,,' → four empty elements", async () => {
      const { container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      input.value = ", , ,";
      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        tags: ["", "", "", ""],
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(2); // full re-render
    });

    it("elements are trimmed; semicolons stay literal", async () => {
      const { container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      input.value = "tag1, tag2; tag3";
      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        tags: ["tag1", "tag2; tag3"],
      });
    });

    it("preserves empty middle tag elements", async () => {
      const { container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      input.value = "tag1, , tag2";
      dispatch(input, "blur");
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        tags: ["tag1", "", "tag2"],
      });
    });

    it("empty input saves a single empty-string element", async () => {
      const { container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      input.value = "";
      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ tags: [""] });
    });

    it("Escape cancels without saving and disarms the following blur", async () => {
      const { view, container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);
      input.value = "never, saved";

      dispatch(input, "keydown", { key: "Escape" });
      expect(input.dataset.cancelled).toBe("1");
      expect((view as any).editing).toBeNull();
      // display mode restored with the original tags text
      expect(byTag(cells(bodyRows(container)[0])[7], "input")).toHaveLength(0);
      expect(cells(bodyRows(container)[0])[7].textContent).toBe("backend, urgent");

      dispatch(input, "blur");
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });

    it("blur after an Enter save does not double-save", async () => {
      const { container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      input.value = "a, b";
      dispatch(input, "keydown", { key: "Enter" });
      expect(input.dataset.saved).toBe("1");
      dispatch(input, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ tags: ["a", "b"] });
    });

    it("plain blur (no Enter/Escape) saves the parsed tags", async () => {
      const { container, h } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      input.value = "x,  y ,z";
      dispatch(input, "blur");
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        tags: ["x", "y", "z"],
      });
    });

    it("tags editor stops click/mousedown propagation and prevents dragstart", async () => {
      const { container } = await startTagsEdit([makeParent()]);
      const input = inputOf(container);

      expect(dispatch(input, "click").__propagationStopped).toBe(true);
      expect(dispatch(input, "mousedown").__propagationStopped).toBe(true);
      const drag = dispatch(input, "dragstart");
      expect(drag.__propagationStopped).toBe(true);
      expect(drag.__defaultPrevented).toBe(true);
    });
  });





  describe("inline editing: save machinery", () => {
    it("savePatch writes through the host, clears editing and fully re-renders", async () => {
      const parent = makeParent();
      const { view, container, h } = await openView([parent]);
      const v = view as any;
      dispatch(
        byClass(cells(bodyRows(container)[0])[3], "task-workbench-cell-text")[0],
        "dblclick"
      );
      expect(v.editing).not.toBeNull();
      expect(h.loadTasks).toHaveBeenCalledTimes(1);

      await v.savePatch(parent, { currentStatus: "done" });

      // The write was delegated to the host.
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ currentStatus: "done" });
      // Saving triggers a full re-render and task reload.
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
      // The render reset clears the editing state.
      expect(v.editing).toBeNull();
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(0);
    });

    it("host failures escape savePatch uncaptured — no try/catch, no re-render", async () => {
      const parent = makeParent();
      const { view, h } = await openView([parent]);
      h.updateTaskItem.mockRejectedValueOnce(new Error("write failed"));

      await expect(
        (view as any).savePatch(parent, { currentStatus: "x" })
      ).rejects.toThrow("write failed");

      // the rejection precedes render: no reload attempt
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });
  });





  describe("sort/filter controls discard in-progress edits", () => {
    it("changing the sort key discards the edit without reloading tasks", async () => {
      const parent = makeParent();
      const { view, container, h } = await openView([parent]);
      dispatch(
        byClass(cells(bodyRows(container)[0])[0], "task-workbench-cell-text")[0],
        "dblclick"
      );
      expect((view as any).editing).toEqual({
        rowId: parent.id,
        field: "displayName",
      });
      expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(1);

      const sortKeySelect = headerSelects(container)[1];
      sortKeySelect.value = "title";
      dispatch(sortKeySelect, "change");

      expect((view as any).editing).toBeNull();
      // the cell renders in display mode again; typed content is lost
      expect(byClass(container, "task-workbench-title-textarea")).toHaveLength(0);
      expect(
        byClass(cells(bodyRows(container)[0])[0], "task-workbench-cell-text")
      ).toHaveLength(1);
      // renderTable only — no full reload happened
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("typing into the filter while editing drops the edit", async () => {
      vi.useFakeTimers();
      const parent = makeParent({ displayName: "Filter Target" });
      const { view, container } = await openView([parent]);
      dispatch(
        byClass(cells(bodyRows(container)[0])[3], "task-workbench-cell-text")[0],
        "dblclick"
      );
      expect((view as any).editing).toEqual({
        rowId: parent.id,
        field: "currentStatus",
      });

      const search = byClass(headerOf(container), "task-workbench-search")[0];
      search.value = "filter";
      dispatch(search, "input");
      vi.advanceTimersByTime(200);

      expect((view as any).editing).toBeNull();
      expect(byClass(container, "task-workbench-inline-textarea")).toHaveLength(0);
      // the row still matches the filter and renders in display mode
      expect(deepText(cells(bodyRows(container)[0])[0])).toContain("Filter Target");
    });
  });
});
