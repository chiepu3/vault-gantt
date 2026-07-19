import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { VaultAdapterPort, TaskFileRecord, WriteResult } from '../application/ports';
import { computeRevision, isRevisionConflict } from '../application/revision';
import { isTaskNoteFrontmatter } from '../domain/task-note/parser';
import { splitFrontmatterBlock } from './frontmatter-split';

/**
 * Real Obsidian implementation of VaultAdapterPort.
 *
 * FR-1.2: frontmatter reads go through metadataCache.getFileCache().frontmatter
 * only; frontmatter writes go through fileManager.processFrontMatter() only.
 * We never hand-construct or hand-parse YAML frontmatter text ourselves.
 */
export class ObsidianVaultAdapter implements VaultAdapterPort {
  constructor(private app: App) {}

  listTaskFilePaths(): string[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => isTaskNoteFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter))
      .map((file) => file.path);
  }

  async readTaskFile(path: string): Promise<TaskFileRecord | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;

    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    // Normalize CRLF at the ingestion boundary so every downstream string
    // comparison (headings, delimiters) sees LF-only content.
    const raw = (await this.app.vault.cachedRead(file)).replace(/\r\n/g, '\n');
    const { body } = splitFrontmatterBlock(raw);
    const revision = computeRevision(file.stat.mtime, file.stat.size);

    return { path: file.path, frontmatter, body, revision };
  }

  async writeTaskFile(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
    expectedRevision: string
  ): Promise<WriteResult> {
    const file = this.app.vault.getAbstractFileByPath(path);

    // ports.ts's WriteResult has no distinct NOT_FOUND variant, so a missing
    // file at write time is reported as a revision conflict with an empty
    // currentRevision.
    if (!(file instanceof TFile)) {
      return { ok: false, error: 'REVISION_CONFLICT', currentRevision: '' };
    }

    // Best-effort check only: Obsidian's API offers no compare-and-swap, so a
    // concurrent write could still race in between this check and the actual
    // write below. Checking immediately before acting keeps that window small.
    const currentRevision = computeRevision(file.stat.mtime, file.stat.size);
    if (isRevisionConflict(expectedRevision, currentRevision)) {
      return { ok: false, error: 'REVISION_CONFLICT', currentRevision };
    }

    // Two-phase write: if phase 2 (processFrontMatter) fails after phase 1
    // (vault.modify) succeeded, the file would be left frontmatter-less and
    // permanently invisible to listTaskFilePaths. Snapshot the original
    // content first so we can roll back.
    const originalRaw = await this.app.vault.cachedRead(file);

    // Replace the entire file content with the new body (the old frontmatter
    // block, if any, is discarded here — that's intentional, see step 2).
    await this.app.vault.modify(file, body);

    // Re-add a fresh, correctly-serialized frontmatter block prepended to the
    // body just written. Obsidian handles YAML serialization internally.
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        for (const key of Object.keys(fm)) {
          delete fm[key];
        }
        Object.assign(fm, frontmatter);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.app.vault.modify(file, originalRaw);
      } catch (restoreErr) {
        console.error(`[vault-gantt] rollback failed for "${path}" — file may be missing its frontmatter`, restoreErr);
      }
      return { ok: false, error: 'WRITE_FAILED', message };
    }

    // Don't trust a possibly-stale .stat on a reference held across awaits;
    // re-fetch the file to compute the new revision.
    const updated = this.app.vault.getAbstractFileByPath(path);
    if (!(updated instanceof TFile)) {
      return { ok: false, error: 'REVISION_CONFLICT', currentRevision: '' };
    }
    const newRevision = computeRevision(updated.stat.mtime, updated.stat.size);
    return { ok: true, revision: newRevision };
  }

  async createTaskFile(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string
  ): Promise<TaskFileRecord> {
    // Ensure the parent folder exists before creating the file.
    const folderPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
    if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const file = await this.app.vault.create(path, body);

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      Object.assign(fm, frontmatter);
    });

    const created = this.app.vault.getAbstractFileByPath(path);
    if (!(created instanceof TFile)) {
      // Should be unreachable: we just created this file and only mutated its
      // frontmatter, but guard against an unexpected external deletion/rename.
      throw new Error(`Failed to re-read created task file at "${path}"`);
    }
    const revision = computeRevision(created.stat.mtime, created.stat.size);

    return { path: created.path, frontmatter, body, revision };
  }

  async deleteTaskFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;
    await this.app.fileManager.trashFile(file);
  }
}
