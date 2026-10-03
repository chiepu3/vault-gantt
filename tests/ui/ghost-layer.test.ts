/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderGhost } from "../../src/ui/ghost-layer";
import { TaskGanttView, type TaskGanttViewHost } from "../../src/ui/task-gantt-view";
import { ScheduleGhostStore } from "../../src/app/schedule-ghost";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { createFakeDocument, byClass, makeFakeEl } from "../stubs/fake-dom";
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
