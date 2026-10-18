import { parseYaml, stringifyYaml } from "obsidian";
import { linkTarget, type NoteVault } from "../../src/app/note-vault";
import { splitFrontmatter } from "../../src/core/note-v2";
import type { VaultFile } from "../../src/app/task-operations";

/**
 * In-memory fake vault implementation for testing.
 * Maintains file content by path, mtime/size on every write, and write call counters.
 */
export class FakeVault implements NoteVault {
  private files: Map<string, VaultFile & { content: string }> = new Map();
  private createCallCount: number = 0;
  private modifyCallCount: number = 0;
  private clock = 0;
  /** Like Obsidian's "automatically update internal links": [[old]] becomes [[new]] in other notes after a rename. */
  updateLinksOnRename = true;
  /** Make rename() throw for matching paths (tests of the failure path). */
  failRename?: (path: string, newPath: string) => boolean;
  readonly renames: { from: string; to: string }[] = [];
  readonly trashed: string[] = [];

  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

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
    const now = this.tick();
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
    const now = this.tick();
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
      basename: f.path.split("/").pop()!.replace(/\.md$/i, ""),
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
      basename: file.path.split("/").pop()!.replace(/\.md$/i, ""),
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

  // ---- note format v2 (a tiny metadataCache + fileManager) ----

  async cachedRead(file: VaultFile): Promise<string> {
    return this.read(file);
  }

  getFrontmatter(file: VaultFile): Record<string, unknown> | null | undefined {
    const existing = this.files.get(file.path);
    if (!existing) return undefined;
    const { front } = splitFrontmatter(existing.content);
    if (!front) return null;
    const yaml = front.replace(/^---[ \t]*\r?\n/, "").replace(/\r?\n---[ \t]*\r?\n?$/, "");
    return (parseYaml(yaml) as Record<string, unknown> | null) ?? {};
  }

  async processFrontMatter(file: VaultFile, update: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const existing = this.files.get(file.path);
    if (!existing) throw new Error(`File not found: ${file.path}`);
    const fm = structuredClone(this.getFrontmatter(file) ?? {});
    update(fm);
    const { body } = splitFrontmatter(existing.content);
    await this.modify(file, `---\n${stringifyYaml(fm)}---\n${body}`);
  }

  /** The note whose frontmatter carries this id, wherever a rename has put it. */
  getFileById(id: string): VaultFile | null {
    for (const [path, file] of this.files) if (new RegExp(`^id: ${id}$`, "m").test(file.content)) return this.getFileByPath(path);
    return null;
  }

  getFileContentById(id: string): string | null {
    const file = this.getFileById(id);
    return file ? this.getFileContent(file.path) : null;
  }

  async rename(path: string, newPath: string): Promise<void> {
    if (this.failRename?.(path, newPath)) throw new Error("rename failed");
    const moves: [string, string][] = [];
    if (this.files.has(path)) moves.push([path, newPath]);
    else for (const key of this.files.keys()) if (key.startsWith(path + "/")) moves.push([key, newPath + key.slice(path.length)]);
    if (!moves.length) throw new Error(`File not found: ${path}`);
    for (const [, to] of moves) if (this.files.has(to)) throw new Error(`Destination file already exists: ${to}`);
    for (const [from, to] of moves) {
      const file = this.files.get(from)!;
      this.files.delete(from);
      file.path = to;
      file.stat = { mtime: this.tick(), size: file.content.length };
      this.files.set(to, file);
      this.renames.push({ from, to });
    }
    if (this.updateLinksOnRename) {
      const base = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");
      for (const [from, to] of moves) {
        if (base(from) === base(to)) continue;
        for (const other of this.files.values()) {
          if (other.content.includes(`[[${base(from)}]]`)) {
            other.content = other.content.split(`[[${base(from)}]]`).join(`[[${base(to)}]]`);
            other.stat = { mtime: this.tick(), size: other.content.length };
          }
        }
      }
    }
  }

  async trash(file: VaultFile): Promise<void> {
    if (!this.files.delete(file.path)) throw new Error(`File not found: ${file.path}`);
    this.trashed.push(file.path);
  }

  resolveLink(link: string, fromPath: string): VaultFile | null {
    const target = linkTarget(link);
    if (!target) return null;
    const exact = this.files.get(target.endsWith(".md") ? target : `${target}.md`);
    if (exact && target.includes("/")) return this.getFileByPath(exact.path);
    const name = target.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
    const matches = [...this.files.keys()].filter((path) => path.split("/").pop()!.replace(/\.md$/i, "").toLowerCase() === name).sort();
    const folder = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
    const path = matches.find((candidate) => candidate.startsWith(folder)) ?? matches[0];
    return path ? this.getFileByPath(path) : null;
  }

  async whenIndexed(): Promise<void> {}

  async afterWrite(): Promise<void> {}

  /** Test helper: all files, as path -> content. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].map(([path, file]) => [path, file.content]));
  }
}
