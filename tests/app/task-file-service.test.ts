/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { TaskFileService, PromptFn } from "../../src/app/task-file-service";
import { createTask } from "../../src/app/task-operations";
import { FakeVault } from "./fake-vault";
import { TaskWorkbenchSettings } from "../../src/core/types";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn() };
});

const NoticeMock = Notice as unknown as Mock;

/** Scripted prompt: returns queued answers in order. */
function scriptedPrompt(answers: Array<string | null>): PromptFn & {
  calls: number;
} {
  const fn = (async () => {
    fn.calls += 1;
    return answers.shift() ?? null;
  }) as PromptFn & { calls: number };
  fn.calls = 0;
  return fn;
}

describe("TaskFileService", () => {
  let vault: FakeVault;
  let settings: TaskWorkbenchSettings;
  let service: TaskFileService;
  let openFile: Mock;
  let getLeaf: Mock;
  let app: App;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    vault = new FakeVault();
    settings = { ...DEFAULT_SETTINGS };
    service = new TaskFileService();
    NoticeMock.mockClear();

    openFile = vi.fn().mockResolvedValue(undefined);
    getLeaf = vi.fn(() => ({ openFile }));
    app = {
      vault: {
        getAbstractFileByPath: (path: string) => {
          if (!vault.getFileByPath(path)) {
            return null;
          }
          const f = new TFile();
          f.path = path;
          return f;
        },
      },
      workspace: { getLeaf },
    } as unknown as App;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vault.clear();
    vi.useRealTimers();
  });

  describe("createTaskInteractively", () => {
    it("opens the prompt (modal) for name input", async () => {
      const prompt = scriptedPrompt(["My Task"]);

      await service.createTaskInteractively(app, vault, settings, prompt);

      expect(prompt.calls).toBe(1);
    });

    it("re-prompts while the name is empty or whitespace-only", async () => {
      const prompt = scriptedPrompt(["", "   ", "Real Name"]);

      const task = await service.createTaskInteractively(
        app,
        vault,
        settings,
        prompt
      );

      expect(prompt.calls).toBe(3);
      expect(task?.displayName).toBe("Real Name");
    });

    it("cancellation returns null and creates nothing", async () => {
      const prompt = scriptedPrompt([null]);

      const task = await service.createTaskInteractively(
        app,
        vault,
        settings,
        prompt
      );

      expect(task).toBeNull();
      expect(vault.getCreateCallCount()).toBe(0);
    });

    it("creates the managed task file on disk", async () => {
      const prompt = scriptedPrompt(["Disk Task"]);

      await service.createTaskInteractively(app, vault, settings, prompt);

      expect(vault.getCreateCallCount()).toBe(1);
      const content = vault.getFileContent(
        "tasks/2026/07/2026-07-29 Disk Task.md"
      );
      expect(content).toContain("type: task");
      expect(content).toContain("# Disk Task");
    });

    it("displays a creation notification", async () => {
      const prompt = scriptedPrompt(["Notified Task"]);

      await service.createTaskInteractively(app, vault, settings, prompt);

      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Notified Task")
      );
    });

    it("opens the created file automatically in a new leaf", async () => {
      const prompt = scriptedPrompt(["Opened Task"]);

      await service.createTaskInteractively(app, vault, settings, prompt);

      expect(getLeaf).toHaveBeenCalledWith(true);
      expect(openFile).toHaveBeenCalledTimes(1);
      const opened = openFile.mock.calls[0][0] as TFile;
      expect(opened.path).toBe("tasks/2026/07/2026-07-29 Opened Task.md");
    });

    it("invokes the completion callback with the created task", async () => {
      const prompt = scriptedPrompt(["Callback Task"]);
      const onCreated = vi.fn();

      await service.createTaskInteractively(
        app,
        vault,
        settings,
        prompt,
        onCreated
      );

      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated.mock.calls[0][0].displayName).toBe("Callback Task");
    });
  });

  describe("addSubtaskInteractively", () => {
    it("adds the subtask under the given explicit parent row and writes it", async () => {
      const parent = await createTask(vault, settings, "Explicit Parent");
      const prompt = scriptedPrompt(["Sub Via Row"]);

      const subtask = await service.addSubtaskInteractively(
        app,
        vault,
        settings,
        parent,
        prompt
      );

      expect(subtask?.displayName).toBe("Sub Via Row");
      const content = vault.getFileContent(parent.file.path) as string;
      expect(content).toContain("### Sub Via Row");
      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Sub Via Row")
      );
    });

    it("re-prompts on empty subtask names and honours cancellation", async () => {
      const parent = await createTask(vault, settings, "Reprompt Parent");
      const prompt = scriptedPrompt(["  ", null]);

      const subtask = await service.addSubtaskInteractively(
        app,
        vault,
        settings,
        parent,
        prompt
      );

      expect(prompt.calls).toBe(2);
      expect(subtask).toBeNull();
    });

    it("opens the parent file after creation and invokes onCreated", async () => {
      const parent = await createTask(vault, settings, "Open Parent");
      const prompt = scriptedPrompt(["Sub Opens Parent"]);
      const onCreated = vi.fn();

      await service.addSubtaskInteractively(
        app,
        vault,
        settings,
        parent,
        prompt,
        onCreated
      );

      expect(getLeaf).toHaveBeenCalledWith(true);
      expect(openFile).toHaveBeenCalledTimes(1);
      const opened = openFile.mock.calls[0][0] as TFile;
      expect(opened.path).toBe(parent.file.path);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated.mock.calls[0][0].displayName).toBe(
        "Sub Opens Parent"
      );
    });
  });

  describe("addSubtaskToCurrentFileInteractively", () => {
    async function createManagedParent(name: string): Promise<string> {
      const row = await createTask(vault, settings, name);
      return row.file.path;
    }

    it("adds the subtask to a managed current file and writes it", async () => {
      const parentPath = await createManagedParent("Parent Task");
      const prompt = scriptedPrompt(["Sub One"]);

      const subtask = await service.addSubtaskToCurrentFileInteractively(
        app,
        vault,
        settings,
        parentPath,
        prompt
      );

      expect(subtask?.displayName).toBe("Sub One");
      const content = vault.getFileContent(parentPath) as string;
      expect(content).toContain("### Sub One");
      expect(content).toContain("subtaskOrder: [sub-one]");
      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Sub One")
      );
    });

    it("re-prompts on empty subtask names and honours cancellation", async () => {
      const parentPath = await createManagedParent("Parent Task");
      const prompt = scriptedPrompt(["  ", null]);

      const subtask = await service.addSubtaskToCurrentFileInteractively(
        app,
        vault,
        settings,
        parentPath,
        prompt
      );

      expect(prompt.calls).toBe(2);
      expect(subtask).toBeNull();
      const content = vault.getFileContent(parentPath) as string;
      expect(content).not.toContain("## Subtasks");
    });

    it("shows an error for a non-managed file and writes nothing", async () => {
      await vault.create("notes/random.md", "# just a note\n");
      const prompt = scriptedPrompt(["Never Asked"]);

      const result = await service.addSubtaskToCurrentFileInteractively(
        app,
        vault,
        settings,
        "notes/random.md",
        prompt
      );

      expect(result).toBeNull();
      expect(prompt.calls).toBe(0);
      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("管理下")
      );
      expect(vault.getModifyCallCount()).toBe(0);
    });

    it("shows the same error when the file does not exist", async () => {
      const prompt = scriptedPrompt(["Never Asked"]);

      const result = await service.addSubtaskToCurrentFileInteractively(
        app,
        vault,
        settings,
        "missing.md",
        prompt
      );

      expect(result).toBeNull();
      expect(prompt.calls).toBe(0);
      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("管理下")
      );
    });
  });
});
