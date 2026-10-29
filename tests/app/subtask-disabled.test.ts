import { describe, expect, it, vi } from "vitest";
import { OperationRegistry, patchSchema } from "../../src/app/operation-registry";
import { taskPatchInputSchema } from "../../src/contracts/operations";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { createTask, addSubtask } from "../../src/app/task-operations";
import { HistoryManager } from "../../src/app/history-manager";
import { aggregates, progress, ganttState, taskPublicState } from "../../src/app/preview-projector";
import { compactTask } from "../../src/app/context-index";
import { collectWorkloadEntriesForDate } from "../../src/app/gantt-layout";
import { pickWorkbenchPreviewSubtask } from "../../src/app/workbench-display";
import { FakeVault } from "./fake-vault";
import type { TaskRow } from "../../src/core/types";

const DAY = "2026-10-13";
const sub = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: "subtask", key, id: key, displayName: key, title: key, completed: false, statusLabel: "active", tags: [], priority: 0, priorityMode: "auto",
  file: { path: `${key}.md` }, workloadPlan: { [DAY]: 2 }, workloadActual: { [DAY]: 1 }, ...extra,
}) as unknown as TaskRow;
const parentOf = (...children: TaskRow[]) => ({ kind: "parent", id: "p", displayName: "P", title: "P", ganttEnabled: true, completed: false, statusLabel: "active", tags: [], subtasks: new Map(children.map((c) => [c.id, c])) }) as unknown as TaskRow;

describe("registry.updateFromUI with disabled", () => {
  it("disables then re-enables a subtask through both schemas, leaving status/completed alone", async () => {
    expect(Object.keys(patchSchema.shape)).toContain("disabled");
    expect(Object.keys(taskPatchInputSchema.shape)).toContain("disabled");
    const vault = new FakeVault();
    const settings = { ...DEFAULT_SETTINGS };
    const registry = new OperationRegistry({ settings, historyManager: new HistoryManager(), invalidate: vi.fn() }, () => vault);
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "作業");
    const read = async () => vault.read(vault.getFileByPath(child.file.path)!);

    await registry.updateFromUI([{ row: child, patch: { disabled: true } }]);
    const saved = await read();
    expect(saved).toMatch(/^disabled: true$/m);
    expect(saved).toMatch(/^status: active$/m);
    expect(saved).toMatch(/^completed: false$/m);

    await registry.updateFromUI([{ row: child, patch: { disabled: false } }]);
    expect(await read()).not.toMatch(/disabled/);

    // the AI-facing plan accepts the same field
    const plan = await registry.plan("update", { taskId: child.id, patch: { disabled: true } });
    expect(plan.diffs[0].fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: "disabled", after: true })]));
  });

  it("rejects disabled on a parent", async () => {
    const vault = new FakeVault();
    const settings = { ...DEFAULT_SETTINGS };
    const registry = new OperationRegistry({ settings, historyManager: new HistoryManager(), invalidate: vi.fn() }, () => vault);
    const parent = await createTask(vault, settings, "親");
    await expect(registry.updateFromUI([{ row: parent, patch: { disabled: true } }])).rejects.toThrow("not writable for parent");
  });
});

describe("disabled subtasks are excluded from aggregates", () => {
  it("aggregates skip disabled children for plan and actual", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.weeklyWorkSchedules = [];
    const days = aggregates([parentOf(sub("a"), sub("b", { disabled: true }))], settings, [DAY], DAY);
    expect(days[0]).toMatchObject({ plan: 2, actual: 1 });
  });
  it("progress ignores disabled children in numerator and denominator", () => {
    expect(progress(parentOf(sub("a", { completed: true }), sub("b"), sub("c", { disabled: true, completed: true })))).toBe(0.5);
    expect(progress(parentOf(sub("a", { disabled: true })))).toBe(0);
  });
  it("collectWorkloadEntriesForDate skips disabled", () => {
    const parent = parentOf(sub("a"), sub("b", { disabled: true }));
    expect(collectWorkloadEntriesForDate(DAY, [parent], "plan").map((e) => e.subtaskName)).toEqual(["a"]);
    expect(collectWorkloadEntriesForDate(DAY, [parent], "actual").map((e) => e.subtaskName)).toEqual(["a"]);
  });
  it("the workbench never previews a disabled child", () => {
    const off = sub("off", { disabled: true, dueDate: "2026-01-01", createdAt: "2026-01-01" });
    const on = sub("on", { dueDate: "2026-12-31", createdAt: "2026-01-01" });
    expect(pickWorkbenchPreviewSubtask([off, on])).toBe(on);
    expect(pickWorkbenchPreviewSubtask([off])).toBeNull();
  });
  it("context compactTask: a parent total skips disabled children, a subtask keeps raw hours and carries the flag", () => {
    const off = sub("b", { disabled: true });
    const parent = parentOf(sub("a"), off);
    const snap = { revisions: new Map([["p", "r"], ["a.md", "r"], ["b.md", "r"]]), settings: DEFAULT_SETTINGS } as never;
    (parent as { file: unknown }).file = { path: "p" };
    const parentOut = compactTask(parent, snap, ["workload"]) as unknown as { hoursTotal: { plan: number; actual: number } };
    expect(parentOut.hoursTotal).toMatchObject({ plan: 2, actual: 1 });
    const childOut = compactTask(off, snap, ["status", "workload"]) as unknown as { disabled: boolean; hoursTotal: { plan: number } };
    expect(childOut.disabled).toBe(true);
    expect(childOut.hoursTotal.plan).toBe(2);
    expect(compactTask(sub("a"), snap, ["status"])).toMatchObject({ disabled: false });
  });
  it("taskPublicState reports disabled as a boolean", () => {
    expect(taskPublicState(sub("a")).disabled).toBe(false);
    expect(taskPublicState(sub("a", { disabled: true })).disabled).toBe(true);
  });
  it("ganttState children expose disabled", () => {
    const state = ganttState([parentOf(sub("a", { disabled: true }))], structuredClone(DEFAULT_SETTINGS), [DAY], DAY);
    expect(state.parents[0].children[0].disabled).toBe(true);
  });
});
