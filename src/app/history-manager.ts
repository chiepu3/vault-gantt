import type { TFile, Vault } from "obsidian";

export interface HistoryFileChange {
  path: string;
  before: string;
  after: string;
}

export interface HistoryEntry {
  label: string;
  files: HistoryFileChange[];
}

export type HistoryOpResult =
  | { kind: "empty" }
  | { kind: "success"; label: string }
  | { kind: "conflict"; label: string; conflictingPaths: string[] }
  | { kind: "invalidated"; label: string; reason: string };

type HistoryContentField = "before" | "after";

interface PreparedFileChange {
  change: HistoryFileChange;
  vaultFile: TFile;
  expected: string;
  target: string;
}

type PendingMutation =
  | { kind: "clear" }
  | { kind: "discardRedo" }
  | { kind: "push"; entry: HistoryEntry };

/**
 * In-memory undo/redo history for coordinated Markdown file changes.
 *
 * Disk writes are deliberately kept out of push; callers record a completed
 * mutation and invoke undo/redo only when the user requests it.
 */
export class HistoryManager {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly maxEntries = 50;
  private readonly maxTotalBytes = 12 * 1024 * 1024;
  private operationTail: Promise<void> = Promise.resolve();
  private operationDepth = 0;
  private readonly pendingMutations: PendingMutation[] = [];

  /**
 * Records a completed action and invalidates any redo actions from the old
 * timeline.
 *
 * Defensively copies `entry` (and each file change within it): callers
 * build these from live batch-update state, and if a caller later reused
 * or mutated the same object/array after calling push, an entry already
 * sitting on undoStack/redoStack would silently change retroactively —
 * corruption that would only surface much later as a wrong-content undo.
 */
  push(entry: HistoryEntry): void {
    const files = entry.files.filter((file) => file.before !== file.after);
    if (files.length === 0) {
      return;
    }

    const clonedEntry: HistoryEntry = {
      label: entry.label,
      files: files.map((file) => ({ ...file })),
    };

    if (this.operationDepth > 0) {
      this.pendingMutations.push({ kind: "push", entry: clonedEntry });
      return;
    }

    this.pushEntry(clonedEntry);
  }

  private pushEntry(entry: HistoryEntry): void {
    this.redoStack.length = 0;
    this.undoStack.push(entry);

    while (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift();
    }

    let totalBytes = this.getUndoStackBytes();
    while (totalBytes > this.maxTotalBytes && this.undoStack.length > 1) {
      this.undoStack.shift();
      totalBytes = this.getUndoStackBytes();
    }
  }

  /** Clears history when untracked changes make it unsafe to apply. */
  clear(): void {
    if (this.operationDepth > 0) {
      this.pendingMutations.push({ kind: "clear" });
      return;
    }

    this.clearNow();
  }

  /** New file creation is not undoable, but must invalidate the old redo timeline. */
  discardRedo(): void {
    if (this.operationDepth > 0) {
      this.pendingMutations.push({ kind: "discardRedo" });
      return;
    }
    this.redoStack.length = 0;
  }

