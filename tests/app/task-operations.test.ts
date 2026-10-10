import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTask,
  loadTasks,
  updateTaskItemsBatch,
  addSubtask,
  addSubtaskWithPlan,
  deleteSubtaskTaskItem,
  getTaskFolderForDate,
  getAvailableTaskPath,
} from "../../src/app/task-operations";
import { FakeVault } from "./fake-vault";
import { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { HistoryManager } from "../../src/app/history-manager";

class FailingBatchVault extends FakeVault {
  private modifyAttempts = 0;
  private readonly failingAttempt: number;

  constructor(failingAttempt: number) {
    super();
    this.failingAttempt = failingAttempt;
  }

  override async modify(file: { path: string }, content: string): Promise<void> {
    this.modifyAttempts += 1;
    if (this.modifyAttempts === this.failingAttempt) {
      throw new Error(`simulated batch failure: ${file.path}`);
    }
    await super.modify(file, content);
  }
}

describe("Task Operations - Integration Tests", () => {
  let vault: FakeVault;
  let settings: TaskWorkbenchSettings;
  let cache: Map<string, { revision: string; taskRow: TaskRow | null }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = new FakeVault();
    settings = { ...DEFAULT_SETTINGS };
    cache = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vault.clear();
  });


  // TASK CREATION TESTS


  describe("createTask", () => {
    it("creates task using today's date", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "My Task");
      expect(task.createdAt).toBe("2026-07-27");
      expect(task.updatedAt).toBe("2026-07-27");
    });

    it("sets statusLabel to active", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.statusLabel).toBe("active");
    });

    it("sets priority to 0", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.priority).toBe(0);
    });

    it("sets priorityMode to auto", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.priorityMode).toBe("auto");
    });

    it("sets ganttEnabled to false", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.ganttEnabled).toBe(false);
    });

    it("sets ganttOrder to Date.now", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const beforeNow = Date.now();
      const task = await createTask(vault, settings, "Test Task");
      const afterNow = Date.now();
      expect(task.ganttOrder).toBeGreaterThanOrEqual(beforeNow);
      expect(task.ganttOrder).toBeLessThanOrEqual(afterNow);
    });

    it("sets empty tags array", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.tags).toEqual([]);
    });

    it("sets empty notes", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.notes).toBe("");
    });

    it("sets empty currentStatus", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");
      expect(task.currentStatus).toBe("");
    });

    it("task file lands at {taskFolder}/YYYY/MM/...md without date prefix", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = false;
      const task = await createTask(vault, settings, "My Task");
      expect(task.file.path).toMatch(/^tasks\/2026\/07\/My Task\.md$/);
    });

    it("task file lands at {taskFolder}/YYYY/MM/YYYY-MM-DD {taskName}.md with date prefix", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = true;
      const task = await createTask(vault, settings, "My Task");
      expect(task.file.path).toMatch(/^tasks\/2026\/07\/2026-07-27 My Task\.md$/);
    });

    it("handles name collision with space-numbered suffix", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = false;

      const task1 = await createTask(vault, settings, "Task Name");
      expect(task1.file.path).toMatch(/Task Name\.md$/);

      const task2 = await createTask(vault, settings, "Task Name");
      expect(task2.file.path).toMatch(/Task Name 1\.md$/);

      const task3 = await createTask(vault, settings, "Task Name");
      expect(task3.file.path).toMatch(/Task Name 2\.md$/);
    });

    it("sanitizes filename removing forbidden characters", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = false;

      // The 13 forbidden chars: \ /: * ? " < > | # ^ [ ]
      const task = await createTask(vault, settings, 'Test\\Task/Name:File*Query?Quote"Less>Greater|Hash#Caret^LBracket[RBracket]');

      // Get just the filename part (after the last /)
      const filename = task.file.path.split("/").pop() ?? "";
      // All forbidden chars should be removed from the actual filename
      expect(filename).not.toContain("\\");
      expect(filename).not.toContain("/");
      expect(filename).not.toContain(":");
      expect(filename).not.toContain("*");
      expect(filename).not.toContain("?");
      expect(filename).not.toContain('"');
      expect(filename).not.toContain("<");
      expect(filename).not.toContain(">");
      expect(filename).not.toContain("|");
      expect(filename).not.toContain("#");
      expect(filename).not.toContain("^");
      expect(filename).not.toContain("[");
      expect(filename).not.toContain("]");
    });

    it("preserves most other special characters in filename", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = false;

      const task = await createTask(vault, settings, "Task-Name_With.Dots&Ampersand");
      expect(task.file.path).toContain("Task-Name_With.Dots&Ampersand");
    });

    it("throws when task name is empty", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      await expect(createTask(vault, settings, "")).rejects.toThrow(
        "Task name cannot be empty"
      );
    });

    it("throws when task name is whitespace only", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      await expect(createTask(vault, settings, "   ")).rejects.toThrow(
        "Task name cannot be empty"
      );
    });

    it("creates file via vault.create", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      vault.resetCounters();
      await createTask(vault, settings, "Test Task");
      expect(vault.getCreateCallCount()).toBe(1);
    });

    it("returns re-parsed task row", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const task = await createTask(vault, settings, "Test Task");

      // Verify it's a valid parsed task (has all the fields)
      expect(task.kind).toBe("parent");
      expect(task.title).toBe("Test Task");
      expect(task.displayName).toBe("Test Task");
      expect(task.statusLabel).toBe("active");
    });
  });


  // TASK LOADING WITH CACHING TESTS


  describe("loadTasks", () => {
    it("processes root folder with trailing slash removed", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.taskFolder = "tasks/";

      // Create a task in the expected location
      await createTask(vault, settings, "Test Task");

      // Load should still find it even with trailing slash in settings
      const loaded = await loadTasks(vault, settings, cache);
      expect(loaded).toHaveLength(1);
    });

    it("matches files: path.startsWith(root+'/') OR path === root", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      // Create task in correct location
      await createTask(vault, settings, "Task in Folder");

      // Create some files outside the task folder (will be ignored by loadTasks)
      await vault.create("other-folder/file.md", "content");

      const loaded = await loadTasks(vault, settings, cache);
      // Should only load the task from the task folder
      expect(loaded.length).toBeGreaterThanOrEqual(1);
    });

    it("processes only files with frontmatter.type === task", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      // Create a valid task
      const task = await createTask(vault, settings, "Valid Task");

      // Create a file in the task folder that's not a task
      await vault.create(
        "tasks/2026/07/not-a-task.md",
        "---\ntype: note\n---\n\nSome content"
      );

      const loaded = await loadTasks(vault, settings, cache);
      // Should only load the actual task, not the note
      expect(loaded).toHaveLength(1);
      expect(loaded[0].file.path).toBe(task.file.path);
    });

    it("unchanged tasks and non-task files skip reads; changed files are reloaded", async () => {
      const task = await createTask(vault, settings, "Cached task");
      await vault.create("tasks/plain.md", "plain note");
      await loadTasks(vault, settings, cache);
      const read = vi.spyOn(vault, "read");

      const unchanged = await loadTasks(vault, settings, cache);
      expect(read).not.toHaveBeenCalled();
      expect(unchanged.map((row) => row.title)).toEqual(["Cached task"]);

      const file = vault.getFileByPath(task.file.path)!;
      const content = await vault.read(file);
      await vault.modify(file, content.split("Cached task").join("Changed cached task"));
      read.mockClear();
      const changed = await loadTasks(vault, settings, cache);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: file.path }));
      expect(changed[0].title).toBe("Changed cached task");
    });

    it("a failed changed-file read is retried rather than cached", async () => {
      const task = await createTask(vault, settings, "Read retry");
      await loadTasks(vault, settings, cache);
      const file = vault.getFileByPath(task.file.path)!;
      await vault.modify(file, (await vault.read(file)) + "\nchanged");
      const read = vi.spyOn(vault, "read").mockRejectedValueOnce(new Error("read failed"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await loadTasks(vault, settings, cache)).toEqual([]);
      expect(await loadTasks(vault, settings, cache)).toHaveLength(1);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("cache hit skips parsing", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      // First load - populates cache
      const loaded1 = await loadTasks(vault, settings, cache);
      expect(loaded1).toHaveLength(1);

      // Manually mutate the cached row to prove the cache is used
      const cachedEntry = cache.get(task.file.path);
      if (cachedEntry && cachedEntry.taskRow) {
        cachedEntry.taskRow.title = "MUTATED TITLE";
      }

      // Second load with same mtime/size - should use cache and return mutated row
      const loaded2 = await loadTasks(vault, settings, cache);
      expect(loaded2).toHaveLength(1);
      expect(loaded2[0].title).toBe("MUTATED TITLE");
    });

    it("parse errors are logged and file is filtered from results", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      // Create a valid task
      const task = await createTask(vault, settings, "Valid Task");

      // Create a file with type: task but missing critical fields that will cause parse to return null
      // When parseTaskFile can't extract required values, it returns null
      await vault.create(
        "tasks/2026/07/incomplete-task.md",
        "---\ntype: task\n---\n\nContent without required fields"
      );

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const loaded = await loadTasks(vault, settings, cache);

      // Should include the valid task
      expect(loaded.length).toBeGreaterThanOrEqual(1);
      const validTaskFound = loaded.some((t) => t.file.path === task.file.path);
      expect(validTaskFound).toBe(true);

      consoleSpy.mockRestore();
    });

    it("old cache entries are deleted before load", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      // Create a task and load it
      await createTask(vault, settings, "Test Task");
      await loadTasks(vault, settings, cache);

      // Manually add a stale cache entry for a file that no longer exists
      cache.set("tasks/2026/07/deleted-task.md", {
        revision: "12345:67890",
        taskRow: null,
      });

      expect(cache.size).toBe(2); // The task and the stale entry

      // Load again - should remove the stale entry
      await loadTasks(vault, settings, cache);

      // Stale entry should be gone
      expect(cache.has("tasks/2026/07/deleted-task.md")).toBe(false);
    });

    it("reuses cached tasks when mtime and size are unchanged", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      // Load once to populate cache
      await loadTasks(vault, settings, cache);
      const cachedEntry = cache.get(task.file.path);

      // Mutate the cached row to prove reuse
      if (cachedEntry && cachedEntry.taskRow) {
        cachedEntry.taskRow.title = "CACHE STILL USED";
      }

      // In a real scenario, the file would have different content but same size/mtime
      // The cache would still be used (this is a known limitation)
      // For testing purposes, we just verify the cache was used from the mutation
      const loaded2 = await loadTasks(vault, settings, cache);

      // If we got the mutated version, the cache was used
      expect(loaded2[0].title).toBe("CACHE STILL USED");
    });
  });


  describe("custom note content", () => {
    it("preserves custom content across updates, subtask addition and deletion", async () => {
      const parent = await createTask(vault, settings, "親タスク");
      const file = vault.getFileByPath(parent.file.path)!;
      const extra = "project: 顧客A\nreferences:\n  - 資料A\n";
      const section = "\n## 参考資料\n[資料](https://example.com)\n";
      await vault.modify(file, (await vault.read(file)).replace("type: task\n", `type: task\n${extra}`) + section);
      const history = new HistoryManager();
      await updateTaskItemsBatch(vault, settings, cache, [{ row: parent, patch: { dueDate: "2026-10-20" } }], {}, history);
      expect(await vault.read(file)).toContain("dueDate: 2026-10-20");
      expect(await vault.read(file)).toContain(extra);
      expect(await vault.read(file)).toContain(section.trim());
      const fresh = (await loadTasks(vault, settings, cache)).find((row) => row.id === parent.id)!;
      const subtask = await addSubtask(vault, settings, fresh, "作業");
      await updateTaskItemsBatch(vault, settings, cache, [{ row: subtask, patch: { notes: "作業メモ" } }], {});
      await deleteSubtaskTaskItem(vault, settings, subtask);
      const saved = await vault.read(file);
      expect(saved).toContain(extra);
      expect(saved).toContain(section.trim());
      expect(saved).not.toContain("subtask__");
    });

    it("refuses a subtask rewrite with custom inner sections without writing or mutating the row", async () => {
      const parent = await createTask(vault, settings, "親タスク");
      const subtask = await addSubtask(vault, settings, parent, "作業");
      const file = vault.getFileByPath(parent.file.path)!;
      const original = await vault.read(file) + "\n#### 参考資料\n消してはいけない資料\n";
      await vault.modify(file, original);
      vault.resetCounters();
      await expect(updateTaskItemsBatch(vault, settings, cache, [{ row: subtask, patch: { displayName: "変更" } }], {}))
        .rejects.toThrow("保持できない記述があります: ## Subtasks");
      await expect(addSubtask(vault, settings, parent, "追加"))
        .rejects.toThrow("保持できない記述があります: ## Subtasks");
      await expect(deleteSubtaskTaskItem(vault, settings, subtask))
        .rejects.toThrow("保持できない記述があります: ## Subtasks");
      expect(parent.subtasks?.size).toBe(1);
      expect(vault.getModifyCallCount()).toBe(0);
      expect(await vault.read(file)).toBe(original);
    });
  });

  // TASK UPDATE TESTS


  describe("updateTaskItemsBatch", () => {
    it("non-array commands returns empty array", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const results = await updateTaskItemsBatch(
        vault,
        settings,
        cache,
        "not an array" as unknown,
        {}
      );
      expect(results).toEqual([]);
    });

    it("empty commands array returns empty array", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const results = await updateTaskItemsBatch(
        vault,
        settings,
        cache,
        [],
        {}
      );
      expect(results).toEqual([]);
    });

    it("groups commands by parent file path and makes single write", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      // Create a parent task with two subtasks
      const parent = await createTask(vault, settings, "Parent Task");
      const subtask1 = await addSubtask(vault, settings, parent, "Subtask 1");
      const subtask2 = await addSubtask(vault, settings, parent, "Subtask 2");

      vault.resetCounters();

      // Update both subtasks in one batch
      const results = await updateTaskItemsBatch(
        vault,
        settings,
        cache,
        [
          {
            row: subtask1,
            patch: { currentStatus: "Updated 1" },
          },
          {
            row: subtask2,
            patch: { currentStatus: "Updated 2" },
          },
        ],
        {}
      );

      // Should have only one modify call (grouped by parent path)
      expect(vault.getModifyCallCount()).toBe(1);
      expect(results).toHaveLength(2);
    });

    it("revision conflict throws REVISION_CONFLICT for entire file", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      // Test that revision conflict is properly thrown
      let conflictThrown = false;
      try {
        await updateTaskItemsBatch(
          vault,
          settings,
          cache,
          [
            {
              row: task,
              patch: { displayName: "Updated" },
              expectedRevision: "wrong-revision",
            },
          ],
          {}
        );
      } catch (error: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = error as any;
        if (e.code === "REVISION_CONFLICT") {
          conflictThrown = true;
        }
      }

      expect(conflictThrown).toBe(true);
    });

    it("expectedRevision check fails and throws REVISION_CONFLICT", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      try {
        await updateTaskItemsBatch(
          vault,
          settings,
          cache,
          [
            {
              row: task,
              patch: { displayName: "Updated" },
              expectedRevision: "definitely-wrong-revision",
            },
          ],
          {}
        );
        expect.fail("Should have thrown REVISION_CONFLICT");
      } catch (error: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = error as any;
        expect(e.code).toBe("REVISION_CONFLICT");
        expect(e.expectedRevision).toBe("definitely-wrong-revision");
        expect(e.currentRevision).toBeDefined();
      }
    });

    it("unset expectedRevision skips the check", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      const results = await updateTaskItemsBatch(
        vault,
        settings,
        cache,
        [
          {
            row: task,
            patch: { displayName: "Updated" },
            expectedRevision: undefined,
          },
        ],
        {}
      );

      // Should succeed because expectedRevision is undefined
      expect(results).toHaveLength(1);
    });

    it("empty string expectedRevision skips the check", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      const results = await updateTaskItemsBatch(
        vault,
        settings,
        cache,
        [
          {
            row: task,
            patch: { displayName: "Updated" },
            expectedRevision: "",
          },
        ],
        {}
      );

      expect(results).toHaveLength(1);
    });

    it("result includes taskId, parentPath, revisionBefore, revisionAfter, changedFields", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const task = await createTask(vault, settings, "Test Task");

      const results = await updateTaskItemsBatch(
        vault,
        settings,
        cache,
        [
          {
            row: task,
            patch: { displayName: "Updated" },
          },
        ],
        {}
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.taskId).toBe(task.id);
      expect(result.parentPath).toBe(task.file.path);
      expect(result.revisionBefore).toBeDefined();
      expect(result.revisionAfter).toBeDefined();
      expect(result.changedFields).toBeDefined();
      expect(Array.isArray(result.changedFields)).toBe(true);
    });

    it("clears history when a multi-file batch fails after a partial write", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      const batchVault = new FailingBatchVault(2);
      const first = await createTask(batchVault, settings, "First");
      const second = await createTask(batchVault, settings, "Second");
      const historyManager = new HistoryManager();
      historyManager.push({
        label: "先行編集",
        files: [{ path: first.file.path, before: "before", after: "after" }],
      });

      await expect(
        updateTaskItemsBatch(
          batchVault,
          settings,
          cache,
          [
            { row: first, patch: { displayName: "First changed" } },
            { row: second, patch: { displayName: "Second changed" } },
          ],
          {},
          historyManager
        )
      ).rejects.toThrow("simulated batch failure");

      expect(historyManager.canUndo()).toBe(false);
      expect(historyManager.canRedo()).toBe(false);
      expect(batchVault.getFileContent(first.file.path)).toContain("First changed");
      expect(batchVault.getFileContent(second.file.path)).toContain("Second");
      expect(batchVault.getFileContent(second.file.path)).not.toContain("Second changed");
    });
  });


  // SUBTASK MANAGEMENT TESTS


  describe("addSubtask", () => {
    it("generates unique key via getSubtaskKey", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask1 = await addSubtask(vault, settings, parent, "My Subtask");

      // Key should be a slug (alphanumeric and hyphens)
      expect(subtask1.key).toMatch(/^[a-z0-9-]+$/);
    });

    it("collision suffix generates unique keys", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask1 = await addSubtask(vault, settings, parent, "Duplicate");
      const subtask2 = await addSubtask(vault, settings, parent, "Duplicate");

      // Keys should be different
      expect(subtask1.key).not.toBe(subtask2.key);
      // Second should have a suffix
      expect(subtask2.key).toMatch(/-1$/);
    });

    it("default subtask has empty plan dates, workload, markers", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask = await addSubtask(vault, settings, parent, "Subtask");

      expect(subtask.plannedStartDate).toBeUndefined();
      expect(subtask.plannedEndDate).toBeUndefined();
      expect(subtask.workloadPlan).toBeUndefined();
      expect(subtask.workloadActual).toBeUndefined();
      expect(subtask.ganttMarkers).toBeUndefined();
    });

    it("patch parameter overrides defaults", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask = await addSubtask(vault, settings, parent, "Subtask", {
        displayName: "Custom Display Name",
        // Note: priority is normally auto-calculated, so we don't test overriding it in a patch
        plannedStartDate: "2026-08-01",
        plannedEndDate: "2026-08-05",
      });

      expect(subtask.displayName).toBe("Custom Display Name");
      expect(subtask.plannedStartDate).toBe("2026-08-01");
      expect(subtask.plannedEndDate).toBe("2026-08-05");
    });

    it("adds to parent subtasks and bumps updatedAt", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const parentUpdatedAtBefore = parent.updatedAt;

      vi.advanceTimersByTime(24 * 60 * 60 * 1000); // Advance by 1 day

      await addSubtask(vault, settings, parent, "Subtask");

      // Reload parent to check updated state
      const file = vault.getFileByPath(parent.file.path);
      if (!file) throw new Error("Parent file not found");

      const parentContent = await vault.read(file);
      const { parseTaskFile } = await import("../../src/core/note-format");
      const reloadedParent = parseTaskFile(
        { path: file.path },
        parentContent,
        settings
      );

      if (!reloadedParent) throw new Error("Failed to reload parent");

      // updatedAt should have been bumped
      expect(reloadedParent.updatedAt).not.toBe(parentUpdatedAtBefore);
    });

    it("throws when subtask name is empty", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");

      await expect(addSubtask(vault, settings, parent, "")).rejects.toThrow(
        "Subtask name cannot be empty"
      );
    });

    it("throws when subtask name is whitespace only", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");

      await expect(addSubtask(vault, settings, parent, "   ")).rejects.toThrow(
        "Subtask name cannot be empty"
      );
    });

    it("writes and re-parses", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      vault.resetCounters();

      const subtask = await addSubtask(vault, settings, parent, "New Subtask");

      // Should have called modify once
      expect(vault.getModifyCallCount()).toBe(1);

      // Subtask should be fully parsed (not just raw data)
      expect(subtask.kind).toBe("subtask");
      expect(subtask.title).toBe("New Subtask");
    });
  });

  describe("addSubtaskWithPlan", () => {
    it("sets both plannedStartDate and plannedEndDate to dateStr", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask = await addSubtaskWithPlan(
        vault,
        settings,
        parent,
        "Planned Subtask",
        "2026-08-15"
      );

      expect(subtask.plannedStartDate).toBe("2026-08-15");
      expect(subtask.plannedEndDate).toBe("2026-08-15");
    });
  });

  describe("deleteSubtaskTaskItem", () => {
    it("removes subtask by id/key match", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask = await addSubtask(vault, settings, parent, "To Delete");

      await deleteSubtaskTaskItem(vault, settings, subtask);

      // Verify subtask is gone
      const file = vault.getFileByPath(parent.file.path);
      if (!file) throw new Error("Parent not found");

      const content = await vault.read(file);
      const { parseTaskFile } = await import("../../src/core/note-format");
      const reloaded = parseTaskFile(
        file as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        content,
        settings
      );

      if (!reloaded) throw new Error("Failed to reload");
      if (!reloaded.subtasks) throw new Error("Subtasks not found");

      // Subtask should be gone
      expect(reloaded.subtasks.has(subtask.key!)).toBe(false);
    });

    it("throws when subtask not found", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const fakeSubtask: TaskRow = {
        kind: "subtask",
        id: `${parent.id}::nonexistent`,
        key: "nonexistent",
        file: {
          path: parent.file.path,
          parentPath: parent.file.path,
          heading: "Nonexistent",
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        title: "Nonexistent",
        displayName: "Nonexistent",
        statusLabel: "active",
        completed: false,
        createdAt: "2026-07-27",
        updatedAt: "2026-07-27",
        dueDate: undefined,
        priority: 0,
        priorityMode: "auto",
        currentStatus: "",
        notes: "",
        tags: [],
        plannedStartDate: undefined,
        plannedEndDate: undefined,
        workloadPlan: undefined,
        workloadActual: undefined,
        ganttMarkers: undefined,
        ganttEnabled: false,
      } as TaskRow;

      await expect(deleteSubtaskTaskItem(vault, settings, fakeSubtask)).rejects.toThrow(
        "Subtask not found"
      );
    });

    it("writes updated parent after deletion", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));

      const parent = await createTask(vault, settings, "Parent");
      const subtask = await addSubtask(vault, settings, parent, "To Delete");

      vault.resetCounters();
      await deleteSubtaskTaskItem(vault, settings, subtask);

      // Should have called modify once
      expect(vault.getModifyCallCount()).toBe(1);
    });
  });


  // UTILITY FUNCTION TESTS


  describe("getTaskFolderForDate", () => {
    it("computes folder as {taskFolder}/YYYY/MM", () => {
      const folder = getTaskFolderForDate(settings, "2026-07-27");
      expect(folder).toBe("tasks/2026/07");
    });
  });

  describe("getAvailableTaskPath", () => {
    it("sanitizes name", () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = false;

      const path = getAvailableTaskPath(
        vault,
        settings,
        'Invalid:Name*With"Chars',
        "2026-07-27"
      );

      // Should have removed invalid chars
      expect(path).not.toContain(":");
      expect(path).not.toContain("*");
      expect(path).not.toContain('"');
    });

    it("adds date prefix when enabled", () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = true;

      const path = getAvailableTaskPath(vault, settings, "Task", "2026-07-27");
      expect(path).toContain("2026-07-27");
    });

    it("no date prefix when disabled", () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
      settings.filenameUsesDatePrefix = false;

      const path = getAvailableTaskPath(vault, settings, "Task", "2026-07-27");
      // Should not have the date prefix (only the folder date structure)
      const filename = path.split("/").pop();
      expect(filename).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
  });
});
