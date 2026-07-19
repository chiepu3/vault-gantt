/**
 * Vault adapter port - defines the interface between the application and infrastructure layers.
 * No Obsidian imports here; this is the seam for dependency injection.
 */

export interface TaskFileRecord {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  revision: string;
}

export type WriteResult =
  | { ok: true; revision: string }
  | { ok: false; error: 'REVISION_CONFLICT'; currentRevision: string };

/**
 * listTaskFilePaths stays synchronous (Obsidian's vault.getMarkdownFiles() is sync,
 * backed by an in-memory index). The other methods are async because their real
 * Obsidian implementations are: metadataCache.getFileCache() is sync but reading a
 * file's body requires vault.cachedRead() (Promise<string>), and
 * fileManager.processFrontMatter() / vault.create() / vault.delete() all return
 * Promise<void | TFile>.
 */
export interface VaultAdapterPort {
  listTaskFilePaths(): string[];
  readTaskFile(path: string): Promise<TaskFileRecord | null>;
  writeTaskFile(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
    expectedRevision: string
  ): Promise<WriteResult>;
  createTaskFile(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): Promise<TaskFileRecord>;
  deleteTaskFile(path: string): Promise<void>;
}
