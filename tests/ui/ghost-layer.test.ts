/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderGhost } from "../../src/ui/ghost-layer";
import { TaskGanttView, type TaskGanttViewHost } from "../../src/ui/task-gantt-view";
import { ScheduleGhostStore } from "../../src/app/schedule-ghost";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { createFakeDocument, byClass, makeFakeEl } from "../stubs/fake-dom";
import { FakePreviewPort } from "./preview-fakes";
import { DELETE_PREVIEW, OUTSIDE_RANGE_PREVIEW, PARENT_ID } from "../contracts/fixtures";
import type { TaskRow } from "../../src/core/types";
import type { OperationResult } from "../../src/app/operation-registry";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const ghost = { taskId: "tasks/p.md::child", name: "子タスク", before: { start: "2026-10-01", end: "2026-10-02" }, after: { start: "2026-10-03", end: "2026-10-04" } };
const result: OperationResult = { kind: "success", committed: 1, total: 1, results: [], message: "ok", diffs: [{ taskId: ghost.taskId, name: ghost.name, fields: [{ field: "plannedStartDate", before: ghost.before.start, after: ghost.after.start }], schedule: { before: ghost.before, after: ghost.after } }] };
describe("before/current Gantt ghost layer", () => {
  it("uses the existing day scale and labels before/current without color-only encoding", () => {
    vi.stubGlobal("document", createFakeDocument()); const timeline = makeFakeEl("div"); const current = makeFakeEl("div"); timeline.appendChild(current);
    const nodes = renderGhost(timeline as any, ghost, "2026-10-01", 20, 10, current as any);
    expect(nodes).toHaveLength(2); expect(current.classList.contains("vg-ai-target")).toBe(true);
    const old = byClass(timeline, "vg-ai-ghost")[0]; expect(old.style.left).toBe("0px"); expect(old.style.width).toBe("36px");
    expect(old.getAttribute("aria-label")).toContain("変更前"); expect(byClass(timeline, "vg-ai-target-label")[0].textContent).toBe("→ 2日後ろへ");
    expect(old.style.top).toBe("2px"); expect(old.style.width).toBe("36px");
  });
  it.each([14, 28, 72])("preserves date geometry and the normal bar at %ipx/day", (zoom) => {
    vi.stubGlobal("document", createFakeDocument()); const timeline = makeFakeEl("div"); timeline.style.width = "600px";
    const current = makeFakeEl("div"); current.style.left = 2 * zoom + "px"; current.style.top = "10px"; current.style.width = 2 * zoom - 4 + "px"; current.style.height = "24px";
    timeline.appendChild(current);
    const original = { ...current.style };
    renderGhost(timeline as any, ghost, "2026-10-01", zoom, 10, current as any);
    expect(current.style).toEqual(original);
    const old = byClass(timeline, "vg-ai-ghost")[0];
    expect(old.style.left).toBe("0px"); expect(old.style.width).toBe(2 * zoom - 4 + "px"); expect(old.style.top).toBe("2px");
  });
  it("clips a partially visible old period using measured pixels, not percentage text", () => {
    vi.stubGlobal("document", createFakeDocument()); const timeline = makeFakeEl("div"); timeline.style.width = "100%"; timeline.clientWidth = 200;
    renderGhost(timeline as any, { ...ghost, before: { start: "2026-09-30", end: "2026-10-02" } }, "2026-10-01", 20, 10);
    const old = byClass(timeline, "vg-ai-ghost")[0];
    expect(old.style.left).toBe("0px"); expect(old.style.width).toBe("36px");
    expect(old.classList.contains("is-clipped-start")).toBe(true); expect(old.title).toContain("切り取り");
    expect(byClass(timeline, "vg-ai-target-label")[0].title).toContain("変更後のバーは非表示");
    timeline.empty();
    renderGhost(timeline as any, { ...ghost, before: { start: "2026-10-09", end: "2026-10-13" } }, "2026-10-01", 20, 10);
    const clippedEnd = byClass(timeline, "vg-ai-ghost")[0];
    expect(clippedEnd.style.left).toBe("160px"); expect(clippedEnd.style.width).toBe("40px");
    expect(clippedEnd.classList.contains("is-clipped-end")).toBe(true);
  });
  it.each(["before", "after"])("annotates wholly out-of-range old periods on the %s side", (side) => {
    vi.stubGlobal("document", createFakeDocument()); const timeline = makeFakeEl("div"); timeline.style.width = "200px";
    const period = side === "before" ? { start: "2026-09-01", end: "2026-09-03" } : { start: "2026-11-01", end: "2026-11-03" };
    renderGhost(timeline as any, { ...ghost, before: period }, "2026-10-01", 20, 10);
    const old = byClass(timeline, "vg-ai-ghost")[0];
    expect(old.classList.contains("is-outside")).toBe(true); expect(old.textContent).toContain("前は範囲外");
    expect(old.style.left).toBe(side === "before" ? "0px" : "108px"); expect(old.title).toContain("表示範囲外");
  });
  it("uses a compact non-overlapping mark when the whole upper lane is occupied", () => {
    vi.stubGlobal("document", createFakeDocument()); const timeline = makeFakeEl("div"); timeline.style.width = "36px";
    const current = makeFakeEl("div"); timeline.appendChild(current);
    renderGhost(timeline as any, ghost, "2026-10-01", 20, 10, current as any);
    const label = byClass(timeline, "vg-ai-target-label")[0];
    expect(label.classList.contains("is-compact")).toBe(true); expect(label.textContent).toBe("↔");
    expect(label.title).toContain("2日後ろへ"); expect(label.title).toContain("変更後は一部範囲外");
    expect(Number.parseFloat(label.style.left)).toBeGreaterThanOrEqual(0);
    expect(byClass(timeline, "vg-ai-ghost")[0].textContent).toBe("");
  });
  it("adds ghosts on an unchanged incremental render and removes them on close/timeout", async () => {
    vi.useFakeTimers(); vi.stubGlobal("document", createFakeDocument()); vi.stubGlobal("window", makeFakeEl("window")); vi.stubGlobal("requestAnimationFrame", () => 0);
    const store = new ScheduleGhostStore();
    const child = { kind: "subtask", id: ghost.taskId, key: "child", file: { path: "tasks/p.md" }, title: "子タスク", displayName: "子タスク", statusLabel: "active", tags: [], plannedStartDate: ghost.after.start, plannedEndDate: ghost.after.end } as unknown as TaskRow;
    const parent = { kind: "parent", id: "tasks/p.md", file: { path: "tasks/p.md" }, title: "親", displayName: "親", tags: [], ganttEnabled: true, ganttOrder: 1, subtasks: new Map([["child", child]]) } as unknown as TaskRow;
    const host = { settings: { ...DEFAULT_SETTINGS, ganttFeatureWorkloadEnabled: false, ganttFeatureDailyTodoEnabled: false, ganttFeatureEventsEnabled: false }, manifest: { version: "test" }, logger: { debug: vi.fn() }, loadTasks: async () => [parent], activateView: vi.fn(), ghosts: store } as unknown as TaskGanttViewHost;
    const view = new TaskGanttView({} as any, host); await view.onOpen();
    const rowHeight = byClass(view.containerEl as any, "task-gantt-parent-timeline")[0].style.height;
    store.show(result);
    expect(byClass(view.containerEl as any, "task-gantt-parent-timeline")[0].style.height).toBe(rowHeight);
    expect(byClass(view.containerEl as any, "vg-ai-ghost")).toHaveLength(1);
    expect(byClass(view.containerEl as any, "vg-ai-legend")).toHaveLength(1);
    vi.advanceTimersByTime(60000); expect(byClass(view.containerEl as any, "vg-ai-ghost")).toHaveLength(0); expect(byClass(view.containerEl as any, "vg-ai-target")).toHaveLength(0);
    store.show(result); expect(byClass(view.containerEl as any, "vg-ai-ghost")).toHaveLength(1);
    await view.onClose(); expect(store.entries.size).toBe(0);
  });
  it("represents removed dates with an old ghost and explicit unset target", () => {
    vi.stubGlobal("document", createFakeDocument()); const timeline = makeFakeEl("div");
    renderGhost(timeline as any, { ...ghost, after: { start: "", end: "" } }, "2026-10-01", 20, 10);
    expect(byClass(timeline, "vg-ai-ghost")).toHaveLength(1); expect(byClass(timeline, "vg-ai-target-label")[0].textContent).toContain("未設定");
  });
});

