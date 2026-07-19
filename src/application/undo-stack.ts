/**
 * Undo stack for tracking reversible operations.
 * Implements a fixed-size LIFO queue that drops the oldest entry when full.
 */

export interface UndoInversePatch {
  path: string;
  expectedRevision: string;
  parent?: Record<string, unknown>;
  subtasks?: { key: string; fields: Record<string, unknown> }[];
  newSubtasks?: { key: string; title: string; createdAt?: string }[];
  deleteSubtaskKeys?: string[];
}

export interface UndoEntry {
  inversePatches?: UndoInversePatch[];
  deletedPaths?: string[];
  recreatedFiles?: { path: string; frontmatter: Record<string, unknown>; body: string }[];
}

/**
 * LIFO undo stack with a maximum size.
 * When push() would exceed maxSize, the OLDEST entry (index 0) is removed first.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 20) {
    this.maxSize = maxSize;
  }

  /**
   * Push a new entry onto the stack.
   * If at maxSize, removes the oldest entry first.
   */
  push(entry: UndoEntry): void {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift(); // Remove oldest entry (index 0)
    }
    this.entries.push(entry);
  }

  /**
   * Pop and return the most recently pushed entry (LIFO).
   * Returns undefined if the stack is empty.
   */
  pop(): UndoEntry | undefined {
    return this.entries.pop();
  }

  /**
   * Clear all entries from the stack.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get the current size of the stack.
   */
  get size(): number {
    return this.entries.length;
  }
}
