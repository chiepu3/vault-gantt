import { TFile } from "obsidian";
import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  HistoryManager,
  type HistoryEntry,
  type HistoryFileChange,
} from "../../src/app/history-manager";

class ProcessFakeVault {
  private readonly files = new Map<string, TFile>();
  private readonly contents = new Map<string, string>();
  private readonly processAttempts = new Map<string, number>();
  private readonly failures = new Map<string, Set<number>>();
  private readonly driftOnNextProcess = new Map<string, string>();
  readonly processCalls: string[] = [];

  seed(path: string, content: string): void {
    const file = new TFile();
    file.path = path;
    this.files.set(path, file);
    this.contents.set(path, content);
  }

  failOnProcess(path: string, attempt: number): void {
    const attempts = this.failures.get(path) ?? new Set<number>();
    attempts.add(attempt);
    this.failures.set(path, attempts);
  }

  /**
 * Simulates an external write landing in the gap between this manager's
 * preflight read and its later process call for the same file: the
 * NEXT process call for `path` sees `driftedContent` as "current",
 * diverging from whatever preflight already saw. This is what actually
 * exercises production's own in-callback guard
 * (`if (current !== prepared.expected) throw`) rather than short-circuiting
 * before that guard ever runs, unlike failOnProcess.
 */
  driftBeforeNextProcess(path: string, driftedContent: string): void {
    this.driftOnNextProcess.set(path, driftedContent);
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  async read(file: TFile): Promise<string> {
    const content = this.contents.get(file.path);
    if (content === undefined) {
      throw new Error(`ファイルが見つかりません: ${file.path}`);
    }
    return content;
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const drift = this.driftOnNextProcess.get(file.path);
    if (drift !== undefined) {
      this.driftOnNextProcess.delete(file.path);
      this.contents.set(file.path, drift);
    }

    const current = await this.read(file);
    const attempt = (this.processAttempts.get(file.path) ?? 0) + 1;
    this.processAttempts.set(file.path, attempt);
    this.processCalls.push(file.path);

    if (this.failures.get(file.path)?.has(attempt)) {
      throw new Error(`書き込み失敗: ${file.path}`);
    }

    const updated = fn(current);
    this.contents.set(file.path, updated);
    return updated;
  }

  getContent(path: string): string | undefined {
    return this.contents.get(path);
  }

  asVault(): Vault {
    return this as unknown as Vault;
  }
}

function makeChange(
  path: string,
  before = "before",
  after = "after"
): HistoryFileChange {
  return { path, before, after };
}

function makeEntry(label: string, files: HistoryFileChange[] = [makeChange("task.md")]): HistoryEntry {
  return { label, files };
}

describe("HistoryManager", () => {
  it("push appends entries and clears the redo stack", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("task.md", "after");

    manager.push(makeEntry("最初の編集"));
    expect(manager.peekUndoLabel()).toBe("最初の編集");
    expect(manager.peekRedoLabel()).toBeUndefined();

    await manager.undo(vault.asVault());
    expect(manager.peekRedoLabel()).toBe("最初の編集");

    manager.push(makeEntry("新しい編集"));
    expect(manager.peekUndoLabel()).toBe("新しい編集");
    expect(manager.canRedo()).toBe(false);
  });

  it("evicts the oldest entries after exceeding the 50-entry cap", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();

    for (let index = 0; index < 51; index += 1) {
      const path = `task-${index}.md`;
      vault.seed(path, `after-${index}`);
      manager.push(makeEntry(`操作${index}`, [makeChange(path, `before-${index}`, `after-${index}`)]));
    }

    for (let index = 50; index >= 1; index -= 1) {
      const result = await manager.undo(vault.asVault());
      expect(result).toEqual({ kind: "success", label: `操作${index}` });
    }
    expect(manager.canUndo()).toBe(false);
    expect(manager.canRedo()).toBe(true);
    expect(manager.peekRedoLabel()).toBe("操作1");
  });