describe("Gantt preview overlay from the preview port", () => {
  const PARENT = "tasks/p.md";
  const mapped = (value: unknown): any => JSON.parse(JSON.stringify(value).split(PARENT_ID).join(PARENT));
  const base = (): any => {
    vi.stubGlobal("document", createFakeDocument()); vi.stubGlobal("window", makeFakeEl("window")); vi.stubGlobal("requestAnimationFrame", () => 0);
    const child = { kind: "subtask", id: PARENT + "::review", key: "review", file: { path: PARENT }, title: "レビュー", displayName: "レビュー", statusLabel: "active", tags: [], plannedStartDate: "2026-10-13", plannedEndDate: "2026-10-15" } as unknown as TaskRow;
    const parent = { kind: "parent", id: PARENT, file: { path: PARENT }, title: "リリース", displayName: "リリース", tags: [], ganttEnabled: true, ganttOrder: 1, subtasks: new Map([["review", child]]) } as unknown as TaskRow;
    const moved = mapped({ ...OUTSIDE_RANGE_PREVIEW, previewId: "moved" });
    // Move by three days inside the range instead of two months away.
    for (const state of [moved.projection!.after]) { state.parents[0].children[0].period = { start: "2026-10-16", end: "2026-10-18" }; state.parents[0].period = { start: "2026-10-16", end: "2026-10-18" }; }
    (moved.entries[0].effects[0] as any).after = { start: "2026-10-16", end: "2026-10-18" };
    const port = new FakePreviewPort([moved as any]);
    const host = { settings: { ...DEFAULT_SETTINGS, ganttFeatureWorkloadEnabled: false, ganttFeatureDailyTodoEnabled: false, ganttFeatureEventsEnabled: false }, manifest: { version: "test" }, logger: { debug: vi.fn() }, loadTasks: async () => [parent], activateView: vi.fn(), previewPort: port } as unknown as TaskGanttViewHost;
    return { host, port };
  };
  it("projects the focused plan as a dashed proposal band plus a separate preview region, and leaves live rows alone", async () => {
    const { host, port } = base();
    const view = new TaskGanttView({} as any, host); await view.onOpen();
    const container = view.containerEl as any;
    const dockHost = byClass(container, "vg-pv-dockhost")[0] as any;
    expect(dockHost.hidden).toBe(true); expect(byClass(container, "vg-ai-ghost")).toHaveLength(0);
    const timeline = byClass(container, "task-gantt-parent-timeline")[0]; const rowHeight = timeline.style.height;
    const bar = byClass(container, "task-gantt-bar")[0]; const barStyle = { ...bar.style };
    port.focus("moved");
    expect(dockHost.hidden).toBe(false);
    expect(byClass(dockHost, "vg-pv-dock")).toHaveLength(1);
    const band = byClass(container, "vg-ai-ghost");
    expect(band).toHaveLength(1); expect(band[0].classList.contains("is-proposed")).toBe(true);
    expect(byClass(container, "vg-ai-legend")[0].textContent).toBe("変更案 · チャット · 実線: 現在 / 破線: 変更案（後）");
    expect(byClass(container, "task-gantt-parent-timeline")[0].style.height).toBe(rowHeight);
    expect(byClass(container, "task-gantt-bar")[0].style).toEqual(barStyle);
    port.focus(null);
    expect(dockHost.hidden).toBe(true); expect(byClass(container, "vg-ai-ghost")).toHaveLength(0); expect(byClass(container, "vg-ai-legend")).toHaveLength(0);
    expect(byClass(container, "vg-ai-target")).toHaveLength(0);
    await view.onClose();
  });
  it("drops the overlay when the view closes while the plan itself stays in the store", async () => {
    const { host, port } = base();
    const view = new TaskGanttView({} as any, host); await view.onOpen();
    port.focus("moved"); await view.onClose();
    expect(port.focused).toBeNull(); expect(port.previews.has("moved")).toBe(true); expect(port.rejected).toEqual([]);
  });
  it("shows a saved outcome as old dashed band + new bar and keeps the host's own ghost store working beside it", async () => {
    const { host, port } = base();
    const outcome = { previewId: "moved", status: "success", actions: [{ actionId: port.previews.get("moved")!.entries[0].actionId, state: "committed", actual: [] }], actualProjection: port.previews.get("moved")!.projection } as any;
    port.outcomes.set("moved", outcome);
    const view = new TaskGanttView({} as any, host); await view.onOpen();
    port.focus("moved");
    const band = byClass(view.containerEl as any, "vg-ai-ghost");
    expect(band).toHaveLength(1); expect(band[0].classList.contains("is-proposed")).toBe(false);
    expect(byClass(view.containerEl as any, "vg-ai-legend")[0].textContent).toContain("保存結果");
    await view.onClose();
  });
  it("marks a task that will be deleted without touching its live bar position", async () => {
    const { host, port } = base();
    const doomed = mapped({ ...DELETE_PREVIEW, previewId: "doomed" });
    port.set(doomed as any);
    const view = new TaskGanttView({} as any, host); await view.onOpen();
    const bar = byClass(view.containerEl as any, "task-gantt-bar")[0]; const style = { ...bar.style };
    port.focus("doomed");
    expect(byClass(view.containerEl as any, "task-gantt-bar")[0].classList.contains("vg-pv-delete-target")).toBe(true);
    expect(byClass(view.containerEl as any, "vg-pv-live-delete")).toHaveLength(1);
    expect(byClass(view.containerEl as any, "task-gantt-bar")[0].style).toEqual(style);
    port.focus(null); expect(byClass(view.containerEl as any, "vg-pv-delete-target")).toHaveLength(0);
    await view.onClose();
  });
});
