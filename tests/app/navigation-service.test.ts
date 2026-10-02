/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TFile } from "obsidian";
import { NavigationService } from "../../src/app/navigation-service";
import type { NavigationHost } from "../../src/app/navigation-service";
import { TaskFinderModal } from "../../src/ui/task-finder-modal";
import { FakeVault } from "./fake-vault";
import { addSubtask, createTask } from "../../src/app/task-operations";
import type { VaultAdapter } from "../../src/app/task-operations";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";

const WB = "task-workbench-view";
const GANTT = "task-gantt-view";

function makeLeaf() {
  return {
    setViewState: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
  };
}

interface Harness {
  service: NavigationService;
  workspace: any;
  vaultStub: { getAbstractFileByPath: ReturnType<typeof vi.fn> };
  settings: TaskWorkbenchSettings;
  vault: FakeVault;
}

function createHarness(): Harness {
  const workspace = {
    getLeavesOfType: vi.fn(() => []),
    getLeaf: vi.fn(() => makeLeaf()),
    revealLeaf: vi.fn().mockResolvedValue(undefined),
    getMostRecentLeaf: vi.fn(() => null),
    openLinkText: vi.fn().mockResolvedValue(undefined),
  };
  const vaultStub = { getAbstractFileByPath: vi.fn(() => null) };
  const app = { workspace, vault: vaultStub };
  const settings = { ...DEFAULT_SETTINGS };
  const host = {
    app,
    settings,
    taskCache: new Map(),
  } as unknown as NavigationHost;
  const vault = new FakeVault();
  const service = new NavigationService(host, () => vault, WB, GANTT);
  return { service, workspace, vaultStub, settings, vault };
}

function makeRow(overrides: Record<string, unknown>): TaskRow {
  return {
    kind: "parent",
    id: "tasks/a.md",
    file: { path: "tasks/a.md" },
    title: "A",
    displayName: "A",
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-29",
    updatedAt: "2026-07-29",
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ...overrides,
  } as unknown as TaskRow;
}

