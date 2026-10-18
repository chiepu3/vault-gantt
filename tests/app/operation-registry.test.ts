import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { OperationRegistry, OPERATION_MANIFEST, patchSchema } from "../../src/app/operation-registry";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { createTask, addSubtask } from "../../src/app/task-operations";
import { HistoryManager } from "../../src/app/history-manager";
import { FakeVault } from "./fake-vault";
import { ToolAdapter } from "../../src/agent-tools/tool-adapter";
import { Logger } from "../../src/core/logger";
import type { App } from "obsidian";

function setup() {
  const vault = new FakeVault();
  const settings = { ...DEFAULT_SETTINGS, agentToolsEnabled: true };
  const historyManager = new HistoryManager();
  const invalidate = vi.fn();
  const registry = new OperationRegistry({ settings, historyManager, invalidate }, () => vault);
  return { vault, settings, historyManager, invalidate, registry };
}
describe("OperationRegistry contract", () => {
  it("manifest has explicit schemas and descriptions for every UI/AI operation", () => {
    expect(Object.keys(OPERATION_MANIFEST)).toEqual(["search", "get", "create", "update", "schedule-batch", "update-batch"]);
    for (const entry of Object.values(OPERATION_MANIFEST)) {
      expect(entry.description.length).toBeGreaterThan(10);
      expect(z.toJSONSchema(entry.schema).type).toBe("object");
    }
    expect(patchSchema.safeParse({ unsafe: true }).success).toBe(false);
    expect(patchSchema.safeParse({ plannedStartDate: "2026-02-30" }).success).toBe(false);
    expect(patchSchema.safeParse({ priority: 6 }).success).toBe(false);
  });
  it("UI and API use identical changes, history and invalidation", async () => {
    const a = setup();
    const row = await createTask(a.vault, a.settings, "Example");
    const adapter = new ToolAdapter({ settings: a.settings, taskCache: new Map(), logger: new Logger({} as App), operations: a.registry }, () => a.vault);
    await a.registry.updateFromUI([{ row, patch: { notes: "UI" } }]);
    const plan = await adapter.previewUpdateTask(row.id, { notes: "API" });
    expect(a.invalidate).toHaveBeenCalledTimes(1);
    await adapter.confirmChange(plan.previewId);
    expect(a.invalidate).toHaveBeenCalledTimes(2);
    expect(a.historyManager.canUndo()).toBe(true);
    const undo = await a.historyManager.undo({
      getFileByPath: (path: string) => a.vault.getFileByPath(path),
      read: a.vault.read.bind(a.vault),
      process: async (file: { path: string }, fn: (content: string) => string) => {
        const content = fn(await a.vault.read(file));
        await a.vault.modify(file, content);
        return content;
      },
    } as never);
    expect(undo.kind).toBe("success");
    expect((await a.registry.get(row.id)).notes).toBe("UI");
  });
  it("refuses text the note format cannot hold instead of losing it", async () => {
    const a = setup();
    const parent = await createTask(a.vault, a.settings, "親タスク");
    const child = await addSubtask(a.vault, a.settings, parent, "作業");
    const original = await a.vault.read(a.vault.getFileByPath(child.file.path)!);
    a.vault.resetCounters();
    await expect(a.registry.updateFromUI([{ row: child, patch: { currentStatus: "本文\n## 別の見出し\n内容" } }]))
      .rejects.toThrow("安全に保存できません");
    expect(await a.vault.read(a.vault.getFileByPath(child.file.path)!)).toBe(original);
    expect(a.vault.getModifyCallCount()).toBe(0);
    expect(a.historyManager.canUndo()).toBe(false);
  });
  it("legacy previews and writes preserve custom note content", async () => {
    const a = setup();
    const parent = await createTask(a.vault, a.settings, "Parent");
    const child = await addSubtask(a.vault, a.settings, parent, "Child");
    const file = a.vault.getFileByPath(child.file.path)!;
    await a.vault.modify(file, (await a.vault.read(file)).replace("type: subtask", "type: subtask\ncustom: keep") + "\n## 参考資料\n保持する本文\n");
    const plan = await a.registry.plan("update", { taskId: child.id, patch: { displayName: "変更" } });
    expect(plan.diffs[0].fields).toContainEqual({ field: "displayName", before: "Child", after: "変更" });
    expect((await a.registry.commit(plan.previewId)).kind).toBe("success");
    expect((await a.registry.get(child.id)).displayName).toBe("変更");
    const saved = a.vault.getFileContentById(child.id)!;
    expect(saved).toContain("custom: keep");
    expect(saved).toContain("## 参考資料\n保持する本文\n");
    expect(a.vault.getFileById(child.id)!.path.endsWith("/変更.md")).toBe(true);
  });
  it("content revisions reject same-stat external changes without writing", async () => {
    const a = setup();
    const row = await createTask(a.vault, a.settings, "Example");
    const plan = await a.registry.plan("update", { taskId: row.id, patch: { notes: "new" } });
    const file = a.vault.getFileByPath(row.file.path)!;
    const stat = { ...file.stat! };
    await a.vault.modify(file, (await a.vault.read(file)).replace("Example", "Changed"));
    Object.assign(a.vault.getFileByPath(row.file.path)!.stat!, stat);
    a.vault.resetCounters();
    expect((await a.registry.commit(plan.previewId)).kind).toBe("stale");
    expect(a.vault.getModifyCallCount()).toBe(0);
    expect(a.invalidate).not.toHaveBeenCalled();
  });
  it("duplicate commits cannot race and returned previews cannot modify stored plans", async () => {
    const a = setup();
    const row = await createTask(a.vault, a.settings, "Example");
    const plan = await a.registry.plan("update", { taskId: row.id, patch: { notes: "new" } });
    plan.diffs[0].fields[0].after = "tampered";
    const first = a.registry.commit(plan.previewId);
    await expect(a.registry.commit(plan.previewId)).rejects.toThrow("already confirmed");
    expect((await first).diffs[0].fields[0].after).toBe("new");
    expect((await a.registry.get(row.id)).notes).toBe("new");
  });
  it("a batch over several subtasks writes each subtask note and leaves the parent note alone", async () => {
    const a = setup();
    const parent = await createTask(a.vault, a.settings, "Parent");
    const first = await addSubtask(a.vault, a.settings, parent, "First");
    const second = await addSubtask(a.vault, a.settings, parent, "Second");
    const parentBefore = a.vault.getFileContent(parent.file.path);
    a.vault.resetCounters();
    const plan = await a.registry.plan("update-batch", { changes: [first, second].map((row) => ({ taskId: row.id, patch: { displayName: `Renamed ${row.displayName}` } })) });
    expect((await a.registry.commit(plan.previewId)).committed).toBe(2);
    expect(a.vault.getFileContent(parent.file.path)).toBe(parentBefore);
    expect(a.vault.getFileContentById(first.id)).toContain("title: Renamed First");
    expect(a.vault.getFileContentById(second.id)).toContain("title: Renamed Second");
  });
  it("batch writes each note once and records subtask-specific diffs", async () => {
    const a = setup();
    const parent = await createTask(a.vault, a.settings, "Parent");
    const child = await addSubtask(a.vault, a.settings, parent, "Child");
    const second = await addSubtask(a.vault, a.settings, parent, "Second child");
    const plan = await a.registry.plan("schedule-batch", { changes: [second, child].map((row) => ({ taskId: row.id, patch: { plannedStartDate: "2026-10-01", plannedEndDate: "2026-10-03" } })) });
    a.vault.resetCounters();
    const result = await a.registry.commit(plan.previewId);
    expect(result.committed).toBe(2);
    expect(a.vault.getModifyCallCount()).toBe(2);
    expect(result.diffs[1].taskId).toBe(child.id);
  });
  it("partial failure retains committed diffs and undo for completed files", async () => {
    const a = setup();
    const rows = await Promise.all(["First", "Second"].map((name) => createTask(a.vault, a.settings, name)));
    const plan = await a.registry.plan("update-batch", { changes: rows.map((row) => ({ taskId: row.id, patch: { notes: "new" } })) });
    const modify = a.vault.modify.bind(a.vault);
    vi.spyOn(a.vault, "modify").mockImplementation(async (file, content) => { if (file.path === rows[1].file.path) throw new Error("synthetic failure"); await modify(file, content); });
    const result = await a.registry.commit(plan.previewId);
    expect(result.kind).toBe("partial");
    expect(result.committed).toBe(1);
    expect(result.diffs).toHaveLength(1);
    expect(a.historyManager.canUndo()).toBe(true);
    expect(a.invalidate).toHaveBeenCalledOnce();
  });
  it("cancel stops future files only, with no rollback", async () => {
    const a = setup();
    const rows = await Promise.all(["First", "Second"].map((name) => createTask(a.vault, a.settings, name)));
    const plan = await a.registry.plan("update-batch", { changes: rows.map((row) => ({ taskId: row.id, patch: { notes: "new" } })) });
    const controller = new AbortController();
    const modify = a.vault.modify.bind(a.vault);
    vi.spyOn(a.vault, "modify").mockImplementation(async (file, content) => { await modify(file, content); controller.abort(); });
    const result = await a.registry.commit(plan.previewId, controller.signal);
    expect(result.kind).toBe("cancelled");
    expect(result.committed).toBe(1);
    expect((await a.registry.get(rows[0].id)).notes).toBe("new");
    expect((await a.registry.get(rows[1].id)).notes).toBe("");
  });
  it("already cancelled proposals do not write and retries must re-preview", async () => {
    const a = setup();
    const plan = await a.registry.plan("create", { name: "Example" });
    const controller = new AbortController(); controller.abort();
    expect((await a.registry.commit(plan.previewId, controller.signal)).kind).toBe("cancelled");
    expect(a.vault.getCreateCallCount()).toBe(0);
    await expect(a.registry.commit(plan.previewId)).rejects.toThrow("already confirmed");
    const next = await a.registry.plan("create", { name: "Example" });
    expect((await a.registry.commit(next.previewId)).committed).toBe(1);
  });
});

