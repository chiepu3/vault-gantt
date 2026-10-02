import { VaultAdapter, VaultFile } from "../../src/app/task-operations";

/**
 * In-memory fake vault implementation for testing.
 * Maintains file content by path, mtime/size on every write, and write call counters.
 */
export class FakeVault implements VaultAdapter {
  private files: Map<string, VaultFile & { content: string }> = new Map();
  private createCallCount: number = 0;
  private modifyCallCount: number = 0;

  /**
 * Get the number of times create has been called.
 */
  getCreateCallCount(): number {
    return this.createCallCount;
  }

  /**
 * Get the number of times modify has been called.
 */
  getModifyCallCount(): number {
    return this.modifyCallCount;
  }

  /**
 * Reset all counters (useful between tests).
 */
  resetCounters(): void {
    this.createCallCount = 0;
    this.modifyCallCount = 0;
  }

  /**
 * Create a file with given path and content.
 * Sets mtime and size based on current time and content length.
 */
  async create(path: string, content: string): Promise<VaultFile> {
    this.createCallCount++;
    const now = Date.now();
    const file: VaultFile & { content: string } = {
      path,
      content,
      stat: {
        mtime: now,
        size: content.length,
      },
    };
    this.files.set(path, file);
    return { path, stat: file.stat };
  }

  /**
 * Modify an existing file's content.
 * Updates mtime and size.
 */
  async modify(file: VaultFile, content: string): Promise<void> {
    this.modifyCallCount++;
    const now = Date.now();
    const existing = this.files.get(file.path);
    if (existing) {
      existing.content = content;
      existing.stat = {
        mtime: now,
        size: content.length,
      };
      // Update the file object's stat too
      if (file.stat) {
        file.stat.mtime = now;
        file.stat.size = content.length;
      }
    } else {
      // File doesn't exist, create it
      const newFile: VaultFile & { content: string } = {
        path: file.path,
        content,
        stat: {
          mtime: now,
          size: content.length,
        },
      };
      this.files.set(file.path, newFile);
    }
  }

  /**
 * Read file content.
 * Throws if file not found.
 */
  async read(file: VaultFile): Promise<string> {
    const existing = this.files.get(file.path);
    if (!existing) {
      throw new Error(`File not found: ${file.path}`);
    }
    return existing.content;
  }

  /**
 * Get all files in vault.
 */
  getFiles(): VaultFile[] {
    return Array.from(this.files.values()).map((f) => ({
      path: f.path,
      stat: f.stat,
    }));
  }

  /**
 * Get file by path.
 * Returns null if not found.
 */
  getFileByPath(path: string): VaultFile | null {
    const file = this.files.get(path);
    if (!file) return null;
    return {
      path: file.path,
      stat: file.stat,
    };
  }

  /**
 * Direct access to stored file content for testing purposes.
 */
  getFileContent(path: string): string | null {
    return this.files.get(path)?.content ?? null;
  }

  /**
 * Clear all files (for test cleanup).
 */
  clear(): void {
    this.files.clear();
    this.resetCounters();
  }
}
