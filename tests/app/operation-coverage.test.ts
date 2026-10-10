import type { Vault } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationRegistry, OPERATION_MANIFEST, patchSchema, type OperationName } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { addSubtask, createTask } from "../../src/app/task-operations";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskPatch } from "../../src/core/types";
import { todayStr } from "../../src/core/utils";
import { FakeVault } from "./fake-vault";

async function setup() {
  const vault = new FakeVault();
  const settings = { ...DEFAULT_SETTINGS, autoPriorityEnabled: false };
  const history = new HistoryManager();
  const invalidate = vi.fn();
  const registry = new OperationRegistry({ settings, historyManager: history, invalidate }, () => vault);
  const parent = await createTask(vault, settings, "Synthetic parent");
  const child = await addSubtask(vault, settings, parent, "Synthetic child");
  const sibling = await addSubtask(vault, settings, parent, "Synthetic sibling");
  const historyVault = {
    getFileByPath: vault.getFileByPath.bind(vault),
    read: vault.read.bind(vault),
    process: async (file: { path: string }, fn: (content: string) => string) => {
      const content = fn(await vault.read(file));
      await vault.modify(file, content);
      return content;
    },
  } as unknown as Vault;
  const update = async (taskId: string, patch: TaskPatch) => {
    const plan = await registry.plan("update", { taskId, patch });
    return registry.commit(plan.previewId);
  };
  vault.resetCounters();
  return { vault, settings, history, invalidate, registry, parent, child, sibling, historyVault, update };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const initialDates = { plannedStartDate: "2026-10-10", plannedEndDate: "2026-10-20", dueDate: "2026-10-25" };
const dateCases: [string, TaskPatch][] = [
  ["start-only extension", { plannedStartDate: "2026-10-08" }],
  ["start-only shrink", { plannedStartDate: "2026-10-12" }],
  ["end-only extension", { plannedEndDate: "2026-10-22" }],
  ["end-only shrink", { plannedEndDate: "2026-10-18" }],
  ["forward shift", { plannedStartDate: "2026-10-15", plannedEndDate: "2026-10-25" }],
  ["backward shift", { plannedStartDate: "2026-10-05", plannedEndDate: "2026-10-15" }],
  ["extend both ends", { plannedStartDate: "2026-10-08", plannedEndDate: "2026-10-22" }],
  ["shrink both ends", { plannedStartDate: "2026-10-12", plannedEndDate: "2026-10-18" }],
  ["overlap sibling", { plannedStartDate: "2026-10-18", plannedEndDate: "2026-10-23" }],
  ["outside original range", { plannedStartDate: "2027-01-01", plannedEndDate: "2027-01-04" }],
  ["single day", { plannedStartDate: "2026-10-15", plannedEndDate: "2026-10-15" }],
  ["clear start only", { plannedStartDate: "" }],
  ["clear end only", { plannedEndDate: "" }],
  ["clear all dates", { plannedStartDate: "", plannedEndDate: "", dueDate: "" }],
  ["due date only", { dueDate: "2026-10-30" }],
];

describe("synthetic public operation feature coverage", () => {
  it("keeps the six-operation inventory and read operations write-free", async () => {
    const a = await setup();
    expect(Object.keys(OPERATION_MANIFEST)).toEqual(["search", "get", "create", "update", "schedule-batch", "update-batch"]);
    expect(Object.entries(OPERATION_MANIFEST).filter(([, entry]) => !entry.mutation).map(([name]) => name)).toEqual(["search", "get"]);
    expect(await a.registry.invoke("search", { query: "SYNTHETIC CHILD" })).toEqual([expect.objectContaining({ id: a.child.id })]);
    expect(await a.registry.invoke("search", {})).toHaveLength(3);
    expect(await a.registry.invoke("get", { taskId: a.parent.id })).toMatchObject({ id: a.parent.id, path: a.parent.file.path });
    await expect(a.registry.invoke("get", { taskId: "missing" })).rejects.toThrow("Task not found");
    expect(a.vault.getCreateCallCount()).toBe(0);
    expect(a.vault.getModifyCallCount()).toBe(0);
    expect(a.history.canUndo()).toBe(false);
  });

  it.each(dateCases)("previews and persists %s without changing the sibling", async (_name, patch) => {
    const a = await setup();
    await a.update(a.child.id, initialDates);
    await a.update(a.sibling.id, { plannedStartDate: "2026-10-17", plannedEndDate: "2026-10-21" });
    const before = a.vault.getFileContent(a.parent.id);
    const sibling = await a.registry.get(a.sibling.id);
    a.vault.resetCounters();
    const plan = await a.registry.plan("schedule-batch", { changes: [{ taskId: a.child.id, patch }] });
    const expected = { ...initialDates, ...patch };
    expect(plan.diffs[0].schedule).toEqual({
      before: { start: initialDates.plannedStartDate, end: initialDates.plannedEndDate },
      after: { start: expected.plannedStartDate, end: expected.plannedEndDate },
    });
    for (const [field, after] of Object.entries(patch)) {
      expect(plan.diffs[0].fields).toContainEqual({ field, before: initialDates[field as keyof typeof initialDates], after });
    }
    expect(a.vault.getFileContent(a.parent.id)).toBe(before);
    expect(a.vault.getModifyCallCount()).toBe(0);
    const result = await a.registry.commit(plan.previewId);
    expect(result).toMatchObject({ kind: "success", committed: 1, total: 1, diffs: plan.diffs });
    expect(await a.registry.get(a.child.id)).toMatchObject(Object.fromEntries(Object.entries(expected).map(([field, value]) => [field, value || undefined])));
    expect(await a.registry.get(a.sibling.id)).toEqual(sibling);
    expect(a.vault.getModifyCallCount()).toBe(1);
  });

  it.each([
    { plannedStartDate: "2026-10-21" },
    { plannedEndDate: "2026-10-09" },
    { plannedStartDate: "2026-10-22", plannedEndDate: "2026-10-08" },
    { plannedStartDate: "2026-02-30" },
    { dueDate: "2026-13-01" },
  ])("rejects invalid or inverted date patch %j without writing", async (patch) => {
    const a = await setup(); await a.update(a.child.id, initialDates);
    const before = a.vault.getFileContent(a.parent.id); a.vault.resetCounters();
    await expect(a.registry.plan("update", { taskId: a.child.id, patch })).rejects.toThrow();
    expect(a.vault.getFileContent(a.parent.id)).toBe(before);
    expect(a.vault.getModifyCallCount()).toBe(0);
  });
});

const markerA = { key: "review", title: "Review", date: "2026-10-12", tags: ["review"] };
const markerB = { key: "release", title: "Release", date: "2026-10-20", tags: [] };

describe("marker full-array replacement", () => {
  it.each([
    ["add", [markerA, markerB, { key: "signoff", title: "Sign off", date: "2026-10-18", tags: [] }]],
    ["move", [{ ...markerA, date: "2026-10-15" }, markerB]],
    ["rename", [{ ...markerA, title: "Peer review" }, markerB]],
    ["delete one", [markerB]],
    ["clear all", []],
    ["replace rather than merge", [{ ...markerA, title: "Only retained marker" }]],
  ] as const)("%s on a subtask", async (_name, markers) => {
    const a = await setup(); await a.update(a.child.id, { ganttMarkers: [markerA, markerB] });
    const replacement = markers.map(marker => ({ ...marker, tags: [...marker.tags] }));
    const before = a.vault.getFileContent(a.parent.id);
    const plan = await a.registry.plan("update", { taskId: a.child.id, patch: { ganttMarkers: replacement } });
    const persistedMarkers = (items: typeof replacement) => items.map(marker => ({ ...marker, tags: marker.tags.length ? marker.tags : undefined }));
    expect(plan.diffs[0].fields).toContainEqual({ field: "ganttMarkers", before: persistedMarkers([markerA, markerB]), after: replacement.length ? persistedMarkers(replacement) : "" });
    expect(a.vault.getFileContent(a.parent.id)).toBe(before);
    expect((await a.registry.commit(plan.previewId)).kind).toBe("success");
    expect((await a.registry.get(a.child.id)).ganttMarkers).toEqual(replacement.length ? persistedMarkers(replacement) : undefined);
    expect((await a.registry.get(a.sibling.id)).ganttMarkers ?? []).toEqual([]);
  });

  it.each([
    [markerA, markerA],
    [{ ...markerA, key: "" }],
    [{ ...markerA, date: "2026-02-30" }],
    [{ ...markerA, key: "bad:key" }],
  ])("rejects invalid markers %j", async (...markers) => {
    const a = await setup();
    await expect(a.registry.plan("update", { taskId: a.child.id, patch: { ganttMarkers: markers } })).rejects.toThrow();
    expect(a.vault.getModifyCallCount()).toBe(0);
  });
});

const fieldCases: [string, TaskPatch, Record<string, unknown>][] = [
  ["displayName sync", { displayName: "Renamed" }, { displayName: "Renamed", title: "Renamed" }],
  ["title sync", { title: "New title" }, { displayName: "New title", title: "New title" }],
  ["manual priority", { priority: 4, priorityMode: "manual" }, { priority: 4, priorityMode: "manual" }],
  ["auto priority mode", { priorityMode: "auto" }, { priorityMode: "auto" }],
  ["tags", { tags: ["alpha", "beta"] }, { tags: ["alpha", "beta"] }],
  ["current status", { currentStatus: "Awaiting synthetic review" }, { currentStatus: "Awaiting synthetic review" }],
  ["notes", { notes: "Synthetic memo\nSecond line" }, { notes: "Synthetic memo\nSecond line" }],
  ["created date", { createdAt: "2026-01-02" }, { createdAt: "2026-01-02" }],
  ["updated date is stamped today", { updatedAt: "2026-01-03" }, { updatedAt: "2026-10-04" }],
  ["due date", { dueDate: "2026-11-01" }, { dueDate: "2026-11-01" }],
];

describe("patch categories and parent/subtask boundaries", () => {
  it.each((["parent", "subtask"] as const).flatMap(kind => fieldCases.map(([name, patch, expected]) => ({ kind, name, patch, expected }))))("round-trips $name on $kind", async ({ kind, patch, expected }) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const a = await setup(); const taskId = kind === "parent" ? a.parent.id : a.child.id;
    const before = a.vault.getFileContent(a.parent.id);
    const previous = await a.registry.get(taskId);
    const plan = await a.registry.plan("update", { taskId, patch });
    for (const [field, after] of Object.entries(expected)) {
      const oldValue = previous[field as keyof typeof previous];
      if (oldValue !== after && field !== "updatedAt") expect(plan.diffs[0].fields).toContainEqual({ field, before: oldValue ?? "", after });
    }
    expect(a.vault.getFileContent(a.parent.id)).toBe(before);
    expect((await a.registry.commit(plan.previewId)).kind).toBe("success");
    expect(await a.registry.get(taskId)).toMatchObject(expected);
    expect(todayStr()).toBe("2026-10-04");
  });

  it.each(["parent", "subtask"] as const)("clears shared optional fields on %s", async (kind) => {
    const a = await setup(); const taskId = kind === "parent" ? a.parent.id : a.child.id;
    await a.update(taskId, { tags: ["synthetic"], notes: "Memo", currentStatus: "Review", dueDate: "2026-10-10" });
    await a.update(taskId, { tags: [], notes: "", currentStatus: "", dueDate: "" });
    expect(await a.registry.get(taskId)).toMatchObject({ tags: [], notes: "", currentStatus: "", dueDate: undefined });
  });

  it.each(["parent", "subtask"] as const)("previews coupled status/completed changes on %s", async (kind) => {
    const a = await setup(); const taskId = kind === "parent" ? a.parent.id : a.child.id;
    const cases: [TaskPatch, string, boolean][] = [
      [{ completed: true }, "done", true],
      [{ completed: false }, "active", false],
      [{ statusLabel: "done", completed: false }, "done", true],
      [{ statusLabel: "in_progress" }, "in_progress", false],
      [{ statusLabel: "waiting" }, "waiting", false],
      [{ statusLabel: "hold" }, "hold", false],
      [{ statusLabel: "active" }, "active", false],
    ];
    for (const [patch, statusLabel, completed] of cases) {
      const previous = await a.registry.get(taskId);
      const plan = await a.registry.plan("update", { taskId, patch });
      for (const [field, after] of Object.entries({ statusLabel, completed })) {
        const before = previous[field as "statusLabel" | "completed"];
        if (before !== after) expect(plan.diffs[0].fields).toContainEqual({ field, before, after });
      }
      expect((await a.registry.commit(plan.previewId)).kind).toBe("success");
      expect(await a.registry.get(taskId)).toMatchObject({ statusLabel, completed });
    }
  });

  it.each(["workloadPlan", "workloadActual"] as const)("normalizes and replaces subtask %s", async (field) => {
    const a = await setup();
    await a.update(a.child.id, { [field]: { "2026-10-10": 2, "2026-10-11": 3 } });
    const plan = await a.registry.plan("update", { taskId: a.child.id, patch: { [field]: { "2026-10-12": 1.3, "2026-10-13": 0 } } });
    expect(plan.diffs[0].fields).toContainEqual({ field, before: { "2026-10-10": 2, "2026-10-11": 3 }, after: { "2026-10-12": 1.5 } });
    expect((await a.registry.commit(plan.previewId)).kind).toBe("success");
    expect((await a.registry.get(a.child.id))[field]).toEqual({ "2026-10-12": 1.5 });
    await a.update(a.child.id, { [field]: {} });
    expect((await a.registry.get(a.child.id))[field]).toBeUndefined();
  });

  it.each([
    ["plannedStartDate", "2026-10-01"], ["plannedEndDate", "2026-10-02"],
    ["workloadPlan", { "2026-10-01": 1 }], ["workloadActual", { "2026-10-01": 1 }],
    ["ganttMarkers", [markerA]],
  ])("rejects parent-only boundary violation for %s", async (field, value) => {
    const a = await setup();
    await expect(a.registry.plan("update", { taskId: a.parent.id, patch: { [field]: value } })).rejects.toThrow(`field is not writable for parent: ${field}`);
    expect(a.vault.getModifyCallCount()).toBe(0);
  });

  it.each(["ganttEnabled", "ganttOrder"])("allows parent %s and rejects it on a subtask", async (field) => {
    const a = await setup(); const patch = field === "ganttEnabled" ? { ganttEnabled: false } : { ganttOrder: 42 };
    expect((await a.update(a.parent.id, patch)).kind).toBe("success");
    expect(await a.registry.get(a.parent.id)).toMatchObject(patch);
    a.vault.resetCounters();
    await expect(a.registry.plan("update", { taskId: a.child.id, patch })).rejects.toThrow(`field is not writable for subtask: ${field}`);
    expect(a.vault.getModifyCallCount()).toBe(0);
  });

  it.each(["delete", "dependencies", "marker", "add-marker", "move-marker"])("rejects unsupported operation %s", async (name) => {
    const a = await setup();
    expect(Object.keys(OPERATION_MANIFEST)).not.toContain(name);
    await expect(a.registry.invoke(name as OperationName, { taskId: a.child.id })).rejects.toThrow();
    expect(a.vault.getModifyCallCount()).toBe(0); expect(a.vault.getCreateCallCount()).toBe(0);
  });

  it.each([{ dependencies: ["other"] }, { deleted: true }, { marker: markerA }, { workloadPlan: { "2026-10-01": 25 } }, { workloadActual: { "2026-02-30": 2 } }])("rejects unsupported or invalid patch %j", async (patch) => {
    const a = await setup();
    expect(patchSchema.safeParse(patch).success).toBe(false);
    await expect(a.registry.plan("update", { taskId: a.child.id, patch })).rejects.toThrow();
    expect(a.vault.getModifyCallCount()).toBe(0);
  });
});