  it("evicts oldest entries when the total content budget is exceeded", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    const largeContent = "x".repeat(7 * 1024 * 1024);

    vault.seed("large.md", largeContent);
    manager.push(makeEntry("古い大容量操作", [makeChange("large.md", "", largeContent)]));
    manager.push(makeEntry("新しい大容量操作", [makeChange("large.md", "", largeContent)]));

    const result = await manager.undo(vault.asVault());
    expect(result).toEqual({ kind: "success", label: "新しい大容量操作" });
    expect(manager.canUndo()).toBe(false);
  });

  it("keeps the newly pushed entry even when it alone exceeds the total budget", () => {
    const manager = new HistoryManager();
    const oversizedContent = "x".repeat(12 * 1024 * 1024 + 1);

    manager.push(
      makeEntry("予算超過操作", [makeChange("large.md", "", oversizedContent)])
    );

    expect(manager.canUndo()).toBe(true);
    expect(manager.peekUndoLabel()).toBe("予算超過操作");
  });

  it("clear empties both undo and redo stacks", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("task.md", "after");

    manager.push(makeEntry("編集"));
    await manager.undo(vault.asVault());
    expect(manager.canRedo()).toBe(true);

    manager.clear();
    expect(manager.canUndo()).toBe(false);
    expect(manager.canRedo()).toBe(false);
    expect(manager.peekUndoLabel()).toBeUndefined();
    expect(manager.peekRedoLabel()).toBeUndefined();
  });

  it("undo on an empty undo stack returns empty without changing redo", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("task.md", "after");

    manager.push(makeEntry("編集"));
    await manager.undo(vault.asVault());
    const result = await manager.undo(vault.asVault());

    expect(result).toEqual({ kind: "empty" });
    expect(manager.peekRedoLabel()).toBe("編集");
  });

  it("undo swaps one file and moves the entry to redo", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("task.md", "after");
    manager.push(makeEntry("単一ファイル編集"));

    const result = await manager.undo(vault.asVault());

    expect(result).toEqual({ kind: "success", label: "単一ファイル編集" });
    expect(vault.getContent("task.md")).toBe("before");
    expect(vault.processCalls).toEqual(["task.md"]);
    expect(manager.canUndo()).toBe(false);
    expect(manager.peekRedoLabel()).toBe("単一ファイル編集");
  });

  it("undo swaps every file in a multi-file entry", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("a.md", "a-after");
    vault.seed("b.md", "b-after");
    manager.push(
      makeEntry("複数ファイル編集", [
        makeChange("a.md", "a-before", "a-after"),
        makeChange("b.md", "b-before", "b-after"),
      ])
    );

    const result = await manager.undo(vault.asVault());

    expect(result).toEqual({ kind: "success", label: "複数ファイル編集" });
    expect(vault.getContent("a.md")).toBe("a-before");
    expect(vault.getContent("b.md")).toBe("b-before");
    expect(vault.processCalls).toEqual(["a.md", "b.md"]);
  });

  it("undo preflight conflict writes nothing and leaves the entry in undo", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("a.md", "a-after");
    vault.seed("b.md", "外部変更");
    manager.push(
      makeEntry("競合する編集", [
        makeChange("a.md", "a-before", "a-after"),
        makeChange("b.md", "b-before", "b-after"),
      ])
    );

    const result = await manager.undo(vault.asVault());

    expect(result).toEqual({
      kind: "conflict",
      label: "競合する編集",
      conflictingPaths: ["b.md"],
    });
    expect(vault.getContent("a.md")).toBe("a-after");
    expect(vault.getContent("b.md")).toBe("外部変更");
    expect(vault.processCalls).toEqual([]);
    expect(manager.peekUndoLabel()).toBe("競合する編集");
    expect(manager.canRedo()).toBe(false);
  });

  it("undo compensates already swapped files after a later process failure", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("a.md", "a-after");
    vault.seed("b.md", "b-after");
    vault.failOnProcess("b.md", 1);
    manager.push(
      makeEntry("途中失敗編集", [
        makeChange("a.md", "a-before", "a-after"),
        makeChange("b.md", "b-before", "b-after"),
      ])
    );

    const result = await manager.undo(vault.asVault());

    expect(result).toEqual({
      kind: "conflict",
      label: "途中失敗編集",
      conflictingPaths: ["b.md"],
    });
    expect(vault.getContent("a.md")).toBe("a-after");
    expect(vault.getContent("b.md")).toBe("b-after");
    expect(vault.processCalls).toEqual(["a.md", "b.md", "a.md"]);
    expect(manager.peekUndoLabel()).toBe("途中失敗編集");
  });

  it("process()'s own in-callback guard rejects content that drifted after preflight passed", async () => {
    // Unlike failOnProcess (which short-circuits process before it ever
    // calls the real callback), this drives an actual mismatch through the
    // production `if (current !== prepared.expected) throw` guard inside
    // history-manager.ts's own process callback, simulating a write
    // landing in the gap between this manager's preflight read and its
    // later process call for the same file.
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("task.md", "after");
    manager.push(makeEntry("競合編集", [makeChange("task.md", "before", "after")]));

    vault.driftBeforeNextProcess("task.md", "外部から書き換わった内容");

    const result = await manager.undo(vault.asVault());

    expect(result).toEqual({
      kind: "conflict",
      label: "競合編集",
      conflictingPaths: ["task.md"],
    });
    expect(vault.getContent("task.md")).toBe("外部から書き換わった内容");
    expect(manager.peekUndoLabel()).toBe("競合編集");
    expect(manager.canRedo()).toBe(false);
  });

  it("invalidates all history when compensation fails", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("a.md", "a-after");
    vault.seed("b.md", "b-after");
    vault.failOnProcess("b.md", 1);
    vault.failOnProcess("a.md", 2);
    manager.push(
      makeEntry("補償失敗編集", [
        makeChange("a.md", "a-before", "a-after"),
        makeChange("b.md", "b-before", "b-after"),
      ])
    );

    const result = await manager.undo(vault.asVault());

    expect(result.kind).toBe("invalidated");
    expect(result).toMatchObject({ label: "補償失敗編集" });
    if (result.kind === "invalidated") {
      expect(result.reason).toContain("a.md");
    }
    expect(manager.canUndo()).toBe(false);
    expect(manager.canRedo()).toBe(false);
  });

  it("redo swaps content back after a successful undo", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("task.md", "after");
    manager.push(makeEntry("編集のやり直し"));

    await manager.undo(vault.asVault());
    const result = await manager.redo(vault.asVault());

    expect(result).toEqual({ kind: "success", label: "編集のやり直し" });
    expect(vault.getContent("task.md")).toBe("after");
    expect(manager.peekUndoLabel()).toBe("編集のやり直し");
    expect(manager.canRedo()).toBe(false);
  });

  it("a fresh push after undo clears redo so redo returns empty", async () => {
    const manager = new HistoryManager();
    const vault = new ProcessFakeVault();
    vault.seed("first.md", "first-after");
    vault.seed("second.md", "second-after");

    manager.push(makeEntry("最初の編集", [makeChange("first.md", "first-before", "first-after")]));
    await manager.undo(vault.asVault());
    manager.push(makeEntry("新しい編集", [makeChange("second.md", "second-before", "second-after")]));

    const result = await manager.redo(vault.asVault());

    expect(result).toEqual({ kind: "empty" });
    expect(manager.peekUndoLabel()).toBe("新しい編集");
    expect(manager.peekRedoLabel()).toBeUndefined();
  });
});
