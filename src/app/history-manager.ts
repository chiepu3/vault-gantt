import type { HistoryPort, HistoryChangeV1, HistoryEntryUndoStateV1 } from "../contracts/ports";
import type { VaultAdapter } from "./task-operations";

/**
 * One note's change. `before`/`after` are the whole note text; null = the note did not exist
 * (a creation) / does not exist any more (a deletion). `afterPath` is where the note lives after
 * the change when it was renamed (`path` is where it lived before).
 */
export interface HistoryFileChange {
  path: string;
  before: string | null;
  after: string | null;
  afterPath?: string;
}

/** What undo/redo need from the vault. rename/create/trash are only needed for entries that use them. */
export interface HistoryVault {
  getFileByPath(path: string): HistoryFile | null;
  read(file: HistoryFile): Promise<string>;
  process?(file: HistoryFile, transform: (content: string) => string): Promise<string>;
  create?(path: string, content: string): Promise<unknown>;
  rename?(path: string, newPath: string): Promise<void>;
  trash?(file: HistoryFile): Promise<void>;
}
export type HistoryFile = { path: string };

/** Gantt parent order (kept in plugin settings, not in notes) before/after an action. */
export interface HistoryOrderChange {
  before: string[];
  after: string[];
}

export interface HistoryEntry {
  label: string;
  files: HistoryFileChange[];
  order?: HistoryOrderChange;
}

/** Access to the stored Gantt parent order, supplied by the plugin. */
export interface ParentOrderStore {
  get(): readonly string[] | undefined;
  set(order: string[]): Promise<void>;
}

const sameOrder = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b);

export type HistoryOpResult =
  | { kind: "empty" }
  | { kind: "success"; label: string }
  | { kind: "conflict"; label: string; conflictingPaths: string[] }
  | { kind: "invalidated"; label: string; reason: string };

type HistoryContentField = "before" | "after";

/**
 * A file change as retained in memory. Notes are large and an edit touches a small region, so when
 * `before` and `after` share a long prefix/suffix only `after` plus the differing middle of `before`
 * is kept; `before` is rebuilt exactly on demand. `size` is the logical before+after length (the cap unit).
 */
interface StoredFileChange {
  path: string;
  size: number;
  after: string | null;
  before?: string | null;
  afterPath?: string;
  patch?: { prefix: number; suffix: number; middle: string };
}
interface StoredEntry {
  label: string;
  files: StoredFileChange[];
  order?: HistoryOrderChange;
}
const MIN_COMPACT_LENGTH = 2048;
function compactChange(change: HistoryFileChange): StoredFileChange {
  const { path, before, after } = change, afterPath = change.afterPath !== undefined && change.afterPath !== path ? { afterPath: change.afterPath } : {};
  if (before === null || after === null) return { path, size: (before ?? "").length + (after ?? "").length, before, after, ...afterPath };
  const size = before.length + after.length;
  if (before.length + after.length < MIN_COMPACT_LENGTH) return { path, size, before, after, ...afterPath };
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  const middle = before.slice(prefix, before.length - suffix);
  if (middle.length * 2 >= before.length) return { path, size, before, after, ...afterPath };
  return { path, size, after, patch: { prefix, suffix, middle }, ...afterPath };
}
function beforeOf(change: StoredFileChange): string | null {
  if (!change.patch) return change.before ?? null;
  const { prefix, suffix, middle } = change.patch;
  const after = change.after!;
  return after.slice(0, prefix) + middle + after.slice(after.length - suffix);
}
function materialize(change: StoredFileChange): HistoryFileChange { return { path: change.path, before: beforeOf(change), after: change.after, ...(change.afterPath !== undefined ? { afterPath: change.afterPath } : {}) }; }

interface PreparedFileChange {
  change: HistoryFileChange;
  /** Where the note is now, and where it goes. */
  from: string;
  to: string;
  expected: string | null;
  target: string | null;
}

type PendingMutation =
  | { kind: "clear" }
  | { kind: "discardRedo" }
  | { kind: "push"; entry: StoredEntry };

/**
 * In-memory undo/redo history for coordinated Markdown file changes.
 *
 * Disk writes are deliberately kept out of push; callers record a completed
 * mutation and invoke undo/redo only when the user requests it.
 */