describe("registry review regressions", () => {
  it("rejects frontmatter-injecting tags before preview or writing", async () => {
    const a = setup(); const parent = await createTask(a.vault, a.settings, "Parent");
    await addSubtask(a.vault, a.settings, parent, "Child");
    a.vault.resetCounters();
    await expect(a.registry.plan("update", { taskId: parent.id, patch: { tags: ["safe\n---"] } })).rejects.toThrow();
    expect(a.vault.getModifyCallCount()).toBe(0);
  });
  it("previews normalized coupled status and title changes", async () => {
    const a = setup(); const row = await createTask(a.vault, a.settings, "Example");
    await a.registry.updateFromUI([{ row, patch: { completed: true } }]);
    const plan = await a.registry.plan("update", { taskId: row.id, patch: { completed: false, displayName: "Renamed" } });
    expect(plan.diffs[0].fields).toEqual(expect.arrayContaining([
      { field: "statusLabel", before: "done", after: "active" },
      { field: "title", before: "Example", after: "Renamed" },
    ]));
  });
});

describe("serialization guard", () => {
  it("rejects a note patch that changes task structure during round trip", async () => {
    const a = setup(); const parent = await createTask(a.vault, a.settings, "Parent"); await addSubtask(a.vault, a.settings, parent, "Child");
    a.vault.resetCounters();
    await expect(a.registry.plan("update", { taskId: parent.id, patch: { notes: "memo\n## Subtasks\n### Forged" } })).rejects.toThrow("安全に保存");
    expect(a.vault.getModifyCallCount()).toBe(0);
  });
});

