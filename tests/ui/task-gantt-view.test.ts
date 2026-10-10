/* eslint-disable @typescript-eslint/no-explicit-any */










import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from "vitest";
import moment from "moment";
import { Menu, Notice } from "obsidian";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  Notice: vi.fn(),
}));
import { TaskGanttView, computeRichPopoverPosition } from "../../src/ui/task-gantt-view";
import type { TaskGanttViewHost } from "../../src/ui/task-gantt-view";
import {
  DEFAULT_GANTT_TAG_COLORS,
  DEFAULT_SETTINGS,
} from "../../src/core/constants";

import type { Logger } from "../../src/core/logger";

import type {
  DailyTodoItem,
  DailyTodoSummary,
  GanttTagDefinition,
  TaskRow,
  TaskWorkbenchSettings,
} from "../../src/core/types";
import { todayStr } from "../../src/core/utils";
import {
  addDays,
  computeRowFingerprint,
  computeRowHeight,
  diffDays,
  estimateTextWidth,
  monthTitle,
} from "../../src/app/gantt-layout";
import {
  BAR_HEIGHT,
  MARKER_ROW_HEIGHT,
  PARENT_COL_WIDTH,
  WORKLOAD_ROW_HEIGHT,
} from "../../src/app/gantt-constants";
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


/** YYYY-MM-DD offset from today (keeps date-relative tests time-safe). */
function dateOffset(days: number): string {
  return moment().startOf("day").add(days, "days").format("YYYY-MM-DD");
}


function weekdayDateOffset(days: number): string {
  let date = addDays(todayStr(), days);
  while (moment(date, "YYYY-MM-DD").day() === 0 || moment(date, "YYYY-MM-DD").day() === 6) {
    date = addDays(date, 1);
  }
  return date;
}

function tagDefinition(
  name: string,
  color = "",
  order = 0,
  key = name
): GanttTagDefinition {
  return { key, name, color, order };
}

function tagRegistry(
  names: string[],
  colors: Record<string, string> = {}
): GanttTagDefinition[] {
  return names.map((name, index) =>
    tagDefinition(name, colors[name] ?? `#${(index + 1).toString(16).repeat(6)}`, index * 1000)
  );
}

function collectTaskTagNames(tasks: TaskRow[]): string[] {
  const names = new Set<string>();
  const addTags = (tags: string[] | undefined): void => {
    for (const tag of tags ?? []) {
      if (tag !== "") {
        names.add(tag);
      }
    }
  };
  const addMarkers = (task: TaskRow): void => {
    for (const marker of task.ganttMarkers ?? []) {
      addTags(marker.tags);
    }
  };

  for (const task of tasks) {
    addTags(task.tags);
    addMarkers(task);
    if (task.kind === "parent") {
      for (const subtask of task.subtasks?.values() ?? []) {
        addTags(subtask.tags);
        addMarkers(subtask);
      }
    }
  }
  return Array.from(names);
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
    currentStatus: "",
    notes: "",
    tags: ["backend"],
    ganttEnabled: false,
    subtasks: new Map<string, TaskRow>(),
    ...overrides,
  } as unknown as TaskRow;
}

/** A subtask row; pass plannedStartDate/plannedEndDate to make it a bar. */
function makeSubtask(
  key: string,
  overrides: Record<string, unknown> = {}
): TaskRow {
  return {
    kind: "subtask",
    id: `tasks/parent-1.md::${key}`,
    key,
    file: { path: "tasks/parent-1.md", parentPath: "tasks/parent-1.md" },
    title: key,
    displayName: key,
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-01 10:00:00",
    updatedAt: "2026-07-02 11:00:00",
    priority: 2,
    priorityMode: "manual",
    currentStatus: "",
    notes: "",
    tags: [],
    ...overrides,
  } as unknown as TaskRow;
}

/** Attaches children to a parent's subtasks Map (keyed by subtask key). */
function withChildren(parent: TaskRow, children: TaskRow[]): TaskRow {
  parent.subtasks = new Map(
    children.map((child): [string, TaskRow] => [child.key ?? child.id, child])
  );
  return parent;
}

interface HostHarness {
  host: TaskGanttViewHost;
  loadTasks: any;
  loadDailyTodoSummaries: any;
  updateDailyTodoItem: any;
  deleteDailyTodoItem: any;
  addDailyTodoItem: any;
  openDailyTodoItem: any;
  saveSettings: any;
  settings: TaskWorkbenchSettings;

  updateTaskItem: any;
  updateTaskItemsBatch: any;
  confirmWorkloadShift: any;

  openTaskItem: any;

  openMarkerModal: any;

  openTextPrompt: any;
  deleteSubtaskTaskItem: any;

  addSubtaskWithPlan: any;

  openGanttParentPicker: any;

  activateView: any;
  syncReadonlyGanttNow: any;
  undoLastAction: any;
  redoLastAction: any;
}










function makeHostHarness(
  tasks: TaskRow[],
  settingsOverrides: Record<string, unknown> = {}
): HostHarness {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...settingsOverrides,
  } as TaskWorkbenchSettings;
  // Fresh copies so view mutations (holiday toggle) never leak into the
  // shared DEFAULT_SETTINGS arrays.
  settings.ganttHolidays = [...settings.ganttHolidays];
  settings.ganttManualHolidays = [...settings.ganttManualHolidays];
  settings.ganttNationalHolidays = [...settings.ganttNationalHolidays];
  settings.ganttSpecialHolidays = [...settings.ganttSpecialHolidays];
  settings.ganttEvents = [...settings.ganttEvents];
  settings.weeklyWorkSchedules = [...settings.weeklyWorkSchedules];

  const loadTasks = vi.fn(async () => tasks);
  const loadDailyTodoSummaries = vi.fn(async (): Promise<DailyTodoSummary[]> => []);
  // Daily ToDo popover persistence: every write succeeds by default.
  const updateDailyTodoItem = vi.fn(
    async (
      item: DailyTodoItem,
      patch: { text?: string; completed?: boolean }
    ) => {
      item.text = patch.text ?? item.text;
      item.completed = patch.completed ?? item.completed;
      return true;
    }
  );
  const deleteDailyTodoItem = vi.fn(async (_item: DailyTodoItem) => true);
  const addDailyTodoItem = vi.fn(
    async (
      _dateStr: string,
      text: string,
      completed: boolean
    ): Promise<DailyTodoItem | null> => ({
      sourceKey: "main",
      sourceLabel: "デイリー",
      path: "daily/main.md",
      line: 99,
      text,
      completed,
      isNew: false,
    })
  );
  const openDailyTodoItem = vi.fn(async (_item: DailyTodoItem) => undefined);
  const saveSettings = vi.fn(async () => undefined);
  const updateTaskItem = vi.fn(async () => ({}));
  const updateTaskItemsBatch = vi.fn(async () => []);
  const confirmWorkloadShift = vi.fn(async () => true);
  // Resolves successfully by default; tests assert the calls made by the
  // popover's 「ノートを開く」 button.
  const openTaskItem = vi.fn(async () => undefined);
  // Defaults to cancelled (null), so tests that do not inspect the submitted
  // value are not blocked. Individual tests return {title, date} to exercise
  // the confirmation path.
  const openMarkerModal = vi.fn(async () => null);
  // Callback-shaped rather than Promise-based. It does not submit by default;
  // tests that inspect the prompt's title, label, or initial value can read
  // those from the mock's call arguments.
  const openTextPrompt = vi.fn(
    (
      _title: string,
      _label: string,
      _initialValue: string,
      onSubmit: (value: string) => void
    ) => {
      // no-op by default (simulates the dialog staying open / user not
      // having confirmed yet) — individual tests call the captured
      // onSubmit callback themselves via openTextPrompt.mock.calls.
      void onSubmit;
    }
  );
  const deleteSubtaskTaskItem = vi.fn(async () => undefined);
  // resolves with a plausible created subtask row by
  // default (individual tests that care about the exact args/result read
  // the mock's own call args instead of the resolved value).
  const addSubtaskWithPlan = vi.fn(
    async (parentRow: TaskRow, name: string, dateStr: string) =>
      ({
        kind: "subtask",
        id: `${parentRow.file.path}::${name}`,
        key: name,
        file: { path: parentRow.file.path, parentPath: parentRow.file.path },
        title: name,
        displayName: name,
        statusLabel: "active",
        completed: false,
        createdAt: dateStr,
        updatedAt: dateStr,
        priority: 0,
        priorityMode: "auto",
        currentStatus: "",
        notes: "",
        tags: [],
        plannedStartDate: dateStr,
        plannedEndDate: dateStr,
      }) as unknown as TaskRow
  );
  // opens the picker synchronously by default (real Modal.open
  // is fire-and-forget too) — tests that need to assert on `items` or invoke
  // the captured onChoose callback read the mock's own call args instead.
  const openGanttParentPicker = vi.fn(
    (
      _items: TaskRow[],
      onChoose: (item: TaskRow) => void | Promise<void>
    ) => {
      void onChoose;
    }
  );
  // resolve successfully by default; individual tests
  // assert on the calls themselves.
  const activateView = vi.fn(async () => undefined);
  const syncReadonlyGanttNow = vi.fn(async () => undefined);
  const undoLastAction = vi.fn(async () => undefined);
  const redoLastAction = vi.fn(async () => undefined);
  const host: TaskGanttViewHost = {

    logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,

    settings,
    loadTasks,
    loadDailyTodoSummaries,
    updateDailyTodoItem,
    deleteDailyTodoItem,
    addDailyTodoItem,
    openDailyTodoItem,
    saveSettings,
    updateTaskItem,
    updateTaskItemsBatch,
    confirmWorkloadShift,
    openTaskItem,
    openMarkerModal,
    openTextPrompt,
    deleteSubtaskTaskItem,
    addSubtaskWithPlan,
    openGanttParentPicker,
    activateView,
    syncReadonlyGanttNow,
    undoLastAction,
    redoLastAction,
    // a plausible default manifest — individual
    // tests that care about the exact rendered text override via
    // settingsOverrides-independent host mutation (host.manifest = {...}).
    manifest: {
      version: "1.2.3",
      releaseNotes: "テストリリースノート",
      description: "テスト説明",
    },
  };
  return {
    host,
    loadTasks,
    loadDailyTodoSummaries,
    updateDailyTodoItem,
    deleteDailyTodoItem,
    addDailyTodoItem,
    openDailyTodoItem,
    saveSettings,
    settings,
    updateTaskItem,
    updateTaskItemsBatch,
    confirmWorkloadShift,
    openTaskItem,
    openMarkerModal,
    openTextPrompt,
    deleteSubtaskTaskItem,
    addSubtaskWithPlan,
    openGanttParentPicker,
    activateView,
    syncReadonlyGanttNow,
    undoLastAction,
    redoLastAction,
  };
}

/** Flushes microtasks so fire-and-forget async handlers settle. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Pins only Date (timers/rAF stay real) to a Friday for the current test, so
 * fixtures built on `moment()` / dateOffset() do not behave differently on
 * weekends (non-working days snap forward to Monday). Real time is restored
 * when the test finishes.
 */
function useFridayClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 2, 12, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function openView(
  tasks: TaskRow[],
  settingsOverrides: Record<string, unknown> = {}
): Promise<{ view: TaskGanttView; container: FakeEl; h: HostHarness }> {
  const effectiveSettingsOverrides =
    Object.prototype.hasOwnProperty.call(settingsOverrides, "ganttTags")
      ? settingsOverrides
      : {
          ...settingsOverrides,
          ganttTags: tagRegistry(collectTaskTagNames(tasks)),
        };
  const h = makeHostHarness(tasks, effectiveSettingsOverrides);
  const view = new TaskGanttView({} as any, h.host);
  const container = (view as any).containerEl as FakeEl;
  await view.onOpen();
  return { view, container, h };
}

/** Reads an inline CSS custom property from the fake DOM's plain-record style. */
function styleVar(el: FakeEl, name: string): string | undefined {
  return (el.style as Record<string, string | undefined>)[name];
}

function wrapOf(container: FakeEl): FakeEl {
  return byClass(container, "task-gantt-wrap")[0];
}

function rowOf(wrap: FakeEl, cls: string): FakeEl {
  return byClass(wrap, cls)[0];
}

/** The view's cached date list (dates[0] = today-14, dates[14] = today). */
function datesOf(view: TaskGanttView): string[] {
  return (view as any).dates as string[];
}

/** Dates rendered by the per-bar popup, not the whole chart range. */
function workloadDatesOf(view: TaskGanttView, task: TaskRow): string[] {
  return datesOf(view).filter(
    (date) =>
      (!task.plannedStartDate || date >= task.plannedStartDate) &&
      (!task.plannedEndDate || date <= task.plannedEndDate)
  );
}



function parentRows(container: FakeEl): FakeEl[] {
  return byClass(container, "task-gantt-parent-row");
}

function leftOf(row: FakeEl): FakeEl {
  return byClass(row, "task-gantt-parent-left")[0];
}

function timelineOf(row: FakeEl): FakeEl {
  return byClass(row, "task-gantt-parent-timeline")[0];
}

/** The chart's base date (rangeStart = today - 14) for geometry math. */
function baseDateOf(view: TaskGanttView): string {
  return (view as any).rangeStart as string;
}

/**
 *
 * Real obsidian.Menu (the tests/stubs/obsidian.ts stub) appends its root
 * element to document.body on show, mirroring real Obsidian — this is
 * where every real-Menu-API context menu this area builds actually lives
 * (bar / marker / empty-cell). Module-level (not describe-scoped) so every
 * describe block in this file that dispatches a contextmenu event can find
 * and click the resulting menu items the same way.
 */
function menuBody(): FakeEl {
  return (document as unknown as { body: FakeEl }).body;
}

/**
 * The rich popover / workload popup / workload day summary popover are all
 * appended to document.body (not containerEl) — real-machine testing found
 * Obsidian's own `.workspace-leaf.mod-active { contain: strict }` breaks
 * position:fixed's viewport-relative math when appended inside the view's
 * own container. Same underlying element as menuBody; a distinct name
 * here just avoids a confusing "why check menuBody for a popover" read.
 */
function popoverBody(): FakeEl {
  return menuBody();
}

function menuItems(): FakeEl[] {
  return byClass(menuBody(), "menu-item");
}

function menuItemWithText(text: string): FakeEl {
  const found = menuItems().find((el) => deepText(el).includes(text));
  if (!found) {
    throw new Error(`no open menu item contains text: ${text}`);
  }
  return found;
}



describe("TaskGanttView", () => {
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    // Run requestAnimationFrame callbacks synchronously so deferred scrolling
    // and the double-rAF extension run immediately.
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    // drag handlers attach pointermove/pointerup on
    // `window` (not the target element) — the fake DOM's element stub has
    // the exact addEventListener/removeEventListener/dispatch surface
    // needed, so it doubles as a fake window.
    vi.stubGlobal("window", makeFakeEl("window"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });





  describe("identity and onOpen", () => {
    it("exposes the Gantt view type and title", () => {
      const h = makeHostHarness([]);
      const view = new TaskGanttView({} as any, h.host);
      expect(view.getViewType()).toBe("task-gantt-view");
      expect(view.getDisplayText()).toBe("Task Gantt");
    });

    it("starts with an empty workloadModeStore (session-only UI state, not yet wired to rendering)", () => {
      const h = makeHostHarness([]);
      const view = new TaskGanttView({} as any, h.host);
      const store = view.getWorkloadModeStoreForTesting();
      expect(store).toBeInstanceOf(Map);
      expect(store.size).toBe(0);
      store.set("tasks/parent.md::sub-a", { mode: "actual" });
      expect(view.getWorkloadModeStoreForTesting().get("tasks/parent.md::sub-a")).toEqual({
        mode: "actual",
      });
    });

    it("builds container + toolbar + wrap + drag tooltip", async () => {
      const { container } = await openView([]);
      expect(container.classList.contains("task-gantt-container")).toBe(true);
      expect(container.children).toHaveLength(3);
      expect(container.children[0].classList.contains("task-gantt-toolbar")).toBe(true);
      expect(container.children[1].classList.contains("task-gantt-wrap")).toBe(true);
      expect(container.children[2].classList.contains("task-gantt-drag-tooltip")).toBe(true);
    });

    it("attaches the scroll listener to the wrap element", async () => {
      const { container } = await openView([]);
      const wrap = wrapOf(container);
      expect((wrap.listeners["scroll"] ?? []).length).toBeGreaterThan(0);
    });

    it("runs the initial render (tasks loaded once)", async () => {
      const { h } = await openView([]);
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("scrolls today to 220px from the left after render", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const todayIndex = datesOf(view).indexOf(todayStr());
      // dayWidth = 28 (default zoom): scrollLeft = todayIndex*28 - 220.
      expect(wrap.scrollLeft).toBe(Math.max(0, todayIndex * 28 - 220));
      expect(wrap.scrollLeft).toBe(172); // todayIndex = 14
    });
  });

  describe("initial state", () => {
    it("initializes range, zoom, cache and extension flag", async () => {
      const { view } = await openView([]);
      expect((view as any).rangeStart).toBe(addDays(todayStr(), -14));
      expect((view as any).rangeDays).toBe(90);
      expect((view as any).dayWidth).toBe(28);
      expect((view as any)._ganttRowCache).toBeUndefined();
      expect((view as any).isExtendingRange).toBe(false);
      expect(datesOf(view)).toHaveLength(90);
      expect(datesOf(view)[0]).toBe(addDays(todayStr(), -14));
    });

    it("reads dayWidth from a non-default ganttZoom setting", async () => {
      const { view } = await openView([], { ganttZoom: 40 });
      expect((view as any).dayWidth).toBe(40);
    });
  });





  describe("header structure", () => {
    it("renders three rows of 90 day-width cells each", async () => {
      const { container } = await openView([]);
      const wrap = wrapOf(container);
      const monthRow = rowOf(wrap, "task-gantt-month-row");
      const dayRow = rowOf(wrap, "task-gantt-day-row");
      const dowRow = rowOf(wrap, "task-gantt-dow-row");
      expect(monthRow).toBeTruthy();
      expect(dayRow).toBeTruthy();
      expect(dowRow).toBeTruthy();
      expect(monthRow.children).toHaveLength(90);
      expect(dayRow.children).toHaveLength(90);
      expect(dowRow.children).toHaveLength(90);
      // inline width = dayWidth px (judgement: inline style, not CSS var)
      expect(monthRow.children[0].style.width).toBe("28px");
      expect(dayRow.children[0].style.width).toBe("28px");
      expect(dowRow.children[0].style.width).toBe("28px");
    });

    it("shows month labels only at month boundaries, day/dow always", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const dates = datesOf(view);
      const monthCells = rowOf(wrap, "task-gantt-month-row").children;
      const dayCells = rowOf(wrap, "task-gantt-day-row").children;
      const dowCells = rowOf(wrap, "task-gantt-dow-row").children;

      // Index 0 always carries a month label (range starts mid-month).
      expect(monthCells[0].textContent).toBe(monthTitle(dates[0]));

      let boundaryCount = 0;
      for (let i = 0; i < dates.length; i += 1) {
        const prev = i === 0 ? "" : dates[i - 1].slice(0, 7);
        const isBoundary = i === 0 || dates[i].slice(0, 7) !== prev;
        if (isBoundary) {
          boundaryCount += 1;
          expect(monthCells[i].textContent).toBe(monthTitle(dates[i]));
        } else {
          expect(monthCells[i].textContent).toBe("");
        }
        // day + dow cells are always labelled
        expect(dayCells[i].textContent).toBe(
          moment(dates[i], "YYYY-MM-DD").format("DD")
        );
        expect(dowCells[i].textContent).not.toBe("");
      }
      expect(boundaryCount).toBeGreaterThanOrEqual(1);
    });

    it("renders header-left label and tag-filter button when tags enabled", async () => {
      const { container } = await openView([], { ganttFeatureTagsEnabled: true });
      const headerLeft = byClass(container, "task-gantt-header-left")[0];
      expect(headerLeft).toBeTruthy();
      const buttons = byClass(headerLeft, "task-gantt-tag-filter");
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toBe("タグ絞込");
      // "親タスク" fixed label present somewhere in header-left
      const texts: string[] = [];
      const collect = (el: FakeEl): void => {
        if (el.textContent) texts.push(el.textContent);
        el.children.forEach(collect);
      };
      collect(headerLeft);
      expect(texts).toContain("親タスク");
    });

    it("omits the tag-filter button when tags disabled", async () => {
      const { container } = await openView([], { ganttFeatureTagsEnabled: false });
      expect(byClass(container, "task-gantt-tag-filter")).toHaveLength(0);
    });
  });

  describe("per-cell classes", () => {
    it.each([true, false])("reuses date classifications only within a render (incremental=%s)", async (incrementalGanttRender) => {
      const { view } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender }
      );
      const date = datesOf(view)[0];
      const classes = (view as any).dateClasses(date);
      const daySpy = vi.spyOn(moment.fn, "day");
      expect((view as any).dateClasses(date)).toBe(classes);
      expect(daySpy).not.toHaveBeenCalled();

      // Popup dates need not belong to the rendered chart range.
      const outsideDate = addDays(date, -1);
      const outsideClasses = (view as any).dateClasses(outsideDate);
      expect((view as any).dateClasses(outsideDate)).toBe(outsideClasses);
      expect(daySpy).toHaveBeenCalledTimes(1);
      daySpy.mockRestore();

      (view as any).renderChart();
      expect((view as any).dateClasses(date)).toEqual(classes);
      expect((view as any).dateClasses(date)).not.toBe(classes);
      expect((view as any).dateClasses(outsideDate)).toEqual(outsideClasses);
      expect((view as any).dateClasses(outsideDate)).not.toBe(outsideClasses);
    });

    it.each([true, false])("refreshes cached holiday and today classes on the next render (incremental=%s)", async (incrementalGanttRender) => {
      useFridayClock();
      const today = todayStr();
      const tomorrow = addDays(today, 1);
      const { view, container, h } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender, ganttManualHolidays: [today] }
      );
      expect((view as any).dateClasses(today)).toEqual({
        isWeekend: false, isHoliday: true, isToday: true,
      });
      expect((view as any).dateClasses(tomorrow)).toEqual({
        isWeekend: true, isHoliday: false, isToday: false,
      });

      h.settings.ganttManualHolidays = [];
      h.settings.ganttSpecialHolidays = [tomorrow];
      vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
      (view as any).renderChart();

      for (const [date, expected] of [
        [today, { isWeekend: false, isHoliday: false, isToday: false }],
        [tomorrow, { isWeekend: true, isHoliday: true, isToday: true }],
      ] as const) {
        expect((view as any).dateClasses(date)).toEqual(expected);
        const index = datesOf(view).indexOf(date);
        const cells = [
          rowOf(wrapOf(container), "task-gantt-day-row").children[index],
          byClass(timelineOf(parentRows(container)[0]), "task-gantt-bg")[index],
        ];
        for (const cell of cells) {
          expect(cell.classList.contains("is-weekend")).toBe(expected.isWeekend);
          expect(cell.classList.contains("is-holiday")).toBe(expected.isHoliday);
          expect(cell.classList.contains("is-today")).toBe(expected.isToday);
        }
      }
    });

    it("marks weekend cells is-weekend on all three rows", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const dates = datesOf(view);
      const saturdayIndex = dates.findIndex(
        (d) => moment(d, "YYYY-MM-DD").day() === 6
      );
      expect(saturdayIndex).toBeGreaterThanOrEqual(0);
      for (const cls of [
        "task-gantt-month-row",
        "task-gantt-day-row",
        "task-gantt-dow-row",
      ]) {
        expect(
          rowOf(wrap, cls).children[saturdayIndex].classList.contains("is-weekend")
        ).toBe(true);
      }
      // a weekday cell has no is-weekend
      const weekdayIndex = dates.findIndex((d) => {
        const day = moment(d, "YYYY-MM-DD").day();
        return day !== 0 && day !== 6;
      });
      expect(
        rowOf(wrap, "task-gantt-day-row").children[weekdayIndex].classList.contains(
          "is-weekend"
        )
      ).toBe(false);
    });

    it("marks holiday cells from the national ∪ manual ∪ special union", async () => {
      const dNational = dateOffset(1);
      const dManual = dateOffset(2);
      const dSpecial = dateOffset(3);
      const { view, container } = await openView([], {
        ganttNationalHolidays: [dNational],
        ganttManualHolidays: [dManual],
        ganttSpecialHolidays: [dSpecial],
      });
      const wrap = wrapOf(container);
      const dates = datesOf(view);
      const dayRow = rowOf(wrap, "task-gantt-day-row");
      for (const holiday of [dNational, dManual, dSpecial]) {
        const index = dates.indexOf(holiday);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(dayRow.children[index].classList.contains("is-holiday")).toBe(true);
      }
      // a non-holiday date has no is-holiday
      const plainIndex = dates.indexOf(dateOffset(10));
      expect(dayRow.children[plainIndex].classList.contains("is-holiday")).toBe(false);
    });

    it("applies is-today (and stacks classes) on all three rows", async () => {
      // Make today a holiday too, so we can observe multiple stacked classes.
      const today = todayStr();
      const { view, container } = await openView([], {
        ganttManualHolidays: [today],
      });
      const wrap = wrapOf(container);
      const todayIndex = datesOf(view).indexOf(today);
      for (const cls of [
        "task-gantt-month-row",
        "task-gantt-day-row",
        "task-gantt-dow-row",
      ]) {
        const cell = rowOf(wrap, cls).children[todayIndex];
        expect(cell.classList.contains("is-today")).toBe(true);
        expect(cell.classList.contains("is-holiday")).toBe(true);
      }
    });

    it("renders no today cells when todayStr() is outside the visible range", async () => {
      const { view, container } = await openView([
        makeParent({ ganttEnabled: true }),
      ]);
      // Move the whole window into the past (viewport territory) and
      // re-render: no date equals todayStr anymore.
      (view as any).rangeStart = addDays(todayStr(), -200);
      (view as any).renderChart();

      const wrap = wrapOf(container);
      const dayCells = rowOf(wrap, "task-gantt-day-row").children;
      expect(
        dayCells.every((cell) => !cell.classList.contains("is-today"))
      ).toBe(true);
      // The parent-row background loop agrees.
      const bgs = byClass(timelineOf(parentRows(container)[0]), "task-gantt-bg");
      expect(bgs.length).toBeGreaterThan(0);
      expect(bgs.every((bg) => !bg.classList.contains("is-today"))).toBe(true);
    });
  });





  describe("toggleHoliday (dow cell click)", () => {
    it("adds to ganttManualHolidays only, saves, re-renders, keeps scroll", async () => {


      // toggleHoliday allows a weekday to be marked as a holiday.


      const dNational = dateOffset(5);
      const dSpecial = dateOffset(6);
      const target = dateOffset(4);
      const { view, container, h } = await openView([], {
        ganttNationalHolidays: [dNational],
        ganttSpecialHolidays: [dSpecial],
      });
      const wrap = wrapOf(container);
      wrap.scrollLeft = 321; // arbitrary position to verify preservation

      const targetIndex = datesOf(view).indexOf(target);
      const dowCell = rowOf(wrap, "task-gantt-dow-row").children[targetIndex];
      dispatch(dowCell, "click");
      await flush();

      // The date was added to the manual list; national and special lists are unchanged.
      expect(h.settings.ganttManualHolidays).toContain(target);
      expect(h.settings.ganttNationalHolidays).toEqual([dNational]);
      expect(h.settings.ganttSpecialHolidays).toEqual([dSpecial]);
      expect(h.saveSettings).toHaveBeenCalledTimes(1);

      // The chart re-rendered with the target cell marked as a holiday, and
      // the scroll position was preserved.
      const newWrap = wrapOf(container);
      const newIndex = datesOf(view).indexOf(target);
      expect(
        rowOf(newWrap, "task-gantt-day-row").children[newIndex].classList.contains(
          "is-holiday"
        )
      ).toBe(true);
      expect(newWrap.scrollLeft).toBe(321);
    });

    it("removes an existing manual holiday on second toggle", async () => {
      const target = dateOffset(4);
      const { view, container, h } = await openView([], {
        ganttManualHolidays: [target],
      });
      const wrap = wrapOf(container);
      const targetIndex = datesOf(view).indexOf(target);
      const dowCell = rowOf(wrap, "task-gantt-dow-row").children[targetIndex];

      dispatch(dowCell, "click");
      await flush();

      expect(h.settings.ganttManualHolidays).not.toContain(target);
      expect(
        rowOf(wrapOf(container), "task-gantt-day-row").children[
          datesOf(view).indexOf(target)
        ].classList.contains("is-holiday")
      ).toBe(false);
    });
  });





  describe("onScroll range extension", () => {
    it("extends left and shifts scroll by 60*dayWidth", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const startBefore = (view as any).rangeStart as string;
      const daysBefore = (view as any).rangeDays as number;

      // threshold = max(240, 28*10) = 280; scrollLeft below it triggers left.
      wrap.scrollLeft = 100;
      dispatch(wrap, "scroll");

      expect((view as any).rangeStart).toBe(addDays(startBefore, -60));
      expect((view as any).rangeDays).toBe(daysBefore + 60);
      expect(datesOf(view)).toHaveLength(150);
      // The scroll position shifted right by the prepended width.
      expect(wrap.scrollLeft).toBe(100 + 60 * 28);
      expect((view as any).isExtendingRange).toBe(false);
    });

    it("the render and the scroll shift are two SEPARATE animation frames, in that order (not one combined frame)", async () => {
      // The outer beforeEach's rAF stub runs callbacks synchronously, which
      // collapses a genuine double-rAF and a (buggy) single-rAF
      // implementation into the same observable end state. This test
      // replaces it with a queueing stub so the two frames can be flushed
      // one at a time and inspected in between.
      const queue: Array<() => void> = [];
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        queue.push(() => cb(0));
        return queue.length;
      });
      const flushOne = (): void => {
        const next = queue.shift();
        if (next) {
          next();
        }
      };

      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      // onOpen queued a scrollToDate animation frame; drain it before the
      // scroll-driven extension under test so it doesn't get mistaken for
      // one of the two frames being verified here.
      flushOne();
      wrap.scrollLeft = 100;

      dispatch(wrap, "scroll");
      // Synchronous part of onScroll has run: rangeStart/rangeDays already
      // grew and exactly one rAF is queued so far — the render.
      expect((view as any).rangeStart).not.toBe(undefined);
      expect(queue).toHaveLength(1);
      expect(wrap.scrollLeft).toBe(100); // not yet shifted

      flushOne(); // frame 1: renderChart + queues frame 2 (the shift)
      expect(datesOf(view)).toHaveLength(150); // render already happened
      expect(wrap.scrollLeft).toBe(100); // Scroll shift is not applied yet.
      expect(queue).toHaveLength(1); // frame 2 is now queued
      expect((view as any).isExtendingRange).toBe(true); // guard still armed

      flushOne(); // frame 2: the scroll shift
      expect(wrap.scrollLeft).toBe(100 + 60 * 28);
      expect((view as any).isExtendingRange).toBe(false);
    });

    it("uses threshold = max(240, dayWidth*10) for a large zoom", async () => {
      const { view, container } = await openView([], { ganttZoom: 50 });
      const wrap = wrapOf(container);
      const startBefore = (view as any).rangeStart as string;
      // threshold = max(240, 50*10) = 500. scrollLeft 300 < 500 → triggers.
      wrap.scrollLeft = 300;
      dispatch(wrap, "scroll");
      expect((view as any).rangeStart).toBe(addDays(startBefore, -60));
    });

    it("extends right without moving scroll (no upper bound)", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const startBefore = (view as any).rangeStart as string;
      const daysBefore = (view as any).rangeDays as number;

      // threshold = 280. Geometry: near the right edge.
      wrap.scrollWidth = 90 * 28; // 2520
      wrap.clientWidth = 500;
      wrap.scrollLeft = 1920; // 1920+500=2420 > 2520-280=2240
      dispatch(wrap, "scroll");

      expect((view as any).rangeStart).toBe(startBefore);
      expect((view as any).rangeDays).toBe(daysBefore + 60);
      expect(datesOf(view)).toHaveLength(150);
      expect(wrap.scrollLeft).toBe(1920); // unchanged
      expect((view as any).isExtendingRange).toBe(false);
    });

    it("ignores scroll events while an extension is in flight", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const startBefore = (view as any).rangeStart as string;
      (view as any).isExtendingRange = true;

      wrap.scrollLeft = 0;
      dispatch(wrap, "scroll");

      expect((view as any).rangeStart).toBe(startBefore);
    });
  });

  describe("updateFloatingMonth", () => {
    it("writes the month once and dedupes while it is unchanged", async () => {
      const { view } = await openView([]);
      const floatingMonthEl = (view as any).floatingMonthEl as FakeEl;
      const visibleStart = (view as any).getVisibleStartDate() as string;
      const expected = moment(visibleStart, "YYYY-MM-DD").format("YYYY年M月");

      // onOpen's render already populated it.
      expect(floatingMonthEl.textContent).toBe(expected);

      // Same month: overwrite with a sentinel, then re-run — dedupe means no
      // rewrite, so the sentinel survives.
      floatingMonthEl.textContent = "SENTINEL";
      (view as any).updateFloatingMonth();
      expect(floatingMonthEl.textContent).toBe("SENTINEL");

      // Month changed: it rewrites.
      (view as any).lastFloatingMonth = "1999年1月";
      (view as any).updateFloatingMonth();
      expect(floatingMonthEl.textContent).toBe(expected);
    });
  });

  describe("scrollToDate / getVisibleStartDate / ensureDateInRange", () => {
    it("scrolls to dateIndex*dayWidth - offsetPx", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      const today = todayStr();
      const todayIndex = datesOf(view).indexOf(today);

      (view as any).scrollToDate(today, 0);
      expect(wrap.scrollLeft).toBe(todayIndex * 28);

      (view as any).scrollToDate(today, 220);
      expect(wrap.scrollLeft).toBe(todayIndex * 28 - 220);
    });

    it("is a no-op for a date outside the current range", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      wrap.scrollLeft = 55;
      (view as any).scrollToDate("2000-01-01", 0);
      expect(wrap.scrollLeft).toBe(55);
    });

    it("returns dates[floor(scrollLeft/dayWidth)] with today fallback", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      wrap.scrollLeft = 28 * 20;
      expect((view as any).getVisibleStartDate()).toBe(datesOf(view)[20]);

      wrap.scrollLeft = 28 * 1000; // out of bounds
      expect((view as any).getVisibleStartDate()).toBe(todayStr());
    });

    it("extends rangeStart backwards until the date is in range", async () => {
      const { view } = await openView([]);
      const daysBefore = (view as any).rangeDays as number;
      const farPast = addDays(todayStr(), -200);
      (view as any).ensureDateInRange(farPast);
      const start = (view as any).rangeStart as string;
      const end = addDays(start, (view as any).rangeDays - 1);
      expect(start <= farPast).toBe(true);
      expect(end >= farPast).toBe(true);
      expect((view as any).rangeDays).toBeGreaterThan(daysBefore);
    });

    it("extends rangeDays forwards until the date is in range", async () => {
      const { view } = await openView([]);
      const startBefore = (view as any).rangeStart as string;
      const farFuture = addDays(todayStr(), 300);
      (view as any).ensureDateInRange(farFuture);
      expect((view as any).rangeStart).toBe(startBefore);
      const end = addDays((view as any).rangeStart, (view as any).rangeDays - 1);
      expect(end >= farFuture).toBe(true);
    });
  });





  describe("setZoom", () => {
    it("updates dayWidth, persists, scales scroll, re-renders", async () => {
      const { view, container, h } = await openView([]);
      const wrap = wrapOf(container);
      wrap.scrollLeft = 100;

      await (view as any).setZoom(56);

      expect((view as any).dayWidth).toBe(56);
      expect(h.settings.ganttZoom).toBe(56);
      expect(h.saveSettings).toHaveBeenCalledTimes(1);
      // The scroll position scales by the width ratio: 100 * 56/28 = 200.
      expect(wrap.scrollLeft).toBe(200);
      // The zoom label reflects the new value.
      expect(((view as any).zoomLabelEl as FakeEl).textContent).toBe("56px/日");
      // Header cells were re-rendered at the new width.
      const monthCell = rowOf(wrapOf(container), "task-gantt-month-row").children[0];
      expect(monthCell.style.width).toBe("56px");
    });

    it("renders a default zoom label in the toolbar", async () => {
      const { container } = await openView([]);
      const label = byClass(container, "task-gantt-zoom-label")[0];
      expect(label).toBeTruthy();
      expect(label.textContent).toBe("28px/日");
    });

    it("zoom buttons step by ±6px and clamp to [14, 72]", async () => {
      const { view, container } = await openView([]);
      const zoomIn = byClass(container, "task-gantt-zoom-in")[0];
      dispatch(zoomIn, "click");
      await flush();
      expect((view as any).dayWidth).toBe(34);

      // Drive down to the floor: repeated zoom-out clamps at 14px.
      const zoomOut = byClass(container, "task-gantt-zoom-out")[0];
      for (let i = 0; i < 20; i += 1) {
        dispatch(zoomOut, "click");
        await flush();
      }
      expect((view as any).dayWidth).toBe(14);

      // Drive up to the ceiling: repeated zoom-in clamps at 72px.
      for (let i = 0; i < 20; i += 1) {
        dispatch(zoomIn, "click");
        await flush();
      }
      expect((view as any).dayWidth).toBe(72);
    });
  });





  describe("toolbar controls", () => {
    it("「Workbench」ボタンで host.activateView() が呼ばれる", async () => {
      const { container, h } = await openView([]);
      const button = byClass(container, "task-gantt-workbench")[0];
      expect(button).toBeTruthy();
      dispatch(button, "click");
      expect(h.activateView).toHaveBeenCalledTimes(1);
    });

    it("「今日へ」ボタンで range確保・再描画・today位置(220px余裕)へのスクロールが起きる", async () => {
      const { view, container } = await openView([]);
      const wrap = wrapOf(container);
      wrap.scrollLeft = 5000; // move away from today first

      const button = byClass(container, "task-gantt-today")[0];
      dispatch(button, "click");

      // The default range already spans today (rangeStart=today-14,
      // rangeDays=90), so ensureDateInRange is a no-op here; the button's
      // own scroll-to-today behavior is what's under test.
      const todayIndex = datesOf(view).indexOf(todayStr());
      expect(todayIndex).toBeGreaterThanOrEqual(0);
      const dayWidth = (view as any).dayWidth as number;
      // scrollToDate's own math: max(0, index*dayWidth - offset).
      expect(wrap.scrollLeft).toBe(Math.max(0, todayIndex * dayWidth - 220));
    });

    it("「今日へ」ボタンは表示範囲外の今日を ensureDateInRange で取り込む", async () => {
      const { view, container } = await openView([]);
      // Force the range far away from today so ensureDateInRange must grow it.
      (view as any).rangeStart = addDays(todayStr(), 40);
      (view as any).rangeDays = 30;

      const button = byClass(container, "task-gantt-today")[0];
      dispatch(button, "click");

      expect((view as any).rangeStart <= todayStr()).toBe(true);
      expect(datesOf(view).includes(todayStr())).toBe(true);
    });

    it("「更新」ボタンで render() が呼ばれ、タスクが再読込される", async () => {
      const { container, h } = await openView([]);
      h.loadTasks.mockClear();
      const button = byClass(container, "task-gantt-refresh")[0];
      dispatch(button, "click");
      await flush();
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("「同期」ボタンで host.syncReadonlyGanttNow() が呼ばれる", async () => {
      const { container, h } = await openView([]);
      const button = byClass(container, "task-gantt-sync")[0];
      dispatch(button, "click");
      expect(h.syncReadonlyGanttNow).toHaveBeenCalledTimes(1);
    });

    it("Undo/Redo and zoom buttons are icon buttons with Japanese labels", async () => {
      const { container } = await openView([]);
      const expected: Array<[string, string, string]> = [
        ["task-gantt-undo", "undo-2", "元に戻す"],
        ["task-gantt-redo", "redo-2", "やり直す"],
        ["task-gantt-zoom-out", "minus", "縮小"],
        ["task-gantt-zoom-in", "plus", "拡大"],
      ];
      for (const [cls, icon, label] of expected) {
        const button = byClass(container, cls)[0];
        expect(button.classList.contains("clickable-icon")).toBe(true);
        expect(button.getAttribute("aria-label")).toBe(label);
        expect(button.title).toBe(label);
        expect(button.children[0].getAttribute("data-icon")).toBe(icon);
      }
    });

    it("Undo/Redo buttons delegate to their host actions", async () => {
      const { container, h } = await openView([]);

      dispatch(byClass(container, "task-gantt-undo")[0], "click");
      dispatch(byClass(container, "task-gantt-redo")[0], "click");

      expect(h.undoLastAction).toHaveBeenCalledTimes(1);
      expect(h.redoLastAction).toHaveBeenCalledTimes(1);
    });

    it("バージョン情報は releaseNotes を含む「※ v[version]: [notes]」形式で読み取り専用表示される", async () => {
      const { container } = await openView([]);
      const info = byClass(container, "task-gantt-version-info")[0];
      expect(info).toBeTruthy();
      // Default harness manifest: version 1.2.3 / releaseNotes 「テストリリースノート」.
      expect(info.textContent).toBe("※ v1.2.3: テストリリースノート");
      // Read-only: not a <button>, has no click listener wired.
      expect(info.tagName).not.toBe("BUTTON");
    });

    it("releaseNotes が無い場合は description にフォールバックする", async () => {
      const h = makeHostHarness([]);
      h.host.manifest = { version: "2.0.0", description: "説明文" };
      const view = new TaskGanttView({} as any, h.host);
      const container = (view as any).containerEl as FakeEl;
      await view.onOpen();

      const info = byClass(container, "task-gantt-version-info")[0];
      expect(info.textContent).toBe("※ v2.0.0: 説明文");
    });

    it("releaseNotes も description も無い場合は空文字列になる", async () => {
      const h = makeHostHarness([]);
      h.host.manifest = { version: "3.0.0" };
      const view = new TaskGanttView({} as any, h.host);
      const container = (view as any).containerEl as FakeEl;
      await view.onOpen();

      const info = byClass(container, "task-gantt-version-info")[0];
      expect(info.textContent).toBe("※ v3.0.0: ");
    });
  });





  describe("empty parent list", () => {
    it("shows the empty message, resets cache, keeps header, no add-row", async () => {
      // ganttEnabled:false parent → getGanttParentRows === [].
      const { view, container } = await openView([makeParent()]);
      const empties = byClass(container, "task-gantt-empty");
      expect(empties).toHaveLength(1);
      expect(empties[0].textContent).toBe(
        "ガント表示対象の親タスクがありません。親タスクの frontmatter / ダッシュボードで ganttEnabled を true にしてください。"
      );
      expect((view as any)._ganttRowCache).toBeUndefined();
      // Header rows still render when there are no parents.
      const wrap = wrapOf(container);
      expect(rowOf(wrap, "task-gantt-month-row")).toBeTruthy();
      expect(rowOf(wrap, "task-gantt-day-row")).toBeTruthy();
      expect(rowOf(wrap, "task-gantt-dow-row")).toBeTruthy();
      // No add-row element is rendered.
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(0);
    });

    it("shows the empty message when there are no tasks at all", async () => {
      const { container } = await openView([]);
      expect(byClass(container, "task-gantt-empty")).toHaveLength(1);
    });

    it("omits the empty message once a ganttEnabled parent exists", async () => {
      const { container } = await openView([
        makeParent({ ganttEnabled: true }),
      ]);
      expect(byClass(container, "task-gantt-empty")).toHaveLength(0);
    });
  });





  describe("parent row — LEFT column", () => {
    it("renders one row per parent; title = displayName || title", async () => {
      const named = makeParent({
        ganttEnabled: true,
        displayName: "Display Name",
        title: "Raw Title",
      });
      const untitled = makeParent({
        ganttEnabled: true,
        id: "tasks/parent-2.md",
        displayName: "",
        title: "Fallback Title",
      });
      const { container } = await openView([named, untitled]);
      const rows = parentRows(container);
      expect(rows).toHaveLength(2);

      const title1 = byClass(rows[0], "task-gantt-parent-title")[0];
      expect(title1.textContent).toBe("Display Name");
      const title2 = byClass(rows[1], "task-gantt-parent-title")[0];
      expect(title2.textContent).toBe("Fallback Title");

      // LEFT column width is the fixed PARENT_COL_WIDTH.
      expect(leftOf(rows[0]).style.width).toBe(`${PARENT_COL_WIDTH}px`);
    });

    it("colors the 4px left border by the primary tag; no border when tagless", async () => {
      const tagged = makeParent({ ganttEnabled: true, tags: ["backend"] });
      const tagless = makeParent({
        ganttEnabled: true,
        id: "tasks/p2.md",
        tags: [],
      });
      const { container } = await openView([tagged, tagless], {
        ganttTags: [tagDefinition("backend", "#123456")],
      });
      const rows = parentRows(container);

      const left1 = leftOf(rows[0]);
      expect(left1.classList.contains("has-tag-accent")).toBe(true);
      expect(styleVar(left1, "--vg-tag-accent")).toBe("#123456");

      const left2 = leftOf(rows[1]);
      expect(left2.classList.contains("has-tag-accent")).toBe(false);
      expect(styleVar(left2, "--vg-tag-accent")).toBeUndefined();
    });

    it("registry colors drive the left-border and tag chip colors", async () => {
      const tagged = makeParent({
        ganttEnabled: true,
        tags: ["backend", "frontend"],
      });
      const { container } = await openView([tagged], {
        ganttTags: [
          tagDefinition("backend", "#123456"),
          tagDefinition("frontend", ""),
        ],
      });
      const row = parentRows(container)[0];
      const left = leftOf(row);
      expect(styleVar(left, "--vg-tag-accent")).toBe("#123456");

      const chips = byClass(
        byClass(row, "task-gantt-parent-tags")[0],
        "task-gantt-parent-tag"
      );
      expect(chips[0].classList.contains("vg-chip")).toBe(true);
      expect(chips[0].classList.contains("is-tag")).toBe(true);
      expect(styleVar(chips[0], "--vg-chip-color")).toBe("#123456");
      // An explicitly colorless definition has no hash-color fallback.
      expect(styleVar(chips[1], "--vg-chip-color")).toBeUndefined();
    });

    it("shows at most 4 tag chips, each tinted by its own tag color", async () => {
      const tags = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
      const { container } = await openView([
        makeParent({ ganttEnabled: true, tags }),
      ], { ganttTags: tagRegistry(tags) });
      const row = parentRows(container)[0];
      const chipsContainer = byClass(row, "task-gantt-parent-tags")[0];
      expect(chipsContainer).toBeTruthy();
      const chips = byClass(chipsContainer, "task-gantt-parent-tag");
      expect(chips).toHaveLength(4);
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "alpha",
        "beta",
        "gamma",
        "delta",
      ]);
      chips.forEach((chip, i) => {
        const color = tagRegistry(tags)[i].color;
        expect(styleVar(chip, "--vg-chip-color")).toBe(color);
      });
    });

    it("hides tag chips when the tags feature is disabled", async () => {
      const { container } = await openView(
        [makeParent({ ganttEnabled: true, tags: ["a", "b"] })],
        {
          ganttFeatureTagsEnabled: false,
          ganttTags: [tagDefinition("a", "#abcdef")],
        }
      );
      const row = parentRows(container)[0];
      expect(byClass(row, "task-gantt-parent-tags")).toHaveLength(0);
      // The left border (a separate concern) still renders.
      expect(styleVar(leftOf(row), "--vg-tag-accent")).toBe("#abcdef");
    });

    it("marks the LEFT column draggable", async () => {
      const { container } = await openView([
        makeParent({ ganttEnabled: true }),
      ]);
      const left = leftOf(parentRows(container)[0]);
      expect(left.getAttribute("draggable")).toBe("true");
    });
  });

  describe("parent row — timeline background", () => {
    it("renders one background cell per date at index × dayWidth with today/weekend/holiday classes", async () => {
      const holiday = addDays(todayStr(), 3);
      const { view, container } = await openView(
        [makeParent({ ganttEnabled: true })],
        { ganttManualHolidays: [holiday] }
      );
      const timeline = timelineOf(parentRows(container)[0]);
      const dates = datesOf(view);
      const base = baseDateOf(view);
      const bgs = byClass(timeline, "task-gantt-bg");
      expect(bgs).toHaveLength(dates.length); // 90

      // Position: index × dayWidth (dayWidth = 28).
      expect(bgs[0].style.left).toBe("0px");
      expect(bgs[1].style.left).toBe("28px");
      expect(bgs[0].style.width).toBe("28px");

      // Today cell carries is-today.
      const todayIndex = dates.indexOf(todayStr());
      expect(todayIndex).toBe(diffDays(base, todayStr()));
      expect(bgs[todayIndex].classList.contains("is-today")).toBe(true);

      // A weekend cell carries is-weekend.
      const saturdayIndex = dates.findIndex(
        (d) => moment(d, "YYYY-MM-DD").day() === 6
      );
      expect(bgs[saturdayIndex].classList.contains("is-weekend")).toBe(true);

      // The manual holiday carries is-holiday.
      expect(
        bgs[dates.indexOf(holiday)].classList.contains("is-holiday")
      ).toBe(true);
    });

    it("the timeline width spans dates × dayWidth", async () => {
      const { view, container } = await openView([
        makeParent({ ganttEnabled: true }),
      ]);
      const timeline = timelineOf(parentRows(container)[0]);
      expect(timeline.style.width).toBe(`${datesOf(view).length * 28}px`);
    });
  });

  describe("parent row bars and row height", () => {
    async function barForTagRendering(
      subOverrides: Record<string, unknown> = {},
      parentOverrides: Record<string, unknown> = {},
      settingsOverrides: Record<string, unknown> = {}
    ): Promise<FakeEl> {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, ...parentOverrides }),
        [
          makeSubtask("s1", {
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 5),
            ...subOverrides,
          }),
        ]
      );
      const { container } = await openView([parent], settingsOverrides);
      return byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-bar"
      )[0];
    }

    it("positions bar left = diff×dayWidth, width = max(8, right-left)", async () => {
      const start = addDays(todayStr(), 2);
      const end = addDays(todayStr(), 8); // 7 days, wide enough to skip a label
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: start,
          plannedEndDate: end,
        }),
      ]);
      const { view, container } = await openView([parent]);
      const base = baseDateOf(view);
      const bar = byClass(timelineOf(parentRows(container)[0]), "task-gantt-bar")[0];

      const left = diffDays(base, start) * 28;
      const right = (diffDays(base, end) + 1) * 28 - 4;
      expect(bar.style.left).toBe(`${left}px`);
      expect(bar.style.width).toBe(`${Math.max(8, right - left)}px`);
    });

    it("renders invisible resize-edge cursor targets on every bar", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 5),
        }),
      ]);
      const { container } = await openView([parent]);
      const bar = byClass(timelineOf(parentRows(container)[0]), "task-gantt-bar")[0];

      expect(byClass(bar, "task-gantt-resize-start")).toHaveLength(1);
      expect(byClass(bar, "task-gantt-resize-end")).toHaveLength(1);
    });

    it("renders a subtask tag badge with the resolved tag color", async () => {
      const bar = await barForTagRendering(
        { tags: ["child-tag"] },
        { tags: ["parent-tag"] },
        {
          ganttTags: [
            tagDefinition("child-tag", "#111111"),
            tagDefinition("parent-tag", "#222222"),
          ],
        }
      );
      const badge = byClass(bar, "task-gantt-bar-tag-badge")[0];

      expect(badge.textContent).toBe("child-tag");
      expect(styleVar(badge, "--vg-chip-color")).toBe("#111111");
      expect(badge.classList.contains("vg-chip")).toBe(true);
      expect(bar.style.backgroundColor).toBe("#111111");
      // The bar title colour is fixed (white) regardless of the tag colour.
      expect(styleVar(bar, "--vg-bar-text")).toBeUndefined();
      expect(bar.style.borderColor).toBe("#111111");
    });

    it("uses the parent tag color but no badge when the subtask has no own tag", async () => {
      const bar = await barForTagRendering(
        { tags: [] },
        { tags: ["parent-tag"] },
        { ganttTags: [tagDefinition("parent-tag", "#222222")] }
      );

      expect(bar.style.backgroundColor).toBe("#222222");
      expect(bar.style.borderColor).toBe("#222222");
      expect(byClass(bar, "task-gantt-bar-tag-badge")).toHaveLength(0);
    });

    it("an explicitly colorless tag badge has no hash-color fallback", async () => {
      const bar = await barForTagRendering(
        { tags: ["colorless"] },
        {},
        { ganttTags: [tagDefinition("colorless", "")] }
      );
      const badge = byClass(bar, "task-gantt-bar-tag-badge")[0];

      expect(badge.textContent).toBe("colorless");
      expect(styleVar(badge, "--vg-chip-color")).toBeUndefined();
    });

    it("resolves a task tag by registry key after the tag is renamed", async () => {
      const bar = await barForTagRendering(
        { tags: ["legacy-key"] },
        {},
        {
          ganttTags: [
            tagDefinition("Renamed tag", "#334455", 0, "legacy-key"),
          ],
        }
      );
      const badge = byClass(bar, "task-gantt-bar-tag-badge")[0];

      expect(badge.textContent).toBe("Renamed tag");
      expect(styleVar(badge, "--vg-chip-color")).toBe("#334455");
    });

    it("renders no bar tag badge when neither task nor parent has a tag", async () => {
      const bar = await barForTagRendering({ tags: [] }, { tags: [] });

      expect(byClass(bar, "task-gantt-bar-tag-badge")).toHaveLength(0);
    });

    it("keeps a completed bar's tag badge under the completed-muted selector", async () => {
      const bar = await barForTagRendering({ completed: true, tags: ["done"] });
      const badge = byClass(bar, "task-gantt-bar-tag-badge")[0];

      expect(bar.classList.contains("is-completed")).toBe(true);
      expect(bar.classList.contains("is-tag-colored-completed")).toBe(true);
      expect(bar.style.backgroundColor).toBeTruthy();
      expect(bar.style.borderColor).toBeTruthy();
      expect(badge).toBeDefined();
    });

    it("omits a tag badge on a narrow bar because of the width gate", async () => {
      // Use the same same-day/dayWidth=4 fixture used elsewhere for an 8px
      // bar, but WITH a tag this time — proves BAR_TAG_BADGE_MIN_WIDTH_PX is
      // what suppresses the badge, not simply having no tag to show.
      const day = todayStr();
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: day,
          plannedEndDate: day,
          tags: ["urgent"],
        }),
      ]);
      const { container } = await openView([parent], { ganttZoom: 4 });
      const bar = byClass(timelineOf(parentRows(container)[0]), "task-gantt-bar")[0];
      expect(bar.style.width).toBe("8px");
      expect(byClass(bar, "task-gantt-bar-tag-badge")).toHaveLength(0);
    });

    it("renders a tag badge alongside an external label (bar wide enough for the badge but not the full title)", async () => {
      // Wide enough for the badge (168px ≥ 72px threshold) but the 60-char
      // title still needs to move outside because it exceeds the readable width.
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 5),
          tags: ["urgent"],
          displayName: "a".repeat(60),
        }),
      ]);
      const { container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const bar = byClass(timeline, "task-gantt-bar")[0];
      expect(byClass(timeline, "task-gantt-external-label")).toHaveLength(1);
      expect(byClass(bar, "task-gantt-bar-title")).toHaveLength(0);
      expect(byClass(bar, "task-gantt-bar-tag-badge")).toHaveLength(1);
    });

    it("floors the bar width at 8px for a tiny dayWidth and moves the title outside", async () => {
      // dayWidth = 4: a same-day bar has right-left = 1×4-4 = 0 → floored to 8.
      const day = todayStr();
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: day,
          plannedEndDate: day,
        }),
      ]);
      const { container } = await openView([parent], { ganttZoom: 4 });
      const timeline = timelineOf(parentRows(container)[0]);
      const bar = byClass(timeline, "task-gantt-bar")[0];
      expect(bar.style.width).toBe("8px");
      // At this narrow day width, the title cannot fit inside the bar, so
      // its label moves outside the bar.
      expect(byClass(timeline, "task-gantt-external-label")).toHaveLength(1);
      expect(byClass(bar, "task-gantt-bar-tag-badge")).toHaveLength(0);
    });

    it("two non-overlapping subtasks share lane 0 → row height = computeRowHeight(1, …)", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("a", {
          displayName: "A",
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 5),
        }),
        makeSubtask("b", {
          displayName: "B",
          plannedStartDate: addDays(todayStr(), 10),
          plannedEndDate: addDays(todayStr(), 15),
        }),
      ]);
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      const bars = byClass(timelineOf(row), "task-gantt-bar");
      expect(bars).toHaveLength(2);
      // Both bars sit at the same (top) lane offset.
      expect(bars[0].style.top).toBe(bars[1].style.top);
      // 1 lane, no markers / labels / deadline.
      expect(row.style.height).toBe(
        `${computeRowHeight(1, [0], [0], [0], false)}px`
      );
      expect(row.style.height).toBe("60px");
    });

    it("two overlapping subtasks open 2 lanes → a taller row", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("a", {
          displayName: "A",
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 10),
        }),
        makeSubtask("b", {
          displayName: "B",
          plannedStartDate: addDays(todayStr(), 5),
          plannedEndDate: addDays(todayStr(), 15),
        }),
      ]);
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      const bars = byClass(timelineOf(row), "task-gantt-bar");
      expect(bars).toHaveLength(2);
      // Different lanes → different vertical offsets.
      expect(bars[0].style.top).not.toBe(bars[1].style.top);
      expect(row.style.height).toBe(
        `${computeRowHeight(2, [0, 0], [0, 0], [0, 0], false)}px`
      );
      expect(row.style.height).toBe("104px");
    });

    it("a parent whose children lack dates renders no bars at minimal height (laneCount 1)", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("nodate"), // no planned dates → never becomes a bar
      ]);
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      expect(byClass(timelineOf(row), "task-gantt-bar")).toHaveLength(0);
      expect(row.style.height).toBe(
        `${computeRowHeight(1, [0], [0], [0], false)}px`
      );
    });
  });

  describe("parent row — markers", () => {
    it("positions a marker at x (centered on its date) below the bar and grows the row by a marker row", async () => {
      const markerDate = todayStr();
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 10),
          ganttMarkers: [{ key: "m1", title: "M", date: markerDate }],
        }),
      ]);
      const { view, container } = await openView([parent]);
      const base = baseDateOf(view);
      const row = parentRows(container)[0];
      const marker = byClass(timelineOf(row), "task-gantt-marker")[0];
      expect(marker).toBeTruthy();
      expect(byClass(marker, "task-gantt-marker-pin")[0].textContent).toBe("▲");
      expect(byClass(marker, "task-gantt-marker-label")[0].textContent).toBe("M");
      expect(byClass(marker, "task-gantt-marker-date")).toHaveLength(0);


      const expectedX = diffDays(base, markerDate) * 28 + 14;
      expect(marker.style.left).toBe(`${expectedX}px`);

      const bar = byClass(timelineOf(row), "task-gantt-bar")[0];
      expect(marker.style.top).toBe(
        `${Number.parseFloat(bar.style.top) + BAR_HEIGHT + 2}px`
      );

      // One marker row added to the height.
      expect(row.style.height).toBe(
        `${computeRowHeight(1, [0], [0], [1], false)}px`
      );
    });

    it("does not render a hover date element for a malformed marker date", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 10),
          ganttMarkers: [{ key: "m1", title: "M", date: "not-a-date" }],
        }),
      ]);
      const { container } = await openView([parent]);
      const marker = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-marker"
      )[0];
      expect(byClass(marker, "task-gantt-marker-date")).toHaveLength(0);
    });

    it("20+ markers on one bar stretch the row via marker-row distribution", async () => {
      const markers = Array.from({ length: 20 }, (_, i) => ({
        key: `m${i}`,
        title: "M",
        date: todayStr(),
      }));
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("s1", {
          displayName: "A",
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 10),
          ganttMarkers: markers,
        }),
      ]);
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      expect(byClass(timelineOf(row), "task-gantt-marker")).toHaveLength(20);
      // All 20 markers share one date (one x) → the 4px gap rule gives
      // each its own marker row, stretching the row vertically.
      expect(row.style.height).toBe(
        `${computeRowHeight(1, [0], [0], [20], false)}px`
      );
    });
  });

  describe("parent row — external labels", () => {
    it("a narrow bar gets a capped external label; a wide bar does not", async () => {
      // Narrow (1-day) bar + long title → needs a label.
      const narrowParent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [
          makeSubtask("narrow", {
            displayName: "Very Long Task Title Here",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
          }),
        ]
      );
      const { view, container } = await openView([narrowParent]);
      const base = baseDateOf(view);
      const row = parentRows(container)[0];
      const label = byClass(timelineOf(row), "task-gantt-external-label")[0];
      expect(label).toBeTruthy();

      // labelLeft = bar right edge + 8px.
      const barRight = (diffDays(base, todayStr()) + 1) * 28 - 4;
      expect(label.style.left).toBe(`${barRight + 8}px`);
      // First (only) top label sits just above the bar band: laneOffset(8) +
      // (topRows-1-row)×22 = 8.
      expect(label.style.top).toBe("8px");
      // cap.
      expect(label.style.maxWidth).toBe("340px");
      // Label text present.
      const text = byClass(label, "task-gantt-label-text")[0];
      expect(text.textContent).toBe("Very Long Task Title Here");
      expect(byClass(timelineOf(row), "task-gantt-external-connector")).toHaveLength(1);
      expect(byClass(timelineOf(row), "task-gantt-bar-title")).toHaveLength(0);
      // One top label row grew the height.
      expect(row.style.height).toBe(
        `${computeRowHeight(1, [1], [0], [0], false)}px`
      );

      // Wide bar + short title → no label.
      const wideParent = withChildren(
        makeParent({ ganttEnabled: true, id: "tasks/p2.md" }),
        [
          makeSubtask("wide", {
            displayName: "A",
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 20),
          }),
        ]
      );
      const wide = await openView([wideParent]);
      const wideRow = parentRows(wide.container)[0];
      expect(
        byClass(timelineOf(wideRow), "task-gantt-external-label")
      ).toHaveLength(0);
      expect(byClass(timelineOf(wideRow), "task-gantt-bar-title")[0].textContent).toBe("A");
    });

    it("gives tagged external labels their resolved tag border and leaves untagged labels transparent", async () => {
      const untaggedParent = withChildren(
        makeParent({ ganttEnabled: true, tags: [] }),
        [
          makeSubtask("untagged", {
            displayName: "Very Long Untagged Task Title",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
            tags: [],
          }),
        ]
      );
      const untagged = await openView([untaggedParent], { ganttTags: [] });
      const untaggedLabel = byClass(
        timelineOf(parentRows(untagged.container)[0]),
        "task-gantt-external-label"
      )[0];
      expect(untaggedLabel.classList.contains("is-tagged")).toBe(false);
      expect(untaggedLabel.style.borderColor).toBeUndefined();

      const taggedParent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["parent-tag"] }),
        [
          makeSubtask("tagged", {
            displayName: "Very Long Tagged Task Title",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
            tags: [],
          }),
        ]
      );
      const tagged = await openView([taggedParent], {
        ganttTags: [tagDefinition("parent-tag", "#123456")],
      });
      const taggedLabel = byClass(
        timelineOf(parentRows(tagged.container)[0]),
        "task-gantt-external-label"
      )[0];
      expect(taggedLabel.classList.contains("is-tagged")).toBe(true);
      expect(taggedLabel.style.borderColor).toBe("#123456");
    });

    it("keeps a title in-bar at the narrow-cell threshold boundary", async () => {
      // dayWidth=28, five days => width=136 and readableInsideWidth=122.
      // estimateTextWidth("abcdefghij")=98: the corrected check is 122 < 49,
      // which is false, so the title stays inside the bar.
      const title = "abcdefghij";
      expect(estimateTextWidth(title)).toBe(98);
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("boundary", {
          displayName: title,
          plannedStartDate: todayStr(),
          plannedEndDate: addDays(todayStr(), 4),
        }),
      ]);
      const { container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      expect(byClass(timeline, "task-gantt-external-label")).toHaveLength(0);
      expect(byClass(timeline, "task-gantt-external-connector")).toHaveLength(0);
      expect(byClass(timeline, "task-gantt-bar-title")[0].textContent).toBe(title);
    });

    it("renders a sane connector for a bottom-side external label", async () => {
      // As in the nearby label-packing fixture, the second non-overlapping
      // label is assigned to the bottom side after the first takes the top.
      const parent = withChildren(makeParent({ ganttEnabled: true, tags: [] }), [
        makeSubtask("top", {
          displayName: "Very Long Task Title Here",
          plannedStartDate: todayStr(),
          plannedEndDate: todayStr(),
        }),
        makeSubtask("bottom", {
          displayName: "Another Long Task Title Here",
          plannedStartDate: addDays(todayStr(), 4),
          plannedEndDate: addDays(todayStr(), 4),
        }),
      ]);
      const { container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const bars = byClass(timeline, "task-gantt-bar");
      const labels = byClass(timeline, "task-gantt-external-label");
      const connectors = byClass(timeline, "task-gantt-external-connector");
      expect(bars).toHaveLength(2);
      expect(labels).toHaveLength(2);
      expect(connectors).toHaveLength(2);

      const bottomBar = bars[1];
      const bottomBarRight =
        Number.parseFloat(bottomBar.style.left) +
        Number.parseFloat(bottomBar.style.width);
      const bottomLabel = labels.find(
        (label) => label.style.left === `${bottomBarRight + 8}px`
      );
      expect(bottomLabel).toBeTruthy();
      if (bottomLabel === undefined) return;

      const bottomBarLeft = Number.parseFloat(bottomBar.style.left);
      const bottomBarWidth = Number.parseFloat(bottomBar.style.width);
      const sourceX =
        bottomBarLeft +
        Math.max(6, Math.min(bottomBarWidth - 6, bottomBarWidth / 2));
      const sourceY =
        Number.parseFloat(bottomBar.style.top) +
        Number.parseFloat(bottomBar.style.height);
      const targetX = Number.parseFloat(bottomLabel.style.left);
      const targetY = Number.parseFloat(bottomLabel.style.top);
      const bendX =
        sourceX +
        (targetX >= sourceX ? 1 : -1) *
          Math.min(28, Math.max(10, Math.abs(targetX - sourceX) * 0.55));
      const bendY = targetY;
      // Independent geometric invariant: the elbow must stay within the
      // horizontal span between its endpoints, rather than overshooting.
      expect(bendX).toBeGreaterThan(Math.min(sourceX, targetX));
      expect(bendX).toBeLessThan(Math.max(sourceX, targetX));
      const minX = Math.min(sourceX, bendX, targetX) - 3;
      const maxX = Math.max(sourceX, bendX, targetX) + 3;
      const minY = Math.min(sourceY, bendY, targetY) - 3;
      const maxY = Math.max(sourceY, bendY, targetY) + 3;
      const bottomConnector = connectors.find(
        (connector) =>
          connector.style.left === `${minX}px` &&
          connector.style.top === `${minY}px`
      );
      expect(bottomConnector).toBeTruthy();
      if (bottomConnector === undefined) return;

      expect(targetY).toBeGreaterThan(Number.parseFloat(bottomBar.style.top));
      expect(bottomConnector.style.left).toBe(`${minX}px`);
      expect(bottomConnector.style.top).toBe(`${minY}px`);
      expect(bottomConnector.getAttribute("width")).toBe(
        String(Math.max(8, maxX - minX))
      );
      expect(bottomConnector.getAttribute("height")).toBe(
        String(Math.max(8, maxY - minY))
      );
      const polyline = bottomConnector.children.find(
        (child) => child.tagName === "POLYLINE"
      );
      expect(polyline).toBeTruthy();
      if (polyline === undefined) return;
      expect(polyline.getAttribute("points")).toBe(
        [
          `${sourceX - minX},${sourceY - minY}`,
          `${bendX - minX},${bendY - minY}`,
          `${targetX - minX},${targetY - minY}`,
        ].join(" ")
      );
    });

    it("the tag badge's width is included in row-packing, not just the title — a 3rd label that reuses row 0 without a badge needs a new row once a long badge is added", async () => {
      // Three short, non-overlapping one-day bars use positions 0, +4, and +6.
      // The third label exercises same-side packing: after top and bottom each
      // have one row, it either fits in the existing top row or needs another.
      // Including the badge width is necessary to make that decision correctly.
      const bars = (aTags: string[]): TaskRow[] =>
        [
          makeSubtask("a", {
            displayName: "AB",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
            tags: aTags,
          }),
          makeSubtask("b", {
            displayName: "CD",
            plannedStartDate: addDays(todayStr(), 4),
            plannedEndDate: addDays(todayStr(), 4),
            tags: [],
          }),
          makeSubtask("c", {
            displayName: "EF",
            plannedStartDate: addDays(todayStr(), 6),
            plannedEndDate: addDays(todayStr(), 6),
            tags: [],
          }),
        ];

      const noBadge = await openView([
        withChildren(makeParent({ ganttEnabled: true, tags: [] }), bars([])),
      ]);
      const noBadgeRow = parentRows(noBadge.container)[0];
      // Without a badge, C's labelLeft sits past A's bare-title labelRight,
      // so C reuses A's top row 0: 1 top row, 1 bottom row (B).
      expect(noBadgeRow.style.height).toBe(
        `${computeRowHeight(1, [1], [1], [0], false)}px`
      );

      const withBadge = await openView([
        withChildren(
          makeParent({ ganttEnabled: true, tags: [] }),
          bars(["AAAAAAAAAAAAAAAAAAAA"]) // long badge on the earliest bar
        ),
      ]);
      const withBadgeRow = parentRows(withBadge.container)[0];
      // With the badge counted in A's packed width, A's occupied extent now
      // reaches past C's labelLeft — row 0 is no longer free, so C is pushed
      // to a second top row, growing topRowCounts from 1 to 2.
      expect(withBadgeRow.style.height).toBe(
        `${computeRowHeight(1, [2], [1], [0], false)}px`
      );
      const labels = byClass(
        timelineOf(withBadgeRow),
        "task-gantt-external-label"
      );
      expect(labels).toHaveLength(3);
      // Displayed text stays bare (no badge text leaks into the title span).
      expect(byClass(labels[0], "task-gantt-label-text")[0].textContent).toBe(
        "AB"
      );
    });

    it("the label badge uses the subtask's own primary tag and ignores the parent's", async () => {
      // Subtask WITH its own tag → badge uses the subtask tag.
      const ownTagParent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["parentTag"] }),
        [
          makeSubtask("s1", {
            displayName: "Very Long Task Title Here",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
            tags: ["subtag"],
          }),
        ]
      );
      const { container } = await openView([ownTagParent], {
        ganttTags: [
          tagDefinition("subtag", "#445566"),
          tagDefinition("parentTag", "#556677"),
        ],
      });
      const ownBadge = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-label-badge"
      )[0];
      expect(ownBadge.textContent).toBe("subtag");
      expect(styleVar(ownBadge, "--vg-chip-color")).toBe("#445566");

      // Subtask WITHOUT a tag → parent tags do not create a name badge.
      const fallbackParent = withChildren(
        makeParent({ ganttEnabled: true, id: "tasks/p2.md", tags: ["parentTag"] }),
        [
          makeSubtask("s2", {
            displayName: "Very Long Task Title Here",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
            tags: [],
          }),
        ]
      );
      const fallback = await openView([fallbackParent], {
        ganttTags: [
          tagDefinition("subtag", "#445566"),
          tagDefinition("parentTag", "#556677"),
        ],
      });
      const fbBadge = byClass(
        timelineOf(parentRows(fallback.container)[0]),
        "task-gantt-label-badge"
      )[0];
      expect(fbBadge).toBeUndefined();
    });
  });

  describe("parent row — deadline marker", () => {
    it("renders a deadline marker at (dueDate - base)×dayWidth and adds MARKER_ROW_HEIGHT+6 to the height", async () => {
      const due = todayStr();
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { view, container } = await openView([parent]);
      const base = baseDateOf(view);
      const row = parentRows(container)[0];
      const deadline = byClass(
        timelineOf(row),
        "task-gantt-deadline-marker"
      )[0];
      expect(deadline).toBeTruthy();
      expect(deadline.style.left).toBe(`${diffDays(base, due) * 28}px`);
      // Height includes the deadline band.
      expect(row.style.height).toBe(
        `${computeRowHeight(1, [0], [0], [0], true)}px`
      );
      expect(row.style.height).toBe("82px");
      // Positioned in the bottom band (rowHeight - MARKER_ROW_HEIGHT - 6).
      expect(deadline.style.top).toBe(`${82 - MARKER_ROW_HEIGHT - 6}px`);
    });

    it("renders no deadline marker when the parent has no dueDate", async () => {
      const parent = makeParent({ ganttEnabled: true, dueDate: "" });
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      expect(
        byClass(timelineOf(row), "task-gantt-deadline-marker")
      ).toHaveLength(0);
      expect(row.style.height).toBe("60px");
    });

    it("renders a deadline marker only when dueDate is set", async () => {
      const withDue = makeParent({ ganttEnabled: true, dueDate: todayStr() });
      const withoutDue = makeParent({ ganttEnabled: true, dueDate: "" });
      const { container: c1 } = await openView([withDue]);
      const { container: c2 } = await openView([withoutDue]);
      expect(
        byClass(timelineOf(parentRows(c1)[0]), "task-gantt-deadline-marker")
      ).toHaveLength(1);
      expect(
        byClass(timelineOf(parentRows(c2)[0]), "task-gantt-deadline-marker")
      ).toHaveLength(0);
    });

    it("the marker's text is ★ + 「期限」label + M/D date", async () => {
      const due = addDays(todayStr(), 5);
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { container } = await openView([parent]);
      const deadline = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-deadline-marker"
      )[0];
      expect(
        byClass(deadline, "task-gantt-deadline-marker-star")[0].textContent
      ).toBe("★");
      expect(
        byClass(deadline, "task-gantt-deadline-marker-label")[0].textContent
      ).toBe("期限");
      expect(
        byClass(deadline, "task-gantt-deadline-marker-date")[0].textContent
      ).toBe(moment(due, "YYYY-MM-DD").format("M/D"));

      // space text nodes, not CSS margin alone, so copied/read text still
      // reads "★ 期限 8/25" rather than "★期限8/25".
      expect(deepText(deadline)).toBe(
        `★ 期限 ${moment(due, "YYYY-MM-DD").format("M/D")}`
      );
    });

    it("keeps drag and context-menu listeners on the whole deadline marker", async () => {
      const due = addDays(todayStr(), 5);
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { view, container } = await openView([parent]);
      const deadline = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-deadline-marker"
      )[0];
      const duePointerDownSpy = vi
        .spyOn(view as any, "onParentDuePointerDown")
        .mockImplementation(() => undefined);
      const contextMenuSpy = vi
        .spyOn(view as any, "openDeadlineMarkerContextMenu")
        .mockImplementation(() => undefined);

      const pointerEvent = dispatch(deadline, "pointerdown", {
        button: 0,
        clientX: 100,
        pointerId: 1,
      });
      const contextMenuEvent = dispatch(deadline, "contextmenu", {
        clientX: 100,
        clientY: 50,
      });

      expect(duePointerDownSpy).toHaveBeenCalledWith(
        pointerEvent,
        deadline,
        parent
      );
      expect(contextMenuSpy).toHaveBeenCalledWith(contextMenuEvent, parent);
    });

    it("hides the marker when the computed X falls past the visible timeline width", async () => {
      // rangeStart = today-14, rangeDays = 90 by default — +300 days is
      // comfortably past the end of the default range.
      const due = addDays(todayStr(), 300);
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      expect(
        byClass(timelineOf(row), "task-gantt-deadline-marker")
      ).toHaveLength(0);
    });

    it("hides the marker when the computed X is negative (before the visible range)", async () => {
      const due = addDays(todayStr(), -300);
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { container } = await openView([parent]);
      const row = parentRows(container)[0];
      expect(
        byClass(timelineOf(row), "task-gantt-deadline-marker")
      ).toHaveLength(0);
    });
  });

  describe("deadline marker context menu", () => {
    it("「期限を削除」clears the parent's dueDate with no confirmation dialog", async () => {
      const due = todayStr();
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { container, h } = await openView([parent]);
      const deadline = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-deadline-marker"
      )[0];
      dispatch(deadline, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("期限を削除"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(parent);
      expect(patch).toEqual({ dueDate: "" });
    });

    it("「ノートを開く」opens the parent task's note", async () => {
      const due = todayStr();
      const parent = makeParent({ ganttEnabled: true, dueDate: due });
      const { container, h } = await openView([parent]);
      const deadline = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-deadline-marker"
      )[0];
      dispatch(deadline, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("ノートを開く"), "click");

      expect(h.openTaskItem).toHaveBeenCalledWith(parent);
    });
  });

  describe("parent row — zoom recalculation", () => {
    it("recomputes bar, marker and label geometry from the new dayWidth on setZoom", async () => {
      // One narrow (1-day) bar with a long title (→ external label) and a
      // marker, so all three element types are present to observe.
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [
          makeSubtask("s1", {
            displayName: "Very Long Task Title Here",
            plannedStartDate: todayStr(),
            plannedEndDate: todayStr(),
            ganttMarkers: [{ key: "m1", title: "M", date: todayStr() }],
          }),
        ]
      );
      const { view, container } = await openView([parent]);
      const base = baseDateOf(view);
      const diff = diffDays(base, todayStr()); // 14

      const before = timelineOf(parentRows(container)[0]);
      expect(byClass(before, "task-gantt-bar")[0].style.left).toBe(
        `${diff * 28}px`
      );

      await (view as any).setZoom(56);

      const after = timelineOf(parentRows(container)[0]);
      // The bar's left position uses the new day width.
      const bar = byClass(after, "task-gantt-bar")[0];
      expect(bar.style.left).toBe(`${diff * 56}px`);
      // The bar width is max(8, 1 × 56 - 4), or 52px.
      expect(bar.style.width).toBe("52px");
      // The marker x-position uses the day center: diff × 56 + 56/2.
      expect(byClass(after, "task-gantt-marker")[0].style.left).toBe(
        `${diff * 56 + 28}px`
      );
      // The label starts 8px after the bar's right edge.
      expect(byClass(after, "task-gantt-external-label")[0].style.left).toBe(
        `${(diff + 1) * 56 - 4 + 8}px`
      );
    });
  });





  describe("fixed rows", () => {
    it("renders workload, event, dailyTodo in that order after the header and before the parent rows", async () => {
      const { container } = await openView([makeParent({ ganttEnabled: true })]);
      const wrap = wrapOf(container);
      const index = (cls: string): number => {
        const el = byClass(wrap, cls)[0];
        if (cls === "task-gantt-header" || cls === "task-gantt-parent-row") {
          return wrap.children.indexOf(el);
        }
        return wrap.children.indexOf(el.parentNode as FakeEl);
      };
      const header = index("task-gantt-header");
      const workload = index("task-gantt-workload-row");
      const event = index("task-gantt-event-row");
      const daily = index("task-gantt-daily-row");
      const parentRow = index("task-gantt-parent-row");
      expect(header).toBeGreaterThanOrEqual(0);
      expect(workload).toBeGreaterThan(header);
      expect(event).toBeGreaterThan(workload);
      expect(daily).toBeGreaterThan(event);
      expect(parentRow).toBeGreaterThan(daily);
    });

    it("renders each fixed row as a wrapper containing the left label and timeline", async () => {
      const { container } = await openView([]);
      const wrap = wrapOf(container);
      const expected = [
        [
          "task-gantt-workload-left",
          "task-gantt-workload-row",
          "作業時間 (実績/想定)",
          "左上: 実績 / 右下: 想定",
        ],
        [
          "task-gantt-event-left",
          "task-gantt-event-row",
          "その他",
          "右クリックで追加 / ドラッグで移動",
        ],
        [
          "task-gantt-daily-left",
          "task-gantt-daily-row",
          "Daily ToDo",
          "メインは空セルクリックで追加",
        ],
      ] as const;

      for (const [leftClass, timelineClass, titleText, subtitleText] of expected) {
        const left = byClass(wrap, leftClass)[0];
        const timeline = byClass(wrap, timelineClass)[0];
        const row = left.parentNode as FakeEl;
        expect(row).toBe(timeline.parentNode);
        expect(row.classList.contains("task-gantt-fixed-row")).toBe(true);
        expect(row.parentNode).toBe(wrap);
        expect(row.children.indexOf(left)).toBe(0);
        expect(row.children.indexOf(timeline)).toBe(1);
        expect(byClass(left, "task-gantt-fixed-title")[0].textContent).toBe(
          titleText
        );
        expect(
          byClass(left, "task-gantt-fixed-subtitle")[0].textContent
        ).toBe(subtitleText);
      }
    });

    it("the workload row is 52px (WORKLOAD_ROW_HEIGHT) with one summary cell per visible date and no data with zero parents", async () => {
      const { container, view } = await openView([]);
      const row = byClass(container, "task-gantt-workload-row")[0];
      expect(row).toBeTruthy();
      expect(row.style.height).toBe(`${WORKLOAD_ROW_HEIGHT}px`);
      expect(row.style.height).toBe("52px");


      const cells = byClass(row, "task-gantt-workload-summary-cell");
      const bgs = byClass(row, "task-gantt-fixed-bg");
      expect(cells.length).toBeGreaterThan(0);
      expect(bgs).toHaveLength(datesOf(view).length);
      expect(cells.length + bgs.length).toBe(row.children.length);
      // Zero parents → zero aggregated hours anywhere → no over-capacity/
      // actual-over-plan class on any cell.
      cells.forEach((cell) => {
        expect(cell.classList.contains("is-over-capacity")).toBe(false);
        expect(cell.classList.contains("is-actual-over-plan")).toBe(false);
      });
    });

    it("renders one classified fixed background cell per visible date behind each fixed-row content layer", async () => {
      useFridayClock();
      const holiday = addDays(todayStr(), 3);
      const { container, view } = await openView([], {
        ganttManualHolidays: [holiday],
      });
      const dates = datesOf(view);
      const weekend = dates.find(
        (date) =>
          date !== holiday &&
          [0, 6].includes(moment(date, "YYYY-MM-DD").day())
      );
      expect(weekend).toBeDefined();
      const weekendIndex = dates.indexOf(weekend!);
      const holidayIndex = dates.indexOf(holiday);

      for (const rowClass of [
        "task-gantt-workload-row",
        "task-gantt-event-row",
        "task-gantt-daily-row",
      ]) {
        const row = byClass(container, rowClass)[0];
        const bgs = byClass(row, "task-gantt-fixed-bg");
        expect(bgs).toHaveLength(dates.length);
        dates.forEach((_, index) => {
          expect(bgs[index].style.left).toBe(`${index * 28}px`);
          expect(bgs[index].style.width).toBe("28px");
        });
        expect(bgs[weekendIndex].classList.contains("is-weekend")).toBe(true);
        expect(bgs[holidayIndex].classList.contains("is-holiday")).toBe(true);
      }

      const workload = byClass(container, "task-gantt-workload-row")[0];
      const bg = byClass(workload, "task-gantt-fixed-bg")[0];
      const summary = byClass(workload, "task-gantt-workload-summary-cell")[0];
      expect(bg).not.toBe(summary);
      expect(workload.children.indexOf(bg)).toBeLessThan(
        workload.children.indexOf(summary)
      );
      expect(summary.style["--twb-workload-plan-ratio"]).toBe("0.0%");
      expect(summary.style["--twb-workload-actual-ratio"]).toBe("0.0%");
    });

    it("the empty event row is 44px tall and titled 「その他」", async () => {
      const { container, view } = await openView([]);
      const row = byClass(container, "task-gantt-event-row")[0];
      expect(row).toBeTruthy();
      // Math.max(44, 12 + rows × 24) with rows = 1 (zero events).
      expect(row.style.height).toBe("44px");
      expect(byClass(row, "task-gantt-event-label")).toHaveLength(0);
      expect(byClass(row, "task-gantt-fixed-bg")).toHaveLength(datesOf(view).length);
      expect(row.children).toHaveLength(datesOf(view).length);
      const left = byClass(container, "task-gantt-event-left")[0];
      expect(byClass(left, "task-gantt-fixed-title")[0].textContent).toBe(
        "その他"
      );
    });

    it("renders one packed chip per configured event and grows for overlapping rows", async () => {
      const { container } = await openView([], {
        ganttEvents: [
          { key: "e1", title: "会議", date: dateOffset(0) },
          { key: "e2", title: "レビュー", date: dateOffset(0) },
        ],
      });
      const row = byClass(container, "task-gantt-event-row")[0];

      expect(byClass(row, "task-gantt-event-chip")).toHaveLength(2);
      expect(byClass(row, "task-gantt-event-label").map((el) => el.textContent)).toEqual([
        "会議",
        "レビュー",
      ]);
      expect(row.style.height).toBe("60px");
      expect(byClass(row, "task-gantt-event-chip")[1].style.top).toBe("32px");
    });

    it("adds a default event on an empty timeline contextmenu", async () => {
      const { container, h, view } = await openView([]);
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const wrap = wrapOf(container);
      const expectedDate = addDays(
        baseDateOf(view),
        Math.floor(wrap.scrollLeft / 28)
      );

      const evt = dispatch(timeline, "contextmenu", { clientX: PARENT_COL_WIDTH });
      await flush();

      expect(evt.__defaultPrevented).toBe(true);
      expect(h.settings.ganttEvents).toHaveLength(1);
      expect(h.settings.ganttEvents[0]).toMatchObject({
        title: "新しいタスク",
        date: expectedDate,
      });
      expect(h.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("refreshes changed event data on the incremental path and keeps the fixed-row slot", async () => {
      const { container, view, h } = await openView(
        [makeParent({ ganttEnabled: true })],
        {
          incrementalGanttRender: true,
          ganttEvents: [{ key: "edit", title: "元の予定", date: dateOffset(0) }],
        }
      );
      const wrap = wrapOf(container);
      const oldTimeline = byClass(container, "task-gantt-event-row")[0];
      const oldWrapper = oldTimeline.parentNode as FakeEl;
      const fullRenderSpy = vi.spyOn(view as any, "renderChartFull");

      h.settings.ganttEvents[0].title = "更新後の予定";
      (view as any).renderChart();

      const newTimeline = byClass(container, "task-gantt-event-row")[0];
      const newWrapper = newTimeline.parentNode as FakeEl;
      expect(fullRenderSpy).not.toHaveBeenCalled();
      expect(newTimeline).not.toBe(oldTimeline);
      expect(oldWrapper.parentNode).toBeNull();
      expect(byClass(newTimeline, "task-gantt-event-label")[0].textContent).toBe(
        "更新後の予定"
      );
      expect(wrap.children.indexOf(newWrapper)).toBe(
        wrap.children.indexOf(byClass(container, "task-gantt-workload-row")[0].parentNode as FakeEl) + 1
      );
      expect((view as any).eventRowEl).toBe(newWrapper);
    });

    it("deletes an event from its context menu", async () => {
      const { container, h } = await openView([], {
        ganttEvents: [
          { key: "keep", title: "残す", date: dateOffset(0) },
          { key: "remove", title: "消す", date: dateOffset(1) },
        ],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[1];

      dispatch(chip, "contextmenu", { clientX: 320, clientY: 20 });
      dispatch(menuItemWithText("削除"), "click");
      await flush();

      expect(h.settings.ganttEvents).toEqual([
        { key: "keep", title: "残す", date: dateOffset(0) },
      ]);
      expect(h.saveSettings).toHaveBeenCalledTimes(1);
      expect(byClass(byClass(container, "task-gantt-event-row")[0], "task-gantt-event-chip")).toHaveLength(1);
    });

    it("commits an event title through the shared inline editor", async () => {
      const { container, h } = await openView([], {
        ganttEvents: [{ key: "edit", title: "元の予定", date: dateOffset(0) }],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[0];


      // double-click's dblclick is retargeted to the chip by the pointer
      // capture that onGanttEventPointerDown engages), so the fake-DOM
      // dispatch must target the chip too — a label-only dispatch no longer
      // reaches the handler.
      dispatch(chip, "dblclick");
      const input = byClass(chip, "task-gantt-inline-editor")[0];
      expect(input).toBeDefined();
      expect(input.style.position).toBe("absolute");
      expect(input.style.left).toBe("0px"); // label has no inline left; offsetLeft fallback is 0 in the fake DOM
      expect(input.focused).toBe(true);
      input.value = "新しい予定";
      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.settings.ganttEvents[0].title).toBe("新しい予定");
      expect(h.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("does not open the editor when double-clicking the label instead of the chip", async () => {
      const { container } = await openView([], {
        ganttEvents: [{ key: "edit", title: "元の予定", date: dateOffset(0) }],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[0];
      const label = byClass(chip, "task-gantt-event-label")[0];

      dispatch(label, "dblclick");
      expect(byClass(chip, "task-gantt-inline-editor")).toHaveLength(0);

      dispatch(chip, "dblclick");
      expect(byClass(chip, "task-gantt-inline-editor")).toHaveLength(1);
    });

    it("commits an event drag to the day under the pointer", async () => {
      const { view, container, h } = await openView([], {
        ganttEvents: [{ key: "drag", title: "移動", date: dateOffset(0) }],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[0];
      const winEl = (globalThis as any).window as FakeEl;
      const base = baseDateOf(view);
      const scrollLeft = wrapOf(container).scrollLeft;
      const originalX =
        PARENT_COL_WIDTH + diffDays(base, dateOffset(0)) * 28 + 14 - scrollLeft;
      const targetX =
        PARENT_COL_WIDTH + diffDays(base, dateOffset(2)) * 28 + 14 - scrollLeft;

      dispatch(chip, "pointerdown", { button: 0, clientX: originalX, pointerId: 1 });
      dispatch(winEl, "pointermove", { clientX: targetX, pointerId: 1 });
      dispatch(winEl, "pointerup", { clientX: targetX, pointerId: 1 });
      await flush();

      expect(h.settings.ganttEvents[0].date).toBe(dateOffset(2));
      expect(h.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("a plain click on an event chip (pointerdown+pointerup, no movement) does not change its date", async () => {
      const { container, h } = await openView([], {
        ganttEvents: [{ key: "click", title: "予定", date: dateOffset(0) }],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[0];
      const winEl = (globalThis as any).window as FakeEl;

      // Same clientX for down and up: a real click, zero pixel delta.
      dispatch(chip, "pointerdown", { button: 0, clientX: 500, pointerId: 1 });
      dispatch(winEl, "pointerup", { clientX: 500, pointerId: 1 });
      await flush();

      expect(h.settings.ganttEvents[0].date).toBe(dateOffset(0));
      expect(h.saveSettings).not.toHaveBeenCalled();
    });

    it("a canceled event drag (pointercancel) does not commit a date change", async () => {
      const { view, container, h } = await openView([], {
        ganttEvents: [{ key: "cancel", title: "予定", date: dateOffset(0) }],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[0];
      const winEl = (globalThis as any).window as FakeEl;
      const base = baseDateOf(view);
      const scrollLeft = wrapOf(container).scrollLeft;
      const originalX =
        PARENT_COL_WIDTH + diffDays(base, dateOffset(0)) * 28 + 14 - scrollLeft;
      const targetX =
        PARENT_COL_WIDTH + diffDays(base, dateOffset(3)) * 28 + 14 - scrollLeft;

      dispatch(chip, "pointerdown", { button: 0, clientX: originalX, pointerId: 1 });
      dispatch(winEl, "pointermove", { clientX: targetX, pointerId: 1 });
      dispatch(winEl, "pointercancel", { pointerId: 1 });
      await flush();

      expect(h.settings.ganttEvents[0].date).toBe(dateOffset(0));
      expect(h.saveSettings).not.toHaveBeenCalled();
      expect(chip.classList.contains("is-dragging")).toBe(false);

      // The cancel must also tear down the move/up listeners: a stray
      // pointerup for the same pointerId after cancel must be a no-op too.
      dispatch(winEl, "pointerup", { clientX: targetX, pointerId: 1 });
      await flush();
      expect(h.settings.ganttEvents[0].date).toBe(dateOffset(0));
      expect(h.saveSettings).not.toHaveBeenCalled();
    });

    it("pointerdown on an event chip while its title is mid-inline-edit does not start a drag", async () => {
      const { container, h } = await openView([], {
        ganttEvents: [{ key: "editing", title: "編集中", date: dateOffset(0) }],
      });
      const timeline = byClass(container, "task-gantt-event-row")[0];
      const chip = byClass(timeline, "task-gantt-event-chip")[0];
      const winEl = (globalThis as any).window as FakeEl;
      const originalLeft = chip.style.left;

      dispatch(chip, "dblclick");
      const input = byClass(chip, "task-gantt-inline-editor")[0];
      expect(input).toBeDefined();

      // A pointerdown that bubbles from the now-visible input up through the
      // chip must not arm a drag session while editing is active.
      dispatch(chip, "pointerdown", { button: 0, clientX: 999, pointerId: 7 });
      dispatch(winEl, "pointermove", { clientX: 1200, pointerId: 7 });
      dispatch(winEl, "pointerup", { clientX: 1200, pointerId: 7 });
      await flush();

      expect(h.settings.ganttEvents[0].date).toBe(dateOffset(0));
      expect(h.saveSettings).not.toHaveBeenCalled();
      expect(chip.style.left).toBe(originalLeft);
    });

    it("renders in-range Daily ToDo summaries as centered count chips and marks complete summaries", async () => {
      const inRangeDate = dateOffset(2);
      const outOfRangeDate = dateOffset(-15);
      const h = makeHostHarness([], {});
      h.loadDailyTodoSummaries.mockResolvedValue([
        {
          date: inRangeDate,
          items: [],
          completedCount: 2,
          totalCount: 2,
        },
        {
          date: dateOffset(3),
          items: [],
          completedCount: 1,
          totalCount: 3,
        },
        {
          date: outOfRangeDate,
          items: [],
          completedCount: 1,
          totalCount: 1,
        },
      ]);
      const view = new TaskGanttView({} as any, h.host);
      const container = (view as any).containerEl as FakeEl;
      await view.onOpen();

      const row = byClass(container, "task-gantt-daily-row")[0];
      const chips = byClass(row, "task-gantt-daily-chip");
      expect(chips).toHaveLength(2);
      expect(chips.map((chip) => chip.textContent)).toEqual(["2/2", "1/3"]);
      expect(chips[0].classList.contains("is-completed")).toBe(true);
      expect(chips[1].classList.contains("is-completed")).toBe(false);
      expect(chips[0].title).toBe("2/2 完了");
      expect(chips[0].style.left).toBe(
        `${diffDays(baseDateOf(view), inRangeDate) * 28 + 14}px`
      );
    });

    describe("Daily ToDo popover", () => {
      const PATH = "daily/2026-08-06.md";
      const todo = (
        line: number,
        text: string,
        completed = false,
        path = PATH
      ): DailyTodoItem => ({
        sourceKey: "main",
        sourceLabel: "デイリー",
        path,
        line,
        text,
        completed,
        isNew: false,
      });

      async function openWithItems(
        items: DailyTodoItem[],
        dateOffsetDays = 2
      ): Promise<{
        h: ReturnType<typeof makeHostHarness>;
        view: TaskGanttView;
        container: FakeEl;
        date: string;
        chip: FakeEl;
      }> {
        const date = dateOffset(dateOffsetDays);
        const h = makeHostHarness([]);
        h.loadDailyTodoSummaries.mockResolvedValue([
          {
            date,
            items,
            completedCount: items.filter((i) => i.completed).length,
            totalCount: items.length,
          },
        ]);
        const view = new TaskGanttView({} as any, h.host);
        const container = (view as any).containerEl as FakeEl;
        await view.onOpen();
        const chip = byClass(container, "task-gantt-daily-chip")[0];
        return { h, view, container, date, chip };
      }

      const popoverEl = (): FakeEl | undefined =>
        byClass(popoverBody(), "task-gantt-daily-todo-popover")[0];
      const rowsOf = (pop: FakeEl): FakeEl[] =>
        byClass(pop, "task-gantt-daily-todo-row");
      const inputOf = (row: FakeEl): FakeEl =>
        byClass(row, "task-gantt-daily-todo-input")[0];
      const checkOf = (row: FakeEl): FakeEl =>
        byClass(row, "task-gantt-daily-todo-check")[0];
      const moreOf = (row: FakeEl): FakeEl =>
        byClass(row, "task-gantt-daily-todo-more")[0];
      const addOf = (pop: FakeEl): FakeEl =>
        byClass(pop, "task-gantt-daily-todo-add")[0];

      it("public method reveals a date outside the range and opens an empty editor", async () => {
        const h = makeHostHarness([]);
        const view = new TaskGanttView({} as any, h.host);
        await view.onOpen();
        const date = dateOffset(180);
        await view.openDailyTodoPopoverForDate(date);
        const pop = popoverEl()!;
        expect(pop.attributes["data-date"]).toBe(date);
        expect(rowsOf(pop)).toHaveLength(0);
        const anchor = (view as any).dailyTodoAnchorEls.get(date) as FakeEl;
        expect(anchor.scrolledIntoView).toEqual({ block: "nearest", inline: "nearest", behavior: "instant" });
        expect((view as any).wrapEl.scrollLeft).toBe(
          (view as any).dates.indexOf(date) * (view as any).dayWidth - 220
        );
        dispatch(addOf(pop), "click");
        expect(rowsOf(pop)).toHaveLength(1);
      });

      it("public method reloads items and keeps the editor open on repeated calls", async () => {
        const { h, view, date } = await openWithItems([todo(3, "元の内容")]);
        await view.openDailyTodoPopoverForDate(date);
        h.loadDailyTodoSummaries.mockResolvedValue([{
          date, items: [todo(3, "外部更新")], completedCount: 0, totalCount: 1,
        }]);
        await view.openDailyTodoPopoverForDate(date);
        expect(inputOf(rowsOf(popoverEl()!)[0]).value).toBe("外部更新");
        expect((view as any).dailyTodoPopoverState.anchorEl).toBe(
          (view as any).dailyTodoAnchorEls.get(date)
        );
      });

      it("opens after scroll events and range extension replace the anchor", async () => {
        const { view, date } = await openWithItems([todo(3, "確認")], 0);
        const frames: Array<() => void> = [];
        vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return 1; });
        const scroll = view.scrollToDate.bind(view);
        vi.spyOn(view, "scrollToDate").mockImplementation((d, offset) => {
          scroll(d, offset);
          requestAnimationFrame(() => dispatch((view as any).wrapEl, "scroll"));
        });
        const opening = view.openDailyTodoPopoverForDate(date);
        await flush();
        for (let i = 0; i < 8; i++) {
          frames.splice(0).forEach((cb) => cb());
          await flush();
        }
        await opening;
        expect(popoverEl()!.attributes["data-date"]).toBe(date);
        expect((view as any).dailyTodoPopoverState.anchorEl).toBe(
          (view as any).dailyTodoAnchorEls.get(date)
        );
      });

      it("waits for focused edits to save before reloading and reopening", async () => {
        const { h, view, chip, date } = await openWithItems([todo(3, "元の内容")]);
        dispatch(chip, "click");
        inputOf(rowsOf(popoverEl()!)[0]).value = "編集内容";
        let release!: () => void;
        h.updateDailyTodoItem.mockImplementationOnce(async (item: DailyTodoItem) => {
          await new Promise<void>((resolve) => { release = resolve; });
          return { ...item, text: "編集内容" };
        });
        h.loadDailyTodoSummaries.mockClear();
        const opening = view.openDailyTodoPopoverForDate(date);
        await flush();
        expect(h.updateDailyTodoItem).toHaveBeenCalled();
        expect(h.loadDailyTodoSummaries).not.toHaveBeenCalled();
        expect(popoverEl()).toBeUndefined();
        h.loadDailyTodoSummaries.mockResolvedValue([{
          date, items: [todo(3, "編集内容")], completedCount: 0, totalCount: 1,
        }]);
        release();
        await opening;
        expect(inputOf(rowsOf(popoverEl()!)[0]).value).toBe("編集内容");
      });

      it("does not reopen after the view closes while waiting for layout", async () => {
        const { view, date } = await openWithItems([]);
        let frame!: () => void;
        vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frame = cb; return 1; });
        const opening = view.openDailyTodoPopoverForDate(date);
        await flush();
        await view.onClose();
        frame();
        await opening;
        expect(popoverEl()).toBeUndefined();
      });

      it("public method respects disabled Daily ToDo settings", async () => {
        const h = makeHostHarness([]);
        h.host.settings.ganttFeatureDailyTodoEnabled = false;
        const view = new TaskGanttView({} as any, h.host);
        await view.onOpen();
        await view.openDailyTodoPopoverForDate(dateOffset(0));
        expect(popoverEl()).toBeUndefined();
        expect(h.loadDailyTodoSummaries).not.toHaveBeenCalled();
        expect(Notice).toHaveBeenCalledWith("設定で「Daily ToDoを表示」を有効にしてください。");
      });

      it("opens a popover on chip click with [check][input][…] rows and a trailing +, without hover or modal", async () => {
        const { chip, date } = await openWithItems([
          todo(3, "資料を確認する"),
          todo(4, "議事録を送る", true),
        ]);

        dispatch(chip, "mouseenter");
        expect(popoverEl()).toBeUndefined();

        dispatch(chip, "click");
        const pop = popoverEl()!;
        expect(pop).toBeTruthy();
        expect(pop.parentNode).toBe(popoverBody());
        expect(pop.attributes["data-date"]).toBe(date);
        expect(pop.classList.contains("vg-popover")).toBe(true);
        const rows = rowsOf(pop);
        expect(rows).toHaveLength(2);
        expect(rows[0].children.map((c) => c.classList.contains("task-gantt-daily-todo-check"))).toEqual([true, false, false]);
        expect(rows[0].children[1].classList.contains("task-gantt-daily-todo-input")).toBe(true);
        expect(rows[0].children[2].classList.contains("task-gantt-daily-todo-more")).toBe(true);
        expect(rows[0].children[2].textContent).toBe("…");
        expect(inputOf(rows[0]).value).toBe("資料を確認する");
        expect(inputOf(rows[1]).value).toBe("議事録を送る");
        expect(checkOf(rows[0]).checked).toBe(false);
        expect(checkOf(rows[1]).checked).toBe(true);
        expect(addOf(pop).textContent).toBe("+");
        // The add button is the last element of the popover.
        expect(pop.children[pop.children.length - 1]).toBe(addOf(pop));
      });

      it("clicking the same chip again closes the popover", async () => {
        const { chip } = await openWithItems([todo(3, "項目")]);
        dispatch(chip, "click");
        expect(popoverEl()).toBeTruthy();
        dispatch(chip, "click");
        expect(popoverEl()).toBeUndefined();
      });

      it("opens an empty popover from a date cell with no ToDo, so a first item can be added", async () => {
        const { container } = await openWithItems([todo(3, "項目")]);
        const timeline = byClass(container, "task-gantt-daily-row")[0];
        const cells = byClass(timeline, "task-gantt-fixed-bg");
        // The first cell is far from the chip's date, so it has no ToDo.
        dispatch(cells[0], "click");
        const pop = popoverEl()!;
        expect(pop).toBeTruthy();
        expect(rowsOf(pop)).toHaveLength(0);
        expect(addOf(pop)).toBeTruthy();
      });

      it("saves a checkbox toggle immediately, keeps the popover open and updates the chip count without reloading", async () => {
        const { h, chip, container } = await openWithItems([
          todo(3, "資料を確認する"),
          todo(4, "議事録を送る"),
        ]);
        dispatch(chip, "click");
        const row = rowsOf(popoverEl()!)[0];
        h.loadDailyTodoSummaries.mockClear();

        checkOf(row).checked = true;
        dispatch(checkOf(row), "change");
        await flush();

        expect(h.updateDailyTodoItem).toHaveBeenCalledTimes(1);
        const [item, patch] = h.updateDailyTodoItem.mock.calls[0];
        expect(item.line).toBe(3);
        expect(patch).toEqual({ text: "資料を確認する", completed: true });
        expect(popoverEl()).toBeTruthy();
        expect(h.loadDailyTodoSummaries).not.toHaveBeenCalled();
        expect(byClass(container, "task-gantt-daily-chip")[0].textContent).toBe("1/2");
      });

      it("saves edited text on change, trimming it", async () => {
        const { h, chip } = await openWithItems([todo(3, "旧")]);
        dispatch(chip, "click");
        const row = rowsOf(popoverEl()!)[0];

        inputOf(row).value = "  新しい文言  ";
        dispatch(inputOf(row), "change");
        await flush();

        expect(h.updateDailyTodoItem.mock.calls[0][1]).toEqual({
          text: "新しい文言",
          completed: false,
        });
        expect(inputOf(row).value).toBe("新しい文言");
      });

      it("never saves a blank text: it reverts the input and leaves the note alone", async () => {
        const { h, chip } = await openWithItems([todo(3, "残す")]);
        dispatch(chip, "click");
        const row = rowsOf(popoverEl()!)[0];

        inputOf(row).value = "   ";
        dispatch(inputOf(row), "change");
        await flush();

        expect(h.updateDailyTodoItem).not.toHaveBeenCalled();
        expect(inputOf(row).value).toBe("残す");
      });

      it("+ appends a blank row and focuses its input; typing text then adds it to the note and shifts later lines", async () => {
        const { h, chip, container, view } = await openWithItems([
          todo(3, "既存A"),
          todo(120, "既存B"),
        ]);
        h.addDailyTodoItem.mockResolvedValueOnce(todo(50, "追加", false));
        dispatch(chip, "click");
        const pop = popoverEl()!;

        dispatch(addOf(pop), "click");
        expect(rowsOf(pop)).toHaveLength(3);
        const draft = rowsOf(pop)[2];
        expect(inputOf(draft).focused).toBe(true);
        // A second + while the blank row is empty reuses it.
        dispatch(addOf(pop), "click");
        expect(rowsOf(pop)).toHaveLength(3);

        // Nothing is written for a blank draft.
        dispatch(inputOf(draft), "change");
        await flush();
        expect(h.addDailyTodoItem).not.toHaveBeenCalled();

        inputOf(draft).value = "追加";
        dispatch(inputOf(draft), "change");
        await flush();
        expect(h.addDailyTodoItem).toHaveBeenCalledWith(
          (view as any).dailyTodoPopoverState.date,
          "追加",
          false
        );
        expect(byClass(container, "task-gantt-daily-chip")[0].textContent).toBe("0/3");

        // The note now has one more line above 既存B, so its stored line moved.
        const rowB = rowsOf(pop)[1];
        checkOf(rowB).checked = true;
        dispatch(checkOf(rowB), "change");
        await flush();
        expect(h.updateDailyTodoItem.mock.calls[0][0].line).toBe(121);
      });

      it("「…」 opens a menu with 開く and 削除; 開く opens the note at that ToDo and closes the popover", async () => {
        const { h, chip } = await openWithItems([todo(3, "資料を確認する")]);
        dispatch(chip, "click");
        const row = rowsOf(popoverEl()!)[0];

        dispatch(moreOf(row), "click");
        expect(menuItems().map((el) => deepText(el))).toEqual(["開く", "削除"]);
        // The popover survives the menu opening and clicks inside the menu.
        dispatch((window as any), "mousedown", { target: menuItemWithText("開く") });
        expect(popoverEl()).toBeTruthy();

        dispatch(menuItemWithText("開く"), "click");
        await flush();
        expect(h.openDailyTodoItem).toHaveBeenCalledTimes(1);
        expect(h.openDailyTodoItem.mock.calls[0][0].line).toBe(3);
        expect(popoverEl()).toBeUndefined();
      });

      it("削除 removes the line at once without a confirmation, updates the chip and shifts the lines below", async () => {
        const { h, chip, container } = await openWithItems([
          todo(3, "消す"),
          todo(4, "残す"),
        ]);
        dispatch(chip, "click");
        const pop = popoverEl()!;

        dispatch(moreOf(rowsOf(pop)[0]), "click");
        dispatch(menuItemWithText("削除"), "click");
        await flush();

        expect(h.deleteDailyTodoItem).toHaveBeenCalledTimes(1);
        expect(h.deleteDailyTodoItem.mock.calls[0][0].text).toBe("消す");
        expect(rowsOf(pop)).toHaveLength(1);
        expect(inputOf(rowsOf(pop)[0]).value).toBe("残す");
        expect(byClass(container, "task-gantt-daily-chip")[0].textContent).toBe("0/1");

        const keep = rowsOf(pop)[0];
        checkOf(keep).checked = true;
        dispatch(checkOf(keep), "change");
        await flush();
        expect(h.updateDailyTodoItem.mock.calls[0][0].line).toBe(3);
      });

      it("deleting the last ToDo removes the chip; deleting a never-saved row only drops the row", async () => {
        const { h, chip, container } = await openWithItems([todo(3, "唯一")]);
        dispatch(chip, "click");
        const pop = popoverEl()!;

        dispatch(addOf(pop), "click");
        dispatch(moreOf(rowsOf(pop)[1]), "click");
        dispatch(menuItemWithText("削除"), "click");
        await flush();
        expect(h.deleteDailyTodoItem).not.toHaveBeenCalled();
        expect(rowsOf(pop)).toHaveLength(1);

        dispatch(moreOf(rowsOf(pop)[0]), "click");
        dispatch(menuItemWithText("削除"), "click");
        await flush();
        expect(h.deleteDailyTodoItem).toHaveBeenCalledTimes(1);
        expect(byClass(container, "task-gantt-daily-chip")).toHaveLength(0);
        expect(popoverEl()).toBeTruthy();
      });

      it("when a save is rejected (the note changed) it reloads the ToDos from disk", async () => {
        const { h, chip } = await openWithItems([todo(3, "旧")]);
        dispatch(chip, "click");
        const pop = popoverEl()!;
        h.updateDailyTodoItem.mockResolvedValueOnce(false);
        h.loadDailyTodoSummaries.mockClear();
        h.loadDailyTodoSummaries.mockResolvedValue([
          {
            date: (pop.attributes as any)["data-date"],
            items: [todo(5, "最新")],
            completedCount: 0,
            totalCount: 1,
          },
        ]);

        inputOf(rowsOf(pop)[0]).value = "上書き";
        dispatch(inputOf(rowsOf(pop)[0]), "change");
        await flush();

        expect(h.loadDailyTodoSummaries).toHaveBeenCalledTimes(1);
        expect(rowsOf(pop)).toHaveLength(1);
        expect(inputOf(rowsOf(pop)[0]).value).toBe("最新");
      });

      it("closes on an outside mousedown or Escape, and saves text that was typed but not yet committed", async () => {
        const { h, chip, container } = await openWithItems([todo(3, "旧")]);
        dispatch(chip, "click");
        let pop = popoverEl()!;
        inputOf(rowsOf(pop)[0]).value = "未確定の入力";

        const outside = makeFakeEl("div");
        dispatch((window as any), "mousedown", { target: outside });
        await flush();
        expect(popoverEl()).toBeUndefined();
        expect(h.updateDailyTodoItem).toHaveBeenCalledTimes(1);
        expect(h.updateDailyTodoItem.mock.calls[0][1].text).toBe("未確定の入力");

        dispatch(byClass(container, "task-gantt-daily-chip")[0], "click");
        pop = popoverEl()!;
        // A mousedown inside the popover does not close it.
        dispatch((window as any), "mousedown", { target: inputOf(rowsOf(pop)[0]) });
        expect(popoverEl()).toBeTruthy();
        dispatch(pop, "keydown", { key: "Escape" });
        expect(popoverEl()).toBeUndefined();
      });

      it.each([0, 1])("waits for the old save before opening date offset %i with fresh lines", async (offset) => {
        const { h, chip, view, date } = await openWithItems([
          todo(3, "消す"), todo(4, "残す"),
        ]);
        const nextDate = addDays(date, offset);
        let release!: () => void;
        h.deleteDailyTodoItem.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => { release = resolve; });
          h.loadDailyTodoSummaries.mockResolvedValue([{
            date: nextDate, items: [todo(3, "外部更新済み")], completedCount: 0, totalCount: 1,
          }]);
          return true;
        });
        dispatch(chip, "click");
        const oldState = (view as any).dailyTodoPopoverState;
        dispatch(moreOf(rowsOf(popoverEl()!)[0]), "click");
        dispatch(menuItemWithText("削除"), "click");
        await flush();
        dispatch(popoverEl()!, "keydown", { key: "Escape" });
        (view as any).openDailyTodoPopover(nextDate, (view as any).dailyTodoAnchorEls.get(nextDate));
        expect(popoverEl()).toBeUndefined();
        expect(h.updateDailyTodoItem).not.toHaveBeenCalled();
        release();
        await flush();
        const row = rowsOf(popoverEl()!)[0];
        expect(inputOf(row).value).toBe("外部更新済み");
        // A detached model cannot restore its stale cached text or line.
        await (view as any).applyDailyTodoModel(oldState);
        expect((view as any).dailyTodoSummaries[0].items[0].text).toBe("外部更新済み");
        checkOf(row).checked = true;
        dispatch(checkOf(row), "change");
        await flush();
        expect(h.updateDailyTodoItem).toHaveBeenCalledTimes(1);
        expect(h.updateDailyTodoItem.mock.calls[0][0].line).toBe(3);
      });

      it.each([false, true])("keeps text typed while a save awaits (new row: %s)", async (newRow) => {
        const { h, chip } = await openWithItems([todo(3, "旧")]);
        dispatch(chip, "click");
        const pop = popoverEl()!;
        if (newRow) dispatch(addOf(pop), "click");
        const row = rowsOf(pop)[newRow ? 1 : 0];
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        if (newRow) {
          h.addDailyTodoItem.mockImplementationOnce(async (_date: string, text: string, completed: boolean) => {
            await pending;
            return todo(5, text, completed);
          });
        } else {
          h.updateDailyTodoItem.mockImplementationOnce(async (item: DailyTodoItem, patch: { text?: string; completed?: boolean }) => {
            await pending;
            Object.assign(item, patch);
            return true;
          });
        }
        inputOf(row).value = "保存対象";
        dispatch(inputOf(row), "change");
        await flush();
        inputOf(row).value = "保存対象に追記";
        release();
        await flush();
        expect(inputOf(row).value).toBe("保存対象に追記");
        dispatch(pop, "keydown", { key: "Escape" });
        await flush();
        expect(h.updateDailyTodoItem.mock.calls.at(-1)![1].text).toBe("保存対象に追記");
      });

      it("does not write untouched trailing whitespace on change or close", async () => {
        const { h, chip } = await openWithItems([todo(3, "文面  ")]);
        dispatch(chip, "click");
        const pop = popoverEl()!;
        dispatch(inputOf(rowsOf(pop)[0]), "change");
        await flush();
        dispatch(pop, "keydown", { key: "Escape" });
        await flush();
        expect(h.updateDailyTodoItem).not.toHaveBeenCalled();
      });

      it.each(["Escape", "outside"])("silently restores blank text when closing via %s", async (method) => {
        const { h, chip } = await openWithItems([todo(3, "残す")]);
        dispatch(chip, "click");
        const pop = popoverEl()!;
        const input = inputOf(rowsOf(pop)[0]);
        vi.mocked(Notice).mockClear();
        input.value = "  ";
        if (method === "Escape") dispatch(pop, "keydown", { key: "Escape" });
        else dispatch((window as any), "mousedown", { target: makeFakeEl("div") });
        await flush();
        expect(input.value).toBe("残す");
        expect(Notice).not.toHaveBeenCalled();
        expect(h.updateDailyTodoItem).not.toHaveBeenCalled();
      });

      it("still notifies about blank text when confirmed while open", async () => {
        const { chip } = await openWithItems([todo(3, "残す")]);
        dispatch(chip, "click");
        vi.mocked(Notice).mockClear();
        const input = inputOf(rowsOf(popoverEl()!)[0]);
        input.value = "";
        dispatch(input, "change");
        await flush();
        expect(Notice).toHaveBeenCalledWith("空欄にはできません。削除は「…」から行えます。");
      });

      it("closes on chart scroll", async () => {
        const { chip, container } = await openWithItems([todo(3, "項目")]);
        dispatch(chip, "click");
        const wrap = wrapOf(container);
        wrap.scrollLeft = 500;
        wrap.clientWidth = 100;
        wrap.scrollWidth = 10000;
        dispatch(wrap, "scroll");
        expect(popoverEl()).toBeUndefined();
      });

      it("keeps a tall popover inside the viewport", async () => {
        const { chip, view } = await openWithItems([todo(3, "項目")]);
        chip.getBoundingClientRect = () => ({
          left: 120,
          top: 40,
          right: 148,
          bottom: 60,
          width: 28,
          height: 20,
        });
        const winEl = (globalThis as any).window as FakeEl;
        winEl.innerHeight = 180;
        dispatch(chip, "click");
        const pop = popoverEl()!;
        Object.defineProperty(pop, "offsetHeight", { value: 140 });
        (view as any).positionDailyTodoPopover(chip);

        expect(pop.style.top).toBe("32px");
        expect(32 + 140).toBeLessThanOrEqual(180 - 8);
      });

      it("removes the body popover before incremental Daily ToDo row replacement", async () => {
        const { chip, view } = await openWithItems([todo(3, "項目")]);
        dispatch(chip, "click");
        expect(popoverEl()).toBeTruthy();

        (view as any).refreshDailyTodoRowIncremental();

        expect(popoverEl()).toBeUndefined();
        expect((view as any).dailyTodoPopoverState).toBeUndefined();
      });

      it("onClose removes the popover", async () => {
        const { chip, view } = await openWithItems([todo(3, "項目")]);
        dispatch(chip, "click");
        expect(popoverEl()).toBeTruthy();

        await view.onClose();

        expect((view as any).dailyTodoPopoverState).toBeUndefined();
        expect(popoverEl()).toBeUndefined();
      });
    });

    it("keeps the daily-todo row fixed at 44px", async () => {
      const { container, view } = await openView([]);
      const row = byClass(container, "task-gantt-daily-row")[0];
      expect(row).toBeTruthy();
      expect(row.style.height).toBe("44px");
      expect(byClass(row, "task-gantt-fixed-bg")).toHaveLength(datesOf(view).length);
      expect(row.children).toHaveLength(datesOf(view).length);
    });

    it("each fixed row is omitted when its own feature flag is disabled", async () => {
      const { container, h } = await openView([], {
        ganttFeatureWorkloadEnabled: false,
        ganttFeatureEventsEnabled: false,
        ganttFeatureDailyTodoEnabled: false,
      });
      expect(byClass(container, "task-gantt-workload-row")).toHaveLength(0);
      expect(byClass(container, "task-gantt-event-row")).toHaveLength(0);
      expect(byClass(container, "task-gantt-daily-row")).toHaveLength(0);
      expect(h.loadDailyTodoSummaries).not.toHaveBeenCalled();
      // The header is independent of these flags.
      expect(byClass(container, "task-gantt-header")).toHaveLength(1);
    });

    it("flags gate rows independently", async () => {
      const { container } = await openView([], {
        ganttFeatureWorkloadEnabled: false,
      });
      expect(byClass(container, "task-gantt-workload-row")).toHaveLength(0);
      expect(byClass(container, "task-gantt-event-row")).toHaveLength(1);
      expect(byClass(container, "task-gantt-daily-row")).toHaveLength(1);
    });

    it("fixed rows render even when there are zero Gantt-enabled parents", async () => {
      const { container } = await openView([makeParent()]); // ganttEnabled: false
      expect(byClass(container, "task-gantt-empty")).toHaveLength(1);
      expect(byClass(container, "task-gantt-workload-row")).toHaveLength(1);
      expect(byClass(container, "task-gantt-event-row")).toHaveLength(1);
      expect(byClass(container, "task-gantt-daily-row")).toHaveLength(1);
    });

    it("disabling ganttFeatureWorkloadEnabled hides the workload row (the only workload display this codebase has today) without touching the underlying task's workload data", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("sub-a", {
          plannedStartDate: "2026-08-01",
          plannedEndDate: "2026-08-03",
          workloadPlan: { "2026-08-01": 4 },
          workloadActual: { "2026-08-01": 2 },
        }),
      ]);
      const sub = parent.subtasks!.get("sub-a")!;

      const { container: disabledContainer } = await openView([parent], {
        ganttFeatureWorkloadEnabled: false,
      });
      expect(byClass(disabledContainer, "task-gantt-workload-row")).toHaveLength(0);
      // Disabling the feature does not delete or mutate workload data.
      expect(sub.workloadPlan).toEqual({ "2026-08-01": 4 });
      expect(sub.workloadActual).toEqual({ "2026-08-01": 2 });

      const { container: enabledContainer } = await openView([parent], {
        ganttFeatureWorkloadEnabled: true,
      });
      expect(byClass(enabledContainer, "task-gantt-workload-row")).toHaveLength(1);
      // Re-enabling still sees the unchanged workload data.
      expect(sub.workloadPlan).toEqual({ "2026-08-01": 4 });
      expect(sub.workloadActual).toEqual({ "2026-08-01": 2 });
    });
  });





  describe("parent add row", () => {
    it("renders the add row last: LEFT cell with 「新規親タスク」 + button, empty timeline", async () => {
      const { view, container } = await openView([
        makeParent({ ganttEnabled: true }),
      ]);
      const wrap = wrapOf(container);
      const wrappers = byClass(wrap, "task-gantt-parent-add-row");
      expect(wrappers).toHaveLength(1);
      // Last child of the chart.
      expect(wrap.children[wrap.children.length - 1]).toBe(wrappers[0]);

      const cell = byClass(wrappers[0], "task-gantt-parent-add-cell")[0];
      expect(cell).toBeTruthy();
      expect(cell.style.width).toBe(`${PARENT_COL_WIDTH}px`);
      expect(deepText(cell)).toContain("新規親タスク");
      const button = byClass(cell, "task-gantt-parent-add-button")[0];
      expect(button).toBeTruthy();
      expect(button.tagName).toBe("BUTTON");

      // Timeline cell: empty, spans dates × dayWidth.
      const timeline = byClass(
        wrappers[0],
        "task-gantt-parent-add-timeline"
      )[0];
      expect(timeline).toBeTruthy();
      expect(timeline.children).toHaveLength(0);
      expect(timeline.style.width).toBe(`${datesOf(view).length * 28}px`);
    });

    it("re-rendering never duplicates the add row (full-rebuild path)", async () => {
      const { view, container } = await openView([
        makeParent({ ganttEnabled: true }),
      ]);
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(1);

      (view as any).renderChart();
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(1);
      expect(
        byClass(container, "task-gantt-parent-add-timeline")
      ).toHaveLength(1);
      expect(byClass(container, "task-gantt-parent-add-row")).toHaveLength(1);

      (view as any).renderChart();
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(1);
    });

    it("deduplicates the add row on the incremental path", async () => {
      const { view, container } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender: true }
      );
      expect((view as any)._ganttRowCache).toBeDefined();
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(1);

      // Second render takes the incremental path (nothing changed) — the
      // dedupe must still keep exactly one add row.
      (view as any).renderChart();
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(1);
      expect(
        byClass(container, "task-gantt-parent-add-timeline")
      ).toHaveLength(1);
      expect(byClass(container, "task-gantt-parent-add-row")).toHaveLength(1);
    });

    it("clicking the button opens a menu; 「新しく親タスクを作る」 delegates to host.createGanttParentInteractively and re-renders", async () => {
      const h = makeHostHarness([makeParent({ ganttEnabled: true })]);
      const createSpy = vi.fn(async () => undefined);
      h.host.createGanttParentInteractively = createSpy;
      const view = new TaskGanttView({} as any, h.host);
      const container = (view as any).containerEl as FakeEl;
      await view.onOpen();

      const button = byClass(container, "task-gantt-parent-add-button")[0];
      dispatch(button, "click"); // opens the menu, does not call anything yet
      expect(createSpy).not.toHaveBeenCalled();

      h.loadTasks.mockClear();
      dispatch(menuItemWithText("新しく親タスクを作る"), "click");
      await flush();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("「新しく親タスクを作る」 warns loudly when the host omits createGanttParentInteractively", async () => {
      const { h, container } = await openView([makeParent({ ganttEnabled: true })]);
      const button = byClass(container, "task-gantt-parent-add-button")[0];
      dispatch(button, "click");
      dispatch(menuItemWithText("新しく親タスクを作る"), "click");
      await flush();
      expect(h.host.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.host.logger.warn).toHaveBeenCalledWith(
        "TaskGanttView",
        expect.stringContaining("createGanttParentInteractively")
      );
    });

    it("「既存タスクから選ぶ」 opens the picker with disabled parents and enables the chosen parent", async () => {
      const disabled1 = makeParent({
        id: "tasks/disabled-1.md",
        ganttEnabled: false,
      });
      const disabled2 = makeParent({
        id: "tasks/disabled-2.md",
        ganttEnabled: false,
      });
      const enabled = makeParent({
        id: "tasks/enabled.md",
        ganttEnabled: true,
      });
      const { h, container } = await openView([disabled1, disabled2, enabled]);
      const button = byClass(container, "task-gantt-parent-add-button")[0];
      dispatch(button, "click");
      dispatch(menuItemWithText("既存タスクから選ぶ"), "click");

      expect(h.openGanttParentPicker).toHaveBeenCalledTimes(1);
      const [items, onChoose] = h.openGanttParentPicker.mock.calls[0];
      expect(items).toHaveLength(2);
      expect(items).toEqual(
        expect.arrayContaining([disabled1, disabled2])
      );
      expect(items).not.toEqual(expect.arrayContaining([enabled]));

      h.loadTasks.mockClear();
      await onChoose(disabled1);
      await flush();

      // only `enabled` is currently ganttEnabled:true and has no explicit
      // ganttOrder, so it falls back to 999999 and the
      // new order is 999999 + 1000 = 1000999.
      expect(h.updateTaskItem).toHaveBeenCalledWith(disabled1, {
        ganttEnabled: true,
        ganttOrder: 1000999,
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("a failed enableParentInGantt save is logged and still re-renders (mirrors saveTaskPatch's failure handling)", async () => {
      const disabled1 = makeParent({
        id: "tasks/disabled-1.md",
        ganttEnabled: false,
      });
      const enabled = makeParent({
        id: "tasks/enabled.md",
        ganttEnabled: true,
      });
      const { h, container } = await openView([disabled1, enabled]);
      h.updateTaskItem.mockRejectedValue(
        Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" })
      );
      const button = byClass(container, "task-gantt-parent-add-button")[0];
      dispatch(button, "click");
      dispatch(menuItemWithText("既存タスクから選ぶ"), "click");
      const [, onChoose] = h.openGanttParentPicker.mock.calls[0];

      h.loadTasks.mockClear();
      await onChoose(disabled1);
      await flush();

      expect(h.host.logger.error).toHaveBeenCalledWith(
        "TaskGanttView",
        expect.stringContaining("failed to enable existing parent"),
        expect.any(Error)
      );
      expect(h.loadTasks).toHaveBeenCalledTimes(1); // render runs on failure too
    });
  });





  describe("incremental rendering", () => {
    it("the full-render escape hatch keeps the cache disabled", async () => {
      const { view, container } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender: false }
      );
      expect((view as any)._ganttRowCache).toBeUndefined();
      const firstRow = parentRows(container)[0];

      (view as any).renderChart();
      expect((view as any)._ganttRowCache).toBeUndefined();
      // Full rebuild: the row element was recreated, not reused.
      expect(parentRows(container)[0]).not.toBe(firstRow);
    });

    it("the cache is populated (rootEl, fingerprint, per-parent maps) only when incrementalGanttRender is true", async () => {
      const parent = makeParent({ ganttEnabled: true });
      const { view, container } = await openView([parent], {
        incrementalGanttRender: true,
      });
      const cache = (view as any)._ganttRowCache;
      expect(cache).toBeDefined();
      expect(cache.rootEl).toBe(wrapOf(container));
      expect(typeof cache.headerFingerprint).toBe("string");
      expect(cache.rowEls.size).toBe(1);
      expect(cache.rowFingerprints.size).toBe(1);
      expect(cache.rowEls.get(parent.file.path)).toBe(parentRows(container)[0]);
      expect(cache.rowFingerprints.get(parent.file.path)).toBe(
        computeRowFingerprint(parent)
      );
    });

    it("calendar-day rollover invalidates the incremental cache so today styling is rebuilt", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2026, 7, 23, 12, 0, 0));
        const { view, container } = await openView(
          [makeParent({ ganttEnabled: true })],
          { incrementalGanttRender: true }
        );
        const oldToday = (view as any).todayForRender;
        const oldRow = parentRows(container)[0];
        const fullRenderSpy = vi.spyOn(view as any, "renderChartFull");

        vi.setSystemTime(new Date(2026, 7, 24, 12, 0, 0));
        (view as any).renderChart();

        expect((view as any).todayForRender).not.toBe(oldToday);
        expect(fullRenderSpy).toHaveBeenCalledTimes(1);
        expect(parentRows(container)[0]).not.toBe(oldRow);
      } finally {
        vi.useRealTimers();
      }
    });

    it("an unchanged parent reuses the SAME DOM element (zero DOM touch)", async () => {
      const a = makeParent({ ganttEnabled: true, ganttOrder: 1 });
      const b = makeParent({
        ganttEnabled: true,
        ganttOrder: 2,
        id: "tasks/p2.md",
        file: { path: "tasks/p2.md" },
      });
      const { view, container } = await openView([a, b], {
        incrementalGanttRender: true,
      });
      const wrap = wrapOf(container);
      const [rowA, rowB] = parentRows(container);
      const indexA = wrap.children.indexOf(rowA);

      (view as any).renderChart();

      const [rowA2, rowB2] = parentRows(container);
      expect(rowA2).toBe(rowA); // identity preserved
      expect(rowB2).toBe(rowB);
      // …at the same position.
      expect(wrap.children.indexOf(rowA2)).toBe(indexA);
    });

    it("a changed parent gets a NEW element in the SAME slot; the old element is detached", async () => {
      const a = makeParent({ ganttEnabled: true, ganttOrder: 1 });
      const b = makeParent({
        ganttEnabled: true,
        ganttOrder: 2,
        id: "tasks/p2.md",
        file: { path: "tasks/p2.md" },
        displayName: "Original B",
      });
      const c = makeParent({
        ganttEnabled: true,
        ganttOrder: 3,
        id: "tasks/p3.md",
        file: { path: "tasks/p3.md" },
      });
      const { view, container } = await openView([a, b, c], {
        incrementalGanttRender: true,
      });
      const wrap = wrapOf(container);
      const [rowA, rowB, rowC] = parentRows(container);

      // Mutate only B's row fingerprint (displayName is in it; the header
      // fingerprint — parentPaths/order — is untouched).
      (b as any).displayName = "Changed B";
      (view as any).renderChart();

      const rows = parentRows(container);
      expect(rows).toHaveLength(3);
      // Unchanged rows keep their identity.
      expect(rows[0]).toBe(rowA);
      expect(rows[2]).toBe(rowC);
      // B was replaced…
      expect(rows[1]).not.toBe(rowB);
      // …the old element is detached…
      expect(rowB.parentNode).toBeNull();
      // …and the new one landed in B's slot, not at the end.
      expect(wrap.children.indexOf(rows[1])).toBe(
        wrap.children.indexOf(rowA) + 1
      );
      expect(wrap.children.indexOf(rowC)).toBe(
        wrap.children.indexOf(rows[1]) + 1
      );
      // The cache now references the new element + fingerprint.
      const cache = (view as any)._ganttRowCache;
      expect(cache.rowEls.get("tasks/p2.md")).toBe(rows[1]);
      expect(cache.rowFingerprints.get("tasks/p2.md")).toBe(
        computeRowFingerprint(b)
      );
    });

    it("a tag-filter-hidden parent that becomes visible again lands in its correct sorted slot, not appended at the end", async () => {
      // parentPaths in computeHeaderFingerprint lists every ganttEnabled
      // parent BEFORE tag-filter visibility is applied, so B regaining a
      // matching tag does NOT change the header fingerprint — B has no
      // cache entry (it was hidden, never rendered) even though the cache
      // otherwise still looks valid. Without the full-rebuild bailout this
      // would append B after C instead of between A and C.
      const a = makeParent({
        ganttEnabled: true,
        ganttOrder: 1,
        tags: ["work"],
      });
      const b = makeParent({
        ganttEnabled: true,
        ganttOrder: 2,
        id: "tasks/p2.md",
        file: { path: "tasks/p2.md" },
        tags: [], // starts filtered out
      });
      const c = makeParent({
        ganttEnabled: true,
        ganttOrder: 3,
        id: "tasks/p3.md",
        file: { path: "tasks/p3.md" },
        tags: ["work"],
      });
      const { view, container } = await openView([a, b, c], {
        incrementalGanttRender: true,
      });
      (view as any).activeTagFilter = new Set(["work"]);
      (view as any).renderChart();

      // B starts hidden: only A and C render.
      expect(parentRows(container)).toHaveLength(2);

      // B gains the matching tag — header fingerprint (parentPaths/order/
      // filter) is unchanged, so this exercises the incremental path.
      (b as any).tags = ["work"];
      (view as any).renderChart();

      const rows = parentRows(container);
      expect(rows).toHaveLength(3);
      // B must land between A and C (ganttOrder 1/2/3), not after C.
      const wrap = wrapOf(container);
      expect(wrap.children.indexOf(rows[0])).toBeLessThan(
        wrap.children.indexOf(rows[1])
      );
      expect(wrap.children.indexOf(rows[1])).toBeLessThan(
        wrap.children.indexOf(rows[2])
      );
      // Confirm B is specifically the middle row via the cache, which is
      // authoritative post-render regardless of how the bailout rebuilt.
      const cache = (view as any)._ganttRowCache;
      expect(wrap.children.indexOf(cache.rowEls.get("tasks/p2.md"))).toBe(
        wrap.children.indexOf(rows[0]) + 1
      );
    });

    it("a dayWidth change invalidates the header fingerprint → full rebuild even with incremental enabled", async () => {
      const { view, container } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender: true }
      );
      const cacheBefore = (view as any)._ganttRowCache;
      const rowBefore = parentRows(container)[0];

      await (view as any).setZoom(56); // renderChart inside

      const cacheAfter = (view as any)._ganttRowCache;
      expect(cacheAfter.headerFingerprint).not.toBe(
        cacheBefore.headerFingerprint
      );
      // Full rebuild: new row element.
      expect(parentRows(container)[0]).not.toBe(rowBefore);
    });

    it("skips workload aggregation on pure zoom while updating row geometry", async () => {
      const targetDate = weekdayDateOffset(0);
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("work", {
          plannedStartDate: targetDate,
          plannedEndDate: targetDate,
          workloadPlan: { [targetDate]: 3 },
        }),
      ]);
      const { view, container } = await openView([parent], {
        incrementalGanttRender: true,
      });
      const computeSpy = vi.spyOn(
        view as any,
        "computeWorkloadSummaryValues"
      );

      await (view as any).setZoom(56);

      expect(computeSpy).not.toHaveBeenCalled();
      const cell = byClass(container, "task-gantt-workload-summary-cell").find(
        (candidate) => candidate.attributes["data-date"] === targetDate
      );
      expect(cell).toBeDefined();
      expect(
        byClass(cell as FakeEl, "task-gantt-workload-summary-plan")[0]
          .textContent
      ).toBe("3h");
      expect((cell as FakeEl).style.width).toBe("56px");
    });

    it("rebuilds workload values when a task workload map changes", async () => {
      const targetDate = weekdayDateOffset(0);
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("work", {
          plannedStartDate: targetDate,
          plannedEndDate: targetDate,
          workloadPlan: { [targetDate]: 2 },
        }),
      ]);
      const { view, container } = await openView([parent], {
        incrementalGanttRender: true,
      });
      const subtask = parent.subtasks!.get("work")!;
      const computeSpy = vi.spyOn(view as any, "computeWorkloadSummaryValues");

      subtask.workloadPlan = { [targetDate]: 5 };
      (view as any).renderChart();

      expect(computeSpy).toHaveBeenCalledTimes(1);
      const cell = byClass(container, "task-gantt-workload-summary-cell").find(
        (candidate) => candidate.attributes["data-date"] === targetDate
      );
      expect(
        byClass(cell as FakeEl, "task-gantt-workload-summary-plan")[0]
          .textContent
      ).toBe("5h");
    });

    it("recomputes workload values for new dates after a horizontal range extension", async () => {
      const targetDate = weekdayDateOffset(80);
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeSubtask("extended", {
          plannedStartDate: todayStr(),
          plannedEndDate: targetDate,
          workloadPlan: { [targetDate]: 4 },
        }),
      ]);
      const { view, container } = await openView([parent], {
        incrementalGanttRender: true,
      });
      const computeSpy = vi.spyOn(view as any, "computeWorkloadSummaryValues");
      const wrap = wrapOf(container);
      wrap.scrollLeft = 1000;
      wrap.clientWidth = 100;
      wrap.scrollWidth = 1000;

      dispatch(wrap, "scroll");

      expect(computeSpy).toHaveBeenCalledTimes(1);
      const cell = byClass(container, "task-gantt-workload-summary-cell").find(
        (candidate) => candidate.attributes["data-date"] === targetDate
      );
      expect(cell).toBeDefined();
      expect(
        byClass(cell as FakeEl, "task-gantt-workload-summary-plan")[0]
          .textContent
      ).toBe("4h");
    });

    it("holiday and parent-order changes force a full rebuild under incremental mode", async () => {
      const a = makeParent({
        ganttEnabled: true,
        ganttOrder: 1,
        displayName: "Alpha",
      });
      const b = makeParent({
        ganttEnabled: true,
        ganttOrder: 2,
        id: "tasks/p2.md",
        file: { path: "tasks/p2.md" },
        displayName: "Bravo",
      });
      const { view, container, h } = await openView([a, b], {
        incrementalGanttRender: true,
      });
      const rowsBefore = parentRows(container);

      // Swapping ganttOrder changes the order of parent paths.
      (a as any).ganttOrder = 9;
      (view as any).renderChart();
      const rowsAfter = parentRows(container);
      expect(rowsAfter[0]).not.toBe(rowsBefore[0]); // full rebuild
      // …and b now sorts first.
      const titles = rowsAfter.map(
        (r) => byClass(r, "task-gantt-parent-title")[0].textContent
      );
      expect(titles[0]).toBe(b.displayName);

      // Changing the holiday list also invalidates the cache.
      const first = parentRows(container)[0];
      h.settings.ganttManualHolidays.push(dateOffset(7));
      (view as any).renderChart();
      expect(parentRows(container)[0]).not.toBe(first);
    });

    it("a detached cache root (isConnected false) forces a full rebuild", async () => {
      const { view } = await openView([makeParent({ ganttEnabled: true })], {
        incrementalGanttRender: true,
      });
      const wrap = (view as any).wrapEl as FakeEl;
      const cacheBefore = (view as any)._ganttRowCache;
      const rowBefore = byClass(wrap, "task-gantt-parent-row")[0];
      expect(cacheBefore.rootEl).toBe(wrap);

      // Detach the chart root from its container.
      wrap.remove();
      expect(wrap.isConnected).toBe(false);

      (view as any).renderChart();

      // Gate condition 4 failed → full rebuild INTO the same wrapEl, with
      // a freshly populated cache.
      const cacheAfter = (view as any)._ganttRowCache;
      expect(cacheAfter).toBeDefined();
      expect(cacheAfter.rootEl).toBe(wrap);
      expect(cacheAfter).not.toBe(cacheBefore);
      expect(byClass(wrap, "task-gantt-parent-row")[0]).not.toBe(rowBefore);
    });

    it("detached fixed rows force a full rebuild instead of appending out of order", async () => {
      const { view, container } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender: true }
      );
      const oldWorkloadRow = (view as any).workloadSummaryRowEl as FakeEl;
      const fullRenderSpy = vi.spyOn(view as any, "renderChartFull");
      oldWorkloadRow.remove();

      (view as any).renderChart();

      expect(fullRenderSpy).toHaveBeenCalledTimes(1);
      const newWorkloadRow = byClass(container, "task-gantt-workload-row")[0];
      expect(newWorkloadRow.parentNode).toBe(wrapOf(container).children[1]);
      expect(newWorkloadRow).not.toBe(oldWorkloadRow);
    });

    it("disabling incrementalGanttRender after cache population → full rebuild and the cache is dropped", async () => {
      const { view, container, h } = await openView(
        [makeParent({ ganttEnabled: true })],
        { incrementalGanttRender: true }
      );
      expect((view as any)._ganttRowCache).toBeDefined();
      const rowBefore = parentRows(container)[0];

      h.settings.incrementalGanttRender = false;
      (view as any).renderChart();

      expect(parentRows(container)[0]).not.toBe(rowBefore);
      expect((view as any)._ganttRowCache).toBeUndefined();
    });

    it("parents disappearing to zero resets the cache (incremental mode)", async () => {
      const parent = makeParent({ ganttEnabled: true });
      const { view, container } = await openView([parent], {
        incrementalGanttRender: true,
      });
      expect((view as any)._ganttRowCache).toBeDefined();

      (parent as any).ganttEnabled = false; // parentPaths [] → fp change
      (view as any).renderChart();

      expect(byClass(container, "task-gantt-empty")).toHaveLength(1);
      expect((view as any)._ganttRowCache).toBeUndefined();
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(0);
    });
  });





  describe("tag filter", () => {
    /** Opens the filter menu via the header button and returns it. */
    function openMenu(container: FakeEl): FakeEl {
      const button = byClass(container, "task-gantt-tag-filter")[0];
      dispatch(button, "click");
      const menus = byClass(popoverBody(), "task-gantt-tag-filter-menu");
      expect(menus).toHaveLength(1);
      return menus[0];
    }

    /** Toggles one menu item's checkbox (by tag text) and fires change. */
    function toggleTag(menu: FakeEl, tag: string, checked: boolean): void {
      const item = byClass(menu, "task-gantt-tag-filter-item").find(
        (el) => byClass(el, "task-gantt-tag-filter-name")[0]?.textContent === tag
      );
      expect(item).toBeTruthy();
      const checkbox = item!.children[0];
      checkbox.checked = checked;
      dispatch(checkbox, "change");
    }

    it("clicking the button opens a menu listing every distinct parent+subtask tag, sorted, with checkboxes + color swatches", async () => {
      const parentA = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [
          makeSubtask("s1", { tags: ["frontend"] }),
          makeSubtask("s2", { tags: ["backend", "urgent"] }),
        ]
      );
      const parentB = makeParent({
        ganttEnabled: true,
        id: "tasks/p2.md",
        file: { path: "tasks/p2.md" },
        tags: ["design"],
      });
      const { container } = await openView([parentA, parentB], {
        ganttTags: tagRegistry(["backend", "design", "frontend", "urgent"]),
      });
      const menu = openMenu(container);
      const title = byClass(menu, "task-gantt-tag-filter-title");
      expect(title).toHaveLength(1);
      expect(title[0].textContent).toBe("タグで絞り込み");
      const items = byClass(menu, "task-gantt-tag-filter-item");
      const labels = items.map(
        (item) => byClass(item, "task-gantt-tag-filter-name")[0].textContent
      );
      expect(labels).toEqual(["backend", "design", "frontend", "urgent"]);
      // Every item carries an unchecked checkbox initially.
      items.forEach((item) => {
        expect(item.children[0].type).toBe("checkbox");
        expect(item.children[0].checked).toBe(false);
      });
      // each item also carries a color swatch.
      expect(byClass(menu, "task-gantt-tag-filter-swatch")).toHaveLength(4);
    });

    it("shows a 「タグは未作成です」 placeholder instead of an empty checkbox list when no tag exists anywhere", async () => {
      const parent = makeParent({ ganttEnabled: true, tags: [] });
      const { container } = await openView([parent]);
      const menu = openMenu(container);
      expect(byClass(menu, "task-gantt-tag-filter-item")).toHaveLength(0);
      const empty = byClass(menu, "task-gantt-tag-filter-empty");
      expect(empty).toHaveLength(1);
      expect(empty[0].textContent).toBe("タグは未作成です");
    });

    it("the footer's 「解除」button clears the whole filter and re-renders", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [makeSubtask("s1", { tags: ["frontend"] })]
      );
      const { view, container } = await openView([parent], {
        ganttTags: tagRegistry(["backend", "frontend"]),
      });
      toggleTag(openMenu(container), "backend", true);
      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込(1)"
      );

      const menu2 = openMenu(container);
      const clearButton = byTag(menu2, "button").find(
        (el) => el.textContent === "解除"
      );
      expect(clearButton).toBeTruthy();
      const wrap = wrapOf(container);
      wrap.scrollLeft = 987;
      const originalRenderChart = (view as any).renderChart.bind(view);
      (view as any).renderChart = () => {
        originalRenderChart();
        wrap.scrollLeft = 0;
      };
      dispatch(clearButton!, "click");
      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込"
      );
      expect(wrap.scrollLeft).toBe(987);
    });

    it("the footer's 「閉じる」button closes the menu without touching the filter", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [makeSubtask("s1", { tags: ["frontend"] })]
      );
      const { container } = await openView([parent], {
        ganttTags: tagRegistry(["backend", "frontend"]),
      });
      const menu = openMenu(container);
      toggleTag(menu, "backend", true);
      // toggling re-rendered the header (a fresh menu is not open now);
      // reopen, then close via the footer button without toggling.
      const menu2 = openMenu(container);
      const closeButton = byTag(menu2, "button").find(
        (el) => el.textContent === "閉じる"
      );
      expect(closeButton).toBeTruthy();
      dispatch(closeButton!, "click");
      expect(byClass(popoverBody(), "task-gantt-tag-filter-menu")).toHaveLength(0);
      // Filter state itself is untouched by 閉じる (still 1 active).
      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込(1)"
      );
    });

    it("a click inside the menu never closes it; a click outside does", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [makeSubtask("s1", { tags: ["frontend"] })]
      );
      const { view, container } = await openView([parent], {
        ganttTags: tagRegistry(["backend", "frontend"]),
      });
      const menu = openMenu(container);

      // Inside click (e.g. the label wrapping a checkbox) — menu survives.
      const item = byClass(menu, "task-gantt-tag-filter-item")[0];
      dispatch((globalThis as any).window, "click", { target: item });
      expect(byClass(popoverBody(), "task-gantt-tag-filter-menu")).toHaveLength(1);

      // Outside click (some unrelated element) closes it.
      const outsideEl = byClass(container, "task-gantt-day-row")[0];
      dispatch((globalThis as any).window, "click", { target: outsideEl });
      expect(byClass(popoverBody(), "task-gantt-tag-filter-menu")).toHaveLength(0);
      expect((view as any).tagFilterMenuEl).toBeUndefined();
    });

    it("the button label counts active filters: 「タグ絞込」 → 「タグ絞込(N)」 → back", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [makeSubtask("s1", { tags: ["frontend"] })]
      );
      const { container } = await openView([parent], {
        ganttTags: tagRegistry(["backend", "frontend"]),
      });
      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込"
      );

      toggleTag(openMenu(container), "backend", true);
      // The re-render rebuilt the header; the fresh button carries the count.
      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込(1)"
      );

      // Reopen: the checkbox reflects the active filter; unchecking clears.
      const menu2 = openMenu(container);
      const item = byClass(menu2, "task-gantt-tag-filter-item").find(
        (el) => byClass(el, "task-gantt-tag-filter-name")[0]?.textContent === "backend"
      );
      expect(item!.children[0].checked).toBe(true);
      toggleTag(menu2, "backend", false);
      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込"
      );
    });

    it("preserves horizontal scroll when a tag-filter checkbox re-renders the chart", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["backend"] }),
        [makeSubtask("s1", { tags: ["frontend"] })]
      );
      const { view, container } = await openView([parent], {
        ganttTags: tagRegistry(["backend", "frontend"]),
      });
      const wrap = wrapOf(container);
      wrap.scrollLeft = 654;

      // Model the observed real-DOM full-rebuild side effect. The handler
      // must restore its captured offset after renderChart returns.
      const originalRenderChart = (view as any).renderChart.bind(view);
      (view as any).renderChart = () => {
        originalRenderChart();
        wrap.scrollLeft = 0;
      };

      toggleTag(openMenu(container), "backend", true);

      expect(byClass(container, "task-gantt-tag-filter")[0].textContent).toBe(
        "タグ絞込(1)"
      );
      expect(wrap.scrollLeft).toBe(654);
    });

    it("parent-tag-only match keeps the parent row with ZERO bars", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["work"] }),
        [
          makeSubtask("s1", {
            displayName: "A",
            tags: ["home"],
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 5),
          }),
        ]
      );
      const { container } = await openView([parent], {
        ganttTags: tagRegistry(["work", "home"]),
      });
      // Before filtering: one bar.
      expect(
        byClass(timelineOf(parentRows(container)[0]), "task-gantt-bar")
      ).toHaveLength(1);

      toggleTag(openMenu(container), "work", true);

      const rows = parentRows(container);
      expect(rows).toHaveLength(1); // row stays (parent tags match)
      expect(
        byClass(timelineOf(rows[0]), "task-gantt-bar")
      ).toHaveLength(0); // all bars filtered out
      expect(rows[0].style.height).toBe("60px"); // laneCount 1, minimal
    });

    it("does not apply bar tag colors to a bar rejected by the existing filter guard", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["work"] }),
        [
          makeSubtask("s1", {
            tags: ["home"],
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 5),
          }),
        ]
      );
      const { container } = await openView([parent], {
        ganttTags: [
          tagDefinition("work", "#123456"),
          tagDefinition("home", "#abcdef"),
        ],
      });

      toggleTag(openMenu(container), "work", true);

      // Bar-level filtering removes the non-matching bar before the render
      // loop, so there is no element on which tag color can be applied.
      const timeline = timelineOf(parentRows(container)[0]);
      expect(byClass(timeline, "task-gantt-bar")).toHaveLength(0);
    });

    it("no match anywhere hides the parent entirely (no empty message, add row stays)", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["work"] }),
        [makeSubtask("s1", { tags: ["home"] })]
      );
      const { view, container } = await openView([parent], {
        ganttTags: tagRegistry(["work", "home"]),
      });
      expect(parentRows(container)).toHaveLength(1);

      // The menu only offers tags that exist somewhere, so a genuine
      // state arises when the tasks stop carrying the selected
      // tags: select 「work」, then strip it from the data.
      toggleTag(openMenu(container), "work", true);
      expect(parentRows(container)).toHaveLength(1); // parent tags match
      (parent as any).tags = [];
      (view as any).renderChart();

      expect(parentRows(container)).toHaveLength(0); // row removed entirely
      expect(byClass(container, "task-gantt-empty")).toHaveLength(0);
      // The add row is unaffected (parents exist — only filtered out).
      expect(byClass(container, "task-gantt-parent-add-cell")).toHaveLength(1);
    });

    it("a child-tag match filters bars BEFORE lane packing: 2 lanes collapse to 1", async () => {
      // Two overlapping subtasks → 2 lanes without a filter.
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: [] }),
        [
          makeSubtask("keep", {
            displayName: "K",
            tags: ["keep"],
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 10),
          }),
          makeSubtask("drop", {
            displayName: "D",
            tags: ["drop"],
            plannedStartDate: addDays(todayStr(), 5),
            plannedEndDate: addDays(todayStr(), 15),
          }),
        ]
      );
      const { container } = await openView([parent], {
        ganttTags: tagRegistry(["keep", "drop"]),
      });
      expect(parentRows(container)[0].style.height).toBe("104px"); // 2 lanes

      toggleTag(openMenu(container), "keep", true);

      const row = parentRows(container)[0];
      expect(byClass(timelineOf(row), "task-gantt-bar")).toHaveLength(1);
      // The dropped bar consumed no lane: the row shrank to a single lane
      // (filtering AFTER the pack would have kept 104px with an empty lane).
      expect(row.style.height).toBe("60px");
    });

    it("getMarkerFilterState: a match on ANY of parent/bar/marker tags keeps dim=false; no match anywhere is dim=true; no active filter is always dim=false", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: ["ptag"] }),
        [
          makeSubtask("s1", {
            tags: ["btag"],
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 5),
          }),
        ]
      );
      const { view } = await openView([parent]);
      const bar = {
        task: parent.subtasks!.get("s1")!,
        start: todayStr(),
        end: addDays(todayStr(), 5),
        lane: 0,
      };
      const getState = (view as any).getMarkerFilterState.bind(view);
      const marker = (tags: string[]) => ({
        key: "m",
        title: "M",
        date: todayStr(),
        tags,
      });

      // With no active filter, the marker is never dimmed.
      expect(getState(parent, bar, marker([]))).toEqual({ dim: false });

      // With an active filter and no matching tags, the marker is dimmed.
      (view as any).activeTagFilter = new Set(["other"]);
      expect(getState(parent, bar, marker([]))).toEqual({ dim: true });

      // A matching marker tag is sufficient even when parent and bar tags do not match.
      (view as any).activeTagFilter = new Set(["mtag"]);
      expect(getState(parent, bar, marker(["mtag"]))).toEqual({ dim: false });

      // A matching parent tag is sufficient.
      (view as any).activeTagFilter = new Set(["ptag"]);
      expect(getState(parent, bar, marker([]))).toEqual({ dim: false });

      // A matching tag on the bar's task is sufficient.
      (view as any).activeTagFilter = new Set(["btag"]);
      expect(getState(parent, bar, marker([]))).toEqual({ dim: false });
    });

    it("does not dim markers on rendered bars because non-matching bars are filtered before packing", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: [] }),
        [
          makeSubtask("s1", {
            tags: ["keep"],
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 5),
            ganttMarkers: [{ key: "m1", title: "M", date: todayStr() }],
          }),
        ]
      );
      const { container } = await openView([parent]);
      toggleTag(openMenu(container), "keep", true);
      const marker = byClass(
        timelineOf(parentRows(container)[0]),
        "task-gantt-marker"
      )[0];
      expect(marker).toBeTruthy();
      expect(marker.classList.contains("is-tag-filter-dimmed")).toBe(false);
    });

    it("a filter change forces a full rebuild even under incremental mode", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, tags: [] }),
        [
          makeSubtask("s1", {
            tags: ["keep"],
            plannedStartDate: todayStr(),
            plannedEndDate: addDays(todayStr(), 5),
          }),
        ]
      );
      const { view, container } = await openView([parent], {
        incrementalGanttRender: true,
      });
      const cacheBefore = (view as any)._ganttRowCache;
      const rowBefore = parentRows(container)[0];

      toggleTag(openMenu(container), "keep", true);

      const cacheAfter = (view as any)._ganttRowCache;
      // The tag filter is part of the header fingerprint, so it changed…
      expect(cacheAfter.headerFingerprint).not.toBe(
        cacheBefore.headerFingerprint
      );
      // …so the row was fully rebuilt, not diffed.
      expect(parentRows(container)[0]).not.toBe(rowBefore);
    });

    it("no menu opens when the tags feature is disabled (no button)", async () => {
      const { container } = await openView(
        [makeParent({ ganttEnabled: true })],
        { ganttFeatureTagsEnabled: false }
      );
      expect(byClass(container, "task-gantt-tag-filter")).toHaveLength(0);
      expect(byClass(popoverBody(), "task-gantt-tag-filter-menu")).toHaveLength(0);
    });
  });





  describe("drag operations", () => {
    let winEl: FakeEl;

    // dateOffset uses the real wall clock, so fixed offsets can land on
    // different weekdays across runs. A resize that snaps back to its starting
    // end date becomes a no-op and skips saving. Freeze the test clock and use
    // offsets whose exact snap targets are weekdays; offset 5 appears only in
    // inequality checks, so its weekday does not affect these assertions.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-04T00:00:00"));
      // Fake timers can intercept requestAnimationFrame; re-stub it
      // synchronously so rAF-driven rendering stays synchronous in this test.
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        cb(0);
        return 0;
      });
      winEl = (globalThis as any).window as FakeEl;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function barElOf(timeline: FakeEl): FakeEl {
      return byClass(timeline, "task-gantt-bar")[0];
    }

    function markerElOf(timeline: FakeEl): FakeEl {
      return byClass(timeline, "task-gantt-marker")[0];
    }

    function deadlineElOf(timeline: FakeEl): FakeEl {
      return byClass(timeline, "task-gantt-deadline-marker")[0];
    }

    function setBarRect(bar: FakeEl, left: number): void {
      const width = parseFloat(bar.style.width);
      bar.getBoundingClientRect = () => ({
        left,
        top: 0,
        right: left + width,
        bottom: 0,
        width,
        height: 0,
      });
    }

    function firstBgOf(timeline: FakeEl): FakeEl {
      return byClass(timeline, "task-gantt-bg")[0];
    }

    /** A 6-day subtask bar (comfortably wide for move-zone offsetX values). */
    function makeBarSubtask(
      key: string,
      overrides: Record<string, unknown> = {}
    ): TaskRow {
      return makeSubtask(key, {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        ...overrides,
      });
    }

    async function openViewWithBar(
      overrides: Record<string, unknown> = {},
      settingsOverrides: Record<string, unknown> = {}
    ): Promise<{
      view: TaskGanttView;
      container: FakeEl;
      timeline: FakeEl;
      h: HostHarness;
      parent: TaskRow;
      sub: TaskRow;
    }> {
      const sub = makeBarSubtask("sub1", overrides);
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { view, container, h } = await openView([parent], settingsOverrides);
      const timeline = timelineOf(parentRows(container)[0]);
      return { view, container, timeline, h, parent, sub };
    }





    it("left-button pointerdown starts a drag with preventDefault/stopPropagation", async () => {
      const { timeline } = await openViewWithBar();
      const bar = barElOf(timeline);
      const evt = dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 50,
      });
      expect((evt as any).__defaultPrevented).toBe(true);
      expect((evt as any).__propagationStopped).toBe(true);
      expect(bar.classList.contains("is-dragging")).toBe(true);
    });

    it("a non-left-button pointerdown does nothing", async () => {
      const { timeline } = await openViewWithBar();
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 2, clientX: 100, offsetX: 50 });
      expect(bar.classList.contains("is-dragging")).toBe(false);
    });

    it("a second pointerdown overwrites dragState without an exclusive lock", async () => {
      const { view, timeline } = await openViewWithBar();
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      const first = view.getActiveDragStateForTesting();
      dispatch(bar, "pointerdown", { button: 0, clientX: 120, offsetX: 50 });
      const second = view.getActiveDragStateForTesting();
      expect(second).not.toBe(first);
      expect(second?.kind).toBe("bar-move");
    });

    it("tooltip stays empty below the 4px threshold, then shows the range, then clears on drop", async () => {
      const { view, container, timeline } = await openViewWithBar();
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 102, clientY: 50 }); // 2px < threshold
      const tooltip = byClass(container, "task-gantt-drag-tooltip")[0];
      expect(tooltip.textContent).toBe("");
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // 28px = 1 day
      expect(tooltip.textContent).toBe(
        `${dateOffset(1)} → ${dateOffset(6)}`
      );
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();
      expect(tooltip.textContent).toBe("");
      expect(bar.classList.contains("is-dragging")).toBe(false);
      void view;
    });

    it.each([
      { start: "2026-10-09", end: "2026-10-09", delta: 1, holidays: [], nextStart: "2026-10-12", nextEnd: "2026-10-12" },
      { start: "2026-10-12", end: "2026-10-12", delta: -1, holidays: [], nextStart: "2026-10-09", nextEnd: "2026-10-09" },
      { start: "2026-10-09", end: "2026-10-12", delta: 1, holidays: ["2026-10-12"], nextStart: "2026-10-13", nextEnd: "2026-10-13" },
      { start: "2026-10-08", end: "2026-10-09", delta: 1, holidays: [], nextStart: "2026-10-09", nextEnd: "2026-10-12" },
    ])("single and bulk moves share saved dates and date previews: $start / $delta / $holidays", async ({ start, end, delta, holidays, nextStart, nextEnd }) => {
      vi.setSystemTime(new Date("2026-10-09T00:00:00"));
      const { view, container, timeline, h, parent, sub } = await openViewWithBar({
        plannedStartDate: start,
        plannedEndDate: end,
        ganttMarkers: [{ key: "m1", title: "M1", date: start }],
        workloadPlan: { [start]: 4 },
      });
      const holidaySet = new Set(holidays);
      (view as any).holidaySet = holidaySet;
      const bar = barElOf(timeline);
      (view as any).runBarDrag("move", sub, bar, parseFloat(bar.style.left), parseFloat(bar.style.width), [], 100, 1);
      dispatch(winEl, "pointermove", { clientX: 100 + delta * 28, clientY: 50 });
      const tooltip = byClass(container, "task-gantt-drag-tooltip")[0];
      expect(tooltip.textContent).toBe(`${nextStart} → ${nextEnd}`);
      dispatch(winEl, "pointerup", { clientX: 100 + delta * 28, clientY: 50 });
      await flush();
      const singlePatch = h.updateTaskItem.mock.calls[0][1];
      expect(singlePatch.plannedStartDate).toBe(nextStart);
      expect(singlePatch.plannedEndDate).toBe(nextEnd);

      (view as any).holidaySet = holidaySet;
      (view as any).startBulkMoveDrag(parent, start, 100);
      dispatch(winEl, "pointermove", { clientX: 100 + delta * 28, clientY: 50 });
      expect(tooltip.textContent).toContain(`${start} → ${nextStart}`);
      dispatch(winEl, "pointerup", { clientX: 100 + delta * 28, clientY: 50 });
      await flush();
      const commands = h.updateTaskItemsBatch.mock.calls[0][0];
      expect(commands).toHaveLength(1);
      expect(commands[0].patch.plannedStartDate).toBe(nextStart);
      expect(commands[0].patch.plannedEndDate).toBe(nextEnd);
      expect(commands[0].patch.ganttMarkers).toEqual(singlePatch.ganttMarkers);
      expect(commands[0].patch.workloadPlan).toEqual({ [nextStart]: 4 });
    });

    it("zero net movement resets the preview and saves nothing", async () => {
      const { timeline, h } = await openViewWithBar();
      const bar = barElOf(timeline);
      const originalLeft = bar.style.left;
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 150, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 }); // back to start
      await flush();
      expect(bar.style.left).toBe(originalLeft);
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });





    it("a mid-bar drag moves start+end together and shifts markers", async () => {
      const { timeline, h, sub } = await openViewWithBar({
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 }); // +2 days
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.plannedStartDate).toBe(dateOffset(2));
      expect(patch.plannedEndDate).toBe(dateOffset(7));

      // The marker preserves its business-day position within the moved bar,
      // landing on dateOffset(6) after the weekend is skipped.
      expect(patch.ganttMarkers).toEqual([
        { key: "m1", title: "M1", date: dateOffset(6) },
      ]);
    });

    it("a left-edge drag resizes only the start date", async () => {
      const { timeline, h, sub } = await openViewWithBar();
      const bar = barElOf(timeline);
      setBarRect(bar, 100);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 0 }); // edge
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // +1 day
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.plannedStartDate).toBe(dateOffset(1));
      expect(patch.plannedEndDate).toBeUndefined();
    });

    it("a left-edge drag past the end date clamps to end", async () => {
      const { timeline, h } = await openViewWithBar();
      const bar = barElOf(timeline);
      setBarRect(bar, 100);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 0 });
      dispatch(winEl, "pointermove", { clientX: 100 + 28 * 20, clientY: 50 }); // +20 days, past end (day 5)
      dispatch(winEl, "pointerup", { clientX: 100 + 28 * 20, clientY: 50 });
      await flush();

      const [, patch] = h.updateTaskItem.mock.calls[0];
      expect(patch.plannedStartDate).toBe(dateOffset(5));
    });

    it("a right-edge drag resizes only the end date", async () => {
      const { timeline, h, sub } = await openViewWithBar();
      const bar = barElOf(timeline);
      setBarRect(bar, 100 - (parseFloat(bar.style.width) - 1));
      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 9999, // far past any real width -> resize-end zone
      });
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // +1 day
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.plannedEndDate).toBe(dateOffset(6));
      expect(patch.plannedStartDate).toBeUndefined();
    });

    it("a left-edge resize with workload actuals does not warn", async () => {
      const { timeline, h, sub } = await openViewWithBar({
        workloadActual: { [dateOffset(0)]: 3 },
      });
      const bar = barElOf(timeline);
      setBarRect(bar, 100);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 0 });
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.confirmWorkloadShift).not.toHaveBeenCalled();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch).toEqual({ plannedStartDate: dateOffset(1) });
    });

    it("a right-edge resize with workload actuals does not warn", async () => {
      const { timeline, h, sub } = await openViewWithBar({
        workloadActual: { [dateOffset(0)]: 3 },
      });
      const bar = barElOf(timeline);
      setBarRect(bar, 100 - (parseFloat(bar.style.width) - 1));
      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 9999,
      });
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.confirmWorkloadShift).not.toHaveBeenCalled();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch).toEqual({ plannedEndDate: dateOffset(6) });
    });

    it("uses the bar geometry when pointerdown targets the resize-end child span", async () => {
      const { timeline, h, sub } = await openViewWithBar();
      const bar = barElOf(timeline);
      const resizeEnd = byClass(bar, "task-gantt-resize-end")[0];
      const width = parseFloat(bar.style.width);
      setBarRect(bar, 100);

      const evt = dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100 + width - 1,
        pointerId: 31,
        target: resizeEnd,
      });
      expect((evt as any).target).toBe(resizeEnd);

      dispatch(winEl, "pointermove", {
        clientX: 100 + width - 1 + 28,
        clientY: 50,
      });
      dispatch(winEl, "pointerup", {
        clientX: 100 + width - 1 + 28,
        clientY: 50,
      });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.plannedEndDate).toBe(dateOffset(6));
      expect(patch.plannedStartDate).toBeUndefined();
    });

    it("a right-edge drag past the start date clamps to start", async () => {
      const { timeline, h } = await openViewWithBar();
      const bar = barElOf(timeline);
      setBarRect(bar, 100 - (parseFloat(bar.style.width) - 1));
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 9999 });
      dispatch(winEl, "pointermove", { clientX: 100 - 28 * 20, clientY: 50 }); // -20 days, past start
      dispatch(winEl, "pointerup", { clientX: 100 - 28 * 20, clientY: 50 });
      await flush();

      const [, patch] = h.updateTaskItem.mock.calls[0];
      expect(patch.plannedEndDate).toBe(dateOffset(0));
    });

    it("the preview width is clamped to a minimum of 8px", async () => {
      const { timeline } = await openViewWithBar();
      const bar = barElOf(timeline);
      setBarRect(bar, 100 - (parseFloat(bar.style.width) - 1));
      const originalWidth = parseFloat(bar.style.width);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 9999 });
      dispatch(winEl, "pointermove", {
        clientX: 100 - originalWidth - 1000,
        clientY: 50,
      });
      expect(parseFloat(bar.style.width)).toBe(8);
      dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 });
    });





    it("a bar move shifts planned hours and keeps actual hours after confirmation", async () => {
      const { timeline, h, sub } = await openViewWithBar({
        workloadPlan: { [dateOffset(0)]: 4, [dateOffset(2)]: 1 },
        workloadActual: { [dateOffset(0)]: 3 },
      });
      h.confirmWorkloadShift.mockResolvedValue(true);
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();

      expect(h.confirmWorkloadShift).toHaveBeenCalledTimes(1);
      expect(h.confirmWorkloadShift.mock.calls[0][0]).toContain(
        "実績時間の日付は変更しません"
      );
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [, patch] = h.updateTaskItem.mock.calls[0];
      expect(patch.workloadPlan).toEqual({
        [dateOffset(2)]: 4,
        [dateOffset(6)]: 1,
      });
      expect(patch).not.toHaveProperty("workloadActual");
      expect(sub.workloadActual).toEqual({ [dateOffset(0)]: 3 });
    });

    it("cancelling the workload warning saves nothing and does not re-render", async () => {
      const { timeline, h } = await openViewWithBar({
        workloadActual: { [dateOffset(0)]: 3 },
      });
      h.confirmWorkloadShift.mockResolvedValue(false);
      h.loadTasks.mockClear();
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
      expect(h.loadTasks).not.toHaveBeenCalled(); // render was skipped
    });

    it("a save failure shows the exact Notice text and still re-renders", async () => {

      // The save path logs the failure and renders again without rolling back
      // because dragState was already cleared.
      const { timeline, h } = await openViewWithBar();
      h.loadTasks.mockClear();
      h.updateTaskItem.mockRejectedValue(
        Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" })
      );
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();

      expect(h.loadTasks).toHaveBeenCalledTimes(1); // Render also runs on failure.
      expect(h.host.logger.error).toHaveBeenCalledWith(
        "TaskGanttView",
        expect.stringContaining("failed to save drag change"),
        expect.any(Error)
      );
    });

    it("a successful save re-renders the chart", async () => {
      const { timeline, h } = await openViewWithBar();
      h.loadTasks.mockClear();
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });





    it("a bar move landing on Sunday snaps forward and preserves business-day duration", async () => {
      // Mark the moved-to date as a holiday so the drag must snap the start
      // forward. Assert that the view persists the resulting dates.
      const movedTo = dateOffset(2);
      const { timeline, h, sub } = await openViewWithBar(
        {},
        { ganttManualHolidays: [movedTo] }
      );
      const bar = barElOf(timeline);
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 }); // +2 days -> lands on the holiday
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();

      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      // Snapped PAST the holiday, not landing on it.
      expect(patch.plannedStartDate).not.toBe(movedTo);
      expect(patch.plannedStartDate > movedTo).toBe(true);

      // Duration is preserved in business days, not calendar days. The
      // original six-calendar-day bar contains four business days. Since the
      // moved range also excludes a business day, the new end is four calendar
      // days after the snapped start.
      expect(diffDays(patch.plannedStartDate, patch.plannedEndDate)).toBe(4);
    });





    it("dragging a marker updates only that marker's date", async () => {
      const { timeline, h, sub } = await openViewWithBar({
        ganttMarkers: [
          { key: "m1", title: "納品", date: dateOffset(2) },
          { key: "m2", title: "確認", date: dateOffset(3) },
        ],
      });
      const markerEl = markerElOf(timeline);
      dispatch(markerEl, "pointerdown", { button: 0, clientX: 100 });
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // +1 day
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.ganttMarkers).toEqual([
        { key: "m1", title: "納品", date: dateOffset(3) },
        { key: "m2", title: "確認", date: dateOffset(3) },
      ]);
    });

    it("a marker cannot be dragged outside its subtask's date range", async () => {
      const { timeline, h } = await openViewWithBar({
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      const markerEl = markerElOf(timeline);
      dispatch(markerEl, "pointerdown", { button: 0, clientX: 100 });
      dispatch(winEl, "pointermove", { clientX: 100 + 28 * 30, clientY: 50 }); // way past the end
      dispatch(winEl, "pointerup", { clientX: 100 + 28 * 30, clientY: 50 });
      await flush();

      const [, patch] = h.updateTaskItem.mock.calls[0];
      expect(patch.ganttMarkers[0].date <= dateOffset(5)).toBe(true);
    });

    it("a marker whose task vanishes mid-drag is a graceful no-op", async () => {
      const { view, timeline, h } = await openViewWithBar({
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      const markerEl = markerElOf(timeline);
      dispatch(markerEl, "pointerdown", { button: 0, clientX: 100 });
      // Simulate an external deletion mid-drag: empty out the task list.
      (view as any).tasks = [];
      expect(() => {
        dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
        dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      }).not.toThrow();
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });





    it("dragging the deadline marker updates the parent's dueDate", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, dueDate: dateOffset(10) }),
        [makeBarSubtask("sub1")]
      );
      const { container, h } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const deadline = deadlineElOf(timeline);
      dispatch(deadline, "pointerdown", { button: 0, clientX: 100 });
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // +1 day
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(parent);



      // unchanged; now Saturday is non-working too, so it snaps through
      // Sunday (dateOffset(12)) to the following Monday (dateOffset(13)).
      expect(patch.dueDate).toBe(dateOffset(13));
      // analog: due-date drag never checks workload-actual.
      expect(h.confirmWorkloadShift).not.toHaveBeenCalled();
    });





    it("right-clicking an empty cell opens the empty-cell menu with the Bulk-Move trigger", async () => {
      const { timeline } = await openViewWithBar();
      const bg = firstBgOf(timeline);
      dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
      expect(menuItems().length).toBeGreaterThan(0);
      expect(menuItemWithText("これ以降を纏めて移動")).toBeDefined();
    });

    it("selecting 「これ以降を纏めて移動」bulk-shifts every subtask from the anchor onward", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeBarSubtask("early", {
          plannedStartDate: dateOffset(-10),
          plannedEndDate: dateOffset(-5),
        }),
        makeBarSubtask("late", {
          plannedStartDate: dateOffset(0),
          plannedEndDate: dateOffset(5),
          ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
          workloadPlan: { [dateOffset(0)]: 4 },
        }),
      ]);
      const { container, h } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      // Right-click the cell at "today" (dates[14], per the test convention
      // used elsewhere in this file). Subtasks are sorted by start,
      // "early" (start -10) precedes "late" (start 0) — the first subtask
      // whose start is on/after today is "late", so it becomes the anchor
      // and every subtask from its sorted index onward (just itself here)
      // is the target set for the bulk move.
      const bg = byClass(timeline, "task-gantt-bg")[14];
      dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("これ以降を纏めて移動"), "click");
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // +1 day
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.updateTaskItemsBatch).toHaveBeenCalledTimes(1);
      const commands = h.updateTaskItemsBatch.mock.calls[0][0];
      expect(commands).toHaveLength(1);
      expect(commands[0].row.key).toBe("late");
      expect(commands[0].patch.plannedStartDate).toBe(dateOffset(1));
      expect(commands[0].patch.plannedEndDate).toBe(dateOffset(6));
      expect(commands[0].patch.ganttMarkers).toEqual([
        { key: "m1", title: "M1", date: dateOffset(3) },
      ]);
      expect(commands[0].patch.workloadPlan).toEqual({ [dateOffset(1)]: 4 });
    });

    it("bulk moves snap each target separately and preserve working-day durations", async () => {
      const targets = [
        makeBarSubtask("thursday", { plannedStartDate: "2026-10-08", plannedEndDate: "2026-10-09" }),
        makeBarSubtask("friday", { plannedStartDate: "2026-10-09", plannedEndDate: "2026-10-09" }),
      ];
      const parent = withChildren(makeParent({ ganttEnabled: true }), targets);
      const { view, h } = await openView([parent]);
      (view as any).holidaySet = new Set<string>();
      await (view as any).finishBulkMoveDrag(targets, 1);
      const commands = h.updateTaskItemsBatch.mock.calls[0][0];
      expect(commands.map((command: { patch: { plannedStartDate?: string; plannedEndDate?: string } }) => [command.patch.plannedStartDate, command.patch.plannedEndDate])).toEqual([
        ["2026-10-09", "2026-10-12"],
        ["2026-10-12", "2026-10-12"],
      ]);
    });

    it("bulk-move preview distinguishes its anchor from follower bars and shows the '一括移動' tooltip", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeBarSubtask("s1", {
          plannedStartDate: dateOffset(0),
          plannedEndDate: dateOffset(3),
        }),
        makeBarSubtask("s2", {
          plannedStartDate: dateOffset(1),
          plannedEndDate: dateOffset(6),
        }),
      ]);
      const { container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const bg = byClass(timeline, "task-gantt-bg")[14]; // today
      dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("これ以降を纏めて移動"), "click");

      const bars = byClass(timeline, "task-gantt-bar");
      expect(bars.every((b) => b.classList.contains("is-dragging"))).toBe(true);
      expect(bars[0].classList.contains("is-bulk-move-anchor")).toBe(true);
      expect(bars[0].classList.contains("is-bulk-move-follower")).toBe(false);
      expect(bars[1].classList.contains("is-bulk-move-anchor")).toBe(false);
      expect(bars[1].classList.contains("is-bulk-move-follower")).toBe(true);

      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
      const tooltip = byClass(container, "task-gantt-drag-tooltip")[0];
      expect(tooltip.textContent).toContain("一括移動");

      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();
      expect(bars.every((b) => b.classList.contains("is-dragging"))).toBe(false);
      expect(
        bars.every(
          (b) =>
            !b.classList.contains("is-bulk-move-anchor") &&
            !b.classList.contains("is-bulk-move-follower")
        )
      ).toBe(true);
    });

    it("a Bulk-Move group with any workload-actual gets ONE combined confirmation", async () => {
      const parent = withChildren(makeParent({ ganttEnabled: true }), [
        makeBarSubtask("s1", {
          plannedStartDate: dateOffset(0),
          plannedEndDate: dateOffset(3),
          workloadActual: { [dateOffset(0)]: 2 },
        }),
        makeBarSubtask("s2", {
          plannedStartDate: dateOffset(1),
          plannedEndDate: dateOffset(6),
        }),
      ]);
      const { container, h } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const bg = byClass(timeline, "task-gantt-bg")[14];
      dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("これ以降を纏めて移動"), "click");
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();

      expect(h.confirmWorkloadShift).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItemsBatch).toHaveBeenCalledTimes(1);
      const commands = h.updateTaskItemsBatch.mock.calls[0][0];
      expect(commands).toHaveLength(2);
      expect(h.confirmWorkloadShift).toHaveBeenCalledWith(
        "予定日と計画時間を一括移動します。実績時間の日付は変更しません。実行しますか？"
      );
      for (const command of commands) {
        expect(command.patch).not.toHaveProperty("workloadActual");
      }
      expect(commands[0].row.workloadActual).toEqual({ [dateOffset(0)]: 2 });
    });
  });
});





describe("computeRichPopoverPosition", () => {
  // A 100px-wide, 24px-tall bar anchored at (100,100).
  const anchor = { left: 100, top: 100, right: 200, bottom: 124 };

  it("places the popover 12px below the bar when it fits", () => {
    const pos = computeRichPopoverPosition(anchor, 260, 180, 1200, 800, 12);
    expect(pos.side).toBe("below");
    expect(pos.top).toBe(136); // 124 + 12
    expect(pos.left).toBe(100); // anchor's left edge (no mouseX)
  });

  it("falls back to 12px above when below does not fit", () => {
    const lowAnchor = { left: 100, top: 700, right: 200, bottom: 724 };
    const pos = computeRichPopoverPosition(lowAnchor, 260, 180, 1200, 800, 12);
    expect(pos.side).toBe("above");
    expect(pos.top).toBe(508); // 700 - 12 - 180
    expect(pos.left).toBe(100);
  });

  it("falls back to the right side when neither vertical placement fits", () => {
    // Viewport only 400px tall: below (174+12+250=436) and above
    // (150-12-250=-112) both overflow.
    const midAnchor = { left: 100, top: 150, right: 200, bottom: 174 };
    const pos = computeRichPopoverPosition(midAnchor, 260, 250, 1200, 400, 12);
    expect(pos.side).toBe("right");
    expect(pos.left).toBe(212); // 200 + 12
    expect(pos.top).toBe(150); // anchor's top edge
  });

  it("left is the fallback when nothing fits, clamped into the viewport", () => {
    const midAnchor = { left: 100, top: 150, right: 200, bottom: 174 };
    // 400px-wide viewport: right (212+260=472) overflows too.
    const pos = computeRichPopoverPosition(midAnchor, 260, 250, 400, 400, 12);
    expect(pos.side).toBe("left");
    expect(pos.left).toBe(0); // 100 - 12 - 260 = -172, clamped to the viewport
    expect(pos.top).toBe(150);
  });

  it("a colliding workload popup makes a free right preferred over a fitting below", () => {
    // The workload popup sits under the anchor, so below collides (and would
    // otherwise fit: 136+180=316 <= 800); above overflows (-92). Right
    // (212..472) clears the workload popup (right edge 200), so right wins.
    const workload = { left: 90, top: 130, right: 200, bottom: 400 };
    const pos = computeRichPopoverPosition(
      anchor,
      260,
      180,
      1200,
      800,
      12,
      workload
    );
    expect(pos.side).toBe("right");
    expect(pos.left).toBe(212);
    expect(pos.top).toBe(100);
  });

  it("rejects a right candidate that collides with the workload popup", () => {
    // Right (212..472 x 100..280) overlaps this workload popup, as do below
    // and (off-screen) above, so the rich popup stacks below the workload.
    const workload = { left: 90, top: 130, right: 350, bottom: 400 };
    const pos = computeRichPopoverPosition(
      anchor,
      260,
      180,
      1200,
      800,
      12,
      workload
    );
    expect(pos.side).toBe("below");
    expect(pos.top).toBe(412); // 400 + 12
    expect(pos.left).toBe(100);
  });

  it("clamps the right candidate's top into a short viewport", () => {
    const lowAnchor = { left: 100, top: 250, right: 200, bottom: 274 };
    const pos = computeRichPopoverPosition(lowAnchor, 260, 250, 1200, 300, 12);
    expect(pos.side).toBe("right");
    expect(pos.left).toBe(212);
    expect(pos.top).toBe(50); // 300 - 250, not the anchor's 250
  });

  it("clamps the left fallback's top into a narrow, short viewport", () => {
    const lowAnchor = { left: 100, top: 250, right: 200, bottom: 274 };
    const pos = computeRichPopoverPosition(lowAnchor, 260, 250, 400, 300, 12);
    expect(pos.side).toBe("left");
    expect(pos.top).toBe(50);
  });

  it("no-space fallback is stable: popover taller than the viewport pins to top 0", () => {
    const workload = { left: 90, top: 130, right: 350, bottom: 400 };
    const args = [anchor, 260, 500, 400, 300, 12, workload] as const;
    const first = computeRichPopoverPosition(...args);
    expect(first.side).toBe("left");
    expect(first.top).toBe(0);
    expect(first.left).toBe(0);
    expect(computeRichPopoverPosition(...args)).toEqual(first);
  });

  describe("narrow viewport regressions", () => {
    const overlaps = (
      a: { left: number; top: number; right: number; bottom: number },
      b: { left: number; top: number; right: number; bottom: number }
    ): boolean =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rectOf = (
      pos: { left: number; top: number },
      w: number,
      h: number
    ) => ({ left: pos.left, top: pos.top, right: pos.left + w, bottom: pos.top + h });

    it("1188x500: places the popover left of the workload popup instead of overlapping it", () => {
      // Below/above/right/stacked are all unusable; the clamped left-of-anchor
      // rect (148..588 x 226..500) used to overlap the workload popup by
      // 18x22px even though room remained farther left.
      const bar = { left: 600, top: 260, right: 1100, bottom: 284 };
      const workload = { left: 570, top: 114, right: 1128, bottom: 248 };
      const pos = computeRichPopoverPosition(bar, 440, 274, 1188, 500, 12, workload);
      expect(pos.side).toBe("left");
      expect(pos.left).toBe(118); // 570 - 12 - 440
      expect(pos.top).toBe(226); // 500 - 274
      const rect = rectOf(pos, 440, 274);
      expect(overlaps(rect, workload)).toBe(false);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(500);
    });

    it("900x500: the left fallback is clamped to the viewport instead of going negative", () => {
      const bar = { left: 340, top: 260, right: 840, bottom: 284 };
      const pos = computeRichPopoverPosition(bar, 440, 274, 900, 500, 12);
      expect(pos.side).toBe("left");
      expect(pos.left).toBe(0); // 340 - 12 - 440 = -112, clamped
      expect(pos.top).toBe(226);
    });

    it("clamps a vertical placement horizontally when the anchor sits near the right edge", () => {
      const bar = { left: 1100, top: 100, right: 1180, bottom: 124 };
      const pos = computeRichPopoverPosition(bar, 440, 180, 1188, 800, 12);
      expect(pos.side).toBe("below");
      expect(pos.left).toBe(748); // 1188 - 440, not the anchor's 1100
    });

    it("moves right of the workload popup when left of it does not fit", () => {
      const bar = { left: 100, top: 260, right: 160, bottom: 284 };
      const workload = { left: 20, top: 114, right: 260, bottom: 248 };
      // Left of the anchor clamps to 0..260 and collides; left of the workload
      // is negative; right of it (272..532) fits.
      const pos = computeRichPopoverPosition(bar, 260, 274, 600, 500, 12, workload);
      expect(pos.side).toBe("right");
      expect(pos.left).toBe(272);
      expect(overlaps(rectOf(pos, 260, 274), workload)).toBe(false);
    });

    it("physically impossible: deterministic clamped fallback, identical on repeats", () => {
      // 900px wide: the 440px popover fits neither beside nor around a 558px
      // workload popup, so overlap cannot be avoided. The fallback is the
      // clamped left-of-anchor rect and never changes between calls.
      const bar = { left: 340, top: 260, right: 840, bottom: 284 };
      const workload = { left: 310, top: 114, right: 868, bottom: 248 };
      const args = [bar, 440, 274, 900, 500, 12, workload] as const;
      const first = computeRichPopoverPosition(...args);
      expect(first).toEqual({ top: 226, left: 0, side: "left" });
      for (let i = 0; i < 3; i++) {
        expect(computeRichPopoverPosition(...args)).toEqual(first);
      }
    });

    it("900x500 with mouseX: clamped on-screen and deterministic when no collision-free spot exists", () => {
      // Exact reported case. Before clamping the left fallback was
      // {left:-112} (off-screen). Nothing is collision-free here: above/below
      // collide or overflow, right (1112+440) and right-of-workload (880+440)
      // exceed 900, and left of the workload (310-12-440) is negative. The
      // result is the on-screen clamped left-of-anchor rect, identical on
      // every call, and it knowingly overlaps the workload popup.
      const bar = { left: 340, top: 300, right: 1100, bottom: 324 };
      const workload = { left: 310, top: 154, right: 868, bottom: 288 };
      const args = [bar, 440, 274, 900, 500, 12, workload, 800] as const;
      const pos = computeRichPopoverPosition(...args);
      expect(pos).toEqual({ top: 226, left: 0, side: "left" });
      const rect = rectOf(pos, 440, 274);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(900);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(500);
      expect(overlaps(rect, workload)).toBe(true); // physically unavoidable
      for (let i = 0; i < 3; i++) {
        expect(computeRichPopoverPosition(...args)).toEqual(pos);
      }
    });

    it("1188x848 sequence: below-fit -> above -> stacked above the workload popup, unchanged", () => {
      // Real repro geometry: a long bar extending past the viewport, low on
      // screen. Before the workload popup exists the popover goes above the
      // bar; once it exists the popover stacks above the workload popup.
      const bar = { left: 704, top: 569, right: 1820, bottom: 593 };
      const lone = computeRichPopoverPosition(bar, 440, 274, 1188, 848, 12);
      expect(lone.side).toBe("above");
      expect(lone.top).toBe(283); // 569 - 12 - 274
      const workload = { left: 674, top: 551, right: 1132, bottom: 685 };
      const stacked = computeRichPopoverPosition(
        bar, 440, 274, 1188, 848, 12, workload
      );
      expect(stacked.side).toBe("above");
      expect(stacked.top).toBe(265); // 551 - 12 - 274
      expect(overlaps(rectOf(stacked, 440, 274), workload)).toBe(false);
      // Repeated placement is stable.
      expect(
        computeRichPopoverPosition(bar, 440, 274, 1188, 848, 12, workload)
      ).toEqual(stacked);
      // A bar with room below keeps the plain below placement.
      const high = { left: 704, top: 457, right: 1820, bottom: 481 };
      expect(
        computeRichPopoverPosition(high, 440, 274, 1188, 848, 12).side
      ).toBe("below");
    });
  });

  it("with a colliding workload popup, no right room and no stacking room, left is used", () => {
    // 450px-tall viewport: below the workload (412+180=592) does not fit,
    // above it (130-12-180) is off-screen, and right overflows 400px.
    const workload = { left: 90, top: 130, right: 350, bottom: 400 };
    const pos = computeRichPopoverPosition(
      anchor,
      260,
      180,
      400,
      450,
      12,
      workload
    );
    expect(pos.side).toBe("left");
  });

  it("stacks above the workload popup when below/above/right are unusable", () => {
    // Anchor near the bottom of a 400px-wide viewport: below overflows,
    // above collides with the workload popup, right overflows.
    const lowAnchor = { left: 100, top: 600, right: 390, bottom: 624 };
    const workload = { left: 90, top: 470, right: 290, bottom: 592 };
    const pos = computeRichPopoverPosition(
      lowAnchor,
      260,
      180,
      400,
      800,
      12,
      workload
    );
    expect(pos.side).toBe("above");
    expect(pos.top).toBe(278); // 470 - 12 - 180
    expect(pos.top + 180 + 12).toBeLessThanOrEqual(workload.top);
  });

  it("stacks below the workload popup when there is no room above it", () => {
    const workload = { left: 90, top: 130, right: 350, bottom: 400 };
    const pos = computeRichPopoverPosition(
      anchor,
      260,
      180,
      400,
      800,
      12,
      workload
    );
    expect(pos.side).toBe("below");
    expect(pos.top).toBe(412); // 400 + 12
  });

  it("is deterministic for repeated identical inputs", () => {
    const lowAnchor = { left: 100, top: 600, right: 390, bottom: 624 };
    const workload = { left: 90, top: 470, right: 290, bottom: 592 };
    const args = [lowAnchor, 260, 180, 400, 800, 12, workload] as const;
    expect(computeRichPopoverPosition(...args)).toEqual(
      computeRichPopoverPosition(...args)
    );
  });

  it("a null/undefined workload popup never blocks below placement", () => {
    const withNull = computeRichPopoverPosition(
      anchor,
      260,
      180,
      1200,
      800,
      12,
      null
    );
    expect(withNull.side).toBe("below");
    const withUndefined = computeRichPopoverPosition(
      anchor,
      260,
      180,
      1200,
      800,
      12,
      undefined
    );
    expect(withUndefined.side).toBe("below");
  });

  it("an open-time mouseX centers a vertical placement on the cursor, clamped to the viewport", () => {
    const pos = computeRichPopoverPosition(
      anchor,
      260,
      180,
      1200,
      800,
      12,
      undefined,
      500
    );
    expect(pos.side).toBe("below");
    expect(pos.left).toBe(370); // 500 - 260/2
    // Clamping: a cursor near the right edge keeps the popover inside.
    const clamped = computeRichPopoverPosition(
      anchor,
      260,
      180,
      1200,
      800,
      12,
      undefined,
      1190
    );
    expect(clamped.left).toBe(940); // 1200 - 260
  });
});





describe("rich popover behavior", () => {
  let winEl: FakeEl;

  beforeEach(() => {
    // Same global stubs as the root describe above (this block is a sibling
    // top-level describe, so those hooks do not reach it).
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
    winEl = (globalThis as any).window as FakeEl;
    // Give the fake window real dimensions so the popover width clamp and
    // the placement fit-checks compute meaningfully (1200×800 → the 440px
    // width ceiling applies).
    winEl.innerWidth = 1200;
    winEl.innerHeight = 800;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Opens a view with one gantt-enabled parent + one 6-day subtask bar. */
  async function openBarView(
    subOverrides: Record<string, unknown> = {},
    parentOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    parent: TaskRow;
    sub: TaskRow;
    bar: FakeEl;
  }> {
    const sub = makeSubtask("sub1", {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(5),
      ...subOverrides,
    });
    const parent = withChildren(
      makeParent({ ganttEnabled: true, ...parentOverrides }),
      [sub]
    );
    const { view, container, h } = await openView([parent], settingsOverrides);
    const timeline = timelineOf(parentRows(container)[0]);
    const bar = byClass(timeline, "task-gantt-bar")[0];
    return { view, container, timeline, h, parent, sub, bar };
  }

  function popoverOf(_container: FakeEl): FakeEl | undefined {
    return byClass(popoverBody(), "task-gantt-rich-popover")[0];
  }

  function showPopover(container: FakeEl, bar: FakeEl, clientX = 100): FakeEl {
    dispatch(bar, "mouseover", { clientX, clientY: 50 });
    const popover = popoverOf(container);
    expect(popover).toBeDefined();
    return popover as FakeEl;
  }

  function buttonByText(root: FakeEl, text: string): FakeEl {
    const found = byTag(root, "button").find((b) => b.textContent === text);
    expect(found).toBeDefined();
    return found as FakeEl;
  }





  it("mouseover on a subtask bar shows the popover with header chips", async () => {
    const { container, bar } = await openBarView({
      displayName: "表示名",
      statusLabel: "in_progress",
      priority: 3,
    });
    const popover = showPopover(container, bar);
    expect(popover.classList.contains("is-subtask")).toBe(true);
    expect(byClass(popover, "task-gantt-popover-title")[0].textContent).toBe(
      "表示名"
    );
    expect(
      byClass(popover, "task-gantt-popover-status-chip")[0].textContent
    ).toBe("進行中");
    expect(
      byClass(popover, "task-gantt-popover-priority-chip")[0].textContent
    ).toBe("P3");
  });

  it("a completed subtask's status chip shows '完了' text AND the status-done class even when statusLabel is stale/inconsistent (single effectiveStatus source, not two independently-driven fields)", async () => {
    const { container, bar } = await openBarView({
      statusLabel: "in_progress",
      completed: true,
    });
    const popover = showPopover(container, bar);
    const chip = byClass(popover, "task-gantt-popover-status-chip")[0];
    expect(chip.textContent).toBe("完了");
    expect(chip.classList.contains("status-done")).toBe(true);
    expect(chip.classList.contains("status-in_progress")).toBe(false);
  });

  it("a completed subtask with statusLabel='done' gets the status-done class the CSS actually styles", async () => {
    const { container, bar } = await openBarView({
      statusLabel: "done",
      completed: true,
    });
    const popover = showPopover(container, bar);
    const chip = byClass(popover, "task-gantt-popover-status-chip")[0];
    expect(chip.classList.contains("status-done")).toBe(true);
  });

  it("a hand-edited/invalid statusLabel does not crash chip rendering and adds no status-{label} modifier class", async () => {
    const { container, bar } = await openBarView({
      statusLabel: "in progress", // contains a space: not a valid CSS class token
    });
    expect(() => showPopover(container, bar)).not.toThrow();
    const popover = showPopover(container, bar);
    const chip = byClass(popover, "task-gantt-popover-status-chip")[0];
    expect(
      Array.from(chip.classList).some((className) =>
        className.startsWith("status-")
      )
    ).toBe(false);
  });

  it("a non-completed subtask's status chip carries a status-{label} class matching statusLabel", async () => {
    const { container, bar } = await openBarView({ statusLabel: "waiting" });
    const popover = showPopover(container, bar);
    const chip = byClass(popover, "task-gantt-popover-status-chip")[0];
    expect(chip.textContent).toBe("待ち");
    expect(chip.classList.contains("status-waiting")).toBe(true);
  });

  it("a completed subtask's bar carries is-completed", async () => {
    const { bar } = await openBarView({ completed: true });
    expect(bar.classList.contains("is-completed")).toBe(true);
  });

  it("a completed subtask's external label carries is-completed when the bar is narrow", async () => {
    const day = dateOffset(0);
    const { timeline } = await openBarView(
      { plannedStartDate: day, plannedEndDate: day, completed: true },
      {},
      { ganttZoom: 4 }
    );
    const label = byClass(timeline, "task-gantt-external-label")[0];
    expect(label).toBeDefined();
    expect(label.classList.contains("is-completed")).toBe(true);
  });

  it("mouseover on a bar adds is-parent-hover to ALL of its markers; mouseleave removes it", async () => {
    const markerDate = dateOffset(1);
    const { timeline, bar } = await openBarView({
      ganttMarkers: [
        { key: "m1", title: "M1", date: markerDate },
        { key: "m2", title: "M2", date: markerDate },
      ],
    });
    const markers = byClass(timeline, "task-gantt-marker");
    expect(markers).toHaveLength(2);
    for (const m of markers) {
      expect(m.classList.contains("is-parent-hover")).toBe(false);
    }

    dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
    for (const m of markers) {
      expect(m.classList.contains("is-parent-hover")).toBe(true);
    }

    dispatch(bar, "mouseleave");
    for (const m of markers) {
      expect(m.classList.contains("is-parent-hover")).toBe(false);
    }
  });

  it("title falls back to title; priority 0 renders no priority chip", async () => {
    const { container, bar } = await openBarView({
      displayName: "",
      title: "素のタイトル",
      priority: 0,
    });
    const popover = showPopover(container, bar);
    expect(byClass(popover, "task-gantt-popover-title")[0].textContent).toBe(
      "素のタイトル"
    );
    expect(byClass(popover, "task-gantt-popover-priority-chip")).toHaveLength(0);
  });

  it("mouseover on the parent LEFT cell shows the parent popover", async () => {
    const parent = withChildren(
      makeParent({
        ganttEnabled: true,
        displayName: "親の表示名",
        statusLabel: "hold",
      }),
      [
        makeSubtask("sub1", {
          plannedStartDate: dateOffset(0),
          plannedEndDate: dateOffset(5),
        }),
      ]
    );
    const { container } = await openView([parent]);
    const left = leftOf(parentRows(container)[0]);
    left.getBoundingClientRect = () => ({
      left: 0,
      top: 100,
      right: 320,
      bottom: 180,
      width: 320,
      height: 80,
    });
    dispatch(left, "mouseover", { clientX: 50, clientY: 20 });
    const popover = popoverOf(container);
    expect(popover).toBeDefined();
    expect((popover as FakeEl).classList.contains("is-parent")).toBe(true);
    expect((popover as FakeEl).style.left).toBe("332px");
    expect((popover as FakeEl).style.top).toBe("100px");
    expect((popover as FakeEl).attributes["data-side"]).toBe("right");
    expect(
      byClass(popover as FakeEl, "task-gantt-popover-title")[0].textContent
    ).toBe("親の表示名");
    expect(
      byClass(popover as FakeEl, "task-gantt-popover-status-chip")[0].textContent
    ).toBe("保留");

    // completion toggle.
    expect(
      byClass(popover as FakeEl, "task-gantt-popover-priority-chip")
    ).toHaveLength(0);
    expect(
      byTag(popover as FakeEl, "button").some(
        (b) => b.textContent === "完了とする" || b.textContent === "未完了に戻す"
      )
    ).toBe(false);
  });

  it("falls back to a viewport-fitting placement when the parent's right side is too narrow", async () => {
    const parent = withChildren(makeParent({ ganttEnabled: true }), [
      makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
      }),
    ]);
    const { container } = await openView([parent]);
    const left = leftOf(parentRows(container)[0]);
    left.getBoundingClientRect = () => ({
      left: 0,
      top: 100,
      right: 320,
      bottom: 180,
      width: 320,
      height: 80,
    });
    winEl.innerWidth = 600;

    dispatch(left, "mouseover", { clientX: 50, clientY: 20 });
    const popover = popoverOf(container) as FakeEl;

    expect(popover.attributes["data-side"]).toBe("below");
    expect(popover.style.left).toBe("24px");
    expect(Number.parseFloat(popover.style.left) + 440 + 24).toBeLessThanOrEqual(
      winEl.innerWidth
    );
  });

  it("a completed parent's status chip shows '完了' text AND the status-done class even when statusLabel is stale/inconsistent", async () => {
    const parent = withChildren(
      makeParent({
        ganttEnabled: true,
        statusLabel: "hold",
        completed: true,
      }),
      [
        makeSubtask("sub1", {
          plannedStartDate: dateOffset(0),
          plannedEndDate: dateOffset(5),
        }),
      ]
    );
    const { container } = await openView([parent]);
    const left = leftOf(parentRows(container)[0]);
    dispatch(left, "mouseover", { clientX: 50, clientY: 20 });
    const popover = popoverOf(container) as FakeEl;
    const chip = byClass(popover, "task-gantt-popover-status-chip")[0];
    expect(chip.textContent).toBe("完了");
    expect(chip.classList.contains("status-done")).toBe(true);
    expect(chip.classList.contains("status-hold")).toBe(false);
  });

  it("hovering a subtask bar opens the SUBTASK popover, never the parent one", async () => {
    const { container, bar } = await openBarView();
    const popover = showPopover(container, bar);
    expect(popover.classList.contains("is-subtask")).toBe(true);
    expect(popover.classList.contains("is-parent")).toBe(false);
  });

  it("a repeated mouseover on the same bar keeps a single popover", async () => {
    const { container, bar } = await openBarView();
    showPopover(container, bar);
    dispatch(bar, "mouseover", { clientX: 110, clientY: 50 });
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
  });

  it("hovering a different bar switches the popover to that task", async () => {
    const parent = withChildren(makeParent({ ganttEnabled: true }), [
      makeSubtask("alpha", {
        displayName: "Alpha",
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(3),
      }),
      makeSubtask("beta", {
        displayName: "Beta",
        plannedStartDate: dateOffset(1),
        plannedEndDate: dateOffset(6),
      }),
    ]);
    const { container } = await openView([parent]);
    const timeline = timelineOf(parentRows(container)[0]);
    const bars = byClass(timeline, "task-gantt-bar");
    dispatch(bars[0], "mouseover", { clientX: 100, clientY: 50 });
    expect(
      byClass(popoverOf(container) as FakeEl, "task-gantt-popover-title")[0]
        .textContent
    ).toBe("Alpha");
    dispatch(bars[1], "mouseover", { clientX: 100, clientY: 50 });
    const popovers = byClass(popoverBody(), "task-gantt-rich-popover");
    expect(popovers).toHaveLength(1);
    expect(
      byClass(popovers[0], "task-gantt-popover-title")[0].textContent
    ).toBe("Beta");
  });

  it("a finished bar drag suppresses the popover until the window expires", async () => {
    const { view, container, bar } = await openBarView();
    dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
    dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 }); // zero net move
    await flush();
    const suppressUntil = (view as any).richPopoverSuppressUntil as number;
    expect(suppressUntil).toBeGreaterThan(Date.now() - 50);
    expect(suppressUntil).toBeLessThanOrEqual(Date.now() + 450);
    // While suppressed, mouseover does nothing.
    dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
    expect(popoverOf(container)).toBeUndefined();
    // Once the window is over, the same mouseover shows it again.
    (view as any).richPopoverSuppressUntil = 0;
    dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
    expect(popoverOf(container)).toBeDefined();
  });


  it("a committed bar drag closes both popovers", async () => {
    const { container, bar } = await openBarView();
    showPopover(container, bar);
    dispatch(bar, "mouseenter");
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(1);

    dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
    dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
    dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
    await flush();

    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(0);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(0);
  });

  it("a no-op bar drag keeps both popovers open", async () => {
    const { container, bar } = await openBarView();
    showPopover(container, bar);
    dispatch(bar, "mouseenter");
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(1);

    dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
    dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 });
    await flush();

    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(1);
  });



  it("a committed Bulk-Move closes both popovers", async () => {
    useFridayClock();
    const parent = withChildren(makeParent({ ganttEnabled: true }), [
      makeSubtask("s1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(3),
      }),
      makeSubtask("s2", {
        plannedStartDate: dateOffset(1),
        plannedEndDate: dateOffset(6),
      }),
    ]);
    const { container, h } = await openView([parent]);
    const timeline = timelineOf(parentRows(container)[0]);
    const bars = byClass(timeline, "task-gantt-bar");
    showPopover(container, bars[0]);
    dispatch(bars[0], "mouseenter");
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(1);

    const bg = byClass(timeline, "task-gantt-bg")[14];
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("これ以降を纏めて移動"), "click");
    dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
    dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
    await flush();

    expect(h.updateTaskItemsBatch).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItemsBatch.mock.calls[0][0]).toHaveLength(2);
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(0);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(0);
  });

  it("a cancelled Bulk-Move keeps both popovers open", async () => {
    useFridayClock();
    const parent = withChildren(makeParent({ ganttEnabled: true }), [
      makeSubtask("s1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(3),
        workloadActual: { [dateOffset(0)]: 2 },
      }),
      makeSubtask("s2", {
        plannedStartDate: dateOffset(1),
        plannedEndDate: dateOffset(6),
      }),
    ]);
    const { container, h } = await openView([parent]);
    const timeline = timelineOf(parentRows(container)[0]);
    const bars = byClass(timeline, "task-gantt-bar");
    showPopover(container, bars[0]);
    dispatch(bars[0], "mouseenter");
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(1);
    h.confirmWorkloadShift.mockResolvedValueOnce(false);

    const bg = byClass(timeline, "task-gantt-bg")[14];
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("これ以降を纏めて移動"), "click");
    dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
    dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
    await flush();

    expect(h.confirmWorkloadShift).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItemsBatch).not.toHaveBeenCalled();
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
    expect(byClass(popoverBody(), "task-gantt-workload-popover")).toHaveLength(1);
  });


  it("a finished marker drag arms the suppression window", async () => {
    const { view, timeline } = await openBarView({
      ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
    });
    const marker = byClass(timeline, "task-gantt-marker")[0];
    dispatch(marker, "pointerdown", { button: 0, clientX: 100 });
    dispatch(winEl, "pointerup", { clientX: 100 });
    expect((view as any).richPopoverSuppressUntil).toBeGreaterThan(Date.now());
  });

  it("a finished parent due-date drag arms the suppression window", async () => {
    const { view, timeline } = await openBarView(
      {},
      { dueDate: dateOffset(10) }
    );
    const deadline = byClass(timeline, "task-gantt-deadline-marker")[0];
    dispatch(deadline, "pointerdown", { button: 0, clientX: 100 });
    dispatch(winEl, "pointerup", { clientX: 100 });
    expect((view as any).richPopoverSuppressUntil).toBeGreaterThan(Date.now());
  });

  it("a finished Bulk-Move drag arms the suppression window", async () => {
    const { view, timeline } = await openBarView();
    // Use the first rendered date instead of a fixed cell index or a
    // task-specific start date. findBulkMoveAnchor accepts a pivot date at or
    // before the subtask start, and dates[0] satisfies that for every visible
    // task. This keeps the test independent of the runner's date and timezone.
    const bg = byClass(timeline, "task-gantt-bg")[0];
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("これ以降を纏めて移動"), "click");
    dispatch(winEl, "pointerup", { clientX: 100 });
    expect((view as any).richPopoverSuppressUntil).toBeGreaterThan(Date.now());
  });

  it("after closing, the same mouseover shows the popover again", async () => {
    const { view, container, bar } = await openBarView();
    showPopover(container, bar);
    (view as any).closeRichPopover();
    expect(popoverOf(container)).toBeUndefined();
    dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
    expect(popoverOf(container)).toBeDefined();
  });





  it("read-only period (from the rendered bar) and due-date fields", async () => {
    const due = dateOffset(10);
    const { container, bar } = await openBarView({ dueDate: due });
    const popover = showPopover(container, bar);
    const expectedPeriod = `${moment(dateOffset(0), "YYYY-MM-DD").format(
      "M/D"
    )} - ${moment(dateOffset(5), "YYYY-MM-DD").format("M/D")}`;
    expect(deepText(byClass(popover, "task-gantt-popover-period")[0])).toContain(
      expectedPeriod
    );
    expect(deepText(byClass(popover, "task-gantt-popover-due")[0])).toContain(
      moment(due, "YYYY-MM-DD").format("M/D")
    );
  });

  it("the due-date field is omitted when the task has no dueDate", async () => {
    const { container, bar } = await openBarView();
    const popover = showPopover(container, bar);
    expect(byClass(popover, "task-gantt-popover-due")).toHaveLength(0);
  });

  it("Status select: five DEFAULT_STATUSES options, immediate save, full re-render", async () => {
    const { container, bar, h, sub } = await openBarView({
      statusLabel: "waiting",
    });
    const popover = showPopover(container, bar);
    const select = byTag(popover, "select")[0];
    const options = byTag(select, "option");
    expect(options.map((o) => o.value)).toEqual([
      "active",
      "in_progress",
      "waiting",
      "hold",
      "done",
    ]);
    expect(options.map((o) => o.textContent)).toEqual([
      "未着手",
      "進行中",
      "待ち",
      "保留",
      "完了",
    ]);
    expect(select.value).toBe("waiting");
    h.loadTasks.mockClear();
    select.value = "done";
    dispatch(select, "change");
    await flush();
    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({ statusLabel: "done" });
    expect(h.loadTasks).toHaveBeenCalledTimes(1); // render
    expect(popoverOf(container)).toBeUndefined(); // closed after the render
  });

  it("a failed Status save is console-only, but still renders and closes", async () => {
    const { container, bar, h } = await openBarView();
    h.updateTaskItem.mockRejectedValue(new Error("write failed"));
    h.loadTasks.mockClear();
    const popover = showPopover(container, bar);
    const select = byTag(popover, "select")[0];
    select.value = "hold";
    dispatch(select, "change");
    await flush();
    expect(h.host.logger.error).toHaveBeenCalledWith(
      "TaskGanttView",
      expect.stringContaining("failed to save popover change"),
      expect.any(Error)
    );
    expect(h.loadTasks).toHaveBeenCalledTimes(1); // render either way
    expect(popoverOf(container)).toBeUndefined();
  });

  it("tags render as chips when present", async () => {
    const { container, bar } = await openBarView({ tags: ["alpha", "beta"] });
    const popover = showPopover(container, bar);
    const chips = byClass(popover, "task-gantt-popover-tags")[0];
    expect(byClass(chips, "vg-chip").map((c) => c.textContent)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("the tags field is omitted when the task has no tags", async () => {
    const { container, bar } = await openBarView();
    const popover = showPopover(container, bar);
    expect(byClass(popover, "task-gantt-popover-tags")).toHaveLength(0);
  });

  it("ノートを開く opens the subtask's note and closes the popover", async () => {
    const { container, bar, h, sub } = await openBarView();
    const popover = showPopover(container, bar);
    dispatch(buttonByText(popover, "ノートを開く"), "click");
    expect(h.openTaskItem).toHaveBeenCalledTimes(1);
    expect(h.openTaskItem.mock.calls[0][0]).toBe(sub);
    expect(popoverOf(container)).toBeUndefined();
  });

  it("完了とする sets completed+done, re-renders and closes", async () => {
    const { container, bar, h, sub } = await openBarView({ completed: false });
    h.loadTasks.mockClear();
    const popover = showPopover(container, bar);
    dispatch(buttonByText(popover, "完了とする"), "click");
    await flush();
    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
      completed: true,
      statusLabel: "done",
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
    expect(popoverOf(container)).toBeUndefined();
  });

  it("未完了に戻す sets completed:false + statusLabel:active", async () => {
    const { container, bar, h, sub } = await openBarView({
      completed: true,
      statusLabel: "done",
    });
    const popover = showPopover(container, bar);
    dispatch(buttonByText(popover, "未完了に戻す"), "click");
    await flush();
    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
      completed: false,
      statusLabel: "active",
    });
    expect(popoverOf(container)).toBeUndefined();
  });





  async function openParentPopoverView(
    parentOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    h: HostHarness;
    parent: TaskRow;
    popover: FakeEl;
  }> {
    const sub = makeSubtask("sub1", {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(5),
    });
    const parent = withChildren(
      makeParent({ ganttEnabled: true, ...parentOverrides }),
      [sub]
    );
    const { view, container, h } = await openView([parent]);
    const left = leftOf(parentRows(container)[0]);
    dispatch(left, "mouseover", { clientX: 50, clientY: 20 });
    const popover = popoverOf(container);
    expect(popover).toBeDefined();
    return { view, container, h, parent, popover: popover as FakeEl };
  }

  it("rich popover control classes are present for subtask and parent variants", async () => {
    const { view, container, bar } = await openBarView({ dueDate: dateOffset(10) });
    const subtaskPopover = showPopover(container, bar);
    expect(byClass(subtaskPopover, "task-gantt-popover-actions")).toHaveLength(1);
    expect(byClass(subtaskPopover, "task-gantt-popover-open-note")).toHaveLength(1);
    expect(byClass(subtaskPopover, "task-gantt-popover-toggle-completed")).toHaveLength(1);
    expect(byClass(subtaskPopover, "task-gantt-popover-status-select")).toHaveLength(1);
    expect(byClass(subtaskPopover, "task-gantt-popover-current-status")).toHaveLength(1);
    expect(byClass(subtaskPopover, "task-gantt-popover-due-input")).toHaveLength(0);

    (view as any).closeRichPopover();
    const parentResult = await openParentPopoverView({ dueDate: dateOffset(10) });
    expect(byClass(parentResult.popover, "task-gantt-popover-actions")).toHaveLength(1);
    expect(byClass(parentResult.popover, "task-gantt-popover-open-note")).toHaveLength(1);
    expect(byClass(parentResult.popover, "task-gantt-popover-toggle-completed")).toHaveLength(0);
    expect(byClass(parentResult.popover, "task-gantt-popover-status-select")).toHaveLength(1);
    expect(byClass(parentResult.popover, "task-gantt-popover-current-status")).toHaveLength(1);
    expect(byClass(parentResult.popover, "task-gantt-popover-due-input")).toHaveLength(1);
  });

  it("the parent due-date input is editable and saves + renders on change", async () => {
    const { container, h, parent, popover } = await openParentPopoverView({
      dueDate: dateOffset(10),
    });
    const input = byTag(popover, "input")[0];
    expect(input.type).toBe("date");
    expect(input.value).toBe(dateOffset(10));
    h.loadTasks.mockClear();
    input.value = dateOffset(20);
    dispatch(input, "change");
    await flush();
    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItem.mock.calls[0][0]).toBe(parent);
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
      dueDate: dateOffset(20),
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
    expect(popoverOf(container)).toBeUndefined();
  });

  it("the parent Status select has the same five options and change renders", async () => {
    const { h, parent, popover } = await openParentPopoverView();
    const select = byTag(popover, "select")[0];
    const options = byTag(select, "option");
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.value)).toEqual([
      "active",
      "in_progress",
      "waiting",
      "hold",
      "done",
    ]);
    h.loadTasks.mockClear();
    select.value = "in_progress";
    dispatch(select, "change");
    await flush();
    expect(h.updateTaskItem.mock.calls[0][0]).toBe(parent);
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
      statusLabel: "in_progress",
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("the parent popover's ノートを開く opens the parent's note", async () => {
    const { container, h, parent, popover } = await openParentPopoverView();
    dispatch(buttonByText(popover, "ノートを開く"), "click");
    expect(h.openTaskItem).toHaveBeenCalledTimes(1);
    expect(h.openTaskItem.mock.calls[0][0]).toBe(parent);
    expect(popoverOf(container)).toBeUndefined();
  });





  it("wheel on the popover forwards the scroll delta to the wrap and closes", async () => {
    const { container, bar } = await openBarView();
    const popover = showPopover(container, bar);
    const wrap = wrapOf(container);
    const scrollLeftBefore = wrap.scrollLeft;
    const evt = dispatch(popover, "wheel", { deltaY: 40, deltaX: 5 });
    expect((evt as any).__defaultPrevented).toBe(true);
    expect(wrap.scrollTop).toBe(40);
    expect(wrap.scrollLeft).toBe(scrollLeftBefore + 5);
    expect(popoverOf(container)).toBeUndefined();
  });

  it("the wheel-close path clears workload sub-popups inside the popover", async () => {
    const { view, container, bar } = await openBarView();
    const popover = showPopover(container, bar);
    // No workload popup exists anywhere yet — simulate what a future one
    // would look like to exercise the structural clearing call site.
    const popup = makeFakeEl("div");
    popup.classList.add("task-gantt-workload-popup");
    popover.appendChild(popup);
    (view as any).clearRichPopoverWorkloadPopups();
    expect(
      popover.children.some((c) =>
        c.classList.contains("task-gantt-workload-popup")
      )
    ).toBe(false);
    expect(popoverOf(container)).toBeDefined(); // popover itself untouched
    dispatch(popover, "wheel", { deltaY: 10 });
    expect(popoverOf(container)).toBeUndefined();
  });





  it("scrolling the wrap closes the popover immediately", async () => {
    const { container, bar } = await openBarView();
    showPopover(container, bar);
    dispatch(wrapOf(container), "scroll", {});
    expect(popoverOf(container)).toBeUndefined();
  });

  it("keeps the open-time position fixed while the pointer moves over the bar and popover", async () => {
    const { container, bar } = await openBarView();
    // Show-time placement (mouseX=300, width 440 at window 1200): left 80.
    const popover = showPopover(container, bar, 300);
    expect(popover.style.left).toBe("80px");
    const queued: Array<(t: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      queued.push(cb);
      return queued.length;
    });
    dispatch(bar, "mousemove", { clientX: 320, clientY: 60 });
    dispatch(popover, "mousemove", { clientX: 500, clientY: 60 });
    expect(queued).toHaveLength(0);
    expect(popover.style.left).toBe("80px");
  });

  it("a detached anchor closes the popover gracefully when positioning is requested", async () => {
    const { view, container, bar } = await openBarView();
    showPopover(container, bar);
    bar.remove(); // simulate an external re-render dropping the anchor
    expect(() => (view as any).positionRichPopover()).not.toThrow();
    expect(popoverOf(container)).toBeUndefined();
  });

  it("mouseover on a detached bar never opens a popover", async () => {
    const { container, bar } = await openBarView();
    bar.remove();
    dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
    expect(popoverOf(container)).toBeUndefined();
  });


  // Timer-driven behavior (220ms hide debounce, 450ms Current Status
  // debounce, setTimeout(0) blur flush) — vi.useFakeTimers, an established
  // pattern elsewhere in this repo. The synchronous requestAnimationFrame
  // stub is re-installed inside the nested beforeEach because fake timers
  // must not interfere with it (rAF is not in vitest's default fake list,
  // but re-stubbing keeps the ordering explicit). Async saves still settle
  // through real microtasks, so tests combine advanceTimersByTime + flush.


  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        cb(0);
        return 0;
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("the popover hides 220ms after the mouse leaves the trigger", async () => {
      const { container, bar } = await openBarView();
      showPopover(container, bar);
      dispatch(bar, "mouseleave");
      vi.advanceTimersByTime(219);
      expect(popoverOf(container)).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(popoverOf(container)).toBeUndefined();
    });

    it("re-entering the bar before the timer fires cancels the hide", async () => {
      const { container, bar } = await openBarView();
      showPopover(container, bar);
      dispatch(bar, "mouseleave");
      vi.advanceTimersByTime(100);
      dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
      vi.advanceTimersByTime(1000);
      expect(popoverOf(container)).toBeDefined();
    });

    it("keeps the popover open while Current Status is focused and typed into", async () => {
      const { container, bar } = await openBarView();
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];

      // Simulate a hide timer that began before the user entered the field.
      dispatch(popover, "mouseleave");
      dispatch(area, "focus");
      area.value = "入力中";
      dispatch(area, "input");
      vi.advanceTimersByTime(221);
      expect(popoverOf(container)).toBeDefined();

      // Focused interaction does not disable normal hiding once it ends.
      dispatch(area, "blur");
      vi.advanceTimersByTime(220);
      expect(popoverOf(container)).toBeUndefined();
    });

    it("hovering the popover itself while the timer runs cancels it; leaving restarts it", async () => {
      const { container, bar } = await openBarView();
      const popover = showPopover(container, bar);
      dispatch(bar, "mouseleave");
      vi.advanceTimersByTime(100);
      dispatch(popover, "mouseover");
      vi.advanceTimersByTime(1000);
      expect(popoverOf(container)).toBeDefined();
      dispatch(popover, "mouseleave");
      vi.advanceTimersByTime(220);
      expect(popoverOf(container)).toBeUndefined();
    });

    it("the Current Status textarea autosaves 450ms after typing stops, without render", async () => {
      const { container, bar, h, sub } = await openBarView({
        currentStatus: "既存の進捗",
      });
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      expect(area.value).toBe("既存の進捗");
      h.loadTasks.mockClear();
      area.value = "新しい進捗";
      dispatch(area, "input");
      vi.advanceTimersByTime(449);
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "新しい進捗",
      });
      expect(sub.currentStatus).toBe("新しい進捗");
      // The Current Status save path never re-renders and never closes the
      // popover (deliberately distinct from savePopoverPatch).
      expect(h.loadTasks).not.toHaveBeenCalled();
      expect(popoverOf(container)).toBeDefined();
    });

    it("no save fires when the trimmed value equals the stored value", async () => {
      const { container, bar, h } = await openBarView({
        currentStatus: "same",
      });
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      area.value = "  same  ";
      dispatch(area, "input");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });

    it("IME composition blocks both the debounce flush and the blur flush", async () => {
      const { container, bar, h } = await openBarView();
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      dispatch(area, "compositionstart");
      area.value = "変換中";
      dispatch(area, "input");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      // blur while composing: the deferred flush is a no-op too.
      dispatch(area, "blur");
      vi.advanceTimersByTime(10);
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      // After compositionend the normal debounce resumes.
      dispatch(area, "compositionend");
      area.value = "確定した値";
      dispatch(area, "input");
      vi.advanceTimersByTime(450);
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "確定した値",
      });
    });

    it("blur flushes through setTimeout(0), never synchronously in the handler", async () => {
      const { container, bar, h, sub } = await openBarView();
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      area.value = "blur で保存";
      dispatch(area, "blur");
      // The blur handler itself must NOT have saved synchronously.
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "blur で保存",
      });
      expect(sub.currentStatus).toBe("blur で保存");
    });

    it("Ctrl+Enter commits immediately and closes the popover", async () => {
      const { container, bar, h, sub } = await openBarView();
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      area.value = "Ctrl+Enter で確定";
      dispatch(area, "keydown", { key: "Enter", ctrlKey: true });
      expect(popoverOf(container)).toBeUndefined(); // closes synchronously
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "Ctrl+Enter で確定",
      });
      expect(sub.currentStatus).toBe("Ctrl+Enter で確定");
    });

    it("Cmd+Enter (metaKey) commits and closes as well", async () => {
      const { container, bar, h } = await openBarView();
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      area.value = "meta で確定";
      dispatch(area, "keydown", { key: "Enter", metaKey: true });
      expect(popoverOf(container)).toBeUndefined();
      await flush();
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "meta で確定",
      });
    });

    it("Escape COMMITS (not cancels) and closes the popover", async () => {
      const { container, bar, h, sub } = await openBarView();
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      area.value = "Escape でも確定";
      dispatch(area, "keydown", { key: "Escape" });
      expect(popoverOf(container)).toBeUndefined();
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "Escape でも確定",
      });
      expect(sub.currentStatus).toBe("Escape でも確定");
    });

    it("a failed Current Status save rolls back the data but keeps the displayed text", async () => {
      const { container, bar, h, sub } = await openBarView({
        currentStatus: "元の値",
      });
      h.updateTaskItem.mockRejectedValue(new Error("write failed"));
      const popover = showPopover(container, bar);
      const area = byTag(popover, "textarea")[0];
      area.value = "未保存の値";
      dispatch(area, "input");
      vi.advanceTimersByTime(450);
      await flush();
      expect(h.host.logger.error).toHaveBeenCalledWith(
        "TaskGanttView",
        expect.stringContaining("failed to save current status"),
        expect.any(Error)
      ); // Only the logger records the failure; no Notice is shown.
      expect(sub.currentStatus).toBe("元の値"); // The in-memory value is rolled back.
      expect(area.value).toBe("未保存の値"); // The editor keeps the displayed value.
    });

    it("the parent popover's Current Status shares the identical debounce behavior", async () => {
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
      });
      const parent = withChildren(
        makeParent({ ganttEnabled: true, currentStatus: "" }),
        [sub]
      );
      const { container, h } = await openView([parent]);
      const left = leftOf(parentRows(container)[0]);
      dispatch(left, "mouseover", { clientX: 50, clientY: 20 });
      const popover = popoverOf(container) as FakeEl;
      const area = byTag(popover, "textarea")[0];
      area.value = "親の進捗";
      dispatch(area, "input");
      vi.advanceTimersByTime(449);
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][0]).toBe(parent);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        currentStatus: "親の進捗",
      });
    });
  });
});






describe("workload paint-drag and bar-level popup", () => {
  let winEl: FakeEl;


  // the clock to a known Tuesday so dates/weekday classification never
  // drift with the real wall-clock date across test runs.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00"));
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
    winEl = (globalThis as any).window as FakeEl;
    winEl.innerWidth = 1200;
    winEl.innerHeight = 800;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Opens a view with one gantt-enabled parent + one 6-day subtask bar. */
  async function openBarView(
    subOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    parent: TaskRow;
    sub: TaskRow;
    bar: FakeEl;
  }> {
    const sub = makeSubtask("sub1", {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(5),
      ...subOverrides,
    });
    const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
    const { view, container, h } = await openView([parent], settingsOverrides);
    const timeline = timelineOf(parentRows(container)[0]);
    const bar = byClass(timeline, "task-gantt-bar")[0];
    return { view, container, timeline, h, parent, sub, bar };
  }


  async function openEventView(
    eventOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    event: Record<string, any>;
    chip: FakeEl;
  }> {
    const event = {
      key: "event-1",
      title: "予定",
      date: dateOffset(0),
      ...eventOverrides,
    };
    const { view, container, h } = await openView([], {
      ...settingsOverrides,
      ganttEvents: [event],
    });
    const timeline = byClass(container, "task-gantt-event-row")[0];
    const chip = byClass(timeline, "task-gantt-event-chip")[0];
    return { view, container, timeline, h, event, chip };
  }


  function popoverOf(_container: FakeEl): FakeEl | undefined {
    return byClass(popoverBody(), "task-gantt-workload-popover")[0];
  }

  function graphOf(popover: FakeEl): FakeEl {
    return byClass(popover, "task-gantt-workload-popover-graph")[0];
  }

  function toggleOf(popover: FakeEl): FakeEl {
    return byClass(popover, "task-gantt-workload-popover-mode-toggle")[0];
  }

  function cellByDate(popover: FakeEl, date: string): FakeEl {
    const cell = byClass(popover, "task-gantt-workload-popover-cell").find(
      (c) => c.attributes["data-date"] === date
    );
    expect(cell).toBeDefined();
    return cell as FakeEl;
  }

  /** The first index in `dates` that is neither Saturday nor Sunday. */
  function businessIndex(dates: string[]): number {
    const idx = dates.findIndex((d) => {
      const dow = moment(d, "YYYY-MM-DD").day();
      return dow !== 0 && dow !== 6;
    });
    expect(idx).toBeGreaterThanOrEqual(0);
    return idx;
  }

  /** The first index in `dates` that IS Saturday or Sunday. */
  function weekendIndex(dates: string[]): number {
    const idx = dates.findIndex((d) => {
      const dow = moment(d, "YYYY-MM-DD").day();
      return dow === 0 || dow === 6;
    });
    expect(idx).toBeGreaterThanOrEqual(0);
    return idx;
  }

  /** Stubs a graph element's rect to match how showWorkloadPopupForBar sized it. */
  function stubGraphRect(graph: FakeEl, dayWidth: number, dateCount: number): void {
    graph.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: dateCount * dayWidth,
      bottom: 96,
      width: dateCount * dayWidth,
      height: 96,
    });
  }





  it("mouseenter on a subtask bar shows the workload popover", async () => {
    const { container, bar } = await openBarView();
    expect(popoverOf(container)).toBeUndefined();
    dispatch(bar, "mouseenter");
    expect(popoverOf(container)).toBeDefined();
  });


  it("mouseenter on an event chip opens one workload cell with its plan and actual values", async () => {
    const date = dateOffset(0);
    const { container, chip } = await openEventView({
      workloadPlan: { [date]: 3 },
      workloadActual: { [date]: 1.5 },
    });

    expect(popoverOf(container)).toBeUndefined();
    dispatch(chip, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    expect(popover).toBeDefined();
    const cells = byClass(popover, "task-gantt-workload-popover-cell");
    expect(cells).toHaveLength(1);
    expect(cells[0].attributes["data-date"]).toBe(date);
    expect(byClass(cells[0], "task-gantt-workload-plan-fill")[0].style.height).toBe(
      `${(3 / 7) * 100}%`
    );
    expect(byClass(cells[0], "task-gantt-workload-fill")[0].style.height).toBe(
      `${(3 / 7) * 100}%`
    );
    expect(byClass(cells[0], "task-gantt-workload-value-badge")[0].textContent).toBe(
      "3h"
    );

    dispatch(toggleOf(popover), "click");
    expect(byClass(cells[0], "task-gantt-workload-fill")[0].style.height).toBe(
      `${(1.5 / 7) * 100}%`
    );
    expect(byClass(cells[0], "task-gantt-workload-value-badge")[0].textContent).toBe(
      "1.5h"
    );
  });


  it("the popover never shows when ganttFeatureWorkloadEnabled is false", async () => {
    const { container, bar } = await openBarView(
      {},
      { ganttFeatureWorkloadEnabled: false }
    );
    dispatch(bar, "mouseenter");
    expect(popoverOf(container)).toBeUndefined();
  });

  it("the popover hides 160ms after the mouse leaves the bar", async () => {
    const { container, bar } = await openBarView();
    dispatch(bar, "mouseenter");
    expect(popoverOf(container)).toBeDefined();
    dispatch(bar, "mouseleave");
    vi.advanceTimersByTime(159);
    expect(popoverOf(container)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(popoverOf(container)).toBeUndefined();
  });

  it("re-entering the bar before the timer fires cancels the hide", async () => {
    const { container, bar } = await openBarView();
    dispatch(bar, "mouseenter");
    dispatch(bar, "mouseleave");
    vi.advanceTimersByTime(100);
    dispatch(bar, "mouseenter");
    vi.advanceTimersByTime(1000);
    expect(popoverOf(container)).toBeDefined();
  });

  it("hovering the popover itself cancels the hide timer; leaving it restarts the timer", async () => {
    const { container, bar } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    dispatch(bar, "mouseleave");
    vi.advanceTimersByTime(100);
    dispatch(popover, "mouseenter");
    vi.advanceTimersByTime(1000);
    expect(popoverOf(container)).toBeDefined();
    dispatch(popover, "mouseleave");
    vi.advanceTimersByTime(160);
    expect(popoverOf(container)).toBeUndefined();
  });

  it("re-triggering while already open tears down and rebuilds fresh (no duplicate popovers)", async () => {
    const { container, bar } = await openBarView();
    dispatch(bar, "mouseenter");
    const first = popoverOf(container) as FakeEl;
    dispatch(bar, "mouseenter");
    const second = popoverOf(container) as FakeEl;
    expect(byClass(popoverBody(), "task-gantt-workload-popover").length).toBe(1);
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });





  it("the mode-toggle button starts on 「計画時間」 and reads/writes workloadModeStore via getWorkloadTaskKey", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const toggle = toggleOf(popover);
    expect(toggle.textContent).toBe("計画時間");
    dispatch(toggle, "click");
    expect(toggle.textContent).toBe("実績時間");
    expect(view.getWorkloadModeStoreForTesting().get(sub.id)).toEqual({
      mode: "actual",
    });
    dispatch(toggle, "click");
    expect(toggle.textContent).toBe("計画時間");
  });

  it("right-clicking the popover toggles mode without opening or propagating a context menu", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const toggle = toggleOf(popover);

    const evt = dispatch(popover, "contextmenu");

    expect(evt.__defaultPrevented).toBe(true);
    expect(evt.__propagationStopped).toBe(true);
    expect(menuItems()).toHaveLength(0);
    expect(toggle.textContent).toBe("実績時間");
    expect(popover.classList.contains("is-actual")).toBe(true);
    expect(view.getWorkloadModeStoreForTesting().get(sub.id)).toEqual({
      mode: "actual",
    });

    dispatch(popover, "contextmenu");
    expect(toggle.textContent).toBe("計画時間");
    expect(popover.classList.contains("is-actual")).toBe(false);
  });

  it("Y-axis labels run 0..maxHours at 1-hour ticks", async () => {
    const { container, bar } = await openBarView(
      {},
      { ganttWorkloadMaxHours: 4 }
    );
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const labels = byClass(popover, "task-gantt-workload-popover-axis-label").map(
      (l) => l.textContent
    );
    expect(labels).toEqual(["4", "3", "2", "1", "0"]);
  });

  it("renders exactly one cell per visible date", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const cells = byClass(popover, "task-gantt-workload-popover-cell");
    expect(cells.length).toBe(workloadDatesOf(view, sub).length);
  });

  it("tints Saturday and Sunday graph cells without tinting weekdays", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const dates = workloadDatesOf(view, sub);
    const cells = byClass(popover, "task-gantt-workload-popover-cell");
    const weekend = weekendIndex(dates);
    const weekday = businessIndex(dates);

    expect(cells[weekend].classList.contains("is-weekend")).toBe(true);
    expect(cells[weekday].classList.contains("is-weekend")).toBe(false);
  });

  it("anchors the popup and its cells to the bar's own screen position (bar-anchored, 2026-08-12) and renders each date's plan/actual values", async () => {
    const dates = [dateOffset(0), dateOffset(1), dateOffset(2), dateOffset(3)];
    const plan = [1, 2, 3, 4];
    const actual = [4, 3, 2, 1];
    const { container, bar } = await openBarView({
      plannedStartDate: dates[0],
      plannedEndDate: dates[3],
      workloadPlan: Object.fromEntries(
        dates.map((date, index) => [date, plan[index]])
      ),
      workloadActual: Object.fromEntries(
        dates.map((date, index) => [date, actual[index]])
      ),
    });
    // Realistic-scale rects (PARENT_COL_WIDTH=320 sticky column + the
    // popup's own 48px axis guard) so graphMinLeft's clamp actually engages
    // — the bar starts 3 days before graphMinLeft, so the popup must clip
    // to a suffix of the bar's date range, anchored to its rectangle rather
    // than the chart origin.
    bar.getBoundingClientRect = () => ({
      left: 700,
      top: 300,
      right: 812, // 700 + 4*28
      bottom: 324,
      width: 112,
      height: 24,
    });
    wrapOf(container).getBoundingClientRect = () => ({
      left: 400,
      top: 0,
      right: 1200,
      bottom: 600,
      width: 800,
      height: 600,
    });
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const cells = byClass(popover, "task-gantt-workload-popover-cell");
    // graphMinLeft = max(8, wrapRect.left(400) + PARENT_COL_WIDTH(320) +
    // axisGuard(48)) = 768; rawStartIndex = ceil((768-700)/28) = 3.
    const visibleDates = dates.slice(3);
    expect(cells.map((cell) => cell.attributes["data-date"])).toEqual(
      visibleDates
    );
    // graphLeft = barRect.left(700) + startIndex(3)*28 = 784 (>= graphMinLeft
    // 768, not further clamped); el/chartEl rects are unstubbed (both default
    // to an all-zero rect), so the live-measured graphOffsetFromEl is 0 and
    // el.style.left lands on graphLeft exactly.
    expect(popover.style.left).toBe("784px");

    let previousLeft: number | undefined;
    visibleDates.forEach((date, index) => {
      const cell = cells[index];
      const left = Number.parseFloat(cell.style.left);
      // Absolute positioning uses graphLeft; cell offsets remain graph-local.
      expect(left).toBe(index * 28);
      expect(cell.style.width).toBe("28px");
      if (previousLeft !== undefined) {
        expect(left - previousLeft).toBe(28);
      }
      previousLeft = left;

      // Plan-fill height always reflects the plan ratio, regardless of popup
      // mode. maxHours defaults to 7.
      const planFill = byClass(cell, "task-gantt-workload-plan-fill")[0];
      const sourceIndex = dates.indexOf(date);
      expect(planFill.style.height).toBe(`${(plan[sourceIndex] / 7) * 100}%`);
    });
  });

  it("caps a long subtask's popup at the bar's own right edge, even when the wrap/viewport would allow more (long-subtask cap)", async () => {
    // The task has 20 planned days, but its rendered bar spans only 10.
    // The wider wrap and viewport must not extend the popup past barRect.right.
    const dates = Array.from({ length: 20 }, (_, i) => dateOffset(i));
    const { container, bar } = await openBarView({
      plannedStartDate: dates[0],
      plannedEndDate: dates[19],
    });
    bar.getBoundingClientRect = () => ({
      left: 500,
      top: 300,
      right: 780, // 500 + 10*28 — much narrower than the full 20-day range
      bottom: 324,
      width: 280,
      height: 24,
    });
    wrapOf(container).getBoundingClientRect = () => ({
      left: 100,
      top: 0,
      right: 2000, // far wider than the bar itself — never the limiter
      bottom: 600,
      width: 1900,
      height: 600,
    });
    winEl.innerWidth = 2000;
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const cells = byClass(popover, "task-gantt-workload-popover-cell");
    // graphMinLeft = max(8, 100+320+36) = 456 < barRect.left(500), so
    // startIndex stays 0 (no left clip). visibleRight = min(2000-8-36-9=1947,
    // 2000, 780) = 780 — the bar's own right edge is the tightest bound.
    // visibleDays = ceil((780-500)/28) = 10, so endIndex = 9: exactly the
    // first 10 dates, not all 20. (graphMaxLeft's min-width floor is far
    // above 500 here, so it never engages.)
    expect(cells.map((cell) => cell.attributes["data-date"])).toEqual(
      dates.slice(0, 10)
    );
    expect(popover.style.left).toBe("500px");
  });

  it("keeps the popup aligned when its min-width exceeds the graph width", async () => {
    // A single-day bar near the viewport's right edge has graph content
    // narrower than the popup's 200px minimum. The layout must account for
    // that minimum so the viewport clamp does not misalign the popup with its
    // date cells.
    const date = dateOffset(0);
    const { container, bar } = await openBarView({
      plannedStartDate: date,
      plannedEndDate: date,
    });
    bar.getBoundingClientRect = () => ({
      left: 1100,
      top: 300,
      right: 1128, // 1100 + 1*28
      bottom: 324,
      width: 28,
      height: 24,
    });
    wrapOf(container).getBoundingClientRect = () => ({
      left: 100,
      top: 0,
      right: 1200,
      bottom: 600,
      width: 1100,
      height: 600,
    });
    // winEl.innerWidth stays at the beforeEach default (1200).
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const cells = byClass(popover, "task-gantt-workload-popover-cell");
    expect(cells.map((cell) => cell.attributes["data-date"])).toEqual([date]);
    // graphMaxLeft = 1200 - 8 - 36 - 9 - max(28, 200-36-9) = 992, below the
    // bar's own unclamped graphLeft (1100) — computeWorkloadPopupLayout caps
    // graphLeft to 992 itself, and positionWorkloadPopup's own maxLeft
    // (1200 - 200 - 8 = 992) agrees exactly, so no further, unrelated clamp
    // fires. The single cell renders at local index 0.
    expect(popover.style.left).toBe("992px");
    expect(cells[0].style.left).toBe("0px");
  });

  it("keeps the body-appended popup anchor-relative and inside the viewport", async () => {
    const { view, container, bar } = await openBarView();
    bar.getBoundingClientRect = () => ({
      left: 1120,
      top: 300,
      right: 1190,
      bottom: 324,
      width: 70,
      height: 24,
    });
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    popover.offsetWidth = 300;
    popover.offsetHeight = 100;
    (view as any).positionWorkloadPopup(bar);
    expect(popover.parentNode).toBe(popoverBody());
    expect(popover.style.left).toBe("892px");
    // aboveTop = anchorRect.top(300) - GAP_PX(12) - height. height is
    // Math.max(WORKLOAD_POPOVER_MIN_HEIGHT_PX(122), offsetHeight stub(100))
    // = 122 (the min-height floor now exceeds the 100px stub), so
    // aboveTop = 300 - 12 - 122 = 166.
    expect(popover.style.top).toBe("166px");
    expect(popover.attributes["data-side"]).toBe("above");
  });

  it("re-places an open rich popover away from the workload popup when it opens, repeatably", async () => {
    const { view, container, bar } = await openBarView();
    bar.getBoundingClientRect = () => ({
      left: 100,
      top: 600,
      right: 1190,
      bottom: 624,
      width: 1090,
      height: 24,
    });
    // Rich popover opens first (mouseover precedes mouseenter): below does
    // not fit (624+12+180 > 800) so it goes above, where the workload popup
    // will also land.
    dispatch(bar, "mouseover", { clientX: 200, clientY: 610 });
    const rich = byClass(popoverBody(), "task-gantt-rich-popover")[0];
    expect(rich.style.top).toBe("408px"); // 600 - 12 - 180
    const workloadRect = { left: 90, top: 466, right: 290, bottom: 588 };
    vi.spyOn(view as any, "getWorkloadPopupRect").mockReturnValue(
      workloadRect
    );

    dispatch(bar, "mouseenter");
    expect(popoverOf(container)).toBeDefined();
    // Stacked above the workload popup: 466 - 12 - 180.
    expect(rich.style.top).toBe("274px");
    expect(rich.attributes["data-side"]).toBe("above");
    const bottom = parseFloat(rich.style.top) + 180;
    expect(bottom + 12).toBeLessThanOrEqual(workloadRect.top);

    // Repeated hover rebuilds the workload popup; placement stays put.
    dispatch(bar, "mouseenter");
    expect(rich.style.top).toBe("274px");
  });

  it("getWorkloadPopupRect reflects the open workload popup and clears when it closes", async () => {
    const { view, container, bar } = await openBarView();
    expect((view as any).getWorkloadPopupRect()).toBeUndefined();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    popover.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      right: 210,
      bottom: 142,
      width: 200,
      height: 122,
    });
    expect((view as any).getWorkloadPopupRect()).toEqual({
      left: 10,
      top: 20,
      right: 210,
      bottom: 142,
    });
    (view as any).closeWorkloadPopup();
    expect((view as any).getWorkloadPopupRect()).toBeUndefined();
  });

  it("renders plan as a backdrop and actual as the overlay sharing the same position, per the current mode", async () => {
    const targetDate = dateOffset(0);
    const { view, container, bar, sub } = await openBarView({
      workloadPlan: { [targetDate]: 3 },
      workloadActual: { [targetDate]: 1 },
    });
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const cell = cellByDate(popover, targetDate);
    const planFill = byClass(cell, "task-gantt-workload-plan-fill")[0];
    const activeFill = byClass(cell, "task-gantt-workload-fill")[0];

    // Plan-fill is always the plan ratio (the backdrop), independent of mode.
    // maxHours defaults to 7: plan=3h -> 3/7*100%.
    expect(planFill.style.height).toBe(`${(3 / 7) * 100}%`);
    // Default mode is "plan": the active fill also shows the plan ratio
    // (backdrop and overlay coincide) and is colored via the numeric
    // low-to-high HSL scale rather than the accent color.
    expect(popover.classList.contains("is-actual")).toBe(false);
    expect(activeFill.style.height).toBe(`${(3 / 7) * 100}%`);
    const planRatio = Math.max(0, Math.min(1, 3 / 7));
    const planHue = 205 - planRatio * 195;
    const planLightness = 74 - planRatio * 23;
    expect(activeFill.style.background).toBe(
      `hsl(${planHue} 88% ${planLightness}%)`
    );

    // Switching to actual mode: the active fill now shows the actual ratio
    // and is colored via the theme accent (CSS `.is-actual` gate, not an
    // inline color), while the plan-fill backdrop is unchanged.
    const toggle = toggleOf(popover);
    dispatch(toggle, "click");
    expect(popover.classList.contains("is-actual")).toBe(true);
    expect(planFill.style.height).toBe(`${(3 / 7) * 100}%`);
    expect(activeFill.style.height).toBe(`${(1 / 7) * 100}%`);
    expect(activeFill.style.background).toBe("");

    // A cell with NO recorded hours (any OTHER visible date) has zero
    // height on both fills.
    const dates = workloadDatesOf(view, sub);
    const emptyDate = dates.find((d) => d !== targetDate) as string;
    const emptyCell = cellByDate(popover, emptyDate);
    const emptyPlanFill = byClass(
      emptyCell,
      "task-gantt-workload-plan-fill"
    )[0];
    expect(emptyPlanFill.style.height).toBe("0%");
  });





  it("pointerdown on the graph paints the cell under the pointer into task.workloadPlan", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    const x = idx * 28 + 5;
    const y = 48; // (1 - 48/96) * 7 = 3.5 hours
    dispatch(graph, "pointerdown", { button: 0, clientX: x, clientY: y, pointerId: 1 });
    expect(sub.workloadPlan?.[dates[idx]]).toBe(3.5);
  });

  it("a non-left-button pointerdown does not paint", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    dispatch(graph, "pointerdown", {
      button: 2,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    expect(sub.workloadPlan?.[dates[idx]]).toBeUndefined();
    expect(view.getWorkloadPaintStateForTesting()).toBeUndefined();
  });

  it("a weekend cell is skipped during paint", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = weekendIndex(dates);
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    expect(sub.workloadPlan?.[dates[idx]]).toBeUndefined();
  });

  it("a pointer beyond the graph's edges clamps to the nearest cell/hour instead of going out of range", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    // Far below the graph (huge clientY) clamps to y=96 -> 0 hours -> entry deleted/never set.
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 999999,
      pointerId: 1,
    });
    expect(sub.workloadPlan?.[dates[idx]]).toBeUndefined();
    // Far above the graph (negative clientY) clamps to y=0 -> maxHours (7).
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: -999999,
      pointerId: 1,
    });
    expect(sub.workloadPlan?.[dates[idx]]).toBe(7);
  });

  it("pointermove paints additional cells while dragging", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    const nextIdx = dates.findIndex(
      (d, i) => i > idx && moment(d, "YYYY-MM-DD").day() !== 0 && moment(d, "YYYY-MM-DD").day() !== 6
    );
    expect(nextIdx).toBeGreaterThan(idx);
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    dispatch(winEl, "pointermove", {
      clientX: nextIdx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    expect(sub.workloadPlan?.[dates[idx]]).toBe(3.5);
    expect(sub.workloadPlan?.[dates[nextIdx]]).toBe(3.5);
  });

  it("pointerup commits the paint via persistWorkload -> host.updateTaskItem, normalized", async () => {
    const { view, container, h, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    dispatch(winEl, "pointerup", {
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    await flush();
    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
      workloadPlan: { [dates[idx]]: 3.5 },
      workloadActual: {},
    });
    expect(view.getWorkloadPaintStateForTesting()).toBeUndefined();
  });


  it("painting an event workload cell saves normalized plan/actual maps through settings", async () => {
    const date = dateOffset(0);
    const { container, h, event, chip } = await openEventView({
      workloadActual: { [date]: 1 },
    });
    dispatch(chip, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    stubGraphRect(graph, 28, 1);

    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: 5,
      clientY: 48,
      pointerId: 1,
    });
    expect(event.workloadPlan?.[date]).toBe(3.5);
    dispatch(winEl, "pointerup", {
      clientX: 5,
      clientY: 48,
      pointerId: 1,
    });
    await flush();

    expect(h.saveSettings).toHaveBeenCalledTimes(1);
    expect(h.settings.ganttEvents[0]).toMatchObject({
      key: event.key,
      title: "予定",
      date,
      workloadPlan: { [date]: 3.5 },
      workloadActual: { [date]: 1 },
    });
  });



  it("an event with only planned hours shows -h for actual in its dual day label", async () => {
    const date = dateOffset(0);
    const { timeline } = await openEventView({
      workloadPlan: { [date]: 3 },
    });
    const label = byClass(timeline, "task-gantt-workload-day-label")[0];

    expect(label).toBeDefined();
    expect(byClass(label, "task-gantt-workload-day-label-actual")[0].textContent).toBe(
      "-h"
    );
    expect(byClass(label, "task-gantt-workload-day-label-plan")[0].textContent).toBe(
      "3h"
    );
  });

  it("an event with only actual hours shows -h for plan in its dual day label", async () => {
    const date = dateOffset(0);
    const { timeline } = await openEventView({
      workloadActual: { [date]: 1.5 },
    });
    const label = byClass(timeline, "task-gantt-workload-day-label")[0];

    expect(label).toBeDefined();
    expect(byClass(label, "task-gantt-workload-day-label-actual")[0].textContent).toBe(
      "1.5h"
    );
    expect(byClass(label, "task-gantt-workload-day-label-plan")[0].textContent).toBe(
      "-h"
    );
  });

  it("an event with neither workload value has no dual day label", async () => {
    const { timeline } = await openEventView();
    expect(byClass(timeline, "task-gantt-workload-day-label")).toHaveLength(0);
  });

  it("the event context menu's 「複製」creates a same-date independent copy", async () => {
    const date = dateOffset(0);
    const { h, event, chip } = await openEventView({
      workloadPlan: { [date]: 3 },
      workloadActual: { [date]: 1.5 },
    });
    const original = h.settings.ganttEvents[0];

    dispatch(chip, "contextmenu", { clientX: 320, clientY: 20 });
    dispatch(menuItemWithText("複製"), "click");
    await flush();

    expect(h.settings.ganttEvents).toHaveLength(2);
    const duplicate = h.settings.ganttEvents[1];
    expect(duplicate).toMatchObject({
      title: "予定",
      date,
      workloadPlan: { [date]: 3 },
      workloadActual: { [date]: 1.5 },
    });
    expect(duplicate.key).not.toBe(original.key);
    expect(duplicate.workloadPlan).not.toBe(original.workloadPlan);
    expect(duplicate.workloadActual).not.toBe(original.workloadActual);
    expect(original).toMatchObject({
      key: event.key,
      title: "予定",
      date,
      workloadPlan: { [date]: 3 },
      workloadActual: { [date]: 1.5 },
    });
    expect(h.saveSettings).toHaveBeenCalledTimes(1);
  });



  it("refreshes the on-bar workload label and aggregate row after a workload save", async () => {
    const targetDate = dateOffset(0);
    const { view, container, h, timeline, bar, sub } = await openBarView({
      workloadActual: { [targetDate]: 1 },
    });
    const initialLabel = byClass(
      timeline,
      "task-gantt-workload-day-label"
    )[0];

    expect(
      byClass(initialLabel, "task-gantt-workload-day-label-plan")[0].textContent
    ).toBe("-h");


    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const targetIndex = dates.indexOf(targetDate);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: targetIndex * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    dispatch(winEl, "pointerup", {
      clientX: targetIndex * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    await flush();

    expect(h.loadTasks).toHaveBeenCalledTimes(2);
    const refreshedTimeline = timelineOf(parentRows(container)[0]);
    const refreshedLabel = byClass(
      refreshedTimeline,
      "task-gantt-workload-day-label"
    )[0];
    expect(
      byClass(
        refreshedLabel,
        "task-gantt-workload-day-label-actual"
      )[0].textContent
    ).toBe("1h");
    expect(
      byClass(refreshedLabel, "task-gantt-workload-day-label-plan")[0]
        .textContent
    ).toBe("3.5h");

    const summaryCell = byClass(
      container,
      "task-gantt-workload-summary-cell"
    ).find((cell) => cell.attributes["data-date"] === targetDate);
    expect(summaryCell).toBeDefined();
    expect(
      byClass(
        summaryCell as FakeEl,
        "task-gantt-workload-summary-actual"
      )[0].textContent
    ).toBe("1h");
    expect(
      byClass(
        summaryCell as FakeEl,
        "task-gantt-workload-summary-plan"
      )[0].textContent
    ).toBe("3.5h");
  });


  it("toggling to 「実績時間」 before painting writes workloadActual, not workloadPlan", async () => {
    const { view, container, h, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const toggle = toggleOf(popover);
    dispatch(toggle, "click"); // 計画時間 -> 実績時間
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    dispatch(winEl, "pointerup", {
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    await flush();
    expect(sub.workloadActual?.[dates[idx]]).toBe(3.5);
    expect(sub.workloadPlan?.[dates[idx]]).toBeUndefined();
    expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
      workloadPlan: {},
      workloadActual: { [dates[idx]]: 3.5 },
    });
  });

  it("a second pointer's move on the same graph does not paint through the first session's stale closure", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    const otherIdx = dates.findIndex(
      (d, i) => i > idx && moment(d, "YYYY-MM-DD").day() !== 0 && moment(d, "YYYY-MM-DD").day() !== 6
    );
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    // A different pointerId's move (e.g. a second touch point) fires on the
    // same shared window listener — must be ignored by session 1's closure.
    dispatch(winEl, "pointermove", {
      clientX: otherIdx * 28 + 5,
      clientY: 48,
      pointerId: 2,
    });
    expect(sub.workloadPlan?.[dates[otherIdx]]).toBeUndefined();
    expect(view.getWorkloadPaintStateForTesting()?.pointerId).toBe(1);
  });

  it("pointercancel clears the paint state WITHOUT persisting", async () => {
    const { view, container, h, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const popover = popoverOf(container) as FakeEl;
    const graph = graphOf(popover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(graph, 28, dates.length);
    const idx = businessIndex(dates);
    dispatch(graph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    expect(sub.workloadPlan?.[dates[idx]]).toBe(3.5); // painted in-memory already
    dispatch(winEl, "pointercancel", { pointerId: 1 });
    await flush();
    expect(h.updateTaskItem).not.toHaveBeenCalled(); // no commit
    expect(view.getWorkloadPaintStateForTesting()).toBeUndefined();
  });

  it("a stray pointermove reaching a torn-down session's own closure is dropped BEFORE it ever reads that graph's rect — only the current session's chartEl is consulted", async () => {
    const { view, container, bar, sub } = await openBarView();
    dispatch(bar, "mouseenter");
    const firstPopover = popoverOf(container) as FakeEl;
    const firstGraph = graphOf(firstPopover);
    const dates = workloadDatesOf(view, sub);
    stubGraphRect(firstGraph, 28, dates.length);
    const firstRectSpy = vi.spyOn(firstGraph, "getBoundingClientRect");
    const idx = businessIndex(dates);
    dispatch(firstGraph, "pointerdown", {
      button: 0,
      clientX: idx * 28 + 5,
      clientY: 48,
      pointerId: 1,
    });
    expect(view.getWorkloadPaintStateForTesting()?.chartEl).toBe(firstGraph);
    expect(firstRectSpy).toHaveBeenCalledTimes(1); // the pointerdown's own initial paint

    // Re-trigger tears down the first popover and opens a fresh one,
    // which overwrites workloadPaintState even though the first
    // session's own window pointermove/pointerup closures are STILL
    // attached (never removed — no exclusive lock, same as dragState).
    dispatch(bar, "mouseenter");
    const secondPopover = popoverOf(container) as FakeEl;
    const secondGraph = graphOf(secondPopover);
    stubGraphRect(secondGraph, 28, dates.length);
    dispatch(secondGraph, "pointerdown", {
      button: 0,
      clientX: (idx + 1) * 28 + 5,
      clientY: 48,
      pointerId: 2,
    });
    expect(view.getWorkloadPaintStateForTesting()?.chartEl).toBe(secondGraph);

    firstRectSpy.mockClear();
    // ONE dispatched pointermove reaches BOTH sessions' still-attached
    // window closures. The first's guard (chartEl !== the CURRENT
    // workloadPaintState.chartEl) must short-circuit before it ever calls
    // firstGraph.getBoundingClientRect again; the second (now-active)
    // session paints normally using secondGraph's own rect.
    dispatch(winEl, "pointermove", {
      clientX: (idx + 2) * 28 + 5,
      clientY: 48,
      pointerId: 2,
    });
    expect(firstRectSpy).not.toHaveBeenCalled(); // guarded before reaching the stale graph's math
    expect(sub.workloadPlan?.[dates[idx + 2]]).toBe(3.5); // second session's own write went through
  });
});



// Tests for marker tag badges, bar-level workload labels, workload summary
// rows, and the day-summary popover.


describe("marker tag badges, workload labels, and summary popovers", () => {
  let winEl: FakeEl;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00")); // a Tuesday
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
    winEl = (globalThis as any).window as FakeEl;
    winEl.innerWidth = 1200;
    winEl.innerHeight = 800;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });


  // Marker tag badge.


  describe("marker tag badge", () => {
    it("shows the marker's primary registry tag as a badge", async () => {
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        ganttMarkers: [
          {
            key: "m1",
            title: "M1",
            date: dateOffset(2),
            tags: ["urgent", "backend"],
          },
        ],
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent], {
        ganttTags: [
          tagDefinition("urgent", "#778899"),
          tagDefinition("backend", "#8899aa", 1000),
        ],
      });
      const timeline = timelineOf(parentRows(container)[0]);
      const markerEl = byClass(timeline, "task-gantt-marker")[0];
      const badges = byClass(markerEl, "task-gantt-marker-tag");
      expect(badges).toHaveLength(1);
      expect(badges[0].textContent).toBe("urgent");
      expect(styleVar(badges[0], "--vg-chip-color")).toBe("#778899");
    });

    it("no badge when the marker has no tags", async () => {
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const markerEl = byClass(timeline, "task-gantt-marker")[0];
      expect(byClass(markerEl, "task-gantt-marker-tag")).toHaveLength(0);
    });

    it("consistent: no badge when the tags feature is disabled, even if the marker has tags", async () => {
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        ganttMarkers: [
          { key: "m1", title: "M1", date: dateOffset(2), tags: ["urgent"] },
        ],
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent], {
        ganttFeatureTagsEnabled: false,
      });
      const timeline = timelineOf(parentRows(container)[0]);
      const markerEl = byClass(timeline, "task-gantt-marker")[0];
      expect(byClass(markerEl, "task-gantt-marker-tag")).toHaveLength(0);
    });
  });


  // Bar-level static workload label


  describe("per-date static workload labels", () => {
    it("renders one dual label per date with data at that date's column", async () => {
      const firstDate = dateOffset(0);
      const secondDate = dateOffset(1);
      const thirdDate = dateOffset(3);
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: {
          [firstDate]: 3,
          [secondDate]: 2,
          [thirdDate]: 1,
          [dateOffset(10)]: 9,
        },
        workloadActual: { [firstDate]: 1, [thirdDate]: 0.5 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { view, container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const labels = byClass(timeline, "task-gantt-workload-day-label");
      expect(labels).toHaveLength(3);
      expect(byClass(timeline, "task-gantt-workload-bar-label")).toHaveLength(0);

      const bar = byClass(timeline, "task-gantt-bar")[0];
      const expectedTop = Math.max(0, Number.parseFloat(bar.style.top) - 18);

      const expected = [
        { date: firstDate, actual: "1h", plan: "3h" },
        { date: secondDate, actual: "-h", plan: "2h" },
        { date: thirdDate, actual: "0.5h", plan: "1h" },
      ];

      expected.forEach(({ date, actual, plan }, index) => {
        const label = labels[index];
        expect(label.classList.contains("is-dual")).toBe(true);
        expect(label.style.left).toBe(
          `${diffDays(baseDateOf(view), date) * 28}px`
        );
        expect(label.style.top).toBe(`${expectedTop}px`);
        expect(label.style.width).toBe("28px");
        expect(
          byClass(label, "task-gantt-workload-day-label-actual")[0].textContent
        ).toBe(actual);
        expect(
          byClass(label, "task-gantt-workload-day-label-plan")[0].textContent
        ).toBe(plan);
      });
    });

    it("uses 「-h」 for the zero side of a one-sided label and skips a zero-only date", async () => {
      const planOnlyDate = dateOffset(0);
      const actualOnlyDate = dateOffset(1);
      const bothDate = dateOffset(2);
      const zeroOnlyDate = dateOffset(3);
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: {
          [planOnlyDate]: 2,
          [bothDate]: 3,
          [zeroOnlyDate]: 0,
        },
        workloadActual: {
          [planOnlyDate]: 0,
          [actualOnlyDate]: 1.5,
          [bothDate]: 0.5,
          [zeroOnlyDate]: 0,
        },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { view, container } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const labels = byClass(timeline, "task-gantt-workload-day-label");
      expect(labels).toHaveLength(3);

      const labelFor = (date: string): FakeEl => {
        const label = labels.find(
          (candidate) =>
            candidate.style.left ===
            `${diffDays(baseDateOf(view), date) * 28}px`
        );
        expect(label).toBeDefined();
        return label as FakeEl;
      };

      const planOnlyLabel = labelFor(planOnlyDate);
      expect(
        byClass(planOnlyLabel, "task-gantt-workload-day-label-actual")[0]
          .textContent
      ).toBe("-h");
      expect(
        byClass(planOnlyLabel, "task-gantt-workload-day-label-plan")[0]
          .textContent
      ).toBe("2h");

      const actualOnlyLabel = labelFor(actualOnlyDate);
      expect(
        byClass(actualOnlyLabel, "task-gantt-workload-day-label-actual")[0]
          .textContent
      ).toBe("1.5h");
      expect(
        byClass(actualOnlyLabel, "task-gantt-workload-day-label-plan")[0]
          .textContent
      ).toBe("-h");

      const bothLabel = labelFor(bothDate);
      expect(
        byClass(bothLabel, "task-gantt-workload-day-label-actual")[0]
          .textContent
      ).toBe("0.5h");
      expect(
        byClass(bothLabel, "task-gantt-workload-day-label-plan")[0].textContent
      ).toBe("3h");
      expect(deepText(bothLabel)).not.toContain("-h");

      expect(
        labels.some(
          (label) =>
            label.style.left ===
            `${diffDays(baseDateOf(view), zeroOnlyDate) * 28}px`
        )
      ).toBe(false);
    });

    it("renders no label when the task has no recorded hours at all", async () => {
      const { container } = await openViewWithBar();
      const timeline = timelineOf(parentRows(container)[0]);
      expect(byClass(timeline, "task-gantt-workload-day-label")).toHaveLength(0);
    });

    it("renders no label when the workload feature is disabled, even with recorded hours", async () => {
      const sub = makeSubtask("sub1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 3 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent], {
        ganttFeatureWorkloadEnabled: false,
      });
      const timeline = timelineOf(parentRows(container)[0]);
      expect(byClass(timeline, "task-gantt-workload-day-label")).toHaveLength(0);
    });
  });

  /** Opens a view with one gantt-enabled parent + one 6-day subtask bar. */
  async function openViewWithBar(
    subOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    parent: TaskRow;
    sub: TaskRow;
  }> {
    const sub = makeSubtask("sub1", {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(5),
      ...subOverrides,
    });
    const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
    const { view, container, h } = await openView([parent], settingsOverrides);
    const timeline = timelineOf(parentRows(container)[0]);
    return { view, container, timeline, h, parent, sub };
  }


  // Workload summary row aggregation.


  describe("workload summary row aggregation", () => {
    function summaryCellAt(container: FakeEl, date: string): FakeEl {
      const row = byClass(container, "task-gantt-workload-row")[0];
      const cell = byClass(row, "task-gantt-workload-summary-cell").find(
        (el) => el.attributes["data-date"] === date
      );
      if (!cell) {
        throw new Error(`no summary cell for ${date}`);
      }
      return cell;
    }

    it("sums every subtask's plan/actual hours on a date across parents", async () => {
      const subA = makeSubtask("a1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 3 },
      });
      const parentA = withChildren(
        makeParent({ ganttEnabled: true, id: "tasks/pA.md", file: { path: "tasks/pA.md" } }),
        [subA]
      );
      const subB = makeSubtask("b1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 2 },
      });
      const parentB = withChildren(
        makeParent({ ganttEnabled: true, id: "tasks/pB.md", file: { path: "tasks/pB.md" } }),
        [subB]
      );
      const { container } = await openView([parentA, parentB]);
      const cell = summaryCellAt(container, dateOffset(0));
      // capacity default 7h; plan total 3+2=5 -> not over capacity.
      expect(cell.classList.contains("is-over-capacity")).toBe(false);
    });

    it("renders rounded actual/plan labels and marks zero-total cells empty", async () => {
      const planOnlyDate = dateOffset(0);
      const bothDate = dateOffset(1);
      const emptyDate = dateOffset(2);
      const sub = makeSubtask("a1", {
        plannedStartDate: planOnlyDate,
        plannedEndDate: dateOffset(5),
        workloadPlan: {
          [planOnlyDate]: 3,
          [bothDate]: 3.5,
        },
        workloadActual: {
          [bothDate]: 3,
        },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent]);

      const planOnlyCell = summaryCellAt(container, planOnlyDate);
      expect(byClass(planOnlyCell, "task-gantt-workload-summary-actual")[0].textContent).toBe("");
      expect(byClass(planOnlyCell, "task-gantt-workload-summary-plan")[0].textContent).toBe("3h");
      expect(planOnlyCell.classList.contains("is-empty")).toBe(false);

      const bothCell = summaryCellAt(container, bothDate);
      expect(byClass(bothCell, "task-gantt-workload-summary-actual")[0].textContent).toBe("3h");
      expect(byClass(bothCell, "task-gantt-workload-summary-plan")[0].textContent).toBe("3.5h");
      expect(bothCell.classList.contains("is-empty")).toBe(false);

      const emptyCell = summaryCellAt(container, emptyDate);
      expect(byClass(emptyCell, "task-gantt-workload-summary-actual")[0].textContent).toBe("");
      expect(byClass(emptyCell, "task-gantt-workload-summary-plan")[0].textContent).toBe("");
      expect(emptyCell.classList.contains("is-empty")).toBe(true);
    });


    it("a matching weekly schedule adds plan hours without changing actual hours", async () => {
      const matchingDate = dateOffset(0);
      const { container } = await openView([], {
        weeklyWorkSchedules: [
          {
            key: "schedule-1",
            title: "習字",
            dayOfWeek: moment(matchingDate, "YYYY-MM-DD").day(),
            minutesPerWeek: 30,
          },
        ],
      });
      const cell = summaryCellAt(container, matchingDate);

      expect(
        byClass(cell, "task-gantt-workload-summary-plan")[0].textContent
      ).toBe("0.5h");
      expect(
        byClass(cell, "task-gantt-workload-summary-actual")[0].textContent
      ).toBe("");
    });

    it("a weekly schedule on another weekday contributes nothing", async () => {
      const matchingDate = dateOffset(0);
      const nonMatchingDate = dateOffset(1);
      const { container } = await openView([], {
        weeklyWorkSchedules: [
          {
            key: "schedule-1",
            title: "習字",
            dayOfWeek: moment(matchingDate, "YYYY-MM-DD").day(),
            minutesPerWeek: 60,
          },
        ],
      });
      const cell = summaryCellAt(container, nonMatchingDate);

      expect(
        byClass(cell, "task-gantt-workload-summary-plan")[0].textContent
      ).toBe("");
      expect(cell.classList.contains("is-empty")).toBe(true);
    });

    it("shows the settings button only while workload is enabled", async () => {
      const enabled = await openView([]);
      expect(byClass(enabled.container, "task-gantt-workload-settings-button")).toHaveLength(1);
      expect(
        byClass(enabled.container, "task-gantt-workload-settings-button")[0].textContent
      ).toBe("定例作業設定");

      const disabled = await openView([], { ganttFeatureWorkloadEnabled: false });
      expect(byClass(disabled.container, "task-gantt-workload-settings-button")).toHaveLength(0);
    });


    it("marks is-over-capacity when the date's summed plan exceeds getCapacityHours", async () => {
      const sub = makeSubtask("a1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 8 }, // default capacity is 7
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent]);
      const cell = summaryCellAt(container, dateOffset(0));
      expect(cell.classList.contains("is-over-capacity")).toBe(true);
    });

    it("fills summary bands by capacity without replacing warning treatments", async () => {
      const halfDate = dateOffset(0);
      const emptyDate = dateOffset(1);
      const warningDate = dateOffset(2);
      const sub = makeSubtask("a1", {
        plannedStartDate: halfDate,
        plannedEndDate: warningDate,
        workloadPlan: {
          [halfDate]: 4,
          [warningDate]: 9,
        },
        workloadActual: {
          [warningDate]: 10,
        },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent], {
        ganttWorkloadDailyCapacityHours: 8,
      });

      const halfCell = summaryCellAt(container, halfDate);
      expect(halfCell.style["--twb-workload-plan-ratio"]).toBe("50.0%");
      expect(halfCell.style["--twb-workload-actual-ratio"]).toBe("0.0%");

      const emptyCell = summaryCellAt(container, emptyDate);
      expect(emptyCell.style["--twb-workload-plan-ratio"]).toBe("0.0%");
      expect(emptyCell.style["--twb-workload-actual-ratio"]).toBe("0.0%");

      const warningCell = summaryCellAt(container, warningDate);
      expect(warningCell.classList.contains("is-over-capacity")).toBe(true);
      expect(warningCell.classList.contains("is-actual-over-plan")).toBe(true);
      expect(warningCell.style["--twb-workload-plan-ratio"]).toBe("100.0%");
      expect(warningCell.style["--twb-workload-actual-ratio"]).toBe("100.0%");
    });

    it("marks is-actual-over-plan when the date's summed actual exceeds summed plan", async () => {
      const sub = makeSubtask("a1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 1 },
        workloadActual: { [dateOffset(0)]: 3 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent]);
      const cell = summaryCellAt(container, dateOffset(0));
      expect(cell.classList.contains("is-actual-over-plan")).toBe(true);
    });

    it("a parent with zero subtasks contributes nothing to any date's total", async () => {
      const emptyParent = makeParent({ ganttEnabled: true });
      const { container } = await openView([emptyParent]);
      const cell = summaryCellAt(container, dateOffset(0));
      expect(cell.classList.contains("is-over-capacity")).toBe(false);
      expect(cell.classList.contains("is-actual-over-plan")).toBe(false);
    });

    it("workload recorded outside the subtask's OWN planned range is not counted", async () => {
      const sub = makeSubtask("a1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(2),
        // dateOffset(10) is far outside [plannedStartDate, plannedEndDate].
        workloadPlan: { [dateOffset(10)]: 9 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent]);
      const cell = summaryCellAt(container, dateOffset(10));
      // 9h would trip is-over-capacity (default 7h) if it were counted.
      expect(cell.classList.contains("is-over-capacity")).toBe(false);
    });

    it("the whole row (and its cells) is absent when the workload feature is disabled", async () => {
      const sub = makeSubtask("a1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 8 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent], {
        ganttFeatureWorkloadEnabled: false,
      });
      expect(byClass(container, "task-gantt-workload-row")).toHaveLength(0);
    });
  });


  // Day-summary popover tests use fake timers.


  describe("day-summary popover", () => {
    function summaryCellAt(container: FakeEl, date: string): FakeEl {
      const row = byClass(container, "task-gantt-workload-row")[0];
      const cell = byClass(row, "task-gantt-workload-summary-cell").find(
        (el) => el.attributes["data-date"] === date
      );
      if (!cell) {
        throw new Error(`no summary cell for ${date}`);
      }
      return cell;
    }

    function popoverOf(_container: FakeEl): FakeEl {
      return byClass(popoverBody(), "task-gantt-workload-day-summary-popover")[0];
    }


    function initialVisibleDates(): string[] {
      return Array.from({ length: 90 }, (_, index) => dateOffset(index - 14));
    }

    function findDate(
      dates: string[],
      predicate: (date: string) => boolean
    ): string {
      const found = dates.find(predicate);
      if (!found) {
        throw new Error("対象日付が見つかりません");
      }
      return found;
    }



    it("週末の作業時間集計セルは内容とホバーを抑制する", async () => {
      const dates = initialVisibleDates();
      const weekend = findDate(dates, (date) => {
        const day = moment(date, "YYYY-MM-DD").day();
        return day === 0 || day === 6;
      });
      const sub = makeSubtask("a1", {
        plannedStartDate: dates[0],
        plannedEndDate: dates[dates.length - 1],
        workloadPlan: { [weekend]: 4 },
        workloadActual: { [weekend]: 2 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { view, container } = await openView([parent], {
        ganttNationalHolidays: [],
        ganttManualHolidays: [],
        ganttSpecialHolidays: [],
      });
      const cell = summaryCellAt(container, weekend);
      expect(cell.classList.contains("is-non-working")).toBe(true);
      expect(cell.style.width).toBe("28px");
      expect(cell.textContent).toBe("");
      expect(
        byClass(cell, "task-gantt-workload-summary-actual")
      ).toHaveLength(0);
      expect(byClass(cell, "task-gantt-workload-summary-plan")).toHaveLength(0);
      expect(cell.style["--twb-workload-plan-ratio"]).toBeUndefined();
      expect(cell.style["--twb-workload-actual-ratio"]).toBeUndefined();
      dispatch(cell, "mouseenter");
      expect(popoverOf(container)).toBeUndefined();

      const row = byClass(container, "task-gantt-workload-row")[0];
      const bg = byClass(row, "task-gantt-fixed-bg")[
        datesOf(view).indexOf(weekend)
      ];
      expect(bg.classList.contains("is-weekend")).toBe(true);
    });



    it("祝日の作業時間集計セルは内容とホバーを抑制する", async () => {
      const dates = initialVisibleDates();
      const holiday = findDate(dates, (date) => {
        const day = moment(date, "YYYY-MM-DD").day();
        return day >= 1 && day <= 5;
      });
      const sub = makeSubtask("a1", {
        plannedStartDate: dates[0],
        plannedEndDate: dates[dates.length - 1],
        workloadPlan: { [holiday]: 5 },
        workloadActual: { [holiday]: 3 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { view, container } = await openView([parent], {
        ganttNationalHolidays: [],
        ganttManualHolidays: [holiday],
        ganttSpecialHolidays: [],
      });
      const cell = summaryCellAt(container, holiday);
      expect(cell.classList.contains("is-non-working")).toBe(true);
      expect(cell.style.width).toBe("28px");
      expect(cell.textContent).toBe("");
      expect(
        byClass(cell, "task-gantt-workload-summary-actual")
      ).toHaveLength(0);
      expect(byClass(cell, "task-gantt-workload-summary-plan")).toHaveLength(0);
      expect(cell.style["--twb-workload-plan-ratio"]).toBeUndefined();
      expect(cell.style["--twb-workload-actual-ratio"]).toBeUndefined();
      dispatch(cell, "mouseenter");
      expect(popoverOf(container)).toBeUndefined();

      const row = byClass(container, "task-gantt-workload-row")[0];
      const bg = byClass(row, "task-gantt-fixed-bg")[
        datesOf(view).indexOf(holiday)
      ];
      expect(bg.classList.contains("is-holiday")).toBe(true);
    });



    it("平日の作業時間集計セルはラベルとポップオーバーを維持する", async () => {
      const dates = initialVisibleDates();
      const weekday = findDate(dates, (date) => {
        const day = moment(date, "YYYY-MM-DD").day();
        return day >= 1 && day <= 5;
      });
      const sub = makeSubtask("a1", {
        plannedStartDate: dates[0],
        plannedEndDate: dates[dates.length - 1],
        workloadPlan: { [weekday]: 4 },
        workloadActual: { [weekday]: 2 },
      });
      const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
      const { container } = await openView([parent], {
        ganttNationalHolidays: [],
        ganttManualHolidays: [],
        ganttSpecialHolidays: [],
      });
      const cell = summaryCellAt(container, weekday);
      expect(cell.classList.contains("is-non-working")).toBe(false);
      expect(
        byClass(cell, "task-gantt-workload-summary-actual")[0].textContent
      ).toBe("2h");
      expect(
        byClass(cell, "task-gantt-workload-summary-plan")[0].textContent
      ).toBe("4h");
      dispatch(cell, "mouseenter");
      expect(popoverOf(container)).toBeTruthy();
    });


    it("hovering a date cell opens a popover titled 「作業時間 M/D」 with 実績/想定 sections listing matching entries", async () => {
      const sub = makeSubtask("a1", {
        displayName: "Sub A",
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(5),
        workloadPlan: { [dateOffset(0)]: 4 },
        workloadActual: { [dateOffset(0)]: 2 },
      });
      const parent = withChildren(
        makeParent({ ganttEnabled: true, displayName: "Parent A" }),
        [sub]
      );
      const { container } = await openView([parent]);
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "mouseenter");

      const popover = popoverOf(container);
      expect(popover).toBeTruthy();
      const title = byClass(
        popover,
        "task-gantt-workload-day-summary-popover-title"
      )[0];
      const expectedMD = moment(dateOffset(0), "YYYY-MM-DD").format("M/D");
      expect(title.textContent).toBe(`作業時間 ${expectedMD}`);

      const sections = byClass(
        popover,
        "task-gantt-workload-day-summary-popover-section"
      );
      expect(sections).toHaveLength(2); // 実績, 想定

      const actualEntries = byClass(
        sections[0],
        "task-gantt-workload-day-summary-popover-entry"
      );
      expect(actualEntries).toHaveLength(1);
      expect(actualEntries[0].textContent).toBe("Parent A / Sub A: 2h");

      const planEntries = byClass(
        sections[1],
        "task-gantt-workload-day-summary-popover-entry"
      );
      expect(planEntries).toHaveLength(1);
      expect(planEntries[0].textContent).toBe("Parent A / Sub A: 4h");
    });


    it("adds matching weekly schedules to the plan section and keeps the shared sort order", async () => {
      const matchingDate = dateOffset(0);
      const sub = makeSubtask("sub1", {
        displayName: "Sub A",
        plannedStartDate: matchingDate,
        plannedEndDate: dateOffset(5),
        workloadPlan: { [matchingDate]: 3 },
      });
      const parent = withChildren(
        makeParent({ ganttEnabled: true, displayName: "Parent A" }),
        [sub]
      );
      const { container } = await openView([parent], {
        weeklyWorkSchedules: [
          {
            key: "schedule-1",
            title: "習字",
            dayOfWeek: moment(matchingDate, "YYYY-MM-DD").day(),
            minutesPerWeek: 120,
          },
        ],
      });
      const cell = summaryCellAt(container, matchingDate);
      dispatch(cell, "mouseenter");

      const popover = popoverOf(container);
      const sections = byClass(
        popover,
        "task-gantt-workload-day-summary-popover-section"
      );
      const actualEntries = byClass(
        sections[0],
        "task-gantt-workload-day-summary-popover-entry"
      );
      const planEntries = byClass(
        sections[1],
        "task-gantt-workload-day-summary-popover-entry"
      );
      expect(actualEntries).toHaveLength(0);
      expect(byClass(sections[0], "task-gantt-workload-day-summary-popover-empty")).toHaveLength(1);
      expect(planEntries.map((entry) => entry.textContent)).toEqual([
        "Parent A / Sub A: 3h",
        "週次定例 / 習字: 2h",
      ]);
      expect(byClass(sections[1], "task-gantt-workload-day-summary-popover-empty")).toHaveLength(0);
    });


    it("shows 「なし」 in a section with no entries for that date", async () => {
      const { container } = await openViewWithBar(); // no workload data at all
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "mouseenter");

      const popover = popoverOf(container);
      const sections = byClass(
        popover,
        "task-gantt-workload-day-summary-popover-section"
      );
      for (const section of sections) {
        const empty = byClass(
          section,
          "task-gantt-workload-day-summary-popover-empty"
        );
        expect(empty).toHaveLength(1);
        expect(empty[0].textContent).toBe("なし");
      }
    });

    it("equivalent: hovering a (possibly different) date cell while one is open tears down and rebuilds fresh", async () => {
      const { container } = await openViewWithBar();
      const cellA = summaryCellAt(container, dateOffset(0));
      dispatch(cellA, "mouseenter");
      const first = popoverOf(container);
      expect(first).toBeTruthy();

      const cellB = summaryCellAt(container, dateOffset(1));
      dispatch(cellB, "mouseenter");
      const second = popoverOf(container);
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect(byClass(popoverBody(), "task-gantt-workload-day-summary-popover")).toHaveLength(1);
    });

    it("hands off from the date cell to the popover, then hides 140ms after leaving the popover", async () => {
      const { container } = await openViewWithBar();
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "mouseenter");
      const popover = popoverOf(container);
      expect(popover).toBeTruthy();

      dispatch(cell, "mouseleave");
      vi.advanceTimersByTime(100);
      dispatch(popover, "mouseenter");
      vi.advanceTimersByTime(100);
      expect(popoverOf(container)).toBeTruthy();

      dispatch(popover, "mouseleave");
      vi.advanceTimersByTime(139);
      expect(popoverOf(container)).toBeTruthy();
      vi.advanceTimersByTime(1);
      expect(popoverOf(container)).toBeUndefined();
    });

    it("re-entering the popover before the 140ms elapses cancels the hide", async () => {
      const { container } = await openViewWithBar();
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "mouseenter");
      const popover = popoverOf(container);

      dispatch(popover, "mouseleave");
      vi.advanceTimersByTime(100);
      dispatch(popover, "mouseenter");
      vi.advanceTimersByTime(200);
      expect(popoverOf(container)).toBeTruthy();
    });

    it("closes immediately on chart scroll", async () => {
      const { container } = await openViewWithBar();
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "mouseenter");
      expect(popoverOf(container)).toBeTruthy();

      dispatch(wrapOf(container), "scroll");
      expect(popoverOf(container)).toBeUndefined();
    });

    it("keeps inside interactions open and closes on an outside pointer interaction", async () => {
      const { container } = await openViewWithBar();
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "mouseenter");
      const popover = popoverOf(container);
      expect(popover).toBeTruthy();

      const winEl = (globalThis as unknown as { window: FakeEl }).window;
      dispatch(winEl, "pointerdown", { target: popover.children[0] });
      expect(popoverOf(container)).toBeTruthy();

      dispatch(winEl, "pointerdown", { target: makeFakeEl("div") });
      expect(popoverOf(container)).toBeUndefined();
    });

    it("a click alone does not open the hover-triggered popover", async () => {
      const { container } = await openViewWithBar();
      const cell = summaryCellAt(container, dateOffset(0));
      dispatch(cell, "click");
      expect(popoverOf(container)).toBeUndefined();
    });

    it("the summary row is absent when the workload feature is disabled", async () => {
      const { container } = await openViewWithBar(
        {},
        { ganttFeatureWorkloadEnabled: false }
      );
      expect(byClass(container, "task-gantt-workload-row")).toHaveLength(0);
      // No summary row/cells exist at all to hover when the feature is off.
    });
  });
});





describe("inline title editing and marker modal", () => {
  beforeEach(() => {

    // this is a sibling describe, so the root block's hooks do not reach it.
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Opens a view with one gantt-enabled parent + one 6-day subtask bar. */
  async function openBarView(
    subOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    parent: TaskRow;
    sub: TaskRow;
    bar: FakeEl;
  }> {
    const sub = makeSubtask("sub1", {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(5),
      ...subOverrides,
    });
    const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
    const { view, container, h } = await openView([parent], settingsOverrides);
    const timeline = timelineOf(parentRows(container)[0]);
    const bar = byClass(timeline, "task-gantt-bar")[0];
    return { view, container, timeline, h, parent, sub, bar };
  }

  function markerElOf(timeline: FakeEl): FakeEl {
    return byClass(timeline, "task-gantt-marker")[0];
  }

  async function openTagMenuTarget(
    targetKind: "bar" | "marker" | "parent"
  ): Promise<{ view: TaskGanttView; target: FakeEl }> {
    if (targetKind === "bar") {
      const opened = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["urgent"]) }
      );
      return { view: opened.view, target: opened.bar };
    }
    if (targetKind === "marker") {
      const opened = await openBarView(
        {
          tags: [],
          ganttMarkers: [
            { key: "m1", title: "M", date: dateOffset(1), tags: [] },
          ],
        },
        { ganttTags: tagRegistry(["urgent"]) }
      );
      return { view: opened.view, target: markerElOf(opened.timeline) };
    }

    const parent = makeParent({ ganttEnabled: true, tags: [] });
    const opened = await openView([parent], {
      ganttTags: tagRegistry(["urgent"]),
    });
    return {
      view: opened.view,
      target: leftOf(parentRows(opened.container)[0]),
    };
  }

  function editorInputOf(timeline: FakeEl): FakeEl {
    return byClass(timeline, "task-gantt-inline-editor")[0];
  }



  // trigger —.. describe the shared mechanism, not a field of
  // their own).


  describe("general inline-edit flow", () => {
    it("dblclick hides the bar and opens a focused, pre-filled, fully-selected input", async () => {
      const { timeline, bar } = await openBarView({ displayName: "元の名前" });
      dispatch(bar, "dblclick");

      expect(bar.style.display).toBe("none");
      const input = editorInputOf(timeline);
      expect(input).toBeDefined();
      expect(input.parentNode).toBe(timeline); // created in hostEl's parent
      expect(input.value).toBe("元の名前");
      expect(input.classList.contains("task-gantt-inline-editor")).toBe(true);
      expect(input.focused).toBe(true);
      expect(input.selected).toBe(true);

      // inline left/top so it renders visibly where the hidden bar was.
      expect(input.style.position).toBe("absolute");
      expect(input.style.left).toBe(bar.style.left);
      expect(input.style.top).toBe(bar.style.top);
      expect(input.style.width).toBe(bar.style.width);
      expect(input.style.height).toBe(bar.style.height);
    });

    it("a pointerdown on the bar while its editor is open does not start a drag", async () => {
      const { view, bar } = await openBarView();
      dispatch(bar, "dblclick");
      const before = view.getActiveDragStateForTesting();

      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });

      expect(view.getActiveDragStateForTesting()).toBe(before);
      expect(bar.classList.contains("is-dragging")).toBe(false);
    });

    it("a real double-click's two pointerdown/pointerup pairs (which fire BEFORE the dblclick event itself, and thus before inlineEditingEls is armed) stay harmless: no save, no workload dialog, and the editor still opens correctly afterwards", async () => {
      // Provide workloadActual so an unintended drag reaching saveTaskPatch
      // would trigger the confirmation-dialog assertion below.
      // confirm-workload-shift dialog assertion below would actually catch
      // it (a task with no workloadActual would silently pass either way).
      const { timeline, h, bar } = await openBarView({
        workloadActual: { [dateOffset(0)]: 2 },
      });
      const windowEl = (globalThis as any).window as FakeEl;

      // Real browser event order for a double-click is mousedown -> mouseup
      // -> mousedown -> mouseup -> dblclick — both pointerdown/pointerup
      // pairs happen BEFORE the dblclick handler (and therefore
      // startInlineEdit/inlineEditingEls) ever runs, so both pairs go
      // through onBarPointerDown -> runBarDrag completely unguarded. This
      // is only harmless today because a stationary double-click has ~0px
      // movement between its own pointerdown/pointerup, and finishBarDrag
      // short-circuits on dayDelta === 0 before any
      // patch/confirm-dialog logic runs.
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(windowEl, "pointerup", { clientX: 100, clientY: 50 }); // 0px move
      dispatch(bar, "pointerdown", { button: 0, clientX: 100, offsetX: 50 });
      dispatch(windowEl, "pointerup", { clientX: 101, clientY: 50 }); // 1px move
      await flush();

      // Neither incidental pointerdown/pointerup pair produced a save or a
      // workload-collision dialog.
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      expect(h.confirmWorkloadShift).not.toHaveBeenCalled();

      // The browser now synthesizes the dblclick — the two preceding
      // pointer pairs must not have left the bar/drag state broken.
      dispatch(bar, "dblclick");

      expect(bar.style.display).toBe("none");
      expect(byClass(timeline, "task-gantt-inline-editor")).toHaveLength(1);
    });

    it("Enter commits, saves, and re-renders", async () => {
      const { timeline, h, bar, sub } = await openBarView({
        displayName: "元の名前",
      });
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "新しい名前";

      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "新しい名前",
        title: "新しい名前",
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(2); // 1 initial + 1 re-render
    });

    it("Escape cancels: discards the input, saves nothing, and reverts to the original element", async () => {
      const { timeline, h, bar } = await openBarView({ displayName: "元の名前" });
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "書きかけの値";

      dispatch(input, "keydown", { key: "Escape" });
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
      expect(bar.style.display).not.toBe("none"); // original re-shown
      expect(byClass(timeline, "task-gantt-inline-editor")).toHaveLength(0);
    });

    it("blur auto-commits when the value changed", async () => {
      const { timeline, h, bar, sub } = await openBarView({
        displayName: "元の名前",
      });
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "blur後の名前";

      dispatch(input, "blur");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      expect(h.updateTaskItem.mock.calls[0][0]).toBe(sub);
      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "blur後の名前",
        title: "blur後の名前",
      });
    });

    it("trims whitespace and collapses embedded newlines before comparing/saving", async () => {
      const { timeline, h, bar } = await openBarView({ displayName: "元の名前" });
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "  複数行\nの値  ";

      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem.mock.calls[0][1]).toEqual({
        displayName: "複数行 の値",
        title: "複数行 の値",
      });
    });

    it("does not save when the (normalized) value is unchanged", async () => {
      const { timeline, h, bar } = await openBarView({ displayName: "同じ名前" });
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "  同じ名前  "; // trims down to the original value

      dispatch(input, "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
      expect(byClass(timeline, "task-gantt-inline-editor")).toHaveLength(0); // still cleaned up
    });

    it("hostEl.show() / input removal happen synchronously, before onCommit's async work resolves", async () => {
      const { timeline, h, bar } = await openBarView({ displayName: "元の名前" });
      let resolveUpdate: (() => void) | undefined;
      h.updateTaskItem.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpdate = () => resolve({});
          })
      );
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "新しい名前";

      dispatch(input, "keydown", { key: "Enter" });
      // onCommit (host.updateTaskItem) has NOT resolved yet — but the
      // synchronous cleanup must already be visible.
      expect(bar.style.display).not.toBe("none");
      expect(byClass(timeline, "task-gantt-inline-editor")).toHaveLength(0);

      resolveUpdate?.();
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    });

    it("an externally-detached input silently discards its edit (no throw, no save)", async () => {
      const { timeline, h, bar } = await openBarView({ displayName: "元の名前" });
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "書きかけの値";
      // The fake DOM's empty does not null a child's parentNode (see
      // fake-dom.ts's isConnected note), so this suite simulates an
      // external render tearing the subtree down the same way its own
      // convention prescribes: an explicit remove on the element in
      // question, BEFORE finish runs.
      input.remove();

      expect(() => dispatch(input, "blur")).not.toThrow();
      await flush();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });

    it("hostEl.show() is a harmless no-op when hostEl was also externally detached", async () => {
      const { timeline, bar } = await openBarView();
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      bar.remove();
      input.remove();

      expect(() =>
        dispatch(input, "keydown", { key: "Enter" })
      ).not.toThrow();
    });

    it("an onCommit() rejection propagates out of finish() uncaught, and nothing is saved/rendered", async () => {

      // A rejected onCommit surfaces as an unhandled promise rejection; this
      // path does not show a Notice. The editor closes before awaiting
      // onCommit, so it stays closed when persistence fails. Workbench editors
      // instead await persistence before re-rendering and remain open if
      // saving rejects.
      const { timeline, h, bar } = await openBarView({ displayName: "元の名前" });
      h.updateTaskItem.mockRejectedValueOnce(new Error("boom"));
      dispatch(bar, "dblclick");
      const input = editorInputOf(timeline);
      input.value = "新しい名前";

      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        dispatch(input, "keydown", { key: "Enter" });
        await flush();
        // Node only fires 'unhandledRejection' after a full event-loop tick
        // (a macrotask boundary), not merely after the microtask queue
        // (flush) drains — give it that chance before checking.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      // finish has no catch block around onCommit, so the
      // rejection propagates all the way out as a genuinely unhandled one.
      expect(rejections).toHaveLength(1);
      // render is sequenced AFTER the
      // updateTaskItem await inside saveSubtaskTitleEdit, so a rejection
      // there means it never runs — only the initial onOpen render (1)
      // has happened, proving nothing was (successfully) saved.
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });
  });





  describe("subtask title editing", () => {
    it("starts on a dblclick of the bar; initial value falls back to title when displayName is empty", async () => {
      const { timeline, bar } = await openBarView({
        displayName: "",
        title: "素のタイトル",
      });
      dispatch(bar, "dblclick");
      expect(editorInputOf(timeline).value).toBe("素のタイトル");
    });

    it("commits BOTH displayName and title to the same new value", async () => {
      const { timeline, h, bar, sub } = await openBarView({
        displayName: "旧名",
        title: "旧名",
      });
      dispatch(bar, "dblclick");
      editorInputOf(timeline).value = "新名";
      dispatch(editorInputOf(timeline), "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        displayName: "新名",
        title: "新名",
      });
    });
  });





  describe("marker title editing", () => {
    it("starts on a dblclick of the marker; initial value falls back to key when title is empty", async () => {
      const { timeline } = await openBarView({
        ganttMarkers: [{ key: "m-key", title: "", date: dateOffset(2) }],
      });
      const marker = markerElOf(timeline);
      dispatch(marker, "dblclick");
      const input = editorInputOf(timeline);
      expect(input.value).toBe("m-key");

      // inline left/top so it renders visibly where the hidden marker was.
      expect(input.style.position).toBe("absolute");
      expect(input.style.left).toBe(marker.style.left);
      expect(input.style.top).toBe(marker.style.top);
    });

    it("commits only the dragged marker's title, leaves the others untouched, and re-renders", async () => {
      const { timeline, h, sub } = await openBarView({
        ganttMarkers: [
          { key: "m1", title: "旧タイトル", date: dateOffset(2) },
          { key: "m2", title: "他のマーカー", date: dateOffset(3) },
        ],
      });
      const marker = markerElOf(timeline);
      dispatch(marker, "dblclick");
      editorInputOf(timeline).value = "新タイトル";
      dispatch(editorInputOf(timeline), "keydown", { key: "Enter" });
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        ganttMarkers: [
          { key: "m1", title: "新タイトル", date: dateOffset(2) },
          { key: "m2", title: "他のマーカー", date: dateOffset(3) },
        ],
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(2);
    });

    it("a pointerdown on the marker while its editor is open does not start a drag", async () => {
      const { timeline } = await openBarView({
        ganttMarkers: [{ key: "m1", title: "M", date: dateOffset(2) }],
      });
      const marker = markerElOf(timeline);
      dispatch(marker, "dblclick");

      dispatch(marker, "pointerdown", { button: 0, clientX: 100 });

      expect(marker.classList.contains("is-dragging")).toBe(false);
    });
  });



  // Tests for marker editing, confirmation, and popover/modal closing.





  // The marker menu includes an action to edit a marker in the modal.


  describe("MarkerModal edit entry point (retained under marker menu)", () => {
    it("selecting '編集' opens MarkerModal pre-filled with the existing marker", async () => {
      const { h, timeline } = await openBarView({
        ganttMarkers: [{ key: "m1", title: "既存タイトル", date: dateOffset(2) }],
      });
      const marker = markerElOf(timeline);
      dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("編集"), "click");

      expect(h.openMarkerModal).toHaveBeenCalledWith(
        "マーカーを編集",
        "既存タイトル",
        dateOffset(2)
      );
    });

    it("confirming an edit updates only that marker in place, others untouched", async () => {
      const { h, timeline, sub } = await openBarView({
        ganttMarkers: [
          { key: "m1", title: "旧", date: dateOffset(2) },
          { key: "m2", title: "他", date: dateOffset(3) },
        ],
      });
      h.openMarkerModal.mockResolvedValueOnce({
        title: "新",
        date: dateOffset(4),
      });
      const marker = markerElOf(timeline);
      dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("編集"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.ganttMarkers).toEqual([
        { key: "m1", title: "新", date: dateOffset(4) },
        { key: "m2", title: "他", date: dateOffset(3) },
      ]);
    });

    it("cancelling the edit modal saves nothing", async () => {
      const { h, timeline } = await openBarView({
        ganttMarkers: [{ key: "m1", title: "M", date: dateOffset(2) }],
      });
      // default host.openMarkerModal fake resolves null (cancelled)
      const marker = markerElOf(timeline);
      dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("編集"), "click");
      await flush();

      expect(h.updateTaskItem).not.toHaveBeenCalled();
    });
  });





  describe("bar context menu", () => {
    it("right-click arms the 1200ms suppression window, hides any open popover, cancels the native menu, and shows the menu", async () => {
      const { bar } = await openBarView();
      // Open the subtask popover first so the context-menu action has one to close.
      dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
      expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);

      const evt = dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });

      expect(evt.__defaultPrevented).toBe(true);
      expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(0);
      expect(menuItems().length).toBeGreaterThan(0); // (menu is shown)

      // hovering the bar again immediately after does NOT
      // reopen the popover (1200ms suppression, longer than the 450ms
      // drag-end window).
      dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
      expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(0);
    });

    it("「完了とする」marks the task done and re-renders", async () => {
      const { h, bar, sub } = await openBarView({ completed: false });
      h.loadTasks.mockClear();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("完了とする"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        completed: true,
        statusLabel: "done",
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("「未完了に戻す」reverts a completed task and re-renders", async () => {
      const { h, bar, sub } = await openBarView({ completed: true });
      h.loadTasks.mockClear();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("未完了に戻す"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        completed: false,
        statusLabel: "active",
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("「マーカーを追加」adds a marker directly (no modal) at the clicked date with a default title and unique key", async () => {
      const { h, bar, sub } = await openBarView({
        ganttMarkers: [{ key: "m1", title: "既存", date: dateOffset(1) }],
      });
      // clientX=100, dayWidth=28 (DEFAULT_SETTINGS.ganttZoom) => floor(100/28)=3
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("マーカーを追加"), "click");
      await flush();

      expect(h.openMarkerModal).not.toHaveBeenCalled(); // no modal
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.ganttMarkers).toHaveLength(2);
      expect(patch.ganttMarkers[1].title).toBe("新しいマーカー");
      expect(patch.ganttMarkers[1].date).toBe(dateOffset(3));
      // makeUniqueMarkerKey admits CJK, so the
      // default Japanese title slugifies to a meaningful key instead of
      // falling back to an empty-then-timestamp key. This also guards against
      // an ASCII-only fallback that would discard Japanese characters.
      expect(patch.ganttMarkers[1].key).toBe("新しいマーカー");
    });

    it("clamps the new marker's date to the bar's own [start, end] range", async () => {
      const { h, bar, sub } = await openBarView(); // bar spans dateOffset(0)..dateOffset(5)
      dispatch(bar, "contextmenu", { clientX: 1000, clientY: 50 }); // far past the bar's end
      dispatch(menuItemWithText("マーカーを追加"), "click");
      await flush();

      const [savedTask, patch] = h.updateTaskItem.mock.calls[0];
      expect(savedTask).toBe(sub);
      expect(patch.ganttMarkers[0].date).toBe(dateOffset(5)); // clamped to bar.end
    });

    it("shows a disabled 「タグは未作成です」 placeholder when settings.ganttTags is empty", async () => {
      const { bar } = await openBarView({ tags: [] }, { ganttTags: [] });
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      const item = menuItemWithText("タグは未作成です");
      expect(item.classList.contains("is-disabled")).toBe(true);
    });

    it("the tag menu lists settings.ganttTags; clicking an unassigned tag adds it", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: ["existing"] },
        { ganttTags: tagRegistry(["existing", "urgent"]) }
      );
      h.loadTasks.mockClear();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("urgent"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["existing", "urgent"],
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("stable tag keys count as assigned in the shared tag menu", async () => {
      const { bar } = await openBarView(
        { tags: ["stable-key"] },
        { ganttTags: [tagDefinition("Existing", "#123456", 0, "stable-key")] }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");

      expect(menuItemWithText("Existing").classList.contains("is-checked")).toBe(
        true
      );
    });

    it("clicking an assigned stable tag key removes the canonical tag", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: ["stable-key"] },
        { ganttTags: [tagDefinition("Existing", "#123456", 0, "stable-key")] }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("Existing"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, { tags: [] });
    });

    it("adding an unassigned tag canonicalizes the shared toggle result", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: ["other"] },
        {
          ganttTags: [
            tagDefinition("Existing", "#123456", 0, "stable-key"),
            tagDefinition("other", "#654321", 1000),
          ],
        }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("Existing"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["other", "Existing"],
      });
    });

    it("puts tag entries in a child menu", async () => {
      const { view, bar } = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["urgent"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });

      expect(menuItems().some((el) => el.textContent === "urgent")).toBe(false);
      dispatch(menuItemWithText("タグ"), "click");
      expect((view as any).activeContextMenu).toBeDefined();
      expect((view as any).activeContextMenu.currentSubmenu).toBeDefined();
      expect(byClass(menuBody(), "menu")).toHaveLength(2);
      expect(menuItems().some((el) => el.textContent === "urgent")).toBe(true);
    });

    it.each(["bar", "marker", "parent"] as const)(
      "opens a genuine native tag submenu on %s hover",
      async (targetKind) => {
        const { view, target } = await openTagMenuTarget(targetKind);
        dispatch(target, "contextmenu", { clientX: 100, clientY: 50 });
        const tagItem = menuItemWithText("タグ");
        const parentMenu = (view as any).activeContextMenu as Menu & {
          currentSubmenu?: Menu & { parentMenu?: Menu };
        };

        expect(tagItem.classList.contains("has-submenu")).toBe(true);
        dispatch(tagItem, "mouseenter");

        expect(parentMenu.currentSubmenu).toBeDefined();
        expect(parentMenu.currentSubmenu?.parentMenu).toBe(parentMenu);
        expect(byClass(menuBody(), "menu")).toHaveLength(2);
        expect(menuItems().some((el) => deepText(el).includes("urgent"))).toBe(
          true
        );
      }
    );

    it("native submenu registration keeps the child interactive during outside-mousedown handling", async () => {
      const { view, h, bar, sub } = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["urgent"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "mouseenter");
      const urgentItem = menuItemWithText("urgent");

      dispatch(window as unknown as FakeEl, "mousedown", {
        target: urgentItem,
      });

      expect((view as any).activeContextMenu).toBeDefined();
      expect(byClass(menuBody(), "menu")).toHaveLength(2);
      dispatch(urgentItem, "click");
      await flush();
      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, { tags: ["urgent"] });
    });

    it.each(["bar", "marker", "parent"] as const)(
      "native tag submenu also opens on %s click",
      async (targetKind) => {
        const menuApi = Menu as unknown as {
          autoHideOnItemClick: boolean;
        };
        menuApi.autoHideOnItemClick = true;
        try {
          const { view, target } = await openTagMenuTarget(targetKind);

          dispatch(target, "contextmenu", { clientX: 100, clientY: 50 });
          dispatch(menuItemWithText("タグ"), "click");
          expect((view as any).activeContextMenu).toBeDefined();
          expect((view as any).activeContextMenu.currentSubmenu).toBeDefined();
          expect(menuItems().some((el) => deepText(el).includes("urgent"))).toBe(
            true
          );

          await view.onClose();
          expect(byClass(menuBody(), "menu")).toHaveLength(0);
        } finally {
          menuApi.autoHideOnItemClick = false;
        }
      }
    );

    it("creates and immediately assigns a new tag", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["existing"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");

      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("  created  ");
      await flush();

      expect(h.settings.ganttTags).toContainEqual({
        key: "created",
        name: "created",
        color: DEFAULT_GANTT_TAG_COLORS[1],
        order: 1000,
      });
      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["created"],
      });
    });

    it("reuses an existing tag by name/key without duplicating the registry", async () => {
      const definitions = [tagDefinition("Existing", "#123456", 0, "stable-key")];
      const { h, bar, sub } = await openBarView(
        { tags: [] },
        { ganttTags: definitions }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");

      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("stable-key");
      await flush();

      expect(h.settings.ganttTags).toEqual(definitions);
      expect(h.saveSettings).not.toHaveBeenCalled();
      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["Existing"],
      });
    });

    it("wraps the palette after eight configured tags", async () => {
      const definitions = tagRegistry(
        ["a", "b", "c", "d", "e", "f", "g", "h"],
        Object.fromEntries(
          ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => [name, ""])
        )
      );
      const { h, bar } = await openBarView(
        { tags: [] },
        { ganttTags: definitions }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");

      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("i");
      await flush();

      expect(h.settings.ganttTags[8].color).toBe(DEFAULT_GANTT_TAG_COLORS[0]);
      expect(h.settings.ganttTags[8].order).toBe(8000);
    });

    it("empty input does nothing", async () => {
      const { h, bar } = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["existing"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");

      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("   ");
      await flush();

      expect(h.saveSettings).not.toHaveBeenCalled();
      expect(h.updateTaskItem).not.toHaveBeenCalled();
      expect(h.settings.ganttTags).toHaveLength(1);
    });

    it("creates and renders when the optional callback is omitted", async () => {
      const { view, h } = await openBarView(
        { tags: [] },
        { ganttTags: [] }
      );
      h.loadTasks.mockClear();
      (view as any).createGanttTagInteractively([], undefined);
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("orphan");
      await flush();

      expect(h.settings.ganttTags[0].name).toBe("orphan");
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("existing key is assigned without a duplicate definition", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: [] },
        { ganttTags: [tagDefinition("Existing", "#123456", 0, "stable-key")] }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("stable-key");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, { tags: ["Existing"] });
      expect(h.saveSettings).not.toHaveBeenCalled();
    });

    it("treats an assigned stable key as the same existing tag", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: ["stable-key"] },
        { ganttTags: [tagDefinition("Existing", "#123456", 0, "stable-key")] }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("stable-key");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["Existing"],
      });
      expect(h.settings.ganttTags).toHaveLength(1);
    });

    it("canonicalizes and dedupes existing/new tag assignments", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: ["stable-key", "Existing", "Existing"] },
        { ganttTags: [tagDefinition("Existing", "#123456", 0, "stable-key")] }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("new-tag");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["Existing", "new-tag"],
      });
    });

    it("child tag actions close both child and parent menus", async () => {
      const { view, bar } = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["urgent"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("urgent"), "click");

      expect((view as any).activeContextMenu).toBeUndefined();
      expect(byClass(menuBody(), "menu")).toHaveLength(0);
    });

    it("saveSettings failure does not rollback a newer settings-array identity", async () => {
      const { h, bar } = await openBarView(
        { tags: [] },
        { ganttTags: tagRegistry(["existing"]) }
      );
      h.saveSettings.mockRejectedValueOnce(new Error("simulated save failure"));
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("candidate");
      const candidate = h.settings.ganttTags;
      h.settings.ganttTags = [
        ...candidate,
        tagDefinition("concurrent", "#abcdef", 2000),
      ];
      await flush();

      expect(h.settings.ganttTags.map((tag) => tag.name)).toEqual([
        "existing",
        "candidate",
        "concurrent",
      ]);
    });

    it("marker creation assigns only the selected marker", async () => {
      const { h, timeline, sub } = await openBarView(
        {
          tags: [],
          ganttMarkers: [
            { key: "m1", title: "One", date: dateOffset(1), tags: [] },
            { key: "m2", title: "Two", date: dateOffset(2), tags: ["keep"] },
          ],
        },
        { ganttTags: tagRegistry(["existing"]) }
      );
      const marker = markerElOf(timeline);
      dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("marker-new");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        ganttMarkers: [
          { key: "m1", title: "One", date: dateOffset(1), tags: ["marker-new"] },
          { key: "m2", title: "Two", date: dateOffset(2), tags: ["keep"] },
        ],
      });
    });

    it("parent creation immediately assigns the parent", async () => {
      const parent = makeParent({ ganttEnabled: true, tags: [] });
      const { h, container } = await openView([parent], {
        ganttTags: tagRegistry(["existing"]),
      });
      const left = byClass(parentRows(container)[0], "task-gantt-parent-left")[0];
      dispatch(left, "contextmenu", { clientX: 10, clientY: 10 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("新しいタグを作成して付与"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("parent-new");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
        tags: ["parent-new"],
      });
    });

    it("tag submenu cleanup handles parent hide, another context menu, and view close", async () => {
      const { view, bar, timeline } = await openBarView(
        { ganttMarkers: [{ key: "m1", title: "M", date: dateOffset(1) }] },
        { ganttTags: tagRegistry(["existing"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      const parentMenu = (view as any).activeContextMenu as { hide: () => void };
      parentMenu.hide();
      expect(byClass(menuBody(), "menu")).toHaveLength(0);

      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(markerElOf(timeline), "contextmenu", { clientX: 100, clientY: 50 });
      expect(byClass(menuBody(), "menu")).toHaveLength(1);

      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      await view.onClose();
      expect((view as any).activeContextMenu).toBeUndefined();
      expect(byClass(menuBody(), "menu")).toHaveLength(0);
    });

    it("clicking an already-assigned tag removes it", async () => {
      const { h, bar, sub } = await openBarView(
        { tags: ["existing", "urgent"] },
        { ganttTags: tagRegistry(["existing", "urgent"]) }
      );
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("urgent"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        tags: ["existing"],
      });
    });

    it("「一括移動モードを解除」only shows when bulkMoveState is active for this bar's parent, and clears it on click", async () => {
      const { view, h, bar, parent } = await openBarView();
      // No bulkMoveState set yet: the item must not appear at all.
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      expect(
        menuItems().some((el) => deepText(el).includes("一括移動モードを解除"))
      ).toBe(false);



      // Set up the required state directly, then exercise the behavior
      // through real event dispatch.
      (view as any).bulkMoveState = {
        parentKey: parent.id,
        anchorKey: "sub1",
        anchorStart: dateOffset(0),
      };
      h.loadTasks.mockClear();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      const item = menuItemWithText("一括移動モードを解除");
      dispatch(item, "click");
      await flush();

      expect((view as any).bulkMoveState).toBeUndefined();
      expect(h.loadTasks).toHaveBeenCalledTimes(1); // re-render
    });

    it("opens the Current Status prompt with the exact title/label/initial value", async () => {
      const { h, bar } = await openBarView({ currentStatus: "進行中です" });
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("Current Statusを編集"), "click");

      expect(h.openTextPrompt).toHaveBeenCalledTimes(1);
      const [title, label, initialValue] = h.openTextPrompt.mock.calls[0];
      expect(title).toBe("Current Statusを編集");
      expect(label).toBe("Current Status");
      expect(initialValue).toBe("進行中です");
    });

    it("falls back to an empty initial value when currentStatus is unset", async () => {
      const { h, bar } = await openBarView({ currentStatus: "" });
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("Current Statusを編集"), "click");

      expect(h.openTextPrompt.mock.calls[0][2]).toBe("");
    });

    it("confirming the Current Status prompt trims and saves", async () => {
      const { h, bar, sub } = await openBarView({ currentStatus: "旧" });
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("Current Statusを編集"), "click");
      const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
        value: string
      ) => void;
      onSubmit("  トリムされる値  ");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        currentStatus: "トリムされる値",
      });
    });

    it("「タスクノートを開く」opens the task's note", async () => {
      const { h, bar, sub } = await openBarView();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タスクノートを開く"), "click");

      expect(h.openTaskItem).toHaveBeenCalledWith(sub);
    });

    it("「ガントチャートから削除」clears the planned dates without deleting the subtask, no confirmation, and re-renders", async () => {
      const { h, bar, sub } = await openBarView();
      h.loadTasks.mockClear();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("ガントチャートから削除"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        plannedStartDate: "",
        plannedEndDate: "",
      });
      expect(h.deleteSubtaskTaskItem).not.toHaveBeenCalled(); // not deleted
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("「タスクとして削除」asks window.confirm with the exact message and does nothing when declined", async () => {
      const { h, bar } = await openBarView({
        displayName: "削除対象",
        title: "削除対象",
      });
      const confirmSpy = vi
        .fn()
        .mockReturnValue(false);
      (globalThis as any).window.confirm = confirmSpy;
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タスクとして削除"), "click");
      await flush();

      expect(confirmSpy).toHaveBeenCalledWith(
        "サブタスク『削除対象』をタスクとして削除します。元に戻せません。"
      );
      expect(h.deleteSubtaskTaskItem).not.toHaveBeenCalled();
    });

    it("confirming 「タスクとして削除」deletes via host.deleteSubtaskTaskItem and re-renders", async () => {
      const { h, bar, sub } = await openBarView({
        displayName: "",
        title: "",
      });
      (globalThis as any).window.confirm = vi.fn().mockReturnValue(true);
      h.loadTasks.mockClear();
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タスクとして削除"), "click");
      await flush();

      // both displayName and title empty falls back to「サブタスク」
      expect((globalThis as any).window.confirm).toHaveBeenCalledWith(
        "サブタスク『サブタスク』をタスクとして削除します。元に戻せません。"
      );
      expect(h.deleteSubtaskTaskItem).toHaveBeenCalledWith(sub);
      expect(h.loadTasks).toHaveBeenCalledTimes(1); // re-render after delete
    });
  });





  describe("marker context menu", () => {
    it("right-click arms the 1200ms suppression window, hides any open popover, cancels the native menu, and shows the menu", async () => {
      const { timeline, bar } = await openBarView({
        ganttMarkers: [{ key: "m1", title: "M", date: dateOffset(2) }],
      });
      dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
      expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);

      const marker = markerElOf(timeline);
      const evt = dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });

      expect(evt.__defaultPrevented).toBe(true);
      expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(0);
      expect(menuItems().length).toBeGreaterThan(0);
    });

    it("the marker's tag menu toggles marker.tags (not the task's own tags) and re-renders", async () => {
      const { h, timeline, sub } = await openBarView(
        { tags: [], ganttMarkers: [{ key: "m1", title: "M", date: dateOffset(2), tags: ["urgent"] }] },
        { ganttTags: tagRegistry(["existing", "urgent"]) }
      );
      h.loadTasks.mockClear();
      const marker = markerElOf(timeline);
      dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      dispatch(menuItemWithText("existing"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        ganttMarkers: [
          {
            key: "m1",
            title: "M",
            date: dateOffset(2),
            tags: ["urgent", "existing"],
          },
        ],
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });

    it("the marker tag menu also shows the disabled 「タグは未作成です」 placeholder when settings.ganttTags is empty", async () => {
      const { timeline } = await openBarView(
        { ganttMarkers: [{ key: "m1", title: "M", date: dateOffset(2) }] },
        { ganttTags: [] }
      );
      const marker = markerElOf(timeline);
      dispatch(marker, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("タグ"), "click");
      const item = menuItemWithText("タグは未作成です");
      expect(item.classList.contains("is-disabled")).toBe(true);
    });

    it("「削除」removes only that marker, no confirmation, and re-renders", async () => {
      const { h, timeline, sub } = await openBarView({
        ganttMarkers: [
          { key: "m1", title: "残る", date: dateOffset(2) },
          { key: "m2", title: "消える", date: dateOffset(3) },
        ],
      });
      h.loadTasks.mockClear();
      const markerToDelete = byClass(timeline, "task-gantt-marker")[1];
      dispatch(markerToDelete, "contextmenu", { clientX: 100, clientY: 50 });
      dispatch(menuItemWithText("削除"), "click");
      await flush();

      expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
        ganttMarkers: [{ key: "m1", title: "残る", date: dateOffset(2) }],
      });
      expect(h.loadTasks).toHaveBeenCalledTimes(1);
    });
  });
});






describe("empty-cell menu and Bulk-Move", () => {
  let winEl: FakeEl;


  // clock so dateOffset-derived fixture dates land on known, fixed


  // business-day snap deterministically.
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("window", makeFakeEl("window"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00"));
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    winEl = (globalThis as any).window as FakeEl;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A gantt-enabled parent with the given subtasks (may be empty). */
  async function openViewWithParent(
    subtasks: TaskRow[],
    parentOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    parent: TaskRow;
  }> {
    const parent = withChildren(
      makeParent({ ganttEnabled: true, ...parentOverrides }),
      subtasks
    );
    const { view, container, h } = await openView([parent], settingsOverrides);
    const timeline = timelineOf(parentRows(container)[0]);
    return { view, container, timeline, h, parent };
  }

  function bgAt(timeline: FakeEl, index: number): FakeEl {
    return byClass(timeline, "task-gantt-bg")[index];
  }





  it("right-clicking a parent row's timeline background opens the empty-cell menu", async () => {
    const { timeline } = await openViewWithParent([]);
    const bg = bgAt(timeline, 14); // today
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    expect(menuItems().length).toBeGreaterThan(0);
    expect(menuItemWithText(`新規サブタスクを ${dateOffset(0)} に作成`)).toBeDefined();
  });

  it("right-clicking a subtask bar never opens the empty-cell menu's own items", async () => {
    const { timeline } = await openViewWithParent([
      makeSubtask("s1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(3),
      }),
    ]);
    const bar = byClass(timeline, "task-gantt-bar")[0];
    dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });

    // empty-cell menu's date-bearing items ever appear on it.
    expect(
      menuItems().some((el) => deepText(el).includes("新規サブタスクを"))
    ).toBe(false);
    expect(
      menuItems().some((el) => deepText(el).includes("親タスク期限を"))
    ).toBe(false);
  });

  it("a right-click on a Sunday cell snaps every date-bearing item forward to the next business day", async () => {
    const { timeline } = await openViewWithParent([]);

    // a Sunday (confirmed fixture in tests/app/gantt-drag.test.ts). The next

    const bg = bgAt(timeline, 19);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    expect(
      menuItemWithText(`新規サブタスクを ${dateOffset(6)} に作成`)
    ).toBeDefined();
    expect(
      menuItemWithText(`親タスク期限を ${dateOffset(6)} に設定`)
    ).toBeDefined();
  });





  it("「新規サブタスクを [date] に作成」opens a prompt and creates the subtask with that date as both start/end", async () => {
    const { h, timeline, parent } = await openViewWithParent([]);
    h.loadTasks.mockClear();
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText(`新規サブタスクを ${dateOffset(0)} に作成`), "click");

    expect(h.openTextPrompt).toHaveBeenCalledTimes(1);
    const [title, label, initialValue, onSubmit] = h.openTextPrompt.mock.calls[0];
    expect(title).toBe("新規サブタスク");
    expect(label).toBe("サブタスク名");
    expect(initialValue).toBe("");

    onSubmit("新しいやつ");
    await flush();

    expect(h.addSubtaskWithPlan).toHaveBeenCalledWith(
      parent,
      "新しいやつ",
      dateOffset(0)
    );
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("an empty (whitespace-only) name cancels subtask creation without saving or re-rendering", async () => {
    const { h, timeline } = await openViewWithParent([]);
    h.loadTasks.mockClear();
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText(`新規サブタスクを ${dateOffset(0)} に作成`), "click");
    const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
      value: string
    ) => void;
    onSubmit("   ");
    await flush();

    expect(h.addSubtaskWithPlan).not.toHaveBeenCalled();
    expect(h.loadTasks).not.toHaveBeenCalled();
  });





  it("shows a disabled message when there are no unplaced subtasks", async () => {
    const { timeline } = await openViewWithParent([
      makeSubtask("placed1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(2),
      }),
    ]);
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    const item = menuItemWithText("未配置サブタスクはありません");
    expect(item.classList.contains("is-disabled")).toBe(true);
  });

  it("lists unplaced subtasks by name; clicking one places it at the clicked date", async () => {
    const { h, timeline, parent } = await openViewWithParent([
      makeSubtask("u1", { displayName: "未配置A" }),
      makeSubtask("u2", { displayName: "未配置B" }),
    ]);
    h.loadTasks.mockClear();
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("未配置を配置: 未配置A"), "click");
    await flush();

    const sub = parent.subtasks!.get("u1")!;
    expect(h.updateTaskItem).toHaveBeenCalledWith(sub, {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(0),
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("shows at most 20 unplaced subtasks plus a disabled overflow message for 21+", async () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      makeSubtask(`u${i}`, { displayName: `未配置${i}` })
    );
    const { timeline } = await openViewWithParent(many);
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    const placeItems = menuItems().filter((el) =>
      deepText(el).startsWith("未配置を配置:")
    );
    expect(placeItems).toHaveLength(20);
    const overflow = menuItemWithText(
      "ほか 3 件はフィルター等で絞り込んでください"
    );
    expect(overflow.classList.contains("is-disabled")).toBe(true);
  });





  it("「親タスク期限を [date] に設定」sets dueDate without confirmation and re-renders", async () => {
    const { h, timeline, parent } = await openViewWithParent([], {
      dueDate: "",
    });
    h.loadTasks.mockClear();
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText(`親タスク期限を ${dateOffset(0)} に設定`), "click");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      dueDate: dateOffset(0),
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("overwrites an already-set dueDate without confirmation", async () => {
    const { h, timeline, parent } = await openViewWithParent([], {
      dueDate: dateOffset(20),
    });
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText(`親タスク期限を ${dateOffset(0)} に設定`), "click");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      dueDate: dateOffset(0),
    });
  });

  it("「親タスク期限を削除」only appears when a dueDate is already set", async () => {
    const { timeline } = await openViewWithParent([], { dueDate: "" });
    dispatch(bgAt(timeline, 14), "contextmenu", { clientX: 100, clientY: 50 });
    expect(
      menuItems().some((el) => deepText(el).includes("親タスク期限を削除"))
    ).toBe(false);
  });

  it("「親タスク期限を削除」clears the parent's dueDate", async () => {
    const { h, timeline, parent } = await openViewWithParent([], {
      dueDate: dateOffset(20),
    });
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("親タスク期限を削除"), "click");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, { dueDate: "" });
  });





  it("bulkMoveState is populated with parentKey/anchorKey/anchorStart when Bulk-Move mode starts", async () => {
    const { view, timeline, parent } = await openViewWithParent([
      makeSubtask("s1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(3),
      }),
    ]);
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("これ以降を纏めて移動"), "click");

    expect((view as any).bulkMoveState).toEqual({
      parentKey: parent.id,
      anchorKey: "tasks/parent-1.md::s1",
      anchorStart: dateOffset(0),
    });
  });

  it("mode persists after a completed (or zero-move) drag — only explicit cancel ends it", async () => {
    const { view, timeline } = await openViewWithParent([
      makeSubtask("s1", {
        plannedStartDate: dateOffset(0),
        plannedEndDate: dateOffset(3),
      }),
    ]);
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("これ以降を纏めて移動"), "click");
    dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 }); // zero net move
    expect((view as any).bulkMoveState).toBeDefined();

    const bar = byClass(timeline, "task-gantt-bar")[0];
    dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
    expect(
      menuItems().some((el) => deepText(el).includes("一括移動モードを解除"))
    ).toBe(true);
  });

  it("an anchor-less trigger still activates the mode (empty target set), and the drag is a no-op", async () => {
    const { view, h, timeline, parent } = await openViewWithParent([
      makeSubtask("s1", {
        plannedStartDate: dateOffset(-10),
        plannedEndDate: dateOffset(-5),
      }),
    ]);
    // Right-click "today" — every subtask starts BEFORE today, so no
    // subtask qualifies as the anchor (-equivalent miss).
    const bg = bgAt(timeline, 14);
    dispatch(bg, "contextmenu", { clientX: 100, clientY: 50 });
    dispatch(menuItemWithText("これ以降を纏めて移動"), "click");

    expect((view as any).bulkMoveState).toEqual({
      parentKey: parent.id,
      anchorKey: "",
      anchorStart: dateOffset(0),
    }); // mode is active regardless

    dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
    dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
    await flush();
    expect(h.updateTaskItemsBatch).not.toHaveBeenCalled();
  });
});



// Keyboard pass-through during bar drag and Current Status editing.


describe("drag preview errors, pointer capture, and keyboard", () => {
  let winEl: FakeEl;



  // silently drift onto a weekend/holiday and turn an expected save into a
  // business-day-snapped no-op.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00"));
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
    winEl = (globalThis as any).window as FakeEl;
    winEl.innerWidth = 1200;
    winEl.innerHeight = 800;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Opens a view with one gantt-enabled parent + one 6-day subtask bar. */
  async function openViewWithBar(
    overrides: Record<string, unknown> = {}
  ): Promise<{
    view: TaskGanttView;
    container: FakeEl;
    timeline: FakeEl;
    h: HostHarness;
    parent: TaskRow;
    sub: TaskRow;
    bar: FakeEl;
  }> {
    const sub = makeSubtask("sub1", {
      plannedStartDate: dateOffset(0),
      plannedEndDate: dateOffset(5),
      ...overrides,
    });
    const parent = withChildren(makeParent({ ganttEnabled: true }), [sub]);
    const { view, container, h } = await openView([parent]);
    const timeline = timelineOf(parentRows(container)[0]);
    const bar = byClass(timeline, "task-gantt-bar")[0];
    return { view, container, timeline, h, parent, sub, bar };
  }

  function markerElOf(timeline: FakeEl): FakeEl {
    return byClass(timeline, "task-gantt-marker")[0];
  }

  function deadlineElOf(timeline: FakeEl): FakeEl {
    return byClass(timeline, "task-gantt-deadline-marker")[0];
  }





  it("a drag preview render error on one pointermove does not abort the bar-drag session", async () => {
    const { h, bar } = await openViewWithBar({
      ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
    });

    dispatch(bar, "pointerdown", {
      button: 0,
      clientX: 100,
      offsetX: 50,
      pointerId: 7,
    });

    // Force one preview-render write to throw. The error escapes the bar-move
    // onMove handler and aborts this pointermove callback, as any uncaught
    // event-listener error would. It must not corrupt the drag session:
    // window-level listeners remain registered, and a later move/up can
    // complete the drag.
    let shouldThrow = true;
    let backing = bar.style.left;
    Object.defineProperty(bar.style, "left", {
      configurable: true,
      get(): string {
        return backing;
      },
      set(v: string): void {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("boom: simulated preview render error");
        }
        backing = v;
      },
    });

    expect(() =>
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 })
    ).toThrow("boom");

    // After the preview error, a subsequent pointermove and pointerup still
    // confirm and save the drag.
    dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
    dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
  });





  describe("pointer capture engaged during drag, released at drag-end", () => {
    it("bar-move pointerdown captures the pointer; pointerup releases it", async () => {
      const { h, bar } = await openViewWithBar();

      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 50,
        pointerId: 42,
      });
      expect(bar.pointerCaptures).toContain(42);

      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
      // still captured mid-drag — a fast pointer excursion
      // outside the bar's own bounds would not interrupt tracking.
      expect(bar.pointerCaptures).toContain(42);

      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();
      expect(bar.pointerCaptures).not.toContain(42); // released at drag-end
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    });

    it("resize-start/resize-end pointerdowns also capture and release the pointer", async () => {
      const { timeline } = await openViewWithBar();
      const bar = byClass(timeline, "task-gantt-bar")[0];

      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 0, // left edge -> resize-start
        pointerId: 11,
      });
      expect(bar.pointerCaptures).toContain(11);
      dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 });
      await flush();
      expect(bar.pointerCaptures).not.toContain(11);

      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 9999, // right edge -> resize-end
        pointerId: 12,
      });
      expect(bar.pointerCaptures).toContain(12);
      dispatch(winEl, "pointerup", { clientX: 100, clientY: 50 });
      await flush();
      expect(bar.pointerCaptures).not.toContain(12);
    });

    it("marker pointerdown captures the pointer; pointerup releases it", async () => {
      const { timeline, h } = await openViewWithBar({
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      const markerEl = markerElOf(timeline);

      dispatch(markerEl, "pointerdown", {
        button: 0,
        clientX: 100,
        pointerId: 5,
      });
      expect(markerEl.pointerCaptures).toContain(5);

      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
      expect(markerEl.pointerCaptures).toContain(5);

      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();
      expect(markerEl.pointerCaptures).not.toContain(5);
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    });

    it("a marker drag interrupted mid-move still releases pointer capture via cleanup", async () => {
      const { view, timeline } = await openViewWithBar({
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      const markerEl = markerElOf(timeline);
      dispatch(markerEl, "pointerdown", {
        button: 0,
        clientX: 100,
        pointerId: 9,
      });
      expect(markerEl.pointerCaptures).toContain(9);

      (view as any).tasks = []; // simulate external deletion mid-drag
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });

      // cleanup runs from the graceful no-op path too — capture released.
      expect(markerEl.pointerCaptures).not.toContain(9);
    });

    it("parent due-date (★) pointerdown captures the pointer; pointerup releases it", async () => {
      const parent = withChildren(
        makeParent({ ganttEnabled: true, dueDate: dateOffset(10) }),
        [makeSubtask("sub1", { plannedStartDate: dateOffset(0), plannedEndDate: dateOffset(5) })]
      );
      const { container, h } = await openView([parent]);
      const timeline = timelineOf(parentRows(container)[0]);
      const deadline = deadlineElOf(timeline);

      dispatch(deadline, "pointerdown", {
        button: 0,
        clientX: 100,
        pointerId: 21,
      });
      expect(deadline.pointerCaptures).toContain(21);

      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 });
      expect(deadline.pointerCaptures).toContain(21);

      dispatch(winEl, "pointerup", { clientX: 128, clientY: 50 });
      await flush();
      expect(deadline.pointerCaptures).not.toContain(21);
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
    });
  });





  it("Escape during an active bar drag does nothing: no save, cleanup, or drag-state change", async () => {
    const { view, h, bar } = await openViewWithBar();

    dispatch(bar, "pointerdown", {
      button: 0,
      clientX: 100,
      offsetX: 50,
      pointerId: 3,
    });
    dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 });
    const dragStateBefore = view.getActiveDragStateForTesting();
    expect(bar.classList.contains("is-dragging")).toBe(true);

    // The drag path has no keydown listener, so Escape has no effect.
    expect(() => dispatch(winEl, "keydown", { key: "Escape" })).not.toThrow();

    expect(bar.classList.contains("is-dragging")).toBe(true); // unaffected
    expect(view.getActiveDragStateForTesting()).toBe(dragStateBefore); // same ref
    expect(h.updateTaskItem).not.toHaveBeenCalled(); // no save

    // The drag still confirms normally afterwards — Escape never interrupted it.
    dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
    await flush();
    expect(h.updateTaskItem).toHaveBeenCalledTimes(1);
  });

  it("an ordinary key in the rich-popover Current Status textarea passes through untouched", async () => {
    const { h, bar } = await openViewWithBar();
    dispatch(bar, "mouseover", { clientX: 100, clientY: 50 });
    const popover = byClass(popoverBody(), "task-gantt-rich-popover")[0];
    expect(popover).toBeDefined();
    const area = byClass(popover, "task-gantt-popover-current-status")[0];
    expect(area).toBeDefined();

    const evt = dispatch(area, "keydown", { key: "a" });

    // Only Enter(+ctrl/meta) and Escape are intercepted; any
    // other key is simply not matched by the handler's if/else-if — no
    // preventDefault, no flush/save, no popover close.
    expect((evt as any).__defaultPrevented).not.toBe(true);
    expect(h.updateTaskItem).not.toHaveBeenCalled();
    expect(byClass(popoverBody(), "task-gantt-rich-popover")).toHaveLength(1);
  });



  // instead of firing them synchronously, prove multiple
  // pointermoves in one frame schedule exactly ONE rAF, and that only the
  // LATEST stored event is applied when it finally runs.


  describe("drag preview rAF batching", () => {
    it("bar-move: multiple pointermoves within one frame schedule ONE rAF that applies only the latest position", async () => {
      const { bar } = await openViewWithBar();
      const originalLeft = parseFloat(bar.style.left);

      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 50, // mid-bar -> move kind
        pointerId: 1,
      });

      const queued: Array<(t: number) => void> = [];
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        queued.push(cb);
        return queued.length;
      });

      dispatch(winEl, "pointermove", { clientX: 120, clientY: 50 }); // +20px
      dispatch(winEl, "pointermove", { clientX: 140, clientY: 50 }); // +40px
      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 }); // +56px (latest)

      expect(queued).toHaveLength(1); // One batched rAF is queued per frame.
      expect(bar.style.left).toBe(`${originalLeft}px`); // nothing applied yet

      queued[0](0);

      // Only the LATEST delta (56px) was applied, not the two intermediate ones.
      expect(bar.style.left).toBe(`${originalLeft + 56}px`);
      expect(queued).toHaveLength(1);

      // Restore a synchronous rAF stub so drag-confirm on pointerup (which
      // this test doesn't exercise further) would behave normally if reused.
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        cb(0);
        return 0;
      });
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();
    });

    it("a pending rAF that fires after pointerup does not resurrect the drag preview", async () => {
      const { h, bar } = await openViewWithBar();
      const originalLeft = parseFloat(bar.style.left);

      dispatch(bar, "pointerdown", {
        button: 0,
        clientX: 100,
        offsetX: 50,
        pointerId: 1,
      });

      const queued: Array<(t: number) => void> = [];
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        queued.push(cb);
        return queued.length;
      });

      dispatch(winEl, "pointermove", { clientX: 156, clientY: 50 }); // +56px
      expect(queued).toHaveLength(1);

      // pointerup fires BEFORE the queued rAF runs — onUp resets the preview
      // and confirms the drag synchronously, same as always.
      dispatch(winEl, "pointerup", { clientX: 156, clientY: 50 });
      await flush();
      expect(bar.style.left).toBe(`${originalLeft}px`); // Reset on drop.
      expect(h.updateTaskItem).toHaveBeenCalledTimes(1);

      // The stale rAF now fires late (simulating a real-browser scheduling
      // race). It must be a harmless no-op, not overwrite the reset preview
      // with the pre-drop-position stale delta.
      expect(() => queued[0](0)).not.toThrow();
      expect(bar.style.left).toBe(`${originalLeft}px`);
    });

    it("marker drag: multiple pointermoves within one frame apply only the latest position via a single rAF", async () => {
      const { timeline, bar } = await openViewWithBar({
        ganttMarkers: [{ key: "m1", title: "M1", date: dateOffset(2) }],
      });
      void bar;
      const markerEl = markerElOf(timeline);
      const originalLeft = parseFloat(markerEl.style.left);

      dispatch(markerEl, "pointerdown", {
        button: 0,
        clientX: 100,
        pointerId: 1,
      });

      const queued: Array<(t: number) => void> = [];
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        queued.push(cb);
        return queued.length;
      });

      dispatch(winEl, "pointermove", { clientX: 110, clientY: 50 });
      dispatch(winEl, "pointermove", { clientX: 128, clientY: 50 }); // +28px (latest)

      expect(queued).toHaveLength(1);
      expect(markerEl.style.left).toBe(`${originalLeft}px`);

      queued[0](0);
      expect(markerEl.style.left).toBe(`${originalLeft + 28}px`);
    });
  });
});





describe("parent title inline editor", () => {
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function leftAndTitle(container: FakeEl): { left: FakeEl; title: FakeEl } {
    const left = leftOf(parentRows(container)[0]);
    const title = byClass(left, "task-gantt-parent-title")[0];
    return { left, title };
  }

  function titleEditorOf(left: FakeEl): FakeEl | undefined {
    return byClass(left, "task-gantt-parent-title-editor")[0];
  }

  it("dblclick opens a <textarea> pre-filled with the current name and hides the title element", async () => {
    const parent = makeParent({
      ganttEnabled: true,
      displayName: "表示名",
      title: "タイトル",
    });
    const { container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);

    dispatch(title, "dblclick");

    const editor = titleEditorOf(left);
    expect(editor).toBeDefined();
    expect(editor!.tagName).toBe("TEXTAREA");
    expect(editor!.value).toBe("表示名");
    expect(title.style.display).toBe("none"); // hidden while editing
  });

  it("falls back to title when displayName is empty", async () => {
    const parent = makeParent({
      ganttEnabled: true,
      displayName: "",
      title: "フォールバック",
    });
    const { container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    expect(titleEditorOf(left)!.value).toBe("フォールバック");
  });

  it("draggable is forced false during the edit and restored after a blur-commit", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    expect(left.getAttribute("draggable")).toBe("true");

    dispatch(title, "dblclick");
    expect(left.getAttribute("draggable")).toBe("false");

    dispatch(titleEditorOf(left)!, "blur");
    await flush();
    expect(left.getAttribute("draggable")).toBe("true"); // restored
  });

  it("dragstart is a no-op while the title is mid-edit (drag-vs-edit interaction)", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { view, container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");

    const dataTransfer = { setData: vi.fn() };
    dispatch(left, "dragstart", { dataTransfer });
    expect((view as any).dragParentId).toBeUndefined();
    expect(dataTransfer.setData).not.toHaveBeenCalled();
  });

  it("sibling elements (tag chips) get .twb-hidden-during-title-edit during the edit, removed after", async () => {
    const parent = makeParent({ ganttEnabled: true, tags: ["backend"] });
    const { container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    const tagsEl = byClass(left, "task-gantt-parent-tags")[0];
    expect(tagsEl).toBeDefined();

    dispatch(title, "dblclick");
    expect(tagsEl.classList.contains("twb-hidden-during-title-edit")).toBe(
      true
    );

    dispatch(titleEditorOf(left)!, "blur");
    await flush();
    expect(tagsEl.classList.contains("twb-hidden-during-title-edit")).toBe(
      false
    );
  });

  it("tags stay hidden through cancel (Escape) and Ctrl+Enter paths and are restored, not deleted", async () => {
    const parent = makeParent({ ganttEnabled: true, tags: ["backend", "frontend"] });
    const { container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    const tagsEl = byClass(left, "task-gantt-parent-tags")[0];
    const chipCount = tagsEl.children.length;

    dispatch(title, "dblclick");
    expect(tagsEl.classList.contains("twb-hidden-during-title-edit")).toBe(true);
    dispatch(titleEditorOf(left)!, "keydown", { key: "Escape" });
    expect(tagsEl.classList.contains("twb-hidden-during-title-edit")).toBe(false);
    expect(tagsEl.children).toHaveLength(chipCount);

    dispatch(title, "dblclick");
    expect(tagsEl.classList.contains("twb-hidden-during-title-edit")).toBe(true);
    dispatch(titleEditorOf(left)!, "keydown", { key: "Enter", ctrlKey: true });
    await flush();
    expect(tagsEl.classList.contains("twb-hidden-during-title-edit")).toBe(false);
    expect(tagsEl.children).toHaveLength(chipCount);
  });

  it("styles.css hides .twb-hidden-during-title-edit children of the parent-left region", async () => {
    const css = (await import("node:fs")).readFileSync("styles.css", "utf8");
    expect(css).toMatch(
      /\.task-gantt-parent-left\s*>\s*\.twb-hidden-during-title-edit\s*\{[^}]*display:\s*none/
    );
  });

  it("blur always commits a trimmed value with newline runs collapsed to a single space", async () => {
    const parent = makeParent({ ganttEnabled: true, displayName: "旧" });
    const { h, container } = await openView([parent]);
    h.loadTasks.mockClear();
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    const editor = titleEditorOf(left)!;
    editor.value = "  新しい\n\n  名前  ";
    dispatch(editor, "blur");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      displayName: "新しい 名前",
      title: "新しい 名前",
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("Ctrl/Cmd+Enter commits when not composing", async () => {
    const parent = makeParent({ ganttEnabled: true, displayName: "旧" });
    const { h, container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    const editor = titleEditorOf(left)!;
    editor.value = "新値";
    dispatch(editor, "keydown", { key: "Enter", ctrlKey: true });
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      displayName: "新値",
      title: "新値",
    });
  });

  it("plain Enter (no modifier) does NOT commit — the textarea stays open for a newline", async () => {
    const parent = makeParent({ ganttEnabled: true, displayName: "旧" });
    const { h, container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    const editor = titleEditorOf(left)!;
    editor.value = "新値";
    dispatch(editor, "keydown", { key: "Enter" });
    await flush();

    expect(h.updateTaskItem).not.toHaveBeenCalled();
    expect(titleEditorOf(left)).toBeDefined(); // still editing
  });

  it("Escape cancels without saving when not composing", async () => {
    const parent = makeParent({ ganttEnabled: true, displayName: "旧" });
    const { h, container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    const editor = titleEditorOf(left)!;
    editor.value = "変更されたが保存されない";
    dispatch(editor, "keydown", { key: "Escape" });
    await flush();

    expect(h.updateTaskItem).not.toHaveBeenCalled();
    expect(titleEditorOf(left)).toBeUndefined(); // editor torn down
    expect(title.style.display).not.toBe("none"); // title restored
  });

  it("Ctrl+Enter/Escape are both ignored while composing (IME), and work again once composition ends", async () => {
    const parent = makeParent({ ganttEnabled: true, displayName: "旧" });
    const { h, container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    const editor = titleEditorOf(left)!;

    dispatch(editor, "compositionstart");
    editor.value = "変換中";
    dispatch(editor, "keydown", { key: "Enter", ctrlKey: true });
    dispatch(editor, "keydown", { key: "Escape" });
    await flush();
    expect(h.updateTaskItem).not.toHaveBeenCalled();
    expect(titleEditorOf(left)).toBeDefined(); // neither committed nor cancelled

    dispatch(editor, "compositionend");
    dispatch(editor, "keydown", { key: "Escape" });
    await flush();
    expect(titleEditorOf(left)).toBeUndefined(); // Escape works again post-IME
  });

  it("an unchanged value (after trim) saves nothing", async () => {
    const parent = makeParent({ ganttEnabled: true, displayName: "変わらない" });
    const { h, container } = await openView([parent]);
    const { left, title } = leftAndTitle(container);
    dispatch(title, "dblclick");
    const editor = titleEditorOf(left)!;
    editor.value = "  変わらない  ";
    dispatch(editor, "blur");
    await flush();

    expect(h.updateTaskItem).not.toHaveBeenCalled();
  });
});

describe("parent context menu", () => {
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openParentMenu(container: FakeEl, index = 0): FakeEl {
    const left = leftOf(parentRows(container)[index]);
    dispatch(left, "contextmenu", { clientX: 10, clientY: 10 });
    return left;
  }

  it("right-click shows 「親タスク名を編集」, which opens a prompt pre-filled with the current name", async () => {
    const parent = makeParent({
      ganttEnabled: true,
      displayName: "元の名前",
      title: "タイトル",
    });
    const { h, container } = await openView([parent]);
    openParentMenu(container);
    dispatch(menuItemWithText("親タスク名を編集"), "click");

    expect(h.openTextPrompt).toHaveBeenCalledTimes(1);
    const [title, label, initialValue] = h.openTextPrompt.mock.calls[0];
    expect(title).toBe("親タスク名を編集");
    expect(label).toBe("親タスク名");
    expect(initialValue).toBe("元の名前");
  });

  it("confirming the prompt trims and saves both displayName/title, then re-renders", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { h, container } = await openView([parent]);
    h.loadTasks.mockClear();
    openParentMenu(container);
    dispatch(menuItemWithText("親タスク名を編集"), "click");
    const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
      value: string
    ) => void;
    onSubmit("  新しい名前  ");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      displayName: "新しい名前",
      title: "新しい名前",
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("an empty (whitespace-only) confirmed value cancels without saving or re-rendering", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { h, container } = await openView([parent]);
    h.loadTasks.mockClear();
    openParentMenu(container);
    dispatch(menuItemWithText("親タスク名を編集"), "click");
    const onSubmit = h.openTextPrompt.mock.calls[0][3] as (
      value: string
    ) => void;
    onSubmit("   ");
    await flush();

    expect(h.updateTaskItem).not.toHaveBeenCalled();
    expect(h.loadTasks).not.toHaveBeenCalled();
  });

  it("the parent menu's tag toggle adds/removes tags the same way the bar menu's does", async () => {
    const parent = makeParent({ ganttEnabled: true, tags: ["existing"] });
    const { h, container } = await openView([parent], {
      ganttTags: tagRegistry(["existing", "urgent"]),
    });
    h.loadTasks.mockClear();
    openParentMenu(container);
    dispatch(menuItemWithText("タグ"), "click");
    dispatch(menuItemWithText("urgent"), "click");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      tags: ["existing", "urgent"],
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("「サブタスクを追加」 delegates to host.addSubtaskInteractively and re-renders via its callback", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { h, container } = await openView([parent]);
    const addSubtaskInteractively = vi.fn(
      async (_row: TaskRow, onCreated: () => void) => {
        onCreated();
      }
    );
    h.host.addSubtaskInteractively = addSubtaskInteractively;
    h.loadTasks.mockClear();
    openParentMenu(container);
    dispatch(menuItemWithText("サブタスクを追加"), "click");
    await flush();

    expect(addSubtaskInteractively).toHaveBeenCalledTimes(1);
    expect(addSubtaskInteractively.mock.calls[0][0]).toBe(parent);
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("warns loudly when the host omits addSubtaskInteractively", async () => {
    const { h, container } = await openView([makeParent({ ganttEnabled: true })]);
    openParentMenu(container);
    dispatch(menuItemWithText("サブタスクを追加"), "click");

    expect(h.host.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.host.logger.warn).toHaveBeenCalledWith(
      "TaskGanttView",
      expect.stringContaining("addSubtaskInteractively")
    );
  });

  it("「ガントでの管理をやめる」 sets ganttEnabled:false and the row disappears from the Gantt after the re-render", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { h, container } = await openView([parent]);
    expect(parentRows(container)).toHaveLength(1);
    h.loadTasks.mockClear();
    // The re-render this action triggers reflects the flip — task-operations

    // boundary (same idiom every other "does the row vanish after re-render"
    // test in this file uses).
    h.loadTasks.mockResolvedValueOnce([{ ...parent, ganttEnabled: false }]);
    openParentMenu(container);
    dispatch(menuItemWithText("ガントでの管理をやめる"), "click");
    await flush();

    expect(h.updateTaskItem).toHaveBeenCalledWith(parent, {
      ganttEnabled: false,
    });
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
    expect(parentRows(container)).toHaveLength(0);
    // Disabling Gantt removes the row from the view but leaves the task data
    // intact. openExistingParentPicker uses the same ganttEnabled filter.
  });

  it("「ノートを開く」 opens the parent's note", async () => {
    const parent = makeParent({ ganttEnabled: true });
    const { h, container } = await openView([parent]);
    openParentMenu(container);
    dispatch(menuItemWithText("ノートを開く"), "click");

    expect(h.openTaskItem).toHaveBeenCalledWith(parent);
  });
});

describe("parent reorder — native HTML5 drag-and-drop", () => {
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("window", makeFakeEl("window"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fresh fake DataTransfer stub (real setData is all this area needs). */
  function fakeDataTransfer(): { setData: ReturnType<typeof vi.fn> } {
    return { setData: vi.fn() };
  }

  it("dragstart records dragParentId and writes the id via dataTransfer.setData(\"text/plain\", …)", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000 });
    const p2 = makeParent({ id: "tasks/p2.md", ganttEnabled: true, ganttOrder: 2000 });
    const { view, container } = await openView([p1, p2]);
    const left1 = leftOf(parentRows(container)[0]);
    const dataTransfer = fakeDataTransfer();

    dispatch(left1, "dragstart", { dataTransfer });

    expect((view as any).dragParentId).toBe(p1.id);
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", p1.id);
  });

  it("is-dragging is added on dragstart and removed on dragend", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000 });
    const { container } = await openView([p1]);
    const left1 = leftOf(parentRows(container)[0]);

    dispatch(left1, "dragstart", { dataTransfer: fakeDataTransfer() });
    expect(left1.classList.contains("is-dragging")).toBe(true);

    dispatch(left1, "dragend");
    expect(left1.classList.contains("is-dragging")).toBe(false);
  });

  it("a cancelled drag (dragend with no drop) clears dragParentId so a later unrelated drop is not misattributed", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000 });
    const p2 = makeParent({ id: "tasks/p2.md", ganttEnabled: true, ganttOrder: 2000 });
    const { h, view, container } = await openView([p1, p2]);
    h.loadTasks.mockClear();
    const left1 = leftOf(parentRows(container)[0]);
    const left2 = leftOf(parentRows(container)[1]);

    dispatch(left1, "dragstart", { dataTransfer: fakeDataTransfer() });
    dispatch(left1, "dragend"); // cancelled: no "drop" fired
    expect((view as any).dragParentId).toBeUndefined();

    // A later, unrelated drop (e.g. an OS file drag) must not be treated as
    // a continuation of the cancelled parent-reorder drag.
    dispatch(left2, "drop", { dataTransfer: fakeDataTransfer() });
    await flush();

    expect(h.updateTaskItemsBatch).not.toHaveBeenCalled();
    expect(h.loadTasks).not.toHaveBeenCalled();
  });

  it("dragover adds .is-drag-over to the row it is over; dragleave removes it", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000 });
    const p2 = makeParent({ id: "tasks/p2.md", ganttEnabled: true, ganttOrder: 2000 });
    const { container } = await openView([p1, p2]);
    const left2 = leftOf(parentRows(container)[1]);

    dispatch(left2, "dragover", { dataTransfer: fakeDataTransfer() });
    expect(left2.classList.contains("is-drag-over")).toBe(true);

    dispatch(left2, "dragleave");
    expect(left2.classList.contains("is-drag-over")).toBe(false);
  });

  it("dropping a parent onto itself is a no-op", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000 });
    const { h, container } = await openView([p1]);
    h.loadTasks.mockClear();
    const left1 = leftOf(parentRows(container)[0]);

    dispatch(left1, "dragstart", { dataTransfer: fakeDataTransfer() });
    dispatch(left1, "drop", { dataTransfer: fakeDataTransfer() });
    await flush();

    expect(h.updateTaskItemsBatch).not.toHaveBeenCalled();
    expect(h.loadTasks).not.toHaveBeenCalled();
  });

  it("dropping with no prior dragstart (empty dragParentId) is a no-op", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000 });
    const p2 = makeParent({ id: "tasks/p2.md", ganttEnabled: true, ganttOrder: 2000 });
    const { h, container } = await openView([p1, p2]);
    h.loadTasks.mockClear();
    const left2 = leftOf(parentRows(container)[1]);

    dispatch(left2, "drop", { dataTransfer: fakeDataTransfer() });
    await flush();

    expect(h.updateTaskItemsBatch).not.toHaveBeenCalled();
    expect(h.loadTasks).not.toHaveBeenCalled();
  });

  it("dropping reorders via splice, renormalizes ganttOrder to (i+1)*1000, and batches only the rows whose order actually changed", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 1000, displayName: "P1" });
    const p2 = makeParent({ id: "tasks/p2.md", ganttEnabled: true, ganttOrder: 2000, displayName: "P2" });
    const p3 = makeParent({ id: "tasks/p3.md", ganttEnabled: true, ganttOrder: 3000, displayName: "P3" });
    const { h, container } = await openView([p1, p2, p3]);
    h.loadTasks.mockClear();

    // Rendered order (getGanttParentRows, ascending ganttOrder): [P1,P2,P3].
    // Drag P2 (index 1) and drop onto P3 (index 2) -> splice -> [P1,P3,P2].
    const left2 = leftOf(parentRows(container)[1]);
    const left3 = leftOf(parentRows(container)[2]);
    dispatch(left2, "dragstart", { dataTransfer: fakeDataTransfer() });
    dispatch(left3, "drop", { dataTransfer: fakeDataTransfer() });
    await flush();

    expect(h.updateTaskItemsBatch).toHaveBeenCalledTimes(1);
    const commands = h.updateTaskItemsBatch.mock.calls[0][0] as Array<{
      row: TaskRow;
      patch: { ganttOrder: number };
    }>;
    // P1 stays at position 0 -> its ganttOrder (1000) is UNCHANGED, so it
    // must be excluded from the batch entirely.
    expect(commands.some((c) => c.row === p1)).toBe(false);
    expect(commands).toHaveLength(2);
    expect(commands).toEqual(
      expect.arrayContaining([
        { row: p3, patch: { ganttOrder: 2000 } },
        { row: p2, patch: { ganttOrder: 3000 } },
      ])
    );
    expect(h.loadTasks).toHaveBeenCalledTimes(1);
  });

  it("a parent with a non-finite (undefined) ganttOrder sorts last before reordering", async () => {
    const p1 = makeParent({ id: "tasks/p1.md", ganttEnabled: true, ganttOrder: 500, displayName: "P1" });
    const p2 = makeParent({ id: "tasks/p2.md", ganttEnabled: true, ganttOrder: undefined, displayName: "P2" });
    const p3 = makeParent({ id: "tasks/p3.md", ganttEnabled: true, ganttOrder: 1500, displayName: "P3" });
    const { h, container } = await openView([p1, p2, p3]);
    h.loadTasks.mockClear();

    // Rendered order: P1(500), P3(1500), P2(undefined -> 999999 fallback,
    // last). Drag P2 (index 2) and drop onto P1 (index 0) -> [P2,P1,P3].
    const leftP2 = leftOf(parentRows(container)[2]);
    const leftP1 = leftOf(parentRows(container)[0]);
    dispatch(leftP2, "dragstart", { dataTransfer: fakeDataTransfer() });
    dispatch(leftP1, "drop", { dataTransfer: fakeDataTransfer() });
    await flush();

    const commands = h.updateTaskItemsBatch.mock.calls[0][0] as Array<{
      row: TaskRow;
      patch: { ganttOrder: number };
    }>;
    expect(commands).toEqual(
      expect.arrayContaining([
        { row: p2, patch: { ganttOrder: 1000 } },
        { row: p1, patch: { ganttOrder: 2000 } },
        { row: p3, patch: { ganttOrder: 3000 } },
      ])
    );
  });
});
