import type { VaultAdapter, VaultFile } from "./task-operations";

export type Frontmatter = Record<string, unknown>;

/**
 * What note format v2 needs from Obsidian beyond plain reads and writes: frontmatter comes from
 * the metadataCache, edits go through processFrontMatter, files are renamed/trashed via the
 * file manager so links stay valid.
 */
export interface NoteVault extends VaultAdapter {
  /** Read through Obsidian's cache (bodies are shown a lot and change rarely). */
  cachedRead(file: VaultFile): Promise<string>;
  /** metadataCache frontmatter: undefined = not indexed yet, null = the note has none. */
  getFrontmatter(file: VaultFile): Frontmatter | null | undefined;
  /** app.fileManager.processFrontMatter: only the keys the callback touches change. */
  processFrontMatter(file: VaultFile, update: (frontmatter: Frontmatter) => void): Promise<void>;
  /** app.fileManager.renameFile (files and folders; missing parent folders are created). */
  rename(path: string, newPath: string): Promise<void>;
  /** app.fileManager.trashFile */
  trash(file: VaultFile): Promise<void>;
  /** Resolves a link such as "[[name]]" the way the metadataCache would from `fromPath`. */
  resolveLink(link: string, fromPath: string): VaultFile | null;
  /** Resolves once the metadataCache has indexed these files (or after the timeout). */
  whenIndexed(files: readonly VaultFile[], timeoutMs?: number): Promise<void>;
  /** After writing: resolves when the metadataCache has caught up with the file (or after a timeout). */
  afterWrite(file: VaultFile, contentChanged: boolean): Promise<void>;
}

/** "[[note]]" / "[[folder/note|alias]]" / "note" -> "note" / "folder/note". */
export function linkTarget(link: string): string {
  const inner = /^\[\[([\s\S]*)\]\]$/.exec(link.trim())?.[1] ?? link.trim();
  return inner.split("|")[0].split("#")[0].trim();
}

/** The wiki link text for a note: its basename when unique in the vault, else its path. */
export function linkTextFor(vault: Pick<VaultAdapter, "getFiles">, file: { path: string; basename?: string }): string {
  const name = file.path.split("/").pop()!.replace(/\.md$/i, "");
  const clashes = vault.getFiles().some((other) => other.path !== file.path && other.path.split("/").pop()!.replace(/\.md$/i, "").toLowerCase() === name.toLowerCase());
  return `[[${clashes ? file.path.replace(/\.md$/i, "") : name}]]`;
}