  private clearNow(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peekUndoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  peekRedoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  undo(vault: Vault): Promise<HistoryOpResult> {
    return this.serialize(async () => {
      if (this.undoStack.length === 0) {
        return { kind: "empty" };
      }

      const entry = this.undoStack[this.undoStack.length - 1];
      const result = await this.applyDirectional(
        vault,
        entry,
        "after",
        "before"
      );
      if (result.kind === "success") {
        this.undoStack.pop();
        this.redoStack.push(entry);
      }
      return result;
    });
  }

  redo(vault: Vault): Promise<HistoryOpResult> {
    return this.serialize(async () => {
      if (this.redoStack.length === 0) {
        return { kind: "empty" };
      }

      const entry = this.redoStack[this.redoStack.length - 1];
      const result = await this.applyDirectional(
        vault,
        entry,
        "before",
        "after"
      );
      if (result.kind === "success") {
        this.redoStack.pop();
        this.undoStack.push(entry);
      }
      return result;
    });
  }

  /**
   * Obsidian UI buttons can be clicked again while a Vault operation is still
   * pending. Keep undo/redo transitions in invocation order so two requests
   * cannot preflight the same content and then race their writes.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.operationDepth += 1;
    const run = this.operationTail.then(
      async () => {
        try {
          return await operation();
        } finally {
          this.finishOperation();
        }
      },
      async () => {
        try {
          return await operation();
        } finally {
          this.finishOperation();
        }
      }
    );
    this.operationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private finishOperation(): void {
    this.operationDepth -= 1;
    const pendingMutations = this.pendingMutations.splice(0);
    for (const mutation of pendingMutations) {
      if (mutation.kind === "clear") {
        this.clearNow();
      } else if (mutation.kind === "discardRedo") {
        this.redoStack.length = 0;
      } else {
        this.pushEntry(mutation.entry);
      }
    }
  }

  private getUndoStackBytes(): number {
    // String.length counts UTF-16 code units, not UTF-8 bytes. That is a fine
    // approximation for this memory cap because task notes are typically a few KB.
    return this.undoStack.reduce(
      (entryTotal, entry) =>
        entryTotal +
        entry.files.reduce(
          (fileTotal, file) => fileTotal + file.before.length + file.after.length,
          0
        ),
      0
    );
  }

  private async applyDirectional(
    vault: Vault,
    entry: HistoryEntry,
    expectField: HistoryContentField,
    targetField: HistoryContentField
  ): Promise<HistoryOpResult> {
    const preparedFiles: PreparedFileChange[] = [];
    const conflictingPaths: string[] = [];

    for (const change of entry.files) {
      const vaultFile = vault.getFileByPath(change.path);
      if (!vaultFile) {
        conflictingPaths.push(change.path);
        continue;
      }

      let current: string;
      try {
        current = await vault.read(vaultFile);
      } catch (_error: unknown) {
        conflictingPaths.push(change.path);
        continue;
      }

      const expected = change[expectField];
      if (current !== expected) {
        conflictingPaths.push(change.path);
      }
      preparedFiles.push({
        change,
        vaultFile,
        expected,
        target: change[targetField],
      });
    }

    if (conflictingPaths.length > 0) {
      return {
        kind: "conflict",
        label: entry.label,
        conflictingPaths,
      };
    }

    const appliedFiles: PreparedFileChange[] = [];
    let failedPath: string | undefined;
    try {
      for (const prepared of preparedFiles) {
        failedPath = prepared.change.path;
        await vault.process(prepared.vaultFile, (current) => {
          if (current !== prepared.expected) {
            throw new Error(
              `履歴適用前提が一致しません: ${prepared.change.path}`
            );
          }
          return prepared.target;
        });
        appliedFiles.push(prepared);
      }
    } catch (error: unknown) {
      for (let index = appliedFiles.length - 1; index >= 0; index -= 1) {
        const applied = appliedFiles[index];
        try {
          await vault.process(applied.vaultFile, (current) => {
            if (current !== applied.target) {
              throw new Error(
                `履歴適用の補償前提が一致しません: ${applied.change.path}`
              );
            }
            return applied.expected;
          });
        } catch (compensationError: unknown) {
          this.clear();
          return {
            kind: "invalidated",
            label: entry.label,
            reason: `履歴の補償に失敗しました（${applied.change.path}）: ${this.getErrorMessage(
              compensationError
            )}`,
          };
        }
      }

      return {
        kind: "conflict",
        label: entry.label,
        conflictingPaths: [failedPath ?? this.getFallbackPath(entry)],
      };
    }

    return { kind: "success", label: entry.label };
  }

  private getFallbackPath(entry: HistoryEntry): string {
    return entry.files[0]?.path ?? "（対象ファイルなし）";
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