export class HistoryManager implements HistoryPort {
  private revision = 0;
  private readonly listeners = new Set<(change: HistoryChangeV1) => void>();
  private readonly conflicts = new Set<string>();
  private checking = false;
  private checkGeneration = 0;
  private vaultReader?: () => VaultAdapter;
  private orderStore?: ParentOrderStore;
  attachOrderStore(store: ParentOrderStore): void { this.orderStore = store; }
  attachVault(reader: () => VaultAdapter): void { this.vaultReader = reader; void this.refreshEligibility(); }
  subscribe(listener: (change: HistoryChangeV1) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  inspectUndo(entryId: string): HistoryEntryUndoStateV1 {
    const entry = this.undoStack.find((entry) => entry.label === entryId);
    const state = this.operationDepth > 0 || this.checking ? "busy" : !entry ? this.redoStack.some((entry) => entry.label === entryId) ? "already-undone" : "missing" : entry !== this.undoStack.at(-1) ? "not-latest" : this.conflicts.has(entryId) ? "conflict" : "available";
    return { entryId, historyRevision: `history-${this.revision}`, state, reason: state === "available" ? null : "履歴先頭・現在内容・操作状態を確認してください。" };
  }
  private notify(): void { this.revision++; for (const listener of this.listeners) { try { listener({ historyRevision: `history-${this.revision}`, changedEntryIds: null }); } catch { /* Detached subscriber. */ } } }
  /** True when `path` belongs to the newest undo entry, i.e. a change to it can alter undo eligibility. */
  touchesTopEntry(path: string): boolean { return !!this.undoStack.at(-1)?.files.some((change) => change.path === path || change.afterPath === path); }
  private eligibilityRun?: Promise<void>;
  private eligibilityNext?: Promise<void>;
  /**
   * Coalesces concurrent calls: at most one read pass runs at a time, and calls
   * made meanwhile share one follow-up pass that starts after they were made.
   */
  refreshEligibility(): Promise<void> {
    if (!this.vaultReader) return Promise.resolve();
    ++this.checkGeneration;
    this.checking = true; this.notify();
    if (this.eligibilityNext) return this.eligibilityNext;
    if (!this.eligibilityRun) return this.startEligibilityRun();
    const start = () => { this.eligibilityNext = undefined; return this.startEligibilityRun(); };
    return this.eligibilityNext = this.eligibilityRun.then(start, start);
  }
  private startEligibilityRun(): Promise<void> {
    const run: Promise<void> = this.runEligibilityCheck().finally(() => { if (this.eligibilityRun === run) this.eligibilityRun = undefined; });
    this.eligibilityRun = run;
    return run;
  }
  private async runEligibilityCheck(): Promise<void> {
    const generation = this.checkGeneration;
    const entry = this.undoStack.at(-1), vault = this.vaultReader!();
    let conflict = false;
    if (entry?.order && !(this.orderStore && sameOrder(this.orderStore.get(), entry.order.after))) conflict = true;
    if (entry) for (const change of entry.files) {
      try {
        const file = vault.getFileByPath(change.afterPath ?? change.path);
        if (change.after === null ? !!file : !file || await vault.read(file) !== change.after) conflict = true;
      } catch { conflict = true; }
    }
    if (generation !== this.checkGeneration) return;
    if (entry === this.undoStack.at(-1)) { if (entry) { if (conflict) this.conflicts.add(entry.label); else this.conflicts.delete(entry.label); } }
    this.checking = false; this.notify();
  }
  private readonly undoStack: StoredEntry[] = [];
  private readonly redoStack: StoredEntry[] = [];
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
    const order = entry.order && !sameOrder(entry.order.before, entry.order.after) ? entry.order : undefined;
    if (files.length === 0 && !order) {
      return;
    }

    const clonedEntry: StoredEntry = {
      label: entry.label,
      files: files.map(compactChange),
      ...(order ? { order: { before: [...order.before], after: [...order.after] } } : {}),
    };

    if (this.operationDepth > 0) {
      this.pendingMutations.push({ kind: "push", entry: clonedEntry });
      return;
    }

    this.pushEntry(clonedEntry);
  }