describe("registry row lookup", () => {
  it("get resolves parents and subtasks of any parent, and rejects unknown ids", async () => {
    const a = setup();
    const p1 = await createTask(a.vault, a.settings, "One"); const p2 = await createTask(a.vault, a.settings, "Two");
    const c1 = await addSubtask(a.vault, a.settings, p1, "A"); const c2 = await addSubtask(a.vault, a.settings, p2, "A");
    expect((await a.registry.get(p2.id)).id).toBe(p2.id);
    expect((await a.registry.get(c1.id)).id).toBe(c1.id);
    expect((await a.registry.get(c2.id)).id).toBe(c2.id);
    expect(c1.id).not.toBe(c2.id);
    await expect(a.registry.get(`${p1.id}::missing`)).rejects.toThrow("Task not found");
    await expect(a.registry.get("nope")).rejects.toThrow("Task not found");
  });
  it("a single-subtask update changes only that subtask and verifies it in the round trip", async () => {
    const a = setup();
    const parent = await createTask(a.vault, a.settings, "Parent");
    const first = await addSubtask(a.vault, a.settings, parent, "First");
    const second = await addSubtask(a.vault, a.settings, parent, "Second");
    const plan = await a.registry.plan("update", { taskId: second.id, patch: { plannedStartDate: "2026-03-01", plannedEndDate: "2026-03-04" } });
    expect(plan.diffs).toHaveLength(1);
    expect(plan.diffs[0].taskId).toBe(second.id);
    expect((await a.registry.commit(plan.previewId)).kind).toBe("success");
    expect((await a.registry.get(second.id)).plannedStartDate).toBe("2026-03-01");
    expect((await a.registry.get(first.id)).plannedStartDate ?? "").toBe("");
  });
});

