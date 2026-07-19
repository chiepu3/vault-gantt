/**
 * In-memory fake implementation of VaultAdapterPort for testing.
 * Tracks revisions and simulates revision conflicts.
 */

import type { VaultAdapterPort, TaskFileRecord, WriteResult } from './ports';

export class FakeVaultAdapter implements VaultAdapterPort {
  private files: Map<string, TaskFileRecord> = new Map();
  private revisionCounters: Map<string, number> = new Map();

  /**
   * List all task file paths currently in the fake vault.
   */
  listTaskFilePaths(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Read a task file from the fake vault.
   * Returns null if the file doesn't exist.
   */
  async readTaskFile(path: string): Promise<TaskFileRecord | null> {
    return this.files.get(path) ?? null;
  }

  /**
   * Write a task file with revision conflict detection.
   * Checks expectedRevision against current revision.
   * On conflict, returns REVISION_CONFLICT error.
   * On success, increments revision counter and returns new revision.
   */
  async writeTaskFile(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
    expectedRevision: string
  ): Promise<WriteResult> {
    const existing = this.files.get(path);

    // Check for revision conflict
    if (existing) {
      if (existing.revision !== expectedRevision) {
        return {
          ok: false,
          error: 'REVISION_CONFLICT',
          currentRevision: existing.revision,
        };
      }
    }

    // Increment revision counter for this path
    const currentCount = (this.revisionCounters.get(path) ?? 0) + 1;
    this.revisionCounters.set(path, currentCount);
    const newRevision = String(currentCount);

    // Update the file
    this.files.set(path, {
      path,
      frontmatter,
      body,
      revision: newRevision,
    });

    return { ok: true, revision: newRevision };
  }

  /**
   * Create a new task file with an initial revision.
   * If file already exists, overwrites it (acceptable for fake).
   */
  async createTaskFile(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): Promise<TaskFileRecord> {
    // Initialize or increment revision counter
    const currentCount = (this.revisionCounters.get(path) ?? 0) + 1;
    this.revisionCounters.set(path, currentCount);
    const revision = String(currentCount);

    const record: TaskFileRecord = {
      path,
      frontmatter,
      body,
      revision,
    };

    this.files.set(path, record);
    return record;
  }

  /**
   * Delete a task file from the fake vault.
   * No-op if the file doesn't exist (no throw).
   */
  async deleteTaskFile(path: string): Promise<void> {
    this.files.delete(path);
    // Note: we intentionally do NOT reset the revision counter,
    // so if the file is recreated, it gets a new revision number.
  }

  /**
   * TEST-ONLY: Simulate an external concurrent write to force revision conflict.
   * This method bypasses the normal expectedRevision check and bumps the revision,
   * making any subsequent write with the old expectedRevision fail with REVISION_CONFLICT.
   * Synchronous on purpose: tests call this between two awaited API calls, so there's
   * no need for it to itself be async.
   */
  _simulateExternalWrite(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): TaskFileRecord {
    const currentCount = (this.revisionCounters.get(path) ?? 0) + 1;
    this.revisionCounters.set(path, currentCount);
    const newRevision = String(currentCount);

    const record: TaskFileRecord = {
      path,
      frontmatter,
      body,
      revision: newRevision,
    };

    this.files.set(path, record);
    return record;
  }
}
