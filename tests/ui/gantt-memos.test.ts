/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import moment from "moment";
import { Notice } from "obsidian";
import { TaskGanttView } from "../../src/ui/task-gantt-view";
import type { TaskGanttViewHost } from "../../src/ui/task-gantt-view";
import { TaskFinderModal } from "../../src/ui/task-finder-modal";
import type { MemoHost } from "../../src/app/memo-controller";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { MemoMeta } from "../../src/core/memo";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { addDays, diffDays } from "../../src/app/gantt-layout";
import { BAR_HEIGHT, PARENT_COL_WIDTH } from "../../src/app/gantt-constants";
import { byClass, createFakeDocument, deepText, dispatch, makeFakeEl } from "../stubs/fake-dom";
import type { FakeEl } from "../stubs/fake-dom";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn() };
});

const dateOffset = (days: number): string => moment().startOf("day").add(days, "days").format("YYYY-MM-DD");
const flush = async (): Promise<void> => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, shiftKey: false, isComposing: false, keyCode: 0, ...extra });

const PARENT_ID = "tasks/parent-1.md";

function parentRow(subtasks: TaskRow[]): TaskRow {
  return {
    kind: "parent", id: PARENT_ID, file: { path: PARENT_ID }, title: "親タスク", displayName: "親タスク", statusLabel: "active",
    completed: false, createdAt: "2026-07-01 10:00:00", updatedAt: "2026-07-02 11:00:00", priority: 2, priorityMode: "manual",
    currentStatus: "", notes: "", tags: [], ganttEnabled: true,
    subtasks: new Map(subtasks.map((sub): [string, TaskRow] => [sub.key ?? sub.id, sub])),
  } as unknown as TaskRow;
}

function subtaskRow(keyName: string, start: string, end: string): TaskRow {
  return {
    kind: "subtask", id: `${PARENT_ID}::${keyName}`, key: keyName, parentId: PARENT_ID, file: { path: PARENT_ID, parentPath: PARENT_ID },
    title: keyName, displayName: keyName, statusLabel: "active", completed: false, createdAt: "2026-07-01 10:00:00",
    updatedAt: "2026-07-02 11:00:00", priority: 2, priorityMode: "manual", currentStatus: "", notes: "", tags: [],
    plannedStartDate: start, plannedEndDate: end,
  } as unknown as TaskRow;
}

function memoMeta(id: string, extra: Partial<MemoMeta> = {}): MemoMeta {
  return { id, path: `tasks/_memos/2026-10-01 ${id}.md`, created: dateOffset(0), updated: dateOffset(0), ...extra };
}

interface Rig {
  view: TaskGanttView;
  container: FakeEl;
  host: TaskGanttViewHost;
  memos: { [K in keyof MemoHost]: ReturnType<typeof vi.fn> };
  settings: TaskWorkbenchSettings;
  loadTasks: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  stored: MemoMeta[];
  sub: TaskRow;
  parent: TaskRow;
}

