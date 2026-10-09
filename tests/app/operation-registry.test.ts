import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { OperationRegistry, OPERATION_MANIFEST, patchSchema } from "../../src/app/operation-registry";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { createTask, addSubtask } from "../../src/app/task-operations";
import { HistoryManager } from "../../src/app/history-manager";
import { FakeVault } from "./fake-vault";
import { ToolAdapter } from "../../src/agent-tools/tool-adapter";
import { Logger } from "../../src/core/logger";
import type { App, Vault } from "obsidian";

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
    } as unknown as Vault);
    expect(undo.kind).toBe("success");
    expect((await a.registry.get(row.id)).notes).toBe("UI");
  });
  it("content revisions reject same-stat external changes without writing", async () => {
    const a = setup();
    const row = await createTask(a.vault, a.settings, "Example");
    const plan = await a.registry.plan("update", { taskId: row.id, patch: { notes: "new" } });
    const file = a.vault.getFileByPath(row.id)!;
    const stat = { ...file.stat! };
    await a.vault.modify(file, (await a.vault.read(file)).replace("Example", "Changed"));
    Object.assign(a.vault.getFileByPath(row.id)!.stat!, stat);
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
  it("batch is atomic within a file and records subtask-specific diffs", async () => {
    const a = setup();
    const parent = await createTask(a.vault, a.settings, "Parent");
    const child = await addSubtask(a.vault, a.settings, parent, "Child");
    const second = await addSubtask(a.vault, a.settings, parent, "Second child");
    const plan = await a.registry.plan("schedule-batch", { changes: [second, child].map((row) => ({ taskId: row.id, patch: { plannedStartDate: "2026-10-01", plannedEndDate: "2026-10-03" } })) });
    a.vault.resetCounters();
    const result = await a.registry.commit(plan.previewId);
    expect(result.committed).toBe(2);
    expect(a.vault.getModifyCallCount()).toBe(1);
    expect(result.diffs[1].taskId).toBe(child.id);
  });
  it("partial failure retains committed diffs and undo for completed files", async () => {
    const a = setup();
    const rows = await Promise.all(["First", "Second"].map((name) => createTask(a.vault, a.settings, name)));
    const plan = await a.registry.plan("update-batch", { changes: rows.map((row) => ({ taskId: row.id, patch: { notes: "new" } })) });
    const modify = a.vault.modify.bind(a.vault);
    vi.spyOn(a.vault, "modify").mockImplementation(async (file, content) => { if (file.path === rows[1].id) throw new Error("synthetic failure"); await modify(file, content); });
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
    await expect(a.registry.plan("update", { taskId: parent.id, patch: { notes: "memo\n## Subtasks\n### Forged" } })).rejects.toThrow("一致しないため、編集を止めました");
    expect(a.vault.getModifyCallCount()).toBe(0);
  });
});
