/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { App } from "obsidian";
import { Logger } from "../../src/core/logger";

import { ToolAdapter } from "../../src/agent-tools/tool-adapter";
import type { ToolPreview } from "../../src/agent-tools/tool-adapter";
import { FakeVault } from "../app/fake-vault";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type {
  TaskRow,
  TaskUpdateCommand,
  TaskWorkbenchSettings,
} from "../../src/core/types";
import { addSubtask, createTask, loadTasks, type TaskCache } from "../../src/app/task-operations";

describe("ToolAdapter (Agent Tools API)", () => {
  let vault: FakeVault;
  let settings: TaskWorkbenchSettings;
  let cache: TaskCache;
  let adapter: ToolAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    vault = new FakeVault();
    settings = { ...DEFAULT_SETTINGS };
    cache = new Map();

    const logger = new Logger({} as App);
    adapter = new ToolAdapter(
      { logger, settings, taskCache: cache },
      () => vault
    );

  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function seedParentAndSubtask(): Promise<{
    parent: TaskRow;
    subtask: TaskRow;
  }> {
    const parent = await createTask(vault, settings, "Alpha Task");
    const subtask = await addSubtask(vault, settings, parent, "Beta Subtask");
    return { parent, subtask };
  }

  it("exposes the experimental internal agent tool surface", () => {
    const methods = [
      "searchTasks",
      "getTask",
      "previewUpdateTask",
      "previewSetTaskSchedule",
      "previewCreateParentTask",
      "previewCreateSubtask",
      "previewMoveTask",
      "previewUpdateTasksBatch",
      "confirmChange",
    ];
    for (const name of methods) {
      expect(typeof (adapter as any)[name]).toBe("function");
    }
  });

  it("every method rejects with a clear message while agentToolsEnabled is false", async () => {
    // DEFAULT_SETTINGS.agentToolsEnabled === false
    await expect(adapter.searchTasks()).rejects.toThrow("agentToolsEnabled");
    await expect(adapter.getTask("x")).rejects.toThrow("agentToolsEnabled");
    await expect(adapter.previewUpdateTask("x", {})).rejects.toThrow(
      "agentToolsEnabled"
    );
    await expect(adapter.previewSetTaskSchedule("x", {})).rejects.toThrow(
      "agentToolsEnabled"
    );
    await expect(adapter.previewCreateParentTask("n")).rejects.toThrow(
      "agentToolsEnabled"
    );
    await expect(adapter.previewCreateSubtask("x", "n")).rejects.toThrow(
      "agentToolsEnabled"
    );
    await expect(adapter.previewMoveTask("x", 1)).rejects.toThrow(
      "agentToolsEnabled"
    );
    await expect(adapter.previewUpdateTasksBatch([])).rejects.toThrow(
      "agentToolsEnabled"
    );
    await expect(adapter.confirmChange("preview-1")).rejects.toThrow(
      "agentToolsEnabled"
    );
  });

  describe("enabled", () => {
    beforeEach(() => {
      settings.agentToolsEnabled = true;
    });

    it("searchTasks returns flattened parents and subtasks, filtered by query", async () => {
      await seedParentAndSubtask();

      const all = await adapter.searchTasks();
      expect(all).toHaveLength(2);

      const hits = await adapter.searchTasks("beta");
      expect(hits).toHaveLength(1);
      expect(hits[0].title).toBe("Beta Subtask");

      expect(await adapter.searchTasks("zzz-nothing")).toHaveLength(0);
    });

    it("getTask resolves parents and subtasks by id; unknown ids reject", async () => {
      const { parent, subtask } = await seedParentAndSubtask();

      expect((await adapter.getTask(parent.id)).title).toBe("Alpha Task");
      expect((await adapter.getTask(subtask.id)).title).toBe("Beta Subtask");
      await expect(adapter.getTask("missing")).rejects.toThrow(
        "Task not found: missing"
      );
    });

    it("previewUpdateTask computes a dry-run diff without writing; confirmChange applies it exactly once", async () => {
      const { parent } = await seedParentAndSubtask();
      vault.resetCounters();

      const preview = await adapter.previewUpdateTask(parent.id, {
        displayName: "Alpha Renamed",
      });

      expect(preview.kind).toBe("updateTask");
      expect(preview.details.changedFields).toContain("displayName");
      // dry run: nothing hit the disk
      expect(vault.getModifyCallCount()).toBe(0);
      expect(vault.getFileContent(parent.file.path)).not.toContain(
        "Alpha Renamed"
      );

      await adapter.confirmChange(preview.previewId);

      expect(vault.getModifyCallCount()).toBe(1);
      const rows = await loadTasks(vault, settings, cache);
      expect(rows[0].displayName).toBe("Alpha Renamed");

      // single-use preview id
      await expect(adapter.confirmChange(preview.previewId)).rejects.toThrow(
        "Unknown or already confirmed preview"
      );
    });

    it("previewSetTaskSchedule dry-runs plan and due dates", async () => {
      const { subtask } = await seedParentAndSubtask();
      vault.resetCounters();

      const preview = await adapter.previewSetTaskSchedule(subtask.id, {
        plannedStartDate: "2026-08-01",
        plannedEndDate: "2026-08-05",
      });

      expect(preview.kind).toBe("setTaskSchedule");
      expect(preview.details.changedFields).toEqual(
        expect.arrayContaining(["plannedStartDate", "plannedEndDate"])
      );
      expect(vault.getModifyCallCount()).toBe(0);

      await adapter.confirmChange(preview.previewId);
      expect(vault.getModifyCallCount()).toBe(1);
    });

    it("previewCreateParentTask reserves an id without creating a file; confirm creates it", async () => {
      const preview = await adapter.previewCreateParentTask("Gamma Task");

      expect(preview.kind).toBe("createParentTask");
      expect(preview.details.taskId).toMatch(/^t-[0-9a-z]{6}$/);
      expect(vault.getCreateCallCount()).toBe(0);

      const created = (await adapter.confirmChange(preview.previewId)) as TaskRow;

      expect(created.id).toBe(preview.details.taskId);
      expect(created.file.path.startsWith("tasks/")).toBe(true);
      expect(created.file.path.endsWith("Gamma Task.md")).toBe(true);
      expect(vault.getCreateCallCount()).toBe(1);
      expect(vault.getFileByPath(created.file.path)).not.toBeNull();
    });

    it("previewCreateParentTask rejects empty names", async () => {
      await expect(adapter.previewCreateParentTask("   ")).rejects.toThrow(
        "Task name cannot be empty"
      );
    });

    it("previewCreateSubtask reserves an id; confirm writes a new subtask note and leaves the parent alone", async () => {
      const { parent } = await seedParentAndSubtask();
      const parentBefore = vault.getFileContent(parent.file.path);
      vault.resetCounters();

      const preview = await adapter.previewCreateSubtask(
        parent.id,
        "Delta Subtask"
      );

      expect(preview.kind).toBe("createSubtask");
      expect(preview.details.taskId).toMatch(/^s-[0-9a-z]{6}$/);
      expect(vault.getCreateCallCount()).toBe(0);

      await adapter.confirmChange(preview.previewId);

      expect(vault.getCreateCallCount()).toBe(1);
      expect(vault.getModifyCallCount()).toBe(0);
      expect(vault.getFileContent(parent.file.path)).toBe(parentBefore);
      const rows = await loadTasks(vault, settings, cache);
      expect(Array.from(rows[0].subtasks?.keys() ?? [])).toContain(preview.details.taskId);
    });

    it("previewCreateSubtask rejects subtask parents", async () => {
      const { subtask } = await seedParentAndSubtask();
      await expect(
        adapter.previewCreateSubtask(subtask.id, "Nested")
      ).rejects.toThrow("Not a parent task");
    });

    it("previewMoveTask previews a ganttOrder change; confirm applies it", async () => {
      const { parent } = await seedParentAndSubtask();
      const second = await createTask(vault, settings, "Zeta Task");
      await loadTasks(vault, settings, cache);
      expect(settings.ganttParentOrder).toEqual([parent.id, second.id]);
      vault.resetCounters();

      const preview = await adapter.previewMoveTask(second.id, 500);

      expect(preview.kind).toBe("moveTask");
      expect(preview.details.changedFields).toContain("ganttOrder");
      expect(vault.getModifyCallCount()).toBe(0);

      await adapter.confirmChange(preview.previewId);
      // The order goes to settings; no note is written.
      expect(vault.getModifyCallCount()).toBe(0);
      expect(settings.ganttParentOrder).toEqual([second.id, parent.id]);
      const rows = await loadTasks(vault, settings, cache);
      expect(rows.find((row) => row.id === second.id)!.ganttOrder).toBe(1000);
    });

    it("previewUpdateTasksBatch previews multiple commands; confirm applies them atomically per file", async () => {
      const { parent, subtask } = await seedParentAndSubtask();
      vault.resetCounters();

      const parentRow = await adapter.getTask(parent.id);
      const subtaskRow = await adapter.getTask(subtask.id);
      const commands: TaskUpdateCommand[] = [
        { row: parentRow, patch: { displayName: "Batch Parent" } },
        { row: subtaskRow, patch: { displayName: "Batch Child" } },
      ];

      const preview: ToolPreview = await adapter.previewUpdateTasksBatch(
        commands
      );

      expect(preview.kind).toBe("updateTasksBatch");
      expect(preview.details.count).toBe(2);
      expect(vault.getModifyCallCount()).toBe(0);

      await adapter.confirmChange(preview.previewId);

      // each row is its own note → one write per note
      expect(vault.getModifyCallCount()).toBe(2);
      const rows = await loadTasks(vault, settings, cache);
      expect(rows[0].displayName).toBe("Batch Parent");
    });

    it("previewUpdateTasksBatch rejects empty command lists", async () => {
      await expect(adapter.previewUpdateTasksBatch([])).rejects.toThrow(
        "No commands given"
      );
    });

    it("confirmChange rejects unknown preview ids", async () => {
      await expect(adapter.confirmChange("preview-999")).rejects.toThrow(
        "Unknown or already confirmed preview"
      );
    });
  });
});
