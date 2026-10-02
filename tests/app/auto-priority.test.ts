/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutoPriorityController, TaskCache } from "../../src/app/auto-priority";
import { VaultAdapter, VaultFile } from "../../src/app/task-operations";
import { FakeVault } from "./fake-vault";
import { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { applyAutoPriorityFields, buildFileRevision } from "../../src/core/utils";

/** Vault whose file listing throws (e.g. task folder deleted externally). */
class ListingFailingVault implements VaultAdapter {
  async create(path: string): Promise<VaultFile> {
    return { path };
  }
  async modify(): Promise<void> {
    throw new Error("modify should not be reached");
  }
  async read(): Promise<string> {
    return "";
  }
  getFiles(): VaultFile[] {
    // first listing attempt fails
    throw new Error("Task folder not found");
  }
  getFileByPath(): VaultFile | null {
    return null;
  }
}

/** Vault where modify fails for selected paths (lock / deleted file). */
class ModifyFailingVault implements VaultAdapter {
  constructor(
    private readonly inner: VaultAdapter,
    private readonly failPaths: Set<string>,
    private readonly message: string
  ) {}
  create(path: string, content: string): Promise<VaultFile> {
    return this.inner.create(path, content);
  }
  async modify(file: VaultFile, content: string): Promise<void> {
    if (this.failPaths.has(file.path)) {
      throw new Error(this.message);
    }
    return this.inner.modify(file, content);
  }
  read(file: VaultFile): Promise<string> {
    return this.inner.read(file);
  }
  getFiles(): VaultFile[] {
    return this.inner.getFiles();
  }
  getFileByPath(path: string): VaultFile | null {
    return this.inner.getFileByPath(path);
  }
}

/** Vault where a file disappears between listing and write. */
class FileVanishingVault implements VaultAdapter {
  constructor(
    private readonly inner: VaultAdapter,
    private readonly vanishedPaths: Set<string>
  ) {}
  create(path: string, content: string): Promise<VaultFile> {
    return this.inner.create(path, content);
  }
  modify(file: VaultFile, content: string): Promise<void> {
    return this.inner.modify(file, content);
  }
  read(file: VaultFile): Promise<string> {
    return this.inner.read(file);
  }
  getFiles(): VaultFile[] {
    return this.inner.getFiles();
  }
  getFileByPath(path: string): VaultFile | null {
    if (this.vanishedPaths.has(path)) {
      return null; // file deleted mid-run
    }
    return this.inner.getFileByPath(path);
  }
}

/**
 * Builds a parent TaskRow with a stale priority (what an in-memory cache
 * entry would look like before recomputation).
 */
function makeStaleParent(path: string, dueDate?: string): TaskRow {
  return {
    kind: "parent",
    id: path,
    file: { path } as any,
    title: "Stale",
    displayName: "Stale",
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-28",
    updatedAt: "2026-07-28",
    dueDate,
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ganttOrder: 1,
    subtasks: new Map(),
  };
}

describe("AutoPriorityController", () => {
  let vault: FakeVault;
  let settings: TaskWorkbenchSettings;
  let cache: TaskCache;
  let controller: AutoPriorityController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    vault = new FakeVault();
    settings = { ...DEFAULT_SETTINGS };
    cache = new Map();
    controller = new AutoPriorityController();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vault.clear();
    vi.useRealTimers();
  });

  /** Seeds a file and a matching-revision cache entry holding staleRow. */
  async function seedStaleCache(
    path: string,
    staleRow: TaskRow
  ): Promise<void> {
    const created = await vault.create(path, "placeholder");
    const revision = buildFileRevision(created as any);
    cache.set(path, { revision, taskRow: staleRow });
  }

  describe("run conditions", () => {
    it("first run (empty lastAutoPriorityUpdate) always runs with default force=false", async () => {
      expect(settings.lastAutoPriorityUpdate).toBe("");

      const ran = await controller.updateAutoPriorities(vault, settings, cache);

      expect(ran).toBe(true);
    });

    it("disabled auto priority terminates immediately without side effects", async () => {
      settings.autoPriorityEnabled = false;

      const ran = await controller.updateAutoPriorities(vault, settings, cache);

      expect(ran).toBe(false);
      expect(settings.lastAutoPriorityUpdate).toBe("");
      expect(vault.getModifyCallCount()).toBe(0);
    });

    it("already run today → duplicate run is skipped", async () => {
      settings.lastAutoPriorityUpdate = "2026-07-29";

      const ran = await controller.updateAutoPriorities(vault, settings, cache);

      expect(ran).toBe(false);
      expect(vault.getModifyCallCount()).toBe(0);
    });

    it("force=true bypasses the same-day check", async () => {
      settings.lastAutoPriorityUpdate = "2026-07-29";

      const ran = await controller.updateAutoPriorities(
        vault,
        settings,
        cache,
        true
      );

      expect(ran).toBe(true);
      expect(settings.lastAutoPriorityUpdate).toBe("2026-07-29");
    });

    it("runs again once the stored date differs from today", async () => {
      settings.lastAutoPriorityUpdate = "2026-07-28";

      const ran = await controller.updateAutoPriorities(vault, settings, cache);

      expect(ran).toBe(true);
      expect(settings.lastAutoPriorityUpdate).toBe("2026-07-29");
    });

    it("stores the run date in YYYY-MM-DD format", async () => {
      await controller.updateAutoPriorities(vault, settings, cache);

      expect(settings.lastAutoPriorityUpdate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(settings.lastAutoPriorityUpdate).toBe("2026-07-29");
    });
  });

  describe("change detection and writes", () => {
    it("manual-mode tasks and unchanged auto tasks are never written", async () => {
      await vault.create(
        "tasks/2026-07/manual.md",
        [
          "---",
          "type: task",
          'displayName: "Manual Task"',
          "priority: 3",
          "priorityMode: manual",
          "dueDate: 2026-07-29",
          "---",
          "",
          "# Manual Task",
          "",
        ].join("\n")
      );
      await vault.create(
        "tasks/2026-07/auto-unchanged.md",
        [
          "---",
          "type: task",
          'displayName: "Auto Task"',
          "priority: 0",
          "priorityMode: auto",
          "---",
          "",
          "# Auto Task",
          "",
        ].join("\n")
      );

      const ran = await controller.updateAutoPriorities(vault, settings, cache);

      expect(ran).toBe(true);
      expect(vault.getModifyCallCount()).toBe(0);
    });

    it("stale cached parent is recomputed and its file rewritten once", async () => {
      const path = "tasks/2026-07/stale-parent.md";
      // due yesterday → overdue → auto priority 5, stored value 0
      const staleRow = makeStaleParent(path, "2026-07-28");
      await seedStaleCache(path, staleRow);

      // the applier returns void/undefined; change detection
      // relies on captured field values, and the update still happens
      expect(applyAutoPriorityFields(staleRow, true)).toBeUndefined();
      // (the call above already mutated staleRow; re-seed for the real run)
      const freshStale = makeStaleParent(path, "2026-07-28");
      cache.set(path, {
        revision: buildFileRevision(vault.getFileByPath(path) as any),
        taskRow: freshStale,
      });

      const ran = await controller.updateAutoPriorities(vault, settings, cache);

      expect(ran).toBe(true);
      expect(vault.getModifyCallCount()).toBe(1);
      const content = vault.getFileContent(path) as string;
      expect(content).toContain("priority: 5");
      expect(content).toContain("priorityMode: auto");
    });

    it("stale cached subtask priority is recomputed and the parent file rewritten", async () => {
      const path = "tasks/2026-07/stale-sub.md";
      const staleRow = makeStaleParent(path);
      const staleSub: TaskRow = {
        kind: "subtask",
        id: `${path}::s-one`,
        key: "s-one",
        file: { path, parentPath: path, heading: "S One" } as any,
        title: "S One",
        displayName: "S One",
        statusLabel: "active",
        completed: false,
        createdAt: "2026-07-28",
        updatedAt: "2026-07-28",
        dueDate: "2026-07-29", // due today → priority 5
        priority: 0,
        priorityMode: "auto",
        currentStatus: "",
        notes: "",
        tags: [],
        ganttEnabled: false,
      };
      staleRow.subtasks = new Map([["s-one", staleSub]]);
      await seedStaleCache(path, staleRow);

      await controller.updateAutoPriorities(vault, settings, cache);

      expect(vault.getModifyCallCount()).toBe(1);
      const content = vault.getFileContent(path) as string;
      expect(content).toContain("subtask__s-one__priority: 5");
    });
  });

  describe("failure propagation", () => {
    it("listing failure propagates and the date stays untouched", async () => {
      const failing = new ListingFailingVault();

      await expect(
        controller.updateAutoPriorities(failing, settings, cache)
      ).rejects.toThrow("Task folder not found");

      expect(settings.lastAutoPriorityUpdate).toBe("");
    });

    it("a file deleted mid-run aborts with a propagated error", async () => {
      const path = "tasks/2026-07/vanished.md";
      await seedStaleCache(path, makeStaleParent(path, "2026-07-28"));
      const vanishing = new FileVanishingVault(vault, new Set([path]));

      await expect(
        controller.updateAutoPriorities(vanishing, settings, cache)
      ).rejects.toThrow("Task file not found");

      expect(settings.lastAutoPriorityUpdate).toBe("");
      expect(vault.getModifyCallCount()).toBe(0);
    });

    it("modify() failure stops iteration after partial updates", async () => {
      const pathA = "tasks/2026-07/a.md";
      const pathB = "tasks/2026-07/b.md";
      await seedStaleCache(pathA, makeStaleParent(pathA, "2026-07-28"));
      await seedStaleCache(pathB, makeStaleParent(pathB, "2026-07-28"));
      const locking = new ModifyFailingVault(
        vault,
        new Set([pathB]),
        "file locked"
      );

      await expect(
        controller.updateAutoPriorities(locking, settings, cache)
      ).rejects.toThrow("file locked");

      // earlier file already updated (partial state)
      expect(vault.getFileContent(pathA)).toContain("priority: 5");
      // later files are not processed
      expect(vault.getFileContent(pathB)).toBe("placeholder");
      // run date not recorded on failure
      expect(settings.lastAutoPriorityUpdate).toBe("");
    });

    it("concurrent runs proceed without an exclusive lock", async () => {
      const path = "tasks/2026-07/concurrent.md";
      await seedStaleCache(path, makeStaleParent(path, "2026-07-28"));

      const [first, second] = await Promise.all([
        controller.updateAutoPriorities(vault, settings, cache, true),
        controller.updateAutoPriorities(vault, settings, cache, true),
      ]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(vault.getFileContent(path)).toContain("priority: 5");
    });
  });
});