describe("batch limits and history outcomes", () => {
  it.each(["schedule-batch", "update-batch"] as const)("%s accepts exactly 100 changes and writes once per file", async (operation) => {
    const a = await setup();
    const children = [a.child, a.sibling];
    for (let i = 2; i < 100; i++) children.push(await addSubtask(a.vault, a.settings, a.parent, `Synthetic child ${i}`));
    const patch = operation === "schedule-batch" ? { plannedStartDate: "2026-10-01", plannedEndDate: "2026-10-02" } : { notes: "Batch memo", priority: 3 };
    a.vault.resetCounters();
    const plan = await a.registry.plan(operation, { changes: children.map(row => ({ taskId: row.id, patch })) });
    expect(plan.count).toBe(100); expect(a.vault.getModifyCallCount()).toBe(0);
    const result = await a.registry.commit(plan.previewId);
    expect(result).toMatchObject({ kind: "success", committed: 100, total: 100 });
    expect(result.diffs).toHaveLength(100); expect(a.vault.getModifyCallCount()).toBe(1);
    for (const row of children) expect(await a.registry.get(row.id)).toMatchObject(patch);
  });

  it.each(["schedule-batch", "update-batch"] as const)("%s rejects empty, oversized and duplicate batches", async (operation) => {
    const a = await setup(); const change = { taskId: a.child.id, patch: { dueDate: "2026-10-10" } };
    for (const changes of [[], Array.from({ length: 101 }, () => change), [change, change]]) {
      await expect(a.registry.plan(operation, { changes })).rejects.toThrow();
    }
    expect(a.vault.getModifyCallCount()).toBe(0);
    if (operation === "schedule-batch") await expect(a.registry.plan(operation, { changes: [{ ...change, patch: { notes: "Not dates" } }] })).rejects.toThrow();
  });

  it("preflights the entire mixed-file batch before writing", async () => {
    const a = await setup(); const other = await createTask(a.vault, a.settings, "Synthetic other");
    const plan = await a.registry.plan("update-batch", { changes: [a.child, other].map(row => ({ taskId: row.id, patch: { notes: "new" } })) });
    const file = a.vault.getFileByPath(other.id)!;
    await a.vault.modify(file, (await a.vault.read(file)) + "\nExternal synthetic edit");
    a.vault.resetCounters();
    const result = await a.registry.commit(plan.previewId);
    expect(result).toMatchObject({ kind: "stale", committed: 0, diffs: [] });
    expect(result.undoLabel).toBeUndefined(); expect(a.history.canUndo()).toBe(false);
    expect(a.vault.getModifyCallCount()).toBe(0); expect(a.invalidate).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "stale"] as const)("%s before the first write records no undo", async (kind) => {
    const a = await setup();
    const plan = await a.registry.plan("update", { taskId: a.child.id, patch: { notes: "new" } });
    const controller = new AbortController();
    if (kind === "cancelled") controller.abort();
    if (kind === "failed") vi.spyOn(a.vault, "modify").mockRejectedValue(new Error("Synthetic failure"));
    if (kind === "stale") { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60 * 1000); }
    const result = await a.registry.commit(plan.previewId, controller.signal);
    expect(result).toMatchObject({ kind, committed: 0, diffs: [] });
    expect(result.undoLabel).toBeUndefined(); expect(a.history.canUndo()).toBe(false);
    expect(a.vault.getModifyCallCount()).toBe(0);
    await expect(a.registry.commit(plan.previewId)).rejects.toThrow("already confirmed");
  });

  it.each(["partial", "cancelled"] as const)("%s after a file write retains only committed diffs and real undo history", async (kind) => {
    const a = await setup(); const other = await createTask(a.vault, a.settings, "Synthetic other");
    const before = a.vault.getFileContent(a.parent.id);
    const plan = await a.registry.plan("update-batch", { changes: [a.child, other].map(row => ({ taskId: row.id, patch: { notes: "new" } })) });
    const controller = new AbortController(); const modify = a.vault.modify.bind(a.vault);
    vi.spyOn(a.vault, "modify").mockImplementation(async (file, content) => {
      if (file.path === other.id) throw new Error("Synthetic failure");
      await modify(file, content);
      if (kind === "cancelled") controller.abort();
    });
    const result = await a.registry.commit(plan.previewId, controller.signal);
    expect(result).toMatchObject({ kind, committed: 1, total: 2 });
    expect(result.diffs.map(diff => diff.taskId)).toEqual([a.child.id]);
    expect(result.undoLabel).toBe(a.history.peekUndoLabel()); expect(result.undoLabel).toBeTruthy();
    expect((await a.registry.get(other.id)).notes).toBe(""); expect(a.invalidate).toHaveBeenCalledOnce();
    expect((await a.history.undo(a.historyVault)).kind).toBe("success");
    expect(a.vault.getFileContent(a.parent.id)).toBe(before);
    expect((await a.history.redo(a.historyVault)).kind).toBe("success");
    expect((await a.registry.get(a.child.id)).notes).toBe("new");
  });

  it("normal updates support exact undo/redo and a new update clears redo", async () => {
    const a = await setup(); const before = a.vault.getFileContent(a.parent.id);
    const result = await a.update(a.child.id, { notes: "new", ganttMarkers: [markerA], ...initialDates });
    const after = a.vault.getFileContent(a.parent.id);
    expect(result.undoLabel).toBe(a.history.peekUndoLabel()); expect(a.history.canRedo()).toBe(false);
    expect((await a.history.undo(a.historyVault)).kind).toBe("success");
    expect(a.vault.getFileContent(a.parent.id)).toBe(before); expect(a.history.canRedo()).toBe(true);
    expect((await a.history.redo(a.historyVault)).kind).toBe("success");
    expect(a.vault.getFileContent(a.parent.id)).toBe(after);
    await a.history.undo(a.historyVault);
    await a.update(a.child.id, { notes: "different timeline" });
    expect(a.history.canUndo()).toBe(true); expect(a.history.canRedo()).toBe(false);
    expect((await a.history.redo(a.historyVault)).kind).toBe("empty");
  });

  it.each(["undo", "redo"] as const)("parent create preserves undo and discards redo with existing %s history", async (direction) => {
    const a = await setup(); await a.update(a.child.id, { notes: "existing history" });
    if (direction === "redo") await a.history.undo(a.historyVault);
    const plan = await a.registry.plan("create", { name: "Synthetic new parent" });
    expect(a.history.canUndo() || a.history.canRedo()).toBe(true);
    const result = await a.registry.commit(plan.previewId);
    expect(result).toMatchObject({ kind: "success", committed: 1, created: { kind: "parent", displayName: "Synthetic new parent" } });
    expect(result.undoLabel).toBeUndefined();
    expect(a.history.canUndo()).toBe(direction === "undo");
    expect(a.history.canRedo()).toBe(false);
    if (direction === "undo") {
      expect((await a.history.undo(a.historyVault)).kind).toBe("success");
      expect((await a.registry.get(a.child.id)).notes).toBe("");
      expect(a.vault.getFileByPath(result.created!.id)).not.toBeNull();
    }
  });

  it("subtask create through parent-file modify is undoable, not a clear barrier", async () => {
    const a = await setup(); const earlier = await a.update(a.child.id, { notes: "prior update" });
    const before = a.vault.getFileContent(a.parent.id);
    const plan = await a.registry.plan("create", { parentTaskId: a.parent.id, name: "Synthetic new child" });
    expect(a.vault.getFileContent(a.parent.id)).toBe(before);
    const result = await a.registry.commit(plan.previewId);
    expect(result).toMatchObject({ kind: "success", committed: 1, created: { kind: "subtask", displayName: "Synthetic new child" } });
    expect(result.undoLabel).toBe(a.history.peekUndoLabel()); expect(result.undoLabel).toBeTruthy();
    const after = a.vault.getFileContent(a.parent.id);
    expect((await a.history.undo(a.historyVault)).kind).toBe("success");
    expect(a.vault.getFileContent(a.parent.id)).toBe(before); expect(a.history.peekUndoLabel()).toBe(earlier.undoLabel);
    expect((await a.history.redo(a.historyVault)).kind).toBe("success");
    expect(a.vault.getFileContent(a.parent.id)).toBe(after);
    await expect(a.registry.plan("create", { parentTaskId: a.child.id, name: "Nested" })).rejects.toThrow("Not a parent");
  });
});