async function openGantt(stored: MemoMeta[], opts: { withMemos?: boolean; settings?: Record<string, unknown> } = {}): Promise<Rig> {
  const sub = subtaskRow("sub1", dateOffset(0), dateOffset(5));
  const parent = parentRow([sub]);
  const settings = { ...DEFAULT_SETTINGS, ganttTags: [], ...opts.settings } as TaskWorkbenchSettings;
  settings.ganttHolidays = [...settings.ganttHolidays]; settings.ganttManualHolidays = [...settings.ganttManualHolidays];
  settings.ganttNationalHolidays = [...settings.ganttNationalHolidays]; settings.ganttSpecialHolidays = [...settings.ganttSpecialHolidays];
  settings.ganttEvents = [...settings.ganttEvents]; settings.weeklyWorkSchedules = [...settings.weeklyWorkSchedules];
  const loadTasks = vi.fn(async () => [parent]);
  const saveSettings = vi.fn(async () => undefined);
  const memos = {
    load: vi.fn(async () => stored),
    readText: vi.fn(async (meta: MemoMeta) => `本文 ${meta.id}`),
    create: vi.fn(async (input: { text: string; date: string; task?: TaskRow }) => {
      const meta = memoMeta("m-created", { date: input.date, taskId: input.task?.id });
      stored.push(meta);
      return meta;
    }),
    updateText: vi.fn(async () => undefined),
    reanchor: vi.fn(async () => undefined),
    remove: vi.fn(async (meta: MemoMeta) => { stored.splice(stored.indexOf(meta), 1); }),
    openNote: vi.fn(async () => undefined),
    saveLayout: vi.fn(),
  };
  const host = {
    logger: { warn: vi.fn(), error: vi.fn() },
    settings,
    loadTasks,
    loadDailyTodoSummaries: vi.fn(async () => []),
    saveSettings,
    updateTaskItem: vi.fn(async () => ({})),
    openAIChat: vi.fn(async () => undefined),
    activateView: vi.fn(async () => undefined),
    manifest: { version: "1.2.3", releaseNotes: "", description: "" },
    ...(opts.withMemos === false ? {} : { memos }),
  } as unknown as TaskGanttViewHost;
  const view = new TaskGanttView({} as any, host);
  const container = (view as any).containerEl as FakeEl;
  await view.onOpen();
  return { view, container, host, memos, settings, loadTasks, saveSettings, stored, sub, parent };
}

const wrapOf = (c: FakeEl): FakeEl => byClass(c, "task-gantt-wrap")[0] as FakeEl;
const layerOf = (c: FakeEl): FakeEl | undefined => byClass(c, "vg-memo-layer")[0];
const parentRows = (c: FakeEl): FakeEl[] => byClass(c, "task-gantt-parent-row");
const menuItems = (): FakeEl[] => byClass((document as any).body as FakeEl, "menu-item");
const menuItem = (text: string): FakeEl => {
  const found = menuItems().find((el) => deepText(el).includes(text));
  if (!found) throw new Error(`no menu item: ${text}`);
  return found;
};
const toolbarButton = (c: FakeEl, cls: string): FakeEl | undefined => byClass(c, cls)[0];

/** Fake elements have no layout, so tests give rows the offsets a browser would report. */
function layOut(r: Rig): { parentTop: number; eventTop: number } {
  const wrap = wrapOf(r.container);
  wrap.scrollWidth = 6000; wrap.scrollHeight = 900; wrap.clientWidth = 1000; wrap.scrollLeft = 0;
  const parentTop = 160, eventTop = 90;
  (parentRows(r.container)[0] as any).offsetTop = parentTop;
  const eventRow = (r.view as any).eventRowEl as FakeEl | undefined;
  if (eventRow) (eventRow as any).offsetTop = eventTop;
  return { parentTop, eventTop };
}

const xOfDate = (r: Rig, date: string): number =>
  PARENT_COL_WIDTH + diffDays((r.view as any).rangeStart as string, date) * ((r.view as any).dayWidth as number) + ((r.view as any).dayWidth as number) / 2;