  private pushEntry(entry: StoredEntry): void {
    this.redoStack.length = 0;
    this.undoStack.push(entry);
    this.conflicts.delete(entry.label);

    while (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift();
    }

    let totalBytes = this.getUndoStackBytes();
    while (totalBytes > this.maxTotalBytes && this.undoStack.length > 1) {
      this.undoStack.shift();
      totalBytes = this.getUndoStackBytes();
    }
    for (const label of this.conflicts) if (!this.undoStack.some((entry) => entry.label === label) && !this.redoStack.some((entry) => entry.label === label)) this.conflicts.delete(label);
    this.notify();
    void this.refreshEligibility();
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
    this.conflicts.clear(); this.notify();
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

  /** Frozen read-only input for approval-based undo/redo; execution still uses undo/redo. */
  inspectTransition(direction: "undo" | "redo"): { historyRevision: string; busy: boolean; entry: HistoryEntry | null } {
    const stack = direction === "undo" ? this.undoStack : this.redoStack;
    const entry = stack[stack.length - 1];
    return { historyRevision: `history-${this.revision}`, busy: this.operationDepth > 0 || this.checking, entry: entry ? { label: entry.label, files: entry.files.map(materialize), ...(entry.order ? { order: { before: [...entry.order.before], after: [...entry.order.after] } } : {}) } : null };
  }

  undo(vault: HistoryVault): Promise<HistoryOpResult> {
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

  redo(vault: HistoryVault): Promise<HistoryOpResult> {
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
    this.notify();
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
    this.notify();
    void this.refreshEligibility();
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
        entry.files.reduce((fileTotal, file) => fileTotal + file.size, 0),
      0
    );
  }

  private async applyDirectional(
    vault: HistoryVault,
    entry: StoredEntry,
    expectField: HistoryContentField,
    targetField: HistoryContentField
  ): Promise<HistoryOpResult> {
    const preparedFiles: PreparedFileChange[] = [];
    const conflictingPaths: string[] = [];
    const orderChange = entry.order;
    if (orderChange && !(this.orderStore && sameOrder(this.orderStore.get(), orderChange[expectField]))) {
      conflictingPaths.push("Gantt並び順");
    }

    // "before" is the state the entry started from (undo goes there); moves are expressed from the current location.
    const undoing = targetField === "before";
    const claimed = new Set<string>();
    for (const stored of entry.files) {
      const change = materialize(stored);
      const original = change.path, moved = change.afterPath ?? change.path;
      const from = undoing ? moved : original, to = undoing ? original : moved;
      const expected = change[expectField], target = change[targetField];
      let ok = true;
      try {
        const vaultFile = vault.getFileByPath(from);
        if (expected === null) {
          if (vaultFile) ok = false;
        } else if (!vaultFile || await vault.read(vaultFile) !== expected) {
          ok = false;
        }
        // The destination must be free, unless the note stays where it is.
        if (ok && target !== null && (expected === null || to !== from) && (vault.getFileByPath(to) || claimed.has(to))) ok = false;
      } catch (_error: unknown) {
        ok = false;
      }
      if (!ok) conflictingPaths.push(expected === null ? to : from);
      claimed.add(to);
      preparedFiles.push({ change, from, to, expected, target });
    }

    if (conflictingPaths.length > 0) {
      return {
        kind: "conflict",
        label: entry.label,
        conflictingPaths,
      };
    }

    // Contents first, at the notes' current paths; then moves. Renaming last keeps Obsidian's own link
    // updates from touching notes whose text this step has not restored yet.
    const done: Array<() => Promise<void>> = [];
    let orderApplied = false;
    let failedPath: string | undefined;
    const needs = <K extends "process" | "create" | "rename" | "trash">(method: K): NonNullable<HistoryVault[K]> => {
      const fn = vault[method];
      if (!fn) throw new Error("この履歴の適用にはファイル操作が必要です");
      return fn.bind(vault) as NonNullable<HistoryVault[K]>;
    };
    try {
      if (orderChange) {
        failedPath = "Gantt並び順";
        await this.orderStore!.set([...orderChange[targetField]]);
        orderApplied = true;
      }
      for (const prepared of preparedFiles) {
        failedPath = prepared.from;
        const { from, expected, target } = prepared;
        if (expected !== null && target !== null) {
          const file = vault.getFileByPath(from)!;
          if (expected !== target) {
            await needs("process")(file, (current) => {
              if (current !== expected) throw new Error(`履歴適用前提が一致しません: ${from}`);
              return target;
            });
            done.push(async () => { await needs("process")(vault.getFileByPath(from)!, (current) => { if (current !== target) throw new Error(`履歴適用の補償前提が一致しません: ${from}`); return expected; }); });
          }
        } else if (expected !== null && target === null) {
          const file = vault.getFileByPath(from)!;
          await needs("trash")(file);
          done.push(async () => { await needs("create")(from, expected); });
        } else if (expected === null && target !== null) {
          failedPath = prepared.to;
          await needs("create")(prepared.to, target);
          done.push(async () => { const file = vault.getFileByPath(prepared.to); if (file) await needs("trash")(file); });
        }
      }
      for (const prepared of preparedFiles) {
        if (prepared.expected === null || prepared.target === null || prepared.from === prepared.to) continue;
        failedPath = prepared.from;
        await needs("rename")(prepared.from, prepared.to);
        done.push(async () => { await needs("rename")(prepared.to, prepared.from); });
      }
    } catch (error: unknown) {
      if (orderApplied && orderChange) {
        try {
          await this.orderStore!.set([...orderChange[expectField]]);
        } catch (compensationError: unknown) {
          this.clear();
          return {
            kind: "invalidated",
            label: entry.label,
            reason: `履歴の補償に失敗しました（Gantt並び順）: ${this.getErrorMessage(compensationError)}`,
          };
        }
      }
      for (let index = done.length - 1; index >= 0; index -= 1) {
        try {
          await done[index]();
        } catch (compensationError: unknown) {
          this.clear();
          return {
            kind: "invalidated",
            label: entry.label,
            reason: `履歴の補償に失敗しました: ${this.getErrorMessage(compensationError)}`,
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

  private getFallbackPath(entry: StoredEntry): string {
    return entry.files[0]?.path ?? "（対象ファイルなし）";
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