describe("registry task cache", () => {
  function cachedSetup() {
    const a = setup();
    const taskCache = new Map();
    const invalidate = vi.fn((paths?: string[]) => { if (paths) for (const path of paths) taskCache.delete(path); else taskCache.clear(); });
    const registry = new OperationRegistry({ settings: a.settings, historyManager: a.historyManager, taskCache, invalidate }, () => a.vault);
    let reads = 0;
    const read = a.vault.read.bind(a.vault);
    a.vault.read = async (file) => { reads++; return read(file); };
    return { ...a, registry, taskCache, invalidate, reads: () => reads, resetReads: () => { reads = 0; } };
  }
  it("does not re-read unchanged files on a second updateFromUI with a shared cache", async () => {
    const a = cachedSetup();
    const rows = [await createTask(a.vault, a.settings, "A"), await createTask(a.vault, a.settings, "B"), await createTask(a.vault, a.settings, "C")];
    await a.registry.updateFromUI([{ row: rows[0], patch: { currentStatus: "status2" } }]);
    a.resetReads();
    await a.registry.updateFromUI([{ row: rows[1], patch: { currentStatus: "status3" } }]);
    const uncached = setup();
    const baseline = new OperationRegistry({ settings: uncached.settings, historyManager: uncached.historyManager, invalidate: uncached.invalidate }, () => uncached.vault);
    const urows = [await createTask(uncached.vault, uncached.settings, "A"), await createTask(uncached.vault, uncached.settings, "B"), await createTask(uncached.vault, uncached.settings, "C")];
    await baseline.updateFromUI([{ row: urows[0], patch: { currentStatus: "status2" } }]);
    let ureads = 0;
    const uread = uncached.vault.read.bind(uncached.vault);
    uncached.vault.read = async (file) => { ureads++; return uread(file); };
    await baseline.updateFromUI([{ row: urows[1], patch: { currentStatus: "status3" } }]);
    // Unchanged files are served from the cache, so each of the other files saves one read.
    expect(a.reads()).toBeLessThan(ureads);
  });
  it("invalidates only the written paths and reloads their changes", async () => {
    const a = cachedSetup();
    const first = await createTask(a.vault, a.settings, "A"); const second = await createTask(a.vault, a.settings, "B");
    await a.registry.rows();
    expect(a.taskCache.has(first.file.path)).toBe(true);
    expect(a.taskCache.has(second.file.path)).toBe(true);
    await a.registry.updateFromUI([{ row: first, patch: { currentStatus: "status4" } }]);
    expect(a.invalidate).toHaveBeenCalledWith([first.file.path]);
    expect(a.taskCache.has(first.file.path)).toBe(false);
    expect(a.taskCache.has(second.file.path)).toBe(true);
    expect((await a.registry.get(first.id)).currentStatus).toBe("status4");
    expect((await a.registry.get(second.id)).currentStatus).not.toBe("status4");
  });
});

describe("plan same-file grouping", () => {
  it("produces the combined content for several commands on one file", async () => {
    const a = setup(); const parent = await createTask(a.vault, a.settings, "Parent");
    const child1 = await addSubtask(a.vault, a.settings, parent, "One"); const child2 = await addSubtask(a.vault, a.settings, parent, "Two");
    const plan = await a.registry.plan("update-batch", { changes: [{ taskId: child1.id, patch: { currentStatus: "status2" } }, { taskId: child2.id, patch: { currentStatus: "status4" } }] });
    expect(plan.count).toBe(2);
    expect((await a.registry.commit(plan.previewId)).committed).toBe(2);
    expect((await a.registry.get(child1.id)).currentStatus).toBe("status2");
    expect((await a.registry.get(child2.id)).currentStatus).toBe("status4");
  });
});