describe("Gantt floating memos", () => {
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { cb(0); return 0; });
    vi.stubGlobal("window", makeFakeEl("window"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("without a memo host", () => {
    it("draws no memo UI at all", async () => {
      const r = await openGantt([], { withMemos: false });
      expect(toolbarButton(r.container, "task-gantt-memos")).toBeUndefined();
      expect(layerOf(r.container)).toBeUndefined();
    });

    it("keeps the bar menu and the event-row right-click as they were", async () => {
      const r = await openGantt([], { withMemos: false });
      const bar = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      dispatch(bar, "contextmenu", { clientX: 100, clientY: 50 });
      expect(menuItems().some((el) => deepText(el).includes("メモ"))).toBe(false);
      const eventTimeline = byClass(r.container, "task-gantt-event-row")[0] as FakeEl;
      const before = r.settings.ganttEvents.length;
      dispatch(eventTimeline, "contextmenu", { clientX: 400, clientY: 50 });
      await flush();
      expect(r.settings.ganttEvents.length).toBe(before + 1);
    });
  });

  describe("the toolbar button", () => {
    it("sits right after the AI button and shows the memo count", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa"), memoMeta("m-bbbbbb")]);
      const toolbar = byClass(r.container, "task-gantt-toolbar")[0] as FakeEl;
      const names = toolbar.children.map((child) => child.className);
      const ai = names.findIndex((name) => name.includes("task-gantt-ai"));
      expect(ai).toBeGreaterThan(-1);
      expect(names[ai + 1]).toContain("task-gantt-memos");
      expect(toolbarButton(r.container, "task-gantt-memos")?.textContent).toBe("メモ 2");
    });

    it("click toggles the visibility setting, saves the layout state only and hides the layer", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa")]);
      layOut(r); await r.view.reloadMemos();
      const button = toolbarButton(r.container, "task-gantt-memos") as FakeEl;
      dispatch(button, "click");
      expect(r.settings.ganttMemosVisible).toBe(false);
      expect(r.memos.saveLayout).toHaveBeenCalledTimes(1);
      expect(r.saveSettings).not.toHaveBeenCalled();
      expect(layerOf(r.container)?.style.display).toBe("none");
      expect(button.classList.contains("is-off")).toBe(true);
      dispatch(button, "click");
      expect(r.settings.ganttMemosVisible).toBe(true);
      expect(layerOf(r.container)?.style.display).toBe("");
    });

    it("right-click offers すべて開く / すべて閉じる", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa"), memoMeta("m-bbbbbb")]);
      layOut(r); await r.view.reloadMemos();
      dispatch(toolbarButton(r.container, "task-gantt-memos") as FakeEl, "contextmenu", { clientX: 5, clientY: 5 });
      dispatch(menuItem("すべて閉じる"), "click");
      expect(Object.values(r.settings.ganttMemoLayout).map((layout) => layout.open)).toEqual([false, false]);
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo-pin")).toHaveLength(2);
      dispatch(toolbarButton(r.container, "task-gantt-memos") as FakeEl, "contextmenu", { clientX: 5, clientY: 5 });
      dispatch(menuItem("すべて開く"), "click");
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo")).toHaveLength(2);
    });

    it("shows the memos again when すべて開く is chosen while they are hidden", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa")], { settings: { ganttMemosVisible: false } });
      layOut(r); await r.view.reloadMemos();
      dispatch(toolbarButton(r.container, "task-gantt-memos") as FakeEl, "contextmenu", { clientX: 5, clientY: 5 });
      dispatch(menuItem("すべて開く"), "click");
      expect(r.settings.ganttMemosVisible).toBe(true);
    });
  });

  describe("placement", () => {
    it("keeps the layer as the last child of the scroll container, through full and incremental renders", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { date: dateOffset(2) })]);
      layOut(r);
      const wrap = wrapOf(r.container);
      const last = (): FakeEl => wrap.children[wrap.children.length - 1] as FakeEl;
      expect(last()).toBe(layerOf(r.container));
      await r.view.render();
      expect(last()).toBe(layerOf(r.container));
      r.view.renderChart();
      expect(last()).toBe(layerOf(r.container));
      expect(byClass(r.container, "vg-memo-layer")).toHaveLength(1);
    });

    it("puts a 「その他」 memo on the event row at its date", async () => {
      const date = dateOffset(3);
      const r = await openGantt([memoMeta("m-aaaaaa", { date })]);
      const { eventTop } = layOut(r);
      await r.view.reloadMemos();
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      expect(dot.style.left).toBe(`${xOfDate(r, date)}px`);
      expect(dot.style.top).toBe(`${eventTop + 8}px`);
    });

    it("puts a parent memo on the parent row at its date", async () => {
      const date = dateOffset(4);
      const r = await openGantt([memoMeta("m-aaaaaa", { taskId: PARENT_ID, date })]);
      const { parentTop } = layOut(r);
      await r.view.reloadMemos();
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      expect(dot.style.left).toBe(`${xOfDate(r, date)}px`);
      expect(dot.style.top).toBe(`${parentTop + 8}px`);
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo-where")[0]?.textContent).toBe("親タスク");
    });

    it("follows a subtask memo along its bar: plannedStartDate plus its day offset, at the bar's height", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { taskId: `${PARENT_ID}::sub1`, at: 2 })]);
      const { parentTop } = layOut(r);
      await r.view.reloadMemos();
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      expect(dot.style.left).toBe(`${xOfDate(r, addDays(dateOffset(0), 2))}px`);
      // The center of the bar that is drawn on the row.
      const barEl = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      expect(dot.style.top).toBe(`${parentTop + Number.parseFloat(barEl.style.top) + BAR_HEIGHT / 2}px`);
    });

    it("clamps a subtask memo to the end of its bar", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { taskId: `${PARENT_ID}::sub1`, at: 40 })]);
      layOut(r); await r.view.reloadMemos();
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      expect(dot.style.left).toBe(`${xOfDate(r, dateOffset(5))}px`);
    });

    it("moves an orphaned memo to the 「その他」 row at its last known date, and keeps it", async () => {
      const date = dateOffset(1);
      const r = await openGantt([memoMeta("m-aaaaaa", { taskId: "tasks/gone.md", date })]);
      const { eventTop } = layOut(r);
      await r.view.reloadMemos();
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      expect(dot.style.left).toBe(`${xOfDate(r, date)}px`);
      expect(dot.style.top).toBe(`${eventTop + 8}px`);
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo-where")[0]?.textContent).toContain("元のタスクなし");
      expect(r.memos.remove).not.toHaveBeenCalled();
    });

    it("re-places after a zoom change", async () => {
      const date = dateOffset(3);
      const r = await openGantt([memoMeta("m-aaaaaa", { date })]);
      layOut(r); await r.view.reloadMemos();
      const dot = (): FakeEl => byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      const before = dot().style.left;
      await (r.view as any).setZoom(40);
      layOut(r); await r.view.reloadMemos();
      expect(dot().style.left).toBe(`${xOfDate(r, date)}px`);
      expect(dot().style.left).not.toBe(before);
    });

    it("leaves a memo out when its day is outside the drawn range", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { date: dateOffset(2000) })]);
      layOut(r); await r.view.reloadMemos();
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo")).toHaveLength(0);
    });

    it("scrolling writes only the clip edge", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { date: dateOffset(2) })]);
      layOut(r); await r.view.reloadMemos();
      const wrap = wrapOf(r.container);
      const rows = parentRows(r.container).slice();
      const layer = layerOf(r.container) as FakeEl;
      const groups = layer.children.slice();
      wrap.scrollLeft = 600;
      dispatch(wrap, "scroll");
      expect(layer.style.clipPath).toBe(`inset(0 0 0 ${600 + PARENT_COL_WIDTH}px)`);
      expect(layer.children).toEqual(groups);
      expect(parentRows(r.container)).toEqual(rows);
    });
  });

  describe("memos stay out of row rendering", () => {
    it("reloading memos re-reads only the memo notes and keeps every row element", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { date: dateOffset(2) })]);
      layOut(r);
      const rows = parentRows(r.container).slice();
      const bar = byClass(r.container, "task-gantt-bar")[0];
      r.loadTasks.mockClear(); r.memos.load.mockClear();
      await r.view.reloadMemos();
      expect(r.memos.load).toHaveBeenCalledTimes(1);
      expect(r.loadTasks).not.toHaveBeenCalled();
      expect(parentRows(r.container)).toEqual(rows);
      expect(byClass(r.container, "task-gantt-bar")[0]).toBe(bar);
    });

    it("lays out nothing inside rows: no memo node is a descendant of a row", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { taskId: `${PARENT_ID}::sub1`, at: 1 })]);
      layOut(r); await r.view.reloadMemos();
      for (const row of parentRows(r.container)) expect(byClass(row, "vg-memo")).toHaveLength(0);
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo")).toHaveLength(1);
    });

    it("a failing memo load does not stop the chart", async () => {
      const r = await openGantt([]);
      r.memos.load.mockRejectedValueOnce(new Error("io"));
      await r.view.render();
      expect(parentRows(r.container)).toHaveLength(1);
      expect((r.host.logger.error as any)).toHaveBeenCalled();
    });
  });

  describe("creating a memo", () => {
    it("bar right-click 「メモを追加」 opens an editor and creates the note on Enter", async () => {
      const r = await openGantt([]);
      layOut(r);
      const bar = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      // x = 320 (name column) + 3 days: the bar starts at today, 14 days into the range.
      const clientX = PARENT_COL_WIDTH + (14 + 2) * 28 + 3;
      dispatch(bar, "contextmenu", { clientX, clientY: 200 });
      dispatch(menuItem("メモを追加"), "click");
      const area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      expect(area).toBeDefined();
      expect(r.memos.create).not.toHaveBeenCalled();
      area.value = "打ち合わせ内容";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(r.memos.create).toHaveBeenCalledTimes(1);
      expect(r.memos.create.mock.calls[0]?.[0]).toMatchObject({ task: r.sub, date: addDays(dateOffset(0), 2), text: "打ち合わせ内容" });
      expect(r.settings.ganttMemoLayout["m-created"]?.open).toBe(true);
      expect(byClass(r.container, "task-gantt-memos")[0]?.textContent).toBe("メモ 1");
    });

    it("keeps the new memo's date inside the bar", async () => {
      const r = await openGantt([]);
      layOut(r);
      const bar = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      dispatch(bar, "contextmenu", { clientX: PARENT_COL_WIDTH + 30 * 28, clientY: 200 });
      dispatch(menuItem("メモを追加"), "click");
      const area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "x";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(r.memos.create.mock.calls[0]?.[0]).toMatchObject({ date: dateOffset(5) });
    });

    it("empty-cell right-click 「この日にメモを追加」 attaches the memo to the parent row", async () => {
      const r = await openGantt([]);
      layOut(r);
      const timeline = byClass(parentRows(r.container)[0] as FakeEl, "task-gantt-parent-timeline")[0] as FakeEl;
      const hit = byClass(timeline, "task-gantt-bg-hit")[0] as FakeEl;
      dispatch(hit, "contextmenu", { offsetX: 20 * 28 + 1, clientX: 600, clientY: 200 });
      dispatch(menuItem("この日にメモを追加"), "click");
      const area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "親に付ける";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      const call = r.memos.create.mock.calls[0]?.[0];
      expect(call).toMatchObject({ task: r.parent, text: "親に付ける" });
      expect(call.date).toBe(addDays((r.view as any).rangeStart as string, 20));
    });

    it("the 「その他」 row offers both the event add and the memo add", async () => {
      const r = await openGantt([]);
      layOut(r);
      const eventTimeline = byClass(r.container, "task-gantt-event-row")[0] as FakeEl;
      dispatch(eventTimeline, "contextmenu", { clientX: 700, clientY: 50 });
      expect(menuItems().map((el) => deepText(el))).toEqual(["予定を追加", "この日にメモを追加"]);
      dispatch(menuItem("この日にメモを追加"), "click");
      const area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "自由メモ";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      const call = r.memos.create.mock.calls[0]?.[0];
      expect(call.task).toBeUndefined();
      expect(call.text).toBe("自由メモ");
    });

    it("「予定を追加」 still adds an event", async () => {
      const r = await openGantt([]);
      layOut(r);
      const before = r.settings.ganttEvents.length;
      dispatch(byClass(r.container, "task-gantt-event-row")[0] as FakeEl, "contextmenu", { clientX: 700, clientY: 50 });
      dispatch(menuItem("予定を追加"), "click");
      await flush();
      expect(r.settings.ganttEvents.length).toBe(before + 1);
    });

    it("Esc and empty text create no note", async () => {
      const r = await openGantt([]);
      layOut(r);
      const bar = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      dispatch(bar, "contextmenu", { clientX: PARENT_COL_WIDTH + 14 * 28 + 3, clientY: 200 });
      dispatch(menuItem("メモを追加"), "click");
      let area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "やめた";
      dispatch(area, "keydown", key("Escape"));
      dispatch(bar, "contextmenu", { clientX: PARENT_COL_WIDTH + 14 * 28 + 3, clientY: 200 });
      dispatch(menuItem("メモを追加"), "click");
      area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(r.memos.create).not.toHaveBeenCalled();
    });

    it("switches the memos on when a memo is added while they are hidden", async () => {
      const r = await openGantt([], { settings: { ganttMemosVisible: false } });
      layOut(r);
      const bar = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      dispatch(bar, "contextmenu", { clientX: PARENT_COL_WIDTH + 14 * 28 + 3, clientY: 200 });
      dispatch(menuItem("メモを追加"), "click");
      expect(r.settings.ganttMemosVisible).toBe(true);
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")).toHaveLength(1);
    });

    it("reports a failed creation and leaves no bubble behind", async () => {
      const r = await openGantt([]);
      layOut(r);
      r.memos.create.mockRejectedValueOnce(new Error("disk"));
      const bar = byClass(r.container, "task-gantt-bar")[0] as FakeEl;
      dispatch(bar, "contextmenu", { clientX: PARENT_COL_WIDTH + 14 * 28 + 3, clientY: 200 });
      dispatch(menuItem("メモを追加"), "click");
      const area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "失敗";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(Notice).toHaveBeenCalled();
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo")).toHaveLength(0);
    });
  });

  describe("the memo menu", () => {
    async function openMemo(extra: Partial<MemoMeta> = {}): Promise<{ r: Rig; meta: MemoMeta }> {
      const meta = memoMeta("m-aaaaaa", { taskId: PARENT_ID, date: dateOffset(2), ...extra });
      const r = await openGantt([meta]);
      layOut(r); await r.view.reloadMemos();
      const box = byClass(layerOf(r.container) as FakeEl, "vg-memo")[0] as FakeEl;
      dispatch(box, "contextmenu", { clientX: 500, clientY: 300 });
      return { r, meta };
    }

    it("offers 付け替え…, ノートを開く and 削除", async () => {
      await openMemo();
      expect(menuItems().map((el) => deepText(el))).toEqual(["付け替え…", "ノートを開く", "削除"]);
    });

    it("ノートを開く opens the memo note", async () => {
      const { r, meta } = await openMemo();
      dispatch(menuItem("ノートを開く"), "click");
      expect(r.memos.openNote).toHaveBeenCalledWith(meta);
    });

    it("削除 removes the note without asking, then redraws without the memo", async () => {
      const { r, meta } = await openMemo();
      dispatch(menuItem("削除"), "click");
      await flush();
      expect(r.memos.remove).toHaveBeenCalledWith(meta);
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo")).toHaveLength(0);
      expect(byClass(r.container, "task-gantt-memos")[0]?.textContent).toBe("メモ 0");
    });

    it("付け替え… opens the task finder with 「その他」 first, and reanchors to the chosen task", async () => {
      const opened: unknown[] = [];
      vi.spyOn(TaskFinderModal.prototype, "open").mockImplementation(function (this: TaskFinderModal) { opened.push(this); });
      const { r, meta } = await openMemo();
      dispatch(menuItem("付け替え…"), "click");
      const finder: any = opened[0];
      const items = finder.items as TaskRow[];
      expect(items[0]?.displayName).toBe("その他");
      expect(items.map((item) => item.displayName)).toEqual(["その他", "親タスク", "sub1"]);
      finder.chooseItem(items[2]);
      await flush();
      expect(r.memos.reanchor).toHaveBeenCalledWith(meta, { task: r.sub, date: dateOffset(2) });
    });

    it("付け替え… to 「その他」 passes no task", async () => {
      const opened: unknown[] = [];
      vi.spyOn(TaskFinderModal.prototype, "open").mockImplementation(function (this: TaskFinderModal) { opened.push(this); });
      const { r, meta } = await openMemo();
      dispatch(menuItem("付け替え…"), "click");
      const finder: any = opened[0];
      finder.chooseItem((finder.items as TaskRow[])[0]);
      await flush();
      expect(r.memos.reanchor).toHaveBeenCalledWith(meta, { task: undefined, date: dateOffset(2) });
    });

    it("holds the day inside the bar when moving a memo onto a subtask", async () => {
      const opened: unknown[] = [];
      vi.spyOn(TaskFinderModal.prototype, "open").mockImplementation(function (this: TaskFinderModal) { opened.push(this); });
      const { r, meta } = await openMemo({ date: dateOffset(20) });
      dispatch(menuItem("付け替え…"), "click");
      const finder: any = opened[0];
      finder.chooseItem((finder.items as TaskRow[])[2]);
      await flush();
      expect(r.memos.reanchor).toHaveBeenCalledWith(meta, { task: r.sub, date: dateOffset(5) });
    });

    it("dragging the dot reanchors to the day, on the same task", async () => {
      const meta = memoMeta("m-aaaaaa", { taskId: PARENT_ID, date: dateOffset(2) });
      const r = await openGantt([meta]);
      layOut(r); await r.view.reloadMemos();
      wrapOf(r.container).getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      dispatch(dot, "pointerdown", { button: 0, clientX: 700, clientY: 200 });
      dispatch((window as any) as FakeEl, "pointermove", { clientX: PARENT_COL_WIDTH + 20 * 28 + 5, clientY: 200 });
      dispatch((window as any) as FakeEl, "pointerup");
      await flush();
      expect(r.memos.reanchor).toHaveBeenCalledWith(meta, { task: r.parent, date: addDays((r.view as any).rangeStart as string, 20) });
    });

    it("a subtask memo's dot stays on the bar while dragging", async () => {
      const meta = memoMeta("m-aaaaaa", { taskId: `${PARENT_ID}::sub1`, at: 1 });
      const r = await openGantt([meta]);
      layOut(r); await r.view.reloadMemos();
      wrapOf(r.container).getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
      const dot = byClass(layerOf(r.container) as FakeEl, "vg-memo-dot")[0] as FakeEl;
      dispatch(dot, "pointerdown", { button: 0, clientX: 700, clientY: 200 });
      dispatch((window as any) as FakeEl, "pointermove", { clientX: PARENT_COL_WIDTH + 60 * 28, clientY: 200 });
      dispatch((window as any) as FakeEl, "pointerup");
      await flush();
      expect(r.memos.reanchor).toHaveBeenCalledWith(meta, { task: r.sub, date: dateOffset(5) });
    });

    it("reports a failed delete and redraws from the notes", async () => {
      const { r } = await openMemo();
      r.memos.remove.mockRejectedValueOnce(new Error("locked"));
      dispatch(menuItem("削除"), "click");
      await flush();
      expect(Notice).toHaveBeenCalled();
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo")).toHaveLength(1);
    });
  });

  describe("editing the text", () => {
    it("saves through the host, then shows the saved text without re-reading the note", async () => {
      const meta = memoMeta("m-aaaaaa", { taskId: PARENT_ID, date: dateOffset(2) });
      const r = await openGantt([meta]);
      layOut(r); await r.view.reloadMemos(); await flush();
      dispatch(byClass(layerOf(r.container) as FakeEl, "vg-memo-text")[0] as FakeEl, "dblclick");
      const area = byClass(layerOf(r.container) as FakeEl, "vg-memo-edit")[0] as FakeEl;
      area.value = "更新後";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(r.memos.updateText).toHaveBeenCalledWith(meta, "更新後");
      r.memos.readText.mockClear();
      await r.view.reloadMemos(); await flush();
      expect(byClass(layerOf(r.container) as FakeEl, "vg-memo-text")[0]?.textContent).toBe("更新後");
      expect(r.memos.readText).not.toHaveBeenCalled();
    });
  });

  describe("tearing down", () => {
    it("removes the layer when the view closes", async () => {
      const r = await openGantt([memoMeta("m-aaaaaa", { date: dateOffset(2) })]);
      layOut(r); await r.view.reloadMemos();
      await r.view.onClose();
      expect(layerOf(r.container)).toBeUndefined();
    });
  });
});
