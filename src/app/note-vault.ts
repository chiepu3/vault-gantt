import type { VaultAdapter } from "./task-operations";

export type Frontmatter = Record<string, unknown>;
/** The vault port note format v2 works against (see VaultAdapter). */
export type NoteVault = VaultAdapter;

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