describe("NavigationService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("activateView and activateGanttView", () => {
    it("reuses the existing leaf of the view type without recreating the instance", async () => {
      const h = createHarness();
      const existing = makeLeaf();
      h.workspace.getLeavesOfType.mockReturnValue([existing]);

      await h.service.activateView();
      await h.service.activateView();

      expect(h.workspace.getLeavesOfType).toHaveBeenCalledTimes(2);
      expect(h.workspace.getLeavesOfType).toHaveBeenCalledWith(WB);
      // the view instance is reused — no new leaf is ever created
      expect(h.workspace.getLeaf).not.toHaveBeenCalled();
      expect(existing.setViewState).toHaveBeenCalledTimes(2);
      expect(existing.setViewState).toHaveBeenCalledWith({
        type: WB,
        active: true,
      });
      expect(h.workspace.revealLeaf).toHaveBeenCalledTimes(2);
      expect(h.workspace.revealLeaf).toHaveBeenCalledWith(existing);
      // same leaf object both times: in-memory state (scroll, filters)
      // survives because the instance is never rebuilt
    });

    it("creates a new tab leaf when none exists; a re-open after close yields a fresh leaf", async () => {
      const h = createHarness();
      const first = makeLeaf();
      const second = makeLeaf();
      h.workspace.getLeavesOfType.mockReturnValue([]);
      h.workspace.getLeaf.mockReturnValueOnce(first).mockReturnValueOnce(second);

      await h.service.activateView();

      expect(h.workspace.getLeaf).toHaveBeenCalledWith("tab");
      expect(first.setViewState).toHaveBeenCalledWith({
        type: WB,
        active: true,
      });
      expect(h.workspace.revealLeaf).toHaveBeenCalledWith(first);

      // view was closed in between (getLeavesOfType keeps returning [])
      await h.service.activateView();

      expect(h.workspace.getLeaf).toHaveBeenCalledTimes(2);
      expect(h.workspace.revealLeaf).toHaveBeenLastCalledWith(second);
      expect(second).not.toBe(first); // fresh instance, state not restored
    });

    it("falls back to getLeaf(true) when getLeaf('tab') throws", async () => {
      const h = createHarness();
      const fallback = makeLeaf();
      h.workspace.getLeavesOfType.mockReturnValue([]);
      h.workspace.getLeaf.mockImplementation((kind?: unknown) => {
        if (kind === "tab") {
          throw new Error("cannot open tab");
        }
        return fallback;
      });

      await expect(h.service.activateView()).resolves.toBeUndefined();

      expect(h.workspace.getLeaf).toHaveBeenCalledWith("tab");
      expect(h.workspace.getLeaf).toHaveBeenCalledWith(true);
      expect(fallback.setViewState).toHaveBeenCalledWith({
        type: WB,
        active: true,
      });
      expect(h.workspace.revealLeaf).toHaveBeenCalledWith(fallback);
    });

    it("Gantt and Workbench use separate view leaves managed by Obsidian tabs", async () => {
      const h = createHarness();
      const wbLeaf = makeLeaf();
      const ganttLeaf = makeLeaf();
      h.workspace.getLeavesOfType.mockImplementation((type: string) => {
        if (type === WB) return [wbLeaf];
        if (type === GANTT) return [ganttLeaf];
        return [];
      });

      await h.service.activateView();
      await h.service.activateGanttView();

      expect(h.workspace.getLeavesOfType).toHaveBeenCalledWith(GANTT);
      expect(ganttLeaf.setViewState).toHaveBeenCalledWith({
        type: GANTT,
        active: true,
      });
      expect(h.workspace.revealLeaf).toHaveBeenCalledWith(wbLeaf);
      expect(h.workspace.revealLeaf).toHaveBeenCalledWith(ganttLeaf);
      // no new leaves created: both views live in their own tabs
      expect(h.workspace.getLeaf).not.toHaveBeenCalled();
    });
  });

  describe("openTaskFinder", () => {
    it("loads all tasks, flattens parents and subtasks, and opens the finder modal", async () => {
      const h = createHarness();
      const parent = await createTask(h.vault, h.settings, "Parent One");
      await addSubtask(h.vault, h.settings, parent, "Child Task");

      let modal: any;
      const openSpy = vi
        .spyOn(TaskFinderModal.prototype, "open")
        .mockImplementation(function (this: any) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          modal = this;
        });

      await h.service.openTaskFinder();

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(Array.isArray(modal.items)).toBe(true);
      expect(modal.items).toHaveLength(2);
      const kinds = modal.items.map((row: TaskRow) => row.kind).sort();
      expect(kinds).toEqual(["parent", "subtask"]);
      const titles = modal.items.map((row: TaskRow) => row.title).sort();
      expect(titles).toEqual(["Child Task", "Parent One"]);
    });

    it("loadTasks failures propagate and the dialog is never opened", async () => {
      const h = createHarness();
      const brokenVault = {
        getFiles: vi.fn(() => {
          throw new Error("vault listing failed");
        }),
        getFileByPath: vi.fn(() => null),
        create: vi.fn(),
        modify: vi.fn(),
        read: vi.fn(),
      } as unknown as VaultAdapter;
      const service = new NavigationService(
        // reuse the host from the harness but swap the vault factory
        (h.service as any).host,
        () => brokenVault,
        WB,
        GANTT
      );
      const openSpy = vi
        .spyOn(TaskFinderModal.prototype, "open")
        .mockImplementation(() => undefined);

      await expect(service.openTaskFinder()).rejects.toThrow(
        "vault listing failed"
      );
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("a task folder whose listing fails surfaces as a propagated loadTasks error", async () => {
      const h = createHarness();
      const brokenVault = {
        getFiles: vi.fn(() => {
          throw new Error("task folder missing");
        }),
        getFileByPath: vi.fn(() => null),
        create: vi.fn(),
        modify: vi.fn(),
        read: vi.fn(),
      } as unknown as VaultAdapter;
      const service = new NavigationService(
        (h.service as any).host,
        () => brokenVault,
        WB,
        GANTT
      );

      await expect(service.openTaskFinder()).rejects.toThrow(
        "task folder missing"
      );
    });
  });

  describe("openTaskItem", () => {
    it("subtasks open through a filename#heading anchor link", async () => {
      const h = createHarness();
      const subtask = makeRow({
        kind: "subtask",
        id: "tasks/2026/07/2026-07-29 Parent.md::child",
        key: "child",
        file: {
          path: "tasks/2026/07/2026-07-29 Parent.md",
          parentPath: "tasks/2026/07/2026-07-29 Parent.md",
          heading: "Sub One",
        },
        title: "Sub One",
        displayName: "Sub One",
      });

      await h.service.openTaskItem(subtask);

      expect(h.workspace.openLinkText).toHaveBeenCalledTimes(1);
      expect(h.workspace.openLinkText).toHaveBeenCalledWith(
        "2026-07-29 Parent#Sub One",
        "tasks/2026/07/2026-07-29 Parent.md"
      );
      // link jump succeeded — no leaf fallback happened
      expect(h.workspace.getMostRecentLeaf).not.toHaveBeenCalled();
      expect(h.workspace.getLeaf).not.toHaveBeenCalled();
    });

    it("a failed link jump is caught and falls back to opening the parent file", async () => {
      const h = createHarness();
      h.workspace.openLinkText.mockRejectedValue(new Error("heading not found"));
      const recent = makeLeaf();
      h.workspace.getMostRecentLeaf.mockReturnValue(recent);
      const subtask = makeRow({
        kind: "subtask",
        id: "tasks/a.md::child",
        key: "child",
        file: { path: "tasks/a.md", parentPath: "tasks/a.md", heading: "Gone" },
        title: "Gone",
        displayName: "Gone",
      });

      await expect(h.service.openTaskItem(subtask)).resolves.toBeUndefined();

      expect(h.workspace.openLinkText).toHaveBeenCalledTimes(1);
      expect(recent.openFile).toHaveBeenCalledTimes(1);
      expect(recent.openFile).toHaveBeenCalledWith(subtask.file);
    });

    it("parent tasks open in the most recently used leaf", async () => {
      const h = createHarness();
      const recent = makeLeaf();
      h.workspace.getMostRecentLeaf.mockReturnValue(recent);
      const parent = makeRow({});

      await h.service.openTaskItem(parent);

      expect(h.workspace.getMostRecentLeaf).toHaveBeenCalledTimes(1);
      expect(h.workspace.getLeaf).not.toHaveBeenCalled();
      expect(recent.openFile).toHaveBeenCalledWith(parent.file);
    });

    it("resolves the real TFile by path instead of handing Obsidian the plain {path,...} row object", async () => {
      const h = createHarness();
      const recent = makeLeaf();
      h.workspace.getMostRecentLeaf.mockReturnValue(recent);
      const realFile = Object.assign(new TFile(), { path: "tasks/a.md" });
      h.vaultStub.getAbstractFileByPath.mockReturnValue(realFile);
      const parent = makeRow({});

      await h.service.openTaskItem(parent);

      expect(h.vaultStub.getAbstractFileByPath).toHaveBeenCalledWith(
        "tasks/a.md"
      );
      expect(recent.openFile).toHaveBeenCalledWith(realFile);
      expect(recent.openFile).not.toHaveBeenCalledWith(parent.file);
    });

    it("creates a new leaf when no recent leaf exists", async () => {
      const h = createHarness();
      const fresh = makeLeaf();
      h.workspace.getMostRecentLeaf.mockReturnValue(null);
      h.workspace.getLeaf.mockReturnValue(fresh);
      const parent = makeRow({});

      await h.service.openTaskItem(parent);

      expect(h.workspace.getLeaf).toHaveBeenCalledWith(true);
      expect(fresh.openFile).toHaveBeenCalledWith(parent.file);
    });

    it("passes the row file to openFile", async () => {
      const h = createHarness();
      const fresh = makeLeaf();
      h.workspace.getMostRecentLeaf.mockReturnValue(null);
      h.workspace.getLeaf.mockReturnValue(fresh);
      const broken = makeRow({ file: undefined });

      // compiles thanks to the item.file! assertion; at runtime
      // openFile receives undefined — error or no-op is up to Obsidian
      await expect(h.service.openTaskItem(broken)).resolves.toBeUndefined();

      expect(fresh.openFile).toHaveBeenCalledWith(undefined);
    });

    it("openFile failures propagate uncaptured", async () => {
      const h = createHarness();
      const recent = makeLeaf();
      recent.openFile.mockRejectedValue(new Error("open failed"));
      h.workspace.getMostRecentLeaf.mockReturnValue(recent);

      await expect(h.service.openTaskItem(makeRow({}))).rejects.toThrow(
        "open failed"
      );
    });
  });
});
